// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { DeveloperTab } from '../DeveloperTab';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@renderer/contexts', () => ({
  useAppContext: () => ({ showToast: vi.fn() }),
}));

vi.mock('@renderer/components/DemoModeDialog', () => ({
  DemoModeDialog: () => null,
}));

// ---------------------------------------------------------------------------
// Window API stubs (minimal — DeveloperTab calls these in useEffect)
// ---------------------------------------------------------------------------

function installWindowApis() {
  Object.assign(window, {
    demoApi: {
      status: vi.fn().mockResolvedValue({ active: false }),
    },
    api: {
      onDemoModeChange: vi.fn(() => vi.fn()),
      getAnalyticsStatus: vi.fn().mockResolvedValue({ state: 'disabled' }),
    },
    settingsApi: {
      getFrequentTools: vi.fn().mockResolvedValue([]),
      mcpSummary: vi.fn().mockResolvedValue(null),
      mcpRestartSuperMcp: vi.fn().mockResolvedValue({ success: true }),
      resetToolUsage: vi.fn().mockResolvedValue({ success: true }),
      chooseFileInDirectory: vi.fn().mockResolvedValue(null),
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    diagnostics: { debugBreadcrumbsUntil: null, forceDirectMcp: false },
    systemSkills: {},
    coreDirectory: null,
    ...overrides,
  } as unknown as AppSettings;
}

function setOss(isOss: boolean) {
  if (isOss) {
    (globalThis as Record<string, unknown>).__REBEL_IS_OSS__ = true;
  } else {
    delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  installWindowApis();
  // Default: non-OSS (enterprise)
  delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
});

describe('DeveloperTab — telemetry section (OSS vs enterprise)', () => {
  it('does NOT render the OSS telemetry section in enterprise (non-OSS)', async () => {
    setOss(false);
    const { container, unmount } = mount(
      <DeveloperTab draftSettings={settings()} updateDraft={vi.fn()} />,
    );
    await flushAsync();

    expect(container.querySelector('[data-testid="settings-section-telemetry-oss"]')).toBeNull();
    // The existing enterprise read-only status text should be present
    expect(container.textContent).toContain('RudderStack status');

    unmount();
  });

  it('renders the OSS telemetry section with toggle in OSS mode', async () => {
    setOss(true);
    const { container, unmount } = mount(
      <DeveloperTab draftSettings={settings()} updateDraft={vi.fn()} />,
    );
    await flushAsync();

    expect(container.querySelector('[data-testid="settings-section-telemetry-oss"]')).not.toBeNull();

    const toggle = container.querySelector<HTMLInputElement>('#telemetryEnabled');
    expect(toggle).not.toBeNull();
    expect(toggle?.checked).toBe(false);

    unmount();
  });

  it('does NOT show cred inputs when toggle is OFF (default)', async () => {
    setOss(true);
    const { container, unmount } = mount(
      <DeveloperTab
        draftSettings={settings({ telemetry: { enabled: false } })}
        updateDraft={vi.fn()}
      />,
    );
    await flushAsync();

    expect(container.querySelector('#telemetrySentryDsn')).toBeNull();
    expect(container.querySelector('#telemetryRudderWriteKey')).toBeNull();
    expect(container.querySelector('#telemetryRudderDataPlaneUrl')).toBeNull();

    unmount();
  });

  it('reveals the three cred inputs when toggle is ON', async () => {
    setOss(true);
    const { container, unmount } = mount(
      <DeveloperTab
        draftSettings={settings({ telemetry: { enabled: true } })}
        updateDraft={vi.fn()}
      />,
    );
    await flushAsync();

    expect(container.querySelector('#telemetrySentryDsn')).not.toBeNull();
    expect(container.querySelector('#telemetryRudderWriteKey')).not.toBeNull();
    expect(container.querySelector('#telemetryRudderDataPlaneUrl')).not.toBeNull();

    unmount();
  });

  it('every cred input has a matching <label htmlFor>', async () => {
    setOss(true);
    const { container, unmount } = mount(
      <DeveloperTab
        draftSettings={settings({ telemetry: { enabled: true } })}
        updateDraft={vi.fn()}
      />,
    );
    await flushAsync();

    for (const id of ['telemetrySentryDsn', 'telemetryRudderWriteKey', 'telemetryRudderDataPlaneUrl']) {
      const input = container.querySelector(`#${id}`);
      expect(input, `input#${id} should exist`).not.toBeNull();
      const label = container.querySelector(`label[for="${id}"]`);
      expect(label, `label[for="${id}"] should exist`).not.toBeNull();
    }

    unmount();
  });

  it('calls updateDraft with telemetry.enabled=true when toggle is clicked', async () => {
    setOss(true);
    const updateDraft = vi.fn();
    const { container, unmount } = mount(
      <DeveloperTab
        draftSettings={settings()}
        updateDraft={updateDraft}
      />,
    );
    await flushAsync();

    const toggle = container.querySelector<HTMLInputElement>('#telemetryEnabled');
    expect(toggle).not.toBeNull();

    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(updateDraft).toHaveBeenCalledWith(
      'telemetry',
      expect.objectContaining({ enabled: true }),
    );

    unmount();
  });

  it('calls updateDraft with sentryDsn when Sentry DSN input changes', async () => {
    setOss(true);
    const updateDraft = vi.fn();
    const { container, unmount } = mount(
      <DeveloperTab
        draftSettings={settings({ telemetry: { enabled: true } })}
        updateDraft={updateDraft}
      />,
    );
    await flushAsync();

    const input = container.querySelector<HTMLInputElement>('#telemetrySentryDsn');
    expect(input).not.toBeNull();

    // React synthetic event: set nativeInputValueSetter on the input, then fire
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      nativeInputValueSetter?.call(input!, 'https://[external-email]/0');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(updateDraft).toHaveBeenCalledWith(
      'telemetry',
      expect.objectContaining({ sentryDsn: 'https://[external-email]/0' }),
    );

    unmount();
  });

  it('calls updateDraft with rudderWriteKey when RudderStack write key input changes', async () => {
    setOss(true);
    const updateDraft = vi.fn();
    const { container, unmount } = mount(
      <DeveloperTab
        draftSettings={settings({ telemetry: { enabled: true } })}
        updateDraft={updateDraft}
      />,
    );
    await flushAsync();

    const input = container.querySelector<HTMLInputElement>('#telemetryRudderWriteKey');
    expect(input).not.toBeNull();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      nativeInputValueSetter?.call(input!, 'my_write_key');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(updateDraft).toHaveBeenCalledWith(
      'telemetry',
      expect.objectContaining({ rudderWriteKey: 'my_write_key' }),
    );

    unmount();
  });

  it('calls updateDraft with rudderDataPlaneUrl when data-plane URL input changes', async () => {
    setOss(true);
    const updateDraft = vi.fn();
    const { container, unmount } = mount(
      <DeveloperTab
        draftSettings={settings({ telemetry: { enabled: true } })}
        updateDraft={updateDraft}
      />,
    );
    await flushAsync();

    const input = container.querySelector<HTMLInputElement>('#telemetryRudderDataPlaneUrl');
    expect(input).not.toBeNull();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      nativeInputValueSetter?.call(input!, 'https://dataplane.example.com');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(updateDraft).toHaveBeenCalledWith(
      'telemetry',
      expect.objectContaining({ rudderDataPlaneUrl: 'https://dataplane.example.com' }),
    );

    unmount();
  });

  it('does NOT render the enterprise RudderStack status section in OSS', async () => {
    setOss(true);
    const { container, unmount } = mount(
      <DeveloperTab draftSettings={settings()} updateDraft={vi.fn()} />,
    );
    await flushAsync();

    // Enterprise status text should be absent
    expect(container.textContent).not.toContain('RudderStack status');

    unmount();
  });
});
