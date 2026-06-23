/**
 * Tests for the catalog-driven pass of scripts/check-bridge-state-readers.ts
 * (260613, rec 4fc05fd4f5e916d4). The script runs as a CLI (calls main() +
 * process.exit), so these tests exercise it as a subprocess and assert the
 * observable contract:
 *   - it passes on the live tree (IBKR is the only needsBridgeState entry, and
 *     its source reads no bridge key, matching the table);
 *   - it reports the catalog-entry count;
 *   - the existing writer⊇reader + rebel-* split passes still run.
 *
 * Negative-path behaviour (fail-closed on an unmapped needsBridgeState entry,
 * and the readsBridgeState:false→reads-a-key flip) is verified by code review
 * + the manual negative run recorded in the plan; encoding a mutation here
 * would require rewriting bundledMcpManager.ts, which is out of scope for a
 * static-check test.
 *
 * @see docs-private/postmortems/260506_mcp_bridge_state_env_var_rename_incomplete_postmortem.md
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'check-bridge-state-readers.ts');

function runCheck(): { status: number; output: string } {
  try {
    const output = execFileSync('npx', ['tsx', scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('check-bridge-state-readers catalog-driven pass', () => {
  it('passes on the live tree and reports the needsBridgeState catalog count', () => {
    const { status, output } = runCheck();
    expect(status, output).toBe(0);
    expect(output).toMatch(/needsBridgeState catalog entries verified: \d+/);
    // IBKR is the sole needsBridgeState: true catalog entry today.
    expect(output).toMatch(/needsBridgeState catalog entries verified: 1/);
  });

  it('still runs the rebel-* split-MCP pass', () => {
    const { output } = runCheck();
    expect(output).toMatch(/Rebel-\* split MCPs verified: 9/);
  });
});
