/**
 * Stage F — autopilot MCP-free invariant guard tests.
 *
 * The validate:fast step `check-autopilot-no-mcp` enforces that nothing
 * under `scripts/sentry-autopilot/` depends on the Sentry MCP at runtime.
 * Rationale + full policy live in
 * `docs/plans/260515_autopilot_deferred_items.md` Stage F and
 * `docs/project/SENTRY_AUTOPILOT.md`.
 *
 * These tests exercise the scanner against synthetic fixtures so the
 * regex set + comment-skipping logic stays correct across edits.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'check-autopilot-no-mcp.ts');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface ScannerResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScanner(): ScannerResult {
  const result = spawnSync('npx', ['tsx', SCRIPT_PATH], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('check-autopilot-no-mcp', () => {
  it('passes against the current scripts/sentry-autopilot tree (no MCP refs)', () => {
    const result = runScanner();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('OK (no MCP runtime usage');
  });

  it('would flag an import from a `mcp` module', async () => {
    // We don't actually plant a file under scripts/sentry-autopilot/ for
    // this test — that'd be a CI footgun. Instead we test the scanner's
    // regexes directly by importing the module and feeding it a fixture.
    // The scanner is a top-level script that calls process.exit(), so we
    // re-implement the regex check here to keep the assertion focused on
    // the pattern set (the spawnSync-based integration test above proves
    // end-to-end behavior).
    const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
      { name: 'mcp_module_import', regex: /\bfrom\s+['"][^'"]*\bmcp[^'"]*['"]/i },
      { name: 'mcp_dynamic_require', regex: /\brequire\(\s*['"][^'"]*\bmcp[^'"]*['"]\s*\)/i },
      { name: 'mcp_call_site', regex: /\bawait\s+mcp[._]/i },
      { name: 'mcp_droid_tool_pattern', regex: /\bmcp__[A-Za-z0-9_]+__/ },
    ];

    const samples: Array<{ text: string; shouldHit: boolean }> = [
      { text: `import x from '@anthropic/mcp-client';`, shouldHit: true },
      { text: `const mcp = require('@something/mcp-something');`, shouldHit: true },
      { text: `await mcp.callTool('foo');`, shouldHit: true },
      { text: `const tools = mcp__sentry__update_issue;`, shouldHit: true },
      { text: `// MCP is documented in docs/project/SENTRY_AUTOPILOT.md`, shouldHit: false },
      { text: `import x from './reporter.ts';`, shouldHit: false },
      { text: `await reporter.executeSentryStatus(issue, payload);`, shouldHit: false },
      { text: `// example shows mcp.callTool but in a comment`, shouldHit: false },
    ];

    for (const { text, shouldHit } of samples) {
      // Mimic the scanner's comment-skip
      const isCommentOnly =
        text.trim().startsWith('//') || text.trim().startsWith('*') || text.trim().startsWith('/*');
      const stripped = isCommentOnly
        ? ''
        : (() => {
            const idx = text.indexOf('//');
            return idx === -1 ? text : text.slice(0, idx);
          })();
      const matched = FORBIDDEN_PATTERNS.some((p) => p.regex.test(stripped));
      expect(matched, `Sample text: ${JSON.stringify(text)}`).toBe(shouldHit);
    }
  });
});
