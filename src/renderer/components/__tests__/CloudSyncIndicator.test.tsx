// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudInstanceConfig } from '@shared/types';
import { CloudSyncIndicator } from '../CloudSyncIndicator';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalCloudApi = window.cloudApi;

function createCloudInstance(): CloudInstanceConfig {
  return {
    mode: 'cloud',
    cloudUrl: 'https://managed.example.com',
    cloudToken: 'token-123',
  };
}

interface RenderOptions {
  status?: 'warm' | 'provisioning' | 'offline' | 'error';
  cloudInstance?: CloudInstanceConfig;
  pressureState?: 'ok' | 'warning' | 'critical' | 'unknown';
  onPressureStateCallback?: (cb: (data: { state: 'ok' | 'warning' | 'critical' | 'unknown'; timestamp: number; recentPressureEvents?: unknown[] }) => void) => () => void;
}

async function renderIndicator(
  statusOrOptions: 'warm' | 'provisioning' | RenderOptions = 'warm',
): Promise<{ root: Root; button: HTMLButtonElement | null }> {
  const options: RenderOptions =
    typeof statusOrOptions === 'string' ? { status: statusOrOptions } : statusOrOptions;
  const { status = 'warm', cloudInstance: ci, pressureState, onPressureStateCallback } = options;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const instance: CloudInstanceConfig = ci ?? {
    ...createCloudInstance(),
    ...(pressureState ? { lastPressureState: pressureState } : {}),
  };

  Object.defineProperty(window, 'cloudApi', {
    configurable: true,
    writable: true,
    value: {
      status: vi.fn().mockResolvedValue({ status }),
      outboxStatus: vi.fn().mockResolvedValue({ pending: 0, failed: 0 }),
      onOutboxChanged: vi.fn().mockReturnValue(() => {}),
      onPressureState: onPressureStateCallback ?? vi.fn().mockReturnValue(() => {}),
    } as unknown as typeof window.cloudApi,
  });

  await act(async () => {
    root.render(
      <CloudSyncIndicator cloudInstance={instance} />,
    );
  });

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    root,
    button: document.body.querySelector('button[aria-label]'),
  };
}

describe('CloudSyncIndicator', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    Object.defineProperty(window, 'cloudApi', {
      configurable: true,
      writable: true,
      value: originalCloudApi,
    });
    vi.restoreAllMocks();
  });

  it('treats warm status as a healthy synced state', async () => {
    const { root, button } = await renderIndicator('warm');

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('Cloud synced — managed.example.com');

    act(() => { root.unmount(); });
  });

  it('treats provisioning status as a healthy synced state', async () => {
    const { root, button } = await renderIndicator('provisioning');

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('Cloud synced — managed.example.com');

    act(() => { root.unmount(); });
  });

  describe('pressure states', () => {
    it('shows pressure-warning tooltip when lastPressureState is warning', async () => {
      const { root, button } = await renderIndicator({ pressureState: 'warning' });

      expect(button?.getAttribute('aria-label')).toBe(
        'Cloud is running tight — review speed options',
      );
      expect(button?.className).toContain('cloud-sync-indicator--pressure-warning');

      act(() => { root.unmount(); });
    });

    it('shows pressure-critical tooltip when lastPressureState is critical', async () => {
      const { root, button } = await renderIndicator({ pressureState: 'critical' });

      expect(button?.getAttribute('aria-label')).toBe(
        'Cloud needs more room — review speed options',
      );
      expect(button?.className).toContain('cloud-sync-indicator--pressure-critical');

      act(() => { root.unmount(); });
    });

    it('shows managed-cloud tooltip variant for critical pressure on managed cloud', async () => {
      const managedInstance: CloudInstanceConfig = {
        ...createCloudInstance(),
        provisionMode: 'managed',
        lastPressureState: 'critical',
      };
      const { root, button } = await renderIndicator({ cloudInstance: managedInstance });

      expect(button?.getAttribute('aria-label')).toBe(
        'Cloud needs more room — Mindstone is handling it',
      );

      act(() => { root.unmount(); });
    });

    it('honours state hierarchy: offline > pressure-critical', async () => {
      const { root, button } = await renderIndicator({
        status: 'offline',
        pressureState: 'critical',
      });

      // offline wins
      expect(button?.className).toContain('cloud-sync-indicator--offline');

      act(() => { root.unmount(); });
    });

    it('honours state hierarchy: pressure-critical > error', async () => {
      // When cloud health returns error AND pressure is critical, critical wins
      const { root, button } = await renderIndicator({
        status: 'error',
        pressureState: 'critical',
      });

      expect(button?.className).toContain('cloud-sync-indicator--pressure-critical');

      act(() => { root.unmount(); });
    });

    it('pressure-warning is clickable (calls onNavigateToCloud)', async () => {
      const onNavigate = vi.fn();
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      const instance: CloudInstanceConfig = {
        ...createCloudInstance(),
        lastPressureState: 'warning',
      };

      Object.defineProperty(window, 'cloudApi', {
        configurable: true,
        writable: true,
        value: {
          status: vi.fn().mockResolvedValue({ status: 'warm' }),
          outboxStatus: vi.fn().mockResolvedValue({ pending: 0, failed: 0 }),
          onOutboxChanged: vi.fn().mockReturnValue(() => {}),
          onPressureState: vi.fn().mockReturnValue(() => {}),
        } as unknown as typeof window.cloudApi,
      });

      await act(async () => {
        root.render(<CloudSyncIndicator cloudInstance={instance} onNavigateToCloud={onNavigate} />);
      });
      await act(async () => { await Promise.resolve(); });

      const btn = document.body.querySelector<HTMLButtonElement>('button[aria-label]');
      await act(async () => { btn?.click(); });

      expect(onNavigate).toHaveBeenCalledTimes(1);

      act(() => { root.unmount(); });
    });

    it('updates pressure state via onPressureState push callback', async () => {
      let pushCallback: ((data: { state: 'ok' | 'warning' | 'critical' | 'unknown'; timestamp: number }) => void) | null = null;

      const { root, button: initialButton } = await renderIndicator({
        pressureState: 'ok',
        onPressureStateCallback: (cb) => {
          pushCallback = cb;
          return () => {};
        },
      });

      // Initially synced
      expect(initialButton?.className).not.toContain('pressure');

      // Simulate push event
      await act(async () => {
        pushCallback?.({ state: 'warning', timestamp: Date.now() });
      });

      const updatedButton = document.body.querySelector<HTMLButtonElement>('button[aria-label]');
      expect(updatedButton?.className).toContain('cloud-sync-indicator--pressure-warning');

      act(() => { root.unmount(); });
    });
  });
});
