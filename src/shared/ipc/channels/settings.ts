import { z } from 'zod';
import {
  defineInvokeChannel,
  ElectronFileFilterSchema,
  AppSettingsSchema,
  AppSettingsPartialSchema,
  ApiKeyValidationRequestSchema,
  ApiKeyValidationResultSchema,
  McpConfigSummarySchema,
  McpServerConfigDetailsSchema,
  McpConfigMutationResultSchema,
  McpServerUpsertPayloadSchema,
  McpRouterPathPatchPayloadSchema,
  McpToolListResponseSchema,
  ToolSafetyLevelSchema,
} from '../schemas';

const ModelChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), modelId: z.string() }),
  z.object({ kind: z.literal('profile'), profileId: z.string() }),
  z.object({ kind: z.literal('inherit') }),
  z.object({ kind: z.literal('auto') }),
  z.object({ kind: z.literal('off') }),
]);

const ModelTestResultSchema = z.object({
  success: z.boolean(),
  latencyMs: z.number().optional(),
  modelResponse: z.string().optional(),
  error: z.string().optional(),
  chatIncompatible: z.boolean().optional(),
  jsonIncompatible: z.boolean().optional(),
  thinkingIncompatible: z.boolean().optional(),
  toolUseIncompatible: z.boolean().optional(),
});

