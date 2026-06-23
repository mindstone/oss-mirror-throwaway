// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Popup } from './popup';

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

describe('Popup', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      action: {
        setBadgeText: vi.fn(async () => undefined),
      },
      windows: {
        getCurrent: vi.fn(async () => ({ id: 1 })),
      },
      runtime: {
        sendMessage: vi
          .fn()
          .mockResolvedValueOnce({ status: { kind: 'boot-token-missing' } })
          .mockResolvedValue(undefined),
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn(async () => ({
            'rebel.pairing.v1': { clientId: 'browser-0123456789abcdef' },
          })),
        },
        session: {
          get: vi.fn(async () => ({})),
        },
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders install-from-Rebel guidance with no code input', async () => {
    mounted = mount(<Popup />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mounted.container.textContent).toContain('Open Rebel, start the browser install there');
    expect(mounted.container.querySelector('input')).toBeNull();
    expect(mounted.container.textContent).not.toContain('6-digit');
    expect(mounted.container.textContent).not.toContain('security code');
  });
});
