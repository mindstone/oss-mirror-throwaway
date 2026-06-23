import { z } from 'zod';

/**
 * Machine-checkable single source of truth for the app <-> Super-MCP seam
 * (docs/plans/260531_mcp-layer-decomposition/, docs/project/MCP_APP_SUPER_MCP_SEAM.md).
 *
 * Production consumers import these constants/schemas (wired in Stage 3) so seam
 * drift surfaces as a compile/test failure rather than a silent runtime bug.
 * Keep it core-safe: imports only `zod` — no Electron, no process reads, no I/O
 * (so it stays importable from core/cloud/headless without creating a cycle).
 */

const UnknownRecordSchema = z.record(z.string(), z.unknown());

// Derived from super-mcp/src/server.ts:100,125,170,256,266 and
// src/core/services/toolIndex/toolIndexService.ts:473-570.
export const SUPER_MCP_REST_ENDPOINTS = {
  TOOLS: '/api/tools',
  TOOLS_SELECTED_PACKAGES: '/api/tools?packages=',
  TOOLS_CONFIG_HASH: '/api/tools/config-hash',
  TOOLS_MANIFEST: '/api/tools/manifest',
  SKIPPED_SERVERS: '/api/skipped-servers',
  STATS: '/stats',
} as const;

export type SuperMcpRestEndpoint =
  typeof SUPER_MCP_REST_ENDPOINTS[keyof typeof SUPER_MCP_REST_ENDPOINTS];

export const SUPER_MCP_TOOL_INDEX_QUERY_PARAMS = {
  PACKAGES: 'packages',
} as const;

// Derived from super-mcp/src/server.ts:342-628 and dispatch at :632-665.
export const SUPER_MCP_META_TOOLS = {
  LIST_TOOL_PACKAGES: 'list_tool_packages',
  LIST_TOOLS: 'list_tools',
  GET_TOOL_DETAILS: 'get_tool_details',
  USE_TOOL: 'use_tool',
  // Agent-requested bulk export: loops a read-only downstream tool's pagination
  // and streams NDJSON to .rebel/exports/, returning only a summary (data never
  // enters model context). Intentionally absent from SUPER_MCP_READ_ONLY_META_TOOLS
  // below — it writes files + long-loops, so a blind reconnect-retry could
  // double-write; the reconnect gate must treat it as non-retryable.
  BULK_EXPORT: 'bulk_export',
  GET_HELP: 'get_help',
  HEALTH_CHECK_ALL: 'health_check_all',
  HEALTH_CHECK: 'health_check',
  AUTHENTICATE: 'authenticate',
  RESTART_PACKAGE: 'restart_package',
  SEARCH_TOOLS: 'search_tools',
} as const;

export type SuperMcpMetaTool =
  typeof SUPER_MCP_META_TOOLS[keyof typeof SUPER_MCP_META_TOOLS];

// Derived from src/core/rebelCore/mcpClient.ts:127-140.
export const SUPER_MCP_READ_ONLY_META_TOOLS = [
  SUPER_MCP_META_TOOLS.LIST_TOOL_PACKAGES,
  SUPER_MCP_META_TOOLS.LIST_TOOLS,
  SUPER_MCP_META_TOOLS.GET_TOOL_DETAILS,
  SUPER_MCP_META_TOOLS.SEARCH_TOOLS,
  SUPER_MCP_META_TOOLS.GET_HELP,
  SUPER_MCP_META_TOOLS.HEALTH_CHECK,
  SUPER_MCP_META_TOOLS.HEALTH_CHECK_ALL,
] as const;

export type SuperMcpReadOnlyMetaTool =
  typeof SUPER_MCP_READ_ONLY_META_TOOLS[number];

