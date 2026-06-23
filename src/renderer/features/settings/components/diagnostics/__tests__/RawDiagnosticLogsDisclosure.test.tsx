// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawDiagnosticLogsDisclosure } from '../RawDiagnosticLogsDisclosure';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe('RawDiagnosticLogsDisclosure', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('is collapsed by default, toggles open, and copies markdown', async () => {
    const markdown = '## Recent diagnostic events\n- one';
    const writeText = installClipboard();
    mounted = mount(<RawDiagnosticLogsDisclosure markdown={markdown} />);

    expect(mounted.container.textContent).not.toContain(markdown);

    const toggle = mounted.container.querySelector('button')!;
    click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(mounted.container.querySelector('pre code')?.textContent).toBe(markdown);

    const copyButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Copy'))!;
    await act(async () => {
      copyButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(markdown);
  });
});
