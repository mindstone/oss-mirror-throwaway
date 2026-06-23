// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BugReportDialog } from '../BugReportDialog';
import type {
  DiagnosticEventEntry,
  RecentDiagnosticContext,
} from '@shared/diagnostics/recentDiagnosticContext';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installWindowApis(getRecentContext = vi.fn().mockResolvedValue(context())) {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const submitBug = vi.fn().mockResolvedValue({ outcome: 'accepted' });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  Object.defineProperty(window, 'diagnosticsApi', {
    value: { getRecentContext },
    configurable: true,
  });
  Object.defineProperty(window, 'settingsApi', {
    value: { mcpSummary: vi.fn().mockResolvedValue({ servers: [] }) },
    configurable: true,
  });
  Object.defineProperty(window, 'electronEnv', {
    value: { appVersion: '1.2.3', platform: 'darwin', arch: 'arm64' },
    configurable: true,
  });
  Object.defineProperty(window, 'appApi', {
    value: { openUrl: vi.fn() },
    configurable: true,
  });
  Object.defineProperty(window, 'bugReportApi', {
    value: { submitBug, submitFeedback: vi.fn() },
    configurable: true,
  });
  return { writeText, getRecentContext, submitBug };
}

function emptyContext(overrides: Partial<RecentDiagnosticContext> = {}): RecentDiagnosticContext {
  return {
    windowHours: 24,
    limit: 5,
    nowMs: 1_700_000_100_000,
    counts: null,
    lastTimes: null,
    entriesByKind: {},
    totalEvents: 0,
    readerAvailable: true,
    ...overrides,
  };
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

function context(): RecentDiagnosticContext {
  return {
    windowHours: 24,
    limit: 5,
    nowMs: 1_700_000_100_000,
    counts: { known_condition: 1 },
    lastTimes: { known_condition: event.ts },
    entriesByKind: { known_condition: [event] },
    totalEvents: 1,
    readerAvailable: true,
  };
}

describe('BugReportDialog recent activity preview', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders Copy for support and copies recent activity markdown', async () => {
    const { writeText } = installWindowApis();
    mounted = mount(
      <BugReportDialog
        open
        onOpenChange={vi.fn()}
      />,
    );
    await flushAsync();

    expect(document.body.textContent).toContain('Recent activity');
    const copyButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Copy for support'));
    expect(copyButton).not.toBeUndefined();

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('Recent diagnostic events');
  });

  it('renders empty-state copy when totalEvents=0 and reader is available', async () => {
    installWindowApis(vi.fn().mockResolvedValue(emptyContext({ readerAvailable: true })));
    mounted = mount(<BugReportDialog open onOpenChange={vi.fn()} />);
    await flushAsync();

    expect(document.body.textContent).toContain('All quiet. Nothing notable in the last 24 hours.');
    expect(document.body.textContent).not.toContain("isn't available on this surface");
  });

  it('renders distinct readerUnavailable copy when reader is unavailable (not the empty-state copy)', async () => {
    installWindowApis(vi.fn().mockResolvedValue(emptyContext({ readerAvailable: false })));
    mounted = mount(<BugReportDialog open onOpenChange={vi.fn()} />);
    await flushAsync();

    expect(document.body.textContent).toContain("Recent activity isn't available on this surface");
    expect(document.body.textContent).not.toContain('All quiet. Nothing notable in the last 24 hours.');
  });

  it('renders error copy when getRecentContext rejects (without blocking the dialog)', async () => {
    installWindowApis(vi.fn().mockRejectedValue(new Error('fetch boom')));
    mounted = mount(<BugReportDialog open onOpenChange={vi.fn()} />);
    await flushAsync();

    expect(document.body.textContent).toContain("Couldn't load recent activity");
    // Dialog still presents core controls — diagnostics failure must not block submission
    expect(
      Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent?.includes('Copy for support')),
    ).toBe(true);
  });

  it('copyForSupport in readerUnavailable produces a degraded body (no false "All quiet")', async () => {
    const { writeText } = installWindowApis(
      vi.fn().mockResolvedValue(emptyContext({ readerAvailable: false })),
    );
    mounted = mount(<BugReportDialog open onOpenChange={vi.fn()} />);
    await flushAsync();

    const copyButton = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Copy for support'));
    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const markdown = writeText.mock.calls[0][0] as string;
    expect(markdown).toContain('Status: readerUnavailable');
    expect(markdown).toContain("isn't available on this surface");
    expect(markdown).not.toContain('All quiet');
  });

  it('submits per-bundle diagnostic section toggles without persistence', async () => {
    const { submitBug } = installWindowApis();
    const onOpenChange = vi.fn();
    mounted = mount(<BugReportDialog open onOpenChange={onOpenChange} />);
    await flushAsync();

    const description = document.body.querySelector('#feedback-description') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(description, { target: { value: 'Something broke' } });
      fireEvent.change(description, { target: { value: 'Something broke' } });
      await Promise.resolve();
    });

    const settingsDriftToggle = document.body.querySelector('[data-testid="bug-report-section-settings_drift"] input') as HTMLInputElement;
    await act(async () => {
      settingsDriftToggle.click();
    });

    const submitButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Report Bug'));
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(submitBug).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnosticSections: expect.objectContaining({
          settings_drift: false,
        }),
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
