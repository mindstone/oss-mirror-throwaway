// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillCard } from '../SkillCard';
import styles from '../SkillCard.module.css';

vi.mock('@renderer/features/auth/hooks/useAuth', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('../SkillImprovementPanel', () => ({
  SkillImprovementPanel: () => <div data-testid="skill-improvement-panel">Quality panel</div>,
}));

vi.mock('../SkillHistoryPanel', () => ({
  SkillHistoryPanel: () => null,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const BASE_SKILL_CONTENT = `---
description: Writes concise updates for your team.
use_cases:
  - Weekly updates
  - Stakeholder summaries
tools_required:
  - Slack
dependencies:
  - write-summary
---
# Team update writer
`;

describe('SkillCard grid presentation', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders compact grid mode without improvement/details panels and with clamped description', () => {
    mounted = mount(
      <SkillCard
        presentation="grid"
        content={BASE_SKILL_CONTENT}
        relativePath="Chief-of-Staff/skills/team-update/SKILL.md"
        fileName="team-update.md"
        qualityScore={82}
        qualityBand="solid"
        qualityTopImprovement={{ dimension: 'clarity', suggestion: 'Add clearer output constraints.' }}
        examplePaths={['examples/team-update.md', 'examples/stakeholder-summary.md']}
        onShowRaw={vi.fn()}
        onOpenFilePath={vi.fn()}
      />,
    );

    const cardRoot = mounted.container.querySelector('[data-testid="skill-card-grid-root"]');
    const description = mounted.container.querySelector('[data-testid="skill-card-grid-description"]');
    const summary = mounted.container.querySelector('[data-testid="skill-card-grid-summary"]');

    expect(cardRoot).toBeTruthy();
    expect(cardRoot?.className).toContain(styles.cardGrid);
    expect(cardRoot?.getAttribute('role')).toBeNull();
    expect(cardRoot?.getAttribute('tabindex')).toBe('-1');
    expect(description).toBeTruthy();
    expect(description?.className).toContain(styles.descriptionClamped);
    expect(summary?.textContent).toContain('2 use cases');
    expect(mounted.container.querySelector('[data-testid="skill-improvement-panel"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain('Behind the Scenes');
  });

  it('opens the skill when the compact grid card is clicked', () => {
    const onShowRaw = vi.fn();
    mounted = mount(
      <SkillCard
        presentation="grid"
        content={BASE_SKILL_CONTENT}
        relativePath="Chief-of-Staff/skills/team-update/SKILL.md"
        fileName="team-update.md"
        onShowRaw={onShowRaw}
        onOpenFilePath={vi.fn()}
      />,
    );

    const cardRoot = mounted.container.querySelector('[data-testid="skill-card-grid-root"]');
    if (!(cardRoot instanceof HTMLElement)) {
      throw new Error('Expected grid card root to render');
    }

    act(() => {
      cardRoot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onShowRaw).toHaveBeenCalledTimes(1);
  });

  it('opens the skill on Enter and Space keydown in grid mode', () => {
    const onShowRaw = vi.fn();
    mounted = mount(
      <SkillCard
        presentation="grid"
        content={BASE_SKILL_CONTENT}
        relativePath="Chief-of-Staff/skills/team-update/SKILL.md"
        fileName="team-update.md"
        onShowRaw={onShowRaw}
        onOpenFilePath={vi.fn()}
      />,
    );

    const cardRoot = mounted.container.querySelector('[data-testid="skill-card-grid-root"]');
    if (!(cardRoot instanceof HTMLElement)) {
      throw new Error('Expected grid card root to render');
    }

    act(() => {
      cardRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      cardRoot.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });

    expect(onShowRaw).toHaveBeenCalledTimes(2);
  });

  it('prevents nested grid actions from bubbling to card open handlers', () => {
    const onShowRaw = vi.fn();
    const onUseSkill = vi.fn();
    mounted = mount(
      <SkillCard
        presentation="grid"
        content={BASE_SKILL_CONTENT}
        relativePath="Chief-of-Staff/skills/team-update/SKILL.md"
        fileName="team-update.md"
        onShowRaw={onShowRaw}
        onUseSkill={onUseSkill}
        onOpenFilePath={vi.fn()}
      />,
    );

    const openButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Open instructions',
    );
    if (!(openButton instanceof HTMLButtonElement)) {
      throw new Error('Open instructions button not found');
    }
    act(() => {
      openButton.click();
    });
    expect(onShowRaw).toHaveBeenCalledTimes(1);

    const useSkillButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Use Skill',
    );
    if (!(useSkillButton instanceof HTMLButtonElement)) {
      throw new Error('Use Skill button not found');
    }
    act(() => {
      useSkillButton.click();
    });

    expect(onUseSkill).toHaveBeenCalledTimes(1);
    expect(onShowRaw).toHaveBeenCalledTimes(1);
  });

  it('prevents invalid-view instructions button from double-firing card click', () => {
    const onShowRaw = vi.fn();
    mounted = mount(
      <SkillCard
        presentation="grid"
        content={'---\nname: [\n---\n'}
        relativePath="Chief-of-Staff/skills/team-update/SKILL.md"
        fileName="team-update.md"
        onShowRaw={onShowRaw}
        onOpenFilePath={vi.fn()}
      />,
    );

    const viewInstructionsButton = Array.from(mounted.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Open instructions',
    );
    if (!(viewInstructionsButton instanceof HTMLButtonElement)) {
      throw new Error('Open instructions button not found');
    }
    act(() => {
      viewInstructionsButton.click();
    });

    expect(onShowRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps detail presentation behavior by rendering the improvement panel', () => {
    mounted = mount(
      <SkillCard
        presentation="detail"
        content={BASE_SKILL_CONTENT}
        relativePath="Chief-of-Staff/skills/team-update/SKILL.md"
        fileName="team-update.md"
        qualityScore={82}
        qualityBand="solid"
        qualityTopImprovement={{ dimension: 'clarity', suggestion: 'Add clearer output constraints.' }}
        onShowRaw={vi.fn()}
        onOpenFilePath={vi.fn()}
      />,
    );

    expect(mounted.container.querySelector('[data-testid="skill-improvement-panel"]')).toBeTruthy();
  });
});
