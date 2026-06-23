export type BlockedPathDisposition =
  | 'fileWrite'
  | 'failClosed'
  | 'genericApproval'
  | 'mcpStaging'
  | 'hardDeny';

export type BlockedPathDispositionInput = Readonly<{
  isFileWriteTool: boolean;
  isFailClosed: boolean;
  hasGenericApprovalResult: boolean;
  canUseStagingPath: boolean;
}>;

/**
 * Single source of truth for blocked tool routing precedence.
 *
 * Keep per-surface side effects in the caller; this classifier owns only the
 * ordering contract shared by automation and interactive blocked paths.
 */
export function classifyBlockedPathDisposition(
  input: BlockedPathDispositionInput,
): BlockedPathDisposition {
  if (input.isFileWriteTool) return 'fileWrite';
  if (input.isFailClosed) return 'failClosed';
  if (input.hasGenericApprovalResult) return 'genericApproval';
  if (input.canUseStagingPath) return 'mcpStaging';
  return 'hardDeny';
}
