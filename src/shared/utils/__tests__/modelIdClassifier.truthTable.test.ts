/**
 * Truth-table proof that the CENTRALIZED adapters in `modelIdClassifier.ts` exactly
 * reproduce the behaviour of the historical `inferProvider*` clones — BEFORE Stage
 * 3b swaps the clones for these adapters.
 *
 * For each clone we obtain a "reference oracle":
 *  - EXPORTED clones (`providerSwitch.inferProviderFromModelId`,
 *    `billingSource.resolveBillingSourceForModel`,
 *    `providerRouteDecision.inferModelDialect`) — call the REAL function.
 *  - MODULE-PRIVATE clones (`authEnvUtils.inferTierFallbackProvider`,
 *    `providerRouting.inferActiveProviderForFallbackModel`, the `settingsUtils`
 *    inline closure) — transcribe their exact current source verbatim as an
 *    in-test oracle (kept in sync via these very assertions; if the source ever
 *    drifts, Stage 3b's migration is the place that re-pins them).
 *
 * The probe set spans every syntactic family + the known clone-specific cases.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyModelIdSyntax,
  toProviderSwitchProvider,
  toRoutedFallbackProvider,
  toActiveProviderForFallback,
  toBillingFamily,
  toModelDialect,
  type ModelIdSyntax,
} from '../modelIdClassifier';
import { inferProviderFromModelId } from '../providerSwitch';
import { resolveBillingSourceForModel, type BillingSource } from '../billingSource';
import { inferModelDialect } from '../../../core/rebelCore/providerRouteDecision';

// ---------------------------------------------------------------------------
// Probe set: every syntactic family + clone-specific edge cases.
// ---------------------------------------------------------------------------
const PROBES: readonly string[] = [
  // slash / provider-prefixed
  'openai/gpt-5',
  'anthropic/claude-haiku-4-5',
  'deepseek/deepseek-chat',
  'ollama/llama3', // slash AND ollama — billing precedence case
  'meta-llama/llama-3.1',
  // bare anthropic
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  // bare openai gpt
  'gpt-4.1',
  'gpt-5',
  // o-series
  'o3',
  'o4-mini',
  'o1-preview',
  // broad-`o` (NOT o<digit>) — exercises inferModelDialect's startsWith('o')
  'omni-model',
  // ollama colon form (bare, no slash)
  'ollama:llama3',
  'OLLAMA:Phi', // case-insensitive
  // unknown bare
  'mistral-large',
  'some-random-model',
  'openai-but-bare', // starts with 'o' too — dialect edge
  // empty / whitespace
  '',
  '   ',
  '\t',
  // WHITESPACE AROUND a real prefix — the M1 trim-asymmetry cases. The raw,
  // no-trim provider clones do NOT recognise these prefixes (so → undefined);
  // billing trims first (so the trimmed prefix IS recognised). Each adapter must
  // match its clone exactly here, padded or not.
  '  gpt-5',
  ' gpt-5',
  'gpt-5 ',
  ' claude-sonnet-4-6 ',
  '  anthropic/claude-3',
  ' ollama:x',
  ' o3',
  // UPPERCASE — prefixes are case-SENSITIVE in the provider clones (startsWith is
  // exact), so `CLAUDE-3`/`GPT-5`/`O3` are bareUnknown for those; only `ollama`
  // uses a case-INsensitive regex. These pin that asymmetry.
  'CLAUDE-3',
  'GPT-5',
  'O3',
  'OLLAMA:x',
  // STORAGE WRAPPERS — these reach the classifier ONLY if a caller forgets to
  // strip them (callers strip `profile:`/`model:` first). Pinned so the adapters'
  // raw behaviour on a wrapper string is documented: none of the prefix arms
  // match `model:`/`profile:`, so providers → undefined (bareUnknown). `model:...`
  // contains no `/` unless its payload does; `model:profile:x` has none → bare.
  'model:gpt-5',
  'profile:abc',
  'model:profile:x',
];

// ---------------------------------------------------------------------------
// Reference oracles for the module-private clones (verbatim transcriptions).
// ---------------------------------------------------------------------------

/** VERBATIM from `src/core/utils/authEnvUtils.ts#inferTierFallbackProvider`. */
function oracleInferTierFallbackProvider(
  model: string | undefined,
): 'anthropic' | 'openai' | 'openrouter' | undefined {
  if (!model) return undefined;
  if (model.includes('/')) return 'openrouter';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-')) return 'openai';
  return undefined;
}

