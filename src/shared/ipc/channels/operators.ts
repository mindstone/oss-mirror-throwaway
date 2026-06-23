import { z } from 'zod';
import { OPERATOR_ACTIVATION_ERROR_CODES, OperatorConsultToolInputSchema } from '@shared/types/operators';
import { defineInvokeChannel } from '../schemas';

const OperatorRoleSchema = z.enum(['operator', 'live_meeting']);

const OperatorSlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/u, 'operator slug must be a kebab-case identifier');

export const OperatorMetadataSchema = z.object({
  id: z.string(),
  operatorSlug: z.string(),
  spacePath: z.string(),
  sourceSpacePath: z.string(),
  category: z.enum(['bundled', 'space']),
  name: z.string(),
  description: z.string(),
  consult_when: z.string(),
  kind: z.literal('operator'),
  roles: z.array(OperatorRoleSchema).min(1),
  proactiveIntervalMinutes: z.number().int().positive().optional(),
  useCases: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  operatorFileAbsolutePath: z.string(),
  groundingPath: z.string(),
  diaryPath: z.string(),
  warnings: z.array(z.string()).optional(),
});
export type OperatorMetadata = z.infer<typeof OperatorMetadataSchema>;

export const OperatorListFailureSchema = z.object({
  spacePath: z.string(),
  operatorSlug: z.string(),
  operatorFileAbsolutePath: z.string(),
  errorCode: z.string(),
  message: z.string(),
});
export type OperatorListFailure = z.infer<typeof OperatorListFailureSchema>;

export const OperatorDiaryResponseSchema = z.object({
  operatorId: z.string(),
  diary: z.string(),
});
export type OperatorDiaryResponse = z.infer<typeof OperatorDiaryResponseSchema>;

const OperatorConsultErrorResultSchema = z.object({
  isError: z.literal(true),
  errorCode: z.string(),
  message: z.string(),
  reason: z.enum(['rate_limited', 'malformed_response', 'auth_failed', 'network', 'invalid_request', 'unknown']).optional(),
  operatorId: z.string().optional(),
  operatorName: z.string().optional(),
  availableIds: z.array(z.string()).optional(),
});

const OperatorConsultNeedsCalibrationResultSchema = z.object({
  isError: z.literal(false),
  calibrated: z.literal(false),
  errorCode: z.null(),
  operatorId: z.string(),
  operatorName: z.string(),
  message: z.string(),
});

const OperatorConsultSuccessResultSchema = z.object({
  isError: z.literal(false),
  calibrated: z.literal(true),
  errorCode: z.null(),
  operatorId: z.string(),
  operatorName: z.string(),
  perspective: z.string(),
  evidenceCited: z.array(z.string()),
  confidence: z.number(),
  diaryAppendFailed: z.boolean(),
  message: z.string().optional(),
  response: z.string().optional(),
});

export const OperatorConsultResultSchema = z.union([
  OperatorConsultErrorResultSchema,
  z.discriminatedUnion('calibrated', [
    OperatorConsultNeedsCalibrationResultSchema,
    OperatorConsultSuccessResultSchema,
  ]),
]);
export type OperatorConsultResultPayload = z.infer<typeof OperatorConsultResultSchema>;

const OperatorStubMutationResponseSchema = z.object({
  success: z.boolean(),
  errorCode: z.string().optional(),
});

export const OperatorActivationResponseSchema = z.object({
  success: z.boolean(),
  errorCode: z.enum(OPERATOR_ACTIVATION_ERROR_CODES).optional(),
  activatedPath: z.string().optional(),
  orphanPath: z.string().optional(),
  existingOperatorPath: z.string().optional(),
});
export type OperatorActivationResponse = z.infer<typeof OperatorActivationResponseSchema>;

const OperatorRemoveFailureCodeSchema = z.enum([
  'operator_not_found',
  'space_not_found',
  'delete_failed',
]);

export const OperatorRemoveResponseSchema = z.union([
  z.object({
    success: z.literal(true),
  }),
  z.object({
    success: z.literal(false),
    errorCode: OperatorRemoveFailureCodeSchema,
  }),
]);
export type OperatorRemoveResponse = z.infer<typeof OperatorRemoveResponseSchema>;

const OperatorSetDisplayNameFailureCodeSchema = z.enum([
  'operator_not_found',
  'display_name_too_long',
  'write_failed',
]);

export const OperatorSetDisplayNameResponseSchema = z.union([
  z.object({
    success: z.literal(true),
  }),
  z.object({
    success: z.literal(false),
    errorCode: OperatorSetDisplayNameFailureCodeSchema,
  }),
]);
export type OperatorSetDisplayNameResponse = z.infer<typeof OperatorSetDisplayNameResponseSchema>;

const OperatorSetLiveMeetingEnabledFailureCodeSchema = z.enum([
  'operator_not_found',
  'live_prompt_missing',
  'roles_would_be_empty',
  'write_failed',
]);

