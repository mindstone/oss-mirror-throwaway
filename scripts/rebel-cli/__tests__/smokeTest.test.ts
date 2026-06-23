import { execFileSync, fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const rebelDist = path.join(projectRoot, 'scripts', 'rebel-cli', 'dist', 'rebel.js');

// Cold-start budget enforcement is gated by the env flag because shared CI
// runners (esp. the macOS x64 lane) routinely exceed 1s on the first cold
// `node` invocation under load — even though the actual cold-start regression
// signal we care about lives well below that ceiling. The nightly perf lane
// (`processStartTime-nightly.yml`) sets RUN_COLD_START_BUDGET=1 so the
// regression signal is preserved without flaking the main test lane.
const RUN_COLD_START_BUDGET = process.env.RUN_COLD_START_BUDGET === '1';

describe('standalone CLI smoke-test command', () => {
  it('starts and exits successfully', async () => {
    execFileSync('node', ['scripts/rebel-cli/build.mjs'], { cwd: projectRoot, stdio: 'pipe' });
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cli-smoke-'));
    const started = Date.now();

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = fork(rebelDist, ['smoke-test'], {
        cwd: projectRoot,
        execArgv: [],
        env: {
          ...process.env,
          REBEL_USER_DATA: userData,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    const elapsedMs = Date.now() - started;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('OK\n');
    expect(result.stderr).toMatch(/probe/i);

    if (RUN_COLD_START_BUDGET) {
      expect(elapsedMs, `cold-start exceeded 1s budget (took ${elapsedMs}ms)`).toBeLessThan(1_000);
    }
  });
});
