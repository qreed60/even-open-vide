import type { RpcResponse } from '../domain/daemon-client';

export type QueueScope = 'global' | 'team';
export type QueueDisplayCategory = 'running' | 'queued' | 'waiting' | 'history' | 'other';

export interface QueueDisplayItem {
  id: string;
  kind: 'run' | 'task' | 'resource';
  category: QueueDisplayCategory;
  title: string;
  description?: string;
  excerpt?: string;
  status: string;
  executionStatus?: string;
  reviewStatus?: string;
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
  runId?: string;
  queueTaskId?: string;
  queueRunIds?: string[];
  clientMessageId?: string;
  assistantText?: string;
  assistantFrom?: string;
  assistantStatus?: string;
  assistantRoute?: string[];
  assistantProvider?: string;
  assistantModel?: string;
  primaryRunId?: string;
  primaryRunStatus?: string;
  primaryRunCurrentState?: string;
  linkedQueueTaskId?: string;
  linkedBoardTaskId?: string;
  linkedBoardTaskStatus?: string;
  priority?: string;
  position?: string;
  reorderable?: boolean;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface DeletedQueueItemRecord {
  id: string;
  teamId?: string;
  text?: string;
  to?: string;
  createdAt?: string;
  queueTaskId?: string;
  queueRunId?: string;
  queueRunIds?: string[];
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

export type QueueDisplayGroups = Record<QueueDisplayCategory, QueueDisplayItem[]>;

type AnyRecord = Record<string, unknown>;

const RUN_KEYS = ['runs', 'queueRuns', 'teamRuns', 'runningRuns', 'activeRuns', 'recentRuns', 'runHistory', 'history', 'completedRuns'];
const TASK_KEYS = ['task', 'queueTask', 'parentQueueTask', 'tasks', 'queueTasks', 'teamTasks', 'queuedTasks', 'queued', 'pendingTasks', 'waitingTasks', 'queue', 'items'];
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
const RAW_ID_PATTERN = /^(queue_task_|queue_run_|task_|board_item_)[A-Za-z0-9_-]*/;
const DESCRIPTION_MAX_LENGTH = 180;
const GENERIC_QUEUE_TITLES = new Set(['queued run', 'queued task', 'queued chat', 'queue run', 'queue task']);
const DELETED_QUEUE_ITEMS_KEY = 'openvide.deletedQueueItems.v1';
const DELETED_QUEUE_CHATS_KEY_PREFIX = 'openvide.teamChat.deletedQueuedMessages.';
const TERMINAL_DELETE_STATUSES = ['cancel', 'failed', 'complete', 'done', 'success', 'interrupt', 'blocked'];

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

function readNestedRecord(record: AnyRecord, keys: string[]): AnyRecord | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  for (const value of Object.values(record)) {
    if (!isRecord(value)) continue;
    for (const key of keys) {
      const nested = value[key];
      if (isRecord(nested)) return nested;
    }
  }
  return undefined;
}

function readStringArray(record: AnyRecord | undefined, keys: string[], nested = false): string[] | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const strings = value.map(toText).filter((entry): entry is string => Boolean(entry));
      if (strings.length > 0) return strings;
    }
  }
  if (!nested) return undefined;
  for (const value of Object.values(record)) {
    if (!isRecord(value)) continue;
    const nestedValue = readStringArray(value, keys);
    if (nestedValue?.length) return nestedValue;
  }
  return undefined;
}

function readBoolean(record: AnyRecord | undefined, keys: string[], nested = false): boolean | undefined {
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
  if (!nested) return undefined;
  for (const value of Object.values(record)) {
    if (!isRecord(value)) continue;
    const nestedValue = readBoolean(value, keys);
    if (nestedValue !== undefined) return nestedValue;
  }
  return undefined;
}

function isRawIdText(value: string | undefined): boolean {
  return Boolean(value && RAW_ID_PATTERN.test(value));
}