export const settingsChannels = {
  'settings:get': defineInvokeChannel({
    channel: 'settings:get',
    request: z.void(),
    response: AppSettingsSchema,
    description: 'Get the current application settings',
  }),

  'settings:update': defineInvokeChannel({
    channel: 'settings:update',
    // Top-level-PARTIAL request: the desktop handler shallow-merges the incoming
    // payload over current settings, so a bare partial (e.g. `{ cloudInstance }`)
    // is legitimate. A full `AppSettingsSchema` request lied about this and made
    // the dev/test contract-parse seam reject bare partials. `.partial()` strictly
    // WIDENS validation. See docs/plans/260622_mobile-setup-investigation.
    request: AppSettingsPartialSchema,
    response: AppSettingsSchema,
    description: 'Update application settings (accepts a full document or a top-level partial; shallow-merged over current settings)',
  }),

  'settings:get-default-workspace': defineInvokeChannel({
    channel: 'settings:get-default-workspace',
    request: z.void(),
    response: z.string(),
    description: 'Get the suggested default workspace directory path',
  }),

  'settings:choose-directory': defineInvokeChannel({
    channel: 'settings:choose-directory',
    request: z.object({
      defaultPath: z.string().optional(),
    }).optional(),
    response: z.string().nullable(),
    description: 'Open a native directory picker dialog, optionally starting in a specific directory',
  }),

  'settings:choose-file': defineInvokeChannel({
    channel: 'settings:choose-file',
    request: z.array(ElectronFileFilterSchema).optional(),
    response: z.string().nullable(),
    description: 'Open a native file picker dialog',
  }),

  'settings:choose-file-in-directory': defineInvokeChannel({
    channel: 'settings:choose-file-in-directory',
    request: z.object({
      baseDir: z.string(),
      filters: z.array(ElectronFileFilterSchema).optional(),
      returnRelative: z.boolean().optional(),
    }),
    response: z.string().nullable(),
    description: 'Open a native file picker starting in a specific directory, optionally returning relative path',
  }),

  'settings:choose-directory-in-directory': defineInvokeChannel({
    channel: 'settings:choose-directory-in-directory',
    request: z.object({
      baseDir: z.string(),
      returnRelative: z.boolean().optional(),
    }),
    response: z.string().nullable(),
    description: 'Open a native directory picker starting in a specific directory, optionally returning relative path',
  }),

  'settings:choose-executable': defineInvokeChannel({
    channel: 'settings:choose-executable',
    request: z.void(),
    response: z.string().nullable(),
    description: 'Open a native file picker for selecting an executable',
  }),

  'settings:mcp-summary': defineInvokeChannel({
    channel: 'settings:mcp-summary',
    request: z.object({
      settings: AppSettingsSchema.nullable().optional(),
      skipMetadata: z.boolean().optional(),
    }).optional(),
    response: McpConfigSummarySchema,
    description: 'Get a summary of the current MCP configuration',
  }),

  'settings:mcp-ensure-managed': defineInvokeChannel({
    channel: 'settings:mcp-ensure-managed',
    request: z.void(),
    response: z.object({
      configPath: z.string(),
    }),
    description: 'Ensure the managed MCP config file exists',
  }),

  'settings:mcp-get-server': defineInvokeChannel({
    channel: 'settings:mcp-get-server',
    request: z.string(),
    response: McpServerConfigDetailsSchema,
    description: 'Get full configuration details for an MCP server',
  }),

  'settings:mcp-list-tools': defineInvokeChannel({
    channel: 'settings:mcp-list-tools',
    request: z.object({
      serverId: z.string(),
      pageToken: z.string().nullable().optional(),
    }),
    response: McpToolListResponseSchema,
    description: 'List tools for an MCP server with pagination',
  }),

  'settings:mcp-add-rebel-server': defineInvokeChannel({
    channel: 'settings:mcp-add-rebel-server',
    request: z.void(),
    response: McpConfigMutationResultSchema,
    description: 'Add the Rebel task queue MCP server',
  }),

  'settings:mcp-add-bundled-server': defineInvokeChannel({
    channel: 'settings:mcp-add-bundled-server',
    request: z.object({
      serverName: z.string(),
      apiKey: z.string().optional(),
      // Generic credentials for bundled servers needing multiple keys (e.g., Kling: accessKey + secretKey)
      credentials: z.record(z.string(), z.string()).optional(),
      // Account email for identity (used for instance naming like "Fathom-greg-acme-com")
      email: z.string().optional(),
      // HubSpot scope tier: 'readonly' for free accounts, 'full' for paid
      scopeTier: z.enum(['readonly', 'full']).optional(),
      // Catalog entry ID for MCPs with multiple catalog entries (e.g., EmailImap → bundled-icloud-mail / bundled-yahoo-mail)
      catalogId: z.string().optional(),
      mode: z.enum(['create', 'update']).optional().default('create'),
    }),
    response: McpConfigMutationResultSchema,
    description: 'Add a bundled MCP server by name (e.g., GammaMcp, Kling)',
  }),

  'settings:mcp-validate-server': defineInvokeChannel({
    channel: 'settings:mcp-validate-server',
    request: z.object({
      serverName: z.string(),
    }),
    response: z.object({
      status: z.enum(['ok', 'error', 'unavailable']),
      error: z.string().optional(),
    }),
    description: 'Validate a saved MCP server against the live desktop Super-MCP runtime',
  }),

  'settings:mcp-upsert-server': defineInvokeChannel({
    channel: 'settings:mcp-upsert-server',
    request: McpServerUpsertPayloadSchema,
    response: McpConfigMutationResultSchema,
    description: 'Add or update an MCP server configuration',
  }),

  'settings:mcp-remove-server': defineInvokeChannel({
    channel: 'settings:mcp-remove-server',
    request: z.string(),
    response: McpConfigMutationResultSchema,
    description: 'Remove an MCP server from the configuration',
  }),

  'settings:mcp-router-path': defineInvokeChannel({
    channel: 'settings:mcp-router-path',
    request: McpRouterPathPatchPayloadSchema,
    response: McpConfigMutationResultSchema,
    description: 'Add or remove a config path from the Super-MCP router',
  }),

  'settings:mcp-restart-super-mcp': defineInvokeChannel({
    channel: 'settings:mcp-restart-super-mcp',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      isRunning: z.boolean(),
      port: z.number().optional(),
      url: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Restart the Super-MCP HTTP server',
  }),

  'settings:validate-openai-key': defineInvokeChannel({
    channel: 'settings:validate-openai-key',
    request: ApiKeyValidationRequestSchema,
    response: ApiKeyValidationResultSchema,
    description: 'Validate an OpenAI API key by calling the models endpoint',
  }),

  'settings:validate-claude-key': defineInvokeChannel({
    channel: 'settings:validate-claude-key',
    request: ApiKeyValidationRequestSchema,
    response: ApiKeyValidationResultSchema,
    description: 'Validate an Anthropic (Claude) API key by calling the models endpoint',
  }),

  'settings:validate-elevenlabs-key': defineInvokeChannel({
    channel: 'settings:validate-elevenlabs-key',
    request: ApiKeyValidationRequestSchema,
    response: ApiKeyValidationResultSchema,
    description: 'Validate an ElevenLabs API key by calling the user endpoint',
  }),

  'settings:ensure-workspace-symlinks': defineInvokeChannel({
    channel: 'settings:ensure-workspace-symlinks',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      rebelSystemPath: z.string().nullable(),
    }),
    description: 'Ensure workspace symlinks (rebel-system, AGENTS.md, CLAUDE.md) are created. Awaits completion.',
  }),

  'settings:test-local-model': defineInvokeChannel({
    channel: 'settings:test-local-model',
    request: z.object({
      serverUrl: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      models: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
    description: 'Test connection to local model server (OpenAI-compatible) and list available models',
  }),

  'settings:test-model-profile': defineInvokeChannel({
    channel: 'settings:test-model-profile',
    request: z.object({
      serverUrl: z.string(),
      model: z.string().optional(),
      apiKey: z.string().optional(),
      providerType: z.string().optional(),
      customProviderId: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      latencyMs: z.number().optional(),
      modelResponse: z.string().optional(),
      error: z.string().optional(),
      chatIncompatible: z.boolean().optional(),
      jsonIncompatible: z.boolean().optional(),
      thinkingIncompatible: z.boolean().optional(),
      toolUseIncompatible: z.boolean().optional(),
    }),
    description: 'Test a model profile by sending a minimal chat completion and measuring latency',
  }),

  'settings:test-model-choice': defineInvokeChannel({
    channel: 'settings:test-model-choice',
    request: z.object({
      role: z.enum(['working', 'thinking', 'background', 'recovery']),
      choice: ModelChoiceSchema,
      settings: AppSettingsSchema,
    }),
    response: ModelTestResultSchema,
    description: 'Test a model choice by resolving the runtime provider route and sending a minimal probe',
  }),

  'settings:list-local-models': defineInvokeChannel({
    channel: 'settings:list-local-models',
    request: z.object({
      serverUrl: z.string(),
    }),
    response: z.object({
      models: z.array(z.object({
        name: z.string(),
        size: z.string().optional(),
        modifiedAt: z.string().optional(),
      })),
    }),
    description: 'List available models from local model server (OpenAI-compatible)',
  }),

  'settings:get-frequent-tools': defineInvokeChannel({
    channel: 'settings:get-frequent-tools',
    request: z.void(),
    response: z.array(z.object({
      toolName: z.string(),
      shortName: z.string(),
      params: z.array(z.string()),
      usageCount: z.number(),
    })),
    description: 'Get frequently used tools for personalized system prompt injection',
  }),

  'settings:reset-tool-usage': defineInvokeChannel({
    channel: 'settings:reset-tool-usage',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Reset all tool usage statistics to defaults',
  }),

  'settings:mcp-toggle-tool': defineInvokeChannel({
    channel: 'settings:mcp-toggle-tool',
    request: z.object({
      serverId: z.string().min(1),
      toolName: z.string().min(1),
      enabled: z.boolean(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Enable or disable a specific MCP tool. Tool names are short names (e.g., "delete_file"), not namespaced.',
  }),

  'settings:mcp-toggle-server-enabled': defineInvokeChannel({
    channel: 'settings:mcp-toggle-server-enabled',
    request: z.object({
      serverId: z.string().min(1),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Toggle a server between enabled and disabled state. Disabled servers are excluded from tool routing but remain visible in settings.',
  }),

  'settings:add-trusted-tool': defineInvokeChannel({
    channel: 'settings:add-trusted-tool',
    request: z.object({
      toolId: z.string(),
      displayName: z.string().optional(),
      serverHint: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
      toolId: z.string().optional(),
    }),
    description: 'Atomically add a tool to the trusted tools list (deduplicates by toolId, case-sensitive). Returns { success: false, error: "READ_ONLY" } in read-only mode so fail-loud transports can classify.',
  }),

  'settings:set-space-safety-level': defineInvokeChannel({
    channel: 'settings:set-space-safety-level',
    request: z.object({
      spaceId: z.string().min(1).max(128),
      level: ToolSafetyLevelSchema,
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
      spaceId: z.string().optional(),
    }),
    description: 'Atomically set the memory-safety level for a single space (narrow-slice; see D11 in the approval consolidation plan)',
  }),

  'settings:rename-workspace': defineInvokeChannel({
    channel: 'settings:rename-workspace',
    request: z.object({
      newName: z.string().min(1),
    }),
    response: z.object({
      success: z.boolean(),
      oldPath: z.string(),
      newPath: z.string(),
      requiresRestart: z.boolean(),
    }),
    description: 'Rename the workspace (coreDirectory) folder. App will restart to apply changes.',
  }),

} as const;
