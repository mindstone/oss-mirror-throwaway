// Drift + snapshot + verdict-parity guard for the S4.5
// `bts-flow-shape/no-raw-bts-model-read` production flat-config surface.
//
// Two consumers share one SSoT (eslint-rules/bts-raw-read-config.mjs): the
// production block in eslint.config.mjs, and the standalone self-test
// (scripts/check-bts-prefix-decoder-rule.ts) that lints four snippets with a
// MINIMAL config so it boots in ~1s / ~300 MB instead of ~5.4s / ~2.2 GB.
//
// The self-test only preserves the production verdicts if its config has the
// IDENTICAL files/ignores/severity/parser. This file enforces that three ways:
//   1. (F1) REFERENCE identity — the production block must reference the SSoT
//      objects BY REFERENCE (`===`), not a value-equal copy. A value-only check
//      would pass even if eslint.config.mjs reverted to an inline list with the
//      same values, defeating "cannot drift by construction". (Parser parity
//      stays structural — module wrappers are not identity-stable across
//      runners.)
//   2. (F2) VERDICT parity — run the EXACT shared scenarios through BOTH the full
//      production config (via eslint.config.mjs) AND the minimal self-test config
//      and assert per-scenario RULE_ID verdicts match. Turns "surfaces match"
//      into "verdicts match". This test pays the full-config boot cost, but it is
//      a vitest test (runs only in full test / `vitest related` when these files
//      change) — NOT the hot validate:fast guard path.
//   3. (F5) exact-allowlist snapshot over BTS_RAW_READ_IGNORES / BTS_RAW_READ_FILES
//      so any change to the exempt/files set forces intentional review.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// Namespace import: @typescript-eslint/parser is CJS with no default export;
// under Vite/esbuild transform a default import can resolve to `undefined`. The
// namespace object is the parser eslint.config.mjs resolves to.
import * as tsparser from '@typescript-eslint/parser';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BTS_RAW_READ_FILES,
  BTS_RAW_READ_IGNORES,
  BTS_RAW_READ_SEVERITY,
  BTS_RAW_READ_PARSER_OPTIONS,
  btsRawReadLanguageOptions,
} from '../bts-raw-read-config.mjs';
import { BTS_RAW_READ_SCENARIOS } from './bts-raw-read-scenarios.js';

const RULE_ID = 'bts-flow-shape/no-raw-bts-model-read';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslintConfigPath = resolve(repoRoot, 'eslint.config.mjs');

const require = createRequire(import.meta.url);
const noRawBtsModelReadRule = require(
  resolve(repoRoot, 'eslint-rules/no-raw-bts-model-read.js'),
);

/** @type {Record<string, any>} */
let productionBlock;

beforeAll(async () => {
  const mod = await import(eslintConfigPath);
  const config = mod.default;
  if (!Array.isArray(config)) {
    throw new Error('eslint.config.mjs default export is not an array');
  }
  const matching = config.filter(
    (block) =>
      block &&
      block.rules &&
      Object.prototype.hasOwnProperty.call(block.rules, RULE_ID),
  );
  // Exactly one block must wire this rule — otherwise the "effective surface"
  // for the self-test is ambiguous (two blocks could disagree on files/ignores).
  expect(matching).toHaveLength(1);
  productionBlock = matching[0];
});

describe('bts-raw-read-config SSoT ↔ production block reference identity (GPT-F1)', () => {
  it('production block files is the SSoT array by reference (===)', () => {
    // By-construction guarantee: reverting to an inline list (even value-equal)
    // breaks this `===` and fails the test. eslint.config.mjs must reference the
    // SSoT array directly (no spread copy).
    expect(productionBlock.files).toBe(BTS_RAW_READ_FILES);
  });

  it('production block ignores is the SSoT array by reference (===)', () => {
    expect(productionBlock.ignores).toBe(BTS_RAW_READ_IGNORES);
  });

  it('production block parserOptions is the SSoT object by reference (===)', () => {
    expect(productionBlock.languageOptions?.parserOptions).toBe(
      BTS_RAW_READ_PARSER_OPTIONS,
    );
  });

  it('production block severity equals the SSoT severity', () => {
    expect(productionBlock.rules[RULE_ID]).toEqual(BTS_RAW_READ_SEVERITY);
  });

  it('production block registers the real rule under the bts-flow-shape plugin', () => {
    const ruleModule = productionBlock.plugins?.['bts-flow-shape']?.rules?.[
      'no-raw-bts-model-read'
    ];
    expect(ruleModule).toBeTruthy();
    expect(typeof ruleModule.create).toBe('function');
  });

  it('production block parser is a usable @typescript-eslint/parser (structural + parse-smoke)', () => {
    const prodParser = productionBlock.languageOptions?.parser;
    // Usable ESLint parser (exposes parseForESLint) — a missing/wrong parser
    // would make the TS snippets parse differently or hard-fail.
    expect(typeof prodParser?.parseForESLint).toBe('function');
    // Structural identity (NOT `===`): under vitest's module isolation the config
    // file and this test resolve `@typescript-eslint/parser` to distinct module
    // wrappers that are deep-equal but not identical, so `toBe` is too brittle.
    const ssotParser = btsRawReadLanguageOptions(tsparser).parser;
    expect(typeof ssotParser?.parseForESLint).toBe('function');
    expect(prodParser?.meta?.name).toBe('typescript-eslint/parser');
    expect(prodParser?.meta?.name).toBe(ssotParser?.meta?.name);

    // F3 parse-smoke: the resolved production parser must actually parse a TS
    // type-annotation snippet without error — catches an accidental parser
    // weakening (e.g. a parser that drops TS syntax) beyond just meta.name.
    let parsed;
    expect(() => {
      parsed = prodParser.parseForESLint(
        'export const x: { behindTheScenesModel?: string } = {};',
        { ...BTS_RAW_READ_PARSER_OPTIONS },
      );
    }).not.toThrow();
    expect(parsed?.ast?.type).toBe('Program');
  });
});

