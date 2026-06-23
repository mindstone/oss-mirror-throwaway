// @vitest-environment happy-dom
/**
 * Tests for useConnectorContribution hook.
 *
 * Follows the same pattern as useMcpBuildCardState.test.ts:
 * - Mock window.contributionApi
 * - Minimal renderHook without @testing-library/react
 * - Stale-request guard tests
 *
 * @see docs/plans/260414_p8_contribution_status_settings_card.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

// ─── Mock contribution IPC ──────────────────────────────────────────

const mockList = vi.fn();

// Mock window.contributionApi
(window as any).contributionApi = {
  list: (...args: unknown[]) => mockList(...args),
};

// Enable React act() environment
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { useConnectorContribution } from '../hooks/useConnectorContribution';
import type { ConnectorContribution } from '../hooks/useConnectorContribution';

// ── Minimal renderHook (same pattern as useMcpBuildCardState.test.ts) ───

function renderHook<P, T>(
  hookFn: (props: P) => T,
  options?: { initialProps?: P },
): { result: { current: T }; rerender: (props: P) => void; unmount: () => void } {
  const result = { current: undefined as unknown as T };

  const TestComponent = (props: P) => {
    result.current = hookFn(props);
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(React.createElement(TestComponent as any, options?.initialProps ?? {}));
  });

  return {
    result,
    rerender: (props: P) => {
      reactAct(() => {
        root.render(React.createElement(TestComponent as any, props as any));
      });
    },
    unmount: () => {
      reactAct(() => { root.unmount(); });
      container.remove();
    },
  };
}

/** Flush pending promises and microtasks within act(). */
async function flushAsync() {
  await reactAct(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── Helper wrapper for the hook (takes props object) ───────────────

function useHookWrapper(props: { connectorName: string | null | undefined }) {
  return useConnectorContribution(props.connectorName);
}

// ─── Factory helper ─────────────────────────────────────────────────

function makeContribution(
  overrides: Partial<ConnectorContribution> = {},
): ConnectorContribution {
  return {
    id: 'contrib-1',
    sessionId: 'session-1',
    linkedSessionIds: ['session-1'],
    connectorName: 'my-connector',
    attributionMode: 'anonymous',
    status: 'draft',
    acknowledgedEvents: [],
    createdAt: '2026-04-14T00:00:00Z',
    updatedAt: '2026-04-14T00:00:00Z',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('useConnectorContribution', () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it('returns null contribution when connectorName is null', () => {
    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: null },
    });
    expect(result.current.contribution).toBeNull();
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('returns null contribution when connectorName is undefined', () => {
    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: undefined },
    });
    expect(result.current.contribution).toBeNull();
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('returns null when no contribution exists for the connector', async () => {
    mockList.mockResolvedValue({ contributions: [] });

    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: 'unknown-connector' },
    });

    await flushAsync();

    expect(mockList).toHaveBeenCalledWith({});
    expect(result.current.contribution).toBeNull();
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('returns the matching contribution for a given connector name', async () => {
    const contribution = makeContribution({ connectorName: 'my-connector', status: 'testing' });
    mockList.mockResolvedValue({
      contributions: [
        makeContribution({ connectorName: 'other-connector' }),
        contribution,
      ],
    });

    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: 'my-connector' },
    });

    await flushAsync();

    expect(result.current.contribution).toEqual(contribution);
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('returns the most recently updated contribution when multiple exist', async () => {
    const older = makeContribution({
      id: 'contrib-old',
      connectorName: 'my-connector',
      status: 'draft',
      updatedAt: '2026-04-13T00:00:00Z',
    });
    const newer = makeContribution({
      id: 'contrib-new',
      connectorName: 'my-connector',
      status: 'submitted',
      updatedAt: '2026-04-14T12:00:00Z',
    });
    mockList.mockResolvedValue({
      contributions: [older, newer],
    });

    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: 'my-connector' },
    });

    await flushAsync();

    expect(result.current.contribution?.id).toBe('contrib-new');
    unmount();
  });

  it('matches contribution case-insensitively (catalog Humaans vs store humaans)', async () => {
    const contribution = makeContribution({ connectorName: 'humaans', status: 'submitted' });
    mockList.mockResolvedValue({ contributions: [contribution] });

    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: 'Humaans' },
    });

    await flushAsync();

    expect(result.current.contribution).toEqual(contribution);
    unmount();
  });

  it('does not crash on IPC failure', async () => {
    mockList.mockRejectedValue(new Error('IPC failed'));

    const { result, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: 'my-connector' },
    });

    await flushAsync();

    expect(mockList).toHaveBeenCalled();
    expect(result.current.contribution).toBeNull();
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('does NOT poll — only fetches once on mount', async () => {
    mockList.mockResolvedValue({ contributions: [] });

    const { unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: 'my-connector' },
    });

    await flushAsync();

    expect(mockList).toHaveBeenCalledTimes(1);
    unmount();
  });

  // ── Stale-response race condition tests ──────────────────────────

  it('discards stale fetch when connectorName switches before response arrives', async () => {
    let resolveFirst: (value: any) => void;
    const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });

    mockList.mockImplementation(async () => {
      // First call returns a slow promise, second resolves immediately
      if (mockList.mock.calls.length <= 1) {
        return firstPromise;
      }
      return {
        contributions: [
          makeContribution({ connectorName: 'second-connector', status: 'submitted' }),
        ],
      };
    });

    const { result, rerender, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: 'first-connector' },
    });

    // Switch to second connector before first fetch resolves
    rerender({ connectorName: 'second-connector' });
    await flushAsync();

    // second-connector resolved immediately
    expect(result.current.contribution?.connectorName).toBe('second-connector');

    // Now first fetch finally resolves — should be discarded
    resolveFirst!({
      contributions: [
        makeContribution({ connectorName: 'first-connector', status: 'draft' }),
      ],
    });
    await flushAsync();

    // State must still reflect second-connector, not the stale first response
    expect(result.current.contribution?.connectorName).toBe('second-connector');
    unmount();
  });

  it('clears contribution when switching to null connectorName', async () => {
    mockList.mockResolvedValue({
      contributions: [makeContribution({ connectorName: 'my-connector' })],
    });

    const { result, rerender, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: 'my-connector' as string | null },
    });

    await flushAsync();
    expect(result.current.contribution).not.toBeNull();

    // Switch to null
    rerender({ connectorName: null });

    // Should clear immediately
    expect(result.current.contribution).toBeNull();
    unmount();
  });

  it('re-fetches when connectorName changes', async () => {
    mockList.mockResolvedValue({
      contributions: [
        makeContribution({ connectorName: 'connector-a', status: 'draft' }),
        makeContribution({ connectorName: 'connector-b', status: 'submitted' }),
      ],
    });

    const { result, rerender, unmount } = renderHook(useHookWrapper, {
      initialProps: { connectorName: 'connector-a' },
    });

    await flushAsync();
    expect(result.current.contribution?.connectorName).toBe('connector-a');

    // Switch connector
    rerender({ connectorName: 'connector-b' });
    await flushAsync();

    expect(result.current.contribution?.connectorName).toBe('connector-b');
    expect(mockList).toHaveBeenCalledTimes(2);
    unmount();
  });
});
