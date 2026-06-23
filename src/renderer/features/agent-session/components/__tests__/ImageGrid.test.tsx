// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageGrid } from '../ImageGrid';
import type { ImageGridItem } from '../imageGridSource';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TRANSPARENT_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const makeItem = (index: number, total: number, overrides: Partial<ImageGridItem> = {}): ImageGridItem => ({
  key: `item-${index}`,
  tileSrc: TRANSPARENT_PIXEL,
  fullSrc: TRANSPARENT_PIXEL,
  alt: `Image ${index + 1} of ${total}`,
  mimeType: 'image/png',
  state: 'ready',
  ...overrides,
});

const makeItems = (count: number): ImageGridItem[] =>
  Array.from({ length: count }, (_, index) => makeItem(index, count));

describe('ImageGrid', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (images: ImageGridItem[]) => {
    act(() => {
      root.render(<ImageGrid images={images} />);
    });
  };

  it('renders nothing for an empty image list', () => {
    render([]);
    expect(container.textContent).toBe('');
  });

  it('renders a single-image large layout for 1 image', () => {
    render(makeItems(1));
    const list = container.querySelector('[role="list"]');
    expect(list).not.toBeNull();
    expect(list?.getAttribute('aria-label')).toBe('1 image');
    expect(container.querySelectorAll('[role="listitem"]').length).toBe(1);
  });

  it('renders all 3 images as a row', () => {
    render(makeItems(3));
    expect(container.querySelectorAll('[role="listitem"]').length).toBe(3);
  });

  it('renders all 4 images in the dense grid', () => {
    render(makeItems(4));
    expect(container.querySelectorAll('[role="listitem"]').length).toBe(4);
  });

  it('renders all 12 images in the dense grid', () => {
    render(makeItems(12));
    expect(container.querySelectorAll('[role="listitem"]').length).toBe(12);
  });

  it('caps the bounded preview at 12 cells when total ≥ 13 (11 tiles + more-tile)', () => {
    render(makeItems(13));
    expect(container.querySelectorAll('[role="listitem"]').length).toBe(12);
    const moreButton = container.querySelector('button[aria-label*="View all"]');
    expect(moreButton?.getAttribute('aria-label')).toBe('View all 13 images');
  });

  it('caps the bounded preview at 12 cells when total = 100', () => {
    render(makeItems(100));
    expect(container.querySelectorAll('[role="listitem"]').length).toBe(12);
    const moreButton = container.querySelector('button[aria-label*="View all"]');
    expect(moreButton?.getAttribute('aria-label')).toBe('View all 100 images');
  });

  it('opens the modal viewer when a tile is clicked and closes on Escape', () => {
    render(makeItems(4));
    const tileButtons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
    const firstTile = tileButtons.find((button) => button.getAttribute('aria-label')?.includes('click to expand'));
    expect(firstTile).toBeTruthy();
    act(() => firstTile!.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent ?? '').toContain('Image 1 of 4');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('navigates with ArrowRight inside the modal viewer', () => {
    render(makeItems(3));
    const tileButtons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
    const firstTile = tileButtons.find((button) => button.getAttribute('aria-label')?.includes('click to expand'));
    act(() => firstTile!.click());

    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').toContain('Image 1 of 3');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });

    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').toContain('Image 2 of 3');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });

    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').toContain('Image 1 of 3');

    // Close so it doesn't leak across tests
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
  });

  it('opens the modal at the "+X more" tile when there are 13+ images', () => {
    render(makeItems(20));
    const moreButton = container.querySelector('button[aria-label*="View all"]') as HTMLButtonElement | null;
    expect(moreButton).not.toBeNull();
    act(() => moreButton!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').toContain('Image 12 of 20');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
  });

  it('renders the failed state for tiles with state="failed" instead of an <img>', () => {
    render([
      makeItem(0, 2),
      makeItem(1, 2, { state: 'failed' }),
    ]);
    const tiles = Array.from(container.querySelectorAll('[data-state]')) as HTMLButtonElement[];
    const failedTile = tiles.find((t) => t.getAttribute('data-state') === 'failed');
    expect(failedTile?.textContent ?? '').toContain('Image unavailable');
  });
});
