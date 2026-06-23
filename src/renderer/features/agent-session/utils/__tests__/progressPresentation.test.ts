import { describe, expect, it } from 'vitest';
import { InvariantViolationError } from '@shared/utils/invariant';
import { assertNever } from '@shared/utils/assertNever';
import type { StopClassification } from '../detectSilentStop';
import {
  deriveProgressPresentation,
  type ProgressPresentationInputs,
  type ProgressRenderState,
} from '../progressPresentation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInputs(overrides: Partial<ProgressPresentationInputs> = {}): ProgressPresentationInputs {
  return {
    isThinking: false,
    isPaused: false,
    isComplete: false,
    endedWith: undefined,
    silentStop: { hasSilentStop: false, classification: 'none' },
    hasError: false,
    hasRunningSubAgents: false,
    ...overrides,
  };
}

function silentStop(
  classification: StopClassification,
  hasSilentStop = true,
  interruptionSource?: 'shutdown' | 'startup-correction',
) {
  return { hasSilentStop, classification, interruptionSource };
}

// ---------------------------------------------------------------------------
// One case per ProgressRenderState
// ---------------------------------------------------------------------------

describe('deriveProgressPresentation — one case per render state', () => {
  it('live: thinking, no terminal signal', () => {
    const p = deriveProgressPresentation(makeInputs({ isThinking: true }));
    expect(p.dataState).toBe<ProgressRenderState>('live');
    expect(p.headerText).toBe("Rebel’s thinking");
    expect(p.liveTextKind).toBe('default');
    expect(p.iconKind).toBe('thinking');
    expect(p.liveIconKind).toBe('thinking');
    expect(p.sectionLabelText).toBe('Doing right now');
    expect(p.cssGates).toEqual({
      collapsedStatusComplete: false,
      sectionLabelComplete: false,
      liveTextDone: false,
    });
  });

  it('live: sub-agents running selects the assistant indicator icon', () => {
    const p = deriveProgressPresentation(makeInputs({ isThinking: true, hasRunningSubAgents: true }));
    expect(p.dataState).toBe('live');
    expect(p.iconKind).toBe('sub_agents');
    expect(p.liveIconKind).toBe('sub_agents');
  });

  it('live: fallback icon when neither thinking nor sub-agents', () => {
    const p = deriveProgressPresentation(makeInputs({ isThinking: false }));
    expect(p.dataState).toBe('live');
    expect(p.iconKind).toBe('fallback');
    expect(p.liveIconKind).toBe('fallback');
  });

  it('complete: isComplete, no interrupt/silentStop', () => {
    const p = deriveProgressPresentation(makeInputs({ isComplete: true }));
    expect(p.dataState).toBe('complete');
    expect(p.headerText).toBe('How Rebel did this');
    expect(p.liveTextKind).toBe('complete');
    expect(p.iconKind).toBe('complete');
    expect(p.liveIconKind).toBe('complete');
    expect(p.sectionLabelText).toBe('Result');
    expect(p.cssGates).toEqual({
      collapsedStatusComplete: true,
      sectionLabelComplete: true,
      liveTextDone: true,
    });
  });

  it('paused', () => {
    const p = deriveProgressPresentation(makeInputs({ isPaused: true }));
    expect(p.dataState).toBe('paused');
    expect(p.headerText).toBe('Rebel paused');
    // No paused liveText arm — falls through to default (activity.statusLine).
    expect(p.liveTextKind).toBe('default');
    expect(p.iconKind).toBe('paused');
    expect(p.liveIconKind).toBe('paused');
    expect(p.sectionLabelText).toBe('Doing right now');
  });

  it('interrupted: transient_error', () => {
    const p = deriveProgressPresentation(makeInputs({ isComplete: true, endedWith: 'transient_error' }));
    expect(p.dataState).toBe('interrupted');
    expect(p.headerText).toBe('Rebel was interrupted');
    expect(p.liveTextKind).toBe('interrupted');
    expect(p.iconKind).toBe('interrupted');
    expect(p.liveIconKind).toBe('interrupted');
    expect(p.sectionLabelText).toBe('Result');
    // The four !isInterrupted gates are all OFF for interrupted (MA-2).
    expect(p.cssGates).toEqual({
      collapsedStatusComplete: false,
      sectionLabelComplete: false,
      liveTextDone: false,
    });
  });

  it('interrupted: app-closed silent-stop with UNKNOWN source → generic header + NON-network Power icon (pre-discriminator)', () => {
    // Historical turn cut off by app quit/crash: isComplete is true (not
    // thinking, hadActivity) and the silent-stop classifier says 'interrupted'
    // but the persisted status predates the `source` field.
    // Must NOT inherit the green Done treatment AND must NOT imply network.
    const p = deriveProgressPresentation(makeInputs({
      isComplete: true,
      silentStop: silentStop('interrupted'),
    }));
    expect(p.dataState).toBe<ProgressRenderState>('interrupted');
    expect(p.headerText).toBe('Rebel was interrupted');
    expect(p.liveTextKind).toBe('interrupted');
    // Non-network icon even when source is unknown (FOX-2771 follow-up).
    expect(p.iconKind).toBe('closed');
    expect(p.iconKind).not.toBe('interrupted'); // never WifiOff for app-close
    expect(p.liveIconKind).toBe('closed');
    expect(p.sectionLabelText).toBe('Result');
    // All complete-tint gates OFF — same anti-MA-2 treatment as transient_error.
    expect(p.cssGates).toEqual({
      collapsedStatusComplete: false,
      sectionLabelComplete: false,
      liveTextDone: false,
    });
  });

  it('interrupted: app-closed source=shutdown → "Rebel was closed" + Power icon', () => {
    const p = deriveProgressPresentation(makeInputs({
      isComplete: true,
      silentStop: silentStop('interrupted', true, 'shutdown'),
    }));
    expect(p.dataState).toBe<ProgressRenderState>('interrupted');
    expect(p.headerText).toBe('Rebel was closed');
    expect(p.iconKind).toBe('closed');
    expect(p.liveIconKind).toBe('closed');
    expect(p.iconKind).not.toBe('interrupted'); // not WifiOff
  });

  it('interrupted: app-closed source=startup-correction → "Rebel restarted" + RotateCcw icon', () => {
    const p = deriveProgressPresentation(makeInputs({
      isComplete: true,
      silentStop: silentStop('interrupted', true, 'startup-correction'),
    }));
    expect(p.dataState).toBe<ProgressRenderState>('interrupted');
    expect(p.headerText).toBe('Rebel restarted');
    expect(p.iconKind).toBe('restarted');
    expect(p.liveIconKind).toBe('restarted');
    expect(p.iconKind).not.toBe('interrupted'); // not WifiOff
  });

  it('interrupted: transient-network keeps WifiOff + generic header (NOT an app-close)', () => {
    // The genuine connectivity case (endedWith transient_error, no app-close
    // silent stop) must KEEP the network icon + "Rebel was interrupted".
    const p = deriveProgressPresentation(makeInputs({ isComplete: true, endedWith: 'transient_error' }));
    expect(p.dataState).toBe('interrupted');
    expect(p.headerText).toBe('Rebel was interrupted');
    expect(p.iconKind).toBe('interrupted'); // WifiOff
    expect(p.liveIconKind).toBe('interrupted');
  });

  it('silent_stopped_user', () => {
    const p = deriveProgressPresentation(makeInputs({ silentStop: silentStop('user_stopped') }));
    expect(p.dataState).toBe('silent_stopped_user');
    // Short header ladder: no silentStop arm → thinking/complete header.
    expect(p.headerText).toBe("Rebel’s thinking");
    expect(p.liveTextKind).toBe('default');
    expect(p.iconKind).toBe('silent_stop');
    // Live-section icon has NO silentStop arm → falls through (fallback here).
    expect(p.liveIconKind).toBe('fallback');
  });

  it('silent_stopped_await', () => {
    const p = deriveProgressPresentation(makeInputs({ silentStop: silentStop('awaiting_user') }));
    expect(p.dataState).toBe('silent_stopped_await');
    expect(p.iconKind).toBe('silent_stop');
    expect(p.liveIconKind).toBe('fallback');
  });

  it('silent_stopped_unexpected', () => {
    const p = deriveProgressPresentation(makeInputs({ silentStop: silentStop('unexpected_stop') }));
    expect(p.dataState).toBe('silent_stopped_unexpected');
    expect(p.iconKind).toBe('silent_stop');
    expect(p.liveIconKind).toBe('fallback');
  });

  it('superseded: byte-identical presentation to complete (own discriminant)', () => {
    const sup = deriveProgressPresentation(makeInputs({ isComplete: true, endedWith: 'superseded' }));
    const complete = deriveProgressPresentation(makeInputs({ isComplete: true }));
    expect(sup.dataState).toBe('superseded');
    // Every non-discriminant slot equals the complete presentation.
    expect(sup.headerText).toBe(complete.headerText);
    expect(sup.liveTextKind).toBe(complete.liveTextKind);
    expect(sup.iconKind).toBe(complete.iconKind);
    expect(sup.liveIconKind).toBe(complete.liveIconKind);
    expect(sup.sectionLabelText).toBe(complete.sectionLabelText);
    expect(sup.cssGates).toEqual(complete.cssGates);
  });

  it('error: orphan tool-error tone (icon-only amber, text fallthrough)', () => {
    const p = deriveProgressPresentation(makeInputs({ hasError: true, isThinking: false }));
    expect(p.dataState).toBe('error');
    // No header/liveText arm — falls through to thinking/complete & default.
    expect(p.headerText).toBe("Rebel’s thinking");
    expect(p.liveTextKind).toBe('default');
    expect(p.iconKind).toBe('error');
    expect(p.liveIconKind).toBe('error');
    expect(p.sectionLabelText).toBe('Doing right now');
  });
});

