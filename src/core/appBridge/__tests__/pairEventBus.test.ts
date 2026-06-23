import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairEventBus, type PairEvent } from '@core/appBridge/server/pairEventBus';
import { createScopedLogger } from '@core/logger';

vi.mock('@core/logger', () => {
  const mockLogger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    createScopedLogger: vi.fn(() => mockLogger),
  };
});

function buildEvent(overrides: Partial<PairEvent> = {}): PairEvent {
  return {
    type: 'paired',
    pairSessionId: 'pair-session-1',
    emittedAt: Date.now(),
    ...overrides,
  };
}

describe('appBridge/server/pairEventBus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers emitted events to subscribers for the same pair session', () => {
    const bus = new PairEventBus();
    const handler = vi.fn();
    bus.subscribe('pair-session-1', handler);

    const event = buildEvent();
    bus.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('stops delivering events after unsubscribe is called', () => {
    const bus = new PairEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('pair-session-1', handler);

    unsubscribe();
    bus.emit(buildEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers to every subscriber listening on the same session', () => {
    const bus = new PairEventBus();
    const first = vi.fn();
    const second = vi.fn();
    const event = buildEvent();

    bus.subscribe('pair-session-1', first);
    bus.subscribe('pair-session-1', second);
    bus.emit(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });

  it('does not deliver events across different pair sessions', () => {
    const bus = new PairEventBus();
    const matching = vi.fn();
    const nonMatching = vi.fn();

    bus.subscribe('pair-session-1', matching);
    bus.subscribe('pair-session-2', nonMatching);
    bus.emit(buildEvent({ pairSessionId: 'pair-session-1' }));

    expect(matching).toHaveBeenCalledTimes(1);
    expect(nonMatching).not.toHaveBeenCalled();
  });

  it('replays only the last five non-expired events in oldest-first order', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T10:00:00.000Z'));
    const bus = new PairEventBus();
    const baseTime = Date.now();

    // Older than the 11min replay TTL — should be pruned before being replayed.
    bus.emit(buildEvent({ type: 'paired', emittedAt: baseTime - (11 * 60_000 + 1_000) }));
    for (let index = 0; index < 6; index += 1) {
      bus.emit(
        buildEvent({
          type: index % 2 === 0 ? 'paired' : 'session-ended',
          emittedAt: baseTime - 5_000 + index,
          tokenFingerprint: `fingerprint-${index}`,
        }),
      );
    }

    expect(bus.getReplay('pair-session-1')).toEqual([
      expect.objectContaining({ tokenFingerprint: 'fingerprint-1' }),
      expect.objectContaining({ tokenFingerprint: 'fingerprint-2' }),
      expect.objectContaining({ tokenFingerprint: 'fingerprint-3' }),
      expect.objectContaining({ tokenFingerprint: 'fingerprint-4' }),
      expect.objectContaining({ tokenFingerprint: 'fingerprint-5' }),
    ]);
  });

  it('evicts replay entries once they age past the 11 minute TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T10:00:00.000Z'));
    const bus = new PairEventBus();

    bus.emit(buildEvent({ emittedAt: Date.now() }));
    expect(bus.getReplay('pair-session-1')).toHaveLength(1);

    // Replay TTL must outlast the pair-code TTL (10min) so delayed re-subscribe
    // in STEP 3's next turn can still see `paired` / `code-expired` events.
    vi.advanceTimersByTime(11 * 60_000 + 1_000);

    expect(bus.getReplay('pair-session-1')).toEqual([]);
  });

  it('continues invoking remaining subscribers and logs if one throws', () => {
    const bus = new PairEventBus();
    const thrower = vi.fn(() => {
      throw new Error('Test error');
    });
    const succeeding = vi.fn();
    const event = buildEvent();

    bus.subscribe('pair-session-1', thrower);
    bus.subscribe('pair-session-1', succeeding);

    bus.emit(event);

    expect(thrower).toHaveBeenCalledWith(event);
    expect(succeeding).toHaveBeenCalledWith(event);
    const mockLogger = vi.mocked(createScopedLogger)({ service: 'mock' });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        pairSessionId: 'pair-session-1',
        eventType: 'paired',
        err: expect.any(Error),
      }),
      'PairEventBus subscriber threw an error',
    );
  });
});
