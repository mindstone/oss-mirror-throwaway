 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryUpdateStatus, TimeSavedStatus } from '@shared/types';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';

const { analyticsTrackMock, breadcrumbMock } = vi.hoisted(() => ({
  analyticsTrackMock: vi.fn(),
  breadcrumbMock: vi.fn(),
}));

vi.mock('@renderer/src/analytics', () => ({
  analytics: {
    track: (...args: unknown[]) => analyticsTrackMock(...args),
  },
}));

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: (...args: unknown[]) => breadcrumbMock(...args),
}));

import { routeIncomingMemoryUpdateStatus } from '../useMemoryUpdateStatus';
import { routeIncomingTimeSavedStatus } from '../useTimeSavedStatus';

describe('status routing cross-session guards', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('memory update status routing', () => {
    // 260619: memory status is no longer persisted from the renderer — the
    // executing surface persists the terminal state in core
    // (memoryUpdateService.persistTerminalMemoryStatus). The renderer routing is
    // now in-memory only; these tests assert the store setters, not IPC persist.
    it('applies status to the active-session in-memory store when provenance matches', () => {
      const setMemoryUpdateStatus = vi.fn();
      const setMemoryUpdateStatusForSession = vi.fn();
      const status: MemoryUpdateStatus = {
        originalTurnId: 'turn-1',
        originalSessionId: 'session-a',
        status: 'running',
        timestamp: Date.now(),
      };

      const routed = routeIncomingMemoryUpdateStatus({
        status,
        activeSessionId: 'session-a',
        setMemoryUpdateStatus,
        setMemoryUpdateStatusForSession,
      });

      expect(routed).toBe('applied-active');
      expect(setMemoryUpdateStatus).toHaveBeenCalledWith(status);
      expect(setMemoryUpdateStatusForSession).not.toHaveBeenCalled();
    });

    it('routes mismatched provenance to the per-session in-memory store and emits hashed telemetry', () => {
      const setMemoryUpdateStatus = vi.fn();
      const setMemoryUpdateStatusForSession = vi.fn();
      const status: MemoryUpdateStatus = {
        originalTurnId: 'turn-cross',
        originalSessionId: 'session-origin',
        status: 'success',
        timestamp: Date.now(),
      };

      const routed = routeIncomingMemoryUpdateStatus({
        status,
        activeSessionId: 'session-active',
        setMemoryUpdateStatus,
        setMemoryUpdateStatusForSession,
      });

      expect(routed).toBe('routed-cross-session');
      expect(setMemoryUpdateStatus).not.toHaveBeenCalled();
      expect(setMemoryUpdateStatusForSession).toHaveBeenCalledWith('session-origin', status);

      expect(analyticsTrackMock).toHaveBeenCalledWith(
        'memoryUpdate.crossSessionRoutingRejected',
        expect.objectContaining({
          activeSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
          originalSessionIdHash: hashSessionIdForBreadcrumb('session-origin'),
          turnIdHash: hashSessionIdForBreadcrumb('turn-cross'),
        }),
      );
      expect(breadcrumbMock).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'cross-session-routing-rejected',
          data: expect.objectContaining({
            activeSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
            originalSessionIdHash: hashSessionIdForBreadcrumb('session-origin'),
            turnIdHash: hashSessionIdForBreadcrumb('turn-cross'),
          }),
        }),
      );
      const analyticsPayload = analyticsTrackMock.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(Object.values(analyticsPayload)).not.toContain('session-active');
      expect(Object.values(analyticsPayload)).not.toContain('session-origin');
    });

    it('drops legacy broadcasts without originalSessionId and emits telemetry', () => {
      const setMemoryUpdateStatus = vi.fn();
      const setMemoryUpdateStatusForSession = vi.fn();
      const status: MemoryUpdateStatus = {
        originalTurnId: 'turn-legacy',
        status: 'error',
        error: 'legacy',
        timestamp: Date.now(),
      };

      const routed = routeIncomingMemoryUpdateStatus({
        status,
        activeSessionId: 'session-active',
        setMemoryUpdateStatus,
        setMemoryUpdateStatusForSession,
      });

      expect(routed).toBe('dropped-legacy');
      expect(setMemoryUpdateStatus).not.toHaveBeenCalled();
      expect(setMemoryUpdateStatusForSession).not.toHaveBeenCalled();
      expect(analyticsTrackMock).toHaveBeenCalledWith(
        'memoryUpdate.legacyBroadcastWithoutOriginalSessionId',
        expect.objectContaining({
          activeSessionIdHash: hashSessionIdForBreadcrumb('session-active'),
          turnIdHash: hashSessionIdForBreadcrumb('turn-legacy'),
        }),
      );
    });
  });

  describe('time saved status routing', () => {
    it('applies same-session statuses and still persists via IPC', () => {
      const setTimeSavedStatus = vi.fn();
      const setTimeSavedStatusForSession = vi.fn();
      const applyStatusToSession = vi.fn().mockResolvedValue({ ok: true });
      const status: TimeSavedStatus = {
        turnId: 'ts-turn-active',
        originalSessionId: 'session-active-ts',
        status: 'running',
        timestamp: Date.now(),
      };

      const routed = routeIncomingTimeSavedStatus({
        status,
        activeSessionId: 'session-active-ts',
        setTimeSavedStatus,
        setTimeSavedStatusForSession,
        applyStatusToSession,
      });

      expect(routed).toBe('applied-active');
      expect(setTimeSavedStatus).toHaveBeenCalledWith(status);
      expect(setTimeSavedStatusForSession).not.toHaveBeenCalled();
      expect(applyStatusToSession).toHaveBeenCalledWith({
        sessionId: 'session-active-ts',
        turnId: 'ts-turn-active',
        status,
      });
    });

    it('routes mismatched provenance through IPC and keeps active session clean', () => {
      const setTimeSavedStatus = vi.fn();
      const setTimeSavedStatusForSession = vi.fn();
      const applyStatusToSession = vi.fn().mockResolvedValue({ ok: true });
      const status: TimeSavedStatus = {
        turnId: 'ts-turn-1',
        originalSessionId: 'session-origin-ts',
        status: 'success',
        estimate: {
          lowMinutes: 5,
          highMinutes: 8,
          confidence: 'medium',
          taskType: 'writing',
        },
        timestamp: Date.now(),
      };

      const routed = routeIncomingTimeSavedStatus({
        status,
        activeSessionId: 'session-active-ts',
        setTimeSavedStatus,
        setTimeSavedStatusForSession,
        applyStatusToSession,
      });

      expect(routed).toBe('routed-cross-session');
      expect(setTimeSavedStatus).not.toHaveBeenCalled();
      expect(setTimeSavedStatusForSession).toHaveBeenCalledWith('session-origin-ts', status);
      expect(applyStatusToSession).toHaveBeenCalledWith({
        sessionId: 'session-origin-ts',
        turnId: 'ts-turn-1',
        status,
      });
      expect(analyticsTrackMock).toHaveBeenCalledWith(
        'timeSaved.crossSessionRoutingRejected',
        expect.objectContaining({
          activeSessionIdHash: hashSessionIdForBreadcrumb('session-active-ts'),
          originalSessionIdHash: hashSessionIdForBreadcrumb('session-origin-ts'),
          turnIdHash: hashSessionIdForBreadcrumb('ts-turn-1'),
        }),
      );
    });

    it('drops legacy time-saved broadcasts without provenance', () => {
      const setTimeSavedStatus = vi.fn();
      const setTimeSavedStatusForSession = vi.fn();
      const applyStatusToSession = vi.fn();
      const status: TimeSavedStatus = {
        turnId: 'ts-legacy',
        status: 'error',
        error: 'legacy',
        timestamp: Date.now(),
      };

      const routed = routeIncomingTimeSavedStatus({
        status,
        activeSessionId: 'session-active-ts',
        setTimeSavedStatus,
        setTimeSavedStatusForSession,
        applyStatusToSession,
      });

      expect(routed).toBe('dropped-legacy');
      expect(setTimeSavedStatus).not.toHaveBeenCalled();
      expect(setTimeSavedStatusForSession).not.toHaveBeenCalled();
      expect(applyStatusToSession).not.toHaveBeenCalled();
      expect(analyticsTrackMock).toHaveBeenCalledWith(
        'timeSaved.legacyBroadcastWithoutOriginalSessionId',
        expect.objectContaining({
          activeSessionIdHash: hashSessionIdForBreadcrumb('session-active-ts'),
          turnIdHash: hashSessionIdForBreadcrumb('ts-legacy'),
        }),
      );
    });
  });
});
