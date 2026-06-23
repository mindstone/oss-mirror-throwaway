// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryUpdateStatus } from '@shared/types';
import { renderHook, act } from '@renderer/test-utils/hookTestHarness';
import { useMemoryUpdateStatus } from '../useMemoryUpdateStatus';
import { useSessionStore } from '../../store/sessionStore';

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

describe('useMemoryUpdateStatus legacy persisted status round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.stubGlobal('window', {
      api: {
        onMemoryUpdateStatus: vi.fn(() => () => undefined),
        memoryUpdate: {
          applyStatusToSession: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
      sessionsApi: {
        upsert: vi.fn().mockResolvedValue({ success: true }),
        delete: vi.fn().mockResolvedValue({ success: true }),
      },
    });
  });

  it('keeps legacy persisted entries readable and preserves them when new same-session statuses are added', () => {
    const sessionId = 'session-legacy-hook';
    const legacyTurnId = 'turn-legacy';

    useSessionStore.setState({
      currentSessionId: sessionId,
      memoryUpdateStatusByTurn: {
        [legacyTurnId]: {
          originalTurnId: legacyTurnId,
          status: 'success',
          summary: 'legacy persisted entry',
          timestamp: Date.now(),
        } as MemoryUpdateStatus,
      },
    });

    const { result } = renderHook(() => useMemoryUpdateStatus());

    expect(result.current.getStatusForTurn(legacyTurnId)).toEqual({
      originalTurnId: legacyTurnId,
      status: 'success',
      summary: 'legacy persisted entry',
      timestamp: expect.any(Number),
    });
    expect(breadcrumbMock).not.toHaveBeenCalled();
    expect(analyticsTrackMock).not.toHaveBeenCalled();

    const nextStatus: MemoryUpdateStatus = {
      originalTurnId: 'turn-new',
      originalSessionId: sessionId,
      status: 'running',
      timestamp: Date.now(),
    };

    act(() => {
      useSessionStore.getState().setMemoryUpdateStatus(nextStatus);
    });

    const latestMap = useSessionStore.getState().memoryUpdateStatusByTurn;
    expect(latestMap[legacyTurnId]).toEqual({
      originalTurnId: legacyTurnId,
      status: 'success',
      summary: 'legacy persisted entry',
      timestamp: expect.any(Number),
    });
    expect(latestMap['turn-new']).toEqual(nextStatus);
    expect(breadcrumbMock).not.toHaveBeenCalled();
    expect(analyticsTrackMock).not.toHaveBeenCalled();
  });
});
