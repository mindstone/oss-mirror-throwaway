/**
 * IPC Bridge — typed domain APIs built from contract definitions.
 *
 * Replaces the former code-generated bridge (`src/preload/generated/ipcBridge.ts`).
 * Each domain API is created at runtime by `makeDomainApi()` which maps channel
 * definitions to `ipcRenderer.invoke` / `ipcRenderer.sendSync` calls. TypeScript
 * mapped types ensure full compile-time safety without Zod runtime introspection.
 *
 * @see src/preload/ipcBridgeBuilder.ts — generic factory + type utilities
 * @see src/shared/ipc/contracts.ts     — channel definitions (single source of truth)
 */

import { ipcContract } from '@shared/ipc/contracts';
import { makeDomainApi } from './ipcBridgeBuilder';

export type { MeetingTriggerDetectedPayload } from '@shared/ipc/channels/meetingTrigger';

// =============================================================================
// Domain APIs
// =============================================================================

/** Library file operations API */
export const libraryApi = makeDomainApi(ipcContract.library);
/** Application settings API */
export const settingsApi = makeDomainApi(ipcContract.settings);
/** Shell and URL operations API */
export const appApi = makeDomainApi(ipcContract.app);
/** PDF and file export API */
export const exportApi = makeDomainApi(ipcContract.export);
/** Rebel transfer import/export API */
export const migrationApi = makeDomainApi(ipcContract.migration);
/** Voice transcription and TTS API */
export const voiceApi = makeDomainApi(ipcContract.voice);
/** Agent turn execution API */
export const agentApi = makeDomainApi(ipcContract.agent);
/** Agent error resolution API */
export const agentErrorApi = makeDomainApi(ipcContract.agentError);
/** Legacy alias for existing renderer call sites. */
export const errorApi = agentErrorApi;
/** OS permission checks API */
export const permissionsApi = makeDomainApi(ipcContract.permissions);
/** Agent session persistence API */
export const sessionsApi = makeDomainApi(ipcContract.sessions);
/** Inbox management API */
export const inboxApi = makeDomainApi(ipcContract.inbox);
/** Scheduled automation workflows API */
export const automationsApi = makeDomainApi(ipcContract.automations);
/** Demo mode management API */
export const demoApi = makeDomainApi(ipcContract.demo);
/** Contextual suggestions API */
export const dashboardApi = makeDomainApi(ipcContract.dashboard);
/** Search API */
export const searchApi = makeDomainApi(ipcContract.search);
/** System health diagnostics API */
export const systemHealthApi = makeDomainApi(ipcContract.systemHealth);
/** Miscellaneous operations API (analytics, Sentry, conversation, etc.) */
export const miscApi = makeDomainApi(ipcContract.misc);
/** Authentication API */
export const authApi = makeDomainApi(ipcContract.auth);
/** Memory API */
export const memoryApi = makeDomainApi(ipcContract.memory);
/** Scratchpad API */
export const scratchpadApi = makeDomainApi(ipcContract.scratchpad);
/** Google Workspace API */
export const googleWorkspaceApi = makeDomainApi(ipcContract.googleWorkspace);
/** GitHub API */
export const githubApi = makeDomainApi(ipcContract.github);
/** Slack API */
export const slackApi = makeDomainApi(ipcContract.slack);
/** HubSpot API */
export const hubspotApi = makeDomainApi(ipcContract.hubspot);
/** Zendesk API (API-key account management; OAuth wiring was removed in the OSS
 * scrub but the API-key channels + main-side handlers are intentionally preserved). */
