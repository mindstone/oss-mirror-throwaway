import { z } from 'zod';

export const ChangelogEntryIpcSchema = z.object({
  version: z.string(),
  date: z.string(),
  author: z.string(),
  summary: z.string(),
});
export type ChangelogEntryIpc = z.infer<typeof ChangelogEntryIpcSchema>;

export const PluginPermissionIpcSchema = z.enum([
  'conversations:read',
  'conversations:transcript',
  'conversations:write',
  'memory:read',
  'skills:read',
  'skills:write',
  'automations:create',
  'entities:read',
  'external-fetch',
]);
export type PluginPermissionIpc = z.infer<typeof PluginPermissionIpcSchema>;

export const PluginManifestIpcSchema = z.object({
  id: z
    .string()
    .regex(/^(?:__)?[a-z0-9-]+$/, 'Plugin ID must be lowercase alphanumeric with hyphens (optional __ prefix)'),
  name: z.string().min(1),
  description: z.string().optional(),
  documentation: z.string().optional(),
  version: z.string().default('0.1.0'),
  icon: z.string().optional(),
  entryPoint: z.string().min(1),
  maturity: z.enum(['labs', 'stable']).default('labs'),
  /** Tracks which catalog plugin this was forked from */
  forkedFrom: z.string().optional(),
  /** Author identifier (e.g. first name or email hash) — local-only metadata */
  createdBy: z.string().optional(),
  /** Version history with author attribution */
  changelog: z.array(ChangelogEntryIpcSchema).optional(),
  /** List of contributor identifiers */
  contributors: z.array(z.string()).optional(),
  /** ISO timestamp when plugin was archived — if set, plugin is hidden from active lists */
  archivedAt: z.string().optional(),
  permissions: z.array(PluginPermissionIpcSchema).optional(),
  externalDomains: z.array(z.string()).optional(),
  /** Controls where plugin data is stored. 'local' = per-user, 'shared' = in Space directory. Default: 'local'. Independent of where plugin code lives. */
  storageScope: z.enum(['local', 'shared']).default('local').optional(),
  /**
   * Discovery role within a Space. 'hero' marks a plugin as the marquee/featured
   * plugin for its Space (sorted first in the Library Plugins lens with a Hero badge).
   * 'utility' (default) is the standard role for everything else.
   * Discovery/sort signal only — does NOT change render placement, surfaces, or permissions.
   * See docs/plans/260521_plugin_publishing_org_distribution.md (Stage A0).
   */
  role: z.enum(['hero', 'utility']).default('utility'),
  surfaces: z.object({
    sidebar: z.object({ enabled: z.boolean() }).optional(),
    homepageWidget: z.object({
      enabled: z.boolean(),
      defaultSize: z.enum(['small', 'medium', 'large']).optional(),
    }).optional(),
  }).optional(),
});
export type PluginManifestIpc = z.infer<typeof PluginManifestIpcSchema>;

export const PersistedPluginSchema = z.object({
  manifest: PluginManifestIpcSchema,
  source: z.string(),
});
export type PersistedPlugin = z.infer<typeof PersistedPluginSchema>;

export const PluginToolErrorSchema = z.object({
  type: z.string(),
  message: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().nonnegative().optional(),
  snippet: z.string().optional(),
});
export type PluginToolError = z.infer<typeof PluginToolErrorSchema>;

export const PluginToolWarningSchema = z.object({
  message: z.string(),
  type: z.string(),
});
export type PluginToolWarning = z.infer<typeof PluginToolWarningSchema>;

export const CompileAndRegisterPluginRequestSchema = z.object({
  manifest: PluginManifestIpcSchema,
  source: z.string(),
});
export type CompileAndRegisterPluginRequest = z.infer<typeof CompileAndRegisterPluginRequestSchema>;

export const PluginCrashRecordSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  componentStack: z.string().optional(),
  timestamp: z.number(),
});
export type PluginCrashRecordIpc = z.infer<typeof PluginCrashRecordSchema>;

