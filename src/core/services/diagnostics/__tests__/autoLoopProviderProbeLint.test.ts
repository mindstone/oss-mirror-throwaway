import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'src', 'core', 'services', 'diagnostics', '__lint_fixtures__');

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
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? '');
    if (!stdout) {
      console.error('ESLint execution failed without stdout:', e.message, e.stderr?.toString('utf8'));
    }
  }
  const reports = JSON.parse(stdout) as EslintFileReport[];
  const report = reports.find(r => path.resolve(r.filePath) === path.resolve(absPath));
  if (!report) {
    throw new Error(`ESLint produced no report for ${absPath}; stdout=${stdout.slice(0, 500)}`);
  }
  return report;
}

describe('no-auto-loop-provider-probe ESLint rule', () => {
  it('flags setInterval and setTimeout wrapping probeProviderReachability', () => {
    const report = lintFile(path.join(FIXTURES_DIR, 'autoLoop.fixture.ts'));
    expect(report.errorCount).toBeGreaterThan(0);
    const matches = report.messages.filter(
      m => m.ruleId === 'diagnostics/no-auto-loop-provider-probe',
    );
    expect(matches.length).toBe(2);
  }, 30_000);
});
