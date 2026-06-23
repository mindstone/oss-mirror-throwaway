// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Tooltip } from '../Tooltip';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderTooltip(): { button: HTMLButtonElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <Tooltip content="Helpful tooltip" clickToToggle defaultOpen delayShow={0}>
        <button type="button">Toggle tooltip</button>
      </Tooltip>,
    );
  });

  const button = container.querySelector('button');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Expected tooltip trigger button');
  }

  return {
    button,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function expectTooltip(open: boolean): void {
  expect(Boolean(document.body.querySelector('[role="tooltip"]'))).toBe(open);
}

describe('Tooltip', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('toggles clickToToggle tooltips with click, Enter, and Space', () => {
    const rendered = renderTooltip();

    expectTooltip(true);

    act(() => {
      rendered.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expectTooltip(false);

    act(() => {
      rendered.button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expectTooltip(true);

    act(() => {
      rendered.button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expectTooltip(false);

    rendered.unmount();
  });
});
