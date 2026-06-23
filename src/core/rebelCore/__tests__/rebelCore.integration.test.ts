import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
/**
 * Rebel Core Integration Tests
 *
 * These tests make REAL API calls to validate the full agent loop.
 * They require an API key to be present in the app settings.
 *
 * Run with: npm test -- --run src/core/rebelCore/__tests__/rebelCore.integration.test.ts
 *
 * To skip in CI: tests are gated by REBEL_CORE_INTEGRATION env var or presence of API key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAgentLoop } from '../agentLoop';
import { createAgentMessageAdapter } from '../agentMessageAdapter';
import { listRegisteredTools, executeRegisteredTool } from '../toolRegistry';
import { createHookAwareToolExecutor } from '../hookPipeline';
import { AnthropicClient } from '../clients/anthropicClient';
import type { RebelCoreEvent, BuiltinToolContext } from '../types';
import type { AppSettings } from '@shared/types';
import {
  getApiKeyForDirectUse,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
/* eslint-disable no-console -- integration test diagnostic output */

function loadSettings(): AppSettings | null {
  try {
    const settingsPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'mindstone-rebel',
      'app-settings.json',
    );
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.claude) return null;
    return parsed as AppSettings;
  } catch {
    return null;
  }
}

const settings = loadSettings();
// Provider-shape gate (260419 prevention): these tests instantiate
// `AnthropicClient` directly with `apiKey`, hitting Anthropic's native API.
// A legacy `claude.apiKey` can coexist with `activeProvider='openrouter' | 'codex'`,
// in which case auth presence alone lies — the user's effective routing is
// proxied. Compose `isDirectAnthropicConfig(settings)` AND auth-shape so the
// gate matches the real precondition. See postmortem
// docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md.
const apiKey = settings
  ? getApiKeyForDirectUse(settings)
  : (process.env.ANTHROPIC_API_KEY ?? '');
const isDirectAnthropic = settings ? isDirectAnthropicConfig(settings) : true;
const canRun = !!apiKey && isDirectAnthropic;

if (settings && apiKey && !isDirectAnthropic) {
  console.log(
    '[rebelCore.integration] Skipping live API tests: settings route via proxy provider '
    + `(activeProvider='${String(settings.activeProvider)}'); these tests require direct-Anthropic settings.`,
  );
}

