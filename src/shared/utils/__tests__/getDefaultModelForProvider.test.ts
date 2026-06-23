import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../types';
import {
  getDefaultModelForProvider,
  getProviderModelDefaults,
  type ProviderModelDefaults,
} from '../getDefaultModelForProvider';
import {
  OR_DEFAULT_WORKING_MODEL,
  OR_DEFAULT_THINKING_MODEL,
  OR_DEFAULT_BTS_MODEL,
} from '../openRouterDefaults';
import { CODEX_DEFAULT_MODEL, CODEX_DEFAULT_BTS_MODEL } from '../codexDefaults';
import {
  DEFAULT_MODEL,
  PREFERRED_PLANNING_MODEL,
  DEFAULT_AUXILIARY_MODEL,
} from '../modelNormalization';
import {
  isOpenRouterEffectiveProvider,
  OPENROUTER_EFFECTIVE_PROVIDERS,
  ANTHROPIC_DEFAULT_THINKING_MODEL,
  MINDSTONE_DEFAULT_WORKING_MODEL,
  MINDSTONE_DEFAULT_THINKING_MODEL,
  MINDSTONE_DEFAULT_BTS_MODEL,
} from '../providerDefaultConstants';
import type { ActiveProvider } from '../../types/settings';
import { getCatalogEntryById } from '../../data/modelCatalog';

type Picked = Pick<AppSettings, 'activeProvider'>;
const DASH_BTS_MODEL = 'deepseek/deepseek-v4-flash';

// Compile-time assertion utility: forces TS to verify that the discriminant
// has narrowed correctly. If the helper ever stops narrowing
// ProviderModelDefaults by literal, this stops compiling.
function assertProviderIs<P extends ProviderModelDefaults['provider']>(
  defaults: ProviderModelDefaults,
  provider: P,
): asserts defaults is Extract<ProviderModelDefaults, { provider: P }> {
  if (defaults.provider !== provider) {
    throw new Error(
      `Expected provider ${provider}, got ${defaults.provider}`,
    );
  }
}

describe('getProviderModelDefaults', () => {
  it('keeps default thinking-model exports single-sourced across providers', () => {
    const runbook = 'docs/project/NEW_MODEL_SUPPORT_PROCESS.md step 2/2b';

    expect(
      PREFERRED_PLANNING_MODEL,
      `PREFERRED_PLANNING_MODEL drifted from ANTHROPIC_DEFAULT_THINKING_MODEL; follow ${runbook}`,
    ).toBe(ANTHROPIC_DEFAULT_THINKING_MODEL);
    expect(
      OR_DEFAULT_THINKING_MODEL,
      `OR_DEFAULT_THINKING_MODEL must be the OpenRouter twin of ANTHROPIC_DEFAULT_THINKING_MODEL; follow ${runbook}`,
    ).toBe(`anthropic/${ANTHROPIC_DEFAULT_THINKING_MODEL}`);
    expect(
      getCatalogEntryById(OR_DEFAULT_THINKING_MODEL)?.openRouter?.sdkModel,
      `OR_DEFAULT_THINKING_MODEL must resolve to a catalog OpenRouter twin; follow ${runbook}`,
    ).toBe(ANTHROPIC_DEFAULT_THINKING_MODEL);
  });

  it('returns OpenRouter defaults for activeProvider=openrouter', () => {
    const defaults = getProviderModelDefaults({ activeProvider: 'openrouter' });
    assertProviderIs(defaults, 'openrouter');
    expect(defaults).toEqual({
      provider: 'openrouter',
      working: OR_DEFAULT_WORKING_MODEL,
      thinking: OR_DEFAULT_THINKING_MODEL,
      background: OR_DEFAULT_BTS_MODEL,
    });
  });

  it('returns Codex defaults for activeProvider=codex (working == thinking)', () => {
    const defaults = getProviderModelDefaults({ activeProvider: 'codex' });
    assertProviderIs(defaults, 'codex');
    expect(defaults).toEqual({
      provider: 'codex',
      working: CODEX_DEFAULT_MODEL,
      thinking: CODEX_DEFAULT_MODEL,
      background: CODEX_DEFAULT_BTS_MODEL,
    });
    expect(defaults.working).toBe(defaults.thinking);
  });

  it('returns Anthropic defaults for activeProvider=anthropic', () => {
    const defaults = getProviderModelDefaults({ activeProvider: 'anthropic' });
    assertProviderIs(defaults, 'anthropic');
    expect(defaults).toEqual({
      provider: 'anthropic',
      working: DEFAULT_MODEL,
      thinking: PREFERRED_PLANNING_MODEL,
      background: DEFAULT_AUXILIARY_MODEL,
    });
  });

  it('returns the managed (mindstone) tier fallback defaults — cheap + distinct from BYO OpenRouter', () => {
    // Regression: mindstone used to fall through to Anthropic defaults (bare
    // claude ids that misroute through the managed OpenRouter key). It is now
    // OpenRouter-transport (provider:'openrouter') but with its OWN cheap values
    // mirroring the managed tier (worker/BTS = DeepSeek v4 Flash, thinking =
    // GPT-5.5), NOT the BYO-OpenRouter frontier defaults. These mirror the
    // server-seeded managed defaults so they stay allow-list-safe.
    const defaults = getProviderModelDefaults({ activeProvider: 'mindstone' });
    assertProviderIs(defaults, 'openrouter');
    expect(defaults).toEqual({
      provider: 'openrouter',
      working: MINDSTONE_DEFAULT_WORKING_MODEL,
      thinking: MINDSTONE_DEFAULT_THINKING_MODEL,
      background: MINDSTONE_DEFAULT_BTS_MODEL,
    });
    // Distinct from BYO OpenRouter (which keeps the frontier defaults).
    expect(defaults.working).not.toBe(OR_DEFAULT_WORKING_MODEL);
    expect(defaults.thinking).not.toBe(OR_DEFAULT_THINKING_MODEL);
  });

  it('falls back to Anthropic defaults when activeProvider is undefined', () => {
    // Plan-doc Failure Mode Matrix #12 + L248-249 / L274 mandate defensive
    // fallback rather than throwing, because settingsUtils L313 fires before
    // activeProvider derivation at L993 — pre-normalization callers exist by
    // contract.
    const expected = {
      provider: 'anthropic',
      working: DEFAULT_MODEL,
      thinking: PREFERRED_PLANNING_MODEL,
      background: DEFAULT_AUXILIARY_MODEL,
    };
    expect(getProviderModelDefaults({} as Picked)).toEqual(expected);
    expect(getProviderModelDefaults({ activeProvider: undefined })).toEqual(
      expected,
    );
  });

  it('falls back to Anthropic defaults when activeProvider is malformed', () => {
    // Forward-compat: a future enum extension or corrupted persisted setting
    // should never crash callers. Plan-doc Failure Mode #12 requires
    // defensive Sonnet fallback for the default switch arm.
    const malformed = { activeProvider: 'gemini' } as unknown as Picked;
    expect(getProviderModelDefaults(malformed)).toEqual({
      provider: 'anthropic',
      working: DEFAULT_MODEL,
      thinking: PREFERRED_PLANNING_MODEL,
      background: DEFAULT_AUXILIARY_MODEL,
    });
  });

  it('is idempotent — repeated calls return structurally equal defaults', () => {
    const first = getProviderModelDefaults({ activeProvider: 'openrouter' });
    const second = getProviderModelDefaults({ activeProvider: 'openrouter' });
    expect(first).toEqual(second);
  });
});

