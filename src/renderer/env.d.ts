import type { IPCInterface } from '@sentry/electron/common/ipc';
import type {
  ApiBridge,
  SettingsApi,
  LibraryApi,
  RebelE2EApi,
  EmergencyApi,
  UserEngagementApi,
  FileApi,
  PluginsApi,
  BugReportApi,
  FeedbackApi,
  HeroChoiceApi,
  ContributionApi,
  OfficeSidecarApi,
} from '../preload/index';
import type { CommunityEventsApi, CommunityVideoRecsApi, DailySparkApi, FocusApi, FoldersApi, AppBridgeApi, DiagnosticsApi, HtmlPreviewTrustApi } from '../preload/ipcBridge';
import type {
  InboxApi,
  AutomationsApi,
  AppApi,
  ExportApi,
  VoiceApi,
  PermissionsApi,
  DemoApi,
  MiscApi,
  SessionsApi,
  AgentApi,
  AgentErrorApi,
  ErrorApi,
  DashboardApi,
  SearchApi,
  SystemHealthApi,
  AuthApi,
  MemoryApi,
  ScratchpadApi,
  GoogleWorkspaceApi,
  GithubApi,
  CodexApi,
  SubscriptionApi,
  IdentityApi,
  OpenRouterApi,
  SlackApi,
  HubspotApi,
  DiscourseApi,
  MicrosoftApi,
  UsageApi,
  SafetyApi,
  SafetyPromptApi,
  SafetyActivityLogApi,
  SkillsApi,
  SkillHistoryApi,
  OperatorsApi,
  FileConversationApi,
  UserTasksApi,
  TodoistApi,
  CalendarApi,
  ErrorRecoveryApi,
  MeetingBotApi,
  LocalSttApi,
  LocalInferenceApi,
  PhysicalRecordingApi,
  PlaudApi,
  McpAppsApi,
  VersionApi,
  CloudApi as GeneratedCloudApi,
  CloudContinuityApi,
  InboundTriggersApi,
  UseCaseLibraryApi,
  SystemImprovementApi,
  TimeSavedApi,
  AchievementsApi,
  SalesforceApi,
  SpaceMaintenanceApi,
  MigrationApi,
} from '../preload/ipcBridge';

type CloudApi = GeneratedCloudApi & {
  onMigrationProgress: (callback: (step: {
    phase: string;
    message: string;
    progress: number;
    current?: number;
    total?: number;
  }) => void) => () => void;
  onSessionsSynced: (callback: (data: { upserted: string[]; deleted: string[] }) => void) => () => void;
  onFoldersRestored: (callback: (data: { folderCount: number; membershipCount: number }) => void) => () => void;
  onOutboxChanged: (callback: (status: { pending: number; failed: number }) => void) => () => void;
  onContinuityChanged: (callback: () => void) => () => void;
  onProvisioningProgress?: (callback: (step: {
    phase: string;
    message: string;
    progress: number;
    failedStep?: number;
  }) => void) => () => void;
  onWorkspaceConflicts: (callback: (data: { paths: string[] }) => void) => () => void;
  /** Pending cloud updates (newer cloud-only versions of OS-synced files) changed. */
  onWorkspacePendingUpdates: (callback: (data: { paths: string[] }) => void) => () => void;
  onSessionConflict: (callback: (data: {
    sessionId: string;
    conflictType: 'stale-metadata' | 'concurrent-edit';
    fields?: string[];
    detectedAt: number;
  }) => void) => () => void;
  onCloudUpdateStatus?: (callback: (data: { status: string; message: string; timestamp: number }) => void) => () => void;
  /** Subscribe to cloud pressure state changes broadcast by the main process.
   *  Push channel — fires immediately on state changes without waiting for the
   *  next cloud:status poll. Returns an unsubscribe function. */
  onPressureState: (callback: (data: {
    state: 'ok' | 'warning' | 'critical' | 'unknown';
    timestamp: number;
    recentPressureEvents?: Array<{
      state: 'ok' | 'warning' | 'critical' | 'unknown';
      at: number;
      oom: boolean;
      recentRestart: boolean;
    }>;
  }) => void) => () => void;
};

