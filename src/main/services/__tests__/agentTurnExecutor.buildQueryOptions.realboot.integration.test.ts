/**
 * Real-boot migration of the Anthropic-direct subtests from
 * `agentTurnExecutor.buildQueryOptions.test.ts` (47 vi.mock).
 *
 * The old test asserts the executor↔provider contract by reading `query`'s call-args
 * back from a `vi.fn()` (`queryMock` via `vi.mock('@core/rebelCore/queryRouter')`). That
 * mock MASKS executor↔service drift: a semantic change to how `buildSdkQueryOptions`
 * assembles the `systemPrompt` never reaches a mocked `query`, so the old test stays
 * green. (See the Stage-5 mutation-to-red proof in the stage report.)
 *
 * This file drives a REAL direct-Anthropic `executeAgentTurn` through the REAL service
 * graph via `bootRealAgentServices()`, with ONLY `globalThis.fetch` stubbed, and asserts
 * the SAME contract FROM THE CAPTURED WIRE BODY (`capturedRequests[0].body`) — the
 * `system` prompt, the `model`, and that a normal direct turn carries the direct
 * `x-api-key` (no proxy auth) rather than reading a `vi.fn`.
 *
 * CRITICAL — this file does NOT mock `@core/services/settingsStore`,
 * `@core/rebelCore/queryRouter`, or `@main/services/agentQueryRunner`. Settings reach the
 * real `getSettings()` via the helper's `setSettingsStoreAdapter(...)` injection. The
 * provider call path (runAgentQuery → queryRouter → rebelCoreQuery → AnthropicClient) runs
 * REAL down to the fetch seam — exactly the blind spots the old mocked test cannot cover.
 *
 * TIER (Stage 4): SLOW / OPT-IN SERIAL — NOT the quick pre-push tier. Named
 * `*.integration.test.ts` so `VITEST_FAST=1` (the pre-push quick tier + `npm run test:fast`)
 * excludes it via the `vitest.config.ts` fast-mode exclude (`**\/*.integration.*`). ALSO
 * opt-in: the whole suite `describe.skipIf`s unless `RUN_REALBOOT_TESTS` is set (mirrors the
 * `RUN_LIVE_API_TESTS` convention) so a flaky real cold-boot turn cannot land in the full CI
 * desktop run either. Runs SERIAL (singleton runtime). Opt-in command: `npm run test:realboot`.
 * See `bootRealAgentServices` file header.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  bootRealAgentServices,
  DEFAULT_DIRECT_ANTHROPIC_API_KEY,
  DEFAULT_ROUTABLE_MODEL,
} from '../../../test-utils/bootRealAgentServices';

/** Anthropic `/v1/messages` wire body shape we read in assertions (open JSON). */
interface AnthropicWireBody {
  model?: unknown;
  system?: unknown;
  max_tokens?: unknown;
  messages?: Array<{ role: string; content: unknown }>;
}

/** Drive one real direct-Anthropic turn and return the captured state + events. */
async function runRealDirectTurn(
  booted: Awaited<ReturnType<typeof bootRealAgentServices>>,
  prompt: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await booted.runtime.runTurn({
    prompt,
    onEvent: (event) => events.push(event),
    options: { sessionType: 'cli', persistMode: { kind: 'none' } },
  });
  return events;
}

// Opt-in gate: unset/blank => the whole suite skips (slow/opt-in tier, Stage 4).
const runRealBoot = !!process.env.RUN_REALBOOT_TESTS?.trim();