/** VERBATIM from `src/core/rebelCore/providerRouting.ts#inferActiveProviderForFallbackModel`.
 *  (Original is typed to return `ActiveProvider | undefined` but only ever produces
 *  these two literals; NO `gpt-` arm — intentional.) */
function oracleInferActiveProviderForFallbackModel(
  model: string,
): 'anthropic' | 'openrouter' | undefined {
  if (model.includes('/')) return 'openrouter';
  if (model.startsWith('claude-')) return 'anthropic';
  return undefined;
}

/** VERBATIM from the `settingsUtils.ts` inline `inferProviderFromModelId` closure. */
function oracleSettingsInlineInferProvider(
  modelId: string,
): 'anthropic' | 'codex' | 'openai' | 'openrouter' | undefined {
  if (modelId.includes('/')) return 'openrouter';
  if (modelId.startsWith('claude-')) return 'anthropic';
  if (modelId.startsWith('gpt-')) return 'openai';
  return undefined;
}

// ---------------------------------------------------------------------------
// Base classifier sanity (documents the expected discriminant per probe).
// ---------------------------------------------------------------------------
describe('classifyModelIdSyntax — base discriminant', () => {
  const expected: Record<string, ModelIdSyntax> = {
    'openai/gpt-5': 'slash',
    'anthropic/claude-haiku-4-5': 'slash',
    'deepseek/deepseek-chat': 'slash',
    'ollama/llama3': 'slash', // base checks slash first; billing re-tests ollama itself
    'meta-llama/llama-3.1': 'slash',
    'claude-sonnet-4-6': 'claude',
    'claude-haiku-4-5': 'claude',
    'gpt-4.1': 'gpt',
    'gpt-5': 'gpt',
    o3: 'oSeries',
    'o4-mini': 'oSeries',
    'o1-preview': 'oSeries',
    'omni-model': 'bareUnknown', // 'o' but not o<digit>
    'ollama:llama3': 'ollama',
    'OLLAMA:Phi': 'ollama',
    'mistral-large': 'bareUnknown',
    'some-random-model': 'bareUnknown',
    'openai-but-bare': 'bareUnknown',
    // empty = literal '' only; whitespace-only is bareUnknown (base does NOT trim).
    '': 'empty',
    '   ': 'bareUnknown',
    '\t': 'bareUnknown',
    // whitespace-padded prefixes: NOT recognised by the raw base (no trim).
    '  gpt-5': 'bareUnknown',
    ' gpt-5': 'bareUnknown',
    'gpt-5 ': 'gpt', // trailing space — startsWith('gpt-') still true
    ' claude-sonnet-4-6 ': 'bareUnknown',
    '  anthropic/claude-3': 'slash', // includes '/' regardless of leading space
    ' ollama:x': 'bareUnknown', // OLLAMA_PREFIX is anchored ^ — leading space defeats it
    ' o3': 'bareUnknown',
    // uppercase: prefixes are case-sensitive EXCEPT ollama (regex /i).
    'CLAUDE-3': 'bareUnknown',
    'GPT-5': 'bareUnknown',
    O3: 'bareUnknown',
    'OLLAMA:x': 'ollama',
    // storage wrappers (unstripped) — no prefix arm matches → bareUnknown.
    'model:gpt-5': 'bareUnknown',
    'profile:abc': 'bareUnknown',
    'model:profile:x': 'bareUnknown',
  };
  for (const [probe, syntax] of Object.entries(expected)) {
    it(`classifies ${JSON.stringify(probe)} as ${syntax}`, () => {
      expect(classifyModelIdSyntax(probe)).toBe(syntax);
    });
  }
});

// ---------------------------------------------------------------------------
// HARD-CODED expected oracles.
//
// Stage 3b migrated each clone's BODY to delegate to its adapter, so comparing an
// adapter against its now-delegating REAL clone is tautological. To keep this
// truth-table an HONEST guard, every adapter is ALSO pinned against hard-coded
// expected values transcribed from the documented rules — these would catch a
// regression in the SHARED adapter (which the clone→adapter comparison alone no
// longer can). The clone-equivalence assertions are RETAINED below as a secondary
// "the clone still delegates correctly" check.
// ---------------------------------------------------------------------------

/** Hard-coded expected for the provider-key adapter (slash→openrouter,
 *  claude-→anthropic, gpt-→openai, else undefined; no trim, case-sensitive). */
