import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSlackInboundReplayRegistryForTesting,
  registerSlackInboundReplayHandler,
  SLACK_INBOUND_REPLAY_INTERVAL_MS,
  triggerSlackInboundReplay,
} from '../slackInboundReplayRegistry';

describe('slackInboundReplayRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetSlackInboundReplayRegistryForTesting();
  });

  afterEach(() => {
    __resetSlackInboundReplayRegistryForTesting();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('periodically triggers replay every 60 seconds once a handler is registered', async () => {
    const replayHandler = vi.fn().mockResolvedValue(undefined);
    registerSlackInboundReplayHandler(replayHandler);

    await vi.advanceTimersByTimeAsync(SLACK_INBOUND_REPLAY_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SLACK_INBOUND_REPLAY_INTERVAL_MS);

    expect(replayHandler).toHaveBeenCalledTimes(2);
  });

  it('does not run overlapping replay ticks while the previous replay is still in flight', async () => {
    let resolveInFlight!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      resolveInFlight = resolve;
    });
    const replayHandler = vi.fn().mockImplementation(() => inFlight);
    registerSlackInboundReplayHandler(replayHandler);

    await vi.advanceTimersByTimeAsync(SLACK_INBOUND_REPLAY_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SLACK_INBOUND_REPLAY_INTERVAL_MS * 2);
    expect(replayHandler).toHaveBeenCalledTimes(1);

    resolveInFlight();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(SLACK_INBOUND_REPLAY_INTERVAL_MS);
    expect(replayHandler).toHaveBeenCalledTimes(2);
  });

  it('no-ops when replay is triggered before the route registers a handler', async () => {
    await expect(triggerSlackInboundReplay()).resolves.toBeUndefined();
  });
});