// Derived from src/core/services/superMcpHttpManager.ts:863-896.
export const SUPER_MCP_RESTART_REASON = {
  DEBOUNCED_WORKSPACE_CHANGE: 'debounced-workspace-change',
  IDLE_RESTART: 'idle-restart',
  RECONFIGURE: 'reconfigure',
  POST_RESUME: 'post-resume',
  CIRCUIT_BREAKER_RESET: 'circuit-breaker-reset',
} as const;

export const SUPER_MCP_RESTART_REASONS = [
  SUPER_MCP_RESTART_REASON.DEBOUNCED_WORKSPACE_CHANGE,
  SUPER_MCP_RESTART_REASON.IDLE_RESTART,
  SUPER_MCP_RESTART_REASON.RECONFIGURE,
  SUPER_MCP_RESTART_REASON.POST_RESUME,
  SUPER_MCP_RESTART_REASON.CIRCUIT_BREAKER_RESET,
] as const;

export type SuperMcpRestartReason =
  typeof SUPER_MCP_RESTART_REASONS[number];

// Derived from src/core/services/diagnostics/manifest.ts:685-700.
export const SUPER_MCP_DIAGNOSTIC_TRANSITION_REASON = {
  ...SUPER_MCP_RESTART_REASON,
  SPAWN_ERROR: 'spawn-error',
  HEALTH_CHECK_TIMEOUT: 'health-check-timeout',
  PROCESS_EXIT: 'process-exit',
  CIRCUIT_BREAKER_ACTIVE: 'circuit-breaker-active',
} as const;

export const SUPER_MCP_DIAGNOSTIC_TRANSITION_REASONS = [
  ...SUPER_MCP_RESTART_REASONS,
  SUPER_MCP_DIAGNOSTIC_TRANSITION_REASON.SPAWN_ERROR,
  SUPER_MCP_DIAGNOSTIC_TRANSITION_REASON.HEALTH_CHECK_TIMEOUT,
  SUPER_MCP_DIAGNOSTIC_TRANSITION_REASON.PROCESS_EXIT,
  SUPER_MCP_DIAGNOSTIC_TRANSITION_REASON.CIRCUIT_BREAKER_ACTIVE,
] as const;

export type SuperMcpDiagnosticTransitionReason =
  typeof SUPER_MCP_DIAGNOSTIC_TRANSITION_REASONS[number];

// Derived from src/core/services/superMcpHttpManager.ts:1750-1759 and
// src/core/services/superMcpOwnerTag.ts:1-30.
export const SUPER_MCP_SPAWN_ARGV_FLAGS = {
  TRANSPORT: '--transport',
  PORT: '--port',
  CONFIG: '--config',
  REBEL_OWNER_ID: '--rebel-owner-id',
  REBEL_OWNER_PID: '--rebel-owner-pid',
  REBEL_OWNER_START: '--rebel-owner-start',
} as const;

export type SuperMcpSpawnArgvFlag =
  typeof SUPER_MCP_SPAWN_ARGV_FLAGS[keyof typeof SUPER_MCP_SPAWN_ARGV_FLAGS];

// Derived from src/core/services/superMcpHttpManager.ts:1715-1759.
export const SUPER_MCP_SPAWN_ARGV_FIXED_VALUES = {
  TRANSPORT_HTTP: 'http',
} as const;

