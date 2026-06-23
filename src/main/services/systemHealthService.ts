/**
 * System Health Service
 *
 * Provides comprehensive system health checks for troubleshooting and diagnostics.
 * Checks workspace, rebel-system, MCP, API keys, voice, permissions, and more.
 *
 * Check functions are organized in ./health/checks/ by category.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { getDataPath, getAppVersion, isPackaged } from '@core/utils/dataPaths';
import { getAppSystemSettingsVersion } from './systemSettingsSync';
import {
  superMcpHttpManager,
  getDefaultSuperMcpPort as getDefaultSuperMcpPortImpl,
  startSuperMcpWithRetries,
  type SuperMcpStartResult,
} from './superMcpHttpManager';
import { resolveMcpConfigPath } from './mcpService';

import { setHealthContext, setFeatureGatesContext, setHealthContextUpdater, captureMainException, type HealthContextSummary } from '../sentry';
import { getSettings } from '@core/services/settingsStore';
import { getBuildChannel } from '@main/utils/buildChannel';
import { formatVersionWithChannel } from '@shared/utils/versionDisplay';

// Import types and utilities from health module
import {
  safeCheck,
  type CheckResult,
  type EnvironmentSummary,
  type Recommendation,
  type SystemHealthReport,
  type HealthCheckTier,
  type PreflightIssue,
  type PreflightIssueCategory,
  type PreflightIssueSeverity,
  type PreflightResult,
} from './health';
import { getAuthHealthCheck } from './health/authHealthCheckRegistry';

// Import all check functions from health module
import {
  // Filesystem
  checkUserDataWritable,
  checkWorkspaceAccessible,
  WORKSPACE_ACCESS_CHECK_TIMEOUT_MS,
  checkDiskSpace,
  checkSymlinkHealth,
  checkTempDirectoryHealth,
  // MCP
  checkMcpConfigValid,
  checkSuperMcpHealth,
  checkBundledServers,
  checkMcpSkippedServers,
  // Network
  checkAnthropicReachable,
  // System
  checkNodeBundleHealth,
  checkMsvcRuntimeHealth,
  checkEnvOverrides,
  checkPortAvailable,
  checkGitBashHealth,
  checkPowerShellHealth,
  // Sync
  checkRebelSystemPresent,
  checkRebelSystemSyncStatus,
  // Permissions
  checkMicrophonePermission,
  checkScreenRecordingPermission,
  checkWorkspacePathIssues,
  checkFullDiskAccess,
  // API Keys
  checkClaudeApiKeyValid,
  checkVoiceApiKeyValid,
  // Prompt
  checkSystemPromptRenders,
  checkSafetyPromptExists,
  checkMemoryPromptExists,
  checkSystemPromptCoherence,
  // Skills
  checkSkillsConvention,
  // Semantic search
  checkEmbeddingServiceReady,
  checkSemanticIndexHealth,
  // Spaces
  checkSpaceReadmeSizes,
  checkSpaceSharingConfig,
  checkBrokenSpaceFrontmatter,
  // Calendar
  checkCalendarCacheHealth,
  // Tool index
  checkToolIndexHealth,
  // Enhancement
  checkEnhancementHealth,
  // Auto-update
  checkAutoUpdateHealth,
  // Inbox
  checkInboxHealth,
  // Conversation index
  checkConversationIndexHealth,
  // Profile
  checkUserProfileComplete,
  // Conflicting copies
  checkConflictingCopies,
  // Cloud service
  checkCloudServiceHealth,
  // Prompt files
  checkPromptFilesExist,
  checkPromptFilesRender,
  // Degraded-state surfacing (Stage 0 stubs)
  checkApiCooldownHealth,
  checkOauthRefreshHealth,
  checkMcpRuntimeHealth,
  checkToolAdvisoryHealth,
} from './health';

import { SYSTEM_PROMPT_COHERENCE_TIMEOUT_MS } from './health/checks/prompt';
import { fireAndForget } from '@shared/utils/fireAndForget';
import {
  extractMsvcRuntimeDetailsForSentry,
  isSafeCheckId,
  SAFE_CHECK_DETAIL_FIELDS as TYPED_SAFE_CHECK_DETAIL_FIELDS,
  sanitizeSafeCheckDetailValueForSentry,
  validateSafeCheckDetailField,
} from '@core/services/health/safeCheckDetails';

const log = createScopedLogger({ service: 'systemHealth' });

// =============================================================================
// Safe Health Check Detail Extraction (Privacy)
// =============================================================================

/**
 * Per-check allowlist of fields safe to include in Sentry context.
 * Only checks and fields explicitly listed here are included.
 * Unknown checks or unlisted fields are excluded entirely.
 *
 * CRITICAL: Do NOT add checks that expose PII (auth, profile, apiKeys, spaces, etc.)
 */
export const SAFE_CHECK_DETAIL_FIELDS = TYPED_SAFE_CHECK_DETAIL_FIELDS;

/** Maximum total serialized size for safe check details (4KB) */
const MAX_SAFE_DETAILS_SIZE = 4096;

/**
 * Extract only privacy-safe fields from a health check's details.
 * Returns undefined if the check is unknown or has no safe fields.
 */
