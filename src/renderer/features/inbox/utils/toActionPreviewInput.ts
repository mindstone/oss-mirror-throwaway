import type { ActionPreviewInput } from '@rebel/shared';
import type { PendingApprovalItem } from '../hooks/usePendingApprovals';
import type { StagedFileItem } from '../hooks/useStagedFiles';

export interface ToActionPreviewInputOptions {
  resolvedRecipientLabel?: string;
  resolvedChannelName?: string;
}

interface StagedFilePendingApprovalLike {
  type: 'staged-file';
  stagedFile: StagedFileItem;
}

type ActionPreviewSourceItem =
  | PendingApprovalItem
  | StagedFileItem
  | StagedFilePendingApprovalLike;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readStringField(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function extractToolArgs(input: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(input.args);
  return nested ?? input;
}

function toMemorySharing(value: unknown): 'private' | 'restricted' | 'company-wide' | 'public' | undefined {
  if (
    value === 'private'
    || value === 'restricted'
    || value === 'company-wide'
    || value === 'public'
  ) {
    return value;
  }
  return undefined;
}

function mapStagedFileToActionPreviewInput(file: StagedFileItem): ActionPreviewInput {
  return {
    kind: 'staged-file',
    stagedFileId: file.id,
    filePath: file.realPath,
    spaceName: file.spaceName,
    spacePath: file.spacePath,
    sharing: toMemorySharing(file.sharing),
    summary: file.summary,
    baseHash: file.baseHash,
    isNewFile: file.baseHash === 'new-file',
    hasConflict: Boolean(file.hasConflict),
    approvalKind: file.approvalKind,
  };
}

function isStagedFileItem(value: ActionPreviewSourceItem): value is StagedFileItem {
  return (
    'realPath' in value
    && typeof value.realPath === 'string'
    && 'baseHash' in value
    && typeof value.baseHash === 'string'
  );
}

export function toActionPreviewInput(
  sourceItem: ActionPreviewSourceItem,
  options: ToActionPreviewInputOptions = {},
): ActionPreviewInput | null {
  if (isStagedFileItem(sourceItem)) {
    return mapStagedFileToActionPreviewInput(sourceItem);
  }

  if (sourceItem.type === 'staged-file') {
    return mapStagedFileToActionPreviewInput(sourceItem.stagedFile);
  }

  const approval = sourceItem;

  if (approval.type === 'tool' && approval.toolApproval) {
    const toolInput = asRecord(approval.toolApproval.input) ?? {};
    const packageId = readStringField(toolInput, ['packageId', 'package_id']) ?? approval.packageName;
    return {
      kind: 'tool',
      toolName: approval.toolApproval.toolName,
      effectiveToolId: approval.toolApproval.effectiveToolId,
      packageId,
      reason: approval.toolApproval.reason,
      args: extractToolArgs(toolInput),
      resolvedRecipientLabel: options.resolvedRecipientLabel,
      resolvedChannelName: options.resolvedChannelName,
    };
  }

  if (approval.type === 'staged-tool' && approval.stagedToolCall) {
    return {
      kind: 'staged-tool',
      toolId: approval.stagedToolCall.mcpPayload.toolId,
      packageId: approval.stagedToolCall.mcpPayload.packageId,
      displayName: approval.stagedToolCall.displayName,
      reason: approval.stagedToolCall.reason,
      args: approval.stagedToolCall.mcpPayload.args,
      resolvedRecipientLabel: options.resolvedRecipientLabel,
      resolvedChannelName: options.resolvedChannelName,
    };
  }

  if (approval.type === 'memory' && approval.memoryApproval) {
    return {
      kind: 'memory',
      toolUseId: approval.memoryApproval.toolUseId,
      filePath: approval.memoryApproval.filePath,
      spaceName: approval.memoryApproval.spaceName,
      spacePath: approval.memoryApproval.spacePath,
      sharing: approval.memoryApproval.sharing,
      summary: approval.memoryApproval.summary,
      content: approval.memoryApproval.content,
      contentPreview: approval.memoryApproval.contentPreview,
      sensitivityReason: approval.memoryApproval.sensitivityReason,
      isNewFile: approval.memoryApproval.isNewFile,
      approvalKind: approval.memoryApproval.approvalKind,
      hasConflict: false,
    };
  }

  return null;
}
