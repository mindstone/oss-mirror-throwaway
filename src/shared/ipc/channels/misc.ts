import { z } from 'zod';
import {
  defineInvokeChannel,
  defineSyncChannel,
  AnalyticsStatusPayloadSchema,
  RendererAnalyticsHealthSchema,
  RuntimeConfigSchema,
  UpdateManifestSchema,
  ConversationTitleRequestPayloadSchema,
  PythonRuntimeStatusSchema,
  TelemetrySettingsSchema,
} from '../schemas';
import { OAuthSetupGuidanceSchema } from '../schemas/common';

export const miscChannels = {
  'analytics:status': defineInvokeChannel({
    channel: 'analytics:status',
    request: z.void(),
    response: AnalyticsStatusPayloadSchema,
    description: 'Get analytics configuration status',
  }),

  'analytics:renderer-health': defineInvokeChannel({
    channel: 'analytics:renderer-health',
    request: RendererAnalyticsHealthSchema,
    response: z.object({ received: z.boolean() }),
    description: 'Push renderer analytics health state to main process for diagnostics',
  }),

  'runtime-config:get': defineInvokeChannel({
    channel: 'runtime-config:get',
    request: z.void(),
    response: RuntimeConfigSchema,
    description: 'Get runtime configuration info',
  }),

  'sentry:capture-exception': defineInvokeChannel({
    channel: 'sentry:capture-exception',
    request: z.object({
      message: z.string().optional(),
      name: z.string().optional(),
      stack: z.string().optional(),
      context: z.record(z.string(), z.unknown()).optional(),
    }).nullable(),
    response: z.object({
      eventId: z.string().nullable(),
    }),
    description: 'Report an exception to Sentry',
  }),

  'sentry:capture-message': defineInvokeChannel({
    channel: 'sentry:capture-message',
    request: z.object({
      message: z.string().optional(),
      // 'info' deliberately absent — raw info-level captures are forbidden
      // (Stage 5 of docs/plans/260610_improve-sentry-noise/PLAN.md). Info
      // telemetry goes through captureKnownCondition or breadcrumbs/ledger.
      level: z.enum(['warning', 'error', 'fatal']).optional(),
      context: z.record(z.string(), z.unknown()).optional(),
    }).nullable(),
    response: z.object({
      eventId: z.string().nullable(),
    }),
    description: 'Send a message to Sentry',
  }),

  'conversation:generate-title': defineInvokeChannel({
    channel: 'conversation:generate-title',
    request: ConversationTitleRequestPayloadSchema,
    response: z.object({
      title: z.string().nullable(),
    }),
    description: 'Generate a title for a conversation based on transcript',
  }),

  'onboarding:get-tool-auth-url': defineInvokeChannel({
    channel: 'onboarding:get-tool-auth-url',
    request: z.object({
      tool: z.string(),
      serverName: z.string().optional(),
      companyName: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      authUrl: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Get OAuth authentication URL for a tool (deprecated - use bundled MCP connectors)',
  }),

  'onboarding:verify-tool-auth': defineInvokeChannel({
    channel: 'onboarding:verify-tool-auth',
    request: z.object({
      tool: z.string(),
      serverName: z.string().optional(),
      companyName: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      isAuthenticated: z.boolean(),
      limitExceeded: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Verify if a tool is authenticated (deprecated - use bundled MCP connectors)',
  }),

  'check-for-updates': defineInvokeChannel({
    channel: 'check-for-updates',
    request: z.void(),
    response: z.object({
      available: z.boolean(),
      version: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Check for application updates',
  }),

  'misc:fetch-update-manifest': defineInvokeChannel({
    channel: 'misc:fetch-update-manifest',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      manifest: UpdateManifestSchema.optional(),
      error: z.string().optional(),
    }),
    description: 'Fetch the latest.json manifest from GCS for version comparison',
  }),

  'misc:mcp-authenticate': defineInvokeChannel({
    channel: 'misc:mcp-authenticate',
    request: z.object({
      serverId: z.string(),
      force: z.boolean().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      status: z.enum(['already_authenticated', 'authenticated', 'error']).optional(),
      error: z.string().optional(),
      // Structured setup guidance when the connector is broken-by-default (no OAuth client
      // credentials configured) and auth was attempted via the agent/setup-tool path.
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Trigger OAuth authentication for an MCP server. Pass force=true to skip pre-checks and always open the browser.',
  }),

  'misc:mcp-invoke-stdio-auth': defineInvokeChannel({
    channel: 'misc:mcp-invoke-stdio-auth',
    request: z.object({
      serverId: z.string(),
      toolName: z.string(),
      email: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      authUrl: z.string().optional(),
      error: z.string().optional(),
      // Structured setup guidance when the connector is broken-by-default (no OAuth client
      // credentials configured) and auth was driven by a host OAuth orchestrator.
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Invoke a stdio MCP authenticate tool to get OAuth URL',
  }),

  'misc:mcp-check-health': defineInvokeChannel({
    channel: 'misc:mcp-check-health',
    request: z.object({
      serverId: z.string(),
    }),
    response: z.object({
      health: z.enum(['ok', 'error', 'unavailable', 'unknown']),
    }),
    description: 'Check health status of a specific MCP server',
  }),

  'update:install-now': defineInvokeChannel({
    channel: 'update:install-now',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Install a downloaded update and restart the app',
  }),

  'update:get-pending-downloaded': defineInvokeChannel({
    channel: 'update:get-pending-downloaded',
    request: z.object({
      ignoreAck: z.boolean().optional(),
    }).optional(),
    response: z.object({
      pending: z
        .object({
          updateKey: z.string(),
          versionLabel: z.string(),
          downloadedAt: z.number(),
          downloadUrl: z.string().optional(),
        })
        .nullable(),
      // REBEL-53B: silent auto-heal counter for the current pending
      // updateKey. `>= 1` means a previous install attempt didn't take
      // and the renderer should adapt the toast copy ("Previous install
      // didn't take" + Download directly). Defaults to 0 when no pending
      // update is set or when no recovery attempts have been recorded.
      recoveryAttempts: z.number().int().min(0).default(0),
    }),
    description: 'Get the pending downloaded update (if any) for showing an "Update ready" prompt. Pass ignoreAck: true for user-initiated checks that should bypass acknowledgment filtering.',
  }),

  'update:acknowledge': defineInvokeChannel({
    channel: 'update:acknowledge',
    request: z.object({
      updateKey: z.string(),
      source: z.enum(['push', 'pull', 'toast']).optional(),
    }),
    response: z.object({
      acknowledged: z.boolean(),
    }),
    description: 'Acknowledge a downloaded update prompt so it is not repeatedly shown in the same app session',
  }),

  'update:acknowledge-toast': defineInvokeChannel({
    channel: 'update:acknowledge-toast',
    request: z.void(),
    response: z.object({
      acknowledged: z.boolean(),
    }),
    description: 'Acknowledge that the update toast was displayed in the renderer',
  }),

  'quips:generate': defineInvokeChannel({
    channel: 'quips:generate',
    request: z.object({
      userMessage: z.string(),
      turnId: z.string(),
      stage: z.enum(['processing', 'generation']),
    }),
    response: z.object({
      success: z.boolean(),
      quips: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
    description: 'Generate dynamic contextual quips for long-running turns using Haiku',
  }),

  'misc:get-changelog': defineInvokeChannel({
    channel: 'misc:get-changelog',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      content: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Get the changelog markdown content',
  }),

  'misc:get-coaching-sessions': defineInvokeChannel({
    channel: 'misc:get-coaching-sessions',
    request: z.void(),
    response: z.object({
      sessionIds: z.array(z.string()),
    }),
    description: 'Get session IDs that have pending coaching insights',
  }),

  'misc:get-coaching-for-session': defineInvokeChannel({
    channel: 'misc:get-coaching-for-session',
    request: z.object({ sessionId: z.string() }),
    response: z.object({
      evaluation: z.object({
        sessionId: z.string(),
        evaluatedAt: z.number(),
        primaryInsight: z.object({
          id: z.string(),
          insight: z.string(),
          context: z.string().optional(),
          continuationPrompt: z.string(),
          category: z.string(),
        }),
        state: z.enum(['pending', 'shown', 'acted', 'dismissed']),
        dismissalReason: z.string().optional(),
      }).nullable(),
    }),
    description: 'Get coaching evaluation for a specific session',
  }),

  'misc:update-coaching-state': defineInvokeChannel({
    channel: 'misc:update-coaching-state',
    request: z.object({
      sessionId: z.string(),
      state: z.enum(['pending', 'shown', 'acted', 'dismissed']),
      dismissalReason: z.string().optional(),
    }),
    response: z.object({ success: z.boolean() }),
    description: 'Update coaching state (acted, dismissed, etc.)',
  }),

  'misc:get-suggested-skills': defineInvokeChannel({
    channel: 'misc:get-suggested-skills',
    request: z.void(),
    response: z.object({
      suggestions: z.array(z.object({
        skillName: z.string(),
        count: z.number(),
        lastSuggestedAt: z.number(),
      })),
    }),
    description: 'Get aggregated skill suggestions from coaching history for personalization',
  }),

  'misc:check-python-runtime': defineInvokeChannel({
    channel: 'misc:check-python-runtime',
    request: z.object({ forceRefresh: z.boolean().optional() }).optional(),
    response: PythonRuntimeStatusSchema,
    description: 'Check if Python 3 and uvx are installed for Python-based MCPs',
  }),

  'misc:get-executable-path': defineInvokeChannel({
    channel: 'misc:get-executable-path',
    request: z.void(),
    response: z.object({
      path: z.string().nullable(),
      isPackaged: z.boolean(),
    }),
    description: 'Get the path to the Rebel executable for MCP configuration',
  }),

  'misc:capture-screenshot': defineInvokeChannel({
    channel: 'misc:capture-screenshot',
    request: z.void(),
    response: z.object({
      screenshot: z.object({
        base64Data: z.string(),
        width: z.number(),
        height: z.number(),
        sizeBytes: z.number(),
      }).nullable(),
      error: z.enum(['screen-permission', 'capture-failed']).optional(),
    }),
    description: 'Capture a screenshot of the active display for bug reports',
  }),

  // OSS no-phone-home bridge (B6.a): synchronous startup read of the user's
  // LOCAL_ONLY settings.telemetry creds. Desktop-only — intentionally kept out
  // of CLOUD_CHANNEL_POLICIES so credentials never sync to the cloud process.
  // Returns null in enterprise builds (renderer falls back to its env-var path).
  'telemetry-config:sync': defineSyncChannel({
    channel: 'telemetry-config:sync',
    request: z.void(),
    response: TelemetrySettingsSchema.nullable(),
    description: 'Synchronous startup read of OSS telemetry creds (returns null in enterprise)',
  }),
} as const;
