#!/usr/bin/env npx tsx
// 260608 release-pipeline hardening. Plan: docs/plans/260607_oss-scrub-regression-class.
//
// Catches a specific, deterministic PowerShell PARSE error in embedded workflow
// scripts BEFORE it reaches a Windows build job (where it currently surfaces only
// after a ~60-min package step, and — because publish-to-gcs needs build-windows —
// blocks ALL beta publishes).
//
// The gotcha: inside a double-quoted PowerShell string, `$Name:` is parsed as a
// scope/drive-qualified variable reference (e.g. `$env:PATH`, `$global:x`). PowerShell
// raises a hard PARSE error — "Variable reference is not valid. ':' was not followed
// by a valid variable name character. Consider using ${} to delimit the name." —
// whenever the colon is NOT immediately followed by a valid variable-name character.
// So `"...$attempt/$Attempts: $($_.Exception.Message)"` fails at parse time (the whole
// script never runs). This shipped in fdb76a7a1 (260606) and blocked every Windows
// beta build until caught manually. Fix: wrap the variable — `${Attempts}:`.
//
// Why static (no pwsh): the rule is purely lexical — `$ident:` followed by a char
// outside [A-Za-z0-9_{] is always this parse error, on every platform — so we can
// flag it deterministically without a PowerShell interpreter (which isn't present on
// dev macOS / the Linux validate runner). Scope is limited to steps whose effective
// shell is pwsh/powershell to avoid touching legitimate bash `$VAR:` usage.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_NAME = 'check-workflow-powershell-syntax';

// `$Name:` where the colon is NOT followed by a valid variable-name char ([A-Za-z0-9_]
// or an opening `${...}` brace). This is the exact condition PowerShell rejects at
// parse time. Captures the offending token for the report.
const PS_COLON_PARSE_ERROR = /\$[A-Za-z_][A-Za-z0-9_]*:(?![A-Za-z0-9_{])/;
const PS_SHELLS = new Set(['pwsh', 'powershell']);

type YamlRecord = Record<string, unknown>;

export interface PowershellSyntaxViolation {
  workflowPath: string;
  jobId: string;
  stepName: string;
  line: number;
  snippet: string;
  token: string;
}

export interface CheckResult {
  violations: PowershellSyntaxViolation[];
  scannedSteps: number;
}

export interface CheckOptions {
  repoRoot?: string;
  /** Explicit list of workflow file paths (absolute). Defaults to .github/workflows/*.yml. */
  workflowFiles?: string[];
}

function asRecord(value: unknown): YamlRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as YamlRecord;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/');
}

function displayPath(absolutePath: string, root: string): string {
  const rel = normalize(relative(root, absolutePath));
  return rel && !rel.startsWith('..') ? rel : normalize(absolutePath);
}

/** Resolve a step's effective shell, falling back to job- then workflow-level defaults. */
function effectiveShell(
  step: YamlRecord,
  job: YamlRecord,
  root: YamlRecord,
): string | undefined {
  const stepShell = typeof step.shell === 'string' ? step.shell : undefined;
  if (stepShell) return stepShell.toLowerCase();
  const jobDefaultShell = asRecord(asRecord(job.defaults)?.run)?.shell;
  if (typeof jobDefaultShell === 'string') return jobDefaultShell.toLowerCase();
  const rootDefaultShell = asRecord(asRecord(root.defaults)?.run)?.shell;
  if (typeof rootDefaultShell === 'string') return rootDefaultShell.toLowerCase();
  return undefined;
}

/** Scan a single PowerShell `run:` script body for the colon parse-error gotcha. */
export function scanScript(run: string): { line: number; snippet: string; token: string }[] {
  const out: { line: number; snippet: string; token: string }[] = [];
  const lines = run.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Skip full-line comments (a `# ... $Var: ...` note is not executed).
    if (raw.trimStart().startsWith('#')) continue;
    const match = PS_COLON_PARSE_ERROR.exec(raw);
    if (match) {
      out.push({ line: i + 1, snippet: raw.trim().slice(0, 160), token: match[0] });
    }
  }
  return out;
}

export function checkWorkflowPowershellSyntax(options: CheckOptions = {}): CheckResult {
  const root = options.repoRoot ?? repoRoot;
  const files =
    options.workflowFiles ??
    fg.sync('.github/workflows/*.{yml,yaml}', { cwd: root, absolute: true });

  const violations: PowershellSyntaxViolation[] = [];
  let scannedSteps = 0;

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(file, 'utf8'));
    } catch {
      // A YAML that doesn't parse is another check's concern; skip here.
      continue;
    }
    const doc = asRecord(parsed);
    const jobs = asRecord(doc?.jobs);
    if (!doc || !jobs) continue;

    for (const [jobId, rawJob] of Object.entries(jobs)) {
      const job = asRecord(rawJob);
      const steps = Array.isArray(job?.steps) ? job!.steps : [];
      for (const rawStep of steps) {
        const step = asRecord(rawStep);
        if (!step || typeof step.run !== 'string') continue;
        const shell = effectiveShell(step, job!, doc);
        if (!shell || !PS_SHELLS.has(shell)) continue;
        scannedSteps++;
        const stepName = typeof step.name === 'string' ? step.name : '(unnamed step)';
        for (const hit of scanScript(step.run)) {
          violations.push({
            workflowPath: displayPath(file, root),
            jobId,
            stepName,
            line: hit.line,
            snippet: hit.snippet,
            token: hit.token,
          });
        }
      }
    }
  }

  return { violations, scannedSteps };
}

function main(): void {
  const { violations, scannedSteps } = checkWorkflowPowershellSyntax();
  if (violations.length === 0) {
    console.log(
      `✔ ${CHECK_NAME}: scanned ${scannedSteps} embedded pwsh/powershell step(s); no \`$var:\` parse-error patterns.`,
    );
    return;
  }
  console.error(
    `✖ ${CHECK_NAME}: ${violations.length} PowerShell parse-error pattern(s) found in workflow scripts.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.workflowPath} — job "${v.jobId}" — step "${v.stepName}" (line ${v.line})`);
    console.error(`    ${v.snippet}`);
    console.error(
      `    ↳ "${v.token}" — PowerShell parses the colon as a scope qualifier and fails at PARSE time.\n` +
        `      Fix: delimit the variable name, e.g. "${v.token.replace(/^\$([A-Za-z_][A-Za-z0-9_]*):$/, '${$1}:')}".\n`,
    );
  }
  console.error(
    'This is a deterministic parse error (the whole script never runs). It would fail the\n' +
      'Windows build only after a long package step, blocking all beta publishes. See\n' +
      'docs/project/CI_WORKFLOW_GOTCHAS.md.',
  );
  process.exitCode = 1;
}

// Run as CLI only (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
