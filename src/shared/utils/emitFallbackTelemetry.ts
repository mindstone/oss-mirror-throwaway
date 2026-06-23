/**
 * Stage 4 emitter helper for `provider.modelDefault.resolved` breadcrumbs.
 *
 * Plan-doc: `docs/plans/260514_openrouter_sonnet_bypass_remediation.md` (Stage 4).
 *
 * Two shapes (`TurnFallbackTelemetry`, `SettingsFallbackTelemetry`) keyed on
 * `kind`. The settings variant carries a `bootPhase` discriminator and OMITS
 * the four turn join-keys entirely (not `null`, not `''`). The turn variant
 * carries all four join-keys non-empty.
 *
 * Auto-detection: callers in shared/normalizeSettings can request `kind:
 * 'turn-or-settings'` and this helper picks the variant by inspecting
 * `getTurnContext()` from `@core/logger`. The settingsUtils L869/L874 sites
 * use this affordance because the same code path runs at boot (no turn)
 * AND mid-session after the user switches provider (turn active).
 *
 * Emission: a single pino `info` log under the routable event name
 * `provider.modelDefault.resolved`. Downstream analytics consumers
 * (RudderStack via `trackMainEvent`, etc.) opt-in by wiring a separate
 * `track` call at their site — this helper is intentionally process-agnostic
 * and side-effect-free beyond the structured-log breadcrumb.
 */

import type {
  FallbackTelemetry,
  SettingsFallbackTelemetry,
  TurnFallbackTelemetry,
  FallbackTelemetryAuth,
  FallbackTelemetryProvider,
  FallbackTelemetryRole,
  FallbackTelemetryCredentialState,
  FallbackReason,
} from '../types/fallbackTelemetry';

/**
 * Optional injection point for the main-process turn-context reader.
 *
 * The main process wires `@core/logger`'s `getTurnContext()` here via
 * `setFallbackTelemetryTurnContextProvider()` so the auto-detect path can
 * read `turnId` / `sessionId` from the AsyncLocalStorage scope without
 * forcing `src/shared/utils` to import `@core/logger` (which would break
 * the renderer build — see Stage 4 design note in plan-doc).
 *
 * Renderer and cloud surfaces leave this unset; their auto-detect calls
 * fall through to the settings variant, which is correct: the renderer's
 * `normalizeSettings()` is a transient UI pass before the IPC write, not a
 * turn-context emission. The authoritative turn-side emit is in
 * `turnErrorRecovery` (main), which passes the four join-keys explicitly.
 */
type TurnContextLike = { turnId: string; sessionId?: string };
type TurnContextProvider = () => TurnContextLike | undefined;
let turnContextProvider: TurnContextProvider | null = null;
export function setFallbackTelemetryTurnContextProvider(provider: TurnContextProvider): void {
  turnContextProvider = provider;
}

/**
 * Console-info emission keeps this module renderer-safe. In main the
 * `[Renderer] / [Main]` console capture funnels the JSON through pino;
 * in cloud / mobile / renderer the structured payload still lands in the
 * platform's log pipeline. Stage 5 wires `trackMainEvent` at the main-side
 * call sites separately so RudderStack stays main-only.
 */
const log = {
  info(payload: object, message: string): void {
    // eslint-disable-next-line no-console -- renderer-safe structured-log emission; main captures `[Main]` / `[Renderer]` console output through pino (see comment block above); module deliberately avoids `@core/logger` to keep `src/shared/utils` renderer-importable
    console.info(message, payload);
  },
  warn(payload: object, message: string): void {

    console.warn(message, payload);
  },
};

/**
 * Shape the call site builds before this helper picks the variant.
 *
 * The shared base is mandatory. `bootPhase` is required so the settings
 * variant has a discriminator when there is no turn context. The optional
 * turn fields are consulted only when a turn IS active (then we emit the
 * turn variant). Sites that know they are in a turn can pass `turnId` /
 * `sessionId` explicitly; otherwise the helper reads them from
 * `getTurnContext()`.
 */
export interface AutoFallbackTelemetryInput {
  site: string;
  provider: FallbackTelemetryProvider;
  role: FallbackTelemetryRole;
  resolvedModel: string;
  credentialState: FallbackTelemetryCredentialState;
  providerFallbackReason: FallbackReason;
  bootPhase: 'boot' | 'save' | 'migration';
  /** Optional turn join-keys; helper auto-fills from `getTurnContext()` if absent. */
  turnId?: string;
  sessionId?: string;
  auth?: FallbackTelemetryAuth;
  resolvedAuthLabel?: string;
}

const TELEMETRY_EVENT: TurnFallbackTelemetry['event'] = 'provider.modelDefault.resolved';

/**
 * Emit a settings-context breadcrumb. Hard-pins `kind: 'settings'`; never
 * synthesises a placeholder turnId — settingsUtils L313/L367/L381/L393
 * call this directly to enforce that contract.
 */
export function emitSettingsFallbackTelemetry(
  input: Omit<SettingsFallbackTelemetry, 'event' | 'kind'>,
): void {
  const payload: SettingsFallbackTelemetry = {
    event: TELEMETRY_EVENT,
    kind: 'settings',
    ...input,
  };
  log.info(payload, TELEMETRY_EVENT);
}