// Derived from src/core/services/superMcpHttpManager.ts:136-140,739-747,
// 1786-1787,1808-1830 and src/main/services/bundledMcpManager.ts:214-250.
export const SUPER_MCP_SPAWN_ENV_KEYS = {
  NODE_ENV: 'NODE_ENV',
  NODE_PATH: 'NODE_PATH',
  SUPER_MCP_APP_NAME: 'SUPER_MCP_APP_NAME',
  SUPER_MCP_PRIMARY_COLOR: 'SUPER_MCP_PRIMARY_COLOR',
  SUPER_MCP_ICON_TEXT: 'SUPER_MCP_ICON_TEXT',
  SUPER_MCP_ICON_URL: 'SUPER_MCP_ICON_URL',
  REBEL_WORKSPACE_PATH: 'REBEL_WORKSPACE_PATH',
  SUPER_MCP_DATA_DIR: 'SUPER_MCP_DATA_DIR',
  HOME: 'HOME',
  USERPROFILE: 'USERPROFILE',
  REBEL_TEST_USER_DATA_DIR: 'REBEL_TEST_USER_DATA_DIR',
  REBEL_E2E_TEST_MODE: 'REBEL_E2E_TEST_MODE',
  REBEL_HEADLESS: 'REBEL_HEADLESS',
  REBEL_SUPER_MCP_BIN: 'REBEL_SUPER_MCP_BIN',
  REBEL_SUPER_MCP_PINNED_VERSION: 'REBEL_SUPER_MCP_PINNED_VERSION',
  SUPER_MCP_HTTP_PORT: 'SUPER_MCP_HTTP_PORT',
  MCP_HOST_BRIDGE_STATE: 'MCP_HOST_BRIDGE_STATE',
  MINDSTONE_REBEL_BRIDGE_STATE: 'MINDSTONE_REBEL_BRIDGE_STATE',
} as const;

export type SuperMcpSpawnEnvKey =
  typeof SUPER_MCP_SPAWN_ENV_KEYS[keyof typeof SUPER_MCP_SPAWN_ENV_KEYS];

// Derived from src/main/services/bundledMcpManager.ts:214-250.
export const SUPER_MCP_BRIDGE_STATE_ENV_KEYS = [
  SUPER_MCP_SPAWN_ENV_KEYS.MCP_HOST_BRIDGE_STATE,
  SUPER_MCP_SPAWN_ENV_KEYS.MINDSTONE_REBEL_BRIDGE_STATE,
] as const;

export type SuperMcpBridgeStateEnvKey =
  typeof SUPER_MCP_BRIDGE_STATE_ENV_KEYS[number];

// Derived from src/core/services/superMcpHttpManager.ts:700-729.
export const SUPER_MCP_SANITIZED_INHERITED_ENV_KEYS = [
  SUPER_MCP_SPAWN_ENV_KEYS.REBEL_WORKSPACE_PATH,
  'NODE_OPTIONS',
] as const;

// Derived from src/core/services/superMcpHttpManager.ts:2742-2754.
export const SuperMcpRuntimeHttpConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string(),
});

export type SuperMcpRuntimeHttpConfig =
  z.infer<typeof SuperMcpRuntimeHttpConfigSchema>;

// Derived from src/core/services/superMcpHttpManager.ts:369-375,1264-1281.
export const SuperMcpHttpManagerConfigureSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().positive(),
  configPath: z.string(),
  startupTimeoutMs: z.number().int().positive(),
  healthCheckIntervalMs: z.number().int().positive(),
});

export type SuperMcpHttpManagerConfigure =
  z.infer<typeof SuperMcpHttpManagerConfigureSchema>;

// Derived from the internal startWithRetries configure call at
// src/core/services/superMcpHttpManager.ts:1577-1585. The current public
// configure interface also carries enabled + healthCheckIntervalMs above.
export const SuperMcpInternalConfigureShapeSchema =
  SuperMcpHttpManagerConfigureSchema.pick({
    port: true,
    configPath: true,
    startupTimeoutMs: true,
  });

export type SuperMcpInternalConfigureShape =
  z.infer<typeof SuperMcpInternalConfigureShapeSchema>;

// Derived from super-mcp/src/handlers/useTool.ts:177-198,257-273.
export const SuperMcpResolutionSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const SuperMcpToolResolutionSchema = SuperMcpResolutionSchema.extend({
  packageId: z.string(),
});

export const SuperMcpTelemetryMetaSchema = z.object({
  packageId: z.string(),
  toolId: z.string(),
  durationMs: z.number(),
  outputChars: z.number().optional(),
  truncated: z.boolean().optional(),
  resultId: z.string().optional(),
  dryRun: z.literal(true).optional(),
  continuation: z.literal(true).optional(),
  staged: z.literal(true).optional(),
  normalisations: z.array(z.string()).optional(),
  packageResolution: SuperMcpResolutionSchema.optional(),
  toolResolution: SuperMcpToolResolutionSchema.optional(),
});

