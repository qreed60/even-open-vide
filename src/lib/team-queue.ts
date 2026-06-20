import type { RpcResponse } from '../domain/daemon-client';

export type QueueScope = 'global' | 'team';

export interface QueueDisplayItem {
  id: string;
  kind: 'run' | 'task' | 'resource';
  category: 'running' | 'queued' | 'waiting' | 'history' | 'other';
  title: string;
  status: string;
  teamId?: string;
  teamName?: string;
  source?: string;
  route?: string;
  currentMember?: string;
  currentState?: string;
  resourceKey?: string;
  provider?: string;
  model?: string;
  runIds?: string[];
  primaryRunId?: string;
  primaryRunStatus?: string;
  primaryRunCurrentState?: string;
  linkedQueueTaskId?: string;
  linkedBoardTaskId?: string;
  linkedBoardTaskStatus?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface QueueSummary {
  taskCount: number;
  runningCount: number;
  queuedCount: number;
  waitingCount: number;
}

export interface QueueData {
  items: QueueDisplayItem[];
  resources: QueueDisplayItem[];
  unsupported: boolean;
}

type AnyRecord = Record<string, unknown>;

const RUN_KEYS = ['runs', 'queueRuns', 'teamRuns', 'runningRuns', 'activeRuns', 'recentRuns', 'runHistory', 'history', 'completedRuns'];
const TASK_KEYS = ['tasks', 'queueTasks', 'teamTasks', 'queuedTasks', 'queued', 'pendingTasks', 'waitingTasks', 'queue', 'items'];
const LEGACY_BOARD_TASK_KEYS = ['tasks', 'teamTasks'];
const RESOURCE_KEYS = ['resources', 'modelResources', 'resourceStates', 'resourceStatus', 'waitingResources'];
const QUEUE_TASK_STATUSES = new Set([
  'queued',
  'waiting_for_team_slot',
  'waiting_for_model',
  'running',
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'interrupted',
]);
const LEGACY_BOARD_STATUSES = new Set(['todo', 'done', 'review', 'approved']);

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function readText(record: AnyRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const text = toText(record[key]);
    if (text) return text;
  }
  return undefined;
}

function readNestedText(record: AnyRecord, keys: string[]): string | undefined {
  const direct = readText(record, keys);
  if (direct) return direct;
  for (const value of Object.values(record)) {
    if (!isRecord(value)) continue;
    const nested = readText(value, keys);
    if (nested) return nested;
  }
  return undefined;
}

function collectRecords(value: unknown, keys: string[], depth = 0): unknown[] {
  if (depth > 4 || !isRecord(value)) return [];
  const found: unknown[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (keys.includes(key) && Array.isArray(entry)) found.push(...entry);
    if (keys.includes(key) && isRecord(entry)) {
      found.push(...Object.values(entry).flatMap((nested) => {
        if (Array.isArray(nested)) return nested;
        if (isRecord(nested)) return [nested];
        return [];
      }));
    }
    if (isRecord(entry)) found.push(...collectRecords(entry, keys, depth + 1));
  }
  return found;
}

function normalizeStatus(value: string): QueueDisplayItem['category'] {
  const status = value.toLowerCase().replace(/\s+/g, '_');
  if (['running', 'active', 'in_progress', 'started', 'dispatching', 'executing'].some((part) => status.includes(part))) return 'running';
  if (['queued', 'pending', 'ready'].some((part) => status.includes(part))) return 'queued';
  if (status.includes('waiting_for_team_slot') || status.includes('waiting_for_model') || status.includes('waiting')) return 'waiting';
  if (['completed', 'complete', 'failed', 'cancelled', 'canceled', 'interrupted', 'success', 'done', 'error'].some((part) => status.includes(part))) return 'history';
  return 'other';
}

function compactRoute(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => toText(entry) ?? (isRecord(entry) ? readText(entry, ['name', 'member', 'id']) : undefined)).filter(Boolean).join(' -> ') || undefined;
  if (isRecord(value)) return readText(value, ['label', 'name', 'id', 'current']) ?? JSON.stringify(value);
  return undefined;
}

function directStatus(value: AnyRecord, kind: QueueDisplayItem['kind']): string {
  return readText(value, ['status', 'state', 'phase', 'queueState', 'runState']) ?? (kind === 'resource' ? 'waiting' : 'unknown');
}

function normalizedStatusText(status: string): string {
  return status.toLowerCase().replace(/\s+/g, '_');
}

