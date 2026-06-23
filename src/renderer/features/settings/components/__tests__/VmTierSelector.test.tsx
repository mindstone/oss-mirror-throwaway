// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VmTierSelector } from '../VmTierSelector';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

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

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function getTierRadio(container: HTMLElement, label: string): HTMLElement {
  const radio = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!radio) {
    throw new Error(`Tier radio not found for label: ${label}`);
  }
  return radio;
}

function getDialog(): HTMLElement | null {
  return document.body.querySelector('[data-testid="vm-tier-dialog"]');
}

function getDialogButton(label: string): HTMLButtonElement {
  const dialog = getDialog();
  if (!dialog) {
    throw new Error('Dialog is not open');
  }
  const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!button) {
    throw new Error(`Dialog button not found: ${label}`);
  }
  return button;
}

const originalCloudApi = window.cloudApi;
const STANDARD_TIER = {
  id: 'standard',
  label: 'Standard',
  description: 'Handles most workloads',
  cpuKind: 'shared',
  cpus: 4,
  memoryMb: 4096,
  estimatedMonthlyCostUsd: 12.77,
  workingRoom: 'Standard',
  speedRank: 1,
  isDefault: true,
};
const FASTER_TIER = {
  id: 'faster',
  label: 'Faster',
  description: 'Dedicated CPU, snappier responses',
  cpuKind: 'performance',
  cpus: 2,
  memoryMb: 4096,
  estimatedMonthlyCostUsd: 63.84,
  workingRoom: 'Standard',
  speedRank: 2,
};
const STANDARD_RAW = { cpuKind: 'shared', cpus: 4, memoryMb: 4096 };
const FASTER_RAW = { cpuKind: 'performance', cpus: 2, memoryMb: 4096 };
const FASTER_UPGRADED_RAW = { cpuKind: 'performance', cpus: 2, memoryMb: 8192 };
const CUSTOM_RAW = { cpuKind: 'shared', cpus: 1, memoryMb: 256 };

