// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundAuthorPolicy } from '@rebel/shared';
import {
  INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY,
  INBOUND_AUTHOR_UPGRADE_REPROMPT_SUPPRESSED_KEY,
} from '../../../hooks/useInboundAuthorPolicy';
import { UpgradeReviewNotice } from '../UpgradeReviewNotice';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function render(ui: React.ReactElement): Mounted {
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

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function buildPolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
  return {
    inboundAuthorPolicySchemaVersion: 1,
    policyRevision: 1,
    mode: 'legacyPermissive',
    allowlist: {},
    blocklist: {},
    surfaceTrusted: {},
    agentAllowlist: {},
    notices: {
      upgradeReviewPending: true,
    },
    ...overrides,
  };
}

describe('UpgradeReviewNotice', () => {
  const mounted: Mounted[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted.length = 0;
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders locked pending copy with Review and Dismiss actions', () => {
    const m = render(
      <UpgradeReviewNotice
        policy={buildPolicy()}
        recentSendersCount={4}
        onDismiss={vi.fn()}
        onMarkDismissedNow={vi.fn()}
      />,
    );
    mounted.push(m);

    expect(m.container.textContent).toContain('Review who can message Rebel');
    expect(m.container.textContent).toContain('Rebel can now limit who may message it from Slack. Your existing setup still works, but it needs a quick review. Sensible, if not glamorous.');
    expect(m.container.textContent).toContain('Review');
    expect(m.container.textContent).toContain('Dismiss');
  });

  it('dismiss action calls settings and local dismissal handlers', async () => {
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    const onMarkDismissedNow = vi.fn();
    const m = render(
      <UpgradeReviewNotice
        policy={buildPolicy()}
        recentSendersCount={1}
        onDismiss={onDismiss}
        onMarkDismissedNow={onMarkDismissedNow}
      />,
    );
    mounted.push(m);

    const dismiss = m.container.querySelector('[data-testid="upgrade-review-notice-dismiss"]');
    expect(dismiss).not.toBeNull();
    await click(dismiss!);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onMarkDismissedNow).toHaveBeenCalledTimes(1);
  });

  it('renders 60-day reprompt copy for legacy permissive mode with blocked attempts', () => {
    window.localStorage.setItem(
      INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY,
      String(Date.now() - (61 * 24 * 60 * 60 * 1000)),
    );
    window.localStorage.removeItem(INBOUND_AUTHOR_UPGRADE_REPROMPT_SUPPRESSED_KEY);

    const m = render(
      <UpgradeReviewNotice
        policy={buildPolicy({
          notices: { upgradeReviewPending: false },
          mode: 'legacyPermissive',
        })}
        recentSendersCount={7}
        onDismiss={vi.fn()}
        onMarkDismissedNow={vi.fn()}
      />,
    );
    mounted.push(m);

    expect(m.container.textContent).toContain("You haven't tightened messaging access in 60 days — 7 strangers tried to message Rebel.");
  });

  it('review action scrolls/focuses to who-can-message-rebel section', async () => {
    const target = document.createElement('section');
    target.setAttribute('data-section', 'who-can-message-rebel');
    const focusButton = document.createElement('button');
    target.appendChild(focusButton);
    document.body.appendChild(target);

    const focusSpy = vi.spyOn(focusButton, 'focus');
    const m = render(
      <UpgradeReviewNotice
        policy={buildPolicy()}
        recentSendersCount={2}
        onDismiss={vi.fn()}
        onMarkDismissedNow={vi.fn()}
      />,
    );
    mounted.push(m);

    const review = m.container.querySelector('[data-testid="upgrade-review-notice-review"]');
    expect(review).not.toBeNull();
    await click(review!);

    expect((HTMLElement.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('hides when no pending review and no qualifying reprompt trigger', () => {
    const m = render(
      <UpgradeReviewNotice
        policy={buildPolicy({
          notices: { upgradeReviewPending: false },
          mode: 'ownerOnly',
        })}
        recentSendersCount={0}
        onDismiss={vi.fn()}
        onMarkDismissedNow={vi.fn()}
      />,
    );
    mounted.push(m);

    expect(m.container.innerHTML).toBe('');
  });
});
