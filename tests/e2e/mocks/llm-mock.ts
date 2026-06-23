/**
 * LLM Mock Infrastructure for E2E Tests
 *
 * This module provides mock infrastructure for agent:turn IPC calls,
 * enabling fast, deterministic E2E tests without live LLM calls.
 *
 * Architecture:
 * - Injects via electronApp.evaluate() to override IPC handlers in the main process
 * - Emits events via setTimeout() (NOT setImmediate) for proper state machine transitions
 * - Uses event.sender.send() targeting instead of BrowserWindow broadcast
 * - Supports pattern matching for different response scenarios
 *
 * Event flow:
 * 1. agent:turn returns { turnId } immediately
 * 2. Events stream via webContents.send('agent:event', { turnId, event })
 * 3. Event sequence: status -> (optional: tool start/end) -> assistant -> result
 *
 * @see docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 3)
 */

import type { ElectronApplication } from '@playwright/test';

// =============================================================================
// Types
// =============================================================================

/**
 * A tool call to simulate during the mock response.
 */
export interface MockToolCall {
  /** Tool name (e.g., 'Read', 'Edit', 'Write') */
  name: string;
  /** Detail/description of what the tool is doing */
  detail: string;
  /** Optional delay before tool end event (ms). Default: 20 */
  durationMs?: number;
}

/**
 * Error types that can be simulated by the mock.
 * Maps to real error shapes from agentTurnExecutor.
 */
export type MockErrorType =
  | 'rate_limit'
  | 'context_overflow'
  | 'overloaded'
  | 'model_not_found'
  | 'network_timeout';

/**
 * A mock response configuration for pattern-matched prompts.
 */
export interface MockResponse {
  /**
   * RegExp pattern to match against the prompt.
   * Note: When passing through electronApp.evaluate(), RegExp objects
   * must be serialized as { source, flags }.
   */
  pattern: RegExp;
  /** The response text to return */
  response: string;
  /** Optional tool calls to simulate before the response */
  toolCalls?: MockToolCall[];
  /**
   * If true, emit assistant_delta events for streaming UI tests.
   * If false (default), emit a single assistant event.
   */
  streaming?: boolean;
  /**
   * Custom delays for event timing (ms).
   * Default: status=10, assistant=50, result=100
   */
  delays?: {
    status?: number;
    assistant?: number;
    result?: number;
  };
  /**
   * If set, the mock will emit an error event instead of a successful response.
   * The `response` field is used as partial text if `partialBeforeError` is true.
   */
  errorType?: MockErrorType;
  /**
   * If true and errorType is set, emit some streaming content before the error.
   */
  partialBeforeError?: boolean;
}

/**
 * Options for enabling LLM mocking.
 */
export interface MockOptions {
  /** Array of pattern-matched responses */
  responses: MockResponse[];
  /** Default response when no pattern matches. Default: 'Mock response' */
  defaultResponse?: string;
  /** Enable debug logging in the main process. Default: false */
  debug?: boolean;
}

/**
 * Serializable version of MockResponse for passing through electronApp.evaluate().
 * RegExp objects cannot be passed directly through Electron's IPC boundary.
 */
interface SerializableMockResponse {
  pattern: { source: string; flags: string };
  response: string;
  toolCalls?: MockToolCall[];
  streaming?: boolean;
  delays?: {
    status?: number;
    assistant?: number;
    result?: number;
  };
  errorType?: MockErrorType;
  partialBeforeError?: boolean;
}

/**
 * Serializable version of MockOptions.
 */
