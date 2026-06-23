/**
 * Phase 6 regression test — cron env-var export propagation.
 *
 * Background
 * ----------
 * `~/autopilot.env` defines bare `KEY=value` lines without `export`. When
 * sourced from a non-interactive `bash -lc` shell (as cron runs it), those
 * assignments stay shell-local and never reach the child Node.js process
 * spawned by `npx tsx scripts/sentry-autopilot/dispatcher.ts`. The result is
 * that `process.env.AUTOPILOT_CLI`, `AUTOPILOT_CURSOR_MODEL`,
 * `SENTRY_AUTH_TOKEN`, etc. arrive as `undefined`, and `loadConfig()` either
 * fails fast (missing required vars) or silently mis-routes (cli falls back
 * to droid default).
 *
 * Fix
 * ---
 * The cron line in `scripts/cloud-vm-provision.sh` wraps the source call with
 * `set -a` (allexport) / `set +a`, which automatically marks all subsequently
 * assigned variables for export. This was empirically verified against the
 * real `bash -lc` invocation shape during Phase 6 review.
 *
 * What this test guards
 * ---------------------
 * 1. **Static check** — scans the provisioning script for the literal
 *    `set -a && source ... autopilot.env && set +a` pattern in the cron line.
 *    Catches accidental deletions / refactors that strip the wrappers.
 * 2. **Behavioural check** — actually runs the bash incantation in an
 *    isolated temp dir with a fake `autopilot.env`, then introspects
 *    `process.env` in a Node child. Confirms the wrapper genuinely surfaces
 *    bare-assigned variables to the child process, and that *without* the
 *    wrapper they stay shell-local. This is the empirical control that makes
 *    the static check meaningful.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PROVISION_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'cloud-vm-provision.sh',
);

function readProvisionScript(): string {
  return fs.readFileSync(PROVISION_SCRIPT, 'utf8');
}

/**
 * Single-line node probe (multi-line strings don't survive bash -> node eval
 * cleanly). Prints a JSON object with the four env vars we care about.
 */
const PROBE_SCRIPT =
  'console.log(JSON.stringify({' +
  'cli: process.env.AUTOPILOT_CLI,' +
  'model: process.env.AUTOPILOT_CURSOR_MODEL,' +
  'sentry: process.env.SENTRY_AUTH_TOKEN,' +
  'cursor: process.env.CURSOR_API_KEY,' +
  'claudeModel: process.env.AUTOPILOT_CLAUDE_MODEL,' +
  'anthropic: process.env.ANTHROPIC_API_KEY,' +
  'releaseGateEnabled: process.env.AUTOPILOT_RELEASE_GATE_ENABLED,' +
  'releaseLagToleranceMinor: process.env.AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR,' +
  'linearDedupEnabled: process.env.AUTOPILOT_LINEAR_DEDUP_ENABLED,' +
  'linearDedupStatuses: process.env.AUTOPILOT_LINEAR_DEDUP_STATUSES,' +
  'inFlightDedupEnabled: process.env.AUTOPILOT_INFLIGHT_DEDUP_ENABLED,' +
  'inFlightDedupWindowHours: process.env.AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS,' +
  'currentRelease: process.env.AUTOPILOT_CURRENT_RELEASE' +
  '}))';

/**
 * Mirror the production cron command shape:
 *
 *   bash -lc 'set -a && source $HOME/autopilot.env && set +a && cd ... && npx tsx ...'
 *
 * We swap `cd ... && npx tsx ...` for `node -e <probe>` so we can introspect
 * the child Node process's `process.env`.
 */
