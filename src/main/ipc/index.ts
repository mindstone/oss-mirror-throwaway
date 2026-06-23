/**
 * Barrel of IPC handler registrations. Use this to locate who owns a channel
 * before changing schemas, the preload bridge, or transport policy.
 *
 * @see docs/project/ARCHITECTURE_IPC.md — contract-first IPC model
 * @see src/shared/ipc/contracts.ts — canonical channel/schema registry
 * @see src/shared/cloudChannelPolicies.ts — desktop-to-cloud routing map
 */

// Stage 1 domains
export { registerLibraryHandlers, type LibraryHandlerDeps } from './libraryHandlers';
export { registerSettingsHandlers, type SettingsHandlerDeps } from './settingsHandlers';

// Stage 2 domains
export { registerAppHandlers, registerEmergencyHandlers, type AppHandlerDeps } from './appHandlers';
export { registerExportHandlers, type ExportHandlerDeps } from './exportHandlers';
export { registerMigrationHandlers, type MigrationHandlerDeps } from './migrationHandlers';
export { registerVoiceHandlers, type VoiceHandlerDeps } from './voiceHandlers';
export { registerAgentHandlers, type AgentHandlerDeps } from './agentHandlers';
export { registerAgentErrorHandlers, type AgentErrorHandlerDeps } from './agentErrorHandlers';
export { registerPermissionsHandlers, type PermissionsHandlerDeps } from './permissionsHandlers';
export { registerSessionsHandlers, type SessionsHandlerDeps } from './sessionsHandlers';
export { registerInboxHandlers, registerTasksHandlers, type InboxHandlerDeps, type TasksHandlerDeps } from './inboxHandlers';
export { registerAutomationsHandlers, type AutomationsHandlerDeps } from './automationsHandlers';
export { registerDemoHandlers, type DemoHandlerDeps } from './demoHandlers';
export { registerDashboardHandlers, type DashboardHandlerDeps } from './dashboardHandlers';
export { bumpAtlasNeighborhoodGeneration, registerSearchHandlers } from './searchHandlers';
export { registerSystemHandlers, type SystemHandlerDeps } from './systemHandlers';
export { registerMiscHandlers, type MiscHandlerDeps } from './miscHandlers';
export { registerMemoryHandlers, type MemoryHandlerDeps } from './memoryHandlers';
export { registerScratchpadHandlers, type ScratchpadHandlerDeps } from './scratchpadHandlers';
export { registerGoogleWorkspaceHandlers, cleanupLegacyGoogleWorkspaceEntry } from './googleWorkspaceHandlers';
export { registerSlackHandlers } from './slackHandlers';
export { registerHubSpotHandlers } from './hubspotHandlers';
export { registerZendeskHandlers } from './zendeskHandlers';
export { registerDiscourseHandlers } from './discourseHandlers';
export { registerGitHubHandlers } from './githubHandlers';
export { registerCodexHandlers } from './codexHandlers';
export { registerSubscriptionHandlers } from './subscriptionHandlers';
export { registerIdentityHandlers } from './identityHandlers';

export { registerOpenRouterHandlers } from './openRouterHandlers';
export { registerSalesforceHandlers } from './salesforceHandlers';
export { registerMicrosoftHandlers, cleanupLegacyMicrosoftEntries } from './microsoftHandlers';
export { registerUsageHandlers, type UsageHandlerDeps } from './usageHandlers';
export { registerCommunityHandlers, type CommunityHandlerDeps } from './communityHandlers';
export { registerSafetyHandlers, type SafetyHandlerDeps } from './safetyHandlers';
export { registerSafetyPromptHandlers } from './safetyPromptHandlers';
export { registerSafetyActivityLogHandlers } from './safetyActivityLogHandlers';
export { registerSkillsHandlers } from './skillsHandlers';
export { registerOperatorsHandlers } from './operatorsHandlers';
export { registerFeedbackHandlers } from './feedbackHandlers';
export { registerPluginHandlers } from './pluginHandlers';
export { registerBugReportHandlers } from './bugReportHandlers';
export { registerFileConversationHandlers } from './fileConversationHandlers';
export { registerUserTasksHandlers, type UserTasksHandlerDeps } from './userTasksHandlers';
export { registerTodoistHandlers } from './todoistHandlers';
export { registerMeetingBotHandlers, type MeetingBotHandlerDeps } from './meetingBotHandlers';
export { registerUseCaseLibraryHandlers } from './useCaseLibraryHandlers';
export { registerCalendarHandlers, type CalendarHandlerDeps } from './calendarHandlers';
export { registerErrorRecoveryHandlers, type ErrorRecoveryHandlerDeps } from './errorRecoveryHandlers';
export { registerLocalSttHandlers } from './localSttHandlers';
export { registerLocalInferenceHandlers } from './localInferenceHandlers';
export { registerPhysicalRecordingHandlers } from './physicalRecordingHandlers';
export { registerQuickCaptureHandlers, registerQuickCaptureQuitHandler } from './quickCaptureHandlers';
export { registerPlaudHandlers } from './plaudHandlers';
export { registerMcpAppsHandlers } from './mcpAppsHandlers';
export { registerVersionHandlers } from './versionHandlers';
export { registerCloudHandlers, type CloudHandlerDeps } from './cloudHandlers';
export { registerInboundTriggerHandlers, type InboundTriggerHandlerDeps } from './inboundTriggerHandlers';
export { registerSystemImprovementHandlers } from './systemImprovementHandlers';
export { registerHeroChoiceHandlers } from './heroChoiceHandlers';
export { registerDailySparkHandlers } from './dailySparkHandlers';
export { registerCommunityEventsHandlers } from './communityEventsHandlers';
export { registerCommunityVideoRecsHandlers, bootstrapVideoRecommendations } from './communityVideoRecsHandlers';
export { registerFocusHandlers } from './focusHandlers';
export { registerFoldersHandlers } from './foldersHandlers';
export { registerContributionHandlers } from './contributionHandlers';
export { registerAppBridgeHandlers, type AppBridgeHandlersDeps } from './appBridgeHandlers';
export { registerOfficeSidecarHandlers, type OfficeSidecarHandlersDeps } from './officeSidecarHandlers';
export { registerSpaceMaintenanceHandlers, type SpaceMaintenanceHandlerDeps } from './spaceMaintenanceHandlers';
export { registerDiagnosticsHandlers } from './diagnosticsHandlers';
export { registerHtmlPreviewTrustHandlers } from './htmlPreviewTrustHandlers';
