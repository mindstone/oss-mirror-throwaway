// @vitest-environment happy-dom

/**
 * Render-level coverage for the Settings → Tools "Share with everyone"
 * button on `ConnectorContributionSection`.
 *
 * Stage 2 of `docs/plans/260428_keep_private_minimize_and_settings_share_button.md`:
 * the section's previously-dormant `_onShareWithCommunity` prop was wired
 * to a `Button` gated on `shouldShowShareCta(contribution)` AND prop
 * presence. This test pins:
 *   1. Button renders for `ready_to_submit` when the prop is provided.
 *   2. Button does NOT render when the prop is absent (legacy callers).
 *   3. Button does NOT render for non-shareable statuses (e.g. `submitted`)
 *      — already enforced by `shouldShowShareCta` but smoke-checked here.
 *   4. Click invokes the prop with `contribution.connectorName` (canonical
 *      name per critique C8) — exactly once.
 *
 * Pattern mirrors `ExpandedConnectionCard.test.tsx` /
 * `useConnectorContribution.test.ts`: manual `createRoot` + `act` from
 * `react-dom/client` because `@testing-library/react` is not installed.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockUseIsOssBuild = vi.hoisted(() => vi.fn(() => false));

vi.mock('@renderer/hooks/useIsOssBuild', () => ({
  useIsOssBuild: mockUseIsOssBuild,
}));

import { ConnectorContributionSection } from '../ConnectorContributionSection';
import type { ConnectorContribution } from '../../hooks/useConnectorContribution';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

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

function makeContribution(
  overrides: Partial<ConnectorContribution> = {},
): ConnectorContribution {
  return {
    id: 'contrib-1',
    sessionId: 'session-1',
    linkedSessionIds: ['session-1'],
    connectorName: 'test-connector-name',
    attributionMode: 'anonymous',
    status: 'ready_to_submit',
    acknowledgedEvents: [],
    createdAt: '2026-04-28T00:00:00Z',
    updatedAt: '2026-04-28T00:00:00Z',
    ...overrides,
  };
}

const SHARE_BUTTON_SELECTOR = '[data-testid="contribution-share-with-everyone"]';

describe('ConnectorContributionSection — Share with everyone button', () => {
  let mounted: Mounted[] = [];

  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted = [];
    document.body.innerHTML = '';
    vi.clearAllMocks();
    mockUseIsOssBuild.mockReturnValue(false);
  });

  it('renders the button when status is ready_to_submit and the callback is provided', () => {
    const onShare = vi.fn();
    const card = mount(
      <ConnectorContributionSection
        contribution={makeContribution({ status: 'ready_to_submit' })}
        isConnected
        loading={false}
        onShareWithCommunity={onShare}
      />,
    );
    mounted = [card];

    const button = card.container.querySelector(SHARE_BUTTON_SELECTOR);
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('Share with everyone');
    expect(button?.getAttribute('aria-label')).toBe(
      'Share test-connector-name with everyone',
    );
  });

  it('renders the button when status is draft and the callback is provided', () => {
    const onShare = vi.fn();
    const card = mount(
      <ConnectorContributionSection
        contribution={makeContribution({ status: 'draft' })}
        isConnected
        loading={false}
        onShareWithCommunity={onShare}
      />,
    );
    mounted = [card];

    expect(card.container.querySelector(SHARE_BUTTON_SELECTOR)).not.toBeNull();
  });

  it('does NOT render the button when onShareWithCommunity is omitted', () => {
    const card = mount(
      <ConnectorContributionSection
        contribution={makeContribution({ status: 'ready_to_submit' })}
        isConnected
        loading={false}
      />,
    );
    mounted = [card];

    expect(card.container.querySelector(SHARE_BUTTON_SELECTOR)).toBeNull();
  });

  it('does NOT render the button for non-shareable statuses (smoke check)', () => {
    const onShare = vi.fn();
    // Stay below the 10-minute "stuck testing" threshold so the testing-status
    // case doesn't render `StuckContributionRecovery` (which needs a
    // ToastProvider ancestor we don't wire up in this leaf-render harness).
    const freshTimestamp = new Date(Date.now() - 60 * 1000).toISOString();

    const nonShareableStatuses: ConnectorContribution['status'][] = [
      'testing',
      'submitted',
      'ci_pass',
      'ci_fail',
      'changes_requested',
      'approved',
      'rejected',
      'published',
    ];

    for (const status of nonShareableStatuses) {
      const card = mount(
        <ConnectorContributionSection
          contribution={makeContribution({ status, updatedAt: freshTimestamp })}
          isConnected
          loading={false}
          onShareWithCommunity={onShare}
        />,
      );
      mounted.push(card);
      expect(
        card.container.querySelector(SHARE_BUTTON_SELECTOR),
        `Button must not render for status="${status}"`,
      ).toBeNull();
    }
  });

  it('invokes onShareWithCommunity with contribution.connectorName on click (canonical name per C8)', () => {
    const onShare = vi.fn();
    const card = mount(
      <ConnectorContributionSection
        contribution={makeContribution({
          connectorName: 'humaans',
          status: 'ready_to_submit',
        })}
        isConnected
        loading={false}
        onShareWithCommunity={onShare}
      />,
    );
    mounted = [card];

    const button = card.container.querySelector(SHARE_BUTTON_SELECTOR);
    expect(button).not.toBeNull();

    act(() => {
      button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onShare).toHaveBeenCalledWith('humaans');
  });

  it('does NOT render anything when contribution is null', () => {
    const onShare = vi.fn();
    const card = mount(
      <ConnectorContributionSection
        contribution={null}
        isConnected
        loading={false}
        onShareWithCommunity={onShare}
      />,
    );
    mounted = [card];

    // The whole section short-circuits; nothing rendered.
    expect(card.container.querySelector(SHARE_BUTTON_SELECTOR)).toBeNull();
    expect(
      card.container.querySelector('[data-testid="connector-contribution-section"]'),
    ).toBeNull();
  });

  it('does NOT render when not connected even with a shareable contribution', () => {
    const onShare = vi.fn();
    const card = mount(
      <ConnectorContributionSection
        contribution={makeContribution({ status: 'ready_to_submit' })}
        isConnected={false}
        loading={false}
        onShareWithCommunity={onShare}
      />,
    );
    mounted = [card];

    expect(card.container.querySelector(SHARE_BUTTON_SELECTOR)).toBeNull();
  });

  it('does NOT render the contribution section in OSS builds', () => {
    mockUseIsOssBuild.mockReturnValue(true);
    const onShare = vi.fn();
    const card = mount(
      <ConnectorContributionSection
        contribution={makeContribution({ status: 'ready_to_submit' })}
        isConnected
        loading={false}
        onShareWithCommunity={onShare}
      />,
    );
    mounted = [card];

    expect(card.container.querySelector(SHARE_BUTTON_SELECTOR)).toBeNull();
    expect(
      card.container.querySelector('[data-testid="connector-contribution-section"]'),
    ).toBeNull();
  });
});
