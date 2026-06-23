/**
 * Stage 2 + Stage 4 of docs/plans/260505_canonical_settings_accessor_and_lint_enforced_read_path.md:
 * durable lint regression fixtures for namespace bans and an allowlist ratchet
 * that keeps canonical exemptions documented + bounded.
 *
 * Shells out to ESLint over the negative fixtures in
 * `src/shared/utils/__lint_fixtures__/` and asserts each produces at least one
 * `no-restricted-properties` error. Closes the regression vector where a
 * future config edit silently disables a namespace ban shape.
 *
 * These tests are slow because they spawn the ESLint CLI; left in the default
 * unit-test path because the four fixtures are tiny and the wall-clock cost
 * is bounded.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'src', 'shared', 'utils', '__lint_fixtures__');
const ESLINT_CONFIG_PATH = path.join(REPO_ROOT, 'eslint.config.mjs');

interface EslintFileReport {
  filePath: string;
  messages: Array<{ ruleId: string | null; message: string; severity: number }>;
  errorCount: number;
}

function lintFile(absPath: string): EslintFileReport {
  let stdout = '';
  try {
    stdout = execFileSync(
      'npx',
      [
        'eslint',
        '--format',
        'json',
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

function expectNamespaceBanFires(fixturePath: string): void {
  const report = lintFile(fixturePath);
  expect(report.errorCount).toBeGreaterThan(0);
  const namespaceBanMatches = report.messages.filter(
    m => m.ruleId === 'no-restricted-properties',
  );
  expect(namespaceBanMatches.length).toBeGreaterThan(0);
}

function expectClaudeBanFires(fixturePath: string): void {
  expectNamespaceBanFires(fixturePath);
}

function expectModelsBanFires(fixturePath: string): void {
  expectNamespaceBanFires(fixturePath);
}

function extractObjectBlockByMarker(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Unable to locate marker in eslint.config.mjs: ${marker}`);
  }

  const objectStart = source.indexOf('{', markerIndex);
  if (objectStart < 0) {
    throw new Error(`Unable to locate object start for marker: ${marker}`);
  }

  let depth = 0;
  for (let idx = objectStart; idx < source.length; idx += 1) {
    const char = source[idx];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(objectStart, idx + 1);
      }
    }
  }

  throw new Error(`Unable to locate object end for marker: ${marker}`);
}

interface AllowlistEntry {
  filePath: string;
  hasReasonComment: boolean;
}

function extractAllowlistEntries(blockSource: string): AllowlistEntry[] {
  const filesMatch = blockSource.match(/files:\s*\[([\s\S]*?)\],\s*rules:/);
  if (!filesMatch) {
    throw new Error(`Unable to locate files array in block:\n${blockSource.slice(0, 500)}`);
  }

  const lines = filesMatch[1].split('\n');
  const entries: AllowlistEntry[] = [];

  lines.forEach((line, lineIndex) => {
    const pathMatch = line.match(/'([^']+)'/);
    if (!pathMatch) {
      return;
    }
    // Tightened in Stage 4 follow-up: reason must be inline OR on the
    // immediately preceding line (no "2 lines back" fallback). Otherwise a
    // 7th file added directly after an existing entry could silently inherit
    // its predecessor's reason comment without justifying itself.
    const inlineReason = /\/\/\s*reason:/i.test(line);
    const previousLineHasReason = /\/\/\s*reason:/i.test(lines[lineIndex - 1] ?? '');

    entries.push({
      filePath: pathMatch[1],
      hasReasonComment: inlineReason || previousLineHasReason,
    });
  });

  return entries;
}

describe('models-namespace ESLint rule — negative lint fixtures', () => {
  it('flags bare `settings.claude.apiKey` read', () => {
    expectClaudeBanFires(path.join(FIXTURES_DIR, 'bareClaudeRead.fixture.ts'));
  }, 30_000);

  it('flags spread `...settings.claude`', () => {
    expectClaudeBanFires(path.join(FIXTURES_DIR, 'spreadClaude.fixture.ts'));
  }, 30_000);

  it('flags alias-root `const c = settings.claude; c.model` pattern', () => {
    expectClaudeBanFires(path.join(FIXTURES_DIR, 'aliasRootClaude.fixture.ts'));
  }, 30_000);

  it('flags bare `settings.models.*` read', () => {
    expectModelsBanFires(path.join(FIXTURES_DIR, 'bareModelsRead.fixture.ts'));
  }, 30_000);
});

describe('models-namespace ESLint allowlist ratchet', () => {
  it('keeps claude/models allowlists reason-annotated and bounded', () => {
    const eslintConfigSource = fs.readFileSync(ESLINT_CONFIG_PATH, 'utf8');
    const claudeAllowlistBlock = extractObjectBlockByMarker(
      eslintConfigSource,
      "Stage 4 allowlist: canonical `.claude.*`",
    );
    const modelsAllowlistBlock = extractObjectBlockByMarker(
      eslintConfigSource,
      "Stage 4 allowlist: canonical `.models.*`",
    );

    const claudeEntries = extractAllowlistEntries(claudeAllowlistBlock);
    const modelsEntries = extractAllowlistEntries(modelsAllowlistBlock);

    expect(claudeEntries.length).toBeGreaterThan(0);
    expect(modelsEntries.length).toBeGreaterThan(0);

    claudeEntries.forEach((entry) => {
      expect(
        entry.hasReasonComment,
        `Missing // reason: comment for claude allowlist entry: ${entry.filePath}`,
      ).toBe(true);
    });
    modelsEntries.forEach((entry) => {
      expect(
        entry.hasReasonComment,
        `Missing // reason: comment for models allowlist entry: ${entry.filePath}`,
      ).toBe(true);
    });

    // Ratchet at <=8. The Stage 3 grace slot that was reserved for
    // `src/shared/data/qualityTiers.ts` is now consumed by
    // `src/shared/utils/settingsAccessorsPure.ts` (canonical settings
    // accessor work). Future allowlist growth still needs to be
    // explicit and justified per entry.
    expect(claudeEntries.length).toBeLessThanOrEqual(8);
    expect(modelsEntries.length).toBeLessThanOrEqual(8);
  });
});