describe('getDefaultModelForProvider', () => {
  it('defaults to working role when role is omitted', () => {
    expect(getDefaultModelForProvider({ activeProvider: 'openrouter' })).toBe(
      OR_DEFAULT_WORKING_MODEL,
    );
    expect(getDefaultModelForProvider({ activeProvider: 'codex' })).toBe(
      CODEX_DEFAULT_MODEL,
    );
    expect(getDefaultModelForProvider({ activeProvider: 'anthropic' })).toBe(
      DEFAULT_MODEL,
    );
  });

  it('returns role-specific defaults for OpenRouter', () => {
    expect(
      getDefaultModelForProvider({ activeProvider: 'openrouter' }, 'thinking'),
    ).toBe(OR_DEFAULT_THINKING_MODEL);
    expect(
      getDefaultModelForProvider({ activeProvider: 'openrouter' }, 'background'),
    ).toBe(OR_DEFAULT_BTS_MODEL);
  });

  it('returns role-specific defaults for Codex (thinking falls back to working)', () => {
    expect(
      getDefaultModelForProvider({ activeProvider: 'codex' }, 'thinking'),
    ).toBe(CODEX_DEFAULT_MODEL);
    expect(
      getDefaultModelForProvider({ activeProvider: 'codex' }, 'background'),
    ).toBe(CODEX_DEFAULT_BTS_MODEL);
  });

  it('returns role-specific defaults for Anthropic (thinking == Opus)', () => {
    expect(
      getDefaultModelForProvider({ activeProvider: 'anthropic' }, 'thinking'),
    ).toBe(PREFERRED_PLANNING_MODEL);
    expect(
      getDefaultModelForProvider({ activeProvider: 'anthropic' }, 'background'),
    ).toBe(DEFAULT_AUXILIARY_MODEL);
  });

  it('uses the configured BTS model for Mindstone background defaults', () => {
    expect(
      getDefaultModelForProvider(
        { activeProvider: 'mindstone', behindTheScenesModel: DASH_BTS_MODEL },
        'background',
      ),
    ).toBe(DASH_BTS_MODEL);
  });

  it('falls back to the Mindstone managed-tier BTS default when BTS is unset', () => {
    // When BTS is unset, resolveBtsModel returns DEFAULT_AUXILIARY_MODEL and
    // getDefaultModelForProvider falls through to getProviderModelDefaults,
    // which for activeProvider='mindstone' returns MINDSTONE_DEFAULT_BTS_MODEL
    // (cheap managed-tier default, distinct from Anthropic's Haiku fallback).
    // Reconciled with origin/dev commit f01da641ce which introduced the
    // Mindstone-specific managed-tier fallback defaults.
    expect(
      getDefaultModelForProvider(
        { activeProvider: 'mindstone', behindTheScenesModel: undefined },
        'background',
      ),
    ).toBe(MINDSTONE_DEFAULT_BTS_MODEL);
  });

  it('falls back to DEFAULT_MODEL through the role wrapper when activeProvider is undefined', () => {
    expect(getDefaultModelForProvider({} as Picked, 'working')).toBe(
      DEFAULT_MODEL,
    );
    expect(getDefaultModelForProvider({} as Picked, 'thinking')).toBe(
      PREFERRED_PLANNING_MODEL,
    );
    expect(getDefaultModelForProvider({} as Picked, 'background')).toBe(
      DEFAULT_AUXILIARY_MODEL,
    );
  });

  it('treats every OpenRouter-effective provider as OpenRouter transport (provider discriminant)', () => {
    // OR-effective providers all report transport family 'openrouter', even
    // though mindstone carries distinct (cheaper) default *values*.
    for (const provider of OPENROUTER_EFFECTIVE_PROVIDERS) {
      expect(getProviderModelDefaults({ activeProvider: provider }).provider).toBe('openrouter');
    }
  });

  it('snapshots the full activeProvider × role default matrix used by ambient services', () => {
    // CHARACTERIZATION: documents current behavior, not necessarily desired.
    expect(([undefined, 'anthropic', 'openrouter', 'codex', 'mindstone'] as const)
      .map((activeProvider) => ({
        activeProvider,
        working: getDefaultModelForProvider({ activeProvider }, 'working'),
        thinking: getDefaultModelForProvider({ activeProvider }, 'thinking'),
        background: getDefaultModelForProvider({ activeProvider }, 'background'),
        defaults: getProviderModelDefaults({ activeProvider }),
      }))).toMatchInlineSnapshot(`
        [
          {
            "activeProvider": undefined,
            "background": "claude-haiku-4-5",
            "defaults": {
              "background": "claude-haiku-4-5",
              "provider": "anthropic",
              "thinking": "claude-opus-4-8",
              "working": "claude-sonnet-4-6",
            },
            "thinking": "claude-opus-4-8",
            "working": "claude-sonnet-4-6",
          },
          {
            "activeProvider": "anthropic",
            "background": "claude-haiku-4-5",
            "defaults": {
              "background": "claude-haiku-4-5",
              "provider": "anthropic",
              "thinking": "claude-opus-4-8",
              "working": "claude-sonnet-4-6",
            },
            "thinking": "claude-opus-4-8",
            "working": "claude-sonnet-4-6",
          },
          {
            "activeProvider": "openrouter",
            "background": "deepseek/deepseek-v4-flash",
            "defaults": {
              "background": "deepseek/deepseek-v4-flash",
              "provider": "openrouter",
              "thinking": "anthropic/claude-opus-4-8",
              "working": "openai/gpt-5.5",
            },
            "thinking": "anthropic/claude-opus-4-8",
            "working": "openai/gpt-5.5",
          },
          {
            "activeProvider": "codex",
            "background": "gpt-5.4-mini",
            "defaults": {
              "background": "gpt-5.4-mini",
              "provider": "codex",
              "thinking": "gpt-5.5",
              "working": "gpt-5.5",
            },
            "thinking": "gpt-5.5",
            "working": "gpt-5.5",
          },
          {
            "activeProvider": "mindstone",
            "background": "deepseek/deepseek-v4-flash",
            "defaults": {
              "background": "deepseek/deepseek-v4-flash",
              "provider": "openrouter",
              "thinking": "openai/gpt-5.5",
              "working": "deepseek/deepseek-v4-flash",
            },
            "thinking": "openai/gpt-5.5",
            "working": "deepseek/deepseek-v4-flash",
          },
        ]
      `);
  });
});

describe('isOpenRouterEffectiveProvider (shared classifier — must not drift)', () => {
  // Enumerate every ActiveProvider literal so adding a value forces a conscious
  // classification decision here (and in getProviderModelDefaults via the shared set).
  const cases: Array<[ActiveProvider, boolean]> = [
    ['anthropic', false],
    ['openrouter', true],
    ['codex', false],
    ['mindstone', true],
  ];

  it.each(cases)('classifies activeProvider=%s as OR-effective=%s', (provider, expected) => {
    expect(isOpenRouterEffectiveProvider(provider)).toBe(expected);
  });

  it('treats undefined and unknown literals as NOT OpenRouter-effective (pre-normalization safety)', () => {
    expect(isOpenRouterEffectiveProvider(undefined)).toBe(false);
    expect(isOpenRouterEffectiveProvider('gemini')).toBe(false);
    expect(isOpenRouterEffectiveProvider('')).toBe(false);
  });

  it('agrees with getProviderModelDefaults: OR-effective <=> OpenRouter-shaped defaults', () => {
    for (const [provider, expected] of cases) {
      const isOr = getProviderModelDefaults({ activeProvider: provider }).provider === 'openrouter';
      expect(isOr).toBe(expected);
    }
  });
});