/**
 * Build a scrubbed env for the spawnSync invocations so any pre-existing
 * exports in the developer's parent shell (e.g. `ANTHROPIC_API_KEY` from
 * `~/.config/droid/env`) don't poison the control assertion that variables
 * stay shell-local without `set -a`. We intentionally retain HOME / PATH so
 * `bash -lc` can still find binaries and source its own rc files.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const SCRUB_KEYS = [
    'AUTOPILOT_CLI',
    'AUTOPILOT_CURSOR_MODEL',
    'AUTOPILOT_CLAUDE_MODEL',
    'SENTRY_AUTH_TOKEN',
    'CURSOR_API_KEY',
    'ANTHROPIC_API_KEY',
    'AUTOPILOT_RELEASE_GATE_ENABLED',
    'AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR',
    'AUTOPILOT_LINEAR_DEDUP_ENABLED',
    'AUTOPILOT_LINEAR_DEDUP_STATUSES',
    'AUTOPILOT_INFLIGHT_DEDUP_ENABLED',
    'AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS',
    'AUTOPILOT_CURRENT_RELEASE',
  ];
  const out = { ...process.env };
  for (const k of SCRUB_KEYS) delete out[k];
  return out;
}

function runProductionShape(envFile: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const inner = `set -a && source ${JSON.stringify(envFile)} && set +a && node -e ${JSON.stringify(PROBE_SCRIPT)}`;
  const result = spawnSync('bash', ['-lc', inner], { encoding: 'utf8', env: scrubbedEnv() });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Same shape, **without** the set -a / set +a wrappers. Acts as a control:
 * if this *also* surfaces the variables, the production wrapper is redundant
 * and the static guard is meaningless. We expect it to NOT surface them.
 */