describe('bts-raw-read-config verdict parity: production config ↔ minimal self-test config (GPT-F2)', () => {
  /** @type {ESLint} */
  let fullEslint;
  /** @type {ESLint} */
  let minimalEslint;

  beforeAll(() => {
    // Full production config (pays the boot cost — acceptable for a vitest test).
    fullEslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: eslintConfigPath,
    });

    // Minimal config — IDENTICAL shape to scripts/check-bts-prefix-decoder-rule.ts.
    const btsFlowShapePlugin = {
      rules: { 'no-raw-bts-model-read': noRawBtsModelReadRule },
    };
    minimalEslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: [...BTS_RAW_READ_FILES],
          ignores: [...BTS_RAW_READ_IGNORES],
          languageOptions: btsRawReadLanguageOptions(tsparser),
          plugins: { 'bts-flow-shape': btsFlowShapePlugin },
          rules: { [RULE_ID]: BTS_RAW_READ_SEVERITY },
        },
      ],
    });
  });

  /**
   * @param {ESLint} eslint
   * @param {{ filePath: string, code: string }} scenario
   * @returns {Promise<boolean>} whether the rule reported a severity:2 error
   */
  async function ruleErrors(eslint, scenario) {
    const [result] = await eslint.lintText(scenario.code, {
      filePath: resolve(repoRoot, scenario.filePath),
    });
    return result.messages.some(
      (m) => m.ruleId === RULE_ID && m.severity === 2,
    );
  }

  it('shares the exact self-test scenarios (non-empty, mix of error/pass)', () => {
    expect(BTS_RAW_READ_SCENARIOS.length).toBeGreaterThan(0);
    expect(
      BTS_RAW_READ_SCENARIOS.some((s) => s.expected === 'must_error'),
    ).toBe(true);
    expect(
      BTS_RAW_READ_SCENARIOS.some((s) => s.expected === 'must_pass'),
    ).toBe(true);
  });

  it.each(BTS_RAW_READ_SCENARIOS)(
    'scenario "$name": minimal-config verdict == production-config verdict (and matches expectation)',
    async (scenario) => {
      const fullHasError = await ruleErrors(fullEslint, scenario);
      const minimalHasError = await ruleErrors(minimalEslint, scenario);
      // Core invariant: the minimal config the hot self-test uses produces the
      // SAME verdict as the full production config.
      expect(minimalHasError).toBe(fullHasError);
      // And both agree with the declared expectation.
      expect(fullHasError).toBe(scenario.expected === 'must_error');
    },
  );
});

describe('bts-raw-read-config exact-allowlist snapshot (GPT-F5)', () => {
  it('BTS_RAW_READ_IGNORES is the pinned exempt set (any change forces review)', () => {
    // Pinned literal — NOT derived from the SSoT (a derived snapshot would
    // silently track edits). Update this list ONLY with a deliberate review of
    // the allowlist change (and the corresponding 260518-S6-style audit note in
    // the SSoT). The reference-identity tests above separately prove production
    // uses this exact array.
    expect([...BTS_RAW_READ_IGNORES]).toEqual([
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
    ]);
  });

  it('BTS_RAW_READ_FILES is the pinned files set (incl. private-mindstone globs)', () => {
    expect([...BTS_RAW_READ_FILES]).toEqual([
      'src/**/*.ts',
      'src/**/*.tsx',
      'private/mindstone/src/**/*.ts',
      'private/mindstone/src/**/*.tsx',
      'evals/**/*.ts',
      'evals/**/*.tsx',
    ]);
  });
});
