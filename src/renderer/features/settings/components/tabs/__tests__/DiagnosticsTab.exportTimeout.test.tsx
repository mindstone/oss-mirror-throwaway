// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { DiagnosticsTab } from '../DiagnosticsTab';

/**
 * S2 (260617_bricked-state-0448-electron42): the Settings diagnostics download
 * is a SECOND surface that could leave `downloading: true` forever on a hang —
 * likely the surface the user actually hit ("stuck on preparing"). These assert
 * the handler always resolves (renderer-side timeout) and surfaces a partial
 * variant when the bundle is incomplete.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('@renderer/contexts', () => ({
  useAppContext: () => ({ showToast: mocks.showToast }),
}));
vi.mock('@renderer/components/WhatsNewDialog', () => ({ WhatsNewDialog: () => null }));

type Mounted = { container: HTMLDivElement; unmount: () => void };

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => { root.render(ui); });
  return { container, unmount: () => { act(() => { root.unmount(); }); container.remove(); } };
}

async function flushAsync(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function settings(): AppSettings {
  return {
    activeProvider: 'anthropic',
    diagnostics: { debugBreadcrumbsUntil: null, developerMode: false },
  } as unknown as AppSettings;
}

function baseWindowApis(zipResult: unknown) {
  Object.assign(window, {
    electronEnv: { appVersion: '1.2.3', buildChannel: 'dev', platform: 'darwin', arch: 'arm64' },
    appApi: {
      safeModeState: vi.fn().mockResolvedValue({ isEnabled: false }),
      enterSafeMode: vi.fn(), exitSafeMode: vi.fn(), openUrl: vi.fn(),
    },
    settingsApi: { mcpRestartSuperMcp: vi.fn().mockResolvedValue({ success: true }) },
    systemHealthApi: {
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checks: {} }),
      healthExport: vi.fn().mockResolvedValue({ markdown: '# Health' }),
      healthExportWithLogs: vi.fn().mockResolvedValue({ content: '# Health', filename: 'health.md' }),
      healthExportZip: vi.fn().mockResolvedValue(zipResult),
    },
    miscApi: {
      checkForUpdates: vi.fn().mockResolvedValue({ available: false }),
      fetchUpdateManifest: vi.fn().mockResolvedValue({ success: false }),
    },
    diagnosticsApi: {
      getProviderReachabilitySnapshot: vi.fn().mockResolvedValue({ snapshotPresent: false, lastRefreshAt: null, providers: {} }),
      getRecentContext: vi.fn().mockResolvedValue({ windowHours: 24, limit: 20, nowMs: Date.now(), counts: {}, lastTimes: {}, entriesByKind: {}, totalEvents: 0, readerAvailable: true }),
    },
  });
  // happy-dom lacks createObjectURL.
  if (!URL.createObjectURL) Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function renderTab(): Mounted {
  return mount(
    <DiagnosticsTab
      draftSettings={settings()}
      updateDraft={vi.fn()}
      onRelaunchOnboarding={vi.fn()}
      onResetOnboardingChecklist={vi.fn()}
    />,
  );
}

async function clickByText(container: HTMLElement, re: RegExp): Promise<void> {
  const el = Array.from(container.querySelectorAll('button, [role="button"], [role="radio"]'))
    .find((c) => re.test(c.textContent ?? ''));
  expect(el, `clickable matching ${re}`).toBeDefined();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function selectDetailedFormat(container: HTMLElement): Promise<void> {
  await clickByText(container, /Detailed \(\.zip\)/i);
}

async function clickDownload(container: HTMLElement): Promise<void> {
  await clickByText(container, /^Download (Report|Bundle)$/i);
}

describe('DiagnosticsTab download — partial + timeout (S2)', () => {
  beforeEach(() => { mocks.showToast.mockClear(); });

  it('surfaces a partial-bundle warning toast when the ZIP result is partial', async () => {
    baseWindowApis({ success: true, data: new Uint8Array(), filename: 'health.zip', partial: true, unavailableSections: ['recent_logs'] });
    const { container, unmount } = renderTab();
    await flushAsync();
    await selectDetailedFormat(container);
    await flushAsync();
    await clickDownload(container);
    await flushAsync();
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Partial diagnostic bundle downloaded',
      variant: 'warning',
    }));
    unmount();
  });

  it('always resolves to a failure toast (never stuck) when the IPC never settles', async () => {
    vi.useFakeTimers();
    baseWindowApis({ success: true, data: new Uint8Array(), filename: 'health.md', content: '# Health' });
    // healthExportWithLogs (standard path) never resolves → only the
    // renderer-side timeout releases it.
    (window.systemHealthApi.healthExportWithLogs as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => { /* never settles */ }),
    );
    const { container, unmount } = renderTab();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await clickDownload(container);
    // Advance past the 45s renderer-side timeout.
    await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Failed to download diagnostics',
      variant: 'error',
    }));
    unmount();
  });
});
