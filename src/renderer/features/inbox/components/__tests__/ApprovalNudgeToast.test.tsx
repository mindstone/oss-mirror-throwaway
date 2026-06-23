// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalNudgeToast } from '../ApprovalNudgeToast';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderApprovalNudgeToast(props: {
  count: number;
  questionCount?: number;
  drawerVisible?: boolean;
  onOpenDrawer?: () => void;
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const onOpenDrawer = props.onOpenDrawer ?? vi.fn();

  act(() => {
    root?.render(
      <ApprovalNudgeToast
        count={props.count}
        questionCount={props.questionCount}
        drawerVisible={props.drawerVisible ?? false}
        onOpenDrawer={onOpenDrawer}
      />,
    );
  });

  return { container, onOpenDrawer };
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
});

describe('ApprovalNudgeToast', () => {
  it('opens the approval drawer from a keyboard-reachable review target', () => {
    const onOpenDrawer = vi.fn();
    const { container } = renderApprovalNudgeToast({ count: 1, onOpenDrawer });

    const reviewTarget = container.querySelector<HTMLElement>('[data-testid="approval-nudge-toast"]');
    const reviewButton = container.querySelector<HTMLButtonElement>('.approval-nudge-toast__body');

    expect(reviewTarget).not.toBeNull();
    expect(reviewButton?.getAttribute('aria-label')).toBe('Rebel needs your approval on 1 action');

    act(() => {
      reviewButton?.click();
    });

    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });

  it('shows pending questions when no approval is waiting', () => {
    const onOpenDrawer = vi.fn();
    const { container } = renderApprovalNudgeToast({
      count: 0,
      questionCount: 1,
      onOpenDrawer,
    });

    const reviewTarget = container.querySelector<HTMLElement>('[data-testid="approval-nudge-toast"]');
    const reviewButton = container.querySelector<HTMLButtonElement>('.approval-nudge-toast__body');

    expect(reviewTarget).not.toBeNull();
    expect(reviewButton?.getAttribute('aria-label')).toBe('Rebel needs 1 detail');
    expect(container.textContent).toContain('Rebel needs one detail');
    expect(container.textContent).not.toContain('approval');

    act(() => {
      reviewButton?.click();
    });

    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });

  it('summarizes approvals and questions together', () => {
    const { container } = renderApprovalNudgeToast({ count: 2, questionCount: 1 });

    expect(container.textContent).toContain('2 approvals and 1 detail waiting');
  });

  it('dismisses until a new approval count arrives', () => {
    const { container } = renderApprovalNudgeToast({ count: 1 });

    expect(container.querySelector('[data-testid="approval-nudge-toast"]')).not.toBeNull();

    const closeButton = container.querySelector<HTMLButtonElement>('.approval-nudge-toast__close');
    act(() => {
      closeButton?.click();
    });

    expect(container.querySelector('[data-testid="approval-nudge-toast"]')).toBeNull();

    act(() => {
      root?.render(
        <ApprovalNudgeToast
          count={2}
          questionCount={0}
          drawerVisible={false}
          onOpenDrawer={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="approval-nudge-toast"]')).not.toBeNull();
    expect(container.textContent).toContain('2 approvals waiting');
  });

  it('stays dismissed when the count only returns to the dismissed count', () => {
    const { container } = renderApprovalNudgeToast({ count: 2 });

    const closeButton = container.querySelector<HTMLButtonElement>('.approval-nudge-toast__close');
    act(() => {
      closeButton?.click();
    });

    act(() => {
      root?.render(
        <ApprovalNudgeToast
          count={1}
          questionCount={0}
          drawerVisible={false}
          onOpenDrawer={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="approval-nudge-toast"]')).toBeNull();

    act(() => {
      root?.render(
        <ApprovalNudgeToast
          count={2}
          questionCount={0}
          drawerVisible={false}
          onOpenDrawer={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="approval-nudge-toast"]')).toBeNull();
  });
});
