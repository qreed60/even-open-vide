import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Card, EmptyState, useDrawerHeader } from 'even-toolkit/web';
import { IcEditChecklist, IcEditPlay, IcEditTrash, IcFeatTimeCounting, IcStatusAlert } from 'even-toolkit/web/icons/svg-icons';
import { rpc, type RpcResponse } from '../domain/daemon-client';
import { useBridge } from '../contexts/bridge';
import { usePullRefresh } from '../hooks/use-pull-refresh';
import {
  deletedQueueItemIds,
  groupQueueDisplayItems,
  loadDeletedQueueItems,
  normalizeQueueData,
  queueDisplayItemCanDelete,
  queueDisplayItemDeleteId,
  queueDisplayItemDeleteTarget,
  queueDisplayItemCanReorder,
  queueDisplayItemIsChat,
  queueDisplayItemIsDeleted,
  queueDisplayItemPrompt,
  queueDisplayItemReorderTarget,
  saveDeletedQueueChatRecord,
  saveDeletedQueueItem,
  summarizeQueue,
  type QueueData,
  type QueueDisplayItem,
} from '../lib/team-queue';

interface TeamInfo {
  id: string;
  name: string;
}

interface TeamRunsPanelProps {
  teamId?: string;
  embedded?: boolean;
  teamName?: string;
}

const EMPTY_QUEUE_DATA: QueueData = {
  items: [],
  resources: [],
  unsupported: false,
};

interface WorkerStatus {
  available: boolean;
  enabled?: boolean;
  active?: boolean;
  intervalMs?: string;
  lastTickAt?: string;
  lastDispatchAt?: string;
  lastDispatchResult?: string;
  lastError?: string;
}

function badgeVariant(item: QueueDisplayItem): 'positive' | 'negative' | 'accent' | 'neutral' {
  if (item.category === 'running') return 'positive';
  if (item.category === 'queued' || item.category === 'waiting') return 'accent';
  if (/(fail|cancel|interrupt|error)/i.test(item.status)) return 'negative';
  return 'neutral';
}

function formatDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getResourceLabel(item: QueueDisplayItem): string | null {
  if (item.resourceKey) return item.resourceKey;
  const parts = [item.provider, item.model].filter(Boolean);
  return parts.length ? parts.join(':') : null;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readBool(record: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(normalized)) return true;
      if (['false', 'no', '0'].includes(normalized)) return false;
    }
  }
  return undefined;
}

function readString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

function compactValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function responseMessage(res: RpcResponse | undefined): string | undefined {
  const record = readRecord(res);
  return readString(record, ['error', 'message', 'reason']);
}

function workerResponsePayload(res: RpcResponse): Record<string, unknown> | undefined {
  return readRecord(res.queueWorkerStatus)
    ?? readRecord(res.worker)
    ?? readRecord(res.queueWorker)
    ?? readRecord(res.status)
    ?? readRecord(res.workerStatus)
    ?? readRecord(res.data)
    ?? readRecord(res.result);
}

function responseSaysUnavailable(res: RpcResponse): boolean {
  const record = readRecord(res);
  const explicitAvailable = readBool(record, ['available', 'workerAvailable', 'queueWorkerAvailable']);
  if (explicitAvailable === false) return true;

  const payload = workerResponsePayload(res);
  const payloadAvailable = readBool(payload, ['available', 'workerAvailable', 'queueWorkerAvailable']);
  if (payloadAvailable === false) return true;

  const message = responseMessage(res)?.toLowerCase() ?? '';
  return /unknown command|unsupported command|not available|unavailable|not found|no handler/.test(message);
}

function isWorkerStatusPayload(payload: Record<string, unknown> | undefined): payload is Record<string, unknown> {
  if (!payload) return false;
  return readBool(payload, ['enabled', 'workerEnabled', 'isEnabled']) !== undefined
    || readBool(payload, ['running', 'ticking', 'dispatching', 'active', 'isRunning', 'inProgress']) !== undefined
    || readString(payload, ['status', 'state']) !== undefined
    || readString(payload, ['lastTickAt', 'last_tick_at', 'lastDispatchAt', 'last_dispatch_at', 'lastError', 'last_error', 'intervalMs', 'interval_ms']) !== undefined
    || payload.lastDispatchResult !== undefined
    || payload.lastDispatch !== undefined
    || payload.lastDispatchSummary !== undefined;
}