export const OperatorSetLiveMeetingEnabledResponseSchema = z.union([
  z.object({
    success: z.literal(true),
  }),
  z.object({
    success: z.literal(false),
    errorCode: OperatorSetLiveMeetingEnabledFailureCodeSchema,
  }),
]);
export type OperatorSetLiveMeetingEnabledResponse = z.infer<typeof OperatorSetLiveMeetingEnabledResponseSchema>;

const OperatorDuplicateFailureCodeSchema = z.enum([
  'source_not_found',
  'display_name_too_long',
  'slug_collision_unresolvable',
  'copy_failed',
]);

export const OperatorDuplicateResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    newSlug: z.string().min(1),
  }),
  z.object({
    success: z.literal(false),
    errorCode: OperatorDuplicateFailureCodeSchema,
  }),
]);
export type OperatorDuplicateResponse = z.infer<typeof OperatorDuplicateResponseSchema>;

const OperatorStartPersonalisationFailureCodeSchema = z.enum([
  'operator_not_found',
  'broadcast_failed',
]);

export const OperatorStartPersonalisationResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    sessionId: z.string().min(1),
  }),
  z.object({
    success: z.literal(false),
    errorCode: OperatorStartPersonalisationFailureCodeSchema,
  }),
]);
export type OperatorStartPersonalisationResponse = z.infer<typeof OperatorStartPersonalisationResponseSchema>;

export const operatorsChannels = {
  'operators:list': defineInvokeChannel({
    channel: 'operators:list',
    request: z.object({
      spacePaths: z.array(z.string()).default([]),
      roleFilter: OperatorRoleSchema.optional(),
    }),
    response: z.object({
      operators: z.array(OperatorMetadataSchema),
      failures: z.array(OperatorListFailureSchema).default([]),
    }),
    description: 'List Operator metadata + diagnostics for the requested Space set.',
  }),
  'operators:get-diary': defineInvokeChannel({
    channel: 'operators:get-diary',
    request: z.object({
      operatorId: z.string().min(1),
    }),
    response: OperatorDiaryResponseSchema,
    description: 'Read diary.md for one Operator.',
  }),
  'operators:activate': defineInvokeChannel({
    channel: 'operators:activate',
    request: z.object({
      operatorSlug: z.string().min(1),
      sourceSpacePath: z.string().min(1),
      targetSpacePath: z.string().min(1),
    }),
    response: OperatorActivationResponseSchema,
    description: 'Activate a bundled Operator for a target user Space by copying OPERATOR.md.',
  }),
  'operators:remove': defineInvokeChannel({
    channel: 'operators:remove',
    request: z.object({
      operatorSlug: z.string().min(1),
      targetSpacePath: z.string().min(1),
    }),
    response: OperatorRemoveResponseSchema,
    description: 'Remove an activated Operator from a Space. The diary file is preserved.',
  }),
  'operators:setDisplayName': defineInvokeChannel({
    channel: 'operators:setDisplayName',
    request: z.object({
      operatorSlug: z.string().min(1),
      targetSpacePath: z.string().min(1),
      displayName: z.string().nullable(),
    }),
    response: OperatorSetDisplayNameResponseSchema,
    description: 'Update or clear an activated Operator display_name field in OPERATOR.md frontmatter.',
  }),
  'operators:duplicate': defineInvokeChannel({
    channel: 'operators:duplicate',
    request: z.object({
      sourceSlug: z.string().min(1),
      sourceSpacePath: z.string().min(1),
      newDisplayName: z.string().min(1).max(120),
    }),
    response: OperatorDuplicateResponseSchema,
    description: 'Duplicate an activated Operator into a new slug under the same Space, copying OPERATOR.md and rewriting display_name.',
  }),
  'operators:setLiveMeetingEnabled': defineInvokeChannel({
    channel: 'operators:setLiveMeetingEnabled',
    request: z.object({
      operatorSlug: OperatorSlugSchema,
      targetSpacePath: z.string().min(1),
      enabled: z.boolean(),
    }),
    response: OperatorSetLiveMeetingEnabledResponseSchema,
    description: 'Enable or disable the live_meeting role for an activated Operator by updating OPERATOR.md frontmatter.',
  }),
  'operators:toggle-enabled': defineInvokeChannel({
    channel: 'operators:toggle-enabled',
    request: z.object({
      operatorId: z.string().min(1),
      enabled: z.boolean(),
    }),
    response: OperatorStubMutationResponseSchema,
    description: 'Toggle an Operator. Stubbed until Stage 5B.',
  }),
  'operators:test-consult': defineInvokeChannel({
    channel: 'operators:test-consult',
    request: OperatorConsultToolInputSchema,
    response: OperatorConsultResultSchema,
    description: 'Ask one Operator from the Operators panel preview.',
  }),
  'operators:startPersonalisation': defineInvokeChannel({
    channel: 'operators:startPersonalisation',
    request: z.object({
      operatorSlug: z.string().min(1),
      targetSpacePath: z.string().min(1),
    }),
    response: OperatorStartPersonalisationResponseSchema,
    description: 'Start a personalisation agent run for one Operator. Validates the Operator exists, then emits a `conversations:start-requested` broadcast for the renderer to create the session.',
  }),
} as const;
