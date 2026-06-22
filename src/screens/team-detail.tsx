import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { Card, Button, Badge, EmptyState, Input, Select, Dialog, MultiSelect, Textarea, ListItem } from 'even-toolkit/web';
import { IcEditAdd, IcEditChecklist, IcEditEdit, IcEditTrash, IcFeatLearnExplore, IcStatusAlert } from 'even-toolkit/web/icons/svg-icons';
import { rpc } from '../domain/daemon-client';
import { usePullRefresh } from '../hooks/use-pull-refresh';
import { UNTITLED_DIALOG_CLASS } from '../lib/dialog';
import { BOARD_EXECUTION_GROUP_ORDER, groupBoardItemsByExecutionStatus, normalizeBoardExecutionStatus, normalizeBoardItems, type BoardExecutionGroup, type TeamBoardItem, type BoardReviewStatus } from '../lib/team-board';
import { isProviderSelectable, providerCapabilityHint, providerOptionsFromMetadata, roleOptionsFromMetadata, type TeamProviderCapability } from '../lib/team-metadata';
import { TeamRunsPanel } from './team-runs';

interface TeamMemberOption {
  value: string;
  label: string;
}

interface TeamMemberDraft {
  name: string;
  tool: string;
  role: string;
  model?: string;
  draftId: string;
}

interface TeamPlanVote {
  reviewer: string;
  vote: 'approve' | 'revise' | 'reject';
  feedback?: string;
  iteration: number;
}

interface TeamPlanSummary {
  id: string;
  status: string;
  mode: string;
  iteration: number;
  maxIterations: number;
  reviewers: string[];
  votes: TeamPlanVote[];
  revisions: Array<{
    id: string;
    author: string;
    createdAt: string;
    tasks: Array<{ subject: string; description: string; owner: string; dependencies?: string[] }>;
  }>;
}

const BOARD_REVIEW_STATUSES: BoardReviewStatus[] = ['pending_review', 'approved', 'revise', 'rejected'];

const boardDotColor: Record<BoardExecutionGroup, string> = {
  draft: 'bg-text-dim',
  queued: 'bg-[#4285F4]',
  waiting: 'bg-accent-warning',
  running: 'bg-positive',
  completed: 'bg-positive',
  failed: 'bg-negative',
  cancelled: 'bg-text-dim',
  interrupted: 'bg-accent-warning',
  blocked: 'bg-negative',
  other: 'bg-text-dim',
};

const PLAN_MODE_OPTIONS = [
  { value: 'simple', label: 'Simple' },
  { value: 'consensus', label: 'Consensus' },
];

const PLAN_MAX_ITERATION_OPTIONS = [
  { value: '2', label: '2 rounds' },
  { value: '3', label: '3 rounds' },
  { value: '4', label: '4 rounds' },
  { value: '5', label: '5 rounds' },
  { value: '6', label: '6 rounds' },
  { value: '8', label: '8 rounds' },
  { value: '10', label: '10 rounds' },
];

type TabId = 'board' | 'plan' | 'chat' | 'runs';

let memberDraftIdCounter = 0;

function createMemberDraftId(): string {
  memberDraftIdCounter += 1;
  return `member-${Date.now().toString(36)}-${memberDraftIdCounter}`;
}

