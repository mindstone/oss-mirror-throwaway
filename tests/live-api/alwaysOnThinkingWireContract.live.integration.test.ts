/**
 * Gated live wire-contract test for ALWAYS-ON-THINKING Anthropic models
 * (Claude Fable 5 is the first subject; the next always-on model is one more
 * entry in `ALWAYS_ON_THINKING_CELLS` below).
 *
 * This file is the permanent, weekly-rerun encoding of the one-off "API Spike
 * Checklist" in docs/project/NEW_MODEL_SUPPORT_PROCESS.md (worked example:
 * docs/plans/260611_fable-5-support/PLAN.md Stage 3). The spike validates wire
 * premises on launch day; this test keeps validating them on every live run
 * (`npm run test:live`, RELEASE_TO_BETA §5.1) so PROVIDER-SIDE DRIFT — changed
 * error wording, a thinking-mode flip, an effort-level removal — surfaces in
 * the weekly run instead of in production 400s.
 *
 * COST DESIGN (deliberate — keep it this way): exactly ONE billed completion
 * per model per run. Cell (a) is the single paid call (small prompt, small
 * actual output; `max_tokens` is headroom — billing follows generated tokens,
 * not the cap). Cell (b)'s pre-output 400 is unbilled; cell (e)'s models GET
 * is free. Future always-on models inherit the same 3-cell shape via
 * `ALWAYS_ON_THINKING_CELLS` — adding a model adds exactly one billed call.
 *
 * Contract encoded (per model):
 *  (a) ONE production-shape request — the exact config production sends for
 *      this model (`thinking: {type:'adaptive', display:'summarized'}` +
 *      `output_config: {effort:'max'}`) → 200, `end_turn`; the serialized
 *      wire body carries NO `temperature`/`top_p`/`top_k`/`budget_tokens`;
 *      the response carries thinking + text blocks. (Merged from the former
 *      separate bare-request / adaptive-config / effort:max cells — one
 *      billed call now covers all three.)
 *  (b) `temperature` → 400, AND the live error text still matches
 *      `isTemperatureRejectionError` — pins the self-heal regex
 *      (src/core/services/safety/btsSafetyEvalService.ts) against provider
 *      wording drift (live text on 2026-06-11: "`temperature` is deprecated
 *      for this model.");
 *  (e) `GET /v1/models/<id>?beta=true` advertises enabled-thinking UNsupported
 *      + adaptive supported (the premise behind the `thinkingAlwaysOn` catalog
 *      flag), effort.max supported, and context/output limits matching the
 *      catalog.
 *
 * Gating contract (same as every file in this dir):
 * - Gated SOLELY on `TEST_ANTHROPIC_API_KEY ?? TEST_CLAUDE_API_KEY` (plus the
 *   tier-wide `RUN_LIVE_API_TESTS` opt-in), via describeLiveApi.
 * - No key present => skip, never fail.
 * - Tiny calls (3 per model, exactly one billed), no retries, latency logged
 *   not asserted.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createClientForModel } from '@core/rebelCore/clientFactory';
import { AnthropicClient } from '@core/rebelCore/clients/anthropicClient';
import { isAlwaysOnThinkingModel, resolveEffortForApi, resolveThinkingConfig } from '@core/rebelCore/modelLimits';
import { ModelError } from '@core/rebelCore/modelErrors';
import { isTemperatureRejectionError } from '@core/services/safety/btsSafetyEvalService';
import { getAnthropicContextWindow, getAnthropicMaxOutput } from '@shared/data/anthropicModelLimits';
import type { AppSettings } from '@shared/types';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describeLiveApi, liveApiMatrix, type LiveApiCell } from '../../src/test-utils/liveApiHarness';

/**
 * One cell per always-on-thinking model. Adding the next such model
 * (Mythos 5, Fable 5.1, ...) is a one-line addition here — every assertion
 * below is parameterized on the cell's model id.
 */
