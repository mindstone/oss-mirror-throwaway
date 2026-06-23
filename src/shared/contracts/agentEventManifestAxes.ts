/**
 * # Agent event manifest — axis types (Zod-free)
 *
 * The 19 locked axes from parent plan
 * `260427_refactor_contract_manifest.md` § Manifest axes (locked,
 * 2026-04-28), expressed as TypeScript types **without any Zod
 * dependency**. Both the canonical Zod-bearing manifest
 * (`agentEventManifest.ts`) and the Zod-free policy sibling
 * (`agentEventPolicyManifest.ts`) import their axis types from this
 * module so the two stay in lockstep.
 *
 * **Why a separate module?** Round 2 review (2026-04-29) found that the
 * Zod-free sibling type-imported from the Zod-bearing module, which —
 * while runtime-correct (TypeScript erases `import type`) — coupled the
 * two files in a way that made the "Zod-free" claim brittle to future
 * refactors. Extracting axis types into this dedicated, Zod-free file
 * makes the property structurally enforced by file-level imports
 * rather than convention.
 *
 * @see ./agentEventManifest.ts
 * @see ./agentEventPolicyManifest.ts
 * @see docs/plans/260427_refactor_contract_manifest.md § "Manifest axes (locked, 2026-04-28 — Stage 1.5)"
 */

import type { ApplicabilityTag } from './applicabilityTag';

// ----------------------------------------------------------------------------
//   Payload axes — 10 axes, per-event
// ----------------------------------------------------------------------------

/** `keep` / `compact` / `drop` per type (see `eventCompaction.ts`). */
export type CompactionPolicy = 'keep' | 'compact' | 'drop';

/**
 * Named strategy from the `eventSanitization` registry.
 *
 * **Open enum** at this stage: the value is a registry name (e.g.,
 * `'redact-bash-tool-input'`); strategies are added to the registry as
 * postmortems demand. The manifest stores the *name*, not the function;
 * the registry resolves the name to the function at sanitization time.
 *
 * Deliberately a `string` (rather than a literal union) so that the
 * registry can grow without bumping the manifest type. A separate
 * manifest-guard CI script (chunk S2-CG) verifies that every name
 * referenced by a populated manifest entry corresponds to an existing
 * registry entry. A future tightening to a literal union remains an
 * option once the registry stabilises.
 */
export type SanitizationStrategy = string;

/** `terminal` / `pause-and-await-user` / `transient` / `lifecycle-only`. */
export type RuntimeEffect =
  | 'terminal'
  | 'pause-and-await-user'
  | 'transient'
  | 'lifecycle-only';

/** Which surfaces render the event. */
export type UiVisibility =
  | 'transcript'
  | 'timeline'
  | 'transcript+timeline'
  | 'none';

/** Whether the event is replayed into LLM history vs. UI-only. */
export type ModelContextVisibility =
  | 'replay-into-history'
  | 'ui-only'
  | 'history-only';

/** Where the event is produced. */
export type ProducerSurface =
  | 'main'
  | 'core'
  | 'mcp'
  | 'renderer-injected'
  | 'mixed';

/**
 * Parse-time vs produce-time legacy field allowances.
 *
 * `'strict-modern'` — both parse and produce require all envelope fields.
 * `'permissive-parse-strict-produce'` — parse accepts legacy partials;
 *                                       producers must include all fields.
 * `'permissive-both'` — parse and produce both accept legacy partials.
 */
export type LegacyCompatibilityPolicyKind =
  | 'strict-modern'
  | 'permissive-parse-strict-produce'
  | 'permissive-both';

/**
 * Structured legacy-compatibility axis. Bundles the policy enum with
 * a free-form `notes` string that names the legacy partials a parser
 * accepts (e.g., "`sessionId` was historically optional on persisted
 * `user_question` events"). Single field — keeps the manifest at 19
 * axes per parent doc lock; folds policy + rationale into one
 * structured value so the two cannot drift.
 *
 * (Round 2 review fix 2026-04-29: original draft split into two top-level
 * fields, which would have made the manifest 20-axis. Folded into a
 * structured single-axis value.)
 */
export type LegacyCompatibility = Readonly<{
  policy: LegacyCompatibilityPolicyKind;
  /**
   * Free-form notes naming the legacy partials accepted by parsers.
   * Required (use `''` if none); reviewers expect `permissive-*`
   * variants to fill this in.
   */
  notes: string;
}>;