export const CompileAndRegisterPluginResponseSchema = z.object({
  ok: z.boolean(),
  errors: z.array(PluginToolErrorSchema).optional(),
  warnings: z.array(PluginToolWarningSchema).optional(),
  previousCrashes: z.array(PluginCrashRecordSchema).optional(),
});
export type CompileAndRegisterPluginResponse = z.infer<typeof CompileAndRegisterPluginResponseSchema>;

export const PersistAllPluginsRequestSchema = z.object({
  plugins: z.array(PersistedPluginSchema),
});
export type PersistAllPluginsRequest = z.infer<typeof PersistAllPluginsRequestSchema>;

export const PersistAllPluginsResponseSchema = z.object({
  success: z.boolean(),
});
export type PersistAllPluginsResponse = z.infer<typeof PersistAllPluginsResponseSchema>;

export const LoadPersistedPluginsResponseSchema = z.object({
  plugins: z.array(PersistedPluginSchema),
});
export type LoadPersistedPluginsResponse = z.infer<typeof LoadPersistedPluginsResponseSchema>;

export const ClearPersistedPluginsResponseSchema = z.object({
  success: z.boolean(),
});
export type ClearPersistedPluginsResponse = z.infer<typeof ClearPersistedPluginsResponseSchema>;

// ── Plugin Storage (per-plugin key-value persistence) ───────────────────

export const PluginStorageGetRequestSchema = z.object({
  pluginId: z.string(),
  key: z.string(),
});
export type PluginStorageGetRequest = z.infer<typeof PluginStorageGetRequestSchema>;

export const PluginStorageGetResponseSchema = z.object({
  value: z.unknown(),
});
export type PluginStorageGetResponse = z.infer<typeof PluginStorageGetResponseSchema>;

export const PluginStorageSetRequestSchema = z.object({
  pluginId: z.string(),
  key: z.string(),
  value: z.unknown(),
});
export type PluginStorageSetRequest = z.infer<typeof PluginStorageSetRequestSchema>;

export const PluginStorageSetResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type PluginStorageSetResponse = z.infer<typeof PluginStorageSetResponseSchema>;

export const PluginStorageDeleteRequestSchema = z.object({
  pluginId: z.string(),
  key: z.string(),
});
export type PluginStorageDeleteRequest = z.infer<typeof PluginStorageDeleteRequestSchema>;

export const PluginStorageDeleteResponseSchema = z.object({
  success: z.boolean(),
});
export type PluginStorageDeleteResponse = z.infer<typeof PluginStorageDeleteResponseSchema>;

export const PluginStorageClearRequestSchema = z.object({
  pluginId: z.string(),
});
export type PluginStorageClearRequest = z.infer<typeof PluginStorageClearRequestSchema>;

export const PluginStorageClearResponseSchema = z.object({
  success: z.boolean(),
});
export type PluginStorageClearResponse = z.infer<typeof PluginStorageClearResponseSchema>;

// ── Plugin Storage Usage (query per-plugin storage consumption) ──────────────

export const PluginStorageUsageRequestSchema = z.object({
  pluginId: z.string(),
});
export type PluginStorageUsageRequest = z.infer<typeof PluginStorageUsageRequestSchema>;

export const PluginStorageUsageResponseSchema = z.object({
  usedBytes: z.number(),
  quotaBytes: z.number(),
  percentUsed: z.number(),
});
export type PluginStorageUsageResponse = z.infer<typeof PluginStorageUsageResponseSchema>;

// ── Plugin Data Export/Import (per-plugin storage data as JSON) ──────────────

export const PluginExportDataRequestSchema = z.object({
  pluginId: z.string(),
});
export type PluginExportDataRequest = z.infer<typeof PluginExportDataRequestSchema>;

