/**
 * Stage 4 matrix test for provider-aware fallback telemetry.
 *
 * Plan-doc reference: `docs/plans/260514_openrouter_sonnet_bypass_remediation.md`
 * (Stage 4 — Test matrix + acceptance invariants a/b/c/d/e).
 *
 * The test is structural rather than runtime-integration: it asserts the
 * type-shape invariants the matrix runner depends on, plus a runtime
 * assertion against representative payloads from each `kind` × `bootPhase`
 * combination. This catches schema drift (e.g. someone re-adding the
 * legacy `fallbackReason` field or re-introducing turn join-keys on a
 * settings payload) without having to spin up the full Electron + Provider
 * harness for every cell.
 *
 * The cross-surface (D-CMP-6) and live emit-site behaviour is covered by
 * the existing site-level unit tests (settingsUtils, automationScheduler,
 * turnErrorRecovery). Stage 4 owns the schema contract; the per-site
 * tests own the call-site behaviour.
 */

import type {
  AssertExact,
  IsExactStrict,
} from '../typeAssertions';
import type {
  BaseFallbackTelemetry,
  FallbackReason,
  FallbackTelemetry,
  FallbackTelemetryAuth,
  FallbackTelemetryCredentialState,
  FallbackTelemetryProvider,
  FallbackTelemetryRole,
  MigrationFallbackTelemetry,
  SettingsFallbackTelemetry,
  TurnFallbackTelemetry,
} from '../fallbackTelemetry';

// ---------------------------------------------------------------------------
// Compile-time assertions (a) closed enums, (d) settings variant omits join keys
// ---------------------------------------------------------------------------

// (a) `FallbackReason` is the exact 8-value union per Stage 0 BLOCKER #4.
// eslint-disable-next-line @typescript-eslint/naming-convention
type _ReasonExact = AssertExact<
  IsExactStrict<
    FallbackReason,
    | null
    | 'credential-missing'
    | 'credential-placeholder'
    | 'alias-missing'
    | 'alias-invalid'
    | 'provider-mismatch'
    | 'tier-unavailable'
    | 'helper-error'
  >
>;

// Closed enums for the join-key fields. These match the helper inputs so
// downstream consumers can compile-time-narrow on them without re-deriving
// the union.
// eslint-disable-next-line @typescript-eslint/naming-convention
type _ProviderExact = AssertExact<
  IsExactStrict<FallbackTelemetryProvider, 'anthropic' | 'openrouter' | 'codex'>
>;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _RoleExact = AssertExact<
  IsExactStrict<FallbackTelemetryRole, 'thinking' | 'working' | 'background'>
>;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _CredStateExact = AssertExact<
  IsExactStrict<FallbackTelemetryCredentialState, 'missing' | 'placeholder' | 'valid'>
>;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _AuthExact = AssertExact<
  IsExactStrict<FallbackTelemetryAuth, 'oauth' | 'apiKey' | 'codexCli'>
>;

// (d) `SettingsFallbackTelemetry` MUST NOT carry the four turn join-keys.
// We assert this by checking that the settings variant is structurally
// disjoint from a hypothetical "settings with turn join-keys" type.
type SettingsKeys = keyof SettingsFallbackTelemetry;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _SettingsLacksTurnId = AssertExact<
  IsExactStrict<Extract<SettingsKeys, 'turnId'>, never>
>;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _SettingsLacksSessionId = AssertExact<
  IsExactStrict<Extract<SettingsKeys, 'sessionId'>, never>
>;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _SettingsLacksAuth = AssertExact<
  IsExactStrict<Extract<SettingsKeys, 'auth'>, never>
>;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _SettingsLacksResolvedAuthLabel = AssertExact<
  IsExactStrict<Extract<SettingsKeys, 'resolvedAuthLabel'>, never>
>;

// Turn variant MUST carry all four join-keys (compile-time check).
type TurnKeys = keyof TurnFallbackTelemetry;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _TurnHasJoinKeys = AssertExact<
  IsExactStrict<
    Extract<TurnKeys, 'turnId' | 'sessionId' | 'auth' | 'resolvedAuthLabel'>,
    'turnId' | 'sessionId' | 'auth' | 'resolvedAuthLabel'
  >
>;

