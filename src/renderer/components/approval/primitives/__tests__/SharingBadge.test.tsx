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
    Lock: createIcon('lock'),
    Users: createIcon('users'),
    Globe: createIcon('globe'),
    HelpCircle: createIcon('help-circle'),
  };
});

import { SharingBadge, type SharingLevel } from '../SharingBadge';
import styles from '../SharingBadge.module.css';

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

describe('SharingBadge', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  const cases: Array<{
    sharing: SharingLevel;
    icon: string;
    label: string;
    variantClass: string;
  }> = [
    { sharing: 'private', icon: 'lock', label: 'Private', variantClass: styles.private },
    { sharing: 'restricted', icon: 'users', label: 'Restricted', variantClass: styles.shared },
    {
      sharing: 'company-wide',
      icon: 'users',
      label: 'Company-wide',
      variantClass: styles.shared,
    },
    { sharing: 'public', icon: 'globe', label: 'Public', variantClass: styles.public },
    { sharing: 'unclear', icon: 'help-circle', label: 'Unclear', variantClass: styles.unclear },
  ];

  for (const testCase of cases) {
    it(`renders the ${testCase.sharing} badge icon, label, and classes`, () => {
      mounted = mount(<SharingBadge sharing={testCase.sharing} />);

      const badge = mounted.container.querySelector('span') as HTMLSpanElement | null;

      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe(testCase.label);
      expect(badge?.className).toContain(styles.badge);
      expect(badge?.className).toContain(testCase.variantClass);
      expect(badge?.querySelector(`[data-icon="${testCase.icon}"]`)).not.toBeNull();
    });
  }
});