/**
 * Emit a turn-context breadcrumb. All four join-keys are required —
 * the type system enforces this so callers cannot silently regress.
 */
export function emitTurnFallbackTelemetry(
  input: Omit<TurnFallbackTelemetry, 'event' | 'kind'>,
): void {
  const payload: TurnFallbackTelemetry = {
    event: TELEMETRY_EVENT,
    kind: 'turn',
    ...input,
  };
  log.info(payload, TELEMETRY_EVENT);
}

/**
 * Auto-detect helper used by sites that may run at boot OR inside a turn
 * (settingsUtils L869/L874).
 *
 * Wire policy:
 *   - If a turn context is present (via `getTurnContext()` or explicit
 *     `turnId` + `sessionId` + `auth` + `resolvedAuthLabel` in the input)
 *     → emit `TurnFallbackTelemetry`.
 *   - Otherwise → emit `SettingsFallbackTelemetry` using `bootPhase`.
 *
 * The helper REFUSES to synthesise placeholder turn fields. If only some
 * of the four turn join-keys are present (e.g. `turnId` from
 * `getTurnContext()` but the caller did not supply `auth`), we fall through
 * to the settings variant and log a warning — the operational contract is
 * "all four or none". This matches the acceptance-test invariant (c) in
 * the Stage 4 plan-doc spec.
 */
export function emitFallbackTelemetryAuto(input: AutoFallbackTelemetryInput): void {
  const ctx = turnContextProvider?.();
  const turnId = input.turnId ?? ctx?.turnId;
  const sessionId = input.sessionId ?? ctx?.sessionId;
  const { auth, resolvedAuthLabel } = input;

  const canEmitTurn =
    typeof turnId === 'string' && turnId.length > 0 &&
    typeof sessionId === 'string' && sessionId.length > 0 &&
    typeof auth === 'string' && auth.length > 0 &&
    typeof resolvedAuthLabel === 'string' && resolvedAuthLabel.length > 0;

  if (canEmitTurn) {
    emitTurnFallbackTelemetry({
      site: input.site,
      provider: input.provider,
      role: input.role,
      resolvedModel: input.resolvedModel,
      credentialState: input.credentialState,
      providerFallbackReason: input.providerFallbackReason,
      turnId: turnId as string,
      sessionId: sessionId as string,
      auth: auth as FallbackTelemetryAuth,
      resolvedAuthLabel: resolvedAuthLabel as string,
    });
    return;
  }

  // Partial turn fields are a misuse of the auto-detect path; warn so we
  // catch it in dev/CI without breaking the breadcrumb.
  const hasPartialTurnFields = !!(turnId || sessionId || auth || resolvedAuthLabel);
  if (hasPartialTurnFields) {
    log.warn(
      { site: input.site, hasTurnId: !!turnId, hasSessionId: !!sessionId, hasAuth: !!auth, hasLabel: !!resolvedAuthLabel },
      'emitFallbackTelemetryAuto: partial turn join-keys present; downgrading to settings variant',
    );
  }

  emitSettingsFallbackTelemetry({
    bootPhase: input.bootPhase,
    site: input.site,
    provider: input.provider,
    role: input.role,
    resolvedModel: input.resolvedModel,
    credentialState: input.credentialState,
    providerFallbackReason: input.providerFallbackReason,
  });
}

/**
 * Lightweight, settings-shape-only derivation of `credentialState` for the
 * boot/save emit sites that do not have access to the full per-turn
 * credential validator (`validateProviderCredentials`). For turn-side
 * callers, prefer to map the existing `credentialState` discriminated union
 * onto this enum directly.
 *
 * Rules (kept in sync with iter-3 BLOCKER #2 case-(c) "no placeholder fakery"):
 *  - `missing`     — no credential of any kind found for the active provider.
 *  - `placeholder` — the recognisable placeholder strings used by templates
 *                    (`'***'` / `'YOUR_API_KEY'`).
 *  - `valid`       — anything else (the resolver itself does not verify the
 *                    credential against the provider; it only confirms a
 *                    non-empty, non-placeholder value).
 */
export function deriveCredentialStateFromSettings(settings: {
  activeProvider?: string;
  apiKey?: string | null;
  openRouter?: { oauthToken?: string | null; enabled?: boolean | null } | null;
  codex?: { connected?: boolean | null } | null;
}): FallbackTelemetryCredentialState {
  const provider: string =
    settings.activeProvider === 'openrouter' || settings.activeProvider === 'codex'
      ? settings.activeProvider
      : 'anthropic';
  if (provider === 'openrouter') {
    const tok = settings.openRouter?.oauthToken;
    if (!tok) return 'missing';
    if (tok === '***' || tok === 'YOUR_OPENROUTER_TOKEN') return 'placeholder';
    return 'valid';
  }
  if (provider === 'codex') {
    return settings.codex?.connected ? 'valid' : 'missing';
  }
  // anthropic
  const key = settings.apiKey;
  if (!key) return 'missing';
  if (key === '***' || key === 'YOUR_API_KEY') return 'placeholder';
  return 'valid';
}

/**
 * Test-only re-export of the union for matrix runners.
 */
export type { FallbackTelemetry };
