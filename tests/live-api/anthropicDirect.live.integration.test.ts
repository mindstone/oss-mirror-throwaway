/**
 * Gated live Anthropic-direct BYOK integration test.
 *
 * Drives the production client factory (`createClientForModel`) for
 * `activeProvider: 'anthropic'` with no profile and no proxy, then captures the
 * real outbound fetch body while allowing the request to continue to Anthropic.
 *
 * Gating contract:
 * - Gated SOLELY on `TEST_ANTHROPIC_API_KEY ?? TEST_CLAUDE_API_KEY`.
 * - No key present => describe.skip, never fail.
 * - One tiny call, no retries/sleeps, no latency assertion. Latency is logged,
 *   with a warning past a generous budget.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createClientForModel } from '@core/rebelCore/clientFactory';
import { AnthropicClient } from '@core/rebelCore/clients/anthropicClient';
import { ModelError } from '@core/rebelCore/modelErrors';
import type { AppSettings } from '@shared/types';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describeLiveApi } from '../../src/test-utils/liveApiHarness';

// Use the native (dashed) Anthropic catalog id for the BYOK direct round-trip.
// Post-260529/260530, createClientForModel does NOT silently strip a proxy-dialect
// (`anthropic/`-prefixed) model onto direct Anthropic — it fails closed
// (proxy-dialect-in-direct-anthropic). The `anthropic/`-prefix strip survives as
// defense-in-depth at the AnthropicClient wire boundary and is covered by the pure
// unit test (anthropicClient.wireModel.test.ts); we don't re-exercise it on a paid
// live call. A bare dotted non-alias like `claude-haiku-4.5` is NOT something prod
// emits (catalog ids are dashed) and would 404, so we don't assert it live either.
const REQUEST_MODEL = unsafeAssertRoutingModelId('claude-haiku-4-5');
const BOGUS_MODEL = unsafeAssertRoutingModelId('claude-does-not-exist-9');
const EXPECTED_WIRE_MODEL = 'claude-haiku-4-5';
const LIVE_TIMEOUT_MS = 60_000;
const LATENCY_WARN_MS = 20_000;

function makeSettings(apiKey: string): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'anthropic',
    voice: { enabled: false },
    models: {
      apiKey,
      oauthToken: null,
      authMethod: 'api-key',
      model: EXPECTED_WIRE_MODEL,
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    diagnostics: { enabled: false },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

describeLiveApi(
  {
    provider: 'anthropic',
    label: 'Anthropic direct BYOK — live integration',
    envVar: 'TEST_ANTHROPIC_API_KEY',
    model: REQUEST_MODEL,
  },
  ({ key }) => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  it(
    'round-trips through createClientForModel and sends a bare dashed Anthropic wire model',
    async () => {
      const originalFetch = globalThis.fetch;
      const capturedBodies: Array<Record<string, unknown>> = [];
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const bodyText = typeof init?.body === 'string' ? init.body : '';
        if (bodyText) {
          capturedBodies.push(JSON.parse(bodyText) as Record<string, unknown>);
        }
        return originalFetch(url, init);
      });

      const settings = makeSettings(key);
      const client = await createClientForModel({ model: REQUEST_MODEL, settings });
      expect(client).toBeInstanceOf(AnthropicClient);

      const startedAt = Date.now();
      const result = await client.create({
        model: REQUEST_MODEL,
        systemPrompt: 'You are terse. Reply with one short word.',
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        maxTokens: 16,
      });
      const latencyMs = Date.now() - startedAt;

      const latencyLabel = latencyMs > LATENCY_WARN_MS ? 'past generous budget' : 'within generous budget';
      console.warn(`[live] Anthropic direct BYOK call took ${latencyMs}ms (${latencyLabel})`);

      expect(capturedBodies.length).toBeGreaterThan(0);
      expect(capturedBodies[0].model).toBe(EXPECTED_WIRE_MODEL);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.stopReason.length).toBeGreaterThan(0);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'bogus Anthropic model fails closed with a classified model_unavailable/404 ModelError',
    async () => {
      const settings = makeSettings(key);
      const client = await createClientForModel({ model: BOGUS_MODEL, settings });
      expect(client).toBeInstanceOf(AnthropicClient);

      let caught: unknown;
      try {
        await client.create({
          model: BOGUS_MODEL,
          systemPrompt: 'You are terse. Reply with one short word.',
          messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
          maxTokens: 16,
        });
        throw new Error('expected Anthropic create to reject on bogus model');
      } catch (err) {
        caught = err;
      }

      // Regression record: 260417_rebel_1d9_404_model_classification_gap and
      // 260401_opus_model_error_detection_gap both depended on the real provider
      // 404 body staying classified as model unavailable. This is effectively
      // free because Anthropic rejects the model before generation.
      if (!(caught instanceof ModelError)) {
        throw new Error(
          'provider unreachable (network/transport) - not a bogus-model ' +
            'classification failure. The Anthropic API could not be reached, so ' +
            'the 404 fail-closed path was never exercised. This is a ' +
            'harness-health / reachability problem, not a model classification regression. ' +
            `Underlying error: ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`,
        );
      }

      expect(caught.kind).toBe('model_unavailable');
      expect(caught.status).toBe(404);
    },
    LIVE_TIMEOUT_MS,
  );
  },
);