function normalizeWorkerStatus(res?: RpcResponse | null): WorkerStatus {
  if (!res) return { available: false, lastError: 'queue.worker.status returned no response' };
  if (!res.ok && responseSaysUnavailable(res)) return { available: false, lastError: responseMessage(res) };

  const payload = workerResponsePayload(res);
  const worker = isWorkerStatusPayload(payload)
    ? payload
    : (res.ok && !responseSaysUnavailable(res) ? readRecord(res) : undefined);

  if (!worker) {
    return {
      available: false,
      lastError: responseMessage(res) ?? 'queue.worker.status returned an invalid response',
    };
  }

  const status = readString(worker, ['status', 'state'])?.toLowerCase();
  const enabled = readBool(worker, ['enabled', 'workerEnabled', 'isEnabled'])
    ?? (status ? ['enabled', 'running', 'active', 'idle'].includes(status) || (['disabled', 'stopped', 'off'].includes(status) ? false : undefined) : undefined);
  const active = readBool(worker, ['running', 'ticking', 'dispatching', 'active', 'isRunning', 'inProgress'])
    ?? (status ? ['running', 'active', 'ticking', 'dispatching'].includes(status) || undefined : undefined);

  return {
    available: true,
    enabled,
    active,
    intervalMs: readString(worker, ['intervalMs', 'interval_ms', 'pollIntervalMs', 'poll_interval_ms']),
    lastTickAt: readString(worker, ['lastTickAt', 'last_tick_at', 'lastTickTime', 'last_tick_time', 'lastRunAt', 'updatedAt']),
    lastDispatchAt: readString(worker, ['lastDispatchAt', 'last_dispatch_at', 'lastDispatchedAt', 'last_dispatched_at']),
    lastDispatchResult: readString(worker, ['lastDispatchResult', 'last_dispatch_result', 'lastResult', 'last_result'])
      ?? compactValue(worker.lastDispatch)
      ?? compactValue(worker.lastDispatchSummary)
      ?? compactValue(worker.lastDispatchResult),
    lastError: readString(worker, ['lastError', 'last_error', 'error']),
  };
}

function normalizeWorkerActionResponse(res: RpcResponse | null | undefined, command: string): { ok: boolean; status?: WorkerStatus; error?: string } {
  if (!res) return { ok: false, error: `${command}: no response` };
  const status = normalizeWorkerStatus(res);
  if (res.ok || status.available) return { ok: true, status };
  return { ok: false, error: `${command}: ${responseMessage(res) ?? status.lastError ?? 'Worker command failed'}` };
}

async function workerRpc(command: string, params?: Record<string, unknown>): Promise<RpcResponse> {
  try {
    const res = await rpc(command, params);
    if (import.meta.env.DEV) console.debug('[team-runs] worker RPC response', command, res);
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (import.meta.env.DEV) console.debug('[team-runs] worker RPC error', command, message);
    return { ok: false, error: message };
  }
}

function workerStatusMeta(workerStatus: WorkerStatus): string[] {
  if (!workerStatus.available) return ['Worker unavailable'];
  return [
    workerStatus.enabled === undefined ? 'enabled unknown' : workerStatus.enabled ? 'enabled' : 'disabled',
    workerStatus.active ? 'running' : 'idle',
    workerStatus.intervalMs ? `interval ${workerStatus.intervalMs}ms` : undefined,
    workerStatus.lastTickAt ? `last tick ${formatDate(workerStatus.lastTickAt) ?? workerStatus.lastTickAt}` : undefined,
    workerStatus.lastDispatchAt ? `last dispatch ${formatDate(workerStatus.lastDispatchAt) ?? workerStatus.lastDispatchAt}` : undefined,
    workerStatus.lastDispatchResult ? `dispatch ${workerStatus.lastDispatchResult}` : undefined,
  ].filter((entry): entry is string => Boolean(entry));
}

function itemKey(item: QueueDisplayItem): string {
  return `${item.kind}:${item.id}:${item.status}:${item.teamId ?? ''}`;
}