export const PluginExportDataResponseSchema = z.object({
  ok: z.boolean(),
  filePath: z.string().optional(),
  error: z.string().optional(),
});
export type PluginExportDataResponse = z.infer<typeof PluginExportDataResponseSchema>;

export const PluginImportDataRequestSchema = z.object({
  pluginId: z.string(),
});
export type PluginImportDataRequest = z.infer<typeof PluginImportDataRequestSchema>;

export const PluginImportDataResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type PluginImportDataResponse = z.infer<typeof PluginImportDataResponseSchema>;

// ── Plugin Data Backup/Restore (automatic pre-update backup) ────────────────

export const PluginRestoreDataBackupRequestSchema = z.object({
  pluginId: z.string(),
});
export type PluginRestoreDataBackupRequest = z.infer<typeof PluginRestoreDataBackupRequestSchema>;

export const PluginRestoreDataBackupResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type PluginRestoreDataBackupResponse = z.infer<typeof PluginRestoreDataBackupResponseSchema>;

export const PluginHasDataBackupRequestSchema = z.object({
  pluginId: z.string(),
});
export type PluginHasDataBackupRequest = z.infer<typeof PluginHasDataBackupRequestSchema>;

export const PluginHasDataBackupResponseSchema = z.object({
  hasBackup: z.boolean(),
});
export type PluginHasDataBackupResponse = z.infer<typeof PluginHasDataBackupResponseSchema>;

// ── Plugin Memory Search (workspace file search for plugins) ────────────────

export const PluginMemorySearchRequestSchema = z.object({
  pluginId: z.string().min(1),
  query: z.string(),
  limit: z.number().min(1).max(50).optional().default(10),
  pathPrefix: z.string().optional(),
});
export type PluginMemorySearchRequest = z.infer<typeof PluginMemorySearchRequestSchema>;

export const PluginMemorySearchResultItemSchema = z.object({
  filePath: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
});
export type PluginMemorySearchResultItem = z.infer<typeof PluginMemorySearchResultItemSchema>;

export const PluginMemorySearchResponseSchema = z.object({
  results: z.array(PluginMemorySearchResultItemSchema),
  status: z.enum(['ok', 'index_not_ready', 'embedding_not_ready', 'error']).default('ok'),
  message: z.string().optional(),
});
export type PluginMemorySearchResponse = z.infer<typeof PluginMemorySearchResponseSchema>;

// ── Plugin Source Search (structured source metadata search) ────────────────

export const PluginSearchSourcesRequestSchema = z.object({
  pluginId: z.string().min(1),
  query: z.string().optional(),
  sourceTypes: z.array(z.string()).optional(),
  participants: z.array(z.string()).optional(),
  dateRange: z.object({
    after: z.string().optional(),
    before: z.string().optional(),
  }).optional(),
  limit: z.number().min(1).max(50).optional().default(20),
});
export type PluginSearchSourcesRequest = z.infer<typeof PluginSearchSourcesRequestSchema>;

export const PluginSourceEntrySchema = z.object({
  relativePath: z.string(),
  title: z.string(),
  sourceType: z.string(),
  sourceSystem: z.string(),
  occurredAt: z.string(),
  participants: z.array(z.string()),
  summary: z.string(),
  keyTakeaways: z.array(z.string()),
  durationMinutes: z.number().optional(),
  description: z.string(),
  sourceUrl: z.string().optional(),
  relevanceScore: z.number().optional(),
});
export type PluginSourceEntry = z.infer<typeof PluginSourceEntrySchema>;

export const PluginSearchSourcesResponseSchema = z.object({
  sources: z.array(PluginSourceEntrySchema),
  totalCount: z.number(),
});
export type PluginSearchSourcesResponse = z.infer<typeof PluginSearchSourcesResponseSchema>;

// ── Plugin Source Document (read a single source document) ──────────────────

export const PluginGetSourceDocumentRequestSchema = z.object({
  pluginId: z.string().min(1),
  relativePath: z.string(),
});
export type PluginGetSourceDocumentRequest = z.infer<typeof PluginGetSourceDocumentRequestSchema>;