const EXPECTED_PROVIDER_SWITCH: Record<string, 'anthropic' | 'openai' | 'openrouter' | undefined> = {
  'openai/gpt-5': 'openrouter',
  'anthropic/claude-haiku-4-5': 'openrouter',
  'deepseek/deepseek-chat': 'openrouter',
  'ollama/llama3': 'openrouter', // has '/', so openrouter for this adapter (NOT local)
  'meta-llama/llama-3.1': 'openrouter',
  'claude-sonnet-4-6': 'anthropic',
  'claude-haiku-4-5': 'anthropic',
  'gpt-4.1': 'openai',
  'gpt-5': 'openai',
  o3: undefined,
  'o4-mini': undefined,
  'o1-preview': undefined,
  'omni-model': undefined,
  'ollama:llama3': undefined, // bare, no '/', no claude-/gpt- prefix
  'OLLAMA:Phi': undefined,
  'mistral-large': undefined,
  'some-random-model': undefined,
  'openai-but-bare': undefined,
  '': undefined,
  '   ': undefined,
  '\t': undefined,
  '  gpt-5': undefined, // no trim → prefix not recognised
  ' gpt-5': undefined,
  'gpt-5 ': 'openai', // trailing space; startsWith('gpt-') still true
  ' claude-sonnet-4-6 ': undefined,
  '  anthropic/claude-3': 'openrouter', // has '/'
  ' ollama:x': undefined,
  ' o3': undefined,
  'CLAUDE-3': undefined, // case-sensitive
  'GPT-5': undefined,
  O3: undefined,
  'OLLAMA:x': undefined, // bare, no '/'
  'model:gpt-5': undefined,
  'profile:abc': undefined,
  'model:profile:x': undefined,
};

/** Hard-coded expected for `toActiveProviderForFallback` — same as provider-switch
 *  but with NO gpt arm (bare gpt-* → undefined). */
const EXPECTED_ACTIVE_FALLBACK: Record<string, 'anthropic' | 'openrouter' | undefined> = {
  ...(Object.fromEntries(
    Object.entries(EXPECTED_PROVIDER_SWITCH).map(([k, v]) => [k, v === 'openai' ? undefined : v]),
  ) as Record<string, 'anthropic' | 'openrouter' | undefined>),
};

/** Hard-coded expected for `toBillingFamily` (trim → local ollama[:/] → slash →
 *  gpt → pay-per-use). */
const EXPECTED_BILLING_FAMILY: Record<string, ReturnType<typeof toBillingFamily>> = {
  'openai/gpt-5': 'slash',
  'anthropic/claude-haiku-4-5': 'slash',
  'deepseek/deepseek-chat': 'slash',
  'ollama/llama3': 'local', // billing tests ollama BEFORE slash
  'meta-llama/llama-3.1': 'slash',
  'claude-sonnet-4-6': 'pay-per-use',
  'claude-haiku-4-5': 'pay-per-use',
  'gpt-4.1': 'gpt',
  'gpt-5': 'gpt',
  o3: 'pay-per-use',
  'o4-mini': 'pay-per-use',
  'o1-preview': 'pay-per-use',
  'omni-model': 'pay-per-use',
  'ollama:llama3': 'local',
  'OLLAMA:Phi': 'local',
  'mistral-large': 'pay-per-use',
  'some-random-model': 'pay-per-use',
  'openai-but-bare': 'pay-per-use',
  '': 'empty',
  '   ': 'empty', // billing TRIMS → whitespace-only is empty
  '\t': 'empty',
  '  gpt-5': 'gpt', // billing trims first → prefix recognised
  ' gpt-5': 'gpt',
  'gpt-5 ': 'gpt',
  ' claude-sonnet-4-6 ': 'pay-per-use',
  '  anthropic/claude-3': 'slash',
  ' ollama:x': 'local', // trimmed → ollama: prefix
  ' o3': 'pay-per-use',
  'CLAUDE-3': 'pay-per-use',
  'GPT-5': 'pay-per-use', // case-sensitive gpt check → not gpt family
  O3: 'pay-per-use',
  'OLLAMA:x': 'local', // ollama regex is case-insensitive
  'model:gpt-5': 'pay-per-use', // bare, no '/', not gpt- prefix
  'profile:abc': 'pay-per-use',
  'model:profile:x': 'pay-per-use',
};

/** Hard-coded expected for `toModelDialect` bare-id arms (slash→openrouter-prefixed,
 *  gpt-/startsWith('o')/openai/→openai-compatible, else anthropic-native). */
