/**
 * IPC Contract Definitions — canonical source of truth for every IPC channel
 * between main and renderer. Each channel defines its request/response schema
 * via Zod for runtime validation and TypeScript type inference.
 *
 * Adding a new channel:
 * 1. Add the channel definition to the appropriate domain file in `channels/`
 * 2. Add `export const xxxApi = makeDomainApi(ipcContract.xxx)` to `src/preload/ipcBridge.ts`
 * 3. Implement the handler in the corresponding `src/main/ipc/*Handlers.ts` module
 *
 * Domains live in `channels/` (workspace, settings, app, export, voice, agent,
 * permissions, sessions, inbox, automations, demo, dashboard,
 * systemHealth, misc); each file owns its own per-channel registry.
 *
 * @see docs/project/ARCHITECTURE_IPC.md — IPC contract and dispatch model
 * @see src/main/ipc/index.ts — main-process handler registration barrel
 * @see src/shared/cloudChannelPolicies.ts — cloud routing policy for shared channels
 */

import { z } from 'zod';

// =============================================================================
// Re-export all schemas for backward compatibility
// =============================================================================
export * from './schemas';

// =============================================================================
// Re-export all channels for backward compatibility
// =============================================================================
export * from './channels';

// =============================================================================
// Import channel groups for contract registry
// =============================================================================
import { libraryChannels } from './channels/library';
import { settingsChannels } from './channels/settings';
import { appChannels } from './channels/app';
import { exportChannels } from './channels/export';
import { migrationChannels } from './channels/migration';
import { voiceChannels } from './channels/voice';
import { agentChannels } from './channels/agent';
import { agentErrorChannels } from './channels/agentError';
import { permissionsChannels } from './channels/permissions';
import { sessionsChannels } from './channels/sessions';
import { inboxChannels } from './channels/inbox';
import { automationsChannels } from './channels/automations';
import { demoChannels } from './channels/demo';
import { dashboardChannels } from './channels/dashboard';
import { searchChannels } from './channels/search';
import { systemHealthChannels } from './channels/health';
import { miscChannels } from './channels/misc';
import { authChannels } from './channels/auth';
import { memoryChannels } from './channels/memory';
import { scratchpadChannels } from './channels/scratchpad';
import { googleWorkspaceChannels } from './channels/googleWorkspace';
import { slackChannels } from './channels/slack';
import { hubspotChannels } from './channels/hubspot';
import { zendeskChannels } from './channels/zendesk';
import { discourseChannels } from './channels/discourse';
import { microsoftChannels } from './channels/microsoft';
import { usageChannels } from './channels/usage';
import { communityChannels } from './channels/community';
import { safetyChannels } from './channels/safety';
import { safetyPromptChannels } from './channels/safetyPrompt';
import { safetyActivityLogChannels } from './channels/safetyActivityLog';
import { skillsChannels } from './channels/skills';
import { skillHistoryChannels } from './channels/skillHistory';
import { operatorsChannels } from './channels/operators';
import { feedbackChannels } from './channels/feedback';
import { pluginsChannels } from './channels/plugins';
import { bugReportChannels } from './channels/bugReport';
import { fileConversationChannels } from './channels/fileConversation';
import { userTasksChannels } from './channels/userTasks';
import { todoistChannels } from './channels/todoist';
import { useCaseLibraryChannels } from './channels/useCaseLibrary';
import { calendarChannels } from './channels/calendar';
import { errorRecoveryChannels } from './channels/errorRecovery';
import { meetingBotChannels } from './channels/meetingBot';
import { timeSavedChannels } from './channels/timeSaved';
import { localSttChannels } from './channels/localStt';
import { localInferenceChannels } from './channels/localInference';
import { physicalRecordingChannels, quickCaptureChannels } from './channels/physicalRecording';
import { plaudChannels } from './channels/plaud';
import { mcpAppsChannels } from './channels/mcpApps';
import { versionChannels } from './channels/version';
import { cloudChannels } from './channels/cloud';
import { cloudContinuityChannels } from './channels/cloudContinuity';
import { inboundTriggersChannels } from './channels/inboundTriggers';
import { systemImprovementChannels } from './channels/systemImprovement';
import { codexChannels } from './channels/codex';
import { subscriptionChannels } from './channels/subscription';
import { identityChannels } from './channels/identity';

