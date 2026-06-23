// @vitest-environment happy-dom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { OperatorCard } from '../OperatorCard';

const baseOperator: OperatorMetadata = {
  id: '/workspace/Chief-of-Staff::customer-voice',
  operatorSlug: 'customer-voice',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  category: 'space',
  name: 'Customer Voice',
  description: 'Speaks for the user.',
  consult_when: 'When discovery findings need a customer perspective.',
  kind: 'operator',
  roles: ['operator'],
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/customer-voice/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/customer-voice/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/customer-voice/diary.md',
};

describe('OperatorCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('renders the bundled state with activation Select and button', async () => {
    const onActivate = vi.fn();
    await act(async () => {
      root.render(
        <OperatorCard
          operator={{ ...baseOperator, category: 'bundled' }}
          state={{ kind: 'bundled' }}
          spaceLabel="Bundled"
          activationTargets={[
            { sourceSpacePath: '/workspace/Chief-of-Staff', label: 'Chief-of-Staff', isChiefOfStaff: true },
            { sourceSpacePath: '/workspace/Launch', label: 'Launch' },
          ]}
          defaultActivationTargetSpacePath="/workspace/Chief-of-Staff"
          onActivate={onActivate}
        />,
      );
    });

    const select = container.querySelector('select') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select?.value).toBe('/workspace/Chief-of-Staff');
    const activateButton = container.querySelector('[data-testid="operator-activate-button"]');
    expect(activateButton?.textContent).toContain('Activate');

    await act(async () => {
      activateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onActivate).toHaveBeenCalledWith('/workspace/Chief-of-Staff');
  });

  it('renders the activated state with action buttons and the More menu', async () => {
    const onPersonalise = vi.fn();
    const onOpenInstructions = vi.fn();
    const onRename = vi.fn();

    await act(async () => {
      root.render(
        <OperatorCard
          operator={baseOperator}
          state={{ kind: 'activated', personalised: false, personalising: false }}
          spaceLabel="Chief-of-Staff"
          onPersonalise={onPersonalise}
          onOpenInstructions={onOpenInstructions}
          onRename={onRename}
        />,
      );
    });

    const personalise = container.querySelector('[data-testid="operator-personalise-button"]') as HTMLButtonElement | null;
    expect(personalise).not.toBeNull();
    expect(personalise?.disabled).toBe(false);
    expect(personalise?.textContent).toContain('Personalise');

    const instructionsButton = container.querySelector('[data-testid="operator-instructions-button"]') as HTMLButtonElement | null;
    expect(instructionsButton).not.toBeNull();
    await act(async () => {
      instructionsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenInstructions).toHaveBeenCalled();

    expect(container.querySelector('[data-testid="operator-card-more-button"]')).not.toBeNull();
  });

  it('renders Generic vs Personalised badges correctly', async () => {
    await act(async () => {
      root.render(
        <OperatorCard
          operator={baseOperator}
          state={{ kind: 'activated', personalised: false, personalising: false }}
          spaceLabel="Chief-of-Staff"
        />,
      );
    });
    expect(container.textContent).toContain('Generic');

    await act(async () => {
      root.render(
        <OperatorCard
          operator={baseOperator}
          state={{ kind: 'activated', personalised: true, personalising: false }}
          spaceLabel="Chief-of-Staff"
        />,
      );
    });
    expect(container.textContent).toContain('Personalised');
  });

  it('hides the live meeting toggle if onToggleLiveMeeting is not provided', async () => {
    await act(async () => {
      root.render(
        <OperatorCard
          operator={baseOperator}
          state={{ kind: 'activated', personalised: false, personalising: false }}
          spaceLabel="Chief-of-Staff"
        />,
      );
    });
    expect(container.textContent).not.toContain('Live meeting coach');
  });

  it('renders the live meeting toggle when onToggleLiveMeeting is provided', async () => {
    const onToggleLiveMeeting = vi.fn();
    await act(async () => {
      root.render(
        <OperatorCard
          operator={baseOperator}
          state={{ kind: 'activated', personalised: true, personalising: false }}
          spaceLabel="Chief-of-Staff"
          onToggleLiveMeeting={onToggleLiveMeeting}
        />,
      );
    });
    expect(container.textContent).toContain('Live meeting coach');
  });

  it('renders all Phase A card variants without legacy Notes actions', async () => {
    const variants: Array<{
      label: string;
      operator: OperatorMetadata;
      state: React.ComponentProps<typeof OperatorCard>['state'];
      expectedText: string[];
      forbiddenText: string[];
    }> = [
      {
        label: 'bundled',
        operator: { ...baseOperator, category: 'bundled' },
        state: { kind: 'bundled' },
        expectedText: ['Bundled', 'Operator', 'Activate'],
        forbiddenText: ['Personalise', 'Instructions', 'Notes', 'Edit notes', 'Preview'],
      },
      {
        label: 'activated never personalised',
        operator: baseOperator,
        state: { kind: 'activated', personalised: false, personalising: false },
        expectedText: ['Generic', 'Operator', 'Personalise', 'Instructions', 'Live meeting coach'],
        forbiddenText: ['Notes', 'Edit notes', 'Preview'],
      },
      {
        label: 'activated personalised',
        operator: baseOperator,
        state: { kind: 'activated', personalised: true, personalising: false },
        expectedText: ['Personalised', 'Operator', 'Re-personalise', 'Instructions', 'Live meeting coach'],
        forbiddenText: ['Notes', 'Edit notes', 'Preview'],
      },
      {
        label: 'personalising in progress',
        operator: baseOperator,
        state: { kind: 'activated', personalised: false, personalising: true },
        expectedText: ['Generic', 'Personalising…', 'Operator', 'Instructions'],
        forbiddenText: ['Notes', 'Edit notes', 'Preview'],
      },
      {
        label: 'live-coach only',
        operator: { ...baseOperator, roles: ['live_meeting'], consult_when: '' },
        state: { kind: 'activated', personalised: true, personalising: false },
        expectedText: ['Personalised', 'Live coach', 'Instructions', 'Live meeting coach'],
        forbiddenText: ['Best when:', 'Notes', 'Edit notes', 'Preview'],
      },
      {
        label: 'dual-role',
        operator: { ...baseOperator, roles: ['operator', 'live_meeting'] },
        state: { kind: 'activated', personalised: true, personalising: false },
        expectedText: ['Personalised', 'Operator', 'Live coach', 'Re-personalise', 'Instructions', 'Live meeting coach'],
        forbiddenText: ['Notes', 'Edit notes', 'Preview'],
      },
    ];

    for (const variant of variants) {
      await act(async () => {
        root.render(
          <OperatorCard
            operator={variant.operator}
            state={variant.state}
            spaceLabel={variant.operator.category === 'bundled' ? 'Bundled' : 'Chief-of-Staff'}
            activationTargets={[
              { sourceSpacePath: '/workspace/Chief-of-Staff', label: 'Chief-of-Staff', isChiefOfStaff: true },
            ]}
            defaultActivationTargetSpacePath="/workspace/Chief-of-Staff"
            onActivate={vi.fn()}
            onPersonalise={vi.fn()}
            onOpenInstructions={vi.fn()}
            onToggleLiveMeeting={vi.fn()}
            onRename={vi.fn()}
            onDuplicate={vi.fn()}
            onHistory={vi.fn()}
            onRemove={vi.fn()}
          />,
        );
      });

      for (const expected of variant.expectedText) {
        expect(container.textContent, variant.label).toContain(expected);
      }
      for (const forbidden of variant.forbiddenText) {
        expect(container.textContent, variant.label).not.toContain(forbidden);
      }
      if (variant.label === 'live-coach only') {
        expect(container.querySelector('[data-testid="operator-personalise-button"]')).toBeNull();
      }
    }
  });

  it('omits Duplicate and History for live-coach-only operators', async () => {
    await act(async () => {
      root.render(
        <OperatorCard
          operator={{ ...baseOperator, roles: ['live_meeting'], consult_when: '' }}
          state={{ kind: 'activated', personalised: true, personalising: false }}
          spaceLabel="Chief-of-Staff"
          onOpenInstructions={vi.fn()}
          onToggleLiveMeeting={vi.fn()}
          onRename={vi.fn()}
          onDuplicate={vi.fn()}
          onHistory={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
    });

    const moreButton = container.querySelector('[data-testid="operator-card-more-button"]');
    await act(async () => {
      moreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.querySelector('[data-testid="operator-card-more-rename"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="operator-card-more-remove"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="operator-card-more-duplicate"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="operator-card-more-history"]')).toBeNull();
  });

  it('invokes Personalise and the live meeting toggle when clicked', async () => {
    const onPersonalise = vi.fn();
    const onToggleLiveMeeting = vi.fn();
    await act(async () => {
      root.render(
        <OperatorCard
          operator={baseOperator}
          state={{ kind: 'activated', personalised: false, personalising: false }}
          spaceLabel="Chief-of-Staff"
          onPersonalise={onPersonalise}
          onOpenInstructions={vi.fn()}
          onToggleLiveMeeting={onToggleLiveMeeting}
        />,
      );
    });

    const personalise = container.querySelector('[data-testid="operator-personalise-button"]') as HTMLButtonElement | null;
    const liveToggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(personalise?.disabled).toBe(false);
    expect(liveToggle?.disabled).toBe(false);

    await act(async () => {
      personalise?.click();
      liveToggle?.click();
    });

    expect(onPersonalise).toHaveBeenCalledTimes(1);
    expect(onToggleLiveMeeting).toHaveBeenCalledTimes(1);
    expect(onToggleLiveMeeting).toHaveBeenCalledWith(true);
  });

  it('reflects the live_meeting role in the toggle checked state and disables it while busy', async () => {
    const onToggleLiveMeeting = vi.fn();
    await act(async () => {
      root.render(
        <OperatorCard
          operator={{ ...baseOperator, roles: ['operator', 'live_meeting'] }}
          state={{ kind: 'activated', personalised: true, personalising: false }}
          spaceLabel="Chief-of-Staff"
          busyAction="live-toggle"
          liveMeetingEnabled
          onToggleLiveMeeting={onToggleLiveMeeting}
        />,
      );
    });

    const liveToggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(liveToggle?.checked).toBe(true);
    expect(liveToggle?.disabled).toBe(true);
  });

  it('disables the Personalise button while a personalisation run is active', async () => {
    const onPersonalise = vi.fn();
    await act(async () => {
      root.render(
        <OperatorCard
          operator={baseOperator}
          state={{ kind: 'activated', personalised: false, personalising: true }}
          spaceLabel="Chief-of-Staff"
          onPersonalise={onPersonalise}
          onOpenInstructions={vi.fn()}
        />,
      );
    });

    const personalise = container.querySelector('[data-testid="operator-personalise-button"]') as HTMLButtonElement | null;
    expect(personalise?.disabled).toBe(true);
    expect(personalise?.textContent).toContain('Personalising…');

    await act(async () => {
      personalise?.click();
    });

    expect(onPersonalise).not.toHaveBeenCalled();
  });
});
