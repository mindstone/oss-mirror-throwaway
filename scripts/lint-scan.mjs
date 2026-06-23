#!/usr/bin/env node
// Human-readability convenience (D6 — docs/plans/260612_silent-swallow-gate/PLAN.md).
//
// Runs the EXACT same `npm run lint` (no second ESLint config, no rule turned
// off — single ESLint truth) and only filters the ~2,200 pre-existing
// `rebel-silent-swallow/no-silent-swallow` warnings OUT OF THE DISPLAYED OUTPUT
// so a human/agent reading local lint output can spot a genuinely new finding
// of any other rule without the silent-swallow population drowning it.
//
// IMPORTANT: this changes DISPLAY ONLY. It does NOT change what is enforced:
// - The real new-silent-swallow gate is `validate:eslint-new-warnings`
//   (diff-scoped, blocking) plus the `--max-warnings 3000` mass-regression cap.
// - This script preserves `npm run lint`'s real exit code, so it never
//   licenses a regression — if lint fails (e.g. the cap is crossed, or an
//   error-severity rule fires), this exits non-zero too.
//
// The silent-swallow lines are still PRESENT in plain `npm run lint`; use that
// when you specifically want to audit silent-swallow.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SILENT_SWALLOW_RULE_ID = 'rebel-silent-swallow/no-silent-swallow';

// Run the real lint script (same enforcement). cross-env is invoked via the
// package script indirection, so spawn `npm run lint` to stay in lockstep with
// whatever `lint` resolves to (heap flag, paths, --max-warnings cap).
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCmd, ['run', '--silent', 'lint'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
});

let suppressed = 0;

function filterStream(readable, writable) {
  const rl = createInterface({ input: readable, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.includes(SILENT_SWALLOW_RULE_ID)) {
      suppressed += 1;
      return;
    }
    writable.write(`${line}\n`);
  });
  return rl;
}

filterStream(child.stdout, process.stdout);
filterStream(child.stderr, process.stderr);

child.on('error', (error) => {
  process.stderr.write(`lint:scan failed to spawn npm run lint: ${error.message}\n`);
  process.exit(1);
});

child.on('close', (code) => {
  if (suppressed > 0) {
    process.stderr.write(
      `\n[lint:scan] Hid ${suppressed} pre-existing ${SILENT_SWALLOW_RULE_ID} ` +
        `warning line(s) from this view (display-only; enforcement is unchanged — ` +
        `run \`npm run lint\` to see them, or rely on validate:eslint-new-warnings ` +
        `for new ones).\n`,
    );
  }
  // Preserve the real lint exit code so this can never mask a failure.
  process.exit(code ?? 1);
});