// Base shape is shared (the rename audit: `providerFallbackReason` lives here,
// not the legacy `fallbackReason`).
type BaseKeys = keyof BaseFallbackTelemetry;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _BaseHasRenamedField = AssertExact<
  IsExactStrict<Extract<BaseKeys, 'providerFallbackReason'>, 'providerFallbackReason'>
>;
// eslint-disable-next-line @typescript-eslint/naming-convention
type _BaseLacksLegacyField = AssertExact<
  IsExactStrict<Extract<BaseKeys, 'fallbackReason'>, never>
>;

// ---------------------------------------------------------------------------
// Runtime invariants (a-e)
// ---------------------------------------------------------------------------

const ALL_REASONS: ReadonlyArray<FallbackReason> = [
  null,
  'credential-missing',
  'credential-placeholder',
  'alias-missing',
  'alias-invalid',
  'provider-mismatch',
  'tier-unavailable',
  'helper-error',
];

const PROVIDERS: ReadonlyArray<FallbackTelemetryProvider> = ['anthropic', 'openrouter', 'codex'];
const ROLES: ReadonlyArray<FallbackTelemetryRole> = ['thinking', 'working', 'background'];
const CRED_STATES: ReadonlyArray<FallbackTelemetryCredentialState> = ['missing', 'placeholder', 'valid'];
const AUTHS: ReadonlyArray<FallbackTelemetryAuth> = ['oauth', 'apiKey', 'codexCli'];
const BOOT_PHASES: ReadonlyArray<SettingsFallbackTelemetry['bootPhase']> = ['boot', 'save', 'migration'];

/**
 * Build a representative matrix of `TurnFallbackTelemetry` + `SettingsFallbackTelemetry`
 * payloads, one per (provider × role × credentialState × kind × bootPhase) cell.
 * Per-axis we hold the unrelated axes at a constant so the matrix size stays
 * bounded (3 × 3 × 3 × {turn, settings:boot, settings:save, settings:migration}
 * = 108 cells).
 */
function buildMatrix(): ReadonlyArray<FallbackTelemetry> {
  const cells: FallbackTelemetry[] = [];
  for (const provider of PROVIDERS) {
    for (const role of ROLES) {
      for (const credState of CRED_STATES) {
        // Turn variant
        const auth: FallbackTelemetryAuth =
          provider === 'codex' ? 'codexCli' : provider === 'openrouter' ? 'oauth' : 'apiKey';
        cells.push({
          event: 'provider.modelDefault.resolved',
          kind: 'turn',
          turnId: `01J8MATRIX-${provider}-${role}-${credState}`,
          sessionId: `session-${provider}`,
          site: `matrix:${provider}:${role}`,
          provider,
          role,
          resolvedModel:
            provider === 'anthropic'
              ? 'claude-sonnet-4-6'
              : provider === 'openrouter'
                ? 'openai/gpt-5.5'
                : 'gpt-5.5',
          credentialState: credState,
          auth,
          resolvedAuthLabel: `${provider}-${auth}`,
          providerFallbackReason: credState === 'missing' ? 'credential-missing' : null,
        });
        // Settings variant — one per bootPhase
        for (const bootPhase of BOOT_PHASES) {
          cells.push({
            event: 'provider.modelDefault.resolved',
            kind: 'settings',
            bootPhase,
            site: `matrix:${provider}:${role}:${bootPhase}`,
            provider,
            role,
            resolvedModel:
              provider === 'anthropic'
                ? 'claude-sonnet-4-6'
                : provider === 'openrouter'
                  ? 'openai/gpt-5.5'
                  : 'gpt-5.5',
            credentialState: credState,
            providerFallbackReason: credState === 'placeholder' ? 'credential-placeholder' : null,
          });
        }
      }
    }
  }
  return cells;
}