export type SuperMcpTelemetryMeta =
  z.infer<typeof SuperMcpTelemetryMetaSchema>;

// Derived from super-mcp/src/handlers/useTool.ts:200-205,1151-1158,1365-1371.
export const SuperMcpMaterializationMetaSchema = z.object({
  status: z.enum(['materialized', 'oversized_output']),
  originalChars: z.number().optional(),
  filePath: z.string().optional(),
  imageFiles: z.array(z.string()).optional(),
});

export type SuperMcpMaterializationMeta =
  z.infer<typeof SuperMcpMaterializationMetaSchema>;

// Derived from super-mcp/src/handlers/useTool.ts:225-231. Super-MCP only
// hoists `_meta.ui` when it is a record with a non-empty resourceUri; the app
// carries the rest of the MCP App UI payload opaquely at this seam.
export const McpAppUiPassthroughMetaSchema = z.object({
  resourceUri: z.string().min(1),
}).passthrough();

// Derived from src/core/rebelCore/mcpClient.ts:380-428.
export const SUPER_MCP_OUTER_META_ALLOWED_NAMESPACES = [
  'ui',
  'superMcp',
  'materialization',
] as const;

export type SuperMcpOuterMetaAllowedNamespace =
  typeof SUPER_MCP_OUTER_META_ALLOWED_NAMESPACES[number];

// Consumer-tolerant to match src/core/rebelCore/mcpClient.ts:482-505: unknown
// namespaces may arrive and are dropped/logged by the consumer allowlist.
export const UseToolOuterMetaSchema = z.object({
  ui: McpAppUiPassthroughMetaSchema.optional(),
  superMcp: SuperMcpTelemetryMetaSchema.optional(),
  materialization: SuperMcpMaterializationMetaSchema.optional(),
}).passthrough();

// CONSUMER-TOLERANT. Mirrors what the app must SURVIVE reading, per consumer
// optionality at src/core/rebelCore/mcpClient.ts:430-527 (missing `isError`
// treated as false; unknown `_meta` namespaces dropped/logged). Use this for
// replay / direct-MCP / older-version compatibility — NOT for asserting what
// Super-MCP must emit (use the producer-strict schema below for that).
export const UseToolOuterBlockSchema = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
  _meta: UseToolOuterMetaSchema.optional(),
}).passthrough();

export type UseToolOuterBlock =
  z.infer<typeof UseToolOuterBlockSchema>;

// PRODUCER-STRICT — what current Super-MCP `buildOuter()` MUST emit
// (super-mcp/src/handlers/useTool.ts:294-319 + applyOuterMeta :257-287):
// `isError` is always present; `_meta`, when present, always carries `superMcp`
// and only the allowlisted namespaces (no unknown `_meta.*` leak). Stage 2
// conformance tests assert THIS against real Super-MCP output so a dropped
// `isError` or an accidental `_meta.foo` producer leak fails the build.
// (Stage-1 review F1: 260531_004146_stage01-fidelity-review.md.)
export const SuperMcpOuterMetaProducerSchema = z.object({
  superMcp: SuperMcpTelemetryMetaSchema,
  ui: McpAppUiPassthroughMetaSchema.optional(),
  materialization: SuperMcpMaterializationMetaSchema.optional(),
}).strict();

// PRODUCER-STRICT (buildOuter / main-execution path). `buildOuter()` ALWAYS
// calls applyOuterMeta, so `_meta` (with `superMcp`) is REQUIRED here, and the
// block has no top-level `resultId` (resultId lives in `_meta.superMcp`).
// Use this to assert main-path tool results.
export const UseToolOuterBlockBuildOuterSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean(),
  structuredContent: z.unknown().optional(),
  _meta: SuperMcpOuterMetaProducerSchema,
}).strict();

