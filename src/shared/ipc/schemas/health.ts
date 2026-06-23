import { z } from 'zod';

/** Check status for individual health checks */
export const CheckStatusSchema = z.enum(['pass', 'warn', 'fail', 'skip']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

/** Result of a single health check */
export const CheckResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: CheckStatusSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  remediation: z.string().optional(),
  durationMs: z.number().optional(),
  timedOut: z.boolean().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** Environment summary in health report */
export const EnvironmentSummarySchema = z.object({
  coreDirectory: z.string().nullable(),
  mcpConfigFile: z.string().nullable(),
  mcpMode: z.enum(['none', 'direct', 'super-mcp']),
  superMcpHttpRunning: z.boolean(),
  superMcpPort: z.number().nullable(),
  rebelSystemVersion: z.string().nullable(),
  expectedRebelSystemVersion: z.string(),
  envOverrides: z.record(z.string(), z.string()),
  paths: z.object({
    userData: z.string(),
    logs: z.string(),
    mcpConfig: z.string().nullable(),
    rebelSystem: z.string(),
  }),
});
export type EnvironmentSummary = z.infer<typeof EnvironmentSummarySchema>;

/** Recommendation from health check */
export const RecommendationSchema = z.object({
  priority: z.enum(['critical', 'high', 'medium']),
  message: z.string(),
  action: z.string().optional(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** Full system health report */
export const SystemHealthReportSchema = z.object({
  timestamp: z.number(),
  platform: z.enum(['darwin', 'win32', 'linux', 'aix', 'freebsd', 'openbsd', 'sunos', 'android']),
  appVersion: z.string(),
  isPackaged: z.boolean(),
  status: z.enum(['healthy', 'degraded', 'critical']),
  checks: z.object({
    userDataWritable: CheckResultSchema,
    workspaceAccessible: CheckResultSchema,
    rebelSystemPresent: CheckResultSchema,
    systemPromptRenders: CheckResultSchema,
    systemPromptCoherence: CheckResultSchema,
    safetyPromptExists: CheckResultSchema,
    memoryPromptExists: CheckResultSchema,
    claudeApiKeyValid: CheckResultSchema,
    nodeBundleHealth: CheckResultSchema,
    msvcRuntimeHealth: CheckResultSchema,
    mcpConfigValid: CheckResultSchema,
    bundledServers: CheckResultSchema,
    superMcpHealth: CheckResultSchema,
    microphonePermission: CheckResultSchema,
    screenRecordingPermission: CheckResultSchema,
    workspacePathIssues: CheckResultSchema,
    envOverrides: CheckResultSchema,
    symlinkHealth: CheckResultSchema,
    diskSpace: CheckResultSchema,
    portAvailable: CheckResultSchema,
    voiceApiKeyValid: CheckResultSchema,
    anthropicReachable: CheckResultSchema,
    rebelSystemSyncStatus: CheckResultSchema,
    tempDirectoryHealth: CheckResultSchema,
    gitBashHealth: CheckResultSchema,
    powerShellHealth: CheckResultSchema,
    skillsConvention: CheckResultSchema,
    embeddingServiceReady: CheckResultSchema,
    semanticIndexHealth: CheckResultSchema,
    spaceReadmeSizes: CheckResultSchema,
    spaceSharingConfig: CheckResultSchema,
    brokenSpaceFrontmatter: CheckResultSchema,
    calendarCacheHealth: CheckResultSchema,
    // New checks - Phase 1 & 2
    toolIndexHealth: CheckResultSchema,
    enhancementHealth: CheckResultSchema,
    mcpSkippedServers: CheckResultSchema,
    authHealth: CheckResultSchema,
    autoUpdateHealth: CheckResultSchema,
    // Phase 3
    inboxHealth: CheckResultSchema,
    conversationIndexHealth: CheckResultSchema,
    // Phase 4
    userProfileComplete: CheckResultSchema,
    // Phase 5
    conflictingCopies: CheckResultSchema,
    // Phase 6 - Meeting bot
    fullDiskAccess: CheckResultSchema,
    // Cloud service
    cloudServiceHealth: CheckResultSchema,
    // Prompt files
    promptFilesExist: CheckResultSchema,
    promptFilesRender: CheckResultSchema,
    // Degraded-state surfacing
    apiCooldownHealth: CheckResultSchema,
    oauthRefreshHealth: CheckResultSchema,
    mcpRuntimeHealth: CheckResultSchema,
    toolAdvisoryHealth: CheckResultSchema,
  }),
  environment: EnvironmentSummarySchema,
  recommendations: z.array(RecommendationSchema),
});
export type SystemHealthReport = z.infer<typeof SystemHealthReportSchema>;

/**
 * Union of all health-check IDs — the keys of `SystemHealthReportSchema.checks`.
 * Type check-ID collections (suppression sets, notify policies, tab routing)
 * against this so a typo'd or renamed check ID is a compile error instead of a
 * silently dead entry. Note `CheckResult.id` itself stays `string` (wire shape).
 */
export type HealthCheckId = keyof SystemHealthReport['checks'];

/** Full check-ID set, derived from the schema so it can never drift from it. */
const HEALTH_CHECK_ID_SET: ReadonlySet<HealthCheckId> = new Set(
  Object.keys(SystemHealthReportSchema.shape.checks.shape) as HealthCheckId[],
);

/**
 * Check IDs arrive as `string` on the wire (`CheckResult.id`); membership
 * tests against typed check-ID collections go through this narrowing helper
 * instead of per-call-site casts.
 */
export function hasCheckId(set: ReadonlySet<HealthCheckId>, id: string): id is HealthCheckId {
  return (set as ReadonlySet<string>).has(id);
}

/** Narrow a wire-shaped check ID against the full schema-derived ID set. */
export function isHealthCheckId(id: string): id is HealthCheckId {
  return hasCheckId(HEALTH_CHECK_ID_SET, id);
}

/** Health check tier (quick or full) */
export const HealthCheckTierSchema = z.enum(['quick', 'full']);
export type HealthCheckTier = z.infer<typeof HealthCheckTierSchema>;
