/**
 * ONE dependency-free, typed raw-syntax classifier for model identifiers, plus a
 * set of CENTRALIZED adapters that reproduce — exactly — the behaviour of the
 * several historical `inferProvider*` clones scattered across the provider-routing
 * code.
 *
 * WHY this lives in `src/shared` (not `src/core`): the clones live in
 * `@core`-free modules (`providerSwitch.ts`, `settingsUtils.ts`, `billingSource.ts`)
 * which CANNOT import from `@core`. A cross-family review therefore mandated the
 * shared base + centralized adapters here. This module imports NOTHING from
 * `@core` and pulls in no settings/profile dependencies — it classifies a bare
 * model-id string by its SYNTAX alone.
 *
 * Scope: classification is by raw model-id syntax (prefix rules), matching what
 * every clone keys on. Callers strip storage wrappers (`profile:` / `model:`) and
 * resolve profiles BEFORE reaching the bare-id arms — so this classifier (and the
 * adapters built on it) operate on the already-stripped bare model id, exactly
 * like the clone arms they replace.
 *
 * The adapters DELIBERATELY DIVERGE from one another — that divergence is the
 * historical behaviour being preserved, not a bug. See each adapter's doc comment
 * and the truth-table test `__tests__/modelIdClassifier.truthTable.test.ts`.
 *
 * @see src/shared/utils/providerSwitch.ts — `inferProviderFromModelId` clone (Stage 3b will call `toProviderSwitchProvider`)
 * @see src/core/utils/authEnvUtils.ts — `inferTierFallbackProvider` clone (reuses `toProviderSwitchProvider`)
 * @see src/core/rebelCore/providerRouting.ts — `inferActiveProviderForFallbackModel` clone (`toActiveProviderForFallback`)
 * @see src/shared/utils/settingsUtils.ts — inline provider-inference clone (`toRoutedFallbackProvider`)
 * @see src/shared/utils/billingSource.ts — `resolveBillingSourceForModel` clone (`toBillingFamily`)
 * @see src/core/rebelCore/providerRouteDecision.ts — `inferModelDialect` (`toModelDialect` wraps this base)
 */

/**
 * Raw-syntax classification of a bare model id, derived from prefix rules ONLY.
 *
 * IMPORTANT — the base classifier operates on the RAW string and does NOT trim.
 * The provider-key clones it reproduces (`inferProviderFromModelId`,
 * `inferTierFallbackProvider`, `inferActiveProviderForFallbackModel`, the
 * `settingsUtils` inline closure) run `.startsWith(...)` / `.includes('/')` on the
 * UNTRIMMED string — so e.g. stored `"model: gpt-5"` sliced to `" gpt-5"` (the
 * `authEnvUtils.parseFallbackEncoding` payload is NOT trimmed) infers `undefined`,
 * NOT `'openai'`. Trimming here would silently flip that real, reachable case.
 * Adapters that MUST trim (billing) do so themselves; see `toBillingFamily`.
 *
 * The discriminant captures every distinction any clone keys on:
 *  - `empty`       — the LITERAL empty string `''` ONLY. A whitespace-only id like
 *                    `'   '` is NOT `empty` here; it falls through to `bareUnknown`
 *                    (raw `'   '.startsWith('claude-')` etc. are all false), which is
 *                    exactly what the no-trim provider clones do (→ undefined). The
 *                    billing adapter handles whitespace-only via its own trim.
 *  - `slash`       — contains `/` (slash-form id, e.g. `openai/gpt-5`, `anthropic/claude-x`,
 *                    `deepseek/...`). Slash takes precedence over every prefix below
 *                    in EVERY clone, so it is checked first after `empty`.
 *  - `ollama`      — bare id matching `ollama[:/]` (the billing "local" marker). Only
 *                    `billing` keys on this; other clones see `ollama:foo` as a bare,
 *                    non-slash id (the `[:/]` form with `/` would be `slash` — but the
 *                    `ollama:` colon form is the relevant local case and has no `/`).
 *  - `claude`      — bare id starting with `claude-`.
 *  - `gpt`         — bare id starting with `gpt-`.
 *  - `oSeries`     — bare id starting with `o` followed by a digit (`o3`, `o4-mini`,
 *                    …) — only `inferModelDialect` keys on this (OpenAI-compatible).
 *  - `bareUnknown` — any other non-empty bare id (incl. leading/trailing whitespace
 *                    around a prefix, which the raw clones do NOT recognise).
 *
 * Order of evaluation (load-bearing): empty → slash → ollama → claude → gpt →
 * oSeries → bareUnknown. This order lets every adapter recover its clone's exact
 * branch precedence with a single switch.
 */
export type ModelIdSyntax =
  | 'empty'
  | 'slash'
  | 'ollama'
  | 'claude'
  | 'gpt'
  | 'oSeries'
  | 'bareUnknown';

