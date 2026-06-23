import { z } from 'zod';

/**
 * User Question Types
 *
 * Types for the Ask User Questions feature, where the agent
 * presents structured inline questions to the user in the
 * conversation transcript. Questions can be choice-based, free-text-only,
 * or hybrid via `requiresInput`.
 *
 * The agent calls the built-in `AskUserQuestion` tool, which is
 * intercepted by a PreToolUse hook (deny-and-retry pattern). The hook
 * persists the question batch, dispatches an event to the renderer,
 * and ends the turn. The renderer shows an inline question card; on
 * submit, answers flow back via IPC as a continuation message.
 */

export const QuestionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  /** When true, selecting this option reveals an inline text input for the user to provide data (e.g. an API key). */
  requiresInput: z.boolean().optional(),
  /** Placeholder text shown in the inline input when `requiresInput` is true. */
  inputPlaceholder: z.string().optional(),
  /** URL to open in the user's browser when this option is selected (e.g. a dashboard to retrieve an API key). */
  url: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/**
 * Optional semantic discriminator for a question's intent.
 *
 * `approval_clarification` marks a question as a pre-approval clarification
 * for display and analytics. The answer supplies
 * intent context only; it is not an approval object, approval subtype, or
 * execution permission. Sensitive actions must still return to the normal
 * approval surface. Generic questions omit this field.
 *
 * Stage 2 of `docs/plans/260518_reduce_approval_clarification_branch_scope.md`.
 */
export const QUESTION_PURPOSE_APPROVAL_CLARIFICATION = 'approval_clarification' as const;

export const UserQuestionPurposeSchema = z.literal(QUESTION_PURPOSE_APPROVAL_CLARIFICATION);
export type UserQuestionPurpose = z.infer<typeof UserQuestionPurposeSchema>;

export const UserQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string(),
  context: z.string().optional(),
  options: z.array(QuestionOptionSchema),
  multiSelect: z.boolean(),
  /**
   * Optional semantic purpose. When set to `approval_clarification`, this
   * question is a pre-approval clarification and the UI presents it as a
   * calmer question. The response path
   * still only resumes the conversation; it does not approve execution.
   * Generic questions omit this.
   *
   * The hook validates that all questions in a batch share the same purpose
   * (or none have a purpose) — mixed-purpose batches are rejected. See
   * `docs/plans/260518_reduce_approval_clarification_branch_scope.md` Stage 2.
   */
  purpose: UserQuestionPurposeSchema.optional(),
});
export type UserQuestion = z.infer<typeof UserQuestionSchema>;

export const UserQuestionBatchSchema = z.object({
  batchId: z.string(),
  toolUseId: z.string(),
  turnId: z.string(),
  sessionId: z.string(),
  questions: z.array(UserQuestionSchema),
  timestamp: z.number(),
});
export type UserQuestionBatch = z.infer<typeof UserQuestionBatchSchema>;

type ApprovalClarificationCandidate = {
  purpose?: UserQuestionPurpose;
  question?: string;
  header?: string;
  context?: string;
  options?: ReadonlyArray<{
    label?: string;
    description?: string;
    inputPlaceholder?: string;
  }>;
};

export const UserQuestionAnswerAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['image', 'document', 'extracted-pdf', 'office', 'textfile', 'binary']),
  mimeType: z.string().optional(),
});
export type UserQuestionAnswerAttachment = z.infer<typeof UserQuestionAnswerAttachmentSchema>;

export const UserQuestionAnswerSchema = z.object({
  questionId: z.string(),
  selectedOptionIds: z.array(z.string()),
  freeText: z.string().optional(),
  attachments: z.array(UserQuestionAnswerAttachmentSchema).optional(),
});
export type UserQuestionAnswer = z.infer<typeof UserQuestionAnswerSchema>;

export const UserQuestionBatchResponseSchema = z.object({
  batchId: z.string(),
  answers: z.array(UserQuestionAnswerSchema),
  timestamp: z.number(),
});
export type UserQuestionBatchResponse = z.infer<typeof UserQuestionBatchResponseSchema>;

function textIncludesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Narrow compatibility classifier for clarification questions created before
 * the model reliably set `purpose: "approval_clarification"`.
 */
export function inferApprovalClarificationPurpose(
  question: ApprovalClarificationCandidate,
): UserQuestionPurpose | undefined {
  if (question.purpose === QUESTION_PURPOSE_APPROVAL_CLARIFICATION) {
    return QUESTION_PURPOSE_APPROVAL_CLARIFICATION;
  }

  const combinedText = [
    question.question,
    question.header,
    question.context,
    ...(question.options ?? []).flatMap((option) => [
      option.label,
      option.description,
      option.inputPlaceholder,
    ]),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();

  const hasApprovalBoundaryLanguage = textIncludesAny(combinedText, [
    /\bnot approval\b/,
    /\bnot permission\b/,
    /\bnot approve\b/,
    /\bbefore any send\b/,
    /\bbefore sending\b/,
    /\bafter draft approval\b/,
    /\bsafety rules\b/,
  ]);

  const mentionsSensitiveAction = textIncludesAny(combinedText, [
    /\bsend(?:ing)?\b/,
    /\bpost(?:ing)?\b/,
    /\bemail\b/,
    /\bslack\b/,
    /\bdm\b/,
    /\bmessage\b/,
    /\bschedul(?:e|ing)\b/,
    /\bpay(?:ing|ment)?\b/,
    /\bdelet(?:e|ing)\b/,
    /\bmodif(?:y|ying)\b/,
  ]);

  return hasApprovalBoundaryLanguage && mentionsSensitiveAction
    ? QUESTION_PURPOSE_APPROVAL_CLARIFICATION
    : undefined;
}

function normalizedOptionLabels(
  question: ApprovalClarificationCandidate,
): Set<string> {
  return new Set(
    (question.options ?? [])
      .map((option) => option.label?.trim().toLowerCase())
      .filter((label): label is string => !!label),
  );
}

/**
 * Detects approval/confirmation decisions that must not be rendered as
 * AskUserQuestion cards. These belong in the normal action-tool path so Safety
 * Rules can stage or drawer-review the operation.
 */
export function isChatApprovalQuestionBatch(
  batch: { questions: ReadonlyArray<ApprovalClarificationCandidate> },
): boolean {
  if (batch.questions.length === 0) return false;

  return batch.questions.some((question) => {
    const labels = normalizedOptionLabels(question);
    const header = question.header?.trim().toLowerCase() ?? '';
    const prompt = question.question?.trim().toLowerCase() ?? '';
    const hasApprovalHeader = /^(approve|confirm|send)$/.test(header);
    const asksForSensitiveAction = /^(send|post|email|schedule|pay|delete|modify)\b/.test(prompt);
    const hasCommitOption =
      labels.has('send') ||
      labels.has('approve') ||
      labels.has('confirm') ||
      labels.has('go ahead');
    const hasCancelOption = labels.has('cancel') || labels.has('do not send');
    const hasEditOption = labels.has('edit') || labels.has('change');

    return (
      (hasApprovalHeader || asksForSensitiveAction) &&
      hasCommitOption &&
      (hasCancelOption || hasEditOption)
    );
  });
}

/**
 * Returns `true` when every question in a batch carries the
 * `approval_clarification` purpose. The hook rejects mixed-purpose
 * batches before they reach this helper, so a single positive purpose
 * means the whole batch is approval-context.
 *
 * Used by UI/response code to scope display and analytics
 * without scattering literal string comparisons.
 */
export function isApprovalClarificationBatch(
  batch: { questions: ReadonlyArray<ApprovalClarificationCandidate> },
): boolean {
  if (batch.questions.length === 0) return false;
  return batch.questions.every(
    (question) => inferApprovalClarificationPurpose(question) === QUESTION_PURPOSE_APPROVAL_CLARIFICATION,
  );
}