// Claude Fable 5 access was withdrawn for all keys in 2026-06 (after a brief
// availability window); live calls now 404 ("use Opus 4.8"). This cell SKIPS
// (never fails) until access returns — set RUN_FABLE_LIVE_TESTS=1 to re-enable;
// the wire-contract assertions below are preserved unchanged. The gate is the
// existing per-cell `requires` mechanism, so the skip names exactly why.
const FABLE_LIVE_ACCESS_OPT_IN = Boolean(process.env.RUN_FABLE_LIVE_TESTS?.trim());
const ALWAYS_ON_THINKING_CELLS: readonly LiveApiCell[] = liveApiMatrix([
  {
    provider: 'anthropic',
    label: 'Always-on-thinking wire contract — Claude Fable 5',
    envVar: 'TEST_ANTHROPIC_API_KEY',
    model: 'claude-fable-5',
    requires: [
      {
        name: 'fable-5-access',
        ok: FABLE_LIVE_ACCESS_OPT_IN,
        diagnostic:
          'Claude Fable 5 access withdrawn for all keys (2026-06) — model returns 404. Set RUN_FABLE_LIVE_TESTS=1 to re-enable once access returns.',
      },
    ],
  },
]);

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
// Fable single-request turns can run long even on small prompts (always-on
// thinking); generous per-test budget, latency logged not asserted.
const LIVE_TIMEOUT_MS = 120_000;
const LATENCY_WARN_MS = 30_000;
// Headroom cap for the single billed call: max-effort thinking plus a short
// answer must end on `end_turn`, never `max_tokens`. Billing follows tokens
// actually generated (typically a few hundred here), not this cap.
const PRODUCTION_SHAPE_MAX_TOKENS = 2_048;

