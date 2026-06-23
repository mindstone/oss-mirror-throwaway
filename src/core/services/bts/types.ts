/**
 * `BtsCallResult` — the typed return shape of the Behind-The-Scenes dispatch core.
 *
 * Stage 8 of the hotspot-refactor roadmap (PLAN.md Hotspot 3). Researcher findings
 * F4 (Result-shaped returns + structured "degraded" states; remove silent reroute)
 * and F7 (cost attribution as a first-class typed state; `UnknownPricing` forwarded
 * to the ledger as observable, never silently dropped).
 *
 * ── Scope contract (pinned by the Chief) ─────────────────────────────────────
 * `BtsCallResult` is the **internal** dispatch-core return type. The four public
 * entry points (`callBehindTheScenes`, `callWithModel`, `callBehindTheScenesWithAuth`,
 * `callWithModelAuthAware`) STILL return `BehindTheScenesResponse` — the Result is
 * unwrapped at the boundary so the ~45 existing consumers stay untouched. The Result
 * exists so that:
 *   - every degraded / skipped outcome is a typed branch the dispatch core must
 *     handle explicitly (no silent `catch → reroute`), and
 *   - each non-`ok` branch carries a `ProofOfObservability` so a degraded state is
 *     provably logged/telemetered, per AGENTS.md "Silent failure is a bug".
 *
 * "Observable" here means structured logs + telemetry/cost-ledger discriminants —
 * NOT a change to any UI flow or to what an end user sees. Surfacing a previously
 * silent state to a consumer's control flow would be a product decision and is out
 * of scope for this stage.
 *
 * Platform-agnostic by contract: lives in `src/core/` (inherited by cloud + mobile).
 * MUST NOT import `electron`, `@main/*`, or `@renderer/*`.
 */

import type { ProofOfObservability } from '@shared/types/proofOfObservability';
import type { BehindTheScenesResponse } from './transports/shared';

/**
 * How the cost attached to a BTS call was derived. Mirrors the cost-source
 * priority chain enforced in `trackCostIfEnabled` (invariants 18-19):
 *   `exact` (provider `usage.cost`) → `calculated` (token×pricing) → `legacy-sdk`.
 *
 * `unknown` is the first-class `UnknownPricing` state (F7 / invariant 18, PM
 * 260405): tokens were consumed but `MODEL_CATALOG` had no pricing, so a cost
 * could not be derived. It is forwarded as an observable structured state instead
 * of being silently dropped. `none` means no cost data was present at all (no
 * `usage`, no exact cost, no legacy cost) — a benign no-op, distinct from `unknown`.
 */
export type BtsCostSource = 'exact' | 'calculated' | 'legacy-sdk' | 'unknown' | 'none';

/**
 * Typed cost attribution carried on a `BtsCallResult`. `amountUsd` is `null` for
 * the `unknown` / `none` sources (no derivable cost); a finite non-negative number
 * otherwise. `ledgerWritten` records whether a cost-ledger row was appended — for
 * `unknown` pricing it is `false` (the ledger entry shape requires a numeric cost;
 * writing a synthetic `0` would corrupt cost summaries — see PLAN Stage 8 notes and
 * invariant 19c), so the unknown-pricing state is surfaced via the structured
 * warn-once log + this discriminant rather than a ledger row.
 */
export interface BtsCostAttribution {
  source: BtsCostSource;
  amountUsd: number | null;
  ledgerWritten: boolean;
}

/**
 * Discriminated union returned by the BTS dispatch core.
 *
 * `ok`                 — the call succeeded; `response` carries the wire result.
 * `degraded`           — the call produced a usable `response` but only after a
 *                        fallback reroute. Today the only signal the orchestration
 *                        surfaces to `settleBtsCall` is `usedOperationalFallback`
 *                        (the configured-role background fallback,
 *                        `reason: 'operational-fallback'`), which emits a structured
 *                        `log.warn` but no Sentry condition — so its `proof` carries
 *                        NO `sentryClass`. The structured-output ladder triggers
 *                        (`profile-flag-bypass` / `json-capability` / `parse-failure`)
 *                        are observable on their own axis (`log.warn` +
 *                        `captureKnownCondition('bts_structured_output_fallback')`)
 *                        but do NOT set `usedOperationalFallback`, so they currently
 *                        settle as `ok`, not `degraded`. The consumer still receives
 *                        a valid response; every degradation is observable, not silent.
 * `rate_limit`         — reserved for a self-imposed / provider rate-limit outcome
 *                        surfaced as a value rather than a throw. (The current
 *                        entry points still throw `ModelError(rate_limit)` at the
 *                        boundary to preserve consumer behaviour; this variant
 *                        exists so future callers can opt into value-shaped
 *                        handling without reintroducing a silent path.)
 * `capability_skipped` — a profile was deliberately bypassed for structured output
 *                        (JSON-incompatible flag); reserved for the same reason.
 *
 * Every non-`ok` variant carries `proof: ProofOfObservability` so the degraded
 * state is provably observable. `cost` is attached to terminal-success variants.
 */
export type BtsCallResult =
  | {
      kind: 'ok';
      response: BehindTheScenesResponse;
      resolvedModel: string;
      resolvedAuth?: string;
      usedOperationalFallback?: boolean;
      cost?: BtsCostAttribution;
    }
  | {
      kind: 'degraded';
      response: BehindTheScenesResponse;
      resolvedModel: string;
      resolvedAuth?: string;
      usedOperationalFallback?: boolean;
      /** Why the call was downgraded to a fallback path. */
      reason: BtsDegradedReason;
      /** True when the degradation persisted a sticky profile-compatibility mutation. */
      persistedMutation?: boolean;
      cost?: BtsCostAttribution;
      proof: ProofOfObservability;
    }
  | {
      kind: 'rate_limit';
      reason: string;
      proof: ProofOfObservability;
    }
  | {
      kind: 'capability_skipped';
      response: BehindTheScenesResponse;
      resolvedModel: string;
      reason: string;
      persistedMutation?: boolean;
      proof: ProofOfObservability;
    };

/**
 * Enumerated reasons a BTS call was downgraded to a fallback.
 *
 * The first three are the structured-output ladder triggers emitted by
 * `emitStructuredOutputFallback` (each carries its own
 * `captureKnownCondition('bts_structured_output_fallback')` + `log.warn`).
 *
 * `operational-fallback` is a DIFFERENT axis: the configured-role background
 * fallback in `executeBtsPlanWithOperationalFallback` (signalled by
 * `usedOperationalFallback`). It emits a structured `log.warn` only — no
 * `captureKnownCondition` — so a `degraded` Result carrying this reason must
 * carry a `ProofOfObservability` WITHOUT a `sentryClass` (the proof would
 * otherwise be a false claim — see `settleBtsCall`).
 */
export type BtsDegradedReason =
  | 'profile-flag-bypass'
  | 'json-capability'
  | 'parse-failure'
  | 'operational-fallback';
