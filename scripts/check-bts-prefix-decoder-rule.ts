#!/usr/bin/env npx tsx
/**
 * Programmatic smoke test for the S4.5 BTS raw-read lint rule.
 *
 * Asserts that:
 * 1) a synthetic bypass read is blocked in a non-exempt path
 * 2) a destructured bypass read is blocked in a non-exempt path
 * 3) a helper-based access pattern in a non-exempt path is allowed
 * 4) an exempt file path is allowlisted
 *
 * Perf (Stage A / 260619_validate-fast-parallel): instead of booting the WHOLE
 * repo ESLint config (`overrideConfigFile: eslint.config.mjs` → every plugin +
 * rule → ~2.2 GB RSS / ~5.4s) just to lint four tiny snippets, this builds a
 * MINIMAL flat config that registers ONLY the `bts-flow-shape` plugin + the one
 * `no-raw-bts-model-read` rule, with the production `files`/`ignores`/severity/
 * parser sourced from the shared SSoT (eslint-rules/bts-raw-read-config.mjs) so
 * the verdicts are byte-for-byte the production verdicts at ~1/6 the time and
 * ~1/7 the memory. The drift test (eslint-rules/__tests__/bts-raw-read-config-
 * drift.test.js) proves the production block and this minimal config share the
 * same effective surface.
 */

import { ESLint, type Linter } from 'eslint';
import { createRequire } from 'node:module';
// Namespace import: @typescript-eslint/parser is CJS with NO default export, and
// under tsx's CJS-interop a default import resolves to `undefined` (the parser
// would silently be missing → "Parsing error: Unexpected token :" on the TS
// snippets). The namespace object IS the ESLint parser (exposes parseForESLint).
import * as tsparser from '@typescript-eslint/parser';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BTS_RAW_READ_FILES,
  BTS_RAW_READ_IGNORES,
  BTS_RAW_READ_SEVERITY,
  btsRawReadLanguageOptions,
} from '../eslint-rules/bts-raw-read-config.mjs';
// Scenarios shared with the drift test (eslint-rules/__tests__/bts-raw-read-
// config-drift.test.js) so the verdict-parity proof runs the EXACT same snippets.
import {
  BTS_RAW_READ_SCENARIOS,
  type BtsRawReadScenario,
} from '../eslint-rules/__tests__/bts-raw-read-scenarios.js';

const RULE_ID = 'bts-flow-shape/no-raw-bts-model-read';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The rule is a CommonJS module (module.exports); load it the same way the
// vitest RuleTester does so the minimal flat config registers the production
// rule object verbatim.
const require = createRequire(import.meta.url);
const noRawBtsModelReadRule = require(
  resolve(repoRoot, 'eslint-rules/no-raw-bts-model-read.js'),
);

const btsFlowShapePlugin = {
  rules: {
    'no-raw-bts-model-read': noRawBtsModelReadRule,
  },
};

// Minimal flat config — IDENTICAL files/ignores/severity/parser to the
// production block (eslint.config.mjs), all sourced from the SSoT.
const minimalConfig: Linter.Config[] = [
  {
    files: [...BTS_RAW_READ_FILES],
    ignores: [...BTS_RAW_READ_IGNORES],
    languageOptions: btsRawReadLanguageOptions(tsparser),
    plugins: {
      'bts-flow-shape': btsFlowShapePlugin,
    },
    rules: {
      'bts-flow-shape/no-raw-bts-model-read': BTS_RAW_READ_SEVERITY,
    },
  },
];

type Scenario = BtsRawReadScenario;

const scenarios: readonly Scenario[] = BTS_RAW_READ_SCENARIOS;

function formatRuleMessages(messages: ReadonlyArray<Linter.LintMessage>): string {
  if (messages.length === 0) return '(none)';
  return messages
    .map((message) =>
      `${message.ruleId ?? '<unknown>'}@${message.line}:${message.column} ${message.message}`)
    .join('\n');
}

async function lintScenario(eslint: ESLint, scenario: Scenario): Promise<ReadonlyArray<Linter.LintMessage>> {
  const [result] = await eslint.lintText(scenario.code, {
    filePath: resolve(repoRoot, scenario.filePath),
  });
  return result.messages.filter((message) => message.ruleId === RULE_ID);
}

async function main(): Promise<void> {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: minimalConfig,
  });

  const failures: string[] = [];

  // Defensive guard against a silently-disabled rule: track whether ANY
  // `must_error` scenario actually produced a severity:2 message. If the rule
  // were unregistered or wired with the wrong id, every `must_error` would
  // vacuously look like it "passed" (no error reported) — so we require at least
  // one real fired error, otherwise the run FAILS rather than false-greening.
  let observedRealRuleError = false;
  const expectedErrorScenarioCount = scenarios.filter((s) => s.expected === 'must_error').length;

  for (const scenario of scenarios) {
    const ruleMessages = await lintScenario(eslint, scenario);
    const hasRuleError = ruleMessages.some((message) => message.severity === 2);
    if (hasRuleError) observedRealRuleError = true;

    if (scenario.expected === 'must_error' && !hasRuleError) {
      failures.push(
        `[FAIL] ${scenario.name}: expected ${RULE_ID} to report an error.\n${formatRuleMessages(ruleMessages)}`,
      );
      continue;
    }

    if (scenario.expected === 'must_pass' && hasRuleError) {
      failures.push(
        `[FAIL] ${scenario.name}: expected no ${RULE_ID} errors.\n${formatRuleMessages(ruleMessages)}`,
      );
    }
  }

  // Fail-closed: a config that registers no rule (or the wrong rule id) would
  // pass every `must_pass` and silently skip every `must_error`. Require that at
  // least one of the `must_error` scenarios genuinely fired.
  if (expectedErrorScenarioCount > 0 && !observedRealRuleError) {
    failures.push(
      `[FAIL] defensive guard: no ${RULE_ID} error fired across ${expectedErrorScenarioCount} must_error scenario(s) — the rule appears silently disabled or misregistered. Refusing to pass vacuously.`,
    );
  }

  if (failures.length > 0) {
    console.error('BTS prefix-decoder lint-rule self-test failed.');
    for (const failure of failures) {
      console.error(failure);
    }
    process.exit(1);
  }

  console.log('BTS prefix-decoder lint-rule self-test passed.');
}

main().catch((error) => {
  console.error('Unexpected error while checking BTS prefix-decoder lint rule:', error);
  process.exit(1);
});
