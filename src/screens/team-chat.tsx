import { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { Select } from 'even-toolkit/web';
import { ProviderBadge } from '../components/chat/provider-badge';
import { ChatBubble } from '../components/chat/chat-bubble';
import { ChatInput } from '../components/chat/chat-input';
import { rpc } from '../domain/daemon-client';
import { usePullRefresh } from '../hooks/use-pull-refresh';

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

export function TeamChatRoute() {
  const [params] = useSearchParams();
  const teamId = params.get('id') ?? '';
  const [messages, setMessages] = useState<TeamMessageSummary[]>([]);
  const [recipient, setRecipient] = useState('*');
  const [recipients, setRecipients] = useState<Array<{ value: string; label: string }>>([{ value: '*', label: 'Team' }]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [runs, setRuns] = useState<OrchestratorRunSummary[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<Record<string, OrchestratorRunDetail>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!teamId) return;
    refresh();
    refreshRuns();
    const interval = setInterval(refresh, 3000);
    const runsInterval = setInterval(refreshRuns, 10000);
    return () => {
      clearInterval(interval);
      clearInterval(runsInterval);
    };
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
  }, [autoScroll, messages]);

  const handleSend = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await rpc('team.message.send', { teamId, to: recipient, text: draft.trim() });
      setDraft('');
      await refresh();
    } catch { /* ignore */ }
    setSending(false);
  };

  const { pullHandlers, PullIndicator } = usePullRefresh(refresh);

  const AI_TOOLS = ['claude', 'codex', 'gemini'];
  const isUserMessage = (msg: TeamMessageSummary) => {
    if (msg.from === 'user' || msg.from === 'you') return true;
    if (msg.fromTool && AI_TOOLS.includes(msg.fromTool)) return false;
    // Infer from sender name: if it matches a known AI tool, treat as AI
    if (AI_TOOLS.includes(msg.from.toLowerCase())) return false;
    // Default: messages without fromTool from unknown senders are user messages
    return !msg.fromTool;
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
                        <span className="truncate text-[12px] tracking-[-0.12px] font-normal">{route || runId || 'run'}</span>
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

        {!loading && messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center py-15 text-center text-text-dim">
            <div className="text-[40px] mb-4 opacity-30">{'\u{1F4AC}'}</div>
            <div className="text-[15px] tracking-[-0.15px] font-normal text-text mb-1.5">No messages yet</div>
            <div className="text-[13px] tracking-[-0.13px]">Start the conversation with your team</div>
          </div>
        )}

        {messages.map((msg) => {
          const isUser = isUserMessage(msg);
          const orchestration = msg.orchestration;
          const route = formatRoute(orchestration?.route);
          const events = orchestration?.events ?? [];
          return (
            <div key={msg.id} className={`msg-enter flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
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
      </div>
    </div>
  );
}
