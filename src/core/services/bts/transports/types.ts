/**
 * Typed BtsTransportAdapter interface + the BtsTransport union.
 *
 * Stage 7 of the hotspot-refactor roadmap (PLAN.md). Every dispatchable BTS
 * transport implements one `BtsTransportAdapter`, and the central dispatch in
 * `behindTheScenesClient.ts` selects an adapter via an exhaustive
 * `switch (transport)`. The per-adapter `requiredBehaviors` descriptor is the
 * machine-checkable symmetry contract: `scripts/check-bts-transport-symmetry.ts`
 * statically verifies each adapter's source actually implements the behaviours
 * it declares, catching the historic regression class where transport symmetry
 * was prose rather than code (PMs 260428 callProfileHttp generic-Error,
 * 260429 cooldown bypass / Codex SSE, 260427 OpenRouter structured-output).
 *
 * `BtsTransport` is the `DispatchableTransport` union from the provider router —
 * the single source of truth for which transports exist. Re-aliased here so the
 * adapter registry and the symmetry script share one name.
 */

import type { DispatchableTransport } from '@core/rebelCore/providerRouteDecision';
import type { ProviderRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import type { AppSettings } from '@shared/types';
import type {
  BehindTheScenesResponse,
  WireSafeBtsOptions,
} from './shared';

/** The set of transports the BTS dispatch core can execute. */
export type BtsTransport = DispatchableTransport;

/**
 * Structural-symmetry contract declared by each adapter. Each `true` flag is a
 * behaviour the symmetry CI script statically asserts is present in the
 * adapter's implementation source. A transport that genuinely does not need a
 * behaviour declares it `false` WITH a one-line rationale in `notes`, so the
 * omission is a deliberate, reviewed decision rather than a silent drift.
 */
export interface BtsTransportRequiredBehaviors {
  /**
   * Participates in cooldown discipline. Stage 10 moved the actual
   * `cooldown.record*` call to the DISPATCH layer (`executeBtsPlan`), so every
   * transport is covered by construction (PM 260429 — a transport silently
   * dropping its recorder can no longer regress because no adapter holds one).
   * For a transport that can return a real 429, `recordsCooldown:true` means it
   * surfaces a typed rate-limit signal via `attachCooldownRateLimitSignal` on the
   * thrown error; the symmetry script verifies the dispatch site does the record
   * and (for a fetch transport) that the adapter emits the signal. PM 260502
   * (safety-eval parity). NOTE: this is a SCRIPT invariant, not a TYPE invariant.
   */
  recordsCooldown: boolean;
  /**
   * Parses the HTTP body through `parseJsonResponseBody`, which raises a typed
   * error on an SSE (`text/event-stream`) body before recording success.
   * PM 260429 (Codex proxy SSE force-streaming). `false` for SDK-based / direct
   * `JSON.parse` transports that never receive a raw `Response` to guard.
   */
  guardsSseViaParseJson: boolean;
  /**
   * Classifies 4xx responses into a `ModelError` (via `classifyHttpError` for
   * fetch transports or `classifyError` for the SDK transport) — never a generic
   * `Error`. PM 260428 (callProfileHttp generic-Error regression).
   */
  classifiesHttpErrors: boolean;
  /**
   * Propagates `options.outputFormat` onto the wire request (Anthropic
   * `output_format` / SDK `output_config` / OpenAI `response_format`).
   * PM 260427 (OpenRouter structured-output prose) / investigation 260509.
   */
  propagatesOutputFormat: boolean;
  /**
   * Emits Sentry only through the typed `captureKnownCondition` discipline and
   * never calls `captureException` directly. Enforced as an absence-check by the
   * symmetry script. PM 260424 / 260427 (ModelError fingerprint fragmentation).
   */
  sentryViaCaptureKnownConditionOnly: boolean;
  /**
   * Extracts the model's final answer from reasoning-model output: reads
   * `reasoning_content` via `extractOpenAITextFields` and/or strips
   * `<think>...</think>` blocks via `stripThinkingBlocks`. The literal regression
   * this contract exists to prevent: PM 260427
   * (`reasoning_content` dropped from the direct-profile path for 55 days because
   * parser symmetry was prose, not code). `false` for pure-Anthropic / dormant
   * passthrough transports that never receive OpenAI-style reasoning output —
   * declared with a `notes` rationale. Invariant 14.
   */
  extractsReasoningContent: boolean;
  /**
   * Wraps the call in `withTransientRetry` (bounded exponential backoff on
   * transient 5xx / network errors, respecting the caller's AbortSignal).
   * Invariants 23-24. This is an INTENTIONAL asymmetry: only some paths wrap it
   * (anthropic-direct API-key path, profile-direct). Proxy paths delegate
   * transient handling to the local proxy, so they declare `false` WITH a `notes`
   * rationale — the asymmetry is declared and verified, not silently ignored.
   */
  wrapsTransientRetry: boolean;
  /**
   * Accepts ONLY the branded `WireSafeBtsOptions` minted by
   * `sanitizeBtsOptionsForWireModel` (sampling-param strip for
   * sampling-forbidden models, max_tokens floor for always-on-thinking models,
   * identity copy otherwise). The brand makes an
   * unsanitized dispatch a COMPILE error; the symmetry script additionally
   * asserts the exported transport function's signature carries the brand and
   * that the dispatch layer calls the sanitizer — so a future transport can't
   * ship without it (Fable 5 Stage 4, docs/plans/260611_fable-5-support/PLAN.md).
   */
  requiresWireSafeOptions: boolean;
  /** Free-text rationale for any behaviour deliberately declared `false`. */
  notes?: string;
}

/**
 * Arguments handed to a transport adapter's `execute`. A single struct keeps the
 * dispatch `switch` uniform even though the underlying transports historically
 * had heterogeneous positional signatures.
 */
export interface BtsTransportExecuteArgs {
  /** The materialized route plan that selected this transport. */
  plan: ProviderRoutePlan;
  /**
   * Branded by `sanitizeBtsOptionsForWireModel` — the dispatch layer sanitizes
   * per dispatch, keyed on this dispatch's resolved wire model, so an
   * unsanitized dispatch cannot typecheck (Fable 5 Stage 4).
   */
  options: WireSafeBtsOptions;
  settings: AppSettings;
  // Stage 10: `cooldown` is no longer passed to adapters. Recording moved to the
  // dispatch layer (`executeBtsPlan`); adapters surface a typed cooldown signal
  // (attachCooldownRateLimitSignal) instead of holding the cooldown instance.
}

export interface BtsTransportAdapter {
  /** The `DispatchableTransport` this adapter handles. */
  readonly transport: BtsTransport;
  /** Machine-checkable symmetry contract — see the symmetry CI script. */
  readonly requiredBehaviors: BtsTransportRequiredBehaviors;
  /** Execute the BTS call for this transport. Behaviour-preserving extraction. */
  execute(args: BtsTransportExecuteArgs): Promise<BehindTheScenesResponse>;
}