/**
 * What to do with unknown persisted variants encountered at read time.
 * `preserve` — pass through as-is (current `eventCompaction.ts:127-136`).
 * `drop`     — silently drop (rare; reserved for known-bad legacy types).
 * `error`    — fail the load (test-only).
 */
export type UnknownRuntimePolicy = 'preserve' | 'drop' | 'error';

/**
 * What to log / sentry-capture on drop, on legacy-allow-paths, on
 * unknown-variant. `none` means "intentionally silent"; reviewer must
 * cross-reference postmortem to justify silence.
 */
export type TelemetryPolicy =
  | 'none'
  | 'log-only'
  | 'log-and-sentry'
  | 'log-and-sentry-with-pii-scrub';

/**
 * For `error` and `result` variants: rate-limit / billing / retry
 * semantics. All other variants declare
 * `applicabilityTag('not-applicable', '<rationale>')`.
 */
export type ErrorClassPolicyValue =
  | 'transient-retry'
  | 'permanent-fail'
  | 'rate-limit'
  | 'billing-fail'
  | 'auth-fail'
  | 'unknown';

/**
 * The `errorClassPolicy` axis as it appears on a manifest entry. Either
 * a real value (for `error` / `result`) or an applicability tag (for
 * everything else).
 */
export type ErrorClassPolicy = ErrorClassPolicyValue | ApplicabilityTag;

// ----------------------------------------------------------------------------
//   Envelope axes — 9 axes, per-envelope
// ----------------------------------------------------------------------------

/** Producer-time required envelope fields. */
export type EnvelopeRequiredField =
  | 'sessionId'
  | 'turnId'
  | 'originalSessionId'
  | 'batchId'
  | 'toolUseId';

/**
 * Tuple kind used as cache key, dedup key, or cross-session routing key.
 * The actual tuple shape is variant-specific; this axis names the
 * *category* so that derivations and reviewers can reason at the right
 * level.
 */
export type IdentityKey =
  | 'turn-scoped'
  | 'session-scoped'
  | 'batch-scoped'
  | 'tool-use-scoped'
  | 'global'
  | 'none';

/**
 * What a consumer should do when an event arrives whose `sessionId`
 * doesn't match the current session.
 */
export type CrossSessionRouting =
  | 'drop-on-mismatch'
  | 'route-by-session'
  | 'global';

/**
 * Per-surface persistence flags. Stored as a struct so that the three
 * surfaces are explicit and impossible to forget.
 *
 * - `mainAccumulator`: persisted in the main-process event accumulator.
 * - `rendererStore`:   persisted in the renderer-side session store.
 * - `cloud`:           persisted by the cloud service in
 *                      `cloud-service/src/bootstrap.ts`.
 */
export type PersistenceFlags = Readonly<{
  mainAccumulator: boolean;
  rendererStore: boolean;
  cloud: boolean;
}>;

/**
 * Optional dedup tuple. `'none'` means dedup is not applicable;
 * otherwise a category similar to `IdentityKey` (the actual tuple
 * shape lives in code that consumes the dedupe semantics).
 */
export type DedupeKey =
  | 'none'
  | 'identity-key'
  | 'tool-use-id'
  | 'turn-and-batch';

/**
 * Ordering semantics. `seq` lives on the payload (see parent doc § 341),
 * so `'per-session-monotonic-by-seq'` here refers to a payload-derived
 * ordering signal exposed up to the envelope as a derived view.
 */
export type OrderingSemantics =
  | 'per-session-monotonic-by-seq'
  | 'per-turn-ordered'
  | 'unordered';

/** Replay safety / continuation-cache semantics. */
export type IdempotencyAndRetry =
  | 'idempotent'
  | 'cache-continuation-result'
  | 'non-idempotent-no-retry';

/** What happens when WS disconnects / session aborts mid-flight. */
export type CancellationBehavior =
  | 'abort-on-disconnect'
  | 'continue-on-disconnect'
  | 'requeue-on-disconnect';

/**
 * JSON-only / binary-allowed / size cap. The size cap is a categorical
 * label; concrete byte limits are enforced by the serializer, not the
 * manifest.
 */
export type SerializationConstraints =
  | 'json-only'
  | 'json-only-small'
  | 'binary-allowed'
  | 'json-or-stream';
