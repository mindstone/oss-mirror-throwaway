// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LibrarySearchTruncationNotice,
  ENGINE_CAP_COPY,
  TREE_COPY,
  BOTH_COPY,
  CLOUD_DEGRADED_COPY_SINGULAR,
  CLOUD_DEGRADED_COPY_PLURAL,
} from '../LibrarySearchTruncationNotice';
import { useNoticeDismissal } from '../../search/useNoticeDismissal';
import type { TruncationSignal } from '../../search/useTruncationSignal';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  rerender: (element: React.ReactElement) => void;
  unmount: () => void;
};

function mount(element: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(element);
  });

  return {
    container,
    root,
    rerender: (nextElement) => {
      act(() => {
        root.render(nextElement);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function getDismissReason(signal: TruncationSignal): 'engine-cap' | 'tree' | 'both' | null {
  if (signal.kind === 'engine-cap' || signal.kind === 'tree' || signal.kind === 'both') {
    return signal.kind;
  }
  return null;
}

function DismissibleHarness({ signal }: { signal: TruncationSignal }) {
  const reason = getDismissReason(signal);
  const { dismissed, dismiss } = useNoticeDismissal(reason ?? 'engine-cap');

  if (reason === null || dismissed) {
    return null;
  }

  return (
    <LibrarySearchTruncationNotice
      signal={signal}
      placement="inline"
      onDismiss={dismiss}
    />
  );
}

describe('LibrarySearchTruncationNotice', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    window.sessionStorage.clear();
  });

  it('renders engine-cap copy byte-for-byte with status aria semantics', () => {
    mounted = mount(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'engine-cap', entriesTotal: 100_001, entriesIndexed: 100_000 }}
        placement="inline"
        onDismiss={() => undefined}
      />,
    );

    const notice = mounted.container.querySelector('[data-testid="library-search-truncation-notice"]');
    expect(notice?.textContent).toContain(ENGINE_CAP_COPY);
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.getAttribute('aria-live')).toBe('polite');
  });

  it('renders distinct byte-for-byte copy for tree and both signals', () => {
    mounted = mount(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'tree' }}
        placement="embedded"
        onDismiss={() => undefined}
      />,
    );
    expect(mounted.container.textContent).toContain(TREE_COPY);

    mounted.rerender(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'both', entriesTotal: 130_000, entriesIndexed: 100_000 }}
        placement="embedded"
        onDismiss={() => undefined}
      />,
    );
    expect(mounted.container.textContent).toContain(BOTH_COPY);
  });

  // Stage 8 — cloud-degraded variant.
  it('renders the singular cloud-degraded copy with status semantics', () => {
    mounted = mount(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'cloud-degraded', reconnectingSpaceCount: 1 }}
        placement="inline"
      />,
    );
    const notice = mounted.container.querySelector('[data-testid="library-search-truncation-notice"]');
    expect(notice?.textContent).toContain(CLOUD_DEGRADED_COPY_SINGULAR);
    expect(notice?.getAttribute('role')).toBe('status');
    // Live status — not dismissible (no dead X).
    expect(mounted.container.querySelector('[aria-label="Dismiss notice"]')).toBeNull();
  });

  it('renders the plural cloud-degraded copy when multiple spaces are reconnecting', () => {
    mounted = mount(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'cloud-degraded', reconnectingSpaceCount: 3 }}
        placement="inline"
      />,
    );
    expect(mounted.container.textContent).toContain(CLOUD_DEGRADED_COPY_PLURAL);
  });

  it('exposes a focusable info tooltip trigger with an accessible name for cloud-degraded', () => {
    mounted = mount(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'cloud-degraded', reconnectingSpaceCount: 1 }}
        placement="inline"
      />,
    );
    const trigger = mounted.container.querySelector('[data-testid="library-truncation-notice-info"]');
    // Must be a real <button> (focusable) — not a bare <span> — so the
    // focus-fired Tooltip is keyboard/screen-reader reachable (PLAN F2).
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    expect(trigger?.getAttribute('aria-label')).toBe('What does reconnecting mean?');
  });

  it('renders the Manage in Settings button and fires onManageSpaces when clicked', () => {
    let managed = 0;
    mounted = mount(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'cloud-degraded', reconnectingSpaceCount: 1 }}
        placement="inline"
        onManageSpaces={() => {
          managed += 1;
        }}
      />,
    );
    const button = mounted.container.querySelector(
      '[data-testid="library-truncation-notice-manage-spaces"]',
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected the Manage in Settings button when onManageSpaces is supplied');
    }
    expect(button.textContent).toContain('Manage in Settings');
    act(() => {
      button.click();
    });
    expect(managed).toBe(1);
  });

  it('renders NO Manage in Settings button when onManageSpaces is absent (no dead button)', () => {
    mounted = mount(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'cloud-degraded', reconnectingSpaceCount: 1 }}
        placement="inline"
      />,
    );
    // Tooltip trigger present, but no Settings button without the callback.
    expect(
      mounted.container.querySelector('[data-testid="library-truncation-notice-info"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="library-truncation-notice-manage-spaces"]'),
    ).toBeNull();
  });

  it('leaves non-cloud-degraded kinds unenriched (no info trigger, no Settings button)', () => {
    for (const signal of [
      { kind: 'engine-cap', entriesTotal: 100_001, entriesIndexed: 100_000 },
      { kind: 'tree' },
      { kind: 'both', entriesTotal: 140_000, entriesIndexed: 100_000 },
    ] as const) {
      const local = mount(
        // An onManageSpaces handler must be ignored for non-cloud-degraded kinds.
        <LibrarySearchTruncationNotice
          signal={signal}
          placement="inline"
          onManageSpaces={() => undefined}
        />,
      );
      expect(
        local.container.querySelector('[data-testid="library-truncation-notice-info"]'),
      ).toBeNull();
      expect(
        local.container.querySelector('[data-testid="library-truncation-notice-manage-spaces"]'),
      ).toBeNull();
      local.unmount();
    }
  });

  it('renders a non-dismissible notice (no X) when no onDismiss handler is supplied', () => {
    mounted = mount(
      <LibrarySearchTruncationNotice signal={{ kind: 'tree' }} placement="inline" />,
    );

    const notice = mounted.container.querySelector('[data-testid="library-search-truncation-notice"]');
    expect(notice?.textContent).toContain(TREE_COPY);
    // No dead dismiss button — the X is only rendered when a real handler exists.
    expect(mounted.container.querySelector('[aria-label="Dismiss notice"]')).toBeNull();
  });

  it('renders a working dismiss button when an onDismiss handler is supplied', () => {
    let dismissed = false;
    mounted = mount(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'tree' }}
        placement="inline"
        onDismiss={() => {
          dismissed = true;
        }}
      />,
    );

    const dismissButton = mounted.container.querySelector('[aria-label="Dismiss notice"]');
    if (!(dismissButton instanceof HTMLButtonElement)) {
      throw new Error('Expected dismiss button to exist when onDismiss is supplied');
    }
    act(() => {
      dismissButton.click();
    });
    expect(dismissed).toBe(true);
  });

  it('does not render for none and unknown signals', () => {
    mounted = mount(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'none' }}
        placement="inline"
        onDismiss={() => undefined}
      />,
    );
    expect(mounted.container.querySelector('[data-testid="library-search-truncation-notice"]')).toBeNull();

    mounted.rerender(
      <LibrarySearchTruncationNotice
        signal={{ kind: 'unknown' }}
        placement="inline"
        onDismiss={() => undefined}
      />,
    );
    expect(mounted.container.querySelector('[data-testid="library-search-truncation-notice"]')).toBeNull();
  });

  it('persists dismissal in sessionStorage, re-shows on escalation, and re-shows after app restart simulation', () => {
    mounted = mount(
      <DismissibleHarness signal={{ kind: 'engine-cap', entriesTotal: 100_001, entriesIndexed: 100_000 }} />,
    );

    expect(mounted.container.textContent).toContain(ENGINE_CAP_COPY);

    const dismissButton = mounted.container.querySelector('[aria-label="Dismiss notice"]');
    if (!(dismissButton instanceof HTMLButtonElement)) {
      throw new Error('Expected dismiss button to exist');
    }

    act(() => {
      dismissButton.click();
    });

    expect(mounted.container.querySelector('[data-testid="library-search-truncation-notice"]')).toBeNull();
    expect(window.sessionStorage.getItem('library-search-truncation-notice-dismissed:engine-cap')).toBe('1');

    mounted.rerender(
      <DismissibleHarness signal={{ kind: 'engine-cap', entriesTotal: 100_001, entriesIndexed: 100_000 }} />,
    );
    expect(mounted.container.querySelector('[data-testid="library-search-truncation-notice"]')).toBeNull();

    mounted.rerender(
      <DismissibleHarness signal={{ kind: 'both', entriesTotal: 140_000, entriesIndexed: 100_000 }} />,
    );
    expect(mounted.container.textContent).toContain(BOTH_COPY);

    mounted.unmount();
    mounted = null;
    window.sessionStorage.clear();

    mounted = mount(
      <DismissibleHarness signal={{ kind: 'engine-cap', entriesTotal: 100_001, entriesIndexed: 100_000 }} />,
    );
    expect(mounted.container.textContent).toContain(ENGINE_CAP_COPY);
  });
});
