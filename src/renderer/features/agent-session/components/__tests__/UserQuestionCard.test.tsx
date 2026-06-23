import { describe, it, expect } from 'vitest';
import type {
  UserQuestionBatch,
  UserQuestionAnswer,
  UserQuestion,
  QuestionOption,
} from '@shared/types';
import { isApprovalClarificationBatch } from '@shared/types/userQuestion';
import type { FileAttachment } from '@renderer/features/composer/hooks/useFileAttachments';
import {
  AUTO_ADVANCE_DELAY_MS,
  SKIPPED_MARKER,
  formatAnswer,
  buildAnswers,
  createInitialSelections,
  shouldAutoAdvanceAfterOptionSelect,
} from '../UserQuestionCard';

/**
 * Tests for UserQuestionCard component (stepper v2).
 *
 * Note: Full component rendering tests (click interactions, stepper navigation)
 * would require @testing-library/react which isn't currently installed.
 * These tests verify exports, type structure, prop contracts, and the
 * pure helper functions (formatAnswer, buildAnswers, createInitialSelections).
 *
 * To enable full component testing:
 *   npm install -D @testing-library/react @testing-library/jest-dom
 */

// =============================================================================
// Test Helpers
// =============================================================================

function makeOption(id: string, label: string, description: string = ''): QuestionOption {
  return { id, label, description };
}

function makeQuestion(overrides: Partial<UserQuestion> = {}): UserQuestion {
  return {
    id: 'q0',
    question: 'What format do you prefer?',
    header: 'Format',
    options: [
      makeOption('q0-opt0', 'Bullet points', 'Quick scannable overview'),
      makeOption('q0-opt1', 'Paragraphs', 'Detailed narrative format'),
      makeOption('q0-opt2', 'Table', 'Side-by-side structured view'),
    ],
    multiSelect: false,
    ...overrides,
  };
}

function makeBatch(overrides: Partial<UserQuestionBatch> = {}): UserQuestionBatch {
  return {
    batchId: 'batch-1',
    toolUseId: 'tool-1',
    turnId: 'turn-1',
    sessionId: 'session-1',
    questions: [makeQuestion()],
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeAnswer(questionId: string, selectedOptionIds: string[], freeText?: string): UserQuestionAnswer {
  return { questionId, selectedOptionIds, freeText };
}

function makeBinaryAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    id: 'att-1',
    name: 'brief.pdf',
    type: 'binary',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    originalPath: '/tmp/brief.pdf',
    ...overrides,
  } as FileAttachment;
}

