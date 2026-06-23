#!/usr/bin/env npx tsx

/**
 * ============================================================================
 * Mindstone Rebel - Git Safe Sync
 * ============================================================================
 *
 * Safely syncs the entire project (pull + push) INCLUDING submodules, with
 * comprehensive safety checks to prevent lost work or dangling commits.
 *
 * This script implements the diagnostic workflow from:
 *   coding-agent-instructions/docs/GIT_SUBMODULE_HEALTH_CHECK.md
 *
 * ============================================================================
 * WHY THIS SCRIPT EXISTS
 * ============================================================================
 *
 * Git submodules are dangerous. If you run `git submodule update` when your
 * submodule has unpushed commits, those commits become "orphaned" - they exist
 * only in `.git/modules/` and are not reachable from any branch. They can be
 * lost during garbage collection.
 *
 * This script ensures:
 * 1. ALL submodule commits are pushed before ANY superproject operations
 * 2. No uncommitted changes exist in submodules
 * 3. Clear error messages guide you to recovery
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *
 * Basic sync (fetch, merge, push; validator delegated to pre-push hook):
 *   npx tsx scripts/git-safe-sync.ts
 *
 * Preview what would happen (safe):
 *   npx tsx scripts/git-safe-sync.ts --dry-run
 *
 * Just check the state (no sync):
 *   npx tsx scripts/git-safe-sync.ts --diagnostics-only
 *
 * Sync but don't push yet (auto-runs validator since pre-push won't):
 *   npx tsx scripts/git-safe-sync.ts --no-push
 *
 * Force in-script validation (normally delegated to pre-push):
 *   npx tsx scripts/git-safe-sync.ts --validate
 *
 * Handle uncommitted superproject changes:
 *   npx tsx scripts/git-safe-sync.ts --autostash
 *
 * Skip submodule advancement:
 *   npx tsx scripts/git-safe-sync.ts --no-advance-submodules
 *
 * ============================================================================
 * SAFETY GUARANTEES (Non-negotiable)
 * ============================================================================
 *
 * This script WILL ABORT if:
 *   - Any submodule has uncommitted changes
 *   - Any submodule HEAD is not on any remote branch (unpushed commits)
 *   - Superproject is dirty (unless --autostash)
 *   - Validators fail after merge (leaves you in merged-but-unpushed state)
 *   - Merge conflicts occur (leaves you mid-merge for manual resolution)
 *
 * ============================================================================
 * MINDSTONE REBEL DEFAULTS
 * ============================================================================
 *
 * - Remote: origin
 * - Branch: current branch (typically 'dev')
 * - Validator: npm run validate:fast — SKIPPED by default (pre-push hook runs it
 *   before the actual `git push`, so running here is duplicate ~40s work). Falls
 *   back to running in-script if no pre-push hook is detected or --no-push is set.
 * - Submodules: rebel-system, super-mcp, coding-agent-instructions (from .gitmodules)
 *
 * ============================================================================
 * WORKFLOW SEQUENCE
 * ============================================================================
 *
 * 1. Navigate to repo root
 * 2. Fetch origin + all submodule remotes IN PARALLEL via
 *    `git fetch --recurse-submodules=yes --jobs=N` — needed for accurate safety checks
 * 3. Check superproject for uncommitted changes
 * 4. Check ALL submodules for:
 *    - Uncommitted changes → ABORT
 *    - HEAD not on any remote branch → ABORT (unpushed commits)
 * 5. Calculate divergence (ahead/behind)
 * 6. Create backup branch (before non-FF merge)
 * 7. If behind: merge with --no-edit (non-interactive)
 * 8. Verify merge integrity (fail-closed)
 * 9. git submodule sync (propagate URL changes)
 * 10. git submodule update --init --recursive (match merged pointers)
 * 11. Advance submodules to remote HEAD in parallel via `--jobs=N` (unless --no-advance-submodules)
 * 12. Create pointer commit if submodules advanced
 * 13. Run validators — SKIPPED by default; runs when --validate, --no-push, or
 *     no pre-push hook detected. Pre-push hook normally handles validation.
 * 14. Push with --recurse-submodules=on-demand (pre-push hook validates before push)
 * 15. Verify final state from LOCAL refs (no re-fetch)
 *
 * ============================================================================
 * RELATED DOCUMENTATION
 * ============================================================================
 *
 * - coding-agent-instructions/docs/GIT_SUBMODULE_HEALTH_CHECK.md - Full diagnostic workflow
 * - docs/project/GIT_SUBMODULES.md - Quick reference
 * - scripts/git-worktree-sync-all.ts - Sync across worktrees
 *
 * (The earlier per-submodule helpers push-submodule.sh / pull-submodule.sh
 * were removed once this script covered all their use cases.)
 *
 * ============================================================================
 */

import { Cli, Command, Option, UsageError } from 'clipanion';
import { execSync, ExecSyncOptions, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { basename, resolve } from 'path';
import { collectMergeFacts, assessMergeIntegrity } from './lib/merge-integrity';
import { SyncTimingRecorder, resolveLogDir } from './lib/sync-timing';
import {
  acquireSameHostSyncLock,
  installLockWaitSignalHandlers,
  type SyncLockHandle,
} from './lib/same-host-sync-lock';
import { checkSubmodulePins, makeRunGit } from './lib/submodulePinAncestry';
import {
  assessDirtySuperproject,
  type DirtySuperprojectAssessment,
} from './lib/submodulePointerLag';
import { partitionUntrackedByCollision } from './lib/untrackedCollision';
import {
  classifyPushFailure,
  decidePushRetry,
  buildRetryLegSpawnPlan,
} from './lib/push-race-retry';
import {
  parsePrepushTimingMarkers,
  type PrepushChildSpan,
} from './lib/prepush-timing-parser';

/** ANSI color codes for terminal output */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
} as const;

/** Exit codes for different failure modes */
const EXIT_CODES = {
  SUCCESS: 0,
  SUBMODULE_UNCOMMITTED: 10,
  SUBMODULE_UNPUSHED: 11,
  SUPERPROJECT_DIRTY: 12,
  MERGE_CONFLICT: 20,
  VALIDATOR_FAILED: 30,
  PUSH_FAILED: 40,
  MERGE_INTEGRITY_FAILED: 15,
  MERGE_INTEGRITY_WARN: 16,
  SUBMODULE_ADVANCEMENT_FAILED: 17,
  DIVERGENCE_UNKNOWN: 18,
  SUBMODULE_PIN_ORPHAN: 19,
  NETWORK_ERROR: 50,
  UNKNOWN_ERROR: 99,
} as const;

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

/** Result of running a git command */
interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

/** State of a single submodule */
interface SubmoduleState {
  name: string;
  path: string;
  hasUncommittedChanges: boolean;
  isOnRemoteBranch: boolean;
  remoteBranches: string[];
  currentCommit: string;
  checkFailed: boolean;
  checkError?: string;
}

/** Overall diagnostic state */
interface DiagnosticState {
  repoRoot: string;
  currentBranch: string;
  remote: string;
  trackingBranch: string | null;
  ahead: number;
  behind: number;
  divergenceError: boolean;
  superprojectDirty: boolean;
  submodules: SubmoduleState[];
  fetchSuccessful: boolean;
}

/** Sync strategy based on divergence */
type SyncStrategy = 'up-to-date' | 'push-only' | 'fast-forward' | 'merge';

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Executes a shell command and captures output.
 * Does NOT throw on failure - returns structured result.
 */
function exec(command: string, options: ExecSyncOptions = {}, timeoutMs?: number): CommandResult {
  try {
    // git-exec-allow: safe-sync shell wrapper preserves structured result semantics
    const output = execSync(command, {
      ...options,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    }) as string; // encoding: 'utf8' guarantees string return
    return { success: true, output: output.trim() };
  } catch (error: unknown) {
    const err = error as {
      status?: number;
      stdout?: Buffer;
      stderr?: Buffer;
      message?: string;
      killed?: boolean;
    };
    return {
      success: false,
      output: err.stdout?.toString().trim() || '',
      error: err.killed
        ? `Command timed out after ${timeoutMs}ms`
        : (err.stderr?.toString().trim() || err.message || 'Unknown error'),
      exitCode: err.status,
    };
  }
}

/**
 * Parses .gitmodules to get submodule paths dynamically.
 * This ensures we handle submodules being added/removed without hardcoding.
 */
function getSubmodulePaths(repoRoot: string): string[] {
  const gitmodulesPath = resolve(repoRoot, '.gitmodules');
  if (!existsSync(gitmodulesPath)) {
    return [];
  }

  const result = exec('git config --file .gitmodules --get-regexp "submodule\\..*\\.path"', {
    cwd: repoRoot,
  });

  if (!result.success) {
    return [];
  }

  // Parse lines like: "submodule.rebel-system.path rebel-system"
  return result.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const spaceIndex = line.indexOf(' ');
      return spaceIndex > 0 ? line.substring(spaceIndex + 1) : '';
    })
    .filter((path) => path.length > 0);
}

/**
 * Gets the name of a submodule from its path (for display purposes).
 */
function getSubmoduleName(submodulePath: string): string {
  return submodulePath.split('/').pop() || submodulePath;
}

// -----------------------------------------------------------------------------
// MAIN COMMAND CLASS
// -----------------------------------------------------------------------------

class GitSafeSyncCommand extends Command {
  // ---------------------------------------------------------------------------
  // CLI CONFIGURATION
  // ---------------------------------------------------------------------------

  static paths = [['git-safe-sync'], ['safe-sync'], Command.Default];

  static usage = Command.Usage({
    description: 'Safely sync project with origin including submodules',
    details: `
      This script safely syncs your local branch with the remote, handling
      submodules correctly to prevent orphaned commits or lost work.

      SAFETY GUARANTEES:
      • Aborts if any submodule has uncommitted changes
      • Aborts if any submodule has unpushed commits (HEAD not on remote)
      • Aborts if superproject is dirty (unless --autostash)
      • Aborts if validators fail (leaves merged-but-unpushed for manual fix)

      WORKFLOW:
      1. Fetch origin (needed for accurate safety checks)
      2. Check submodule safety (uncommitted changes, unpushed commits)
      3. Detect divergence and determine strategy
      4. Merge if needed (non-interactive)
      5. Update submodules
      6. Run validators
      7. Push to origin

      See coding-agent-instructions/docs/GIT_SUBMODULE_HEALTH_CHECK.md for full documentation.
    `,
    examples: [
      ['Basic sync', 'npx tsx scripts/git-safe-sync.ts'],
      ['Preview without executing', 'npx tsx scripts/git-safe-sync.ts --dry-run'],
      ['Check state only', 'npx tsx scripts/git-safe-sync.ts --diagnostics-only'],
      ['Sync but skip push', 'npx tsx scripts/git-safe-sync.ts --no-push'],
      ['Handle dirty superproject', 'npx tsx scripts/git-safe-sync.ts --autostash'],
    ],
  });

  // ---------------------------------------------------------------------------
  // CLI OPTIONS
  // ---------------------------------------------------------------------------

  /** Branch to sync (defaults to current branch) */
  branch = Option.String('--branch', {
    description: 'Branch to sync (default: current branch)',
  });

  /** Remote to sync with */
  remote = Option.String('--remote', 'origin', {
    description: 'Remote to sync with (default: origin)',
  });

  /** Validator command to run before push */
  validatorCommand = Option.String('--validator-command', 'npm run validate:fast', {
    description: 'Validator command to run before push (default: npm run validate:fast)',
  });

  /** Skip push step */
  noPush = Option.Boolean('--no-push', false, {
    description: 'Fetch and merge but do not push',
  });

  /**
   * Opt-in: run validator inside the script.
   *
   * Default is SKIP because the repo's Husky pre-push hook runs the same
   * validator (`npm run validate:fast`) before the actual `git push`. Running
   * it twice is pure duplication (~40s each). If the pre-push hook is missing
   * (detected at runtime), the script falls back to running the validator.
   */
  validate = Option.Boolean('--validate', false, {
    description: 'Run validator in-script (default: skip; pre-push hook validates before push)',
  });

  /**
   * Explicitly skip validator.
   *
   * Retained for backward compatibility. The validator is skipped by default
   * now, so this flag is only meaningful when combined with `--validate` (in
   * which case it wins) or as a no-op self-documenting intent.
   */
  noValidator = Option.Boolean('--no-validator', false, {
    description: 'Explicitly skip validator (default behavior — kept for back-compat)',
    hidden: true,
  });

  /** Stash uncommitted superproject changes */
  autostash = Option.Boolean('--autostash', false, {
    description: 'Stash uncommitted superproject changes before merge',
  });