function numericPriority(item: QueueDisplayItem): number | null {
  if (item.priority == null) return null;
  const value = Number(item.priority);
  return Number.isFinite(value) ? value : null;
}

function cancellableTarget(item: QueueDisplayItem): { kind: 'task' | 'board'; id: string } | null {
  if (item.queueTaskId) return { kind: 'task', id: item.queueTaskId };
  if (item.linkedQueueTaskId) return { kind: 'task', id: item.linkedQueueTaskId };
  if (item.kind === 'task' && item.id.startsWith('queue_task_')) return { kind: 'task', id: item.id };
  if (item.linkedBoardTaskId) return { kind: 'board', id: item.linkedBoardTaskId };
  return null;
}

async function deleteQueueItem(item: QueueDisplayItem): Promise<RpcResponse> {
  const target = queueDisplayItemDeleteTarget(item);
  if (!target) return { ok: false, error: 'No queue item id available' };
  return rpc('team.queue.item.delete', target);
}

function QueueItemCard({
  item,
  showTeam,
  cancellingId,
  deletingId,
  reorderingId,
  onCancel,
  onDelete,
  onMoveToTop,
  onMoveToBottom,
  onAdjustPriority,
}: {
  item: QueueDisplayItem;
  showTeam: boolean;
  cancellingId?: string | null;
  deletingId?: string | null;
  reorderingId?: string | null;
  onCancel?: (item: QueueDisplayItem) => void;
  onDelete?: (item: QueueDisplayItem) => void;
  onMoveToTop?: (item: QueueDisplayItem) => void;
  onMoveToBottom?: (item: QueueDisplayItem) => void;
  onAdjustPriority?: (item: QueueDisplayItem, delta: number) => void;
}) {
  const createdAt = formatDate(item.createdAt);
  const startedAt = formatDate(item.startedAt);
  const finishedAt = formatDate(item.finishedAt);
  const resourceLabel = getResourceLabel(item);
  const cancelTarget = (item.category === 'queued' || item.category === 'waiting') ? cancellableTarget(item) : null;
  const cancelActionId = cancelTarget ? `${cancelTarget.kind}:${cancelTarget.id}` : null;
  const deleteId = queueDisplayItemDeleteId(item);
  const canDelete = queueDisplayItemCanDelete(item);
  const reorderTarget = queueDisplayItemReorderTarget(item);
  const canReorder = Boolean(reorderTarget && queueDisplayItemCanReorder(item) && onMoveToTop && onMoveToBottom);
  const isReordering = Boolean(reorderTarget && reorderingId === reorderTarget.queueTaskId);
  const priorityValue = numericPriority(item);
  const meta = [
    item.kind,
    item.source,
    showTeam ? item.teamName : undefined,
    item.priority ? `priority ${item.priority}` : undefined,
    item.position ? `position ${item.position}` : undefined,
    item.linkedBoardTaskStatus ? `board ${item.linkedBoardTaskStatus}` : undefined,
    item.primaryRunStatus ? `run ${item.primaryRunStatus}` : undefined,
    resourceLabel,
  ].filter(Boolean);

  return (
    <Card className="card-hover">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-[13px] tracking-[-0.13px] text-text font-normal truncate">{item.title}</p>
            <Badge variant={badgeVariant(item)}>{item.status}</Badge>
            {item.priority && <Badge variant="neutral">priority {item.priority}</Badge>}
            {item.position && <Badge variant="neutral">position {item.position}</Badge>}
          </div>
          {(item.excerpt || item.description) && (
            <p className="mt-1.5 line-clamp-2 text-[12px] tracking-[-0.12px] text-text-dim">
              {item.excerpt ?? item.description}
            </p>
          )}
          {item.assistantText && (
            <p className="mt-2 rounded-[6px] border border-border bg-surface/60 px-2 py-1.5 text-[12px] tracking-[-0.12px] text-text line-clamp-3">
              {item.assistantText}
            </p>
          )}
          {meta.length > 0 && <p className="data-mono mt-1">{meta.join(' · ')}</p>}
          {(item.route || item.currentMember || item.currentState || item.primaryRunCurrentState) && (
            <p className="data-mono mt-1">
              {[item.route ? `route ${item.route}` : null, item.currentMember ? `@${item.currentMember}` : null, item.currentState, item.primaryRunCurrentState ? `run state ${item.primaryRunCurrentState}` : null].filter(Boolean).join(' · ')}
            </p>
          )}
          {(createdAt || startedAt || finishedAt) && (
            <div className="mt-2 grid gap-0.5 text-[11px] tracking-[-0.11px] text-text-dim">
              {createdAt && <span>Created: {createdAt}</span>}
              {startedAt && <span>Started: {startedAt}</span>}
              {finishedAt && <span>Finished: {finishedAt}</span>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {canReorder && (
            <div className="flex flex-col gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onMoveToTop?.(item)}
                disabled={isReordering}
              >
                Top
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onMoveToBottom?.(item)}
                disabled={isReordering}
              >
                Bottom
              </Button>
              {priorityValue !== null && onAdjustPriority && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onAdjustPriority(item, 1)}
                    disabled={isReordering}
                  >
                    +1
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onAdjustPriority(item, -1)}
                    disabled={isReordering}
                  >
                    -1
                  </Button>
                </div>
              )}
            </div>
          )}
          {cancelTarget && onCancel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onCancel(item)}
              disabled={cancellingId === cancelActionId}
            >
              {cancellingId === cancelActionId ? 'Cancelling...' : 'Cancel'}
            </Button>
          )}
          {canDelete && deleteId && onDelete && (
            <button
              type="button"
              onClick={() => onDelete(item)}
              disabled={deletingId === deleteId}
              title="Delete"
              aria-label="Delete queue item"
              className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-border bg-surface text-text-dim transition-colors hover:bg-negative/10 hover:text-negative disabled:opacity-60"
            >
              <IcEditTrash width={14} height={14} />
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

function QueueSection({
  title,
  items,
  icon,
  showTeam,
  cancellingId,
  deletingId,
  reorderingId,
  onCancel,
  onDelete,
  onMoveToTop,
  onMoveToBottom,
  onAdjustPriority,
}: {
  title: string;
  items: QueueDisplayItem[];
  icon: ReactNode;
  showTeam: boolean;
  cancellingId?: string | null;
  deletingId?: string | null;
  reorderingId?: string | null;
  onCancel?: (item: QueueDisplayItem) => void;
  onDelete?: (item: QueueDisplayItem) => void;
  onMoveToTop?: (item: QueueDisplayItem) => void;
  onMoveToBottom?: (item: QueueDisplayItem) => void;
  onAdjustPriority?: (item: QueueDisplayItem, delta: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-text-dim">{icon}</span>
        <h2 className="text-[15px] tracking-[-0.15px] text-text font-normal">{title}</h2>
        <Badge variant="neutral">{items.length}</Badge>
      </div>
      {items.map((item) => (
        <QueueItemCard
          key={itemKey(item)}
          item={item}
          showTeam={showTeam}
          cancellingId={cancellingId}
          deletingId={deletingId}
          reorderingId={reorderingId}
          onCancel={onCancel}
          onDelete={onDelete}
          onMoveToTop={onMoveToTop}
          onMoveToBottom={onMoveToBottom}
          onAdjustPriority={onAdjustPriority}
        />
      ))}
    </section>
  );
}

function ResourceSection({ resources }: { resources: QueueDisplayItem[] }) {
  if (resources.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-text-dim"><IcFeatTimeCounting width={16} height={16} /></span>
        <h2 className="text-[15px] tracking-[-0.15px] text-text font-normal">Resources</h2>
        <Badge variant="neutral">{resources.length}</Badge>
      </div>
      {resources.map((item) => (
        <Card key={itemKey(item)}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-[13px] tracking-[-0.13px] text-text font-normal truncate">{getResourceLabel(item) ?? item.title}</p>
                <Badge variant={badgeVariant(item)}>{item.status}</Badge>
              </div>
              {[item.provider, item.model, item.currentMember ? `@${item.currentMember}` : undefined].filter(Boolean).length > 0 && (
                <p className="data-mono mt-1">
                  {[item.provider, item.model, item.currentMember ? `@${item.currentMember}` : undefined].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          </div>
        </Card>
      ))}
    </section>
  );
}

async function softRpc(cmd: string, params?: Record<string, unknown>): Promise<RpcResponse> {
  try {
    return await rpc(cmd, params);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function TeamRunsPanel({ teamId, embedded = false, teamName }: TeamRunsPanelProps) {
  const [data, setData] = useState<QueueData>(EMPTY_QUEUE_DATA);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>({ available: false });
  const [workerAction, setWorkerAction] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => deletedQueueItemIds());
  const [actionError, setActionError] = useState('');
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const { activeHostId } = useBridge();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const teamListRes = await softRpc('team.list');
      const nextTeams = teamListRes.ok && Array.isArray(teamListRes.teams) ? teamListRes.teams as TeamInfo[] : [];
      const teamNames = new Map(nextTeams.map((team) => [team.id, team.name]));
      if (teamId && teamName) teamNames.set(teamId, teamName);
      if (nextTeams.length > 0) setTeams(nextTeams);

      const responses = teamId
        ? await Promise.all([
          softRpc('team.queue.status', { teamId }),
          softRpc('team.task.list', { teamId }),
          softRpc('team.run.list', { teamId }),
          softRpc('model.resources.status'),
        ])
        : await Promise.all([
          softRpc('global.queue.status'),
          softRpc('team.queue.status'),
          softRpc('team.run.list'),
          softRpc('model.resources.status'),
        ]);
      if (!teamId) {
        setWorkerStatus(normalizeWorkerStatus(await workerRpc('queue.worker.status')));
      }
      setDeletedIds(deletedQueueItemIds(loadDeletedQueueItems()));
      setData(normalizeQueueData(responses, teamNames));
      setLoading(false);
    } finally {
      setRefreshing(false);
    }
  }, [teamId, teamName]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [activeHostId, refresh]);

  useEffect(() => {
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [activeHostId, refresh]);

  const handleRefresh = async () => {
    setActionError('');
    await refresh();
  };

  const handleDispatchOnce = async () => {
    setActionError('');
    setDispatching(true);
    try {
      const res = await rpc('team.queue.dispatch_once');
      if (!res.ok) setActionError(res.error ?? 'Dispatch failed');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    await refresh();
    setDispatching(false);
  };

  const handleWorkerAction = async (action: 'enable' | 'disable' | 'tick') => {
    const command = action === 'enable'
      ? 'queue.worker.enable'
      : action === 'disable'
        ? 'queue.worker.disable'
        : 'queue.worker.tick_once';
    setActionError('');
    setWorkerAction(action);
    try {
      const actionResult = normalizeWorkerActionResponse(await workerRpc(command), command);
      if (actionResult.status) setWorkerStatus(actionResult.status);
      if (!actionResult.ok) setActionError(actionResult.error ?? `${command}: Worker command failed`);
    } catch (error) {
      setActionError(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await refresh();
    setWorkerAction(null);
  };

  const handleMoveQueueItem = async (item: QueueDisplayItem, direction: 'top' | 'bottom') => {
    const target = queueDisplayItemReorderTarget(item);
    if (!target || !queueDisplayItemCanReorder(item)) return;
    setActionError('');
    setReorderingId(target.queueTaskId);
    try {
      const cmd = direction === 'top' ? 'global.queue.item.move_to_top' : 'global.queue.item.move_to_bottom';
      const res = await rpc(cmd, target);
      if (!res.ok) setActionError(res.error ?? 'Reorder failed');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    await refresh();
    setReorderingId(null);
  };

  const handleAdjustPriority = async (item: QueueDisplayItem, delta: number) => {
    const target = queueDisplayItemReorderTarget(item);
    const current = numericPriority(item);
    if (!target || current === null || !queueDisplayItemCanReorder(item)) return;
    setActionError('');
    setReorderingId(target.queueTaskId);
    try {
      const res = await rpc('global.queue.item.set_priority', { ...target, priority: current + delta });
      if (!res.ok) setActionError(res.error ?? 'Priority update failed');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    await refresh();
    setReorderingId(null);
  };

  const handleCancel = async (item: QueueDisplayItem) => {
    const target = cancellableTarget(item);
    if (!target) return;
    const actionId = `${target.kind}:${target.id}`;
    setActionError('');
    setCancellingId(actionId);
    try {
      const res = target.kind === 'task'
        ? await rpc('team.task.cancel', { taskId: target.id })
        : await rpc('team.board.item.cancel', { itemId: target.id });
      if (!res.ok) setActionError(res.error ?? 'Cancel failed');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    await refresh();
    setCancellingId(null);
  };

  const handleDelete = async (item: QueueDisplayItem) => {
    if (!queueDisplayItemCanDelete(item)) return;
    const deleteId = queueDisplayItemDeleteId(item);
    if (!deleteId) return;
    setActionError('');
    setDeletingId(deleteId);
    try {
      const res = await deleteQueueItem(item);
      if (!res.ok) {
        setActionError(res.error ?? 'Delete failed');
      } else {
        const record = {
          id: deleteId,
          teamId: item.teamId,
          text: queueDisplayItemPrompt(item),
          createdAt: item.createdAt ?? item.startedAt ?? item.updatedAt ?? item.finishedAt,
          queueTaskId: item.queueTaskId ?? item.linkedQueueTaskId,
          queueRunId: item.primaryRunId ?? item.runId,
          queueRunIds: item.queueRunIds ?? item.runIds,
        };
        if (item.teamId && queueDisplayItemIsChat(item)) {
          saveDeletedQueueChatRecord(item.teamId, { ...record, to: 'team' });
        } else {
          saveDeletedQueueItem(record);
        }
        setDeletedIds(deletedQueueItemIds(loadDeletedQueueItems()));
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    await refresh();
    setDeletingId(null);
  };

  const { pullHandlers, PullIndicator } = usePullRefresh(refresh);
  const items = useMemo(() => data.items
    .filter((item) => !teamId || item.teamId === teamId || !item.teamId)
    .filter((item) => !queueDisplayItemIsDeleted(item, deletedIds)), [data.items, teamId, deletedIds]);
  const resources = useMemo(() => data.resources.filter((item) => !teamId || item.teamId === teamId || !item.teamId), [data.resources, teamId]);
  const groupedItems = useMemo(() => groupQueueDisplayItems(items, resources), [items, resources]);
  const summary = summarizeQueue(items, resources);
  const isEmpty = !loading
    && groupedItems.running.length === 0
    && groupedItems.queued.length === 0
    && groupedItems.waiting.length === 0
    && groupedItems.history.length === 0
    && groupedItems.other.length === 0;
  const showTeam = !teamId;

  const content = (
    <div className={`${embedded ? '' : 'px-3 py-4 pb-8'} flex flex-col gap-3`} {...pullHandlers}>
      <PullIndicator />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[15px] tracking-[-0.15px] text-text font-normal">{teamId ? 'Team Runs' : 'Runs / Queue'}</p>
          <p className="text-[11px] tracking-[-0.11px] text-text-dim">
            {dispatching ? 'Dispatching...' : deletingId ? 'Deleting...' : cancellingId ? 'Cancelling...' : refreshing ? 'Refreshing...' : 'Queue-backed task state'}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
          <Button size="sm" onClick={handleDispatchOnce} disabled={dispatching}>
            {dispatching ? 'Dispatching...' : 'Dispatch once'}
          </Button>
        </div>
      </div>

      {actionError && (
        <p className="rounded-[6px] border border-negative/30 bg-negative/10 px-2 py-1.5 text-[11px] tracking-[-0.11px] text-negative">
          {actionError}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card>
          <p className="data-mono text-text-dim">tasks</p>
          <p className="text-[20px] tracking-[-0.2px] text-text font-normal">{summary.taskCount}</p>
        </Card>
        <Card>
          <p className="data-mono text-text-dim">running</p>
          <p className="text-[20px] tracking-[-0.2px] text-text font-normal">{summary.runningCount}</p>
        </Card>
        <Card>
          <p className="data-mono text-text-dim">queued</p>
          <p className="text-[20px] tracking-[-0.2px] text-text font-normal">{summary.queuedCount}</p>
        </Card>
        <Card>
          <p className="data-mono text-text-dim">waiting</p>
          <p className="text-[20px] tracking-[-0.2px] text-text font-normal">{summary.waitingCount}</p>
        </Card>
      </div>

      {!teamId && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-[13px] tracking-[-0.13px] text-text font-normal">Worker</p>
                <Badge variant={workerStatus.available ? workerStatus.enabled ? 'positive' : 'neutral' : 'negative'}>
                  {workerStatus.available ? workerStatus.enabled ? 'enabled' : 'disabled' : 'unavailable'}
                </Badge>
                {workerStatus.active && <Badge variant="accent">running</Badge>}
              </div>
              <p className="data-mono mt-1 text-text-dim">{workerStatusMeta(workerStatus).join(' · ')}</p>
              {workerStatus.lastError && (
                <p className="mt-1 text-[11px] tracking-[-0.11px] text-negative">{workerStatus.lastError}</p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => handleWorkerAction('enable')} disabled={workerAction !== null}>
                {workerAction === 'enable' ? 'Enabling...' : 'Enable worker'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => handleWorkerAction('disable')} disabled={workerAction !== null}>
                {workerAction === 'disable' ? 'Disabling...' : 'Disable worker'}
              </Button>
              <Button size="sm" onClick={() => handleWorkerAction('tick')} disabled={workerAction !== null}>
                {workerAction === 'tick' ? 'Ticking...' : 'Tick once'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {!teamId && teams.length > 0 && (
        <Card>
          <div className="flex flex-wrap gap-1.5">
            {teams.map((team) => (
              <Badge key={team.id} variant="neutral">{team.name}</Badge>
            ))}
          </div>
        </Card>
      )}

      {loading && (
        <p className="text-[13px] tracking-[-0.13px] text-text-dim text-center py-6 status-breathe-fast">Loading...</p>
      )}

      {!loading && data.unsupported && (
        <EmptyState
          icon={<IcStatusAlert width={32} height={32} />}
          title="Queue status unavailable"
          description="This bridge does not expose queue status commands yet."
        />
      )}

      {isEmpty && !data.unsupported && (
        <EmptyState
          icon={<IcFeatTimeCounting width={32} height={32} />}
          title="No queued work"
          description={teamId ? 'This team has no queued or recent queued runs.' : 'No team queue work is visible from this bridge.'}
        />
      )}

      <QueueSection title="Running" items={groupedItems.running} icon={<IcEditPlay width={16} height={16} />} showTeam={showTeam} />
      <QueueSection title="Queued" items={groupedItems.queued} icon={<IcEditChecklist width={16} height={16} />} showTeam={showTeam} cancellingId={cancellingId} reorderingId={reorderingId} onCancel={handleCancel} onMoveToTop={teamId ? undefined : (item) => handleMoveQueueItem(item, 'top')} onMoveToBottom={teamId ? undefined : (item) => handleMoveQueueItem(item, 'bottom')} onAdjustPriority={teamId ? undefined : handleAdjustPriority} />
      <QueueSection title="Waiting" items={groupedItems.waiting} icon={<IcFeatTimeCounting width={16} height={16} />} showTeam={showTeam} cancellingId={cancellingId} reorderingId={reorderingId} onCancel={handleCancel} onMoveToTop={teamId ? undefined : (item) => handleMoveQueueItem(item, 'top')} onMoveToBottom={teamId ? undefined : (item) => handleMoveQueueItem(item, 'bottom')} onAdjustPriority={teamId ? undefined : handleAdjustPriority} />
      <QueueSection title="History" items={groupedItems.history} icon={<IcEditChecklist width={16} height={16} />} showTeam={showTeam} deletingId={deletingId} reorderingId={reorderingId} onDelete={handleDelete} onMoveToTop={teamId ? undefined : (item) => handleMoveQueueItem(item, 'top')} onMoveToBottom={teamId ? undefined : (item) => handleMoveQueueItem(item, 'bottom')} onAdjustPriority={teamId ? undefined : handleAdjustPriority} />
      <QueueSection title="Other" items={groupedItems.other} icon={<IcStatusAlert width={16} height={16} />} showTeam={showTeam} deletingId={deletingId} onDelete={handleDelete} />
      <ResourceSection resources={resources} />
    </div>
  );

  if (embedded) return content;
  return <div className="flex-1 flex flex-col bg-bg">{content}</div>;
}

export function TeamRunsRoute() {
  useDrawerHeader({ title: 'Runs / Queue' });
  return <TeamRunsPanel />;
}
