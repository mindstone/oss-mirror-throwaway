// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

 
vi.mock('lucide-react', async () => {
  const ReactLocal = await vi.importActual<typeof import('react')>('react');
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    ReactLocal.createElement('svg', { 'data-icon': name, ...props });

  return {
    ShieldCheck: createIcon('shield-check'),
    AlertCircle: createIcon('alert-circle'),
    AlertTriangle: createIcon('alert-triangle'),
    ShieldQuestion: createIcon('shield-question'),
  };
});

 
vi.mock('@renderer/components/ui', async () => {
  const ReactLocal = await vi.importActual<typeof import('react')>('react');
  return {
    Tooltip: ({
      content,
      children,
    }: {
      content: React.ReactNode;
      children: React.ReactElement<Record<string, unknown>>;
    }) => ReactLocal.cloneElement(children, { 'data-tooltip-content': String(content) }),
  };
});

import { RiskBadge, type RiskLevel } from '../RiskBadge';
import styles from '../RiskBadge.module.css';

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

describe('RiskBadge', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  const cases: Array<{
    riskLevel: RiskLevel;
    icon: string;
    label: string;
    variantClass: string;
  }> = [
    { riskLevel: 'low', icon: 'shield-check', label: 'Low risk', variantClass: styles.low },
    { riskLevel: 'medium', icon: 'alert-circle', label: 'Medium risk', variantClass: styles.medium },
    { riskLevel: 'high', icon: 'alert-triangle', label: 'High risk', variantClass: styles.high },
    {
      riskLevel: 'needs-review',
      icon: 'alert-circle',
      label: 'Needs review',
      variantClass: styles.medium,
    },
    {
      riskLevel: 'unknown',
      icon: 'shield-question',
      label: 'Unknown risk — unrated by safety evaluation',
      variantClass: styles.unknown,
    },
  ];

  for (const testCase of cases) {
    it(`renders the ${testCase.riskLevel} badge icon, tooltip label, and classes`, () => {
      mounted = mount(<RiskBadge riskLevel={testCase.riskLevel} />);

      const badge = mounted.container.querySelector('div[aria-label]') as HTMLDivElement | null;

      expect(badge).not.toBeNull();
      expect(badge?.getAttribute('aria-label')).toBe(testCase.label);
      expect(badge?.getAttribute('data-tooltip-content')).toBe(testCase.label);
      expect(badge?.className).toContain(styles.badge);
      expect(badge?.className).toContain(testCase.variantClass);
      expect(badge?.querySelector(`[data-icon="${testCase.icon}"]`)).not.toBeNull();
    });
  }
});