const EXPECTED_DIALECT: Record<string, ReturnType<typeof toModelDialect>> = {
  'openai/gpt-5': 'openrouter-prefixed',
  'anthropic/claude-haiku-4-5': 'openrouter-prefixed',
  'deepseek/deepseek-chat': 'openrouter-prefixed',
  'ollama/llama3': 'openrouter-prefixed',
  'meta-llama/llama-3.1': 'openrouter-prefixed',
  'claude-sonnet-4-6': 'anthropic-native',
  'claude-haiku-4-5': 'anthropic-native',
  'gpt-4.1': 'openai-compatible',
  'gpt-5': 'openai-compatible',
  o3: 'openai-compatible', // startsWith('o')
  'o4-mini': 'openai-compatible',
  'o1-preview': 'openai-compatible',
  'omni-model': 'openai-compatible', // broad startsWith('o')
  'ollama:llama3': 'openai-compatible', // startsWith('o')!
  'OLLAMA:Phi': 'anthropic-native', // uppercase O — startsWith('o') is case-sensitive
  'mistral-large': 'anthropic-native',
  'some-random-model': 'anthropic-native',
  'openai-but-bare': 'openai-compatible', // startsWith('o')
  '': 'anthropic-native',
  '   ': 'anthropic-native',
  '\t': 'anthropic-native',
  '  gpt-5': 'anthropic-native', // leading space defeats startsWith
  ' gpt-5': 'anthropic-native',
  'gpt-5 ': 'openai-compatible',
  ' claude-sonnet-4-6 ': 'anthropic-native',
  '  anthropic/claude-3': 'openrouter-prefixed',
  ' ollama:x': 'anthropic-native', // leading space → not startsWith('o')
  ' o3': 'anthropic-native',
  'CLAUDE-3': 'anthropic-native',
  'GPT-5': 'anthropic-native', // case-sensitive
  O3: 'anthropic-native', // uppercase O
  'OLLAMA:x': 'anthropic-native',
  'model:gpt-5': 'anthropic-native',
  'profile:abc': 'anthropic-native',
  'model:profile:x': 'anthropic-native',
};

describe('adapters ⟷ HARD-CODED expected oracles (regression guard for the shared adapter)', () => {
  for (const probe of PROBES) {
    it(`toProviderSwitchProvider(${JSON.stringify(probe)})`, () => {
      expect(toProviderSwitchProvider(probe)).toBe(EXPECTED_PROVIDER_SWITCH[probe]);
    });
    it(`toRoutedFallbackProvider(${JSON.stringify(probe)}) — identical rule`, () => {
      expect(toRoutedFallbackProvider(probe)).toBe(EXPECTED_PROVIDER_SWITCH[probe]);
    });
    it(`toActiveProviderForFallback(${JSON.stringify(probe)})`, () => {
      expect(toActiveProviderForFallback(probe)).toBe(EXPECTED_ACTIVE_FALLBACK[probe]);
    });
    it(`toBillingFamily(${JSON.stringify(probe)})`, () => {
      expect(toBillingFamily(probe)).toBe(EXPECTED_BILLING_FAMILY[probe]);
    });
    it(`toModelDialect(${JSON.stringify(probe)})`, () => {
      expect(toModelDialect(probe)).toBe(EXPECTED_DIALECT[probe]);
    });
  }
});

// ---------------------------------------------------------------------------
// Adapter ⟷ clone equivalence.
//
// NOTE (post-Stage-3b): the REAL clones now delegate to these adapters, so the
// REAL-comparison blocks below are no longer the primary guard — the hard-coded
// oracles above are. They are retained as a secondary "clone still delegates"
// regression check (a clone re-growing its own logic would diverge here).
// ---------------------------------------------------------------------------
describe('toProviderSwitchProvider ⟷ providerSwitch.inferProviderFromModelId (REAL)', () => {
  for (const probe of PROBES) {
    it(`matches for ${JSON.stringify(probe)}`, () => {
      expect(toProviderSwitchProvider(probe)).toBe(inferProviderFromModelId(probe));
    });
  }
});

// authEnvUtils.inferTierFallbackProvider reuses toProviderSwitchProvider directly (the rule is
// byte-identical), so this pins that the provider-switch adapter matches the tier-fallback oracle.
describe('toProviderSwitchProvider ⟷ authEnvUtils.inferTierFallbackProvider (oracle)', () => {
  for (const probe of PROBES) {
    it(`matches for ${JSON.stringify(probe)}`, () => {
      expect(toProviderSwitchProvider(probe)).toBe(oracleInferTierFallbackProvider(probe));
    });
  }
  it('matches for undefined (clone has a falsy guard)', () => {
    // The adapter takes a string; the clone's `undefined` path maps to '' → undefined.
    expect(toProviderSwitchProvider('')).toBe(oracleInferTierFallbackProvider(undefined));
  });
});