export const PluginSourceDocumentSchema = z.object({
  relativePath: z.string(),
  title: z.string(),
  sourceType: z.string(),
  sourceSystem: z.string(),
  occurredAt: z.string(),
  storedAt: z.string(),
  participants: z.array(z.string()),
  summary: z.string(),
  keyTakeaways: z.array(z.string()),
  durationMinutes: z.number().optional(),
  truncated: z.boolean(),
  description: z.string(),
  sourceUrl: z.string().optional(),
  content: z.string(),
});
export type PluginSourceDocument = z.infer<typeof PluginSourceDocumentSchema>;

export const PluginGetSourceDocumentResponseSchema = z.object({
  document: PluginSourceDocumentSchema.nullable(),
});
export type PluginGetSourceDocumentResponse = z.infer<typeof PluginGetSourceDocumentResponseSchema>;

// ── Plugin Topics (memory/topics access) ────────────────────────────────

export const PluginListTopicsRequestSchema = z.object({
  pluginId: z.string().min(1),
  query: z.string().optional(),
  spacePath: z.string().optional(),
  limit: z.number().min(1).max(50).optional().default(20),
});
export type PluginListTopicsRequest = z.infer<typeof PluginListTopicsRequestSchema>;

export const PluginTopicEntrySchema = z.object({
  relativePath: z.string(),
  title: z.string(),
  spacePath: z.string(),
  updatedAt: z.string(),
});
export type PluginTopicEntry = z.infer<typeof PluginTopicEntrySchema>;

export const PluginListTopicsResponseSchema = z.object({
  topics: z.array(PluginTopicEntrySchema),
});
export type PluginListTopicsResponse = z.infer<typeof PluginListTopicsResponseSchema>;

export const PluginReadTopicRequestSchema = z.object({
  pluginId: z.string().min(1),
  relativePath: z.string(),
});
export type PluginReadTopicRequest = z.infer<typeof PluginReadTopicRequestSchema>;

export const PluginReadTopicResponseSchema = z.object({
  content: z.string().nullable(),
});
export type PluginReadTopicResponse = z.infer<typeof PluginReadTopicResponseSchema>;

export const PluginGetEntitiesRequestSchema = z.object({
  pluginId: z.string().min(1),
  entityType: z.enum(['person', 'company']).optional(),
  query: z.string().optional(),
  company: z.string().optional(),
  limit: z.number().min(1).max(50).optional().default(20),
});
export type PluginGetEntitiesRequest = z.infer<typeof PluginGetEntitiesRequestSchema>;

export const PluginEntityEntrySchema = z.object({
  canonicalName: z.string(),
  entityType: z.enum(['person', 'company']),
  emails: z.array(z.string()),
  company: z.string().optional(),
  role: z.string().optional(),
  domain: z.string().optional(),
  aliases: z.array(z.string()),
});
export type PluginEntityEntry = z.infer<typeof PluginEntityEntrySchema>;

export const PluginGetEntitiesResponseSchema = z.object({
  entities: z.array(PluginEntityEntrySchema),
});
export type PluginGetEntitiesResponse = z.infer<typeof PluginGetEntitiesResponseSchema>;

export const PluginReadSkillRequestSchema = z.object({
  pluginId: z.string().min(1),
  relativePath: z.string(),
});
export type PluginReadSkillRequest = z.infer<typeof PluginReadSkillRequestSchema>;

export const PluginReadSkillResponseSchema = z.object({
  content: z.string().nullable(),
  frontmatter: z.record(z.string(), z.unknown()).nullable(),
});
export type PluginReadSkillResponse = z.infer<typeof PluginReadSkillResponseSchema>;

export const PluginWriteSkillRequestSchema = z.object({
  pluginId: z.string().min(1),
  relativePath: z.string().min(1),
  content: z.string(),
  baseContentHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});
