// @vitest-environment happy-dom
/**
 * Tests for useContributionNotifications hook — P6 notification wiring.
 *
 * Validates:
 * - VAL-NOTIFY-001: PRApprovedBanner shows for approved/published
 * - VAL-NOTIFY-002: MCPNotificationCard in drawer for status transitions
 * - VAL-NOTIFY-003: Banner dismissal doesn't suppress drawer
 * - VAL-NOTIFY-004: Drawer dismissal doesn't suppress banner
 * - VAL-NOTIFY-005: acknowledgedEvents tracks correctly
 * - VAL-NOTIFY-006: Both surfaces show notifications
 * - VAL-CROSS-002: Store feeds all downstream consumers
 * - VAL-CROSS-004: Notification lifecycle from submission to dismissal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

// ─── Mock contribution IPC ──────────────────────────────────────────

const mockList = vi.fn();
const mockDismiss = vi.fn();

(window as any).contributionApi = {
  list: (...args: unknown[]) => mockList(...args),
  dismiss: (...args: unknown[]) => mockDismiss(...args),
};

// Enable React act() environment
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { useContributionNotifications } from '../useContributionNotifications';

// ── Minimal renderHook ──────────────────────────────────────────────

type RenderHookResult<T, P> = {
  result: { current: T };
  unmount: () => void;
  getRenderCount: () => number;
  rerender: (nextProps: P) => void;
};

function renderHookWithProps<T, P>(
  hookFn: (props: P) => T,
  initialProps: P,
): RenderHookResult<T, P> {
  const result = { current: undefined as unknown as T };
  let renderCount = 0;
  let currentProps = initialProps;

  const TestComponent = ({ hookProps }: { hookProps: P }) => {
    renderCount += 1;
    result.current = hookFn(hookProps);
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: any;

  reactAct(() => {
    root = ReactDOMClient.createRoot(container);
    root.render(React.createElement(TestComponent, { hookProps: currentProps }));
  });

  return {
    result,
    getRenderCount: () => renderCount,
    rerender: (nextProps: P) => {
      currentProps = nextProps;
      reactAct(() => {
        root.render(React.createElement(TestComponent, { hookProps: currentProps }));
      });
    },
    unmount: () => {
      reactAct(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

function renderHook<T>(
  hookFn: () => T,
): RenderHookResult<T, undefined> {
  return renderHookWithProps<T, undefined>(() => hookFn(), undefined);
}

// ── Helpers ─────────────────────────────────────────────────────────

function makeContribution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contrib-1',
    sessionId: 'session-1',
    connectorName: 'my-connector',
    status: 'draft',
    attributionMode: 'github',
    acknowledgedEvents: [],
    createdAt: '2026-04-10T00:00:00Z',
    updatedAt: '2026-04-10T00:00:00Z',
    ...overrides,
  };
}

// ── Setup / Teardown ────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  mockList.mockReset();
  mockDismiss.mockReset();
  mockList.mockResolvedValue({ contributions: [] });
  mockDismiss.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('useContributionNotifications', () => {
  describe('VAL-NOTIFY-001: PRApprovedBanner shows for approved/published', () => {
    it('returns bannerProps for approved contribution not dismissed on banner', async () => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'approved' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps).not.toBeNull();
      expect(result.current.bannerProps?.connectorName).toBe('my-connector');
      expect(result.current.bannerProps?.onDismiss).toBeInstanceOf(Function);
      unmount();
    });

    it('returns bannerProps for published contribution not dismissed on banner', async () => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'published' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps).not.toBeNull();
      expect(result.current.bannerProps?.connectorName).toBe('my-connector');
      unmount();
    });

    it('returns null bannerProps when approved contribution is dismissed on banner', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({
            status: 'approved',
            acknowledgedEvents: [{ status: 'approved', surface: 'banner', at: '2026-04-10T01:00:00Z' }],
          }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps).toBeNull();
      unmount();
    });

    it('returns null bannerProps for non-approved/non-published statuses', async () => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'submitted' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps).toBeNull();
      unmount();
    });
  });

  describe('VAL-NOTIFY-002: MCPNotificationCard in drawer for status transitions', () => {
    it.each([
      ['ci_pass', 'ci-pass'],
      ['ci_fail', 'ci-fail'],
      ['approved', 'approved'],
      ['changes_requested', 'changes-requested'],
      ['rejected', 'rejected'],
    ] as const)('returns drawer notification for %s status (maps to %s)', async (status, expectedState) => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.drawerNotifications.length).toBe(1);
      expect(result.current.drawerNotifications[0].state).toBe(expectedState);
      expect(result.current.drawerNotifications[0].connectorName).toBe('my-connector');
      unmount();
    });

    it('returns no drawer notifications for draft/testing/ready_to_submit statuses', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({ id: 'c1', status: 'draft' }),
          makeContribution({ id: 'c2', status: 'testing' }),
          makeContribution({ id: 'c3', status: 'ready_to_submit' }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.drawerNotifications.length).toBe(0);
      unmount();
    });

    it('returns no drawer notifications when status is dismissed on drawer', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({
            status: 'ci_pass',
            acknowledgedEvents: [{ status: 'ci_pass', surface: 'drawer', at: '2026-04-10T01:00:00Z' }],
          }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.drawerNotifications.length).toBe(0);
      unmount();
    });
  });

  describe('VAL-NOTIFY-003: Banner dismissal does not suppress drawer', () => {
    it('drawer notifications remain after banner dismissal', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({
            status: 'approved',
            acknowledgedEvents: [{ status: 'approved', surface: 'banner', at: '2026-04-10T01:00:00Z' }],
          }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Banner is dismissed
      expect(result.current.bannerProps).toBeNull();
      // Drawer notification is still there (approved shows in drawer)
      expect(result.current.drawerNotifications.length).toBe(1);
      expect(result.current.drawerNotifications[0].state).toBe('approved');
      unmount();
    });
  });

  describe('VAL-NOTIFY-004: Drawer dismissal does not suppress banner', () => {
    it('banner remains after drawer dismissal', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({
            status: 'approved',
            acknowledgedEvents: [{ status: 'approved', surface: 'drawer', at: '2026-04-10T01:00:00Z' }],
          }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Drawer notification is dismissed
      expect(result.current.drawerNotifications.length).toBe(0);
      // Banner is still showing
      expect(result.current.bannerProps).not.toBeNull();
      expect(result.current.bannerProps?.connectorName).toBe('my-connector');
      unmount();
    });
  });

  describe('VAL-NOTIFY-005: acknowledgedEvents tracks correctly', () => {
    it('dismissBanner sends correct IPC call with banner surface', async () => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'approved' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Dismiss the banner
      reactAct(() => {
        result.current.dismissBanner('contrib-1', 'approved');
      });

      expect(mockDismiss).toHaveBeenCalledWith({
        contributionId: 'contrib-1',
        status: 'approved',
        surface: 'banner',
      });
      unmount();
    });

    it('dismissDrawer sends correct IPC call with drawer surface', async () => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'ci_pass' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Dismiss drawer notification
      reactAct(() => {
        result.current.dismissDrawer('contrib-1', 'ci_pass');
      });

      expect(mockDismiss).toHaveBeenCalledWith({
        contributionId: 'contrib-1',
        status: 'ci_pass',
        surface: 'drawer',
      });
      unmount();
    });

    it('optimistic update immediately removes banner after dismissBanner', async () => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'approved' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps).not.toBeNull();

      reactAct(() => {
        result.current.bannerProps?.onDismiss?.();
      });

      // Optimistic update: banner should be null immediately
      expect(result.current.bannerProps).toBeNull();
      unmount();
    });

    it('optimistic update immediately removes drawer notification after dismissDrawer', async () => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'ci_pass' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.drawerNotifications.length).toBe(1);

      reactAct(() => {
        result.current.dismissDrawer('contrib-1', 'ci_pass');
      });

      // Optimistic update: drawer notification should be gone
      expect(result.current.drawerNotifications.length).toBe(0);
      unmount();
    });
  });

  describe('VAL-NOTIFY-006: Both surfaces show notifications', () => {
    it('approved contribution appears in both banner and drawer', async () => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'approved' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Banner shows
      expect(result.current.bannerProps).not.toBeNull();
      // Drawer also shows
      expect(result.current.drawerNotifications.length).toBe(1);
      expect(result.current.drawerNotifications[0].state).toBe('approved');
      unmount();
    });

    it('ci_pass appears only in drawer (not in banner)', async () => {
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'ci_pass' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps).toBeNull();
      expect(result.current.drawerNotifications.length).toBe(1);
      unmount();
    });
  });

  describe('VAL-CROSS-002: Store feeds all downstream consumers', () => {
    it('store update propagates to both banner and drawer derivations', async () => {
      // Start with submitted status (no banner, no drawer notification)
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'submitted' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps).toBeNull();
      expect(result.current.drawerNotifications.length).toBe(0);

      // Update to approved status (should appear in both)
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'approved' })],
      });

      // Advance timer to trigger next poll
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(3000); });

      expect(result.current.bannerProps).not.toBeNull();
      expect(result.current.drawerNotifications.length).toBe(1);
      unmount();
    });
  });

  describe('VAL-CROSS-004: Notification lifecycle from submission to dismissal', () => {
    it('full lifecycle: submitted → approved → banner dismiss → drawer shows → drawer dismiss → both gone', async () => {
      // Start with submitted
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'submitted' })],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps).toBeNull();
      expect(result.current.drawerNotifications.length).toBe(0);

      // Status transport updates to approved
      mockList.mockResolvedValue({
        contributions: [makeContribution({ status: 'approved' })],
      });
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(3000); });

      // Both surfaces show
      expect(result.current.bannerProps).not.toBeNull();
      expect(result.current.drawerNotifications.length).toBe(1);

      // User dismisses banner
      reactAct(() => {
        result.current.bannerProps?.onDismiss?.();
      });

      // Banner gone, drawer remains
      expect(result.current.bannerProps).toBeNull();
      expect(result.current.drawerNotifications.length).toBe(1);

      // User dismisses drawer
      reactAct(() => {
        result.current.dismissDrawer('contrib-1', 'approved');
      });

      // Both gone
      expect(result.current.bannerProps).toBeNull();
      expect(result.current.drawerNotifications.length).toBe(0);
      unmount();
    });
  });

  describe('Stage 3 polling contracts', () => {
    it('dedupes identical poll payloads and avoids an extra render', async () => {
      mockList
        .mockResolvedValueOnce({
          contributions: [
            makeContribution({
              id: 'same',
              status: 'approved',
              updatedAt: '2026-04-10T00:00:00Z',
            }),
          ],
        })
        .mockResolvedValueOnce({
          contributions: [
            makeContribution({
              id: 'same',
              status: 'approved',
              updatedAt: '2026-04-10T00:00:00Z',
            }),
          ],
        });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      const firstDrawerRef = result.current.drawerNotifications;

      await reactAct(async () => { await vi.advanceTimersByTimeAsync(3000); });

      expect(mockList).toHaveBeenCalledTimes(2);
      expect(result.current.drawerNotifications).toBe(firstDrawerRef);
      unmount();
    });

    it('updates state when poll payload identity changes', async () => {
      mockList
        .mockResolvedValueOnce({
          contributions: [
            makeContribution({
              id: 'same',
              status: 'approved',
              updatedAt: '2026-04-10T00:00:00Z',
            }),
          ],
        })
        .mockResolvedValueOnce({
          contributions: [
            makeContribution({
              id: 'same',
              status: 'changes_requested',
              updatedAt: '2026-04-10T00:00:01Z',
            }),
          ],
        });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      const firstDrawerRef = result.current.drawerNotifications;

      await reactAct(async () => { await vi.advanceTimersByTimeAsync(3000); });

      expect(mockList).toHaveBeenCalledTimes(2);
      expect(result.current.drawerNotifications).not.toBe(firstDrawerRef);
      expect(result.current.drawerNotifications[0]?.contributionStatus).toBe('changes_requested');
      unmount();
    });

    it('starts paused when disabled and resumes polling after enable', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({ id: 'resume', status: 'approved', updatedAt: '2026-04-10T00:00:00Z' }),
        ],
      });

      const { unmount, rerender } = renderHookWithProps(
        (enabled: boolean) => useContributionNotifications(enabled),
        false as boolean,
      );

      await reactAct(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(mockList).not.toHaveBeenCalled();

      rerender(true);
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(mockList).toHaveBeenCalledTimes(1);

      await reactAct(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(mockList).toHaveBeenCalledTimes(2);
      unmount();
    });
  });

  describe('multiple contributions', () => {
    it('handles multiple contributions with different statuses', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({ id: 'c1', status: 'approved', connectorName: 'connector-a' }),
          makeContribution({ id: 'c2', status: 'ci_fail', connectorName: 'connector-b' }),
          makeContribution({ id: 'c3', status: 'draft', connectorName: 'connector-c' }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Banner shows first approved contribution
      expect(result.current.bannerProps?.connectorName).toBe('connector-a');
      // Drawer shows approved + ci_fail (not draft)
      expect(result.current.drawerNotifications.length).toBe(2);
      unmount();
    });
  });

  describe('banner sorts by recency (newest approved/published first)', () => {
    it('shows the most recently updated approved contribution in the banner', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({
            id: 'older',
            status: 'approved',
            connectorName: 'older-connector',
            updatedAt: '2026-04-08T00:00:00Z',
          }),
          makeContribution({
            id: 'newer',
            status: 'approved',
            connectorName: 'newer-connector',
            updatedAt: '2026-04-10T00:00:00Z',
          }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps?.connectorName).toBe('newer-connector');
      unmount();
    });

    it('shows the most recently updated published contribution over older approved', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({
            id: 'old-approved',
            status: 'approved',
            connectorName: 'old-approved-connector',
            updatedAt: '2026-04-05T00:00:00Z',
          }),
          makeContribution({
            id: 'recent-published',
            status: 'published',
            connectorName: 'recent-published-connector',
            updatedAt: '2026-04-10T12:00:00Z',
          }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.bannerProps?.connectorName).toBe('recent-published-connector');
      unmount();
    });

    it('falls back gracefully when updatedAt is missing', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({
            id: 'no-date',
            status: 'approved',
            connectorName: 'no-date-connector',
          }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Should still render a banner for the single eligible contribution
      expect(result.current.bannerProps?.connectorName).toBe('no-date-connector');
      unmount();
    });
  });

  describe('enabled flag', () => {
    it('does not fetch when enabled is false', async () => {
      mockList.mockClear();
      const { result, unmount } = renderHook(() => useContributionNotifications(false));

      // No IPC call when disabled
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(mockList).not.toHaveBeenCalled();
      expect(result.current.bannerProps).toBeNull();
      expect(result.current.drawerNotifications.length).toBe(0);
      unmount();
    });
  });

  describe('review notes and PR URL passthrough', () => {
    it('passes reviewNotes and prUrl to notification items', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({
            status: 'changes_requested',
            reviewNotes: 'Please fix the tests',
            prUrl: 'https://github.com/org/repo/pull/42',
          }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.drawerNotifications[0].reviewNotes).toBe('Please fix the tests');
      expect(result.current.drawerNotifications[0].prUrl).toBe('https://github.com/org/repo/pull/42');
      unmount();
    });

    it('passes sessionId to notification items', async () => {
      mockList.mockResolvedValue({
        contributions: [
          makeContribution({
            status: 'approved',
            sessionId: 'session-original-build',
          }),
        ],
      });

      const { result, unmount } = renderHook(() => useContributionNotifications());
      await reactAct(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(result.current.drawerNotifications[0].sessionId).toBe('session-original-build');
      unmount();
    });
  });
});
