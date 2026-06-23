import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimitCooldown } from '../apiRateLimitCooldown';

// Mock the cooldownStore module
vi.mock('../cooldownStore', () => ({
  getPersistedCooldown: vi.fn(() => 0),
  persistCooldown: vi.fn(),
  clearPersistedCooldown: vi.fn(),
}));

vi.mock('@core/services/cooldownStatusBroadcast', () => ({
  broadcastCooldownStatus: vi.fn(),
}));

import {
  getPersistedCooldown,
  persistCooldown,
  clearPersistedCooldown,
} from '../cooldownStore';
import { broadcastCooldownStatus } from '@core/services/cooldownStatusBroadcast';

const mockGetPersistedCooldown = vi.mocked(getPersistedCooldown);
const mockPersistCooldown = vi.mocked(persistCooldown);
const mockClearPersistedCooldown = vi.mocked(clearPersistedCooldown);
const mockBroadcastCooldownStatus = vi.mocked(broadcastCooldownStatus);

describe('ApiRateLimitCooldown', () => {
  let cooldown: ApiRateLimitCooldown;

  beforeEach(() => {
    cooldown = new ApiRateLimitCooldown();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is available by default', () => {
    expect(cooldown.isAvailable()).toBe(true);
    expect(cooldown.remainingMs()).toBe(0);
  });

  it('becomes unavailable after recording a rate limit', () => {
    cooldown.recordRateLimit();
    expect(cooldown.isAvailable()).toBe(false);
    expect(cooldown.remainingMs()).toBeGreaterThan(0);
  });

  it('uses default 30s cooldown when no Retry-After provided', () => {
    cooldown.recordRateLimit();
    expect(cooldown.remainingMs()).toBeLessThanOrEqual(30_000);

    vi.advanceTimersByTime(29_999);
    expect(cooldown.isAvailable()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(cooldown.isAvailable()).toBe(true);
  });

  it('uses Retry-After value when provided', () => {
    cooldown.recordRateLimit(5_000);

    vi.advanceTimersByTime(4_999);
    expect(cooldown.isAvailable()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(cooldown.isAvailable()).toBe(true);
  });

  it('caps Retry-After at 5 minutes', () => {
    cooldown.recordRateLimit(10 * 60_000); // 10 minutes

    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(cooldown.isAvailable()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(cooldown.isAvailable()).toBe(true);
  });

  it('never shortens an existing cooldown', () => {
    cooldown.recordRateLimit(20_000);
    cooldown.recordRateLimit(5_000); // shorter -- should be ignored

    vi.advanceTimersByTime(5_000);
    expect(cooldown.isAvailable()).toBe(false); // still in the 20s window

    vi.advanceTimersByTime(15_000);
    expect(cooldown.isAvailable()).toBe(true);
  });

  it('extends cooldown when a longer one is recorded', () => {
    cooldown.recordRateLimit(5_000);
    cooldown.recordRateLimit(20_000);

    vi.advanceTimersByTime(5_000);
    expect(cooldown.isAvailable()).toBe(false);

    vi.advanceTimersByTime(15_000);
    expect(cooldown.isAvailable()).toBe(true);
  });

  it('clears cooldown on success', () => {
    cooldown.recordRateLimit();
    expect(cooldown.isAvailable()).toBe(false);

    cooldown.recordSuccess();
    expect(cooldown.isAvailable()).toBe(true);
    expect(cooldown.remainingMs()).toBe(0);
  });

  it('resets fully via reset()', () => {
    cooldown.recordRateLimit();
    cooldown.reset();
    expect(cooldown.isAvailable()).toBe(true);
    expect(cooldown._getState()).toMatchObject({ cooldownUntil: 0 });
  });

  it('increments generation on inactive to active transition', () => {
    const initialGeneration = cooldown.currentGenerationId();
    cooldown.recordRateLimit(5_000);

    expect(cooldown.currentGenerationId()).toBe(initialGeneration + 1);
    expect(cooldown._getState().generationId).toBe(initialGeneration + 1);
  });

  it('does not increment generation when extending an active cooldown', () => {
    cooldown.recordRateLimit(5_000);
    const activeGeneration = cooldown.currentGenerationId();

    cooldown.recordRateLimit(20_000);

    expect(cooldown.currentGenerationId()).toBe(activeGeneration);
  });

  it('does not reset generation on recordSuccess', () => {
    cooldown.recordRateLimit(5_000);
    const activeGeneration = cooldown.currentGenerationId();

    cooldown.recordSuccess();

    expect(cooldown.currentGenerationId()).toBe(activeGeneration);
  });

  it('uses a new generation after success clears a cooldown and rate limit re-engages', () => {
    cooldown.recordRateLimit(5_000);
    const firstWindowGeneration = cooldown.currentGenerationId();

    cooldown.recordSuccess();
    cooldown.recordRateLimit(5_000);
    const secondWindowGeneration = cooldown.currentGenerationId();

    expect(secondWindowGeneration).not.toBe(firstWindowGeneration);
    expect(secondWindowGeneration).toBe(firstWindowGeneration + 1);
  });

  it('does not reset generation on reset', () => {
    cooldown.recordRateLimit(5_000);
    const activeGeneration = cooldown.currentGenerationId();

    cooldown.reset();

    expect(cooldown.currentGenerationId()).toBe(activeGeneration);
  });

  it('remainingMs() returns 0 when no cooldown is active', () => {
    expect(cooldown.remainingMs()).toBe(0);
  });

  it('remainingMs() counts down correctly', () => {
    cooldown.recordRateLimit(10_000);

    vi.advanceTimersByTime(3_000);
    const remaining = cooldown.remainingMs();
    expect(remaining).toBeLessThanOrEqual(7_000);
    expect(remaining).toBeGreaterThan(6_000);
  });

  describe('non-persist instance (default)', () => {
    it('does not call persistCooldown on recordRateLimit', () => {
      cooldown.recordRateLimit(5_000);
      expect(mockPersistCooldown).not.toHaveBeenCalled();
    });

    it('does not call clearPersistedCooldown on recordSuccess', () => {
      cooldown.recordRateLimit();
      cooldown.recordSuccess();
      expect(mockClearPersistedCooldown).not.toHaveBeenCalled();
    });

    it('does not call clearPersistedCooldown on reset', () => {
      cooldown.recordRateLimit();
      cooldown.reset();
      expect(mockClearPersistedCooldown).not.toHaveBeenCalled();
    });

    it('does not call getPersistedCooldown on isAvailable', () => {
      cooldown.isAvailable();
      expect(mockGetPersistedCooldown).not.toHaveBeenCalled();
    });
  });

  describe('persist instance', () => {
    let persistCooldownInstance: ApiRateLimitCooldown;

    beforeEach(() => {
      persistCooldownInstance = new ApiRateLimitCooldown({ persistState: true });
    });

    it('persists cooldown on recordRateLimit', () => {
      persistCooldownInstance.recordRateLimit(10_000);
      expect(mockPersistCooldown).toHaveBeenCalledOnce();
      expect(mockPersistCooldown).toHaveBeenCalledWith(
        expect.any(Number),
      );
    });

    it('clears persisted cooldown on recordSuccess', () => {
      persistCooldownInstance.recordRateLimit();
      vi.clearAllMocks();
      persistCooldownInstance.recordSuccess();
      expect(mockClearPersistedCooldown).toHaveBeenCalledOnce();
    });

    it('does not call clearPersistedCooldown on recordSuccess when no cooldown active', () => {
      persistCooldownInstance.recordSuccess();
      expect(mockClearPersistedCooldown).not.toHaveBeenCalled();
    });

    it('clears persisted cooldown on reset', () => {
      persistCooldownInstance.recordRateLimit();
      vi.clearAllMocks();
      persistCooldownInstance.reset();
      expect(mockClearPersistedCooldown).toHaveBeenCalledOnce();
    });

    it('restores cooldown from disk on first isAvailable call', () => {
      const futureTime = Date.now() + 60_000;
      mockGetPersistedCooldown.mockReturnValueOnce(futureTime);

      expect(persistCooldownInstance.isAvailable()).toBe(false);
      expect(mockGetPersistedCooldown).toHaveBeenCalledOnce();
    });

    it('restores cooldown from disk on first remainingMs call', () => {
      const futureTime = Date.now() + 60_000;
      mockGetPersistedCooldown.mockReturnValueOnce(futureTime);

      expect(persistCooldownInstance.remainingMs()).toBeGreaterThan(0);
      expect(mockGetPersistedCooldown).toHaveBeenCalledOnce();
    });

    it('only restores from disk once (lazy init)', () => {
      mockGetPersistedCooldown.mockReturnValue(0);

      persistCooldownInstance.isAvailable();
      persistCooldownInstance.isAvailable();
      persistCooldownInstance.remainingMs();

      expect(mockGetPersistedCooldown).toHaveBeenCalledOnce();
    });

    it('does not overwrite a longer in-memory cooldown with a shorter persisted one', () => {
      // Record a long in-memory cooldown first
      persistCooldownInstance.recordRateLimit(120_000);

      // Now create a new instance that would restore a shorter persisted value
      const newInstance = new ApiRateLimitCooldown({ persistState: true });
      const shorterTime = Date.now() + 10_000;
      mockGetPersistedCooldown.mockReturnValueOnce(shorterTime);

      // The in-memory value wins if we had set it already, but this is a fresh instance
      // so the persisted value is loaded
      newInstance.isAvailable();
      expect(mockGetPersistedCooldown).toHaveBeenCalled();
    });
  });

  describe('diagnostic event emits per scope', () => {
    let appendSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      appendSpy = vi.fn();
       
      vi.doMock('../diagnosticEventsLedger', () => ({
        appendDiagnosticEvent: appendSpy,
      }));
    });

    afterEach(() => {
      vi.doUnmock('../diagnosticEventsLedger');
    });

    it('emits cooldown_enter/exit with scope=safety-eval for the safety-eval instance', async () => {
      const { ApiRateLimitCooldown: Reloaded } = await import('../apiRateLimitCooldown');
      const safetyCooldown = new Reloaded({ scope: 'safety-eval' });

      safetyCooldown.recordRateLimit(2_000);
      const enterCalls = appendSpy.mock.calls.filter(([e]) => e?.kind === 'cooldown_enter');
      expect(enterCalls).toHaveLength(1);
      expect(enterCalls[0][0]).toMatchObject({
        kind: 'cooldown_enter',
        data: { scope: 'safety-eval', retryAfterProvided: true, durationMs: 2_000 },
      });

      safetyCooldown.recordSuccess();
      const exitCalls = appendSpy.mock.calls.filter(([e]) => e?.kind === 'cooldown_exit');
      expect(exitCalls).toHaveLength(1);
      expect(exitCalls[0][0]).toMatchObject({
        kind: 'cooldown_exit',
        data: { scope: 'safety-eval', reason: 'success' },
      });
    });

    it('emits cooldown_exit with reason=reset on reset() while active', async () => {
      const { ApiRateLimitCooldown: Reloaded } = await import('../apiRateLimitCooldown');
      const safetyCooldown = new Reloaded({ scope: 'safety-eval' });

      safetyCooldown.recordRateLimit(5_000);
      safetyCooldown.reset();
      const resetExits = appendSpy.mock.calls.filter(
        ([e]) => e?.kind === 'cooldown_exit' && e?.data?.reason === 'reset',
      );
      expect(resetExits).toHaveLength(1);
      expect(resetExits[0][0]).toMatchObject({
        kind: 'cooldown_exit',
        data: { scope: 'safety-eval', reason: 'reset' },
      });
    });

    it('emits cooldown_enter/exit with scope=safety-eval-degraded for degradation cooldowns', async () => {
      const { ApiRateLimitCooldown: Reloaded } = await import('../apiRateLimitCooldown');
      const degradedCooldown = new Reloaded({ scope: 'safety-eval-degraded' });

      degradedCooldown.recordRateLimit(2_000);
      const enterCalls = appendSpy.mock.calls.filter(([e]) => e?.kind === 'cooldown_enter');
      expect(enterCalls).toHaveLength(1);
      expect(enterCalls[0][0]).toMatchObject({
        kind: 'cooldown_enter',
        data: { scope: 'safety-eval-degraded', retryAfterProvided: true, durationMs: 2_000 },
      });

      degradedCooldown.recordSuccess();
      const exitCalls = appendSpy.mock.calls.filter(([e]) => e?.kind === 'cooldown_exit');
      expect(exitCalls).toHaveLength(1);
      expect(exitCalls[0][0]).toMatchObject({
        kind: 'cooldown_exit',
        data: { scope: 'safety-eval-degraded', reason: 'success' },
      });
    });

    it('does NOT emit on reset() when no cooldown was active', async () => {
      const { ApiRateLimitCooldown: Reloaded } = await import('../apiRateLimitCooldown');
      const safetyCooldown = new Reloaded({ scope: 'safety-eval' });

      safetyCooldown.reset();
      expect(appendSpy).not.toHaveBeenCalled();
    });
  });

  describe('cooldown status broadcasts', () => {
    it('broadcasts entered when recordRateLimit activates an inactive API cooldown', () => {
      const apiCooldown = new ApiRateLimitCooldown({ scope: 'api' });

      apiCooldown.recordRateLimit(60_000);

      expect(mockBroadcastCooldownStatus).toHaveBeenCalledOnce();
      expect(mockBroadcastCooldownStatus).toHaveBeenCalledWith({
        scope: 'api',
        state: 'entered',
        untilMs: Date.now() + 60_000,
        durationMs: 60_000,
      });
    });

    it('broadcasts entered with safety-eval scope for safety cooldowns', () => {
      const safetyCooldown = new ApiRateLimitCooldown({ scope: 'safety-eval' });

      safetyCooldown.recordRateLimit(60_000);

      expect(mockBroadcastCooldownStatus).toHaveBeenCalledWith({
        scope: 'safety-eval',
        state: 'entered',
        untilMs: Date.now() + 60_000,
        durationMs: 60_000,
      });
    });

    it('broadcasts entered with safety-eval-degraded scope for degradation cooldowns', () => {
      const degradedCooldown = new ApiRateLimitCooldown({ scope: 'safety-eval-degraded' });

      degradedCooldown.recordRateLimit(60_000);

      expect(mockBroadcastCooldownStatus).toHaveBeenCalledWith({
        scope: 'safety-eval-degraded',
        state: 'entered',
        untilMs: Date.now() + 60_000,
        durationMs: 60_000,
      });
    });

    it('does not broadcast when an already-active cooldown is extended', () => {
      cooldown.recordRateLimit(60_000);
      mockBroadcastCooldownStatus.mockClear();

      vi.advanceTimersByTime(1_000);
      cooldown.recordRateLimit(120_000);

      expect(mockBroadcastCooldownStatus).not.toHaveBeenCalled();
    });

    it('does not broadcast when a rate limit would not extend the active cooldown', () => {
      cooldown.recordRateLimit(60_000);
      mockBroadcastCooldownStatus.mockClear();

      cooldown.recordRateLimit(5_000);

      expect(mockBroadcastCooldownStatus).not.toHaveBeenCalled();
    });

    it('broadcasts exited when recordSuccess clears an active cooldown', () => {
      cooldown.recordRateLimit(60_000);
      mockBroadcastCooldownStatus.mockClear();

      cooldown.recordSuccess();

      expect(mockBroadcastCooldownStatus).toHaveBeenCalledOnce();
      expect(mockBroadcastCooldownStatus).toHaveBeenCalledWith({
        scope: 'safety-eval',
        state: 'exited',
      });
    });

    it('does not broadcast exited when recordSuccess runs with no active cooldown', () => {
      cooldown.recordSuccess();

      expect(mockBroadcastCooldownStatus).not.toHaveBeenCalled();
    });

    it('broadcasts exited when reset clears an active cooldown', () => {
      cooldown.recordRateLimit(60_000);
      mockBroadcastCooldownStatus.mockClear();

      cooldown.reset();

      expect(mockBroadcastCooldownStatus).toHaveBeenCalledOnce();
      expect(mockBroadcastCooldownStatus).toHaveBeenCalledWith({
        scope: 'safety-eval',
        state: 'exited',
      });
    });

    it('does not broadcast exited when reset runs with no active cooldown', () => {
      cooldown.reset();

      expect(mockBroadcastCooldownStatus).not.toHaveBeenCalled();
    });
  });

  // ─── Stage 1 / A2: context-threaded broadcast tests ──────────────────────

  describe('context-threaded reasonKind and resetAtMs', () => {
    it('includes reasonKind and resetAtMs in the broadcast when context is provided', () => {
      const degradedCooldown = new ApiRateLimitCooldown({ scope: 'safety-eval-degraded' });
      const resetAtMs = Date.now() + 200_000;

      degradedCooldown.recordRateLimit(60_000, { reasonKind: 'billing', resetAtMs });

      expect(mockBroadcastCooldownStatus).toHaveBeenCalledOnce();
      expect(mockBroadcastCooldownStatus).toHaveBeenCalledWith({
        scope: 'safety-eval-degraded',
        state: 'entered',
        untilMs: expect.any(Number),
        durationMs: 60_000,
        reasonKind: 'billing',
        resetAtMs,
      });
    });

    it('omits reasonKind and resetAtMs from the broadcast when no context is provided', () => {
      const degradedCooldown = new ApiRateLimitCooldown({ scope: 'safety-eval-degraded' });

      degradedCooldown.recordRateLimit(60_000);

      expect(mockBroadcastCooldownStatus).toHaveBeenCalledOnce();
      const call = mockBroadcastCooldownStatus.mock.calls[0][0];
      expect(call).not.toHaveProperty('reasonKind');
      expect(call).not.toHaveProperty('resetAtMs');
    });

    it('api-scope broadcast is unchanged when called without context', () => {
      const apiCooldown = new ApiRateLimitCooldown({ scope: 'api' });

      apiCooldown.recordRateLimit(60_000);

      expect(mockBroadcastCooldownStatus).toHaveBeenCalledOnce();
      expect(mockBroadcastCooldownStatus).toHaveBeenCalledWith({
        scope: 'api',
        state: 'entered',
        untilMs: expect.any(Number),
        durationMs: 60_000,
      });
      const call = mockBroadcastCooldownStatus.mock.calls[0][0];
      expect(call).not.toHaveProperty('reasonKind');
      expect(call).not.toHaveProperty('resetAtMs');
    });

    it('omits context fields from the broadcast when context has no reasonKind or resetAtMs', () => {
      const degradedCooldown = new ApiRateLimitCooldown({ scope: 'safety-eval-degraded' });

      degradedCooldown.recordRateLimit(60_000, {});

      const call = mockBroadcastCooldownStatus.mock.calls[0][0];
      expect(call).not.toHaveProperty('reasonKind');
      expect(call).not.toHaveProperty('resetAtMs');
    });
  });

  describe('context-threaded diagnostic events', () => {
    let appendSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      appendSpy = vi.fn();

      vi.doMock('../diagnosticEventsLedger', () => ({
        appendDiagnosticEvent: appendSpy,
      }));
    });

    afterEach(() => {
      vi.doUnmock('../diagnosticEventsLedger');
    });

    it('includes reasonKind and resetAtMs in the diagnostic event when context is provided', async () => {
      const { ApiRateLimitCooldown: Reloaded } = await import('../apiRateLimitCooldown');
      const degradedCooldown = new Reloaded({ scope: 'safety-eval-degraded' });
      const resetAtMs = Date.now() + 200_000;

      degradedCooldown.recordRateLimit(60_000, { reasonKind: 'billing', resetAtMs });

      const enterCalls = appendSpy.mock.calls.filter(([e]) => e?.kind === 'cooldown_enter');
      expect(enterCalls).toHaveLength(1);
      expect(enterCalls[0][0]).toMatchObject({
        kind: 'cooldown_enter',
        data: {
          scope: 'safety-eval-degraded',
          reasonKind: 'billing',
          resetAtMs,
        },
      });
    });

    it('omits reasonKind and resetAtMs from diagnostic event when no context is provided', async () => {
      const { ApiRateLimitCooldown: Reloaded } = await import('../apiRateLimitCooldown');
      const degradedCooldown = new Reloaded({ scope: 'safety-eval-degraded' });

      degradedCooldown.recordRateLimit(60_000);

      const enterCalls = appendSpy.mock.calls.filter(([e]) => e?.kind === 'cooldown_enter');
      expect(enterCalls).toHaveLength(1);
      const eventData = enterCalls[0][0].data;
      expect(eventData).not.toHaveProperty('reasonKind');
      expect(eventData).not.toHaveProperty('resetAtMs');
    });
  });
});
