// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolResultContent } from '../ToolResultContent';
import { clearContentHydrationCacheForTests } from '@renderer/hooks/useContentHydration';
import type { ContentRef } from '@shared/types/agent';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const baseRef: ContentRef = {
  contentId: 'c'.repeat(32),
  mimeType: 'text/plain',
  byteSize: 2048,
  summary: 'Short summary',
};

describe('ToolResultContent', () => {
  const mounted: Mounted[] = [];
  const readContent = vi.fn();

  beforeEach(() => {
    clearContentHydrationCacheForTests();
    readContent.mockReset();
    (window as unknown as { sessionsApi: { readContent: typeof readContent } }).sessionsApi = {
      readContent,
    };
  });

  afterEach(() => {
    for (const instance of mounted.splice(0)) {
      instance.unmount();
    }
  });

  it('shows summary, then loading skeleton, then hydrated content on success', async () => {
    let resolveRead:
      | ((value: { reason: 'ok'; bytesBase64: string; mimeType: string }) => void)
      | undefined;
    readContent.mockReturnValue(new Promise((resolve) => {
      resolveRead = resolve as typeof resolveRead;
    }));

    const view = mount(
      <ToolResultContent sessionId="sess-1" contentRef={baseRef} />,
    );
    mounted.push(view);

    expect(view.container.textContent).toContain('Short summary');
    const showButton = Array.from(view.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Show full output'));
    expect(showButton).toBeTruthy();

    await act(async () => {
      showButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('[data-testid="tool-result-content-loading"]')).toBeTruthy();

    await act(async () => {
      resolveRead?.({
        reason: 'ok',
        bytesBase64: Buffer.from('Full hydrated output', 'utf8').toString('base64'),
        mimeType: 'text/plain',
      });
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Full hydrated output');
    expect(readContent).toHaveBeenCalledWith({ sessionId: 'sess-1', contentId: baseRef.contentId });
  });

  it('shows missing-content failure tile without retry button', async () => {
    readContent.mockResolvedValue({ reason: 'missing' });

    const view = mount(
      <ToolResultContent sessionId="sess-missing" contentRef={baseRef} />,
    );
    mounted.push(view);

    const showButton = Array.from(view.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Show full output'));
    await act(async () => {
      showButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(view.container.querySelector('[data-testid="tool-result-content-failure"]')).toBeTruthy();
    expect(view.container.textContent).toContain('Tool output not found');
    expect(Array.from(view.container.querySelectorAll('button')).some((button) => button.textContent?.includes('Try again'))).toBe(false);
  });

  it('shows pending-upload failure tile with retry button', async () => {
    readContent.mockResolvedValue({ reason: 'pending-upload' });

    const view = mount(
      <ToolResultContent sessionId="sess-pending" contentRef={baseRef} />,
    );
    mounted.push(view);

    const showButton = Array.from(view.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Show full output'));
    await act(async () => {
      showButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Still uploading...');
    expect(Array.from(view.container.querySelectorAll('button')).some((button) => button.textContent?.includes('Try again'))).toBe(true);
  });
});