export function extractSafeCheckDetails(
  checkId: string,
  details: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isSafeCheckId(checkId)) return undefined; // Unknown check — exclude entirely

  const allowedFields = SAFE_CHECK_DETAIL_FIELDS[checkId];

  const safe: Record<string, unknown> = {};
  let hasFields = false;
  for (const field of allowedFields) {
    const value = details[field];
    if (value === undefined) continue;

    const validation = validateSafeCheckDetailField(checkId, field, value);
    if (!validation.ok) {
      log.warn(
        { checkId, field, reason: validation.reason },
        'Dropped unsafe health check detail field from Sentry context',
      );
      continue;
    }

    safe[field] = sanitizeSafeCheckDetailValueForSentry(checkId, field, validation.value);
    hasFields = true;
  }
  return hasFields ? safe : undefined;
}

/**
 * Build safe check details from all failing/warning checks.
 * Caps total serialized size to prevent Sentry context bloat.
 */
function buildSafeCheckDetails(
  checks: CheckResult[],
): Record<string, Record<string, unknown>> | undefined {
  const result: Record<string, Record<string, unknown>> = {};

  for (const check of checks) {
    if ((check.status === 'fail' || check.status === 'warn') && check.details) {
      const safe = extractSafeCheckDetails(check.id, check.details);
      if (safe) {
        result[check.id] = safe;
      }
    }
  }

  if (Object.keys(result).length === 0) return undefined;

  // Cap total serialized size to prevent bloat
  try {
    const serialized = JSON.stringify(result);
    if (serialized.length > MAX_SAFE_DETAILS_SIZE) {
      log.debug(
        { size: serialized.length, limit: MAX_SAFE_DETAILS_SIZE },
        'Safe check details exceed size limit, omitting',
      );
      return undefined;
    }
  } catch {
    return undefined;
  }

  return result;
}

// =============================================================================
// Port Configuration by Build Channel
// =============================================================================
// Different app versions (dev, beta, production) use different default port ranges
// to prevent conflicts when running multiple versions simultaneously.
// - Production: 3000-3024
// - Beta: 3100-3124
// - Dev (npm run dev): 3200-3224
// =============================================================================

/**
 * Get the default Super-MCP HTTP port based on the build channel.
 * This prevents port conflicts when running multiple app versions simultaneously.
 *
 * @deprecated Canonical implementation moved to superMcpHttpManager.ts.
 * This re-export is kept for backward compatibility with existing callers.
 */
export function getDefaultSuperMcpPort(): number {
  return getDefaultSuperMcpPortImpl();
}

// Re-export types for external consumers
export type {
  CheckResult,
  EnvironmentSummary,
  Recommendation,
  SystemHealthReport,
  HealthCheckTier,
  PreflightIssue,
  PreflightIssueCategory,
  PreflightIssueSeverity,
  PreflightResult,
};
export type { CheckStatus } from './health';

// =============================================================================
// Main Health Check Function
// =============================================================================

