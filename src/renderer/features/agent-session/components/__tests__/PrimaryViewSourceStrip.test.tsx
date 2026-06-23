// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrimaryViewSourceStrip, type PrimaryViewSourceStripProps } from '../PrimaryViewSourceStrip';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderStrip(
  props: PrimaryViewSourceStripProps = {},
): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <PrimaryViewSourceStrip
        sourcePackageId="GoogleWorkspace-jane-example-com"
        viewRoleLabel="Editable email draft"
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

function getTrigger(container: HTMLElement): HTMLButtonElement {
  const trigger = container.querySelector('button');
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error('Expected Safe view trigger button');
  }
  return trigger;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectTooltip(
  open: boolean,
  expectedContent = 'This view runs separately from Rebel for safety.',
): void {
  const tooltip = document.body.querySelector('[role="tooltip"]');
  expect(Boolean(tooltip)).toBe(open);
  if (open) {
    expect(tooltip?.textContent).toContain(expectedContent);
  }
}

function normalizeReactIds(html: string): string {
  return html.replace(/_r_[a-z0-9]+_/giu, '_react-id_');
}

describe('PrimaryViewSourceStrip', () => {
  beforeEach(() => {
    document.body.className = 'dark';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the default form for a known catalog source', () => {
    const rendered = renderStrip();

    expect(rendered.container.textContent).toContain('Editable email draft');
    expect(rendered.container.textContent).toContain('From Google Workspace');
    expect(rendered.container.textContent).toContain('Safe view');
    expect(rendered.container.textContent).not.toContain('jane-example-com');

    rendered.unmount();
  });

  it('renders the compact form when isCompact=true', () => {
    const rendered = renderStrip({ isCompact: true });

    expect(rendered.container.querySelector('[data-testid="primary-view-source-strip"]')?.className)
      .toContain('primaryViewSourceStripForceCompact');
    expect(rendered.container.textContent).toContain('From Google Workspace.');
    expect(rendered.container.textContent).toContain('Runs separately for safety.');

    rendered.unmount();
  });

  it('opens on hover/focus and dismisses on pointer leave, blur, and Escape', async () => {
    const rendered = renderStrip();
    const trigger = getTrigger(rendered.container);

    act(() => {
      trigger.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });
    await flush();
    expectTooltip(true);

    act(() => {
      trigger.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    });
    await flush();
    expectTooltip(false);

    act(() => {
      trigger.blur();
      trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await flush();

    act(() => {
      trigger.focus();
    });
    await flush();
    expectTooltip(true);

    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expectTooltip(false);

    act(() => {
      trigger.blur();
      trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await flush();

    act(() => {
      trigger.focus();
    });
    await flush();
    expectTooltip(true);

    act(() => {
      trigger.blur();
      trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await flush();
    expectTooltip(false);

    rendered.unmount();
  });

  it('toggles on tap/click and dismisses on outside click', async () => {
    const rendered = renderStrip();
    const trigger = getTrigger(rendered.container);

    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expectTooltip(true);

    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await flush();
    expectTooltip(false);

    rendered.unmount();
  });

  it('renders fallback source when sourcePackageId is empty', () => {
    const rendered = renderStrip({ sourcePackageId: '' });

    expect(rendered.container.textContent).toContain('From connected tool');
    expect(rendered.container.textContent).toContain('Safe view');

    rendered.unmount();
  });

  it('does not render internal Rebel source language for unallowlisted rebel-prefixed ids', () => {
    const rendered = renderStrip({ sourcePackageId: 'rebel-canvas' });

    expect(rendered.container.textContent).toContain('From Rebel Canvas');
    expect(rendered.container.textContent).not.toContain('Built into Rebel');
    expect(rendered.container.textContent).toContain('Safe view');

    rendered.unmount();
  });

  it('renders fallback unknown source without the full instance ID', () => {
    const rendered = renderStrip({
      sourcePackageId: 'unknown-foo-bar-jane-example-com',
    });

    expect(rendered.container.textContent).toContain('From Unknown Foo Bar');
    expect(rendered.container.textContent).not.toContain('jane-example-com');

    rendered.unmount();
  });

  it('captures light and dark snapshots', () => {
    document.body.className = 'light';
    const light = renderStrip();
    expect(normalizeReactIds(light.container.innerHTML)).toMatchSnapshot('light');
    light.unmount();

    document.body.className = 'dark';
    const dark = renderStrip({ defaultTooltipOpen: true });
    expect(normalizeReactIds(dark.container.innerHTML)).toMatchSnapshot('dark-open-tooltip-strip');
    expectTooltip(true);
    dark.unmount();
  });

  it('captures compact-form rendering in a snapshot', () => {
    const compact = renderStrip({ isCompact: true });
    expect(normalizeReactIds(compact.container.innerHTML)).toMatchSnapshot('compact');
    compact.unmount();
  });

  it('uses failure-context tooltip copy while keeping the visible trust strip stable', () => {
    const rendered = renderStrip({ hasFailure: true, defaultTooltipOpen: true });

    expect(rendered.container.textContent).toContain('From Google Workspace');
    expect(rendered.container.textContent).toContain('Safe view');
    expectTooltip(true, 'This view failed to load. Rebel is showing a summary instead.');

    rendered.unmount();
  });

  it('is keyboard accessible: Enter toggles the tooltip closed and open', async () => {
    const rendered = renderStrip();
    const trigger = getTrigger(rendered.container);

    act(() => {
      trigger.focus();
    });
    await flush();
    expectTooltip(true);

    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expectTooltip(false);

    act(() => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expectTooltip(true);

    rendered.unmount();
  });
});
