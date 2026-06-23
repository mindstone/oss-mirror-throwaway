// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecentDiagnosticActivitySection } from '../RecentDiagnosticActivitySection';
import type { UseRecentDiagnosticContextResult } from '../../../hooks/useRecentDiagnosticContext';
import type { DiagnosticEventEntry } from '@shared/diagnostics/recentDiagnosticContext';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const useRecentDiagnosticContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/useRecentDiagnosticContext', () => ({
  useRecentDiagnosticContext: useRecentDiagnosticContextMock,
}));

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const event: DiagnosticEventEntry = {
  v: 1,
  ts: Date.now(),
  surface: 'desktop',
  kind: 'known_condition',
  data: {
    condition: 'bridge_recent_events_failure',
    level: 'warning',
  },
};

function hookState(
  overrides: Partial<UseRecentDiagnosticContextResult> = {},
): UseRecentDiagnosticContextResult {
  return {
    status: 'empty',
    events: [],
    logs: '',
    lastFetchedAt: 1_700_000_000_000,
    refresh: vi.fn().mockResolvedValue(undefined),
    copyForSupport: vi.fn().mockResolvedValue(true),
    error: null,
    ...overrides,
  };
}

describe('RecentDiagnosticActivitySection', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders empty state copy when status=empty', () => {
    useRecentDiagnosticContextMock.mockReturnValue(hookState({ status: 'empty' }));

    mounted = mount(<RecentDiagnosticActivitySection />);

    expect(mounted.container.textContent).toContain('All quiet. Nothing notable in the last 24 hours.');
  });

  it('renders error notice and Try again button; click triggers refresh', () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useRecentDiagnosticContextMock.mockReturnValue(hookState({ status: 'error', refresh }));

    mounted = mount(<RecentDiagnosticActivitySection />);

    expect(mounted.container.textContent).toContain(
      "Couldn't load recent activity. Rebel can keep working, but this view is unavailable right now.",
    );
    const tryAgain = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Try again'))!;
    click(tryAgain);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('renders populated list with rows and raw disclosure', () => {
    useRecentDiagnosticContextMock.mockReturnValue(
      hookState({
        status: 'populated',
        events: [event],
        logs: '## Recent diagnostic events\n- one',
      }),
    );

    mounted = mount(<RecentDiagnosticActivitySection />);

    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(mounted.container.textContent).toContain('Known issue: bridge_recent_events_failure');
    expect(mounted.container.textContent).toContain('Show raw event log');
  });

  it('renders every event without duplicate-key warnings when two same-kind events share a millisecond', () => {
    // Regression: two `mcp_transition` events emitted in the same ms with no
    // tid/sid produced identical React keys (`mcp_transition-<ts>--`), spamming
    // console.error and risking dropped/duplicated rows. Caught by the UI smoke
    // test on 2026-06-10. The row key now appends the map index.
    const sharedTs = 1_700_000_000_000;
    const collidingEvents: DiagnosticEventEntry[] = [
      {
        v: 1,
        ts: sharedTs,
        surface: 'desktop',
        kind: 'mcp_transition',
        data: { transition: 'connect', restartCount: 0, consecutiveFailures: 0 },
      },
      {
        v: 1,
        ts: sharedTs,
        surface: 'desktop',
        kind: 'mcp_transition',
        data: { transition: 'disconnect', restartCount: 0, consecutiveFailures: 1 },
      },
    ];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useRecentDiagnosticContextMock.mockReturnValue(
      hookState({ status: 'populated', events: collidingEvents, logs: '## events' }),
    );

    mounted = mount(<RecentDiagnosticActivitySection />);

    // Both rows render...
    expect(mounted.container.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    // ...and React emitted no duplicate-key warning.
    const duplicateKeyWarning = errorSpy.mock.calls.some((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('same key')),
    );
    expect(duplicateKeyWarning).toBe(false);

    errorSpy.mockRestore();
  });

  it('readerUnavailable renders distinct degraded notice (not the empty-state copy)', () => {
    useRecentDiagnosticContextMock.mockReturnValue(hookState({ status: 'readerUnavailable' }));

    mounted = mount(<RecentDiagnosticActivitySection />);

    expect(mounted.container.textContent).toContain("Recent activity isn't available on this surface");
    expect(mounted.container.textContent).not.toContain('All quiet. Nothing notable in the last 24 hours.');
  });
});