export type PluginWriteSkillRequest = z.infer<typeof PluginWriteSkillRequestSchema>;

export const PluginWriteSkillResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  conflict: z.boolean().optional(),
  currentHash: z.string().optional(),
});
export type PluginWriteSkillResponse = z.infer<typeof PluginWriteSkillResponseSchema>;

// ── Plugin Pre-Turn Contexts (system prompt injection) ─────────────────

export const PluginPreTurnContextSchema = z.object({
  pluginId: z.string(),
  pluginName: z.string(),
  content: z.string().max(2_000),
  priority: z.number().int(),
});
export type PluginPreTurnContext = z.infer<typeof PluginPreTurnContextSchema>;

export const PluginGetContextsRequestSchema = z.object({
  /**
   * Optional push payload from renderer.
   * If provided, main process stores this snapshot for subsequent turns.
   */
  contexts: z.array(PluginPreTurnContextSchema).optional(),
});
export type PluginGetContextsRequest = z.infer<typeof PluginGetContextsRequestSchema>;

export const PluginGetContextsResponseSchema = z.object({
  contexts: z.array(PluginPreTurnContextSchema),
});
export type PluginGetContextsResponse = z.infer<typeof PluginGetContextsResponseSchema>;

// ── Plugin AI Operations (behind-the-scenes LLM access) ────────────────

export const PluginAiSummarizeRequestSchema = z.object({
  pluginId: z.string().min(1),
  text: z.string().min(1).max(5000),
  maxLength: z.number().min(1).max(500).optional(),
});
export type PluginAiSummarizeRequest = z.infer<typeof PluginAiSummarizeRequestSchema>;

export const PluginAiSummarizeResponseSchema = z.object({
  summary: z.string(),
});
export type PluginAiSummarizeResponse = z.infer<typeof PluginAiSummarizeResponseSchema>;

export const PluginAiExtractRequestSchema = z.object({
  pluginId: z.string().min(1),
  text: z.string().min(1).max(5000),
  schema: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    properties: z.record(z.string(), z.unknown()),
  }),
});
export type PluginAiExtractRequest = z.infer<typeof PluginAiExtractRequestSchema>;

export const PluginAiExtractResponseSchema = z.object({
  result: z.unknown(),
});
export type PluginAiExtractResponse = z.infer<typeof PluginAiExtractResponseSchema>;

export const PluginAiGenerateRequestSchema = z.object({
  pluginId: z.string().min(1),
  prompt: z.string().min(1).max(2000),
  maxTokens: z.number().min(1).max(1000).optional(),
});
export type PluginAiGenerateRequest = z.infer<typeof PluginAiGenerateRequestSchema>;

export const PluginAiGenerateResponseSchema = z.object({
  text: z.string(),
});
export type PluginAiGenerateResponse = z.infer<typeof PluginAiGenerateResponseSchema>;

// ── Plugin Calendar/Meetings (plugin-safe meeting cache access) ─────────

export const PluginGetMeetingsRequestSchema = z.object({
  pluginId: z.string().min(1),
  todayOnly: z.boolean().optional(),
});
export type PluginGetMeetingsRequest = z.infer<typeof PluginGetMeetingsRequestSchema>;

export const PluginMeetingSchema = z.object({
  id: z.string(),
  title: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  participants: z.array(z.string()),
  meetingUrl: z.string().optional(),
});
export type PluginMeeting = z.infer<typeof PluginMeetingSchema>;

export const PluginGetMeetingsResponseSchema = z.object({
  meetings: z.array(PluginMeetingSchema),
  isStale: z.boolean(),
});
export type PluginGetMeetingsResponse = z.infer<typeof PluginGetMeetingsResponseSchema>;

// ── Space Plugin Discovery ──────────────────────────────────────────────

export const SpacePluginInfoSchema = z.object({
  pluginId: z.string(),
  manifest: PluginManifestIpcSchema,
  source: z.string(),
  spaceName: z.string(),
  spacePath: z.string(),
});
export type SpacePluginInfo = z.infer<typeof SpacePluginInfoSchema>;

