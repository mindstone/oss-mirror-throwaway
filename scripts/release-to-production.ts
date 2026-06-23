#!/usr/bin/env npx tsx

/**
 * ============================================================================
 * Mindstone Rebel - Release to Production
 * ============================================================================
 *
 * Automates releasing the latest code from `dev` to production (`main`).
 *
 * ============================================================================
 * WHY THIS SCRIPT EXISTS
 * ============================================================================
 *
 * Releasing to production requires careful coordination:
 * 1. Version must be bumped on dev and pushed BEFORE merging
 * 2. Submodules must be in a safe state
 * 3. Merge conflicts require human intervention
 * 4. Validators must pass before pushing to main
 *
 * This script ensures all steps are performed correctly and safely.
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *
 * Basic release (patch bump):
 *   npx tsx scripts/release-to-production.ts
 *
 * Preview what would happen (safe):
 *   npx tsx scripts/release-to-production.ts --dry-run
 *
 * Minor version bump:
 *   npx tsx scripts/release-to-production.ts --minor
 *
 * Major version bump:
 *   npx tsx scripts/release-to-production.ts --major
 *
 * Release from a specific commit (instead of latest dev):
 *   npx tsx scripts/release-to-production.ts --commit abc123def
 *
 * Preview specific commit release:
 *   npx tsx scripts/release-to-production.ts --commit abc123def --dry-run
 *
 * Skip minor/major bump confirmation prompts (--yes does NOT skip early checkpoint):
 *   npx tsx scripts/release-to-production.ts --yes
 *
 * Skip the push step:
 *   npx tsx scripts/release-to-production.ts --skip-push
 *
 * ============================================================================
 * SAFETY GUARANTEES (Non-negotiable)
 * ============================================================================
 *
 * This script WILL ABORT if:
 *   - You are not on the `dev` branch
 *   - Working directory has uncommitted changes (requires user confirmation to proceed)
 *   - Any submodule has uncommitted changes or unpushed commits
 *   - Merge conflicts occur (leaves you mid-merge for manual resolution)
 *   - Any MCP lockfile is out of sync or MCP build fails
 *   - Validators fail after merge (leaves you merged-but-unpushed)
 *
 * ============================================================================
 * WORKFLOW SEQUENCE
 * ============================================================================
 *
 * Standard flow (releasing latest dev):
 * 1. Verify on dev branch with clean working directory
 * 2. Check submodule safety
 * 3. Forward-integrate origin/main into dev (catches hotfixes, triage commits)
 * 4. Compare versions between dev and main
 * 5. *** CHECKPOINT *** - Human confirmation required (see below)
 * 6. Bump version on dev (if needed) and push to origin/dev
 * 7. Checkout main and pull --ff-only
 * 8. Merge origin/dev into main
 * 9. Validate MCP lockfiles and build all MCPs
 * 10. Run validators (npm run validate:fast)
 * 11. Push to origin/main
 * 12. Return to dev branch
 *
 * With --commit <sha> (releasing from specific commit):
 * 1. Verify on dev branch with clean working directory
 * 2. Check submodule safety
 * 3. Validate commit exists and is on origin/dev
 * 4. Compare version at commit with main (must be higher)
 * 5. *** CHECKPOINT *** - Human confirmation required (see below)
 * 6. Skip version bump (uses version from the specified commit)
 * 7. Checkout main and pull --ff-only
 * 8. Merge the specific commit into main
 * 9. Validate MCP lockfiles and build all MCPs
 * 10. Run validators (npm run validate:fast)
 * 11. Push to origin/main
 * 12. Return to dev branch
 *
 * NOTE: --commit mode skips forward-integration (step 3 in standard flow)
 * since you're merging a specific historical commit, not latest dev.
 *
 * ============================================================================
 * EARLY CHECKPOINT (MANDATORY)
 * ============================================================================
 *
 * Before any modifications (version bump or merge), the script requires
 * explicit human confirmation. This checkpoint:
 *
 * - Displays the exact version that will be released
 * - Reminds the user to verify the changelog is up to date
 * - Requires typing 'y' to proceed
 *
 * IMPORTANT: This checkpoint is NOT skippable with --yes flag.
 * Once confirmed, the script will merge, validate, and push to main
 * without further prompts.
 *
 * This design ensures AI agents running the script will stop and ask
 * the human user for confirmation before making any changes.
 *
 * ============================================================================
 * RELATED DOCUMENTATION
 * ============================================================================
 *
 * - docs/project/RELEASING.md - Full release process documentation
 * - docs/project/CHANGELOG_UPDATE_PROCESS.md - Changelog conventions
 * - scripts/git-safe-sync.ts - Related safety patterns
 *
 * ============================================================================
 */

import { Cli, Command, Option, UsageError } from 'clipanion';
import { execSync, ExecSyncOptions } from 'child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { fileURLToPath } from 'node:url';
import { resolve } from 'path';
import * as readline from 'readline';
import * as semver from 'semver';
import {
  confirmReleaseCheckpoint as runReleaseCheckpoint,
  CheckpointCancelledError,
} from './lib/release-checkpoint';

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
  WRONG_BRANCH: 10,
  DIRTY_WORKING_TREE: 11,
  SUBMODULE_UNSAFE: 12,
  MERGE_CONFLICT: 20,
  MCP_BUILD_FAILED: 25,
  VALIDATOR_FAILED: 30,
  PUSH_FAILED: 40,
  VERSION_BUMP_FAILED: 50,
  USER_CANCELLED: 60,
  UNKNOWN_ERROR: 99,
} as const;

/**
 * Custom error class that carries the appropriate exit code.
 * Extends UsageError to maintain compatibility with Clipanion's error handling.
 */
class ReleaseError extends UsageError {
  constructor(
    message: string,
    public readonly exitCode: number
  ) {
    super(message);
  }
}

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

/** Result of running a shell command */
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

/** Version bump type */
type BumpType = 'patch' | 'minor' | 'major';

type ManifestVersionResult = { ok: true; version: string } | { ok: false; error: string };

interface GitHubReleaseRun {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

export function fetchManifestVersion(url: string, timeoutMs = 10_000): Promise<ManifestVersionResult> {
  return new Promise((resolveResult) => {
    const manifestUrl = new URL(url);
    manifestUrl.searchParams.set('cb', String(Date.now()));

    const client = manifestUrl.protocol === 'http:' ? http : manifestUrl.protocol === 'https:' ? https : null;
    if (!client) {
      resolveResult({ ok: false, error: `Unsupported protocol: ${manifestUrl.protocol}` });
      return;
    }

    let settled = false;
    const finish = (result: ManifestVersionResult) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    const req = client.get(manifestUrl, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('error', (error) => {
        finish({ ok: false, error: `response stream: ${error.message}` });
      });
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          finish({ ok: false, error: `HTTP ${res.statusCode}` });
          return;
        }

        try {
          const parsed = JSON.parse(body) as { version?: unknown };
          if (typeof parsed.version !== 'string') {
            finish({ ok: false, error: 'manifest missing "version" field' });
            return;
          }
          finish({ ok: true, version: parsed.version });
        } catch (error) {
          finish({ ok: false, error: `JSON parse: ${error instanceof Error ? error.message : String(error)}` });
        }
      });
    });

    req.on('error', (error) => {
      finish({ ok: false, error: error.message });
    });

    req.setTimeout(timeoutMs, () => {
      finish({ ok: false, error: `socket timeout after ${timeoutMs}ms` });
      req.destroy();
    });
  });
}

/**
 * Executes a shell command and captures output.
 * Does NOT throw on failure - returns structured result.
 */
