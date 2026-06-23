import { describe, expect, it, vi } from 'vitest';
import {
  confirmReleaseCheckpoint,
  CheckpointCancelledError,
  type ReleaseCheckpointOptions,
} from '../lib/release-checkpoint';

// ---------------------------------------------------------------------------
// Pure-unit coverage of the shared production-release human checkpoint.
//
// The lib is fully injectable (no electron / clipanion / readline imports), so
// every path is exercised by supplying `log` + `promptLine` adapters and the
// dryRun / isTTY / confirmChangelogCurrent inputs the release script formerly
// pulled from `this`/globals. These tests are the contract that BOTH the
// release script and the CI-triggered promote driver must keep satisfied.
// ---------------------------------------------------------------------------

interface Harness {
  opts: ReleaseCheckpointOptions;
  lines: string[];
  promptLine: ReturnType<typeof vi.fn>;
}

function makeHarness(
  overrides: Partial<ReleaseCheckpointOptions> & { promptAnswer?: string } = {}
): Harness {
  const { promptAnswer, ...optOverrides } = overrides;
  const lines: string[] = [];
  const promptLine = vi.fn(async () => promptAnswer ?? 'y');
  const opts: ReleaseCheckpointOptions = {
    version: '0.4.50',
    confirmChangelogCurrent: undefined,
    dryRun: false,
    isTTY: false,
    log: (message: string) => {
      lines.push(message);
    },
    promptLine,
    ...optOverrides,
  };
  return { opts, lines, promptLine };
}

describe('confirmReleaseCheckpoint (shared lib)', () => {
  it('always prints the HUMAN CONFIRMATION REQUIRED banner', async () => {
    const h = makeHarness({ dryRun: true });
    await confirmReleaseCheckpoint(h.opts);
    expect(h.lines.some((l) => l.includes('🛑  HUMAN CONFIRMATION REQUIRED  🛑'))).toBe(true);
    expect(h.lines.some((l) => l.includes('About to release: v0.4.50'))).toBe(true);
  });

  describe('dry-run', () => {
    it('auto-proceeds and never prompts', async () => {
      const h = makeHarness({ dryRun: true });
      await expect(confirmReleaseCheckpoint(h.opts)).resolves.toBeUndefined();
      expect(h.promptLine).not.toHaveBeenCalled();
      expect(h.lines.some((l) => l.includes('DRY RUN: Would wait for human confirmation'))).toBe(
        true
      );
      expect(h.lines.some((l) => l.includes('DRY RUN: Auto-proceeding...'))).toBe(true);
    });

    it('dry-run wins even when stdin is not a TTY and no flag is set', async () => {
      const h = makeHarness({ dryRun: true, isTTY: false, confirmChangelogCurrent: undefined });
      await expect(confirmReleaseCheckpoint(h.opts)).resolves.toBeUndefined();
    });
  });

  describe('--confirm-changelog-current (non-interactive acknowledgement)', () => {
    it('proceeds when the flag exactly matches the release version', async () => {
      const h = makeHarness({ confirmChangelogCurrent: '0.4.50', version: '0.4.50' });
      await expect(confirmReleaseCheckpoint(h.opts)).resolves.toBeUndefined();
      expect(h.promptLine).not.toHaveBeenCalled();
      expect(
        h.lines.some((l) =>
          l.includes('Checkpoint confirmed non-interactively via --confirm-changelog-current 0.4.50')
        )
      ).toBe(true);
    });

    it('throws CheckpointCancelledError on version mismatch', async () => {
      const h = makeHarness({ confirmChangelogCurrent: '0.4.49', version: '0.4.50' });
      await expect(confirmReleaseCheckpoint(h.opts)).rejects.toBeInstanceOf(
        CheckpointCancelledError
      );
      await expect(confirmReleaseCheckpoint(makeHarness({
        confirmChangelogCurrent: '0.4.49',
        version: '0.4.50',
      }).opts)).rejects.toThrow(/does not match the release version v0\.4\.50/);
    });

    it('normalizes a leading "v" and surrounding whitespace on the flag', async () => {
      const h = makeHarness({ confirmChangelogCurrent: '  v0.4.50  ', version: '0.4.50' });
      await expect(confirmReleaseCheckpoint(h.opts)).resolves.toBeUndefined();
      expect(h.promptLine).not.toHaveBeenCalled();
    });

    it('takes precedence over a non-TTY stdin (the flag is the non-interactive bypass)', async () => {
      const h = makeHarness({
        confirmChangelogCurrent: '0.4.50',
        version: '0.4.50',
        isTTY: false,
      });
      await expect(confirmReleaseCheckpoint(h.opts)).resolves.toBeUndefined();
    });
  });

  describe('non-interactive without the flag (fail-closed)', () => {
    it('throws CheckpointCancelledError when stdin is not a TTY and no flag is set', async () => {
      const h = makeHarness({ isTTY: false, confirmChangelogCurrent: undefined });
      await expect(confirmReleaseCheckpoint(h.opts)).rejects.toBeInstanceOf(
        CheckpointCancelledError
      );
      expect(h.promptLine).not.toHaveBeenCalled();
    });

    it('the fail-closed message names the exact re-run flag for this version', async () => {
      const h = makeHarness({ isTTY: false, version: '0.4.50' });
      await expect(confirmReleaseCheckpoint(h.opts)).rejects.toThrow(
        /stdin is not an interactive terminal[\s\S]*--confirm-changelog-current 0\.4\.50/
      );
    });
  });

  describe('interactive TTY prompt', () => {
    it("proceeds when the user types 'y'", async () => {
      const h = makeHarness({ isTTY: true, promptAnswer: 'y' });
      await expect(confirmReleaseCheckpoint(h.opts)).resolves.toBeUndefined();
      expect(h.promptLine).toHaveBeenCalledOnce();
      expect(h.promptLine).toHaveBeenCalledWith("  Type 'y' to proceed with release: ");
      expect(h.lines.some((l) => l.includes('Checkpoint confirmed - proceeding with release'))).toBe(
        true
      );
    });

    it("accepts 'Y' (case-insensitive)", async () => {
      const h = makeHarness({ isTTY: true, promptAnswer: 'Y' });
      await expect(confirmReleaseCheckpoint(h.opts)).resolves.toBeUndefined();
    });

    it("throws CheckpointCancelledError on any non-'y' answer", async () => {
      const h = makeHarness({ isTTY: true, promptAnswer: 'n' });
      await expect(confirmReleaseCheckpoint(h.opts)).rejects.toBeInstanceOf(
        CheckpointCancelledError
      );
      await expect(
        confirmReleaseCheckpoint(makeHarness({ isTTY: true, promptAnswer: 'n' }).opts)
      ).rejects.toThrow(/Release cancelled by user at checkpoint/);
    });

    it("does not treat 'yes' as confirmation (only exact 'y')", async () => {
      const h = makeHarness({ isTTY: true, promptAnswer: 'yes' });
      await expect(confirmReleaseCheckpoint(h.opts)).rejects.toBeInstanceOf(
        CheckpointCancelledError
      );
    });
  });
});