  /** Show what would happen without executing */
  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Show what would happen without executing',
  });

  /** Just print diagnostic info and exit */
  diagnosticsOnly = Option.Boolean('--diagnostics-only', false, {
    description: 'Just print diagnostic info and exit',
  });

  /** Show detailed output */
  verbose = Option.Boolean('-v,--verbose', false, {
    description: 'Show detailed output',
  });

  /** Skip post-merge integrity check (requires explicit reason — use with caution) */
  skipMergeIntegrity = Option.Boolean('--skip-merge-integrity', false, {
    description: 'Skip post-merge integrity verification (not recommended)',
    hidden: true,
  });

  /** Skip backup branch creation */
  noBackup = Option.Boolean('--no-backup', false, {
    description: 'Skip backup branch creation before merge (not recommended)',
    hidden: true,
  });

  /** Skip submodule advancement to remote HEAD */
  noAdvanceSubmodules = Option.Boolean('--no-advance-submodules', false, {
    description: 'Skip advancing submodules to their remote HEAD (only sync to merged pointers)',
  });

  /** Enable GIT_TRACE_PERFORMANCE=1 on all git child processes */
  traceGit = Option.Boolean('--trace-git', false, {
    description: 'Enable git built-in performance trace (verbose; writes sidecar log next to timing log)',
  });

  /** Disable writing the timing log file (keeps terminal summary) */
  noLog = Option.Boolean('--no-log', false, {
    description: 'Do not write the timing log file (terminal summary still printed)',
  });

  /** Skip the same-host advisory sync lock */
  noLock = Option.Boolean('--no-lock', false, {
    description: 'Skip the same-host advisory sync lock (env: GIT_SAFE_SYNC_NO_LOCK=1)',
  });

  /** Disable the single auto-retry after a lost push race (Stage 7) */
  noRetry = Option.Boolean('--no-retry', false, {
    description:
      'Disable the single automatic retry after a lost push race (env: GIT_SAFE_SYNC_NO_RETRY=1)',
  });

  /**
   * Internal: marks the respawned retry leg after a lost push race. Its ONLY
   * effects are (a) suppressing a further retry (single-retry bound) and
   * (b) tagging the timing log so telemetry can pair the two legs. The leg
   * is otherwise a completely ordinary sync.
   */
  retryLeg = Option.Boolean('--retry-leg', false, {
    description: 'Internal: this run is the respawned retry leg after a lost push race',
    hidden: true,
  });

  /** Track whether integrity WARN should block push */
  private integrityWarnBlocking = false;

  /** Section-level timing recorder (written to Google Drive by default) */
  private timing?: SyncTimingRecorder;

  /** Path to the git-trace sidecar file, if --trace-git used */
  private traceFilePath?: string;

  /** Held same-host advisory sync lock (null until acquired; see Stage 4 plan) */
  private syncLockHandle: SyncLockHandle | null = null;

  /** Guards double-finalize when a signal lands around normal completion */
  private timingFinalized = false;

  /**
   * Set by the push-failure path when a lost push race qualifies for the
   * Stage-7 auto-retry. Consumed by execute() AFTER its finally (lock
   * released, timing log finalized) to respawn a fresh retry leg.
   */
  private pushRetryPlan: { fromTip: string; toTip: string } | null = null;

  // ---------------------------------------------------------------------------
  // OUTPUT HELPERS
  // ---------------------------------------------------------------------------

  private log(message: string, color: string = colors.reset): void {
    this.context.stdout.write(`${color}${message}${colors.reset}\n`);
  }

  private logSection(title: string): void {
    this.log(`\n${'─'.repeat(60)}`, colors.dim);
    this.log(`  ${title}`, colors.bright);
    this.log(`${'─'.repeat(60)}`, colors.dim);
  }

  private logSuccess(message: string): void {
    this.log(`  ✅ ${message}`, colors.green);
  }

  private logWarning(message: string): void {
    this.log(`  ⚠️  ${message}`, colors.yellow);
  }

  private logError(message: string): void {
    this.log(`  ❌ ${message}`, colors.red);
  }

  private logInfo(message: string): void {
    this.log(`  ℹ️  ${message}`, colors.cyan);
  }

  private logVerbose(message: string): void {
    if (this.verbose) {
      this.log(`     ${message}`, colors.dim);
    }
  }

  // ---------------------------------------------------------------------------
  // DIAGNOSTIC GATHERING
  // ---------------------------------------------------------------------------

  /**
   * Navigates to repository root and returns the path.
   * All operations should happen from repo root for consistency.
   */
  private getRepoRoot(): string {
    const result = exec('git rev-parse --show-toplevel');
    if (!result.success) {
      throw new UsageError('Not in a git repository');
    }
    return result.output;
  }

  /**
   * Gets the current branch name.
   */
  private getCurrentBranch(repoRoot: string): string {
    const result = exec('git branch --show-current', { cwd: repoRoot });
    if (!result.success || !result.output) {
      throw new UsageError('Could not determine current branch (detached HEAD?)');
    }
    return result.output;
  }

  /**
   * Gets the tracking branch for the current branch.
   * Returns null if no tracking branch is configured.
   */
  private getTrackingBranch(repoRoot: string, branch: string, remote: string): string | null {
    const result = exec(`git config --get branch.${branch}.merge`, { cwd: repoRoot });
    if (!result.success) {
      return null;
    }
    // Convert refs/heads/dev to dev
    const ref = result.output.replace('refs/heads/', '');
    return `${remote}/${ref}`;
  }

  /**
   * Fetches from remote to ensure we have accurate refs.
   * This MUST happen before checking if submodule commits are on remote branches.
   *
   * Uses `git fetch --recurse-submodules=yes --jobs=N` to fetch the
   * superproject AND all submodules in parallel. This replaces the previous
   * approach of fetching the superproject first and then iterating submodules
   * sequentially — a measurable win when there are multiple submodules on a
   * slower link. Safety is unchanged: we still fetch every submodule, we just
   * do it concurrently.
   *
   * If the parallel fetch fails for any reason (old Git, transient network
   * error, protocol issue) we fall back to the original sequential path so
   * the safety checks never run against a stale ref cache.
   */
  private fetchRemote(repoRoot: string, remote: string): boolean {
    this.logInfo(`Fetching from ${remote} (submodules in parallel)...`);

    const submodulePaths = getSubmodulePaths(repoRoot);
    if (submodulePaths.length === 0 && existsSync(resolve(repoRoot, '.gitmodules'))) {
      this.logWarning('Found .gitmodules but no submodule paths — possible parse error');
    }
    // Cap jobs at submodule count (Git treats --jobs=0 as default). Minimum 1.
    const jobs = Math.max(1, submodulePaths.length);

    const parallelResult = exec(
      `git fetch --recurse-submodules=yes --jobs=${jobs} ${remote}`,
      { cwd: repoRoot },
    );

    if (parallelResult.success) {
      this.logSuccess('Fetch complete');
      return true;
    }

    // Fallback: previous sequential behavior. Rare, but preserves safety
    // guarantees on old Git versions or protocol failures.
    this.logWarning(`Parallel fetch failed (${parallelResult.error || 'unknown'}) — falling back to sequential`);

    const superResult = exec(`git fetch ${remote}`, { cwd: repoRoot });
    if (!superResult.success) {
      this.logWarning(`Could not fetch superproject: ${superResult.error}`);
      return false;
    }

    for (const subPath of submodulePaths) {
      const fullPath = resolve(repoRoot, subPath);
      if (existsSync(fullPath)) {
        const subResult = exec('git fetch --quiet', { cwd: fullPath });
        if (!subResult.success) {
          this.logWarning(`Could not fetch ${getSubmoduleName(subPath)}: ${subResult.error}`);
        }
      }
    }

    this.logSuccess('Fetch complete (sequential fallback)');
    return true;
  }

  /**
   * Checks if the superproject working tree is dirty.
   */
  private isSuperprojectDirty(repoRoot: string): boolean {
    const result = exec('git status --porcelain', { cwd: repoRoot });
    return result.success && result.output.length > 0;
  }

  /**
   * Paths the incoming merge would write — files changed on the tracking branch
   * since our merge-base (three-dot diff). An untracked working-tree file at one
   * of these paths is the one case where `git merge` refuses to proceed
   * ("untracked working tree files would be overwritten"), so it's the only
   * untracked dirt git-safe-sync must still treat as blocking.
   *
   * Returns `null` if the set can't be computed — callers MUST fail closed
   * (treat every untracked file as potentially colliding) rather than risk a
   * clobber.
   *
   * Surrounding quotes (git quotes paths with special/non-ASCII bytes under the
   * default `core.quotePath`) are stripped to match `parsePorcelain`'s handling
   * of the untracked-path side — both git commands use identical quoting, so
   * stripping the wrapper on both yields comparable strings.
   */
  private getIncomingChangedPaths(repoRoot: string, trackingBranch: string): Set<string> | null {
    const result = exec(`git diff --name-only HEAD...${trackingBranch}`, { cwd: repoRoot });
    if (!result.success) {
      return null;
    }
    return new Set(
      result.output
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((p) => (p.startsWith('"') && p.endsWith('"') && p.length >= 2 ? p.slice(1, -1) : p)),
    );
  }

  /**
   * Gets the state of a single submodule.
   * Checks for uncommitted changes and whether HEAD is on any remote branch.
   *
   * @param repoRoot - The root of the superproject
   * @param subPath - The relative path to the submodule
   * @param remote - The remote to filter branches by (e.g., 'origin')
   */
  private getSubmoduleState(repoRoot: string, subPath: string, remote: string): SubmoduleState {
    const name = getSubmoduleName(subPath);
    const fullPath = resolve(repoRoot, subPath);

    const state: SubmoduleState = {
      name,
      path: subPath,
      hasUncommittedChanges: false,
      isOnRemoteBranch: false,
      remoteBranches: [],
      currentCommit: '',
      checkFailed: false,
    };

    // Check if submodule is initialized
    if (!existsSync(resolve(fullPath, '.git'))) {
      state.checkFailed = true;
      state.checkError = 'Submodule not initialized';
      return state;
    }

    // Get current commit
    const commitResult = exec('git rev-parse --short HEAD', { cwd: fullPath });
    if (commitResult.success) {
      state.currentCommit = commitResult.output;
    }

    // Check for uncommitted changes
    const statusResult = exec('git status --porcelain', { cwd: fullPath });
    if (statusResult.success) {
      state.hasUncommittedChanges = statusResult.output.length > 0;
    } else {
      state.checkFailed = true;
      state.checkError = 'Could not check status';
      return state;
    }

    // Check if HEAD is on any remote branch FOR THE SPECIFIED REMOTE
    // This is the CRITICAL safety check - if HEAD is not on a remote branch,
    // the submodule has unpushed commits that could become orphaned
    //
    // We filter to only consider the specified remote (e.g., 'origin/') to avoid
    // false positives from other remotes the user may have configured
    const branchResult = exec('git branch -r --contains HEAD', { cwd: fullPath });
    if (branchResult.success) {
      state.remoteBranches = branchResult.output
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b.length > 0)
        .filter((b) => b.startsWith(`${remote}/`)); // Filter to specified remote only
      state.isOnRemoteBranch = state.remoteBranches.length > 0;
    } else {
      // This can happen if the commit is not on any remote branch
      state.isOnRemoteBranch = false;
      state.remoteBranches = [];
    }

    return state;
  }

  /**
   * Calculates how many commits we are ahead/behind the tracking branch.
   */
  private getAheadBehind(
    repoRoot: string,
    trackingBranch: string
  ): { ahead: number; behind: number; error?: boolean } {
    const result = exec(`git rev-list --left-right --count HEAD...${trackingBranch}`, {
      cwd: repoRoot,
    });

    if (!result.success) {
      return { ahead: 0, behind: 0, error: true };
    }

    const [ahead, behind] = result.output.split('\t').map((n) => parseInt(n, 10));
    return { ahead: ahead || 0, behind: behind || 0 };
  }

  /**
   * Gathers complete diagnostic state of the repository.
   *
   * When `fetch` is true (default), performs a network fetch first so remote
   * refs are fresh. When false, trusts the current ref cache — useful for
   * post-push final verification where a fetch would be wasted round-trips.
   */
  private gatherDiagnostics(repoRoot: string, fetch: boolean = true): DiagnosticState {
    const currentBranch = this.branch || this.getCurrentBranch(repoRoot);
    const remote = this.remote;
    const trackingBranch = this.getTrackingBranch(repoRoot, currentBranch, remote);

    // Fetch first - needed for accurate remote branch checks
    const fetchSuccessful = fetch ? this.fetchRemote(repoRoot, remote) : true;

    // Check superproject state
    const superprojectDirty = this.isSuperprojectDirty(repoRoot);

    // Check all submodules (pass remote so we filter to the correct origin)
    const submodulePaths = getSubmodulePaths(repoRoot);
    if (submodulePaths.length === 0 && existsSync(resolve(repoRoot, '.gitmodules'))) {
      this.logWarning('Found .gitmodules but no submodule paths — possible parse error');
    }
    const submodules = submodulePaths.map((path) => this.getSubmoduleState(repoRoot, path, remote));

    // Calculate divergence
    const divergence = trackingBranch
      ? this.getAheadBehind(repoRoot, trackingBranch)
      : { ahead: 0, behind: 0 };
    const ahead = divergence.ahead;
    const behind = divergence.behind;

    return {
      repoRoot,
      currentBranch,
      remote,
      trackingBranch,
      ahead,
      behind,
      divergenceError: 'error' in divergence && !!divergence.error,
      superprojectDirty,
      submodules,
      fetchSuccessful,
    };
  }

  // ---------------------------------------------------------------------------
  // DIAGNOSTIC DISPLAY
  // ---------------------------------------------------------------------------

  /**
   * Prints the diagnostic state in a human-readable format.
   */
  private printDiagnostics(state: DiagnosticState): void {
    this.logSection('Repository State');

    // CRITICAL: Warn if fetch failed - safety checks may be inaccurate
    if (!state.fetchSuccessful) {
      this.logWarning('NETWORK FETCH FAILED - Safety checks running against local cache');
      this.log('  Remote branch information may be stale.', colors.yellow);
      this.log('  If in doubt, fix network and retry.\n', colors.yellow);
    }

    this.log(`  Branch: ${state.currentBranch}`, colors.cyan);
    this.log(`  Remote: ${state.remote}`, colors.cyan);
    this.log(
      `  Tracking: ${state.trackingBranch || '(no tracking branch)'}`,
      state.trackingBranch ? colors.cyan : colors.yellow
    );

    // Divergence - but only meaningful if we have a tracking branch
    if (!state.trackingBranch) {
      this.logWarning('No tracking branch configured - cannot determine sync state');
      this.log('  Set upstream with: git branch --set-upstream-to=origin/<branch>', colors.cyan);
    } else if (state.ahead === 0 && state.behind === 0) {
      this.logSuccess('Up to date with remote');
    } else {
      if (state.ahead > 0) {
        this.logInfo(`${state.ahead} commit(s) ahead of remote`);
      }
      if (state.behind > 0) {
        this.logWarning(`${state.behind} commit(s) behind remote`);
      }
    }

    // Superproject state
    if (state.superprojectDirty) {
      this.logWarning('Superproject has uncommitted changes');
    } else {
      this.logSuccess('Superproject working tree is clean');
    }

    // Submodule states
    this.logSection('Submodule Safety Check');

    if (state.submodules.length === 0) {
      this.logInfo('No submodules found');
    } else {
      for (const sub of state.submodules) {
        this.log(`\n  📦 ${sub.name} (${sub.currentCommit || 'unknown'})`, colors.bright);

        if (sub.checkFailed) {
          this.logWarning(`Check failed: ${sub.checkError}`);
          continue;
        }

        // Uncommitted changes
        if (sub.hasUncommittedChanges) {
          this.logError('Has uncommitted changes - UNSAFE');
        } else {
          this.logSuccess('No uncommitted changes');
        }

        // Remote branch check
        if (sub.isOnRemoteBranch) {
          this.logSuccess(`HEAD is on remote: ${sub.remoteBranches.join(', ')}`);
        } else {
          this.logError('HEAD is NOT on any remote branch - UNPUSHED COMMITS');
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // AUTO-RESOLUTION
  // ---------------------------------------------------------------------------

  /**
   * Identifies submodules eligible for auto-push (preflight only, no side effects).
   * A submodule is eligible if:
   *   - It has unpushed commits (not on any remote branch)
   *   - No uncommitted changes
   *   - Its current branch matches the expected remote branch (.gitmodules or 'main')
   *
   * Returns a list of { sub, targetBranch } for submodules that should be pushed.
   * Submodules on unexpected branches (e.g., feature branches) are NOT eligible —
   * the safety check will catch them and require manual resolution.
   */
  private identifyAutoResolvableSubmodules(
    repoRoot: string,
    state: DiagnosticState,
  ): Array<{ sub: SubmoduleState; targetBranch: string }> {
    const eligible: Array<{ sub: SubmoduleState; targetBranch: string }> = [];

    for (const sub of state.submodules) {
      if (sub.isOnRemoteBranch || sub.checkFailed || sub.hasUncommittedChanges) continue;

      const fullPath = resolve(repoRoot, sub.path);

      // Determine expected branch from .gitmodules config, fallback to 'main'
      const configResult = exec(
        `git config -f .gitmodules submodule.${sub.path}.branch`,
        { cwd: repoRoot },
      );
      const expectedBranch =
        configResult.success && configResult.output ? configResult.output : 'main';

      // Check the submodule's current local branch
      const branchResult = exec('git branch --show-current', { cwd: fullPath });
      const currentBranch = branchResult.success ? branchResult.output : '';

      // Only auto-push if current branch matches the expected branch, OR if
      // in detached HEAD (typical after git submodule update). Detached HEAD
      // is safe because the commits were created for the expected branch.
      if (currentBranch && currentBranch !== expectedBranch) {
        this.logVerbose(
          `${sub.name}: on branch '${currentBranch}' (expected '${expectedBranch}') — skipping auto-push`,
        );
        continue;
      }

      eligible.push({ sub, targetBranch: expectedBranch });
    }

    return eligible;
  }

  /**
   * Pushes auto-resolvable submodules to their remote branches.
   * Called AFTER all other safety checks pass — no irreversible side effects during preflight.
   */
  private pushAutoResolvableSubmodules(
    repoRoot: string,
    state: DiagnosticState,
    eligible: Array<{ sub: SubmoduleState; targetBranch: string }>,
  ): { pushed: string[]; failed: string[] } {
    const pushed: string[] = [];
    const failed: string[] = [];

    for (const { sub, targetBranch } of eligible) {
      const fullPath = resolve(repoRoot, sub.path);

      this.logInfo(`Auto-pushing ${sub.name} to ${state.remote}/${targetBranch}...`);

      const pushResult = exec(
        `git push ${state.remote} HEAD:${targetBranch}`,
        { cwd: fullPath },
      );

      if (pushResult.success) {
        this.logSuccess(`${sub.name}: pushed to ${state.remote}/${targetBranch}`);
        pushed.push(sub.name);
        sub.isOnRemoteBranch = true;
        sub.remoteBranches = [`${state.remote}/${targetBranch}`];
      } else {
        const reason = pushResult.error?.includes('non-fast-forward')
          ? 'non-fast-forward (remote has diverged)'
          : (pushResult.error || 'unknown error');
        this.logError(`${sub.name}: auto-push failed — ${reason}`);
        failed.push(sub.name);
      }
    }

    return { pushed, failed };
  }

  // ---------------------------------------------------------------------------
  // SAFETY CHECKS
  // ---------------------------------------------------------------------------

  /**
   * Determines the sync strategy based on the diagnostic state.
   */
  private determineSyncStrategy(state: DiagnosticState): SyncStrategy {
    if (state.ahead === 0 && state.behind === 0) {
      return 'up-to-date';
    } else if (state.ahead > 0 && state.behind === 0) {
      return 'push-only';
    } else if (state.ahead === 0 && state.behind > 0) {
      return 'fast-forward';
    } else {
      return 'merge';
    }
  }

  /**
   * Checks if it's safe to proceed with the sync.
   * Returns true if safe, throws UsageError with guidance if not.
   *
   * @param state - Diagnostic state to check
   * @param autoResolvableNames - Submodule names that will be auto-pushed after
   *   safety check passes. These are excluded from the unpushed-commits error.
   * @param dirtyAssessment - Per-entry classification of the dirty superproject
   *   (Stage 6). When submodule-shaped entries are present, the copy must
   *   distinguish checkout-lag from genuine changes: a bare "commit your
   *   changes" on a lagging gitlink invites committing a PIN REGRESSION.
   */
  private checkSafety(
    state: DiagnosticState,
    autoResolvableNames?: Set<string>,
    dirtyAssessment?: DirtySuperprojectAssessment | null,
  ): void {
    const errors: string[] = [];
    const recovery: string[] = [];
    const autoResolvable = autoResolvableNames ?? new Set<string>();

    // Check superproject
    if (state.superprojectDirty && !this.autostash) {
      const classified = dirtyAssessment?.entries ?? [];
      const lagEntries = classified.filter((e) => e.kind === 'alignable-pointer-lag');
      const blockedSubs = classified.filter((e) => e.kind === 'submodule-blocked');
      const otherEntries = classified.filter((e) => e.kind === 'other');
      const untrackedEntries = classified.filter((e) => e.kind === 'untracked');

      // Untracked files are inert to merge/pull/push EXCEPT a collision with an
      // incoming change (git refuses to overwrite). Tolerate the non-colliding
      // case: the sync proceeds with those files left in place — no abort, no
      // autostash. This is the by-construction fix for the scratch-file class
      // (e.g. triage logs) that otherwise forces the race-prone --autostash in a
      // multi-agent checkout. Fail closed: if the incoming set can't be computed
      // — including a missing tracking branch — treat every untracked file as
      // colliding (blocking). Prefix/dir-aware matching lives in
      // partitionUntrackedByCollision (porcelain collapses untracked dirs to
      // `dir/`, so exact equality is not enough).
      let incoming: Set<string> | null = new Set<string>();
      if (untrackedEntries.length > 0) {
        incoming = state.trackingBranch
          ? this.getIncomingChangedPaths(state.repoRoot, state.trackingBranch)
          : null;
      }
      const { tolerable: tolerableUntracked, colliding: collidingUntracked } =
        partitionUntrackedByCollision(
          untrackedEntries.map((e) => e.path),
          incoming,
        );

      const hasBlockingSuperprojectDirt =
        classified.length === 0 ||
        lagEntries.length > 0 ||
        blockedSubs.length > 0 ||
        collidingUntracked.length > 0 ||
        otherEntries.length > 0;

      // Only announce tolerance when these untracked files are the ONLY
      // superproject dirt — otherwise the run is about to abort and "Proceeding"
      // would be misleading.
      if (tolerableUntracked.length > 0 && !hasBlockingSuperprojectDirt) {
        this.logInfo(
          `Proceeding with ${tolerableUntracked.length} untracked file(s) left in place (no collision with incoming changes): ${tolerableUntracked.join(
            ', ',
          )}`,
        );
      }

      if (classified.length === 0) {
        // Classification unavailable but porcelain was non-empty — never tolerate
        // dirt we couldn't inspect.
        errors.push('Superproject has uncommitted changes');
        recovery.push('Commit your changes, or use --autostash to stash them');
      } else {
        for (const e of lagEntries) {
          errors.push(`${e.path}: submodule checkout lags the committed pin — NOT real changes; do NOT commit this`);
          recovery.push(e.recovery);
        }
        for (const e of blockedSubs) {
          errors.push(`${e.path}: ${e.reason}`);
          recovery.push(e.recovery);
        }
        for (const path of collidingUntracked) {
          errors.push(`${path}: untracked file would be overwritten by the incoming merge`);
          recovery.push(`Commit, move, or gitignore ${path} (or rerun with --autostash), then re-run`);
        }
        if (otherEntries.length > 0) {
          errors.push(`Superproject has ${otherEntries.length} genuinely uncommitted file change(s)`);
          recovery.push('Commit those changes, or use --autostash to stash them');
        }
      }
    }

    // Check submodules
    for (const sub of state.submodules) {
      if (sub.checkFailed) {
        errors.push(`${sub.name}: Could not verify safety (${sub.checkError})`);
        recovery.push(`Initialize submodule: git submodule update --init ${sub.path}`);
        continue;
      }

      if (sub.hasUncommittedChanges) {
        errors.push(`${sub.name}: Has uncommitted changes`);
        recovery.push(`cd ${sub.path} && git add -A && git commit -m "your message"`);
      }

      if (!sub.isOnRemoteBranch && !autoResolvable.has(sub.name)) {
        errors.push(`${sub.name}: Has unpushed commits (HEAD not on any remote branch)`);
        recovery.push(
          `cd ${sub.path} && git push origin HEAD:<target-branch>  # typically 'main'`
        );
      }
    }

    if (errors.length > 0) {
      this.logSection('SAFETY CHECK FAILED');

      for (const error of errors) {
        this.logError(error);
      }

      this.log('\n  Recovery steps:', colors.yellow);
      for (let i = 0; i < recovery.length; i++) {
        this.log(`  ${i + 1}. ${recovery[i]}`, colors.cyan);
      }

      this.log('\n  After fixing, run this script again.', colors.yellow);
      this.log('  See: coding-agent-instructions/docs/GIT_SUBMODULE_HEALTH_CHECK.md\n', colors.dim);

      throw new UsageError('Safety check failed - see errors above');
    }
  }

  // ---------------------------------------------------------------------------
  // SYNC OPERATIONS
  // ---------------------------------------------------------------------------

  /**
   * Stashes uncommitted changes in the superproject.
   * Includes untracked files (-u) to ensure a clean working tree.
   *
   * Tags the stash with a per-run nonce in its message; the nonce — NOT a
   * position (`stash@{0}`) — is how the restore (popStash) re-identifies this
   * exact stash, so a concurrent stash landing on the shared stack can never
   * redirect our restore onto a peer's work.
   *
   * @returns Object with:
   *   - stashed: true if stash was created
   *   - failed: true if stash command failed (distinct from "nothing to stash")
   *   - error: error message if failed
   *   - nonce: the message marker to pass to popStash (present iff stashed)
   */
  private stashChanges(repoRoot: string): { stashed: boolean; failed: boolean; error?: string; nonce?: string } {
    // pid+timestamp is unique enough for the same-host window the sync lock
    // can't fully cover (e.g. a manual `git stash` by a human mid-sync).
    const nonce = `gss-${process.pid}-${Date.now()}`;
    // Use -u to include untracked files - otherwise new files would be left behind
    const result = exec(`git stash push -u -m "git-safe-sync autostash ${nonce}"`, { cwd: repoRoot });

    if (!result.success) {
      // Stash command failed (not the same as "nothing to stash")
      return { stashed: false, failed: true, error: result.error };
    }

    // "No local changes to save" means nothing was stashed (success, not failure)
    const stashed = !result.output.includes('No local changes');
    if (!stashed) {
      return { stashed: false, failed: false };
    }

    return { stashed: true, failed: false, nonce };
  }

  /**
   * Restores the autostash created by stashChanges, identified by its `nonce`.
   *
   * Resolves the nonce → stash SHA from `git stash list` and restores via
   * `git stash apply <sha>` (restores tracked + `-u` untracked parts, paths/
   * modes intact). Two deliberate safety choices, both motivated by the
   * multi-agent shared stash stack:
   *   - Identify by nonce, never by position — a peer stash at `stash@{0}`
   *     can't be mistaken for ours.
   *   - Apply, then DO NOT drop. `git stash drop` is index-addressed and git
   *     has no atomic drop-by-identity, so any drop carries a TOCTOU risk of
   *     removing a *peer's* entry (pushing them into fsck-recovery — the exact
   *     failure this whole change exists to prevent). We leave our applied
   *     entry on the stack instead; it's clearly labelled and cheap to clear.
   *
   * Fails CLOSED: a missing nonce, a failed list, or a not-found entry returns
   * `{ ok: false }` rather than blind-popping `stash@{0}` (which could restore a
   * peer's stash). Returns the resolved sha when found so the caller can print
   * an exact recovery hint.
   */
  private popStash(repoRoot: string, nonce?: string | null): { ok: boolean; sha?: string } {
    if (!nonce) {
      return { ok: false };
    }
    const list = exec('git stash list --format="%H %gs"', { cwd: repoRoot });
    if (!list.success) {
      return { ok: false };
    }
    let sha: string | undefined;
    for (const line of list.output.split('\n')) {
      const idx = line.indexOf(' ');
      if (idx < 0) continue;
      const hash = line.slice(0, idx);
      const subject = line.slice(idx + 1);
      if (subject.includes(nonce)) {
        sha = hash;
        break;
      }
    }
    if (!sha) {
      return { ok: false };
    }
    const applyResult = exec(`git stash apply ${sha}`, { cwd: repoRoot });
    if (!applyResult.success) {
      return { ok: false, sha };
    }
    // Intentionally NOT dropping (see doc comment) — leave our labelled entry.
    this.logInfo(`Left the autostash entry on the stack for safety; clear later with: git stash drop ${sha}`);
    return { ok: true, sha };
  }

  /**
   * Performs the merge operation.
   * Uses --no-edit to avoid interactive editor prompts.
   */
  private performMerge(
    repoRoot: string,
    trackingBranch: string
  ): { success: boolean; hasConflicts: boolean } {
    const result = exec(`git merge --no-edit ${trackingBranch}`, { cwd: repoRoot });

    if (result.success) {
      return { success: true, hasConflicts: false };
    }

    // Check if it's a merge conflict using porcelain format (locale-independent)
    // Porcelain status codes for conflicts:
    //   U = unmerged
    //   AA = both added
    //   DD = both deleted
    //   UU = both modified
    //   AU/UA = added by us/them
    //   DU/UD = deleted by us/them
    const conflictState = this.hasGitConflicts(repoRoot);
    return { success: false, hasConflicts: conflictState === 'yes' };
  }

  /**
   * Checks if there are unmerged paths (conflicts) using porcelain format.
   * This is locale-independent and more reliable than parsing human-readable output.
   */
  private hasGitConflicts(repoRoot: string): 'yes' | 'no' | 'unknown' {
    const statusResult = exec('git status --porcelain', { cwd: repoRoot });
    if (!statusResult.success) {
      return 'unknown';
    }

    const hasConflicts = statusResult.output.split('\n').some((line) => {
      if (line.length < 2) return false;
      const xy = line.substring(0, 2);
      // Check for any conflict markers:
      // - Contains 'U' (unmerged)
      // - 'AA' (both added)
      // - 'DD' (both deleted)
      return xy.includes('U') || xy === 'AA' || xy === 'DD';
    });

    return hasConflicts ? 'yes' : 'no';
  }

  /**
   * Creates a backup branch before potentially destructive merge operations.
   * Branch name format: backup/<branch>/<YYYYMMDD-HHmmss>-<shortsha>
   * Returns the backup branch name on success, null on failure.
   */
  private createBackupBranch(repoRoot: string, currentBranch: string): string | null {
    const shortSha = exec('git rev-parse --short HEAD', { cwd: repoRoot });
    if (!shortSha.success) return null;

    const now = new Date();
    const timestamp = [
      now.getFullYear().toString(),
      (now.getMonth() + 1).toString().padStart(2, '0'),
      now.getDate().toString().padStart(2, '0'),
      '-',
      now.getHours().toString().padStart(2, '0'),
      now.getMinutes().toString().padStart(2, '0'),
      now.getSeconds().toString().padStart(2, '0'),
    ].join('');

    const backupName = `backup/${currentBranch}/${timestamp}-${shortSha.output}`;
    const result = exec(`git branch ${backupName}`, { cwd: repoRoot });

    if (!result.success) {
      return null;
    }

    return backupName;
  }

  /**
   * Prunes old backup branches, keeping the most recent N per base branch.
   * Only prunes refs under backup/<currentBranch>/.
   */
  private pruneBackupBranches(repoRoot: string, currentBranch: string, keepCount: number = 10): void {
    const prefix = `backup/${currentBranch}/`;
    const result = exec(`git branch --list "${prefix}*"`, { cwd: repoRoot });
    if (!result.success || !result.output) return;

    const branches = result.output
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0)
      .sort(); // Lexicographic sort works because timestamps are YYYYMMDD-HHmmss

    if (branches.length <= keepCount) return;

    const toDelete = branches.slice(0, branches.length - keepCount);
    for (const branch of toDelete) {
      const deleteResult = exec(`git branch -D ${branch}`, { cwd: repoRoot });
      if (deleteResult.success) {
        this.logVerbose(`Pruned old backup: ${branch}`);
      }
    }

    if (toDelete.length > 0) {
      this.logInfo(`Pruned ${toDelete.length} old backup branch(es)`);
    }
  }

  /**
   * Updates submodules to match the current superproject state.
   */
  private updateSubmodules(repoRoot: string): boolean {
    const result = exec('git submodule update --init --recursive', { cwd: repoRoot });
    return result.success;
  }

  /**
   * Syncs submodule URLs from .gitmodules to .git/config.
   * Must run after merge (which may change .gitmodules) and before submodule update.
   */
  private syncSubmodules(repoRoot: string): boolean {
    const result = exec('git submodule sync --recursive', { cwd: repoRoot });
    return result.success;
  }

  /**
   * Checks out each submodule onto its configured tracking branch.
   * This is required before --remote --merge to avoid creating detached HEAD merge commits.
   * Uses .gitmodules branch config (set in Stage 2), falls back to 'main'.
   */
  private checkoutSubmoduleBranches(repoRoot: string): { success: boolean; errors: string[] } {
    const submodulePaths = getSubmodulePaths(repoRoot);
    const errors: string[] = [];

    for (const subPath of submodulePaths) {
      const fullPath = resolve(repoRoot, subPath);
      const name = getSubmoduleName(subPath);

      if (!existsSync(resolve(fullPath, '.git'))) {
        errors.push(`${name}: not initialized`);
        continue;
      }

      // Get configured branch from .gitmodules, fallback to 'main'
      const branchResult = exec(`git config -f .gitmodules submodule.${subPath}.branch`, {
        cwd: repoRoot,
      });
      const targetBranch = branchResult.success && branchResult.output ? branchResult.output : 'main';

      // Check for uncommitted changes before checkout
      const statusResult = exec('git status --porcelain', { cwd: fullPath });
      if (statusResult.success && statusResult.output.length > 0) {
        errors.push(`${name}: has uncommitted changes — cannot checkout branch`);
        continue;
      }

      // Checkout the tracking branch
      const checkoutResult = exec(`git checkout ${targetBranch}`, { cwd: fullPath });
      if (!checkoutResult.success) {
        // Try creating a local tracking branch from the remote
        const createResult = exec(`git checkout -b ${targetBranch} origin/${targetBranch}`, {
          cwd: fullPath,
        });
        if (!createResult.success) {
          errors.push(`${name}: could not checkout ${targetBranch} — ${createResult.error}`);
        }
      }
    }

    return { success: errors.length === 0, errors };
  }

  /**
   * Advances submodules to their remote HEAD using git submodule update --remote --merge.
   * Returns info about which submodules were advanced.
   */
  private advanceSubmodules(repoRoot: string): {
    success: boolean;
    advanced: Array<{ name: string; path: string; fromSha: string; toSha: string }>;
    error?: string;
  } {
    const submodulePaths = getSubmodulePaths(repoRoot);
    const advanced: Array<{ name: string; path: string; fromSha: string; toSha: string }> = [];

    // Record current SHAs before advancement
    const beforeShas: Record<string, string> = {};
    for (const subPath of submodulePaths) {
      const fullPath = resolve(repoRoot, subPath);
      const sha = exec('git rev-parse --short HEAD', { cwd: fullPath });
      if (sha.success) {
        beforeShas[subPath] = sha.output;
      }
    }

    // Run advancement in parallel. `git submodule update --remote --merge`
    // performs a fetch-then-merge per submodule; the --jobs flag parallelises
    // only the fetch phase, not the merge, which is what we want here — we
    // still process merges sequentially (so a merge conflict in one submodule
    // can't corrupt another mid-flight).
    const advanceJobs = Math.max(1, submodulePaths.length);
    const result = exec(
      `git submodule update --remote --merge --jobs=${advanceJobs}`,
      { cwd: repoRoot },
    );

    if (!result.success) {
      // Restore submodules to pre-advancement state
      for (const subPath of submodulePaths) {
        if (beforeShas[subPath]) {
          const fullPath = resolve(repoRoot, subPath);
          exec(`git checkout ${beforeShas[subPath]}`, { cwd: fullPath });
        }
      }
      return {
        success: false,
        advanced: [],
        error: result.error || 'git submodule update --remote --merge failed',
      };
    }

    // Detect which submodules actually changed
    for (const subPath of submodulePaths) {
      const fullPath = resolve(repoRoot, subPath);
      const afterSha = exec('git rev-parse --short HEAD', { cwd: fullPath });
      if (afterSha.success && beforeShas[subPath] && afterSha.output !== beforeShas[subPath]) {
        advanced.push({
          name: getSubmoduleName(subPath),
          path: subPath,
          fromSha: beforeShas[subPath],
          toSha: afterSha.output,
        });
      }
    }

    return { success: true, advanced };
  }

  /**
   * Creates a separate commit for submodule pointer updates after advancement.
   */
  private createPointerCommit(
    repoRoot: string,
    advanced: Array<{ name: string; path: string; fromSha: string; toSha: string }>
  ): boolean {
    if (advanced.length === 0) return true;

    // Stage submodule paths
    const paths = advanced.map((a) => a.path).join(' ');
    const stageResult = exec(`git add ${paths}`, { cwd: repoRoot });
    if (!stageResult.success) return false;

    // Check if there are actually staged changes
    const diffResult = exec('git diff --cached --quiet', { cwd: repoRoot });
    if (diffResult.success) {
      // No changes to commit (diff --quiet exits 0 if no diff)
      return true;
    }

    // Build descriptive commit message
    const changes = advanced.map((a) => `${a.name} (${a.fromSha}→${a.toSha})`).join(', ');
    const message = `chore(submodules): advance ${changes}`;

    const commitResult = exec(`git commit -m "${message}"`, { cwd: repoRoot });
    return commitResult.success;
  }

  /**
   * By-construction guard against the "submodule pin orphan" regression class
   * (see docs/postmortems/260603_supermcp_bulk_export_submodule_pin_orphan_postmortem.md
   * and the Submodule Pin Policy in docs/project/PROJECT_OVERRIDES2.md): refuse to
   * push the superproject if any submodule's recorded pin is not reachable from its
   * `.gitmodules` tracked branch (`origin/<branch>`). Both DIVERGED and AHEAD pins
   * fail — an "ahead" pin (a commit built on the branch but not yet landed on it) is
   * exactly the shape that lost bulk_export.
   *
   * Runs AFTER auto-push + advancement, so a legitimate in-flight submodule commit
   * has already reached its tracked branch and verifies as OK. It is ONLINE
   * (fetches each tracked branch first) so it does not skip on a merely-stale ref;
   * it skips only if a submodule genuinely can't be verified (clone absent / fetch
   * impossible), which the offline validate:fast gate also covers at pre-push.
   * Returns true if safe to push.
   */
  private enforceSubmodulePinsOnTrackedBranch(repoRoot: string): boolean {
    const outcomes = checkSubmodulePins(makeRunGit(repoRoot), { fetch: true });
    if (outcomes.length === 0) return true; // no submodules

    const failures = outcomes.filter((o) => o.status === 'fail');
    for (const o of outcomes) {
      if (o.status === 'ok') {
        this.logSuccess(`${o.path}: pin is on origin/${o.branch}`);
      } else if (o.status === 'skip') {
        this.logWarning(`${o.path}: ${o.reason}`);
      } else {
        this.logError(`${o.path}: ${o.reason}`);
      }
    }
    if (failures.length > 0) {
      this.log(
        '\n  Refusing to push: a submodule pin is not on its tracked branch and would be',
        colors.yellow,
      );
      this.log('  silently orphaned by a future pointer re-align. Land the submodule commit on', colors.yellow);
      this.log('  its tracked branch (push it / merge it), then re-run the sync.\n', colors.yellow);
    }
    return failures.length === 0;
  }

  /**
   * Runs the configured validator command.
   */
  private runValidator(repoRoot: string): boolean {
    this.logInfo(`Running validator: ${this.validatorCommand}`);
    const result = exec(this.validatorCommand, { cwd: repoRoot });
    return result.success;
  }

  /**
   * Detects whether a working `pre-push` hook is installed.
   *
   * This is how we decide whether it's safe to skip in-script validation:
   * the hook runs `npm run validate:fast` before `git push`, so if it's
   * present we can rely on it as the pre-push validation gate.
   *
   * Checks both Husky's conventional location (`.husky/pre-push`) and the
   * configured `core.hooksPath` (or default `.git/hooks/pre-push`). A file
   * at either location counts — Husky's `_/pre-push` wrapper dispatches to
   * the real `.husky/pre-push` script.
   */
  private hasPrePushHook(repoRoot: string): boolean {
    const huskyHook = resolve(repoRoot, '.husky/pre-push');
    if (existsSync(huskyHook)) return true;

    const hooksPathResult = exec('git config --get core.hooksPath', { cwd: repoRoot });
    const hooksDir =
      hooksPathResult.success && hooksPathResult.output
        ? hooksPathResult.output
        : '.git/hooks';
    const hookFile = resolve(repoRoot, hooksDir, 'pre-push');
    return existsSync(hookFile);
  }

  /**
   * Pushes to remote with --recurse-submodules=on-demand.
   * This ensures submodule commits are pushed before the superproject.
   *
   * Uses `spawnSync` (rather than the shared `exec()` helper) so we can:
   *   1. Capture both stdout and stderr on success. The stock `exec()` only
   *      returns stdout and discards stderr, which hides ~30-60s of pre-push
   *      hook output on a successful push.
   *   2. Parse per-phase timing markers emitted by the hook to stderr and
   *      record each phase as a child span (`push:validate-fast`, etc.) in
   *      the JSON log. See `parsePrepushTimingMarkers` above for the wire
   *      protocol.
   *
   * Returns the cleaned stderr (markers stripped) and child spans so the
   * caller can replay the output to the user and append the spans under
   * their existing `push` span.
   */
  private pushToRemote(
    repoRoot: string,
    remote: string,
    branch: string,
  ): {
    success: boolean;
    stdout: string;
    cleanedStderr: string;
    childSpans: PrepushChildSpan[];
    parseNotes: string[];
  } {
    // Capture the perf/wall anchor IMMEDIATELY before spawn. The hook's
    // timing markers are in epoch seconds; converting them to the recorder's
    // performance.now() timebase requires this pair. Any clock adjustment
    // between here and hook completion would skew the child spans — not
    // an acceptable mode in practice on developer machines.
    const perfAnchorMs = this.timing?.nowMs() ?? performance.now();
    const wallAnchorSec = Math.floor(Date.now() / 1000);

    // git-exec-allow: safe-sync push captures hook stderr markers with explicit buffer cap
    const result = spawnSync(
      'git',
      ['push', `--recurse-submodules=on-demand`, remote, branch],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        // Inherit env so the hook gets everything (PATH, node, etc.).
        env: process.env,
        // Pipe all three so we can capture markers from stderr while still
        // letting the user see the hook's output after parse.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Node's spawnSync defaults to 1 MiB per stream. The pre-push hook
        // emits ~validate:fast + tier-1 vitest-related output, which on
        // heavy merges (e.g. ~140 own-files touching ~1000 test files)
        // exceeds the default and triggers an ENOBUFS that kills the hook
        // mid-vitest with no actual test failure. 64 MiB gives us comfortable
        // headroom for every realistic Tier 1/2/3 run.
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    const pushEndPerfMs = this.timing?.nowMs() ?? performance.now();
    const stdout = result.stdout ?? '';
    const rawStderr = result.stderr ?? '';
    const parsed = parsePrepushTimingMarkers(
      rawStderr,
      perfAnchorMs,
      wallAnchorSec,
      pushEndPerfMs,
    );

    return {
      success: result.status === 0,
      stdout,
      cleanedStderr: parsed.cleanedStderr,
      childSpans: parsed.childSpans,
      parseNotes: parsed.notes,
    };
  }

  // ---------------------------------------------------------------------------
  // MAIN EXECUTION
  // ---------------------------------------------------------------------------

  async execute(): Promise<number> {
    // Resolve repo + branch early so the timing recorder has context for the
    // log file even if the sync aborts immediately.
    let repoRoot: string;
    let currentBranch: string;
    try {
      repoRoot = this.getRepoRoot();
      currentBranch = this.branch || this.getCurrentBranch(repoRoot);
    } catch (err) {
      // No repo context → can't produce a useful log. Fall through to the
      // legacy error handling without timing wrapping.
      if (err instanceof UsageError) throw err;
      this.logError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT_CODES.UNKNOWN_ERROR;
    }

    this.timing = new SyncTimingRecorder(
      basename(repoRoot),
      currentBranch,
      process.argv.slice(2),
    );

    // NOTE on signals: SIGINT/SIGTERM handlers are installed ONLY around the
    // async lock-wait phase (see acquireSyncLock). A process-lifetime handler
    // would silently swallow kills delivered during synchronous child
    // sections (execSync/spawnSync — including the minutes-long push gate),
    // because Node can't run JS handlers while blocked there and installing
    // one replaces the default kill disposition. Mid-sync kills keep today's
    // immediate-death behavior; the lock is reclaimed via staleness.

    // --trace-git: enable git's built-in performance trace and direct it to a
    // sidecar file next to our timing log. Propagates to every `exec(...)`
    // call because they inherit process.env.
    if (this.traceGit) {
      const logDir = resolveLogDir();
      if (!logDir) {
        this.logWarning(
          '--trace-git requires a writable log directory (Mindstone Google Drive or GIT_SAFE_SYNC_LOG_DIR); continuing without trace',
        );
      } else {
        try {
          const now = new Date();
          const pad = (n: number): string => String(n).padStart(2, '0');
          const stamp =
            `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
            `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
          const yyyymm = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
          const perRepoDir = resolve(logDir, basename(repoRoot), yyyymm);
          // mkdirSync recursive is idempotent.
          mkdirSync(perRepoDir, { recursive: true });
          this.traceFilePath = resolve(perRepoDir, `${stamp}-git-trace.log`);
          process.env.GIT_TRACE_PERFORMANCE = this.traceFilePath;
          process.env.GIT_TRACE = this.traceFilePath;
          this.timing.note(`git trace enabled → ${this.traceFilePath}`);
        } catch (err) {
          this.logWarning(
            `Could not set up --trace-git sidecar: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Tag the retry leg in the timing log so telemetry can pair it with the
    // leg that lost the race (logged argv also carries --retry-leg).
    if (this.retryLeg) {
      this.timing.note('retry-leg: respawned after a lost push race');
    }

    let resolvedExit: number = EXIT_CODES.UNKNOWN_ERROR;
    let outcome: 'success' | 'failure' | 'aborted' = 'failure';
    try {
      resolvedExit = await this.runSyncBody(repoRoot);
      outcome = resolvedExit === EXIT_CODES.SUCCESS ? 'success' : 'failure';
    } catch (error) {
      if (error instanceof UsageError) {
        outcome = 'aborted';
        // UsageError is re-thrown; clipanion translates it into exit 1.
        resolvedExit = 1;
        this.finalizeTiming(outcome, resolvedExit);
        throw error;
      }
      this.logError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      resolvedExit = EXIT_CODES.UNKNOWN_ERROR;
      outcome = 'failure';
    } finally {
      // Unconditional + null-safe: must run on every path, including
      // UsageError aborts and never-acquired early exits (release() is
      // ownership-checked and idempotent; a null handle is a no-op).
      this.releaseSyncLock();
      // Only finalize if we didn't already do it in the UsageError branch.
      if (outcome !== 'aborted') {
        this.finalizeTiming(outcome, resolvedExit);
      }
    }

    // Stage 7: lost-push-race auto-retry via self-respawn. Deliberately AFTER
    // the finally — the lock is released and this leg's timing log finalized
    // (recording the lost race + spawned retry), so the retry is an ordinary
    // fresh sync: fresh lock acquire, fresh diagnostics, fresh autostash
    // semantics, conflicts exit 20 as today. The fresh-process shape avoids
    // every traced in-process re-entrancy hazard (integrityWarnBlocking
    // persistence, once-only finalizeTiming + duplicate span names, the
    // autostash pop finally inside the body, backup-branch naming). See
    // docs/plans/260611_prepush-gate-speedup/PLAN.md Stage 7.
    if (this.pushRetryPlan) {
      return this.respawnRetryLeg(this.pushRetryPlan);
    }
    return resolvedExit;
  }

  /**
   * Spawns THIS script once as a fresh process with the same argv plus
   * `--retry-leg` (single retry bound by construction; GIT_SAFE_SYNC_RETRY_DEPTH
   * is a belt-and-braces env guard against looping even with mangled flags).
   * The parent's exit code becomes the child's exit code.
   */
  private respawnRetryLeg(plan: { fromTip: string; toTip: string }): number {
    this.log('\n╔════════════════════════════════════════════════════════════╗', colors.yellow);
    this.log('║      LOST PUSH RACE — RETRYING ONCE IN A FRESH RUN         ║', colors.yellow);
    this.log('╚════════════════════════════════════════════════════════════╝', colors.yellow);
    this.log(
      `  Remote tip moved ${plan.fromTip} → ${plan.toTip} between our fetch and our push.`,
      colors.yellow,
    );
    this.log(
      '  Respawning this sync once to fetch, re-merge, and push (disable with --no-retry).\n',
      colors.yellow,
    );

    const spawnPlan = buildRetryLegSpawnPlan({
      execPath: process.execPath,
      execArgv: process.execArgv,
      scriptPath: process.argv[1],
      scriptArgs: process.argv.slice(2),
      env: process.env,
    });
    const result = spawnSync(spawnPlan.command, spawnPlan.args, {
      stdio: 'inherit',
      env: spawnPlan.env as NodeJS.ProcessEnv,
    });
    if (typeof result.status === 'number') {
      return result.status;
    }
    // Spawn failure or signal death of the child: fall back to today's
    // contract (this sync genuinely failed on a push race) rather than
    // inventing a new exit code.
    this.logError(
      `Retry leg did not complete (${result.error ? result.error.message : `signal ${result.signal ?? 'unknown'}`}) — exiting with the original push failure`,
    );
    return EXIT_CODES.PUSH_FAILED;
  }

  /** Null-safe, idempotent, never throws (release() swallows-with-warning). */
  private releaseSyncLock(): void {
    const handle = this.syncLockHandle;
    this.syncLockHandle = null;
    handle?.release();
  }

  /**
   * Acquires the same-host advisory sync lock (scripts/lib/same-host-sync-lock.ts)
   * before the first fetch. The `lock-wait` span is recorded on every path —
   * acquired, skipped, timed out, or errored — so the next measurement pass
   * can see queueing. Never throws; fail-open by design.
   */
  private async acquireSyncLock(repoRoot: string): Promise<void> {
    this.timing?.start('lock-wait');
    if (this.noLock || process.env.GIT_SAFE_SYNC_NO_LOCK === '1') {
      this.timing?.end('lock-wait', 'skipped', this.noLock ? '--no-lock' : 'GIT_SAFE_SYNC_NO_LOCK=1');
      return;
    }
    if (this.dryRun || this.diagnosticsOnly) {
      // Read-only flows shouldn't queue behind a multi-minute gate.
      this.timing?.end('lock-wait', 'skipped', this.dryRun ? 'dry-run' : 'diagnostics-only');
      return;
    }
    const urlResult = exec(`git remote get-url ${this.remote}`, { cwd: repoRoot });
    if (!urlResult.success || !urlResult.output) {
      this.logWarning('Could not resolve remote URL for the sync-lock key — proceeding without lock');
      this.timing?.end('lock-wait', 'skipped', 'remote URL unresolvable');
      return;
    }
    // --no-push runs merge but don't enter the push race; a prophylactic
    // merge shouldn't queue minutes behind a pushing peer's gate. Short cap,
    // then proceed-with-warning (PLAN.md Amendments item 3 / DA F5).
    let maxWaitMs: number | undefined;
    if (this.noPush) {
      const fromEnv = Number(process.env.GIT_SAFE_SYNC_LOCK_NOPUSH_WAIT_MS);
      maxWaitMs = Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 90_000;
    }
    // Signal handlers are SCOPED to this await: a SIGINT/SIGTERM during the
    // (possibly minutes-long) async wait releases the lock, writes the timing
    // log, and re-exits 130/143 — a default-disposition death here would skip
    // both. They MUST come off before any synchronous child work begins:
    // handlers can't run while Node is blocked in execSync/spawnSync, and
    // leaving them installed would swallow mid-sync kills entirely.
    const uninstallSignalHandlers = installLockWaitSignalHandlers((_signal, exitCode) => {
      this.releaseSyncLock(); // null-safe: nothing is acquired mid-wait
      this.finalizeTiming('aborted', exitCode);
      process.exit(exitCode);
    });
    let result;
    try {
      result = await acquireSameHostSyncLock({
        originUrl: urlResult.output,
        argv: process.argv.slice(2),
        maxWaitMs,
        log: (msg) => this.log(`  ${msg}`, colors.yellow),
      });
    } finally {
      uninstallSignalHandlers();
    }
    if (result.acquired) {
      this.syncLockHandle = result.handle;
      if (result.waitedMs > 1000) {
        this.logInfo(`Sync lock acquired after ${(result.waitedMs / 1000).toFixed(1)}s (${result.note})`);
      }
      this.timing?.end('lock-wait', 'ok', result.note);
    } else {
      this.logWarning(`Proceeding without sync lock: ${result.note}`);
      this.timing?.end('lock-wait', 'skipped', result.note);
    }
  }

  /**
   * Writes the timing log (if enabled) and prints the terminal summary.
   * Never throws.
   */
  private finalizeTiming(
    outcome: 'success' | 'failure' | 'aborted',
    exitCode: number,
  ): void {
    if (!this.timing) return;
    // Idempotent: each normal path calls this exactly once already; the guard
    // only matters when a signal lands around normal completion (the signal
    // handler also finalizes) — without it we'd write two log files.
    if (this.timingFinalized) return;
    this.timingFinalized = true;
    let logPath: string | null = null;
    let loggingSkipped = false;
    if (!this.noLog) {
      logPath = this.timing.writeLog(outcome, exitCode);
      // writeLog returns null either because the log dir is unresolvable
      // (Mindstone drive not mounted and no GIT_SAFE_SYNC_LOG_DIR) or
      // because the write itself failed. The latter already printed its
      // own stderr message; the former is silent by design — surface it
      // here so the skip is observable (per AGENTS.md "silent failure is
      // a bug"). resolveLogDir is cheap, so a second call is fine.
      if (!logPath && !resolveLogDir()) {
        loggingSkipped = true;
      }
    }
    // Terminal summary — dim so it doesn't drown the primary output.
    this.log('\n' + this.timing.formatSummary(outcome, exitCode), colors.dim);
    if (logPath) {
      this.log(`  log: ${logPath}`, colors.dim);
    } else if (loggingSkipped) {
      this.log(
        '  log: skipped (Mindstone Google Drive not found; set GIT_SAFE_SYNC_LOG_DIR to enable)',
        colors.dim,
      );
    }
    if (this.traceFilePath) {
      this.log(`  git-trace: ${this.traceFilePath}`, colors.dim);
    }
  }

  private async runSyncBody(repoRoot: string): Promise<number> {
    try {
      // Header
      this.log('\n╔════════════════════════════════════════════════════════════╗', colors.bright);
      this.log('║          Mindstone Rebel - Git Safe Sync                   ║', colors.bright);
      this.log('╚════════════════════════════════════════════════════════════╝', colors.bright);

      // Show mode
      if (this.dryRun) {
        this.log('\n  🔍 DRY RUN MODE - No changes will be made\n', colors.yellow);
      }
      if (this.diagnosticsOnly) {
        this.log('\n  🔍 DIAGNOSTICS ONLY - No sync will be performed\n', colors.yellow);
      }

      // Step 1: Navigate to repo root (already resolved in execute())
      process.chdir(repoRoot);
      this.logVerbose(`Working from: ${repoRoot}`);

      // Step 1b: Validate --branch flag if provided
      // If user specified a branch, it MUST match the current branch
      // (we don't auto-checkout to avoid surprising the user)
      if (this.branch) {
        const currentBranch = this.getCurrentBranch(repoRoot);
        if (this.branch !== currentBranch) {
          this.logError(`You specified --branch ${this.branch} but you're on branch ${currentBranch}`);
          this.log('  To sync that branch, first checkout it:', colors.yellow);
          this.log(`    git checkout ${this.branch}`, colors.cyan);
          throw new UsageError('Branch mismatch - checkout the target branch first');
        }
      }

      // Step 1c: Same-host advisory sync lock — acquired immediately BEFORE
      // the fetch inside gatherDiagnostics() so every fetch happens post-lock
      // (the "freshness re-fetch after acquiring" requirement holds by
      // construction, zero extra round-trips). Advisory + fail-open: timeout
      // or any lock error proceeds with a loud warning.
      await this.acquireSyncLock(repoRoot);

      // Step 2: Gather diagnostics (includes fetch)
      this.logSection('Gathering Diagnostics');
      this.timing?.start('diagnostics');
      let state = this.gatherDiagnostics(repoRoot);
      this.timing?.end('diagnostics');

      // Step 3: Print diagnostics
      this.printDiagnostics(state);

      // Step 4: If diagnostics-only, stop here
      if (this.diagnosticsOnly) {
        this.log('\n  Diagnostics complete. No sync performed.\n', colors.cyan);
        return EXIT_CODES.SUCCESS;
      }

      // Step 4b: Pre-safety submodule pointer-lag auto-align (Stage 6,
      // docs/plans/260611_prepush-gate-speedup/PLAN.md). After a MANUAL merge
      // commit, submodule checkouts lag the newly-committed pins and the
      // safety check below would abort "uncommitted changes" until a human ran
      // `git submodule update`. When EVERY dirty entry is provably-safe pure
      // pointer-lag (clean submodule checkout strictly behind a committed pin
      // that is reachable from the tracked remote branch), align the checkouts
      // and RE-GATHER diagnostics so strategy/auto-resolvable/safety are all
      // computed from fresh state — the pre-align snapshot must not survive.
      // Anything else falls through to checkSafety, which aborts as before
      // (with classification-aware recovery copy). Runs AT MOST ONCE.
      let dirtyAssessment: DirtySuperprojectAssessment | null = null;
      if (state.superprojectDirty) {
        dirtyAssessment = assessDirtySuperproject(makeRunGit(repoRoot));
        if (dirtyAssessment.allAlignable) {
          this.logSection('Aligning Submodule Pointer-Lag');
          if (this.dryRun) {
            for (const e of dirtyAssessment.entries) {
              this.logInfo(`Would align ${e.path}: ${e.fromSha} → ${e.toSha} (checkout lags committed pin)`);
            }
          } else {
            this.timing?.start('submodule-lag-align');
            const aligned: string[] = [];
            let alignFailed = false;
            for (const e of dirtyAssessment.entries) {
              // argv-array spawn (no shell): the path never passes through
              // string interpolation — paths with spaces/metacharacters are
              // exactly the conservative class this phase must fail safe on.
              // git-exec-allow: align spawn preserves status/stderr for the loud note + abort path
              const alignRun = spawnSync(
                'git',
                ['submodule', 'update', '--init', '--', e.path],
                { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
              );
              const result = {
                success: alignRun.status === 0,
                error: alignRun.error?.message || alignRun.stderr?.trim() || undefined,
              };
              if (result.success) {
                const branchNote = e.wasOnBranch
                  ? ` (was on branch '${e.wasOnBranch}' — now detached at the pin; branch ref preserved, re-attached at advancement)`
                  : '';
                this.logSuccess(`${e.path}: checkout aligned to committed pin ${e.fromSha} → ${e.toSha}${branchNote}`);
                aligned.push(`${e.path} ${e.fromSha}→${e.toSha}`);
              } else {
                alignFailed = true;
                this.logError(`${e.path}: submodule update failed — ${result.error || 'unknown error'}`);
              }
            }
            this.timing?.end('submodule-lag-align', alignFailed ? 'err' : 'ok', aligned.join('; ') || 'nothing aligned');
            if (aligned.length > 0) {
              this.timing?.note(`submodule-lag-align: ${aligned.join('; ')}`);
            }
            // Recompute everything downstream from fresh local state (no second
            // fetch — Step 2's fetch is seconds old). If still dirty (e.g. an
            // `update=none` submodule no-op'd the align), checkSafety aborts
            // below exactly as today — the pass never re-runs.
            state = this.gatherDiagnostics(repoRoot, false);
            dirtyAssessment = state.superprojectDirty
              ? assessDirtySuperproject(makeRunGit(repoRoot))
              : null;
          }
        }
      }

      // Fail-closed: if we can't determine divergence, abort
      if (state.divergenceError) {
        this.logSection('Divergence Check');
        this.logError('Cannot determine ahead/behind count — git rev-list failed');
        this.log('  This may indicate a network issue or corrupted refs.', colors.yellow);
        this.log('  Fix the issue and retry.\n', colors.yellow);
        return EXIT_CODES.DIVERGENCE_UNKNOWN;
      }

      // Step 5: Check for tracking branch (required for meaningful sync)
      if (!state.trackingBranch) {
        this.logSection('Sync Strategy');
        this.logError('Cannot determine sync strategy - no tracking branch configured');
        this.log('\n  To set up tracking, run:', colors.yellow);
        this.log(`    git branch --set-upstream-to=${state.remote}/${state.currentBranch}`, colors.cyan);
        this.log('\n  Or push with -u to set upstream:', colors.yellow);
        this.log(`    git push -u ${state.remote} ${state.currentBranch}\n`, colors.cyan);
        throw new UsageError('No tracking branch - cannot determine what to sync');
      }

      // Step 6: Determine sync strategy
      const strategy = this.determineSyncStrategy(state);
      this.logSection('Sync Strategy');
      this.logInfo(`Strategy: ${strategy}`);

      if (strategy === 'up-to-date' && !state.superprojectDirty) {
        this.logSuccess('Already up to date - nothing to do');
        return EXIT_CODES.SUCCESS;
      }

      // Step 6b: Identify auto-resolvable submodules (preflight only, no side effects)
      const autoResolvable = this.dryRun
        ? []
        : this.identifyAutoResolvableSubmodules(repoRoot, state);

      // Step 7: Safety checks — skip unpushed-commit errors for auto-resolvable submodules
      this.logSection('Safety Verification');
      this.checkSafety(state, new Set(autoResolvable.map((a) => a.sub.name)), dirtyAssessment);
      this.logSuccess('All safety checks passed');

      // Step 7b: Now push auto-resolvable submodules (after safety gate, before merge)
      if (autoResolvable.length > 0) {
        this.logSection('Auto-pushing Submodule Commits');
        this.timing?.start('auto-push-submodules');
        const resolution = this.pushAutoResolvableSubmodules(repoRoot, state, autoResolvable);
        if (resolution.pushed.length > 0) {
          this.logSuccess(`Auto-pushed ${resolution.pushed.length} submodule(s)`);
        }
        if (resolution.failed.length > 0) {
          this.timing?.end('auto-push-submodules', 'err', `${resolution.failed.length} failed`);
          this.logError(
            `${resolution.failed.length} submodule(s) failed to push — aborting`,
          );
          this.log('  Fix the submodule push issues and retry.\n', colors.yellow);
          return EXIT_CODES.SUBMODULE_UNPUSHED;
        }
        this.timing?.end('auto-push-submodules');
      }

      // Step 8: Pre-check merge conflicts before autostash
      // If autostash is requested and there are changes to stash, verify the merge won't conflict
      // This prevents the awkward state of "stashed changes + merge conflict to resolve"
      if (
        state.superprojectDirty &&
        this.autostash &&
        !this.dryRun &&
        state.behind > 0 &&
        state.trackingBranch
      ) {
        this.logSection('Pre-checking Merge Conflicts');
        this.timing?.start('merge-conflict-precheck');
        this.logInfo('Verifying merge will succeed before stashing your changes...');

        // git merge-tree --write-tree performs merge without touching working tree or index
        // Exit code 0 = no conflicts, exit code 1 = conflicts, other = error
        // Requires Git 2.38+ for --write-tree mode
        const mergeTreeResult = exec(`git merge-tree --write-tree HEAD ${state.trackingBranch}`, {
          cwd: repoRoot,
        });

        if (!mergeTreeResult.success) {
          // Check if this is a conflict (exit 1) or an error (other exit codes)
          // If merge-tree itself failed (e.g., old Git version), warn but proceed
          // The stash preservation logic in the finally block will handle conflicts
          if (mergeTreeResult.error?.includes('usage:') || mergeTreeResult.error?.includes('fatal:')) {
            // merge-tree command itself failed - degrade gracefully
            this.logWarning('Could not pre-check for conflicts (git merge-tree not available)');
            this.logInfo('Proceeding with autostash - conflicts will be handled during merge');
            this.timing?.end('merge-conflict-precheck', 'skipped', 'merge-tree unavailable');
          } else {
            // Exit code 1 = actual merge conflicts detected
            this.timing?.end('merge-conflict-precheck', 'err', 'conflicts detected');
            this.logError('Merge would have conflicts - cannot safely autostash');
            this.log('\n  Your uncommitted changes would be stashed, but the merge would fail.', colors.yellow);
            this.log('  This would leave you with stashed changes + a merge conflict to resolve.', colors.yellow);
            this.log('\n  Options:', colors.yellow);
            this.log('  1. Commit your changes first, then run git-safe-sync', colors.cyan);
            this.log('  2. Stash manually (git stash push -u), resolve merge, then pop stash', colors.cyan);
            this.log('  3. Pull without this script: git pull (handles conflicts interactively)', colors.cyan);
            throw new UsageError('Merge conflicts detected - autostash aborted for safety');
          }
        } else {
          this.logSuccess('Merge will not conflict - safe to proceed with autostash');
          this.timing?.end('merge-conflict-precheck');
        }
      }

      // Step 9: Handle autostash if needed
      let stashCreated = false;
      let autostashNonce: string | null = null;
      if (state.superprojectDirty && this.autostash) {
        this.logSection('Autostash');
        this.timing?.start('autostash');
        if (this.dryRun) {
          this.logInfo('Would stash uncommitted changes');
        } else {
          const stashResult = this.stashChanges(repoRoot);
          if (stashResult.failed) {
            // Stash command failed - abort to avoid proceeding with dirty state
            this.logError(`Failed to stash changes: ${stashResult.error}`);
            this.log('  Cannot proceed with dirty working tree.', colors.yellow);
            throw new UsageError('Autostash failed - commit or stash changes manually');
          }
          stashCreated = stashResult.stashed;
          if (stashCreated) {
            autostashNonce = stashResult.nonce ?? null;
            this.logSuccess('Changes stashed');
          } else {
            this.logInfo('No changes to stash');
          }
        }
        this.timing?.end('autostash', 'ok', stashCreated ? 'stashed' : 'nothing to stash');
      }

      try {
        // Step 9b: Create backup branch before merge
        if ((strategy === 'fast-forward' || strategy === 'merge') && !this.noBackup) {
          this.logSection('Creating Backup Branch');
          this.timing?.start('backup-branch');

          if (this.dryRun) {
            this.logInfo('Would create backup branch');
            this.timing?.end('backup-branch', 'skipped', 'dry-run');
          } else {
            const backupRef = this.createBackupBranch(repoRoot, state.currentBranch);
            if (backupRef) {
              this.logSuccess(`Backup: ${backupRef}`);
              this.logInfo(`Rollback: git reset --hard ${backupRef}`);
              this.timing?.end('backup-branch');
            } else {
              this.timing?.end('backup-branch', 'err');
              this.logError('Failed to create backup branch — aborting for safety');
              this.log('  Use --no-backup to skip (not recommended)\n', colors.yellow);
              return EXIT_CODES.UNKNOWN_ERROR;
            }
          }
        }

        // Step 10: Perform merge if needed
        if (strategy === 'fast-forward' || strategy === 'merge') {
          this.logSection('Merging Remote Changes');
          this.timing?.start('merge');

          if (this.dryRun) {
            this.logInfo(`Would merge ${state.trackingBranch}`);
            this.timing?.end('merge', 'skipped', 'dry-run');
          } else {
            const mergeResult = this.performMerge(repoRoot, state.trackingBranch!);

            if (!mergeResult.success) {
              if (mergeResult.hasConflicts) {
                this.timing?.end('merge', 'err', 'conflicts');
                this.logError('Merge conflict detected');
                this.log('\n  Recovery:', colors.yellow);
                this.log('  1. Resolve conflicts manually', colors.cyan);
                this.log('  2. git add <resolved files>', colors.cyan);
                this.log('  3. git commit', colors.cyan);
                this.log('  4. Run this script again (or git push manually)\n', colors.cyan);
                return EXIT_CODES.MERGE_CONFLICT;
              }
              this.timing?.end('merge', 'err');
              throw new Error('Merge failed');
            }

            this.logSuccess('Merge successful');
            this.timing?.end('merge');

            // Step 10b: Verify merge integrity
            if (!this.skipMergeIntegrity) {
              this.logSection('Merge Integrity Verification');
              this.timing?.start('integrity-check');
              try {
                const facts = collectMergeFacts(repoRoot, 'HEAD');
                const integrity = assessMergeIntegrity(facts);

                this.logInfo(`Merge: ${integrity.mergeCommit.slice(0, 10)}`);
                this.logInfo(`Parents: ${integrity.parent1.slice(0, 10)} (ours) ← ${integrity.parent2.slice(0, 10)} (theirs)`);
                this.logInfo(`Theirs files: ${integrity.theirsFileCount}, Merge changes: ${integrity.mergeChangeCount}`);
                if (facts.convergentFiles.length > 0) {
                  this.logInfo(`Convergent files: ${facts.convergentFiles.length} (both sides made same change)`);
                }
                this.logInfo(`Incorporation: ${(integrity.incorporationRatio * 100).toFixed(1)}%`);

                if (integrity.status === 'fail') {
                  this.timing?.end('integrity-check', 'err', 'fail');
                  this.logError('MERGE INTEGRITY FAILURE — incoming changes appear to have been dropped');
                  this.log(`\n  ${integrity.reason}`, colors.red);
                  if (integrity.suspiciousFiles && integrity.suspiciousFiles.length > 0) {
                    this.log('\n  Dropped files (sample):', colors.yellow);
                    for (const file of integrity.suspiciousFiles) {
                      this.log(`    - ${file}`, colors.yellow);
                    }
                  }
                  this.log('\n  Recovery:', colors.cyan);
                  this.log('    git reset --hard HEAD~1          # Undo the bad merge', colors.cyan);
                  this.log('    npx tsx scripts/git-safe-sync.ts  # Re-merge safely', colors.cyan);
                  this.log('\n  To skip this check (NOT RECOMMENDED):', colors.dim);
                  this.log('    npx tsx scripts/git-safe-sync.ts --skip-merge-integrity\n', colors.dim);
                  return EXIT_CODES.MERGE_INTEGRITY_FAILED;
                }

                if (integrity.status === 'warn') {
                  this.logWarning(integrity.reason);
                  if (integrity.suspiciousFiles && integrity.suspiciousFiles.length > 0) {
                    this.log('  Potentially dropped files (sample):', colors.yellow);
                    for (const file of integrity.suspiciousFiles) {
                      this.log(`    - ${file}`, colors.yellow);
                    }
                  }
                  this.logWarning('Proceeding despite warning — review the merge result carefully');
                  this.integrityWarnBlocking = true;
                  this.timing?.end('integrity-check', 'ok', 'warn — push blocked');
                } else {
                  this.logSuccess('Merge integrity verified — incoming changes preserved');
                  this.timing?.end('integrity-check');
                }
              } catch (integrityError) {
                // Fail-closed: integrity check exceptions are blocking failures
                // See docs-private/postmortems/260402_merge_drop_second_incident_postmortem.md
                this.timing?.end('integrity-check', 'err', 'exception');
                this.logError(
                  `Merge integrity check failed: ${integrityError instanceof Error ? integrityError.message : String(integrityError)}`
                );
                this.logError('Cannot verify merge integrity — aborting for safety');
                this.log('\n  To bypass (NOT RECOMMENDED):', colors.dim);
                this.log('    npx tsx scripts/git-safe-sync.ts --skip-merge-integrity\n', colors.dim);
                return EXIT_CODES.MERGE_INTEGRITY_FAILED;
              }
            } else {
              this.logWarning('Merge integrity check SKIPPED (--skip-merge-integrity)');
            }
          }
        }

        // Step 11: Sync submodule URLs (in case merge changed .gitmodules)
        if (strategy !== 'push-only' && strategy !== 'up-to-date') {
          this.logSection('Syncing Submodules');
          this.timing?.start('submodules-sync');

          if (this.dryRun) {
            this.logInfo('Would sync submodule URLs and update to merged pointers');
            this.timing?.end('submodules-sync', 'skipped', 'dry-run');
          } else {
            // 11a: Sync URLs from .gitmodules → .git/config
            const syncResult = this.syncSubmodules(repoRoot);
            if (!syncResult) {
              this.logWarning('Submodule sync failed — continuing with existing URLs');
            }

            // 11b: Update submodules to match merged pointers
            const submoduleResult = this.updateSubmodules(repoRoot);
            if (!submoduleResult) {
              this.timing?.end('submodules-sync', 'err');
              throw new Error('Submodule update failed');
            }
            this.logSuccess('Submodules updated to merged pointers');
            this.timing?.end('submodules-sync');
          }
        }

        // Step 12: Advance submodules to remote HEAD (unless --no-advance-submodules)
        if (!this.noAdvanceSubmodules && strategy !== 'up-to-date') {
          this.logSection('Advancing Submodules');
          this.timing?.start('submodules-advance');

          if (this.dryRun) {
            this.logInfo('Would advance submodules to remote HEAD');
            this.timing?.end('submodules-advance', 'skipped', 'dry-run');
          } else {
            // For push-only, we still need to sync and ensure submodules are initialized
            if (strategy === 'push-only') {
              const syncResult = this.syncSubmodules(repoRoot);
              if (!syncResult) {
                this.logWarning('Submodule sync failed — continuing with existing URLs');
              }

              const submoduleResult = this.updateSubmodules(repoRoot);
              if (!submoduleResult) {
                this.logError('Submodule initialization/update failed before advancement');
                return EXIT_CODES.SUBMODULE_ADVANCEMENT_FAILED;
              }
            }

            // 12a: Checkout tracking branches (escape detached HEAD)
            const branchResult = this.checkoutSubmoduleBranches(repoRoot);
            if (!branchResult.success) {
              this.timing?.end('submodules-advance', 'err', 'checkout failed');
              this.logError('Could not checkout submodule branches:');
              for (const err of branchResult.errors) {
                this.logError(`  ${err}`);
              }
              this.log('\n  Use --no-advance-submodules to skip advancement\n', colors.yellow);
              return EXIT_CODES.SUBMODULE_ADVANCEMENT_FAILED;
            }

            // 12b: Advance to remote HEAD
            const advanceResult = this.advanceSubmodules(repoRoot);
            if (!advanceResult.success) {
              this.timing?.end('submodules-advance', 'err', 'advancement failed');
              this.logError(`Submodule advancement failed: ${advanceResult.error}`);
              this.log('\n  This usually means a submodule has diverged and needs manual merge.', colors.yellow);
              this.log('  Use --no-advance-submodules to skip, or resolve manually.\n', colors.yellow);
              return EXIT_CODES.SUBMODULE_ADVANCEMENT_FAILED;
            }

            if (advanceResult.advanced.length > 0) {
              for (const sub of advanceResult.advanced) {
                this.logSuccess(`${sub.name}: ${sub.fromSha} → ${sub.toSha}`);
              }

              // 12c: Create pointer commit
              const commitResult = this.createPointerCommit(repoRoot, advanceResult.advanced);
              if (!commitResult) {
                this.timing?.end('submodules-advance', 'err', 'pointer commit failed');
                this.logError('Failed to create submodule pointer commit');
                return EXIT_CODES.SUBMODULE_ADVANCEMENT_FAILED;
              }
              this.logSuccess('Submodule pointer commit created');
              this.timing?.end('submodules-advance', 'ok', `advanced ${advanceResult.advanced.length}`);
            } else {
              this.logInfo('All submodules already at remote HEAD');
              this.timing?.end('submodules-advance', 'ok', 'no-op');
            }
          }
        } else if (this.noAdvanceSubmodules) {
          this.logSection('Submodule Advancement Skipped');
          this.logInfo('--no-advance-submodules flag set');
        }

        // Step 13: Run validator
        //
        // Decision matrix for running the validator in-script:
        //   --validate            → always run (user explicitly opted in)
        //   --no-validator        → always skip (explicit opt-out, wins over other logic)
        //   --no-push             → run (push gate won't protect us; fail fast here)
        //   pre-push hook present → skip (hook runs validate:fast before push; running now is duplicate ~40s)
        //   no pre-push hook      → run as fallback (no other gate between us and origin)
        //
        // This flipped default (skip if pre-push exists) is the single
        // biggest speed win — each run avoids ~40s of duplicated work.
        const willPush = !this.noPush && (strategy !== 'up-to-date' || state.ahead > 0);

        // Step 13a: by-construction submodule-pin-orphan guard. Before pushing the
        // superproject, refuse any submodule pin not on its tracked branch (would be
        // silently dropped on a future re-align). Runs after auto-push + advancement,
        // so legit in-flight commits already verify OK. Skipped in dry-run (nothing
        // is pushed) and when not pushing.
        if (willPush && !this.dryRun) {
          this.logSection('Checking Submodule Pins (tracked-branch ancestry)');
          this.timing?.start('submodule-pin-guard');
          const pinsOk = this.enforceSubmodulePinsOnTrackedBranch(repoRoot);
          if (!pinsOk) {
            this.timing?.end('submodule-pin-guard', 'err', 'pin off tracked branch');
            return EXIT_CODES.SUBMODULE_PIN_ORPHAN;
          }
          this.timing?.end('submodule-pin-guard', 'ok');
        }

        let shouldValidate: boolean;
        let validatorReason = '';
        if (this.noValidator) {
          shouldValidate = false;
          validatorReason = '--no-validator flag set';
        } else if (this.validate) {
          shouldValidate = true;
          validatorReason = '--validate flag set';
        } else if (!willPush) {
          // --no-push or up-to-date: no subsequent push gate, so validate
          // here to avoid leaving a broken tree silently on disk.
          shouldValidate = true;
          validatorReason = 'no push scheduled — pre-push hook will not run';
        } else {
          const prePushDetected = this.hasPrePushHook(repoRoot);
          if (prePushDetected) {
            shouldValidate = false;
            validatorReason = 'pre-push hook will run validator before push';
          } else {
            shouldValidate = true;
            validatorReason = 'no pre-push hook detected — falling back to in-script validator';
            this.logWarning('No pre-push hook found — running validator in-script as safety fallback');
          }
        }

        if (shouldValidate && (strategy !== 'up-to-date' || state.ahead > 0)) {
          this.logSection('Running Validators');
          this.logInfo(`Reason: ${validatorReason}`);
          this.timing?.start('validator', validatorReason);

          if (this.dryRun) {
            this.logInfo(`Would run: ${this.validatorCommand}`);
            this.timing?.end('validator', 'skipped', 'dry-run');
          } else {
            const validatorResult = this.runValidator(repoRoot);
            if (!validatorResult) {
              this.timing?.end('validator', 'err');
              this.logError('Validation failed');
              this.log('\n  You are in a merged-but-unpushed state.', colors.yellow);
              this.log('  Fix the validation errors and push manually.\n', colors.yellow);
              return EXIT_CODES.VALIDATOR_FAILED;
            }
            this.logSuccess('Validation passed');
            this.timing?.end('validator');
          }
        } else if (!shouldValidate && (strategy !== 'up-to-date' || state.ahead > 0)) {
          this.logSection('Skipping In-Script Validation');
          this.logInfo(validatorReason);
          this.logInfo('Use --validate to force in-script validation');
          this.timing?.note(`validator skipped: ${validatorReason}`);
        }

        // WARN-blocked: merge integrity had warnings — block push for safety
        if (this.integrityWarnBlocking && !this.noPush) {
          this.logSection('Push Blocked (Integrity Warning)');
          this.logWarning('Merge integrity returned WARN — push blocked for safety');
          this.log('  Review the merge result carefully, then either:', colors.yellow);
          this.log('  1. Push manually: git push origin ' + state.currentBranch, colors.cyan);
          this.log('  2. Rerun with --skip-merge-integrity to bypass', colors.cyan);
          this.log('  3. Reset to pre-merge state if the merge is wrong\n', colors.cyan);
          return EXIT_CODES.MERGE_INTEGRITY_WARN;
        }

        // Step 14: Push
        if (!this.noPush && (strategy !== 'up-to-date' || state.ahead > 0)) {
          this.logSection('Pushing to Remote');
          // Note: push time INCLUDES the pre-push hook (which runs validate:fast
          // ~29s cold / 14s warm). That's usually the dominant cost in a clean
          // push. See docs/plans/260421_validate_fast_parallelisation.md.
          this.timing?.start('push', 'includes pre-push hook (validate:fast + tiered tests)');

          if (this.dryRun) {
            this.logInfo(`Would push to ${state.remote}/${state.currentBranch}`);
            this.timing?.end('push', 'skipped', 'dry-run');
          } else {
            const pushResult = this.pushToRemote(repoRoot, state.remote, state.currentBranch);

            // Replay captured output so the user still sees git's messages
            // and any warnings from the pre-push hook. Today's behavior was
            // to discard both streams silently on success — fix that too
            // while we're here.
            if (pushResult.stdout) process.stdout.write(pushResult.stdout);
            if (pushResult.cleanedStderr) process.stderr.write(pushResult.cleanedStderr);

            // Attach each pre-push phase as a flat span so the JSON log
            // answers "where did those 30-60 seconds go?" without requiring
            // anyone to re-run with --trace-git.
            for (const span of pushResult.childSpans) {
              this.timing?.recordSpan(span);
            }
            for (const note of pushResult.parseNotes) {
              this.timing?.note(note);
            }

            if (!pushResult.success) {
              // Stage 7: structured race classification (scripts/lib/push-race-retry.ts).
              // Deliberately NOT the old bare-substring heuristic: '[rejected]' is a
              // substring of '[remote rejected]' (hook/policy decline, not a race) and
              // pre-push hook stderr can echo race-like words. Race = the specific
              // non-FF rejection line shape AND the remote tip provably moved.
              // A failed push leaves the remote-tracking ref untouched, so it still
              // holds the tip we fetched; ls-remote observes where the remote is now.
              const fetchedTip = exec(`git rev-parse ${state.trackingBranch}`, { cwd: repoRoot });
              const observed = exec(
                `git ls-remote ${state.remote} refs/heads/${state.currentBranch}`,
                { cwd: repoRoot },
                30_000,
              );
              const observedTip = observed.success ? (observed.output.split(/\s+/)[0] ?? '') : '';
              const classification = classifyPushFailure(pushResult.cleanedStderr, {
                fetchedRemoteTip: fetchedTip.success ? fetchedTip.output : null,
                observedRemoteTip: observedTip || null,
              });
              this.timing?.end('push', 'err', classification.reason);
              this.logError('Push failed');
              this.log('\n  Your changes are merged locally but not pushed.', colors.yellow);
              if (classification.kind === 'race-non-ff') {
                // Non-FF + remote moved: another push landed between our fetch and
                // our push. Bare `git push` would fail the same way — the fix is a
                // full fetch+merge+push cycle, which the retry leg (or re-running
                // this command) provides.
                const fromTip = (fetchedTip.output || '').slice(0, 10);
                const toTip = observedTip.slice(0, 10);
                this.log('  Another push landed on the remote between fetch and push.', colors.yellow);
                const decision = decidePushRetry({
                  failureKind: classification.kind,
                  autostashCreated: stashCreated,
                  isRetryLeg: this.retryLeg,
                  noRetryFlag: this.noRetry,
                  env: process.env,
                });
                if (decision.retry) {
                  // Telemetry (DA must-add): this leg's log must record that a race
                  // was lost AND a retry was spawned — retried-and-won races have to
                  // stay visible to the cross-machine tripwire analysis.
                  this.timing?.note(`push-retry: lost race ${fromTip}→${toTip}; spawning retry leg`);
                  this.pushRetryPlan = { fromTip, toTip };
                } else {
                  this.timing?.note(
                    `push-retry: lost race ${fromTip}→${toTip}; NOT retrying (${decision.reason})`,
                  );
                  this.log(`  Auto-retry skipped (${decision.reason}).`, colors.yellow);
                  this.log('  Re-run this command to fetch, re-merge, and push.\n', colors.yellow);
                }
              } else if (
                classification.rejectionShape === 'non-ff-rejected' ||
                classification.rejectionShape === 'cas-ref-lock'
              ) {
                // Non-FF / CAS ref-lock shape but the remote-moved evidence is
                // absent or unverifiable (e.g. ls-remote failed and the embedded
                // SHAs weren't a clean pair): never auto-retry, but bare
                // `git push` would still fail — keep the re-run guidance.
                this.logVerbose(`Push failure classification: ${classification.reason}`);
                this.log('  Push was rejected (non-fast-forward / ref-lock).', colors.yellow);
                this.log('  Re-run this command to fetch, re-merge, and push.\n', colors.yellow);
              } else {
                this.logVerbose(`Push failure classification: ${classification.reason}`);
                this.log(`  Fix the failure above, then: git push ${state.remote} ${state.currentBranch}\n`, colors.yellow);
              }
              return EXIT_CODES.PUSH_FAILED;
            }
            this.logSuccess('Push successful');
            this.timing?.end('push');
          }
        } else if (this.noPush) {
          this.logSection('Skipping Push');
          this.logInfo('--no-push flag set, changes are merged but not pushed');
          this.timing?.note('push skipped (--no-push)');
        }
      } finally {
        // Step 15: Pop stash if we created one
        // BUT: Don't pop if we're in a merge conflict state - that would make things worse
        if (stashCreated && !this.dryRun) {
          // Check if we're in a merge conflict state using porcelain format
          const conflictState = this.hasGitConflicts(repoRoot);

          if (conflictState === 'yes' || conflictState === 'unknown') {
            this.logSection('Stash Preserved (Merge Conflict)');
            this.logInfo('Your stashed changes are preserved during conflict resolution');
            this.log('  After resolving the merge conflict:', colors.yellow);
            this.log('  1. git add <resolved files>', colors.cyan);
            this.log('  2. git commit', colors.cyan);
            this.log('  3. git stash pop  (restore your uncommitted changes)', colors.cyan);
          } else {
            this.logSection('Restoring Stashed Changes');
            const popResult = this.popStash(repoRoot, autostashNonce);
            if (popResult.ok) {
              this.logSuccess('Stashed changes restored');
            } else {
              this.logWarning('Could not restore stashed changes');
              if (popResult.sha) {
                this.log(`  Recover with: git stash apply ${popResult.sha}`, colors.yellow);
                this.log('  (If that fails, see Trigger D in git-safe-sync-and-push.md — fsck recovery.)', colors.yellow);
              } else {
                this.log(
                  `  Find it: git stash list | grep "${autostashNonce ?? 'git-safe-sync autostash'}"  then  git stash apply <sha>`,
                  colors.yellow,
                );
                this.log('  (If the stack is empty, see Trigger D in git-safe-sync-and-push.md — fsck recovery.)', colors.yellow);
              }
            }
          }
        }
      }

      // Step 16: Final verification
      //
      // IMPORTANT: we intentionally do NOT re-fetch here. The previous
      // implementation called `gatherDiagnostics(repoRoot)` which triggered a
      // full superproject + submodule fetch (~5s + network) just to print a
      // "synchronized" line. We already have fresh refs from Step 2's fetch
      // and the just-completed push, so a second network round-trip adds no
      // safety value. If `pass fetch=false` the diagnostic is purely local.
      this.logSection('Final Verification');
      this.timing?.start('final-verify');

      if (this.dryRun) {
        this.logInfo('Dry run complete - no changes were made');
        this.timing?.end('final-verify', 'skipped', 'dry-run');
      } else {
        // Re-check state against local refs only (no network)
        const finalState = this.gatherDiagnostics(repoRoot, false);

        if (finalState.ahead === 0 && finalState.behind === 0) {
          this.logSuccess('Fully synchronized with remote (local refs)');
        } else if (this.noPush && finalState.ahead > 0) {
          this.logInfo(`${finalState.ahead} commit(s) ready to push`);
        }

        // Verify submodules are still safe (local-only checks — uncommitted
        // state and remote-branch membership against the refs we fetched
        // earlier in the run).
        const unsafeSubmodules = finalState.submodules.filter(
          (s) => s.hasUncommittedChanges || !s.isOnRemoteBranch
        );
        if (unsafeSubmodules.length === 0) {
          this.logSuccess('All submodules are in safe state');
        }
        this.timing?.end('final-verify');
      }

      // Prune old backup branches (keep last 10)
      if (!this.dryRun && !this.noBackup) {
        this.pruneBackupBranches(repoRoot, state.currentBranch);
      }

      // Success!
      this.log('\n╔════════════════════════════════════════════════════════════╗', colors.green);
      this.log('║                    Sync Complete!                          ║', colors.green);
      this.log('╚════════════════════════════════════════════════════════════╝\n', colors.green);

      return EXIT_CODES.SUCCESS;
    } finally {
      // Outer execute() handles error translation + log writing. This block
      // exists so the current logSection / log lines survive the extraction
      // and no accidental fall-through return 0 sneaks in.
    }
  }
}

// -----------------------------------------------------------------------------
// CLI ENTRY POINT
// -----------------------------------------------------------------------------

const cli = new Cli({
  binaryLabel: 'Git Safe Sync',
  binaryName: 'git-safe-sync',
  binaryVersion: '1.0.0',
});

cli.register(GitSafeSyncCommand);
cli.runExit(process.argv.slice(2));