function exec(command: string, options: ExecSyncOptions = {}): CommandResult {
  try {
    const output = execSync(command, {
      ...options,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as string;
    return { success: true, output: output.trim() };
  } catch (error: unknown) {
    const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
    return {
      success: false,
      output: err.stdout?.toString().trim() || '',
      error: err.stderr?.toString().trim() || err.message || 'Unknown error',
      exitCode: err.status,
    };
  }
}

/**
 * True iff `git merge --ff-only <targetRef>` from `baseRef` would fast-forward to
 * exactly targetRef — i.e. baseRef is an ancestor of targetRef. This is the core of
 * the --commit promotion fast-forward guard: it guarantees the merged production tree
 * is exactly the (beta-certified) targetRef tree, with no merge commit. Exported so it
 * can be tested against a real git fixture.
 */
export function isCleanFastForward(baseRef: string, targetRef: string, cwd: string): boolean {
  return exec(`git merge-base --is-ancestor ${baseRef} ${targetRef}`, { cwd }).success;
}

/**
 * Proves a `git push` will ACTUALLY execute the pre-push hook (which runs
 * validate:fast unconditionally). The in-script validate:fast may only be safely
 * skipped when this returns true — file existence alone is NOT proof: Git skips hooks
 * when HUSKY=0 or core.hooksPath is unset/misrouted (a known silent-disable class —
 * see scripts/check-husky-hooks-path.ts). Fail-safe: any uncertainty → false. Exported
 * so it can be tested against a real git fixture.
 */
export function prePushHookWillRun(repoRoot: string): boolean {
  if (process.env.HUSKY === '0') return false;
  const hooksPathResult = exec('git config --get core.hooksPath', { cwd: repoRoot });
  const hooksPath = hooksPathResult.success ? hooksPathResult.output.trim() : '';
  if (!hooksPath) return false;
  // The wrapper Git actually invokes (e.g. .husky/_/pre-push) must exist, and it
  // sources the real hook body (.husky/pre-push) — require both.
  if (!existsSync(resolve(repoRoot, hooksPath, 'pre-push'))) return false;
  if (!existsSync(resolve(repoRoot, '.husky', 'pre-push'))) return false;
  return true;
}

/**
 * Parses `gh run list ... --json databaseId,headSha,status,conclusion` output and
 * returns the release run whose headSha matches, or null on no-match / non-array /
 * parse error. Pure (no I/O) — exported for testing.
 */
export function selectStableReleaseRun(ghOutput: string, headSha: string): GitHubReleaseRun | null {
  try {
    const runs = JSON.parse(ghOutput) as GitHubReleaseRun[];
    if (!Array.isArray(runs)) return null;
    return runs.find((run) => run.headSha === headSha) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the "GCS manifest did not advance" warning should be SOFTENED to an
 * informational "stable build still running" note. Only true when we found the
 * matching stable run AND it is still queued/in_progress — a completed run (including
 * a failed one), or no run at all, must still get the hard warning so a genuine
 * publish failure is never masked. Pure — exported for testing.
 */
export function shouldSoftenGcsWarning(run: GitHubReleaseRun | null): run is GitHubReleaseRun {
  return run !== null && (run.status === 'in_progress' || run.status === 'queued');
}

/**
 * Parses .gitmodules to get submodule paths dynamically.
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

/**
 * Prompts the user for confirmation (y/n).
 * Returns true if user confirms, false otherwise.
 */
async function promptConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// -----------------------------------------------------------------------------
// MAIN COMMAND CLASS
// -----------------------------------------------------------------------------

class ReleaseToProductionCommand extends Command {
  // ---------------------------------------------------------------------------
  // CLI CONFIGURATION
  // ---------------------------------------------------------------------------

  static paths = [['release-to-production'], ['release'], Command.Default];

  static usage = Command.Usage({
    description: 'Release latest code from dev to production (main)',
    details: `
      This script automates releasing from dev to main with proper version bumping,
      validation, and safety checks.

      SAFETY GUARANTEES:
      • Requires you to be on the dev branch
      • Requires clean working directory (no uncommitted changes)
      • Aborts if any submodule has uncommitted changes or unpushed commits
      • Aborts on merge conflicts (leaves you mid-merge for manual resolution)
      • Aborts if validators fail (leaves you merged-but-unpushed for manual fix)

      WORKFLOW:
      1. Verify on dev branch with clean working directory
      2. Check submodule safety
      3. Forward-integrate origin/main into dev (prevents merge conflicts)
      4. *** CHECKPOINT *** (requires human confirmation — only prompt in the flow)
      5. Bump version on dev and push to origin/dev
      6. Checkout main, merge, validate, and push to origin/main

      SPECIFIC COMMIT RELEASE (--commit <sha>):
      Instead of releasing latest dev, release from a specific commit on dev.
      The commit must:
      • Exist and be an ancestor of origin/dev
      • Have a version in package.json higher than origin/main
      Version bumping is skipped - the commit must already have the correct version.

      EARLY CHECKPOINT:
      Before any modifications, the script requires human confirmation showing:
      • The exact version that will be released
      • A reminder to verify the changelog is up to date
      IMPORTANT: This checkpoint is NOT skippable with --yes.
      Once confirmed, the script merges, validates, and pushes to main
      without further prompts.

      See docs/project/RELEASING.md for full documentation.
    `,
    examples: [
      ['Release with patch bump (default)', 'npx tsx scripts/release-to-production.ts'],
      ['Preview without executing', 'npx tsx scripts/release-to-production.ts --dry-run'],
      ['Release with minor bump', 'npx tsx scripts/release-to-production.ts --minor'],
      ['Release with major bump', 'npx tsx scripts/release-to-production.ts --major'],
      ['Release from specific commit', 'npx tsx scripts/release-to-production.ts --commit abc123def'],
      ['Preview commit release', 'npx tsx scripts/release-to-production.ts --commit abc123def --dry-run'],
      ['Skip minor/major bump confirmation', 'npx tsx scripts/release-to-production.ts --yes'],
    ],
  });

  // ---------------------------------------------------------------------------
  // CLI OPTIONS
  // ---------------------------------------------------------------------------

  /** Show what would happen without executing */
  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Show what would happen without executing',
  });

  /** Bump minor version instead of patch */
  minor = Option.Boolean('--minor', false, {
    description: 'Bump minor version instead of patch',
  });

  /** Bump major version instead of patch */
  major = Option.Boolean('--major', false, {
    description: 'Bump major version instead of patch',
  });

  /** Skip the push to main step */
  skipPush = Option.Boolean('--skip-push', false, {
    description: 'Do everything except push to main',
  });

  /** Require --commit releases to fast-forward main to the certified SHA */
  requireFastForward = Option.Boolean('--require-fast-forward', true, {
    description: 'Require --commit releases to be a clean fast-forward from origin/main',
  });

  /** Force the in-script validate:fast run even when the pre-push hook will run it */
  localValidate = Option.Boolean('--local-validate', false, {
    description: 'Run npm run validate:fast inside the script even when the pre-push hook will also validate',
  });

  /** Skip version bump (if already bumped) */
  skipVersionBump = Option.Boolean('--skip-version-bump', false, {
    description: 'Skip version bump (if already bumped manually)',
  });

  /** Skip minor/major bump confirmation prompts (does NOT skip early checkpoint) */
  yes = Option.Boolean('--yes,-y', false, {
    description: 'Skip minor/major bump confirmation (does NOT skip early checkpoint)',
  });

  /** Show detailed output */
  verbose = Option.Boolean('-v,--verbose', false, {
    description: 'Show detailed output',
  });

  /** Allow proceeding when git fetch fails (use stale refs) */
  allowStaleRefs = Option.Boolean('--allow-stale-refs', false, {
    description: 'Allow proceeding when git fetch fails (uses local data)',
  });

  /** Release from a specific commit SHA on dev instead of latest */
  commit = Option.String('--commit', {
    description: 'Release from a specific commit SHA on dev instead of latest',
  });

  /**
   * Non-interactive acknowledgement that the changelog is current for the release.
   * Must equal the EXACT version being released (e.g. --confirm-changelog-current 0.4.48),
   * so a stale copied command cannot acknowledge the wrong release. This is the only way to
   * pass the human checkpoint without an interactive TTY; --yes deliberately does NOT skip it.
   */
  confirmChangelogCurrent = Option.String('--confirm-changelog-current', {
    description:
      'Acknowledge non-interactively that the changelog is current for THIS exact release version (e.g. --confirm-changelog-current 0.4.48). Must match the version being released; the only checkpoint bypass for non-interactive runs.',
  });

  private pushedMainSha: string | null = null;

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
  // GIT HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Navigates to repository root and returns the path.
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
   * Checks if the working tree is dirty.
   */
  private isWorkingTreeDirty(repoRoot: string): boolean {
    const result = exec('git status --porcelain', { cwd: repoRoot });
    return result.success && result.output.length > 0;
  }

  /**
   * Fetches from remote.
   */
  private fetchRemote(repoRoot: string): boolean {
    this.logInfo('Fetching from origin...');
    const result = exec('git fetch origin', { cwd: repoRoot });
    if (!result.success) {
      this.logWarning(`Could not fetch: ${result.error}`);
      return false;
    }
    return true;
  }

  /**
   * Gets the state of a single submodule.
   */
  private getSubmoduleState(repoRoot: string, subPath: string): SubmoduleState {
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

    // Check if HEAD is on any remote branch (origin only)
    const branchResult = exec('git branch -r --contains HEAD', { cwd: fullPath });
    if (branchResult.success) {
      state.remoteBranches = branchResult.output
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b.length > 0)
        .filter((b) => b.startsWith('origin/'));
      state.isOnRemoteBranch = state.remoteBranches.length > 0;
    } else {
      state.isOnRemoteBranch = false;
      state.remoteBranches = [];
    }

    return state;
  }

  /**
   * Gets version from a remote branch's package.json.
   */
  private getVersionFromRemoteBranch(repoRoot: string, branch: string): string | null {
    const result = exec(`git show origin/${branch}:package.json`, { cwd: repoRoot });
    if (!result.success) {
      return null;
    }
    try {
      const pkg = JSON.parse(result.output);
      return pkg.version || null;
    } catch {
      return null;
    }
  }

  /**
   * Validates that a commit exists and is an ancestor of origin/dev.
   * Returns the resolved full SHA if valid.
   */
  private validateCommitOnDev(
    repoRoot: string,
    sha: string
  ): { valid: boolean; resolvedSha: string; error?: string } {
    // SECURITY: Validate SHA format to prevent shell injection
    // Git SHAs are hexadecimal strings (short: 7-12 chars, full: 40 chars)
    const shaPattern = /^[0-9a-fA-F]{7,40}$/;
    if (!shaPattern.test(sha)) {
      return {
        valid: false,
        resolvedSha: '',
        error: `Invalid commit SHA format: '${sha}'. Must be 7-40 hexadecimal characters.`,
      };
    }

    // Resolve to full SHA and verify it's a valid commit object
    const resolveResult = exec(`git rev-parse --verify ${sha}^{commit}`, { cwd: repoRoot });
    if (!resolveResult.success) {
      return {
        valid: false,
        resolvedSha: '',
        error: `Commit '${sha}' not found or not a valid commit object`,
      };
    }
    const resolvedSha = resolveResult.output;

    // Verify the commit is an ancestor of origin/dev
    const ancestorResult = exec(`git merge-base --is-ancestor ${resolvedSha} origin/dev`, {
      cwd: repoRoot,
    });
    if (!ancestorResult.success) {
      return {
        valid: false,
        resolvedSha,
        error: `Commit '${sha}' (${resolvedSha.substring(0, 8)}) is not on origin/dev branch`,
      };
    }

    return { valid: true, resolvedSha };
  }

  /**
   * Gets version from package.json at a specific commit.
   */
  private getVersionFromCommit(repoRoot: string, sha: string): string | null {
    const result = exec(`git show ${sha}:package.json`, { cwd: repoRoot });
    if (!result.success) {
      return null;
    }
    try {
      const pkg = JSON.parse(result.output);
      return pkg.version || null;
    } catch {
      return null;
    }
  }

  /**
   * Early checkpoint requiring human confirmation before any modifications.
   * This is the only human checkpoint - once confirmed, the script proceeds
   * through merge, validation, and push without further prompts.
   * NOT skippable with --yes flag. The only non-interactive bypass is an explicit,
   * version-valued --confirm-changelog-current <version> that must match the release exactly
   * (so an agent must stop, ask the human, and re-run with the acknowledged version).
   * The prominent "HUMAN CONFIRMATION REQUIRED" text helps AI agents recognize they need
   * to stop and ask the user for confirmation.
   */
  private async confirmReleaseCheckpoint(version: string): Promise<void> {
    // Delegates to the shared `scripts/lib/release-checkpoint.ts` so this gate
    // and the CI-triggered promote driver enforce the SAME rule from one
    // implementation. Behaviour-preserving: identical banner, dry-run
    // auto-proceed, version-exact-match non-interactive path, non-TTY
    // fail-closed, and TTY 'y' check. The shared fn signals cancellation via
    // CheckpointCancelledError; we map that to ReleaseError + USER_CANCELLED so
    // the command's exit-code contract is unchanged.
    try {
      await runReleaseCheckpoint({
        version,
        confirmChangelogCurrent: this.confirmChangelogCurrent,
        dryRun: this.dryRun,
        isTTY: Boolean(process.stdin.isTTY),
        log: (message, color) => this.log(message, color),
        promptLine: (question) => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          return new Promise<string>((resolve) => {
            rl.question(question, (ans) => {
              rl.close();
              resolve(ans);
            });
          });
        },
      });
    } catch (error) {
      if (error instanceof CheckpointCancelledError) {
        throw new ReleaseError(error.message, EXIT_CODES.USER_CANCELLED);
      }
      throw error;
    }
  }

  /**
   * Gets version from local package.json.
   */
  private getLocalVersion(repoRoot: string): string {
    const pkgPath = resolve(repoRoot, 'package.json');
    const content = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(content);
    return pkg.version;
  }

  /**
   * Updates version in package.json and package-lock.json.
   */
  private updateVersionFiles(repoRoot: string, newVersion: string): void {
    // Update package.json
    const pkgPath = resolve(repoRoot, 'package.json');
    const pkgContent = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgContent);
    pkg.version = newVersion;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    // Update package-lock.json (root version and packages[""] version)
    const lockPath = resolve(repoRoot, 'package-lock.json');
    const lockContent = readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(lockContent);
    lock.version = newVersion;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = newVersion;
    }
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }

  /**
   * Checks for merge conflicts using porcelain format.
   */
  private hasGitConflicts(repoRoot: string): boolean {
    const statusResult = exec('git status --porcelain', { cwd: repoRoot });
    if (!statusResult.success) {
      return false;
    }

    return statusResult.output.split('\n').some((line) => {
      if (line.length < 2) return false;
      const xy = line.substring(0, 2);
      return xy.includes('U') || xy === 'AA' || xy === 'DD';
    });
  }

  /**
   * Validates the user-facing changelog has a `## v<version>` heading for the
   * release version. Mirrors the CI check in `.github/workflows/release.yml`
   * (Publish to Google Cloud Storage → Validate changelog matches release version)
   * so we fail locally before pushing to main, not after a 25-minute build.
   *
   * Common cause of failure: writers leave the new section under `## Unreleased`
   * instead of `## v<version> — <date range>`. Per CHANGELOG_UPDATE_PROCESS.md,
   * the heading must match the package.json version.
   */
  private validateChangelogForRelease(
    repoRoot: string,
    version: string
  ): { success: boolean; reason?: string; hasUnreleased?: boolean } {
    const changelogPath = resolve(repoRoot, 'rebel-system', 'help-for-humans', 'changelog.md');
    if (!existsSync(changelogPath)) {
      return { success: false, reason: `Changelog not found at ${changelogPath}` };
    }

    let content: string;
    try {
      content = readFileSync(changelogPath, 'utf8');
    } catch (error) {
      return {
        success: false,
        reason: `Could not read changelog: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const versionHeadingPattern = new RegExp(`^## v${version.replace(/\./g, '\\.')}(\\s|$)`, 'm');
    if (versionHeadingPattern.test(content)) {
      return { success: true };
    }

    const hasUnreleased = /^## Unreleased(\s|$)/m.test(content);
    return {
      success: false,
      reason: `Changelog at rebel-system/help-for-humans/changelog.md is missing a '## v${version}' heading.`,
      hasUnreleased,
    };
  }

  /**
   * Validates all MCP lockfiles are in sync and builds all MCPs.
   * This catches issues like stale lockfiles (missing transitive deps)
   * and TypeScript/bundling errors before they reach CI.
   *
   * Returns { success, failures } where failures lists MCP names that failed.
   */
  private validateMcpBuilds(repoRoot: string): { success: boolean; failures: string[] } {
    const mcpRoot = resolve(repoRoot, 'resources', 'mcp');
    if (!existsSync(mcpRoot)) {
      return { success: true, failures: [] };
    }

    const failures: string[] = [];

    // Phase 1: Verify lockfile consistency (npm ci) for all MCPs with package-lock.json
    this.logInfo('Checking MCP lockfile consistency...');
    const mcpDirs = readdirSync(mcpRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(resolve(mcpRoot, name, 'package-lock.json')));

    for (const mcpName of mcpDirs) {
      const mcpPath = resolve(mcpRoot, mcpName);
      const result = exec('npm ci --ignore-scripts', { cwd: mcpPath });
      if (!result.success) {
        this.logError(`${mcpName}: lockfile out of sync`);
        this.logVerbose(result.error || '');
        failures.push(mcpName);
      } else {
        this.logVerbose(`${mcpName}: lockfile OK`);
      }
    }

    if (failures.length > 0) {
      return { success: false, failures };
    }
    this.logSuccess(`All ${mcpDirs.length} MCP lockfiles verified`);

    // Phase 2: Run the full MCP build script
    this.logInfo('Building all MCPs...');
    const buildResult = exec('node scripts/build-bundled-mcps.mjs', { cwd: repoRoot });
    if (!buildResult.success) {
      // Parse which MCPs failed from the output
      const failedMatch = buildResult.output.match(/❌ \d+ MCPs failed:\n([\s\S]*?)(?:\n\n|$)/);
      if (failedMatch) {
        const failedNames = failedMatch[1]
          .split('\n')
          .map((l) => l.trim().replace(/^- /, ''))
          .filter((l) => l.length > 0);
        failures.push(...failedNames);
      } else {
        failures.push('(unknown - check build output)');
      }
      this.logError('MCP build failed');
      this.logVerbose(buildResult.error || '');
      return { success: false, failures };
    }

    this.logSuccess('All MCPs built successfully');
    return { success: true, failures: [] };
  }

  /**
   * Updates submodules to match the current superproject state.
   * This ensures submodule working directories match the committed refs after checkout/merge.
   */
  private updateSubmodules(repoRoot: string): boolean {
    const result = exec('git submodule update --init --recursive', { cwd: repoRoot });
    return result.success;
  }

  // ---------------------------------------------------------------------------
  // STAGE IMPLEMENTATIONS
  // ---------------------------------------------------------------------------

  /**
   * Stage 1 & 2: Validate git state (branch, working tree, submodules)
   */
  private async validateGitState(repoRoot: string): Promise<void> {
    this.logSection('Git State Validation');

    // Check we're on dev branch
    const currentBranch = this.getCurrentBranch(repoRoot);
    if (currentBranch !== 'dev') {
      this.logError(`Must be on 'dev' branch, but you're on '${currentBranch}'`);
      this.log('\n  To switch to dev:', colors.yellow);
      this.log('    git checkout dev', colors.cyan);
      throw new ReleaseError(`Wrong branch: ${currentBranch}`, EXIT_CODES.WRONG_BRANCH);
    }
    this.logSuccess(`On branch: ${currentBranch}`);

    // Check working tree is clean (warn + confirm if dirty)
    if (this.isWorkingTreeDirty(repoRoot)) {
      this.log('  ⚠️  Working directory has uncommitted changes', colors.yellow);
      this.log('\n  These changes will NOT be included in the release.', colors.yellow);
      this.log('  Run `git status` to review them.\n', colors.cyan);

      if (this.dryRun) {
        this.logInfo('DRY RUN: Would ask for confirmation to proceed with dirty working tree');
      } else {
        const confirmed = await promptConfirmation('  Proceed anyway? (confirm you don\'t need these changes in the release)');
        if (!confirmed) {
          throw new ReleaseError('User cancelled due to uncommitted changes', EXIT_CODES.DIRTY_WORKING_TREE);
        }
        this.logSuccess('Proceeding with uncommitted changes (user confirmed)');
      }
    } else {
      this.logSuccess('Working tree is clean');
    }

    // Fetch latest from origin
    if (!this.fetchRemote(repoRoot)) {
      if (this.allowStaleRefs) {
        this.log('', colors.reset);
        this.log('  ╔════════════════════════════════════════════════════════════════╗', colors.yellow);
        this.log('  ║  WARNING: Proceeding with stale refs (--allow-stale-refs)      ║', colors.yellow);
        this.log('  ║  Remote data could not be fetched - using local data only.     ║', colors.yellow);
        this.log('  ║  Version comparisons may be inaccurate.                        ║', colors.yellow);
        this.log('  ╚════════════════════════════════════════════════════════════════╝', colors.yellow);
        this.log('', colors.reset);
      } else {
        this.logError('Could not fetch from origin - aborting for safety');
        this.log('', colors.reset);
        this.log('  Production releases require fresh data from the remote.', colors.yellow);
        this.log('  To proceed with local data (not recommended), use:', colors.yellow);
        this.log('    --allow-stale-refs', colors.cyan);
        throw new ReleaseError('Fetch failed - cannot verify remote state', EXIT_CODES.UNKNOWN_ERROR);
      }
    }

    // Fetch submodule remotes
    const submodulePaths = getSubmodulePaths(repoRoot);
    for (const subPath of submodulePaths) {
      const fullPath = resolve(repoRoot, subPath);
      if (existsSync(fullPath)) {
        exec('git fetch --quiet', { cwd: fullPath });
      }
    }

    // Check submodule safety
    this.logSection('Submodule Safety Check');

    if (submodulePaths.length === 0) {
      this.logInfo('No submodules found');
    } else {
      const errors: string[] = [];
      const recovery: string[] = [];

      for (const subPath of submodulePaths) {
        const state = this.getSubmoduleState(repoRoot, subPath);
        this.log(`\n  📦 ${state.name} (${state.currentCommit || 'unknown'})`, colors.bright);

        if (state.checkFailed) {
          this.logWarning(`Check failed: ${state.checkError}`);
          errors.push(`${state.name}: Could not verify safety (${state.checkError})`);
          recovery.push(`Initialize submodule: git submodule update --init ${state.path}`);
          continue;
        }

        if (state.hasUncommittedChanges) {
          this.logError('Has uncommitted changes');
          errors.push(`${state.name}: Has uncommitted changes`);
          recovery.push(`cd ${state.path} && git add -A && git commit -m "your message"`);
        } else {
          this.logSuccess('No uncommitted changes');
        }

        if (state.isOnRemoteBranch) {
          this.logSuccess(`HEAD is on remote: ${state.remoteBranches.join(', ')}`);
        } else {
          this.logError('HEAD is NOT on any remote branch - UNPUSHED COMMITS');
          errors.push(`${state.name}: Has unpushed commits`);
          recovery.push(`cd ${state.path} && git push origin HEAD:<target-branch>  # typically 'main'`);
        }
      }

      if (errors.length > 0) {
        this.log('\n  Recovery steps:', colors.yellow);
        for (let i = 0; i < recovery.length; i++) {
          this.log(`  ${i + 1}. ${recovery[i]}`, colors.cyan);
        }
        this.log('\n  After fixing, run this script again.', colors.yellow);
        throw new ReleaseError('Submodule safety check failed', EXIT_CODES.SUBMODULE_UNSAFE);
      }
    }

    // Verify both branches exist on origin
    const devExists = exec('git rev-parse origin/dev', { cwd: repoRoot });
    const mainExists = exec('git rev-parse origin/main', { cwd: repoRoot });

    if (!devExists.success) {
      this.logError('origin/dev does not exist');
      throw new ReleaseError('origin/dev not found', EXIT_CODES.UNKNOWN_ERROR);
    }
    if (!mainExists.success) {
      this.logError('origin/main does not exist');
      throw new ReleaseError('origin/main not found', EXIT_CODES.UNKNOWN_ERROR);
    }
    this.logSuccess('Both origin/dev and origin/main exist');
  }

  /**
   * Stage 3: Compare versions between dev and main
   */
  private async compareVersions(repoRoot: string): Promise<{ devVersion: string; mainVersion: string; needsBump: boolean }> {
    this.logSection('Version Comparison');

    const devVersion = this.getVersionFromRemoteBranch(repoRoot, 'dev');
    const mainVersion = this.getVersionFromRemoteBranch(repoRoot, 'main');

    if (!devVersion) {
      throw new ReleaseError('Could not read version from origin/dev:package.json', EXIT_CODES.VERSION_BUMP_FAILED);
    }
    if (!mainVersion) {
      throw new ReleaseError('Could not read version from origin/main:package.json', EXIT_CODES.VERSION_BUMP_FAILED);
    }

    this.logInfo(`dev version:  ${devVersion}`);
    this.logInfo(`main version: ${mainVersion}`);

    const comparison = semver.compare(devVersion, mainVersion);
    const needsBump = comparison <= 0;

    if (comparison > 0) {
      this.logSuccess(`dev (${devVersion}) is ahead of main (${mainVersion}) - version already bumped`);
    } else if (comparison === 0) {
      this.logWarning(`dev and main have same version (${devVersion}) - bump required`);
    } else {
      // dev < main - unusual situation, usually indicates a hotfix was applied directly to main
      this.log('', colors.reset);
      this.log(`  ${'═'.repeat(56)}`, colors.yellow);
      this.log(`  ⚠️  UNUSUAL: dev version (${devVersion}) is BEHIND main (${mainVersion})`, colors.yellow);
      this.log('', colors.reset);
      this.log('  This typically happens when:', colors.yellow);
      this.log('    - A hotfix was applied directly to main', colors.yellow);
      this.log('    - Version was bumped on main without merging back to dev', colors.yellow);
      this.log('', colors.reset);
      this.log('  Per RELEASING.md, this is a red flag that should be investigated.', colors.yellow);
      this.log('  The script will bump dev to a version HIGHER than main.', colors.yellow);
      this.log(`  ${'═'.repeat(56)}`, colors.yellow);
      this.log('', colors.reset);

      if (!this.yes) {
        const confirmed = await promptConfirmation('  Proceed with release despite dev < main?');
        if (!confirmed) {
          throw new ReleaseError('User cancelled due to dev < main version', EXIT_CODES.USER_CANCELLED);
        }
      } else {
        this.logInfo('--yes flag set, proceeding despite dev < main');
      }
    }

    return { devVersion, mainVersion, needsBump };
  }

  /**
   * Stage 4: Bump version on dev and push
   * @param baseVersion - The version to bump FROM (may be mainVersion if dev < main)
   */
  private async bumpVersionOnDev(repoRoot: string, baseVersion: string): Promise<string> {
    const bumpType: BumpType = this.major ? 'major' : this.minor ? 'minor' : 'patch';

    this.logSection(`Version Bump (${bumpType})`);

    const newVersion = semver.inc(baseVersion, bumpType);
    if (!newVersion) {
      throw new ReleaseError(`Failed to increment version ${baseVersion}`, EXIT_CODES.VERSION_BUMP_FAILED);
    }

    this.logInfo(`Bumping: ${baseVersion} → ${newVersion}`);

    // Warn for minor/major bumps about changelog
    if ((this.minor || this.major) && !this.yes) {
      this.log('', colors.reset);
      this.log(`  ${'═'.repeat(56)}`, colors.yellow);
      this.log(`  ⚠️  You're bumping a ${bumpType.toUpperCase()} version.`, colors.yellow);
      this.log('', colors.reset);
      this.log('  Please ensure changelog entries are correctly assigned', colors.yellow);
      this.log('  to this version. See:', colors.yellow);
      this.log('    docs/project/CHANGELOG_UPDATE_PROCESS.md', colors.cyan);
      this.log(`  ${'═'.repeat(56)}`, colors.yellow);
      this.log('', colors.reset);

      const confirmed = await promptConfirmation('  Continue with version bump?');
      if (!confirmed) {
        throw new ReleaseError('User cancelled version bump', EXIT_CODES.USER_CANCELLED);
      }
    }

    if (this.dryRun) {
      this.logInfo(`Would update package.json to version ${newVersion}`);
      this.logInfo('Would commit: chore: bump version to ' + newVersion);
      this.logInfo('Would push to origin/dev');
    } else {
      // Update version files
      this.updateVersionFiles(repoRoot, newVersion);
      this.logSuccess('Updated package.json and package-lock.json');

      // Commit the version bump
      const addResult = exec('git add package.json package-lock.json', { cwd: repoRoot });
      if (!addResult.success) {
        throw new ReleaseError(`Failed to stage files: ${addResult.error}`, EXIT_CODES.VERSION_BUMP_FAILED);
      }

      const commitResult = exec(`git commit -m "chore: bump version to ${newVersion}"`, { cwd: repoRoot });
      if (!commitResult.success) {
        throw new ReleaseError(`Failed to commit: ${commitResult.error}`, EXIT_CODES.VERSION_BUMP_FAILED);
      }
      this.logSuccess(`Committed: chore: bump version to ${newVersion}`);

      // Push to origin/dev - CRITICAL: must happen before merge
      const pushResult = exec('git push origin dev', { cwd: repoRoot });
      if (!pushResult.success) {
        this.logError(`Failed to push to origin/dev: ${pushResult.error}`);
        this.log('\n  The version bump is committed locally but not pushed.', colors.yellow);
        this.log('  Try manually: git push origin dev', colors.cyan);
        this.log('  If origin/dev has new commits: git pull --rebase origin dev && git push origin dev', colors.cyan);
        throw new ReleaseError('Failed to push version bump to origin/dev', EXIT_CODES.PUSH_FAILED);
      }
      this.logSuccess('Pushed version bump to origin/dev');
    }

    return newVersion;
  }

  /**
   * Forward-integrate: merge origin/main into dev before the release merge.
   * This picks up any commits that landed directly on main (e.g. daily sentry
   * triage, hotfixes) so the later dev->main merge is conflict-free.
   *
   * If the merge itself conflicts, the script aborts with recovery instructions
   * — the user resolves the conflict on dev (low-stakes) rather than on main
   * (high-stakes, blocks the release pipeline).
   */
  private async forwardIntegrateMain(repoRoot: string): Promise<void> {
    this.logSection('Forward-Integrate Main into Dev');

    // Check if there are any main-only commits to integrate
    const aheadResult = exec('git rev-list --count origin/dev..origin/main', { cwd: repoRoot });
    const aheadCount = aheadResult.success ? parseInt(aheadResult.output, 10) : 0;

    if (aheadCount === 0) {
      this.logSuccess('origin/main has no commits ahead of origin/dev — nothing to integrate');
      return;
    }

    this.logInfo(`origin/main has ${aheadCount} commit(s) not yet on dev — merging now`);

    if (this.dryRun) {
      this.logInfo('Would merge origin/main into dev');
      this.logInfo('Would push updated dev to origin');
      return;
    }

    const mergeResult = exec('git merge --no-edit origin/main', { cwd: repoRoot });
    if (!mergeResult.success) {
      if (this.hasGitConflicts(repoRoot)) {
        this.logError('Merge conflict while integrating main into dev!');
        this.log('', colors.reset);
        this.log('  You are on the dev branch with a merge conflict from origin/main.', colors.yellow);
        this.log('  Resolve the conflict here (on dev) — this is safer than resolving on main.', colors.yellow);
        this.log('', colors.reset);
        this.log('  To resolve:', colors.yellow);
        this.log('  1. View conflicts: git status', colors.cyan);
        this.log('  2. Edit conflicting files and resolve conflicts', colors.cyan);
        this.log('  3. Stage resolved files: git add <files>', colors.cyan);
        this.log('  4. Complete merge: git commit', colors.cyan);
        this.log('  5. Push: git push origin dev', colors.cyan);
        this.log('  6. Re-run the release script', colors.cyan);
        this.log('', colors.reset);
        this.log('  To abort:', colors.yellow);
        this.log('  git merge --abort', colors.cyan);
        throw new ReleaseError(
          'Merge conflict integrating main into dev — resolve on dev and re-run',
          EXIT_CODES.MERGE_CONFLICT
        );
      }
      throw new ReleaseError(
        `Failed to merge origin/main into dev: ${mergeResult.error}`,
        EXIT_CODES.MERGE_CONFLICT
      );
    }
    this.logSuccess('Merged origin/main into dev');

    // Push the integrated dev branch
    const pushResult = exec('git push origin dev', { cwd: repoRoot });
    if (!pushResult.success) {
      this.logError(`Failed to push integrated dev: ${pushResult.error}`);
      this.log('', colors.reset);
      this.log('  The merge succeeded locally but could not be pushed.', colors.yellow);
      this.log('  Try: git push origin dev', colors.cyan);
      throw new ReleaseError('Failed to push forward-integrated dev', EXIT_CODES.PUSH_FAILED);
    }
    this.logSuccess('Pushed forward-integrated dev to origin');
  }

  /**
   * Stage 5: Merge, validate, and push to main
   * @param mergeRef - The ref to merge into main (defaults to 'origin/dev', can be a specific commit SHA)
   * Returns exit code (0 for success, non-zero for failure)
   */
  private async mergeAndPushToMain(repoRoot: string, version: string, mergeRef: string = 'origin/dev'): Promise<number> {
    this.logSection('Merge dev into main');

    if (this.dryRun) {
      this.logInfo('Would fetch origin dev to ensure ref is current');
      this.logInfo('Would checkout main');
      this.logInfo('Would pull --ff-only origin main');
      if (this.commit && this.requireFastForward) {
        this.logInfo(`Would verify origin/main is an ancestor of ${mergeRef}, then merge --ff-only ${mergeRef} (aborts if not a clean fast-forward)`);
      } else {
        this.logInfo(`Would merge --no-edit ${mergeRef}`);
      }
      this.logInfo('Would update submodules');
      this.logInfo('Would validate MCP lockfiles and build all MCPs');
      this.logInfo('Would run npm run validate:fast (unless the pre-push hook will validate the pushed tree)');
      this.logInfo(`Would push to origin main`);
      this.logInfo('Would checkout dev');
      this.logInfo('Would update submodules on dev');
      return EXIT_CODES.SUCCESS;
    }

    // Fetch origin/dev to ensure we have the latest ref (including any bump we just pushed)
    this.logInfo('Fetching origin/dev to ensure ref is current...');
    const fetchDevResult = exec('git fetch origin dev', { cwd: repoRoot });
    if (!fetchDevResult.success) {
      this.logError(`Failed to fetch origin/dev: ${fetchDevResult.error}`);
      throw new ReleaseError('Failed to fetch origin/dev', EXIT_CODES.UNKNOWN_ERROR);
    }

    // Checkout main
    const checkoutResult = exec('git checkout main', { cwd: repoRoot });
    if (!checkoutResult.success) {
      throw new ReleaseError(`Failed to checkout main: ${checkoutResult.error}`, EXIT_CODES.UNKNOWN_ERROR);
    }
    this.logSuccess('Checked out main');

    // Pull --ff-only
    const pullResult = exec('git pull --ff-only origin main', { cwd: repoRoot });
    if (!pullResult.success) {
      this.logError(`Failed to pull main: ${pullResult.error}`);
      this.log('\n  Your local main may have diverged from origin.', colors.yellow);
      this.log('  Try: git checkout main && git reset --hard origin/main', colors.cyan);
      // Return to dev before throwing
      exec('git checkout dev', { cwd: repoRoot });
      throw new ReleaseError('Failed to pull main with --ff-only', EXIT_CODES.UNKNOWN_ERROR);
    }
    this.logSuccess('Pulled latest main (ff-only)');

    if (this.commit && this.requireFastForward) {
      this.logInfo('Verifying --commit promotion is still a clean fast-forward...');
      if (!isCleanFastForward('origin/main', mergeRef, repoRoot)) {
        this.logError(
          'Promotion is no longer a clean fast-forward — origin/main advanced since the certified SHA; re-brief and use the emergency direct-cut path, or pass --no-require-fast-forward to override'
        );
        exec('git checkout dev', { cwd: repoRoot });
        return EXIT_CODES.MERGE_CONFLICT;
      }
      this.logSuccess('origin/main is an ancestor of the certified SHA');
    }

    // Merge the specified ref (origin/dev or specific commit SHA).
    // For a --commit promotion with the fast-forward guard, use --ff-only so the
    // merge itself REFUSES a non-fast-forward (robust even if an ambient
    // merge.ff=false config would otherwise have created a merge commit despite
    // the --is-ancestor pre-check passing). This makes "production tree == the
    // beta-certified tree" true by construction, not by relying on git defaults.
    const mergeFlags = this.commit && this.requireFastForward ? '--ff-only' : '--no-edit';
    const mergeResult = exec(`git merge ${mergeFlags} ${mergeRef}`, { cwd: repoRoot });
    if (!mergeResult.success) {
      if (this.hasGitConflicts(repoRoot)) {
        this.logError('Merge conflict detected!');
        this.log('', colors.reset);
        this.log('  You are now on the main branch with a merge conflict.', colors.yellow);
        this.log('  DO NOT leave this unresolved - it will block future releases.', colors.red);
        this.log('', colors.reset);
        this.log('  To resolve:', colors.yellow);
        this.log('  1. View conflicts: git status', colors.cyan);
        this.log('  2. Edit conflicting files and resolve conflicts', colors.cyan);
        this.log('  3. Stage resolved files: git add <files>', colors.cyan);
        this.log('  4. Complete merge: git commit', colors.cyan);
        this.log('  5. Then run: npm run validate:fast', colors.cyan);
        this.log('  6. Push: git push origin main', colors.cyan);
        this.log('  7. Return to dev: git checkout dev', colors.cyan);
        this.log('', colors.reset);
        this.log('  To abort (go back to dev):', colors.yellow);
        this.log('  git merge --abort && git checkout dev', colors.cyan);
        // Return merge conflict exit code - user needs to resolve manually
        return EXIT_CODES.MERGE_CONFLICT;
      }
      // Not a conflict, some other merge failure
      exec('git checkout dev', { cwd: repoRoot });
      throw new ReleaseError(`Merge failed: ${mergeResult.error}`, EXIT_CODES.MERGE_CONFLICT);
    }
    this.logSuccess(`Merged ${mergeRef} into main`);

    // Update submodules to match the merged state
    this.logSection('Updating Submodules');
    this.logInfo('Running: git submodule update --init --recursive');

    const submoduleUpdateResult = this.updateSubmodules(repoRoot);
    if (!submoduleUpdateResult) {
      this.logError('Submodule update failed!');
      this.log('', colors.reset);
      this.log('  You are merged but submodules failed to update.', colors.yellow);
      this.log('  This may affect validation results.', colors.yellow);
      this.log('', colors.reset);
      this.log('  To fix manually:', colors.yellow);
      this.log('  1. git submodule update --init --recursive', colors.cyan);
      this.log('  2. npm run validate:fast', colors.cyan);
      this.log('  3. git push origin main', colors.cyan);
      this.log('  4. git checkout dev', colors.cyan);
      this.log('', colors.reset);
      this.log('  To abort (discard merge):', colors.yellow);
      this.log('  git reset --hard origin/main && git checkout dev', colors.cyan);
      return EXIT_CODES.SUBMODULE_UNSAFE;
    }
    this.logSuccess('Submodules updated');

    // Validate MCP builds (lockfile consistency + full build)
    this.logSection('MCP Build Validation');
    this.logInfo('Verifying MCP lockfiles and building all MCPs...');

    const mcpResult = this.validateMcpBuilds(repoRoot);
    if (!mcpResult.success) {
      this.logError(`MCP validation failed for: ${mcpResult.failures.join(', ')}`);
      this.log('', colors.reset);
      this.log('  You are merged but unpushed on main.', colors.yellow);
      this.log('  Fix the MCP build errors before pushing.', colors.yellow);
      this.log('', colors.reset);
      this.log('  Common fix: regenerate the lockfile:', colors.yellow);
      for (const name of mcpResult.failures) {
        this.log(`    cd resources/mcp/${name} && rm -rf node_modules package-lock.json && npm install`, colors.cyan);
      }
      this.log('', colors.reset);
      this.log('  After fixing, commit the lockfile and continue:', colors.yellow);
      this.log('  1. git add resources/mcp/*/package-lock.json', colors.cyan);
      this.log('  2. git commit --amend --no-edit', colors.cyan);
      this.log('  3. npm run validate:fast', colors.cyan);
      this.log('  4. git push origin main', colors.cyan);
      this.log('  5. git checkout dev', colors.cyan);
      this.log('', colors.reset);
      this.log('  To abort (discard merge):', colors.yellow);
      this.log('  git reset --hard origin/main && git checkout dev', colors.cyan);
      return EXIT_CODES.MCP_BUILD_FAILED;
    }

    // Run validators
    this.logSection('Running Validators');
    // Only skip the in-script validate:fast when the push will DEMONSTRABLY fire
    // the pre-push hook (which runs validate:fast). If not (no push, HUSKY=0, or a
    // misrouted core.hooksPath), keep the in-script run — it is then the only local gate.
    const prePushWillValidate = !this.skipPush && prePushHookWillRun(repoRoot);

    if (prePushWillValidate && !this.localValidate) {
      this.logInfo('Skipping redundant in-script validate:fast — the pre-push hook + CI will validate the pushed tree');
    } else {
      this.logInfo('Running: npm run validate:fast');

      const validateResult = exec('npm run validate:fast', { cwd: repoRoot });
      if (!validateResult.success) {
        this.logError('Validation failed!');
        this.log('', colors.reset);
        this.log('  You are merged but unpushed on main.', colors.yellow);
        this.log('  Fix the validation errors before pushing.', colors.yellow);
        this.log('', colors.reset);
        this.log('  After fixing:', colors.yellow);
        this.log('  1. npm run validate:fast', colors.cyan);
        this.log('  2. git push origin main', colors.cyan);
        this.log('  3. git checkout dev', colors.cyan);
        this.log('', colors.reset);
        this.log('  To abort (discard merge):', colors.yellow);
        this.log('  git reset --hard origin/main && git checkout dev', colors.cyan);
        // Return validator failed exit code - user needs to fix manually
        return EXIT_CODES.VALIDATOR_FAILED;
      }
      this.logSuccess('Validation passed');
    }

    // Push to production
    this.logSection('Push to Production');

    if (this.skipPush) {
      this.logWarning('--skip-push flag set, not pushing to main');
      this.log('', colors.reset);
      this.log('  You are merged but unpushed on main.', colors.yellow);
      this.log('  To complete the release:', colors.yellow);
      this.log('  1. git push origin main', colors.cyan);
      this.log('  2. git checkout dev', colors.cyan);
      exec('git checkout dev', { cwd: repoRoot });
      // Return success - user explicitly requested skip-push
      return EXIT_CODES.SUCCESS;
    }

    // Push to main
    const pushEnv: NodeJS.ProcessEnv = { ...process.env };
    delete pushEnv.REBEL_CERTIFIED_PROMOTE_SHA;
    const pushMainOptions: ExecSyncOptions = { cwd: repoRoot, env: pushEnv };
    if (this.commit && this.requireFastForward) {
      const certifiedPromoteShaResult = exec('git rev-parse HEAD', { cwd: repoRoot });
      if (certifiedPromoteShaResult.success) {
        // Read by .husky/pre-push to skip redundant local test:fast/test:perf
        // for a certified byte-identical promote; stable CI still gates both.
        pushEnv.REBEL_CERTIFIED_PROMOTE_SHA = certifiedPromoteShaResult.output;
      } else {
        this.logWarning('Could not resolve certified promote SHA for pre-push marker; full local Tier 3 tests will run');
      }
    }
    const pushMainResult = exec('git push origin main', pushMainOptions);
    if (!pushMainResult.success) {
      this.logError(`Failed to push to main: ${pushMainResult.error}`);
      this.log('', colors.reset);
      this.log('  You are merged but unpushed on main.', colors.yellow);
      this.log('  Try: git push origin main', colors.cyan);
      exec('git checkout dev', { cwd: repoRoot });
      throw new ReleaseError('Failed to push to origin/main', EXIT_CODES.PUSH_FAILED);
    }
    this.logSuccess('Pushed to origin/main');
    const pushedMainShaResult = exec('git rev-parse HEAD', { cwd: repoRoot });
    this.pushedMainSha = pushedMainShaResult.success ? pushedMainShaResult.output : null;

    // Return to dev
    exec('git checkout dev', { cwd: repoRoot });
    this.logSuccess('Returned to dev branch');

    // Update submodules after returning to dev to prevent working directory mismatch
    const devSubmoduleResult = this.updateSubmodules(repoRoot);
    if (!devSubmoduleResult) {
      this.logWarning('Submodule update failed on dev - run manually: git submodule update --init --recursive');
    } else {
      this.logSuccess('Submodules updated on dev');
    }

    return EXIT_CODES.SUCCESS;
  }

  /**
   * Post-release: bump version on dev for the next development cycle.
   * Always does a patch bump regardless of what the release bump was.
   * All failures are warnings - the release already succeeded.
   */
  private async postReleaseBump(repoRoot: string, releasedVersion: string): Promise<void> {
    this.logSection('Post-Release Version Bump');

    try {
      const nextVersion = semver.inc(releasedVersion, 'patch');
      if (!nextVersion) {
        this.logWarning(`Could not compute next version from ${releasedVersion} - skipping post-release bump`);
        return;
      }

      // Guard: don't downgrade dev if it's already ahead (e.g., --commit mode releasing an older version)
      const currentDevVersion = this.getLocalVersion(repoRoot);
      if (semver.gte(currentDevVersion, nextVersion)) {
        this.logInfo(`Dev is already at ${currentDevVersion} (>= ${nextVersion}) - skipping post-release bump`);
        return;
      }

      this.logInfo(`Bumping dev to ${nextVersion} for next development cycle`);

      this.updateVersionFiles(repoRoot, nextVersion);
      this.logSuccess('Updated package.json and package-lock.json');

      const addResult = exec('git add package.json package-lock.json', { cwd: repoRoot });
      if (!addResult.success) {
        this.logWarning(`Failed to stage version files: ${addResult.error}`);
        this.logWarning('Manual bump required: update package.json version and push to dev');
        return;
      }

      const commitResult = exec(`git commit -m "chore: bump version to ${nextVersion} after release"`, { cwd: repoRoot });
      if (!commitResult.success) {
        this.logWarning(`Failed to commit: ${commitResult.error}`);
        this.logWarning('Manual bump required: commit version change and push to dev');
        return;
      }
      this.logSuccess(`Committed: chore: bump version to ${nextVersion} after release`);

      const pushResult = exec('git push origin dev', { cwd: repoRoot });
      if (!pushResult.success) {
        this.logWarning(`Failed to push to origin/dev: ${pushResult.error}`);
        this.logWarning('Post-release bump committed locally but not pushed. Run: git push origin dev');
        return;
      }
      this.logSuccess(`Pushed v${nextVersion} to origin/dev`);
    } catch (error) {
      this.logWarning(`Post-release bump failed: ${error instanceof Error ? error.message : String(error)}`);
      this.logWarning('Manual bump required: update package.json version and push to dev');
    }
  }

  private async fetchManifestVersion(url: string): Promise<ManifestVersionResult> {
    return fetchManifestVersion(url);
  }

  private getStableReleaseRunForSha(repoRoot: string, headSha: string): GitHubReleaseRun | null {
    const result = exec(
      'gh run list --workflow release.yml --branch main --limit 3 --json databaseId,headSha,status,conclusion',
      { cwd: repoRoot, timeout: 15_000 }
    );
    if (!result.success) {
      this.logVerbose(`Could not query GitHub Actions release run: ${result.error || result.output}`);
      return null;
    }
    const run = selectStableReleaseRun(result.output, headSha);
    if (run === null) {
      this.logVerbose('No matching GitHub Actions release run (no match / non-array / parse error)');
    }
    return run;
  }

  private async verifyPublishedToGcs(repoRoot: string, releasedVersion: string): Promise<void> {
    // 260511 release pipeline hardening (H1'). Plan: docs/plans/260511_release_pipeline_hardening_post_v0.4.40.md
    const manifestUrl = 'https://storage.googleapis.com/mindstone-rebel/releases/latest.json';
    this.logSection('Verify Published to GCS');

    if (this.dryRun) {
      this.logInfo(`Would poll ${manifestUrl} for v${releasedVersion}`);
      return;
    }

    if (this.skipPush) {
      this.logInfo('Skipping GCS verification (--skip-push: nothing was pushed)');
      return;
    }

    const timeoutMs = 45 * 60 * 1000;
    const intervalMs = 30 * 1000;
    const timeoutMinutes = Math.round(timeoutMs / 60_000);
    // performance.now() is monotonic; bounds the loop even if the system clock jumps backward mid-poll.
    const startedAt = performance.now();
    let lastSeenVersion = '<unknown>';
    let lastError: string | null = null;

    const formatVersion = (version: string) => (version === '<unknown>' ? version : `v${version}`);
    const emitWarning = () => {
      this.log('', colors.reset);
      this.log('╔════════════════════════════════════════════════════════════════════════╗', colors.yellow);
      this.log('║ ⚠️ ⚠️ ⚠️  GCS MANIFEST DID NOT ADVANCE  ⚠️ ⚠️ ⚠️                  ║', colors.yellow);
      this.log('╚════════════════════════════════════════════════════════════════════════╝', colors.yellow);
      this.log('', colors.reset);
      this.logWarning(`Released version: v${releasedVersion}`);
      this.logWarning(`Last seen version: ${formatVersion(lastSeenVersion)}`);
      if (lastError !== null) {
        this.logWarning(`Last transport error: ${lastError}`);
      }
      this.log('', colors.reset);
      this.log('  This likely means the GitHub Actions release pipeline failed or stalled', colors.yellow);
      this.log('  before publish-to-gcs advanced releases/latest.json. The release commit', colors.yellow);
      this.log('  is on origin/main, but users will not receive the update until the GCS', colors.yellow);
      this.log('  publish completes successfully.', colors.yellow);
      this.log('', colors.reset);
      this.log('  Action: open the CI run URL and inspect validate/build/publish-to-gcs:', colors.yellow);
      this.log('    https://github.com/mindstone/rebel-app/actions', colors.cyan);
      this.log('', colors.reset);
      this.log('  See docs-private/investigations/260510_paul_christensen_stale_update_lag.md for context.', colors.cyan);
    };
    const emitWarningOrRunningCiNote = () => {
      const headSha = this.pushedMainSha ?? exec('git rev-parse main', { cwd: repoRoot }).output;
      if (headSha) {
        const stableRun = this.getStableReleaseRunForSha(repoRoot, headSha);
        if (shouldSoftenGcsWarning(stableRun)) {
          const runUrl = `https://github.com/mindstone/rebel-app/actions/runs/${stableRun.databaseId}`;
          this.logInfo(
            `Stable build still running after the ${timeoutMinutes}-min poll window — this is not a manifest failure yet; a stable build is typically ~25-30 min, and queued runs can exceed the poll window. Inspect the run's jobs (esp. publish-to-gcs) at ${runUrl} — a still-running run can have an already-failed job.`
          );
          this.logInfo(`GitHub Actions run status: ${stableRun.status}`);
          this.logInfo(`Last seen GCS version: ${formatVersion(lastSeenVersion)}`);
          if (lastError !== null) {
            this.logInfo(`Last transport error: ${lastError}`);
          }
          return;
        }
      }

      emitWarning();
    };

    try {
      this.logInfo(`Polling ${manifestUrl} for v${releasedVersion} (up to ${timeoutMinutes} min, every 30s)`);

      while (performance.now() - startedAt < timeoutMs) {
        const result = await this.fetchManifestVersion(manifestUrl);
        if (result.ok) {
          lastError = null;
          lastSeenVersion = result.version;
          if (result.version === releasedVersion) {
            const elapsedSeconds = Math.round((performance.now() - startedAt) / 1000);
            this.logSuccess(`GCS manifest advanced to v${releasedVersion} (${elapsedSeconds}s after push)`);
            return;
          }
        } else {
          lastError = result.error;
        }

        const remainingMs = timeoutMs - (performance.now() - startedAt);
        if (remainingMs <= 0) break;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(intervalMs, remainingMs)));
      }

      emitWarningOrRunningCiNote();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      emitWarningOrRunningCiNote();
    }
  }

  // ---------------------------------------------------------------------------
  // MAIN EXECUTION
  // ---------------------------------------------------------------------------

  async execute(): Promise<number> {
    try {
      // Header
      this.log('\n╔════════════════════════════════════════════════════════════╗', colors.bright);
      this.log('║        Mindstone Rebel - Release to Production             ║', colors.bright);
      this.log('╚════════════════════════════════════════════════════════════╝', colors.bright);

      // Show mode
      if (this.dryRun) {
        this.log('\n  🔍 DRY RUN MODE - No changes will be made\n', colors.yellow);
      }

      // Check for incompatible flag combinations with --commit
      if (this.commit) {
        if (this.minor || this.major || this.skipVersionBump) {
          this.logError('--commit cannot be used with --minor, --major, or --skip-version-bump');
          this.log('', colors.reset);
          this.log('  When releasing from a specific commit, the version at that commit is used.', colors.yellow);
          this.log('  Version bumping is not applicable for historical commits.', colors.yellow);
          throw new ReleaseError(
            '--commit cannot be used with --minor, --major, or --skip-version-bump',
            EXIT_CODES.USER_CANCELLED
          );
        }
        this.logInfo(`Releasing from specific commit: ${this.commit}`);
      }

      // Step 1: Navigate to repo root
      const repoRoot = this.getRepoRoot();
      process.chdir(repoRoot);
      this.logVerbose(`Working from: ${repoRoot}`);

      // Stage 1 & 2: Validate git state
      await this.validateGitState(repoRoot);

      // If --commit specified, validate the commit is on dev branch
      let resolvedCommitSha: string | undefined;
      if (this.commit) {
        this.logSection('Commit Validation');
        const validation = this.validateCommitOnDev(repoRoot, this.commit);
        if (!validation.valid) {
          this.logError(validation.error || 'Commit validation failed');
          this.log('', colors.reset);
          this.log('  The --commit flag requires a valid commit that exists on origin/dev.', colors.yellow);
          this.log('  Make sure the commit has been pushed to origin/dev.', colors.yellow);
          throw new ReleaseError(validation.error || 'Invalid commit', EXIT_CODES.USER_CANCELLED);
        }
        resolvedCommitSha = validation.resolvedSha;
        this.logSuccess(`Commit validated: ${resolvedCommitSha.substring(0, 8)}`);
        this.logInfo(`Full SHA: ${resolvedCommitSha}`);
      }

      // Pull latest dev before comparing versions (ensures local matches origin)
      // This is run even in --commit mode to maintain the invariant that local dev isn't diverged
      this.logSection('Sync Local Dev Branch');
      this.logInfo('Pulling latest changes from origin/dev...');

      if (this.dryRun) {
        this.logInfo('Would run: git pull --ff-only origin dev');
      } else {
        const pullDevResult = exec('git pull --ff-only origin dev', { cwd: repoRoot });
        if (!pullDevResult.success) {
          this.logError('Failed to pull origin/dev with --ff-only');
          this.log('', colors.reset);
          this.log('  Your local dev branch has diverged from origin/dev.', colors.yellow);
          this.log('  This usually means you have local commits not on origin.', colors.yellow);
          this.log('', colors.reset);
          this.log('  To investigate:', colors.yellow);
          this.log('    git log origin/dev..HEAD', colors.cyan);
          this.log('', colors.reset);
          this.log('  To force sync with origin (LOSES local commits):', colors.yellow);
          this.log('    git reset --hard origin/dev', colors.cyan);
          throw new ReleaseError('Local dev has diverged from origin/dev', EXIT_CODES.UNKNOWN_ERROR);
        }
        this.logSuccess('Local dev is in sync with origin/dev');
      }

      // Forward-integrate main into dev to prevent merge conflicts.
      // Any commits that landed directly on main (e.g. daily sentry triage)
      // are merged into dev here, so the later dev->main merge is conflict-free.
      if (!this.commit) {
        await this.forwardIntegrateMain(repoRoot);
      }

      // Variables for the release
      let releaseVersion: string;
      let mergeRef: string;

      // Diverge execution flow based on --commit mode vs normal mode
      if (this.commit && resolvedCommitSha) {
        // ═══════════════════════════════════════════════════════════════════
        // --commit MODE: Release from specific commit
        // ═══════════════════════════════════════════════════════════════════

        this.logSection('Version Comparison (from commit)');

        // Get version from the specified commit
        const commitVersion = this.getVersionFromCommit(repoRoot, resolvedCommitSha);
        if (!commitVersion) {
          this.logError(`Could not read version from commit ${resolvedCommitSha.substring(0, 8)}`);
          throw new ReleaseError('Could not read version from specified commit', EXIT_CODES.VERSION_BUMP_FAILED);
        }
        // Validate it's a valid semver
        if (!semver.valid(commitVersion)) {
          this.logError(`Invalid semver in commit: '${commitVersion}'`);
          throw new ReleaseError(`Commit has invalid version format: '${commitVersion}'`, EXIT_CODES.VERSION_BUMP_FAILED);
        }
        this.logInfo(`Commit version: ${commitVersion}`);

        // Get main version
        const mainVersion = this.getVersionFromRemoteBranch(repoRoot, 'main');
        if (!mainVersion) {
          throw new ReleaseError('Could not read version from origin/main:package.json', EXIT_CODES.VERSION_BUMP_FAILED);
        }
        // Validate it's a valid semver
        if (!semver.valid(mainVersion)) {
          this.logError(`Invalid semver on main: '${mainVersion}'`);
          throw new ReleaseError(`Main branch has invalid version format: '${mainVersion}'`, EXIT_CODES.VERSION_BUMP_FAILED);
        }
        this.logInfo(`Main version:   ${mainVersion}`);

        // Compare: commit version must be > main version
        const comparison = semver.compare(commitVersion, mainVersion);
        if (comparison <= 0) {
          this.logError(`Commit version (${commitVersion}) is not ahead of main (${mainVersion})`);
          this.log('', colors.reset);
          this.log('  When releasing from a specific commit, that commit must have a version', colors.yellow);
          this.log('  higher than what is currently on main. This ensures releases always', colors.yellow);
          this.log('  increment the version number.', colors.yellow);
          this.log('', colors.reset);
          this.log('  The commit you specified was likely created before the version was bumped.', colors.yellow);
          this.log('  You may need to choose a different commit or release normally from latest dev.', colors.yellow);
          throw new ReleaseError(
            `Commit version (${commitVersion}) must be greater than main version (${mainVersion})`,
            EXIT_CODES.VERSION_BUMP_FAILED
          );
        }
        this.logSuccess(`Commit (${commitVersion}) is ahead of main (${mainVersion})`);

        // Set release version and merge ref
        releaseVersion = commitVersion;
        mergeRef = resolvedCommitSha;

        // Checkpoint: Require human confirmation before proceeding
        await this.confirmReleaseCheckpoint(releaseVersion);

        // Skip version bump - we're using the version from the specified commit
        this.logSection('Version Bump (skipped for --commit)');
        this.logInfo(`Using version ${releaseVersion} from commit ${resolvedCommitSha.substring(0, 8)}`);
      } else {
        // ═══════════════════════════════════════════════════════════════════
        // NORMAL MODE: Release from latest origin/dev
        // ═══════════════════════════════════════════════════════════════════

        // Stage 3: Compare versions
        const { devVersion, mainVersion, needsBump } = await this.compareVersions(repoRoot);

        // Stage 4: Bump version if needed
        releaseVersion = devVersion;
        mergeRef = 'origin/dev';

        if (this.skipVersionBump) {
          this.logSection('Version Bump (skipped)');
          this.logInfo('--skip-version-bump flag set, using existing version from origin/dev');

          // Even when skipping bump, we must enforce: origin/dev > origin/main
          // This prevents releasing when versions are equal or dev is behind main
          const comparison = semver.compare(devVersion, mainVersion);
          if (comparison <= 0) {
            this.logError(`Cannot skip version bump: origin/dev (${devVersion}) is not ahead of origin/main (${mainVersion})`);
            this.log('', colors.reset);
            this.log('  The --skip-version-bump flag requires that origin/dev already has a', colors.yellow);
            this.log('  version higher than origin/main. This ensures every release has a', colors.yellow);
            this.log('  unique, incremented version number.', colors.yellow);
            this.log('', colors.reset);
            this.log('  To fix, either:', colors.yellow);
            this.log('  1. Remove --skip-version-bump flag to let the script bump the version', colors.cyan);
            this.log('  2. Manually bump the version on dev and push before running with --skip-version-bump', colors.cyan);
            throw new ReleaseError('Cannot skip version bump when dev is not ahead of main', EXIT_CODES.VERSION_BUMP_FAILED);
          }

          // Warn if local version differs from origin/dev (informational)
          const localVersion = this.getLocalVersion(repoRoot);
          if (localVersion !== devVersion) {
            this.logWarning(`Local version (${localVersion}) differs from origin/dev (${devVersion})`);
            this.logInfo('Using origin/dev version for release');
          }

          // Use the remote version (devVersion) which is already validated
          releaseVersion = devVersion;
          this.logSuccess(`Using version ${releaseVersion} from origin/dev`);

          // Checkpoint: Require human confirmation before proceeding
          await this.confirmReleaseCheckpoint(releaseVersion);
        } else if (needsBump) {
          // Checkpoint: Require human confirmation BEFORE bumping version
          // When dev < main (hotfix scenario), bump from mainVersion to ensure we're ahead
          const bumpBase = semver.compare(devVersion, mainVersion) < 0 ? mainVersion : devVersion;
          const bumpType: BumpType = this.major ? 'major' : this.minor ? 'minor' : 'patch';
          const previewVersion = semver.inc(bumpBase, bumpType);

          // Checkpoint before any modifications
          await this.confirmReleaseCheckpoint(previewVersion || devVersion);

          if (bumpBase !== devVersion) {
            this.logInfo(`Bumping from main version (${mainVersion}) to ensure dev > main`);
          }
          releaseVersion = await this.bumpVersionOnDev(repoRoot, bumpBase);
        } else {
          this.logSection('Version Bump (not needed)');
          this.logSuccess(`Version ${devVersion} already bumped on dev`);

          // Checkpoint: Require human confirmation before proceeding
          await this.confirmReleaseCheckpoint(releaseVersion);
        }
      }

      // Pre-merge: validate user-facing changelog has the version heading.
      // Mirrors the CI check on main; failing here saves a ~25min build.
      this.logSection('Changelog Validation');
      const changelogCheck = this.validateChangelogForRelease(repoRoot, releaseVersion);
      if (!changelogCheck.success) {
        this.logError(changelogCheck.reason || 'Changelog validation failed');
        this.log('', colors.reset);
        this.log('  CI on main runs the same check and will reject the publish.', colors.yellow);
        this.log('  See: docs/project/CHANGELOG_UPDATE_PROCESS.md', colors.cyan);
        this.log('', colors.reset);
        if (changelogCheck.hasUnreleased) {
          this.log('  Detected `## Unreleased` heading. To fix:', colors.yellow);
          this.log(`  1. cd rebel-system && git checkout main && git pull --ff-only`, colors.cyan);
          this.log(
            `  2. Rename '## Unreleased' to '## v${releaseVersion} — <date range>' in help-for-humans/changelog.md`,
            colors.cyan
          );
          this.log(`  3. git commit -am "docs(changelog): Promote Unreleased to v${releaseVersion}"`, colors.cyan);
          this.log(`  4. git push origin main`, colors.cyan);
          this.log(`  5. cd .. && git add rebel-system && git commit -m "chore(rebel-system): advance pointer for v${releaseVersion} changelog heading"`, colors.cyan);
          this.log(`  6. Re-run this script.`, colors.cyan);
        } else {
          this.log(`  Add a '## v${releaseVersion} — <date range>' section to:`, colors.yellow);
          this.log(`    rebel-system/help-for-humans/changelog.md`, colors.cyan);
          this.log(`  Commit + push the submodule, advance the superproject pointer, then re-run.`, colors.yellow);
        }
        throw new ReleaseError(
          `User-facing changelog is missing '## v${releaseVersion}' heading`,
          EXIT_CODES.VALIDATOR_FAILED
        );
      }
      this.logSuccess(`Found '## v${releaseVersion}' heading in user-facing changelog`);

      // Stage 5: Merge and push
      const mergeResult = await this.mergeAndPushToMain(repoRoot, releaseVersion, mergeRef);

      // Check if merge/push had issues (conflict, validation failure)
      if (mergeResult !== EXIT_CODES.SUCCESS) {
        // Error already logged with recovery instructions
        return mergeResult;
      }

      // Success!
      this.log('\n╔════════════════════════════════════════════════════════════╗', colors.green);
      this.log(`║      Successfully released v${releaseVersion.padEnd(24)}      ║`, colors.green);
      this.log('╚════════════════════════════════════════════════════════════╝\n', colors.green);

      await this.verifyPublishedToGcs(repoRoot, releaseVersion);

      // Post-release: auto-bump version on dev for the next cycle
      // Skip if --skip-push was used (release wasn't actually pushed to main)
      if (this.skipPush) {
        this.logInfo('Skipping post-release bump (--skip-push: release not pushed to main)');
      } else if (!this.dryRun) {
        await this.postReleaseBump(repoRoot, releaseVersion);
      } else {
        const nextVersion = semver.inc(releaseVersion, 'patch');
        this.logInfo(`Would bump dev to ${nextVersion} for next cycle`);
        this.logInfo(`Would commit: chore: bump version to ${nextVersion} after release`);
        this.logInfo('Would push to origin/dev');
      }

      return EXIT_CODES.SUCCESS;
    } catch (error) {
      // ReleaseError carries its own exit code - use it directly
      if (error instanceof ReleaseError) {
        return error.exitCode;
      }

      // Rethrow UsageError for Clipanion's built-in error handling
      if (error instanceof UsageError) {
        throw error;
      }

      this.logError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT_CODES.UNKNOWN_ERROR;
    }
  }
}

// -----------------------------------------------------------------------------
// CLI ENTRY POINT
// -----------------------------------------------------------------------------

const cli = new Cli({
  binaryLabel: 'Release to Production',
  binaryName: 'release-to-production',
  binaryVersion: '1.0.0',
});

cli.register(ReleaseToProductionCommand);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli.runExit(process.argv.slice(2));
}
