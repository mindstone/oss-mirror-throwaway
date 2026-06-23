#!/usr/bin/env npx tsx

/**
 * ============================================================================
 * Merge Integrity Verifier — Standalone CLI
 * ============================================================================
 *
 * Scans merge commits for signs of silently dropped changes ("ours"-style
 * merges). Can check a single commit, HEAD, or a range of commits.
 *
 * Usage:
 *   npx tsx scripts/verify-merge-integrity.ts              # Check HEAD
 *   npx tsx scripts/verify-merge-integrity.ts --commit abc  # Check specific SHA
 *   npx tsx scripts/verify-merge-integrity.ts --range a..b  # Scan range
 *
 * Exit codes:
 *   0 — All checks passed (or no merge commits to check)
 *   1 — Integrity failure detected (ours-style merge)
 *   2 — Warning: low incorporation ratio (suspicious but not definitive)
 *   3 — Invalid arguments or git error
 *
 * See: docs/plans/260403_merge_safety_hardening.md
 * ============================================================================
 */

import { Cli, Command, Option, UsageError } from 'clipanion';
import { execSync } from 'child_process';
import {
  collectMergeFacts,
  assessMergeIntegrity,
  findMergeCommitsInRange,
  type MergeIntegrityResult,
  type MergeIntegrityOptions,
} from './lib/merge-integrity';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const EXIT_CODES = {
  SUCCESS: 0,
  INTEGRITY_FAILURE: 1,
  INTEGRITY_WARNING: 2,
  INVALID_ARGS: 3,
} as const;

/** ANSI color codes */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
} as const;

// -----------------------------------------------------------------------------
// Main Command
// -----------------------------------------------------------------------------

class VerifyMergeIntegrityCommand extends Command {
  static paths = [Command.Default];

  static usage = Command.Usage({
    description: 'Verify merge commit integrity (detect dropped changes)',
    details: `
      Scans merge commits for signs of silently dropped changes. Catches
      "ours"-style merges where the merge tree equals parent 1, meaning all
      incoming changes were discarded.

      Two checks:
      1. Tree equality (deterministic): merge tree == parent1 tree → FAIL
      2. Incorporation ratio (heuristic): low ratio of incorporated files → WARN

      Background: Two incidents (87 and 362 files dropped) caused by
      \`git reset HEAD -- .\` in merge state.
    `,
    examples: [
      ['Check HEAD', 'npx tsx scripts/verify-merge-integrity.ts'],
      ['Check specific commit', 'npx tsx scripts/verify-merge-integrity.ts --commit abc123'],
      ['Scan a range', 'npx tsx scripts/verify-merge-integrity.ts --range "origin/main..HEAD"'],
      ['Custom threshold', 'npx tsx scripts/verify-merge-integrity.ts --threshold 0.2'],
    ],
  });

  /** Specific commit to check */
  commit = Option.String('--commit', {
    description: 'Check a specific commit SHA (default: HEAD)',
  });

  /** Range of commits to scan */
  range = Option.String('--range', {
    description: 'Scan merge commits in a range (e.g., "origin/main..HEAD")',
  });

  /** Incorporation ratio threshold */
  threshold = Option.String('--threshold', {
    description: 'Incorporation ratio threshold for warnings (default: 0.1)',
  });

  /** Minimum theirs files for ratio check */
  minTheirsFiles = Option.String('--min-theirs-files', {
    description: 'Minimum theirs files before ratio check applies (default: 5)',
  });

  /** Quiet mode — only output on failure/warning */
  quiet = Option.Boolean('-q,--quiet', false, {
    description: 'Only output on failure or warning',
  });

  // ---------------------------------------------------------------------------
  // Output helpers
  // ---------------------------------------------------------------------------

  private log(message: string, color: string = colors.reset): void {
    this.context.stdout.write(`${color}${message}${colors.reset}\n`);
  }

  // ---------------------------------------------------------------------------
  // Result formatting
  // ---------------------------------------------------------------------------

