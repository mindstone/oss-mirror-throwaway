/**
 * Stage 8 smoke tests for `session-supervisor.sh` runner selection.
 *
 * The supervisor branches on `AUTOPILOT_CLI` (`droid` | `cursor`). We don't have
 * the real binaries in CI / on developer macs, so we stub `droid`, `cursor-agent`,
 * and `timeout` (absent from stock macOS) by:
 *
 *   1. Creating a temp HOME (`$HOME/.local/bin/{droid,cursor-agent,timeout}`),
 *      because the supervisor itself prepends `$HOME/.local/bin` to PATH.
 *   2. Symlinking the fixture stubs into that directory.
 *   3. Invoking the supervisor with the desired `AUTOPILOT_CLI`, recording the
 *      stub's invocation metadata and the resulting `outcome.json`.
 *
 * This exercises:
 *   - Default + explicit `droid` → calls `droid exec --auto high -f $PROMPT_FILE`.
 *   - `cursor` with `CURSOR_API_KEY` → calls `cursor-agent --print …` with
 *     prompt piped via stdin and `AUTOPILOT_CURSOR_MODEL` honoured.
 *   - `cursor` without `CURSOR_API_KEY` → fallback outcome (exit 78, no binary).
 *   - Unknown `AUTOPILOT_CLI` value → fallback outcome (exit 78, no binary).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_DIR = path.resolve(__dirname, '..');
const SUPERVISOR = path.join(SCRIPT_DIR, 'session-supervisor.sh');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const CURSOR_STUB = path.join(FIXTURE_DIR, 'cursor-agent-stub.sh');
const DROID_STUB = path.join(FIXTURE_DIR, 'droid-stub.sh');
const CLAUDE_STUB = path.join(FIXTURE_DIR, 'claude-stub.sh');
const TIMEOUT_STUB = path.join(FIXTURE_DIR, 'timeout-stub.sh');

const tempDirs: string[] = [];

function makeTempHome(): {
  home: string;
  binDir: string;
  worktree: string;
  artifactDir: string;
  promptFile: string;
  recordFile: string;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-supervisor-'));
  tempDirs.push(home);

  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Stage stubs under HOME/.local/bin so the supervisor's PATH prepend finds
  // them ahead of any real droid / cursor-agent / claude / timeout on the
  // dev machine.
  fs.symlinkSync(DROID_STUB, path.join(binDir, 'droid'));
  fs.symlinkSync(CURSOR_STUB, path.join(binDir, 'cursor-agent'));
  fs.symlinkSync(CLAUDE_STUB, path.join(binDir, 'claude'));
  fs.symlinkSync(TIMEOUT_STUB, path.join(binDir, 'timeout'));

  const worktree = path.join(home, 'worktree');
  const artifactDir = path.join(home, 'artifacts');
  fs.mkdirSync(worktree);
  fs.mkdirSync(artifactDir);

  const promptFile = path.join(home, 'prompt.txt');
  fs.writeFileSync(
    promptFile,
    'PROMPT_FIRST_LINE_MARKER\nsecond line of the prompt\nthird line\n',
  );

  const recordFile = path.join(home, 'stub-record.txt');
  fs.writeFileSync(recordFile, '');

  return { home, binDir, worktree, artifactDir, promptFile, recordFile };
}

function runSupervisor(opts: {
  home: string;
  worktree: string;
  artifactDir: string;
  promptFile: string;
  recordFile: string;
  env: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    'bash',
    [
      SUPERVISOR,
      opts.worktree,
      'SENTRY-TEST',
      opts.promptFile,
      opts.artifactDir,
      String(opts.timeoutSeconds ?? 60),
    ],
    {
      // Wipe parent env so a developer's local AUTOPILOT_CLI / CURSOR_API_KEY
      // (or real droid in /usr/local/bin) can't leak into the test.
      env: {
        HOME: opts.home,
        // Keep PATH minimal — supervisor adds its own HOME/.local/bin prepend.
        PATH: '/usr/bin:/bin',
        AUTOPILOT_TEST_RECORD_FILE: opts.recordFile,
        AUTOPILOT_TEST_ARTIFACT_DIR: opts.artifactDir,
        ...opts.env,
      },
      encoding: 'utf8',
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readOutcome(artifactDir: string): Record<string, unknown> | null {
  const p = path.join(artifactDir, 'outcome.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

function readSupervisorLog(artifactDir: string): string {
  const p = path.join(artifactDir, 'supervisor.log');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

beforeAll(() => {
  // Sanity check fixture stubs are executable; chmod here so a fresh clone of
  // the repo doesn't fail on permissions before anyone has run the test once.
  for (const stub of [CURSOR_STUB, DROID_STUB, CLAUDE_STUB, TIMEOUT_STUB]) {
    fs.chmodSync(stub, 0o755);
  }
});

afterEach(() => {
  // Nothing per-test; each test creates its own tempdir.
});

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('session-supervisor.sh runner selection', () => {
  it('defaults to the droid runner and invokes `droid exec --auto high -f PROMPT_FILE`', () => {
    const env = makeTempHome();
    // No AUTOPILOT_CLI set → defaults to droid.
    const result = runSupervisor({
      ...env,
      env: { AUTOPILOT_TEST_WRITE_OUTCOME: '1' },
    });

    expect(result.status).toBe(0);

    const outcome = readOutcome(env.artifactDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.outcome).toBe('fixed');

    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).toContain('binary=droid');
    expect(record).toContain(`argv=exec --auto high -f ${env.promptFile}`);
    // Supervisor must record which runner it invoked.
    expect(readSupervisorLog(env.artifactDir)).toContain('Invoking runner: droid');
  });

  it('invokes cursor-agent with the prompt piped on stdin when AUTOPILOT_CLI=cursor', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'cursor',
        CURSOR_API_KEY: 'fake-test-key',
        AUTOPILOT_CURSOR_MODEL: 'composer-pro',
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);

    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('fixed');

    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).toContain('binary=cursor-agent');
    // Flag surface: --print, --output-format stream-json, --model, --force,
    // --trust, --workspace.
    expect(record).toContain('--print');
    expect(record).toContain('--output-format stream-json');
    expect(record).toContain('--model composer-pro');
    expect(record).toContain('--force');
    expect(record).toContain('--trust');
    expect(record).toContain(`--workspace ${env.worktree}`);
    // Prompt file must be piped via stdin, not passed as an arg.
    expect(record).toContain('stdin_first_line=PROMPT_FIRST_LINE_MARKER');
    expect(record).not.toContain(env.promptFile + ' '); // not in argv as positional
    // Env propagation through tmux/cron must reach the stub.
    expect(record).toContain('CURSOR_API_KEY=fake-test-key');
    expect(record).toContain('AUTOPILOT_CLI=cursor');
    expect(record).toContain('AUTOPILOT_CURSOR_MODEL=composer-pro');

    expect(readSupervisorLog(env.artifactDir)).toContain('Invoking runner: cursor');
    expect(readSupervisorLog(env.artifactDir)).toContain('Using cursor model: composer-pro');
  });

  it('defaults the cursor model to composer-2.5 when AUTOPILOT_CURSOR_MODEL is unset', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'cursor',
        CURSOR_API_KEY: 'fake-test-key',
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);
    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).toContain('--model composer-2.5');
  });

  it('writes a supervisor_failure outcome with exit 78 when cursor is selected but CURSOR_API_KEY is missing', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'cursor',
        // No CURSOR_API_KEY — supervisor must short-circuit before invoking cursor-agent.
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0); // finish trap always exits 0

    // cursor-agent must NOT have been invoked.
    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).not.toContain('binary=cursor-agent');

    const outcome = readOutcome(env.artifactDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.failure_kind).toBe('supervisor_failure');
    expect(outcome?.exit_code).toBe(78);
    expect(String(outcome?.error)).toMatch(/cursor runner exited without writing outcome\.json/);

    expect(readSupervisorLog(env.artifactDir)).toContain(
      'ERROR: AUTOPILOT_CLI=cursor requires CURSOR_API_KEY',
    );
  });

  it('writes a supervisor_failure outcome for an unknown AUTOPILOT_CLI value', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'banana',
      },
    });

    expect(result.status).toBe(0);

    // No runner stub should have been called.
    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).not.toContain('binary=droid');
    expect(record).not.toContain('binary=cursor-agent');
    expect(record).not.toContain('binary=claude');

    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.failure_kind).toBe('supervisor_failure');
    expect(outcome?.exit_code).toBe(78);
    expect(readSupervisorLog(env.artifactDir)).toContain(
      "ERROR: unknown AUTOPILOT_CLI 'banana'",
    );
    // Error message must list all three legitimate values so operators
    // know what to set.
    expect(readSupervisorLog(env.artifactDir)).toMatch(/'droid'.*'cursor'.*'claude'/);
  });

  it('preserves the runner outcome when the stub writes outcome.json and exits 0 (no fallback overwrite)', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'droid',
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);
    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('fixed');
    expect(outcome?.failure_kind).toBeNull();
  });

  it('writes a fallback outcome when the runner exits non-zero without producing outcome.json', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'droid',
        AUTOPILOT_TEST_WRITE_OUTCOME: '0',
        AUTOPILOT_TEST_EXIT_CODE: '7',
      },
    });

    expect(result.status).toBe(0);
    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.failure_kind).toBe('supervisor_failure');
    expect(outcome?.exit_code).toBe(7);
  });

  it('invokes claude with the prompt piped on stdin when AUTOPILOT_CLI=claude', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'claude',
        ANTHROPIC_API_KEY: 'fake-anthropic-test-key',
        AUTOPILOT_CLAUDE_MODEL: 'claude-sonnet-4-5',
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);

    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('fixed');

    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).toContain('binary=claude');
    // Flag surface: --print, --output-format stream-json, --verbose, --model,
    // --dangerously-skip-permissions, --settings <vm-specific>,
    // --no-session-persistence, --add-dir.
    expect(record).toContain('--print');
    expect(record).toContain('--output-format stream-json');
    // --verbose is required by claude 2.1.165 when --print + stream-json are
    // both set; see docs/plans/260604_autopilot_claude_code/spike_results.md.
    expect(record).toContain('--verbose');
    expect(record).toContain('--model claude-sonnet-4-5');
    expect(record).toContain('--dangerously-skip-permissions');
    // --settings replaced --bare on 2026-06-06: --bare also disabled MCP and
    // the Task subagent tool, which CHIEF_BUGFIXER Phase 2 needs (Sentry MCP
    // for evidence retrieval, Task for parallel debugger investigation).
    // The VM-specific settings file pins `hooks: {}` to suppress the dev-only
    // transcript-export hooks while leaving MCP/plugins/Task at claude defaults.
    expect(record).toMatch(/--settings \S+claude-settings\.json/);
    // Defensive: --bare must NOT be passed any more.
    expect(record).not.toContain(' --bare');
    expect(record).toContain('--no-session-persistence');
    expect(record).toContain(`--add-dir ${env.worktree}`);
    // Prompt file must be piped via stdin, not passed as an arg.
    expect(record).toContain('stdin_first_line=PROMPT_FIRST_LINE_MARKER');
    expect(record).not.toContain(`${env.promptFile} `); // not in argv as positional
    // Env propagation through tmux/cron must reach the stub.
    expect(record).toContain('ANTHROPIC_API_KEY=fake-anthropic-test-key');
    expect(record).toContain('AUTOPILOT_CLI=claude');
    expect(record).toContain('AUTOPILOT_CLAUDE_MODEL=claude-sonnet-4-5');

    expect(readSupervisorLog(env.artifactDir)).toContain('Invoking runner: claude');
    expect(readSupervisorLog(env.artifactDir)).toContain('Using claude model: claude-sonnet-4-5');
  });

  it('defaults the claude model to claude-opus-4-8 when AUTOPILOT_CLAUDE_MODEL is unset', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'claude',
        ANTHROPIC_API_KEY: 'fake-anthropic-test-key',
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);
    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).toContain('--model claude-opus-4-8');
  });

  it('defaults --settings to scripts/sentry-autopilot/claude-settings.json when AUTOPILOT_CLAUDE_SETTINGS is unset', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'claude',
        ANTHROPIC_API_KEY: 'fake-anthropic-test-key',
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);
    const record = fs.readFileSync(env.recordFile, 'utf8');
    // Default resolves relative to the supervisor script's directory, so the
    // tail of the path must match. We don't pin the absolute prefix because
    // the test runs the supervisor out of a temp HOME with the real script
    // path on disk (see runSupervisor).
    expect(record).toMatch(/--settings \S*scripts\/sentry-autopilot\/claude-settings\.json/);
  });

  it('respects AUTOPILOT_CLAUDE_SETTINGS env override for the --settings flag', () => {
    const env = makeTempHome();
    const customSettings = '/tmp/custom-claude-settings.json';
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'claude',
        ANTHROPIC_API_KEY: 'fake-anthropic-test-key',
        AUTOPILOT_CLAUDE_SETTINGS: customSettings,
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);
    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).toContain(`--settings ${customSettings}`);
  });

  it('writes a supervisor_failure outcome with exit 78 when claude is selected but ANTHROPIC_API_KEY is missing', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'claude',
        // No ANTHROPIC_API_KEY — supervisor must short-circuit before invoking claude.
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0); // finish trap always exits 0

    // claude must NOT have been invoked.
    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).not.toContain('binary=claude');

    const outcome = readOutcome(env.artifactDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.failure_kind).toBe('supervisor_failure');
    expect(outcome?.exit_code).toBe(78);
    expect(String(outcome?.error)).toMatch(/claude runner exited without writing outcome\.json/);

    expect(readSupervisorLog(env.artifactDir)).toContain(
      'ERROR: AUTOPILOT_CLI=claude requires ANTHROPIC_API_KEY',
    );
  });

  it('writes a supervisor_failure outcome when claude exits 0 without producing outcome.json', () => {
    // Regression guard for the silent-success failure mode (parallel to the
    // existing cursor coverage): claude exits cleanly but did not actually
    // finish the work and never wrote outcome.json. The supervisor's finish
    // trap must synthesise a supervisor_failure outcome so session-manager
    // downstream sees a failure rather than treating a missing outcome.json
    // as a stuck run or silently dropping the session.
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'claude',
        ANTHROPIC_API_KEY: 'fake-anthropic-test-key',
        AUTOPILOT_CLAUDE_MODEL: 'claude-opus-4-8',
        AUTOPILOT_TEST_WRITE_OUTCOME: '0',
        AUTOPILOT_TEST_EXIT_CODE: '0',
      },
    });

    expect(result.status).toBe(0);

    // claude must have actually been invoked; fallback kicks in *after* a
    // clean runner exit, not before the runner even ran.
    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).toContain('binary=claude');

    const outcome = readOutcome(env.artifactDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.failure_kind).toBe('supervisor_failure');
    expect(outcome?.exit_code).toBe(0);
    expect(String(outcome?.error)).toMatch(
      /claude runner exited without writing outcome\.json/,
    );
    expect(readSupervisorLog(env.artifactDir)).toContain('Invoking runner: claude');
  });

  it('writes a supervisor_failure outcome when cursor-agent exits 0 without producing outcome.json', () => {
    // Regression guard for the silent-success failure mode: cursor-agent
    // exits cleanly (the model said "done") but did not actually finish the
    // work and never wrote outcome.json. The supervisor's finish trap must
    // synthesise a supervisor_failure outcome so session-manager downstream
    // sees a failure rather than treating a missing outcome.json as a stuck
    // run or silently dropping the session. Existing coverage at line ~298
    // exercises this for droid + non-zero exit; cursor + exit 0 is the
    // dual-runner blind spot that prompted task 16e.
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'cursor',
        CURSOR_API_KEY: 'fake-test-key',
        AUTOPILOT_CURSOR_MODEL: 'composer-2.5',
        // Stub skips writing outcome.json but still exits 0.
        AUTOPILOT_TEST_WRITE_OUTCOME: '0',
        AUTOPILOT_TEST_EXIT_CODE: '0',
      },
    });

    expect(result.status).toBe(0); // finish trap always exits 0

    // cursor-agent must have actually been invoked (vs short-circuiting on
    // missing API key); we want to prove fallback kicks in *after* a clean
    // runner exit, not before the runner even ran.
    const record = fs.readFileSync(env.recordFile, 'utf8');
    expect(record).toContain('binary=cursor-agent');

    const outcome = readOutcome(env.artifactDir);
    expect(outcome).not.toBeNull();
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.failure_kind).toBe('supervisor_failure');
    expect(outcome?.exit_code).toBe(0);
    expect(String(outcome?.error)).toMatch(
      /cursor runner exited without writing outcome\.json/,
    );

    // Supervisor must announce the fallback in its log so on-call can find
    // it from the artifact bundle alone (no upstream stderr surfacing).
    expect(readSupervisorLog(env.artifactDir)).toContain('Invoking runner: cursor');
  });
});

describe('runner metadata injection', () => {
  // The supervisor must stamp `runner.cli` (and `runner.cursorModel` when
  // applicable) into every outcome.json artifact so downstream subagent
  // analysis can attribute results to the correct runner. Without this,
  // outcome.json files appear with `runner.cli=unset` and dual-runner A/B
  // comparison breaks. Covers both code paths:
  //   - fallback outcome (CLI didn't write outcome.json) — runner is baked
  //     directly into the printf.
  //   - success outcome (CLI wrote its own outcome.json) — supervisor merges
  //     runner in via jq after the fact.
  it('injects runner.cli=droid into fallback outcomes', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'droid',
        AUTOPILOT_TEST_WRITE_OUTCOME: '0',
        AUTOPILOT_TEST_EXIT_CODE: '7',
      },
    });

    expect(result.status).toBe(0);
    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.runner).toEqual({ cli: 'droid' });
  });

  it('injects runner.cli=cursor and runner.cursorModel into fallback outcomes', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'cursor',
        CURSOR_API_KEY: 'fake-test-key',
        AUTOPILOT_CURSOR_MODEL: 'composer-pro',
        AUTOPILOT_TEST_WRITE_OUTCOME: '0',
        AUTOPILOT_TEST_EXIT_CODE: '0',
      },
    });

    expect(result.status).toBe(0);
    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.runner).toEqual({ cli: 'cursor', cursorModel: 'composer-pro' });
  });

  it('injects runner.cli=droid into a CLI-written outcome.json without overwriting other fields', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'droid',
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);
    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('fixed');
    // Stub-written fields are preserved.
    expect(outcome?.runner).toEqual({ cli: 'droid' });
  });

  it('injects runner.cli=cursor and runner.cursorModel into a CLI-written outcome.json', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'cursor',
        CURSOR_API_KEY: 'fake-test-key',
        AUTOPILOT_CURSOR_MODEL: 'composer-2.5',
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);
    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('fixed');
    expect(outcome?.runner).toEqual({ cli: 'cursor', cursorModel: 'composer-2.5' });
  });

  it('injects runner.cli=claude and runner.claudeModel into fallback outcomes', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'claude',
        ANTHROPIC_API_KEY: 'fake-anthropic-test-key',
        AUTOPILOT_CLAUDE_MODEL: 'claude-sonnet-4-5',
        AUTOPILOT_TEST_WRITE_OUTCOME: '0',
        AUTOPILOT_TEST_EXIT_CODE: '0',
      },
    });

    expect(result.status).toBe(0);
    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.runner).toEqual({ cli: 'claude', claudeModel: 'claude-sonnet-4-5' });
  });

  it('injects runner.cli=claude and runner.claudeModel into a CLI-written outcome.json', () => {
    const env = makeTempHome();
    const result = runSupervisor({
      ...env,
      env: {
        AUTOPILOT_CLI: 'claude',
        ANTHROPIC_API_KEY: 'fake-anthropic-test-key',
        AUTOPILOT_CLAUDE_MODEL: 'claude-opus-4-8',
        AUTOPILOT_TEST_WRITE_OUTCOME: '1',
      },
    });

    expect(result.status).toBe(0);
    const outcome = readOutcome(env.artifactDir);
    expect(outcome?.outcome).toBe('fixed');
    expect(outcome?.runner).toEqual({ cli: 'claude', claudeModel: 'claude-opus-4-8' });
  });
});

describe('runner-neutral copy guard', () => {
  // After Stage 4, generic prose surfaces should refer to "runner" / "agent"
  // / "subagent" rather than "droid"-specific copy. This catches accidental
  // re-introductions when someone edits these files later.
  const NEUTRAL_FILES = [
    path.join(SCRIPT_DIR, 'prompt-builder.ts'),
    path.join(SCRIPT_DIR, 'reporter.ts'),
    path.join(SCRIPT_DIR, 'cleanup-eval-artifacts.sh'),
  ];

  // Phrases that should never appear in these surfaces — they have no legitimate
  // dual-runner usage. "droid exec" gets special treatment below: pairing it
  // explicitly with "cursor-agent" on the same line (e.g.
  // `runner (\`droid exec\` / \`cursor-agent\`)`) is *good* dual-runner
  // disambiguation, but a bare "droid exec" mention is a regression.
  const BANNED_SUBSTRINGS = [
    'bugfix sub-droid',
    'droid session',
  ];

  for (const file of NEUTRAL_FILES) {
    it(`does not contain droid-specific copy in ${path.basename(file)}`, () => {
      const text = fs.readFileSync(file, 'utf8');
      for (const needle of BANNED_SUBSTRINGS) {
        expect(
          text.includes(needle),
          `Found banned droid-specific phrase "${needle}" in ${file}. ` +
            `These files were generalized in Stage 4 — use runner-neutral phrasing ` +
            `("runner", "subagent", "agent session") instead.`,
        ).toBe(false);
      }

      const violations: string[] = [];
      text.split('\n').forEach((line, idx) => {
        // Allow `droid exec` mentions only when paired with another runner
        // (cursor-agent or claude) on the same line — that's legitimate
        // multi-runner disambiguation, not a stale droid-only reference.
        if (
          line.includes('droid exec') &&
          !line.includes('cursor-agent') &&
          !line.includes('claude')
        ) {
          violations.push(`${file}:${idx + 1}: ${line.trim()}`);
        }
      });
      expect(
        violations,
        `Found bare "droid exec" mentions (no "cursor-agent" or "claude" on the same line). ` +
          `Use runner-neutral phrasing ("runner", "subagent"), or pair runners ` +
          `explicitly (e.g. "runner (\`droid exec\` / \`cursor-agent\` / \`claude\`)"):\n` +
          violations.join('\n'),
      ).toEqual([]);
    });
  }
});
