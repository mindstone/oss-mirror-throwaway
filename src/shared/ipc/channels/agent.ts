import { z } from 'zod';
import {
  defineInvokeChannel,
  AgentTurnRequestSchema,
  AnyAttachmentPayloadSchema,
  ContinuationContextHandoffSchema,
} from '../schemas';
import { UserQuestionAnswerSchema, UserQuestionSchema } from '../../types';

/** Tool safety approval response from renderer */
export const ToolSafetyApprovalResponseSchema = z.object({
  toolUseID: z.string(),
  approved: z.boolean(),
  input: z.record(z.string(), z.unknown()),
});

/** Result of loading a single cached attachment */
export const LoadCacheResultSchema = z.object({
  id: z.string(),
  success: z.boolean(),
  payload: AnyAttachmentPayloadSchema.optional(),
  error: z.string().optional(),
});

/** Request schema for done-safety evaluation */
export const DoneSafetyRequestSchema = z.object({
  lastUserMessage: z.string(),
  responseText: z.string(),
});

/** Response schema for done-safety evaluation */
export const DoneSafetyResponseSchema = z.object({
  safeToMarkDone: z.boolean(),
  reason: z.string(),
});

export const agentChannels = {
  'agent:turn': defineInvokeChannel({
    channel: 'agent:turn',
    request: AgentTurnRequestSchema,
    response: z.object({
      turnId: z.string(),
    }),
    description: 'Start an agent turn with a prompt',
  }),

  'agent:stop-turn': defineInvokeChannel({
    channel: 'agent:stop-turn',
    request: z.string(),
    response: z.object({
      success: z.boolean(),
      reason: z.string().optional(),
    }),
    description: 'Stop an active agent turn',
  }),

  'agent:generate-summary': defineInvokeChannel({
    channel: 'agent:generate-summary',
    request: z.object({
      messages: z.array(z.object({
        role: z.enum(['user', 'assistant', 'result']),
        text: z.string(),
      })),
      largeToolNames: z.array(z.string()).optional(),
    }),
    response: z.object({
      summary: z.string().nullable(),
      error: z.string().optional(),
    }),
    description: 'Generate a summary of conversation for context compaction',
  }),

  'agent:generate-intelligent-summary': defineInvokeChannel({
    channel: 'agent:generate-intelligent-summary',
    request: z.object({
      // turnId is optional over IPC — the handler synthesizes a fallback ('summary-turn')
      // when absent. AgentTurnMessage requires turnId internally, but renderer callers
      // may not always have it available.
      messages: z.array(z.object({
        role: z.enum(['user', 'assistant', 'result']),
        text: z.string(),
        turnId: z.string().optional(),
      })),
      originalPrompt: z.string(),
      depth: z.number(),
    }),
    response: z.object({
      summary: z.string().nullable(),
      enhancedPrompt: z.string().nullable(),
      error: z.string().optional(),
    }),
    description: 'Generate an intelligent summary with sliding window and BTS compression for context compaction',
  }),

  'agent:tool-safety-response': defineInvokeChannel({
    channel: 'agent:tool-safety-response',
    request: ToolSafetyApprovalResponseSchema,
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Send tool approval response from user (continue/allow for session/deny)',
  }),

  'agent:cache-attachments': defineInvokeChannel({
    channel: 'agent:cache-attachments',
    request: z.object({
      attachments: z.array(AnyAttachmentPayloadSchema),
    }),
    response: z.object({
      cacheIds: z.array(z.string()),
    }),
    description: 'Cache attachments to disk for network reconnect resume',
  }),

  'agent:load-cached-attachments': defineInvokeChannel({
    channel: 'agent:load-cached-attachments',
    request: z.object({
      cacheIds: z.array(z.string()),
    }),
    response: z.object({
      results: z.array(LoadCacheResultSchema),
    }),
    description: 'Load cached attachments from disk by their cache IDs',
  }),

  'agent:delete-cached-attachments': defineInvokeChannel({
    channel: 'agent:delete-cached-attachments',
    request: z.object({
      cacheIds: z.array(z.string()),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Delete cached attachment files by their cache IDs',
  }),

  'agent:evaluate-done-safety': defineInvokeChannel({
    channel: 'agent:evaluate-done-safety',
    request: DoneSafetyRequestSchema,
    response: DoneSafetyResponseSchema,
    description: 'Evaluate if a conversation is safe to auto-mark-done after turn completion',
  }),

  'agent:warm-cache': defineInvokeChannel({
    channel: 'agent:warm-cache',
    request: z.object({}),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Warm the Anthropic prompt cache with a minimal API call for faster first response',
  }),
  'agent:user-question-response': defineInvokeChannel({
    channel: 'agent:user-question-response',
    request: z.object({
      batchId: z.string(),
      answers: z.array(UserQuestionAnswerSchema),
      skipped: z.boolean().optional(),
      sessionId: z.string(),
      turnId: z.string(),
      toolUseId: z.string(),
      questions: z.array(UserQuestionSchema),
      queuedBatches: z.array(z.object({
        batchId: z.string(),
        answers: z.array(UserQuestionAnswerSchema),
        skipped: z.boolean().optional(),
        questions: z.array(UserQuestionSchema),
      })).optional(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
      continuationMessage: z.string().optional(),
      /**
       * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`
       * (F3): when the handler injected `<prior_turns>` +
       * `<conversation_history>` into `continuationMessage`, the renderer
       * threads this back into the next `agent:turn` so the proactive
       * prepend in `agentTurnExecute` skips its own injection.
       */
      continuationContext: ContinuationContextHandoffSchema.optional(),
    }),
    description: 'Send user answers to a question batch from the AskUserQuestion tool',
  }),
} as const;
