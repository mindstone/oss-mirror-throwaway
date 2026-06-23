// @vitest-environment happy-dom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BtsTaskOverridesStoryBodyTheme,
  type BtsTaskOverridesStoryTheme,
} from '../BtsTaskOverridesStoryTheme';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function mountStoryTheme(theme: BtsTaskOverridesStoryTheme): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <BtsTaskOverridesStoryBodyTheme theme={theme}>
        <div>Story content</div>
      </BtsTaskOverridesStoryBodyTheme>,
    );
  });

  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function bodyThemeClasses(): string[] {
  return ['light', 'dark'].filter((theme) => document.body.classList.contains(theme));
}

describe('BtsTaskOverrides stories', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.classList.remove('light', 'dark');
    document.body.innerHTML = '';
  });

  it.each([
    'light',
    'dark',
  ] as const)('sets exactly one body theme class for the %s story wrapper', (theme) => {
    mounted = mountStoryTheme(theme);

    expect(bodyThemeClasses()).toEqual([theme]);
  });
});