export async function runSystemHealthCheck(
  settings: AppSettings,
  options?: { tier?: HealthCheckTier }
): Promise<SystemHealthReport> {
  const tier = options?.tier ?? 'full';
  const startTime = Date.now();

  log.info({ tier }, 'Starting system health check');

  // Run all checks in parallel, each wrapped to never throw
  const [
    userDataWritable,
    workspaceAccessible,
    rebelSystemPresent,
    systemPromptRenders,
    systemPromptCoherence,
    safetyPromptExists,
    memoryPromptExists,
    nodeBundleHealth,
    msvcRuntimeHealth,
    mcpConfigValid,
    bundledServers,
    symlinkHealth,
    diskSpace,
    portAvailable,
    anthropicReachable,
    rebelSystemSyncStatus,
    tempDirectoryHealth,
    gitBashHealth,
    powerShellHealth,
    skillsConvention,
    embeddingServiceReady,
    semanticIndexHealth,
    spaceReadmeSizes,
    spaceSharingConfig,
    brokenSpaceFrontmatter,
    calendarCacheHealth,
    // New checks - Phase 1 & 2
    toolIndexHealth,
    enhancementHealth,
    mcpSkippedServers,
    authHealth,
    autoUpdateHealth,
    // Phase 3
    inboxHealth,
    conversationIndexHealth,
    // Phase 4
    userProfileComplete,
    // Phase 5
    conflictingCopies,
    // Phase 6 - Meeting bot
    fullDiskAccess,
    // Cloud service
    cloudServiceHealth,
    // Prompt files
    promptFilesExist,
    promptFilesRender,
    // Degraded-state surfacing (Stage 0 stubs)
    apiCooldownHealth,
    oauthRefreshHealth,
    mcpRuntimeHealth,
    toolAdvisoryHealth,
  ] = await Promise.all([
    safeCheck(checkUserDataWritable, 'userDataWritable', 'User Data Directory'),
    safeCheck((signal) => checkWorkspaceAccessible(settings, signal), 'workspaceAccessible', 'Workspace Access', { timeoutMs: WORKSPACE_ACCESS_CHECK_TIMEOUT_MS }),
    safeCheck(checkRebelSystemPresent, 'rebelSystemPresent', 'Rebel System'),
    tier === 'full' 
      ? safeCheck(() => checkSystemPromptRenders(settings), 'systemPromptRenders', 'System Prompt')
      : Promise.resolve({ id: 'systemPromptRenders', name: 'System Prompt', status: 'skip' as const, message: 'Skipped in quick mode' }),
    tier === 'full'
      ? safeCheck((signal) => checkSystemPromptCoherence(settings, signal), 'systemPromptCoherence', 'System Prompt Coherence', { timeoutMs: SYSTEM_PROMPT_COHERENCE_TIMEOUT_MS })
      : Promise.resolve({ id: 'systemPromptCoherence', name: 'System Prompt Coherence', status: 'skip' as const, message: 'Skipped in quick mode' }),
    safeCheck(() => checkSafetyPromptExists(settings), 'safetyPromptExists', 'Safety Guard Prompt'),
    safeCheck(() => checkMemoryPromptExists(settings), 'memoryPromptExists', 'Memory Update Prompt'),
    safeCheck(checkNodeBundleHealth, 'nodeBundleHealth', 'Node Bundle'),
    safeCheck(checkMsvcRuntimeHealth, 'msvcRuntimeHealth', 'MSVC Runtime'),
    safeCheck(() => checkMcpConfigValid(settings), 'mcpConfigValid', 'MCP Configuration'),
    safeCheck(() => checkBundledServers(settings), 'bundledServers', 'Bundled MCP Servers'),
    safeCheck(() => checkSymlinkHealth(settings), 'symlinkHealth', 'Symlink Health'),
    safeCheck(checkDiskSpace, 'diskSpace', 'Disk Space'),
    safeCheck(checkPortAvailable, 'portAvailable', 'Port Availability'),
    tier === 'full'
      ? checkAnthropicReachable()
      : Promise.resolve({ id: 'anthropicReachable', name: 'Anthropic API', status: 'skip' as const, message: 'Skipped in quick mode' }),
    safeCheck(checkRebelSystemSyncStatus, 'rebelSystemSyncStatus', 'System Files Sync'),
    safeCheck(checkTempDirectoryHealth, 'tempDirectoryHealth', 'Temp Directory'),
    safeCheck(checkGitBashHealth, 'gitBashHealth', 'Git Bash'),
    safeCheck(checkPowerShellHealth, 'powerShellHealth', 'PowerShell'),
    tier === 'full'
      ? safeCheck(checkSkillsConvention, 'skillsConvention', 'Skills Convention')
      : Promise.resolve({ id: 'skillsConvention', name: 'Skills Convention', status: 'skip' as const, message: 'Skipped in quick mode' }),
    safeCheck(checkEmbeddingServiceReady, 'embeddingServiceReady', 'Embedding Service'),
    safeCheck(() => checkSemanticIndexHealth(settings), 'semanticIndexHealth', 'Semantic Index'),
    safeCheck(() => checkSpaceReadmeSizes(settings), 'spaceReadmeSizes', 'Space README Sizes'),
    safeCheck(() => checkSpaceSharingConfig(settings), 'spaceSharingConfig', 'Space Sharing Configuration'),
    safeCheck(() => checkBrokenSpaceFrontmatter(settings), 'brokenSpaceFrontmatter', 'Space Frontmatter'),
    safeCheck(checkCalendarCacheHealth, 'calendarCacheHealth', 'Calendar Cache'),
    // New checks - Phase 1 & 2
    safeCheck(checkToolIndexHealth, 'toolIndexHealth', 'Tool Index'),
    safeCheck(checkEnhancementHealth, 'enhancementHealth', 'Background Enhancement'),
    safeCheck(checkMcpSkippedServers, 'mcpSkippedServers', 'MCP Server Validation'),
    safeCheck(getAuthHealthCheck(), 'authHealth', 'Authentication'),
    safeCheck(checkAutoUpdateHealth, 'autoUpdateHealth', 'Auto-Updates'),
    // Phase 3
    safeCheck(checkInboxHealth, 'inboxHealth', 'Inbox'),
    safeCheck(checkConversationIndexHealth, 'conversationIndexHealth', 'Conversation Index'),
    // Phase 4
    safeCheck(() => checkUserProfileComplete(settings), 'userProfileComplete', 'User Profile'),
    // Phase 5
    safeCheck(() => checkConflictingCopies(settings), 'conflictingCopies', 'Conflicting File Copies'),
    // Phase 6 - Meeting bot
    safeCheck(() => checkFullDiskAccess(settings), 'fullDiskAccess', 'Full Disk Access (Teams URLs)'),
    // Cloud service health (network check, full tier only)
    tier === 'full'
      ? safeCheck(() => checkCloudServiceHealth(settings), 'cloudServiceHealth', 'Cloud Service')
      : Promise.resolve({ id: 'cloudServiceHealth', name: 'Cloud Service', status: 'skip' as const, message: 'Skipped in quick mode' }),
    // Prompt files
    safeCheck(checkPromptFilesExist, 'promptFilesExist', 'Prompt Files'),
    safeCheck(checkPromptFilesRender, 'promptFilesRender', 'Prompt File Rendering'),
    // Degraded-state surfacing (Stage 0 stubs — desktop tier; run in both `quick` and `full`)
    safeCheck(checkApiCooldownHealth, 'apiCooldownHealth', 'API Cooldown'),
    safeCheck(checkOauthRefreshHealth, 'oauthRefreshHealth', 'OAuth Refresh'),
    safeCheck(checkMcpRuntimeHealth, 'mcpRuntimeHealth', 'MCP Runtime'),
    safeCheck(checkToolAdvisoryHealth, 'toolAdvisoryHealth', 'Tool Advisory'),
  ]);

  // Synchronous checks (also wrapped for safety)
  const claudeApiKeyValid = await safeCheck(() => checkClaudeApiKeyValid(settings), 'claudeApiKeyValid', 'Claude API Key');
  const superMcpHealth = await safeCheck(() => checkSuperMcpHealth(settings), 'superMcpHealth', 'Super-MCP Server');
  const microphonePermission = await safeCheck(checkMicrophonePermission, 'microphonePermission', 'Microphone Access');
  const screenRecordingPermission = await safeCheck(checkScreenRecordingPermission, 'screenRecordingPermission', 'Screen Recording (Local Meeting Recording)');
  const workspacePathIssues = await safeCheck(() => checkWorkspacePathIssues(settings), 'workspacePathIssues', 'Workspace Path');
  const envOverrides = await safeCheck(checkEnvOverrides, 'envOverrides', 'Environment Overrides');
  const voiceApiKeyValid = await safeCheck(() => checkVoiceApiKeyValid(settings), 'voiceApiKeyValid', 'Voice API Key');

  const checks = {
    userDataWritable,
    workspaceAccessible,
    rebelSystemPresent,
    systemPromptRenders,
    systemPromptCoherence,
    safetyPromptExists,
    memoryPromptExists,
    claudeApiKeyValid,
    nodeBundleHealth,
    msvcRuntimeHealth,
    mcpConfigValid,
    bundledServers,
    superMcpHealth,
    microphonePermission,
    screenRecordingPermission,
    workspacePathIssues,
    envOverrides,
    symlinkHealth,
    diskSpace,
    portAvailable,
    voiceApiKeyValid,
    anthropicReachable,
    rebelSystemSyncStatus,
    tempDirectoryHealth,
    gitBashHealth,
    powerShellHealth,
    skillsConvention,
    embeddingServiceReady,
    semanticIndexHealth,
    spaceReadmeSizes,
    spaceSharingConfig,
    brokenSpaceFrontmatter,
    calendarCacheHealth,
    // New checks - Phase 1 & 2
    toolIndexHealth,
    enhancementHealth,
    mcpSkippedServers,
    authHealth,
    autoUpdateHealth,
    // Phase 3
    inboxHealth,
    conversationIndexHealth,
    // Phase 4
    userProfileComplete,
    // Phase 5
    conflictingCopies,
    // Phase 6 - Meeting bot
    fullDiskAccess,
    // Cloud service
    cloudServiceHealth,
    // Prompt files
    promptFilesExist,
    promptFilesRender,
    // Degraded-state surfacing
    apiCooldownHealth,
    oauthRefreshHealth,
    mcpRuntimeHealth,
    toolAdvisoryHealth,
  };

  // Determine overall status
  const allChecks = Object.values(checks);
  const hasCritical = allChecks.some(c => 
    c.status === 'fail' && ['userDataWritable', 'workspaceAccessible', 'claudeApiKeyValid'].includes(c.id)
  );
  const hasFail = allChecks.some(c => c.status === 'fail');
  const hasWarn = allChecks.some(c => c.status === 'warn');

  let status: 'healthy' | 'degraded' | 'critical';
  if (hasCritical) {
    status = 'critical';
  } else if (hasFail) {
    status = 'degraded';
  } else if (hasWarn) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  // Build environment summary
  const superMcpState = superMcpHttpManager.getState();
  const userDataPath = getDataPath();
  const logsPath = path.join(userDataPath, 'logs');
  const rebelSystemPath = isPackaged()
    ? path.join(process.resourcesPath, 'rebel-system')
    : path.join(process.cwd(), 'rebel-system');
  
  const environment: EnvironmentSummary = {
    coreDirectory: settings.coreDirectory,
    mcpConfigFile: settings.mcpConfigFile,
    mcpMode: !settings.mcpConfigFile ? 'none' : superMcpState.isRunning ? 'super-mcp' : 'direct',
    superMcpHttpRunning: superMcpState.isRunning,
    superMcpPort: superMcpState.isRunning ? superMcpState.port : null,
    rebelSystemVersion: getAppSystemSettingsVersion(),
    expectedRebelSystemVersion: getAppSystemSettingsVersion(),
    envOverrides: envOverrides.details?.overrides as Record<string, string> ?? {},
    paths: {
      userData: userDataPath,
      logs: logsPath,
      mcpConfig: settings.mcpConfigFile ? resolveMcpConfigPath(settings) : null,
      rebelSystem: rebelSystemPath,
    },
  };

  // Build recommendations
  const recommendations: Recommendation[] = [];

  for (const check of allChecks) {
    if (check.status === 'fail' && check.remediation) {
      recommendations.push({
        priority: ['userDataWritable', 'workspaceAccessible', 'claudeApiKeyValid'].includes(check.id)
          ? 'critical'
          : 'high',
        message: check.message,
        action: check.remediation,
      });
    } else if (check.status === 'warn' && check.remediation) {
      recommendations.push({
        priority: 'medium',
        message: check.message,
        action: check.remediation,
      });
    }
  }

  // Sort recommendations by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const report: SystemHealthReport = {
    timestamp: Date.now(),
    platform: process.platform,
    appVersion: getAppVersion(),
    isPackaged: isPackaged(),
    status,
    checks,
    environment,
    recommendations,
  };

  log.info(
    { 
      status, 
      duration: Date.now() - startTime,
      checksPassed: allChecks.filter(c => c.status === 'pass').length,
      checksWarned: allChecks.filter(c => c.status === 'warn').length,
      checksFailed: allChecks.filter(c => c.status === 'fail').length,
    },
    'System health check completed'
  );

  return report;
}

