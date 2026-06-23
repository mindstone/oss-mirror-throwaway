import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';

const McpAppPermissionMethodSchema = z.enum(['ui/updateModelContext', 'ui/sendMessage']);

export const McpAppPermissionChangedPayloadSchema = z.object({
  kind: z.enum(['granted', 'revoked']),
  scope: z.enum(['method', 'tool', 'conversation', 'package']),
  sourcePackageId: z.string().optional(),
  conversationId: z.string().optional(),
  method: z.union([McpAppPermissionMethodSchema, z.literal('tools/call')]).optional(),
  toolName: z.string().optional(),
}).strict();
export type McpAppPermissionChangedPayload = z.infer<typeof McpAppPermissionChangedPayloadSchema>;

export const MCP_APPS_BROADCAST_CHANNELS = {
  PERMISSION_CHANGED: 'mcp:permission-changed',
} as const;
export type McpAppsBroadcastChannel =
  (typeof MCP_APPS_BROADCAST_CHANNELS)[keyof typeof MCP_APPS_BROADCAST_CHANNELS];

/**
 * MCP Apps IPC channels for interactive tool UI support.
 * 
 * Phase 1: Read-only views + app-initiated tool calls
 * - mcp:read-resource: Fetch UI resources from MCP servers
 * - mcp:call-tool: Execute package-scoped MCP tools from MCP App iframes
 * 
 * @see https://modelcontextprotocol.io/docs/extensions/apps
 */
