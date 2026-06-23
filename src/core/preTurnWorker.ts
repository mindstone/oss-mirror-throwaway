export interface PreTurnRequest {
  prompt: string;
  fileQueryEmbedding?: number[];
  toolQueryEmbedding?: number[];
  conversationQueryEmbedding?: number[];
  skillQueryEmbedding?: number[];
  fileQueryText?: string;
  toolSearchIntentionallySkipped?: boolean;
  toolIndexUsable?: boolean;
}

export interface PreTurnResult {
  semanticContext?: {
    formattedContext: string;
    fileCount: number;
    files?: Array<{ relativePath: string; score: number }>;
  };
  suggestedTools?: Array<{
    toolId: string;
    serverId: string;
    serverName: string;
    description: string;
    summary: string;
    inputSchema: string;
    score: number;
  }>;
  suggestedConversations?: Array<{
    sessionId: string;
    title: string;
    score: number;
    createdAt: number;
    messageCount: number;
  }>;
  suggestedSkills?: Array<{
    relativePath: string;
    skillName: string;
    description: string;
    score: number;
  }>;
  toolSearchStatus?: 'ok' | 'skipped' | 'unavailable';
  conversationSearchStatus?: 'ok' | 'unavailable';
}

export interface PreTurnWorkerStatus {
  isReady: boolean;
  permanentlyDisabled: boolean;
  consecutiveCrashes: number;
  crashCooldownRemainingMs: number;
  workspacePath: string | null;
}

export type PreTurnWorkerCrashCategory =
  | 'oom'
  | 'unhandled_exception'
  | 'sigterm'
  | 'unknown';

export interface PreTurnWorkerStatsSnapshot {
  since: 'app_start';
  appStartedAt: number;
  spawnCount: number;
  restartCount: number;
  lastCrashCategory?: PreTurnWorkerCrashCategory;
  lastCrashAt?: number;
  averagePreTurnDurationBucket?: '<100ms' | '<500ms' | '<2s' | '>=2s';
  currentlyRestarting: boolean;
  persistedLastCrashAt?: number;
  persistedLastCrashCategory?: PreTurnWorkerCrashCategory;
  crashesInLast7Days?: number;
  totalCrashesAllTime?: number;
}

export interface PreTurnWorker {
  waitForWorkerReady(workspacePath: string): Promise<void>;
  isWorkerAvailable(): boolean;
  assemblePreTurnContext(
    workspacePath: string,
    request: PreTurnRequest,
    urlDomainHints?: string,
  ): Promise<PreTurnResult>;
  disposeWorker(): Promise<void>;
  getWorkerStatus(): PreTurnWorkerStatus;
  getPreTurnWorkerStats(): PreTurnWorkerStatsSnapshot;
}

export type PreTurnWorkerFactory = () => PreTurnWorker;

let _factory: PreTurnWorkerFactory | undefined;
let _instance: PreTurnWorker | undefined;

export function setPreTurnWorkerFactory(factory: PreTurnWorkerFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getPreTurnWorker(): PreTurnWorker {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error(
      'PreTurnWorker not initialized. Call setPreTurnWorkerFactory() before use.',
    );
  }
  _instance = _factory();
  return _instance;
}
