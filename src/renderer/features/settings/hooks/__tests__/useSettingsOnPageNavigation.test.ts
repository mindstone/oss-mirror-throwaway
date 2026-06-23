// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import {
  getSettingsOnPageAnchors,
  createSettingsAnchorOwnerMap,
} from '../../components/settingsOnPageAnchorConfig';
import {
  resolveActiveAnchorId,
  useSettingsOnPageNavigation,
} from '../useSettingsOnPageNavigation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HookResult<T> = {
  result: { current: T };
  rerender: (props: Record<string, unknown>) => void;
  unmount: () => void;
};

function renderHook<T>(
  hookFn: (props: Record<string, unknown>) => T,
  initialProps: Record<string, unknown>,
): HookResult<T> {
  const result = { current: undefined as unknown as T };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const TestComponent = (props: Record<string, unknown>) => {
    result.current = hookFn(props);
    return null;
  };

  act(() => {
    root.render(React.createElement(TestComponent, initialProps));
  });

  return {
    result,
    rerender: (props) => {
      act(() => {
        root.render(React.createElement(TestComponent, props));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function mockRect(element: HTMLElement, top: number, height = 32) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 320,
    bottom: top + height,
    width: 320,
    height,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('settingsOnPageAnchors metadata', () => {
  it('maps nested advanced sections back to their owning anchors', () => {
    const anchors = getSettingsOnPageAnchors('advanced', { developerModeEnabled: true });
    const ownerMap = createSettingsAnchorOwnerMap(anchors);

    expect(ownerMap.get('pluginsActive')).toBe('labsPlugins');
    expect(ownerMap.get('pluginsArchived')).toBe('labsPlugins');
    expect(ownerMap.get('analytics')).toBe('developerTools');
    expect(ownerMap.get('appUpdates')).toBe('appUpdates');
  });

  it('hides developer anchors when developer mode is off', () => {
    const anchors = getSettingsOnPageAnchors('advanced', { developerModeEnabled: false });
    expect(anchors.some((anchor) => anchor.anchorId === 'developerTools')).toBe(false);
  });
});

describe('resolveActiveAnchorId', () => {
  it('selects the last observed section above the sticky threshold', () => {
    const anchors = getSettingsOnPageAnchors('advanced', { developerModeEnabled: true });
    const ownerMap = createSettingsAnchorOwnerMap(anchors);

    const activeAnchorId = resolveActiveAnchorId(
      [
        { sectionId: 'systemHealth', relativeTop: -20 },
        { sectionId: 'appUpdates', relativeTop: 18 },
        { sectionId: 'pluginsActive', relativeTop: 220 },
      ],
      ownerMap,
      72,
    );

    expect(activeAnchorId).toBe('appUpdates');
  });
});

describe('useSettingsOnPageNavigation', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? false : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('clears stale pending jumps back to the current anchor after timeout', () => {
    const scrollRoot = document.createElement('div');
    scrollRoot.setAttribute('data-settings-scroll-root', '');
    const stickyStrip = document.createElement('nav');
    stickyStrip.setAttribute('data-settings-on-page-strip', '');
    const coreDirectory = document.createElement('section');
    coreDirectory.setAttribute('data-section', 'coreDirectory');
    const scratchpad = document.createElement('section');
    scratchpad.setAttribute('data-section', 'scratchpad');

    scrollRoot.append(stickyStrip, coreDirectory, scratchpad);
    document.body.appendChild(scrollRoot);

    mockRect(scrollRoot, 0, 600);
    mockRect(stickyStrip, 0, 40);
    mockRect(coreDirectory, 24, 60);
    mockRect(scratchpad, 280, 60);

    const anchors = getSettingsOnPageAnchors('workspace', { developerModeEnabled: false });

    const { result, unmount } = renderHook(
      (props) =>
        useSettingsOnPageNavigation({
          destination: props.destination as 'workspace',
          activeLeafTab: props.activeLeafTab as 'spaces',
          anchors: props.anchors as typeof anchors,
          incomingSection: props.incomingSection as string | undefined,
        }),
      {
        destination: 'workspace',
        activeLeafTab: 'spaces',
        anchors,
        incomingSection: undefined,
      },
    );

    expect(result.current.activeAnchorId).toBe('coreDirectory');

    act(() => {
      result.current.beginExplicitJump('cloudSync');
    });

    expect(result.current.activeAnchorId).toBe('cloudSync');

    act(() => {
      vi.advanceTimersByTime(1700);
    });

    expect(result.current.activeAnchorId).toBe('coreDirectory');
    unmount();
  });
});
