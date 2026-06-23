import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings } from '@shared/types';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';

type CallToolHandler = (request: {
  params: { name: string; arguments?: unknown };
}) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const capturedHandlers: { call?: CallToolHandler } = {};
const closeMock = vi.fn(async () => undefined);

function readMethodFromSchema(schema: unknown): string | undefined {
  const shape = (schema as { shape?: { method?: { def?: { values?: unknown[] }; value?: unknown } } })?.shape;
  const methodNode = shape?.method;
  if (!methodNode) return undefined;
  const literalValues = methodNode.def?.values;
  if (Array.isArray(literalValues) && typeof literalValues[0] === 'string') {
    return literalValues[0];
  }
  if (typeof methodNode.value === 'string') {
    return methodNode.value;
  }
  return undefined;
}

 
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  class Server {
    constructor(_info: unknown, _capabilities: unknown) {}
    setRequestHandler(schema: unknown, handler: CallToolHandler): void {
      const method = readMethodFromSchema(schema);
      if (method === 'tools/call') {
        capturedHandlers.call = handler;
      }
    }
    async connect(): Promise<void> {
      return undefined;
    }
    close = closeMock;
  }
  return { Server };
});

 
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  class StdioServerTransport {}
  return { StdioServerTransport };
});

import { startMcpServer } from '../index';

const makeSettings = (): AppSettings =>
  ({
    coreDirectory: '/tmp/workspace',
    activeProvider: 'anthropic',
    models: { apiKey: 'test-key' },
    claude: { apiKey: 'test-key' },
    mcpServerEnabled: true,
  }) as unknown as AppSettings;

describe('Rebel MCP server `rebel_run_turn` --finish-line plumbing', () => {
  beforeEach(() => {
    capturedHandlers.call = undefined;
    closeMock.mockClear();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards `finishLine` from the tool arguments into HeadlessTurnOptions', async () => {
    const runHeadlessTurn = vi.fn(
      async (params: {
        prompt: string;
        onEvent: (event: AgentEvent) => void;
        options: HeadlessTurnOptions;
      }) => {
        params.onEvent({
          type: 'result',
          text: 'done',
          usage: {},
        } as unknown as AgentEvent);
      },
    );

    await startMcpServer({
      version: 'test',
      runHeadlessTurn: runHeadlessTurn as never,
      getSettings: makeSettings,
    });

    expect(capturedHandlers.call).toBeDefined();

    const result = await capturedHandlers.call!({
      params: {
        name: 'rebel_run_turn',
        arguments: {
          prompt: 'polish the draft',
          sessionId: 'mcp-test',
          finishLine: '   ready to send   ',
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
    const passedOptions = runHeadlessTurn.mock.calls[0]![0]!.options;
    expect(passedOptions.finishLine).toBe('ready to send');
  });

  it('omits `finishLine` when the tool argument is missing or empty', async () => {
    const runHeadlessTurn = vi.fn(
      async (params: {
        prompt: string;
        onEvent: (event: AgentEvent) => void;
        options: HeadlessTurnOptions;
      }) => {
        params.onEvent({
          type: 'result',
          text: 'done',
          usage: {},
        } as unknown as AgentEvent);
      },
    );

    await startMcpServer({
      version: 'test',
      runHeadlessTurn: runHeadlessTurn as never,
      getSettings: makeSettings,
    });

    await capturedHandlers.call!({
      params: { name: 'rebel_run_turn', arguments: { prompt: 'hello' } },
    });
    expect(runHeadlessTurn.mock.calls[0]![0]!.options.finishLine).toBeUndefined();

    await capturedHandlers.call!({
      params: { name: 'rebel_run_turn', arguments: { prompt: 'hello', finishLine: '   ' } },
    });
    expect(runHeadlessTurn.mock.calls[1]![0]!.options.finishLine).toBeUndefined();
  });
});
