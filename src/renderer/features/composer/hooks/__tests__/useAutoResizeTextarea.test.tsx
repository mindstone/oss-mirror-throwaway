// @vitest-environment happy-dom
/**
 * Unit tests for useAutoResizeTextarea — the auto-grow primitive wired into the
 * legacy <textarea> path of MentionHeroInput (REBEL-680: Home hero input grows
 * with content instead of staying single-line).
 *
 * happy-dom does not run layout, so `scrollHeight` is always 0. We stub it via
 * a callback ref so the hook has a deterministic content height to reconcile
 * against, then assert the resulting inline `style.height`.
 */
import { describe, it, expect } from 'vitest';
import React, { useRef } from 'react';
import { useAutoResizeTextarea } from '../useAutoResizeTextarea';

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({
  value,
  enabled,
  scrollHeight,
}: {
  value: string;
  enabled?: boolean;
  scrollHeight: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoResizeTextarea(ref, value, enabled);
  // Callback ref runs during commit (before useLayoutEffect), so scrollHeight is
  // stubbed by the time the hook reads it. configurable:true lets each render
  // redefine with the current `scrollHeight` prop.
  const attach = (node: HTMLTextAreaElement | null) => {
    ref.current = node;
    if (node) {
      Object.defineProperty(node, 'scrollHeight', {
        configurable: true,
        get: () => scrollHeight,
      });
    }
  };
  return React.createElement('textarea', {
    ref: attach,
    value,
    onChange: () => {},
    'data-testid': 'ta',
  });
}

function mount(props: { value: string; enabled?: boolean; scrollHeight: number }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: any;
  reactAct(() => {
    root = ReactDOMClient.createRoot(container);
    root.render(React.createElement(Harness, props));
  });
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  return {
    textarea,
    rerender: (next: { value: string; enabled?: boolean; scrollHeight: number }) => {
      reactAct(() => root.render(React.createElement(Harness, next)));
    },
    unmount: () => {
      reactAct(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

describe('useAutoResizeTextarea', () => {
  it('sets the textarea height to its content scrollHeight', () => {
    const { textarea, unmount } = mount({ value: 'one line', scrollHeight: 62 });
    expect(textarea.style.height).toBe('62px');
    unmount();
  });

  it('grows when the content height increases on a value change', () => {
    const { textarea, rerender, unmount } = mount({ value: 'one line', scrollHeight: 62 });
    expect(textarea.style.height).toBe('62px');
    rerender({ value: 'one line\ntwo\nthree', scrollHeight: 120 });
    expect(textarea.style.height).toBe('120px');
    unmount();
  });

  it('shrinks back when content height decreases', () => {
    const { textarea, rerender, unmount } = mount({ value: 'tall\ntall\ntall', scrollHeight: 120 });
    expect(textarea.style.height).toBe('120px');
    rerender({ value: 'short', scrollHeight: 62 });
    expect(textarea.style.height).toBe('62px');
    unmount();
  });

  it('does nothing when disabled (rich-editor path owns its own sizing)', () => {
    const { textarea, unmount } = mount({ value: 'whatever', enabled: false, scrollHeight: 200 });
    expect(textarea.style.height).toBe('');
    unmount();
  });
});