export const zendeskApi = makeDomainApi(ipcContract.zendesk);
/** Discourse API */
export const discourseApi = makeDomainApi(ipcContract.discourse);
/** Microsoft API */
export const microsoftApi = makeDomainApi(ipcContract.microsoft);
/** Usage API */
export const usageApi = makeDomainApi(ipcContract.usage);
/** Community API */
export const communityApi = makeDomainApi(ipcContract.community);
/** Safety API */
export const safetyApi = makeDomainApi(ipcContract.safety);
/** Safety prompt API */
export const safetyPromptApi = makeDomainApi(ipcContract.safetyPrompt);
/** Safety activity log API */
export const safetyActivityLogApi = makeDomainApi(ipcContract.safetyActivityLog);
/** Skills API */
export const skillsApi = makeDomainApi(ipcContract.skills);
/** Skill history API */
export const skillHistoryApi = makeDomainApi(ipcContract.skillHistory);
/** Operators API */
export const operatorsApi = makeDomainApi(ipcContract.operators);
/** Feedback API */
export const feedbackApi = makeDomainApi(ipcContract.feedback);
/** Plugins API */
export const pluginsApi = makeDomainApi(ipcContract.plugins);
/** Bug report API */
export const bugReportApi = makeDomainApi(ipcContract.bugReport);
/** File conversation API */
export const fileConversationApi = makeDomainApi(ipcContract.fileConversation);
/** User tasks API */
export const userTasksApi = makeDomainApi(ipcContract.userTasks);
/** Todoist API */
export const todoistApi = makeDomainApi(ipcContract.todoist);
/** Use case library API */
export const useCaseLibraryApi = makeDomainApi(ipcContract.useCaseLibrary);
/** Calendar API */
export const calendarApi = makeDomainApi(ipcContract.calendar);
/** Error recovery API */
export const errorRecoveryApi = makeDomainApi(ipcContract.errorRecovery);
/** Meeting bot API */
export const meetingBotApi = makeDomainApi(ipcContract.meetingBot);
/** Time saved API */
export const timeSavedApi = makeDomainApi(ipcContract.timeSaved);
/** Local STT API */
export const localSttApi = makeDomainApi(ipcContract.localStt);
/** Local Inference API (bundled Ollama) */
export const localInferenceApi = makeDomainApi(ipcContract.localInference);
/** Physical recording API */
export const physicalRecordingApi = makeDomainApi(ipcContract.physicalRecording);
/** Quick capture API */
export const quickCaptureApi = makeDomainApi(ipcContract.quickCapture);
/** Plaud API */
export const plaudApi = makeDomainApi(ipcContract.plaud);
/** MCP apps API */
export const mcpAppsApi = makeDomainApi(ipcContract.mcpApps);
/** Version API */
export const versionApi = makeDomainApi(ipcContract.version);
/** Cloud Sprite provisioning, management, and migration API */
export const cloudApi = makeDomainApi(ipcContract.cloud);
/** Cloud continuity API */
export const cloudContinuityApi = makeDomainApi(ipcContract.cloudContinuity);
/** Inbound triggers API */
export const inboundTriggersApi = makeDomainApi(ipcContract.inboundTriggers);
/** System improvement API */
export const systemImprovementApi = makeDomainApi(ipcContract.systemImprovement);
/** Codex API */
export const codexApi = makeDomainApi(ipcContract.codex);
/** Subscription API */
export const subscriptionApi = makeDomainApi(ipcContract.subscription);
/** Identity API — OSS lead-capture egress (desktop-only, not cloud-routable) */
export const identityApi = makeDomainApi(ipcContract.identity);
/** OpenRouter API */
export const openRouterApi = makeDomainApi(ipcContract.openRouter);
/** Hero choice API */
export const heroChoiceApi = makeDomainApi(ipcContract.heroChoice);
/** Daily Spark API */
export const dailySparkApi = makeDomainApi(ipcContract.dailySpark);
/** Community events API */
export const communityEventsApi = makeDomainApi(ipcContract.communityEvents);
/** Community video recommendations API */
export const communityVideoRecsApi = makeDomainApi(ipcContract.communityVideoRecs);
/** Focus / Goals API */
export const focusApi = makeDomainApi(ipcContract.focus);
/** Conversation folders API */
export const foldersApi = makeDomainApi(ipcContract.folders);
/** Contribution API */
export const contributionApi = makeDomainApi(ipcContract.contribution);
/** App Bridge (browser-extension pairing) API */
export const appBridgeApi = makeDomainApi(ipcContract.appBridge);
/** Office sidecar status + retry API */
export const officeSidecarApi = makeDomainApi(ipcContract.officeSidecar);
/** Space maintenance API — dry-run preview + manual needs-review recovery */
export const spaceMaintenanceApi = makeDomainApi(ipcContract.spaceMaintenance);
/** Diagnostics API — read recent diagnostic events for the in-app Diagnostics surface */
export const diagnosticsApi = makeDomainApi(ipcContract.diagnostics);
/** HTML preview trust API — per-file trust gate for the rebel-html viewer */
export const htmlPreviewTrustApi = makeDomainApi(ipcContract.htmlPreviewTrust);
/** Achievements API — streaks, badges, fluency tiers, onboarding journey, counters */
export const achievementsApi = makeDomainApi(ipcContract.achievements);
/** Salesforce API — account management and OAuth */
export const salesforceApi = makeDomainApi(ipcContract.salesforce);