export function TeamDetailRoute() {
  const [params] = useSearchParams();
  const teamId = params.get('id') ?? '';
  const navigate = useNavigate();
  const [boardItems, setBoardItems] = useState<TeamBoardItem[]>([]);
  const [boardUnsupported, setBoardUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [updatingReviewId, setUpdatingReviewId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('board');
  const [newSubject, setNewSubject] = useState('');
  const [newOwners, setNewOwners] = useState<string[]>([]);
  const [newDesc, setNewDesc] = useState('');
  const [addingTask, setAddingTask] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMemberOption[]>([]);
  const [teamName, setTeamName] = useState('Team');
  const [teamCwd, setTeamCwd] = useState('');
  const [teamMemberDrafts, setTeamMemberDrafts] = useState<TeamMemberDraft[]>([]);
  const [teamMetadata, setTeamMetadata] = useState<unknown>(null);
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [savingTeam, setSavingTeam] = useState(false);

  const [latestPlan, setLatestPlan] = useState<TeamPlanSummary | null>(null);
  const [showPlanForm, setShowPlanForm] = useState(false);
  const [planRequest, setPlanRequest] = useState('');
  const [planMode, setPlanMode] = useState<'simple' | 'consensus'>('simple');
  const [planMaxIterations, setPlanMaxIterations] = useState('5');
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const [deletingPlanId, setDeletingPlanId] = useState<string | null>(null);

  const refreshTeam = async () => {
    try {
      const res = await rpc('team.get', { teamId });
      if (res.ok && res.team) {
        const team = res.team as { name?: string; workingDirectory?: string; members?: { name: string; tool: string; role: string; model?: string }[] };
        setTeamName(team.name ?? 'Team');
        setTeamCwd(team.workingDirectory ?? '');
        if (team.members) {
          setTeamMembers(team.members.map((member) => ({
            value: member.name,
            label: `${member.name} (${member.tool} · ${member.role})`,
          })));
          setTeamMemberDrafts(team.members.map((member) => ({
            name: member.name,
            tool: member.tool,
            role: member.role,
            model: member.model,
            draftId: createMemberDraftId(),
          })));
        }
      }
    } catch {
      // Ignore team refresh errors.
    }
  };

  const refreshBoardItems = async () => {
    try {
      const res = await rpc('team.board.items.list', { teamId });
      if (res.ok) {
        setBoardItems(normalizeBoardItems(res));
        setBoardUnsupported(false);
      } else {
        setBoardItems([]);
        setBoardUnsupported(true);
      }
    } catch {
      setBoardItems([]);
      setBoardUnsupported(true);
    }
  };

  const refreshPlan = async () => {
    try {
      const res = await rpc('team.plan.latest', { teamId });
      if (res.ok && res.teamPlan) {
        setLatestPlan(res.teamPlan as TeamPlanSummary);
      } else {
        setLatestPlan(null);
      }
    } catch {
      // Ignore plan refresh errors.
    }
  };

  const refreshMetadata = async () => {
    try {
      const res = await rpc('team.metadata');
      if (res.ok) setTeamMetadata(res);
    } catch {
      // Older daemons do not expose metadata.
    }
  };

  const refresh = async () => {
    await Promise.all([refreshTeam(), refreshBoardItems(), refreshPlan(), refreshMetadata()]);
    setLoading(false);
  };

  useEffect(() => {
    if (!teamId) return;
    void refresh();
  }, [teamId]);

  useEffect(() => {
    if (!teamId) return;
    const timer = setInterval(() => {
      void refreshBoardItems();
      if (activeTab === 'plan') {
        void refreshPlan();
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [activeTab, teamId]);

  const { pullHandlers, PullIndicator } = usePullRefresh(refresh);

  const handleAddTask = async () => {
    if (!newSubject.trim()) return;
    setAddingTask(true);
    try {
      await rpc('team.board.item.create', {
        teamId,
        title: newSubject.trim(),
        description: newDesc.trim(),
        assignedMembers: newOwners,
      });
      setNewSubject('');
      setNewOwners([]);
      setNewDesc('');
      setShowAddForm(false);
      await refreshBoardItems();
    } catch {
      // Keep the dialog open so the user can retry.
    }
    setAddingTask(false);
  };

  const handleCancelBoardItem = async (itemId: string) => {
    setCancellingId(itemId);
    try {
      await rpc('team.board.item.cancel', { teamId, itemId });
      await refreshBoardItems();
    } catch {
      // Keep the board visible when an older bridge lacks cancellation.
    }
    setCancellingId(null);
  };

  const handleSetReviewStatus = async (itemId: string, reviewStatus: BoardReviewStatus) => {
    setUpdatingReviewId(itemId);
    try {
      await rpc('team.board.item.set_review_status', { teamId, itemId, reviewStatus });
      await refreshBoardItems();
    } catch {
      // Review controls are best-effort on bridges that expose the command.
    }
    setUpdatingReviewId(null);
  };

  const handleGeneratePlan = async () => {
    if (!planRequest.trim()) return;
    setGeneratingPlan(true);
    try {
      await rpc('team.plan.generate', {
        teamId,
        request: planRequest.trim(),
        mode: planMode,
        maxIterations: planMode === 'consensus' ? Number(planMaxIterations) : undefined,
      });
      setPlanRequest('');
      setShowPlanForm(false);
      setActiveTab('plan');
      await refreshPlan();
    } catch {
      // Keep the dialog open for retry.
    }
    setGeneratingPlan(false);
  };

  const addTeamMember = () => {
    setTeamMemberDrafts((current) => [...current, { name: '', tool: 'codex', role: 'coder', draftId: createMemberDraftId() }]);
  };

  const updateTeamMember = (index: number, field: keyof TeamMemberDraft, value: string) => {
    setTeamMemberDrafts((current) => current.map((member, memberIndex) => (
      memberIndex === index ? { ...member, [field]: value } : member
    )));
  };

  const removeTeamMember = (index: number) => {
    setTeamMemberDrafts((current) => current.length <= 1 ? current : current.filter((_, memberIndex) => memberIndex !== index));
  };

  const handleSaveTeam = async () => {
    const members = teamMemberDrafts
      .map((member) => ({ ...member, name: member.name.trim() }))
      .filter((member) => member.name.length > 0);
    if (!teamName.trim() || !teamCwd.trim() || members.length === 0) return;
    setSavingTeam(true);
    try {
      const res = await rpc('team.update', {
        teamId,
        name: teamName.trim(),
        cwd: teamCwd.trim(),
        members: members.map((member) => ({
          name: member.name,
          tool: member.tool,
          role: member.role,
          model: member.model?.trim() || undefined,
        })),
      });
      if (res.ok) {
        setShowTeamForm(false);
        await refresh();
      }
    } catch {
      // Keep the dialog open for retry.
    }
    setSavingTeam(false);
  };

  const handleDeletePlan = async (planId: string) => {
    setDeletingPlanId(planId);
    try {
      await rpc('team.plan.delete', { teamId, planId });
      await refreshPlan();
    } catch {
      // Ignore delete failures and keep current plan visible.
    }
    setDeletingPlanId(null);
  };

  const groupedBoardItems = useMemo(() => groupBoardItemsByExecutionStatus(boardItems), [boardItems]);
  const boardSections = useMemo(() => (
    [...BOARD_EXECUTION_GROUP_ORDER, ...(groupedBoardItems.other.length ? ['other' as const] : [])]
      .map((status) => ({ status, items: groupedBoardItems[status] }))
  ), [groupedBoardItems]);

  const latestRevision = useMemo(() => latestPlan?.revisions?.[latestPlan.revisions.length - 1] ?? null, [latestPlan]);
  const teamToolOptions = providerOptionsFromMetadata(teamMetadata);
  const teamRoleOptions = roleOptionsFromMetadata(teamMetadata);
  const teamProvidersByValue = new Map<string, TeamProviderCapability>(teamToolOptions.map((provider) => [provider.value, provider]));

  const tabs: { id: TabId; label: string }[] = [
    { id: 'board', label: 'Board' },
    { id: 'plan', label: 'Plan' },
    { id: 'chat', label: 'Chat' },
    { id: 'runs', label: 'Runs' },
  ];

  return (
    <div className="flex-1 flex flex-col bg-bg">
      <div className="px-3 pt-4 pb-8" {...pullHandlers}>
        <PullIndicator />
        <Card className="mb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] tracking-[-0.15px] text-text font-normal truncate">{teamName}</p>
              <p className="text-[11px] tracking-[-0.11px] text-text-dim mt-1 break-all">{teamCwd}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <span className="text-[11px] tracking-[-0.11px] text-text-dim">{boardItems.length} board item{boardItems.length !== 1 ? 's' : ''}</span>
              <Button size="sm" onClick={() => setShowTeamForm(true)}>
                <IcEditEdit width={16} height={16} />
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {teamMemberDrafts.map((member) => (
              <Badge key={member.draftId} variant="neutral">
                {member.name} · {member.role}
              </Badge>
            ))}
          </div>
        </Card>

        <div className="flex gap-0 mb-4 bg-surface rounded-[6px] p-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`flex-1 py-1.5 text-[13px] tracking-[-0.13px] font-normal rounded-[4px] cursor-pointer border-none transition-colors ${
                activeTab === tab.id
                  ? 'bg-bg text-text'
                  : 'bg-transparent text-text-dim hover:text-text'
              }`}
              onClick={() => {
                if (tab.id === 'chat') {
                  navigate(`/team-chat?id=${teamId}`);
                } else {
                  setActiveTab(tab.id);
                }
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'board' && (
          <>
            {loading && (
              <p className="text-[13px] tracking-[-0.13px] text-text-dim text-center py-6 status-breathe-fast">Loading...</p>
            )}

            {!loading && boardUnsupported && (
              <EmptyState
                icon={<IcStatusAlert width={32} height={32} />}
                title="Board unavailable"
                description="This bridge does not expose queue-backed Board commands yet."
              />
            )}

            {!loading && !boardUnsupported && boardItems.length === 0 && (
              <EmptyState
                icon={<IcEditChecklist width={32} height={32} />}
                title="No board items"
                description="This team has no queue-backed Board items yet."
              />
            )}

            {!loading && !boardUnsupported && boardItems.length > 0 && (
              <div className="flex gap-3 overflow-x-auto pb-4">
                {boardSections.map(({ status, items: statusItems }) => {
                  return (
                    <div key={status} className="kanban-col flex flex-col gap-1.5">
                      <div className="kanban-col-header">
                        <span className={`kanban-col-dot ${boardDotColor[status] ?? 'bg-text-dim'}`} />
                        <span className="text-[11px] tracking-[-0.11px] font-normal text-text-dim uppercase">
                          {status.replace(/_/g, ' ')}
                        </span>
                        <span className="data-mono ml-auto">{statusItems.length}</span>
                      </div>

                      {statusItems.map((item) => {
                        const executionStatus = normalizeBoardExecutionStatus(item.executionStatus);
                        const canCancel = !['completed', 'failed', 'cancelled'].includes(executionStatus);
                        const reviewVariant = item.reviewStatus === 'approved'
                          ? 'positive'
                          : item.reviewStatus === 'rejected' || item.reviewStatus === 'revise'
                            ? 'negative'
                            : item.reviewStatus === 'pending_review'
                              ? 'accent'
                              : 'neutral';
                        const executionVariant = executionStatus === 'completed'
                          ? 'positive'
                          : ['failed', 'blocked'].includes(executionStatus)
                            ? 'negative'
                            : ['queued', 'waiting', 'waiting_for_team_slot', 'waiting_for_model', 'running'].includes(executionStatus)
                              ? 'accent'
                              : 'neutral';
                        const queueMeta = [
                          item.source,
                          item.priority ? `priority ${item.priority}` : null,
                        ].filter(Boolean);
                        const resultMeta = [
                          item.resultStatus,
                          item.resultMemberName ? `by ${item.resultMemberName}` : null,
                          item.resultProvider && item.resultModel ? `${item.resultProvider}:${item.resultModel}` : item.resultProvider ?? item.resultModel,
                          item.resultRoute?.length ? `route ${item.resultRoute.join(' -> ')}` : null,
                        ].filter(Boolean);
                        const memberMeta = [
                          item.assignedMembers.length ? `assigned ${item.assignedMembers.join(', ')}` : null,
                          item.reviewerMembers.length ? `reviewers ${item.reviewerMembers.join(', ')}` : null,
                        ].filter(Boolean);
                        return (
                          <Card key={item.id} className="card-hover">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-[13px] tracking-[-0.13px] text-text font-normal truncate">{item.title}</p>
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  <Badge variant={executionVariant}>{executionStatus}</Badge>
                                  <Badge variant={reviewVariant}>{item.reviewStatus}</Badge>
                                </div>
                              </div>
                            </div>
                            {(item.excerpt || item.description) && (
                              <p className="text-[11px] tracking-[-0.11px] text-text-dim mt-2 line-clamp-3">{item.excerpt ?? item.description}</p>
                            )}
                            {memberMeta.length > 0 && <p className="data-mono mt-2">{memberMeta.join(' · ')}</p>}
                            {queueMeta.length > 0 && <p className="data-mono mt-1 text-text-dim">{queueMeta.join(' · ')}</p>}
                            {item.resultSummary && (
                              <p className="mt-2 rounded-[6px] border border-border bg-surface/60 px-2 py-1.5 text-[11px] tracking-[-0.11px] text-text line-clamp-4">
                                {item.resultSummary}
                              </p>
                            )}
                            {resultMeta.length > 0 && <p className="data-mono mt-1 text-text-dim">{resultMeta.join(' · ')}</p>}
                            {(item.blockedReason || item.reviewFeedback) && (
                              <p className="text-[11px] tracking-[-0.11px] text-text-dim mt-2">
                                {[item.blockedReason ? `Blocked: ${item.blockedReason}` : null, item.reviewFeedback ? `Review: ${item.reviewFeedback}` : null].filter(Boolean).join(' · ')}
                              </p>
                            )}
                            <div className="mt-2 flex flex-wrap gap-1">
                              {BOARD_REVIEW_STATUSES.map((reviewStatus) => (
                                <Button
                                  key={reviewStatus}
                                  variant={item.reviewStatus === reviewStatus ? 'default' : 'ghost'}
                                  size="sm"
                                  onClick={() => handleSetReviewStatus(item.id, reviewStatus)}
                                  disabled={updatingReviewId === item.id}
                                >
                                  {reviewStatus.replace(/_/g, ' ')}
                                </Button>
                              ))}
                            </div>
                            {canCancel && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="mt-2 w-full"
                                onClick={() => handleCancelBoardItem(item.id)}
                                disabled={cancellingId === item.id}
                              >
                                {cancellingId === item.id ? 'Cancelling...' : 'Cancel'}
                              </Button>
                            )}
                          </Card>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            <button
              className="fixed bottom-20 right-4 w-12 h-12 rounded-[6px] bg-accent text-text-highlight flex items-center justify-center cursor-pointer border-none z-20 press-spring"
              style={{ boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}
              onClick={() => setShowAddForm(true)}
            >
              <IcEditAdd width={20} height={20} />
            </button>

            <Dialog open={showAddForm} onClose={() => setShowAddForm(false)} title="New Task">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Title</span>
                  <Input placeholder="Fix the auth bug" value={newSubject} onChange={(e) => setNewSubject(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Description (optional)</span>
                  <Textarea rows={4} placeholder="Details about the task..." value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Assign to (optional)</span>
                  <MultiSelect
                    values={newOwners}
                    options={teamMembers}
                    onValuesChange={setNewOwners}
                    placeholder="Select agents..."
                  />
                </div>
                <div className="flex gap-2 justify-end mt-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>Cancel</Button>
                  <Button size="sm" onClick={handleAddTask} disabled={addingTask || !newSubject.trim()}>
                    {addingTask ? 'Adding...' : 'Add Task'}
                  </Button>
                </div>
              </div>
            </Dialog>

            <Dialog open={showTeamForm} onClose={() => setShowTeamForm(false)} title="" className={UNTITLED_DIALOG_CLASS}>
              <div className="flex max-h-[70vh] flex-col">
                <div className="flex flex-col gap-3 overflow-y-auto pr-1">
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Team Name</span>
                    <Input placeholder="Team name" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Working Directory</span>
                    <Input placeholder="~/projects/openvide" value={teamCwd} onChange={(e) => setTeamCwd(e.target.value)} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] tracking-[-0.13px] text-text font-normal">Members</span>
                    <Button size="sm" onClick={addTeamMember}>
                      <IcEditAdd width={16} height={16} />
                    </Button>
                  </div>
                  {teamMemberDrafts.map((member, index) => (
                    <div key={member.draftId} className="bg-surface-light rounded-[6px] p-2.5 flex flex-col gap-2">
                      <div className="flex gap-1.5 items-end">
                        <div className="flex-1 flex flex-col gap-0.5">
                          <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Name</span>
                          <Input placeholder="alice" value={member.name} onChange={(e) => updateTeamMember(index, 'name', e.target.value)} />
                        </div>
                        {teamMemberDrafts.length > 1 && (
                          <button
                            className="shrink-0 w-9 h-9 rounded-[6px] bg-negative flex items-center justify-center cursor-pointer border-none hover:opacity-90 transition-opacity press-spring"
                            onClick={() => removeTeamMember(index)}
                            style={{ color: '#fff' }}
                          >
                            <IcEditTrash width={16} height={16} />
                          </button>
                        )}
                      </div>
                      <div className="flex gap-1.5">
                        <div className="flex-1 flex flex-col gap-0.5">
                          <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Tool</span>
                          <Select
                            value={member.tool}
                            options={teamToolOptions}
                            onValueChange={(value) => {
                              if (isProviderSelectable(teamProvidersByValue.get(value))) updateTeamMember(index, 'tool', value);
                            }}
                          />
                        </div>
                        <div className="flex-1 flex flex-col gap-0.5">
                          <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Role</span>
                          <Select value={member.role} options={teamRoleOptions} onValueChange={(value) => updateTeamMember(index, 'role', value)} />
                        </div>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Model Override</span>
                        <Input placeholder="Default" value={member.model ?? ''} onChange={(e) => updateTeamMember(index, 'model', e.target.value)} />
                        <span className="text-[10px] tracking-[-0.1px] text-text-dim">{providerCapabilityHint(teamProvidersByValue.get(member.tool))}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2 justify-end mt-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowTeamForm(false)}>Cancel</Button>
                  <Button size="sm" onClick={handleSaveTeam} disabled={savingTeam || !teamName.trim() || !teamCwd.trim() || teamMemberDrafts.some((member) => !member.name.trim())}>
                    {savingTeam ? 'Saving...' : 'Save Team'}
                  </Button>
                </div>
              </div>
            </Dialog>
          </>
        )}

        {activeTab === 'plan' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-[15px] tracking-[-0.15px] font-normal text-text">Autonomous Plan</h2>
                <p className="text-[11px] tracking-[-0.11px] text-text-dim">Planner + reviewers run from the daemon.</p>
              </div>
              <Button size="sm" onClick={() => setShowPlanForm(true)}>
                <IcEditAdd width={16} height={16} />
              </Button>
            </div>

            {!latestPlan && (
              <EmptyState
                icon={<IcFeatLearnExplore width={32} height={32} />}
                title="No plan yet"
                description="Generate a plan and the team daemon will route it through planner and reviewer sessions."
              />
            )}

            {latestPlan && (
              <>
                <ListItem
                  title={latestPlan.id}
                  subtitle={`${latestPlan.mode} · iteration ${latestPlan.iteration}/${latestPlan.maxIterations}`}
                  trailing={(
                    <Badge variant={latestPlan.status === 'approved' || latestPlan.status === 'auto-approved' ? 'positive' : latestPlan.status === 'rejected' ? 'negative' : 'neutral'}>
                      {deletingPlanId === latestPlan.id ? '...' : latestPlan.status}
                    </Badge>
                  )}
                  onDelete={() => handleDeletePlan(latestPlan.id)}
                />

                <Card>
                  <div className="flex flex-wrap gap-1.5">
                    {latestPlan.reviewers.map((reviewer) => (
                      <Badge key={reviewer} variant="neutral">{reviewer}</Badge>
                    ))}
                  </div>
                </Card>

                {latestPlan.votes.length > 0 && (
                  <Card>
                    <p className="text-[13px] tracking-[-0.13px] font-normal text-text mb-2">Votes</p>
                    <div className="flex flex-col gap-2">
                      {latestPlan.votes.map((vote, index) => (
                        <div key={`${vote.reviewer}-${index}`} className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="data-mono">{vote.reviewer}</p>
                            {vote.feedback && <p className="text-[11px] tracking-[-0.11px] text-text-dim mt-0.5">{vote.feedback}</p>}
                          </div>
                          <Badge variant={vote.vote === 'approve' ? 'positive' : vote.vote === 'reject' ? 'negative' : 'neutral'}>
                            {vote.vote}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                <Card>
                  <p className="text-[13px] tracking-[-0.13px] font-normal text-text mb-2">Latest Tasks</p>
                  <div className="flex flex-col gap-2">
                    {(latestRevision?.tasks ?? []).map((task, index) => (
                      <div key={`${task.subject}-${index}`} className="rounded-[6px] bg-surface-light p-2.5">
                        <div className="flex items-center gap-2">
                          <span className="data-mono">{index + 1}.</span>
                          <span className="text-[13px] tracking-[-0.13px] text-text">{task.subject}</span>
                        </div>
                        <p className="text-[11px] tracking-[-0.11px] text-text-dim mt-1">{task.description}</p>
                        <p className="data-mono mt-1">@{task.owner}{task.dependencies?.length ? ` · deps ${task.dependencies.join(', ')}` : ''}</p>
                      </div>
                    ))}
                  </div>
                </Card>
              </>
            )}

            <Dialog open={showPlanForm} onClose={() => setShowPlanForm(false)} title="Generate Plan">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Review mode</span>
                  <Select value={planMode} options={PLAN_MODE_OPTIONS} onValueChange={(value) => setPlanMode(value as 'simple' | 'consensus')} />
                </div>
                {planMode === 'consensus' && (
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Max consensus rounds</span>
                    <Select value={planMaxIterations} options={PLAN_MAX_ITERATION_OPTIONS} onValueChange={setPlanMaxIterations} />
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] tracking-[-0.11px] text-text-dim font-normal">Request</span>
                  <Textarea
                    rows={6}
                    value={planRequest}
                    onChange={(e) => setPlanRequest(e.target.value)}
                    placeholder="Break down the current auth regression into implementation and review tasks, assign owners, and include dependencies."
                  />
                </div>
                <div className="flex gap-2 justify-end mt-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowPlanForm(false)}>Cancel</Button>
                  <Button size="sm" onClick={handleGeneratePlan} disabled={generatingPlan || !planRequest.trim()}>
                    {generatingPlan ? 'Starting...' : 'Generate'}
                  </Button>
                </div>
              </div>
            </Dialog>
          </div>
        )}

        {activeTab === 'runs' && (
          <TeamRunsPanel teamId={teamId} teamName={teamName} embedded />
        )}
      </div>
    </div>
  );
}
