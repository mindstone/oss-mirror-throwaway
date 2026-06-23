/**
 * Smoke test for `bootRealAgentServices()` — supersedes the Stage-1 throwaway spike.
 *
 * Drives ONE real direct-Anthropic `executeAgentTurn` through the REAL service graph
 * (via `createHeadlessRuntime`) with only `globalThis.fetch` stubbed, and asserts the
 * Stage-3 ENFORCEABLE anti-false-green set:
 *   (a) exactly ONE provider request (`capturedRequests.length === 1`);
 *   (b) host `api.anthropic.com`, path `/v1/messages`, method POST;
 *   (c) request body includes the user prompt AND a system prompt;
 *   (d) a terminal success/result event sourced from the canned SSE fake;
 *   (e) NO admission/error event.
 *
 * CRITICAL: this file does NOT mock `@core/services/settingsStore`,
 * `@core/rebelCore/queryRouter`, or `@main/services/agentQueryRunner`. Settings reach
 * the real `getSettings()` via the helper's `setSettingsStoreAdapter(...)` injection —
 * proving the production seam is sufficient (no vi.mock of settings needed).
 *
 * TIER (Stage 4): SLOW / OPT-IN SERIAL. Named `*.integration.test.ts` so `VITEST_FAST=1`
 * (the pre-push quick tier + `npm run test:fast`) excludes it via the `vitest.config.ts`
 * fast-mode exclude (`**\/*.integration.*`). ALSO opt-in: the whole suite `describe.skipIf`s
 * unless `RUN_REALBOOT_TESTS` is set (mirrors the `RUN_LIVE_API_TESTS` convention) so a
 * flaky real cold-boot turn cannot land in the full CI desktop run either. Runs SERIAL
 * (singleton runtime — see the helper header).
 *
 * Opt-in command: `npm run test:realboot`
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  storeSingleUseApproval,
  hasActionableExecutionExpectations,
  currentApprovalSequence,
} from '@main/services/safety/sessionApprovals';
import {
  bootRealAgentServices,
  DEFAULT_DIRECT_ANTHROPIC_API_KEY,
  DEFAULT_ROUTABLE_MODEL,
} from '../bootRealAgentServices';

// Opt-in gate: unset/blank => the whole suite skips (slow/opt-in tier, Stage 4).
const runRealBoot = !!process.env.RUN_REALBOOT_TESTS?.trim();

describe.skipIf(!runRealBoot)('bootRealAgentServices (smoke) — real direct-Anthropic turn', () => {
  let booted: Awaited<ReturnType<typeof bootRealAgentServices>> | undefined;

  afterEach(async () => {
    if (booted) {
      await booted.cleanup();
      booted = undefined;
    }
  });

  it('runs ONE real turn to the provider seam and back, with no mocks above the helper', async () => {
    const assistantText = 'real-boot-ok';
    booted = await bootRealAgentServices({ assistantText });

    const prompt = 'Say the magic smoke word please';
    const events: AgentEvent[] = [];
    await booted.runtime.runTurn({
      prompt,
      onEvent: (event) => events.push(event),
      options: { sessionType: 'cli', persistMode: { kind: 'none' } },
    });

    // (e/escape) No non-local network escape.
    expect(booted.unexpectedFetches).toEqual([]);

    // (a) Exactly ONE primary provider request.
    expect(booted.capturedRequests).toHaveLength(1);
    const req = booted.capturedRequests[0];

    // (b) Host / path / method.
    expect(new URL(req.url).hostname).toBe('api.anthropic.com');
    expect(new URL(req.url).pathname).toBe('/v1/messages');
    expect(req.method).toBe('POST');
    // The turn built a REAL AnthropicClient via the client factory (direct api-key
    // header), not a pre-built short-circuit client (which would carry no fetch).
    expect(req.headers['x-api-key']).toBe(DEFAULT_DIRECT_ANTHROPIC_API_KEY);
    expect(req.headers.authorization).toBeUndefined();

    // (c) Request body carries the user prompt AND the REAL system prompt, and the
    // EXACT configured model (F5: not merely `toBeDefined()`).
    const body = req.body as {
      model?: unknown;
      system?: unknown;
      messages?: Array<{ role: string; content: unknown }>;
    };
    expect(body.model).toBe(DEFAULT_ROUTABLE_MODEL);
    const wireJson = JSON.stringify(req.body);
    expect(wireJson).toContain(prompt);
    // Anthropic dialect: the system prompt is the top-level `system` field
    // (string or content-block array). F2: assert it is the REAL composed Rebel system
    // prompt, not merely non-empty — a stub like "x" must FAIL. The real prompt is a
    // large composed document; assert both a substantial length AND a durable identity
    // marker that the real prompt always carries.
    expect(body.system).toBeDefined();
    const systemText =
      typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
    // The real composed Rebel system prompt is a large (tens of KB) document. A stub
    // like "x" would fail both the length floor and the durable-content markers below.
    expect(systemText.length).toBeGreaterThan(2000);
    expect(systemText).toContain('Mindstone Rebel');
    expect(systemText).toContain('You are Rebel');

    // (e) NO terminal admission/error event.
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(
      errorEvents,
      `unexpected error/admission events: ${JSON.stringify(errorEvents)}`,
    ).toEqual([]);
    const admissionReasons = [
      'missing-core-directory',
      'missing-auth',
      'codex-not-connected',
      'openrouter-not-connected',
      'mindstone-key-missing',
    ];
    for (const event of events) {
      const reason = (event as { reason?: string }).reason;
      if (reason) expect(admissionReasons).not.toContain(reason);
    }

    // (d) A terminal SUCCESS result event whose text was SOURCED FROM THE FAKE.
    // F2: the prior "a result event exists" check was gameable. The runtime dispatches
    // a renderer `type:'result'` event ONLY on the success path (agentMessageHandler.ts
    // :3075-3077 carries the accumulated assistant text); the ERROR path dispatches a
    // `type:'error'` event instead (we already asserted there are none above). So a
    // `type:'result'` event present == terminal success (is_error:false / subtype:'success'
    // at the AgentMessage layer). Prove the canned SSE `text_delta` actually became the
    // terminal result by asserting its `text` carries the configured assistantText — an
    // empty/incorrect fake terminal result would now FAIL.
    const resultEvents = events.filter((e) => e.type === 'result');
    expect(
      resultEvents.length,
      `expected exactly one terminal success result; saw ${JSON.stringify(events.map((e) => e.type))}`,
    ).toBe(1);
    const terminal = resultEvents[0] as { type: 'result'; text?: unknown };
    expect(typeof terminal.text).toBe('string');
    expect(terminal.text as string).toContain(assistantText);
  });

  it('approval-execution guard rides along: a seeded unconsumed approval forces ONE approval-specific continuation on the wire (FOX-2771 Stage 2)', async () => {
    // The guard hook (@main/services/safety/approvalExecutionGuardHook) and its
    // store (@main/services/safety/sessionApprovals) need NO boot wiring — the
    // executor constructs the hook per-turn when a sessionId is present and
    // bypassToolSafety is not set, and the store is module-level in-memory
    // state. This case proves they are LIVE in the real-boot graph: seed an
    // execution-expected approval the canned model will "ignore", and observe
    // the guard's forced continuation as a SECOND provider request.
    booted = await bootRealAgentServices();

    const sessionId = 'real-boot-approval-guard-session';
    // Seed BEFORE the turn (legacy approve-then-retry shape). The executor
    // snapshots currentApprovalSequence() at entry, so this counts as
    // stored-before-turn.
    storeSingleUseApproval('tool', sessionId, 'mcp__gmail__send_email', { expectExecution: true });
    const seqAfterStore = currentApprovalSequence();

    const events: AgentEvent[] = [];
    await booted.runtime.runTurn({
      prompt: 'Please retry the approved operation',
      onEvent: (event) => events.push(event),
      options: { sessionType: 'cli', persistMode: { kind: 'none' }, sessionId },
    });

    expect(booted.unexpectedFetches).toEqual([]);

    // The canned SSE model never calls the approved tool, so the approval is
    // never consumed → the guard blocks the first stop with its stronger
    // message → a SECOND real provider request goes out carrying it.
    expect(
      booted.capturedRequests.length,
      `expected the guard's forced continuation to produce a second provider request; ` +
        `saw ${booted.capturedRequests.length}`,
    ).toBe(2);
    const secondWire = JSON.stringify(booted.capturedRequests[1].body);
    expect(secondWire).toContain('mcp__gmail__send_email');
    expect(secondWire).toContain('NOT been executed');

    // Second stop pass: still unconsumed → the guard surfaces the explicit
    // "Approved but not executed" status (visible in the turn's event stream)
    // and allows the stop — exactly one forced continuation total.
    const surfacedStatus = events.filter(
      (e) => e.type === 'status' && (e as { message?: string }).message?.includes('Approved but not executed'),
    );
    expect(surfacedStatus.length).toBe(1);

    // Expectation is terminal (surfaced) — nothing actionable left for a
    // later turn; cleanup() then resets the store entirely.
    expect(hasActionableExecutionExpectations(sessionId, seqAfterStore)).toBe(false);
  });
});
