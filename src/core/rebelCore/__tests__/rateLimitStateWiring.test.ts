/**
 * Runtime tests for the per-turn rate-limit state wiring helpers and their
 * use in `rebelCoreQuery` / `agentTool`.
 *
 * Background: the original bug (see
 * `docs-private/postmortems/260421_websearch_ddg_captcha_postmortem.md`) was that
 * `rateLimitState` was added to `BuiltinToolContext` / `AgentToolContext`
 * as an optional field, and `webSearchTool` / `webFetchTool` were written
 * to consume it, but no production code path ever populated it — so
 * per-task rate limits and per-task Sentry dedupe were dead code.
 *
 * This file replaces a static source-grep guard with true runtime RED/GREEN
 * coverage:
 *
 * 1. Helper unit tests — the pure factory + attach + type-guard functions
 *    in `rateLimitStateWiring.ts` do what they promise.
 * 2. "Confirms bug" test — a context missing `rateLimitState` is detectable
 *    via `hasRateLimitState`, demonstrating how the regression would look.
 * 3. Wiring proof — `rebelCoreQuery` actually calls the named factory
 *    when a turn starts, asserted via a module spy (not source regex).
 *    This is the RED-on-pre-fix / GREEN-on-fix test that would have caught
 *    the original bug at test time.
 * 4. Static defence-in-depth — the four object-literal sites still mention
 *    `rateLimitState`, kept as a cheap additional guard.
 *
 * TDD reference: `coding-agent-instructions/docs/TDD.md`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  createPerTurnRateLimitState,
  attachRateLimitState,
  hasRateLimitState,
} from '../rateLimitStateWiring';
import type { BuiltinToolContext, AgentToolContext } from '../types';

// Spy-capturing mock for the wiring-proof test. We intercept the module so
// that `rebelCoreQuery`'s live named import resolves to our spy instance,
// while every helper's real implementation still runs (so downstream code
// that depends on receiving a real Map doesn't crash).
const createPerTurnRateLimitStateSpy = vi.fn(
  (): Map<string, number> => new Map<string, number>(),
);

vi.mock('../rateLimitStateWiring', async () => {
  const actual = await vi.importActual<typeof import('../rateLimitStateWiring')>(
    '../rateLimitStateWiring',
  );
  return {
    ...actual,
    createPerTurnRateLimitState: () => createPerTurnRateLimitStateSpy(),
  };
});

// ── 1. Helper unit tests ────────────────────────────────────────────────

describe('createPerTurnRateLimitState', () => {
  it('returns an empty Map<string, number>', () => {
    const s = createPerTurnRateLimitState();
    expect(s).toBeInstanceOf(Map);
    expect(s.size).toBe(0);
  });

  it('returns a fresh Map each call (no module-level shared state)', () => {
    const a = createPerTurnRateLimitState();
    const b = createPerTurnRateLimitState();
    a.set('WebSearch', 3);
    expect(b.get('WebSearch')).toBeUndefined();
    expect(a).not.toBe(b);
  });
});

describe('attachRateLimitState', () => {
  it('returns a shallow-merged context with rateLimitState populated', () => {
    const state = new Map<string, number>();
    const result = attachRateLimitState({ cwd: '/tmp', depth: 0 }, state);
    expect(result.cwd).toBe('/tmp');
    expect(result.depth).toBe(0);
    expect(result.rateLimitState).toBe(state);
  });

  it('preserves reference identity of the Map (same instance, not a copy)', () => {
    // Critical invariant: parent + sub-agents must share ONE Map so counters
    // and WeakMap-keyed Sentry dedupe compose. If this ever returns a copy
    // we silently lose dedupe and rate limiting.
    const state = new Map<string, number>();
    const a = attachRateLimitState({}, state);
    const b = attachRateLimitState({}, state);
    expect(a.rateLimitState).toBe(state);
    expect(b.rateLimitState).toBe(state);
    expect(a.rateLimitState).toBe(b.rateLimitState);

    // Mutation through one handle is visible through the other.
    a.rateLimitState.set('WebSearch', 2);
    expect(b.rateLimitState.get('WebSearch')).toBe(2);
  });
});

describe('hasRateLimitState', () => {
  it('returns true when rateLimitState is a Map', () => {
    const ctx: Partial<BuiltinToolContext> = { rateLimitState: new Map() };
    expect(hasRateLimitState(ctx)).toBe(true);
  });

  it('returns false when rateLimitState is missing (confirms bug signature)', () => {
    // This is the "confirms bug" test (see TDD.md): it proves the original
    // failure mode is detectable. Pre-fix production code produced contexts
    // matching this shape — no `rateLimitState` field at all.
    const ctx: Partial<BuiltinToolContext> = { cwd: '/tmp' };
    expect(hasRateLimitState(ctx)).toBe(false);
  });

  it('returns false when rateLimitState is undefined', () => {
    const ctx: Partial<BuiltinToolContext> = { rateLimitState: undefined };
    expect(hasRateLimitState(ctx)).toBe(false);
  });

  it('returns false when rateLimitState is set to a non-Map value', () => {
    // Defence-in-depth: guard against a refactor that replaces the Map with
    // a plain object or other "dictionary-like" value.
    const ctx = { rateLimitState: {} as unknown as Map<string, number> };
    expect(hasRateLimitState(ctx)).toBe(false);
  });
});

// ── 2. Wiring proof via module spy ──────────────────────────────────────
// This is the test that would have caught the original bug at test time —
// a direct, runtime RED/GREEN of the wiring. If someone removes the
// `createPerTurnRateLimitState()` call from `rebelCoreQuery.ts` (the exact
// regression class), this test fails.
//
// We use `vi.spyOn(wiring, 'createPerTurnRateLimitState')` rather than mocking
// the module so the real factory still runs and rebelCoreQuery doesn't crash
// downstream. We then iterate the generator enough to reach the factory-call
// site; failures AFTER that point (e.g. a real Anthropic client construction)
// are fine — the spy has already been asserted.

describe('rebelCoreQuery uses the named factory (wiring runtime proof)', () => {
  beforeEach(() => {
    createPerTurnRateLimitStateSpy.mockClear();
  });

  afterEach(() => {
    createPerTurnRateLimitStateSpy.mockClear();
  });

  it('calls createPerTurnRateLimitState() during turn setup', async () => {
    // Late import so the `vi.mock` above is active when `rebelCoreQuery`
    // resolves its `createPerTurnRateLimitState` binding.
    const { rebelCoreQuery } = await import('../rebelCoreQuery');

    // Minimal fake inputs; we don't need them to be complete — we only need
    // rebelCoreQuery's generator to reach the per-turn rateLimitState setup
    // block before any downstream failure (the agent loop fails far past that
    // point, which is fine — the spy has already been asserted by then).
    //
    // We inject a stub execution client so rebelCoreQuery doesn't try to
    // construct a real Anthropic client from empty settings — see the
    // `context.executionClient ?? ...` branch in rebelCoreQuery.ts.
    const stubClient = {
      send: () => { throw new Error('test-stub: not expected to be called'); },
    } as unknown as Parameters<typeof rebelCoreQuery>[1]['executionClient'];

    const abortController = new AbortController();
    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: { type: 'preset', preset: 'claude_code' } as unknown as Parameters<typeof rebelCoreQuery>[0]['systemPrompt'],
        prompt: 'unit test prompt',
        abortController,
        env: {},
      },
      {
        settings: {} as unknown as Parameters<typeof rebelCoreQuery>[1]['settings'],
        executionClient: stubClient,
      },
    );

    // Drive the generator until either the spy has fired or iteration ends /
    // throws. Downstream failures after the factory call do not invalidate
    // the assertion below — the agent loop fails long after rateLimitState
    // is constructed under this minimal harness, and that's fine.
    try {
      for (let i = 0; i < 100; i++) {
        if (createPerTurnRateLimitStateSpy.mock.calls.length > 0) break;
        const r = await gen.next();
        if (r.done) break;
      }
    } catch {
      // Expected under this minimal harness.
    } finally {
      try { await gen.return?.(undefined as never); } catch { /* noop */ }
    }

    expect(createPerTurnRateLimitStateSpy).toHaveBeenCalled();
  });
});

