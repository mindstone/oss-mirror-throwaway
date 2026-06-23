// Single source of truth for the S4.5 `bts-flow-shape/no-raw-bts-model-read`
// production flat-config surface (files / ignores / severity / languageOptions).
//
// Consumed by:
//   - eslint.config.mjs
//       → the production `no-raw-bts-model-read` flat-config block spreads these
//         constants instead of inlining them.
//   - scripts/check-bts-prefix-decoder-rule.ts
//       → builds a MINIMAL flat config (only the bts-flow-shape plugin + this one
//         rule) that registers the IDENTICAL files/ignores/severity/parser, so the
//         self-test boots in ~1s / ~300 MB instead of loading the whole repo config
//         (~5.4s / ~2.2 GB) while preserving every scenario verdict exactly.
//   - eslint-rules/__tests__/bts-raw-read-config-drift.test.js
//       → asserts the production block's EFFECTIVE surface (introspected from the
//         resolved eslint.config.mjs array) equals this SSOT, and snapshots the
//         exact ignore allowlist so any change forces intentional review.
//
// Why a single source of truth: the self-test must lint with the EXACT
// files/ignores/severity/parser the production config applies — otherwise a
// "passing" self-test can drift from what ESLint really enforces (a narrowed
// exemption the 4 broad scenarios wouldn't catch, or a parser mismatch that
// changes how the TypeScript snippets parse). Keeping the literals here (not
// copied into the self-test) means altering production's surface without
// updating both consumers breaks the drift test by construction.
//
// Why plain `.mjs` (with a co-located `.d.mts`): eslint.config.mjs is loaded by
// the `eslint` binary as plain Node ESM (no TS loader), so it cannot import a
// `.ts` at config-load time. A `.ts` consumer (the self-test) statically
// importing a `.mjs` would also fail `tsc -p tsconfig.node.json` (TS7016, no
// declaration; allowJs off). The `.mjs` + `.d.mts` pair satisfies both — same
// pattern as eslint-rules/routing-state-writer-selectors.mjs and
// scripts/silentSwallowSurfaceCoverage.mjs.
//
// IMPORTANT — keep this module side-effect-free and import-cheap: NO ESLint
// engine, NO plugin imports, NO `@typescript-eslint/parser` import at module
// load. The parser is referenced by NAME below; each consumer resolves the
// actual parser object itself (eslint.config.mjs already imports `tsparser`;
// the self-test imports it once). Importing this module must NOT re-incur the
// whole-config cost the self-test is trying to avoid.

// The private-Mindstone source globs. Owned here so the production BTS block and
// the self-test share ONE source for the `files` set (these are spread into the
// production `files` glob). Other eslint.config.mjs blocks import this same
// binding, so there is exactly one definition repo-wide.
export const privateMindstoneSourceGlobs = [
  'private/mindstone/src/**/*.ts',
  'private/mindstone/src/**/*.tsx',
];

// Production `files` globs for the S4.5 BTS raw-read block.
export const BTS_RAW_READ_FILES = [
  'src/**/*.ts',
  'src/**/*.tsx',
  ...privateMindstoneSourceGlobs,
  'evals/**/*.ts',
  'evals/**/*.tsx',
];

// Production `ignores` allowlist for the S4.5 BTS raw-read block.
//
// Audit completed 2026-05-18 (260518 S6): added evals/shared/btsEvalModelResolver.ts
// as a decoded site, removed stale exemptions for ModelChoicePicker.tsx and
// behindTheScenesClient.ts, and confirmed all remaining entries still reference
// these BTS settings fields.
//
// Any change here forces review via the exact-allowlist snapshot test
// (eslint-rules/__tests__/bts-raw-read-config-drift.test.js).
export const BTS_RAW_READ_IGNORES = [
  // Decoded sites (codec-respecting reads are intentional).
  'src/core/rebelCore/modelRoleResolver.ts',
  'src/core/rebelCore/agentTool.ts',
  'src/core/services/dailySparkService.ts',
  'src/core/services/heroChoiceService.ts',
  'src/main/services/enhancementService.ts',
  'src/shared/utils/btsModelResolver.ts',
  'src/shared/utils/modelChoiceCodec.ts',
  'src/shared/utils/providerSwitch.ts',
  'src/shared/utils/settingsUtils.ts',
  'evals/shared/btsEvalModelResolver.ts',
  'evals/view-tool-selection.ts',
  'evals/eval-proxy-lifecycle.ts',
  // Exempt-display/maintenance sites.
  'src/main/services/authService.ts',
  'private/mindstone/src/services/authService.ts',
  'src/shared/utils/codexDefaults.ts',
  'src/shared/utils/cleanupOrphanedProfileReferences.ts',
  'src/core/services/safety/btsSafetyEvalService.ts',
  'src/main/services/agentTurnExecutor.ts',
  'src/renderer/features/settings/components/tabs/AgentsTab.tsx',
  'evals/knowledge-work-bootstrap.ts',
  // Tests are exempt by design.
  '**/__tests__/**',
  '**/*.test.ts',
  '**/*.test.tsx',
];

// Production severity for the rule.
export const BTS_RAW_READ_SEVERITY = 'error';

// Production `languageOptions.parserOptions`. The parser itself is referenced by
// name (`BTS_RAW_READ_PARSER_NAME`) so this module stays import-cheap; each
// consumer wires the resolved `@typescript-eslint/parser` object via
// `btsRawReadLanguageOptions(tsparser)`. The synthetic self-test snippets are
// TypeScript, so the minimal config MUST pin this same parser + parserOptions or
// it parses differently / hard-fails (GPT-F1).
export const BTS_RAW_READ_PARSER_NAME = '@typescript-eslint/parser';

export const BTS_RAW_READ_PARSER_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  ecmaFeatures: {
    jsx: true,
  },
};

// Build the `languageOptions` object from a resolved parser. Kept as a factory
// (rather than a frozen literal) so this module never imports the parser itself.
export function btsRawReadLanguageOptions(parser) {
  return {
    parser,
    parserOptions: BTS_RAW_READ_PARSER_OPTIONS,
  };
}
