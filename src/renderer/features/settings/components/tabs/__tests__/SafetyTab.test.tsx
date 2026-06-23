// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { SafetyTab } from '../SafetyTab';

function setOss(isOss: boolean) {
  if (isOss) {
    (globalThis as Record<string, unknown>).__REBEL_IS_OSS__ = true;
  } else {
    delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
  }
}

 
vi.mock('../../SafetyPromptEditor', () => ({
  SafetyPromptEditor: () => <div>Safety prompt editor</div>,
}));

 
vi.mock('../../SafetyActivityLog', () => ({
  SafetyActivityLog: () => <div>Safety activity log</div>,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

let mounted: Mounted[] = [];

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
      act(() => {
        root.unmount();
      });
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

function makeSettings(): AppSettings {
  return {
    trustedTools: [],
    spaces: [],
    spaceSafetyLevels: {},
  } as unknown as AppSettings;
}

describe('SafetyTab', () => {
  beforeEach(() => {
    Object.assign(window, {
      mcpAppsApi: {
        listPermissions: vi.fn().mockResolvedValue({ permissions: [] }),
        revokePermission: vi.fn().mockResolvedValue({ success: true }),
      },
      api: {
        onMcpPermissionChanged: vi.fn(() => vi.fn()),
      },
    });
    // Default: non-OSS (enterprise)
    delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
  });

  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted = [];
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
  });

  it('keeps Connected app permissions between Tools and Memory in Zone 2', async () => {
    const view = mount(
      <SafetyTab
        draftSettings={makeSettings()}
        updateDraft={vi.fn()}
      />,
    );
    mounted.push(view);

    await flushAsync();

    const text = view.container.textContent ?? '';
    expect(text).toContain('Tools');
    expect(text).toContain('Connected app permissions');
    expect(text).toContain('Memory Spaces');
    expect(text).toContain('including work run in the cloud');
    expect(text.indexOf('Tools')).toBeLessThan(text.indexOf('Connected app permissions'));
    expect(text.indexOf('Connected app permissions')).toBeLessThan(text.indexOf('Memory Spaces'));
  });
});

describe('SafetyTab — privacy card "No conversation storage" (OSS vs enterprise)', () => {
  beforeEach(() => {
    Object.assign(window, {
      mcpAppsApi: {
        listPermissions: vi.fn().mockResolvedValue({ permissions: [] }),
        revokePermission: vi.fn().mockResolvedValue({ success: true }),
      },
      api: {
        onMcpPermissionChanged: vi.fn(() => vi.fn()),
      },
    });
    delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
  });

  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted = [];
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
  });

  it('shows telemetry-off copy in OSS mode', async () => {
    setOss(true);
    const view = mount(
      <SafetyTab draftSettings={makeSettings()} updateDraft={vi.fn()} />,
    );
    mounted.push(view);
    await flushAsync();

    const text = view.container.textContent ?? '';
    expect(text).toContain('telemetry is off');
    expect(text).toContain('Developer settings');
    expect(text).not.toContain('Only limited telemetry');
  });

  it('shows existing enterprise copy in non-OSS mode', async () => {
    setOss(false);
    const view = mount(
      <SafetyTab draftSettings={makeSettings()} updateDraft={vi.fn()} />,
    );
    mounted.push(view);
    await flushAsync();

    const text = view.container.textContent ?? '';
    expect(text).toContain('Only limited telemetry');
    expect(text).not.toContain('telemetry is off');
  });
});
