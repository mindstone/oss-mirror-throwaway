// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useIsOssBuild } from '../useIsOssBuild';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Config = Awaited<ReturnType<Window['authApi']['getConfig']>>;

interface Harness {
  getValue: () => boolean;
  unmount: () => void;
}

let authConfigListener: (() => void) | null = null;
let fallbackConfigListener: (() => void) | null = null;
let currentConfig: Config = null;

function installAuthApis(options: { authEvents?: boolean } = { authEvents: true }): void {
  authConfigListener = null;
  fallbackConfigListener = null;

  window.authApi = {
    ...(window.authApi ?? {}),
    getConfig: vi.fn(async () => currentConfig),
    onAuthConfigReceived: options.authEvents === false
      ? undefined
      : vi.fn((callback: () => void) => {
          authConfigListener = callback;
          return () => {
            authConfigListener = null;
          };
        }),
  } as Window['authApi'];

  window.api = {
    ...(window.api ?? {}),
    onAuthConfigReceived: vi.fn((callback: () => void) => {
      fallbackConfigListener = callback;
      return () => {
        fallbackConfigListener = null;
      };
    }),
  } as Window['api'];
}

function renderHook(): Harness {
  let value = false;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const TestComponent = () => {
    value = useIsOssBuild();
    return null;
  };

  act(() => {
    root.render(<TestComponent />);
  });

  return {
    getValue: () => value,
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

describe('useIsOssBuild', () => {
  beforeEach(() => {
    currentConfig = null;
    installAuthApis();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('defaults false before config resolves', () => {
    currentConfig = { isOssBuild: true } as Config;
    const hook = renderHook();
    expect(hook.getValue()).toBe(false);
    hook.unmount();
  });

  it.each([
    { label: 'explicit true', config: { isOssBuild: true }, expected: true },
    { label: 'explicit false', config: { isOssBuild: false }, expected: false },
    { label: 'omitted', config: {}, expected: false },
    { label: 'null', config: null, expected: false },
  ])('returns $expected for $label config', async ({ config, expected }) => {
    currentConfig = config as Config;
    const hook = renderHook();

    await flushAsync();

    expect(hook.getValue()).toBe(expected);
    hook.unmount();
  });

  it('refreshes when auth config is received', async () => {
    currentConfig = { isOssBuild: false } as Config;
    const hook = renderHook();
    await flushAsync();
    expect(hook.getValue()).toBe(false);

    currentConfig = { isOssBuild: true } as Config;
    await act(async () => {
      authConfigListener?.();
      await Promise.resolve();
    });

    expect(hook.getValue()).toBe(true);
    hook.unmount();
  });

  it('uses window.api auth-config events when window.authApi event helper is absent', async () => {
    installAuthApis({ authEvents: false });
    currentConfig = { isOssBuild: false } as Config;
    const hook = renderHook();
    await flushAsync();

    currentConfig = { isOssBuild: true } as Config;
    await act(async () => {
      fallbackConfigListener?.();
      await Promise.resolve();
    });

    expect(hook.getValue()).toBe(true);
    hook.unmount();
  });
});