describe.skipIf(!runRealBoot)('executeAgentTurn buildQueryOptions contracts (REAL boot — wire-observable)', () => {
  let booted: Awaited<ReturnType<typeof bootRealAgentServices>> | undefined;

  afterEach(async () => {
    if (booted) {
      await booted.cleanup();
      booted = undefined;
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PRIMARY (the non-vacuity target): the assembled system prompt reaches the
  // provider over the wire. The old mocked test never asserts systemPrompt CONTENT
  // (it reads queryMock call-args and checks resume/env/model fields), so dropping
  // the assembled systemPrompt in buildSdkQueryOptions is invisible to it — but this
  // wire-body assertion goes RED. This is the Stage-5 mutation-to-red proof.
  // ───────────────────────────────────────────────────────────────────────────
  it('sends the assembled system prompt to the provider over the wire', async () => {
    booted = await bootRealAgentServices();

    const prompt = 'Hello direct Anthropic';
    const events = await runRealDirectTurn(booted, prompt);

    // Reach-the-seam (anti-false-green): exactly ONE provider request, no escape,
    // no admission/error event.
    expect(booted.unexpectedFetches).toEqual([]);
    expect(booted.capturedRequests).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);

    const req = booted.capturedRequests[0];
    expect(new URL(req.url).hostname).toBe('api.anthropic.com');
    expect(new URL(req.url).pathname).toBe('/v1/messages');
    expect(req.method).toBe('POST');

    const body = req.body as AnthropicWireBody;

    // The user prompt rode the wire (messages).
    expect(JSON.stringify(req.body)).toContain(prompt);

    // THE migrated contract: the REAL composed Rebel system prompt reached the wire
    // as the Anthropic top-level `system` field. Asserting CONTENT (not merely
    // presence): a stub like "x", an empty string, or a dropped `system` field all
    // FAIL here — which is the semantic mutation the old mocked test cannot see.
    expect(body.system).toBeDefined();
    const systemText =
      typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
    // The real composed system prompt is a large (tens of KB) document carrying
    // durable identity markers. A dropped/altered systemPrompt breaks these.
    expect(systemText.length).toBeGreaterThan(2000);
    expect(systemText).toContain('Mindstone Rebel');
    expect(systemText).toContain('You are Rebel');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The configured model reaches the provider (wire-observable analog of the old
  // test's `options.model` call-arg assertions, e.g. "preserves plan model").
  // ───────────────────────────────────────────────────────────────────────────
  it('sends the configured model to the provider over the wire', async () => {
    booted = await bootRealAgentServices();

    await runRealDirectTurn(booted, 'What model am I?');

    expect(booted.capturedRequests).toHaveLength(1);
    const body = booted.capturedRequests[0].body as AnthropicWireBody;
    expect(body.model).toBe(DEFAULT_ROUTABLE_MODEL);
    // max_tokens is a key Anthropic option the SDK always sets; assert it is a
    // positive integer on the wire (cleanly wire-observable second option).
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens as number).toBeGreaterThan(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Wire-observable analog of the old test's "does not request a proxy token or
  // proxy headers for a normal Anthropic-direct turn": a direct turn carries the
  // direct `x-api-key` and reaches api.anthropic.com itself — NOT a proxy with
  // x-proxy-auth/x-routed-model headers. (The old test reads proxy-header strings
  // out of `options.env`; here we observe the real request that actually went out.)
  // ───────────────────────────────────────────────────────────────────────────
  it('routes a normal direct turn straight to Anthropic with the direct api-key (no proxy)', async () => {
    booted = await bootRealAgentServices();

    await runRealDirectTurn(booted, 'Hello direct, no proxy please');

    expect(booted.capturedRequests).toHaveLength(1);
    const req = booted.capturedRequests[0];
    expect(req.headers['x-api-key']).toBe(DEFAULT_DIRECT_ANTHROPIC_API_KEY);
    expect(req.headers.authorization).toBeUndefined();
    // Direct egress went to api.anthropic.com, not a 127.0.0.1 proxy fall-through.
    expect(new URL(req.url).hostname).toBe('api.anthropic.com');
    // No proxy routing headers leaked onto the wire request.
    expect(req.headers['x-proxy-auth']).toBeUndefined();
    expect(req.headers['x-routed-model']).toBeUndefined();
    expect(req.headers['x-routed-turn-id']).toBeUndefined();
  });
});
