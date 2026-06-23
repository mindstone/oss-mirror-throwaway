/**
 * R1 Stage 1 — phase-to-phase ESLint rule fixture verification.
 *
 * Shells out to ESLint over the three negative fixtures in
 * `src/main/services/turnPipeline/__lint_fixtures__/` and asserts each
 * produces at least one `@typescript-eslint/no-restricted-imports` error.
 *
 * Also asserts the structural `index.ts` type-only-export invariant: the
 * barrel must export only `export type ...` declarations. This closes the
 * "phase impl re-exported through index" bypass.
 *
 * These tests are slow because they spawn the ESLint CLI; tagged with the
 * `lint-fixture` filter to keep them isolated from the fast unit-test path.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'src', 'main', 'services', 'turnPipeline', '__lint_fixtures__');
const SERVICES_LINT_FIXTURES_DIR = path.join(REPO_ROOT, 'src', 'main', 'services', '__lint_fixtures__');
const TURN_POLICY_FIXTURES_DIR = path.join(REPO_ROOT, 'src', 'core', 'services', 'turnPipeline', '__lint_fixtures__');
const INDEX_TS = path.join(REPO_ROOT, 'src', 'main', 'services', 'turnPipeline', 'index.ts');
const ESLINT_CONFIG = path.join(REPO_ROOT, 'eslint.config.mjs');
const TURN_POLICY_FENCE_MESSAGE = 'TurnPolicy refactor (260526_turn_policy_unification.md): read effectivePolicy.<field> instead.';

interface EslintFileReport {
  filePath: string;
  messages: Array<{ ruleId: string | null; message: string; severity: number }>;
  errorCount: number;
}

function lintFile(absPath: string): EslintFileReport {
  // eslint --no-error-on-unmatched-pattern emits JSON regardless of error
  // count; we capture stdout even when ESLint exits non-zero.
  let stdout = '';
  try {
    stdout = execFileSync(
      'npx',
      [
        'eslint',
        '--format',
        'json',
        // Override the global `ignores` block — fixtures are deliberately
        // ignored from `npm run lint` so they don't break CI, but we want
        // ESLint to lint them for this test.
        '--no-ignore',
        absPath,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    // ESLint exits non-zero when there are errors, but JSON output still
    // arrives on stdout for `execFileSync` errors.
    const e = err as { stdout?: Buffer | string };
    stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? '');
  }
  const reports = JSON.parse(stdout) as EslintFileReport[];
  const report = reports.find(r => path.resolve(r.filePath) === path.resolve(absPath));
  if (!report) {
    throw new Error(`ESLint produced no report for ${absPath}; stdout=${stdout.slice(0, 500)}`);
  }
  return report;
}

async function lintSyntheticFile(relativePath: string, source: string) {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: ESLINT_CONFIG,
  });
  const [result] = await eslint.lintText(source, {
    filePath: path.join(REPO_ROOT, relativePath),
  });
  return result;
}

function turnPolicyFenceMessages(result: { messages: Array<{ ruleId: string | null; message: string }> }) {
  return result.messages.filter(
    message => message.ruleId === 'no-restricted-syntax' && message.message.includes(TURN_POLICY_FENCE_MESSAGE),
  );
}

function turnPolicyFenceFileMessages(report: EslintFileReport) {
  return report.messages.filter(
    message => message.ruleId === 'no-restricted-syntax' && message.message.includes(TURN_POLICY_FENCE_MESSAGE),
  );
}

describe('R1 phase-to-phase ESLint rule — negative lint fixtures', () => {
  it('flags bare-sibling import (./turnAdmission)', () => {
    const fixture = path.join(FIXTURES_DIR, 'bareSiblingImport.fixture.ts');
    const report = lintFile(fixture);
    expect(report.errorCount).toBeGreaterThan(0);
    const restrictedImportMatches = report.messages.filter(
      m => m.ruleId === '@typescript-eslint/no-restricted-imports',
    );
    expect(restrictedImportMatches.length).toBeGreaterThan(0);
  }, 30_000);

  it('flags path-alias import (@main/services/turnPipeline/turnAdmission)', () => {
    const fixture = path.join(FIXTURES_DIR, 'pathAliasImport.fixture.ts');
    const report = lintFile(fixture);
    expect(report.errorCount).toBeGreaterThan(0);
    const restrictedImportMatches = report.messages.filter(
      m => m.ruleId === '@typescript-eslint/no-restricted-imports',
    );
    expect(restrictedImportMatches.length).toBeGreaterThan(0);
  }, 30_000);

  it('flags barrel bypass (@main/services/turnPipeline)', () => {
    const fixture = path.join(FIXTURES_DIR, 'indexBypass.fixture.ts');
    const report = lintFile(fixture);
    expect(report.errorCount).toBeGreaterThan(0);
    const restrictedImportMatches = report.messages.filter(
      m => m.ruleId === '@typescript-eslint/no-restricted-imports',
    );
    expect(restrictedImportMatches.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('R1 Stage 3 cleanup-bypass ESLint rule — negative lint fixture', () => {
  it('flags all direct cleanup-state mutations outside agentTurnCleanup', () => {
    const fixture = path.join(SERVICES_LINT_FIXTURES_DIR, 'cleanupBypass.fixture.ts');
    const report = lintFile(fixture);
    const cleanupBypassMatches = report.messages.filter(
      m => m.ruleId === 'no-restricted-syntax' && m.message.includes('agentTurnCleanup'),
    );
    expect(cleanupBypassMatches).toHaveLength(5);
  }, 30_000);
});

describe('TurnPolicy Stage 5 ESLint fence — synthetic fixture coverage', () => {
  // Uses lintFile (CLI subprocess) against a real on-disk fixture rather than
  // ESLint.lintText synthetic input, because the latter was matching 0
  // messages on CI Node 20 + eslint@10 + esquery@1.7 even though it matched
  // 2 messages locally on Node 24. The lintFile path is the same one CI uses
  // for `npm run lint`, so this exercises the fence under the same parser/
  // selector engine the production rule runs through.
  it('flags sessionType === \'automation\' inside locked files', () => {
    const fixture = path.join(TURN_POLICY_FIXTURES_DIR, 'sessionTypeAutomationViolation.fixture.ts');
    const report = lintFile(fixture);
    expect(turnPolicyFenceFileMessages(report).length).toBeGreaterThan(0);
  }, 30_000);

  // Positive tests routed through lintFile (CLI subprocess) for the same
  // CI-stability reason as the sessionType test above — lintText was
  // randomly returning 0 messages on CI Node 20 even when local Node 24
  // returned the expected matches.
  it('flags const isAutomation locals inside locked files', () => {
    const fixture = path.join(TURN_POLICY_FIXTURES_DIR, 'isAutomationLocalViolation.fixture.ts');
    const report = lintFile(fixture);
    expect(turnPolicyFenceFileMessages(report).length).toBeGreaterThan(0);
  }, 30_000);

  it('flags literal includes patterns inside locked files', () => {
    const fixture = path.join(TURN_POLICY_FIXTURES_DIR, 'automationIncludesViolation.fixture.ts');
    const report = lintFile(fixture);
    expect(turnPolicyFenceFileMessages(report).length).toBeGreaterThan(0);
  }, 30_000);

  it('flags optional-chaining sessionType comparisons inside locked files', () => {
    const fixture = path.join(TURN_POLICY_FIXTURES_DIR, 'optionalChainingAutomationViolation.fixture.ts');
    const report = lintFile(fixture);
    expect(turnPolicyFenceFileMessages(report).length).toBeGreaterThan(0);
  }, 30_000);

  it('does not flag z.enum schema literals', async () => {
    const result = await lintSyntheticFile(
      'src/core/services/promptTemplateService.ts',
      `
      import { z } from 'zod';
      export const SessionTypeSchema = z.enum(['interactive', 'automation', 'cli', 'mcp_server']);
      `,
    );

    expect(turnPolicyFenceMessages(result)).toHaveLength(0);
  });

  it('does not flag isAutomationSession identifier names', async () => {
    const result = await lintSyntheticFile(
      'src/core/services/turnPipeline/agentTurnExecute.ts',
      `
      const isAutomationSession = true;
      if (isAutomationSession) {
        console.log('allowed');
      }
      `,
    );

    expect(turnPolicyFenceMessages(result)).toHaveLength(0);
  });

  it('does not flag isAutomationHardCap identifier names', async () => {
    const result = await lintSyntheticFile(
      'src/core/services/turnPipeline/agentTurnExecute.ts',
      `
      const isAutomationHardCap = true;
      if (isAutomationHardCap) {
        console.log('allowed');
      }
      `,
    );

    expect(turnPolicyFenceMessages(result)).toHaveLength(0);
  });

  it('does not flag the forbidden pattern outside locked files', async () => {
    const result = await lintSyntheticFile(
      'src/main/services/__tests__/turnPolicyFence.nonLocked.ts',
      `
      const turnOptions: { sessionType?: string } = { sessionType: 'automation' };
      if (turnOptions.sessionType === 'automation') {
        console.log('allowed-outside-locked-group');
      }
      `,
    );

    expect(turnPolicyFenceMessages(result)).toHaveLength(0);
  });
});

describe('R1 turnPipeline/index.ts — type-only export invariant', () => {
  it('exports only `export type ...` declarations (no value re-exports)', () => {
    const source = readFileSync(INDEX_TS, 'utf8');
    // Strip block comments so we don't false-positive on documentation that
    // mentions `export {` inside a /* ... */ block.
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
    // Find all top-of-line `export ...` declarations.
    const exportLines = stripped
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('export '));
    if (exportLines.length === 0) {
      throw new Error('Expected at least one `export type` declaration in index.ts');
    }
    for (const line of exportLines) {
      if (!line.startsWith('export type ') && !line.startsWith('export type{')) {
        throw new Error(
          `index.ts may only contain \`export type\` declarations; found: ${JSON.stringify(line)}. ` +
            'See `turnPipeline/index.ts` header for the rationale.',
        );
      }
    }
  });
});