export const mcpAppsChannels = {
  /**
   * Read a UI resource from an MCP server via Super-MCP.
   * Used to fetch HTML content for MCP App Views.
   * 
   * @example
   * const { contents } = await window.mcpAppsApi.readResource({
   *   uri: 'ui://chart-tool/app.html'
   * });
   */
  'mcp:read-resource': defineInvokeChannel({
    channel: 'mcp:read-resource',
    request: z.object({
      /** Resource URI (ui://tool-name/resource.html) */
      uri: z.string().min(1),
      /** Source package instance ID for direct routing (optional, falls back to URI-based inference) */
      sourcePackageId: z.string().optional(),
    }),
    response: z.object({
      /** Whether the resource was successfully fetched */
      success: z.boolean(),
      /** Resource contents (array for consistency with MCP protocol) */
      contents: z.array(z.object({
        uri: z.string(),
        mimeType: z.string().optional(),
        text: z.string().optional(),
        blob: z.string().optional(),
      })).optional(),
      /** Error message if fetch failed */
      error: z.string().optional(),
      /** CSP configuration from resource metadata */
      csp: z.object({
        connectDomains: z.array(z.string()).optional(),
        resourceDomains: z.array(z.string()).optional(),
        frameDomains: z.array(z.string()).optional(),
      }).optional(),
    }),
    description: 'Read a UI resource from an MCP server for rendering MCP App Views',
  }),

  /**
   * Call an MCP tool from an MCP App iframe via Super-MCP.
   * The call is scoped to the source package that served the iframe resource.
   */
  'mcp:call-tool': defineInvokeChannel({
    channel: 'mcp:call-tool',
    request: z.object({
      /** App-family name for allowlist matching (e.g., "google-workspace" from URI authority) */
      appFamily: z.string().min(1),
      /** Instance package ID for Super-MCP routing and trust scoping (e.g., "GoogleWorkspace-jane-example-com"). */
      sourcePackageId: z.string().min(1),
      /** Host-owned tool use ID for trust-boundary nonce scoping. */
      toolUseId: z.string().min(1),
      /** Host-owned session ID for trust-boundary nonce/rate-limit scoping. */
      sessionId: z.string().min(1),
      /** Host-owned conversation ID for trust-boundary permission scoping. */
      conversationId: z.string().min(1),
      /** Host-assigned iframe instance ID for one-time nonce scoping. */
      iframeInstanceId: z.string().min(1),
      /** One-time freshness nonce issued immediately before this tools/call request. */
      nonce: z.string().min(1),
      /** Tool name requested by the iframe */
      toolName: z.string().min(1),
      /** Tool arguments */
      args: z.record(z.string(), z.unknown()),
    }),
    response: z.union([
      z.object({
        /** Whether the tool call succeeded */
        success: z.literal(true),
        /** Raw MCP tool result payload (if successful) */
        result: z.unknown().optional(),
      }),
      z.object({
        success: z.literal(false),
        /** Error message for post-trust tool execution failures */
        error: z.string().optional(),
        /** Trust-boundary rejection for nonce/rate-limit/allowlist failures */
        rejection: z.object({
          jsonRpcCode: z.number(),
          reason: z.string(),
          safeMessage: z.string(),
          correlationId: z.string().optional(),
        }).optional(),
      }),
    ]),
    description: 'Call an MCP tool from an MCP App iframe via Super-MCP with package scoping',
  }),

  /**
   * Issue a freshness nonce for one host-rendered MCP App iframe instance.
   * This is the only nonce issuance path for iframe → host trust-boundary methods.
   */
  'mcp:issue-nonce': defineInvokeChannel({
    channel: 'mcp:issue-nonce',
    request: z.object({
      sourcePackageId: z.string().min(1),
      toolUseId: z.string().min(1),
      sessionId: z.string().min(1),
      conversationId: z.string().min(1),
      iframeInstanceId: z.string().min(1),
    }),
    response: z.union([
      z.object({
        success: z.literal(true),
        nonce: z.string(),
      }),
      z.object({
        success: z.literal(false),
        rejection: z.object({
          jsonRpcCode: z.number(),
          reason: z.string(),
          safeMessage: z.string(),
          correlationId: z.string().optional(),
        }),
      }),
    ]),
    description: 'Issue a host nonce for an MCP App iframe instance',
  }),

  /**
   * Store model context supplied by an MCP App iframe for the next agent turn.
   * The main process enforces nonce freshness, rate limits, and permissions.
   */
  'mcp:update-context': defineInvokeChannel({
    channel: 'mcp:update-context',
    request: z.object({
      sourcePackageId: z.string(),
      toolUseId: z.string(),
      sessionId: z.string(),
      conversationId: z.string(),
      iframeInstanceId: z.string(),
      nonce: z.string(),
      content: z.string().optional(),
      structuredContent: z.unknown().optional(),
    }),
    response: z.union([
      z.object({ success: z.literal(true) }),
      z.object({
        success: z.literal(false),
        rejection: z.object({
          jsonRpcCode: z.number(),
          reason: z.string(),
          safeMessage: z.string(),
          correlationId: z.string().optional(),
        }),
      }),
    ]),
    description: 'Update attributed MCP App model context for the next agent turn',
  }),

  /**
   * Send a user-role message from an MCP App iframe into the conversation.
   * The main process enforces nonce freshness, rate limits, permissions,
   * role allowlisting, sanitization, and attribution before dispatch.
   */
  'mcp:send-message': defineInvokeChannel({
    channel: 'mcp:send-message',
    request: z.object({
      sourcePackageId: z.string(),
      toolUseId: z.string(),
      sessionId: z.string(),
      conversationId: z.string(),
      iframeInstanceId: z.string(),
      nonce: z.string(),
      content: z.string(),
      role: z.string(),
    }),
    response: z.union([
      z.object({ success: z.literal(true) }),
      z.object({
        success: z.literal(false),
        rejection: z.object({
          jsonRpcCode: z.number(),
          reason: z.string(),
          safeMessage: z.string(),
          correlationId: z.string().optional(),
        }),
      }),
    ]),
    description: 'Send an attributed user-role MCP App message to the conversation',
  }),

  /**
   * Invalidate all active nonces for an iframe instance after host unmount.
   */
  'mcp:invalidate-nonce': defineInvokeChannel({
    channel: 'mcp:invalidate-nonce',
    request: z.object({
      iframeInstanceId: z.string().min(1),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Invalidate active MCP App nonces for one iframe instance',
  }),

  /**
   * Invalidate active nonces for a conversation during conversation lifecycle changes.
   */
  'mcp:invalidate-conversation-nonces': defineInvokeChannel({
    channel: 'mcp:invalidate-conversation-nonces',
    request: z.object({
      conversationId: z.string().min(1),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Invalidate active MCP App nonces for one conversation',
  }),

  /**
   * Grant a host-controlled permission for MCP App bidirectional methods.
   * V1 exposes this through the trust-rejection notice; full settings management follows later.
   */
  'mcp:grant-permission': defineInvokeChannel({
    channel: 'mcp:grant-permission',
    request: z.union([
      z.object({
        sourcePackageId: z.string().min(1),
        conversationId: z.string().min(1),
        method: McpAppPermissionMethodSchema,
      }),
      z.object({
        sourcePackageId: z.string().min(1),
        conversationId: z.string().min(1),
        method: z.literal('tools/call'),
        toolName: z.string().min(1),
      }),
    ]),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Grant MCP App permission for a conversation-scoped bidirectional method',
  }),

  'mcp:list-permissions': defineInvokeChannel({
    channel: 'mcp:list-permissions',
    request: z.object({}),
    response: z.object({
      permissions: z.array(z.object({
        sourcePackageId: z.string(),
        conversationId: z.string(),
        granted: z.boolean(),
        grantedAt: z.string(),
        methods: z.array(z.string()),
        toolAllowlist: z.array(z.string()).optional(),
      })),
    }),
    description: 'List all standing MCP App permission grants',
  }),

  'mcp:revoke-permission': defineInvokeChannel({
    channel: 'mcp:revoke-permission',
    request: z.discriminatedUnion('scope', [
      z.object({
        scope: z.literal('method'),
        sourcePackageId: z.string().min(1),
        conversationId: z.string().min(1),
        method: McpAppPermissionMethodSchema,
      }),
      z.object({
        scope: z.literal('tool'),
        sourcePackageId: z.string().min(1),
        conversationId: z.string().min(1),
        toolName: z.string().min(1),
      }),
      z.object({
        scope: z.literal('conversation'),
        sourcePackageId: z.string().min(1),
        conversationId: z.string().min(1),
      }),
      z.object({
        scope: z.literal('package'),
        sourcePackageId: z.string().min(1),
      }),
    ]),
    response: z.object({ success: z.boolean() }),
    description: 'Revoke a standing MCP App permission grant',
  }),

  /**
   * Write raw HTML to a temp file and open it in the default browser.
   * Used by McpAppView "Open in Browser" for raw HTML mode (no file on disk).
   */
  'mcp:open-html-in-browser': defineInvokeChannel({
    channel: 'mcp:open-html-in-browser',
    request: z.object({
      html: z.string().min(1),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Write HTML to a temp file and open in the default browser',
  }),
} as const;