  private formatResult(result: MergeIntegrityResult): void {
    const shortSha = result.mergeCommit.slice(0, 10);

    switch (result.status) {
      case 'fail':
        this.log(`\n❌ FAIL: ${shortSha}`, colors.red);
        this.log(`   ${result.reason}`, colors.red);
        this.log(`   Parents: ${result.parent1.slice(0, 10)} (ours) ← ${result.parent2.slice(0, 10)} (theirs)`, colors.dim);
        this.log(`   Theirs files: ${result.theirsFileCount}`, colors.dim);
        this.log(`   Merge changes: ${result.mergeChangeCount}`, colors.dim);
        this.log(`   Incorporation: ${(result.incorporationRatio * 100).toFixed(1)}%`, colors.dim);
        if (result.suspiciousFiles && result.suspiciousFiles.length > 0) {
          this.log(`   Dropped files (sample):`, colors.yellow);
          for (const file of result.suspiciousFiles) {
            this.log(`     - ${file}`, colors.yellow);
          }
        }
        this.log('', colors.reset);
        this.log(`   Recovery:`, colors.cyan);
        this.log(`     git revert ${shortSha}                  # Undo the bad merge`, colors.cyan);
        this.log(`     npx tsx scripts/git-safe-sync.ts         # Re-merge safely`, colors.cyan);
        break;

      case 'warn':
        this.log(`\n⚠️  WARN: ${shortSha}`, colors.yellow);
        this.log(`   ${result.reason}`, colors.yellow);
        this.log(`   Parents: ${result.parent1.slice(0, 10)} (ours) ← ${result.parent2.slice(0, 10)} (theirs)`, colors.dim);
        this.log(`   Theirs files: ${result.theirsFileCount}`, colors.dim);
        this.log(`   Merge changes: ${result.mergeChangeCount}`, colors.dim);
        this.log(`   Incorporation: ${(result.incorporationRatio * 100).toFixed(1)}%`, colors.dim);
        if (result.suspiciousFiles && result.suspiciousFiles.length > 0) {
          this.log(`   Potentially dropped files (sample):`, colors.yellow);
          for (const file of result.suspiciousFiles) {
            this.log(`     - ${file}`, colors.yellow);
          }
        }
        break;

      case 'pass':
        if (!this.quiet) {
          this.log(`✅ PASS: ${shortSha} — ${result.reason}`, colors.green);
        }
        break;

      case 'skip':
        if (!this.quiet) {
          this.log(`⏭️  SKIP: ${shortSha} — ${result.reason}`, colors.dim);
        }
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Main execution
  // ---------------------------------------------------------------------------

  async execute(): Promise<number> {
    // Validate mutually exclusive options
    if (this.commit && this.range) {
      throw new UsageError('Cannot specify both --commit and --range');
    }

    // Parse options
    const integrityOptions: MergeIntegrityOptions = {};
    if (this.threshold) {
      const parsed = parseFloat(this.threshold);
      if (isNaN(parsed) || parsed < 0 || parsed > 1) {
        throw new UsageError('--threshold must be a number between 0 and 1');
      }
      integrityOptions.threshold = parsed;
    }
    if (this.minTheirsFiles) {
      const parsed = parseInt(this.minTheirsFiles, 10);
      if (isNaN(parsed) || parsed < 0) {
        throw new UsageError('--min-theirs-files must be a non-negative integer');
      }
      integrityOptions.minTheirsFiles = parsed;
    }

    // Determine repo root
    let repoRoot: string;
    try {
      // git-exec-allow: repo-root lookup returns one path and preserves CLI error mapping
      repoRoot = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      this.log('Error: Not in a git repository', colors.red);
      return EXIT_CODES.INVALID_ARGS;
    }

    // Collect commits to check
    let commits: string[];

    if (this.range) {
      if (!this.quiet) {
        this.log(`Scanning merge commits in range: ${this.range}`, colors.cyan);
      }
      commits = findMergeCommitsInRange(repoRoot, this.range);
      if (commits.length === 0) {
        if (!this.quiet) {
          this.log('No merge commits found in range — nothing to check.', colors.dim);
        }
        return EXIT_CODES.SUCCESS;
      }
      if (!this.quiet) {
        this.log(`Found ${commits.length} merge commit(s) to check`, colors.cyan);
      }
    } else {
      commits = [this.commit || 'HEAD'];
    }

    // Check each commit
    let worstStatus: 'pass' | 'fail' | 'warn' | 'skip' = 'pass';

    for (const commitSha of commits) {
      try {
        const facts = collectMergeFacts(repoRoot, commitSha);
        const result = assessMergeIntegrity(facts, integrityOptions);
        this.formatResult(result);

        // Track worst result
        if (result.status === 'fail') {
          worstStatus = 'fail';
        } else if (result.status === 'warn' && worstStatus !== 'fail') {
          worstStatus = 'warn';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Error checking ${commitSha}: ${message}`, colors.red);
        return EXIT_CODES.INVALID_ARGS;
      }
    }

    // Exit code reflects worst result
    switch (worstStatus) {
      case 'fail':
        return EXIT_CODES.INTEGRITY_FAILURE;
      case 'warn':
        return EXIT_CODES.INTEGRITY_WARNING;
      default:
        return EXIT_CODES.SUCCESS;
    }
  }
}

// -----------------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------------

const cli = new Cli({
  binaryLabel: 'Merge Integrity Verifier',
  binaryName: 'verify-merge-integrity',
  binaryVersion: '1.0.0',
});

cli.register(VerifyMergeIntegrityCommand);
cli.runExit(process.argv.slice(2));
