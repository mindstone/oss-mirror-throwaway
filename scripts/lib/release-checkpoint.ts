/**
 * ============================================================================
 * Shared production-release HUMAN CHECKPOINT
 * ============================================================================
 *
 * The one mandatory human confirmation gate that must guard EVERY path that
 * promotes code to production (`main`). Both `scripts/release-to-production.ts`
 * and the CI-triggered promote driver delegate here so the SAME hard gate is
 * enforced IN CODE — there is exactly one implementation of the rule, not two
 * copies that can silently drift.
 *
 * Behaviour (must stay identical to the original `confirmReleaseCheckpoint`):
 *   - Prints the "🛑 HUMAN CONFIRMATION REQUIRED 🛑" banner.
 *   - `--dry-run` → logs "would wait" + "auto-proceeding" and proceeds.
 *   - Non-interactive bypass: ONLY an explicit, version-valued
 *     `--confirm-changelog-current <version>` that, after trimming + stripping a
 *     leading `v` (case preserved), EXACTLY equals the release version. `--yes`
 *     does NOT skip this. Mismatch → cancellation (typed error).
 *   - Non-TTY stdin without that flag → fail-closed cancellation (cannot
 *     reliably answer a readline prompt).
 *   - TTY → readline prompt; proceeds only on `'y'` (case-insensitive).
 *
 * DESIGN: pure-ish + injectable. NO imports from electron / clipanion / readline.
 * Everything the original method pulled from `this`/globals is injected via
 * `opts`: the version, the flag, dryRun, isTTY, a `log` adapter, and a
 * `promptLine` adapter. Cancellation/mismatch is signalled via a typed
 * `CheckpointCancelledError` the caller maps to its own exit code.
 */

/**
 * ANSI color codes used by the checkpoint output. Kept local (plain strings, no
 * import) so the lib stays decoupled from the release script's `colors` object,
 * while producing byte-identical output through the injected `log` adapter.
 */
const CHECKPOINT_COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
} as const;

/**
 * Raised when the human checkpoint is NOT satisfied — either a non-interactive
 * acknowledgement mismatch, a fail-closed non-TTY run without the flag, or an
 * interactive non-`'y'` answer. The caller maps this to its own exit code
 * (e.g. `EXIT_CODES.USER_CANCELLED`).
 */
export class CheckpointCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointCancelledError';
  }
}

export interface ReleaseCheckpointOptions {
  /** The exact version about to be released (no leading `v`). */
  version: string;
  /**
   * Non-interactive acknowledgement value, if the flag was provided. Must equal
   * the release version after trimming + stripping a leading `v` (case as-is).
   * `undefined` when the flag was not passed.
   */
  confirmChangelogCurrent?: string;
  /** When true, auto-proceed after logging (the `--dry-run` path). */
  dryRun: boolean;
  /** Whether stdin is an interactive terminal (typically `process.stdin.isTTY`). */
  isTTY: boolean;
  /** Output adapter. Mirrors the release script's `log(message, color?)`. */
  log: (message: string, color?: string) => void;
  /**
   * Reads a single line of input for the interactive TTY prompt. The
   * implementation owns the readline lifecycle (create + close). Only invoked on
   * the TTY path.
   */
  promptLine: (question: string) => Promise<string>;
}

/**
 * The mandatory human checkpoint. Resolves when the release is confirmed;
 * throws `CheckpointCancelledError` when it is not.
 *
 * Behaviour-preserving extraction of `release-to-production.ts`'s former private
 * `confirmReleaseCheckpoint(version)` — see file header for the exact contract.
 */
export async function confirmReleaseCheckpoint(opts: ReleaseCheckpointOptions): Promise<void> {
  const { version, confirmChangelogCurrent, dryRun, isTTY, log, promptLine } = opts;
  const c = CHECKPOINT_COLORS;

  // --- Banner (identical strings + colors to the original method) -----------
  log('', c.reset);
  log('  ╔════════════════════════════════════════════════════════════════╗', c.magenta);
  log('  ║                                                                ║', c.magenta);
  log('  ║            🛑  HUMAN CONFIRMATION REQUIRED  🛑                 ║', c.magenta);
  log('  ║                                                                ║', c.magenta);
  log('  ╠════════════════════════════════════════════════════════════════╣', c.magenta);
  log(`  ║  About to release: v${version.padEnd(41)}║`, c.yellow);
  log('  ║                                                                ║', c.magenta);
  log('  ║  Please confirm the changelog is up to date for this release. ║', c.yellow);
  log('  ║                                                                ║', c.magenta);
  log('  ║  Changelog path:                                               ║', c.magenta);
  log('  ║    rebel-system/help-for-humans/changelog.md                   ║', c.cyan);
  log('  ║                                                                ║', c.magenta);
  log('  ║  Once confirmed, the script will merge, validate, and push    ║', c.yellow);
  log('  ║  to main without further prompts.                              ║', c.yellow);
  log('  ║                                                                ║', c.magenta);
  log('  ╠════════════════════════════════════════════════════════════════╣', c.magenta);
  log('  ║  AI AGENTS: Stop here and ask the human user to confirm.      ║', c.yellow);
  log('  ╚════════════════════════════════════════════════════════════════╝', c.magenta);
  log('', c.reset);

  if (dryRun) {
    // logInfo: cyan, "  ℹ️  " prefix
    log("  ℹ️  DRY RUN: Would wait for human confirmation (type 'y' to proceed)", c.cyan);
    log('  ℹ️  DRY RUN: Auto-proceeding...', c.cyan);
    return;
  }

  // Non-interactive acknowledgement: an explicit, version-valued flag records the
  // human's "changelog is current" confirmation without a fragile piped readline (the
  // old multi-prompt-over-a-pipe failure mode that lost the answer to EOF). The version
  // must match EXACTLY, so a stale copied command cannot acknowledge the wrong release.
  if (confirmChangelogCurrent !== undefined) {
    const acked = confirmChangelogCurrent.trim().replace(/^v/i, '');
    const target = version.trim().replace(/^v/i, '');
    if (acked !== target) {
      throw new CheckpointCancelledError(
        `--confirm-changelog-current "${confirmChangelogCurrent}" does not match the release version v${version}. ` +
          `Confirm the changelog is current for THIS release, then re-run with --confirm-changelog-current ${version}.`
      );
    }
    // logSuccess: green, "  ✅ " prefix
    log(
      `  ✅ Checkpoint confirmed non-interactively via --confirm-changelog-current ${version} - proceeding`,
      c.green
    );
    return;
  }

  // No flag → only the interactive TTY path is supported. A non-TTY stdin (piped /
  // automated) cannot reliably answer a readline prompt, so fail EXPLICIT with the exact
  // re-run instruction rather than hang or silently mis-read a lost answer.
  if (!isTTY) {
    throw new CheckpointCancelledError(
      `Release checkpoint needs confirmation but stdin is not an interactive terminal. ` +
        `Confirm the changelog is current for v${version}, then re-run with --confirm-changelog-current ${version}.`
    );
  }

  const answer = await promptLine(`  Type 'y' to proceed with release: `);

  if (answer.toLowerCase() !== 'y') {
    throw new CheckpointCancelledError('Release cancelled by user at checkpoint');
  }

  // logSuccess: green, "  ✅ " prefix
  log('  ✅ Checkpoint confirmed - proceeding with release', c.green);
}
