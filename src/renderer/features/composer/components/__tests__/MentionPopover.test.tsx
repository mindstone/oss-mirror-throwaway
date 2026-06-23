// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MentionState } from '../../hooks';
import { MentionPopover } from '../MentionPopover';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseMentionState: MentionState = {
  active: true,
  startIndex: 0,
  endIndex: 1,
  rawQuery: '',
  query: '',
  filter: 'all',
  hasExplicitPrefix: false,
  results: [],
  selectedIndex: 0,
};

function renderPopover(
  mentionState: MentionState,
  overrides: Partial<React.ComponentProps<typeof MentionPopover>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MentionPopover
        isTextMode={true}
        mentionState={mentionState}
        coreDirectory="/workspace"
        libraryIndex={[]}
        libraryIndexLoading={false}
        libraryIndexError={null}
        getRelativeLibraryPath={(path) => path}
        refreshLibraryIndex={async () => undefined}
        insertMentionResult={vi.fn()}
        setSelectedIndex={vi.fn()}
        hasConversations={false}
        showModelsTab={true}
        hasOperators={false}
        {...overrides}
      />,
    );
  });
  return {
    root,
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('MentionPopover', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('filters the Operators tab out when no Operators are available', () => {
    const view = renderPopover(baseMentionState, { hasOperators: false });
    expect(document.querySelector('[data-testid="mention-filter-operators"]')).toBeNull();
    view.unmount();
  });

  it('shows the zero-Operators affordance when no Operators are available', () => {
    const onOpenOperatorsPanel = vi.fn();
    const view = renderPopover(baseMentionState, {
      hasOperators: false,
      onOpenOperatorsPanel,
    });
    expect(document.body.textContent).toContain('No Operators yet. Set them up in Operators.');
    const openButton = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Open')) as HTMLButtonElement | undefined;
    expect(openButton).toBeDefined();
    act(() => {
      openButton?.click();
    });
    expect(onOpenOperatorsPanel).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('shows Operator results and the Operators tab when Operators are available', () => {
    const view = renderPopover({
      ...baseMentionState,
      results: [{
        kind: 'operator',
        operatorId: '/workspace/Chief-of-Staff::skeptical-engineer',
        operatorSlug: 'skeptical-engineer',
        operatorName: 'Skeptical Engineer',
        description: 'Stress-tests the plan.',
        consultWhen: 'When the plan needs pressure.',
        score: 0,
        matches: [[0, 9]],
      }],
    }, { hasOperators: true });
    expect(document.querySelector('[data-testid="mention-filter-operators"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Skeptical Engineer');
    view.unmount();
  });
});