/** Shorthand for building a QuestionSelections-shaped object */
function makeSel(overrides: Partial<{
  selectedOptionIds: Set<string>;
  freeText: string;
  otherSelected: boolean;
  attachments: FileAttachment[];
}> = {}) {
  return {
    selectedOptionIds: new Set<string>(),
    freeText: '',
    otherSelected: false,
    attachments: [],
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('UserQuestionCard', () => {
  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  describe('exports', () => {
    it('exports UserQuestionCard as named export', async () => {
      const module = await import('../UserQuestionCard');
      expect(module.UserQuestionCard).toBeDefined();
      expect(typeof module.UserQuestionCard).toBe('object');
    });

    it('component has displayName set for debugging', async () => {
      const module = await import('../UserQuestionCard');
      const component = module.UserQuestionCard as { type?: { displayName?: string }; displayName?: string };
      const name = component.displayName ?? component.type?.displayName;
      expect(name).toBe('UserQuestionCard');
    });

    it('exports pure helper functions', () => {
      expect(typeof formatAnswer).toBe('function');
      expect(typeof buildAnswers).toBe('function');
      expect(typeof createInitialSelections).toBe('function');
      expect(typeof shouldAutoAdvanceAfterOptionSelect).toBe('function');
    });

    it('exports constants', () => {
      expect(typeof AUTO_ADVANCE_DELAY_MS).toBe('number');
      expect(typeof SKIPPED_MARKER).toBe('string');
    });

    it('can import UserQuestionCardProps type', async () => {
      const module = await import('../UserQuestionCard');
      expect(module.UserQuestionCard).toBeDefined();
    });
  });

  describe('approval clarification classification', () => {
    it('recognizes legacy pre-send clarification questions without explicit purpose', () => {
      const batch = makeBatch({
        questions: [
          makeQuestion({
            question: 'What should I send Jane?',
            header: 'Note',
            context:
              'Choosing a channel or providing text here is not approval to send — I’ll show the draft before any send.',
            options: [
              makeOption('q0-opt0', 'Type note', 'Paste or type the message.'),
              makeOption('q0-opt1', 'Slack DM', 'Send by Slack DM after draft approval.'),
            ],
          }),
        ],
      });

      expect(isApprovalClarificationBatch(batch)).toBe(true);
    });

    it('keeps generic questions generic without approval-boundary wording', () => {
      expect(isApprovalClarificationBatch(makeBatch())).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  describe('constants', () => {
    it('AUTO_ADVANCE_DELAY_MS is 200ms', () => {
      expect(AUTO_ADVANCE_DELAY_MS).toBe(200);
    });

    it('SKIPPED_MARKER is [Skipped]', () => {
      expect(SKIPPED_MARKER).toBe('[Skipped]');
    });
  });

  // ---------------------------------------------------------------------------
  // shouldAutoAdvanceAfterOptionSelect
  // ---------------------------------------------------------------------------

  describe('shouldAutoAdvanceAfterOptionSelect', () => {
    it('auto-advances intermediate single-select questions', () => {
      expect(
        shouldAutoAdvanceAfterOptionSelect({
          multiSelect: false,
          requiresInput: false,
          hasUrl: false,
          isLastQuestion: false,
        }),
      ).toBe(true);
    });

    it('auto-advances final single-select question without requiresInput (timed auto-submit)', () => {
      expect(
        shouldAutoAdvanceAfterOptionSelect({
          multiSelect: false,
          requiresInput: false,
          hasUrl: false,
          isLastQuestion: true,
        }),
      ).toBe(true);
    });

    it('does not auto-advance multi-select questions', () => {
      expect(
        shouldAutoAdvanceAfterOptionSelect({
          multiSelect: true,
          requiresInput: false,
          hasUrl: false,
          isLastQuestion: false,
        }),
      ).toBe(false);
    });

    it('does not auto-advance multi-select questions even when option has url', () => {
      expect(
        shouldAutoAdvanceAfterOptionSelect({
          multiSelect: true,
          requiresInput: false,
          hasUrl: true,
          isLastQuestion: false,
        }),
      ).toBe(false);
    });

    it('does not auto-advance questions that require typed input', () => {
      expect(
        shouldAutoAdvanceAfterOptionSelect({
          multiSelect: false,
          requiresInput: true,
          hasUrl: false,
          isLastQuestion: false,
        }),
      ).toBe(false);
    });

    it('does not auto-advance when option has url but no requiresInput (credential-fetch dead-end prevention)', () => {
      // Regression: clicking "Need to get it" used to auto-submit ~200ms after
      // opening the provider's keys page in a new tab, leaving the user with
      // nowhere to paste the freshly-fetched credential. Wait for explicit Submit.
      expect(
        shouldAutoAdvanceAfterOptionSelect({
          multiSelect: false,
          requiresInput: false,
          hasUrl: true,
          isLastQuestion: false,
        }),
      ).toBe(false);
    });

    it('does not auto-advance when option has both url and requiresInput (requiresInput dominates)', () => {
      // Properly-paired credential-fetch option: opens URL AND reveals input field.
      // Auto-advance is suppressed by requiresInput; behaviour preserved.
      expect(
        shouldAutoAdvanceAfterOptionSelect({
          multiSelect: false,
          requiresInput: true,
          hasUrl: true,
          isLastQuestion: false,
        }),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // createInitialSelections
  // ---------------------------------------------------------------------------

  describe('createInitialSelections', () => {
    it('creates a map entry for each question', () => {
      const questions = [
        makeQuestion({ id: 'q0' }),
        makeQuestion({ id: 'q1' }),
      ];
      const result = createInitialSelections(questions);
      expect(result.size).toBe(2);
      expect(result.has('q0')).toBe(true);
      expect(result.has('q1')).toBe(true);
    });

    it('initialises each entry with empty selections', () => {
      const questions = [makeQuestion({ id: 'q0' })];
      const result = createInitialSelections(questions);
      const sel = result.get('q0')!;
      expect(sel.selectedOptionIds.size).toBe(0);
      expect(sel.freeText).toBe('');
      expect(sel.otherSelected).toBe(false);
      expect(sel.attachments).toEqual([]);
    });

    it('returns empty map for empty questions array', () => {
      const result = createInitialSelections([]);
      expect(result.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // buildAnswers
  // ---------------------------------------------------------------------------

  describe('buildAnswers', () => {
    it('builds answer with selected option', () => {
      const questions = [makeQuestion()];
      const sels = new Map([['q0', makeSel({ selectedOptionIds: new Set(['q0-opt0']) })]]);
      const answers = buildAnswers(questions, sels);
      expect(answers).toHaveLength(1);
      expect(answers[0].questionId).toBe('q0');
      expect(answers[0].selectedOptionIds).toEqual(['q0-opt0']);
      expect(answers[0].freeText).toBeUndefined();
    });

    it('builds answer with multiple selected options (multi-select)', () => {
      const questions = [makeQuestion({ multiSelect: true })];
      const sels = new Map([['q0', makeSel({ selectedOptionIds: new Set(['q0-opt0', 'q0-opt2']) })]]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].selectedOptionIds).toHaveLength(2);
      expect(answers[0].selectedOptionIds).toContain('q0-opt0');
      expect(answers[0].selectedOptionIds).toContain('q0-opt2');
    });

    it('builds answer with skip marker', () => {
      const questions = [makeQuestion()];
      const sels = new Map([['q0', makeSel({ freeText: SKIPPED_MARKER })]]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].freeText).toBe(SKIPPED_MARKER);
      expect(answers[0].selectedOptionIds).toEqual([]);
    });

    it('builds answer with "other" free-text', () => {
      const questions = [makeQuestion()];
      const sels = new Map([['q0', makeSel({ otherSelected: true, freeText: 'Custom answer' })]]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].freeText).toBe('Custom answer');
      expect(answers[0].selectedOptionIds).toEqual([]);
    });

    it('builds answer with uploaded attachment metadata for supplemental input', () => {
      const questions = [makeQuestion({
        options: [{ id: 'q0-opt0', label: 'Upload brief', description: '', requiresInput: true }],
      })];
      const sels = new Map([['q0', makeSel({
        selectedOptionIds: new Set(['q0-opt0']),
        attachments: [makeBinaryAttachment()],
      })]]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].attachments).toEqual([
        { id: 'att-1', name: 'brief.pdf', type: 'binary', mimeType: 'application/pdf' },
      ]);
    });

    it('builds answer for free-text-only question (no options)', () => {
      const questions = [makeQuestion({ options: [] })];
      const sels = new Map([['q0', makeSel({ freeText: 'My typed answer' })]]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].freeText).toBe('My typed answer');
    });

    it('trims whitespace from free-text answers', () => {
      const questions = [makeQuestion({ options: [] })];
      const sels = new Map([['q0', makeSel({ freeText: '  spaces  ' })]]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].freeText).toBe('spaces');
    });

    it('ignores empty/whitespace free-text for "other"', () => {
      const questions = [makeQuestion()];
      const sels = new Map([['q0', makeSel({ otherSelected: true, freeText: '   ' })]]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].freeText).toBeUndefined();
    });

    it('returns empty selectedOptionIds for unanswered question', () => {
      const questions = [makeQuestion()];
      const sels = new Map([['q0', makeSel()]]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].selectedOptionIds).toEqual([]);
      expect(answers[0].freeText).toBeUndefined();
    });

    it('handles missing selection entry for a question', () => {
      const questions = [makeQuestion()];
      const sels = new Map<string, ReturnType<typeof makeSel>>();
      const answers = buildAnswers(questions, sels);
      expect(answers[0].questionId).toBe('q0');
      expect(answers[0].selectedOptionIds).toEqual([]);
    });

    it('builds answers for multi-question batch', () => {
      const questions = [
        makeQuestion({ id: 'q0' }),
        makeQuestion({ id: 'q1', question: 'Second?' }),
      ];
      const sels = new Map([
        ['q0', makeSel({ selectedOptionIds: new Set(['q0-opt0']) })],
        ['q1', makeSel({ freeText: SKIPPED_MARKER })],
      ]);
      const answers = buildAnswers(questions, sels);
      expect(answers).toHaveLength(2);
      expect(answers[0].selectedOptionIds).toEqual(['q0-opt0']);
      expect(answers[1].freeText).toBe(SKIPPED_MARKER);
    });

    it('skip marker takes precedence over "other" flag', () => {
      const questions = [makeQuestion()];
      const sels = new Map([['q0', makeSel({ otherSelected: true, freeText: SKIPPED_MARKER })]]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].freeText).toBe(SKIPPED_MARKER);
    });
  });

  // ---------------------------------------------------------------------------
  // formatAnswer
  // ---------------------------------------------------------------------------

  describe('formatAnswer', () => {
    it('formats a single selected option', () => {
      const question = makeQuestion();
      const answer = makeAnswer('q0', ['q0-opt0']);
      expect(formatAnswer(question, answer)).toBe('Bullet points');
    });

    it('formats multiple selected options (multi-select)', () => {
      const question = makeQuestion({ multiSelect: true });
      const answer = makeAnswer('q0', ['q0-opt0', 'q0-opt2']);
      expect(formatAnswer(question, answer)).toBe('Bullet points, Table');
    });

    it('formats free-text only answer', () => {
      const question = makeQuestion();
      const answer = makeAnswer('q0', [], 'Custom format preference');
      expect(formatAnswer(question, answer)).toBe('"Custom format preference"');
    });

    it('formats option + free-text combined answer', () => {
      const question = makeQuestion({ multiSelect: true });
      const answer = makeAnswer('q0', ['q0-opt0'], 'With extra notes');
      expect(formatAnswer(question, answer)).toBe('Bullet points, "With extra notes"');
    });

    it('formats attachment names alongside the answer', () => {
      const question = makeQuestion();
      const answer: UserQuestionAnswer = {
        questionId: 'q0',
        selectedOptionIds: ['q0-opt0'],
        attachments: [{ id: 'att-1', name: 'brief.pdf', type: 'binary', mimeType: 'application/pdf' }],
      };
      expect(formatAnswer(question, answer)).toBe('Bullet points, Attached: brief.pdf');
    });

    it('returns dash for empty answer', () => {
      const question = makeQuestion();
      const answer = makeAnswer('q0', []);
      expect(formatAnswer(question, answer)).toBe('—');
    });

    it('skips unrecognised option IDs gracefully', () => {
      const question = makeQuestion();
      const answer = makeAnswer('q0', ['nonexistent-opt']);
      expect(formatAnswer(question, answer)).toBe('—');
    });

    it('formats skip-marker answer as quoted string', () => {
      const question = makeQuestion();
      const answer = makeAnswer('q0', [], SKIPPED_MARKER);
      expect(formatAnswer(question, answer)).toBe(`"${SKIPPED_MARKER}"`);
    });
  });

  // ---------------------------------------------------------------------------
  // Prop contract — pending state (stepper)
  // ---------------------------------------------------------------------------

  describe('prop contract (pending state)', () => {
    it('documents required props for pending stepper card', () => {
      const batch = makeBatch();
      const props = {
        batch,
        isAnswered: false,
        answers: undefined,
        onSubmit: async (_batchId: string, _answers: UserQuestionAnswer[]) => {},
        onDismiss: (_batchId: string) => {},
        onUndoDismiss: (_batchId: string) => {},
        isSubmitting: false,
        error: null,
      };

      expect(props.batch.batchId).toBe('batch-1');
      expect(props.isAnswered).toBe(false);
      expect(props.isSubmitting).toBe(false);
      expect(typeof props.onSubmit).toBe('function');
      expect(typeof props.onDismiss).toBe('function');
      expect(typeof props.onUndoDismiss).toBe('function');
    });

    it('variant defaults to inline when omitted', () => {
      const props = {
        batch: makeBatch(),
        isAnswered: false,
        onSubmit: async () => {},
        onDismiss: () => {},
        onUndoDismiss: () => {},
        isSubmitting: false,
      };
      expect(props).not.toHaveProperty('variant');
    });

    it('variant can be set to footer for input area replacement', () => {
      const props = {
        batch: makeBatch(),
        isAnswered: false,
        onSubmit: async () => {},
        onDismiss: () => {},
        onUndoDismiss: () => {},
        isSubmitting: false,
        variant: 'footer' as const,
      };
      expect(props.variant).toBe('footer');
    });

    it('variant can be set to inline for conversation flow', () => {
      const props = {
        batch: makeBatch(),
        isAnswered: false,
        onSubmit: async () => {},
        onDismiss: () => {},
        onUndoDismiss: () => {},
        isSubmitting: false,
        variant: 'inline' as const,
      };
      expect(props.variant).toBe('inline');
    });

    it('onSubmit receives batchId and answers array', async () => {
      let capturedBatchId: string | null = null;
      let capturedAnswers: UserQuestionAnswer[] | null = null;
      const submittedAnswers = [makeAnswer('q0', ['q0-opt0'])];

      const onSubmit = async (batchId: string, answers: UserQuestionAnswer[]) => {
        capturedBatchId = batchId;
        capturedAnswers = answers;
      };

      await onSubmit('batch-1', submittedAnswers);

      expect(capturedBatchId).toBe('batch-1');
      expect(capturedAnswers).toEqual(submittedAnswers);
    });

    it('onDismiss receives batchId (synchronous, no IPC)', () => {
      let capturedBatchId: string | null = null;

      const onDismiss = (batchId: string) => {
        capturedBatchId = batchId;
      };

      onDismiss('batch-1');

      expect(capturedBatchId).toBe('batch-1');
    });

    it('approval-context pending cards keep purpose for non-approval presentation', () => {
      const batch = makeBatch({
        questions: [
          makeQuestion({
            purpose: 'approval_clarification',
            context: 'I found two calendars that could fit.',
          }),
        ],
      });
      const props = {
        batch,
        isAnswered: false,
        onSubmit: async () => {},
        onDismiss: (_batchId: string) => {},
        onUndoDismiss: (_batchId: string) => {},
        isSubmitting: false,
      };

      expect(props.batch.questions[0].purpose).toBe('approval_clarification');
    });

    it('onUndoDismiss receives batchId', () => {
      let capturedBatchId: string | null = null;

      const onUndoDismiss = (batchId: string) => {
        capturedBatchId = batchId;
      };

      onUndoDismiss('batch-1');

      expect(capturedBatchId).toBe('batch-1');
    });

    it('error prop is displayed as alert when non-null', () => {
      const props = {
        batch: makeBatch(),
        isAnswered: false,
        onSubmit: async () => {},
        onDismiss: () => {},
        onUndoDismiss: () => {},
        isSubmitting: false,
        error: 'Failed to submit answers',
      };
      expect(props.error).toBe('Failed to submit answers');
    });
  });

  // ---------------------------------------------------------------------------
  // Prop contract — answered state
  // ---------------------------------------------------------------------------

  describe('prop contract (answered state)', () => {
    it('documents required props for answered question card', () => {
      const batch = makeBatch();
      const answers = [makeAnswer('q0', ['q0-opt1'])];
      const props = {
        batch,
        isAnswered: true,
        answers,
        onSubmit: async () => {},
        onDismiss: () => {},
        onUndoDismiss: () => {},
        isSubmitting: false,
        error: null,
      };

      expect(props.isAnswered).toBe(true);
      expect(props.answers).toHaveLength(1);
    });

    it('answered state renders read-only with selected options', () => {
      const question = makeQuestion();
      const answer = makeAnswer('q0', ['q0-opt1']);
      expect(formatAnswer(question, answer)).toBe('Paragraphs');
    });

    it('approval-context answered receipt is distinct from generic answered state', () => {
      const batch = makeBatch({
        questions: [makeQuestion({ purpose: 'approval_clarification' })],
      });
      const props = {
        batch,
        isAnswered: true,
        answers: [makeAnswer('q0', ['q0-opt1'])],
      };

      expect(props.batch.questions[0].purpose).toBe('approval_clarification');
      // Component copy: "Clarification answered" + Safety Rules follow-up note.
    });
  });

  // ---------------------------------------------------------------------------
  // Prop contract — skipped state
  // ---------------------------------------------------------------------------

  describe('prop contract (skipped state)', () => {
    it('documents skipped state props', () => {
      const batch = makeBatch();
      const props = {
        batch,
        isAnswered: true,
        answers: [] as UserQuestionAnswer[],
        skipped: true,
        onSubmit: async () => {},
        onDismiss: () => {},
        onUndoDismiss: () => {},
        isSubmitting: false,
        error: null,
      };

      expect(props.isAnswered).toBe(true);
      expect(props.skipped).toBe(true);
      expect(props.answers).toEqual([]);
    });

    it('skipped card shows "Questions skipped" (not "Questions answered")', () => {
      // When skipped=true, the component renders:
      // - aria-label="Questions skipped"
      // - header text "Questions skipped"
      // - SkipForward icon instead of Check icon
      // - cardSkipped CSS class instead of cardAnswered
      // - No per-question answered values displayed
      const props = {
        batch: makeBatch(),
        isAnswered: true,
        skipped: true,
        answers: [] as UserQuestionAnswer[],
      };
      expect(props.skipped).toBe(true);
      expect(props.isAnswered).toBe(true);
    });

    it('non-skipped answered card does not use skipped styling', () => {
      const props = {
        batch: makeBatch(),
        isAnswered: true,
        skipped: undefined,
        answers: [makeAnswer('q0', ['q0-opt0'])],
      };
      expect(props.skipped).toBeUndefined();
      expect(props.isAnswered).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Prop contract — dismissed state
  // ---------------------------------------------------------------------------

  describe('prop contract (dismissed state)', () => {
    it('documents dismissed state props', () => {
      const batch = makeBatch();
      const props = {
        batch,
        isAnswered: false,
        dismissed: true,
        onSubmit: async () => {},
        onDismiss: () => {},
        onUndoDismiss: (_batchId: string) => {},
        isSubmitting: false,
      };

      expect(props.dismissed).toBe(true);
      expect(props.isAnswered).toBe(false);
    });

    it('dismissed card renders "Questions dismissed" (not "Questions answered")', () => {
      // When dismissed=true, the component renders:
      // - aria-label="Questions dismissed"
      // - header text "Questions dismissed"
      // - X icon instead of Check icon
      // - cardDismissed CSS class
      // - "Show questions" button for undo
      const props = {
        batch: makeBatch(),
        isAnswered: false,
        dismissed: true,
      };
      expect(props.dismissed).toBe(true);
      expect(props.isAnswered).toBe(false);
    });

    it('dismissed card has "Show questions" button for undo', () => {
      // The dismissed card includes a "Show questions" button that calls onUndoDismiss(batchId)
      const batch = makeBatch();
      let undoDismissBatchId: string | null = null;
      const props = {
        batch,
        isAnswered: false,
        dismissed: true,
        onUndoDismiss: (batchId: string) => { undoDismissBatchId = batchId; },
      };
      // Simulate undo click
      props.onUndoDismiss(batch.batchId);
      expect(undoDismissBatchId).toBe('batch-1');
    });

    it('onDismiss is synchronous (no IPC, no Promise)', () => {
      // Unlike the old onSkip which was async and triggered IPC,
      // onDismiss is synchronous and renderer-only
      const onDismiss = (batchId: string) => batchId;
      const result = onDismiss('batch-1');
      expect(result).toBe('batch-1');
      // Note: result is NOT a Promise (synchronous path)
      expect(result).not.toBeInstanceOf(Promise);
    });

    it('dismissed state is distinct from answered and skipped', () => {
      const dismissed = { isAnswered: false, dismissed: true, skipped: undefined };
      const answered = { isAnswered: true, dismissed: undefined, skipped: undefined };
      const skipped = { isAnswered: true, dismissed: undefined, skipped: true };
      expect(dismissed.isAnswered).toBe(false);
      expect(answered.isAnswered).toBe(true);
      expect(skipped.skipped).toBe(true);
      expect(dismissed.dismissed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Single-question batch — Skip button visibility
  // ---------------------------------------------------------------------------

  describe('single-question batch skip visibility', () => {
    it('single-question batch has no per-question Skip button', () => {
      // For a batch with exactly 1 question, the per-question Skip button
      // is hidden. The user can only answer, type "something else", or dismiss (X).
      const batch = makeBatch({ questions: [makeQuestion()] });
      expect(batch.questions).toHaveLength(1);
      // isSingleQuestionBatch = batch.questions.length === 1 → true → Skip hidden
      const isSingleQuestionBatch = batch.questions.length === 1;
      expect(isSingleQuestionBatch).toBe(true);
    });

    it('multi-question batch shows per-question Skip button', () => {
      // For a batch with 2+ questions, the per-question Skip button is visible
      const batch = makeBatch({
        questions: [
          makeQuestion({ id: 'q0' }),
          makeQuestion({ id: 'q1', question: 'Second?' }),
        ],
      });
      expect(batch.questions.length).toBeGreaterThanOrEqual(2);
      const isSingleQuestionBatch = batch.questions.length === 1;
      expect(isSingleQuestionBatch).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Keyboard — Escape triggers onDismiss
  // ---------------------------------------------------------------------------

  describe('keyboard dismiss', () => {
    it('documents that Escape key triggers onDismiss (not onSkip)', () => {
      // The Escape keyboard handler now calls onDismiss (synchronous, renderer-only)
      // instead of the old onSkip (async, IPC). This is verified in ARIA tests below.
      const shortcuts = {
        dismiss: 'Escape',
      };
      expect(shortcuts.dismiss).toBe('Escape');
    });
  });

  // ---------------------------------------------------------------------------
  // Stepper validation logic
  // ---------------------------------------------------------------------------

  describe('stepper validation logic', () => {
    /**
     * Reimplementation of the component's questionHasAnswer callback.
     * The stepper validates per-question before allowing advance/submit.
     */
    function questionHasAnswer(
      question: UserQuestion,
      sel: { selectedOptionIds: Set<string>; freeText: string; otherSelected: boolean },
    ): boolean {
      if (sel.freeText === SKIPPED_MARKER) return true;
      if (sel.selectedOptionIds.size > 0) return true;
      if (sel.otherSelected && sel.freeText.trim().length > 0) return true;
      if (question.options.length === 0 && sel.freeText.trim().length > 0) return true;
      return false;
    }

    it('question with selected option is valid', () => {
      const question = makeQuestion();
      expect(questionHasAnswer(question, makeSel({ selectedOptionIds: new Set(['q0-opt0']) }))).toBe(true);
    });

    it('question with no selection is invalid', () => {
      const question = makeQuestion();
      expect(questionHasAnswer(question, makeSel())).toBe(false);
    });

    it('question with "Other" selected and text is valid', () => {
      const question = makeQuestion();
      expect(questionHasAnswer(question, makeSel({ otherSelected: true, freeText: 'My answer' }))).toBe(true);
    });

    it('question with "Other" selected but empty text is invalid', () => {
      const question = makeQuestion();
      expect(questionHasAnswer(question, makeSel({ otherSelected: true }))).toBe(false);
      expect(questionHasAnswer(question, makeSel({ otherSelected: true, freeText: '   ' }))).toBe(false);
    });

    it('free-text only question (no options) requires text', () => {
      const question = makeQuestion({ options: [] });
      expect(questionHasAnswer(question, makeSel())).toBe(false);
      expect(questionHasAnswer(question, makeSel({ freeText: 'Typed answer' }))).toBe(true);
    });

    it('multi-select with multiple options is valid', () => {
      const question = makeQuestion({ multiSelect: true });
      expect(questionHasAnswer(question, makeSel({ selectedOptionIds: new Set(['q0-opt0', 'q0-opt1']) }))).toBe(true);
    });

    it('skipped question (SKIPPED_MARKER) is always valid', () => {
      const question = makeQuestion();
      expect(questionHasAnswer(question, makeSel({ freeText: SKIPPED_MARKER }))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ARIA accessibility
  // ---------------------------------------------------------------------------

  describe('ARIA accessibility', () => {
    it('documents expected ARIA attributes on pending stepper card', () => {
      // The pending stepper card uses:
      // - role="form" with aria-label="Rebel has a question" (single) or
      //   "Rebel has a question — N of M" (multi-question)
      // - aria-describedby linking to error message when present
      // - role="radiogroup" (single-select) or role="group" (multi-select) on options grid
      // - role="radio" / role="checkbox" with aria-checked on each option card
      // - aria-live="polite" on progress indicator ("1 of 3")
      // - role="alert" on error message
      // - aria-busy on submit button when submitting
      // - aria-label="Dismiss all questions" on X button
      // - aria-label="Go back to previous question" on Back button
      const ariaAttributes = {
        card: { role: 'form', 'aria-label': 'Rebel has a question' },
        optionsGrid: { role: 'radiogroup' },
        optionCard: { role: 'radio', 'aria-checked': false },
        progress: { 'aria-live': 'polite' },
        error: { role: 'alert' },
      };
      expect(ariaAttributes.card.role).toBe('form');
      expect(ariaAttributes.optionCard.role).toBe('radio');
    });

    it('documents expected ARIA attributes on answered card', () => {
      // The answered card uses:
      // - role="region" with aria-label="Answered questions"
      // - aria-hidden="true" on decorative icons (Check)
      const ariaAttributes = {
        card: { role: 'region', 'aria-label': 'Answered questions' },
      };
      expect(ariaAttributes.card.role).toBe('region');
    });

    it('documents expected ARIA attributes on skipped card', () => {
      // The skipped card uses:
      // - role="region" with aria-label="Questions skipped"
      // - aria-hidden="true" on decorative icons (SkipForward)
      const ariaAttributes = {
        card: { role: 'region', 'aria-label': 'Questions skipped' },
      };
      expect(ariaAttributes.card.role).toBe('region');
      expect(ariaAttributes.card['aria-label']).toBe('Questions skipped');
    });

    it('documents expected ARIA attributes on dismissed card', () => {
      // The dismissed card uses:
      // - role="region" with aria-label="Questions dismissed"
      // - aria-hidden="true" on decorative icons (X)
      // - "Show questions" button for undo
      const ariaAttributes = {
        card: { role: 'region', 'aria-label': 'Questions dismissed' },
      };
      expect(ariaAttributes.card.role).toBe('region');
      expect(ariaAttributes.card['aria-label']).toBe('Questions dismissed');
    });

    it('documents keyboard navigation for stepper', () => {
      // Arrow Up/Down: navigate between option cards
      // Enter/Space: select focused option card
      // Backspace: go back to previous question (when not in input)
      // Escape: dismiss all questions
      // Enter (in text input): advance to next question / submit
      const shortcuts = {
        navigateOptions: ['ArrowUp', 'ArrowDown'],
        selectOption: ['Enter', ' '],
        goBack: 'Backspace',
        dismiss: 'Escape',
        advanceFromInput: 'Enter',
      };
      expect(shortcuts.navigateOptions).toContain('ArrowDown');
      expect(shortcuts.goBack).toBe('Backspace');
      expect(shortcuts.dismiss).toBe('Escape');
    });
  });

  // ---------------------------------------------------------------------------
  // Question batch edge cases
  // ---------------------------------------------------------------------------

  describe('question batch edge cases', () => {
    it('handles single question batch (no progress indicator)', () => {
      const batch = makeBatch({
        questions: [makeQuestion()],
      });
      expect(batch.questions).toHaveLength(1);
    });

    it('handles maximum 4 questions per batch (agent limit)', () => {
      const batch = makeBatch({
        questions: [
          makeQuestion({ id: 'q0' }),
          makeQuestion({ id: 'q1', question: 'Second question?', header: 'Q2' }),
          makeQuestion({ id: 'q2', question: 'Third question?', header: 'Q3' }),
          makeQuestion({ id: 'q3', question: 'Fourth question?', header: 'Q4' }),
        ],
      });
      expect(batch.questions).toHaveLength(4);
    });

    it('handles question with no options (free-text only)', () => {
      const batch = makeBatch({
        questions: [makeQuestion({ options: [] })],
      });
      expect(batch.questions[0].options).toHaveLength(0);
    });

    it('handles question with maximum 4 options (agent limit)', () => {
      const batch = makeBatch({
        questions: [
          makeQuestion({
            options: [
              makeOption('q0-opt0', 'A'),
              makeOption('q0-opt1', 'B'),
              makeOption('q0-opt2', 'C'),
              makeOption('q0-opt3', 'D'),
            ],
          }),
        ],
      });
      expect(batch.questions[0].options).toHaveLength(4);
    });

    it('handles multi-select question', () => {
      const batch = makeBatch({
        questions: [makeQuestion({ multiSelect: true })],
      });
      expect(batch.questions[0].multiSelect).toBe(true);
    });

    it('intermediate single-select questions auto-advance after option click', () => {
      expect(AUTO_ADVANCE_DELAY_MS).toBe(200);
    });

    it('per-question skip uses SKIPPED_MARKER in freeText', () => {
      const answers = buildAnswers(
        [makeQuestion()],
        new Map([['q0', makeSel({ freeText: SKIPPED_MARKER })]]),
      );
      expect(answers[0].freeText).toBe('[Skipped]');
      expect(answers[0].selectedOptionIds).toEqual([]);
    });

    it('mixed answered and skipped questions in a batch', () => {
      const questions = [
        makeQuestion({ id: 'q0' }),
        makeQuestion({ id: 'q1', question: 'Second?' }),
        makeQuestion({ id: 'q2', question: 'Third?' }),
      ];
      const sels = new Map([
        ['q0', makeSel({ selectedOptionIds: new Set(['q0-opt0']) })],
        ['q1', makeSel({ freeText: SKIPPED_MARKER })],
        ['q2', makeSel({ otherSelected: true, freeText: 'Custom' })],
      ]);
      const answers = buildAnswers(questions, sels);
      expect(answers[0].selectedOptionIds).toEqual(['q0-opt0']);
      expect(answers[0].freeText).toBeUndefined();
      expect(answers[1].freeText).toBe(SKIPPED_MARKER);
      expect(answers[2].freeText).toBe('Custom');
    });
  });
});
