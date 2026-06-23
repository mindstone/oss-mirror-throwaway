import type { PendingApprovalItem } from '@renderer/features/inbox/hooks/usePendingApprovals';
import type { StagedFileItem } from '@renderer/features/inbox/hooks/useStagedFiles';

const DEFAULT_MAX_INSTRUCTION_LENGTH = 4000;

export type RedirectTarget =
  | { kind: 'approval'; approval: PendingApprovalItem }
  | { kind: 'staged-file'; stagedFile: StagedFileItem };

export type RedirectOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; stage: 'precondition'; reason: 'empty-instruction' | 'missing-session' | 'over-length' }
  | { ok: false; stage: 'deny'; reason: string }
  | { ok: false; stage: 'send'; sessionId: string; error: string };

export interface RedirectDeps {
  denyApproval: (a: PendingApprovalItem) => Promise<{ ok: boolean; reason?: string }>;
  denyMemoryApprovalWithoutFeedback: (a: PendingApprovalItem) => Promise<{ ok: boolean; reason?: string }>;
  keepStagedFilePrivate: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  sendMessageToSession: (sessionId: string, message: string) => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

function getSessionId(target: RedirectTarget): string {
  const rawSessionId = target.kind === 'approval'
    ? target.approval.sessionId
    : target.stagedFile.sessionId;
  return typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
}

async function denyTarget(target: RedirectTarget, deps: RedirectDeps): Promise<{ ok: boolean; reason?: string }> {
  if (target.kind === 'staged-file') {
    return deps.keepStagedFilePrivate(target.stagedFile.id);
  }

  switch (target.approval.type) {
    case 'memory':
      return deps.denyMemoryApprovalWithoutFeedback(target.approval);
    case 'tool':
    case 'staged-tool':
      return deps.denyApproval(target.approval);
    default: {
      const _exhaustive: never = target.approval.type;
      throw new Error(`Unsupported approval type: ${_exhaustive}`);
    }
  }
}

export async function redirectApprovalWithInstruction(args: {
  target: RedirectTarget;
  instruction: string;
  deps: RedirectDeps;
  maxInstructionLength?: number;
}): Promise<RedirectOutcome> {
  const { target, deps } = args;
  const maxInstructionLength = args.maxInstructionLength ?? DEFAULT_MAX_INSTRUCTION_LENGTH;
  const instruction = args.instruction.trim();

  if (!instruction) {
    return { ok: false, stage: 'precondition', reason: 'empty-instruction' };
  }

  if (instruction.length > maxInstructionLength) {
    return { ok: false, stage: 'precondition', reason: 'over-length' };
  }

  const sessionId = getSessionId(target);
  if (!sessionId) {
    return { ok: false, stage: 'precondition', reason: 'missing-session' };
  }

  let denyResult: { ok: boolean; reason?: string };
  try {
    denyResult = await denyTarget(target, deps);
  } catch (error) {
    return { ok: false, stage: 'deny', reason: getErrorMessage(error) };
  }

  if (!denyResult.ok) {
    return {
      ok: false,
      stage: 'deny',
      reason: denyResult.reason ?? 'Deny failed',
    };
  }

  try {
    await deps.sendMessageToSession(sessionId, instruction);
  } catch (error) {
    return {
      ok: false,
      stage: 'send',
      sessionId,
      error: getErrorMessage(error),
    };
  }

  return { ok: true, sessionId };
}
