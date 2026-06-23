/**
 * validate:fast guard — Sentry autopilot is MCP-free.
 *
 * Enforces the Stage F invariant in
 * `docs/plans/260515_autopilot_deferred_items.md`:
 *
 *   Autopilot orchestration uses Sentry REST API only. The poller,
 *   dispatcher, session-manager, reporter, and any other code path inside
 *   `scripts/sentry-autopilot/` MUST NOT depend on the Sentry MCP server.
 *
 * Rationale: Sentry MCP disconnects in Droid are a known operational
 * hazard. The autopilot cron loop must keep running through them. The
 * Sentry MCP is only available to the CHIEF_BUGFIXER agent during its
 * investigation phase (see Stage G in the plan).
 *
 * What this script does:
 *   Scans every `.ts` / `.js` file under `scripts/sentry-autopilot/` for
 *   patterns that indicate MCP usage:
 *     - imports from a `*mcp*` module
 *     - `await mcp.<anything>(...)` call sites
 *     - `mcp__sentry__*` Droid-tool-call patterns
 *   Doc/comment references to "MCP" are allowed (the invariant itself is
 *   documented in this codebase).
 *
 * Failure mode: prints offending file paths + line numbers to stderr and
 * exits 1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIR = path.join(ROOT, 'scripts', 'sentry-autopilot');

interface Hit {
  file: string;
  line: number;
  text: string;
  pattern: string;
}

/**
 * Patterns that indicate a runtime MCP dependency. Tested against
 * pre-stripped lines (single-line `//` comments and obvious
 * `/* ... *\/` comments are removed before matching).
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  {
    name: 'mcp_module_import',
    regex: /\bfrom\s+['"][^'"]*\bmcp[^'"]*['"]/i,
  },
  {
    name: 'mcp_dynamic_require',
    regex: /\brequire\(\s*['"][^'"]*\bmcp[^'"]*['"]\s*\)/i,
  },
  {
    name: 'mcp_call_site',
    regex: /\bawait\s+mcp[._]/i,
  },
  {
    name: 'mcp_droid_tool_pattern',
    regex: /\bmcp__[A-Za-z0-9_]+__/,
  },
];

const ALLOWED_DIRECTORIES_OUT = new Set(['node_modules', '__snapshots__']);

function walk(dir: string, accumulator: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ALLOWED_DIRECTORIES_OUT.has(entry.name)) continue;
      walk(path.join(dir, entry.name), accumulator);
    } else if (entry.isFile()) {
      const fullPath = path.join(dir, entry.name);
      if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        accumulator.push(fullPath);
      }
    }
  }
}

function stripCommentForMatching(line: string): string {
  // Drop the trailing `//` comment payload before matching. We don't
  // attempt to handle multi-line block comments — that's why the script
  // also walks raw lines, ensuring `// foo mcp bar` doesn't fire but
  // `await mcp.thing()` would.
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function isLikelyCommentOnly(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function scanFile(file: string): Hit[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isLikelyCommentOnly(line)) continue;
    const stripped = stripCommentForMatching(line);
    for (const { name, regex } of FORBIDDEN_PATTERNS) {
      if (regex.test(stripped)) {
        hits.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          text: line.trim().slice(0, 200),
          pattern: name,
        });
      }
    }
  }
  return hits;
}

function main(): number {
  const files: string[] = [];
  walk(TARGET_DIR, files);

  const hits: Hit[] = [];
  for (const file of files) {
    hits.push(...scanFile(file));
  }

  if (hits.length === 0) {
    process.stdout.write('check-autopilot-no-mcp: OK (no MCP runtime usage in scripts/sentry-autopilot/)\n');
    return 0;
  }

  process.stderr.write(
    `check-autopilot-no-mcp: FAIL — found ${hits.length} forbidden MCP reference(s) in scripts/sentry-autopilot/:\n`,
  );
  for (const hit of hits) {
    process.stderr.write(`  ${hit.file}:${hit.line}  [${hit.pattern}]  ${hit.text}\n`);
  }
  process.stderr.write(
    '\n'
      + 'Sentry autopilot orchestration MUST NOT depend on the Sentry MCP server.\n'
      + 'Use authenticated REST calls (SENTRY_API_BASE_URL + SENTRY_AUTH_TOKEN) instead.\n'
      + 'See docs/plans/260515_autopilot_deferred_items.md Stage F.\n',
  );
  return 1;
}

process.exit(main());
