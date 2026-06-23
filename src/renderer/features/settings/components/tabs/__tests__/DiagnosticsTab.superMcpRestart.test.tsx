// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { DiagnosticsTab } from '../DiagnosticsTab';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('@renderer/contexts', () => ({
  useAppContext: () => ({ showToast: mocks.showToast }),
}));

vi.mock('@renderer/components/WhatsNewDialog', () => ({
  WhatsNewDialog: () => null,
}));

type Mounted = { container: HTMLDivElement; root: Root; unmount: () => void };

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => { root.unmount(); });
      container.remove();
    },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function settings(): AppSettings {
  return {
    activeProvider: 'anthropic',
    diagnostics: { debugBreadcrumbsUntil: null, developerMode: false },
  } as unknown as AppSettings;
}

function installWindowApis() {
  Object.assign(window, {
    electronEnv: {
      appVersion: '1.2.3',
      buildChannel: 'dev',
      platform: 'darwin',
      arch: 'arm64',
    },
    appApi: {
      safeModeState: vi.fn().mockResolvedValue({ isEnabled: false }),
      enterSafeMode: vi.fn().mockResolvedValue(undefined),
      exitSafeMode: vi.fn().mockResolvedValue(undefined),
      openUrl: vi.fn().mockResolvedValue(undefined),
    },
    settingsApi: {
      mcpRestartSuperMcp: vi.fn().mockResolvedValue({ success: true }),
    },
    systemHealthApi: {
      healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', checks: {} }),
      healthExport: vi.fn().mockResolvedValue({ markdown: '# Health' }),
      healthExportWithLogs: vi.fn().mockResolvedValue({ content: '# Health', filename: 'health.md' }),
      healthExportZip: vi.fn().mockResolvedValue({ success: true, data: new Uint8Array(), filename: 'health.zip' }),
    },
    miscApi: {
      checkForUpdates: vi.fn().mockResolvedValue({ available: false }),
      fetchUpdateManifest: vi.fn().mockResolvedValue({ success: false }),
    },
    diagnosticsApi: {
      getProviderReachabilitySnapshot: vi.fn().mockResolvedValue({
        snapshotPresent: false,
        lastRefreshAt: null,
        providers: {},
      }),
      getRecentContext: vi.fn().mockResolvedValue({
        windowHours: 24,
        limit: 20,
        nowMs: Date.now(),
        counts: {},
        lastTimes: {},
        entriesByKind: {},
        totalEvents: 0,
        readerAvailable: true,
      }),
    },
  });
}

beforeEach(() => {
  installWindowApis();
  mocks.showToast.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('DiagnosticsTab Super-MCP restart control', () => {
  it('renders for ordinary users and invokes the existing restart IPC', async () => {
    const { container, unmount } = mount(
      <DiagnosticsTab
        draftSettings={settings()}
        updateDraft={vi.fn()}
        onRelaunchOnboarding={vi.fn()}
        onResetOnboardingChecklist={vi.fn()}
      />,
    );
    await flushAsync();

    const button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Restart Super-MCP');
    expect(button).toBeDefined();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(window.settingsApi.mcpRestartSuperMcp).toHaveBeenCalledOnce();
    expect(mocks.showToast).toHaveBeenCalledWith({ title: 'Super-MCP restarted' });

    unmount();
  });
});
