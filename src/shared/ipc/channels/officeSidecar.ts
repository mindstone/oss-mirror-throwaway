import { z } from 'zod';
import { defineInvokeChannel } from '../schemas/common';
import { OFFICE_SIDECAR_ERROR_CODES } from '@shared/sidecar/errorMessages';

export const OfficeSidecarErrorCodeSchema = z.enum(OFFICE_SIDECAR_ERROR_CODES);

export const OfficeSidecarSkipReasonSchema = z.enum([
  'kill-switch',
  'surface-not-desktop',
]);

export const SanitizedOfficeSidecarErrorSchema = z.object({
  code: OfficeSidecarErrorCodeSchema,
  message: z.string(),
  at: z.number().int().positive(),
}).strict();

export const OfficeSidecarStatusResponseSchema = z.object({
  running: z.boolean(),
  port: z.number().int().positive().nullable(),
  adopted: z.boolean(),
  skipReason: OfficeSidecarSkipReasonSchema.nullable(),
  lastError: SanitizedOfficeSidecarErrorSchema.nullable(),
  startedAt: z.number().int().positive().nullable(),
}).strict();

export const OfficeSidecarRetryStartResponseSchema = z.object({
  restarted: z.boolean(),
  port: z.number().int().positive().nullable(),
  adopted: z.boolean(),
  skipReason: OfficeSidecarSkipReasonSchema.nullable(),
  error: SanitizedOfficeSidecarErrorSchema.nullable(),
}).strict();

export type OfficeSidecarStatusResponse = z.infer<typeof OfficeSidecarStatusResponseSchema>;
export type OfficeSidecarRetryStartResponse = z.infer<typeof OfficeSidecarRetryStartResponseSchema>;
export type SanitizedOfficeSidecarError = z.infer<typeof SanitizedOfficeSidecarErrorSchema>;

export const officeSidecarChannels = {
  'office-sidecar:status': defineInvokeChannel({
    channel: 'office-sidecar:status',
    request: z.void(),
    response: OfficeSidecarStatusResponseSchema,
    description: 'Get the current Office sidecar runtime status.',
  }),
  'office-sidecar:retry-start': defineInvokeChannel({
    channel: 'office-sidecar:retry-start',
    request: z.void(),
    response: OfficeSidecarRetryStartResponseSchema,
    description: 'Retry starting the Office sidecar and return the sanitized result.',
  }),
} as const;
