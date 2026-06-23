// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpaceCard } from '../SpaceCard';
import type { EnrichedSpaceInfo } from '../spaceTypes';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function mount(ui: React.ReactElement, bodyClass?: string): Mounted {
  if (bodyClass) {
    document.body.className = bodyClass;
  }
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
      act(() => root.unmount());
      container.remove();
    },
  };
}

function makeSpace(): EnrichedSpaceInfo {
  return {
    name: 'General',
    path: 'work/Mindstone/General',
    absolutePath: '/workspace/work/Mindstone/General',
    type: 'project',
    isSymlink: false,
    hasReadme: true,
    description: 'General notes',
    sharing: 'restricted',
    organisationName: 'Mindstone',
    status: 'ok',
  };
}

function renderCard(
  theme: 'light' | 'dark',
  overrides: { onEdit?: () => void; isChiefOfStaff?: boolean } = {},
): Mounted {
  return mount(
    <SpaceCard
      space={makeSpace()}
      onEdit={overrides.onEdit ?? vi.fn()}
      onOpenInWorkspace={vi.fn()}
      onRevealInFolder={vi.fn()}
      onEditReadme={vi.fn()}
      onRemove={vi.fn()}
      onMigrateLegacyAgentsMd={vi.fn()}
      isChiefOfStaff={overrides.isChiefOfStaff}
    />,
    theme,
  );
}

describe('SpaceCard organisation chip', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    document.body.className = '';
    vi.clearAllMocks();
  });

  it('renders the organisation chip as an interactive edit button that opens the space editor', () => {
    const onEdit = vi.fn();
    mounted = renderCard('dark', { onEdit });

    const chip = mounted.container.querySelector('[aria-label="Edit organisation: Mindstone"]');
    expect(chip).toBeInstanceOf(HTMLButtonElement);
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.textContent).toContain('Mindstone');

    act(() => {
      (chip as HTMLButtonElement).click();
    });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ organisationName: 'Mindstone' }));
  });

  it('renders a non-interactive organisation chip for Chief-of-Staff (no edit surface)', () => {
    mounted = renderCard('dark', { isChiefOfStaff: true });

    const chip = mounted.container.querySelector('[aria-label="Organisation: Mindstone"]');
    expect(chip).toBeInstanceOf(HTMLSpanElement);
    expect(chip?.tagName).toBe('SPAN');
    expect(chip?.textContent).toContain('Mindstone');
    expect(mounted.container.querySelector('[aria-label="Edit organisation: Mindstone"]')).toBeNull();
  });

  it.each(['light', 'dark'] as const)('renders the organisation chip in %s mode', (theme) => {
    mounted = renderCard(theme);

    const chip = mounted.container.querySelector('[aria-label="Edit organisation: Mindstone"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toContain('Mindstone');
  });
});
