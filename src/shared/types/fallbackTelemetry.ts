/**
 * Provider-aware fallback telemetry shapes.
 *
 * Stage 4 of `docs/plans/260514_openrouter_sonnet_bypass_remediation.md`.
 *
 * The Stage 1 helper `getDefaultModelForProvider` selects a provider-correct
 * default whenever a caller needs a model fallback. Stage 4 standardises the
 * structured-log breadcrumb that each call site emits so we can answer two
 * production questions:
 *
 *   1. "Are users on OpenRouter / Codex ever silently falling back to a
 *      Sonnet default?" (regression detector for the original
 *      OpenRouter-Sonnet-bypass class of bug.)
 *   2. "When the helper resolved to a non-null `providerFallbackReason`,
 *      which credential or alias condition triggered it?" (root-cause
 *      breakdown for spend / latency anomalies.)
 *
 * --- Two-variant discriminated union ---
 *
 * Per the iter-3 BLOCKER (Stage 4 must not contradict Stage 2A: the boot/save
 * paths inside `normalizeSettings` fire BEFORE any turn context exists), the
 * payload is split into two variants keyed on `kind`:
 *
 *   - `TurnFallbackTelemetry`   — emitted when the helper resolves inside a
 *                                 turn (Stage 2B turnErrorRecovery, Stage 2C
 *                                 reconnect, Stage 3 council / qualityTiers
 *                                 callers, and the late settingsUtils sites
 *                                 that fire when the user switches provider
 *                                 mid-session). Carries the full join-key set
 *                                 (`turnId`, `sessionId`, `auth`,
 *                                 `resolvedAuthLabel`).
 *
 *   - `SettingsFallbackTelemetry` — emitted when the helper resolves during
 *                                 settingsUtils boot or save (no turn
 *                                 context). The turn join-keys are
 *                                 **absent from the payload** — not `null`,
 *                                 not `''` — and `bootPhase` substitutes as
 *                                 the temporal/causal join key.
 *
 * --- Field rename (Stage 0 BLOCKER #4) ---
 *
 * The TYPE alias name `FallbackReason` is preserved per the iter-3 BLOCKER #4
 * attestation. The carrying FIELD name is renamed from the legacy
 * `fallbackReason` to `providerFallbackReason` to disambiguate from two
 * unrelated production usages of the legacy field name
 * (`agentTurnExecutor.ts:1605` tool-search-fallback and
 * `preTurnWorkerService.ts:843` pre-turn embedding), which are out of scope
 * for this remediation. The Stage 6 layered grep gate enforces this rename
 * (primary regex matches the renamed field; secondary advisory regex tolerates
 * exactly the 2 unrelated production hits + plan-doc historical zones).
 */

/**
 * Closed kebab-case union of provider-fallback reasons (II-M1).
 *
 * `null` means the helper resolved on the happy path (correct provider,
 * valid credentials, alias present). Every non-null literal must surface
 * a structured-warn log at the emit site so downstream analytics can
 * dashboard the breakdown.
 *
 * Add new values only with an accompanying plan-doc rationale: the Stage 6
 * grep gate matches any string-literal `providerFallbackReason: '<value>'`
 * that is not narrowed by this type.
 */
export type FallbackReason =
  | null
  | 'credential-missing'
  | 'credential-placeholder'
  | 'alias-missing'
  | 'alias-invalid'
  | 'provider-mismatch'
  | 'tier-unavailable'
  | 'helper-error';

/**
 * The closed set of provider literals that this telemetry can carry.
 * Mirrors the `getDefaultModelForProvider` discriminated-union arms.
 */
import type { ModelRoleTier } from './agent';

export type FallbackTelemetryProvider = 'anthropic' | 'openrouter' | 'codex';

/**
 * The model-role tier this telemetry breadcrumb is about. Canonical type:
 * {@link ModelRoleTier} (single source of tier membership). The emitted analytics
 * value stays `'background'` for the cheap tier — unchanged. Kept as a
 * domain-named alias for call-site readability.
 */
export type FallbackTelemetryRole = ModelRoleTier;

/** Credential state at the moment of resolution. */
export type FallbackTelemetryCredentialState = 'missing' | 'placeholder' | 'valid';

/** Auth mode used for this resolution (turn-context only). */
export type FallbackTelemetryAuth = 'oauth' | 'apiKey' | 'codexCli';

/**
 * Shared base. Both variants share these fields verbatim.
 *
 * `event` is the routable structured-log event name. Pino consumers and the
 * downstream analytics pipeline both key on this string, so it must remain
 * stable across stages and surfaces.
 */
