// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectSlackMcpActionTesting,
  useConnectSlackMcpAction,
  type UseConnectSlackMcpActionOptions,
  type UseConnectSlackMcpActionResult,
} from '../useConnectSlackMcpAction';
import type { ConnectorCatalogEntry } from '@shared/types';

const trackingMocks = vi.hoisted(() => ({
  connectorConnected: vi.fn(),
  connectorConnectionFailed: vi.fn(),
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    settings: trackingMocks,
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

const slackCatalogEntry: ConnectorCatalogEntry = {
  id: 'bundled-slack',
  name: 'Slack',
  description: 'Team messaging',
  icon: 'MessageSquare',
  provider: 'bundled',
  category: 'communication',
  bundledConfig: {
    serverName: 'Slack',
    authType: 'oauth',
    authApi: 'slackApi',
  },
};

interface MountedHook {
  result: { current: UseConnectSlackMcpActionResult };
  unmount: () => void;
}

function mountHook(
  onConfigureWithRebel: UseConnectSlackMcpActionOptions['onConfigureWithRebel'] = undefined,
): MountedHook {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const result = { current: undefined as unknown as UseConnectSlackMcpActionResult };

  function Harness() {
    result.current = useConnectSlackMcpAction({ onConfigureWithRebel });
    return null;
  }

  act(() => {
    root.render(React.createElement(Harness));
  });

  return {
    result,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useConnectSlackMcpAction', () => {
  let originalSlackApi: typeof window.slackApi;
  let originalSettingsApi: typeof window.settingsApi;

  beforeEach(() => {
    vi.clearAllMocks();
    connectSlackMcpActionTesting.reset();
    originalSlackApi = window.slackApi;
    originalSettingsApi = window.settingsApi;
    Object.defineProperty(window, 'slackApi', {
      configurable: true,
      writable: true,
      value: {
        startAuth: vi.fn().mockResolvedValue({ success: true, teamName: 'Acme Slack' }),
      },
    });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      writable: true,
      value: {
        mcpAddBundledServer: vi.fn().mockResolvedValue({ success: true }),
      },
    });
  });

  afterEach(() => {
    connectSlackMcpActionTesting.reset();
    Object.defineProperty(window, 'slackApi', {
      configurable: true,
      writable: true,
      value: originalSlackApi,
    });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      writable: true,
      value: originalSettingsApi,
    });
    document.body.innerHTML = '';
  });

  it('runs one Slack connect flow with side effects in order', async () => {
    const order: string[] = [];
    window.slackApi.startAuth = vi.fn().mockImplementation(async () => {
      order.push('startAuth');
      return { success: true, teamName: 'Acme Slack' };
    });
    trackingMocks.connectorConnected.mockImplementation(() => {
      order.push('connectorConnected');
    });
    const onConfigureWithRebel = vi.fn().mockImplementation(() => {
      order.push('launchRebel');
    });
    const mounted = mountHook(onConfigureWithRebel);

    await act(async () => {
      await mounted.result.current.connect({
        connectionName: 'Slack',
        category: 'communication',
        catalogEntry: slackCatalogEntry,
        launchRebel: true,
        connectStartedAt: Date.parse('2026-05-23T12:00:00.000Z'),
        connectorType: 'bundled',
      });
    });

    expect(order).toEqual(['startAuth', 'connectorConnected', 'launchRebel']);
    expect(window.slackApi.startAuth).toHaveBeenCalledTimes(1);
    expect(window.settingsApi.mcpAddBundledServer).not.toHaveBeenCalled();
    expect(trackingMocks.connectorConnected).toHaveBeenCalledWith('Slack', 'communication', 'oauth');
    expect(onConfigureWithRebel).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'Slack-acme-slack',
      catalogEntry: slackCatalogEntry,
      setupResult: { success: true, error: undefined },
      oauthResult: expect.objectContaining({
        success: true,
        accountIdentity: 'Acme Slack',
      }),
      isNewConnection: true,
    }));
    expect(mounted.result.current.isInFlight).toBe(false);
    mounted.unmount();
  });

  it('joins two simultaneous same-microtask connect calls to one in-flight promise', async () => {
    const deferred = createDeferred<{ success: boolean; teamName: string }>();
    window.slackApi.startAuth = vi.fn(() => deferred.promise);
    const mounted = mountHook();

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      firstPromise = mounted.result.current.connect({ connectionName: 'Slack' });
      secondPromise = mounted.result.current.connect({ connectionName: 'Slack' });
    });

    expect(firstPromise).toBe(secondPromise);
    expect(window.slackApi.startAuth).toHaveBeenCalledTimes(1);
    expect(mounted.result.current.isInFlight).toBe(true);

    deferred.resolve({ success: true, teamName: 'Acme Slack' });
    await act(async () => {
      await Promise.all([firstPromise, secondPromise]);
    });

    expect(trackingMocks.connectorConnected).toHaveBeenCalledTimes(1);
    expect(mounted.result.current.isInFlight).toBe(false);
    mounted.unmount();
  });

  it('runs two independent flows when the second call starts after the first resolves', async () => {
    const mounted = mountHook();

    await act(async () => {
      await mounted.result.current.connect({ connectionName: 'Slack' });
    });
    await act(async () => {
      await mounted.result.current.connect({ connectionName: 'Slack' });
    });

    expect(window.slackApi.startAuth).toHaveBeenCalledTimes(2);
    expect(trackingMocks.connectorConnected).toHaveBeenCalledTimes(2);
    mounted.unmount();
  });

  it('propagates errors, clears the lock after rejection, and lets the next call start fresh', async () => {
    window.slackApi.startAuth = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'Slack said no' })
      .mockResolvedValueOnce({ success: true, teamName: 'Acme Slack' });
    const mounted = mountHook();

    await expect(
      act(async () => {
        await mounted.result.current.connect({
          connectionName: 'Slack',
          category: 'communication',
          connectStartedAt: Date.parse('2026-05-23T12:00:00.000Z'),
        });
      }),
    ).rejects.toThrow('Slack said no');

    expect(mounted.result.current.isInFlight).toBe(false);
    expect(connectSlackMcpActionTesting.getInFlightSnapshot()).toBe(false);
    expect(trackingMocks.connectorConnectionFailed).toHaveBeenCalledWith(
      'Slack',
      'communication',
      'bundled_setup_failed',
      'Slack said no',
      expect.objectContaining({
        connectorType: 'bundled',
        lastOauthStep: 'not_started',
        source: 'settings_ui',
      }),
    );

    await act(async () => {
      await mounted.result.current.connect({ connectionName: 'Slack' });
    });

    expect(window.slackApi.startAuth).toHaveBeenCalledTimes(2);
    expect(trackingMocks.connectorConnected).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('notifies subscribers when the promise lock is acquired and released', async () => {
    const deferred = createDeferred<{ success: boolean; teamName: string }>();
    window.slackApi.startAuth = vi.fn(() => deferred.promise);
    const snapshots: boolean[] = [];
    const unsubscribe = connectSlackMcpActionTesting.subscribeToInFlight(() => {
      snapshots.push(connectSlackMcpActionTesting.getInFlightSnapshot());
    });

    const promise = connectSlackMcpActionTesting.connectSlackMcp({ connectionName: 'Slack' });
    expect(snapshots).toEqual([true]);

    deferred.resolve({ success: true, teamName: 'Acme Slack' });
    await promise;

    expect(snapshots).toEqual([true, false]);
    unsubscribe();
  });
});
