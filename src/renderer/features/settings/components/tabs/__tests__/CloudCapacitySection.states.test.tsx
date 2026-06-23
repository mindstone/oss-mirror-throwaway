// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudCapacitySection } from '../CloudTab';
import type { LastKnownVolumeStatus, ResizeVolumeResult, ResizeVolumeUiState, VolumeStatusOutcome } from '../../../hooks/useCloudCapacity';
import { getTierById, type VmTier } from '../../../../../../core/services/cloud/vmTierCatalog';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  rerender: (ui: React.ReactElement) => void;
  unmount: () => void;
}

const GIB = 1024 ** 3;

const originalCloudApi = window.cloudApi;
const originalAppApi = window.api;
const originalMiscApi = window.miscApi;

function okVolume(percent: number, sizeGb = 100): Extract<VolumeStatusOutcome, { kind: 'ok' }> {
  const totalBytes = sizeGb * GIB;
  const usedBytes = totalBytes * (percent / 100);
  return {
    kind: 'ok',
    sizeGb,
    totalBytes,
    usedBytes,
    availableBytes: totalBytes - usedBytes,
    lastCheckedAt: Date.now() - 60_000,
  };
}

function installCloudApiMock(overrides: Partial<Window['cloudApi']> = {}) {
  const standardTier = getTierById('standard') as VmTier;
  const api = {
    getVmTier: vi.fn().mockResolvedValue({ success: true, tier: standardTier }),
    changeVmTier: vi.fn().mockResolvedValue({
      success: true,
      updated: true,
      applied: true,
      healthVerified: true,
      settingsPersisted: true,
    }),
    getVolumeStatus: vi.fn(),
    resizeVolume: vi.fn(),
    ...overrides,
  };
  (window as unknown as { cloudApi: typeof api }).cloudApi = api;
  return api;
}

function installObservabilityMocks() {
  const logEvent = vi.fn();
  const captureMessage = vi.fn().mockResolvedValue({ eventId: 'event-1' });
  (window as unknown as { api: { logEvent: typeof logEvent } }).api = { logEvent };
  (window as unknown as { miscApi: { captureMessage: typeof captureMessage } }).miscApi = { captureMessage };
  return { logEvent, captureMessage };
}

