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

const RUN_KEYS = ['runs', 'teamRuns', 'runningRuns', 'activeRuns', 'recentRuns', 'runHistory', 'history', 'completedRuns'];
const TASK_KEYS = ['tasks', 'teamTasks', 'queuedTasks', 'queued', 'pendingTasks', 'waitingTasks', 'queue', 'items'];
const RESOURCE_KEYS = ['resources', 'modelResources', 'resourceStates', 'resourceStatus', 'waitingResources'];

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

function collectArrays(value: unknown, keys: string[], depth = 0): unknown[] {
  if (depth > 4 || !isRecord(value)) return [];
  const found: unknown[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (keys.includes(key) && Array.isArray(entry)) found.push(...entry);
    if (keys.includes(key) && isRecord(entry)) found.push(...Object.values(entry).flatMap((nested) => Array.isArray(nested) ? nested : []));
    if (isRecord(entry)) found.push(...collectArrays(entry, keys, depth + 1));
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

function normalizeItem(value: unknown, kind: QueueDisplayItem['kind'], index: number, teamNames: Map<string, string>): QueueDisplayItem | null {
  if (!isRecord(value)) return null;
  const status = readNestedText(value, ['status', 'state', 'phase', 'queueState', 'runState']) ?? (kind === 'resource' ? 'waiting' : 'unknown');
  const teamId = readNestedText(value, ['teamId', 'team_id']);
  const id = readNestedText(value, ['id', 'taskId', 'task_id', 'runId', 'run_id', 'resourceKey']) ?? `${kind}-${teamId ?? 'global'}-${index}`;
  const title = readNestedText(value, ['title', 'subject', 'name', 'prompt', 'request', 'description']) ?? id;
  const resourceKey = readNestedText(value, ['resourceKey', 'resource_key', 'key']) ?? readNestedText(value, ['providerModelKey']);
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
    provider: readNestedText(value, ['provider', 'tool']),
    model: readNestedText(value, ['model', 'modelId', 'model_id']),
    createdAt: readNestedText(value, ['createdAt', 'created_at', 'queuedAt', 'queued_at']),
    startedAt: readNestedText(value, ['startedAt', 'started_at', 'dispatchedAt', 'dispatched_at']),
    finishedAt: readNestedText(value, ['finishedAt', 'finished_at', 'completedAt', 'completed_at', 'endedAt', 'ended_at']),
  };
}

export function normalizeQueueData(responses: RpcResponse[], teamNames = new Map<string, string>()): QueueData {
  const okResponses = responses.filter((response) => response.ok);
  const normalized = okResponses.flatMap((response) => {
    const runs = collectArrays(response, RUN_KEYS).map((entry, index) => normalizeItem(entry, 'run', index, teamNames));
    const tasks = collectArrays(response, TASK_KEYS).map((entry, index) => normalizeItem(entry, 'task', index, teamNames));
    return [...runs, ...tasks].filter((entry): entry is QueueDisplayItem => Boolean(entry));
  });
  const resources = okResponses.flatMap((response) => (
    collectArrays(response, RESOURCE_KEYS)
      .map((entry, index) => normalizeItem(entry, 'resource', index, teamNames))
      .filter((entry): entry is QueueDisplayItem => Boolean(entry))
  ));
  const seen = new Set<string>();
  const items = normalized.filter((item) => {
    const key = `${item.kind}:${item.id}:${item.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
