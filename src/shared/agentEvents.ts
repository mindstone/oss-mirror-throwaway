/**
 * Shared agent routing/auth event contracts.
 */

import { z } from 'zod';

export const TURN_AUTH_LABELS = [
  'codex-subscription',
  'openrouter',
  'mindstone',
  'api-key',
  'oauth-token',
  'local',
  'profile-direct',
] as const;

export const TurnAuthLabelSchema = z.enum(TURN_AUTH_LABELS);

export type TurnAuthLabel = z.infer<typeof TurnAuthLabelSchema>;

export const AgentRoutePlanResolvedEventSchema = z.object({
  sessionId: z.string(),
  turnAuthLabel: TurnAuthLabelSchema,
  resolvedAt: z.number(),
  profileName: z.string().optional(),
});

export type AgentRoutePlanResolvedEvent = z.infer<typeof AgentRoutePlanResolvedEventSchema>;
