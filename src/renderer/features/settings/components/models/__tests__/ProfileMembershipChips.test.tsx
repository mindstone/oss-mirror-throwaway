// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COUNCIL_MANAGED_NO_BYOK_TOOLTIP } from '@shared/utils/councilProfiles';

import {
  ProfileMembershipChips,
  type ProfileMembershipDisabledReason,
} from '../ProfileMembershipChips';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

const DISABLED_TOOLTIPS: Record<ProfileMembershipDisabledReason, string> = {
  companyManaged: 'Managed by your company. Contact your admin to change.',
  profileDisabled: 'Enable this profile first.',
  turnInFlight: 'Edits apply to your next turn.',
  orphanedProvider: 'Fix this profile’s provider first.',
  managedNoBYOK: COUNCIL_MANAGED_NO_BYOK_TOOLTIP,
};

function mount(
  ui: React.ReactElement,
): Mounted {
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

function click(element: Element | null): void {
  act(() => {
    element?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function keyDown(element: Element | null, key: string): void {
  act(() => {
    element?.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function chip(container: HTMLElement, name: 'council' | 'smart-picking'): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="chips-${name}"]`);
  if (!element) throw new Error(`Missing ${name} chip`);
  return element;
}

describe('ProfileMembershipChips', () => {
  let mounted: Mounted[] = [];
  let onToggleCouncil: ReturnType<typeof vi.fn<() => void>>;
  let onToggleSmartPicking: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    onToggleCouncil = vi.fn<() => void>();
    onToggleSmartPicking = vi.fn<() => void>();
  });

  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted = [];
    document.body.innerHTML = '';
  });

  function renderChips(
    props: Partial<React.ComponentProps<typeof ProfileMembershipChips>> = {},
  ): Mounted {
    const instance = mount(
      <ProfileMembershipChips
        councilEnabled={false}
        routingEligible={false}
        onToggleCouncil={onToggleCouncil}
        onToggleSmartPicking={onToggleSmartPicking}
        testIdPrefix="chips"
        {...props}
      />,
    );
    mounted.push(instance);
    return instance;
  }

  it('renders both chips with correct on/off styling', () => {
    const m = renderChips({ councilEnabled: true, routingEligible: false });

    const council = chip(m.container, 'council');
    const smartPicking = chip(m.container, 'smart-picking');

    expect(council.textContent).toBe('Council');
    expect(council.getAttribute('aria-pressed')).toBe('true');
    expect(council.className).toMatch(/membershipChipOn/);
    expect(smartPicking.textContent).toBe('Smart picking');
    expect(smartPicking.getAttribute('aria-pressed')).toBe('false');
    expect(smartPicking.className).toMatch(/membershipChipOff/);
  });

  it('clicking Council invokes the Council toggle callback', () => {
    const m = renderChips();

    click(chip(m.container, 'council'));

    expect(onToggleCouncil).toHaveBeenCalledTimes(1);
    expect(onToggleSmartPicking).not.toHaveBeenCalled();
  });

  it('clicking Smart picking invokes the Smart picking toggle callback', () => {
    const m = renderChips();

    click(chip(m.container, 'smart-picking'));

    expect(onToggleSmartPicking).toHaveBeenCalledTimes(1);
    expect(onToggleCouncil).not.toHaveBeenCalled();
  });

  it.each(
    Object.entries(DISABLED_TOOLTIPS) as Array<[ProfileMembershipDisabledReason, string]>,
  )('disables chips for %s and shows the reason tooltip', (disabledReason, tooltipText) => {
    const m = renderChips({ disabledReason });
    const council = chip(m.container, 'council');
    const smartPicking = chip(m.container, 'smart-picking');

    expect(council.getAttribute('aria-disabled')).toBe('true');
    expect(smartPicking.getAttribute('aria-disabled')).toBe('true');
    expect(council.querySelector('button')?.disabled).toBe(true);
    expect(smartPicking.querySelector('button')?.disabled).toBe(true);

    click(council);
    click(smartPicking);
    keyDown(council, 'Enter');
    keyDown(smartPicking, ' ');

    expect(onToggleCouncil).not.toHaveBeenCalled();
    expect(onToggleSmartPicking).not.toHaveBeenCalled();

    act(() => {
      council.focus();
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(tooltipText);
  });

  it('Enter and Space toggle enabled chips', () => {
    const m = renderChips();

    keyDown(chip(m.container, 'council'), 'Enter');
    keyDown(chip(m.container, 'smart-picking'), ' ');

    expect(onToggleCouncil).toHaveBeenCalledTimes(1);
    expect(onToggleSmartPicking).toHaveBeenCalledTimes(1);
  });
});