// ---------------------------------------------------------------------------
// Precedence collisions
// ---------------------------------------------------------------------------

describe('deriveProgressPresentation — precedence collisions', () => {
  it('error_exit silentStop (hasSilentStop:false) does NOT win — interrupted wins (#2)', () => {
    // Production transient-error turn: error event → error_exit → hasSilentStop false.
    const p = deriveProgressPresentation(makeInputs({
      isComplete: true,
      endedWith: 'transient_error',
      silentStop: silentStop('error_exit', /* hasSilentStop */ false),
    }));
    expect(p.dataState).toBe('interrupted');
    expect(p.iconKind).toBe('interrupted');
  });

  it('isInterrupted precedes isComplete — interrupted, not complete (#3)', () => {
    const p = deriveProgressPresentation(makeInputs({ isComplete: true, endedWith: 'transient_error' }));
    expect(p.dataState).toBe('interrupted');
    expect(p.dataState).not.toBe('complete');
    expect(p.cssGates.collapsedStatusComplete).toBe(false);
    expect(p.cssGates.sectionLabelComplete).toBe(false);
    expect(p.cssGates.liveTextDone).toBe(false);
  });

  it('silentStop (hasSilentStop:true) precedes isInterrupted when both present (#1)', () => {
    // Defensive: if a turn somehow carries hasSilentStop AND transient_error,
    // the as-coded icon ladder gives silentStop the top arm.
    const p = deriveProgressPresentation(makeInputs({
      endedWith: 'transient_error',
      silentStop: silentStop('user_stopped'),
    }));
    expect(p.dataState).toBe('silent_stopped_user');
  });

  it('hasError orphan sits BELOW interrupted/complete (#10)', () => {
    const belowComplete = deriveProgressPresentation(makeInputs({ isComplete: true, hasError: true }));
    expect(belowComplete.dataState).toBe('complete');

    const belowInterrupted = deriveProgressPresentation(makeInputs({
      isComplete: true,
      endedWith: 'transient_error',
      hasError: true,
    }));
    expect(belowInterrupted.dataState).toBe('interrupted');

    // But above paused/live.
    const aboveLive = deriveProgressPresentation(makeInputs({ hasError: true }));
    expect(aboveLive.dataState).toBe('error');
  });

  it('hasError precedes isPaused (icon ladder order)', () => {
    const p = deriveProgressPresentation(makeInputs({ hasError: true, isPaused: true }));
    expect(p.dataState).toBe('error');
  });

  it('silentStop+complete sectionLabel stays as-coded inconsistent (#13)', () => {
    // A user_stopped turn that is also isComplete: collapsed EXCLUDES the
    // complete tint (silentStop check), expanded does NOT (sectionLabelComplete +
    // liveTextDone fire). Preserved byte-identical — do NOT "fix".
    const p = deriveProgressPresentation(makeInputs({
      isComplete: true,
      silentStop: silentStop('user_stopped'),
    }));
    expect(p.dataState).toBe('silent_stopped_user');
    expect(p.cssGates.collapsedStatusComplete).toBe(false); // collapsed excludes silentStop
    expect(p.cssGates.sectionLabelComplete).toBe(true);     // expanded does NOT exclude
    expect(p.cssGates.liveTextDone).toBe(true);             // expanded does NOT exclude
    // And the expanded section label reads 'Result' (isComplete true).
    expect(p.sectionLabelText).toBe('Result');
  });
});

