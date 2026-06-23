/**
 * Health Check Types
 *
 * Internal TypeScript types for health checks.
 * Note: Zod schemas for IPC are in @shared/ipc/schemas/health.ts
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
  remediation?: string;
  durationMs?: number;
  timedOut?: boolean;
}

export interface EnvironmentSummary {
  coreDirectory: string | null;
  mcpConfigFile: string | null;
  mcpMode: 'none' | 'direct' | 'super-mcp';
  superMcpHttpRunning: boolean;
  superMcpPort: number | null;
  rebelSystemVersion: string | null;
  expectedRebelSystemVersion: string;
  envOverrides: Record<string, string>;
  paths: {
    userData: string;
    logs: string;
    mcpConfig: string | null;
    rebelSystem: string;
  };
}

export interface Recommendation {
  priority: 'critical' | 'high' | 'medium';
  message: string;
  action?: string;
}

export interface SystemHealthReport {
  timestamp: number;
  platform: NodeJS.Platform;
  appVersion: string;
  isPackaged: boolean;
  status: 'healthy' | 'degraded' | 'critical';
  checks: {
    userDataWritable: CheckResult;
    workspaceAccessible: CheckResult;
    rebelSystemPresent: CheckResult;
    systemPromptRenders: CheckResult;
    systemPromptCoherence: CheckResult;
    safetyPromptExists: CheckResult;
    memoryPromptExists: CheckResult;
    claudeApiKeyValid: CheckResult;
    nodeBundleHealth: CheckResult;
    msvcRuntimeHealth: CheckResult;
    mcpConfigValid: CheckResult;
    bundledServers: CheckResult;
    superMcpHealth: CheckResult;
    microphonePermission: CheckResult;
    screenRecordingPermission: CheckResult;
    workspacePathIssues: CheckResult;
    envOverrides: CheckResult;
    symlinkHealth: CheckResult;
    diskSpace: CheckResult;
    portAvailable: CheckResult;
    voiceApiKeyValid: CheckResult;
    anthropicReachable: CheckResult;
    rebelSystemSyncStatus: CheckResult;
    tempDirectoryHealth: CheckResult;
    gitBashHealth: CheckResult;
    powerShellHealth: CheckResult;
    skillsConvention: CheckResult;
    embeddingServiceReady: CheckResult;
    semanticIndexHealth: CheckResult;
    spaceReadmeSizes: CheckResult;
    spaceSharingConfig: CheckResult;
    brokenSpaceFrontmatter: CheckResult;
    calendarCacheHealth: CheckResult;
    // New checks - Phase 1 & 2
    toolIndexHealth: CheckResult;
    enhancementHealth: CheckResult;
    mcpSkippedServers: CheckResult;
    authHealth: CheckResult;
    autoUpdateHealth: CheckResult;
    // Phase 3
    inboxHealth: CheckResult;
    conversationIndexHealth: CheckResult;
    // Phase 4
    userProfileComplete: CheckResult;
    // Phase 5
    conflictingCopies: CheckResult;
    // Phase 6 - Meeting bot
    fullDiskAccess: CheckResult;
    // Cloud service
    cloudServiceHealth: CheckResult;
    // Prompt files
    promptFilesExist: CheckResult;
    promptFilesRender: CheckResult;
    // Degraded-state surfacing
    apiCooldownHealth: CheckResult;
    oauthRefreshHealth: CheckResult;
    mcpRuntimeHealth: CheckResult;
    toolAdvisoryHealth: CheckResult;
  };
  environment: EnvironmentSummary;
  recommendations: Recommendation[];
}

export type HealthCheckTier = 'quick' | 'full';

export type PreflightIssueCategory = 'network' | 'storage' | 'permissions' | 'system';
export type PreflightIssueSeverity = 'blocker' | 'warning';

export interface PreflightIssue {
  id: string;
  category: PreflightIssueCategory;
  title: string;
  description: string;
  severity: PreflightIssueSeverity;
  remediation?: string;
  canRetry: boolean;
  actionType?: 'open-folder' | 'open-settings' | 'open-url' | 'retry-only';
  actionPath?: string;
  // Enhanced diagnostics for user feedback
  diagnosticCode?: string;
  diagnosticHint?: string;
}

export interface PreflightResult {
  canProceed: boolean;
  issues: PreflightIssue[];
  checkDurationMs: number;
}
