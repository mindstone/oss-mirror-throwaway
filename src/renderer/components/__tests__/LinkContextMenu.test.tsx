// @vitest-environment happy-dom
/**
 * Tests for LinkContextMenu's share-link behaviour.
 *
 * Verifies Stage G of the cross-surface links plan: the "Copy Rebel link"
 * button produces the canonical `rebel://space/...` form when the file lives
 * in a shareable space, and canonicalises local-only copies to
 * `rebel://library/...` even when the source link was legacy. The "Copy web
 * link" button appears iff cloud is configured and the file is shareable.
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage G.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the renderer SpaceResolver — LinkContextMenu uses this behind the scenes
// via generateShareLink. We control the response per-test to simulate
// shareable / private / not-in-workspace scenarios.
const filePathToSpaceLinkMock = vi.fn();

 
vi.mock('@renderer/contexts/desktopSpaceResolverRenderer', () => ({
  rendererDesktopSpaceResolver: {
    resolveSpaceLink: vi.fn(),
    filePathToSpaceLink: (...args: unknown[]) => filePathToSpaceLinkMock(...args),
  },
}));

import { LinkContextMenu, type LinkContextMenuTarget } from '../LinkContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ClipboardMock = { writeText: ReturnType<typeof vi.fn> };

function installClipboard(): ClipboardMock {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return { writeText };
}

async function renderMenu(
  target: LinkContextMenuTarget,
  opts: { cloudBaseUrl?: string } = {},
): Promise<{ container: HTMLElement; root: Root; toasts: { title: string }[] }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const toasts: { title: string }[] = [];

  await act(async () => {
    root.render(
      <LinkContextMenu
        target={target}
        onClose={() => {}}
        showToast={(t) => toasts.push(t)}
        cloudBaseUrl={opts.cloudBaseUrl}
      />,
    );
  });

  // Flush the async effect that resolves the share link.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, root, toasts };
}

function findButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement | null {
  // The menu is portalled onto document.body, not `container`. Also buttons
  // contain an icon span + label span, so textContent includes icon glyph
  // whitespace — check the visible label span instead.
  void container;
  return (
    Array.from(document.body.querySelectorAll('button')).find((b) => {
      const labelEl = b.querySelector('span:last-of-type');
      return labelEl?.textContent?.trim() === label;
    }) ?? null
  );
}

describe('LinkContextMenu share-link actions', () => {
  let clipboard: ClipboardMock;

  beforeEach(() => {
    filePathToSpaceLinkMock.mockReset();
    clipboard = installClipboard();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('copies the canonical rebel://space/ URL when the file is in a shareable space', async () => {
    filePathToSpaceLinkMock.mockResolvedValue({ spaceName: 'Exec', relativePath: 'memory/q1.md' });

    const { container, root } = await renderMenu({
      x: 0,
      y: 0,
      relativePath: 'Exec/memory/q1.md',
      libraryUrl: 'library://Exec%2Fmemory%2Fq1.md',
      fullPath: '/workspace/Exec/memory/q1.md',
      isFolder: false,
    });

    const rebelButton = findButtonByLabel(container, 'Copy Rebel link');
    expect(rebelButton).not.toBeNull();
    expect(rebelButton?.disabled).toBe(false);

    await act(async () => {
      rebelButton!.click();
    });

    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith('rebel://space/Exec/memory%2Fq1.md');

    act(() => {
      root.unmount();
    });
  });

  it('canonicalises the local-only copy to rebel://library/ form, even if the source link was legacy', async () => {
    filePathToSpaceLinkMock.mockResolvedValue(null);

    const { container, root } = await renderMenu({
      x: 0,
      y: 0,
      relativePath: 'sandbox/notes.md',
      libraryUrl: 'library://sandbox%2Fnotes.md',
      fullPath: '/workspace/sandbox/notes.md',
      isFolder: false,
    });

    // Button label flips to "Copy local link" when no shareable form exists.
    const localButton = findButtonByLabel(container, 'Copy local link');
    expect(localButton).not.toBeNull();

    await act(async () => {
      localButton!.click();
    });

    expect(clipboard.writeText).not.toHaveBeenCalledWith('library://sandbox%2Fnotes.md');
    expect(clipboard.writeText).toHaveBeenCalledWith('rebel://library/sandbox%2Fnotes.md');

    act(() => {
      root.unmount();
    });
  });

  it('does not show "Copy web link" when cloud is not configured', async () => {
    filePathToSpaceLinkMock.mockResolvedValue({ spaceName: 'Exec', relativePath: 'q1.md' });

    const { container, root } = await renderMenu({
      x: 0,
      y: 0,
      relativePath: 'Exec/q1.md',
      libraryUrl: 'library://Exec%2Fq1.md',
      fullPath: '/workspace/Exec/q1.md',
      isFolder: false,
    });

    // No cloudBaseUrl passed → web link button should not be rendered.
    expect(findButtonByLabel(container, 'Copy web link')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('shows and copies a web link when cloud is configured and file is shareable', async () => {
    filePathToSpaceLinkMock.mockResolvedValue({ spaceName: 'Exec', relativePath: 'memory/q1.md' });

    const { container, root } = await renderMenu(
      {
        x: 0,
        y: 0,
        relativePath: 'Exec/memory/q1.md',
        libraryUrl: 'library://Exec%2Fmemory%2Fq1.md',
        fullPath: '/workspace/Exec/memory/q1.md',
        isFolder: false,
      },
      { cloudBaseUrl: 'https://cloud.example.com' },
    );

    const webButton = findButtonByLabel(container, 'Copy web link');
    expect(webButton).not.toBeNull();

    await act(async () => {
      webButton!.click();
    });

    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = clipboard.writeText.mock.calls[0][0] as string;
    expect(copied).toMatch(/^https:\/\/cloud\.example\.com\/app\/open\?u=/);
    expect(copied).toContain(encodeURIComponent('rebel://space/Exec/memory%2Fq1.md'));

    act(() => {
      root.unmount();
    });
  });

  it('omits "Copy web link" even with cloud configured when the file is not shareable', async () => {
    filePathToSpaceLinkMock.mockResolvedValue(null);

    const { container, root } = await renderMenu(
      {
        x: 0,
        y: 0,
        relativePath: 'sandbox/notes.md',
        libraryUrl: 'library://sandbox%2Fnotes.md',
        fullPath: '/workspace/sandbox/notes.md',
        isFolder: false,
      },
      { cloudBaseUrl: 'https://cloud.example.com' },
    );

    expect(findButtonByLabel(container, 'Copy web link')).toBeNull();
    // But the local-link option is still present.
    expect(findButtonByLabel(container, 'Copy local link')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('handles folders by emitting the rebel://space/ folder form', async () => {
    filePathToSpaceLinkMock.mockResolvedValue({ spaceName: 'Exec', relativePath: 'memory' });

    const { container, root } = await renderMenu({
      x: 0,
      y: 0,
      relativePath: 'Exec/memory/',
      libraryUrl: 'library://Exec%2Fmemory%2F',
      fullPath: '/workspace/Exec/memory',
      isFolder: true,
    });

    const rebelButton = findButtonByLabel(container, 'Copy Rebel link');
    expect(rebelButton).not.toBeNull();

    await act(async () => {
      rebelButton!.click();
    });

    const copied = clipboard.writeText.mock.calls[0][0] as string;
    // Folder form: trailing slash after space name + folder path segment.
    expect(copied).toMatch(/^rebel:\/\/space\/Exec\//);
    expect(copied).toContain('memory');

    act(() => {
      root.unmount();
    });
  });
});
