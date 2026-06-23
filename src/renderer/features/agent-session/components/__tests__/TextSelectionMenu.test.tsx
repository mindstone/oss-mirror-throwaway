// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TextSelectionMenuLayer } from '../TextSelectionMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderLayerWithLink(href: string): { container: HTMLElement; root: Root; link: HTMLAnchorElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <>
        <a href={href} data-href={href}>
          Link
        </a>
        <TextSelectionMenuLayer
          onReply={vi.fn()}
          onComment={vi.fn()}
          showToast={vi.fn()}
        />
      </>,
    );
  });

  const link = container.querySelector('a');
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error('Expected rendered link');
  }

  return { container, root, link };
}

function rightClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 12,
    clientY: 18,
  }));
}

describe('TextSelectionMenuLayer link routing', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the generic copy-link menu for ordinary links', async () => {
    const { root, link } = renderLayerWithLink('https://example.com/docs');

    await act(async () => {
      rightClick(link);
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Copy Link');

    act(() => root.unmount());
  });

  it('lets Rebel resource links fall through to their specialised file menu', async () => {
    const { root, link } = renderLayerWithLink('rebel://space/Exec/notes.md');

    await act(async () => {
      rightClick(link);
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('Copy Link');

    act(() => root.unmount());
  });
});