export type UseToolOuterBlockBuildOuter =
  z.infer<typeof UseToolOuterBlockBuildOuterSchema>;

// PRODUCER-STRICT (any `use_tool` outer block). Superset of buildOuter: the
// ONLY non-buildOuter outer block is the early-error return when `result_id` is
// given without `output_offset` (super-mcp/src/handlers/useTool.ts:790), which
// is `{ content, isError }` with NO `_meta`. So `_meta` is optional here.
// IMPORTANT: there is NO top-level `resultId` on the outer block — the
// continuation path's `resultId` is produced by the inner `handleContinuation`
// helper (useTool.ts:88-119) and then placed inside `_meta.superMcp.resultId`
// by `buildOuter` (useTool.ts:791-803), never at the top level. `isError` is
// always present; `.strict()` rejects any unknown top-level key (incl. a leaked
// `resultId`). (Stage-2a cross-family fidelity review corrected an earlier
// mis-reading that added a fictional top-level `resultId`.)
export const UseToolOuterBlockProducerSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean(),
  structuredContent: z.unknown().optional(),
  _meta: SuperMcpOuterMetaProducerSchema.optional(),
}).strict();

export type UseToolOuterBlockProducer =
  z.infer<typeof UseToolOuterBlockProducerSchema>;

// Derived from super-mcp/src/types.ts:192-214.
export const UseToolJsonTextTelemetrySchema = z.object({
  duration_ms: z.number(),
  status: z.enum(['ok', 'error']),
  output_chars: z.number().optional(),
  output_truncated: z.boolean().optional(),
  original_output_chars: z.number().optional(),
  result_id: z.string().optional(),
  materialized: z.boolean().optional(),
}).passthrough();

export const UseToolJsonTextAnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
}).passthrough();

// Derived from super-mcp/src/types.ts:192-214 and normal/dry-run construction at
// super-mcp/src/handlers/useTool.ts:1068-1086,1227-1245.
export const UseToolJsonTextStandardEnvelopeSchema = z.object({
  package_id: z.string(),
  tool_id: z.string(),
  args_used: z.unknown(),
  result: z.unknown(),
  telemetry: UseToolJsonTextTelemetrySchema,
  annotations: UseToolJsonTextAnnotationsSchema.optional(),
}).passthrough();

export const UseToolJsonTextDryRunEnvelopeSchema =
  UseToolJsonTextStandardEnvelopeSchema.extend({
    result: z.object({
      dry_run: z.literal(true),
    }).passthrough(),
  });

// Derived from super-mcp/src/handlers/useTool.ts:86-118.
export const UseToolJsonTextContinuationEnvelopeSchema = z.object({
  continuation: z.literal(true),
  result_id: z.string(),
  offset: z.number(),
  length: z.number(),
  total_chars: z.number(),
  has_more: z.boolean(),
  content: z.string(),
}).passthrough();

// Derived from super-mcp/src/handlers/useTool.ts:750-771. Staged calls return
// plain text in the outer block; this schema describes the internal input flags
// that identify that bypass path at the seam.
export const UseToolStagedBypassInputSchema = z.object({
  _rebel_staged: z.literal(true),
  _rebel_staged_message: z.string().optional(),
}).passthrough();

export const UseToolJsonTextKnownEnvelopeSchema = z.union([
  UseToolJsonTextDryRunEnvelopeSchema,
  UseToolJsonTextContinuationEnvelopeSchema,
  UseToolJsonTextStandardEnvelopeSchema,
]);

// Derived from src/core/rebelCore/superMcpEnvelope.ts:1-24. The compatibility
// parser accepts any non-null, non-array JSON object before a "\n\n" suffix;
// known Super-MCP variants are exposed separately above.
export const UseToolJsonTextParserObjectSchema = UnknownRecordSchema;