import { openRouterChannels } from './channels/openRouter';
import { heroChoiceChannels } from './channels/heroChoice';
import { dailySparkChannels } from './channels/dailySpark';
import { communityEventsChannels } from './channels/communityEvents';
import { communityVideoRecsChannels } from './channels/communityVideoRecs';
import { focusChannels } from './channels/focus';
import { foldersChannels } from './channels/folders';
import { contributionChannels } from './channels/contribution';
import { appBridgeChannels } from './channels/appBridge';
import { officeSidecarChannels } from './channels/officeSidecar';
import { spaceMaintenanceChannels } from './channels/spaceMaintenance';
import { githubChannels } from './channels/github';
import { diagnosticsChannels } from './channels/diagnostics';
import { htmlPreviewTrustChannels } from './channels/htmlPreviewTrust';
import { achievementsChannels } from './channels/achievements';
import { salesforceChannels } from './channels/salesforce';
import type { MeetingTriggerDetectedPayload } from './channels/meetingTrigger';

export type { MeetingTriggerDetectedPayload };

export const CloudErrorCategorySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('network'),
    subkind: z.enum(['fetch_failed', 'dns', 'tcp', 'abort', 'timeout']),
  }),
  z.object({
    kind: z.literal('auth'),
    subkind: z.enum(['unauthorized', 'forbidden', 'token_expired']),
  }),
  z.object({
    kind: z.literal('cloud_down'),
    subkind: z.enum(['http_5xx', 'reported_unhealthy', 'deprovisioning']),
  }),
  z.object({
    kind: z.literal('unknown'),
    rawMessage: z.string(),
  }),
]);

export const CloudStatusChangedSchema = z.object({
  lastKnownStatus: z.string().optional(),
  errorCategory: CloudErrorCategorySchema.optional(),
  lastWriter: z.string().optional(),
  timestamp: z.number(),
});

export type CloudStatusChangedPayload = z.infer<typeof CloudStatusChangedSchema>;
// =============================================================================
// Contract Registry
// =============================================================================

/**
 * All IPC invoke channels grouped by domain.
 * This is the authoritative registry used by the code generator.
 */
export const ipcContract = {
  library: libraryChannels,
  settings: settingsChannels,
  app: appChannels,
  export: exportChannels,
  migration: migrationChannels,
  voice: voiceChannels,
  agent: agentChannels,
  agentError: agentErrorChannels,
  permissions: permissionsChannels,
  sessions: sessionsChannels,
  inbox: inboxChannels,
  automations: automationsChannels,
  demo: demoChannels,
  dashboard: dashboardChannels,
  search: searchChannels,
  systemHealth: systemHealthChannels,
  misc: miscChannels,
  auth: authChannels,
  memory: memoryChannels,
  scratchpad: scratchpadChannels,
  googleWorkspace: googleWorkspaceChannels,
  github: githubChannels,
  slack: slackChannels,
  hubspot: hubspotChannels,
  zendesk: zendeskChannels,
  discourse: discourseChannels,
  microsoft: microsoftChannels,
  usage: usageChannels,
  community: communityChannels,
  safety: safetyChannels,
  safetyPrompt: safetyPromptChannels,
  safetyActivityLog: safetyActivityLogChannels,
  skills: skillsChannels,
  skillHistory: skillHistoryChannels,
  operators: operatorsChannels,
  feedback: feedbackChannels,
  plugins: pluginsChannels,
  bugReport: bugReportChannels,
  fileConversation: fileConversationChannels,
  userTasks: userTasksChannels,
  todoist: todoistChannels,
  useCaseLibrary: useCaseLibraryChannels,
  calendar: calendarChannels,
  errorRecovery: errorRecoveryChannels,
  meetingBot: meetingBotChannels,
  timeSaved: timeSavedChannels,
  localStt: localSttChannels,
  localInference: localInferenceChannels,
  physicalRecording: physicalRecordingChannels,
  quickCapture: quickCaptureChannels,
  plaud: plaudChannels,
  mcpApps: mcpAppsChannels,
  version: versionChannels,
  cloud: cloudChannels,
  cloudContinuity: cloudContinuityChannels,
  inboundTriggers: inboundTriggersChannels,
  systemImprovement: systemImprovementChannels,
  codex: codexChannels,
  subscription: subscriptionChannels,
  identity: identityChannels,
  openRouter: openRouterChannels,
  heroChoice: heroChoiceChannels,
  dailySpark: dailySparkChannels,
  communityEvents: communityEventsChannels,
  communityVideoRecs: communityVideoRecsChannels,
  focus: focusChannels,
  folders: foldersChannels,
  contribution: contributionChannels,
  appBridge: appBridgeChannels,
  officeSidecar: officeSidecarChannels,
  spaceMaintenance: spaceMaintenanceChannels,
  diagnostics: diagnosticsChannels,
  htmlPreviewTrust: htmlPreviewTrustChannels,
  achievements: achievementsChannels,
  salesforce: salesforceChannels,
} as const;

