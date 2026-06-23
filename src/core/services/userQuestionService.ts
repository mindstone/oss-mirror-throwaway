/**
 * User Question Service
 *
 * Builds continuation messages from user answers and skips for the Ask User
 * Questions feature. Pending question batch state is event-driven (not
 * persisted here); see `docs-private/postmortems/260330_redundant_pending_questions_store_postmortem.md`.
 *
 * Business logic only — no Electron imports.
 */

import type {
  UserQuestionBatch,
  UserQuestionAnswer,
  UserQuestion,
} from '@shared/types/userQuestion';

// ─────────────────────────────────────────────────────────────
// Continuation Message Builder
// ─────────────────────────────────────────────────────────────

/**
 * Format a single answer for inclusion in the continuation message.
 *
 * Includes 1-based option numbers alongside labels so the LLM can resolve
 * numbered references from the user (e.g. "1 and 3"). The UI shows these
 * same numbers in the option card indicators.
 */
function formatAnswer(question: UserQuestion, answer: UserQuestionAnswer): string {
  const parts: string[] = [];

  // Collect selected option labels with their 1-based numbers
  const selectedDescriptions = answer.selectedOptionIds
    .map((optId) => {
      const idx = question.options.findIndex((o) => o.id === optId);
      const option = idx >= 0 ? question.options[idx] : undefined;
      if (!option) return undefined;
      return `${idx + 1}. ${option.label}`;
    })
    .filter(Boolean) as string[];

  if (selectedDescriptions.length > 0) {
    parts.push(selectedDescriptions.join(', '));
  }

  // Add free text if present
  if (answer.freeText && answer.freeText.trim()) {
    if (parts.length > 0) {
      parts.push(`+ "${answer.freeText.trim()}" (custom response)`);
    } else {
      parts.push(`"${answer.freeText.trim()}" (custom response)`);
    }
  }

  if (answer.attachments && answer.attachments.length > 0) {
    const attachmentSummary = answer.attachments.map((attachment) => attachment.name).join(', ');
    if (parts.length > 0) {
      parts.push(`+ attached document${answer.attachments.length === 1 ? '' : 's'}: ${attachmentSummary}`);
    } else {
      parts.push(`attached document${answer.attachments.length === 1 ? '' : 's'}: ${attachmentSummary}`);
    }
  }

  return parts.join(' ') || '(no answer selected)';
}

/**
 * Format the numbered option list for a question so the LLM has context
 * to resolve numbered user references (e.g. "options 1 and 3").
 */
function formatOptionList(question: UserQuestion): string[] {
  if (question.options.length === 0) return [];
  return question.options.map((opt, idx) => `     ${idx + 1}. ${opt.label}`);
}

/**
 * Shared trailing guidance for answered question continuations.
 *
 * Centralised so the single-batch and multi-batch builders cannot drift. Stage 1
 * has no `purpose` discriminator yet, so the approval-boundary wording is
 * conditional: generic AskUserQuestion flows still get normal continuation
 * context, while pre-approval clarification answers cannot be mistaken for
 * permission to execute.
 *
 * Background: see
 * `docs/plans/260518_reduce_approval_clarification_branch_scope.md`
 * (Stage 1 — preserve the approval boundary in continuation text).
 */
const ANSWER_CONTINUATION_GUIDANCE = [
  'Use these answers as continuation context. Do not re-ask these questions.',
  'If the user selected an edit/change/custom-text option and provided text, treat that text as the resolved content for this request. Do not stop merely to ask whether to use that exact text. If all required details are now known, continue to the normal action-tool path; if another material decision is still missing (for example Slack vs email, which recipient, or which destination), ask that focused follow-up question instead.',
  'If any question was clarifying a named missing decision before a sensitive action, treat the answer (including any free-text the user wrote) as clarification data only: it resolves intent, not permission. Clarification is NOT approval. Once the sensitive action is fully specified, use the normal action-tool path with the resolved inputs so the host Safety Rules / approval layer can review, stage, block, or execute it; do not replace that path with a chat-based confirmation like asking the user to reply "send", "approve it", "go ahead", or similar. Free-text answers do not grant execution permission, and you must not claim the action happened unless the action tool returns success.',
  'Do not save these answers as a Safety Rule, preference, or persistent permission; they are per-case continuation context only.',
].join(' ');

