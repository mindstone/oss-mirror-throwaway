/**
 * Agent turn admission — typed target-busy refusal (shared sentinel + matcher).
 *
 * When an `AgentTurnRequest` carries `supersedePolicy: 'reject'` and the
 * target session already has an active turn, `startAgentTurn` refuses
 * admission by throwing the error created here instead of cancelling the
 * active turn (the legacy supersede path). The renderer detects the refusal
 * with `isTargetBusyRejection` and re-queues the message — no loss, no toast.
 *
 * The sentinel code travels in the error MESSAGE because Electron's
 * `ipcRenderer.invoke` rejection only preserves the message text (wrapped as
 * `"Error invoking remote method 'agent:turn': Error: <message>"`), so the
 * matcher is a substring check, not an `instanceof`/property check.
 *
 * Both producer (main/cloud admission) and consumer (renderer queue) import
 * from here so there is exactly one definition of the contract.
 * See docs/plans/260610_queue-drain-cancels-turn/PLAN.md (Stages 2–3).
 */

export const AGENT_TURN_TARGET_BUSY_CODE = 'AGENT_TURN_TARGET_BUSY';

/**
 * Create the typed refusal thrown at turn admission when the request policy
 * is 'reject' and the target session has an active turn. Embeds the sentinel
 * code in the message so it survives the Electron IPC rejection wrapper.
 */
export function createTargetBusyRejectionError(
  sessionId: string,
  activeTurnId: string,
): Error {
  return new Error(
    `${AGENT_TURN_TARGET_BUSY_CODE}: session ${sessionId} already has active turn ${activeTurnId}; ` +
    'a non-interrupt (queue-mode) send never supersedes an active turn.',
  );
}

/**
 * Detect the typed target-busy refusal, tolerating the Electron invoke
 * rejection prefix (`"Error invoking remote method 'agent:turn': …"`) and
 * raw-string rethrows. Anything that is not an Error or string is never a
 * refusal.
 */
export function isTargetBusyRejection(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message.includes(AGENT_TURN_TARGET_BUSY_CODE);
}

/**
 * Renderer-side enrichment (never crosses IPC): when a SAME-SESSION dispatch
 * is refused, the user message was already persisted via `addUserMessage`
 * before the IPC call. `processMessage` attaches that persisted message id to
 * the refusal so the queue's requeue can carry `existingMessageId` and the
 * re-drain dedups instead of duplicating the message
 * (FMM row 9 of the planning doc).
 */
const REQUEUE_MESSAGE_ID_PROP = 'rebelRequeueExistingMessageId';

export function attachRequeueMessageId(err: unknown, messageId: string): Error {
  const error =
    err instanceof Error
      ? err
      : new Error(typeof err === 'string' ? err : String(err));
  (error as Error & { [REQUEUE_MESSAGE_ID_PROP]?: string })[
    REQUEUE_MESSAGE_ID_PROP
  ] = messageId;
  return error;
}

export function getRequeueMessageId(err: unknown): string | undefined {
  if (err instanceof Error) {
    const value = (err as Error & { [REQUEUE_MESSAGE_ID_PROP]?: unknown })[
      REQUEUE_MESSAGE_ID_PROP
    ];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}