export interface BaseFallbackTelemetry {
  event: 'provider.modelDefault.resolved';
  /**
   * Stable per-call-site identifier, e.g. `settingsUtils:367` or
   * `turnErrorRecovery:142`. The line-number suffix is informational only —
   * grep / analytics consumers key on the colon-separated module:label
   * shape. When refactors move a site, update the label so the breadcrumb
   * remains traceable in the existing dashboards.
   */
  site: string;
  provider: FallbackTelemetryProvider;
  role: FallbackTelemetryRole;
  /** The model string the helper returned. Sonnet on a non-Anthropic row = bug. */
  resolvedModel: string;
  credentialState: FallbackTelemetryCredentialState;
  /**
   * Renamed from legacy `fallbackReason` per Stage 0 BLOCKER #4.
   * The TYPE alias name `FallbackReason` is preserved; only the field changed.
   */
  providerFallbackReason: FallbackReason;
}

/**
 * Turn-context variant. Emitted when the helper resolves inside an active
 * turn — Stage 2B/2C/3 callers, plus the late settingsUtils sites that fire
 * mid-session.
 *
 * The four join keys (`turnId`, `sessionId`, `auth`, `resolvedAuthLabel`)
 * are REQUIRED and non-empty. The Stage 4 acceptance test asserts this
 * explicitly so future agents cannot regress to placeholder values.
 */
export interface TurnFallbackTelemetry extends BaseFallbackTelemetry {
  kind: 'turn';
  /** ULID — links to the turn-execution breadcrumb. */
  turnId: string;
  /** Links to the session trace. */
  sessionId: string;
  /** Raw auth mode used for this resolution. */
  auth: FallbackTelemetryAuth;
  /** Canonical label from resolveTurnAuthLabelFromRoutePlan. */
  resolvedAuthLabel: string;
}

/**
 * Settings-context variant. Emitted when the helper resolves during
 * `normalizeSettings()` boot/save (or migration). No turn exists yet, so
 * the four turn join keys are intentionally absent from the payload — not
 * `null`, not `''`, but absent.
 *
 * `bootPhase` substitutes as the temporal/causal join key for downstream
 * analytics: dashboards bucket settings-context events by phase to surface
 * boot-time fallback rates separately from save-time and migration-time
 * rates.
 *
 * The `provider` field reflects the **resolved active provider after
 * settings derivation**, not a turn-time `routePlan.provider`. Sites that
 * would otherwise emit before `activeProvider` is derived must defer the
 * breadcrumb until after derivation (see Stage 2A site sequencing).
 */
export interface SettingsFallbackTelemetry extends BaseFallbackTelemetry {
  kind: 'settings';
  bootPhase: 'boot' | 'save' | 'migration';
}

/**
 * Specialisation of `SettingsFallbackTelemetry` for the Stage 2C v26→v27
 * automation-schedule migration. The base settings payload is extended with
 * mutation-tracking fields the dashboard needs to bucket "actually-mutated"
 * runs vs. flag-OFF reads vs. customised-record skips.
 *
 * The migration site at `automationScheduler.applyProviderAwareV26V27Pass`
 * is the only emitter; other migration sites use `SettingsFallbackTelemetry`
 * directly with `bootPhase: 'migration'`.
 */
export interface MigrationFallbackTelemetry extends SettingsFallbackTelemetry {
  bootPhase: 'migration';
  /** Migration identifier — currently the only value is `v26_to_v27`. */
  migration: 'v26_to_v27';
  /** Whether the migration applied a mutation this pass. */
  mutationApplied: boolean;
  /**
   * The model the migration filled in, or `null` when no mutation was applied.
   * When `mutationApplied` is `true`, this matches `resolvedModel`. When false,
   * it is `null` so the dashboard can drop the row from the "mutations by
   * model" breakdown without a special case.
   */
  defaultedTo: string | null;
  /** Resolved active provider AFTER settings derivation. Mirrors `provider`. */
  activeProvider: FallbackTelemetryProvider;
  /** How many automation records were evaluated this pass. */
  automationCount: number;
  /** Feature-flag state at evaluation time — defaults to OFF in v27. */
  mutationFlagState: boolean;
}

/**
 * Discriminated union of the two variants. Consumers narrow on `kind`.
 */
export type FallbackTelemetry = TurnFallbackTelemetry | SettingsFallbackTelemetry;
