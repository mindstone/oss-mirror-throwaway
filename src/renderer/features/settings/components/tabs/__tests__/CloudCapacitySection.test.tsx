// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { CloudCapacitySection } from '../CloudTab';
import { recommendVolumeGb } from '../../../../../../core/services/cloud/providers/volumeDefaults';
import { getTierById, type VmTier } from '../../../../../../core/services/cloud/vmTierCatalog';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    rerender: (nextElement: React.ReactElement) => {
      act(() => {
        root.render(nextElement);
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function okVolume(percent: number) {
  const totalBytes = 100 * 1024 ** 3;
  const usedBytes = totalBytes * (percent / 100);
  return {
    kind: 'ok' as const,
    sizeGb: 100,
    totalBytes,
    usedBytes,
    availableBytes: totalBytes - usedBytes,
    lastCheckedAt: 1000,
  };
}

function renderSection(volume = okVolume(49)) {
  return render(
    <CloudCapacitySection
      currentVmTierId="standard"
      tierSelectorDisabled={false}
      lastTierChangeSuccess={null}
      volume={volume}
      loading={false}
      resizing={false}
      resizeResult={null}
      onTierChanged={vi.fn()}
      onTierChangeStart={vi.fn()}
      onDismissTierChangeNotice={vi.fn()}
      onDismissResizeResult={vi.fn()}
      onDismissPressureNotice={vi.fn()}
      onPollNow={vi.fn()}
      onResize={vi.fn().mockResolvedValue({ success: true, sizeGbAfter: 125 })}
    />,
  );
}

function click(element: Element | null) {
  if (!element) {
    throw new Error('Expected element to exist');
  }
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

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const originalCloudApi = window.cloudApi;

function installCloudApiMock() {
  const standardTier = getTierById('standard') as VmTier;
  const fasterTier = getTierById('faster') as VmTier;
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
  };
  (window as unknown as { cloudApi: Window['cloudApi'] }).cloudApi = api as unknown as Window['cloudApi'];
  return { api, fasterTier };
}

afterEach(() => {
  (window as unknown as { cloudApi: Window['cloudApi'] }).cloudApi = originalCloudApi;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('CloudCapacitySection', () => {
  it.each([
    [49, 'calm'],
    [50, 'mention'],
    [79, 'mention'],
    [80, 'warning'],
    [94, 'warning'],
    [95, 'urgent'],
  ])('renders threshold tone at %s%%', (percent, tone) => {
    const { container, unmount } = renderSection(okVolume(percent));

    expect(container.querySelector('[data-testid="cloud-storage-meter"]')?.getAttribute('data-tone')).toBe(tone);
    unmount();
  });

  it('renders token-missing Notice in-section', () => {
    const { container, unmount } = render(
      <CloudCapacitySection
        currentVmTierId="standard"
        tierSelectorDisabled={false}
        lastTierChangeSuccess={null}
        volume={{ kind: 'fly_token_missing' }}
        loading={false}
        resizing={false}
        resizeResult={null}
        onTierChanged={vi.fn()}
        onTierChangeStart={vi.fn()}
      onDismissTierChangeNotice={vi.fn()}
      onDismissResizeResult={vi.fn()}
      onDismissPressureNotice={vi.fn()}
      onPollNow={vi.fn()}
      onResize={vi.fn()}
    />,
  );

    expect(container.querySelector('[data-testid="cloud-storage-token-missing"]')?.textContent).toContain('Connect your Fly token');
    unmount();
  });

  it('defaults resize Dialog size to recommendVolumeGb(usedBytes) when usage is known', () => {
    const usedBytes = 6.8 * 1024 ** 3;
    const volume = {
      kind: 'ok' as const,
      sizeGb: 10,
      totalBytes: 10 * 1024 ** 3,
      usedBytes,
      availableBytes: 3.2 * 1024 ** 3,
      lastCheckedAt: 1000,
    };
    const { container, unmount } = renderSection(volume);

    act(() => {
      (container.querySelector('[data-testid="cloud-storage-add-button"]') as HTMLButtonElement).click();
    });

    const input = document.body.querySelector('[data-testid="cloud-storage-target-input"]') as HTMLInputElement;
    expect(input.value).toBe(String(recommendVolumeGb(usedBytes)));
    unmount();
  });

  it('renders Speed above Storage in Cloud capacity', () => {
    const { container, unmount } = renderSection(okVolume(49));

    const speedRow = container.querySelector('[data-testid="cloud-speed-row"]');
    const storageRow = container.querySelector('[data-testid="cloud-storage-row"]');

    expect(speedRow).not.toBeNull();
    expect(storageRow).not.toBeNull();
    expect(speedRow?.compareDocumentPosition(storageRow as Node) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    unmount();
  });

  it('renders tier-change success Notice persistently, clears on dismiss, and clears when a new tier change starts', async () => {
    installCloudApiMock();

    function Harness({ revision }: { revision: number }) {
      const [notice, setNotice] = React.useState<{ tierLabel: string } | null>({ tierLabel: 'Faster' });
      return (
        <div data-revision={revision}>
          <CloudCapacitySection
            currentVmTierId="standard"
            tierSelectorDisabled={false}
            lastTierChangeSuccess={notice}
            volume={okVolume(49)}
            loading={false}
            resizing={false}
            resizeResult={null}
            onTierChanged={(tierId) => {
              setNotice({ tierLabel: getTierById(tierId)?.label ?? 'Cloud speed' });
            }}
            onTierChangeStart={() => setNotice(null)}
            onDismissTierChangeNotice={() => setNotice(null)}
            onDismissResizeResult={vi.fn()}
            onDismissPressureNotice={vi.fn()}
            onPollNow={vi.fn()}
            onResize={vi.fn().mockResolvedValue({ success: true })}
          />
        </div>
      );
    }

    const { container, rerender, unmount } = render(<Harness revision={1} />);
    await flushEffects();

    expect(container.querySelector('[data-testid="cloud-tier-change-success"]')?.textContent).toContain(
      'Faster is now active. Same Fly machine, new size. Storage unchanged.',
    );

    rerender(<Harness revision={2} />);
    await flushEffects();
    expect(container.querySelector('[data-testid="cloud-tier-change-success"]')?.textContent).toContain(
      'Faster is now active. Same Fly machine, new size. Storage unchanged.',
    );

    click(container.querySelector('[aria-label="Dismiss notice"]'));
    expect(container.querySelector('[data-testid="cloud-tier-change-success"]')).toBeNull();

    click(getTierRadio(container, 'Faster'));
    click(document.body.querySelector('[data-testid="vm-tier-dialog"] button:last-of-type'));
    await flushEffects();
    await flushEffects();
    expect(container.querySelector('[data-testid="cloud-tier-change-success"]')?.textContent).toContain(
      'Faster is now active. Same Fly machine, new size. Storage unchanged.',
    );

    click(getTierRadio(container, 'Heavy work'));
    expect(container.querySelector('[data-testid="cloud-tier-change-success"]')).toBeNull();
    unmount();
  });
});
