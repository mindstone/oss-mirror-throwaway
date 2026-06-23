import { z } from 'zod';

export const ProviderIdSchema = z.enum(['anthropic', 'openai', 'google', 'openrouter', 'codex', 'rebel-cloud']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProbeErrorCodeSchema = z.enum(['dns', 'tls', 'http_4xx', 'http_5xx', 'timeout', 'unknown']);
export type ProbeErrorCode = z.infer<typeof ProbeErrorCodeSchema>;

export const ProbeResultSchema = z.object({
  status: z.enum(['reachable', 'unreachable', 'unknown']),
  latencyMs: z.number().optional(),
  errorCode: ProbeErrorCodeSchema.optional(),
  checkedAt: z.number(),
  cachedAt: z.number(),
  expiresAt: z.number(),
  stale: z.boolean(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const ProviderReachabilitySnapshotSchema = z.object({
  snapshotPresent: z.boolean(),
  lastRefreshAt: z.number().nullable(),
  providers: z.partialRecord(ProviderIdSchema, ProbeResultSchema).optional(),
});
export type ProviderReachabilitySnapshot = z.infer<typeof ProviderReachabilitySnapshotSchema>;
