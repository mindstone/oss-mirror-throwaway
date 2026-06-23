// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderReachabilitySection } from '../ProviderReachabilitySection';
import type {
  ProviderId,
  ProviderReachabilitySnapshot,
} from '@shared/diagnostics/providerReachabilitySnapshot';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

function emptySnapshot(): ProviderReachabilitySnapshot {
  return {
    snapshotPresent: false,
    lastRefreshAt: null,
    providers: {},
  };
}

function snapshotWith(
  providers: Partial<Record<ProviderId, 'reachable' | 'unreachable'>>,
  nowMs = Date.now(),
): ProviderReachabilitySnapshot {
  return {
    snapshotPresent: true,
    lastRefreshAt: nowMs,
    providers: Object.fromEntries(
      Object.entries(providers).map(([provider, status]) => [
        provider,
        {
          status,
          checkedAt: nowMs,
          cachedAt: nowMs,
          expiresAt: nowMs + 30_000,
          stale: false,
          ...(status === 'unreachable' ? { errorCode: 'timeout' as const } : {}),
        },
      ]),
    ) as ProviderReachabilitySnapshot['providers'],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function mount(ui: React.ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  await act(async () => {
    await Promise.resolve();
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

describe('ProviderReachabilitySection', () => {
  let mounted: Mounted | null = null;
  const getProviderReachabilitySnapshot = vi.fn();
  const refreshProviderReachabilityCache = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
    getProviderReachabilitySnapshot.mockReset();
    refreshProviderReachabilityCache.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getProviderReachabilitySnapshot.mockResolvedValue(emptySnapshot());
    refreshProviderReachabilityCache.mockResolvedValue(snapshotWith({ anthropic: 'reachable' }));
    Object.defineProperty(window, 'diagnosticsApi', {
      configurable: true,
      value: {
        getProviderReachabilitySnapshot,
        refreshProviderReachabilityCache,
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders initial empty state with button and privacy line', async () => {
    mounted = await mount(<ProviderReachabilitySection activeProvider="anthropic" />);

    expect(mounted.container.textContent).toContain(
      'Quick connection check only. No prompts, files, or API keys are sent.',
    );
    expect(mounted.container.textContent).toContain('Check AI services');
    expect(mounted.container.textContent).toContain(
      'Not checked yet. Press the button. The button has one job.',
    );
    expect(mounted.container.textContent).toContain('Anthropic');
    expect(mounted.container.textContent).toContain('Current');
  });

  it('click starts an in-flight probe with disabled Checking button', async () => {
    const refresh = deferred<ProviderReachabilitySnapshot>();
    refreshProviderReachabilityCache.mockReturnValue(refresh.promise);
    mounted = await mount(<ProviderReachabilitySection activeProvider="anthropic" />);

    const button = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Check AI services'),
    )!;
    click(button);

    expect(refreshProviderReachabilityCache).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(mounted.container.textContent).toContain('Checking…');
    expect(mounted.container.textContent).toContain('Checking');

    await act(async () => {
      refresh.resolve(snapshotWith({ anthropic: 'reachable' }));
      await refresh.promise;
    });
  });

  it('probe success shows success Notice and reachable rows', async () => {
    mounted = await mount(<ProviderReachabilitySection activeProvider="anthropic" />);

    const button = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Check AI services'),
    )!;
    click(button);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mounted.container.textContent).toContain('AI services are reachable.');
    expect(mounted.container.textContent).toContain('Reachable');
  });

  it('probe partial failure shows warning Notice and failed row', async () => {
    refreshProviderReachabilityCache.mockResolvedValue(
      snapshotWith({ anthropic: 'reachable', openrouter: 'unreachable' }),
    );
    mounted = await mount(<ProviderReachabilitySection activeProvider="anthropic" />);

    const button = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Check AI services'),
    )!;
    click(button);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mounted.container.textContent).toContain('Some AI services need attention.');
    expect(mounted.container.textContent).toContain("Can't reach");
    expect(mounted.container.textContent).toContain('Timed out');
  });

  it('click during cache TTL does not re-probe and shows checked age', async () => {
    mounted = await mount(<ProviderReachabilitySection activeProvider="anthropic" />);

    const button = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Check AI services'),
    )!;
    click(button);
    await act(async () => {
      await Promise.resolve();
    });
    expect(refreshProviderReachabilityCache).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    click(button);

    expect(refreshProviderReachabilityCache).toHaveBeenCalledTimes(1);
    expect(mounted.container.textContent).toMatch(/Checked \d+s ago/);
  });

  it('click after TTL expires re-runs the probe', async () => {
    mounted = await mount(<ProviderReachabilitySection activeProvider="anthropic" />);

    const button = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Check AI services'),
    )!;
    click(button);
    await act(async () => {
      await Promise.resolve();
    });
    expect(refreshProviderReachabilityCache).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(30_001);
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    click(button);
    await act(async () => {
      await Promise.resolve();
    });

    expect(refreshProviderReachabilityCache).toHaveBeenCalledTimes(2);
  });

  it('renders refresh errors with the specified error copy', async () => {
    refreshProviderReachabilityCache.mockRejectedValue(new Error('offline'));
    mounted = await mount(<ProviderReachabilitySection activeProvider="anthropic" />);

    const button = Array.from(mounted.container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Check AI services'),
    )!;
    click(button);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mounted.container.textContent).toContain(
      "Couldn't check AI services. Your network may be blocking the check, or Rebel tripped over a cable. Try again.",
    );
  });
});
