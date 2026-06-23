import { z } from 'zod';
import { defineInvokeChannel, SafeModeErrorCategorySchema } from '../schemas';

// Re-export for convenience
export { SafeModeErrorCategorySchema };

// Error recovery status enum
export const ErrorRecoveryStatusSchema = z.enum([
  'idle',
  'evaluating',
  'can_help',
  'cannot_help',
  'evaluation_failed',
]);
export type ErrorRecoveryStatus = z.infer<typeof ErrorRecoveryStatusSchema>;

// Confidence level for evaluation
export const EvaluationConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type EvaluationConfidence = z.infer<typeof EvaluationConfidenceSchema>;

// Context passed to fix conversation
export const ErrorRecoveryContextSchema = z.object({
  filesExamined: z.array(z.string()),
  relevantExcerpts: z.record(z.string(), z.string()),
  healthCheckSummary: z.string().optional(),
  diagnosticInfo: z.string().optional(),
});
export type ErrorRecoveryContext = z.infer<typeof ErrorRecoveryContextSchema>;

// Full evaluation result
export const ErrorRecoveryEvaluationSchema = z.object({
  status: ErrorRecoveryStatusSchema,
  canHelp: z.boolean(),
  confidence: EvaluationConfidenceSchema,
  summary: z.string(),
  suggestedAction: z.string().optional(),
  contextForConversation: ErrorRecoveryContextSchema,
  evaluationDurationMs: z.number().optional(),
  error: z.string().optional(),
});
export type ErrorRecoveryEvaluation = z.infer<typeof ErrorRecoveryEvaluationSchema>;

// Service state (for subscription)
export const ErrorRecoveryStateSchema = z.object({
  evaluationId: z.string().nullable(),
  status: ErrorRecoveryStatusSchema,
  errorCategory: SafeModeErrorCategorySchema.nullable(),
  evaluation: ErrorRecoveryEvaluationSchema.nullable(),
  startedAt: z.number().nullable(),
  quipIndex: z.number(),
});
export type ErrorRecoveryState = z.infer<typeof ErrorRecoveryStateSchema>;

// Request to start evaluation
export const ErrorRecoveryRequestSchema = z.object({
  errorCategory: SafeModeErrorCategorySchema,
  errorMessage: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorRecoveryRequest = z.infer<typeof ErrorRecoveryRequestSchema>;

export const errorRecoveryChannels = {
  'error-recovery:evaluate': defineInvokeChannel({
    channel: 'error-recovery:evaluate',
    request: ErrorRecoveryRequestSchema,
    response: ErrorRecoveryEvaluationSchema,
    description: 'Start error evaluation to determine if Rebel can help fix an error',
  }),

  'error-recovery:get-state': defineInvokeChannel({
    channel: 'error-recovery:get-state',
    request: z.void(),
    response: ErrorRecoveryStateSchema,
    description: 'Get current error recovery evaluation state',
  }),

  'error-recovery:dismiss': defineInvokeChannel({
    channel: 'error-recovery:dismiss',
    request: z.void(),
    response: z.object({ success: z.boolean() }),
    description: 'Dismiss current error evaluation and reset state',
  }),

  'error-recovery:get-fix-prompt': defineInvokeChannel({
    channel: 'error-recovery:get-fix-prompt',
    request: z.void(),
    response: z.object({
      prompt: z.string().nullable(),
      errorCategory: SafeModeErrorCategorySchema.nullable(),
    }),
    description: 'Get the pre-populated prompt for "Let Rebel fix it" conversation',
  }),
} as const;