export type UseToolJsonTextKnownEnvelope =
  z.infer<typeof UseToolJsonTextKnownEnvelopeSchema>;

// Derived from super-mcp/src/server.ts:113-118.
export const SuperMcpToolConfigHashResponseSchema = z.object({
  config_hash: z.string(),
  security_hash: z.string(),
  package_ids: z.array(z.string()),
  package_count: z.number(),
}).passthrough();

// Derived from super-mcp/src/server.ts:145-160.
export const SuperMcpToolManifestPackageSchema = z.object({
  package_id: z.string(),
  package_name: z.string(),
  tool_count: z.number(),
  embedding_hash: z.string(),
  status: z.string(),
}).passthrough();

export const SuperMcpToolManifestResponseSchema = z.object({
  packages: z.array(SuperMcpToolManifestPackageSchema),
  security_hash: z.string(),
  package_count: z.number(),
  generated_at: z.string(),
}).passthrough();

// Derived from super-mcp/src/server.ts:196-247 and the app's consumer type at
// src/core/services/toolIndex/toolIndexService.ts:77-92.
export const SuperMcpToolCatalogToolSchema = z.object({
  package_id: z.string(),
  package_name: z.string(),
  tool_id: z.string(),
  name: z.string(),
  description: z.string(),
  summary: z.string().optional(),
  input_schema: z.unknown().optional(),
  annotations: UnknownRecordSchema.optional(),
}).passthrough();

// CONSUMER-TOLERANT (older Super-MCP versions may omit the count/hash fields).
export const SuperMcpToolCatalogResponseSchema = z.object({
  tools: z.array(SuperMcpToolCatalogToolSchema),
  etag: z.string(),
  tool_count: z.number().optional(),
  package_count: z.number().optional(),
  package_hashes: z.record(z.string(), z.string()).optional(),
  user_disabled_count: z.number().optional(),
  admin_disabled_count: z.number().optional(),
  generated_at: z.string().optional(),
}).passthrough();

// PRODUCER-STRICT — current `/api/tools` ALWAYS emits all of these
// (super-mcp/src/server.ts:237-247). `package_hashes` in particular drives the
// app's package-refresh/cache correctness (toolIndexService.ts:682-691,
// :1146-1196), so a producer that stopped emitting it must fail conformance.
// (Stage-1 review F2.)
export const SuperMcpToolCatalogResponseProducerSchema = z.object({
  tools: z.array(SuperMcpToolCatalogToolSchema),
  etag: z.string(),
  tool_count: z.number(),
  package_count: z.number(),
  package_hashes: z.record(z.string(), z.string()),
  user_disabled_count: z.number(),
  admin_disabled_count: z.number(),
  generated_at: z.string(),
}).passthrough();

// Derived from super-mcp/src/server.ts:256-257 and consumer parsing at
// src/core/services/superMcpHttpManager.ts:2790-2796.
// CONSUMER-TOLERANT (older versions / 404 fallback).
export const SuperMcpSkippedServersResponseSchema = z.object({
  packages: z.array(z.object({
    id: z.string(),
    reason: z.string(),
  }).passthrough()).optional(),
}).passthrough();

// PRODUCER-STRICT — current `/api/skipped-servers` ALWAYS emits `{ packages }`
// of `SkippedPackage { id, reason }` (super-mcp/src/server.ts:256-257,
// super-mcp/src/types.ts:94-97). (Stage-1 review F2.)
export const SuperMcpSkippedServersResponseProducerSchema = z.object({
  packages: z.array(z.object({
    id: z.string(),
    reason: z.string(),
  }).passthrough()),
}).passthrough();

