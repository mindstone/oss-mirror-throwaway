/**
 * MCP Server for Rebel
 *
 * Exposes Rebel's agent capabilities via the MCP stdio protocol.
 * External MCP clients (Cursor, Claude Desktop, VS Code) can invoke
 * Rebel's agent turns via the `rebel_run_turn` tool.
 *
 * CRITICAL: All logging MUST go to stderr - stdout is reserved for MCP JSON-RPC protocol.
 */

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { AgentEvent, AppSettings } from '@shared/types';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import { FINISH_LINE_MAX_LENGTH, normalizeFinishLine } from '@core/utils/finishLine';
import { hasValidAuth } from '../utils/authEnvUtils';

const TOOL_DESCRIPTION = `Run a full agent turn with Rebel - a voice-first AI assistant with access to your memories, connected tools, and learned context.

Rebel connects to 50+ services in your productivity stack via pre-configured MCP servers:
- **Communication**: Gmail, Outlook, Slack, Microsoft Teams
- **Productivity**: Google Workspace, Notion, Linear, Asana, Jira/Confluence
- **Meetings**: Fathom transcripts, Fireflies, Otter.ai
- **Data**: PostgreSQL, MongoDB, BigQuery, Looker
- **CRM**: HubSpot, Salesforce, Pipedrive
- **Dev**: GitHub, Sentry, Vercel
- And many more...

Rebel also maintains **memories** of your preferences, projects, and workflows - accumulated context that makes each interaction more relevant.

**Use this tool to:**
- Query information across your connected services
- Perform actions in tools you've connected to Rebel
- Access your accumulated knowledge and context
- Execute multi-step workflows with Rebel's skills

**Important notes:**
- Rebel processes requests using Claude. Complex requests may take 30-120 seconds.
- Each call runs a complete agent turn (may include multiple tool calls internally).
- Returns a JSON response with text, turnId, and usage statistics.`;

const TOOL_SCHEMA = {
  name: 'rebel_run_turn',
  description: TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'The user prompt to send to Rebel'
      },
      sessionId: {
        type: 'string',
        description: 'Optional session ID for multi-turn context within this MCP connection'
      },
      finishLine: {
        type: 'string',
        maxLength: FINISH_LINE_MAX_LENGTH,
        description:
          'Optional success criterion. Rebel stops when it is met. Example: "the draft is ready to send".'
      }
    },
    required: ['prompt']
  }
};

/**
 * Function signature for running a headless agent turn.
 * This is injected from the CLI runtime.
 */
type RunHeadlessTurnFn = (params: {
  prompt: string;
  onEvent: (event: AgentEvent) => void;
  options: HeadlessTurnOptions;
}) => Promise<void>;

export interface McpServerOptions {
  version: string;
  runHeadlessTurn: RunHeadlessTurnFn;
  getSettings: () => Promise<AppSettings> | AppSettings;
}

/**
 * Response structure for rebel_run_turn tool.
 */
interface RebelRunTurnResponse {
  text: string;
  turnId: string;
  conversationId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
  };
}

/**
 * Checks prerequisites before starting the MCP server.
 * If any check fails, exits with a helpful error message to stderr.
 *
 * This is called BEFORE the MCP handshake so the client sees a clean failure.
 */
async function checkPrerequisites(getSettings: McpServerOptions['getSettings']): Promise<void> {
  const settings = await Promise.resolve(getSettings());

  // Check coreDirectory is configured
  if (!settings.coreDirectory) {
    process.stderr.write(
      '[rebel-mcp-server] Error: Core directory is not configured.\n' +
        'Please open Rebel and configure your core directory in Settings.\n'
    );
    process.exit(1);
  }

  // Check Claude API key / auth is present
  if (!hasValidAuth(settings)) {
    process.stderr.write(
      '[rebel-mcp-server] Error: Claude authentication is missing.\n' +
        'Please open Rebel and configure your API key or OAuth token in Settings.\n'
    );
    process.exit(1);
  }

  // Check MCP server is enabled in settings
  if (!settings.mcpServerEnabled) {
    process.stderr.write(
      '[rebel-mcp-server] Error: MCP server is not enabled.\n' +
        'Please open Rebel and enable "Allow external MCP access" in Settings → Connectors.\n'
    );
    process.exit(1);
  }
}

/**
 * Starts the MCP server using stdio transport.
 *
 * This function never returns normally - it runs until the process is killed
 * or a shutdown signal (SIGTERM/SIGINT) is received.
 */