function isQueueTaskRecord(value: AnyRecord, status: string): boolean {
  const id = readText(value, ['id', 'taskId', 'task_id']);
  const normalizedStatus = normalizedStatusText(status);
  return Boolean(
    id?.startsWith('queue_task_')
    || QUEUE_TASK_STATUSES.has(normalizedStatus)
    || Array.isArray(value.runIds)
    || isRecord(value.sourceRef)
    || value.queuedAt
    || value.queued_at
    || value.priority
  );
}

function isLegacyBoardTaskRecord(value: AnyRecord): boolean {
  const id = readText(value, ['id', 'taskId', 'task_id']);
  const status = readText(value, ['status', 'state']);
  return Boolean(id && status && LEGACY_BOARD_STATUSES.has(normalizedStatusText(status)));
}

function collectBoardTaskStatuses(responses: RpcResponse[]): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const response of responses) {
    if (!response.ok) continue;
    for (const entry of collectRecords(response, LEGACY_BOARD_TASK_KEYS)) {
      if (!isRecord(entry) || !isLegacyBoardTaskRecord(entry)) continue;
      const id = readText(entry, ['id', 'taskId', 'task_id']);
      const status = readText(entry, ['status', 'state']);
      if (id && status) statuses.set(id, status);
    }
  }
  return statuses;
}

function collectQueueTaskBoardRefs(responses: RpcResponse[], boardTaskStatuses: Map<string, string>): Map<string, { boardTaskId: string; boardTaskStatus?: string }> {
  const refs = new Map<string, { boardTaskId: string; boardTaskStatus?: string }>();
  for (const response of responses) {
    if (!response.ok) continue;
    for (const entry of collectRecords(response, TASK_KEYS)) {
      if (!isRecord(entry)) continue;
      const status = directStatus(entry, 'task');
      if (!isQueueTaskRecord(entry, status)) continue;
      const id = readText(entry, ['id', 'taskId', 'task_id']);
      const boardTaskId = readNestedText(entry, ['boardTaskId', 'board_task_id']);
      if (id && boardTaskId) refs.set(id, { boardTaskId, boardTaskStatus: boardTaskStatuses.get(boardTaskId) });
    }
  }
  return refs;
}

function normalizeItem(
  value: unknown,
  kind: QueueDisplayItem['kind'],
  index: number,
  teamNames: Map<string, string>,
  boardTaskStatuses: Map<string, string>,
  queueTaskBoardRefs: Map<string, { boardTaskId: string; boardTaskStatus?: string }>,
): QueueDisplayItem | null {
  if (!isRecord(value)) return null;
  const status = directStatus(value, kind);
  if (kind === 'task' && !isQueueTaskRecord(value, status)) return null;
  const teamId = readNestedText(value, ['teamId', 'team_id']);
  const explicitId = readNestedText(value, ['id', 'taskId', 'task_id', 'runId', 'run_id', 'resourceKey']);
  const resourceKey = readNestedText(value, ['resourceKey', 'resource_key', 'key']) ?? readNestedText(value, ['providerModelKey']);
  const provider = readNestedText(value, ['provider', 'tool']);
  const model = readNestedText(value, ['model', 'modelId', 'model_id']);
  if (kind === 'run' && !explicitId) return null;
  if (kind === 'resource' && !explicitId && !resourceKey && !provider && !model) return null;
  const resourceIdentity = [provider, model].filter(Boolean).join(':') || undefined;
  const id = explicitId ?? resourceKey ?? resourceIdentity ?? `${kind}-${teamId ?? 'global'}-${index}`;
  const title = readNestedText(value, ['title', 'subject', 'name', 'prompt', 'request', 'description']) ?? id;
  const linkedQueueTaskId = readNestedText(value, ['taskId', 'task_id']);
  const linkedQueueTaskRef = linkedQueueTaskId ? queueTaskBoardRefs.get(linkedQueueTaskId) : undefined;
  const linkedBoardTaskId = readNestedText(value, ['boardTaskId', 'board_task_id']) ?? linkedQueueTaskRef?.boardTaskId;
  const runIds = Array.isArray(value.runIds)
    ? value.runIds.map((entry) => toText(entry)).filter((entry): entry is string => Boolean(entry))
    : undefined;
  return {
    id,
    kind,
    category: normalizeStatus(status),
    title,
    status,
    teamId,
    teamName: readNestedText(value, ['teamName', 'team_name']) ?? (teamId ? teamNames.get(teamId) : undefined),
    source: readNestedText(value, ['source', 'taskSource', 'task_source', 'origin', 'producer']),
    route: compactRoute(value.route ?? value.routing ?? value.path),
    currentMember: readNestedText(value, ['currentMember', 'current_member', 'member', 'owner', 'assignee']),
    currentState: readNestedText(value, ['currentState', 'current_state', 'stage', 'step']),
    resourceKey,
    provider,
    model,
    runIds,
    linkedQueueTaskId,
    linkedBoardTaskId,
    linkedBoardTaskStatus: linkedBoardTaskId ? boardTaskStatuses.get(linkedBoardTaskId) ?? linkedQueueTaskRef?.boardTaskStatus : undefined,
    createdAt: readNestedText(value, ['createdAt', 'created_at', 'queuedAt', 'queued_at']),
    startedAt: readNestedText(value, ['startedAt', 'started_at', 'dispatchedAt', 'dispatched_at']),
    finishedAt: readNestedText(value, ['finishedAt', 'finished_at', 'completedAt', 'completed_at', 'endedAt', 'ended_at']),
  };
}