/**
 * Flat map of all channels for quick lookup
 */
export const allChannels = {
  ...libraryChannels,
  ...settingsChannels,
  ...appChannels,
  ...exportChannels,
  ...migrationChannels,
  ...voiceChannels,
  ...agentChannels,
  ...agentErrorChannels,
  ...permissionsChannels,
  ...sessionsChannels,
  ...inboxChannels,
  ...automationsChannels,
  ...demoChannels,
  ...dashboardChannels,
  ...searchChannels,
  ...systemHealthChannels,
  ...miscChannels,
  ...authChannels,
  ...memoryChannels,
  ...scratchpadChannels,
  ...googleWorkspaceChannels,
  ...githubChannels,
  ...slackChannels,
  ...hubspotChannels,
  ...zendeskChannels,
  ...discourseChannels,
  ...microsoftChannels,
  ...usageChannels,
  ...communityChannels,
  ...safetyChannels,
  ...safetyPromptChannels,
  ...safetyActivityLogChannels,
  ...skillsChannels,
  ...skillHistoryChannels,
  ...operatorsChannels,
  ...feedbackChannels,
  ...pluginsChannels,
  ...bugReportChannels,
  ...fileConversationChannels,
  ...userTasksChannels,
  ...todoistChannels,
  ...useCaseLibraryChannels,
  ...calendarChannels,
  ...errorRecoveryChannels,
  ...meetingBotChannels,
  ...timeSavedChannels,
  ...localSttChannels,
  ...localInferenceChannels,
  ...physicalRecordingChannels,
  ...quickCaptureChannels,
  ...plaudChannels,
  ...mcpAppsChannels,
  ...versionChannels,
  ...cloudChannels,
  ...cloudContinuityChannels,
  ...inboundTriggersChannels,
  ...systemImprovementChannels,
  ...codexChannels,
  ...subscriptionChannels,
  ...identityChannels,
  ...openRouterChannels,
  ...heroChoiceChannels,
  ...dailySparkChannels,
  ...communityEventsChannels,
  ...communityVideoRecsChannels,
  ...focusChannels,
  ...foldersChannels,
  ...contributionChannels,
  ...appBridgeChannels,
  ...officeSidecarChannels,
  ...spaceMaintenanceChannels,
  ...diagnosticsChannels,
  ...htmlPreviewTrustChannels,
  ...achievementsChannels,
  ...salesforceChannels,
} as const;

// =============================================================================
// Type Utilities
// =============================================================================

/** Extract the request type for a channel (post-parse, used by handlers). */
export type IpcRequestOf<T extends keyof typeof allChannels> =
  z.infer<(typeof allChannels)[T]['request']>;

/** Extract the caller-facing request type (pre-parse, fields with .default() are optional). */
export type IpcInputOf<T extends keyof typeof allChannels> =
  z.input<(typeof allChannels)[T]['request']>;

/** Extract the response type for a channel. */
export type IpcResponseOf<T extends keyof typeof allChannels> =
  z.infer<(typeof allChannels)[T]['response']>;

/** All channel names */
export type IpcChannelName = keyof typeof allChannels;

