// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { TeamKnowledgeIndicator } from '../TeamKnowledgeIndicator';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState = vi.hoisted(() => ({
  value: {
    settings: {
      spaces: [
        {
          name: 'Exec',
          path: 'work/Mindstone/Exec',
          type: 'team',
          isSymlink: false,
          sharing: 'restricted',
          companyName: 'Mindstone',
        },
        {
          name: 'General',
          path: 'work/Mindstone/General',
          type: 'team',
          isSymlink: false,
          sharing: 'restricted',
          companyName: 'Mindstone',
        },
      ],
    },
  },
}));

 
vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: () => settingsState.value,
}));

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
      act(() => root.unmount());
      container.remove();
    },
  };
}

function fileSearchEvent(): AgentEvent {
  return {
    type: 'tool',
    toolName: 'file_search',
    toolUseId: 'file-search-turn-1',
    stage: 'end',
    detail: JSON.stringify({
      action: 'search',
      sources: [
        {
          relativePath: 'work/Mindstone/Exec/plan.md',
          score: 0.9,
          spaceName: 'Exec',
          spaceDisplayName: 'Exec',
          sharing: 'restricted',
        },
        {
          relativePath: 'work/Mindstone/General/notes.md',
          score: 0.8,
          spaceName: 'General',
          spaceDisplayName: 'General',
          sharing: 'restricted',
        },
      ],
    }),
    timestamp: Date.now(),
  };
}

describe('TeamKnowledgeIndicator organisation grouping', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('shows an organisation header chip when multiple source spaces share an organisation', async () => {
    mounted = mount(<TeamKnowledgeIndicator turnEvents={[fileSearchEvent()]} />);

    const pill = mounted.container.querySelector<HTMLElement>('.team-knowledge-indicator');
    expect(pill).toBeTruthy();

    await act(async () => {
      pill?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const organisationChip = mounted.container.querySelector('.team-knowledge-card__organisation-chip');
    expect(organisationChip?.textContent).toBe('Mindstone');
    expect(mounted.container.textContent).toContain('Exec');
    expect(mounted.container.textContent).toContain('General');
  });
});