// =============================================================================
// Sentry Integration
// =============================================================================

export function updateSentryHealthContext(report: SystemHealthReport): void {
  const checks = Object.values(report.checks);
  const failedChecks = checks.filter(c => c.status === 'fail').map(c => c.id);
  const warnChecks = checks.filter(c => c.status === 'warn').map(c => c.id);

  // Extract privacy-safe details from failing/warning checks
  const safeCheckDetails = buildSafeCheckDetails(checks);

  // Extract tool index per-server breakdown through the same typed Sentry chokepoint.
  let toolIndexByServer = report.checks.toolIndexHealth?.details
    ? extractSafeCheckDetails('toolIndexHealth', report.checks.toolIndexHealth.details)?.byServer as Record<string, number> | undefined
    : undefined;
  if (toolIndexByServer && JSON.stringify(toolIndexByServer).length > MAX_SAFE_DETAILS_SIZE) {
    toolIndexByServer = undefined;
  }

  const summary: HealthContextSummary = {
    status: report.status,
    failedChecks,
    warnChecks,
    mcpMode: report.environment.mcpMode,
    superMcpRunning: report.environment.superMcpHttpRunning,
    hasBundledServers: report.checks.bundledServers?.status === 'pass',
    safeCheckDetails,
    toolIndexByServer,
  };

  setHealthContext(summary);

  // Update feature gates Sentry context alongside health
  try {
    const settings = getSettings();
    setFeatureGatesContext({
      meetingBotUnlocked: settings.meetingBotUnlocked,
      managedCloudEnabled: settings.managedCloudEnabled,
      mcpServerEnabled: settings.mcpServerEnabled,
      onboardingCompleted: settings.onboardingCompleted,
      indexingEnabled: settings.indexingEnabled,
      capturedAt: new Date().toISOString(),
    });
  } catch {
    // Non-fatal — settings may not be available yet during early startup
  }

  log.debug({ status: report.status, failedCount: failedChecks.length, warnCount: warnChecks.length }, 'Updated Sentry health context');
}