describe('VmTierSelector', () => {
  let mounted: Mounted | null = null;
  let getVmTierMock: ReturnType<typeof vi.fn>;
  let changeVmTierMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getVmTierMock = vi.fn().mockResolvedValue({ success: true, tier: STANDARD_TIER, raw: STANDARD_RAW });
    changeVmTierMock = vi.fn().mockResolvedValue({ success: true, updated: true });

    (window as unknown as { cloudApi: Window['cloudApi'] }).cloudApi = {
      getVmTier: getVmTierMock,
      changeVmTier: changeVmTierMock,
    } as unknown as Window['cloudApi'];
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    (window as unknown as { cloudApi: Window['cloudApi'] }).cloudApi = originalCloudApi;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('exact tier match checks Faster and shows Current', async () => {
    getVmTierMock.mockResolvedValueOnce({ success: true, tier: FASTER_TIER, raw: FASTER_RAW });
    mounted = mount(<VmTierSelector cachedTierId="faster" />);
    await flushEffects();

    expect(mounted.container.querySelectorAll('[role="radio"]')).toHaveLength(3);
    const current = mounted.container.querySelector('[role="radio"][aria-checked="true"]');
    expect(current?.textContent).toContain('Faster');
    expect(mounted.container.textContent).toContain('Current');
  });

  it('approx tier match checks Faster, shows Current, and renders extra capacity note', async () => {
    getVmTierMock.mockResolvedValueOnce({ success: true, tier: FASTER_TIER, raw: FASTER_UPGRADED_RAW });
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    const checked = mounted.container.querySelector('[role="radio"][aria-checked="true"]');
    expect(checked?.textContent).toContain('Faster');
    expect(mounted.container.textContent).toContain('Current');
    expect(mounted.container.querySelector('[data-testid="vm-tier-extra-capacity"]')?.textContent).toContain(
      'Working room: 8 GB now; Faster usually includes 4 GB',
    );
    const standard = getTierRadio(mounted.container, 'Standard');
    expect(standard.getAttribute('aria-checked')).toBe('false');
  });

  it('none tier match keeps all cards unselected and shows custom-cloud notice', async () => {
    getVmTierMock.mockResolvedValueOnce({ success: true, tier: undefined, raw: CUSTOM_RAW });
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    expect(mounted.container.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
    const notice = mounted.container.querySelector('[data-testid="vm-tier-unknown-fly-size"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Custom cloud size');
    expect(notice?.textContent).toContain(
      'This cloud does not match a Rebel speed tier. Pick Standard, Faster, or Heavy Work to put it on a standard size.',
    );
  });

  it('renders working-room and speed labels while keeping raw CPU/RAM off the card face', async () => {
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    expect(mounted.container.textContent).toContain('Working room: Standard');
    expect(mounted.container.textContent).toContain('Working room: Double');
    expect(mounted.container.textContent).toContain('Speed: 1/3');
    expect(mounted.container.textContent).toContain('Speed: 2/3');
    expect(mounted.container.textContent).toContain('Speed: 3/3');
    expect(mounted.container.textContent).toContain('Speed tiers do not add storage. Storage is managed below.');
    expect(mounted.container.textContent).toContain('What\'s this?');
    expect(mounted.container.textContent).not.toContain('cpu_kind');
    expect(mounted.container.textContent).not.toContain('memory_mb');
  });

  it('renders add-storage-instead affordance when callback is provided and calls it', async () => {
    const onAddStorageInstead = vi.fn();
    mounted = mount(<VmTierSelector cachedTierId="standard" onAddStorageInstead={onAddStorageInstead} />);
    await flushEffects();

    const button = mounted.container.querySelector('[data-testid="vm-tier-add-storage-instead"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('Need more room, not more speed? Add storage instead.');
    click(button as Element);
    expect(onAddStorageInstead).toHaveBeenCalledOnce();
  });

  it('does not render add-storage-instead affordance when callback is absent', async () => {
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    expect(mounted.container.querySelector('[data-testid="vm-tier-add-storage-instead"]')).toBeNull();
  });

  it('makes raw CPU/RAM details available only through the support tooltip', async () => {
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    const supportButton = mounted.container.querySelector('[data-testid="vm-tier-support-standard"]') as HTMLButtonElement;
    expect(supportButton).not.toBeNull();

    act(() => {
      supportButton.focus();
    });
    await flushEffects();

    expect(document.body.textContent).toContain('cpu_kind: shared');
    expect(document.body.textContent).toContain('memory_mb: 4096');
  });

  it('clicking a non-current tier opens the confirmation dialog', async () => {
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));

    expect(getDialog()).not.toBeNull();
    expect(document.body.textContent).toContain('Switch cloud speed to Faster?');
  });

  it('dialog shows speed delta, cost delta, storage status hint, and restart note', async () => {
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));

    expect(document.body.textContent).toContain('Speed: 1/3 → 2/3');
    expect(document.body.textContent).toContain('+$51.07/month');
    expect(document.body.textContent).toContain('Storage: unchanged');
    expect(document.body.querySelector('[data-testid="vm-tier-storage-hint"]')?.textContent).toContain(
      'Need more room, not more speed? Add storage instead; no tier change required.',
    );
    expect(document.body.textContent).toContain('Same Fly machine, brief restart');
  });

  it('confirming calls changeVmTier and updates current tier on success', async () => {
    getVmTierMock
      .mockResolvedValueOnce({ success: true, tier: STANDARD_TIER })
      .mockResolvedValueOnce({ success: true, tier: FASTER_TIER });
    changeVmTierMock.mockResolvedValueOnce({
      success: true,
      updated: true,
      applied: true,
      healthVerified: true,
      settingsPersisted: true,
    });

    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));
    click(getDialogButton('Switch speed'));
    await flushEffects();
    await flushEffects();

    expect(changeVmTierMock).toHaveBeenCalledWith({ tierId: 'faster' });
    const current = mounted.container.querySelector('[role="radio"][aria-checked="true"]');
    expect(current?.textContent).toContain('Faster');
    expect(getDialog()).toBeNull();
  });

  it('confirm during busy disables both buttons and shows spinner', async () => {
    let resolveChange!: (value: unknown) => void;
    const changePromise = new Promise((resolve) => {
      resolveChange = resolve;
    });
    changeVmTierMock.mockReturnValueOnce(changePromise);

    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));
    click(getDialogButton('Switch speed'));
    await flushEffects();

    const cancelButton = getDialogButton('Not now');
    const confirmButton = getDialogButton('Switch speed');
    expect(cancelButton.disabled).toBe(true);
    expect(confirmButton.disabled).toBe(true);
    expect(document.body.textContent).toContain('Changing speed now. The cloud may be briefly unavailable while the same Fly machine restarts.');
    expect(getDialog()?.querySelector('.animate-spin')).not.toBeNull();

    resolveChange({ success: true, updated: true, settingsPersisted: true });
    await flushEffects();
    await flushEffects();
  });

  it('failure shows error and keeps dialog open', async () => {
    changeVmTierMock.mockResolvedValueOnce({ success: false, error: 'Could not apply tier change' });

    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));
    click(getDialogButton('Switch speed'));
    await flushEffects();

    expect(document.body.textContent).toContain('Could not apply tier change');
    expect(getDialog()).not.toBeNull();
  });

  it('applied=true and healthVerified=false reports applied-but-unverified state', async () => {
    const onTierChangeVerificationFailed = vi.fn();
    changeVmTierMock.mockResolvedValueOnce({
      success: false,
      applied: true,
      healthVerified: false,
    });

    mounted = mount(<VmTierSelector cachedTierId="standard" onTierChangeVerificationFailed={onTierChangeVerificationFailed} />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));
    click(getDialogButton('Switch speed'));
    await flushEffects();

    expect(onTierChangeVerificationFailed).toHaveBeenCalledOnce();
    expect(getDialog()).toBeNull();
  });

  it('settingsPersisted=false after success shows the persistence warning', async () => {
    getVmTierMock
      .mockResolvedValueOnce({ success: true, tier: STANDARD_TIER })
      .mockResolvedValueOnce({ success: true, tier: FASTER_TIER });
    changeVmTierMock.mockResolvedValueOnce({
      success: true,
      updated: true,
      applied: true,
      healthVerified: true,
      settingsPersisted: false,
    });

    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));
    click(getDialogButton('Switch speed'));
    await flushEffects();
    await flushEffects();

    expect(getDialog()).toBeNull();
    expect(mounted.container.textContent).toContain(
      'Your cloud is on the new tier, but we couldn\'t save your preference. Try refreshing.',
    );
  });

  it('disabled=true makes the cards non-interactive', async () => {
    mounted = mount(<VmTierSelector cachedTierId="standard" disabled />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));

    expect(getDialog()).toBeNull();
  });

  it('selecting the current tier is a silent no-op', async () => {
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Standard'));

    expect(getDialog()).toBeNull();
    expect(changeVmTierMock).not.toHaveBeenCalled();
  });

  it('selecting the current approx tier is also a silent no-op', async () => {
    getVmTierMock.mockResolvedValueOnce({ success: true, tier: FASTER_TIER, raw: FASTER_UPGRADED_RAW });
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));

    expect(getDialog()).toBeNull();
    expect(changeVmTierMock).not.toHaveBeenCalled();
  });

  it('thrown exception during change shows friendly fallback (not raw error)', async () => {
    changeVmTierMock.mockRejectedValueOnce(new Error('ECONNRESET socket hang up'));

    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));
    click(getDialogButton('Switch speed'));
    await flushEffects();
    await flushEffects();

    expect(document.body.textContent).toContain(
      'Couldn\'t change the tier. Your cloud is still running on the previous tier.',
    );
    expect(document.body.textContent).not.toContain('ECONNRESET');
    expect(getDialog()).not.toBeNull();
  });

  it('renders a cheaper-tier delta in the success color (not destructive)', async () => {
    getVmTierMock.mockResolvedValueOnce({ success: true, tier: FASTER_TIER });
    mounted = mount(<VmTierSelector cachedTierId="faster" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Standard'));

    const delta = document.body.querySelector('[data-testid="vm-tier-cost-delta"]');
    expect(delta?.textContent).toMatch(/^-\$/);
    const color = (delta as HTMLElement | null)?.style.color ?? '';
    expect(color).toContain('--color-success');
  });

  it('sets aria-busy on the dialog body during the in-flight tier change', async () => {
    let resolveChange!: (value: unknown) => void;
    const changePromise = new Promise((resolve) => {
      resolveChange = resolve;
    });
    changeVmTierMock.mockReturnValueOnce(changePromise);

    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));
    click(getDialogButton('Switch speed'));
    await flushEffects();

    const dialog = getDialog();
    const busyBody = dialog?.querySelector('[aria-busy="true"]');
    expect(busyBody).not.toBeNull();

    resolveChange({ success: true, updated: true });
    await flushEffects();
    await flushEffects();
  });

  it('surfaces handler active-turn refusal message in the dialog', async () => {
    changeVmTierMock.mockResolvedValueOnce({
      success: false,
      error: 'Can\'t change tiers while a conversation is active. Wait for the current response to finish.',
    });

    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));
    click(getDialogButton('Switch speed'));
    await flushEffects();

    expect(document.body.textContent).toContain('Can\'t change tiers while a conversation is active');
    expect(getDialog()).not.toBeNull();
  });

  it('calls onTierChanged after successful change so parents can refresh cached settings', async () => {
    getVmTierMock
      .mockResolvedValueOnce({ success: true, tier: STANDARD_TIER })
      .mockResolvedValueOnce({ success: true, tier: FASTER_TIER });
    changeVmTierMock.mockResolvedValueOnce({
      success: true,
      updated: true,
      applied: true,
      healthVerified: true,
      settingsPersisted: true,
    });
    const onTierChanged = vi.fn();

    mounted = mount(<VmTierSelector cachedTierId="standard" onTierChanged={onTierChanged} />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));
    click(getDialogButton('Switch speed'));
    await flushEffects();
    await flushEffects();

    expect(onTierChanged).toHaveBeenCalledWith('faster');
  });

  it('calls onTierChangeStart when a new tier-change attempt begins', async () => {
    const onTierChangeStart = vi.fn();

    mounted = mount(<VmTierSelector cachedTierId="standard" onTierChangeStart={onTierChangeStart} />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));

    expect(onTierChangeStart).toHaveBeenCalledOnce();
  });

  it('shows an "approximate pricing" caveat in the confirmation dialog', async () => {
    mounted = mount(<VmTierSelector cachedTierId="standard" />);
    await flushEffects();

    click(getTierRadio(mounted.container, 'Faster'));

    const caveat = document.body.querySelector('[data-testid="vm-tier-pricing-caveat"]');
    expect(caveat).not.toBeNull();
    expect(caveat?.textContent).toMatch(/approximate/i);
    expect(caveat?.textContent?.toLowerCase()).toContain('fly.io');
  });

  describe('suggestion highlight (Stage E)', () => {
    it('renders a "Suggested" badge on the suggested tier card', async () => {
      mounted = mount(
        <VmTierSelector
          cachedTierId="standard"
          suggestedTierId="faster"
          suggestionReason="Cloud is running tight"
        />,
      );
      await flushEffects();

      const badge = mounted.container.querySelector('[data-testid="vm-tier-suggested-badge-faster"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toContain('Suggested');
    });

    it('does NOT show Suggested badge on the current tier', async () => {
      mounted = mount(
        <VmTierSelector
          cachedTierId="standard"
          suggestedTierId="standard"
        />,
      );
      await flushEffects();

      // current tier badge wins — no "Suggested" badge on it
      const badge = mounted.container.querySelector('[data-testid="vm-tier-suggested-badge-standard"]');
      expect(badge).toBeNull();
    });

    it('does NOT auto-open the confirmation dialog when suggestedTierId is provided', async () => {
      mounted = mount(
        <VmTierSelector
          cachedTierId="standard"
          suggestedTierId="faster"
        />,
      );
      await flushEffects();

      // Dialog must NOT be open automatically
      expect(getDialog()).toBeNull();
    });

    it('opens the confirmation dialog only after user clicks the suggested tier card', async () => {
      mounted = mount(
        <VmTierSelector
          cachedTierId="standard"
          suggestedTierId="faster"
        />,
      );
      await flushEffects();

      click(getTierRadio(mounted.container, 'Faster'));

      expect(getDialog()).not.toBeNull();
    });

    it('shows the suggestion reason copy inside the tier description', async () => {
      mounted = mount(
        <VmTierSelector
          cachedTierId="standard"
          suggestedTierId="faster"
          suggestionReason="Cloud is running tight"
        />,
      );
      await flushEffects();

      const fasterCard = getTierRadio(mounted.container, 'Faster');
      expect(fasterCard.textContent).toContain('Cloud is running tight');
    });

    it('shows no Suggested badge when suggestedTierId is undefined', async () => {
      mounted = mount(<VmTierSelector cachedTierId="standard" />);
      await flushEffects();

      const badge = mounted.container.querySelector('[data-testid^="vm-tier-suggested-badge-"]');
      expect(badge).toBeNull();
    });
  });
});