// =============================================================================
// Type exports
// =============================================================================

export type LibraryApi = typeof libraryApi;
export type SettingsApi = typeof settingsApi;
export type AppApi = typeof appApi;
export type ExportApi = typeof exportApi;
export type MigrationApi = typeof migrationApi;
export type VoiceApi = typeof voiceApi;
export type AgentApi = typeof agentApi;
export type AgentErrorApi = typeof agentErrorApi;
export type ErrorApi = typeof errorApi;
export type PermissionsApi = typeof permissionsApi;
export type SessionsApi = typeof sessionsApi;
export type InboxApi = typeof inboxApi;
export type AutomationsApi = typeof automationsApi;
export type DemoApi = typeof demoApi;
export type DashboardApi = typeof dashboardApi;
export type SearchApi = typeof searchApi;
export type SystemHealthApi = typeof systemHealthApi;
export type MiscApi = typeof miscApi;
export type AuthApi = typeof authApi;
export type MemoryApi = typeof memoryApi;
export type ScratchpadApi = typeof scratchpadApi;
export type GoogleWorkspaceApi = typeof googleWorkspaceApi;
export type GithubApi = typeof githubApi;
export type SlackApi = typeof slackApi;
export type HubspotApi = typeof hubspotApi;
export type ZendeskApi = typeof zendeskApi;
export type DiscourseApi = typeof discourseApi;
export type MicrosoftApi = typeof microsoftApi;
export type UsageApi = typeof usageApi;
export type CommunityApi = typeof communityApi;
export type SafetyApi = typeof safetyApi;
export type SafetyPromptApi = typeof safetyPromptApi;
export type SafetyActivityLogApi = typeof safetyActivityLogApi;
export type SkillsApi = typeof skillsApi;
export type SkillHistoryApi = typeof skillHistoryApi;
export type OperatorsApi = typeof operatorsApi;
export type FeedbackApi = typeof feedbackApi;
export type PluginsApi = typeof pluginsApi;
export type BugReportApi = typeof bugReportApi;
export type FileConversationApi = typeof fileConversationApi;
export type UserTasksApi = typeof userTasksApi;
export type TodoistApi = typeof todoistApi;
export type UseCaseLibraryApi = typeof useCaseLibraryApi;
export type CalendarApi = typeof calendarApi;
export type ErrorRecoveryApi = typeof errorRecoveryApi;
export type MeetingBotApi = typeof meetingBotApi;
export type TimeSavedApi = typeof timeSavedApi;
export type LocalSttApi = typeof localSttApi;
export type LocalInferenceApi = typeof localInferenceApi;
export type PhysicalRecordingApi = typeof physicalRecordingApi;
export type QuickCaptureApi = typeof quickCaptureApi;
export type PlaudApi = typeof plaudApi;
export type McpAppsApi = typeof mcpAppsApi;
export type VersionApi = typeof versionApi;
export type CloudApi = typeof cloudApi;
export type CloudContinuityApi = typeof cloudContinuityApi;
export type InboundTriggersApi = typeof inboundTriggersApi;
export type SystemImprovementApi = typeof systemImprovementApi;
export type CodexApi = typeof codexApi;
export type SubscriptionApi = typeof subscriptionApi;
export type IdentityApi = typeof identityApi;
export type OpenRouterApi = typeof openRouterApi;
export type HeroChoiceApi = typeof heroChoiceApi;
export type DailySparkApi = typeof dailySparkApi;
export type CommunityEventsApi = typeof communityEventsApi;
export type CommunityVideoRecsApi = typeof communityVideoRecsApi;
export type FocusApi = typeof focusApi;
export type FoldersApi = typeof foldersApi;
export type ContributionApi = typeof contributionApi;
export type AppBridgeApi = typeof appBridgeApi;
export type OfficeSidecarGeneratedApi = typeof officeSidecarApi;
export type SpaceMaintenanceApi = typeof spaceMaintenanceApi;
export type DiagnosticsApi = typeof diagnosticsApi;
export type HtmlPreviewTrustApi = typeof htmlPreviewTrustApi;
export type AchievementsApi = typeof achievementsApi;
export type SalesforceApi = typeof salesforceApi;

