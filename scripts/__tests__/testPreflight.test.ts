import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

interface PreflightRun {
  exitCode: number;
  output: string;
  durationMs: number;
}

const fullModeLabels = [
  'Disk free',
  'Port 5173',
  'Port 9222',
  'rebel-test processes',
  'Installed app',
  'MCP dev-server state files',
  'Node on PATH',
  'Submodules',
  'Super MCP dist',
  'Rebel CLI dist',
  '.env.local',
  'Temp dir',
];

const quickModeLabels = ['Disk free', 'Node on PATH', 'Submodules', 'Super MCP dist', 'Rebel CLI dist', '.env.local'];

async function runPreflight(args: string[]): Promise<PreflightRun> {
  const startedAt = performance.now();

  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', 'scripts/test-preflight.ts', ...args], {
      cwd: process.cwd(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return {
      exitCode: 0,
      output: `${result.stdout}${result.stderr}`,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof maybeError.code === 'number' ? maybeError.code : 1,
      output: `${maybeError.stdout ?? ''}${maybeError.stderr ?? ''}`,
      durationMs: performance.now() - startedAt,
    };
  }
}

describe('scripts/test-preflight.ts', () => {
  it('reports every full-mode check label and exits cleanly or with environment failures', async () => {
    const result = await runPreflight([]);

    // The script target is <2s, but CI process startup and loader setup can be
    // slower than the script body. Keep the wrapper tolerant of cold machines.
    expect(result.durationMs).toBeLessThan(10_000);
    expect([0, 1]).toContain(result.exitCode);
    for (const label of fullModeLabels) {
      expect(result.output, `missing label ${label}`).toContain(label);
    }
  }, 15_000);

  it('reports every quick-mode check label and skips launch-class probes', async () => {
    const result = await runPreflight(['--quick']);

    // See full-mode test: this measures subprocess + loader overhead, not only the
    // preflight script body.
    expect(result.durationMs).toBeLessThan(10_000);
    expect([0, 1]).toContain(result.exitCode);
    for (const label of quickModeLabels) {
      expect(result.output, `missing label ${label}`).toContain(label);
    }
    expect(result.output).not.toContain('Port 5173');
    expect(result.output).not.toContain('Port 9222');
    expect(result.output).not.toContain('Temp dir');
  }, 15_000);
});