declare global {
  interface Window {
    api: ApiBridge;
    fileApi: FileApi;
    settingsApi: SettingsApi;
    libraryApi: LibraryApi;
    inboxApi: InboxApi;
    tasksApi: InboxApi; // Legacy alias
    automationsApi: AutomationsApi;
    appApi: AppApi;
    exportApi: ExportApi;
    migrationApi: MigrationApi;
    voiceApi: VoiceApi;
    permissionsApi: PermissionsApi;
    demoApi: DemoApi;
    miscApi: MiscApi;
    sessionsApi: SessionsApi;
    agentApi: AgentApi;
    agentErrorApi: AgentErrorApi;
    errorApi: ErrorApi;
    dashboardApi: DashboardApi;
    searchApi: SearchApi;
    systemHealthApi: SystemHealthApi;
    authApi: AuthApi;
    memoryApi: MemoryApi;
    scratchpadApi: ScratchpadApi;
    googleWorkspaceApi: GoogleWorkspaceApi;
    githubApi: GithubApi;
    codexApi: CodexApi;
    subscriptionApi: SubscriptionApi;
    identityApi: IdentityApi;
    openRouterApi: OpenRouterApi;
    slackApi: SlackApi;
    hubspotApi: HubspotApi;
    discourseApi: DiscourseApi;
    microsoftApi: MicrosoftApi;
    usageApi: UsageApi;
    safetyApi: SafetyApi;
    safetyPromptApi: SafetyPromptApi;
    safetyPromptSubscriptions: {
      onSafetyPromptUpdated: (
        callback: (data: {
          version: number;
          lastUpdatedAt: number;
          lastUpdatedBy: 'user' | 'system' | 'migration';
        }) => void,
      ) => () => void;
      onSafetyPromptRulePersisted: (
        callback: (data: {
          version: number;
          lastUpdatedAt: number;
          source: 'ui-picker' | 'chat-intent' | 'settings-editor' | 'system' | 'migration';
          summary: string;
          proposedPrinciple: string;
        }) => void,
      ) => () => void;
    };
    safetyActivityLogApi: SafetyActivityLogApi;
    safetyActivityLogSubscriptions: {
      onSafetyActivityLogUpdated: (callback: (data: { timestamp: number }) => void) => () => void;
    };
    btsSubscriptions: {
      onStructuredOutputBypassed: (
        callback: (data: {
          profileId: string;
          profileName: string;
          fellBackTo: string;
          caller: string | null;
        }) => void,
      ) => () => void;
    };
    skillsApi: SkillsApi;
    skillHistoryApi: SkillHistoryApi;
    operatorsApi: OperatorsApi;
    pluginsApi: PluginsApi;
    bugReportApi: BugReportApi;
    fileConversationApi: FileConversationApi;
    userTasksApi: UserTasksApi;
    todoistApi: TodoistApi;
    calendarApi: CalendarApi;
    errorRecoveryApi: ErrorRecoveryApi;
    meetingBotApi: MeetingBotApi;
    localSttApi: LocalSttApi;
    localInferenceApi: LocalInferenceApi;
    physicalRecordingApi: PhysicalRecordingApi;
    plaudApi: PlaudApi;
    mcpAppsApi: McpAppsApi;
    versionApi: VersionApi;
    cloudApi: CloudApi;
    cloudContinuityApi: CloudContinuityApi;
    inboundTriggersApi: InboundTriggersApi;
    useCaseLibraryApi: UseCaseLibraryApi;
    systemImprovementApi: SystemImprovementApi;
    heroChoiceApi: HeroChoiceApi;
    dailySparkApi: DailySparkApi;
    communityEventsApi: CommunityEventsApi;
    communityVideoRecsApi: CommunityVideoRecsApi;
    focusApi: FocusApi;
    foldersApi: FoldersApi;
    contributionApi: ContributionApi;
    appBridgeApi: AppBridgeApi;
    officeSidecarApi: OfficeSidecarApi;
    diagnosticsApi: DiagnosticsApi;
    htmlPreviewTrustApi: HtmlPreviewTrustApi;
    timeSavedApi: TimeSavedApi;
    achievementsApi: AchievementsApi;
    salesforceApi: SalesforceApi;
    spaceMaintenanceApi: SpaceMaintenanceApi;
    userEngagementApi: UserEngagementApi;
    e2eApi?: RebelE2EApi;
    feedbackApi: FeedbackApi;
    heroChoiceApi: HeroChoiceApi;
    dailySparkApi: DailySparkApi;
    emergencyApi: EmergencyApi;
    __SENTRY_IPC__?: IPCInterface;
    electronEnv?: {
      anonymousId: string | null;
      appVersion: string | null;
      appName: string | null;
      buildChannel: 'stable' | 'beta' | 'dev' | null;
      analyticsDisabled: boolean;
      /**
       * Runtime Sentry kill-switch from main (`--rebel-sentry-disabled`
       * additionalArguments flag, set when SENTRY_ENABLED is explicitly
       * false-ish at runtime). When true the renderer must not init Sentry —
       * wins over build-inlined DSN and OSS settings telemetry.
       */
      sentryDisabled: boolean;
      userEmail: string | null;
      platform: NodeJS.Platform;
      arch: NodeJS.Architecture;
      runtimeConfig: unknown;
      /**
       * OSS-build telemetry creds (settings.telemetry, LOCAL_ONLY). Populated
       * by main ONLY in an OSS build; `null` in enterprise. The OSS renderer
       * reads telemetry creds EXCLUSIVELY from here (never runtimeConfig/env).
       * Typed `unknown` because it crosses the contextBridge; consumers
       * narrow it. See B6.a (260607_oss-b6-launch-polish).
       */
      telemetryConfig: unknown;
      reloadRuntimeConfig: () => Promise<unknown>;
      syncAnalyticsIdentity: (data: { userId: string; traits: Record<string, unknown> }) => void;
    };
  }

  /**
   * Build-time OSS signal injected by the renderer vite configs
   * (`vite.renderer.config.mjs` + the renderer section of
   * `electron.vite.config.ts`). `undefined` under vitest and any non-vite
   * build — always read it through `rendererIsOss()`
   * (`@renderer/src/rendererIsOss`), never bare (a bare read throws
   * ReferenceError where the define is absent).
   */
  const __REBEL_IS_OSS__: boolean;
}

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*.lottie' {
  const src: string;
  export default src;
}

export {};
