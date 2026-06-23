import { describe, it, expect } from 'vitest';

import {
  buildUserQuestionContinuationMessage,
  buildUserQuestionSkipMessage,
  buildMultiBatchContinuationMessage,
} from '@core/services/userQuestionService';
import type { UserQuestionBatch, UserQuestionAnswer } from '@shared/types/userQuestion';

function makeBatch(overrides?: Partial<UserQuestionBatch>): UserQuestionBatch {
  return {
    batchId: 'batch-1',
    toolUseId: 'tool-1',
    turnId: 'turn-1',
    sessionId: 'session-1',
    questions: [
      {
        id: 'q0',
        question: 'What format do you prefer?',
        header: 'Format',
        options: [
          { id: 'q0-opt0', label: 'Bullet points', description: 'Quick, scannable overview' },
          { id: 'q0-opt1', label: 'Paragraphs', description: 'Thorough, narrative format' },
        ],
        multiSelect: false,
      },
    ],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('userQuestionService', () => {

  // ─── Continuation message builder ──────────────────────────

  describe('buildUserQuestionContinuationMessage', () => {
    it('formats single question with selected option and numbered option list', () => {
      const batch = makeBatch();
      const answers: UserQuestionAnswer[] = [
        { questionId: 'q0', selectedOptionIds: ['q0-opt0'] },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).toContain('The user answered your questions:');
      expect(message).toContain('What format do you prefer?');
      expect(message).toContain('Options presented:');
      expect(message).toContain('1. Bullet points');
      expect(message).toContain('2. Paragraphs');
      expect(message).toContain('Answer: 1. Bullet points');
      // Continuation now opens with neutral continuation-context language,
      // while the approval-boundary guidance is conditional for pre-approval
      // clarification. See
      // docs/plans/260518_reduce_approval_clarification_branch_scope.md (Stage 1).
      expect(message).toContain('Use these answers as continuation context');
    });

    it('formats free-text answer', () => {
      const batch = makeBatch();
      const answers: UserQuestionAnswer[] = [
        { questionId: 'q0', selectedOptionIds: [], freeText: 'A table format please' },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).toContain('"A table format please" (custom response)');
    });

    it('formats combined option + free-text', () => {
      const batch = makeBatch();
      const answers: UserQuestionAnswer[] = [
        { questionId: 'q0', selectedOptionIds: ['q0-opt0'], freeText: 'But keep it short' },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).toContain('Bullet points');
      expect(message).toContain('"But keep it short" (custom response)');
    });

    it('treats edited text as resolved content rather than a stopping point', () => {
      const batch = makeBatch({
        questions: [
          {
            id: 'q0',
            question: 'What should the note say?',
            header: 'Message',
            options: [
              {
                id: 'q0-opt0',
                label: 'Edit first',
                description: 'Write or revise the message before sending',
                requiresInput: true,
              },
            ],
            multiSelect: false,
          },
        ],
      });
      const answers: UserQuestionAnswer[] = [
        {
          questionId: 'q0',
          selectedOptionIds: ['q0-opt0'],
          freeText: 'hi I am testing this is automated message',
        },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).toContain('"hi I am testing this is automated message"');
      expect(message).toMatch(/resolved content/i);
      expect(message).toMatch(/Do not stop merely to ask whether to use that exact text/i);
      expect(message).toMatch(/Slack vs email/i);
      expect(message).toMatch(/ask that focused follow-up question/i);
      expect(message).toMatch(/continue to the normal action-tool path/i);
    });

    it('formats uploaded document names alongside the answer', () => {
      const batch = makeBatch();
      const answers: UserQuestionAnswer[] = [
        {
          questionId: 'q0',
          selectedOptionIds: ['q0-opt0'],
          attachments: [{ id: 'att-1', name: 'brief.pdf', type: 'document', mimeType: 'application/pdf' }],
        },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).toContain('Bullet points');
      expect(message).toContain('attached document: brief.pdf');
    });

    it('formats multiple questions', () => {
      const batch = makeBatch({
        questions: [
          {
            id: 'q0',
            question: 'What format?',
            header: 'Format',
            options: [
              { id: 'q0-opt0', label: 'Bullets', description: 'Quick' },
              { id: 'q0-opt1', label: 'Prose', description: 'Detailed' },
            ],
            multiSelect: false,
          },
          {
            id: 'q1',
            question: 'How detailed?',
            header: 'Detail',
            options: [
              { id: 'q1-opt0', label: 'Brief', description: 'High-level' },
              { id: 'q1-opt1', label: 'Comprehensive', description: 'Full detail' },
            ],
            multiSelect: false,
          },
        ],
      });
      const answers: UserQuestionAnswer[] = [
        { questionId: 'q0', selectedOptionIds: ['q0-opt0'] },
        { questionId: 'q1', selectedOptionIds: ['q1-opt1'] },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).toContain('1. What format?');
      expect(message).toContain('Answer: 1. Bullets');
      expect(message).toContain('2. How detailed?');
      expect(message).toContain('Answer: 2. Comprehensive');
    });

    it('handles multi-select answers with numbered references', () => {
      const batch = makeBatch({
        questions: [
          {
            id: 'q0',
            question: 'Which features?',
            header: 'Features',
            options: [
              { id: 'q0-opt0', label: 'Feature A', description: 'First' },
              { id: 'q0-opt1', label: 'Feature B', description: 'Second' },
              { id: 'q0-opt2', label: 'Feature C', description: 'Third' },
            ],
            multiSelect: true,
          },
        ],
      });
      const answers: UserQuestionAnswer[] = [
        { questionId: 'q0', selectedOptionIds: ['q0-opt0', 'q0-opt2'] },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).toContain('1. Feature A, 3. Feature C');
    });

    it('handles unanswered question gracefully', () => {
      const batch = makeBatch();
      const answers: UserQuestionAnswer[] = [];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).toContain('(no answer provided)');
    });

    it('includes "Do not re-ask" instruction to prevent repeated questions', () => {
      const batch = makeBatch();
      const answers: UserQuestionAnswer[] = [
        { questionId: 'q0', selectedOptionIds: ['q0-opt0'] },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).toContain('Do not re-ask these questions');
    });

    // ─── Pre-approval clarification invariant (Stage 1) ─────────
    // These tests anchor the "clarification is not approval" boundary in
    // the continuation message. They are the runtime counterpart to the
    // AskUserQuestion description tests in builtinTools.test.ts. The
    // critical regression to prevent: an agent receiving an answer (or an
    // emphatic free-text answer like "send it now") and treating that as
    // permission to execute a sensitive action without going through the
    // normal approval surface. See
    // docs/plans/260518_reduce_approval_clarification_branch_scope.md (Stage 1).

    it('frames the answer as resolved clarification, not as a directive to execute', () => {
      const batch = makeBatch();
      const answers: UserQuestionAnswer[] = [
        { questionId: 'q0', selectedOptionIds: ['q0-opt0'] },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      // Provides generic continuation context…
      expect(message).toMatch(/Use these answers as continuation context/);
      expect(message).not.toMatch(/Please proceed based on these answers/i);
      // …while preserving the approval-specific invariant conditionally.
      expect(message).toMatch(/resolves intent, not permission/);
      // …does not approve.
      expect(message).toMatch(/Clarification is NOT approval/i);
      // …does not bypass the normal approval surface for sensitive actions:
      // it should use the action-tool path so the host safety layer can stage/review.
      expect(message).toMatch(/normal action-tool path/i);
      expect(message).toMatch(/Safety Rules \/ approval layer/i);
      expect(message).toMatch(/do not replace that path with a chat-based confirmation/i);
      expect(message).toMatch(/reply "send"/i);
      // …and is not stored as a Safety Rule / preference.
      expect(message).toMatch(/Safety Rule/);
      expect(message).toMatch(/per-case/i);
    });

    it('treats adversarial free-text answers like "send it now" as clarification data, not permission', () => {
      // The user's free-text answer is the most direct attack on the
      // clarification-vs-approval boundary: a phrase like "yes, send it
      // now" or "approve it" reads as permission to a model unless the
      // continuation explicitly frames free text as clarification data.
      // We don't pass the adversarial text to the model on faith — we
      // also assert the continuation includes the standing guidance that
      // free-text answers do NOT grant execution permission, regardless
      // of what the user typed.
      const batch = makeBatch({
        questions: [
          {
            id: 'q0',
            question: 'Which channel should I post the launch update to?',
            header: 'Channel',
            options: [
              { id: 'q0-opt0', label: '#product-team', description: 'Internal product channel' },
              { id: 'q0-opt1', label: '#general', description: 'Whole company' },
            ],
            multiSelect: false,
          },
        ],
      });
      const answers: UserQuestionAnswer[] = [
        {
          questionId: 'q0',
          selectedOptionIds: ['q0-opt0'],
          freeText: 'yes, just go ahead and send it now please',
        },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      // The free-text is preserved verbatim so the agent has the user's
      // raw words…
      expect(message).toContain('"yes, just go ahead and send it now please"');
      // …but the surrounding guidance must explicitly defang it.
      expect(message).toMatch(/free-text/i);
      expect(message).toMatch(/clarification data/i);
      expect(message).toMatch(/do not grant execution permission|does not grant.*permission|do NOT grant/i);
      // The classic emphatic phrases the model might over-index on must
      // be called out by name in the standing guidance so the agent has
      // explicit calibration anchors.
      expect(message).toMatch(/send it now/i);
      expect(message).toMatch(/approve it/i);
      expect(message).toMatch(/go ahead/i);
    });

    it('includes numbered option list so LLM can resolve user references like "1 and 3"', () => {
      const batch = makeBatch({
        questions: [
          {
            id: 'q0',
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { id: 'q0-opt0', label: 'Quick prototype', description: 'Fast' },
              { id: 'q0-opt1', label: 'Full spec', description: 'Thorough' },
              { id: 'q0-opt2', label: 'Research first', description: 'Careful' },
            ],
            multiSelect: true,
          },
        ],
      });
      const answers: UserQuestionAnswer[] = [
        { questionId: 'q0', selectedOptionIds: ['q0-opt0', 'q0-opt2'] },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      // The option list should be present so the LLM knows what "1" and "3" mean
      expect(message).toContain('Options presented:');
      expect(message).toContain('1. Quick prototype');
      expect(message).toContain('2. Full spec');
      expect(message).toContain('3. Research first');
      // The answer should reference the numbered options
      expect(message).toContain('Answer: 1. Quick prototype, 3. Research first');
    });

    it('omits option list for free-text-only questions (no options)', () => {
      const batch = makeBatch({
        questions: [
          {
            id: 'q0',
            question: 'What is your API key?',
            header: 'API Key',
            options: [],
            multiSelect: false,
          },
        ],
      });
      const answers: UserQuestionAnswer[] = [
        { questionId: 'q0', selectedOptionIds: [], freeText: 'fake-abc123' },
      ];

      const message = buildUserQuestionContinuationMessage(batch, answers);
      expect(message).not.toContain('Options presented:');
      expect(message).toContain('"fake-abc123" (custom response)');
    });
  });

  // ─── Skip message builder ─────────────────────────────────

  describe('buildUserQuestionSkipMessage', () => {
    it('formats skip message with question text', () => {
      const batch = makeBatch();
      const message = buildUserQuestionSkipMessage(batch);
      expect(message).toContain('The user chose to skip your questions without answering.');
      expect(message).toContain('Questions that were skipped:');
      expect(message).toContain('1. What format do you prefer?');
      // Skip text must still preserve the do-not-re-ask invariant, but it
      // must NO LONGER tell the agent to "proceed using your best judgment"
      // unconditionally — that wording was unsafe for sensitive
      // clarification (skipping a "which calendar?" question must not
      // license guessing the calendar). See
      // docs/plans/260518_reduce_approval_clarification_branch_scope.md
      // (Stage 1 — fail-closed skip for sensitive clarification).
      expect(message).toContain('Do not re-ask these specific questions');
      expect(message).toMatch(/sensitive next steps|sensitive/i);
      expect(message).toMatch(/do NOT guess|do not guess/i);
      expect(message).toMatch(/normal action-tool path/i);
      expect(message).toMatch(/Safety Rules \/ approval layer/i);
      expect(message).toMatch(/do not ask for chat-based approval/i);
      expect(message).toMatch(/independently clear from other context|what is still missing/i);
    });

    it('lists multiple skipped questions', () => {
      const batch = makeBatch({
        questions: [
          {
            id: 'q0',
            question: 'What format?',
            header: 'Format',
            options: [
              { id: 'q0-opt0', label: 'Bullets', description: 'Quick' },
            ],
            multiSelect: false,
          },
          {
            id: 'q1',
            question: 'How detailed?',
            header: 'Detail',
            options: [
              { id: 'q1-opt0', label: 'Brief', description: 'High-level' },
            ],
            multiSelect: false,
          },
        ],
      });
      const message = buildUserQuestionSkipMessage(batch);
      expect(message).toContain('1. What format?');
      expect(message).toContain('2. How detailed?');
    });

    it('includes "Do not re-ask these specific questions" instruction', () => {
      const batch = makeBatch();
      const message = buildUserQuestionSkipMessage(batch);
      expect(message).toContain('Do not re-ask these specific questions.');
    });
  });

  // ─── Multi-batch continuation message builder ─────────────

  describe('buildMultiBatchContinuationMessage', () => {
    it('formats multiple answered batches with set labels', () => {
      const batch1 = makeBatch({ batchId: 'b1' });
      const batch2 = makeBatch({
        batchId: 'b2',
        questions: [
          {
            id: 'q0',
            question: 'How detailed?',
            header: 'Detail',
            options: [
              { id: 'q0-opt0', label: 'Brief', description: 'High-level' },
              { id: 'q0-opt1', label: 'Detailed', description: 'Full' },
            ],
            multiSelect: false,
          },
        ],
      });

      const message = buildMultiBatchContinuationMessage([
        { batch: batch1, answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }] },
        { batch: batch2, answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt1'] }] },
      ]);

      expect(message).toContain('2 sets of questions');
      expect(message).toContain('## Set 1');
      expect(message).toContain('1. Bullet points');
      expect(message).toContain('## Set 2');
      expect(message).toContain('2. Detailed');
      // Multi-batch continuations must carry the same conditional
      // "clarification is not approval" boundary as single-batch
      // continuations so the two paths cannot drift.
      // See docs/plans/260518_reduce_approval_clarification_branch_scope.md
      // (Stage 1).
      expect(message).toMatch(/Use these answers as continuation context/);
      expect(message).toMatch(/Clarification is NOT approval/i);
      expect(message).toMatch(/normal action-tool path/i);
      expect(message).toMatch(/Safety Rules \/ approval layer/i);
    });

    it('marks skipped batches', () => {
      const batch1 = makeBatch({ batchId: 'b1' });
      const batch2 = makeBatch({ batchId: 'b2' });

      const message = buildMultiBatchContinuationMessage([
        { batch: batch1, answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }] },
        { batch: batch2, answers: [], skipped: true },
      ]);

      expect(message).toContain('## Set 1');
      expect(message).toContain('Bullet points');
      expect(message).toContain('## Set 2');
      expect(message).toContain('(User skipped this set without answering.)');
      expect(message).toContain('Questions skipped:');
      expect(message).toContain('What format do you prefer?');
      expect(message).toMatch(/do NOT guess|do not guess/i);
      expect(message).toMatch(/do NOT execute|do not execute/i);
    });

    it('uses singular label for single batch', () => {
      const batch = makeBatch();
      const message = buildMultiBatchContinuationMessage([
        { batch, answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }] },
      ]);

      expect(message).toContain('1 set of questions');
      expect(message).not.toContain('sets');
    });

    it('includes "Do not re-ask" instruction to prevent repeated questions', () => {
      const batch = makeBatch();
      const message = buildMultiBatchContinuationMessage([
        { batch, answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }] },
      ]);

      expect(message).toContain('Do not re-ask these questions');
    });

    it('does not describe skipped multi-batch questions as resolved sensitive clarifications', () => {
      const answeredBatch = makeBatch({
        batchId: 'b1',
        questions: [
          {
            id: 'q0',
            question: 'Which channel should I use?',
            header: 'Channel',
            options: [
              { id: 'q0-opt0', label: '#product-team', description: 'Internal product channel' },
            ],
            multiSelect: false,
          },
        ],
      });
      const skippedBatch = makeBatch({
        batchId: 'b2',
        questions: [
          {
            id: 'q0',
            question: 'Which calendar should this go on?',
            header: 'Calendar',
            options: [
              { id: 'q0-opt0', label: 'Work', description: 'Company calendar' },
            ],
            multiSelect: false,
          },
        ],
      });

      const message = buildMultiBatchContinuationMessage([
        { batch: answeredBatch, answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }] },
        { batch: skippedBatch, answers: [], skipped: true },
      ]);

      expect(message).toContain('(User skipped this set without answering.)');
      expect(message).toContain('Which calendar should this go on?');
      expect(message).toMatch(/do NOT guess|do not guess/i);
      expect(message).toMatch(/do NOT execute|do not execute/i);
      expect(message).toMatch(/what is still missing/i);
      expect(message).toMatch(/If any question was clarifying a named missing decision/i);
    });

    it('preserves the "clarification is not approval" boundary for multi-batch answers (Stage 1 invariant)', () => {
      // Why this lives here as well as in buildUserQuestionContinuationMessage:
      // when multiple sibling batches resolve in one pass (queued batches in
      // userQuestionResponseHandler), the agent sees ONLY the multi-batch
      // continuation. If the trailer drifts on this path the boundary leaks
      // even though the single-batch path remains correct. See
      // docs/plans/260518_reduce_approval_clarification_branch_scope.md
      // (Stage 1) and the rationale on the shared trailer guidance.
      const batch1 = makeBatch({ batchId: 'b1' });
      const batch2 = makeBatch({
        batchId: 'b2',
        questions: [
          {
            id: 'q0',
            question: 'Which calendar should this go on?',
            header: 'Calendar',
            options: [
              { id: 'q0-opt0', label: 'Personal', description: 'jordan@…' },
              { id: 'q0-opt1', label: 'Work', description: '[external-email]' },
            ],
            multiSelect: false,
          },
        ],
      });

      const message = buildMultiBatchContinuationMessage([
        {
          batch: batch1,
          answers: [
            {
              questionId: 'q0',
              selectedOptionIds: ['q0-opt0'],
              freeText: 'approve it and send it now',
            },
          ],
        },
        {
          batch: batch2,
          answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt1'] }],
        },
      ]);

      // Adversarial free text from set 1 is preserved verbatim (so the
      // agent sees the user's raw words)…
      expect(message).toContain('"approve it and send it now"');
      // …but the standing guidance must defang it.
      expect(message).toMatch(/clarification data/i);
      expect(message).toMatch(/Clarification is NOT approval/i);
      expect(message).toMatch(/normal action-tool path/i);
      expect(message).toMatch(/chat-based confirmation/i);
      expect(message).toMatch(/free-text/i);
      expect(message).toMatch(/do not grant execution permission|do NOT grant/i);
      expect(message).toMatch(/Safety Rule/);
    });
  });
});