export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const { version, runHeadlessTurn, getSettings } = options;

  // Check prerequisites BEFORE MCP handshake
  await checkPrerequisites(getSettings);

  // CRITICAL: All logging must go to stderr
  process.stderr.write(`[rebel-mcp-server] Starting MCP server v${version}\n`);

  // Simple mutex for single-turn-at-a-time execution
  let isBusy = false;

  const server = new Server(
    {
      name: 'rebel',
      version
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Handle tools/list request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    process.stderr.write('[rebel-mcp-server] Received tools/list request\n');
    return {
      tools: [TOOL_SCHEMA]
    };
  });

  // Handle tools/call request
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    process.stderr.write(`[rebel-mcp-server] Received tools/call: ${name}\n`);

    if (name !== 'rebel_run_turn') {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown tool: ${name}`
          }
        ],
        isError: true
      };
    }

    // Validate prompt argument
    const typedArgs = args as { prompt?: string; sessionId?: string; finishLine?: string } | undefined;
    const prompt = typedArgs?.prompt;
    if (!prompt) {
      return {
        content: [
          {
            type: 'text',
            text: 'Missing required argument: prompt'
          }
        ],
        isError: true
      };
    }
    const finishLine = normalizeFinishLine(typedArgs?.finishLine);

    // Check mutex - reject concurrent calls
    if (isBusy) {
      process.stderr.write('[rebel-mcp-server] Rejecting concurrent call - turn in progress\n');
      return {
        content: [
          {
            type: 'text',
            text: 'Rebel is currently processing another request. Please wait for it to complete.'
          }
        ],
        isError: true
      };
    }

    // Acquire mutex
    isBusy = true;

    try {
      const turnId = `mcp-${randomUUID()}`;
      const sessionId = typedArgs?.sessionId ?? `mcp-session-${Date.now()}`;

      process.stderr.write(
        `[rebel-mcp-server] Executing turn ${turnId}: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"\n`
      );

      // Collect events and track state
      let responseText = '';
      let sawAssistantText = false;
      let sawError = false;
      let errorMessage = '';
      let usage: RebelRunTurnResponse['usage'] | undefined;

      const onEvent = (event: AgentEvent): void => {
        // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- AgentEvent is open at runtime (events stream from the agent turn); this handler logs a subset and the default logs the rest for debugging — an exhaustive assertNever would crash the MCP server turn on unknown/future events.
        switch (event.type) {
          case 'status':
            process.stderr.write(`[rebel-mcp-server] [status] ${event.message}\n`);
            break;

          case 'assistant':
            // Collect streaming assistant text
            if (event.text && event.text.length > 0) {
              responseText += event.text;
              sawAssistantText = true;
            }
            break;

          case 'tool': {
            const stageLabel = event.stage === 'start' ? 'start' : 'end';
            process.stderr.write(
              `[rebel-mcp-server] [tool:${stageLabel}] ${event.toolName}: ${event.detail ?? ''}\n`
            );
            break;
          }

          case 'result':
            // If no assistant text was streamed, use result.text
            if (!sawAssistantText && event.text && event.text.trim().length > 0) {
              responseText = event.text;
            }
            // Capture usage from result event
            if (event.usage) {
              const u = {
                inputTokens: event.usage.inputTokens ?? undefined,
                outputTokens: event.usage.outputTokens ?? undefined,
                cacheCreationTokens: event.usage.cacheCreationTokens ?? undefined,
                cacheReadTokens: event.usage.cacheReadTokens ?? undefined,
                costUsd: event.usage.costUsd ?? undefined
              };
              usage = u;
              process.stderr.write(
                `[rebel-mcp-server] [usage] in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0} cost=$${u.costUsd?.toFixed(6) ?? '0'}\n`
              );
            }
            break;

          case 'error':
            sawError = true;
            errorMessage = event.error;
            process.stderr.write(`[rebel-mcp-server] [error] ${event.error}\n`);
            break;

          // AgentEvent is open at runtime (events arrive over the agent stream),
          // so the default must tolerate unknown/future types — log for debugging,
          // never throw. An exhaustive assertNever would crash the MCP server turn.
          // (Guard suppressed at the switch above.)
          default:
            // Log other events for debugging
            process.stderr.write(`[rebel-mcp-server] [${event.type}]\n`);
            break;
        }
      };

      // Run the agent turn
      await runHeadlessTurn({
        prompt,
        onEvent,
        options: {
          sessionType: 'mcp_server',
          persistMode: { kind: 'none' },
          sessionId,
          resetConversation: false,
          ...(finishLine ? { finishLine } : {}),
        },
      });

      // Build response
      if (sawError) {
        return {
          content: [
            {
              type: 'text',
              text: `Error during agent turn: ${errorMessage}`
            }
          ],
          isError: true
        };
      }

      const response: RebelRunTurnResponse = {
        text: responseText || '(No response text)',
        turnId,
        conversationId: sessionId,
        usage
      };

      process.stderr.write(`[rebel-mcp-server] Turn ${turnId} completed successfully\n`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response, null, 2)
          }
        ]
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[rebel-mcp-server] Turn failed with exception: ${errorMsg}\n`);

      return {
        content: [
          {
            type: 'text',
            text: `Exception during agent turn: ${errorMsg}`
          }
        ],
        isError: true
      };
    } finally {
      // Release mutex
      isBusy = false;
    }
  });

  // Setup graceful shutdown
  const shutdown = async () => {
    process.stderr.write('[rebel-mcp-server] Shutting down...\n');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    fireAndForget(shutdown(), 'mcpServer.sigintShutdown');
  });
  process.on('SIGTERM', () => {
    fireAndForget(shutdown(), 'mcpServer.sigtermShutdown');
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[rebel-mcp-server] MCP server started, waiting for requests...\n');
}
