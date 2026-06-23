// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageTile } from '../ImageTile';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('ImageTile', () => {
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

  it('renders the image with the provided alt text', () => {
    act(() => {
      root.render(<ImageTile src={PIXEL} alt="A test image" />);
    });
    const img = container.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('A test image');
    expect(img?.getAttribute('src')).toBe(PIXEL);
  });

  it('calls onClick when the tile is clicked', () => {
    const onClick = vi.fn();
    act(() => {
      root.render(<ImageTile src={PIXEL} alt="Click me" onClick={onClick} />);
    });
    const button = container.querySelector('button');
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('flips to failed state when the underlying image errors', () => {
    act(() => {
      root.render(<ImageTile src="rebel-asset://invalid" alt="Broken" />);
    });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
    expect(container.textContent ?? '').toContain('Image unavailable');
  });

  it('renders the failed state directly when state="failed"', () => {
    act(() => {
      root.render(<ImageTile src={PIXEL} alt="Pre-failed" state="failed" />);
    });
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a skeleton overlay when state="loading"', () => {
    act(() => {
      root.render(<ImageTile src={PIXEL} alt="Loading" state="loading" />);
    });
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull();
  });
});