export const PluginConflictSchema = z.object({
  pluginId: z.string(),
  conflictFiles: z.array(z.string()),
  spacePath: z.string(),
});
export type PluginConflict = z.infer<typeof PluginConflictSchema>;

export const ScanSpacePluginsResponseSchema = z.object({
  plugins: z.array(SpacePluginInfoSchema),
  conflicts: z.array(PluginConflictSchema),
});
export type ScanSpacePluginsResponse = z.infer<typeof ScanSpacePluginsResponseSchema>;

export const ExportPluginToSpaceRequestSchema = z.object({
  pluginId: z.string(),
  spacePath: z.string(),
  /**
   * Optional role override applied during publish. When omitted, the plugin keeps
   * the role currently in its manifest (defaulting to 'utility' when undefined).
   * See docs/plans/260521_plugin_publishing_org_distribution.md (Stage A2).
   */
  role: z.enum(['hero', 'utility']).optional(),
});
export type ExportPluginToSpaceRequest = z.infer<typeof ExportPluginToSpaceRequestSchema>;

export const ExportPluginToSpaceResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  exportedPath: z.string().optional(),
});
export type ExportPluginToSpaceResponse = z.infer<typeof ExportPluginToSpaceResponseSchema>;

export const ResolvePluginConflictRequestSchema = z.object({
  pluginId: z.string(),
  spacePath: z.string(),
  resolution: z.enum(['keep-mine', 'keep-theirs']),
});
export type ResolvePluginConflictRequest = z.infer<typeof ResolvePluginConflictRequestSchema>;

export const ResolvePluginConflictResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export type ResolvePluginConflictResponse = z.infer<typeof ResolvePluginConflictResponseSchema>;

export const RebelMergeRequestSchema = z.object({
  pluginId: z.string(),
  spacePath: z.string(),
});
export type RebelMergeRequest = z.infer<typeof RebelMergeRequestSchema>;

export const RebelMergeResponseSchema = z.object({
  success: z.boolean(),
  mergedManifest: z.record(z.string(), z.unknown()).optional(),
  mergedSource: z.string().optional(),
  error: z.string().optional(),
});
export type RebelMergeResponse = z.infer<typeof RebelMergeResponseSchema>;

export const AcceptMergeRequestSchema = z.object({
  pluginId: z.string(),
  spacePath: z.string(),
  mergedManifest: z.record(z.string(), z.unknown()),
  mergedSource: z.string(),
});
export type AcceptMergeRequest = z.infer<typeof AcceptMergeRequestSchema>;

export const AcceptMergeResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export type AcceptMergeResponse = z.infer<typeof AcceptMergeResponseSchema>;

// ── Space Plugin Activation Persistence ────────────────────────────────

export const ActivatedPluginIdsResponseSchema = z.object({
  pluginIds: z.array(z.string()),
});
export type ActivatedPluginIdsResponse = z.infer<typeof ActivatedPluginIdsResponseSchema>;

export const PluginActivationMutationRequestSchema = z.object({
  pluginId: z.string(),
});
export type PluginActivationMutationRequest = z.infer<typeof PluginActivationMutationRequestSchema>;

export const PluginActivationMutationResponseSchema = z.object({
  success: z.boolean(),
});
export type PluginActivationMutationResponse = z.infer<typeof PluginActivationMutationResponseSchema>;

export const PluginReadmeIndexRequestSchema = z.object({
  pluginId: z.string(),
  spacePath: z.string(),
});
export type PluginReadmeIndexRequest = z.infer<typeof PluginReadmeIndexRequestSchema>;

export const PluginReadmeIndexResponseSchema = z.object({
  success: z.boolean(),
});
export type PluginReadmeIndexResponse = z.infer<typeof PluginReadmeIndexResponseSchema>;

