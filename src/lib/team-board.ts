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
  return {
    id,
    teamId: readText(value, ['teamId', 'team_id']),
    title: readText(value, ['title', 'subject', 'name']) ?? id,
    description: readText(value, ['description', 'body', 'details']),
    source: readText(value, ['source']),
    executionStatus: readText(value, ['executionStatus', 'execution_status']) ?? 'draft',
    reviewStatus: readText(value, ['reviewStatus', 'review_status']) ?? 'not_required',
    assignedMembers: readStringArray(value, ['assignedMembers', 'assigned_members', 'assignees', 'owners']),
    reviewerMembers: readStringArray(value, ['reviewerMembers', 'reviewer_members', 'reviewers']),
    priority: readText(value, ['priority']),
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
