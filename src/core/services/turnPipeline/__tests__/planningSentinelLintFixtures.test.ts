/**
 * Stage 5 of 260604_routing-ssot-divergence: durable lint regression fixtures
 * for the planning-sentinel-as-mode-trigger guard (PM
 * 260603_plan_mode_synthetic_claude_planning_sentinel_creds, REBEL-655 rec #3).
 *
 * Shells out to ESLint over the fixtures in
 * `src/core/services/turnPipeline/__lint_fixtures__/planningSentinel/` (a path
 * the block-1838 `no-restricted-syntax` rule covers via its `__lint_fixtures__/**`
 * entry, so the production `planningSentinelGuardSelectors` rule runs verbatim —
 * no `--rule` injection). Asserts:
 *   - the two negative fixtures (sentinel passed INTO a model-resolution call)
 *     each produce a planning-sentinel `no-restricted-syntax` error;
 *   - the sanctioned-fallback fixture (sentinel as a fallback VALUE) produces
 *     ZERO planning-sentinel errors.
 *
 * This closes the regression vector where a future eslint.config.mjs edit
 * silently disables the ban or its sanctioned-fallback carve-out.
 *
 * These tests are slow (spawn the ESLint CLI). The bounded fixture count keeps
 * the wall-clock cost acceptable.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  'src',
  'core',
  'services',
  'turnPipeline',
  '__lint_fixtures__',
  'planningSentinel',
);

const SENTINEL_MESSAGE_NEEDLE = 'PREFERRED_PLANNING_MODEL into a model-resolution call';

interface EslintFileReport {
  filePath: string;
  messages: Array<{ ruleId: string | null; message: string; severity: number }>;
  errorCount: number;
}

function lintFixture(absPath: string): EslintFileReport {
  let stdout = '';
  try {
    stdout = execFileSync(
      'npx',
      [
        'eslint',
        '--format',
        'json',
        // Fixtures live in a globally-ignored directory; --no-ignore lets ESLint
        // lint them under the real config (block 1838 re-applies the rule there).
        '--no-ignore',
        absPath,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
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

function planningSentinelErrors(report: EslintFileReport) {
  return report.messages.filter(
    m => m.ruleId === 'no-restricted-syntax' && m.message.includes(SENTINEL_MESSAGE_NEEDLE),
  );
}

describe('planning-sentinel ESLint guard — lint fixtures', () => {
  it('flags PREFERRED_PLANNING_MODEL passed into resolveModelConfig (the killed substitution)', () => {
    const report = lintFixture(path.join(FIXTURES_DIR, 'resolveModelConfigViolation.fixture.ts'));
    expect(planningSentinelErrors(report).length).toBeGreaterThan(0);
  }, 30_000);

  it('flags PREFERRED_PLANNING_MODEL passed into planModeTargetFromThinkingModel', () => {
    const report = lintFixture(path.join(FIXTURES_DIR, 'planModeTargetViolation.fixture.ts'));
    expect(planningSentinelErrors(report).length).toBeGreaterThan(0);
  }, 30_000);

  it('does NOT flag the sanctioned fallback-value uses (decode/log/seed/compare)', () => {
    const report = lintFixture(path.join(FIXTURES_DIR, 'sanctionedFallback.fixture.ts'));
    expect(planningSentinelErrors(report)).toEqual([]);
  }, 30_000);
});
