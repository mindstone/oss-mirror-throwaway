/**
 * Per-turn rate-limit state helpers for Rebel Core.
 *
 * The per-turn `rateLimitState` Map is threaded through `BuiltinToolContext`
 * and `AgentToolContext` so that WebSearch/WebFetch per-task rate limits and
 * per-task Sentry dedupe compose across the main agent and all its sub-agents
 * within a single turn. The same Map reference must be shared — not copied —
 * between parent and sub-agents.
 *
 * This module exists as the single, named factory + attach point for that
 * Map so the wiring can be unit-tested in isolation and spied on at the
 * call site, replacing the brittle static-source-grep regression guard that
 * was the initial fix for the documented-but-not-wired bug.
 *
 * See `docs-private/postmortems/260421_websearch_ddg_captcha_postmortem.md` for the
 * bug that shipped when this wiring was documented in the plan but never
 * actually implemented in production.
 */

/**
 * Create a fresh per-turn rate-limit state Map. One per agent turn; shared
 * with every sub-agent spawned during that turn via context propagation.
 *
 * Using a named factory (rather than `new Map()` inline) gives tests a single
 * spy point to assert that a per-turn Map is created, and makes the wiring
 * grep-visible with a stable name.
 */
export function createPerTurnRateLimitState(): Map<string, number> {
  return new Map<string, number>();
}

/**
 * Attach the per-turn rate-limit state to a context object, returning a
 * shallow copy with the `rateLimitState` field populated. Use this at every
 * `BuiltinToolContext` / `AgentToolContext` construction site so the wiring
 * is visible, consistent, and spy-testable.
 *
 * Reference identity: the passed-in Map is stored by reference so mutations
 * (counter increments, WeakMap dedupe keys) are visible across every context
 * that shares it.
 */
export function attachRateLimitState<T extends object>(
  base: T,
  rateLimitState: Map<string, number>,
): T & { rateLimitState: Map<string, number> } {
  return { ...base, rateLimitState };
}

/**
 * Type guard: does the context have a populated rateLimitState Map? Used
 * by tests and consumer-side invariants to detect the "documented-but-not-
 * wired" regression class at runtime.
 *
 * This is the core assertion that replaces the static source-grep: a context
 * either *has* a rateLimitState Map attached or it doesn't, and we can prove
 * that at runtime regardless of refactors that rename variables or split
 * object literals.
 */
export function hasRateLimitState<T extends { rateLimitState?: Map<string, number> }>(
  ctx: T,
): ctx is T & { rateLimitState: Map<string, number> } {
  return ctx.rateLimitState instanceof Map;
}
