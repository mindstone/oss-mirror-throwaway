// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { InboxCardFrame } from '../InboxCardFrame';

function renderComponent(props: React.ComponentProps<typeof InboxCardFrame>): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: ReturnType<typeof ReactDOMClient.createRoot>;
  reactAct(() => {
    root = ReactDOMClient.createRoot(container);
    root.render(<InboxCardFrame {...props} />);
  });
  return {
    container,
    unmount: () => {
      reactAct(() => root.unmount());
      container.remove();
    },
  };
}

describe('InboxCardFrame', () => {
  describe('click activation', () => {
    it('calls onActivate when clicking non-interactive content', () => {
      const onActivate = vi.fn();
      const { container, unmount } = renderComponent({
        itemId: 'test-1',
        children: <span data-testid="plain-text">Hello</span>,
        onActivate,
      });
      const text = container.querySelector('[data-testid="plain-text"]')!;
      reactAct(() => { text.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onActivate).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('does NOT call onActivate when clicking a button inside card body', () => {
      const onActivate = vi.fn();
      const onClick = vi.fn();
      const { container, unmount } = renderComponent({
        itemId: 'test-2',
        children: <button data-testid="inner-btn" onClick={onClick}>Action</button>,
        onActivate,
      });
      const btn = container.querySelector('[data-testid="inner-btn"]')!;
      reactAct(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onActivate).not.toHaveBeenCalled();
      unmount();
    });

    it('does NOT call onActivate when clicking an input inside card body', () => {
      const onActivate = vi.fn();
      const { container, unmount } = renderComponent({
        itemId: 'test-3',
        children: <input data-testid="inner-input" />,
        onActivate,
      });
      const input = container.querySelector('[data-testid="inner-input"]')!;
      reactAct(() => { input.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onActivate).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('keyboard activation', () => {
    it('calls onActivate when Enter is pressed on the card itself', () => {
      const onActivate = vi.fn();
      const { container, unmount } = renderComponent({
        itemId: 'test-4',
        children: <span>Content</span>,
        onActivate,
      });
      const card = container.querySelector('[data-testid="inbox-item-card"]')!;
      reactAct(() => {
        card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(onActivate).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('does NOT call onActivate when Enter is pressed on an inner button', () => {
      const onActivate = vi.fn();
      const { container, unmount } = renderComponent({
        itemId: 'test-5',
        children: <button data-testid="inner-btn">Action</button>,
        onActivate,
      });
      const btn = container.querySelector('[data-testid="inner-btn"]')!;
      reactAct(() => {
        btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(onActivate).not.toHaveBeenCalled();
      unmount();
    });
  });
});