export const PluginReadmeDeindexRequestSchema = z.object({
  pluginId: z.string(),
  spacePath: z.string(),
});
export type PluginReadmeDeindexRequest = z.infer<typeof PluginReadmeDeindexRequestSchema>;

export const PluginReadmeDeindexResponseSchema = z.object({
  success: z.boolean(),
});
export type PluginReadmeDeindexResponse = z.infer<typeof PluginReadmeDeindexResponseSchema>;

// ── Plugin Deletion (Space plugin file removal) ─────────────────────────

export const DeletePluginFromSpaceRequestSchema = z.object({
  pluginId: z.string(),
  spacePath: z.string(),
});
export type DeletePluginFromSpaceRequest = z.infer<typeof DeletePluginFromSpaceRequestSchema>;

export const DeletePluginFromSpaceResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export type DeletePluginFromSpaceResponse = z.infer<typeof DeletePluginFromSpaceResponseSchema>;

// ── Plugin Migration (electron-store → Chief-of-Staff) ──────────────────

export const MigratePluginsToSpaceResponseSchema = z.object({
  migrated: z.number(),
  skipped: z.number(),
  failed: z.number(),
});
export type MigratePluginsToSpaceResponse = z.infer<typeof MigratePluginsToSpaceResponseSchema>;

// ── Bundled Plugins Seed ────────────────────────────────────────────────

export const SeedBundledPluginsRequestSchema = z.object({
  alreadySeededIds: z.array(z.string()),
});
export type SeedBundledPluginsRequest = z.infer<typeof SeedBundledPluginsRequestSchema>;

export const SeedBundledPluginsResponseSchema = z.object({
  seeded: z.array(z.string()),
  skipped: z.array(z.string()),
  failed: z.array(z.string()),
  malformed: z.array(z.string()),
});
export type SeedBundledPluginsResponse = z.infer<typeof SeedBundledPluginsResponseSchema>;

// ── Plugin Conversation Actions (send message / start conversation) ─────

export const PluginSendMessageRequestSchema = z.object({
  pluginId: z.string().min(1),
  sessionId: z.string().min(1),
  message: z.string().min(1).max(10_000),
});
export type PluginSendMessageRequest = z.infer<typeof PluginSendMessageRequestSchema>;

const PluginWriteErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export const PluginSendMessageResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
  }),
  PluginWriteErrorResponseSchema,
]);
export type PluginSendMessageResponse = z.infer<typeof PluginSendMessageResponseSchema>;

export const PluginStartConversationRequestSchema = z.object({
  pluginId: z.string().min(1),
  message: z.string().min(1).max(10_000),
});
export type PluginStartConversationRequest = z.infer<typeof PluginStartConversationRequestSchema>;

export const PluginStartConversationResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    sessionId: z.string(),
  }),
  PluginWriteErrorResponseSchema,
]);
export type PluginStartConversationResponse = z.infer<typeof PluginStartConversationResponseSchema>;

// ── Plugin Inbox Actions (create/list inbox items) ─────────────────────

export const PluginInboxPrioritySchema = z.enum(['low', 'medium', 'high']);
export type PluginInboxPriority = z.infer<typeof PluginInboxPrioritySchema>;

export const PluginInboxAddInputSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(10_000).optional(),
  priority: PluginInboxPrioritySchema.optional(),
  actionPrompt: z.string().trim().min(1).max(10_000).optional(),
});
export type PluginInboxAddInput = z.infer<typeof PluginInboxAddInputSchema>;

export const PluginInboxAddRequestSchema = z.object({
  pluginId: z.string().min(1),
  item: PluginInboxAddInputSchema,
});
export type PluginInboxAddRequest = z.infer<typeof PluginInboxAddRequestSchema>;

export const PluginInboxAddResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    itemId: z.string().uuid(),
  }),
  PluginWriteErrorResponseSchema,
]);
export type PluginInboxAddResponse = z.infer<typeof PluginInboxAddResponseSchema>;

