// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DiagnosticEventRow } from '../DiagnosticEventRow';
import type { DiagnosticEventEntry } from '@shared/diagnostics/recentDiagnosticContext';

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

const event: DiagnosticEventEntry = {
  v: 1,
  ts: Date.now(),
  surface: 'desktop',
  tid: 'turn-1',
  kind: 'cooldown_enter',
  data: {
    scope: 'api',
    untilMs: Date.now() + 5_000,
    retryAfterProvided: true,
    durationMs: 5_000,
  },
};

describe('DiagnosticEventRow', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('shows friendly summary from the display map', () => {
    mounted = mount(<DiagnosticEventRow event={event} />);

    expect(mounted.container.textContent).toContain(
      'Rebel paused requests because a service asked it to slow down.',
    );
  });

  it('toggles raw JSON details and aria-expanded', () => {
    mounted = mount(<DiagnosticEventRow event={event} />);
    const toggle = mounted.container.querySelector('button')!;

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(mounted.container.textContent).not.toContain('"kind": "cooldown_enter"');

    click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(mounted.container.textContent).toContain('Raw kind: cooldown_enter');
    expect(mounted.container.textContent).toContain('"kind": "cooldown_enter"');
  });
});