describe.skipIf(!canRun)('Rebel Core Integration (live API)', () => {
  beforeAll(() => {
    if (!canRun) return;
    console.log('Running live API integration tests with Rebel Core');
  });

  it('should complete a simple text-only turn', async () => {
    const events: RebelCoreEvent[] = [];

    const result = await runAgentLoop(
      {
        client: new AnthropicClient({ apiKey: apiKey! }),
        model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        systemPrompt: 'You are a helpful assistant. Respond in one short sentence.',
        messages: [{ role: 'user', content: 'What is 2 + 2?' }],
        maxTokens: 256,
        maxTurns: 1,
      },
      async () => ({ output: '', isError: true }),
      (event) => events.push(event),
    );

    expect(result.turns).toBe(1);
    expect(result.totalUsage.inputTokens).toBeGreaterThan(0);
    expect(result.totalUsage.outputTokens).toBeGreaterThan(0);

    const textEvents = events.filter((e) => e.type === 'assistant:text');
    expect(textEvents.length).toBeGreaterThan(0);

    const fullText = textEvents.map((e) => (e as any).text).join('');
    expect(fullText.toLowerCase()).toContain('4');

    const completeEvent = events.find((e) => e.type === 'loop:complete');
    expect(completeEvent).toBeDefined();
  }, 30_000);

  it('should produce valid AgentMessage shapes via the adapter', async () => {
    const adapter = createAgentMessageAdapter({
      model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      tools: [],
      sessionId: 'test-session',
      cwd: process.cwd(),
    });

    const sdkMessages: any[] = [];

    // Emit init
    sdkMessages.push(adapter.createInitMessage());

    await runAgentLoop(
      {
        client: new AnthropicClient({ apiKey: apiKey! }),
        model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        systemPrompt: 'Reply with exactly: "Hello from Rebel Core"',
        messages: [{ role: 'user', content: 'Say hello.' }],
        maxTokens: 128,
        maxTurns: 1,
      },
      async () => ({ output: '', isError: true }),
      (event) => {
        const msgs = adapter.handleEvent(event);
        sdkMessages.push(...msgs);
      },
    );

    // Verify init message shape
    const init = sdkMessages[0];
    expect(init.type).toBe('system');
    expect(init.subtype).toBe('init');
    // session_id is omitted — Rebel Core is stateless (no server-side session)
    expect(init.session_id).toBeUndefined();
    expect(init.model).toBe('claude-sonnet-4-20250514');

    // Verify at least one assistant message
    const assistantMsgs = sdkMessages.filter((m) => m.type === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);

    // Verify result message
    const result = sdkMessages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    expect(result.subtype).toBe('success');
    expect(result.is_error).toBe(false);
    expect(typeof result.total_cost_usd).toBe('number');
    expect(result.total_cost_usd).toBeGreaterThan(0);
    expect(result.usage).toBeDefined();
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  }, 30_000);

  it('should execute a tool call (Read) and continue the loop', async () => {
    const events: RebelCoreEvent[] = [];
    const tools = listRegisteredTools();

    const toolContext: BuiltinToolContext = { cwd: process.cwd() };

    const result = await runAgentLoop(
      {
        client: new AnthropicClient({ apiKey: apiKey! }),
        model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        systemPrompt: 'You are a file reader. Use the Read tool to read the requested file. Then summarize what you found in one sentence.',
        messages: [
          {
            role: 'user',
            content: `Read the file at ${path.join(process.cwd(), 'package.json')} and tell me the project name.`,
          },
        ],
        tools,
        maxTokens: 1024,
        maxTurns: 3,
      },
      async (toolName, input, _id) => executeRegisteredTool(toolName, input, toolContext),
      (event) => events.push(event),
    );

    // Should have made at least one tool call
    const toolStarts = events.filter((e) => e.type === 'tool_use:start');
    expect(toolStarts.length).toBeGreaterThan(0);

    // At least one should be a Read
    const readCalls = toolStarts.filter((e) => (e as any).toolName === 'Read');
    expect(readCalls.length).toBeGreaterThan(0);

    // Tool results should be present
    const toolResults = events.filter((e) => e.type === 'tool_use:result');
    expect(toolResults.length).toBeGreaterThan(0);

    // Should have completed
    expect(events.some((e) => e.type === 'loop:complete')).toBe(true);
    expect(result.turns).toBeGreaterThanOrEqual(2); // At least: API call, tool call, API call
  }, 60_000);

  it('should handle abort signal', async () => {
    const controller = new AbortController();
    const events: RebelCoreEvent[] = [];

    // Abort after 500ms
    setTimeout(() => controller.abort(), 500);

    await expect(
      runAgentLoop(
        {
          client: new AnthropicClient({ apiKey: apiKey! }),
          model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
          systemPrompt: 'Write a very long essay about the history of computing. Be extremely detailed.',
          messages: [{ role: 'user', content: 'Go.' }],
          maxTokens: 4096,
          maxTurns: 1,
          signal: controller.signal,
        },
        async () => ({ output: '', isError: true }),
        (event) => events.push(event),
      ),
    ).rejects.toThrow();
  }, 15_000);

  it('should run hooks (PreToolUse deny)', async () => {
    const events: RebelCoreEvent[] = [];
    const tools = listRegisteredTools();

    const denyHook = async () => ({
      continue: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: 'Test: all tools denied',
      },
    });

    const hookAwareExecutor = createHookAwareToolExecutor(
      async (toolName, input) => executeRegisteredTool(toolName, input, { cwd: process.cwd() }),
      { PreToolUse: [{ hooks: [denyHook] }] },
    );

    const _result = await runAgentLoop(
      {
        client: new AnthropicClient({ apiKey: apiKey! }),
        model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        systemPrompt: 'Use the Read tool to read package.json. Always use tools when asked.',
        messages: [{ role: 'user', content: 'Read package.json' }],
        tools,
        maxTokens: 1024,
        maxTurns: 3,
      },
      hookAwareExecutor,
      (event) => events.push(event),
    );

    // Tool should have been attempted but denied
    const toolResults = events.filter((e) => e.type === 'tool_use:result');
    const deniedResults = toolResults.filter((e) => (e as any).isError === true);
    // At least one denied tool result
    expect(deniedResults.length).toBeGreaterThan(0);
  }, 60_000);
});
