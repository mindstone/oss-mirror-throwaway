import { z } from 'zod';
import {
  defineInvokeChannel,
  CompileAndRegisterPluginRequestSchema,
  CompileAndRegisterPluginResponseSchema,
  PersistAllPluginsRequestSchema,
  PersistAllPluginsResponseSchema,
  LoadPersistedPluginsResponseSchema,
  ClearPersistedPluginsResponseSchema,
  PluginStorageGetRequestSchema,
  PluginStorageGetResponseSchema,
  PluginStorageSetRequestSchema,
  PluginStorageSetResponseSchema,
  PluginStorageDeleteRequestSchema,
  PluginStorageDeleteResponseSchema,
  PluginStorageClearRequestSchema,
  PluginStorageClearResponseSchema,
  PluginStorageUsageRequestSchema,
  PluginStorageUsageResponseSchema,
  PluginExportDataRequestSchema,
  PluginExportDataResponseSchema,
  PluginImportDataRequestSchema,
  PluginImportDataResponseSchema,
  PluginRestoreDataBackupRequestSchema,
  PluginRestoreDataBackupResponseSchema,
  PluginHasDataBackupRequestSchema,
  PluginHasDataBackupResponseSchema,
  PluginExportRequestSchema,
  PluginExportResultSchema,
  PluginImportResultSchema,
  PluginMemorySearchRequestSchema,
  PluginMemorySearchResponseSchema,
  PluginSearchSourcesRequestSchema,
  PluginSearchSourcesResponseSchema,
  PluginGetSourceDocumentRequestSchema,
  PluginGetSourceDocumentResponseSchema,
  PluginListTopicsRequestSchema,
  PluginListTopicsResponseSchema,
  PluginReadTopicRequestSchema,
  PluginReadTopicResponseSchema,
  PluginGetEntitiesRequestSchema,
  PluginGetEntitiesResponseSchema,
  PluginReadSkillRequestSchema,
  PluginReadSkillResponseSchema,
  PluginWriteSkillRequestSchema,
  PluginWriteSkillResponseSchema,
  PluginGetContextsRequestSchema,
  PluginGetContextsResponseSchema,
  PluginAiSummarizeRequestSchema,
  PluginAiSummarizeResponseSchema,
  PluginAiExtractRequestSchema,
  PluginAiExtractResponseSchema,
  PluginAiGenerateRequestSchema,
  PluginAiGenerateResponseSchema,
  PluginGetMeetingsRequestSchema,
  PluginGetMeetingsResponseSchema,
  ScanSpacePluginsResponseSchema,
  ExportPluginToSpaceRequestSchema,
  ExportPluginToSpaceResponseSchema,
  ResolvePluginConflictRequestSchema,
  ResolvePluginConflictResponseSchema,
  RebelMergeRequestSchema,
  RebelMergeResponseSchema,
  AcceptMergeRequestSchema,
  AcceptMergeResponseSchema,
  ActivatedPluginIdsResponseSchema,
  PluginActivationMutationRequestSchema,
  PluginActivationMutationResponseSchema,
  PluginReadmeIndexRequestSchema,
  PluginReadmeIndexResponseSchema,
  PluginReadmeDeindexRequestSchema,
  PluginReadmeDeindexResponseSchema,
  MigratePluginsToSpaceResponseSchema,
  SeedBundledPluginsRequestSchema,
  SeedBundledPluginsResponseSchema,
  DeletePluginFromSpaceRequestSchema,
  DeletePluginFromSpaceResponseSchema,
  PluginSendMessageRequestSchema,
  PluginSendMessageResponseSchema,
  PluginStartConversationRequestSchema,
  PluginStartConversationResponseSchema,
  PluginGetTranscriptRequestSchema,
  PluginGetTranscriptResponseSchema,
  PluginInboxAddRequestSchema,
  PluginInboxAddResponseSchema,
  PluginInboxListRequestSchema,
  PluginInboxListResponseSchema,
  PluginExternalFetchRequestSchema,
  PluginExternalFetchResponseSchema,
  PluginCreateAutomationRequestSchema,
  PluginCreateAutomationResponseSchema,
  PluginListAutomationsRequestSchema,
  PluginListAutomationsResponseSchema,
} from '../schemas';

