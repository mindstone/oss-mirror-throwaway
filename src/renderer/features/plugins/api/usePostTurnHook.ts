import { useRebelEvent } from './useRebelEvent';
import type { PostTurnHookResult } from './types';

function isValidPostTurnPayload(payload: unknown): payload is Omit<PostTurnHookResult, 'toolsUsed'> & { toolsUsed?: unknown } {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.sessionId === 'string' &&
    typeof candidate.turnId === 'string' &&
    typeof candidate.assistantText === 'string'
  );
}

export function usePostTurnHook(callback: (turnResult: PostTurnHookResult) => void): void {
  useRebelEvent('turn:completed', (payload) => {
    if (!isValidPostTurnPayload(payload)) {
      return;
    }

    const toolsUsed = Array.isArray(payload.toolsUsed)
      ? payload.toolsUsed.filter((tool): tool is string => typeof tool === 'string')
      : [];

    callback({
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      assistantText: payload.assistantText,
      toolsUsed,
    });
  });
}