export interface SuperMcpAppExpectationManifest {
  schemaVersion: 1;
  rest: {
    endpoints: readonly SuperMcpRestEndpoint[];
    toolIndexEndpoints: readonly SuperMcpRestEndpoint[];
  };
  metaTools: {
    all: readonly SuperMcpMetaTool[];
    readOnlyRetryable: readonly SuperMcpReadOnlyMetaTool[];
  };
  useToolEnvelope: {
    version: 1;
    outerMetaAllowlist: readonly SuperMcpOuterMetaAllowedNamespace[];
    supportsStructuredContent: true;
    supportsJsonInTextCompatibility: true;
    bypassFlags: readonly ['staged', 'dryRun', 'continuation'];
    superMcpTelemetryFields: readonly [
      'packageId',
      'toolId',
      'durationMs',
      'outputChars',
      'truncated',
      'resultId',
      'dryRun',
      'continuation',
      'staged',
      'normalisations',
      'packageResolution',
      'toolResolution',
    ];
  };
  runtime: {
    httpConfigType: 'http';
    restartReasons: readonly SuperMcpRestartReason[];
    diagnosticTransitionReasons: readonly SuperMcpDiagnosticTransitionReason[];
    spawnArgvFlags: readonly SuperMcpSpawnArgvFlag[];
    spawnEnvKeys: readonly SuperMcpSpawnEnvKey[];
    bridgeStateEnvKeys: readonly SuperMcpBridgeStateEnvKey[];
  };
}

// App-owned expectation manifest for Stage 4 startup checks and a future
// Super-MCP /capabilities endpoint. Values are current app expectations, not a
// live probe, so importing this has no side effects.
export const SUPER_MCP_APP_EXPECTATION_MANIFEST = {
  schemaVersion: 1,
  rest: {
    endpoints: [
      SUPER_MCP_REST_ENDPOINTS.TOOLS,
      SUPER_MCP_REST_ENDPOINTS.TOOLS_SELECTED_PACKAGES,
      SUPER_MCP_REST_ENDPOINTS.TOOLS_CONFIG_HASH,
      SUPER_MCP_REST_ENDPOINTS.TOOLS_MANIFEST,
      SUPER_MCP_REST_ENDPOINTS.SKIPPED_SERVERS,
      SUPER_MCP_REST_ENDPOINTS.STATS,
    ],
    toolIndexEndpoints: [
      SUPER_MCP_REST_ENDPOINTS.TOOLS,
      SUPER_MCP_REST_ENDPOINTS.TOOLS_SELECTED_PACKAGES,
      SUPER_MCP_REST_ENDPOINTS.TOOLS_CONFIG_HASH,
      SUPER_MCP_REST_ENDPOINTS.TOOLS_MANIFEST,
    ],
  },
  metaTools: {
    all: Object.values(SUPER_MCP_META_TOOLS),
    readOnlyRetryable: SUPER_MCP_READ_ONLY_META_TOOLS,
  },
  useToolEnvelope: {
    version: 1,
    outerMetaAllowlist: SUPER_MCP_OUTER_META_ALLOWED_NAMESPACES,
    supportsStructuredContent: true,
    supportsJsonInTextCompatibility: true,
    bypassFlags: ['staged', 'dryRun', 'continuation'],
    superMcpTelemetryFields: [
      'packageId',
      'toolId',
      'durationMs',
      'outputChars',
      'truncated',
      'resultId',
      'dryRun',
      'continuation',
      'staged',
      'normalisations',
      'packageResolution',
      'toolResolution',
    ],
  },
  runtime: {
    httpConfigType: 'http',
    restartReasons: SUPER_MCP_RESTART_REASONS,
    diagnosticTransitionReasons: SUPER_MCP_DIAGNOSTIC_TRANSITION_REASONS,
    spawnArgvFlags: Object.values(SUPER_MCP_SPAWN_ARGV_FLAGS),
    spawnEnvKeys: Object.values(SUPER_MCP_SPAWN_ENV_KEYS),
    bridgeStateEnvKeys: SUPER_MCP_BRIDGE_STATE_ENV_KEYS,
  },
} as const satisfies SuperMcpAppExpectationManifest;