// =============================================================================
// Export Generation
// =============================================================================

export function generateShareableReport(report: SystemHealthReport): string {
  const lines: string[] = [];

  lines.push('## System Health Report');
  lines.push(`Generated: ${new Date(report.timestamp).toISOString()}`);
  lines.push(`App Version: ${formatVersionWithChannel(report.appVersion, getBuildChannel())}`);
  lines.push(`Platform: ${report.platform} (${process.arch})`);
  lines.push('');
  lines.push(`### Status: ${report.status.toUpperCase()}`);
  lines.push('');

  const failed = Object.values(report.checks).filter(c => c.status === 'fail');
  const warned = Object.values(report.checks).filter(c => c.status === 'warn');
  const passed = Object.values(report.checks).filter(c => c.status === 'pass');

  if (failed.length > 0) {
    lines.push('#### Failed Checks');
    for (const check of failed) {
      lines.push(`- **${check.name}**: ${check.message}`);
    }
    lines.push('');
  }

  if (warned.length > 0) {
    lines.push('#### Warnings');
    for (const check of warned) {
      lines.push(`- **${check.name}**: ${check.message}`);
    }
    lines.push('');
  }

  if (passed.length > 0) {
    lines.push('#### Passed Checks');
    for (const check of passed) {
      lines.push(`- ${check.name}: ${check.message}`);
    }
    lines.push('');
  }

  if (report.recommendations.length > 0) {
    lines.push('### Recommendations');
    for (const rec of report.recommendations) {
      lines.push(`- [${rec.priority}] ${rec.message}`);
      if (rec.action) {
        lines.push(`  - Action: ${rec.action}`);
      }
    }
    lines.push('');
  }

  lines.push('### Environment');
  lines.push(`- Workspace: ${report.environment.coreDirectory ?? 'Not configured'}`);
  lines.push(`- MCP Mode: ${report.environment.mcpMode}`);
  if (report.environment.superMcpHttpRunning) {
    lines.push(`- Super-MCP: Running on port ${report.environment.superMcpPort}`);
  }
  lines.push(`- System Files Version: ${report.environment.rebelSystemVersion}`);

  if (Object.keys(report.environment.envOverrides).length > 0) {
    lines.push('- Environment Overrides:');
    for (const [key, value] of Object.entries(report.environment.envOverrides)) {
      lines.push(`  - ${key}=${value}`);
    }
  }

  lines.push('');
  lines.push('### Important Paths');
  lines.push(`- User Data: ${report.environment.paths.userData}`);
  lines.push(`- Logs: ${report.environment.paths.logs}`);
  lines.push(`- MCP Config: ${report.environment.paths.mcpConfig ?? 'Not configured'}`);
  lines.push(`- Rebel System: ${report.environment.paths.rebelSystem}`);

  return lines.join('\n');
}

// =============================================================================
// Initialization
// =============================================================================

export function initializeHealthContextUpdater(): void {
  // Fire-and-forget: shift Windows on-access AV scans earlier without delaying startup.
  // We schedule this to avoid impacting the synchronous startup path / window creation.
  setTimeout(() => {
    warmupAVSensitiveExecutables('startup');
  }, 0);

  setHealthContextUpdater(async () => {
    try {
      const settings = getSettings();
      const report = await runSystemHealthCheck(settings, { tier: 'quick' });
      updateSentryHealthContext(report);
    } catch (error) {
      log.warn({ err: error }, 'Failed to update health context for Sentry');
    }
  });
  log.debug('Health context updater registered for Sentry');
}

// =============================================================================
// Pre-flight Check (for onboarding)
// =============================================================================

/**
 * Get the path to the bundled Node.js executable.
 * Returns null if not in a packaged app or if the executable doesn't exist.
 */
