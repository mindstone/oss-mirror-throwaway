import { describe, it, expect } from 'vitest';
import type { AgentEvent, TurnEndReason } from '@shared/types';
import type { TaskProgressItem } from '../turnStepContext';
import type { TurnInterruptionSource } from '@shared/constants/turnInterruption';
import {
  detectSilentStop,
  canOfferContinue,
  getResultTurnEndReason,
  getTurnInterruptionSource,
  type SilentStopInput,
} from '../detectSilentStop';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(status: TaskProgressItem['status'], id = 'task-1'): TaskProgressItem {
  return { id, title: `Task ${id}`, status };
}

function makeInput(overrides: Partial<SilentStopInput> = {}): SilentStopInput {
  return {
    taskProgress: undefined,
    isThinking: false,
    isBusy: false,
    turnEvents: [],
    isStopping: false,
    ...overrides,
  };
}

function makeResultEvent(turnEndReason?: TurnEndReason): AgentEvent {
  return {
    type: 'result',
    text: 'Done',
    timestamp: Date.now(),
    ...(turnEndReason ? { turnEndReason } : {}),
  };
}

function makeErrorEvent(message = 'Something went wrong', errorKind?: 'message_timeout'): AgentEvent {
  return {
    type: 'error',
    error: message,
    timestamp: Date.now(),
    ...(errorKind ? { errorKind } : {}),
  };
}

function makeInterruptionStatusEvent(source?: TurnInterruptionSource): AgentEvent {
  return {
    type: 'status',
    message: 'Agent turn interrupted when Mindstone Rebel closed.',
    timestamp: Date.now(),
    ...(source ? { source } : {}),
  };
}

function makeUserQuestionEvent(): AgentEvent {
  return {
    type: 'user_question',
    batchId: 'batch-1',
    toolUseId: 'tool-1',
    questions: [],
    timestamp: Date.now(),
  };
}

function makeChatApprovalQuestionEvent(): Extract<AgentEvent, { type: 'user_question' }> {
  return {
    type: 'user_question',
    batchId: 'batch-approval',
    toolUseId: 'tool-approval',
    questions: [
      {
        id: 'q0',
        question: 'Send this Slack DM to Jane?',
        header: 'Approve',
        context: 'Recipient resolved as Jane. Message: “doing a test”.',
        options: [
          { id: 'q0-opt0', label: 'Send', description: 'Send exactly: “doing a test”' },
          { id: 'q0-opt1', label: 'Edit', description: 'Change the message before sending' },
          { id: 'q0-opt2', label: 'Cancel', description: 'Do not send anything' },
        ],
        multiSelect: false,
      },
    ],
    timestamp: Date.now(),
  };
}

function makeMixedChatApprovalQuestionEvent(): AgentEvent {
  const event = makeChatApprovalQuestionEvent();
  return {
    ...event,
    batchId: 'batch-mixed-approval',
    questions: [
      {
        id: 'q-generic',
        question: 'Which tone should I use?',
        header: 'Tone',
        options: [
          { id: 'q-generic-opt0', label: 'Brief', description: 'Keep it concise.' },
          { id: 'q-generic-opt1', label: 'Warm', description: 'Make it friendlier.' },
        ],
        multiSelect: false,
      },
      ...event.questions,
    ],
  };
}

// ---------------------------------------------------------------------------
// detectSilentStop
// ---------------------------------------------------------------------------

