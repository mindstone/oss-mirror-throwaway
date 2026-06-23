// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { MessageWorkDisclosure } from '../MessageWorkDisclosure';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderDisclosure(
  props: Partial<React.ComponentProps<typeof MessageWorkDisclosure>> = {},
): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MessageWorkDisclosure label="Show details" {...props}>
        <div data-testid="work-body">Inline tool work</div>
      </MessageWorkDisclosure>,
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

describe('MessageWorkDisclosure', () => {
  it('renders collapsed by default and expands on click', () => {
    const rendered = renderDisclosure();

    const button = rendered.container.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(rendered.container.querySelector('[data-testid="work-body"]')?.parentElement?.hidden).toBe(true);

    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(rendered.container.querySelector('[data-testid="work-body"]')?.parentElement?.hidden).toBe(false);

    rendered.unmount();
  });

  it('auto-opens when active or failed work is present', () => {
    const rendered = renderDisclosure({ forceOpenWhenActiveOrFailed: true });

    const button = rendered.container.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(rendered.container.querySelector('[data-testid="work-body"]')?.parentElement?.hidden).toBe(false);

    rendered.unmount();
  });
});
