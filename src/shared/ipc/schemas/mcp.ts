import { z } from 'zod';

/** MCP transport type */
export const McpTransportSchema = z.enum(['stdio', 'http', 'sse']);

/** MCP server preview (summary info) */
export const McpServerPreviewSchema = z.object({
  name: z.string(),
  transport: McpTransportSchema,
  type: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).nullable().optional(),
  url: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  envKeys: z.array(z.string()).optional(),
  headersKeys: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  health: z.enum(['ok', 'error', 'unavailable']).optional(),
  catalogStatus: z.enum(['ready', 'auth_required', 'error']).optional(),
  catalogError: z.string().nullable().optional(),
  catalogSummary: z.string().nullable().optional(),
  toolCount: z.number().nullable().optional(),
  catalogId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
  lastConnectedAt: z.number().nullable().optional(),
  disabled: z.boolean().optional(),
  oauth: z.boolean().optional(),
  needsReconnect: z.boolean().optional(),
});

/** MCP router preview */
export const McpRouterPreviewSchema = z.object({
  configPaths: z.array(z.string()),
  upstreamServers: z.array(McpServerPreviewSchema),
  upstreamCount: z.number(),
  httpMode: z.enum(['stdio', 'http']),
  isRunning: z.boolean(),
  port: z.number().optional(),
  url: z.string().optional(),
  lastHealthCheck: z.number().nullable().optional(),
});

/** MCP config summary */
export const McpConfigSummarySchema = z.object({
  status: z.enum(['missing', 'ready', 'error']),
  mode: z.enum(['none', 'direct', 'super-mcp']),
  configPath: z.string().nullable(),
  servers: z.array(McpServerPreviewSchema),
  editableServers: z.array(McpServerPreviewSchema).optional(),
  upstreamCount: z.number(),
  router: McpRouterPreviewSchema.nullable().optional(),
  lastLoadedAt: z.number(),
  error: z.string().optional(),
  managed: z.object({
    isManaged: z.boolean(),
    managedPath: z.string(),
    sourcePath: z.string().nullable().optional(),
    wrapperVersion: z.number().optional(),
  }).optional(),
});
export type McpConfigSummary = z.infer<typeof McpConfigSummarySchema>;

/** MCP server upsert payload */
export const McpServerUpsertPayloadSchema = z.object({
  name: z.string(),
  transport: McpTransportSchema.optional(),
  /** Specific transport type (http vs sse). Takes precedence over transport when saving. */
  type: z.enum(['http', 'sse']).nullable().optional(),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).nullable().optional(),
  url: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  env: z.record(z.string(), z.string()).nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  description: z.string().nullable().optional(),
  oauth: z.boolean().nullable().optional(),
  oauthParams: z.record(z.string(), z.string()).nullable().optional(),
  catalogId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
});
export type McpServerUpsertPayload = z.infer<typeof McpServerUpsertPayloadSchema>;

/** MCP router path patch payload */
export const McpRouterPathPatchPayloadSchema = z.object({
  action: z.enum(['add', 'remove']),
  path: z.string(),
});
export type McpRouterPathPatchPayload = z.infer<typeof McpRouterPathPatchPayloadSchema>;

/** MCP config mutation result */
export const McpConfigMutationResultSchema = z.object({
  summary: McpConfigSummarySchema,
  backupPath: z.string().nullable().optional(),
});
export type McpConfigMutationResult = z.infer<typeof McpConfigMutationResultSchema>;

/** MCP server config details (full details for editing) */
export const McpServerConfigDetailsSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
  transport: McpTransportSchema,
  command: z.string().nullable(),
  args: z.array(z.string()).nullable(),
  url: z.string().nullable(),
  cwd: z.string().nullable(),
  env: z.record(z.string(), z.string()).nullable(),
  headers: z.record(z.string(), z.string()).nullable(),
  description: z.string().nullable(),
  catalogId: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
});
export type McpServerConfigDetails = z.infer<typeof McpServerConfigDetailsSchema>;

/** MCP tool info (for tool visibility UI) */
export const McpToolInfoSchema = z.object({
  serverId: z.string(),
  toolId: z.string(),
  name: z.string(),
  summary: z.string().optional(),
  argsSkeleton: z.unknown().optional(),
  blocked: z.boolean().optional(),
  blockedReason: z.string().optional(),
  userDisabled: z.boolean().optional(),
  adminDisabled: z.boolean().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
});
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;

/** MCP tool list response (with pagination) */
export const McpToolListResponseSchema = z.object({
  tools: z.array(McpToolInfoSchema),
  nextPageToken: z.string().nullable(),
});
export type McpToolListResponse = z.infer<typeof McpToolListResponseSchema>;