describe('detectSilentStop', () => {
  // ── Classification: 'none' ──

  describe('returns none', () => {
    it('when isThinking is true', () => {
      const result = detectSilentStop(makeInput({
        isThinking: true,
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
      }));
      expect(result).toEqual({ hasSilentStop: false, incompleteTaskCount: 0, classification: 'none', errorContinueEligible: false });
    });

    it('when isBusy is true', () => {
      const result = detectSilentStop(makeInput({
        isBusy: true,
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
      }));
      expect(result).toEqual({ hasSilentStop: false, incompleteTaskCount: 0, classification: 'none', errorContinueEligible: false });
    });

    it('when taskProgress is undefined', () => {
      const result = detectSilentStop(makeInput({ taskProgress: undefined }));
      expect(result.classification).toBe('none');
      expect(result.hasSilentStop).toBe(false);
    });

    it('when taskProgress is empty', () => {
      const result = detectSilentStop(makeInput({ taskProgress: [] }));
      expect(result.classification).toBe('none');
      expect(result.hasSilentStop).toBe(false);
    });

    it('when all tasks are completed', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('completed', 'task-2')],
      }));
      expect(result.classification).toBe('none');
      expect(result.hasSilentStop).toBe(false);
    });

    it('when tasks exist but none completed (plan-only turn)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('pending'), makeTask('in_progress', 'task-2')],
      }));
      expect(result.classification).toBe('none');
      expect(result.hasSilentStop).toBe(false);
    });

    it('when all tasks are pending (no work started)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('pending'), makeTask('pending', 'task-2')],
      }));
      expect(result.classification).toBe('none');
      expect(result.hasSilentStop).toBe(false);
    });
  });

  // ── Classification: 'user_stopped' ──

  describe('classifies user_stopped', () => {
    it('when isStopping is true and tasks are incomplete', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        isStopping: true,
      }));
      expect(result.classification).toBe('user_stopped');
      expect(result.hasSilentStop).toBe(true);
      expect(result.incompleteTaskCount).toBe(1);
    });

    it('when result event has turnEndReason: user_stopped (historical turn, isStopping false)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2'), makeTask('in_progress', 'task-3')],
        isStopping: false,
        turnEvents: [makeResultEvent('user_stopped')],
      }));
      expect(result.classification).toBe('user_stopped');
      expect(result.hasSilentStop).toBe(true);
      expect(result.incompleteTaskCount).toBe(2);
    });

    it('prioritizes user_stopped over awaiting_user when both signals present', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        isStopping: true,
        turnEvents: [makeUserQuestionEvent()],
      }));
      expect(result.classification).toBe('user_stopped');
    });
  });

  // ── Classification: 'superseded' ──

  describe('classifies superseded', () => {
    it('when result event has turnEndReason: superseded', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeResultEvent('superseded')],
      }));
      expect(result.classification).toBe('superseded');
      expect(result.hasSilentStop).toBe(false);
      expect(result.incompleteTaskCount).toBe(1);
    });

    it('superseded takes priority over user_stopped (isStopping flag)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        isStopping: true,
        turnEvents: [makeResultEvent('superseded')],
      }));
      expect(result.classification).toBe('superseded');
      expect(result.hasSilentStop).toBe(false);
    });
  });

  // ── Classification: 'awaiting_user' ──

  describe('classifies awaiting_user', () => {
    it('when turn has user_question event with incomplete tasks', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeUserQuestionEvent()],
      }));
      expect(result.classification).toBe('awaiting_user');
      expect(result.hasSilentStop).toBe(true);
      expect(result.incompleteTaskCount).toBe(1);
    });

    it('does not classify blocked chat-approval questions as awaiting user', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeChatApprovalQuestionEvent()],
      }));
      expect(result.classification).toBe('unexpected_stop');
      expect(result.hasSilentStop).toBe(true);
      expect(result.incompleteTaskCount).toBe(1);
    });

    it('does not classify mixed batches with a chat-approval question as awaiting user', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeMixedChatApprovalQuestionEvent()],
      }));
      expect(result.classification).toBe('unexpected_stop');
      expect(result.hasSilentStop).toBe(true);
      expect(result.incompleteTaskCount).toBe(1);
    });

    it('when result event has turnEndReason: awaiting_user', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeResultEvent('awaiting_user')],
      }));
      expect(result.classification).toBe('awaiting_user');
      expect(result.hasSilentStop).toBe(true);
    });
  });

  // ── Classification: 'interrupted' (Stage 1a — FOX-2771/2601) ──

  describe('classifies interrupted', () => {
    it('fires WITHOUT taskProgress when last event is the interruption status', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: undefined,
        turnEvents: [
          { type: 'status', message: 'Working…', timestamp: Date.now() },
          makeInterruptionStatusEvent(),
        ],
      }));
      expect(result.classification).toBe('interrupted');
      expect(result.hasSilentStop).toBe(true);
      expect(result.incompleteTaskCount).toBe(0);
      expect(result.errorContinueEligible).toBe(false);
    });

    it('fires with empty taskProgress', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [],
        turnEvents: [makeInterruptionStatusEvent()],
      }));
      expect(result.classification).toBe('interrupted');
      expect(result.hasSilentStop).toBe(true);
    });

    it('counts incomplete tasks when taskProgress IS present', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2'), makeTask('in_progress', 'task-3')],
        turnEvents: [makeInterruptionStatusEvent()],
      }));
      expect(result.classification).toBe('interrupted');
      expect(result.incompleteTaskCount).toBe(2);
    });

    // FOX-2771 follow-up: thread the quit-vs-crash discriminator to the renderer.
    it('threads interruptionSource=shutdown from the status event', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeInterruptionStatusEvent('shutdown')],
      }));
      expect(result.classification).toBe('interrupted');
      expect(result.interruptionSource).toBe('shutdown');
    });

    it('threads interruptionSource=startup-correction from the status event', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeInterruptionStatusEvent('startup-correction')],
      }));
      expect(result.classification).toBe('interrupted');
      expect(result.interruptionSource).toBe('startup-correction');
    });

    it('leaves interruptionSource undefined for a pre-discriminator session (no source on status)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeInterruptionStatusEvent()],
      }));
      expect(result.classification).toBe('interrupted');
      expect(result.interruptionSource).toBeUndefined();
    });

    it('leaves interruptionSource undefined for non-interrupted classifications', () => {
      const stopped = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        isStopping: true,
      }));
      expect(stopped.classification).toBe('user_stopped');
      expect(stopped.interruptionSource).toBeUndefined();
    });

    it('does NOT fire while the turn is still running', () => {
      const result = detectSilentStop(makeInput({
        isThinking: true,
        turnEvents: [makeInterruptionStatusEvent()],
      }));
      expect(result.classification).toBe('none');
      expect(result.hasSilentStop).toBe(false);
    });

    it('does NOT fire on a healthy turn (result event last)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: undefined,
        turnEvents: [
          { type: 'status', message: 'Working…', timestamp: Date.now() },
          makeResultEvent('completed'),
        ],
      }));
      expect(result.classification).toBe('none');
      expect(result.hasSilentStop).toBe(false);
    });

    it('does NOT fire when the interruption status is not the LAST event', () => {
      // Producer appends the status last and only to turns without a terminal
      // event; if a result follows, the turn ended normally afterwards.
      const result = detectSilentStop(makeInput({
        taskProgress: undefined,
        turnEvents: [makeInterruptionStatusEvent(), makeResultEvent('completed')],
      }));
      expect(result.classification).toBe('none');
    });

    it('does NOT fire for a regular trailing status message', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: undefined,
        turnEvents: [{ type: 'status', message: 'Some other status', timestamp: Date.now() }],
      }));
      expect(result.classification).toBe('none');
    });

    // Composer F6: the predicate is exact-equality BY DESIGN (producer and
    // reader share TURN_INTERRUPTION_MESSAGE) — near-miss strings must not match.
    it.each([
      ['trailing space', 'Agent turn interrupted when Mindstone Rebel closed. '],
      ['missing period', 'Agent turn interrupted when Mindstone Rebel closed'],
      ['case drift', 'agent turn interrupted when Mindstone Rebel closed.'],
      ['leading space', ' Agent turn interrupted when Mindstone Rebel closed.'],
    ])('does NOT fire on near-miss copy (%s)', (_label, message) => {
      const result = detectSilentStop(makeInput({
        taskProgress: undefined,
        turnEvents: [{ type: 'status', message, timestamp: Date.now() }],
      }));
      expect(result.classification).toBe('none');
      expect(result.hasSilentStop).toBe(false);
    });
  });

  // ── Classification: 'error_exit' ──

  describe('classifies error_exit', () => {
    it('when turn has error event with incomplete tasks', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeErrorEvent()],
      }));
      expect(result.classification).toBe('error_exit');
      // error_exit defers to existing error handling — no silent stop banner
      expect(result.hasSilentStop).toBe(false);
      expect(result.incompleteTaskCount).toBe(1);
    });

    it('when result has turnEndReason: error but no error event (graceful degradation)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeResultEvent('error')],
      }));
      expect(result.classification).toBe('error_exit');
      expect(result.hasSilentStop).toBe(false);
    });
  });

  // ── error_exit continue-eligibility (Stage 1b — watchdog/timeout/stall only) ──

  describe('error_exit continue eligibility', () => {
    const tasks = () => [makeTask('completed'), makeTask('pending', 'task-2')];

    it('watchdog kill ("unresponsive … stopped automatically") is continue-eligible', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: tasks(),
        turnEvents: [makeErrorEvent('This turn was unresponsive for 12 minutes and was stopped automatically. You can try sending your message again.')],
      }));
      expect(result.classification).toBe('error_exit');
      expect(result.hasSilentStop).toBe(false); // error banner still owns the failure display
      expect(result.errorContinueEligible).toBe(true);
    });

    it('extended-silence watchdog ("went silent … stopped automatically") is continue-eligible', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: tasks(),
        turnEvents: [makeErrorEvent('This turn went silent for over 9 minutes and was stopped automatically. Try sending the message again.')],
      }));
      expect(result.errorContinueEligible).toBe(true);
    });

    it('response-stalled timeout is continue-eligible', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: tasks(),
        turnEvents: [makeErrorEvent('Response stalled and timed out. Please try again.')],
      }));
      expect(result.errorContinueEligible).toBe(true);
    });

    it('upstream abort ("took too long to respond") is continue-eligible', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: tasks(),
        turnEvents: [makeErrorEvent('The AI took too long to respond. Your message is safe — try sending it again.')],
      }));
      expect(result.errorContinueEligible).toBe(true);
    });

    it('structural errorKind message_timeout is continue-eligible regardless of copy', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: tasks(),
        turnEvents: [makeErrorEvent('Some provider-specific phrasing', 'message_timeout')],
      }));
      expect(result.errorContinueEligible).toBe(true);
    });

    it('generic api error is NOT continue-eligible', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: tasks(),
        turnEvents: [makeErrorEvent('Something went wrong. Please try again.')],
      }));
      expect(result.classification).toBe('error_exit');
      expect(result.errorContinueEligible).toBe(false);
    });

    it('billing error is NOT continue-eligible', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: tasks(),
        turnEvents: [makeErrorEvent('Your account needs billing attention — add credits to continue.')],
      }));
      expect(result.errorContinueEligible).toBe(false);
    });

    it('keys on the TERMINAL (last) error — mid-turn watchdog error followed by billing error is not eligible', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: tasks(),
        turnEvents: [
          makeErrorEvent('stopped automatically'),
          makeErrorEvent('Your credit balance is too low.'),
        ],
      }));
      expect(result.errorContinueEligible).toBe(false);
    });

    it('turnEndReason error with NO error event is not eligible (nothing to classify)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: tasks(),
        turnEvents: [makeResultEvent('error')],
      }));
      expect(result.classification).toBe('error_exit');
      expect(result.errorContinueEligible).toBe(false);
    });

    it('non-error classifications never set errorContinueEligible', () => {
      const stopped = detectSilentStop(makeInput({
        taskProgress: tasks(),
        isStopping: true,
        turnEvents: [makeErrorEvent('stopped automatically')],
      }));
      expect(stopped.classification).toBe('user_stopped');
      expect(stopped.errorContinueEligible).toBe(false);
    });
  });

  // ── Classification: 'unexpected_stop' ──

  describe('classifies unexpected_stop', () => {
    it('when incomplete tasks exist with completed tasks and no other signals', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeResultEvent()],
      }));
      expect(result.classification).toBe('unexpected_stop');
      expect(result.hasSilentStop).toBe(true);
      expect(result.incompleteTaskCount).toBe(1);
    });

    it('backward compat: no turnEndReason on result + incomplete tasks → unexpected_stop', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [
          makeTask('completed'),
          makeTask('completed', 'task-2'),
          makeTask('pending', 'task-3'),
        ],
        turnEvents: [makeResultEvent()], // no turnEndReason
      }));
      expect(result.classification).toBe('unexpected_stop');
      expect(result.hasSilentStop).toBe(true);
      expect(result.incompleteTaskCount).toBe(1);
    });

    it('with no turn events at all + incomplete tasks', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [],
      }));
      expect(result.classification).toBe('unexpected_stop');
      expect(result.hasSilentStop).toBe(true);
    });
  });

  // ── Classification: 'finished_with_handoff' ──
  //
  // REBEL-H5: When the agent's result event explicitly says `turnEndReason: 'completed'`
  // but tasks remain incomplete, this is a user-owned handoff, NOT an unexpected stop.
  // See docs/plans/260528_rebel-h5-stopped-finished/PLAN.md.

  describe('classifies finished_with_handoff', () => {
    it('when result has turnEndReason: completed + incomplete tasks', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeResultEvent('completed')],
      }));
      expect(result.classification).toBe('finished_with_handoff');
      expect(result.hasSilentStop).toBe(true);
      expect(result.incompleteTaskCount).toBe(1);
    });

    it('counts multiple incomplete tasks for the handoff', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [
          makeTask('completed'),
          makeTask('pending', 'task-2'),
          makeTask('in_progress', 'task-3'),
        ],
        turnEvents: [makeResultEvent('completed')],
      }));
      expect(result.classification).toBe('finished_with_handoff');
      expect(result.incompleteTaskCount).toBe(2);
    });

    it('does NOT classify as finished_with_handoff when all tasks are complete (→ none)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('completed', 'task-2')],
        turnEvents: [makeResultEvent('completed')],
      }));
      // All complete → falls out at step 2 ("no incomplete tasks")
      expect(result.classification).toBe('none');
      expect(result.hasSilentStop).toBe(false);
    });

    it('superseded takes priority over finished_with_handoff (turnEndReason: superseded)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeResultEvent('superseded')],
      }));
      // A newer turn already replaced this one — incomplete tasks belong to the newer turn,
      // not a clean handoff. superseded check runs before the completed/handoff branch.
      expect(result.classification).toBe('superseded');
      expect(result.hasSilentStop).toBe(false);
    });

    it('user_stopped takes priority over finished_with_handoff (isStopping flag)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        isStopping: true,
        turnEvents: [makeResultEvent('completed')],
      }));
      // isStopping > completed: a stop pressed during a completion synthesis still reads as user_stopped.
      expect(result.classification).toBe('user_stopped');
    });

    it('awaiting_user takes priority over finished_with_handoff (user_question event)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeResultEvent('completed'), makeUserQuestionEvent()],
      }));
      // A live question outranks a "completed" tag: agent is actively waiting for input.
      expect(result.classification).toBe('awaiting_user');
    });

    it('error_exit takes priority over finished_with_handoff (error event present)', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeResultEvent('completed'), makeErrorEvent()],
      }));
      // An error event during the turn outranks the "completed" tag.
      expect(result.classification).toBe('error_exit');
      expect(result.hasSilentStop).toBe(false);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('counts multiple incomplete tasks correctly', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [
          makeTask('completed'),
          makeTask('pending', 'task-2'),
          makeTask('in_progress', 'task-3'),
          makeTask('pending', 'task-4'),
        ],
        turnEvents: [],
      }));
      expect(result.incompleteTaskCount).toBe(3);
    });

    it('handles blocked tasks as incomplete', () => {
      // blocked is not pending/in_progress, so it's not counted as incomplete
      const result = detectSilentStop(makeInput({
        taskProgress: [
          makeTask('completed'),
          makeTask('blocked', 'task-2'),
        ],
        turnEvents: [],
      }));
      // blocked is NOT counted as incomplete (only pending/in_progress)
      expect(result.classification).toBe('none');
    });

    it('user_stopped takes priority over error events', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        isStopping: true,
        turnEvents: [makeErrorEvent()],
      }));
      expect(result.classification).toBe('user_stopped');
    });

    it('awaiting_user takes priority over error events', () => {
      const result = detectSilentStop(makeInput({
        taskProgress: [makeTask('completed'), makeTask('pending', 'task-2')],
        turnEvents: [makeUserQuestionEvent(), makeErrorEvent()],
      }));
      expect(result.classification).toBe('awaiting_user');
    });
  });
});

