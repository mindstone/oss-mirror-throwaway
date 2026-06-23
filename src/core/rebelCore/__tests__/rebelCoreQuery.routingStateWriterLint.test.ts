/**
 * Regression tests for the PM 260601 routing-state no-restricted-syntax guard.
 *
 * The executable seam is `createTaskRoutingMetadataWriter`; this guard keeps the
 * `taskRoutingMetadata` sole-writer chokepoint and the piecemeal activeExecution*
 * mutables from quietly regressing.
 *
 * Three layers of coverage, all deterministic and fast (260612):
 *  1. The selectors actually fire on synthetic offending snippets — linted with
 *     a minimal NON-type-aware flat config (parser only, no `parserOptions.project`).
 *     This deliberately bypasses the production `eslint.config.mjs`, whose
 *     `src/core/**` type-aware block (`parserOptions.project='./tsconfig.node.json'`)
 *     made a cold `lintText()` build the full ~398kLOC TS program — the source of
 *     the CI flake (it intermittently returned zero messages under parallel load).
 *     The selectors are pure-AST, so a non-type-aware lint catches the exact same
 *     writes the production type-aware lint does.
 *  2. The production config still WIRES those selectors onto rebelCoreQuery.ts —
 *     asserted via `ESLint.calculateConfigForFile()`, which only resolves config
 *     (no TS program build), so it stays fast/deterministic. This closes the gap
 *     where someone keeps the exported selectors but unwires them from the file
 *     block.
 *  3. The direct-write allowlist stays scoped to the sole writer chokepoint
 *     (static readFileSync + regex on rebelCoreQuery.ts).
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import path from 'node:path';
import { readFileSync } from 'node:fs';
// SSOT: the exact selectors the production eslint.config.mjs spreads onto
// rebelCoreQuery.ts. Importing them (rather than copying) means removing or
// altering a production selector breaks this test by construction.
import { routingStateWriterGuardSelectors } from '../../../../eslint-rules/routing-state-writer-selectors.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REBEL_CORE_QUERY_PATH = path.join(REPO_ROOT, 'src', 'core', 'rebelCore', 'rebelCoreQuery.ts');

/**
 * Lint a synthetic snippet with a minimal NON-type-aware flat config containing
 * ONLY the routing-state-writer selectors. No `parserOptions.project`, so no TS
 * program is built — fast (~10ms) and deterministic.
 */
async function lintWithRoutingSelectors(code: string) {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tsparser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        rules: {
          'no-restricted-syntax': ['error', ...routingStateWriterGuardSelectors],
        },
      },
    ],
    ignore: false,
  });
  // filePath drives parser selection only; the snippet is virtual.
  const [result] = await eslint.lintText(code, { filePath: REBEL_CORE_QUERY_PATH });
  return result?.messages ?? [];
}

describe('rebelCoreQuery routing-state writer ESLint guard', () => {
  it('flags a synthetic direct taskRoutingMetadata write', async () => {
    const messages = await lintWithRoutingSelectors(`
      const taskRoutingMetadata = {};
      function bad(taskId, model) {
        taskRoutingMetadata[taskId] = { model };
      }
    `);

    expect(messages.some((message) =>
      message.ruleId === 'no-restricted-syntax'
      && message.message.includes('taskRoutingMetadata badge writes are guarded'),
    )).toBe(true);
  });

  it('flags synthetic piecemeal activeExecution mutables', async () => {
    const messages = await lintWithRoutingSelectors(`
      let activeExecutionModel = 'claude-sonnet-4-20250514';
      activeExecutionModel = 'claude-opus-4-20250514';
    `);

    const routingStateErrors = messages.filter((message) =>
      message.ruleId === 'no-restricted-syntax'
      && message.message.includes('activeExecution* execution-state mutables'),
    );
    expect(routingStateErrors.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the production config wired to apply the routing selectors to rebelCoreQuery.ts', async () => {
    // calculateConfigForFile resolves the production eslint.config.mjs WITHOUT
    // building the TS program, so it is fast and deterministic. This proves the
    // selectors are still attached to the rebelCoreQuery.ts file block — not just
    // that they exist in the SSOT module.
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.mjs'),
    });
    const config = await eslint.calculateConfigForFile(REBEL_CORE_QUERY_PATH);

    const restrictedSyntax = config.rules?.['no-restricted-syntax'];
    expect(Array.isArray(restrictedSyntax)).toBe(true);
    // options shape: ['error', selector1, selector2, ...]
    const [, ...resolvedSelectors] = restrictedSyntax as [unknown, ...{ selector?: string }[]];
    const resolvedSelectorStrings = resolvedSelectors
      .map((entry) => (entry && typeof entry === 'object' ? entry.selector : undefined))
      .filter((s): s is string => typeof s === 'string');

    for (const { selector } of routingStateWriterGuardSelectors) {
      expect(resolvedSelectorStrings).toContain(selector);
    }
  });

  it('keeps the taskRoutingMetadata direct-write allowlist to the sole writer chokepoint', () => {
    const source = readFileSync(REBEL_CORE_QUERY_PATH, 'utf8');
    const matches = source.match(/routing-state-writer-justified/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(source).toContain('taskRoutingMetadata sole-writer assignment chokepoint');
  });
});