interface SerializableMockOptions {
  responses: SerializableMockResponse[];
  defaultResponse: string;
  debug: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Enable LLM mocking in an Electron app for E2E testing.
 *
 * This function injects mock handlers for `agent:turn` and `agent:stop-turn`
 * IPC channels, allowing tests to run without making live LLM calls.
 *
 * Usage:
 * ```typescript
 * await enableLlmMocking(electronApp, {
 *   responses: [
 *     { pattern: /hello/i, response: 'Hello! How can I help?' },
 *     { pattern: /weather/i, response: 'I cannot check the weather.' },
 *   ],
 *   defaultResponse: 'I understand.',
 * });
 * ```
 *
 * @param app - The Playwright ElectronApplication instance
 * @param options - Mock configuration options
 */
export async function enableLlmMocking(
  app: ElectronApplication,
  options: MockOptions
): Promise<void> {
  // Serialize options for passing through Electron IPC
  const serializedOptions: SerializableMockOptions = {
    responses: options.responses.map((r) => ({
      pattern: { source: r.pattern.source, flags: r.pattern.flags },
      response: r.response,
      toolCalls: r.toolCalls,
      streaming: r.streaming,
      delays: r.delays,
      errorType: r.errorType,
      partialBeforeError: r.partialBeforeError,
    })),
    defaultResponse: options.defaultResponse ?? 'Mock response',
    debug: options.debug ?? false,
  };

  await app.evaluate(async ({ ipcMain }, opts: SerializableMockOptions) => {
    const { responses, defaultResponse, debug } = opts;

    // Track active timers per turnId for cancellation support
    const activeTimers = new Map<string, NodeJS.Timeout[]>();

    // Helper to log in debug mode
    const debugLog = (msg: string) => {
      if (debug) {
        console.log(`[LLM-Mock] ${msg}`);
      }
    };

    // Helper to schedule a timer and track it
    const scheduleEvent = (
      turnId: string,
      callback: () => void,
      delayMs: number
    ): void => {
      const timer = setTimeout(() => {
        // Remove this timer from tracking once it fires
        const timers = activeTimers.get(turnId);
        if (timers) {
          const idx = timers.indexOf(timer);
          if (idx >= 0) timers.splice(idx, 1);
        }
        callback();
      }, delayMs);

      // Track the timer
      if (!activeTimers.has(turnId)) {
        activeTimers.set(turnId, []);
      }
      activeTimers.get(turnId)!.push(timer);
    };

    // Helper to cancel all pending timers for a turn
    const cancelTurn = (turnId: string): void => {
      const timers = activeTimers.get(turnId);
      if (timers) {
        debugLog(`Cancelling ${timers.length} pending timers for turnId: ${turnId}`);
        for (const timer of timers) {
          clearTimeout(timer);
        }
        activeTimers.delete(turnId);
      }
    };

    // Remove existing handlers to prevent conflicts
    try {
      ipcMain.removeHandler('agent:turn');
    } catch {
      // Handler may not exist - that's fine
    }
    try {
      ipcMain.removeHandler('agent:stop-turn');
    } catch {
      // Handler may not exist - that's fine
    }

    // Mock agent:turn handler
    ipcMain.handle(
      'agent:turn',
      async (
        event: Electron.IpcMainInvokeEvent,
        request: { prompt: string; sessionId: string }
      ) => {
        const { prompt, sessionId } = request;
        const turnId = `mock-turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        debugLog(`agent:turn received - turnId: ${turnId}, sessionId: ${sessionId}`);
        debugLog(`Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`);

        // Find matching response by pattern
        let responseText = defaultResponse;
        let matchedResponse: (typeof responses)[number] | undefined;

        for (const r of responses) {
          const pattern = new RegExp(r.pattern.source, r.pattern.flags);
          if (pattern.test(prompt)) {
            responseText = r.response;
            matchedResponse = r;
            debugLog(`Matched pattern: ${r.pattern.source}`);
            break;
          }
        }

        // Get timing delays (use defaults if not specified)
        const delays = {
          status: matchedResponse?.delays?.status ?? 10,
          assistant: matchedResponse?.delays?.assistant ?? 50,
          result: matchedResponse?.delays?.result ?? 100,
        };

        // Use event.sender.send() for targeted events (not BrowserWindow broadcast)
        const sender = event.sender;

        // Handle error responses
        if (matchedResponse?.errorType) {
          const errorMessages: Record<string, { message: string; code?: string }> = {
            rate_limit: { message: 'Rate limit exceeded. Please try again later.', code: '429' },
            context_overflow: { message: 'Context window exceeded. Your conversation is too long.', code: '400' },
            overloaded: { message: 'The model is currently overloaded. Please try again.', code: '529' },
            model_not_found: { message: 'Model not found. Please check your model selection.', code: '404' },
            network_timeout: { message: 'Network request timed out. Check your connection.', code: 'TIMEOUT' },
          };

          const errorInfo = errorMessages[matchedResponse.errorType] ?? { message: 'Unknown error' };

          // Schedule status event first
          scheduleEvent(turnId, () => {
            sender.send('agent:event', {
              turnId,
              event: { type: 'status' as const, message: 'Processing request...', timestamp: Date.now() },
            });
          }, delays.status);

          // Optionally emit partial streaming content before the error
          let errorDelay = delays.status + delays.assistant;
          if (matchedResponse.partialBeforeError && matchedResponse.streaming) {
            const partialText = responseText.slice(0, Math.floor(responseText.length / 2));
            scheduleEvent(turnId, () => {
              sender.send('agent:event', {
                turnId,
                event: { type: 'assistant_delta' as const, text: partialText, timestamp: Date.now() },
              });
            }, delays.status + 20);
            errorDelay = delays.status + 50;
          }

          // Emit error event
          scheduleEvent(turnId, () => {
            debugLog(`Emitting error event (${matchedResponse!.errorType})`);
            sender.send('agent:event', {
              turnId,
              event: {
                type: 'error' as const,
                error: errorInfo.message,
                errorCode: errorInfo.code,
                timestamp: Date.now(),
              },
            });
          }, errorDelay);

          // Emit result to mark turn as complete
          scheduleEvent(turnId, () => {
            sender.send('agent:event', {
              turnId,
              event: {
                type: 'result' as const,
                text: '',
                model: 'mock-model',
                timestamp: Date.now(),
              },
            });
          }, errorDelay + 50);

          return { turnId };
        }

        // Schedule status event
        scheduleEvent(turnId, () => {
          debugLog(`Emitting status event for turnId: ${turnId}`);
          sender.send('agent:event', {
            turnId,
            event: {
              type: 'status' as const,
              message: 'Processing request...',
              timestamp: Date.now(),
            },
          });
        }, delays.status);

        let nextEventDelay = delays.status;

        // Schedule tool call events if specified
        if (matchedResponse?.toolCalls) {
          for (const toolCall of matchedResponse.toolCalls) {
            const toolDuration = toolCall.durationMs ?? 20;
            const toolStartDelay = nextEventDelay + 10;
            const toolEndDelay = toolStartDelay + toolDuration;

            // Generate toolUseId ONCE and use for both start and end events
            // (fix: reviewers noted start/end had different IDs which breaks UI correlation)
            const toolUseId = `mock-tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

            // Tool start event
            scheduleEvent(turnId, () => {
              debugLog(`Emitting tool start: ${toolCall.name} (${toolUseId})`);
              sender.send('agent:event', {
                turnId,
                event: {
                  type: 'tool' as const,
                  toolName: toolCall.name,
                  toolUseId,
                  parentToolUseId: null,
                  detail: toolCall.detail,
                  stage: 'start' as const,
                  timestamp: Date.now(),
                },
              });
            }, toolStartDelay);

            // Tool end event (uses same toolUseId as start)
            scheduleEvent(turnId, () => {
              debugLog(`Emitting tool end: ${toolCall.name} (${toolUseId})`);
              sender.send('agent:event', {
                turnId,
                event: {
                  type: 'tool' as const,
                  toolName: toolCall.name,
                  toolUseId,
                  parentToolUseId: null,
                  detail: `${toolCall.detail} (completed)`,
                  stage: 'end' as const,
                  timestamp: Date.now(),
                },
              });
            }, toolEndDelay);

            nextEventDelay = toolEndDelay;
          }
        }

        // Schedule assistant event(s)
        const assistantDelay = nextEventDelay + delays.assistant;

        // Track when the last assistant-related event fires (for result scheduling)
        let lastAssistantEventDelay = assistantDelay;

        if (matchedResponse?.streaming) {
          // Streaming mode: emit multiple assistant_delta events
          const chunkSize = 20;
          const chunks: string[] = [];
          for (let i = 0; i < responseText.length; i += chunkSize) {
            chunks.push(responseText.slice(i, i + chunkSize));
          }

          debugLog(`Streaming ${chunks.length} chunks`);

          chunks.forEach((chunk, idx) => {
            const chunkDelay = assistantDelay + idx * 5; // 5ms between chunks
            scheduleEvent(turnId, () => {
              debugLog(`Emitting assistant_delta chunk ${idx + 1}/${chunks.length}`);
              sender.send('agent:event', {
                turnId,
                event: {
                  type: 'assistant_delta' as const,
                  text: chunk,
                  timestamp: Date.now(),
                },
              });
            }, chunkDelay);
          });

          // Also emit final assistant event with full text
          const finalAssistantDelay = assistantDelay + chunks.length * 5 + 10;
          scheduleEvent(turnId, () => {
            debugLog(`Emitting final assistant event`);
            sender.send('agent:event', {
              turnId,
              event: {
                type: 'assistant' as const,
                text: responseText,
                timestamp: Date.now(),
              },
            });
          }, finalAssistantDelay);

          // Fix: result must fire AFTER final assistant event, not before
          lastAssistantEventDelay = finalAssistantDelay;
        } else {
          // Non-streaming mode: single assistant event
          scheduleEvent(turnId, () => {
            debugLog(`Emitting assistant event`);
            sender.send('agent:event', {
              turnId,
              event: {
                type: 'assistant' as const,
                text: responseText,
                timestamp: Date.now(),
              },
            });
          }, assistantDelay);
        }

        // Schedule result event (turn completion)
        // Must be after ALL assistant events (fix: was using assistantDelay which broke streaming)
        const resultDelay = lastAssistantEventDelay + delays.result;
        scheduleEvent(turnId, () => {
          debugLog(`Emitting result event for turnId: ${turnId}`);
          sender.send('agent:event', {
            turnId,
            event: {
              type: 'result' as const,
              text: responseText,
              model: 'mock-model',
              usage: {
                inputTokens: prompt.length,
                outputTokens: responseText.length,
                costUsd: 0,
                contextUtilization: 5,
                contextWindow: 200000,
              },
              timestamp: Date.now(),
            },
          });

          // Clean up timer tracking for this turn
          activeTimers.delete(turnId);
          debugLog(`Turn completed: ${turnId}`);
        }, resultDelay);

        // Return turnId immediately (matches real behavior)
        return { turnId };
      }
    );

    // Mock agent:stop-turn handler
    ipcMain.handle(
      'agent:stop-turn',
      async (event: Electron.IpcMainInvokeEvent, turnIdToStop: string) => {
        debugLog(`agent:stop-turn received for turnId: ${turnIdToStop}`);

        // Check if turn exists (has pending timers)
        const hasPendingTimers = activeTimers.has(turnIdToStop) && activeTimers.get(turnIdToStop)!.length > 0;

        if (!hasPendingTimers) {
          // Turn doesn't exist or already completed - don't emit spurious error event
          // (fix: reviewers noted emitting error for non-existent turn breaks UI state)
          debugLog(`Turn ${turnIdToStop} not found or already completed`);
          return { success: false, reason: 'Turn not found or already completed' };
        }

        // Cancel any pending timers for this turn
        cancelTurn(turnIdToStop);

        // Emit error event to signal cancellation
        event.sender.send('agent:event', {
          turnId: turnIdToStop,
          event: {
            type: 'error' as const,
            error: 'Turn cancelled by user',
            isTransient: true,
            timestamp: Date.now(),
          },
        });

        return { success: true, reason: 'Turn cancelled by mock' };
      }
    );

    debugLog('LLM mocking enabled');
  }, serializedOptions);
}