/** Channel names by domain */
export type WorkspaceChannelName = keyof typeof libraryChannels;
export type SettingsChannelName = keyof typeof settingsChannels;
export type AppChannelName = keyof typeof appChannels;
export type ExportChannelName = keyof typeof exportChannels;
export type VoiceChannelName = keyof typeof voiceChannels;
export type AgentChannelName = keyof typeof agentChannels;
export type AgentErrorChannelName = keyof typeof agentErrorChannels;
export type PermissionsChannelName = keyof typeof permissionsChannels;
export type SessionsChannelName = keyof typeof sessionsChannels;
export type InboxChannelName = keyof typeof inboxChannels;
/** @deprecated Use InboxChannelName */
export type TasksChannelName = InboxChannelName;
export type AutomationsChannelName = keyof typeof automationsChannels;
export type DemoChannelName = keyof typeof demoChannels;
export type DashboardChannelName = keyof typeof dashboardChannels;
export type SearchChannelName = keyof typeof searchChannels;
export type SystemHealthChannelName = keyof typeof systemHealthChannels;
export type MiscChannelName = keyof typeof miscChannels;
export type MemoryChannelName = keyof typeof memoryChannels;
export type ScratchpadChannelName = keyof typeof scratchpadChannels;
export type GoogleWorkspaceChannelName = keyof typeof googleWorkspaceChannels;
export type GitHubChannelName = keyof typeof githubChannels;
export type SlackChannelName = keyof typeof slackChannels;
export type HubSpotChannelName = keyof typeof hubspotChannels;
export type ZendeskChannelName = keyof typeof zendeskChannels;
export type DiscourseChannelName = keyof typeof discourseChannels;
export type MicrosoftChannelName = keyof typeof microsoftChannels;
export type UsageChannelName = keyof typeof usageChannels;
export type SafetyPromptChannelName = keyof typeof safetyPromptChannels;
export type SafetyActivityLogChannelName = keyof typeof safetyActivityLogChannels;
export type SkillsChannelName = keyof typeof skillsChannels;
export type OperatorsChannelName = keyof typeof operatorsChannels;
export type PluginChannelName = keyof typeof pluginsChannels;
export type FileConversationChannelName = keyof typeof fileConversationChannels;
export type UserTasksChannelName = keyof typeof userTasksChannels;
export type TodoistChannelName = keyof typeof todoistChannels;
export type UseCaseLibraryChannelName = keyof typeof useCaseLibraryChannels;
export type CalendarChannelName = keyof typeof calendarChannels;
export type ErrorRecoveryChannelName = keyof typeof errorRecoveryChannels;
export type MeetingBotChannelName = keyof typeof meetingBotChannels;
export type TimeSavedChannelName = keyof typeof timeSavedChannels;
export type LocalSttChannelName = keyof typeof localSttChannels;
export type LocalInferenceChannelName = keyof typeof localInferenceChannels;
export type PhysicalRecordingChannelName = keyof typeof physicalRecordingChannels;
export type QuickCaptureChannelName = keyof typeof quickCaptureChannels;
export type PlaudChannelName = keyof typeof plaudChannels;
export type McpAppsChannelName = keyof typeof mcpAppsChannels;
export type VersionChannelName = keyof typeof versionChannels;
export type CloudChannelName = keyof typeof cloudChannels;
export type CloudContinuityChannelName = keyof typeof cloudContinuityChannels;
export type InboundTriggersChannelName = keyof typeof inboundTriggersChannels;
export type SystemImprovementChannelName = keyof typeof systemImprovementChannels;
export type CodexChannelName = keyof typeof codexChannels;
export type SubscriptionChannelName = keyof typeof subscriptionChannels;
export type OpenRouterChannelName = keyof typeof openRouterChannels;
export type HeroChoiceChannelName = keyof typeof heroChoiceChannels;
export type DailySparkChannelName = keyof typeof dailySparkChannels;
export type CommunityEventsChannelName = keyof typeof communityEventsChannels;
export type CommunityVideoRecsChannelName = keyof typeof communityVideoRecsChannels;
export type FocusChannelName = keyof typeof focusChannels;
export type FoldersChannelName = keyof typeof foldersChannels;
export type ContributionChannelName = keyof typeof contributionChannels;
export type AppBridgeChannelName = keyof typeof appBridgeChannels;
export type OfficeSidecarChannelName = keyof typeof officeSidecarChannels;
export type SpaceMaintenanceChannelName = keyof typeof spaceMaintenanceChannels;
export type DiagnosticsChannelName = keyof typeof diagnosticsChannels;
export type HtmlPreviewTrustChannelName = keyof typeof htmlPreviewTrustChannels;
export type AchievementsChannelName = keyof typeof achievementsChannels;
export type SalesforceChannelName = keyof typeof salesforceChannels;
