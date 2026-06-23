// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { AdditionalViewRow } from '../AdditionalViewRow';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderRow(
  props: Partial<React.ComponentProps<typeof AdditionalViewRow>> = {},
): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <AdditionalViewRow
        viewRoleLabel="Editable email draft"
        viewSummary="Email draft to alice@example.com."
        onOpen={vi.fn()}
        {...props}
      />,
    );
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('AdditionalViewRow', () => {
  it('renders a clickable row with role label and summary', () => {
    const onOpen = vi.fn();
    const rendered = renderRow({ onOpen });

    const row = rendered.container.querySelector('[data-testid="additional-view-row"]');
    expect(row?.tagName).toBe('BUTTON');
    expect(rendered.container.textContent).toContain('Editable email draft');
    expect(rendered.container.textContent).toContain('Email draft to alice@example.com.');

    act(() => row?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpen).toHaveBeenCalledTimes(1);

    rendered.unmount();
  });

  it('exposes expanded state and failed status copy', () => {
    const rendered = renderRow({ expanded: true, status: 'failed', controlledRegionId: 'additional-view-body' });

    const row = rendered.container.querySelector('[data-testid="additional-view-row"]');
    expect(row?.getAttribute('aria-expanded')).toBe('true');
    expect(row?.getAttribute('aria-controls')).toBe('additional-view-body');
    expect(rendered.container.textContent).toContain('Needs attention');

    rendered.unmount();
  });
});
