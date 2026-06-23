import { z } from 'zod';

export const SlackOAuthStartResponseSchema = z.object({
  authUrl: z.string().url(),
  state: z.string().min(1),
});

export const SlackWorkspaceResponseSchema = z.object({
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  status: z.enum(['connected', 'needs_reconnect', 'disconnected', 'disconnecting']),
  peerInstanceCount: z.number().int().nonnegative().optional(),
  lastSeenAt: z.string().nullable(),
});

export const SlackWorkspaceNullableResponseSchema = SlackWorkspaceResponseSchema.nullable();