function getBundledNodePath(): string | null {
  if (!isPackaged()) {
    return null;
  }
  
  const isWindows = process.platform === 'win32';
  const resourcesPath = process.resourcesPath;
  
  // Windows: node.exe is at root of node-bundle
  // macOS: node is in node-bundle/bin
  if (isWindows) {
    return path.join(resourcesPath, 'node-bundle', 'node.exe');
  } else {
    return path.join(resourcesPath, 'node-bundle', 'bin', 'node');
  }
}

/**
 * Trigger Windows Firewall prompt by making a network request using the bundled Node.js.
 * This should happen DURING the preflight screen so users see the prompt
 * in context ("Getting ready...") rather than after moving to onboarding.
 * 
 * IMPORTANT: Must use the bundled Node.js executable, not system `node`, because:
 * 1. Users may not have Node.js installed system-wide
 * 2. Windows Firewall prompts are per-executable - the bundled Node.js needs approval
 * 
 * Note: This function is only called on Windows (guarded by shouldWarmupFirewall),
 * but we keep it platform-aware for safety.
 */
async function warmupWindowsFirewall(): Promise<void> {
  // Safety check: this should only be called on Windows
  if (process.platform !== 'win32') {
    log.debug('warmupWindowsFirewall called on non-Windows platform, skipping');
    return;
  }
  
  log.info('Warming up bundled Node.js to trigger Windows Firewall prompt');
  
  const bundledNodePath = getBundledNodePath();
  if (!bundledNodePath) {
    log.warn('Not a packaged app, skipping Windows Firewall warmup');
    return;
  }
  
  // Verify bundled Node exists before attempting warmup
  try {
    await fs.access(bundledNodePath);
  } catch {
    log.warn({ bundledNodePath }, 'Bundled Node.js not found, skipping Windows Firewall warmup');
    return;
  }
  
  try {
    const { execSync } = await import('node:child_process');
    // Use the bundled Node.js to trigger the firewall prompt
    // The path must be quoted to handle spaces in the path (common on Windows with usernames)
    execSync(
      `"${bundledNodePath}" -e "require('http').get('http://localhost:1', () => {}).on('error', () => {})"`,
      { timeout: 5000, stdio: 'ignore' }
    );
  } catch {
    // Expected to fail (nothing listening on port 1), but it triggers the firewall prompt
  }
  // Give user time to respond to the firewall prompt
  log.info('Waiting for user to respond to Windows Firewall prompt...');
  await new Promise(resolve => setTimeout(resolve, 3000));
}

/**
 * Trigger AV scans for executables that may be flagged during agent turns.
 * 
 * This runs during preflight to shift AV scanning from mid-agent-turn to startup.
 * Uses async file read (not spawn) because:
 * - spawn() calls CreateProcessW synchronously on main thread (can block event loop)
 * - fs.readFile() uses libuv's threadpool (cannot block main thread)
 * - Most on-access AV scanners trigger on file open/read operations
 * 
 * Fire-and-forget: no await needed, errors are silently ignored.
 * The goal is just to trigger the scan attempt, not to verify success.
 */
function warmupAVSensitiveExecutables(context: 'startup' | 'preflight'): void {
  if (process.platform !== 'win32' || !isPackaged()) return;

  fireAndForget((async () => {
    const appVersion = getAppVersion();
    const markerDir = path.join(getDataPath(), 'warmup');
    const markerPath = path.join(markerDir, `av-sensitive-exes-${appVersion}.json`);

    // If we've already warmed up this exact app version, skip.
    try {
      await fs.stat(markerPath);
      log.debug({ markerPath, appVersion, context }, 'AV warmup already completed for this version, skipping');
      return;
    } catch {
      // continue
    }

    const resourcesPath = process.resourcesPath;

    const candidates: Array<{ id: string; filePath: string }> = [
      {
        id: 'bundledNode',
        filePath: path.join(resourcesPath, 'node-bundle', 'node.exe'),
      },
      {
        id: 'gitBash',
        filePath: path.join(resourcesPath, 'git-bundle', 'usr', 'bin', 'bash.exe'),
      },
      {
        id: 'gitExe',
        filePath: path.join(resourcesPath, 'git-bundle', 'cmd', 'git.exe'),
      },
      // NOTE: Squirrel.Windows Update.exe warmup removed - Windows now uses NSIS installer (2026-01)
    ];

    const warmed: Array<{ id: string; filePath: string }> = [];

    for (const candidate of candidates) {
      try {
        const handle = await fs.open(candidate.filePath, 'r');
        try {
          // Read a tiny amount to encourage on-access scanners to inspect the file.
          const buf = Buffer.alloc(16);
          await handle.read(buf, 0, buf.length, 0);
        } finally {
          await handle.close();
        }
        warmed.push(candidate);
      } catch {
        // Ignore errors: file may not exist or may be locked; the goal is best-effort scan triggering.
      }
    }

    try {
      await fs.mkdir(markerDir, { recursive: true });
      await fs.writeFile(
        markerPath,
        JSON.stringify(
          {
            appVersion,
            context,
            warmed,
            timestamp: new Date().toISOString(),
          },
          null,
          2
        )
      );
    } catch {
      // ignore
    }

    log.debug(
      {
        appVersion,
        context,
        warmedCount: warmed.length,
        warmedIds: warmed.map((w) => w.id),
      },
      'AV warmup completed'
    );
  })(), 'systemHealthService.line780');
}

