import { z } from 'zod';
import { FileLocationSchema } from '../fileLocation';
import { BlockSourceSchema, ToolBlockSourceSchema } from './blockSource';

/**
 * Live approval/staging broadcast DTO schemas.
 *
 * These model renderer/cloud broadcast payloads, not the durable invoke/store
 * schemas in `src/shared/ipc/channels/*`. S6.2 will derive consumer types and
 * type producer emits from this SSOT.
 */

const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
const SharingSchema = z.enum(['private', 'restricted', 'company-wide', 'public']);
const ApprovalKindSchema = z.enum(['memory_write', 'shared_skill_checkpoint']);
const StagedToolCallStatusSchema = z.enum([
  'pending',
  'executing',
  'executed',
  'failed',
  'rejected',
  'expired',
]);

const MemoryApprovalDestinationBroadcastSchema = z.object({
  path: z.string(),
  spaceName: z.string(),
  spacePath: z.string().optional(),
  location: FileLocationSchema.optional(),
  sharing: SharingSchema.optional(),
  isNew: z.boolean(),
});

const StagedCallResultBroadcastSchema = z.object({
  success: z.boolean(),
  content: z.string().optional(),
  error: z.string().optional(),
  executedAt: z.number(),
});

export const ToolSafetyApprovalRequestBroadcastSchema = z.object({
  toolUseID: z.string(),
  turnId: z.string(),
  sessionId: z.string().optional(),
  toolName: z.string(),
  // Carries sensitive tool arguments. Parse-error logs must not echo it.
  input: z.record(z.string(), z.unknown()),
  reason: z.string().optional(),
  timestamp: z.number(),
  allowPermanentTrust: z.boolean().optional(),
  effectiveToolId: z.string().optional(),
  riskLevel: RiskLevelSchema.optional(),
  packageName: z.string().optional(),
  conversationTitle: z.string().optional(),
  blockedBy: ToolBlockSourceSchema.optional(),
});
export type ToolSafetyApprovalRequestBroadcast = z.infer<typeof ToolSafetyApprovalRequestBroadcastSchema>;

export const ToolSafetyApprovalResolvedBroadcastSchema = z.object({
  toolUseID: z.string(),
  sessionId: z.string().optional(),
  approved: z.boolean(),
});
export type ToolSafetyApprovalResolvedBroadcast = z.infer<typeof ToolSafetyApprovalResolvedBroadcastSchema>;

export const ToolSafetyStagedCallBroadcastSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  displayName: z.string(),
  packageId: z.string(),
  toolId: z.string(),
  riskLevel: RiskLevelSchema.optional(),
  reason: z.string().optional(),
  timestamp: z.number(),
  allowPermanentTrust: z.boolean().optional(),
  blockedBy: ToolBlockSourceSchema.optional(),
  automationId: z.string().optional(),
  automationName: z.string().optional(),
});
export type ToolSafetyStagedCallBroadcast = z.infer<typeof ToolSafetyStagedCallBroadcastSchema>;

export const ToolSafetyStagedCallUpdatedBroadcastSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  status: StagedToolCallStatusSchema,
  result: StagedCallResultBroadcastSchema.optional(),
});
export type ToolSafetyStagedCallUpdatedBroadcast = z.infer<typeof ToolSafetyStagedCallUpdatedBroadcastSchema>;

export const MemoryWriteApprovalRequestBroadcastSchema = z.object({
  toolUseId: z.string(),
  originalTurnId: z.string(),
  originalSessionId: z.string(),
  destination: MemoryApprovalDestinationBroadcastSchema,
  summary: z.string(),
  // Carries sensitive file content on persisted/catch-up records. Parse-error logs must not echo it.
  content: z.string().optional(),
  contentPreview: z.string().optional(),
  sensitivityReason: z.string().optional(),
  hasSpaceOverride: z.boolean().optional(),
  privateMode: z.boolean().optional(),
  blockedBy: BlockSourceSchema.optional(),
  approvalIdentifier: z.string().optional(),
  approvalKind: ApprovalKindSchema.optional(),
  authorLabel: z.string().optional(),
  staged: z.boolean().optional(),
  timestamp: z.number(),

  // Flat legacy/catch-up fields preserved by normalizeMemoryApproval().
  turnId: z.string().optional(),
  sessionId: z.string().optional(),
  filePath: z.string().optional(),
  spaceName: z.string().optional(),
  spacePath: z.string().optional(),
  location: FileLocationSchema.optional(),
  sharing: SharingSchema.optional(),
  isNewFile: z.boolean().optional(),
});
export type MemoryWriteApprovalRequestBroadcast = z.infer<typeof MemoryWriteApprovalRequestBroadcastSchema>;

export const MemoryWriteApprovalResolvedBroadcastSchema = z.object({
  toolUseId: z.string(),
  originalSessionId: z.string(),
  approved: z.boolean(),
});
export type MemoryWriteApprovalResolvedBroadcast = z.infer<typeof MemoryWriteApprovalResolvedBroadcastSchema>;

export const MemoryFileStagedBroadcastSchema = z.object({
  id: z.string(),
  realPath: z.string(),
  spaceName: z.string(),
  summary: z.string(),
  stagedAt: z.number(),
});
export type MemoryFileStagedBroadcast = z.infer<typeof MemoryFileStagedBroadcastSchema>;

export const MemoryStagedFilesChangedBroadcastSchema = z.object({}).passthrough().optional();
export type MemoryStagedFilesChangedBroadcast = z.infer<typeof MemoryStagedFilesChangedBroadcastSchema>;