// ---------------------------------------------------------------------------
// canOfferContinue
// ---------------------------------------------------------------------------

describe('canOfferContinue', () => {
  it('returns true for unexpected_stop on last turn when not busy', () => {
    expect(canOfferContinue('unexpected_stop', true, false)).toBe(true);
  });

  it('returns true for user_stopped on last turn when not busy', () => {
    expect(canOfferContinue('user_stopped', true, false)).toBe(true);
  });

  it('returns false for superseded (new turn already handles it)', () => {
    expect(canOfferContinue('superseded', true, false)).toBe(false);
  });

  it('returns false for awaiting_user (user should answer the question)', () => {
    expect(canOfferContinue('awaiting_user', true, false)).toBe(false);
  });

  it('returns false for error_exit (default — not continue-eligible)', () => {
    expect(canOfferContinue('error_exit', true, false)).toBe(false);
  });

  it('returns true for error_exit when the terminal error is continue-eligible (timeout/stall)', () => {
    expect(canOfferContinue('error_exit', true, false, true)).toBe(true);
  });

  it('returns false for continue-eligible error_exit when busy or not last turn', () => {
    expect(canOfferContinue('error_exit', true, true, true)).toBe(false);
    expect(canOfferContinue('error_exit', false, false, true)).toBe(false);
  });

  it('returns true for interrupted on last turn when not busy', () => {
    expect(canOfferContinue('interrupted', true, false)).toBe(true);
  });

  it('returns false for interrupted when not last turn or busy', () => {
    expect(canOfferContinue('interrupted', false, false)).toBe(false);
    expect(canOfferContinue('interrupted', true, true)).toBe(false);
  });

  it('returns false for finished_with_handoff (Rebel finished cleanly; user owns next steps)', () => {
    expect(canOfferContinue('finished_with_handoff', true, false)).toBe(false);
  });

  it('returns false for none', () => {
    expect(canOfferContinue('none', true, false)).toBe(false);
  });

  it('returns false when not the last turn', () => {
    expect(canOfferContinue('unexpected_stop', false, false)).toBe(false);
  });

  it('returns false when busy', () => {
    expect(canOfferContinue('unexpected_stop', true, true)).toBe(false);
  });

  it('returns false for user_stopped when not last turn', () => {
    expect(canOfferContinue('user_stopped', false, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getResultTurnEndReason
// ---------------------------------------------------------------------------

describe('getResultTurnEndReason', () => {
  it('returns undefined when no events', () => {
    expect(getResultTurnEndReason([])).toBeUndefined();
  });

  it('returns undefined when no result event', () => {
    expect(getResultTurnEndReason([makeErrorEvent()])).toBeUndefined();
  });

  it('returns undefined when result has no turnEndReason (pre-improvement session)', () => {
    expect(getResultTurnEndReason([makeResultEvent()])).toBeUndefined();
  });

  it('returns the turnEndReason from a result event', () => {
    expect(getResultTurnEndReason([makeResultEvent('user_stopped')])).toBe('user_stopped');
  });

  it('prefers the last result event when multiple exist (double-result edge case)', () => {
    const apiResult = makeResultEvent();
    const syntheticResult = makeResultEvent('user_stopped');
    expect(getResultTurnEndReason([apiResult, syntheticResult])).toBe('user_stopped');
  });

  it('returns the last result turnEndReason when multiple result events exist', () => {
    const first = makeResultEvent('completed');
    const second = makeResultEvent('error');
    expect(getResultTurnEndReason([first, second])).toBe('error');
  });

  it('ignores non-result events when scanning', () => {
    const events: AgentEvent[] = [
      { type: 'status', message: 'Starting', timestamp: Date.now() },
      makeResultEvent('awaiting_user'),
      makeErrorEvent(),
    ];
    expect(getResultTurnEndReason(events)).toBe('awaiting_user');
  });
});

// ---------------------------------------------------------------------------
// getTurnInterruptionSource
// ---------------------------------------------------------------------------

describe('getTurnInterruptionSource', () => {
  it('returns the source when the last event is the interruption status', () => {
    expect(getTurnInterruptionSource([makeInterruptionStatusEvent('shutdown')])).toBe('shutdown');
    expect(getTurnInterruptionSource([makeInterruptionStatusEvent('startup-correction')]))
      .toBe('startup-correction');
  });

  it('returns undefined when the interruption status has no source (pre-discriminator)', () => {
    expect(getTurnInterruptionSource([makeInterruptionStatusEvent()])).toBeUndefined();
  });

  it('returns undefined when the LAST event is not the interruption status', () => {
    expect(getTurnInterruptionSource([
      makeInterruptionStatusEvent('shutdown'),
      makeResultEvent('completed'),
    ])).toBeUndefined();
  });

  it('returns undefined for a regular trailing status', () => {
    expect(getTurnInterruptionSource([
      { type: 'status', message: 'Working…', timestamp: Date.now() },
    ])).toBeUndefined();
  });

  it('returns undefined for no events', () => {
    expect(getTurnInterruptionSource([])).toBeUndefined();
  });
});
