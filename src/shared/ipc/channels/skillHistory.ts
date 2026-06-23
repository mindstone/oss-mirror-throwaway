import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

const SkillHistoryVersionSummarySchema = z.object({
  snapshotId: z.string(),
  filename: z.string(),
  timestampMs: z.number(),
  contentHash: z.string(),
  summary: z.string(),
  actorKind: z.enum(['human', 'agent']),
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  actorEmail: z.string().nullable(),
  skillWorkspacePath: z.string(),
  restoredFromSnapshotId: z.string().nullable(),
});

const SkillHistorySnapshotPayloadSchema = z.object({
  snapshotId: z.string(),
  timestampMs: z.number(),
  contentHash: z.string(),
  summary: z.string(),
  actorKind: z.enum(['human', 'agent']),
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  actorEmail: z.string().nullable(),
  skillWorkspacePath: z.string(),
  body: z.string(),
  restoredFromSnapshotId: z.string().nullable(),
  restoredFromSkillPath: z.string().nullable(),
});

export const skillHistoryChannels = {
  'skill-history:get-versions': defineInvokeChannel({
    channel: 'skill-history:get-versions',
    request: z.object({ skillWorkspacePath: z.string() }),
    response: z.discriminatedUnion('success', [
      z.object({ success: z.literal(true), versions: z.array(SkillHistoryVersionSummarySchema) }),
      z.object({ success: z.literal(false), error: z.string() }),
    ]),
    description: 'List collaboration-scoped snapshot versions for a shared skill',
  }),

  'skill-history:get-snapshot': defineInvokeChannel({
    channel: 'skill-history:get-snapshot',
    request: z.object({
      skillWorkspacePath: z.string(),
      snapshotId: z.string(),
    }),
    response: z.discriminatedUnion('success', [
      z.object({ success: z.literal(true), snapshot: SkillHistorySnapshotPayloadSchema }),
      z.object({ success: z.literal(false), error: z.string() }),
    ]),
    description: 'Load a single shared skill history snapshot (metadata + prior file body)',
  }),

  'skill-history:restore': defineInvokeChannel({
    channel: 'skill-history:restore',
    request: z.object({
      skillWorkspacePath: z.string(),
      snapshotId: z.string(),
    }),
    response: z.discriminatedUnion('success', [
      z.object({
        success: z.literal(true),
        path: z.string(),
        currentHash: z.string(),
        updatedAt: z.number(),
      }),
      z.object({
        success: z.literal(false),
        error: z.string(),
        conflict: z.boolean().optional(),
        currentHash: z.string().optional(),
      }),
    ]),
    description: 'Restore a shared skill to a snapshot (creates a new current version + history entry)',
  }),

  'skill-history:fork': defineInvokeChannel({
    channel: 'skill-history:fork',
    request: z.object({
      skillWorkspacePath: z.string(),
      snapshotId: z.string(),
      forkName: z.string().optional(),
    }),
    response: z.discriminatedUnion('success', [
      z.object({
        success: z.literal(true),
        forkPath: z.string(),
        forkWorkspaceRelative: z.string(),
      }),
      z.object({ success: z.literal(false), error: z.string() }),
    ]),
    description: 'Save a snapshot version as a new skill in your Library',
  }),
} as const;
