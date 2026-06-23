/**
 * Health Check Functions
 *
 * Re-exports all check functions from category modules.
 */

// Filesystem checks
export {
  checkUserDataWritable,
  checkWorkspaceAccessible,
  checkDiskSpace,
  checkSymlinkHealth,
  checkTempDirectoryHealth,
  WORKSPACE_ACCESS_CHECK_TIMEOUT_MS,
  WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS,
  computeHealthWorkspaceWorstCaseMs,
} from './filesystem';

// MCP checks
export {
  checkMcpConfigValid,
  checkSuperMcpHealth,
  checkBundledServers,
  checkMcpSkippedServers,
} from './mcp';

// Network checks
export {
  checkAnthropicReachable,
} from './network';

// System checks
export {
  checkNodeBundleHealth,
  checkMsvcRuntimeHealth,
  checkEnvOverrides,
  checkPortAvailable,
  checkGitBashHealth,
  checkPowerShellHealth,
} from './system';

// Sync checks
export {
  checkRebelSystemPresent,
  checkRebelSystemSyncStatus,
} from './sync';

// Permission checks
export {
  checkMicrophonePermission,
  checkScreenRecordingPermission,
  checkWorkspacePathIssues,
  checkFullDiskAccess,
} from './permissions';

// API key checks
export {
  checkClaudeApiKeyValid,
  checkVoiceApiKeyValid,
} from './apiKeys';

// Prompt checks
export {
  checkSystemPromptRenders,
  checkSafetyPromptExists,
  checkMemoryPromptExists,
  checkSystemPromptCoherence,
} from './prompt';

// Skills checks
export { checkSkillsConvention } from './skills';

// Semantic search checks
export {
  checkEmbeddingServiceReady,
  checkSemanticIndexHealth,
} from './semanticSearch';

// Space checks
export { checkSpaceReadmeSizes, checkSpaceSharingConfig, checkBrokenSpaceFrontmatter } from './spaces';

// Calendar checks
export { checkCalendarCacheHealth } from './calendar';

// Tool index checks
export { checkToolIndexHealth } from './toolIndex';

// Enhancement checks
export { checkEnhancementHealth } from './enhancement';

// Auto-update checks
export { checkAutoUpdateHealth } from './updates';

// Inbox checks
export { checkInboxHealth } from './inbox';

// Conversation index checks
export { checkConversationIndexHealth } from './conversationIndex';

// Profile checks
export { checkUserProfileComplete } from './profile';

// Conflicting copies checks
export { checkConflictingCopies } from './conflictingCopies';

// Cloud service checks
export { checkCloudServiceHealth } from './cloud';

// Prompt file checks
export { checkPromptFilesExist, checkPromptFilesRender } from './promptFiles';

// Degraded-state surfacing (Stage 0 stubs)
// Core-tier checks (apiCooldown, toolAdvisory) are exposed via the parent
// `./health` barrel's `export * from '@core/services/health'`, so we don't
// re-export them here to avoid duplicate re-export topology.
export { checkOauthRefreshHealth } from './oauthRefresh';
export { checkMcpRuntimeHealth } from './mcpRuntime';
