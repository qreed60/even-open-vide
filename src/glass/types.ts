import type {
  SessionSummary,
  Host,
  Workspace,
  Settings,
  TeamSummary,
  TeamMessageSummary,
  ScheduledTask,
  DiffFile,
  Prompt,
  PortEntry,
  ActionResult,
  FsEntry,
} from '../state/types';
import type { TeamBoardItem } from '../lib/team-board';

export interface OpenVideSnapshot {
  sessions: SessionSummary[];
  hosts: Host[];
  selectedHostId: string | null;
  hostStatuses: Record<string, 'connected' | 'disconnected'>;
  workspaces: Workspace[];
  connectionStatus: 'connected' | 'connecting' | 'disconnected';
  selectedSessionId: string | null;
  selectedSessionMode: string;
  selectedSessionModel: string;
  selectedWorkspace: string | null;
  selectedWorkspaceHostId: string | null;
  outputLines: string[];
  outputScrollOffset: number;
  chatHighlight: number;
  expandedThinking: number[];
  voiceListening: boolean;
  voiceText: string | null;
  teams: TeamSummary[];
  selectedTeamId: string | null;
  teamTasks: TeamBoardItem[];
  teamMessages: TeamMessageSummary[];
  teamPlan: {
    id: string;
    status: string;
    mode: string;
    iteration: number;
    maxIterations: number;
    revisions: Array<{
      tasks: Array<{ subject: string; owner: string }>;
    }>;
  } | null;
  scheduledTasks: ScheduledTask[];
  settings: Settings;
  browserPath: string;
  browserEntries: FsEntry[];
  diffFiles: DiffFile[];
  prompts: Prompt[];
  ports: PortEntry[];
  pendingResult: ActionResult | null;
}

export interface OpenVideActions {
  navigate: (path: string) => void;
  rpc: (cmd: string, params?: Record<string, unknown>) => Promise<any>;
  switchHost: (hostId: string) => void;
  setSessionMode: (mode: string) => void;
  setSessionModel: (model: string) => void;
  startVoice: () => void;
  stopVoice: () => void;
  submitVoice: (prompt: string) => Promise<void>;
}