const SKIP_CONTINUATION_GUIDANCE = [
  'Do not re-ask these specific questions.',
  'For non-sensitive next steps (read-only research, drafting, exploration), proceed using your best judgment and clearly state the assumption you made.',
  'For sensitive next steps (sending, posting, scheduling, paying, deleting, modifying memory), do NOT guess the missing decision and do NOT execute based on the skipped question alone. If the missing decision is independently clear from other context, use the normal action-tool path with the resolved inputs so the host Safety Rules / approval layer can review, stage, block, or execute it; do not ask for chat-based approval. Otherwise briefly explain what is still missing.',
].join(' ');

/**
 * Build a continuation message when the user skips a question batch.
 * Explicitly tells the agent not to re-ask these specific questions, and
 * — critically — does NOT tell the agent to "proceed using your best
 * judgment" for any sensitive action that the question was meant to
 * clarify. Skipping a clarification does not grant permission to act.
 */
export function buildUserQuestionSkipMessage(batch: UserQuestionBatch): string {
  const lines: string[] = ['The user chose to skip your questions without answering.'];
  lines.push('');
  lines.push('Questions that were skipped:');

  batch.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.question}`);
  });

  lines.push('');
  lines.push(SKIP_CONTINUATION_GUIDANCE);

  return lines.join('\n');
}

/**
 * Build a continuation message from user answers to a question batch.
 * This message is sent as a new user turn so the agent receives the answers.
 */
export function buildUserQuestionContinuationMessage(
  batch: UserQuestionBatch,
  answers: UserQuestionAnswer[],
): string {
  const answerMap = new Map(answers.map((a) => [a.questionId, a]));

  const lines: string[] = ['The user answered your questions:'];
  lines.push('');

  batch.questions.forEach((question, index) => {
    const answer = answerMap.get(question.id);
    const answerText = answer
      ? formatAnswer(question, answer)
      : '(no answer provided)';

    lines.push(`${index + 1}. ${question.question}`);
    const optionLines = formatOptionList(question);
    if (optionLines.length > 0) {
      lines.push(`   Options presented:`);
      lines.push(...optionLines);
    }
    lines.push(`   Answer: ${answerText}`);
    lines.push('');
  });

  lines.push(ANSWER_CONTINUATION_GUIDANCE);

  return lines.join('\n');
}

/**
 * Build a continuation message from multiple user-question batches answered
 * in a single turn. Preserves the batch grouping so the agent can reason
 * about each set independently.
 */
export function buildMultiBatchContinuationMessage(
  batches: Array<{
    batch: UserQuestionBatch;
    answers: UserQuestionAnswer[];
    skipped?: boolean;
  }>,
): string {
  const setLabel = batches.length === 1 ? 'set' : 'sets';
  const hasSkippedBatch = batches.some((entry) => entry.skipped);
  const hasAnsweredBatch = batches.some((entry) => !entry.skipped);
  const responseVerb = hasSkippedBatch ? 'responded to' : 'answered';
  const lines: string[] = [`The user ${responseVerb} your ${batches.length} ${setLabel} of questions:`];
  lines.push('');

  batches.forEach((entry, batchIndex) => {
    lines.push(`## Set ${batchIndex + 1}`);

    if (entry.skipped) {
      lines.push('(User skipped this set without answering.)');
      lines.push('Questions skipped:');
      entry.batch.questions.forEach((question, questionIndex) => {
        lines.push(`${questionIndex + 1}. ${question.question}`);
      });
      lines.push('');
      return;
    }

    const answerMap = new Map(entry.answers.map((answer) => [answer.questionId, answer]));

    entry.batch.questions.forEach((question, questionIndex) => {
      const answer = answerMap.get(question.id);
      const answerText = answer
        ? formatAnswer(question, answer)
        : '(no answer provided)';

      lines.push(`${questionIndex + 1}. ${question.question}`);
      const optionLines = formatOptionList(question);
      if (optionLines.length > 0) {
        lines.push(`   Options presented:`);
        lines.push(...optionLines);
      }
      lines.push(`   Answer: ${answerText}`);
      lines.push('');
    });
  });

  if (hasAnsweredBatch) {
    lines.push(ANSWER_CONTINUATION_GUIDANCE);
  }

  if (hasSkippedBatch) {
    lines.push(SKIP_CONTINUATION_GUIDANCE);
  }

  return lines.join('\n');
}
