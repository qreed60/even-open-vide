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
  queueDisplayItemIsChat,
  queueDisplayItemIsDeleted,
  queueDisplayItemPrompt,
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

function itemKey(item: QueueDisplayItem): string {
  return `${item.kind}:${item.id}:${item.status}:${item.teamId ?? ''}`;
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
  onCancel,
  onDelete,
}: {
  item: QueueDisplayItem;
  showTeam: boolean;
  cancellingId?: string | null;
  deletingId?: string | null;
  onCancel?: (item: QueueDisplayItem) => void;
  onDelete?: (item: QueueDisplayItem) => void;
}) {
  const createdAt = formatDate(item.createdAt);
  const startedAt = formatDate(item.startedAt);
  const finishedAt = formatDate(item.finishedAt);
  const resourceLabel = getResourceLabel(item);
  const cancelTarget = (item.category === 'queued' || item.category === 'waiting') ? cancellableTarget(item) : null;
  const cancelActionId = cancelTarget ? `${cancelTarget.kind}:${cancelTarget.id}` : null;
  const deleteId = queueDisplayItemDeleteId(item);
  const canDelete = queueDisplayItemCanDelete(item);
  const meta = [
    item.kind,
    item.source,
    showTeam ? item.teamName : undefined,
    item.priority ? `priority ${item.priority}` : undefined,
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
          </div>
          {(item.excerpt || item.description) && (
            <p className="mt-1.5 line-clamp-2 text-[12px] tracking-[-0.12px] text-text-dim">
              {item.excerpt ?? item.description}
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
  onCancel,
  onDelete,
}: {
  title: string;
  items: QueueDisplayItem[];
  icon: ReactNode;
  showTeam: boolean;
  cancellingId?: string | null;
  deletingId?: string | null;
  onCancel?: (item: QueueDisplayItem) => void;
  onDelete?: (item: QueueDisplayItem) => void;
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
          onCancel={onCancel}
          onDelete={onDelete}
        />
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
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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
      <QueueSection title="Queued" items={groupedItems.queued} icon={<IcEditChecklist width={16} height={16} />} showTeam={showTeam} cancellingId={cancellingId} onCancel={handleCancel} />
      <QueueSection title="Waiting" items={groupedItems.waiting} icon={<IcFeatTimeCounting width={16} height={16} />} showTeam={showTeam} cancellingId={cancellingId} onCancel={handleCancel} />
      <QueueSection title="History" items={groupedItems.history} icon={<IcEditChecklist width={16} height={16} />} showTeam={showTeam} deletingId={deletingId} onDelete={handleDelete} />
      <QueueSection title="Other" items={groupedItems.other} icon={<IcStatusAlert width={16} height={16} />} showTeam={showTeam} deletingId={deletingId} onDelete={handleDelete} />
    </div>
  );

  if (embedded) return content;
  return <div className="flex-1 flex flex-col bg-bg">{content}</div>;
}

export function TeamRunsRoute() {
  useDrawerHeader({ title: 'Runs / Queue' });
  return <TeamRunsPanel />;
}