function render(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    rerender: (nextUi) => {
      act(() => {
        root.render(nextUi);
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function renderSection({
  mode,
  currentVmTierId = 'standard',
  volume = okVolume(40),
  loading = false,
  resizing = false,
  resizeResult = null,
  resizeState = { kind: 'idle' } as ResizeVolumeUiState,
  tierChangeState = { kind: 'idle' } as const,
  lastKnownVolume = null,
  onResize = vi.fn().mockResolvedValue({ success: true, sizeGbAfter: 125 }),
  onTierChangeVerificationFailed = vi.fn(),
}: {
  mode?: 'byok' | 'managed';
  currentVmTierId?: string;
  volume?: VolumeStatusOutcome | null;
  loading?: boolean;
  resizing?: boolean;
  resizeResult?: ResizeVolumeResult | null;
  resizeState?: ResizeVolumeUiState;
  tierChangeState?: { kind: 'idle' } | { kind: 'post_apply_verification_failed' };
  lastKnownVolume?: LastKnownVolumeStatus | null;
  onResize?: (targetSizeGb: number) => Promise<ResizeVolumeResult>;
  onTierChangeVerificationFailed?: () => void;
} = {}) {
  return render(
    <CloudCapacitySection
      mode={mode}
      currentVmTierId={currentVmTierId}
      tierSelectorDisabled={false}
      lastTierChangeSuccess={null}
      tierChangeState={tierChangeState}
      lastKnownVolume={lastKnownVolume}
      volume={volume}
      loading={loading}
      resizing={resizing}
      resizeResult={resizeResult}
      resizeState={resizeState}
      onTierChanged={vi.fn()}
      onTierChangeStart={vi.fn()}
      onTierChangeVerificationFailed={onTierChangeVerificationFailed}
      onDismissTierChangeNotice={vi.fn()}
      onDismissResizeResult={vi.fn()}
      onDismissPressureNotice={vi.fn()}
      onPollNow={vi.fn()}
      onResize={onResize}
    />,
  );
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(element: Element | null) {
  if (!element) throw new Error('Expected element to exist');
  act(() => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function keyDown(element: Element | Window, key: string, shiftKey = false) {
  act(() => {
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  });
}

function getTierRadio(container: HTMLElement, label: string): HTMLElement {
  const radio = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!radio) throw new Error(`Tier radio not found for label: ${label}`);
  return radio;
}

function getButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function tabbableElements(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(
    'button, input, select, textarea, a[href], [role="radio"], [tabindex]',
  )).filter((element) => {
    if (element.closest('[inert]')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    if (element instanceof HTMLInputElement && element.disabled) return false;
    return element.tabIndex >= 0;
  });
}

function tabUntil(target: HTMLElement, maxTabs = 20) {
  for (let index = 0; index < maxTabs; index += 1) {
    const tabbables = tabbableElements();
    const currentIndex = tabbables.indexOf(document.activeElement as HTMLElement);
    const next = tabbables[(currentIndex + 1) % tabbables.length];
    act(() => {
      next?.focus();
    });
    if (document.activeElement === target) return;
  }
  throw new Error(`Did not reach target ${target.dataset.testid ?? target.textContent ?? target.tagName}`);
}

beforeEach(() => {
  installCloudApiMock();
  installObservabilityMocks();
});

afterEach(() => {
  (window as unknown as { cloudApi: Window['cloudApi'] }).cloudApi = originalCloudApi;
  (window as unknown as { api: Window['api'] }).api = originalAppApi;
  (window as unknown as { miscApi: Window['miscApi'] }).miscApi = originalMiscApi;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('CloudCapacitySection Stage 4 state polish', () => {
  it('renders the tier loading state with an inline spinner', () => {
    installCloudApiMock({ getVmTier: vi.fn(() => new Promise(() => undefined)) as unknown as Window['cloudApi']['getVmTier'] });
    const { container, unmount } = renderSection();

    expect(container.querySelector('[data-testid="vm-tier-loading"]')?.textContent).toContain('Checking cloud speed…');
    expect(container.querySelector('[data-testid="vm-tier-loading"] [role="status"]')).not.toBeNull();
    unmount();
  });

  it('renders the tier cloud-unreachable state disabled with last-known copy', async () => {
    installCloudApiMock({ getVmTier: vi.fn().mockResolvedValue({ success: false, error: 'offline' }) });
    const { container, unmount } = renderSection({ currentVmTierId: 'faster' });
    await flushEffects();

    expect(container.querySelector('[data-testid="vm-tier-selector"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('[data-testid="vm-tier-cloud-unreachable"]')?.textContent).toContain(
      "Couldn't reach the cloud just now — last known: Faster",
    );
    unmount();
  });

  it('renders the shared Fly-token-missing Notice and disables the tier picker', async () => {
    installCloudApiMock({ getVmTier: vi.fn().mockResolvedValue({ success: false, error: 'Fly API token not found. Link your Fly token first.' }) });
    const { container, unmount } = renderSection({ volume: { kind: 'fly_token_missing' } });
    await flushEffects();

    expect(container.querySelector('[data-testid="cloud-storage-token-missing"]')?.textContent).toContain('Connect your Fly token');
    expect(container.querySelector('[data-testid="vm-tier-selector"]')?.getAttribute('aria-disabled')).toBe('true');
    unmount();
  });

  it('keeps the tier dialog locked with spinner and explanatory text while a change is in-flight', async () => {
    installCloudApiMock({
      changeVmTier: vi.fn(() => new Promise(() => undefined)) as unknown as Window['cloudApi']['changeVmTier'],
    });
    const { container, unmount } = renderSection();
    await flushEffects();

    click(getTierRadio(container, 'Faster'));
    click(getButton('Switch speed'));
    await flushEffects();
    keyDown(window, 'Escape');

    expect(document.body.querySelector('[data-testid="vm-tier-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="vm-tier-dialog-busy"]')?.textContent).toContain(
      'Changing speed now. The cloud may be briefly unavailable while the same Fly machine restarts.',
    );
    expect(document.body.querySelector('[data-testid="vm-tier-dialog-busy"] .animate-spin')).not.toBeNull();
    unmount();
  });

  it('surfaces post-apply tier verification failure as a persistent Notice', () => {
    const { container, unmount } = renderSection({
      tierChangeState: { kind: 'post_apply_verification_failed' },
    });

    expect(container.querySelector('[data-testid="cloud-tier-verification-failure"]')?.textContent).toContain(
      "Tier change applied but we couldn't confirm your cloud is healthy. Refresh in a moment.",
    );
    unmount();
  });

  it('renders the unknown Fly-size tier state and keeps tier selection available', async () => {
    installCloudApiMock({
      getVmTier: vi.fn().mockResolvedValue({
        success: true,
        raw: { cpuKind: 'shared', cpus: 1, memoryMb: 256 },
      }),
    });
    const { container, unmount } = renderSection();
    await flushEffects();

    expect(container.querySelector('[data-testid="vm-tier-unknown-fly-size"]')?.textContent).toContain(
      'This cloud does not match a Rebel speed tier.',
    );
    expect(container.querySelector('[data-testid="vm-tier-selector"]')?.getAttribute('aria-disabled')).toBe('false');
    unmount();
  });

  it('shows the speed-row add-storage affordance for resizable BYOK clouds and reuses the existing Add storage dialog', async () => {
    const { container, unmount } = renderSection({ volume: okVolume(40) });
    await flushEffects();

    const affordance = container.querySelector('[data-testid="vm-tier-add-storage-instead"]') as HTMLButtonElement;
    expect(affordance).not.toBeNull();
    expect(affordance.textContent).toContain('Need more room, not more speed? Add storage instead.');

    click(affordance);
    await flushEffects();
    expect(document.body.querySelector('[data-testid="cloud-storage-target-input"]')).not.toBeNull();
    unmount();
  });

  it('hides the speed-row add-storage affordance while a resize is in flight', async () => {
    const { container, unmount } = renderSection({
      volume: okVolume(40),
      resizing: true,
      resizeState: { kind: 'in_flight', targetSizeGb: 125 },
    });
    await flushEffects();

    // Even though the volume is live and below max, an in-flight resize must
    // suppress the "Add storage instead" shortcut so it can't open the locked dialog.
    expect(container.querySelector('[data-testid="vm-tier-add-storage-instead"]')).toBeNull();
    unmount();
  });

  it('renders the storage loading state with a skeleton meter and checking copy', () => {
    const { container, unmount } = renderSection({ volume: null, loading: true });

    expect(container.querySelector('[data-testid="cloud-storage-loading"]')?.textContent).toContain('Checking storage…');
    expect(container.querySelector('[data-testid="cloud-storage-loading"]')?.querySelector('[class*="cloudStorageSkeletonMeter"]')).not.toBeNull();
    unmount();
  });

  it('renders cloud-unreachable storage with the last-known meter and timestamp copy', () => {
    const lastKnown = okVolume(68);
    const { container, unmount } = renderSection({
      volume: {
        kind: 'cloud_unreachable',
        error: 'offline',
        lastCheckedAt: Date.now(),
        lastKnown,
      },
    });

    expect(container.querySelector('[data-testid="cloud-storage-unreachable"]')?.textContent).toContain(
      "Couldn't reach the cloud just now — showing the last reading from",
    );
    expect(container.querySelector('[data-testid="cloud-storage-meter"]')?.textContent).toContain('68.0 GB used of 100.0 GB');
    unmount();
  });

  it('renders endpoint-missing storage as a cloud-update compatibility message', () => {
    const { container, unmount } = renderSection({
      volume: {
        kind: 'cloud_unreachable',
        reason: 'endpoint_missing',
        error: 'CLOUD_STORAGE_ENDPOINT_NOT_FOUND',
        lastCheckedAt: Date.now(),
        sizeGb: 100,
      },
    });

    expect(container.querySelector('[data-testid="cloud-storage-unreachable"]')?.textContent).toContain(
      'Your cloud needs an update before storage usage can be read.',
    );
    unmount();
  });

  it('renders in-flight resize target and replaces Add storage with spinner copy', () => {
    const { container, unmount } = renderSection({
      resizing: true,
      resizeState: { kind: 'in_flight', targetSizeGb: 125 },
    });

    expect(container.querySelector('[data-testid="cloud-storage-pending-target"]')?.textContent).toContain('Resizing to 125 GB…');
    expect(container.querySelector('[data-testid="cloud-storage-resizing-status"]')?.textContent).toContain('Resizing…');
    expect(container.querySelector('[data-testid="cloud-storage-add-button"]')).toBeNull();
    unmount();
  });

  it('renders resize success as a persistent inline Notice', () => {
    const { container, unmount } = renderSection({
      resizeResult: { success: true, sizeGbAfter: 125 },
      resizeState: { kind: 'success', result: { success: true, sizeGbAfter: 125 } },
    });

    expect(container.querySelector('[data-testid="cloud-storage-resize-success"]')?.textContent).toContain(
      'Storage now 125.0 GB. Same Fly machine, brief restart applied.',
    );
    unmount();
  });

  it('renders resize failure with retry while preserving the last-known meter', () => {
    const { container, unmount } = renderSection({
      resizeResult: { success: false, applied: false, error: 'Fly said no.' },
      resizeState: { kind: 'failure', result: { success: false, applied: false, error: 'Fly said no.' } },
    });

    expect(container.querySelector('[data-testid="cloud-storage-resize-error"]')?.textContent).toContain('Fly said no.');
    expect(container.querySelector('[data-testid="cloud-storage-resize-retry"]')?.textContent).toContain('Retry');
    expect(container.querySelector('[data-testid="cloud-storage-meter"]')?.textContent).toContain('40.0 GB used of 100.0 GB');
    unmount();
  });

  it('disables Add storage at 500 GB and exposes the maximum-storage Tooltip copy', async () => {
    const { container, unmount } = renderSection({ volume: okVolume(40, 500) });
    await flushEffects();

    const button = container.querySelector('[data-testid="cloud-storage-add-button"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[data-testid="vm-tier-add-storage-instead"]')).toBeNull();

    act(() => {
      (container.querySelector('[data-testid="cloud-storage-at-max-tooltip-trigger"]') as HTMLElement).focus();
    });
    await flushEffects();
    expect(document.body.textContent).toContain('Maximum cloud storage is 500 GB. Contact us if you need more.');
    unmount();
  });

  it('hides the speed-row add-storage affordance when no live volume reading is available', async () => {
    const { container, unmount } = renderSection({
      volume: {
        kind: 'cloud_unreachable',
        error: 'offline',
        lastCheckedAt: Date.now(),
        sizeGb: 100,
      },
      lastKnownVolume: null,
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="vm-tier-add-storage-instead"]')).toBeNull();
    unmount();
  });

  it.each([
    [80, 'warning'],
    [95, 'urgent'],
  ])('renders threshold Notice copy with non-colour cue at %s%%', (percent, tone) => {
    const { container, unmount } = renderSection({ volume: okVolume(percent) });

    const notice = container.querySelector('[data-testid="cloud-storage-threshold-notice"]');
    expect(notice?.getAttribute('role')).toBe('note');
    expect(notice?.textContent).toContain('Cloud storage is getting snug. Add room before sync has to become dramatic.');
    expect(container.querySelector('[data-testid="cloud-storage-meter"]')?.getAttribute('data-tone')).toBe(tone);
    expect(notice?.querySelector('svg')).not.toBeNull();
    unmount();
  });

  it('renders a subtle non-colour mention cue before the warning threshold', () => {
    const { container, unmount } = renderSection({ volume: okVolume(68) });

    const cue = container.querySelector('[data-testid="cloud-storage-mention-cue"]');
    expect(cue?.textContent).toContain('Cloud is starting to fill — 68% used. Plenty of room, but worth keeping an eye on.');
    expect(cue?.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-storage-threshold-notice"]')).toBeNull();
    unmount();
  });

  it('clamps storage over-reporting and logs divergence instead of crashing', async () => {
    const { captureMessage } = installObservabilityMocks();
    const invalidVolume = {
      ...okVolume(40),
      totalBytes: 10 * GIB,
      usedBytes: 12 * GIB,
      availableBytes: -2 * GIB,
    };
    const { container, unmount } = renderSection({ volume: invalidVolume });
    await flushEffects();

    expect(container.querySelector('[data-testid="cloud-storage-meter"]')?.getAttribute('aria-label')).toBe(
      '10.0 GB used of 10.0 GB, 0.0 GB free',
    );
    expect(captureMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud-storage-usage-exceeded-total',
      context: expect.objectContaining({ reason: 'storage_usage_counter_diverged' }),
    }));
    unmount();
  });

  it('passes an axe serious-violation check and exposes required aria labels', async () => {
    const { container, unmount } = renderSection();
    await flushEffects();

    const meter = container.querySelector('[data-testid="cloud-storage-meter"]');
    expect(meter?.getAttribute('role')).toBe('img');
    expect(meter?.getAttribute('aria-label')).toBe('40.0 GB used of 100.0 GB, 60.0 GB free');

    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      rules: { region: { enabled: false } },
    });
    expect(results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([]);
    unmount();
  });

  it('supports keyboard navigation through capacity controls and resize dialog dismissal', async () => {
    const { container, unmount } = renderSection();
    await flushEffects();

    const tierCard = container.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement;
    const helper = container.querySelector('[data-testid="vm-tier-helper-text"]') as HTMLElement;
    const meter = container.querySelector('[data-testid="cloud-storage-meter"]') as HTMLElement;
    const addStorage = container.querySelector('[data-testid="cloud-storage-add-button"]') as HTMLButtonElement;

    tabUntil(tierCard);
    expect(document.activeElement).toBe(tierCard);
    tabUntil(helper);
    expect(document.activeElement).toBe(helper);
    tabUntil(meter);
    expect(document.activeElement).toBe(meter);
    tabUntil(addStorage);
    expect(document.activeElement).toBe(addStorage);

    keyDown(addStorage, 'Enter');
    click(addStorage);
    await flushEffects();

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog?.getAttribute('aria-labelledby')).toBe('cloud-storage-resize-title');

    const confirm = document.body.querySelector('[data-testid="cloud-storage-confirm-resize"]') as HTMLButtonElement;
    confirm.focus();
    keyDown(dialog, 'Tab');
    expect(dialog.contains(document.activeElement)).toBe(true);

    keyDown(window, 'Escape');
    await flushEffects();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    click(addStorage);
    await flushEffects();
    click(getButton('Cancel'));
    await flushEffects();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    unmount();
  });

  it('managed mode hides tier and resize controls but keeps the storage meter and refresh', () => {
    const { container, unmount } = renderSection({ mode: 'managed', volume: okVolume(40) });

    const section = container.querySelector('[data-testid="cloud-capacity-section"]');
    expect(section?.textContent).toContain('Mindstone keeps your cloud running');
    expect(container.querySelector('[data-testid="cloud-speed-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="vm-tier-selector"]')).toBeNull();
    expect(container.querySelector('[data-testid="vm-tier-add-storage-instead"]')).toBeNull();
    expect(container.querySelector('[data-testid="cloud-storage-add-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="cloud-storage-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-storage-meter"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-storage-refresh-button"]')).not.toBeNull();
    unmount();
  });

  it('managed mode swaps the threshold copy to point at Mindstone support', () => {
    const { container, unmount } = renderSection({ mode: 'managed', volume: okVolume(85) });

    const notice = container.querySelector('[data-testid="cloud-storage-threshold-notice"]');
    expect(notice?.textContent).toContain('Mindstone manages capacity');
    expect(notice?.textContent).not.toContain('Add room before sync has to become dramatic');
    unmount();
  });
});
