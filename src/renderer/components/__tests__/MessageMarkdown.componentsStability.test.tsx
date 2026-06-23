// @vitest-environment happy-dom
/**
 * Regression test for REBEL-4ZV / FOX-3174 (text-selection instability).
 *
 * The MessageMarkdown component used to rebuild its `components={…}` prop on
 * every render via an inline object literal. ReactMarkdown treats each entry
 * as a component "type", so a new function identity for `p`/`a`/`img`/etc.
 * remounted the entire markdown DOM subtree on every parent re-render — which
 * destroyed text nodes and collapsed any live user selection.
 *
 * Stage 1 fix (Change A): the `components` map is now extracted into a
 * stable `useMemo([])` block. This test pins that contract: rendering the
 * same content twice MUST preserve DOM identity of paragraph text nodes.
 *
 * See `docs-private/investigations/260427_text_selection_unstable_v2.md`.
 */
import React, { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageMarkdown } from '../MessageMarkdown';
import { __resetSpacesCacheForTests } from '../../hooks/useSpacesData';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * Render-twice helper that DEFEATS `React.memo` by changing a callback prop
 * reference between renders. Without this, `MessageMarkdown` (which is
 * `memo()`-wrapped) would short-circuit and never re-execute the function
 * body — so the test would pass trivially, even against the broken pre-fix
 * implementation. We explicitly want the body to run twice so the components
 * map is rebuilt (or re-used) at least once.
 */
function renderTwiceForcingRerender(
  content: string,
  props: Partial<ComponentProps<typeof MessageMarkdown>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  // First render with one showToast reference.
  const showToastA = () => undefined;
  act(() => {
    root.render(<MessageMarkdown content={content} showToast={showToastA} {...props} />);
  });
  const firstParagraph = container.querySelector('p');
  const firstAnchor = container.querySelector('a');
  const firstTextNode = firstParagraph?.firstChild;

  // Second render with a DIFFERENT showToast reference. memo() shallow-equal
  // sees a new prop value and re-runs the body. If the components map is
  // stable, the existing paragraph/anchor DOM nodes survive; if it's rebuilt,
  // ReactMarkdown remounts and the DOM nodes get replaced.
  const showToastB = () => undefined;
  act(() => {
    root.render(<MessageMarkdown content={content} showToast={showToastB} {...props} />);
  });
  const secondParagraph = container.querySelector('p');
  const secondAnchor = container.querySelector('a');
  const secondTextNode = secondParagraph?.firstChild;

  return {
    firstParagraph,
    firstAnchor,
    firstTextNode,
    secondParagraph,
    secondAnchor,
    secondTextNode,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('MessageMarkdown component stability (REBEL-4ZV regression)', () => {
  beforeEach(() => {
    __resetSpacesCacheForTests();
  });

  afterEach(() => {
    __resetSpacesCacheForTests();
    vi.clearAllMocks();
  });

  it('preserves paragraph DOM identity across re-renders that re-execute the component body', () => {
    const result = renderTwiceForcingRerender('Hello world. This is a stable paragraph.');
    try {
      expect(result.firstParagraph).toBeTruthy();
      expect(result.secondParagraph).toBe(result.firstParagraph);
      expect(result.firstTextNode).toBeTruthy();
      expect(result.secondTextNode).toBe(result.firstTextNode);
    } finally {
      result.cleanup();
    }
  });

  it('preserves anchor DOM identity across re-renders that re-execute the component body', () => {
    const result = renderTwiceForcingRerender('Here is [a link](https://example.com/page).');
    try {
      expect(result.firstAnchor).toBeTruthy();
      expect(result.secondAnchor).toBe(result.firstAnchor);
    } finally {
      result.cleanup();
    }
  });

  it('preserves auto-linked file anchor identity when the library-link plugin inputs are unchanged', () => {
    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        scanSpaces: vi.fn().mockReturnValue(new Promise(() => undefined)),
        readFileBase64: vi.fn().mockResolvedValue(''),
      },
    });

    const result = renderTwiceForcingRerender(
      'See /workspace/notes.md',
      { coreDirectory: '/workspace' },
    );
    try {
      expect(result.firstAnchor).toBeTruthy();
      expect(result.secondAnchor).toBe(result.firstAnchor);
    } finally {
      result.cleanup();
    }
  });
});

/**
 * Branch-transition / hook-order regression test (260416 rules-of-hooks crash).
 *
 * MessageMarkdown renders through multiple branches on the SAME mounted
 * instance: pending-lightweight, two-phase lightweight (`needsTwoPhase &&
 * !isEnhanced`), then the full enhanced render once an idle callback flips
 * `isEnhanced` to true. The 260416 crash (`abc7516f7`) was a Rules-of-Hooks
 * violation: hooks declared AFTER the early-return branches, so the hook count
 * changed when the render path toggled and React threw on the transition.
 *
 * This test drives one instance across the two-phase → enhanced boundary and
 * asserts no runtime exception is thrown. It is non-vacuous: content above
 * TWO_PHASE_THRESHOLD (1500 chars) is required to enter the two-phase branch,
 * and the idle-callback flush is what crosses the boundary — if MessageMarkdown
 * ever reintroduces a post-return hook, the transition render throws here.
 *
 * @see docs-private/postmortems/260416_messagemarkdown_rules_of_hooks_crash_postmortem.md
 */
describe('MessageMarkdown render-phase transition hook-order (260416 regression)', () => {
  beforeEach(() => {
    __resetSpacesCacheForTests();
    // Force the setTimeout fallback in `scheduleIdle` so fake timers can drive
    // the two-phase → enhanced transition deterministically.
    if ('requestIdleCallback' in window) {
      delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
    }
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    __resetSpacesCacheForTests();
    vi.clearAllMocks();
  });

  it('crosses two-phase lightweight → enhanced on one instance without a hook-order crash', () => {
    // Above TWO_PHASE_THRESHOLD (1500) so the instance starts in the two-phase
    // lightweight branch, then transitions to enhanced via the idle callback.
    const longContent = `[link](https://example.com)\n\n${'word '.repeat(400)}`;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      expect(() => {
        act(() => {
          root.render(<MessageMarkdown content={longContent} showToast={() => undefined} />);
        });
        // Flush the scheduleIdle setTimeout(…, 100) that flips isEnhanced=true,
        // re-running the body down the enhanced branch on the SAME instance.
        act(() => {
          vi.advanceTimersByTime(200);
        });
      }).not.toThrow();

      // After the transition the enhanced render is active (real anchor, not the
      // lightweight inert span) — proves the boundary was actually crossed.
      expect(container.querySelector('a')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