function makeSettings(apiKey: string, wireModel: string): AppSettings {
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
      model: wireModel,
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    diagnostics: { enabled: false },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

function logLatency(label: string, startedAt: number): void {
  const latencyMs = Date.now() - startedAt;
  const latencyLabel = latencyMs > LATENCY_WARN_MS ? 'past generous budget' : 'within generous budget';
  console.warn(`[live] ${label} took ${latencyMs}ms (${latencyLabel})`);
}

for (const cell of ALWAYS_ON_THINKING_CELLS) {
  describeLiveApi(cell, ({ key, model }) => {
    const routingModel = unsafeAssertRoutingModelId(model);
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    afterEach(() => {
      fetchSpy?.mockRestore();
      fetchSpy = undefined;
    });

    /** Pass-through fetch spy capturing outbound JSON request bodies. */
    function captureWireBodies(): Array<Record<string, unknown>> {
      const originalFetch = globalThis.fetch;
      const capturedBodies: Array<Record<string, unknown>> = [];
      fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
          const bodyText = typeof init?.body === 'string' ? init.body : '';
          if (bodyText) {
            capturedBodies.push(JSON.parse(bodyText) as Record<string, unknown>);
          }
          return originalFetch(url, init);
        });
      return capturedBodies;
    }

    it(
      "(a) one production-shape request (adaptive + display:'summarized' + effort:'max') → 200 end_turn — the single billed call",
      async () => {
        // Premise behind the whole contract: the catalog marks this model
        // always-on. If this fails, the cell was added without the flag.
        expect(isAlwaysOnThinkingModel(model)).toBe(true);

        // Pin the production-resolved shapes first (no API cost): these are
        // the exact objects resolveThinkingConfig / resolveEffortForApi emit
        // for always-on, max-effort-capable models — so the call below is
        // byte-for-byte what production sends.
        const thinking = resolveThinkingConfig('high', model, getAnthropicMaxOutput(model) ?? 128_000);
        expect(thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        const effort = resolveEffortForApi('xhigh', model);
        expect(effort).toBe('max');

        const capturedBodies = captureWireBodies();
        const client = await createClientForModel({ model: routingModel, settings: makeSettings(key, model) });
        expect(client).toBeInstanceOf(AnthropicClient);

        const startedAt = Date.now();
        const result = await client.create({
          model: routingModel,
          systemPrompt: 'You are terse.',
          // A prompt with one small reasoning step (not a bare echo) so
          // adaptive thinking reliably emits a thinking block to assert on.
          messages: [{ role: 'user', content: 'What is 17 * 23? Reply with just the number.' }],
          maxTokens: PRODUCTION_SHAPE_MAX_TOKENS,
          thinking,
          effort,
        });
        logLatency(`${model} production-shape request`, startedAt);

        // Wire-body inspection — one pass covers what used to be three paid
        // cells. The former bare-request cell asserted the OMIT-thinking
        // premise ("production never NEEDS to send `thinking`"); that premise
        // is day-0 spike territory (NEW_MODEL_SUPPORT_PROCESS API Spike
        // Checklist) and isn't worth a second billed call weekly — what we
        // pin instead is the always-on invariant production relies on: the
        // adaptive shape (never `enabled`, never `budget_tokens`) and no
        // sampling params anywhere in the serialized body.
        expect(capturedBodies.length).toBeGreaterThan(0);
        const body = capturedBodies[0];
        expect(body.model).toBe(model);
        for (const forbiddenKey of ['temperature', 'top_p', 'top_k', 'budget_tokens']) {
          expect(body).not.toHaveProperty(forbiddenKey);
        }
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect((body.output_config as Record<string, unknown>)?.effort).toBe('max');

        // Response contract: a clean stop with both a (summarized) thinking
        // block and a text answer, and billed output tokens recorded.
        expect(result.stopReason).toBe('end_turn');
        const blockTypes = result.content.map((block) => block.type);
        expect(blockTypes).toContain('thinking');
        expect(blockTypes).toContain('text');
        expect(result.usage.outputTokens).toBeGreaterThan(0);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      '(b) temperature → 400 whose live error text still matches isTemperatureRejectionError',
      async () => {
        // COST: pre-output 400s are unbilled — this cell costs nothing.
        const startedAt = Date.now();
        const response = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
          },
          // Raw fetch is deliberate: the production client cannot express
          // `temperature` (the BTS sanitizer strips it), so pinning the
          // provider's rejection requires going under the seam.
          body: JSON.stringify({
            model,
            max_tokens: 16,
            temperature: 0,
            messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
          }),
        });
        logLatency(`${model} temperature rejection`, startedAt);

        expect(response.status).toBe(400);
        const payload = (await response.json()) as {
          error?: { type?: string; message?: string };
        };
        expect(payload.error?.type).toBe('invalid_request_error');
        const liveMessage = payload.error?.message ?? '';
        // Surface the verbatim text in the run log so wording drift is
        // visible even while the regex still matches.
        console.warn(`[live] ${model} temperature-rejection 400 verbatim: ${liveMessage}`);
        expect(liveMessage.toLowerCase()).toContain('temperature');

        // Drift pin: the btsSafetyEvalService self-heal (retry without
        // temperature) is regex-gated on this exact provider wording. Live
        // text on 2026-06-11 was "`temperature` is deprecated for this
        // model." — if Anthropic rewords the error such that the regex stops
        // matching, this assertion (not a production incident) catches it.
        const asModelError = new ModelError('invalid_request', liveMessage, 400, 'anthropic', {
          rawMessage: liveMessage,
        });
        expect(isTemperatureRejectionError(asModelError)).toBe(true);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      '(e) models endpoint pins the always-on premise and the catalog limits',
      async () => {
        // COST: a GET on the models endpoint — free, no tokens.
        const startedAt = Date.now();
        const response = await fetch(
          `${ANTHROPIC_API_BASE}/v1/models/${encodeURIComponent(model)}?beta=true`,
          {
            headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
          },
        );
        logLatency(`${model} models endpoint`, startedAt);

        expect(response.status).toBe(200);
        const payload = (await response.json()) as {
          max_input_tokens?: number;
          max_tokens?: number;
          capabilities?: {
            thinking?: {
              types?: {
                enabled?: { supported?: boolean };
                adaptive?: { supported?: boolean };
              };
            };
            effort?: { max?: { supported?: boolean } };
          };
        };

        // The always-on premise behind the `thinkingAlwaysOn` catalog flag:
        // manual enabled-thinking (budget_tokens) is NOT supported; adaptive
        // is. If the provider ever flips these, the catalog flag — and
        // everything Stage 4/5 derives from it — needs re-deciding.
        expect(payload.capabilities?.thinking?.types?.enabled?.supported).toBe(false);
        expect(payload.capabilities?.thinking?.types?.adaptive?.supported).toBe(true);
        expect(payload.capabilities?.effort?.max?.supported).toBe(true);

        // Context/output must match the catalog limits row (the explicit
        // anthropicModelLimits entry — a drift here means the catalog is
        // advertising the wrong window).
        expect(payload.max_input_tokens).toBe(getAnthropicContextWindow(model));
        expect(payload.max_tokens).toBe(getAnthropicMaxOutput(model));
      },
      LIVE_TIMEOUT_MS,
    );
  });
}