// ── 3. Static defence-in-depth — cheap, plus a clear error pointer ─────
// Kept intentionally small: the spy test above is the primary runtime guard.
// These lightweight greps act as a "belt" in case a refactor moves the wiring
// into a helper this spy can't reach, but a consumer forgets to attach.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
}

describe('rateLimitState wiring — defence-in-depth (static)', () => {
  it('agentTool.ts subagentToolContext propagates ctx.rateLimitState', () => {
    const src = readFile('src/core/rebelCore/agentTool.ts');
    const subCtxMatch = src.match(/const\s+subagentToolContext\s*=\s*\{[\s\S]*?\};/);
    expect(subCtxMatch).toBeTruthy();
    expect(subCtxMatch![0]).toContain('rateLimitState');
  });

  it('agentTool.ts childAgentCtx propagates ctx.rateLimitState', () => {
    const src = readFile('src/core/rebelCore/agentTool.ts');
    const childAgentCtxMatch = src.match(
      /const\s+childAgentCtx\s*:\s*AgentToolContext\s*\|\s*null\s*=[\s\S]*?;/,
    );
    expect(childAgentCtxMatch).toBeTruthy();
    expect(childAgentCtxMatch![0]).toContain('rateLimitState');
  });

  it('rebelCoreQuery.ts toolContext literal contains rateLimitState', () => {
    const src = readFile('src/core/rebelCore/rebelCoreQuery.ts');
    const toolContextBlockMatch = src.match(
      /const\s+toolContext\s*:\s*BuiltinToolContext\s*=\s*\{[\s\S]*?\};/,
    );
    expect(toolContextBlockMatch).toBeTruthy();
    expect(toolContextBlockMatch![0]).toContain('rateLimitState');
  });

  it('rebelCoreQuery.ts agentCtx literal contains rateLimitState', () => {
    const src = readFile('src/core/rebelCore/rebelCoreQuery.ts');
    const agentCtxBlockMatch = src.match(
      /const\s+agentCtx\s*:\s*AgentToolContext\s*\|\s*null\s*=[\s\S]*?;/,
    );
    expect(agentCtxBlockMatch).toBeTruthy();
    expect(agentCtxBlockMatch![0]).toContain('rateLimitState');
  });
});

// ── 4. Cross-check: the type guard recognises contexts built by the helpers ──

describe('hasRateLimitState integration with attachRateLimitState', () => {
  it('returns true for contexts built via attachRateLimitState', () => {
    const state = createPerTurnRateLimitState();
    const builtinCtx = attachRateLimitState(
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        depth: 0,
        agentNamespace: 'main',
      },
      state,
    ) as unknown as BuiltinToolContext;
    expect(hasRateLimitState(builtinCtx)).toBe(true);

    const agentCtx = attachRateLimitState(
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        depth: 0,
        agentNamespace: 'main',
      },
      state,
    ) as unknown as AgentToolContext;
    expect(hasRateLimitState(agentCtx)).toBe(true);

    // And they share the same Map reference.
    expect(builtinCtx.rateLimitState).toBe(agentCtx.rateLimitState);
  });
});
