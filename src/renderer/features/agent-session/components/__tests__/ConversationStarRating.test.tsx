// @vitest-environment happy-dom

import React, { act } from 'react';
import { fireEvent } from '@testing-library/dom';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ConversationStarRating } from '../ConversationStarRating';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderStarRating(
  props: Partial<React.ComponentProps<typeof ConversationStarRating>> = {},
): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ConversationStarRating
        value={null}
        onSelect={vi.fn()}
        testIdPrefix="conversation-star-rating"
        {...props}
      />,
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

function getStarButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
}

describe('ConversationStarRating', () => {
  it('renders five radio buttons with the expected ARIA labels', () => {
    const rendered = renderStarRating();
    const group = rendered.container.querySelector('[role="radiogroup"]');
    const stars = getStarButtons(rendered.container);

    expect(group?.getAttribute('aria-label')).toBe('Rate this response');
    expect(stars).toHaveLength(5);
    expect(stars[0].getAttribute('aria-label')).toBe('1 star, Bad');
    expect(stars[1].getAttribute('aria-label')).toBe('2 stars');
    expect(stars[2].getAttribute('aria-label')).toBe('3 stars');
    expect(stars[3].getAttribute('aria-label')).toBe('4 stars');
    expect(stars[4].getAttribute('aria-label')).toBe('5 stars, Great');

    rendered.unmount();
  });

  it('fills stars up to the hovered star', () => {
    const rendered = renderStarRating();
    const stars = getStarButtons(rendered.container);

    act(() => {
      fireEvent.mouseOver(stars[3]);
    });

    expect(stars[0].dataset.filled).toBe('true');
    expect(stars[1].dataset.filled).toBe('true');
    expect(stars[2].dataset.filled).toBe('true');
    expect(stars[3].dataset.filled).toBe('true');
    expect(stars[4].dataset.filled).toBe('false');

    rendered.unmount();
  });

  it('moves focus and preview with Arrow/Home/End keys', () => {
    const rendered = renderStarRating({ value: null });
    const stars = getStarButtons(rendered.container);

    act(() => {
      stars[0].focus();
    });
    act(() => {
      fireEvent.keyDown(stars[0], { key: 'ArrowRight' });
    });
    expect(document.activeElement).toBe(stars[1]);
    expect(stars[0].dataset.filled).toBe('true');
    expect(stars[1].dataset.filled).toBe('true');
    expect(stars[2].dataset.filled).toBe('false');

    act(() => {
      fireEvent.keyDown(stars[1], { key: 'End' });
    });
    expect(document.activeElement).toBe(stars[4]);
    expect(stars[4].dataset.filled).toBe('true');

    act(() => {
      fireEvent.keyDown(stars[4], { key: 'Home' });
    });
    expect(document.activeElement).toBe(stars[0]);
    expect(stars[0].dataset.filled).toBe('true');
    expect(stars[1].dataset.filled).toBe('false');

    rendered.unmount();
  });

  it('calls onSelect with the focused rating on Enter and Space', () => {
    const onSelect = vi.fn();
    const rendered = renderStarRating({ onSelect });
    const stars = getStarButtons(rendered.container);

    act(() => {
      stars[2].focus();
    });
    act(() => {
      fireEvent.keyDown(stars[2], { key: 'Enter' });
      fireEvent.keyDown(stars[2], { key: ' ' });
    });

    expect(onSelect).toHaveBeenNthCalledWith(1, 3);
    expect(onSelect).toHaveBeenNthCalledWith(2, 3);

    rendered.unmount();
  });
});
