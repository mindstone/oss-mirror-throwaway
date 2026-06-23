/**
 * Registry for the Slack inbound replay handler. Lets
 * `externalConversationServiceFactory` trigger inbound replay without a
 * static import cycle with `routes/slackWebhook` (which itself depends on
 * the factory for adapter access).
 *
 * `routes/slackWebhook` registers its `replayPendingSlackInbound` function
 * at module-load time; the factory imports the registry, which is small and
 * has no upward dependencies.
 */

import { createScopedLogger } from '@core/logger';

type ReplayHandler = () => Promise<void>;

const log = createScopedLogger({ service: 'slackInboundReplayRegistry' });
export const SLACK_INBOUND_REPLAY_INTERVAL_MS = 60_000;

let replayHandler: ReplayHandler | null = null;
let periodicReplayTimer: NodeJS.Timeout | null = null;
let periodicReplayInFlight = false;

function ensurePeriodicReplayTimer(): void {
  if (periodicReplayTimer) return;
  periodicReplayTimer = setInterval(() => {
    if (periodicReplayInFlight) return;
    periodicReplayInFlight = true;
    triggerSlackInboundReplay().catch((err: unknown) => {
      log.warn({ err }, 'slack_replay_tick_failed');
    }).finally(() => {
      periodicReplayInFlight = false;
    });
  }, SLACK_INBOUND_REPLAY_INTERVAL_MS);
  periodicReplayTimer.unref?.();
}

export function registerSlackInboundReplayHandler(handler: ReplayHandler): void {
  replayHandler = handler;
  ensurePeriodicReplayTimer();
}

export async function triggerSlackInboundReplay(): Promise<void> {
  if (!replayHandler) {
    // Replay handler not yet registered; the slackWebhook route module hasn't
    // been imported yet (routes register on first server-side request). The
    // factory's startup replay is best-effort — when the route does load it
    // will register and any subsequent client-connect-driven replay will run.
    return;
  }
  await replayHandler();
}

export function __resetSlackInboundReplayRegistryForTesting(): void {
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) return;
  replayHandler = null;
  periodicReplayInFlight = false;
  if (periodicReplayTimer) {
    clearInterval(periodicReplayTimer);
    periodicReplayTimer = null;
  }
}
