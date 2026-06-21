import type { RpcResponse } from '../domain/daemon-client';

export type BoardExecutionStatus =
  | 'draft'
  | 'queued'
  | 'waiting_for_team_slot'
  | 'waiting_for_model'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'blocked';

export type NormalizedBoardExecutionStatus = BoardExecutionStatus | 'waiting';
export type BoardExecutionGroup = Exclude<NormalizedBoardExecutionStatus, 'waiting_for_team_slot' | 'waiting_for_model'> | 'other';

export type BoardReviewStatus =
  | 'not_required'
  | 'pending_review'
  | 'approved'
  | 'revise'
  | 'rejected';

export interface TeamBoardItem {
  id: string;
  teamId?: string;
  title: string;
  description?: string;
  excerpt?: string;
  source?: string;
  executionStatus: BoardExecutionStatus | string;
  reviewStatus: BoardReviewStatus | string;
  assignedMembers: string[];
  reviewerMembers: string[];
  priority?: string;
  queueTaskId?: string;
  queueRunIds: string[];
  createdAt?: string;
  updatedAt?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  blockedReason?: string;
  reviewFeedback?: string;
}

type AnyRecord = Record<string, unknown>;

const BOARD_ITEM_KEYS = ['items', 'boardItems', 'teamBoardItems', 'teamBoard', 'board'];
export const BOARD_EXECUTION_GROUP_ORDER: BoardExecutionGroup[] = [
  'draft',
  'queued',
  'waiting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'blocked',
];
const WAITING_BOARD_EXECUTION_STATUSES = new Set<NormalizedBoardExecutionStatus>([
  'waiting',
  'waiting_for_team_slot',
  'waiting_for_model',
]);
const RAW_ID_PATTERN = /^(queue_task_|queue_run_|task_|board_item_)[A-Za-z0-9_-]*/;
const DESCRIPTION_MAX_LENGTH = 220;
const BOARD_EXECUTION_STATUS_ALIASES: Record<string, BoardExecutionStatus | 'waiting'> = {
  todo: 'draft',
  open: 'draft',
  queued: 'queued',
  pending: 'queued',
  waiting: 'waiting',
  waiting_for_slot: 'waiting_for_team_slot',
  waiting_for_team_slot: 'waiting_for_team_slot',
  waiting_for_model: 'waiting_for_model',
  running: 'running',
  in_progress: 'running',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  interrupted: 'interrupted',
  blocked: 'blocked',
};

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
    const value = toText(record[key]);
    if (value) return value;
  }
  return undefined;
}

function readStringArray(record: AnyRecord, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    return value.map((entry) => toText(entry)).filter((entry): entry is string => Boolean(entry));
  }
  return [];
}

function isRawIdText(value: string | undefined): boolean {
  return Boolean(value && RAW_ID_PATTERN.test(value));
}

function excerptText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) return undefined;
  if (compacted.length <= DESCRIPTION_MAX_LENGTH) return compacted;
  return `${compacted.slice(0, DESCRIPTION_MAX_LENGTH - 1).trimEnd()}...`;
}

export function normalizeBoardExecutionStatus(value: unknown): NormalizedBoardExecutionStatus {
  const status = toText(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (!status) return 'draft';
  return BOARD_EXECUTION_STATUS_ALIASES[status] ?? (status as BoardExecutionStatus | 'waiting');
}

export function boardExecutionGroup(status: NormalizedBoardExecutionStatus): BoardExecutionGroup {
  if (WAITING_BOARD_EXECUTION_STATUSES.has(status)) return 'waiting';
  if (status === 'waiting_for_team_slot' || status === 'waiting_for_model') return 'waiting';
  return BOARD_EXECUTION_GROUP_ORDER.includes(status) ? status : 'other';
}

export function groupBoardItemsByExecutionStatus(items: TeamBoardItem[]): Record<BoardExecutionGroup, TeamBoardItem[]> {
  const grouped = Object.fromEntries(
    [...BOARD_EXECUTION_GROUP_ORDER, 'other'].map((status) => [status, []]),
  ) as unknown as Record<BoardExecutionGroup, TeamBoardItem[]>;

  for (const item of items) {
    const executionStatus = normalizeBoardExecutionStatus(item.executionStatus);
    grouped[boardExecutionGroup(executionStatus)].push(item);
  }

  return grouped;
}

function collectRecords(value: unknown, keys: string[], depth = 0): unknown[] {
  if (depth > 4 || !isRecord(value)) return [];
  const found: unknown[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (keys.includes(key) && Array.isArray(entry)) found.push(...entry);
    if (keys.includes(key) && isRecord(entry)) found.push(...Object.values(entry).filter(isRecord));
    if (isRecord(entry)) found.push(...collectRecords(entry, keys, depth + 1));
  }
  return found;
}

function normalizeBoardItem(value: unknown): TeamBoardItem | null {
  if (!isRecord(value)) return null;
  const id = readText(value, ['id', 'itemId', 'item_id', 'boardItemId', 'board_item_id']);
  if (!id) return null;
  const description = readText(value, ['description', 'body', 'details']);
  const title = readText(value, ['title', 'subject', 'name']);
  return {
    id,
    teamId: readText(value, ['teamId', 'team_id']),
    title: title && !isRawIdText(title) ? title : 'Board item',
    description,
    excerpt: excerptText(description),
    source: isRawIdText(readText(value, ['source'])) ? undefined : readText(value, ['source']),
    executionStatus: normalizeBoardExecutionStatus(readText(value, ['executionStatus', 'execution_status'])),
    reviewStatus: readText(value, ['reviewStatus', 'review_status']) ?? 'not_required',
    assignedMembers: readStringArray(value, ['assignedMembers', 'assigned_members', 'assignees', 'owners']),
    reviewerMembers: readStringArray(value, ['reviewerMembers', 'reviewer_members', 'reviewers']),
    priority: isRawIdText(readText(value, ['priority'])) ? undefined : readText(value, ['priority']),
    queueTaskId: readText(value, ['queueTaskId', 'queue_task_id']),
    queueRunIds: readStringArray(value, ['queueRunIds', 'queue_run_ids', 'runIds', 'run_ids']),
    createdAt: readText(value, ['createdAt', 'created_at']),
    updatedAt: readText(value, ['updatedAt', 'updated_at']),
    queuedAt: readText(value, ['queuedAt', 'queued_at']),
    startedAt: readText(value, ['startedAt', 'started_at']),
    finishedAt: readText(value, ['finishedAt', 'finished_at']),
    blockedReason: readText(value, ['blockedReason', 'blocked_reason']),
    reviewFeedback: readText(value, ['reviewFeedback', 'review_feedback']),
  };
}

export function normalizeBoardItems(response: RpcResponse): TeamBoardItem[] {
  if (!response.ok) return [];
  const directItems = Array.isArray(response.items) ? response.items : null;
  const records = directItems ?? collectRecords(response, BOARD_ITEM_KEYS);
  const seen = new Set<string>();
  return records
    .map(normalizeBoardItem)
    .filter((item): item is TeamBoardItem => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}