// Matches the historical billing local-marker test `/^ollama[:/]/i`. We classify
// the bare (non-slash) `ollama:` form here; a slash-bearing `ollama/...` id is
// caught by the earlier `slash` arm (billing's `isLocalOptionId` runs BEFORE its
// slash check, so the truth-table pins the slash-vs-ollama precedence per adapter).
const OLLAMA_PREFIX = /^ollama[:/]/i;

// `o`-series OpenAI reasoning models: `o` immediately followed by a digit. This is
// narrower than the historical `model.startsWith('o')` in `inferModelDialect`,
// which would also match e.g. `openai/...` (already caught by `slash`) and any bare
// id beginning with `o`. The adapter `toModelDialect` reproduces the broad
// `startsWith('o')` behaviour explicitly; see its doc comment + truth-table.

/**
 * Classify a bare model id by raw syntax. Pure; dependency-free.
 *
 * NOTE: this is the SYNTAX layer. It does NOT replicate `inferModelDialect`'s
 * broad `startsWith('o')` rule (that adapter handles it) — `oSeries` here is the
 * precise `o<digit>` family so other adapters that ignore o-series are unaffected.
 */
export function classifyModelIdSyntax(modelId: string): ModelIdSyntax {
  // RAW string — no trim (see doc above). `empty` is the literal '' only; a
  // whitespace-padded prefix is `bareUnknown`, matching the no-trim clones.
  if (modelId === '') return 'empty';
  // Slash precedence: every clone treats a slash-form id as provider-prefixed
  // BEFORE any bare prefix check. (Billing checks `ollama` first; that divergence
  // is handled in `toBillingFamily`, which calls the ollama test on its own.)
  if (modelId.includes('/')) return 'slash';
  if (OLLAMA_PREFIX.test(modelId)) return 'ollama';
  if (modelId.startsWith('claude-')) return 'claude';
  if (modelId.startsWith('gpt-')) return 'gpt';
  if (/^o\d/.test(modelId)) return 'oSeries';
  return 'bareUnknown';
}

// ---------------------------------------------------------------------------
// CENTRALIZED ADAPTERS — one per clone's enum. Each maps the base classification
// to that clone's EXACT output, preserving its order and special-cases. The
// divergences between them are intentional (historical behaviour).
// ---------------------------------------------------------------------------

/** Output enum shared by the three "provider-key" clones (providerSwitch + authEnv). */
export type InferredProvider = 'anthropic' | 'openai' | 'openrouter';

/**
 * Reproduces `providerSwitch.ts#inferProviderFromModelId` AND
 * `authEnvUtils.ts#inferTierFallbackProvider` (identical logic):
 *   slash → openrouter, `claude-` → anthropic, `gpt-` → openai, else undefined.
 *
 * `authEnvUtils` additionally guards a falsy `model` and returns undefined; an
 * empty id classifies as `empty` here → undefined, matching that guard. A
 * whitespace-PADDED id (e.g. `' gpt-5'`) classifies as `bareUnknown` → undefined,
 * matching the no-trim clones (which run `.startsWith('gpt-')` on the raw string
 * and so do NOT recognise the padded prefix). (`providerSwitch`'s variant has no
 * falsy guard but is only ever called with a stripped id; on `''` it returns
 * undefined too — `''` has no `/`, no `claude-`, no `gpt-`.)
 */
export function toProviderSwitchProvider(modelId: string): InferredProvider | undefined {
  switch (classifyModelIdSyntax(modelId)) {
    case 'slash':
      return 'openrouter';
    case 'claude':
      return 'anthropic';
    case 'gpt':
      return 'openai';
    case 'empty':
    case 'ollama':
    case 'oSeries':
    case 'bareUnknown':
      return undefined;
  }
}

// NOTE: `authEnvUtils.ts#inferTierFallbackProvider` is byte-identical to `providerSwitch`'s rule,
// so it consumes `toProviderSwitchProvider` directly (no separate alias export — a redundant alias
// reads as a knip duplicate-export group).

/** Alias: the `settingsUtils.ts` inline clone returns a wider enum
 *  (`'anthropic' | 'codex' | 'openai' | 'openrouter'`) but its INFERENCE arm is
 *  byte-identical (slash→openrouter, claude→anthropic, gpt→openai, else undefined;
 *  it never emits `'codex'` from the bare-id path). Typed to the wider enum so it
 *  drops into the existing `RoutedFallbackProvider` site without a cast. */
export type RoutedFallbackProvider = 'anthropic' | 'codex' | 'openai' | 'openrouter';
export function toRoutedFallbackProvider(modelId: string): RoutedFallbackProvider | undefined {
  return toProviderSwitchProvider(modelId);
}

/**
 * Reproduces `providerRouting.ts#inferActiveProviderForFallbackModel`, which
 * DELIBERATELY OMITS the `gpt-` arm (its callers never route bare `gpt-*` to
 * codex from this path):
 *   slash → openrouter, `claude-` → anthropic, else undefined (incl. `gpt-*`).
 *
 * Output enum is `ActiveProvider`, but only the `'anthropic' | 'openrouter'`
 * subset is ever produced here — typed loosely as a union of those two literals so
 * Stage 3b can widen to `ActiveProvider` at the (core-side) call site without this
 * `@core`-free module importing `ActiveProvider`.
 */
