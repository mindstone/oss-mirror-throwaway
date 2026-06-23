import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

const SafetyPromptUpdaterSchema = z.enum(['user', 'system', 'migration']);

const SafetyPromptHistoryEntrySchema = z.object({
  prompt: z.string(),
  version: z.number(),
  updatedAt: z.number(),
  updatedBy: SafetyPromptUpdaterSchema,
});

const SafetyPromptResponseSchema = z.object({
  prompt: z.string(),
  version: z.number(),
  lastUpdatedAt: z.number(),
  lastUpdatedBy: SafetyPromptUpdaterSchema,
  history: z.array(SafetyPromptHistoryEntrySchema),
  migrationComplete: z.boolean(),
});

const PrincipleUpdateSchema = z.object({
  summary: z.string(),
  proposedPrinciple: z.string(),
  fullUpdatedPrompt: z.string(),
});

export const SAFETY_PROMPT_RULE_PERSISTED_CHANNEL = 'safety-prompt:rule-persisted';

export const SafetyPromptRulePersistedPayloadSchema = z.object({
  version: z.number(),
  lastUpdatedAt: z.number(),
  source: z.enum(['ui-picker', 'chat-intent', 'settings-editor', 'system', 'migration']),
  summary: z.string(),
  proposedPrinciple: z.string(),
});

export type SafetyPromptRulePersistedPayload = z.infer<
  typeof SafetyPromptRulePersistedPayloadSchema
>;

/**
 * F4-2 defense-in-depth: mirror the cloud-route cap for `toolInput` size.
 *
 * Matches `TOOL_INPUT_MAX_CHARS` in `src/core/safetyPromptLogic.ts` and the
 * cloud-route refinement in `cloud-service/src/routes/ipc.ts`. Refinements
 * are stripped from `z.input`/`z.infer` so adding this does not change any
 * consumer TypeScript signature. The hard security boundary remains the
 * cloud route; this contract documents the cap locally and any future
 * IPC runtime validator will pick it up automatically.
 */
const TOOL_INPUT_MAX_CHARS = 4_000;

const BlockedActionContextSchema = z
  .object({
    toolName: z.string(),
    toolInput: z.record(z.string(), z.unknown()),
    spaceDescription: z.string().optional(),
    sessionType: z.enum(['interactive', 'automation', 'role']).optional(),
    automationName: z.string().optional(),
    blockReason: z.string(),
  })
  .superRefine((ctx, issue) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(ctx.toolInput);
    } catch {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolInput'],
        message: 'toolInput is not serializable',
      });
      return;
    }
    if (serialized.length > TOOL_INPUT_MAX_CHARS) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolInput'],
        message: `toolInput exceeds ${TOOL_INPUT_MAX_CHARS} char cap (got ${serialized.length})`,
      });
    }
  });

export const safetyPromptChannels = {
  'safety-prompt:get': defineInvokeChannel({
    channel: 'safety-prompt:get',
    request: z.void(),
    response: SafetyPromptResponseSchema,
    description: 'Get the current Safety Prompt with version and history',
  }),

  'safety-prompt:update': defineInvokeChannel({
    channel: 'safety-prompt:update',
    request: z.object({
      prompt: z.string(),
      updatedBy: SafetyPromptUpdaterSchema.optional(),
    }),
    response: SafetyPromptResponseSchema,
    description: 'Update the Safety Prompt and clear evaluation cache',
  }),

  'safety-prompt:revert': defineInvokeChannel({
    channel: 'safety-prompt:revert',
    request: z.object({
      targetVersion: z.number(),
    }),
    response: SafetyPromptResponseSchema,
    description: 'Revert the Safety Prompt to a previous version',
  }),

  'safety-prompt:reset': defineInvokeChannel({
    channel: 'safety-prompt:reset',
    request: z.void(),
    response: SafetyPromptResponseSchema,
    description: 'Reset the Safety Prompt to defaults',
  }),

  'safety-prompt:generate-options': defineInvokeChannel({
    channel: 'safety-prompt:generate-options',
    request: BlockedActionContextSchema,
    response: z.object({
      options: z.array(z.object({
        label: z.string(),
        scope: z.enum(['trusted_tool', 'broad', 'specific']),
      })),
      error: z.string().optional(),
    }),
    description: 'Generate 3 principle scope options for a blocked action',
  }),

  'safety-prompt:apply-selection': defineInvokeChannel({
    channel: 'safety-prompt:apply-selection',
    request: z.object({
      blockedAction: BlockedActionContextSchema,
      selectedLabel: z.string(),
      scope: z.enum(['trusted_tool', 'broad', 'specific']),
    }),
    response: z.object({
      update: PrincipleUpdateSchema.nullable(),
      error: z.string().optional(),
    }),
    description: 'Apply a user-selected principle option to generate the actual Safety Prompt edit',
  }),

  'safety-prompt:generate-deny-options': defineInvokeChannel({
    channel: 'safety-prompt:generate-deny-options',
    request: BlockedActionContextSchema,
    response: z.object({
      options: z.array(z.object({
        label: z.string(),
        scope: z.enum(['trusted_tool', 'broad', 'specific']),
      })),
      error: z.string().optional(),
    }),
    description: 'Generate 3 deny/block principle scope options for a blocked action',
  }),

  'safety-prompt:apply-deny-selection': defineInvokeChannel({
    channel: 'safety-prompt:apply-deny-selection',
    request: z.object({
      blockedAction: BlockedActionContextSchema,
      selectedLabel: z.string(),
      scope: z.enum(['trusted_tool', 'broad', 'specific']),
    }),
    response: z.object({
      update: PrincipleUpdateSchema.nullable(),
      error: z.string().optional(),
    }),
    description: 'Apply a user-selected deny principle option to generate the actual Safety Prompt edit',
  }),
} as const;
