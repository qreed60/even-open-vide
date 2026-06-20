import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Card, EmptyState, useDrawerHeader } from 'even-toolkit/web';
import { IcEditChecklist, IcEditPlay, IcFeatTimeCounting, IcStatusAlert } from 'even-toolkit/web/icons/svg-icons';
import { rpc, type RpcResponse } from '../domain/daemon-client';
import { useBridge } from '../contexts/bridge';
import { usePullRefresh } from '../hooks/use-pull-refresh';
import { normalizeQueueData, summarizeQueue, type QueueData, type QueueDisplayItem } from '../lib/team-queue';

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

function QueueItemCard({ item, showTeam }: { item: QueueDisplayItem; showTeam: boolean }) {
  const createdAt = formatDate(item.createdAt);
  const startedAt = formatDate(item.startedAt);
  const finishedAt = formatDate(item.finishedAt);
  const resourceLabel = getResourceLabel(item);
  const meta = [
    item.kind,
    item.source,
    showTeam ? item.teamName ?? item.teamId : undefined,
    item.linkedBoardTaskStatus ? `linked board task: ${item.linkedBoardTaskStatus}` : undefined,
    item.primaryRunId ? `run ${item.primaryRunId}${item.primaryRunStatus ? ` ${item.primaryRunStatus}` : ''}` : undefined,
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
        <span className="data-mono shrink-0 text-text-dim">{item.id}</span>
      </div>
    </Card>
  );
}

function QueueSection({ title, items, icon, showTeam }: { title: string; items: QueueDisplayItem[]; icon: ReactNode; showTeam: boolean }) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-text-dim">{icon}</span>
        <h2 className="text-[15px] tracking-[-0.15px] text-text font-normal">{title}</h2>
        <Badge variant="neutral">{items.length}</Badge>
      </div>
      {items.map((item) => <QueueItemCard key={itemKey(item)} item={item} showTeam={showTeam} />)}
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
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const { activeHostId } = useBridge();

  const refresh = async () => {
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
    setData(normalizeQueueData(responses, teamNames));
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, [activeHostId, teamId, teamName]);

  useEffect(() => {
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [activeHostId, teamId, teamName]);

  const { pullHandlers, PullIndicator } = usePullRefresh(refresh);
  const items = useMemo(() => data.items.filter((item) => !teamId || item.teamId === teamId || !item.teamId), [data.items, teamId]);
  const resources = useMemo(() => data.resources.filter((item) => !teamId || item.teamId === teamId || !item.teamId), [data.resources, teamId]);
  const summary = summarizeQueue(items);
  const running = items.filter((item) => item.category === 'running');
  const queued = items.filter((item) => item.category === 'queued');
  const waiting = [...items.filter((item) => item.category === 'waiting'), ...resources];
  const history = items.filter((item) => item.category === 'history');
  const other = items.filter((item) => item.category === 'other');
  const isEmpty = !loading && running.length === 0 && queued.length === 0 && waiting.length === 0 && history.length === 0 && other.length === 0;
  const showTeam = !teamId;

  const content = (
    <div className={`${embedded ? '' : 'px-3 py-4 pb-8'} flex flex-col gap-3`} {...pullHandlers}>
      <PullIndicator />

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
          <p className="text-[20px] tracking-[-0.2px] text-text font-normal">{summary.waitingCount + resources.length}</p>
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

      <QueueSection title="Running" items={running} icon={<IcEditPlay width={16} height={16} />} showTeam={showTeam} />
      <QueueSection title="Queued" items={queued} icon={<IcEditChecklist width={16} height={16} />} showTeam={showTeam} />
      <QueueSection title="Waiting" items={waiting} icon={<IcFeatTimeCounting width={16} height={16} />} showTeam={showTeam} />
      <QueueSection title="History" items={history} icon={<IcEditChecklist width={16} height={16} />} showTeam={showTeam} />
      <QueueSection title="Other" items={other} icon={<IcStatusAlert width={16} height={16} />} showTeam={showTeam} />
    </div>
  );

  if (embedded) return content;
  return <div className="flex-1 flex flex-col bg-bg">{content}</div>;
}

export function TeamRunsRoute() {
  useDrawerHeader({ title: 'Runs / Queue' });
  return <TeamRunsPanel />;
}
