import type { AgentErrorResolutionAction } from '@rebel/shared';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { isMessageHidden } from '../store/selectors';

export const SESSION_ERROR_RESOLUTION_RETRY_ACTIONS = new Set<AgentErrorResolutionAction['action']>([
  'retry',
  'switch-model',
  'switch-provider',
  // 260622 Stage 4: both Chief-of-Staff recovery verbs resend the original user
  // message after applying their fix (recreate the README / proceed on the
  // template), so they retry the turn just like `retry`.
  'recreate-chief-of-staff',
  'proceed-without-chief-of-staff',
]);

export type ManualSessionErrorRetryPlan =
  | { kind: 'not-retry-action' }
  | { kind: 'still-working' }
  | { kind: 'missing-message' }
  | { kind: 'retry'; messageText: string; failedTurnHadToolEvents: boolean };

type PlanManualSessionErrorRetryInput = {
  action: AgentErrorResolutionAction['action'];
  activeTurnId: string | null | undefined;
  failedTurnId: string;
  events: AgentEvent[];
  messages: AgentTurnMessage[];
};

export function planManualSessionErrorRetry({
  action,
  activeTurnId,
  failedTurnId,
  events,
  messages,
}: PlanManualSessionErrorRetryInput): ManualSessionErrorRetryPlan {
  if (!SESSION_ERROR_RESOLUTION_RETRY_ACTIONS.has(action)) {
    return { kind: 'not-retry-action' };
  }

  if (activeTurnId) {
    return { kind: 'still-working' };
  }

  const retryMessage = messages.find(
    (message) => message.turnId === failedTurnId && message.role === 'user' && !isMessageHidden(message),
  );
  if (!retryMessage?.text) {
    return { kind: 'missing-message' };
  }

  return {
    kind: 'retry',
    messageText: retryMessage.text,
    failedTurnHadToolEvents: events.some((event) => event.type === 'tool'),
  };
}