// =============================================================================
// Legacy Compatibility Layer
// =============================================================================

/**
 * Legacy flat API surface for backward compatibility.
 * New code should use domain-specific APIs (libraryApi, settingsApi, etc.).
 *
 * @deprecated Use domain-specific APIs instead
 */
export const legacyApiMethods = {
  // Library methods (legacy names)
  listWorkspaceFiles: libraryApi.listFiles,
  readWorkspaceFile: libraryApi.readFile,
  readFileAsBase64: libraryApi.readFileBase64,
  writeWorkspaceFile: libraryApi.writeFile,
  createWorkspaceFile: libraryApi.createFile,
  createWorkspaceFolder: libraryApi.createFolder,
  renameWorkspaceItem: libraryApi.renameItem,
  moveWorkspaceItem: libraryApi.moveItem,
  deleteWorkspaceItem: libraryApi.deleteItem,

  // Settings methods (legacy names)
  getSettings: settingsApi.get,
  updateSettings: settingsApi.update,
  getDefaultWorkspacePath: settingsApi.getDefaultWorkspace,
  chooseDirectory: settingsApi.chooseDirectory,
  chooseFile: settingsApi.chooseFile,
  chooseExecutable: settingsApi.chooseExecutable,
  getMcpSummary: settingsApi.mcpSummary,
  ensureManagedMcpConfig: settingsApi.mcpEnsureManaged,
  getMcpServerDetails: settingsApi.mcpGetServer,
  addRebelInboxServer: settingsApi.mcpAddRebelServer,
  addRebelTaskQueueServer: settingsApi.mcpAddRebelServer,
  upsertMcpServer: settingsApi.mcpUpsertServer,
  removeMcpServer: settingsApi.mcpRemoveServer,
  patchMcpRouterPath: settingsApi.mcpRouterPath,

  // App methods
  openPath: appApi.openPath,
  openUrl: appApi.openUrl,
  revealPath: appApi.revealPath,

  // Export methods
  exportToPdf: exportApi.toPdf,
  saveFile: exportApi.saveFile,

  // Voice methods
  transcribeAudio: voiceApi.transcribe,
  textToSpeech: voiceApi.textToSpeech,

  // Agent methods
  startAgentTurn: agentApi.turn,
  stopTurn: agentApi.stopTurn,

  // Permissions methods
  getMicrophonePermissionStatus: permissionsApi.getMicrophoneStatus,
  requestMicrophonePermission: permissionsApi.requestMicrophone,
  checkFileAccess: permissionsApi.checkFileAccess,
  openSystemPreferences: permissionsApi.openSystemPreferences,

  // Sessions methods
  loadAgentSessions: sessionsApi.load,
  saveAgentSessions: sessionsApi.save,

  // Inbox methods
  loadInbox: inboxApi.load,
  deleteInboxItem: inboxApi.delete,
  recordInboxExecution: inboxApi.recordExecution,
  loadTaskQueue: inboxApi.load,
  deleteTask: inboxApi.delete,
  recordTaskExecution: inboxApi.recordExecution,

  // Automations methods
  loadAutomations: automationsApi.state,
  upsertAutomation: automationsApi.upsert,
  deleteAutomation: automationsApi.delete,
  runAutomationNow: automationsApi.runNow,

  // Demo methods
  enterDemoMode: demoApi.enter,
  exitDemoMode: demoApi.exit,
  getDemoModeStatus: demoApi.status,

  // Misc methods
  getAnalyticsStatus: miscApi.status,
  generateConversationTitle: miscApi.generateTitle,
  captureException: miscApi.captureException,
  captureMessage: miscApi.captureMessage,
};

export type LegacyApiMethods = typeof legacyApiMethods;