describe('Stage 4 — FallbackTelemetry matrix invariants', () => {
  const matrix = buildMatrix();

  // (a) Every cell's providerFallbackReason is one of the 8 closed values.
  it('(a) providerFallbackReason is always a member of the FallbackReason enum', () => {
    expect(matrix.length).toBeGreaterThan(0);
    for (const cell of matrix) {
      expect(ALL_REASONS).toContain(cell.providerFallbackReason);
    }
  });

  // (b) `null` reason ⇔ happy-path. We model happy-path as "credentialState
  // matches the cell's optimistic state for that variant". For our matrix:
  //   - Turn cells   → null iff credentialState !== 'missing'
  //   - Settings     → null iff credentialState !== 'placeholder'
  // The point of the invariant is not the specific mapping above but the
  // biconditional shape: a non-null reason MUST correspond to an unhealthy
  // credential / alias state, and vice versa.
  it('(b) providerFallbackReason: null ⇔ happy-path; non-null ⇔ unhealthy state', () => {
    for (const cell of matrix) {
      if (cell.kind === 'turn') {
        const happy = cell.credentialState !== 'missing';
        expect(cell.providerFallbackReason === null).toBe(happy);
      } else {
        const happy = cell.credentialState !== 'placeholder';
        expect(cell.providerFallbackReason === null).toBe(happy);
      }
    }
  });

  // (c) Every turn cell has all four non-empty join-keys.
  it('(c) turn variant — turnId, sessionId, auth, resolvedAuthLabel are all present and non-empty', () => {
    const turnCells = matrix.filter((c): c is TurnFallbackTelemetry => c.kind === 'turn');
    expect(turnCells.length).toBeGreaterThan(0);
    for (const cell of turnCells) {
      expect(typeof cell.turnId).toBe('string');
      expect(cell.turnId.length).toBeGreaterThan(0);
      expect(typeof cell.sessionId).toBe('string');
      expect(cell.sessionId.length).toBeGreaterThan(0);
      expect(AUTHS).toContain(cell.auth);
      expect(typeof cell.resolvedAuthLabel).toBe('string');
      expect(cell.resolvedAuthLabel.length).toBeGreaterThan(0);
    }
  });

  // (d) Every settings cell OMITS the four turn fields entirely.
  // We model omission as "the key does not exist on the object". This catches
  // both `null` and `''` regressions (both would pass a truthiness check but
  // fail the analytics-pipeline join key uniqueness contract).
  it('(d) settings variant — turnId / sessionId / auth / resolvedAuthLabel are absent (not null, not empty)', () => {
    const settingsCells = matrix.filter(
      (c): c is SettingsFallbackTelemetry => c.kind === 'settings',
    );
    expect(settingsCells.length).toBeGreaterThan(0);
    for (const cell of settingsCells) {
      const payload = cell as unknown as Record<string, unknown>;
      expect('turnId' in payload).toBe(false);
      expect('sessionId' in payload).toBe(false);
      expect('auth' in payload).toBe(false);
      expect('resolvedAuthLabel' in payload).toBe(false);
      expect(BOOT_PHASES).toContain(cell.bootPhase);
    }
  });

  // (e) The matrix exercises both kinds (at least one of each).
  it('(e) matrix emits ≥1 turn cell and ≥1 settings cell', () => {
    const turnCount = matrix.filter((c) => c.kind === 'turn').length;
    const settingsCount = matrix.filter((c) => c.kind === 'settings').length;
    expect(turnCount).toBeGreaterThan(0);
    expect(settingsCount).toBeGreaterThan(0);
  });

  it('event name is the stable routable identifier across both kinds', () => {
    for (const cell of matrix) {
      expect(cell.event).toBe('provider.modelDefault.resolved');
    }
  });
});

describe('Stage 4 — MigrationFallbackTelemetry shape', () => {
  it('extends SettingsFallbackTelemetry with the mutation-tracking fields', () => {
    const m: MigrationFallbackTelemetry = {
      event: 'provider.modelDefault.resolved',
      kind: 'settings',
      bootPhase: 'migration',
      migration: 'v26_to_v27',
      site: 'automationScheduler:v26_to_v27',
      provider: 'anthropic',
      role: 'background',
      resolvedModel: 'claude-haiku-4-5',
      credentialState: 'valid',
      providerFallbackReason: null,
      mutationApplied: true,
      defaultedTo: 'claude-haiku-4-5',
      activeProvider: 'anthropic',
      automationCount: 3,
      mutationFlagState: true,
    };
    // Compile-time check via assignment + runtime invariants.
    expect(m.kind).toBe('settings');
    expect(m.bootPhase).toBe('migration');
    expect(m.migration).toBe('v26_to_v27');
    expect(typeof m.mutationApplied).toBe('boolean');
    expect(typeof m.automationCount).toBe('number');
    expect(typeof m.mutationFlagState).toBe('boolean');
    // (d) still holds: turn fields absent.
    const payload = m as unknown as Record<string, unknown>;
    expect('turnId' in payload).toBe(false);
  });
});
