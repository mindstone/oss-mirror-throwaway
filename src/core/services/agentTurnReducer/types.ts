import type { AgentEvent } from '@shared/types';
import type { AgentErrorKind } from '@shared/utils/agentErrorCatalog';
import type { MissionContext, TaskProgressItem } from './missionTask';
import type { SubAgentItem } from './subAgents';

export interface CurrentToolEvent {
  toolName: string;
  detail?: string;
  isError?: boolean;
  toolUseId?: string;
}

export interface CompletedStep {
  label: string;
  timestamp: number;
  toolName: string;
  detail?: string;
  isError?: boolean;
  toolUseId?: string;
}

export interface LiveTurnState {
  isSending: boolean;
  streamingText: string;
  statusText: string | null;
  activeTurnId: string | null;
  currentTool: CurrentToolEvent | null;
  completedSteps: CompletedStep[];
  missionContext: MissionContext | null;
  taskProgress: TaskProgressItem[];
  subAgentItems: SubAgentItem[];
  error: string | null;
  hasMissionSet: boolean;
  touchedTaskIds: string[];
  userQuestionEventsByTurn: Record<string, AgentEvent[]>;
  receivedTerminal: boolean;
  hasSeenTaskSnapshot: boolean;
}

export interface ReducerEnvelope {
  sessionId: string;
  turnId: string | null;
  now: number;
}

export type TurnReducerEffect =
  | { kind: 'terminal-refresh'; sessionId: string; clearOptimisticMessagesIfStable: true }
  | { kind: 'snapshot-completed-steps'; turnId: string; steps: CompletedStep[] }
  | { kind: 'snapshot-mission-task'; turnId: string; mission: MissionContext | null; tasks: TaskProgressItem[]; hasMissionSet: boolean; touchedTaskIds: string[] }
  | { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; context?: Record<string, unknown> };

export type HumanizeErrorInput = {
  errorKind?: AgentErrorKind;
  billingMeta?: Extract<AgentEvent, { type: 'error' }>['billingMeta'];
  rateLimitMeta?: Extract<AgentEvent, { type: 'error' }>['rateLimitMeta'];
  provider?: string;
  rawMessage: string;
};

export interface ReducerOptions {
  humanizeError?: (input: HumanizeErrorInput) => string;
  shouldSuppressStatus?: (message: string) => boolean;
  truncateToolDetail?: (detail: string | undefined) => string | undefined;
}

export type LiveTurnReducerResult = {
  state: LiveTurnState;
  effects: TurnReducerEffect[];
};
