/**
 * Flagship gated live-LLM integration test.
 *
 * Drives the production client factory (`createClientForModel`) with DeepSeek V4
 * Flash via OpenRouter (no proxy) and makes TWO real, cheap round-trips
 * (~$1e-5 each): one non-streaming `create`, one streaming `stream`.
 *
 * Why this exists (per docs/plans/improve_tests.md §4):
 *  - It exercises the codebase's own routing seam end-to-end. An inline
 *    `ModelProfile` with `providerType: 'openrouter'` must resolve to the
 *    `openai-compatible` target and produce an `OpenAIClient` — asserting the
 *    instance type locks routing so silent routing drift (e.g. accidentally
 *    sending OpenRouter traffic through the Anthropic proxy) fails this test.
 *  - The streaming case proves real SSE ordering/assembly through the
 *    OpenAIClient translator: the joined `text_delta` chunks must reconstruct
 *    the final assembled content. A mock cannot prove that.
 *
 * Gating contract:
 *  - Gated SOLELY on `TEST_OPENROUTER_API_KEY` (loaded from `.env.test` by
 *    vitest.setup.ts). Absent key → the whole describe SKIPS, never fails, so
 *    CI without secrets stays green.
 *  - The gate intentionally does NOT touch getAuthForDirectUse /
 *    getApiKeyForDirectUse / hasDirectAuth and never READS a `settings.claude.*`
 *    field, so scripts/check-integration-test-provider-gates.ts reports no
 *    violation. Settings are constructed via a pure object literal where
 *    `models: { apiKey: ... }` is a write (property assignment), not a read.
 */
import { expect, it } from 'vitest';
import { createClientForModel } from '@core/rebelCore/clientFactory';
import { OpenAIClient } from '@core/rebelCore/clients/openaiClient';
import type { CreateParams, StreamEvent, StreamParams } from '@core/rebelCore/modelClient';
import type { TextBlock } from '@core/rebelCore/modelTypes';
import type { AppSettings } from '@shared/types';
import type { ModelProfile } from '@shared/types/settings';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describeLiveApi } from '../../src/test-utils/liveApiHarness';

// modelCatalog OpenRouter id for DeepSeek V4 Flash (~$1e-5/call).
const MODEL = unsafeAssertRoutingModelId('deepseek/deepseek-v4-flash');

const LIVE_TIMEOUT_MS = 60_000;

// DeepSeek V4 Flash is a REASONING model: it spends output tokens on a hidden
// reasoning trace before emitting the visible answer. With a 16-token budget the
// whole allowance is consumed by reasoning and `content` comes back empty
// (finish_reason="length"). 256 is still tiny — observed cost ~$1e-5/call — and
// leaves room for the reasoning trace plus the one-word answer.
const MAX_TOKENS = 256;

/**
 * Minimal AppSettings built from a pure object literal — `models: { apiKey }`
 * is a WRITE, so the provider-gate AST check does not flag it. The dummy
 * Anthropic key only guards any incidental direct-Anthropic auth path; routing
 * is driven entirely by the explicit `profile` below, so resolveTargetForModel
 * returns kind `openai-compatible` and never touches Anthropic.
 */
function makeSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: 'dummy-anthropic-key-not-used',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    diagnostics: { enabled: false },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

/** Concatenate all text blocks of a content array into one string. */
function textOf(content: ReadonlyArray<{ type: string }>): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

describeLiveApi(
  {
    provider: 'openrouter',
    label: 'OpenRouter DeepSeek V4 Flash — live integration',
    envVar: 'TEST_OPENROUTER_API_KEY',
    model: MODEL,
  },
  ({ key }) => {
  // The routing seam: an explicit OpenRouter profile makes resolution
  // deterministic and independent of the user's real app settings.
  const profile = {
    id: 'openrouter-deepseek-test',
    name: 'OpenRouter DeepSeek (test)',
    providerType: 'openrouter',
    serverUrl: 'https://openrouter.ai/api/v1',
    apiKey: key,
    model: MODEL,
    enabled: true,
  } as unknown as ModelProfile;

  it(
    'non-streaming round-trip through createClientForModel → OpenAIClient.create',
    async () => {
      const settings = makeSettings();
      const client = await createClientForModel({ model: MODEL, profile, settings });

      // Routing lock: an OpenRouter profile MUST resolve to the
      // openai-compatible seam, i.e. an OpenAIClient. Catches routing drift.
      expect(client).toBeInstanceOf(OpenAIClient);

      const params: CreateParams = {
        model: MODEL,
        systemPrompt: 'You are a terse assistant. Reply with a single word.',
        messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
        maxTokens: MAX_TOKENS,
      };

      const res = await client.create(params);

      // Tolerant shape asserts — no exact-wording dependence.
      expect(Array.isArray(res.content)).toBe(true);
      expect(res.content.length).toBeGreaterThan(0);

      const textBlocks = res.content.filter((b) => b.type === 'text');
      expect(textBlocks.length).toBeGreaterThan(0);
      expect(textOf(res.content).trim().length).toBeGreaterThan(0);

      expect(typeof res.stopReason).toBe('string');
      expect(res.stopReason.length).toBeGreaterThan(0);

      expect(res.usage.outputTokens).toBeGreaterThan(0);
      expect(res.usage.inputTokens).toBeGreaterThan(0);

      // Soft signal (informational): the model usually echoes "pong". Logged,
      // not asserted, to stay robust to model nondeterminism.
      if (!textOf(res.content).toLowerCase().includes('pong')) {
        console.warn(
          `[live] DeepSeek did not echo "pong"; got: ${JSON.stringify(textOf(res.content))}`,
        );
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'streaming chunk ordering through createClientForModel → OpenAIClient.stream',
    async () => {
      const settings = makeSettings();
      const client = await createClientForModel({ model: MODEL, profile, settings });
      expect(client).toBeInstanceOf(OpenAIClient);

      const params: StreamParams = {
        model: MODEL,
        systemPrompt: 'You are a terse assistant. Reply with a single word.',
        messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
        maxTokens: MAX_TOKENS,
      };

      const events: StreamEvent[] = [];
      const res = await client.stream(params, (e) => events.push(e));

      // Real streaming happened.
      expect(events.length).toBeGreaterThan(0);

      const textDeltas = events.filter(
        (e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta',
      );
      expect(textDeltas.length).toBeGreaterThan(0);

      const streamedText = textDeltas.map((e) => e.text).join('');
      expect(streamedText.length).toBeGreaterThan(0);

      // Assembly correctness: the streamed chunks, joined in arrival order,
      // must reconstruct the final assembled content. This is the load-bearing
      // assertion a mock cannot prove — it exercises real SSE ordering through
      // the OpenAIClient translator. Allow containment to tolerate any trailing
      // normalization in the assembled blocks.
      const assembledText = textOf(res.content);
      expect(assembledText.length).toBeGreaterThan(0);
      expect(assembledText).toContain(streamedText.trim());

      expect(typeof res.stopReason).toBe('string');
      expect(res.stopReason.length).toBeGreaterThan(0);
      expect(res.usage.outputTokens).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
  },
);
