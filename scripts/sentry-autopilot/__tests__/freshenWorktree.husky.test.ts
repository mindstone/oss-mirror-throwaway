/**
 * Stage D — freshenWorktree husky/hooksPath defense-in-depth tests.
 *
 * Husky's `prepare` script reinstalls hooks into the superproject's
 * `core.hooksPath` on every `npm ci`, which silently breaks the per-worktree
 * `core.hooksPath` that points at the autopilot pre-push hook. We defend with
 * two mechanisms:
 *   1. `HUSKY=0` env var passed to `npm ci` — prevents the prepare script
 *      from running at all.
 *   2. Re-applying `git config --worktree core.hooksPath <state>/hooks`
 *      immediately after `npm ci` — cheap and catches any other source of
 *      hooksPath drift.
 *
 * Both must happen on every freshen, not just the first one. These tests
 * mock node:child_process.execFile and assert the call sequence.
 */

import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileCalls: Array<{
  command: string;
  args: readonly string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
}> = [];

vi.mock('node:child_process', () => {
  return {
    execFile: (
      command: string,
      args: readonly string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined,
      callback: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      execFileCalls.push({ command, args, options });
      // `git status --porcelain` is the only command whose stdout the
      // surrounding logic inspects; everything else is fire-and-check-exit.
      callback(null, { stdout: '', stderr: '' });
    },
  };
});

// Force the lockfile-hash check to always treat the worktree as needing
// `npm ci`. We do this via a `vi.spyOn` on `node:fs` after the SessionManager
// module loads (see beforeEach).
import fs from 'node:fs';

import type { AutopilotConfig } from '../config.ts';
import { SessionManager } from '../session-manager.ts';
import type { IssueRow, StateDB } from '../state.ts';

function makeConfig(stateDir: string): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'disabled',
    stateDir,
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: path.resolve(__dirname, '..', '..', '..'),
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

describe('freshenWorktree husky + hooksPath defense (Stage D)', () => {
  let manager: SessionManager;
  const stateDir = '/tmp/sentry-autopilot-test-state';

  beforeEach(() => {
    execFileCalls.length = 0;
    const db = {} as unknown as StateDB;
    manager = new SessionManager(makeConfig(stateDir), db);

    // shouldRunNpmCi reads package-lock.json, .lockfile-hash, and
    // node_modules. Force it to take the "needs npm ci" branch by faking
    // each fs call.
    vi.spyOn(fs, 'existsSync').mockImplementation(() => false);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor) => {
      // Return any string for package-lock.json so the hash compute succeeds.
      const key = String(p);
      if (key.endsWith('package-lock.json')) return 'mock-lockfile-content';
      if (key.endsWith('.lockfile-hash')) return 'stale-hash\n';
      return '';
    }) as typeof fs.readFileSync);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes HUSKY=0 in the env of npm ci', async () => {
    await (
      manager as unknown as { freshenWorktree: (slot: number) => Promise<void> }
    ).freshenWorktree(0);

    const npmCi = execFileCalls.find(
      (c) => c.command === 'npm' && c.args[0] === 'ci',
    );
    expect(npmCi, 'expected npm ci to be invoked').toBeDefined();
    expect(npmCi?.options?.env).toBeDefined();
    expect((npmCi?.options?.env as Record<string, string>).HUSKY).toBe('0');
  });

  it('re-applies core.hooksPath via git config --worktree AFTER npm ci', async () => {
    await (
      manager as unknown as { freshenWorktree: (slot: number) => Promise<void> }
    ).freshenWorktree(0);

    const hooksPath = path.join(stateDir, 'hooks');
    const hooksConfigCall = execFileCalls.find(
      (c) =>
        c.command === 'git' &&
        c.args.includes('config') &&
        c.args.includes('--worktree') &&
        c.args.includes('core.hooksPath') &&
        c.args.includes(hooksPath),
    );
    expect(hooksConfigCall, 'expected git config --worktree core.hooksPath').toBeDefined();

    // The hooksPath re-apply must come AFTER npm ci. Otherwise an npm ci
    // mid-tick could still clobber it.
    const npmCiIndex = execFileCalls.findIndex(
      (c) => c.command === 'npm' && c.args[0] === 'ci',
    );
    const hooksConfigIndex = execFileCalls.indexOf(hooksConfigCall!);
    expect(hooksConfigIndex).toBeGreaterThan(npmCiIndex);
  });

  it('runs git submodule sync + update --init --recursive after origin/dev checkout', async () => {
    // Submodules track pinned versions in dev. Without these the worktree
    // can carry a stale rebel-system / super-mcp / coding-agent-instructions
    // checkout from a previous tick, so the bug-fixer reasons against
    // out-of-date workflow instructions and skill files.
    await (
      manager as unknown as { freshenWorktree: (slot: number) => Promise<void> }
    ).freshenWorktree(0);

    const checkoutIdx = execFileCalls.findIndex(
      (c) =>
        c.command === 'git' && c.args[0] === 'checkout' && c.args.includes('origin/dev'),
    );
    const submoduleSyncIdx = execFileCalls.findIndex(
      (c) =>
        c.command === 'git' &&
        c.args[0] === 'submodule' &&
        c.args[1] === 'sync' &&
        c.args.includes('--recursive'),
    );
    const submoduleUpdateIdx = execFileCalls.findIndex(
      (c) =>
        c.command === 'git' &&
        c.args[0] === 'submodule' &&
        c.args[1] === 'update' &&
        c.args.includes('--init') &&
        c.args.includes('--recursive'),
    );

    expect(submoduleSyncIdx, 'expected git submodule sync --recursive').toBeGreaterThan(-1);
    expect(submoduleUpdateIdx, 'expected git submodule update --init --recursive').toBeGreaterThan(-1);
    // Both submodule commands must run AFTER the origin/dev checkout so
    // they pull the pointers recorded on the freshly-checked-out tip.
    expect(submoduleSyncIdx).toBeGreaterThan(checkoutIdx);
    expect(submoduleUpdateIdx).toBeGreaterThan(submoduleSyncIdx);
  });

  it('runs git fetch + checkout origin/dev + clean before npm ci', async () => {
    // Sanity-check the ordering so a future refactor doesn't accidentally
    // move npm ci ahead of the worktree-reset commands (which would npm ci
    // against whatever dirty state the previous session left behind).
    await (
      manager as unknown as { freshenWorktree: (slot: number) => Promise<void> }
    ).freshenWorktree(0);

    const npmCiIdx = execFileCalls.findIndex(
      (c) => c.command === 'npm' && c.args[0] === 'ci',
    );
    const fetchIdx = execFileCalls.findIndex(
      (c) => c.command === 'git' && c.args[0] === 'fetch',
    );
    const checkoutIdx = execFileCalls.findIndex(
      (c) =>
        c.command === 'git' && c.args[0] === 'checkout' && c.args.includes('origin/dev'),
    );

    expect(fetchIdx).toBeGreaterThan(-1);
    expect(checkoutIdx).toBeGreaterThan(-1);
    expect(npmCiIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeLessThan(npmCiIdx);
    expect(checkoutIdx).toBeLessThan(npmCiIdx);
  });
});
