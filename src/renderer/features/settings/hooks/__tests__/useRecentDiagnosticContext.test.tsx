// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRecentDiagnosticContext } from '../useRecentDiagnosticContext';
import type { UseRecentDiagnosticContextResult } from '../useRecentDiagnosticContext';
import type {
  DiagnosticEventEntry,
  RecentDiagnosticContext,
} from '@shared/diagnostics/recentDiagnosticContext';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

let latest: UseRecentDiagnosticContextResult | null = null;

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

function Harness() {
  latest = useRecentDiagnosticContext();
  return (
    <button type="button" onClick={() => void latest?.refresh()}>
      refresh
    </button>
  );
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installDiagnosticsApi(getRecentContext = vi.fn()) {
  Object.defineProperty(window, 'diagnosticsApi', {
    value: { getRecentContext },
    configurable: true,
  });
  return getRecentContext;
}

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

const event: DiagnosticEventEntry = {
  v: 1,
  ts: 1_700_000_000_000,
  surface: 'desktop',
  kind: 'known_condition',
  data: {
    condition: 'bridge_recent_events_failure',
    level: 'warning',
  },
};

function context(overrides: Partial<RecentDiagnosticContext> = {}): RecentDiagnosticContext {
  return {
    windowHours: 24,
    limit: 5,
    nowMs: 1_700_000_100_000,
    counts: { known_condition: 1 },
    lastTimes: { known_condition: event.ts },
    entriesByKind: { known_condition: [event] },
    totalEvents: 1,
    readerAvailable: true,
    ...overrides,
  };
}

describe('useRecentDiagnosticContext', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    latest = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('transitions from loading to populated', async () => {
    installDiagnosticsApi(vi.fn().mockResolvedValue(context()));

    mounted = mount(<Harness />);

    expect(latest?.status).toBe('loading');
    await flushAsync();

    expect(latest?.status).toBe('populated');
    expect(latest?.events).toHaveLength(1);
    expect(latest?.logs).toContain('Recent diagnostic events');
  });

  it('sets status=error when getRecentContext throws', async () => {
    installDiagnosticsApi(vi.fn().mockRejectedValue(new Error('boom')));

    mounted = mount(<Harness />);
    await flushAsync();

    expect(latest?.status).toBe('error');
    expect(latest?.error?.message).toBe('boom');
  });

  it('sets status=readerUnavailable when the reader is unavailable and no events exist', async () => {
    installDiagnosticsApi(
      vi.fn().mockResolvedValue(context({
        counts: null,
        lastTimes: null,
        entriesByKind: {},
        totalEvents: 0,
        readerAvailable: false,
      })),
    );

    mounted = mount(<Harness />);
    await flushAsync();

    expect(latest?.status).toBe('readerUnavailable');
  });

  it('sets status=empty when no events exist and reader is available', async () => {
    installDiagnosticsApi(
      vi.fn().mockResolvedValue(context({
        counts: null,
        lastTimes: null,
        entriesByKind: {},
        totalEvents: 0,
        readerAvailable: true,
      })),
    );

    mounted = mount(<Harness />);
    await flushAsync();

    expect(latest?.status).toBe('empty');
  });

  it('refresh re-fetches recent context', async () => {
    const getRecentContext = installDiagnosticsApi(
      vi.fn()
        .mockResolvedValueOnce(context({
          counts: null,
          lastTimes: null,
          entriesByKind: {},
          totalEvents: 0,
        }))
        .mockResolvedValueOnce(context()),
    );

    mounted = mount(<Harness />);
    await flushAsync();
    expect(latest?.status).toBe('empty');

    await act(async () => {
      await latest?.refresh();
    });

    expect(getRecentContext).toHaveBeenCalledTimes(2);
    expect(latest?.status).toBe('populated');
  });

  it('copyForSupport writes markdown with window and timestamp', async () => {
    installDiagnosticsApi(vi.fn().mockResolvedValue(context()));
    const writeText = installClipboard();

    mounted = mount(<Harness />);
    await flushAsync();

    await act(async () => {
      await latest?.copyForSupport();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const markdown = writeText.mock.calls[0][0] as string;
    expect(markdown).toContain('Window: Last 24h');
    expect(markdown).toContain('Captured at:');
    expect(markdown).toContain('Status: populated');
    expect(markdown).toContain('Recent diagnostic events');
  });

  it('copyForSupport produces a degraded body when readerUnavailable (not "All quiet")', async () => {
    installDiagnosticsApi(
      vi.fn().mockResolvedValue(context({
        counts: null,
        lastTimes: null,
        entriesByKind: {},
        totalEvents: 0,
        readerAvailable: false,
      })),
    );
    const writeText = installClipboard();

    mounted = mount(<Harness />);
    await flushAsync();

    await act(async () => {
      await latest?.copyForSupport();
    });

    const markdown = writeText.mock.calls[0][0] as string;
    expect(markdown).toContain('Status: readerUnavailable');
    expect(markdown).toContain("isn't available on this surface");
    expect(markdown).not.toContain('All quiet');
  });

  it('copyForSupport produces an explicit error body when status=error', async () => {
    installDiagnosticsApi(vi.fn().mockRejectedValue(new Error('boom')));
    const writeText = installClipboard();

    mounted = mount(<Harness />);
    await flushAsync();

    await act(async () => {
      await latest?.copyForSupport();
    });

    const markdown = writeText.mock.calls[0][0] as string;
    expect(markdown).toContain('Status: error');
    expect(markdown).toContain("Couldn't read recent activity");
    expect(markdown).not.toContain('All quiet');
  });
});
