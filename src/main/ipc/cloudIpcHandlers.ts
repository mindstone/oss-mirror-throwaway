/**
 * Cloud-safe IPC handler registrations.
 *
 * Only handlers that work without desktop-specific Electron APIs.
 * Desktop-only handlers (OAuth, voice, meeting bot, etc.) are excluded.
 *
 * The desktop app continues to use ./index.ts which exports ALL handlers.
 * The cloud service imports from this barrel to avoid loading 24+ desktop-only
 * handlers and their transitive Electron dependencies.
 */

export { registerLibraryHandlers, type LibraryHandlerDeps } from './libraryHandlers';
export { registerSettingsHandlers, type SettingsHandlerDeps } from './settingsHandlers';
export { registerSessionsHandlers, type SessionsHandlerDeps } from './sessionsHandlers';
export { registerInboxHandlers, type InboxHandlerDeps } from './inboxHandlers';
export { registerAutomationsHandlers, type AutomationsHandlerDeps } from './automationsHandlers';
export { registerDashboardHandlers, type DashboardHandlerDeps } from './dashboardHandlers';
export { registerUserTasksHandlers, type UserTasksHandlerDeps } from './userTasksHandlers';
export { registerScratchpadHandlers, type ScratchpadHandlerDeps } from './scratchpadHandlers';
export { registerSkillsHandlers } from './skillsHandlers';
export { registerUseCaseLibraryHandlers } from './useCaseLibraryHandlers';
export { registerFileConversationHandlers } from './fileConversationHandlers';
export { registerSafetyHandlers, type SafetyHandlerDeps } from './safetyHandlers';
export { registerSafetyActivityLogHandlers } from './safetyActivityLogHandlers';
export { registerSafetyPromptHandlers } from './safetyPromptHandlers';
export { registerSearchHandlers } from './searchHandlers';
export { registerFeedbackHandlers } from './feedbackHandlers';
export { registerMemoryHandlers, type MemoryHandlerDeps } from './memoryHandlers';
export { registerCommunityHandlers, type CommunityHandlerDeps } from './communityHandlers';
export { registerMiscHandlers, type MiscHandlerDeps } from './miscHandlers';
export { registerCalendarHandlers, type CalendarHandlerDeps } from './calendarHandlers';
export { registerErrorRecoveryHandlers, type ErrorRecoveryHandlerDeps } from './errorRecoveryHandlers';
export { registerUsageHandlers, type UsageHandlerDeps } from './usageHandlers';
export { registerDiagnosticsHandlers } from './diagnosticsHandlers';
