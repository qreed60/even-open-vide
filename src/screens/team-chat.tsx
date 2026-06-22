import { useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { Select } from 'even-toolkit/web';
import { ProviderBadge } from '../components/chat/provider-badge';
import { ChatBubble } from '../components/chat/chat-bubble';
import { ChatInput } from '../components/chat/chat-input';
import { rpc, type RpcResponse } from '../domain/daemon-client';
import { usePullRefresh } from '../hooks/use-pull-refresh';
import {
  normalizeQueueData,
  deletedQueueItemIds,
  loadDeletedQueueChatRecords,
  loadDeletedQueueItems,
  queueDisplayItemDeleteId,
  queueDisplayItemDeleteTarget,
  queueDisplayItemIsChat,
  queueDisplayItemIsDeleted,
  queueDisplayItemPrompt,
  queueDisplayItemStableTaskId,
  saveDeletedQueueChatRecord,
  type DeletedQueueItemRecord,
  type QueueDisplayItem,
} from '../lib/team-queue';

interface TeamMessageSummary {
  id: string;
  from: string;
  fromTool?: string;
  to: string;
  text: string;
  createdAt: string;
  orchestration?: OrchestrationMetadata;
}

interface OrchestrationEvent {
  id?: string;
  type?: string;
  status?: string;
  member?: string;
  role?: string;
  provider?: string;
  model?: string;
  message?: string;
  createdAt?: string;
}

interface OrchestrationMetadata {
  runId?: string;
  route?: Array<string | { member?: string; name?: string; role?: string }>;
  status?: string;
  provider?: string;
  model?: string;
  eventCount?: number;
  events?: OrchestrationEvent[];
}

interface OrchestratorRunSummary extends OrchestrationMetadata {
  id?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
  durationMs?: number;
}

interface OrchestratorRunDetail extends OrchestratorRunSummary {
  events?: OrchestrationEvent[];
}

const AI_TOOLS = ['claude', 'codex', 'gemini'];

interface QueuedChatEntry {
  localId: string;
  text: string;
  to: string;
  createdAt: string;
  queueTaskId?: string;
  queueRunIds: string[];
  clientMessageId?: string;
}

interface VisibleQueuedChatEntry extends QueuedChatEntry {
  deleted?: boolean;
  item?: QueueDisplayItem;
}

function formatRecipient(to: string): string {
  if (to === '*' || to === 'team') return 'team';
  if (to === 'user' || to === 'you') return 'you';
  return to;
}

function routeMemberLabel(member: string | { member?: string; name?: string; role?: string }): string {
  if (typeof member === 'string') return member;
  return member.role || member.member || member.name || 'member';
}

function formatRoute(route?: OrchestrationMetadata['route']): string {
  if (!Array.isArray(route) || route.length === 0) return '';
  return route.map(routeMemberLabel).join(' \u2192 ');
}

function formatRunTime(run: Pick<OrchestratorRunSummary, 'durationMs' | 'startedAt' | 'endedAt' | 'updatedAt'>): string {
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)) {
    return run.durationMs < 1000 ? `${run.durationMs}ms` : `${Math.round(run.durationMs / 1000)}s`;
  }
  const started = Date.parse(run.startedAt ?? '');
  const ended = Date.parse(run.endedAt ?? run.updatedAt ?? '');
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
    return `${Math.max(1, Math.round((ended - started) / 1000))}s`;
  }
  const ref = Date.parse(run.updatedAt ?? run.startedAt ?? '');
  if (!Number.isFinite(ref)) return '';
  const ageSeconds = Math.max(1, Math.round((Date.now() - ref) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  return `${Math.round(ageSeconds / 60)}m ago`;
}

function statusClass(status?: string): string {
  const normalized = (status ?? '').toLowerCase();
  if (normalized.includes('fail') || normalized.includes('error')) return 'border-negative bg-negative/10 text-negative';
  if (normalized.includes('block') || normalized.includes('unknown')) return 'border-accent-warning bg-accent-warning/10 text-accent-warning';
  if (normalized.includes('done') || normalized.includes('complete') || normalized.includes('success')) return 'border-positive bg-positive/10 text-positive';
  return 'border-border bg-surface-light text-text-dim';
}

function isAttentionEvent(event: OrchestrationEvent): boolean {
  const text = `${event.type ?? ''} ${event.status ?? ''} ${event.message ?? ''}`.toLowerCase();
  return text.includes('blocked') || text.includes('failed') || text.includes('error') || text.includes('unknown');
}

function eventLabel(event: OrchestrationEvent): string {
  const parts = [
    event.type,
    event.status,
    event.member || event.role,
    event.provider && event.model ? `${event.provider}/${event.model}` : event.provider || event.model,
  ].filter(Boolean);
  return parts.join(' · ') || 'event';
}

function getRunId(run: OrchestratorRunSummary): string {
  return run.id || run.runId || '';
}

async function softRpc(cmd: string, params?: Record<string, unknown>): Promise<RpcResponse> {
  try {
    return await rpc(cmd, params);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((entry): entry is string => Boolean(entry));
}

function queuedChatFromResponse(res: RpcResponse, text: string, to: string, clientMessageId: string): QueuedChatEntry {
  const record = res as Record<string, unknown>;
  const task = (record.task && typeof record.task === 'object') ? record.task as Record<string, unknown> : null;
  const queueTask = (record.queueTask && typeof record.queueTask === 'object') ? record.queueTask as Record<string, unknown> : task;
  const sourceRef = (queueTask?.sourceRef && typeof queueTask.sourceRef === 'object') ? queueTask.sourceRef as Record<string, unknown> : null;
  const queueTaskId = readString(record.taskId)
    ?? readString(record.queueTaskId)
    ?? (queueTask ? readString(queueTask.id) ?? readString(queueTask.taskId) : undefined);
  const queueRunIds = readStringArray(record.runIds)
    .concat(readStringArray(record.queueRunIds))
    .concat(queueTask ? readStringArray(queueTask.runIds) : []);
  const uniqueRunIds = queueRunIds.filter((runId, index, allRunIds) => allRunIds.indexOf(runId) === index);
  return {
    localId: `queued-chat-${clientMessageId}`,
    text,
    to,
    createdAt: (queueTask ? readString(queueTask.createdAt) ?? readString(queueTask.queuedAt) : undefined) ?? new Date().toISOString(),
    queueTaskId,
    queueRunIds: uniqueRunIds,
    clientMessageId: readString(record.clientMessageId) ?? (sourceRef ? readString(sourceRef.messageId) : undefined) ?? clientMessageId,
  };
}

function queuedChatEntryKeys(entry: QueuedChatEntry): string[] {
  return [
    entry.clientMessageId,
    entry.queueTaskId,
    ...entry.queueRunIds,
    entry.localId,
  ].filter((key, index, allKeys): key is string => Boolean(key) && allKeys.indexOf(key) === index);
}

function queuedChatItemKeys(item: QueueDisplayItem): string[] {
  return [
    item.clientMessageId,
    item.queueTaskId,
    item.linkedQueueTaskId,
    item.kind === 'task' ? item.id : undefined,
    item.primaryRunId,
    item.runId,
    item.kind === 'run' ? item.id : undefined,
    ...(item.queueRunIds ?? []),
    ...(item.runIds ?? []),
  ].filter((key, index, allKeys): key is string => Boolean(key) && allKeys.indexOf(key) === index);
}

function queuedChatEntryKey(entry: QueuedChatEntry): string {
  return queuedChatEntryKeys(entry)[0] ?? entry.localId;
}

function mergeQueuedChatEntries(current: QueuedChatEntry[], next: QueuedChatEntry): QueuedChatEntry[] {
  const nextKeys = new Set(queuedChatEntryKeys(next));
  const existingIndex = current.findIndex((entry) => queuedChatEntryKeys(entry).some((key) => nextKeys.has(key)));
  if (existingIndex === -1) return [...current, next];
  return current.map((entry, index) => (index === existingIndex ? { ...entry, ...next } : entry));
}

function queueItemForChat(entry: QueuedChatEntry, items: QueueDisplayItem[]): QueueDisplayItem | undefined {
  const entryKeys = new Set(queuedChatEntryKeys(entry));
  return items.find((item) => {
    if (queuedChatItemKeys(item).some((key) => entryKeys.has(key))) return true;
    return false;
  });
}

function queueStatusLabel(entry: QueuedChatEntry, item?: QueueDisplayItem, deleted = false): string {
  if (deleted) return 'deleted';
  const status = item?.status ?? (entry.queueTaskId ? 'queued' : 'queued');
  const normalized = status.toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized.includes('cancel')) return 'cancelled';
  if (normalized.includes('run') || normalized.includes('active') || normalized.includes('progress')) return 'running';
  if (normalized.includes('complete') || normalized.includes('done') || normalized.includes('success')) return 'completed';
  if (normalized.includes('fail') || normalized.includes('error')) return 'failed';
  if (normalized.includes('wait')) return 'waiting';
  if (normalized.includes('queue') || normalized.includes('pending') || normalized.includes('ready')) return 'queued';
  return status;
}

function deletedChatEntryFromRecord(record: DeletedQueueItemRecord): VisibleQueuedChatEntry {
  return {
    localId: `deleted-queued-chat-${record.id}`,
    text: record.text ?? '',
    to: record.to ?? 'team',
    createdAt: record.createdAt ?? new Date().toISOString(),
    queueTaskId: record.queueTaskId ?? record.id,
    queueRunIds: record.queueRunIds ?? (record.queueRunId ? [record.queueRunId] : []),
    deleted: true,
  };
}

function deletedRecordForChatEntry(teamId: string, entry: QueuedChatEntry, item?: QueueDisplayItem): DeletedQueueItemRecord | null {
  const targetId = entry.queueTaskId ?? (item ? queueDisplayItemDeleteId(item) : undefined);
  if (!targetId) return null;
  return {
    id: targetId,
    teamId,
    text: entry.text,
    to: entry.to,
    createdAt: entry.createdAt,
    queueTaskId: entry.queueTaskId ?? item?.queueTaskId ?? item?.linkedQueueTaskId,
    queueRunId: item?.primaryRunId ?? item?.runId,
    queueRunIds: entry.queueRunIds.length ? entry.queueRunIds : item?.queueRunIds ?? item?.runIds,
  };
}

async function deleteQueuedChatItem(entry: QueuedChatEntry, item?: QueueDisplayItem): Promise<RpcResponse> {
  if (entry.queueTaskId) return rpc('team.queue.item.delete', { queueTaskId: entry.queueTaskId });
  const target = item ? queueDisplayItemDeleteTarget(item) : null;
  if (!target) return { ok: false, error: 'No queue item id available' };
  return rpc('team.queue.item.delete', target);
}

function isCancelledQueueStatus(status: string): boolean {
  return status.toLowerCase().includes('cancel');
}

function queuedChatEntryFromItem(item: QueueDisplayItem): QueuedChatEntry {
  const stableId = queueDisplayItemStableTaskId(item);
  const target = queueDisplayItemDeleteTarget(item);
  const text = queueDisplayItemPrompt(item);
  return {
    localId: `queued-chat-${stableId}`,
    text,
    to: 'team',
    createdAt: item.createdAt ?? item.startedAt ?? item.updatedAt ?? new Date().toISOString(),
    queueTaskId: target?.queueTaskId,
    queueRunIds: [
      target?.queueRunId,
      ...(item.queueRunIds ?? []),
      ...(item.runIds ?? []),
      item.runId,
      item.primaryRunId,
    ].filter((runId, index, allRunIds): runId is string => Boolean(runId) && allRunIds.indexOf(runId) === index),
    clientMessageId: item.clientMessageId,
  };
}

function queuedChatCanonicalKey(entry: QueuedChatEntry, item?: QueueDisplayItem): string {
  const itemKeys = item ? queuedChatItemKeys(item) : [];
  return entry.clientMessageId
    ?? item?.clientMessageId
    ?? entry.queueTaskId
    ?? item?.queueTaskId
    ?? item?.linkedQueueTaskId
    ?? (item?.kind === 'task' ? item.id : undefined)
    ?? entry.queueRunIds[0]
    ?? item?.primaryRunId
    ?? item?.runId
    ?? itemKeys[0]
    ?? entry.localId;
}

function nearTimestamp(left?: string, right?: string): boolean {
  const leftTime = Date.parse(left ?? '');
  const rightTime = Date.parse(right ?? '');
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
  return Math.abs(leftTime - rightTime) <= 5000;
}

function isQueueBacked(entry: VisibleQueuedChatEntry): boolean {
  return Boolean(entry.item || entry.queueTaskId || entry.queueRunIds.length > 0);
}

function isUserMessage(msg: TeamMessageSummary): boolean {
  if (msg.from === 'user' || msg.from === 'you') return true;
  if (msg.fromTool && AI_TOOLS.includes(msg.fromTool)) return false;
  if (AI_TOOLS.includes(msg.from.toLowerCase())) return false;
  return !msg.fromTool;
}

function sameMessages(a: TeamMessageSummary[], b: TeamMessageSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (
      left.id !== right.id
      || left.from !== right.from
      || left.to !== right.to
      || left.text !== right.text
      || left.createdAt !== right.createdAt
      || left.fromTool !== right.fromTool
      || JSON.stringify(left.orchestration ?? null) !== JSON.stringify(right.orchestration ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function queueAssistantMessage(item: QueueDisplayItem | undefined): TeamMessageSummary | null {
  if (!item?.assistantText?.trim()) return null;
  return {
    id: `queued-assistant-${item.primaryRunId ?? item.runId ?? item.queueRunIds?.[0] ?? item.id}`,
    from: item.assistantFrom ?? item.currentMember ?? 'Lead',
    fromTool: item.assistantProvider,
    to: 'user',
    text: item.assistantText,
    createdAt: item.finishedAt ?? item.updatedAt ?? item.startedAt ?? item.createdAt ?? new Date().toISOString(),
    orchestration: item.assistantRoute || item.assistantStatus || item.assistantProvider || item.assistantModel
      ? {
        status: item.assistantStatus === 'blocked' ? 'blocked' : item.assistantStatus === 'failed' ? 'failed' : 'completed',
        route: item.assistantRoute ?? [],
        provider: item.assistantProvider,
        model: item.assistantModel,
      }
      : undefined,
  };
}

export function TeamChatRoute() {
  const [params] = useSearchParams();
  const teamId = params.get('id') ?? '';
  const [messages, setMessages] = useState<TeamMessageSummary[]>([]);
  const [recipient, setRecipient] = useState('*');
  const [recipients, setRecipients] = useState<Array<{ value: string; label: string }>>([{ value: '*', label: 'Team' }]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [queueError, setQueueError] = useState('');
  const [queuedChats, setQueuedChats] = useState<QueuedChatEntry[]>([]);
  const [deletedQueuedChats, setDeletedQueuedChats] = useState<DeletedQueueItemRecord[]>(() => loadDeletedQueueChatRecords(teamId));
  const [queueItems, setQueueItems] = useState<QueueDisplayItem[]>([]);
  const [deletingQueueId, setDeletingQueueId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [runs, setRuns] = useState<OrchestratorRunSummary[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<Record<string, OrchestratorRunDetail>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);

  const refresh = async () => {
    try {
      const res = await rpc('team.message.list', { teamId, limit: 50 });
      if (res.ok && Array.isArray(res.teamMessages)) {
        const nextMessages = res.teamMessages as TeamMessageSummary[];
        setMessages((current) => (sameMessages(current, nextMessages) ? current : nextMessages));
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  const refreshRuns = async () => {
    try {
      const res = await rpc('team.orchestrator.runs.list', { teamId, limit: 5 });
      const rawRuns = Array.isArray(res.runs) ? res.runs : Array.isArray(res.orchestratorRuns) ? res.orchestratorRuns : [];
      if (res.ok) {
        setRuns(rawRuns as OrchestratorRunSummary[]);
      }
    } catch { /* metadata RPC may not exist on older daemons */ }
  };

  const refreshQueueState = async () => {
    const responses = await Promise.all([
      softRpc('team.queue.status', { teamId }),
      softRpc('team.task.list', { teamId }),
      softRpc('team.run.list', { teamId }),
    ]);
    const normalized = normalizeQueueData(responses);
    const deletedIds = deletedQueueItemIds(loadDeletedQueueItems());
    setQueueItems(normalized.items
      .filter((item) => item.teamId === teamId || !item.teamId)
      .filter((item) => !queueDisplayItemIsDeleted(item, deletedIds)));
  };

  useEffect(() => {
    if (!teamId) return;
    setDeletedQueuedChats(loadDeletedQueueChatRecords(teamId));
    refresh();
    refreshRuns();
    refreshQueueState();
    const interval = setInterval(refresh, 3000);
    const runsInterval = setInterval(refreshRuns, 10000);
    const queueInterval = setInterval(refreshQueueState, 3000);
    return () => {
      clearInterval(interval);
      clearInterval(runsInterval);
      clearInterval(queueInterval);
    };
  }, [teamId]);

  useEffect(() => {
    setQueuedChats([]);
  }, [teamId]);

  useEffect(() => {
    if (!teamId) return;
    rpc('team.get', { teamId }).then((res) => {
      if (!res.ok || !res.team) return;
      const team = res.team as { members?: Array<{ name: string }> };
      const next = [{ value: '*', label: 'Team' }];
      for (const member of team.members ?? []) {
        next.push({ value: member.name, label: member.name });
      }
      setRecipients(next);
    }).catch(() => {});
  }, [teamId]);

  useEffect(() => {
    if (!autoScroll) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [autoScroll, messages, queuedChats, queueItems]);

  const handleSend = async () => {
    if (!draft.trim() || sendingRef.current) return;
    const text = draft.trim();
    const clientMessageId = newClientMessageId();
    sendingRef.current = true;
    setSending(true);
    setQueueError('');
    try {
      const res = await rpc('team.chat.queue', {
        teamId,
        text,
        to: recipient,
        from: 'user',
        messageId: clientMessageId,
        clientMessageId,
      });
      if (res.ok) {
        const queuedChat = queuedChatFromResponse(res, text, recipient, clientMessageId);
        setQueuedChats((current) => mergeQueuedChatEntries(current, queuedChat));
        setDraft('');
        await Promise.all([refreshRuns(), refreshQueueState()]);
      } else {
        setQueueError(res.error ?? 'Queue failed');
      }
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : String(error));
    }
    sendingRef.current = false;
    setSending(false);
  };

  const { pullHandlers, PullIndicator } = usePullRefresh(refresh);
  const visibleQueuedChats = useMemo(() => {
    const persistedUserMessages = new Set(
      messages
        .filter((message) => isUserMessage(message))
        .map((message) => `${message.to}:${message.text}`),
    );
    const byKey = new Map<string, VisibleQueuedChatEntry>();
    const aliases = new Map<string, string>();
    const deletedIds = new Set(deletedQueuedChats.map((entry) => entry.id));

    const upsertEntry = (entry: VisibleQueuedChatEntry, item?: QueueDisplayItem) => {
      const keys = [
        ...queuedChatEntryKeys(entry),
        ...(item ? queuedChatItemKeys(item) : []),
      ].filter((key, index, allKeys): key is string => Boolean(key) && allKeys.indexOf(key) === index);
      const existingKey = keys.map((key) => aliases.get(key) ?? key).find((key) => byKey.has(key));
      const canonicalKey = existingKey ?? queuedChatCanonicalKey(entry, item);
      const existingEntry = byKey.get(canonicalKey);
      const nextEntry = existingEntry ? { ...existingEntry, ...entry, item: item ?? entry.item ?? existingEntry.item } : { ...entry, item: item ?? entry.item };
      byKey.set(canonicalKey, nextEntry);
      for (const key of keys) aliases.set(key, canonicalKey);
    };

    for (const entry of queuedChats) {
      const item = queueItemForChat(entry, queueItems);
      upsertEntry({ ...entry, item }, item);
    }

    for (const item of queueItems) {
      if (!queueDisplayItemIsChat(item)) continue;
      const entry = queuedChatEntryFromItem(item);
      const key = queuedChatCanonicalKey(entry, item);
      upsertEntry({ ...entry, item, deleted: deletedIds.has(key) || queuedChatItemKeys(item).some((itemKey) => deletedIds.has(itemKey)) }, item);
    }

    for (const record of deletedQueuedChats) {
      if (!record.text) continue;
      upsertEntry(deletedChatEntryFromRecord(record));
    }

    const entries = Array.from(byKey.entries()).map(([key, entry]) => ({
        ...entry,
        deleted: entry.deleted ?? deletedIds.has(key),
      }));
    const queueBackedEntries = entries.filter(isQueueBacked);
    const dedupedEntries = entries.filter((entry) => {
      if (isQueueBacked(entry) || entry.clientMessageId || entry.queueTaskId || entry.queueRunIds.length > 0) return true;
      return !queueBackedEntries.some((queueBacked) => (
        queueBacked.text === entry.text
        && nearTimestamp(queueBacked.createdAt, entry.createdAt)
      ));
    });

    return dedupedEntries.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)).map((entry) => ({
      entry,
      showBubble: !persistedUserMessages.has(`${entry.to}:${entry.text}`),
    }));
  }, [messages, queuedChats, queueItems, deletedQueuedChats]);

  const deletedQueuedChatTexts = useMemo(() => new Set(
    visibleQueuedChats
      .filter(({ entry }) => entry.deleted)
      .map(({ entry }) => entry.text),
  ), [visibleQueuedChats]);

  const displayedMessages = useMemo(() => (
    messages.filter((message) => !(isUserMessage(message) && deletedQueuedChatTexts.has(message.text)))
  ), [messages, deletedQueuedChatTexts]);

  const assistantMessagesFromQueue = useMemo(() => {
    const persistedAssistantMessages = new Set(
      messages
        .filter((message) => !isUserMessage(message))
        .map((message) => `${message.from}:${message.text}`),
    );
    return visibleQueuedChats
      .map(({ entry }) => queueAssistantMessage(entry.item ?? queueItemForChat(entry, queueItems)))
      .filter((message): message is TeamMessageSummary => Boolean(message))
      .filter((message) => !persistedAssistantMessages.has(`${message.from}:${message.text}`));
  }, [messages, queueItems, visibleQueuedChats]);

  const timelineEntries = useMemo(() => {
    const messageEntries = [...displayedMessages, ...assistantMessagesFromQueue].map((message) => ({
      type: 'message' as const,
      id: message.id,
      createdAt: message.createdAt,
      message,
    }));
    const queuedEntries = visibleQueuedChats.map((queued) => ({
      type: 'queued' as const,
      id: queued.entry.localId,
      createdAt: queued.entry.createdAt,
      queued,
    }));
    return [...messageEntries, ...queuedEntries].sort((left, right) => {
      const leftTime = Date.parse(left.createdAt);
      const rightTime = Date.parse(right.createdAt);
      const normalizedLeft = Number.isFinite(leftTime) ? leftTime : 0;
      const normalizedRight = Number.isFinite(rightTime) ? rightTime : 0;
      if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight;
      return left.type === right.type ? 0 : left.type === 'message' ? -1 : 1;
    });
  }, [displayedMessages, assistantMessagesFromQueue, visibleQueuedChats]);

  const handleDeleteQueuedChat = async (entry: QueuedChatEntry) => {
    const item = queueItemForChat(entry, queueItems);
    const record = deletedRecordForChatEntry(teamId, entry, item);
    if (!record) return;
    setQueueError('');
    setDeletingQueueId(record.id);
    try {
      const res = await deleteQueuedChatItem(entry, item);
      if (!res.ok) {
        setQueueError(res.error ?? 'Delete failed');
      } else {
        saveDeletedQueueChatRecord(teamId, record);
        setDeletedQueuedChats(loadDeletedQueueChatRecords(teamId));
        await Promise.all([refresh(), refreshRuns(), refreshQueueState()]);
      }
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : String(error));
    }
    setDeletingQueueId(null);
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom < 80);
  };

  const toggleRun = async (runId: string) => {
    const nextId = expandedRunId === runId ? null : runId;
    setExpandedRunId(nextId);
    if (!nextId || runDetails[nextId]) return;
    try {
      const res = await rpc('team.orchestrator.run.get', { teamId, runId: nextId });
      const run = (res.run ?? res.orchestratorRun) as OrchestratorRunDetail | undefined;
      if (res.ok && run) {
        setRunDetails((current) => ({ ...current, [nextId]: run }));
      }
    } catch { /* older daemon or missing run detail */ }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-4 flex flex-col gap-4"
        {...pullHandlers}
      >
        <PullIndicator />
        {loading && (
          <p className="text-[13px] tracking-[-0.13px] text-text-dim text-center py-6 status-breathe-fast">Loading...</p>
        )}

        {runs.length > 0 && (
          <div className="rounded-[6px] border border-border bg-surface p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] tracking-[-0.12px] text-text font-normal">Recent Runs</span>
              <span className="data-mono text-text-dim">{runs.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {runs.map((run) => {
                const runId = getRunId(run);
                const route = formatRoute(run.route);
                const detail = runDetails[runId];
                const events = detail?.events ?? run.events ?? [];
                return (
                  <div key={runId || route || run.startedAt} className={`rounded-[6px] border p-2 ${statusClass(run.status)}`}>
                    <button
                      className="w-full cursor-pointer border-none bg-transparent p-0 text-left"
                      onClick={() => { if (runId) toggleRun(runId); }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[12px] tracking-[-0.12px] font-normal">{route || 'Run'}</span>
                        <span className="data-mono shrink-0">{run.status ?? 'unknown'}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] tracking-[-0.11px]">
                        <span>{formatRunTime(run)}</span>
                        <span>{run.eventCount ?? events.length} event{(run.eventCount ?? events.length) === 1 ? '' : 's'}</span>
                      </div>
                    </button>
                    {expandedRunId === runId && events.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1 border-t border-border/60 pt-2">
                        {events.slice(0, 8).map((event, index) => (
                          <div
                            key={event.id ?? `${runId}-${index}`}
                            className={`rounded-[4px] px-2 py-1 text-[11px] tracking-[-0.11px] ${isAttentionEvent(event) ? 'bg-negative/15 text-negative' : 'bg-bg/60 text-text-dim'}`}
                          >
                            <span className="data-mono">{eventLabel(event)}</span>
                            {event.message && <span className="ml-1">{event.message}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!loading && timelineEntries.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center py-15 text-center text-text-dim">
            <div className="text-[40px] mb-4 opacity-30">{'\u{1F4AC}'}</div>
            <div className="text-[15px] tracking-[-0.15px] font-normal text-text mb-1.5">No messages yet</div>
            <div className="text-[13px] tracking-[-0.13px]">Start the conversation with your team</div>
          </div>
        )}

        {timelineEntries.map((timelineEntry) => {
          if (timelineEntry.type === 'queued') {
            const { entry, showBubble } = timelineEntry.queued;
            const item = entry.item ?? queueItemForChat(entry, queueItems);
            const status = queueStatusLabel(entry, item, entry.deleted);
            const canDelete = !entry.deleted && isCancelledQueueStatus(status);
            const deleteId = entry.queueTaskId ?? (item ? queueDisplayItemDeleteId(item) : undefined);
            return (
              <div key={timelineEntry.id} className="msg-enter flex flex-col items-end">
                {entry.deleted ? (
                  <div className="max-w-[92%] rounded-[14px] border border-border bg-surface px-3 py-2 text-[13px] tracking-[-0.13px] text-text-dim">
                    Message deleted
                  </div>
                ) : showBubble && (
                  <ChatBubble
                    role="user"
                    tool="user"
                    timestamp={new Date(entry.createdAt).getTime()}
                  >
                    {entry.text}
                  </ChatBubble>
                )}
                <div className="mt-1 flex max-w-[92%] items-center justify-end gap-1.5">
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] tracking-[-0.1px] ${statusClass(status)}`}>
                    {status}
                  </span>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => handleDeleteQueuedChat(entry)}
                      disabled={Boolean(deleteId && deletingQueueId === deleteId)}
                      className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] tracking-[-0.1px] text-text-dim"
                    >
                      {deleteId && deletingQueueId === deleteId ? 'Deleting...' : 'Delete'}
                    </button>
                  )}
                </div>
              </div>
            );
          }

          const msg = timelineEntry.message;
          const isUser = isUserMessage(msg);
          const orchestration = msg.orchestration;
          const route = formatRoute(orchestration?.route);
          const events = orchestration?.events ?? [];
          return (
            <div key={timelineEntry.id} className={`msg-enter flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
              {!isUser && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <ProviderBadge provider={(msg.fromTool || 'claude') as 'claude' | 'codex' | 'gemini'} size={18} />
                  <span className="data-mono">{msg.from}</span>
                  <span className="text-[11px] tracking-[-0.11px] text-text-dim">{'\u2192'} {formatRecipient(msg.to)}</span>
                </div>
              )}
              <ChatBubble
                role={isUser ? 'user' : 'assistant'}
                tool={msg.fromTool || msg.from}
                timestamp={new Date(msg.createdAt).getTime()}
              >
                {msg.text}
              </ChatBubble>
              {orchestration && (
                <details className={`mt-1 max-w-[92%] rounded-[6px] border px-2 py-1.5 ${statusClass(orchestration.status)}`}>
                  <summary className="cursor-pointer text-[11px] tracking-[-0.11px]">
                    {route || 'Orchestrator'}{orchestration.status ? ` · ${orchestration.status}` : ''}{orchestration.provider || orchestration.model ? ` · ${[orchestration.provider, orchestration.model].filter(Boolean).join('/')}` : ''}
                  </summary>
                  {events.length > 0 && (
                    <div className="mt-1.5 flex flex-col gap-1">
                      {events.map((event, index) => (
                        <div
                          key={event.id ?? `${msg.id}-${index}`}
                          className={`rounded-[4px] px-2 py-1 text-[11px] tracking-[-0.11px] ${isAttentionEvent(event) ? 'bg-negative/15 text-negative' : 'bg-bg/60 text-text-dim'}`}
                        >
                          <span className="data-mono">{eventLabel(event)}</span>
                          {event.message && <span className="ml-1">{event.message}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-3 pb-3 pt-2 border-t border-border bg-bg">
        <div className="mb-2">
          <Select value={recipient} options={recipients} onValueChange={setRecipient} dropdownPosition="top" />
        </div>
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          isRunning={sending}
          placeholder="Type a message to the team..."
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            {queueError && <p className="text-[11px] tracking-[-0.11px] text-negative truncate">{queueError}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
