#!/usr/bin/env npx tsx
/**
 * CI Validation: E2E lifecycle-wait timeout-budget guard.
 *
 * Guards the regression class from
 * docs-private/postmortems/260531_make_voice_session_routing_firstwindow_timeout_*:
 * a release-gating E2E spec encoded a *fixed* long `firstWindow()` startup
 * budget (120s) that was fine on a fresh runner but false on the tired-runner
 * path (the spec ran after 100+ prior tests). Each time an earlier startup
 * budget was made CI-aware, the next fixed lifecycle wait became the bottleneck.
 *
 * The prevention the postmortem recommends (Review Analysis, recommendation 1):
 *   "Add an E2E timeout-budget lint/check for Playwright lifecycle waits: fixed
 *    waits above a small threshold in release-gating E2E specs should either be
 *    CI-aware/env-overridable or explicitly justified."
 *
 * This is that check. It is deliberately NARROW — it targets the *startup
 * lifecycle wait* class that caused the incident, not every timeout literal:
 *
 *   - `firstWindow({ timeout: <literal> })` — the Electron app first-window wait
 *     that runs in beforeAll/launch helpers. A fixed literal above the threshold
 *     is the exact 260531 bug shape.
 *
 * It does NOT flag `test.describe.configure({ timeout })` or `test.setTimeout()`
 * — those are overall *test* budgets, legitimately large, and not the lifecycle
 * bottleneck class. Widening to them would be noise.
 *
 * A flagged literal passes if it is any of:
 *   - CI-aware: the timeout expression references `process.env.CI` (a literal is
 *     a *value*, not an expression, so a CI-aware one is never a bare number);
 *   - env-overridable: references a `process.env.E2E_*` / `*_TIMEOUT_*` override;
 *   - a variable/identifier rather than a numeric literal (already abstracted);
 *   - explicitly justified with an inline `// timeout-budget-ok: <reason>` marker
 *     on the same line or the line immediately above.
 *
 * Run: npx tsx scripts/check-e2e-timeout-budget.ts
 * Wired into: npm run validate:fast (validate:e2e-timeout-budget)
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const E2E_DIR = path.join(ROOT, 'tests', 'e2e');

/**
 * Fixed firstWindow waits STRICTLY ABOVE this many ms must be CI-aware,
 * env-overridable, or justified. 30_000 is Playwright's own default firstWindow
 * timeout and the documented safe CI startup value (test-utils.ts
 * STARTUP_PROBE_TIMEOUT_MS), so anything larger that is *hardcoded* is the
 * latent next-bottleneck the postmortem warns about; 30_000 itself is fine.
 */
const THRESHOLD_MS = 30_000;

const JUSTIFY_MARKER = 'timeout-budget-ok:';

/** Matches `firstWindow({ timeout: <expr> })`, capturing the timeout expression. */
const FIRST_WINDOW_RE = /firstWindow\(\s*\{[^}]*\btimeout\s*:\s*([^,}]+?)\s*[,}]/g;

export interface BudgetViolation {
  file: string;
  line: number;
  expr: string;
  valueMs: number;
}

/**
 * Parse a fixed numeric timeout expression to ms, or null if it's not a constant
 * (an identifier, a process.env expression, a function call — i.e. already
 * abstracted). Handles `_` separators (120_000) and simple products of literals
 * (`60 * 1000`, `2 * 60_000`) so the obvious arithmetic bypass is still caught.
 */
function parseNumericLiteral(expr: string): number | null {
  const cleaned = expr.replace(/_/g, '').trim();
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  // Product of bare integer literals only (no identifiers / calls / env refs).
  const product = cleaned.match(/^(\d+(?:\s*\*\s*\d+)+)$/);
  if (product) {
    return cleaned.split('*').reduce((acc, part) => acc * Number(part.trim()), 1);
  }
  return null;
}

function isCiAwareOrOverridable(expr: string): boolean {
  return /process\.env\.CI\b/.test(expr) || /process\.env\.[A-Z0-9_]*(TIMEOUT|E2E)[A-Z0-9_]*/.test(expr);
}

export function findTimeoutBudgetViolations(
  fileText: string,
  fileLabel: string,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  const lines = fileText.split('\n');

  let match: RegExpExecArray | null;
  FIRST_WINDOW_RE.lastIndex = 0;
  while ((match = FIRST_WINDOW_RE.exec(fileText)) !== null) {
    const expr = match[1].trim();

    // A bare numeric literal is the only flaggable shape — a variable or a
    // process.env expression is already abstracted/CI-aware.
    const valueMs = parseNumericLiteral(expr);
    if (valueMs === null) continue; // identifier / expression → already abstracted
    if (valueMs <= THRESHOLD_MS) continue; // only fixed budgets STRICTLY above the safe value

    // CI-aware / env-overridable check on the (literal) expr — defensive; a bare
    // literal won't reference process.env, but keep the gate logically complete.
    if (isCiAwareOrOverridable(expr)) continue;

    // Locate the line of the match for justification + reporting.
    const charIndex = match.index;
    const lineNo = fileText.slice(0, charIndex).split('\n').length;
    const thisLine = lines[lineNo - 1] ?? '';
    const prevLine = lines[lineNo - 2] ?? '';
    if (thisLine.includes(JUSTIFY_MARKER) || prevLine.includes(JUSTIFY_MARKER)) continue;

    violations.push({ file: fileLabel, line: lineNo, expr, valueMs });
  }

  return violations;
}

function collectE2eFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectE2eFiles(full));
    } else if (/\.(spec|test)\.ts$/.test(name) || name === 'test-utils.ts') {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
  if (!fs.existsSync(E2E_DIR)) {
    console.log('⏭️  tests/e2e not found — skipping E2E timeout-budget check.');
    return;
  }

  const files = collectE2eFiles(E2E_DIR);
  const violations: BudgetViolation[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    violations.push(...findTimeoutBudgetViolations(text, path.relative(ROOT, file)));
  }

  if (violations.length > 0) {
    console.error(
      `\n❌ ${violations.length} fixed E2E firstWindow timeout(s) above ${THRESHOLD_MS}ms ` +
        'that are not CI-aware, env-overridable, or justified:\n',
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  firstWindow({ timeout: ${v.expr} })  (${v.valueMs}ms)`);
    }
    console.error(
      '\nA fixed long first-window startup budget is the 260531 voice-session-routing\n' +
        'regression class: fine on a fresh runner, false on the tired-runner release lane.\n' +
        'Make the timeout CI-aware (reference process.env.CI), env-overridable\n' +
        '(read a process.env.E2E_*_TIMEOUT_MS override, like STARTUP_PROBE_TIMEOUT_MS in\n' +
        'tests/e2e/test-utils.ts), or — if the fixed budget is deliberate — add an inline\n' +
        `  // ${JUSTIFY_MARKER} <reason>\n` +
        'marker on the line or the line above.\n',
    );
    process.exit(1);
  }

  console.log(
    `✔ All E2E firstWindow waits ≥ ${THRESHOLD_MS}ms are CI-aware, env-overridable, or justified.`,
  );
}

if (require.main === module) {
  main();
}
