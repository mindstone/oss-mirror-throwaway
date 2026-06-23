// Single source of truth for the WS0 stage-6 "duplicate provider/dialect
// inference" guard (scripts/check-model-id-inference-clone.ts).
//
// Consumed by:
//   - scripts/check-model-id-inference-clone.ts  (the production guard)
//   - scripts/__tests__/check-model-id-inference-clone.test.ts  (its self-test)
//
// Why an SSOT module: the self-test asserts the guard FIRES on a re-introduced
// clone and PASSES on every allowlisted site. If the allowlist literals were
// copied into the test, an allowlist edit could silently diverge from what the
// guard actually enforces. Keeping them here means the test imports the exact
// same set the guard scans against.
//
// Plain `.mjs` with a co-located `.d.mts` (the `.ts` consumers are type-checked
// by tsc with allowJs off, so they need declarations — same pattern as
// eslint-rules/bts-raw-read-config.{mjs,d.mts}).

// The "clone signature": a function that INFERS a provider/dialect FROM a bare
// model id by chaining the per-family prefix arms. Historically these clones all
// keyed on BOTH `claude-` and `gpt-` (mapping each to a different provider). The
// co-occurrence of both bare-prefix sniffs in one source file is the high-signal
// marker — legitimate non-clone code keys on at most one of them (a claude-only
// gate, or a slash-form boolean), never chains claude+gpt to derive a provider.
//
// We scan for the RAW sniff idioms (single- or double-quoted) rather than an AST
// shape: the clone is a multi-statement chain that an AST node-visitor matches
// poorly without false positives, whereas the co-occurrence of these two exact
// literals is precise (proven zero false positives on the post-WS0 tree).
export const CLAUDE_PREFIX_SNIFF_RE = /\.startsWith\(\s*['"]claude-['"]\s*\)/;
export const GPT_PREFIX_SNIFF_RE = /\.startsWith\(\s*['"]gpt-['"]\s*\)/;

// Source roots scanned (TS/TSX). Tests are excluded by the guard itself.
export const SCAN_GLOBS = ['src', 'evals'];

// The legitimate KEEP / LEFT sites that co-occur both prefix sniffs and must NOT
// trip the guard. Suffix-matched (posix-normalized) so it is worktree/CWD-agnostic.
//
// MINIMAL BY CONSTRUCTION — only files that TODAY genuinely co-occur BOTH the
// `claude-` AND `gpt-` bare-prefix sniffs. This is deliberately the smallest set:
// the guard skips an allowlisted file ENTIRELY, so every entry is a hole where a
// NEW clone could hide. Most WS0 LEFT sites are SINGLE-arm (claude-only gates,
// slash-form booleans, gpt-only voice sniffs) — a two-arm check already ignores
// them, so they are NOT (and must NOT be) allowlisted: a future clone added to
// providerRouting.ts / agentTurnExecute.ts / councilService.ts / etc. will now be
// CAUGHT, because those files carry no two-arm signature today.
//
// To re-derive after a refactor: list every non-test src file with both sniffs
//   (rg -l "startsWith\('claude-'\)" src | xargs rg -l "startsWith\('gpt-'\)")
// and confirm each newly-appearing file is a legitimate multi-arm classifier
// (route it through modelIdClassifier instead) before adding it here.
//
// The three legitimate two-arm co-occurrences (audited 2026-06-20):
export const MODEL_ID_CLONE_ALLOWLIST = [
  // OWNS the inference — the centralized raw-syntax classifier + its adapters.
  // This is the ONE place chained claude+gpt classification is supposed to live.
  'src/shared/utils/modelIdClassifier.ts',
  // `canUsePrimaryProvider` is a `switch (to)` keyed on the TARGET ActiveProvider
  // (anthropic→claude- arm, codex→gpt- arm), NOT an id→provider inference. The two
  // arms sit in different switch cases over a different discriminant, so the file
  // co-occurs both literals without being a clone. Provider inference itself was
  // already migrated to toProviderSwitchProvider() in stage 3b.
  'src/shared/utils/providerSwitch.ts',
  // The two sniffs sit in UNRELATED functions: a gpt-/whisper- OpenAI voice/STT
  // sniff (`isOpenAIModel`, not model routing — WS0 stage 5 explicitly left it)
  // and several separate claude-only thinking-model gates. No single function
  // chains claude+gpt to derive a provider/dialect.
  'src/shared/utils/settingsUtils.ts',
];

export function normalizePathPosix(filename) {
  return (filename ?? '').replace(/\\/g, '/');
}

export function isAllowlisted(filename) {
  const normalized = normalizePathPosix(filename);
  return MODEL_ID_CLONE_ALLOWLIST.some((allowed) => normalized.endsWith(allowed));
}

export function isTestFile(filename) {
  const normalized = normalizePathPosix(filename);
  return (
    normalized.includes('/__tests__/') ||
    /\.test\.tsx?$/.test(normalized) ||
    /\.spec\.tsx?$/.test(normalized)
  );
}

/** The clone signature: a single source co-occurs BOTH bare-prefix sniffs. */
export function hasCloneSignature(source) {
  return CLAUDE_PREFIX_SNIFF_RE.test(source) && GPT_PREFIX_SNIFF_RE.test(source);
}