// ---------------------------------------------------------------------------
// assertNever runtime guard
// ---------------------------------------------------------------------------

describe('deriveProgressPresentation — assertNever exhaustiveness lock', () => {
  it('every reachable render state yields a defined icon/liveIcon (totality — no blank slot)', () => {
    // The discriminant switch in deriveIconKind ends in assertNever, and the
    // return type is total. Drive every reachable state and confirm no slot is
    // undefined — a missing arm would either be a tsc error or yield undefined.
    const states: ProgressPresentationInputs[] = [
      makeInputs({ isThinking: true }),
      makeInputs({ isComplete: true }),
      makeInputs({ isPaused: true }),
      makeInputs({ isComplete: true, endedWith: 'transient_error' }),
      makeInputs({ silentStop: silentStop('user_stopped') }),
      makeInputs({ silentStop: silentStop('awaiting_user') }),
      makeInputs({ silentStop: silentStop('unexpected_stop') }),
      makeInputs({ silentStop: silentStop('interrupted') }),
      makeInputs({ silentStop: silentStop('interrupted', true, 'shutdown') }),
      makeInputs({ silentStop: silentStop('interrupted', true, 'startup-correction') }),
      makeInputs({ isComplete: true, endedWith: 'superseded' }),
      makeInputs({ hasError: true }),
    ];
    for (const input of states) {
      const p = deriveProgressPresentation(input);
      expect(p.iconKind).toBeDefined();
      expect(p.liveIconKind).toBeDefined();
      expect(p.headerText).toBeDefined();
      expect(p.liveTextKind).toBeDefined();
      expect(p.sectionLabelText).toBeDefined();
    }
  });

  it('assertNever (the lock used in the icon switch default) throws on an unhandled discriminant', () => {
    // Verifies the fail-closed mechanism that backs the icon-ladder switch: if a
    // future ProgressRenderState member reached the switch without an arm, the
    // default `assertNever(state)` throws an InvariantViolationError rather than
    // returning undefined.
    expect(() => assertNever('impossible_state' as never, 'deriveIconKind')).toThrow(
      InvariantViolationError,
    );
  });
});
