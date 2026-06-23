import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSurfaceTag } from '../cloudSessionMergeService';
import {
  SURFACE_TIEBREAKER_RACE_WINDOW_MS,
  getConflictDetector,
  resetConflictDetectorForTests,
} from '../conflictDetector';

type SurfaceWrite = {
  surface: SessionSurfaceTag;
  changedAt: number;
  value: unknown;
};

function resolveRace(args: {
  field: string;
  writes: SurfaceWrite[];
  now: number;
}): {
  winner: SurfaceWrite;
  reason: 'within-race-window' | 'outside-race-window' | 'ineligible-field' | 'no-desktop';
  tiebreakInvocations: number;
} {
  const detector = getConflictDetector();
  let winner = args.writes[0];
  let reason: 'within-race-window' | 'outside-race-window' | 'ineligible-field' | 'no-desktop' = 'no-desktop';
  let tiebreakInvocations = 0;

  for (let index = 1; index < args.writes.length; index += 1) {
    const challenger = args.writes[index];
    const winnerIsDesktop = winner.surface === 'desktop';
    const challengerIsDesktop = challenger.surface === 'desktop';

    if (!winnerIsDesktop && !challengerIsDesktop) {
      winner = challenger;
      continue;
    }

    if (winnerIsDesktop && challengerIsDesktop) {
      winner = challenger;
      continue;
    }

    tiebreakInvocations += 1;
    const desktopWrite = winnerIsDesktop ? winner : challenger;
    const otherWrite = winnerIsDesktop ? challenger : winner;
    const decision = detector.resolveSurfaceTiebreaker({
      sessionId: 'session-1',
      field: args.field,
      desktopWrite,
      otherWrite,
      now: args.now,
    });
    reason = decision.reason;

    if (decision.winner === 'desktop') {
      winner = desktopWrite;
    } else {
      winner = challenger;
    }
  }

  return { winner, reason, tiebreakInvocations };
}

beforeEach(() => {
  resetConflictDetectorForTests();
});

describe('conflictDetector.resolveSurfaceTiebreaker', () => {
  it('99ms apart resolves within race window to desktop', () => {
    const detector = getConflictDetector();
    const decision = detector.resolveSurfaceTiebreaker({
      sessionId: 'session-1',
      field: 'title',
      desktopWrite: { changedAt: 1_000, value: 'Desktop title' },
      otherWrite: { surface: 'mobile', changedAt: 1_099, value: 'Mobile title' },
      now: 1_099,
    });

    expect(SURFACE_TIEBREAKER_RACE_WINDOW_MS).toBe(100);
    expect(decision).toEqual({
      winner: 'desktop',
      reason: 'within-race-window',
    });
  });

  it('101ms apart resolves outside race window by ordering', () => {
    const detector = getConflictDetector();
    const decision = detector.resolveSurfaceTiebreaker({
      sessionId: 'session-1',
      field: 'title',
      desktopWrite: { changedAt: 1_000, value: 'Desktop title' },
      otherWrite: { surface: 'mobile', changedAt: 1_101, value: 'Mobile title' },
      now: 1_101,
    });

    expect(decision).toEqual({
      winner: 'other',
      reason: 'outside-race-window',
    });
  });

  it('non-eligible fields return ineligible-field and do not apply desktop tiebreaking', () => {
    const detector = getConflictDetector();
    const decision = detector.resolveSurfaceTiebreaker({
      sessionId: 'session-1',
      field: 'seq',
      desktopWrite: { changedAt: 1_000, value: 10 },
      otherWrite: { surface: 'mobile', changedAt: 1_050, value: 11 },
      now: 1_050,
    });

    expect(decision).toEqual({
      winner: 'other',
      reason: 'ineligible-field',
    });
  });

  it('three-way race with desktop/mobile/cloud inside 100ms resolves to desktop', () => {
    const outcome = resolveRace({
      field: 'title',
      writes: [
        { surface: 'desktop', changedAt: 1_000, value: 'desktop' },
        { surface: 'mobile', changedAt: 1_050, value: 'mobile' },
        { surface: 'cloud', changedAt: 1_075, value: 'cloud' },
      ],
      now: 1_075,
    });

    expect(outcome.winner.surface).toBe('desktop');
    expect(outcome.winner.value).toBe('desktop');
    expect(outcome.reason).toBe('within-race-window');
    expect(outcome.tiebreakInvocations).toBe(2);
  });

  it('no-desktop race between mobile/cloud does not invoke the desktop tiebreaker', () => {
    const outcome = resolveRace({
      field: 'title',
      writes: [
        { surface: 'mobile', changedAt: 1_000, value: 'mobile' },
        { surface: 'cloud', changedAt: 1_050, value: 'cloud' },
      ],
      now: 1_050,
    });

    expect(outcome.winner.surface).toBe('cloud');
    expect(outcome.winner.value).toBe('cloud');
    expect(outcome.reason).toBe('no-desktop');
    expect(outcome.tiebreakInvocations).toBe(0);
  });
});