export const pluginsChannels = {
  'plugins:compile-and-register': defineInvokeChannel({
    channel: 'plugins:compile-and-register',
    request: CompileAndRegisterPluginRequestSchema,
    response: CompileAndRegisterPluginResponseSchema,
    description: 'Compile plugin source in renderer and register it in the plugin runtime',
  }),

  'plugins:persist-all': defineInvokeChannel({
    channel: 'plugins:persist-all',
    request: PersistAllPluginsRequestSchema,
    response: PersistAllPluginsResponseSchema,
    description: 'Persist all registered plugins (manifest + source)',
  }),

  'plugins:load-persisted': defineInvokeChannel({
    channel: 'plugins:load-persisted',
    request: z.void(),
    response: LoadPersistedPluginsResponseSchema,
    description: 'Load all persisted plugins from storage',
  }),

  'plugins:clear-persisted': defineInvokeChannel({
    channel: 'plugins:clear-persisted',
    request: z.void(),
    response: ClearPersistedPluginsResponseSchema,
    description: 'Clear all persisted plugins from storage',
  }),

  'plugins:storage-get': defineInvokeChannel({
    channel: 'plugins:storage-get',
    request: PluginStorageGetRequestSchema,
    response: PluginStorageGetResponseSchema,
    description: 'Get a value from per-plugin storage',
  }),

  'plugins:storage-set': defineInvokeChannel({
    channel: 'plugins:storage-set',
    request: PluginStorageSetRequestSchema,
    response: PluginStorageSetResponseSchema,
    description: 'Set a value in per-plugin storage (10MB quota per plugin)',
  }),

  'plugins:storage-delete': defineInvokeChannel({
    channel: 'plugins:storage-delete',
    request: PluginStorageDeleteRequestSchema,
    response: PluginStorageDeleteResponseSchema,
    description: 'Delete a value from per-plugin storage',
  }),

  'plugins:storage-clear': defineInvokeChannel({
    channel: 'plugins:storage-clear',
    request: PluginStorageClearRequestSchema,
    response: PluginStorageClearResponseSchema,
    description: 'Clear all storage for a plugin',
  }),

  'plugins:storage-usage': defineInvokeChannel({
    channel: 'plugins:storage-usage',
    request: PluginStorageUsageRequestSchema,
    response: PluginStorageUsageResponseSchema,
    description: 'Query storage usage for a plugin (bytes used, quota, percentage)',
  }),

  'plugins:export-data': defineInvokeChannel({
    channel: 'plugins:export-data',
    request: PluginExportDataRequestSchema,
    response: PluginExportDataResponseSchema,
    description: 'Export plugin storage data as a JSON file via native save dialog',
  }),

  'plugins:import-data': defineInvokeChannel({
    channel: 'plugins:import-data',
    request: PluginImportDataRequestSchema,
    response: PluginImportDataResponseSchema,
    description: 'Import plugin storage data from a JSON file via native open dialog (replaces existing data)',
  }),

  'plugins:restore-data-backup': defineInvokeChannel({
    channel: 'plugins:restore-data-backup',
    request: PluginRestoreDataBackupRequestSchema,
    response: PluginRestoreDataBackupResponseSchema,
    description: 'Restore plugin data from the automatic pre-update backup',
  }),

  'plugins:has-data-backup': defineInvokeChannel({
    channel: 'plugins:has-data-backup',
    request: PluginHasDataBackupRequestSchema,
    response: PluginHasDataBackupResponseSchema,
    description: 'Check whether a data backup exists for a plugin',
  }),

  'plugins:export-plugin': defineInvokeChannel({
    channel: 'plugins:export-plugin',
    request: PluginExportRequestSchema,
    response: PluginExportResultSchema,
    description: 'Export a plugin as a .rebel-plugin.json file via native save dialog',
  }),

  'plugins:import-plugin': defineInvokeChannel({
    channel: 'plugins:import-plugin',
    request: z.void(),
    response: PluginImportResultSchema,
    description: 'Import a plugin from a .rebel-plugin.json file via native open dialog',
  }),

  'plugins:memory-search': defineInvokeChannel({
    channel: 'plugins:memory-search',
    request: PluginMemorySearchRequestSchema,
    response: PluginMemorySearchResponseSchema,
    description: 'Search workspace files using semantic search (for plugin useMemorySearch hook)',
  }),

  'plugins:search-sources': defineInvokeChannel({
    channel: 'plugins:search-sources',
    request: PluginSearchSourcesRequestSchema,
    response: PluginSearchSourcesResponseSchema,
    description: 'Search source metadata with optional semantic query and structured filters (for plugin useSources hook)',
  }),

  'plugins:get-source-document': defineInvokeChannel({
    channel: 'plugins:get-source-document',
    request: PluginGetSourceDocumentRequestSchema,
    response: PluginGetSourceDocumentResponseSchema,
    description: 'Read a single source document by relative path, returning metadata and raw markdown content',
  }),

  'plugins:list-topics': defineInvokeChannel({
    channel: 'plugins:list-topics',
    request: PluginListTopicsRequestSchema,
    response: PluginListTopicsResponseSchema,
    description: 'List/search memory topic markdown files across configured spaces',
  }),

  'plugins:read-topic': defineInvokeChannel({
    channel: 'plugins:read-topic',
    request: PluginReadTopicRequestSchema,
    response: PluginReadTopicResponseSchema,
    description: 'Read a single memory topic markdown file (frontmatter stripped)',
  }),

  'plugins:get-entities': defineInvokeChannel({
    channel: 'plugins:get-entities',
    request: PluginGetEntitiesRequestSchema,
    response: PluginGetEntitiesResponseSchema,
    description: 'Search entity metadata (people/companies) with plugin-safe fields only',
  }),

  'plugins:read-skill': defineInvokeChannel({
    channel: 'plugins:read-skill',
    request: PluginReadSkillRequestSchema,
    response: PluginReadSkillResponseSchema,
    description: 'Read a single skill markdown file, returning frontmatter and body content',
  }),

  'plugins:write-skill': defineInvokeChannel({
    channel: 'plugins:write-skill',
    request: PluginWriteSkillRequestSchema,
    response: PluginWriteSkillResponseSchema,
    description: 'Write a shared skill markdown file with managed conflict detection and attribution',
  }),

  'plugins:get-contexts': defineInvokeChannel({
    channel: 'plugins:get-contexts',
    request: PluginGetContextsRequestSchema,
    response: PluginGetContextsResponseSchema,
    description: 'Push/read plugin pre-turn context snapshot for system prompt injection',
  }),

  'plugins:ai-summarize': defineInvokeChannel({
    channel: 'plugins:ai-summarize',
    request: PluginAiSummarizeRequestSchema,
    response: PluginAiSummarizeResponseSchema,
    description: 'Summarize text using behind-the-scenes LLM (rate-limited, for plugin useAi hook)',
  }),

  'plugins:ai-extract': defineInvokeChannel({
    channel: 'plugins:ai-extract',
    request: PluginAiExtractRequestSchema,
    response: PluginAiExtractResponseSchema,
    description: 'Extract structured data from text using behind-the-scenes LLM with JSON schema (rate-limited, for plugin useAi hook)',
  }),

  'plugins:ai-generate': defineInvokeChannel({
    channel: 'plugins:ai-generate',
    request: PluginAiGenerateRequestSchema,
    response: PluginAiGenerateResponseSchema,
    description: 'Generate text from a constrained prompt using behind-the-scenes LLM (rate-limited, for plugin useAi hook)',
  }),

  'plugins:get-meetings': defineInvokeChannel({
    channel: 'plugins:get-meetings',
    request: PluginGetMeetingsRequestSchema,
    response: PluginGetMeetingsResponseSchema,
    description: 'Get cached calendar meetings with plugin-safe shape (omits emails, filesystem paths)',
  }),

  'plugins:scan-spaces': defineInvokeChannel({
    channel: 'plugins:scan-spaces',
    request: z.void(),
    response: ScanSpacePluginsResponseSchema,
    description: 'Scan all Spaces for shared plugins in their plugins/ directories',
  }),

  'plugins:export-to-space': defineInvokeChannel({
    channel: 'plugins:export-to-space',
    request: ExportPluginToSpaceRequestSchema,
    response: ExportPluginToSpaceResponseSchema,
    description: 'Export a plugin from local storage to a Space plugins/ directory',
  }),

  'plugins:resolve-conflict': defineInvokeChannel({
    channel: 'plugins:resolve-conflict',
    request: ResolvePluginConflictRequestSchema,
    response: ResolvePluginConflictResponseSchema,
    description: 'Resolve shared plugin cloud sync conflicts by keeping mine/theirs',
  }),

  'plugins:rebel-merge': defineInvokeChannel({
    channel: 'plugins:rebel-merge',
    request: RebelMergeRequestSchema,
    response: RebelMergeResponseSchema,
    description: 'Ask Rebel to propose a merged plugin version from conflict files (no write)',
  }),

  'plugins:accept-merge': defineInvokeChannel({
    channel: 'plugins:accept-merge',
    request: AcceptMergeRequestSchema,
    response: AcceptMergeResponseSchema,
    description: 'Accept a proposed plugin merge, write merged files, and delete conflict copies',
  }),

  'plugins:get-activated': defineInvokeChannel({
    channel: 'plugins:get-activated',
    request: z.void(),
    response: ActivatedPluginIdsResponseSchema,
    description: 'Get locally activated Space plugin IDs',
  }),

  'plugins:add-activated': defineInvokeChannel({
    channel: 'plugins:add-activated',
    request: PluginActivationMutationRequestSchema,
    response: PluginActivationMutationResponseSchema,
    description: 'Mark a Space plugin as activated for this user',
  }),

  'plugins:remove-activated': defineInvokeChannel({
    channel: 'plugins:remove-activated',
    request: PluginActivationMutationRequestSchema,
    response: PluginActivationMutationResponseSchema,
    description: 'Remove a Space plugin from this user activation list',
  }),

  'plugins:get-deactivated': defineInvokeChannel({
    channel: 'plugins:get-deactivated',
    request: z.void(),
    response: ActivatedPluginIdsResponseSchema,
    description: 'Get explicitly deactivated plugin IDs (prevents CoS auto-reactivation)',
  }),

  'plugins:get-pending-review': defineInvokeChannel({
    channel: 'plugins:get-pending-review',
    request: z.void(),
    response: ActivatedPluginIdsResponseSchema,
    description: 'Get plugin IDs awaiting user security review (agent-created, elevated permissions, not yet activated)',
  }),

  'plugins:add-deactivated': defineInvokeChannel({
    channel: 'plugins:add-deactivated',
    request: PluginActivationMutationRequestSchema,
    response: PluginActivationMutationResponseSchema,
    description: 'Mark a plugin as explicitly deactivated by the user',
  }),

  'plugins:remove-deactivated': defineInvokeChannel({
    channel: 'plugins:remove-deactivated',
    request: PluginActivationMutationRequestSchema,
    response: PluginActivationMutationResponseSchema,
    description: 'Remove a plugin from the deactivated list (re-enable auto-activation)',
  }),

  'plugins:index-readme': defineInvokeChannel({
    channel: 'plugins:index-readme',
    request: PluginReadmeIndexRequestSchema,
    response: PluginReadmeIndexResponseSchema,
    description: 'Index README.md for an active Space plugin',
  }),

  'plugins:deindex-readme': defineInvokeChannel({
    channel: 'plugins:deindex-readme',
    request: PluginReadmeDeindexRequestSchema,
    response: PluginReadmeDeindexResponseSchema,
    description: 'Remove an inactive Space plugin README.md from semantic index',
  }),

  'plugins:delete-from-space': defineInvokeChannel({
    channel: 'plugins:delete-from-space',
    request: DeletePluginFromSpaceRequestSchema,
    response: DeletePluginFromSpaceResponseSchema,
    description: 'Permanently delete a plugin folder from a Space directory',
  }),

  'plugins:migrate-to-space': defineInvokeChannel({
    channel: 'plugins:migrate-to-space',
    request: z.void(),
    response: MigratePluginsToSpaceResponseSchema,
    description: 'Migrate plugins from electron-store to Chief-of-Staff/plugins/ (one-time startup migration)',
  }),

  'plugins:seed-bundled': defineInvokeChannel({
    channel: 'plugins:seed-bundled',
    request: SeedBundledPluginsRequestSchema,
    response: SeedBundledPluginsResponseSchema,
    description: 'Copy bundled rebel-system/plugins into Chief-of-Staff/plugins on first launch (idempotent; CoS wins on conflict)',
  }),

  'plugins:send-message': defineInvokeChannel({
    channel: 'plugins:send-message',
    request: PluginSendMessageRequestSchema,
    response: PluginSendMessageResponseSchema,
    description: 'Send a message to an existing conversation on behalf of a plugin (rate-limited, requires conversations:write)',
  }),

  'plugins:start-conversation': defineInvokeChannel({
    channel: 'plugins:start-conversation',
    request: PluginStartConversationRequestSchema,
    response: PluginStartConversationResponseSchema,
    description: 'Start a new conversation with an initial message on behalf of a plugin (rate-limited, requires conversations:write)',
  }),

  'plugins:get-transcript': defineInvokeChannel({
    channel: 'plugins:get-transcript',
    request: PluginGetTranscriptRequestSchema,
    response: PluginGetTranscriptResponseSchema,
    description: 'Read visible user/assistant transcript messages for an existing conversation (rate-limited, requires conversations:transcript)',
  }),

  'plugins:inbox-add': defineInvokeChannel({
    channel: 'plugins:inbox-add',
    request: PluginInboxAddRequestSchema,
    response: PluginInboxAddResponseSchema,
    description: 'Create an inbox item on behalf of a plugin (rate-limited, no manifest permission required)',
  }),

  'plugins:inbox-list': defineInvokeChannel({
    channel: 'plugins:inbox-list',
    request: PluginInboxListRequestSchema,
    response: PluginInboxListResponseSchema,
    description: 'List active inbox items for plugin use with optional limit (default 20, max 50)',
  }),

  'plugins:external-fetch': defineInvokeChannel({
    channel: 'plugins:external-fetch',
    request: PluginExternalFetchRequestSchema,
    response: PluginExternalFetchResponseSchema,
    description: 'Execute a mediated HTTP GET request to an allowlisted external domain on behalf of a plugin (rate-limited, requires external-fetch permission)',
  }),

  'plugins:create-automation': defineInvokeChannel({
    channel: 'plugins:create-automation',
    request: PluginCreateAutomationRequestSchema,
    response: PluginCreateAutomationResponseSchema,
    description: 'Create a new automation on behalf of a plugin (rate-limited: 3/hr, requires automations:create, defaults to disabled)',
  }),

  'plugins:list-automations': defineInvokeChannel({
    channel: 'plugins:list-automations',
    request: PluginListAutomationsRequestSchema,
    response: PluginListAutomationsResponseSchema,
    description: 'List automation summaries (optionally filtered by plugin attribution)',
  }),
} as const;
