import type {
  AppSettings,
  ConnectorCatalogEntry,
  McpConfigSummary,
  McpServerUpsertPayload,
  McpServerConfigDetails,
  ModelSettings,
} from '@shared/types';

export type SetupWithRebelParams = {
  serverName: string;
  catalogEntry?: ConnectorCatalogEntry;
  /** Result of OAuth authentication (for direct OAuth connectors) */
  oauthResult?: {
    success: boolean;
    status?: 'already_authenticated' | 'authenticated' | 'error';
    error?: string;
    /** Account/workspace identity that was authenticated (e.g., email or workspace name) */
    accountIdentity?: string;
  };
  /** Result of setup action (API key save, direct OAuth, etc.) */
  setupResult?: {
    success: boolean;
    error?: string;
  };
  /** Whether this is a new connection (true) or reconfigure of existing (false) */
  isNewConnection?: boolean;
};

export type UpdateRoot = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
export type UpdateClaude = <K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) => void;
export type UpdateVoice = <K extends keyof AppSettings['voice']>(key: K, value: AppSettings['voice'][K]) => void;

export type SystemTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
  chooseDirectory: () => Promise<void> | void;
};

export type ToolsTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
  mcpSummary: McpConfigSummary | null;
  mcpSummaryLoading: boolean;
  mcpSummaryError: string | null;
  mcpHealthLoading?: boolean;
  mcpMutationPending: boolean;
  refreshMcpSummary: () => Promise<void>;
  reloadConnectors: () => Promise<void>;
  upsertMcpServer: (payload: McpServerUpsertPayload) => Promise<void>;
  removeMcpServer: (name: string) => Promise<void>;
  loadMcpServer: (name: string) => Promise<McpServerConfigDetails>;
  chooseMcpFile: () => Promise<void> | void;
  onNavigateToDiagnostics: () => void;
  onConfigureWithRebel?: (params: SetupWithRebelParams) => void | Promise<void>;
  onBuildConnector?: (searchQuery?: string) => void | Promise<void>;
  onExtendConnector?: (connectorId: string, connectorName: string) => void | Promise<void>;
  onShareWithCommunity?: (connectorName: string) => void | Promise<void>;
  /** Open the originating contribution conversation for a connector. */
  onOpenContributionChat?: (sessionId: string) => void | Promise<void>;
  onGetPythonHelp?: (connectorName: string) => void;
  onRequestConnector?: () => void;
  /** `data-section` id (e.g. `connector-…`) from settings navigation / health deep links; connector-level only. */
  connectorRevealTarget?: string | null;
  /** Fired after local reveal state is applied so the shell can scroll/highlight once the chip exists in the DOM. */
  onConnectorRevealReady?: (sectionId: string | null) => void;
  /**
   * True when the `mcpRuntimeHealth` system-health check is in warn/fail state.
   * Drives the Tools tab manager-status banner so users have a clear surface
   * after following the "A connected tool needs attention" toast deep-link.
   */
  mcpRuntimeHealthDegraded?: boolean;
};

export type AgentsTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
  updateClaude: UpdateClaude;
  updateVoice: UpdateVoice;
  markKeySticky: (key: keyof AppSettings) => void;
};

export type VoiceTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
  updateVoice: UpdateVoice;
};

export type DiagnosticsTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
  onRelaunchOnboarding: () => void;
  onResetOnboardingChecklist: () => void;
};

export type DeveloperTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
};

export type SafetyTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
  onChatAboutSafety?: () => void;
};

export type MeetingsTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
};

export type CloudTabProps = {
  draftSettings: AppSettings;
  updateDraft: UpdateRoot;
  embedded?: boolean;
};
