import { useMemo } from 'react';
import {
  classifyEffectKind,
  deriveActionPreview,
  isFileBackedEffectKind,
  type ActionPreviewInput,
  type ActionPreviewModel,
} from '@rebel/shared';
import type { MemoryWriteApproval, StagedFile } from '../types';
import {
  useApprovalContent,
  type ApprovalContentItem,
  type MemoryApprovalContentIdentity,
  type UseApprovalContentOptions,
  type UseApprovalContentResult,
} from './useApprovalContent';

const MISSING_TRANSPORT_ERROR =
  'useActionPreview requires readStagedContent/readWorkspaceFile for file-backed effects.';

const MISSING_READ_STAGED_CONTENT: UseApprovalContentOptions['readStagedContent'] = async () => {
  throw new Error(MISSING_TRANSPORT_ERROR);
};

const MISSING_READ_WORKSPACE_FILE: UseApprovalContentOptions['readWorkspaceFile'] = async () => {
  throw new Error(MISSING_TRANSPORT_ERROR);
};

type MemoryLikeInput = Extract<ActionPreviewInput, { kind: 'memory' }>;
type StagedFileLikeInput = Extract<ActionPreviewInput, { kind: 'staged-file' }>;
type ConflictAwareInput = MemoryLikeInput | StagedFileLikeInput;

export interface UseActionPreviewOptions {
  readStagedContent?: UseApprovalContentOptions['readStagedContent'];
  readWorkspaceFile?: UseApprovalContentOptions['readWorkspaceFile'];
  readMemoryApprovalContent?: (
    identity: MemoryApprovalContentIdentity,
    signal: AbortSignal,
  ) => Promise<string | null>;
  onError?: UseApprovalContentOptions['onError'];
}

export interface UseActionPreviewResult {
  model: ActionPreviewModel;
  content: UseApprovalContentResult;
}

function isConflictAwareInput(input: ActionPreviewInput): input is ConflictAwareInput {
  return input.kind === 'memory' || input.kind === 'staged-file';
}

function toApprovalContentItem(input: ConflictAwareInput): ApprovalContentItem | null {
  if (input.kind === 'memory') {
    const extraIdentity = input as typeof input & {
      originalSessionId?: string;
      approvalIdentifier?: string;
    };
    const item: MemoryWriteApproval & { content?: string; approvalIdentifier?: string } = {
      toolUseId: input.toolUseId ?? '',
      originalTurnId: '',
      originalSessionId: extraIdentity.originalSessionId ?? '',
      spaceName: input.spaceName,
      filePath: input.filePath,
      summary: input.summary ?? '',
      contentPreview: input.contentPreview ?? '',
      timestamp: 0,
      spacePath: input.spacePath ?? input.filePath,
      sharing: input.sharing,
      isNewFile: input.isNewFile ?? false,
      blockedBy: 'safety_prompt',
      content: input.content,
      approvalIdentifier: extraIdentity.approvalIdentifier,
      approvalKind: input.approvalKind,
    };
    return item;
  }

  const isNewFile = input.isNewFile === true || (input.baseHash ?? '').toLowerCase() === 'new-file';
  const baseHash = input.baseHash ?? (isNewFile ? 'new-file' : 'existing-file');
  if (typeof input.stagedFileId !== 'string' || input.stagedFileId.trim().length === 0) {
    return null;
  }
  const item: StagedFile = {
    id: input.stagedFileId,
    realPath: input.filePath,
    spaceName: input.spaceName,
    spacePath: input.spacePath ?? input.filePath,
    sessionId: '',
    baseHash,
    summary: input.summary ?? '',
    stagedAt: 0,
    sensitivity: 'high',
    sharing: input.sharing,
    hasConflict: input.hasConflict,
    approvalKind: input.approvalKind,
  };
  return item;
}

function addResolvedConflict(input: ActionPreviewInput, conflictFromContent: boolean): ActionPreviewInput {
  if (!isConflictAwareInput(input)) {
    return input;
  }

  const hasConflict = input.hasConflict === true || conflictFromContent;
  if (input.hasConflict === hasConflict) {
    return input;
  }

  return {
    ...input,
    hasConflict,
  };
}

export function useActionPreview(
  input: ActionPreviewInput,
  options: UseActionPreviewOptions = {},
): UseActionPreviewResult {
  const initialEffectKind = useMemo(() => classifyEffectKind(input), [input]);
  const shouldResolveFileContent = isFileBackedEffectKind(initialEffectKind);

  const contentItem = useMemo(
    () => (shouldResolveFileContent && isConflictAwareInput(input) ? toApprovalContentItem(input) : null),
    [input, shouldResolveFileContent],
  );

  // Intentionally unconditional to keep hook order stable across effect kinds.
  const content = useApprovalContent(contentItem, {
    readStagedContent: options.readStagedContent ?? MISSING_READ_STAGED_CONTENT,
    readWorkspaceFile: options.readWorkspaceFile ?? MISSING_READ_WORKSPACE_FILE,
    readMemoryApprovalContent: options.readMemoryApprovalContent,
    onError: options.onError,
  });

  const modelInput = useMemo(
    () => addResolvedConflict(input, content.conflict),
    [input, content.conflict],
  );
  const model = useMemo(() => deriveActionPreview(modelInput), [modelInput]);

  return { model, content };
}
