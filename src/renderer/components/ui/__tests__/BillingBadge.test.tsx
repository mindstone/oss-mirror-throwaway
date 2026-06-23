// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingBadge } from '../BillingBadge';
import type { BillingSource } from '@shared/utils/billingSource';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../Tooltip', async () => {
  const ReactLocal = await vi.importActual<typeof import('react')>('react');
  return {
    Tooltip: ({
      content,
      children,
    }: {
      content: React.ReactNode;
      children: React.ReactElement<{ 'data-tooltip-content'?: string }>;
    }) => ReactLocal.cloneElement(children, { 'data-tooltip-content': String(content) }),
  };
});

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

describe('BillingBadge', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  const cases: Array<{
    source: BillingSource;
    label: string;
    variant: string;
    tooltip: string;
  }> = [
    {
      source: 'subscription',
      label: 'Subscription',
      variant: 'success',
      tooltip: 'Included with your subscription plan.',
    },
    {
      source: 'pay-per-use',
      label: 'Pay-per-use',
      variant: 'muted',
      tooltip: 'Billed per request via your API key.',
    },
    {
      source: 'local',
      label: 'Local',
      variant: 'secondary',
      tooltip: 'Runs on your computer. No network. No bill.',
    },
  ];

  for (const testCase of cases) {
    it(`renders the ${testCase.source} badge label, variant, and aria-label`, () => {
      mounted = mount(<BillingBadge source={testCase.source} />);

      const badge = mounted.container.querySelector(
        `[data-billing-source="${testCase.source}"]`
      ) as HTMLSpanElement | null;

      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe(testCase.label);
      expect(badge?.getAttribute('data-billing-variant')).toBe(testCase.variant);
      expect(badge?.getAttribute('aria-label')).toBe(testCase.tooltip);
      expect(badge?.getAttribute('data-tooltip-content')).toBe(testCase.tooltip);
    });
  }
});