// SuperMcpStartResult is now defined in superMcpHttpManager.ts — re-export for backward compatibility
export type { SuperMcpStartResult };

export { startSuperMcpWithRetries };

/**
 * Wait for Super-MCP to become ready with a bounded timeout.
 * Used during onboarding to ensure SuperMCP is running before showing "all set".
 * If timeout is reached, continues gracefully (SuperMCP will keep retrying in background).
 */
async function waitForSuperMcpReady(timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();
  const pollIntervalMs = 500;
  
  log.info({ timeoutMs }, 'Waiting for Super-MCP to become ready...');
  
  while (Date.now() - startTime < timeoutMs) {
    if (superMcpHttpManager.getState().isRunning) {
      const elapsedMs = Date.now() - startTime;
      log.info({ elapsedMs }, 'Super-MCP is ready');
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  
  log.warn({ timeoutMs }, 'Timed out waiting for Super-MCP - continuing with onboarding');
  return false;
}

export async function runPreflightCheck(): Promise<PreflightResult> {
  const startTime = Date.now();
  const issues: PreflightIssue[] = [];
  const isWindows = process.platform === 'win32';

  log.info('Running pre-flight check');

  // Determine if this is first run and if we need to start Super-MCP
  const superMcpState = superMcpHttpManager.getState();
  const settings = getSettings();
  const isFirstRun = !settings.onboardingCompleted;
  const shouldStartSuperMcp = isFirstRun && !superMcpState.isRunning;

  // Get config path for Super-MCP (needed if we start it)
  // Use the user's configured path, or fall back to default router location
  const configPath = resolveMcpConfigPath(settings) 
    || path.join(getDataPath(), 'mcp', 'super-mcp-router.json');

  // Run health checks AND Windows warmup in parallel.
  // The warmup triggers Windows Firewall prompt DURING "Getting ready..." screen,
  // not after the user moves to onboarding wizard.
  // Include Node bundle health check to verify bundled Node.js is available before
  // attempting to start Super-MCP (prevents race condition with Node permissions).
  const checksPromise = Promise.all([
    safeCheck(checkUserDataWritable, 'userDataWritable', 'User Data'),
    safeCheck(checkDiskSpace, 'diskSpace', 'Disk Space'),
    safeCheck(checkGitBashHealth, 'gitBashHealth', 'Git Bash'),
    safeCheck(checkPowerShellHealth, 'powerShellHealth', 'PowerShell'),
    safeCheck(checkNodeBundleHealth, 'nodeBundleHealth', 'Node Bundle'),
    safeCheck(checkMsvcRuntimeHealth, 'msvcRuntimeHealth', 'MSVC Runtime'),
  ]);

  // On Windows (packaged app), warm up bundled Node.js to trigger Windows Firewall prompt.
  // This runs in parallel with health checks and happens DURING "Getting ready..." screen.
  // We run this every time preflight runs (not just first-run) so that re-running onboarding
  // can recover from a dismissed firewall prompt.
  const shouldWarmupFirewall = isWindows && isPackaged();
  const warmupPromise = shouldWarmupFirewall
    ? warmupWindowsFirewall()
    : Promise.resolve();

  // Fire-and-forget: trigger AV scans for executables that may be flagged during agent turns.
  // Uses async file read (threadpool-based, cannot block main thread).
  warmupAVSensitiveExecutables('preflight');

  // Wait for both health checks and warmup to complete
  const [[userDataResult, diskSpaceResult, gitBashResult, powerShellResult, nodeBundleResult, msvcRuntimeResult]] = await Promise.all([
    checksPromise,
    warmupPromise,
  ]);

  // Now that warmup is done (firewall prompt handled), start Super-MCP and wait for it.
  // Only proceed if Node bundle is healthy (packaged) or in development mode.
  // This prevents starting Super-MCP if the bundled Node.js is missing/broken.
  const nodeBundleHealthy = !isPackaged() || nodeBundleResult.status === 'pass';
  if (shouldStartSuperMcp && nodeBundleHealthy) {
    log.info('Starting Super-MCP after preflight warmup (first-run user)');
    // Start the retry loop in background (fire-and-forget, will continue retrying)
    fireAndForget(startSuperMcpWithRetries(configPath, { logContext: 'preflight' }), 'systemHealthService.line948');
    // Wait up to 15 seconds for SuperMCP to become ready
    // This ensures "You're all set!" is shown only after SuperMCP is actually running
    // If timeout is reached, we continue gracefully - SuperMCP will keep retrying
    await waitForSuperMcpReady(15000);
  } else if (shouldStartSuperMcp && !nodeBundleHealthy) {
    log.warn({ nodeBundleStatus: nodeBundleResult.status }, 'Skipping Super-MCP startup due to Node bundle health check failure');
  }

  // Transform check results into human-friendly issues

  // 1. User data writable - BLOCKER
  if (userDataResult.status === 'fail') {
    issues.push({
      id: 'userData',
      category: 'permissions',
      title: 'Saving your work',
      description: "We need somewhere to keep your settings and conversations.",
      severity: 'blocker',
      remediation: 'Check that Rebel has permission to save files, or free up some disk space.',
      canRetry: true,
      actionType: 'open-folder',
      actionPath: getDataPath(),
    });
  }

  // 2. Disk space - BLOCKER if critical, WARNING if low
  if (diskSpaceResult.status === 'fail') {
    issues.push({
      id: 'diskSpace',
      category: 'storage',
      title: 'Storage space',
      description: 'Your disk is running low on space.',
      severity: 'blocker',
      remediation: 'Free up at least 100 MB so Rebel has room to work.',
      canRetry: true,
    });
  } else if (diskSpaceResult.status === 'warn') {
    issues.push({
      id: 'diskSpace',
      category: 'storage',
      title: 'Getting tight on space',
      description: 'Your disk is getting full. This might cause issues later.',
      severity: 'warning',
      remediation: 'Consider freeing up some disk space when you get a chance.',
      canRetry: false,
    });
  }

  // 3. Git Bash (Windows only) - BLOCKER
  if (isWindows && gitBashResult.status === 'fail') {
    // Extract diagnostic code from the health check details
    const diagnosticCode = gitBashResult.details?.diagnosticCode as string | undefined;
    
    // Map diagnostic codes to user-friendly hints. A keyed lookup (rather than a
    // switch over the open `string` type) keeps unknown/undefined codes a clean
    // no-op without a non-exhaustive switch over a non-finite union.
    const GIT_BASH_DIAGNOSTIC_HINTS: Record<string, string> = {
      GIT_BUNDLED_MISSING: 'The bundled Git component is missing. This can happen if security software quarantined it during installation. Try reinstalling Rebel, or install Git for Windows separately.',
      GIT_BUNDLED_BLOCKED: 'Git was found but your security software may be preventing it from running. Try adding Rebel to your antivirus exceptions, or install Git for Windows separately.',
      GIT_EXECUTION_TIMEOUT: 'Git is taking too long to respond. This can happen during security scans. Try clicking "Check again" in a moment.',
      GIT_BASH_MISSING: 'Git is partially installed but the Bash component is missing. Try reinstalling Git for Windows with default options.',
      GIT_SYSTEM_NOT_INSTALLED: 'Git for Windows is not installed on this computer.',
    };
    // No specific hint for unknown/undefined codes (preserves prior default no-op).
    const diagnosticHint: string | undefined = diagnosticCode
      ? GIT_BASH_DIAGNOSTIC_HINTS[diagnosticCode]
      : undefined;

    // Log diagnostic details for support cases
    log.info(
      {
        diagnosticCode,
        details: gitBashResult.details,
      },
      'Git Bash health check failed - diagnostic details'
    );

    issues.push({
      id: 'gitBash',
      category: 'system',
      title: 'Git for Windows',
      description: 'Rebel needs Git to run commands on your behalf.',
      severity: 'blocker',
      remediation: 'Install Git for Windows - it only takes a minute.',
      canRetry: true,
      actionType: 'open-url',
      actionPath: 'https://git-scm.com/downloads/win',
      diagnosticCode: diagnosticCode as PreflightIssue['diagnosticCode'],
      diagnosticHint,
    });
  }

  // 4. PowerShell (Windows only) - BLOCKER
  if (isWindows && powerShellResult.status === 'fail') {
    const isRestricted = powerShellResult.message.includes('restricted');
    issues.push({
      id: 'powershell',
      category: 'system',
      title: 'Windows setup',
      description: isRestricted 
        ? 'Windows needs a quick setting change to finish setup.'
        : "There's a Windows configuration issue we need to fix.",
      severity: 'blocker',
      remediation: isRestricted
        ? 'Open PowerShell as Administrator and run: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned'
        : 'Check that PowerShell is installed correctly.',
      canRetry: true,
    });
  }

  // 5. Node bundle (packaged builds only) - BLOCKER
  // This check ensures the bundled Node.js runtime is present and executable
  // before we attempt to start Super-MCP or run MCP servers.
  if (isPackaged() && nodeBundleResult.status === 'fail') {
    issues.push({
      id: 'nodeBundle',
      category: 'system',
      title: 'Runtime environment',
      description: 'A required component is missing from the application.',
      severity: 'blocker',
      remediation: 'Try reinstalling Rebel. If the problem persists, please contact support.',
      canRetry: true,
    });
  }

  // 6. MSVC runtime (packaged Windows only) - WARNING
  // Native modules (LanceDB, ONNX Runtime) depend on MSVC runtime DLLs.
  // We ship them app-local (next to the app exe and node.exe) to avoid installing vc_redist.
  if (isWindows && isPackaged() && msvcRuntimeResult.status === 'fail') {
    captureMainException(new Error('MSVC runtime missing during startup preflight'), {
      tags: {
        area: 'startup',
        component: 'msvc-runtime',
        context: 'preflight',
        condition: 'startup_msvc_runtime_missing',
      },
      fingerprint: ['startup-msvc-runtime-missing'],
      extra: {
        checkId: msvcRuntimeResult.id,
        message: msvcRuntimeResult.message,
        details: extractMsvcRuntimeDetailsForSentry(msvcRuntimeResult.details),
      },
    });

    issues.push({
      id: 'msvcRuntime',
      category: 'system',
      title: 'Runtime environment',
      description: 'A required Microsoft runtime component is missing. Some features may not work.',
      severity: 'warning',
      remediation: 'Try reinstalling Rebel. If the problem persists, please contact support.',
      canRetry: true,
    });
  }

  const canProceed = !issues.some(i => i.severity === 'blocker');
  const checkDurationMs = Date.now() - startTime;

  log.info({ 
    canProceed, 
    issueCount: issues.length, 
    blockerCount: issues.filter(i => i.severity === 'blocker').length,
    checkDurationMs,
  }, 'Pre-flight check completed');

  return {
    canProceed,
    issues,
    checkDurationMs,
  };
}