function excerptText(value: string | undefined, maxLength = DESCRIPTION_MAX_LENGTH): string | undefined {
  if (!value) return undefined;
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) return undefined;
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength - 1).trimEnd()}...`;
}

function shortTitleFromText(value: string | undefined): string | undefined {
  const excerpt = excerptText(value, 72);
  if (!excerpt || isRawIdText(excerpt)) return undefined;
  return excerpt;
}

function normalizedSource(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[\s-]+/g, '_');
}

function readableText(record: AnyRecord | undefined, keys: string[], nested = false): string | undefined {
  if (!record) return undefined;
  const value = nested ? readNestedText(record, keys) : readText(record, keys);
  return isRawIdText(value) ? undefined : value;
}

function isChatWorkItem(value: AnyRecord, parentQueueTask?: AnyRecord): boolean {
  const source = readableText(parentQueueTask, ['source', 'taskSource', 'task_source', 'origin', 'producer'])
    ?? readableText(value, ['source', 'taskSource', 'task_source', 'origin', 'producer'], true)
    ?? readableText(parentQueueTask, ['type', 'kind'])
    ?? readableText(value, ['type', 'kind'], true);
  if (source?.toLowerCase().includes('chat')) return true;
  return Boolean(
    (parentQueueTask && (parentQueueTask.to || parentQueueTask.from) && (parentQueueTask.message || parentQueueTask.text || parentQueueTask.prompt))
    || ((value.to || value.from) && (value.message || value.text || value.prompt)),
  );
}

function isBoardWorkItem(value: AnyRecord, parentQueueTask?: AnyRecord): boolean {
  const source = readableText(parentQueueTask, ['source', 'taskSource', 'task_source', 'origin', 'producer'])
    ?? readableText(value, ['source', 'taskSource', 'task_source', 'origin', 'producer'], true)
    ?? readableText(parentQueueTask, ['type', 'kind'])
    ?? readableText(value, ['type', 'kind'], true);
  const normalized = normalizedSource(source);
  return normalized.includes('board') || Boolean(readNestedText(value, ['boardTaskId', 'board_task_id']));
}

function collectRecords(value: unknown, keys: string[], depth = 0): unknown[] {
  if (depth > 4 || !isRecord(value)) return [];
  const found: unknown[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (keys.includes(key) && Array.isArray(entry)) found.push(...entry);
    if (keys.includes(key) && isRecord(entry)) {
      found.push(entry);
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

function normalizeStatus(value: string): QueueDisplayCategory {
  const status = value.toLowerCase().replace(/\s+/g, '_');
  if (['running', 'active', 'in_progress', 'started', 'dispatching', 'executing'].some((part) => status.includes(part))) return 'running';
  if (['queued', 'pending', 'ready'].some((part) => status.includes(part))) return 'queued';
  if (status.includes('waiting_for_team_slot') || status.includes('waiting_for_model') || status.includes('waiting')) return 'waiting';
  if (['completed', 'complete', 'failed', 'cancelled', 'canceled', 'interrupted', 'blocked', 'success', 'done', 'error'].some((part) => status.includes(part))) return 'history';
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

function displayDescription(value: AnyRecord, parentQueueTask?: AnyRecord): string | undefined {
  return readableText(parentQueueTask, [
    'boardDescription',
    'board_description',
    'itemDescription',
    'item_description',
    'description',
    'prompt',
    'message',
    'text',
    'request',
    'summary',
    'body',
    'details',
  ]) ?? readableText(value, [
    'boardDescription',
    'board_description',
    'itemDescription',
    'item_description',
    'description',
    'prompt',
    'message',
    'text',
    'request',
    'summary',
    'body',
    'details',
  ], true);
}

function displayTitle(value: AnyRecord, description: string | undefined, id: string, kind: QueueDisplayItem['kind'], parentQueueTask?: AnyRecord): string {
  const source = readableText(parentQueueTask, ['source', 'taskSource', 'task_source', 'origin', 'producer'])
    ?? readableText(value, ['source', 'taskSource', 'task_source', 'origin', 'producer'], true);
  const descriptionTitle = shortTitleFromText(description);
  const chatWorkItem = source?.toLowerCase().includes('chat') || isChatWorkItem(value, parentQueueTask);
  const boardWorkItem = isBoardWorkItem(value, parentQueueTask);

  if (chatWorkItem && descriptionTitle) return `Team chat: ${descriptionTitle}`;

  const boardTitle = readableText(parentQueueTask, ['boardTitle', 'board_title', 'itemTitle', 'item_title'])
    ?? readableText(value, ['boardTitle', 'board_title', 'itemTitle', 'item_title'], true);
  if (boardWorkItem && boardTitle) return boardTitle;

  const title = readableText(parentQueueTask, ['title', 'subject', 'name'])
    ?? readableText(value, ['title', 'subject', 'name'], true);
  if (title && !GENERIC_QUEUE_TITLES.has(title.toLowerCase())) return title;

  if (descriptionTitle) return descriptionTitle;
  if (kind === 'run') return 'Queued run';
  if (kind === 'task') return 'Queued task';
  return isRawIdText(id) ? 'Resource wait' : id;
}

function normalizedStatusText(status: string): string {
  return status.toLowerCase().replace(/\s+/g, '_');
}

function isDeletedStatus(status: string): boolean {
  return normalizedStatusText(status).includes('deleted');
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
  const parentQueueTask = kind === 'run' ? readNestedRecord(value, ['queueTask', 'parentQueueTask', 'task']) : undefined;
  const teamId = readNestedText(value, ['teamId', 'team_id']);
  const explicitId = kind === 'run'
    ? readNestedText(value, ['id', 'runId', 'run_id'])
      ?? readNestedText(value, ['queueRunId', 'queue_run_id'])
    : readNestedText(value, ['id', 'taskId', 'task_id', 'queueTaskId', 'queue_task_id', 'resourceKey']);
  const resourceKey = readNestedText(value, ['resourceKey', 'resource_key', 'key']) ?? readNestedText(value, ['providerModelKey']);
  const provider = readNestedText(value, ['provider', 'tool']);
  const model = readNestedText(value, ['model', 'modelId', 'model_id']);
  if (kind === 'run' && !explicitId) return null;
  if (kind === 'resource' && !explicitId && !resourceKey && !provider && !model) return null;
  const resourceIdentity = [provider, model].filter(Boolean).join(':') || undefined;
  const id = explicitId ?? resourceKey ?? resourceIdentity ?? `${kind}-${teamId ?? 'global'}-${index}`;
  const description = displayDescription(value, parentQueueTask);
  const title = displayTitle(value, description, id, kind, parentQueueTask);
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  const queuedChatResult = readNestedRecord(value, ['queuedChatResult', 'queued_chat_result']);
  const sourceRef = readNestedRecord(value, ['sourceRef', 'source_ref'])
    ?? (parentQueueTask ? readNestedRecord(parentQueueTask, ['sourceRef', 'source_ref']) : undefined);
  const linkedQueueTaskId = readNestedText(value, ['taskId', 'task_id', 'queueTaskId', 'queue_task_id'])
    ?? (parentQueueTask ? readText(parentQueueTask, ['id', 'taskId', 'task_id', 'queueTaskId', 'queue_task_id']) : undefined);
  const linkedQueueTaskRef = linkedQueueTaskId ? queueTaskBoardRefs.get(linkedQueueTaskId) : undefined;
  const linkedBoardTaskId = readNestedText(value, ['boardTaskId', 'board_task_id']) ?? linkedQueueTaskRef?.boardTaskId;
  const runIds = Array.isArray(value.runIds)
    ? value.runIds.map((entry) => toText(entry)).filter((entry): entry is string => Boolean(entry))
    : undefined;
  const queueRunIds = [
    ...(runIds ?? []),
    readNestedText(value, ['queueRunId', 'queue_run_id']),
    ...(readStringArray(value, ['queueRunIds', 'queue_run_ids'], true) ?? []),
  ].filter((runId, runIndex, allRunIds): runId is string => Boolean(runId) && allRunIds.indexOf(runId) === runIndex);
  return {
    id,
    kind,
    category: normalizeStatus(status),
    title,
    description,
    excerpt: excerptText(description),
    status,
    executionStatus: status,
    reviewStatus: readableText(value, ['reviewStatus', 'review_status'], true),
    teamId,
    teamName: readNestedText(value, ['teamName', 'team_name']) ?? (teamId ? teamNames.get(teamId) : undefined),
    source: readableText(value, ['source', 'taskSource', 'task_source', 'origin', 'producer'], true),
    route: compactRoute(value.route ?? value.routing ?? value.path),
    currentMember: readableText(value, ['currentMember', 'current_member', 'member', 'owner', 'assignee'], true),
    currentState: readableText(value, ['currentState', 'current_state', 'stage', 'step'], true),
    resourceKey,
    provider,
    model,
    runIds: runIds ?? (queueRunIds.length > 0 ? queueRunIds : undefined),
    runId: kind === 'run' ? id : undefined,
    queueTaskId: kind === 'task' ? id : linkedQueueTaskId,
    queueRunIds: queueRunIds.length > 0 ? queueRunIds : undefined,
    clientMessageId: readNestedText(value, ['clientMessageId', 'client_message_id', 'messageId', 'message_id'])
      ?? (sourceRef ? readText(sourceRef, ['clientMessageId', 'client_message_id', 'messageId', 'message_id']) : undefined),
    assistantText: readableText(queuedChatResult, ['assistantText', 'assistant_text'])
      ?? readableText(value, ['assistantText', 'assistant_text'], true),
    assistantFrom: readableText(queuedChatResult, ['memberName', 'member_name', 'from'])
      ?? readableText(value, ['memberName', 'member_name', 'from'], true),
    assistantStatus: readableText(queuedChatResult, ['finalStatus', 'final_status', 'status'])
      ?? readableText(value, ['finalStatus', 'final_status'], true),
    assistantRoute: readStringArray(queuedChatResult, ['route'])
      ?? readStringArray(value, ['route'], true),
    assistantProvider: readableText(queuedChatResult, ['provider', 'tool'])
      ?? readableText(value, ['provider', 'tool'], true),
    assistantModel: readableText(queuedChatResult, ['model', 'modelId', 'model_id'])
      ?? readableText(value, ['model', 'modelId', 'model_id'], true),
    linkedQueueTaskId,
    linkedBoardTaskId,
    linkedBoardTaskStatus: linkedBoardTaskId ? boardTaskStatuses.get(linkedBoardTaskId) ?? linkedQueueTaskRef?.boardTaskStatus : undefined,
    priority: readableText(value, ['priority', 'queuePriority', 'queue_priority'], true),
    position: readableText(value, ['position', 'order', 'queuePosition', 'queue_position', 'sortIndex', 'sort_index'], true),
    reorderable: readBoolean(value, ['reorderable', 'canReorder', 'can_reorder', 'supportsReorder', 'supports_reorder'], true),
    createdAt: readNestedText(value, ['createdAt', 'created_at', 'queuedAt', 'queued_at']),
    updatedAt: readNestedText(value, ['updatedAt', 'updated_at']),
    startedAt: readNestedText(value, ['startedAt', 'started_at', 'dispatchedAt', 'dispatched_at']),
    finishedAt: readNestedText(value, ['finishedAt', 'finished_at', 'completedAt', 'completed_at', 'endedAt', 'ended_at']),
    metadata,
  };
}

function mergeTaskRunPairs(items: QueueDisplayItem[]): QueueDisplayItem[] {
  const runs = items.filter((item) => item.kind === 'run');
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const taskIds = new Set(items
    .filter((item) => item.kind === 'task')
    .map((item) => item.queueTaskId ?? item.id));
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
      description: item.description ?? primaryRun.description,
      route: item.route ?? primaryRun.route,
      currentMember: item.currentMember ?? primaryRun.currentMember,
      currentState: item.currentState ?? primaryRun.currentState,
      resourceKey: item.resourceKey ?? primaryRun.resourceKey,
      provider: item.provider ?? primaryRun.provider,
      model: item.model ?? primaryRun.model,
      primaryRunId: primaryRun.id,
      primaryRunStatus: primaryRun.status,
      primaryRunCurrentState: primaryRun.currentState,
      queueRunIds: item.queueRunIds ?? [primaryRun.id],
      startedAt: item.startedAt ?? primaryRun.startedAt,
      updatedAt: item.updatedAt ?? primaryRun.updatedAt,
      finishedAt: item.finishedAt ?? primaryRun.finishedAt,
    };
  });

  const seenLogicalItems = new Set<string>();
  return mergedItems
    .filter((item) => item.kind !== 'run' || (!mergedRunIds.has(item.id) && !(item.linkedQueueTaskId && taskIds.has(item.linkedQueueTaskId))))
    .filter((item) => {
      const logicalId = item.kind === 'run' && item.linkedQueueTaskId ? item.linkedQueueTaskId : item.id;
      const key = `${item.kind}:${logicalId}:${item.teamId ?? ''}`;
      if (seenLogicalItems.has(key)) return false;
      seenLogicalItems.add(key);
      return true;
    });
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
    if (isDeletedStatus(item.status)) return false;
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

export function queueDisplayItemIsChat(item: QueueDisplayItem): boolean {
  const source = normalizedSource(item.source);
  if (source.includes('chat')) return true;
  if (item.title.toLowerCase().startsWith('team chat:')) return true;
  const metadataSource = typeof item.metadata?.source === 'string' ? item.metadata.source : undefined;
  return normalizedSource(metadataSource).includes('chat');
}

export function queueDisplayItemStableTaskId(item: QueueDisplayItem): string {
  return item.queueTaskId ?? item.linkedQueueTaskId ?? (item.kind === 'task' ? item.id : item.id);
}

export function queueDisplayItemDeleteTarget(item: QueueDisplayItem): { queueTaskId?: string; queueRunId?: string } | null {
  const queueTaskId = item.queueTaskId ?? item.linkedQueueTaskId ?? (item.kind === 'task' ? item.id : undefined);
  if (queueTaskId) return { queueTaskId };
  const queueRunId = item.primaryRunId ?? item.runId ?? (item.kind === 'run' ? item.id : undefined) ?? item.queueRunIds?.[0] ?? item.runIds?.[0];
  if (queueRunId) return { queueRunId };
  return null;
}

export function queueDisplayItemDeleteId(item: QueueDisplayItem): string | undefined {
  const target = queueDisplayItemDeleteTarget(item);
  return target?.queueTaskId ?? target?.queueRunId;
}

export function queueDisplayItemPrompt(item: QueueDisplayItem): string {
  const text = item.description ?? item.excerpt ?? item.title.replace(/^Team chat:\s*/i, '').trim();
  return text || 'Message queued';
}

export function queueDisplayItemIsRunning(item: QueueDisplayItem): boolean {
  return item.category === 'running' || /running|active|in_progress|started|dispatching|executing/i.test(item.status);
}

export function queueDisplayItemCanDelete(item: QueueDisplayItem): boolean {
  if (queueDisplayItemIsRunning(item)) return false;
  if (!queueDisplayItemDeleteTarget(item)) return false;
  const normalized = item.status.toLowerCase().replace(/[\s-]+/g, '_');
  return TERMINAL_DELETE_STATUSES.some((part) => normalized.includes(part));
}

export function queueDisplayItemReorderTarget(item: QueueDisplayItem): { queueTaskId: string } | null {
  const queueTaskId = item.queueTaskId ?? item.linkedQueueTaskId ?? (item.kind === 'task' ? item.id : undefined);
  if (!queueTaskId) return null;
  return { queueTaskId };
}

export function queueDisplayItemCanReorder(item: QueueDisplayItem): boolean {
  if (!queueDisplayItemReorderTarget(item)) return false;
  if (item.reorderable === false) return false;
  const normalized = item.status.toLowerCase().replace(/[\s-]+/g, '_');
  if (queueDisplayItemIsRunning(item)) return false;
  if (['completed', 'complete', 'failed', 'cancelled', 'canceled', 'interrupted', 'deleted'].some((part) => normalized.includes(part))) return false;
  return item.reorderable === true
    || ['queued', 'waiting', 'waiting_for_team_slot', 'waiting_for_model', 'blocked'].some((part) => normalized.includes(part))
    || item.category === 'queued'
    || item.category === 'waiting';
}

function safeParseDeletedQueueRecords(value: string | null): DeletedQueueItemRecord[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is DeletedQueueItemRecord => isRecord(entry) && typeof entry.id === 'string' && entry.id.trim().length > 0)
      .map((entry) => ({
        ...entry,
        queueRunIds: Array.isArray(entry.queueRunIds) ? entry.queueRunIds.filter((runId): runId is string => typeof runId === 'string') : undefined,
      }));
  } catch {
    return [];
  }
}

export function loadDeletedQueueItems(): DeletedQueueItemRecord[] {
  if (typeof window === 'undefined') return [];
  return safeParseDeletedQueueRecords(window.localStorage.getItem(DELETED_QUEUE_ITEMS_KEY));
}

export function saveDeletedQueueItem(record: DeletedQueueItemRecord) {
  if (typeof window === 'undefined' || !record.id) return;
  const existing = loadDeletedQueueItems().filter((entry) => entry.id !== record.id);
  window.localStorage.setItem(DELETED_QUEUE_ITEMS_KEY, JSON.stringify([...existing, record]));
}

export function deletedQueueItemIds(records = loadDeletedQueueItems()): Set<string> {
  return new Set(records.flatMap((record) => [
    record.id,
    record.queueTaskId,
    record.queueRunId,
    ...(record.queueRunIds ?? []),
  ].filter((entry): entry is string => Boolean(entry))));
}

export function queueDisplayItemIsDeleted(item: QueueDisplayItem, deletedIds = deletedQueueItemIds()): boolean {
  const ids = [
    queueDisplayItemDeleteId(item),
    item.queueTaskId,
    item.linkedQueueTaskId,
    item.primaryRunId,
    item.runId,
    ...(item.queueRunIds ?? []),
    ...(item.runIds ?? []),
    item.id,
  ];
  return ids.some((id) => Boolean(id && deletedIds.has(id)));
}

export function deletedQueueChatKey(teamId: string): string {
  return `${DELETED_QUEUE_CHATS_KEY_PREFIX}${teamId}`;
}

export function loadDeletedQueueChatRecords(teamId: string): DeletedQueueItemRecord[] {
  if (typeof window === 'undefined' || !teamId) return [];
  return safeParseDeletedQueueRecords(window.localStorage.getItem(deletedQueueChatKey(teamId)));
}

export function saveDeletedQueueChatRecord(teamId: string, record: DeletedQueueItemRecord) {
  if (typeof window === 'undefined' || !teamId || !record.id) return;
  const existing = loadDeletedQueueChatRecords(teamId).filter((entry) => entry.id !== record.id);
  window.localStorage.setItem(deletedQueueChatKey(teamId), JSON.stringify([...existing, record]));
  saveDeletedQueueItem({ ...record, teamId: record.teamId ?? teamId });
}

export function groupQueueDisplayItems(items: QueueDisplayItem[], resources: QueueDisplayItem[] = []): QueueDisplayGroups {
  void resources;
  return {
    running: items.filter((item) => item.category === 'running'),
    queued: items.filter((item) => item.category === 'queued'),
    waiting: items.filter((item) => item.category === 'waiting'),
    history: items.filter((item) => item.category === 'history'),
    other: items.filter((item) => item.category === 'other'),
  };
}

export function summarizeQueue(items: QueueDisplayItem[], resources: QueueDisplayItem[] = []): QueueSummary {
  void resources;
  const groups = groupQueueDisplayItems(items, resources);
  return {
    taskCount: items.filter((item) => item.kind === 'task').length,
    runningCount: groups.running.length,
    queuedCount: groups.queued.length,
    waitingCount: groups.waiting.length,
  };
}

export function summaryForTeam(items: QueueDisplayItem[], teamId: string): QueueSummary {
  return summarizeQueue(items.filter((item) => item.teamId === teamId));
}