function mergeTaskRunPairs(items: QueueDisplayItem[]): QueueDisplayItem[] {
  const runs = items.filter((item) => item.kind === 'run');
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const mergedRunIds = new Set<string>();

  const mergedItems = items.map((item) => {
    if (item.kind !== 'task') return item;
    const linkedRuns = [
      ...(item.runIds ?? []).map((runId) => runsById.get(runId)).filter((run): run is QueueDisplayItem => Boolean(run)),
      ...runs.filter((run) => run.linkedQueueTaskId === item.id),
    ];
    const uniqueRuns = linkedRuns.filter((run, index, allRuns) => allRuns.findIndex((entry) => entry.id === run.id) === index);
    if (uniqueRuns.length === 0) return item;

    for (const run of uniqueRuns) mergedRunIds.add(run.id);
    const primaryRun = uniqueRuns[0];
    return {
      ...item,
      category: item.category === 'other' ? primaryRun.category : item.category,
      status: item.status === 'unknown' ? primaryRun.status : item.status,
      route: item.route ?? primaryRun.route,
      currentMember: item.currentMember ?? primaryRun.currentMember,
      currentState: item.currentState ?? primaryRun.currentState,
      resourceKey: item.resourceKey ?? primaryRun.resourceKey,
      provider: item.provider ?? primaryRun.provider,
      model: item.model ?? primaryRun.model,
      primaryRunId: primaryRun.id,
      primaryRunStatus: primaryRun.status,
      primaryRunCurrentState: primaryRun.currentState,
      startedAt: item.startedAt ?? primaryRun.startedAt,
      finishedAt: item.finishedAt ?? primaryRun.finishedAt,
    };
  });

  return mergedItems.filter((item) => item.kind !== 'run' || !mergedRunIds.has(item.id));
}

export function normalizeQueueData(responses: RpcResponse[], teamNames = new Map<string, string>()): QueueData {
  const okResponses = responses.filter((response) => response.ok);
  const boardTaskStatuses = collectBoardTaskStatuses(okResponses);
  const queueTaskBoardRefs = collectQueueTaskBoardRefs(okResponses, boardTaskStatuses);
  const normalized = okResponses.flatMap((response) => {
    const runs = collectRecords(response, RUN_KEYS).map((entry, index) => normalizeItem(entry, 'run', index, teamNames, boardTaskStatuses, queueTaskBoardRefs));
    const tasks = collectRecords(response, TASK_KEYS).map((entry, index) => normalizeItem(entry, 'task', index, teamNames, boardTaskStatuses, queueTaskBoardRefs));
    return [...runs, ...tasks].filter((entry): entry is QueueDisplayItem => Boolean(entry));
  });
  const resources = okResponses.flatMap((response) => (
    collectRecords(response, RESOURCE_KEYS)
      .map((entry, index) => normalizeItem(entry, 'resource', index, teamNames, boardTaskStatuses, queueTaskBoardRefs))
      .filter((entry): entry is QueueDisplayItem => Boolean(entry))
  ));
  const seen = new Set<string>();
  const items = mergeTaskRunPairs(normalized.filter((item) => {
    const key = `${item.kind}:${item.id}:${item.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
  return {
    items,
    resources,
    unsupported: responses.length > 0 && okResponses.length === 0,
  };
}

export function summarizeQueue(items: QueueDisplayItem[]): QueueSummary {
  return {
    taskCount: items.filter((item) => item.kind === 'task').length,
    runningCount: items.filter((item) => item.category === 'running').length,
    queuedCount: items.filter((item) => item.category === 'queued').length,
    waitingCount: items.filter((item) => item.category === 'waiting').length,
  };
}

export function summaryForTeam(items: QueueDisplayItem[], teamId: string): QueueSummary {
  return summarizeQueue(items.filter((item) => item.teamId === teamId));
}