export function toActiveProviderForFallback(
  modelId: string,
): 'anthropic' | 'openrouter' | undefined {
  switch (classifyModelIdSyntax(modelId)) {
    case 'slash':
      return 'openrouter';
    case 'claude':
      return 'anthropic';
    // NOTE: NO `gpt` arm — intentional divergence from providerSwitch/authEnv.
    case 'gpt':
    case 'empty':
    case 'ollama':
    case 'oSeries':
    case 'bareUnknown':
      return undefined;
  }
}

/** Billing "model family" decision — the syntax half of
 *  `billingSource.ts#resolveBillingSourceForModel`. Provider/route-conditional
 *  flips (mindstone→subscription, OAuth→pool, codex→subscription) stay at the
 *  call site; this adapter classifies the id into the family the call site
 *  switches on. */
export type BillingModelFamily =
  | 'empty' // trimmed-empty (incl. whitespace-only) → caller returns undefined
  | 'local' // `ollama:` / `ollama/` → 'local'
  | 'slash' // slash-form → caller flips on activeProvider/OAuth
  | 'gpt' // bare `gpt-` → caller flips on codexConnected
  | 'pay-per-use'; // bare `claude-` AND any other bare → 'pay-per-use'

/**
 * Reproduces the PRE-PROCESSING ORDER of `resolveBillingSourceForModel`:
 *   trim/empty → local `ollama[:/]` → slash → bare `gpt-` → (bare `claude-` OR any
 *   other bare) → 'pay-per-use'.
 *
 * CRITICAL DIVERGENCES preserved:
 *  - `ollama` is tested BEFORE slash (so `ollama/x` → 'local', NOT 'slash'). The
 *    base classifier checks slash first, so this adapter applies the ollama test
 *    itself on the trimmed value to honour billing's order.
 *  - Slash-form `openai/gpt-*` is NEVER treated as the OpenAI/codex family — it
 *    stays `slash` (so it flips on OpenRouter/mindstone, per billing). Likewise a
 *    bare `gpt-*` is the only thing that reaches the codex-subscription flip.
 *  - bare `claude-*` and every other unknown bare id both collapse to
 *    'pay-per-use' — billing does not distinguish them.
 */
export function toBillingFamily(optionValue: string): BillingModelFamily {
  const normalizedValue = optionValue.trim();
  if (!normalizedValue) return 'empty';
  // Billing tests the local marker BEFORE slash — preserve that order here.
  if (OLLAMA_PREFIX.test(normalizedValue)) return 'local';
  if (normalizedValue.includes('/')) return 'slash';
  if (normalizedValue.startsWith('gpt-')) return 'gpt';
  // bare `claude-` and any other bare id → pay-per-use (billing collapses them).
  return 'pay-per-use';
}

/**
 * Reproduces `providerRouteDecision.ts#inferModelDialect`'s BARE-ID arms (the
 * profile-driven arms — `local`, `anthropic`, `profile-ref` — stay at the call
 * site, since they depend on `profile`/`serverUrl`, not the id syntax). Returns
 * `ProviderModelDialect` values as string literals so this `@core`-free module
 * needn't import the type; Stage 3b types the call site to `ProviderModelDialect`.
 *
 * Bare-id mapping (when `profile` is null in the caller):
 *   slash → 'openrouter-prefixed'
 *   `gpt-` OR `o<anything>` OR `openai/` → 'openai-compatible'
 *   everything else (incl. `claude-`, `ollama:`, unknown bare, EMPTY) → 'anthropic-native'
 *
 * DIVERGENCE — broad `o` rule: the original used `model.startsWith('o')`, matching
 * ANY id beginning with `o` (e.g. `o3`, `o4-mini`, but also `omni-foo`). The base
 * classifier's `oSeries` is the precise `o<digit>` family, so this adapter applies
 * the broad `startsWith('o')` itself to stay byte-identical. (`openai/...` is a
 * slash id, already 'openrouter-prefixed' by the slash arm above — but the original
 * listed `startsWith('openai/')` explicitly; with slash checked first it is
 * unreachable, and we preserve that — slash wins, so `openai/gpt-5` →
 * 'openrouter-prefixed', exactly as today.)
 */
export type DialectFromId =
  | 'anthropic-native'
  | 'openrouter-prefixed'
  | 'openai-compatible';
export function toModelDialect(model: string): DialectFromId {
  // Match the original's exact arm order on the RAW model string (no trim — the
  // original did not trim before these checks).
  if (model.includes('/')) return 'openrouter-prefixed';
  if (model.startsWith('gpt-') || model.startsWith('o') || model.startsWith('openai/')) {
    return 'openai-compatible';
  }
  return 'anthropic-native';
}