export const PluginInboxListRequestSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
});
export type PluginInboxListRequest = z.infer<typeof PluginInboxListRequestSchema>;

export const PluginInboxItemSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  priority: PluginInboxPrioritySchema,
  actionPrompt: z.string().optional(),
  pluginId: z.string().optional(),
  createdAt: z.number(),
  archived: z.boolean(),
});
export type PluginInboxItem = z.infer<typeof PluginInboxItemSchema>;

export const PluginInboxListResponseSchema = z.object({
  items: z.array(PluginInboxItemSchema),
});
export type PluginInboxListResponse = z.infer<typeof PluginInboxListResponseSchema>;

// ── Plugin Conversation Transcript ──────────────────────────────────────

export const TranscriptMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  timestamp: z.string(),
  toolsUsed: z.array(z.string()).optional(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export const PluginGetTranscriptRequestSchema = z.object({
  pluginId: z.string().min(1),
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(100),
});
export type PluginGetTranscriptRequest = z.infer<typeof PluginGetTranscriptRequestSchema>;

export const PluginGetTranscriptResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    messages: z.array(TranscriptMessageSchema),
    state: z.enum(['ok', 'not_found', 'redacted']).default('ok'),
  }),
  PluginWriteErrorResponseSchema,
]);
export type PluginGetTranscriptResponse = z.infer<typeof PluginGetTranscriptResponseSchema>;

// ── Plugin External Fetch (mediated HTTP requests) ──────────────────────

// ── Plugin Automation Actions (create/list automations) ──────────────────

export const PluginAutomationScheduleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('interval'),
    value: z.string().regex(/^\d+[mhd]$/, 'Interval must be like "30m", "1h", or "1d"'),
  }),
  z.object({
    type: z.literal('cron'),
    value: z.string().min(1),
  }),
]);
export type PluginAutomationSchedule = z.infer<typeof PluginAutomationScheduleSchema>;

export const PluginCreateAutomationRequestSchema = z.object({
  pluginId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  skillContent: z.string().min(1).max(50_000),
  schedule: PluginAutomationScheduleSchema,
  enabled: z.boolean().optional().default(false),
});
export type PluginCreateAutomationRequest = z.infer<typeof PluginCreateAutomationRequestSchema>;

export const PluginCreateAutomationResponseSchema = z.object({
  automationId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type PluginCreateAutomationResponse = z.infer<typeof PluginCreateAutomationResponseSchema>;

export const PluginListAutomationsRequestSchema = z.object({
  pluginId: z.string().min(1).optional(),
});
export type PluginListAutomationsRequest = z.infer<typeof PluginListAutomationsRequestSchema>;

export const PluginAutomationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  schedule: z.object({
    type: z.string(),
    value: z.string().optional(),
  }),
  enabled: z.boolean(),
  lastRunAt: z.number().nullable().optional(),
  lastRunStatus: z.string().optional(),
  nextRunAt: z.number().nullable().optional(),
  pluginId: z.string().optional(),
});
export type PluginAutomationSummary = z.infer<typeof PluginAutomationSummarySchema>;

export const PluginListAutomationsResponseSchema = z.object({
  automations: z.array(PluginAutomationSummarySchema),
});
export type PluginListAutomationsResponse = z.infer<typeof PluginListAutomationsResponseSchema>;

export const PluginExternalFetchRequestSchema = z.object({
  pluginId: z.string().min(1),
  url: z.string().min(1),
  method: z.literal('GET').default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
});
export type PluginExternalFetchRequest = z.infer<typeof PluginExternalFetchRequestSchema>;

export const PluginExternalFetchResponseSchema = z.object({
  ok: z.boolean(),
  status: z.number(),
  data: z.unknown(),
  error: z.string().optional(),
});
export type PluginExternalFetchResponse = z.infer<typeof PluginExternalFetchResponseSchema>;