describe('toRoutedFallbackProvider ⟷ settingsUtils inline clone (oracle)', () => {
  for (const probe of PROBES) {
    it(`matches for ${JSON.stringify(probe)}`, () => {
      expect(toRoutedFallbackProvider(probe)).toBe(oracleSettingsInlineInferProvider(probe));
    });
  }
});

describe('toActiveProviderForFallback ⟷ providerRouting clone (oracle, NO gpt arm)', () => {
  for (const probe of PROBES) {
    it(`matches for ${JSON.stringify(probe)}`, () => {
      expect(toActiveProviderForFallback(probe)).toBe(
        oracleInferActiveProviderForFallbackModel(probe),
      );
    });
  }
  it('does NOT map bare gpt-* (divergence from providerSwitch)', () => {
    expect(toActiveProviderForFallback('gpt-5')).toBeUndefined();
    expect(toProviderSwitchProvider('gpt-5')).toBe('openai');
  });
});

describe('toModelDialect ⟷ providerRouteDecision.inferModelDialect (REAL, profile=null)', () => {
  for (const probe of PROBES) {
    it(`matches for ${JSON.stringify(probe)}`, () => {
      // inferModelDialect with profile=null exercises exactly the bare-id arms the
      // adapter reproduces. (Whitespace-only ids never reach this fn in prod, but
      // the bare-id arms still classify them — we assert parity anyway.)
      expect(toModelDialect(probe)).toBe(inferModelDialect(probe, null));
    });
  }
  it('honours the broad startsWith("o") rule (omni-model → openai-compatible)', () => {
    expect(toModelDialect('omni-model')).toBe('openai-compatible');
    expect(inferModelDialect('omni-model', null)).toBe('openai-compatible');
  });
});

// ---------------------------------------------------------------------------
// Billing: prove toBillingFamily + the call-site flips reproduce
// resolveBillingSourceForModel (REAL) across the provider/route matrix.
// ---------------------------------------------------------------------------
describe('toBillingFamily + flips ⟷ billingSource.resolveBillingSourceForModel (REAL)', () => {
  type Ctx = {
    activeProvider: 'anthropic' | 'mindstone' | 'codex' | 'openrouter';
    hasOpenRouterOAuth: boolean;
    codexConnected: boolean;
  };
  const CTXS: Ctx[] = [
    { activeProvider: 'anthropic', hasOpenRouterOAuth: false, codexConnected: false },
    { activeProvider: 'anthropic', hasOpenRouterOAuth: true, codexConnected: true },
    { activeProvider: 'mindstone', hasOpenRouterOAuth: false, codexConnected: false },
    { activeProvider: 'mindstone', hasOpenRouterOAuth: true, codexConnected: true },
    { activeProvider: 'codex', hasOpenRouterOAuth: false, codexConnected: true },
    { activeProvider: 'codex', hasOpenRouterOAuth: false, codexConnected: false },
    { activeProvider: 'openrouter', hasOpenRouterOAuth: true, codexConnected: false },
  ];

  // Re-derive BillingSource from the adapter's family + the call-site flips.
  // This is the exact logic Stage 3b will inline at the billing call site.
  function billingFromFamily(optionValue: string, ctx: Ctx): BillingSource | undefined {
    switch (toBillingFamily(optionValue)) {
      case 'empty':
        return undefined;
      case 'local':
        return 'local';
      case 'slash':
        return ctx.activeProvider === 'mindstone'
          ? 'subscription'
          : ctx.hasOpenRouterOAuth
            ? 'pool'
            : 'pay-per-use';
      case 'gpt':
        return ctx.codexConnected ? 'subscription' : 'pay-per-use';
      case 'pay-per-use':
        return 'pay-per-use';
    }
  }

  for (const ctx of CTXS) {
    for (const probe of PROBES) {
      it(`matches for ${JSON.stringify(probe)} @ ${ctx.activeProvider}/or=${ctx.hasOpenRouterOAuth}/codex=${ctx.codexConnected}`, () => {
        const real = resolveBillingSourceForModel({
          optionValue: probe,
          activeProvider: ctx.activeProvider,
          hasOpenRouterOAuth: ctx.hasOpenRouterOAuth,
          codexConnected: ctx.codexConnected,
        });
        expect(billingFromFamily(probe, ctx)).toBe(real);
      });
    }
  }
});