/**
 * Disable LLM mocking by restoring original IPC handlers.
 *
 * Note: This doesn't restore the original handlers - it just removes the mocks.
 * The app will need to be restarted to get real LLM functionality back.
 * For most test scenarios, simply closing the app after the test is sufficient.
 *
 * @param app - The Playwright ElectronApplication instance
 */
export async function disableLlmMocking(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ ipcMain }) => {
    try {
      ipcMain.removeHandler('agent:turn');
    } catch {
      // Handler may not exist
    }
    try {
      ipcMain.removeHandler('agent:stop-turn');
    } catch {
      // Handler may not exist
    }
    console.log('[LLM-Mock] LLM mocking disabled');
  });
}

// =============================================================================
// Convenience Helpers
// =============================================================================

/**
 * Create a simple mock response for a specific prompt pattern.
 *
 * @param pattern - RegExp pattern to match against prompts
 * @param response - Response text to return
 * @returns MockResponse object
 */
export function mockResponse(pattern: RegExp, response: string): MockResponse {
  return { pattern, response };
}

/**
 * Create a mock response with tool calls.
 *
 * @param pattern - RegExp pattern to match against prompts
 * @param response - Response text to return
 * @param toolCalls - Array of tool calls to simulate
 * @returns MockResponse object
 */
export function mockResponseWithTools(
  pattern: RegExp,
  response: string,
  toolCalls: MockToolCall[]
): MockResponse {
  return { pattern, response, toolCalls };
}

/**
 * Create a streaming mock response for testing streaming UI.
 *
 * @param pattern - RegExp pattern to match against prompts
 * @param response - Response text to stream
 * @returns MockResponse object with streaming enabled
 */
export function mockStreamingResponse(pattern: RegExp, response: string): MockResponse {
  return { pattern, response, streaming: true };
}

/**
 * Create a mock response that simulates an error.
 *
 * @param pattern - RegExp pattern to match against prompts
 * @param errorType - Type of error to simulate
 * @param options - Additional options (partial text before error, delays)
 * @returns MockResponse object that emits an error event
 */
export function mockErrorResponse(
  pattern: RegExp,
  errorType: MockErrorType,
  options?: { partialText?: string; delays?: MockResponse['delays'] }
): MockResponse {
  return {
    pattern,
    response: options?.partialText ?? '',
    errorType,
    partialBeforeError: !!options?.partialText,
    streaming: !!options?.partialText,
    delays: options?.delays,
  };
}