function runUnwrappedShape(envFile: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const inner = `source ${JSON.stringify(envFile)} && node -e ${JSON.stringify(PROBE_SCRIPT)}`;
  const result = spawnSync('bash', ['-lc', inner], { encoding: 'utf8', env: scrubbedEnv() });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

let tmpDir: string;
let envFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-cron-env-'));
  envFile = path.join(tmpDir, 'autopilot.env');

  // Mirror the production autopilot.env layout: bare KEY=value lines with no
  // `export` keyword. This is exactly what scripts/cloud-vm-provision.sh
  // generates via `cat > ~/autopilot.env`.
  fs.writeFileSync(
    envFile,
    [
      '# Autopilot environment — Phase 6 regression fixture',
      'AUTOPILOT_CLI=cursor',
      'AUTOPILOT_CURSOR_MODEL=composer-2.5',
      'SENTRY_AUTH_TOKEN=fake-sentry-token-from-env-file',
      'CURSOR_API_KEY=fake-cursor-key-from-env-file',
      'AUTOPILOT_CLAUDE_MODEL=claude-opus-4-8',
      'ANTHROPIC_API_KEY=fake-anthropic-key-from-env-file',
      'AUTOPILOT_RELEASE_GATE_ENABLED=true',
      'AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR=0',
      'AUTOPILOT_LINEAR_DEDUP_ENABLED=true',
      'AUTOPILOT_LINEAR_DEDUP_STATUSES=Done,Cancelled,Duplicate',
      'AUTOPILOT_INFLIGHT_DEDUP_ENABLED=true',
      'AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS=6',
      'AUTOPILOT_CURRENT_RELEASE=v0.4.46',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('cron env export — static guard (cloud-vm-provision.sh)', () => {
  it('keeps the autopilot CRON_LINE wrapped in `set -a` / `set +a`', () => {
    const script = readProvisionScript();

    // Locate the autopilot CRON_LINE assignment. There are two CRON_LINE
    // assignments in the script (transcript uploader at ~line 1394 and the
    // autopilot dispatcher at ~line 2099). We want the autopilot one — the
    // one that sources autopilot.env.
    const autopilotCronLineMatch = script.match(
      /CRON_LINE="[^"\n]*sentry-autopilot[^"\n]*"|CRON_LINE="[^"\n]*autopilot\.env[^"\n]*"/,
    );

    expect(
      autopilotCronLineMatch,
      'expected to find the autopilot CRON_LINE in cloud-vm-provision.sh',
    ).not.toBeNull();

    const cronLine = autopilotCronLineMatch![0];

    // The fix: `set -a` precedes the source, `set +a` follows it.
    expect(
      cronLine,
      'autopilot CRON_LINE must enable allexport (`set -a`) before sourcing autopilot.env',
    ).toMatch(/set -a\s*&&\s*source\s+\\?\$HOME\/autopilot\.env/);

    expect(
      cronLine,
      'autopilot CRON_LINE must disable allexport (`set +a`) after sourcing autopilot.env',
    ).toMatch(/source\s+\\?\$HOME\/autopilot\.env\s*&&\s*set \+a/);
  });

  it('preserves the explanatory NOTE comment so future maintainers understand the wrapper', () => {
    const script = readProvisionScript();

    // The comment block right above the CRON_LINE explains *why* the wrapper
    // exists. Without it, the next refactor will likely strip the wrapper as
    // "redundant shell ceremony". The guard is light on purpose — just enough
    // to catch a wholesale comment deletion.
    expect(
      script,
      'expected the `set -a` rationale comment above the autopilot CRON_LINE',
    ).toMatch(/allexport.*autopilot\.env/s);
  });
});

describe('cron env export — behavioural control (real bash)', () => {
  it('with the wrapper, variables from bare-KEY=value source line reach the child Node process', () => {
    const r = runProductionShape(envFile);

    expect(
      r.status,
      `production-shape bash invocation failed: ${r.stderr}`,
    ).toBe(0);

    const parsed = JSON.parse(r.stdout.trim()) as {
      cli?: string;
      model?: string;
      sentry?: string;
      cursor?: string;
      claudeModel?: string;
      anthropic?: string;
      releaseGateEnabled?: string;
      releaseLagToleranceMinor?: string;
      linearDedupEnabled?: string;
      linearDedupStatuses?: string;
      inFlightDedupEnabled?: string;
      inFlightDedupWindowHours?: string;
      currentRelease?: string;
    };

    expect(parsed.cli).toBe('cursor');
    expect(parsed.model).toBe('composer-2.5');
    expect(parsed.sentry).toBe('fake-sentry-token-from-env-file');
    expect(parsed.cursor).toBe('fake-cursor-key-from-env-file');
    // Claude runner env vars must also propagate via the same `set -a`
    // wrapper. They're written to the same `~/autopilot.env` file when
    // claude mode is selected (per cloud-vm-provision.sh).
    expect(parsed.claudeModel).toBe('claude-opus-4-8');
    expect(parsed.anthropic).toBe('fake-anthropic-key-from-env-file');
    expect(parsed.releaseGateEnabled).toBe('true');
    expect(parsed.releaseLagToleranceMinor).toBe('0');
    expect(parsed.linearDedupEnabled).toBe('true');
    expect(parsed.linearDedupStatuses).toBe('Done,Cancelled,Duplicate');
    expect(parsed.inFlightDedupEnabled).toBe('true');
    expect(parsed.inFlightDedupWindowHours).toBe('6');
    expect(parsed.currentRelease).toBe('v0.4.46');
  });

  it('WITHOUT the wrapper, variables from bare-KEY=value source line do NOT reach the child Node process', () => {
    // This is the control. If this assertion ever flips and the unwrapped
    // form also propagates the variables, the production fix would be
    // unnecessary and the static guard above would be meaningless. The
    // behavioural assertion below is what gives the static guard teeth.
    const r = runUnwrappedShape(envFile);

    expect(
      r.status,
      `unwrapped bash invocation failed unexpectedly: ${r.stderr}`,
    ).toBe(0);

    const parsed = JSON.parse(r.stdout.trim()) as {
      cli?: string;
      model?: string;
      sentry?: string;
      cursor?: string;
      claudeModel?: string;
      anthropic?: string;
      releaseGateEnabled?: string;
      releaseLagToleranceMinor?: string;
      linearDedupEnabled?: string;
      linearDedupStatuses?: string;
      inFlightDedupEnabled?: string;
      inFlightDedupWindowHours?: string;
      currentRelease?: string;
    };

    // Bash assignments stay shell-local without `export` / `set -a`. Child
    // processes inherit the parent's exported env only, so all keys arrive
    // undefined. This is the bug the wrapper fixes.
    expect(parsed.cli).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.sentry).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
    expect(parsed.claudeModel).toBeUndefined();
    expect(parsed.anthropic).toBeUndefined();
    expect(parsed.releaseGateEnabled).toBeUndefined();
    expect(parsed.releaseLagToleranceMinor).toBeUndefined();
    expect(parsed.linearDedupEnabled).toBeUndefined();
    expect(parsed.linearDedupStatuses).toBeUndefined();
    expect(parsed.inFlightDedupEnabled).toBeUndefined();
    expect(parsed.inFlightDedupWindowHours).toBeUndefined();
    expect(parsed.currentRelease).toBeUndefined();
  });
});
