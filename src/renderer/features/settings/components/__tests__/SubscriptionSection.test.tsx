// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionState } from '@shared/types';
import type { ManagedProviderInfo } from '@shared/types/managedProvider';
import { SubscriptionSection } from '../SubscriptionSection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

type UseSubscriptionStateResult = {
  subscription: SubscriptionState | null;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  isActive: boolean;
  isPastDueWithinGrace: boolean;
  refresh: () => Promise<void>;
};

const useSubscriptionStateMock = vi.fn<() => UseSubscriptionStateResult>();
const useManagedDefaultsMock = vi.fn<
  () => { managedProvider: ManagedProviderInfo | undefined; requestServerRefresh: () => Promise<void> }
>();
const requestServerRefreshMock = vi.fn(async () => {});

vi.mock('@renderer/hooks/useSubscriptionState', () => ({
  useSubscriptionState: () => useSubscriptionStateMock(),
}));

vi.mock('@renderer/hooks/useManagedDefaults', () => ({
  useManagedDefaults: () => useManagedDefaultsMock(),
}));

vi.mock('@renderer/hooks/useCreditMeterThresholdAnalytics', () => ({
  useCreditMeterThresholdAnalytics: vi.fn(),
}));

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

function makeSubscription(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    tier: 'dash',
    status: 'active',
    currentPeriodEnd: '2026-06-20T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    graceEndsAt: null,
    routingAvailable: true,
    ...overrides,
  };
}

describe('SubscriptionSection', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    useManagedDefaultsMock.mockReturnValue({
      managedProvider: undefined,
      requestServerRefresh: requestServerRefreshMock,
    });
    useSubscriptionStateMock.mockReturnValue({
      subscription: null,
      phase: 'ready',
      isActive: false,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });
    try {
      // Clear any stale H7 dismissal keys from prior tests.
      Object.keys(window.localStorage)
        .filter((k) => k.startsWith('subscription:resetCadenceOnboarding:dismissed:day-'))
        .forEach((k) => window.localStorage.removeItem(k));
    } catch {
      // localStorage may not be available in some environments.
    }
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('matches snapshot for current-plan cancellation hint when cancelAtPeriodEnd is true', () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-06-30T00:00:00.000Z',
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    expect(
      mounted.container.querySelector('[data-testid="settings-subscription-cancel-hint"]')
        ?.textContent,
    ).toContain("You'll keep full access until then.");
    expect(mounted.container.innerHTML).toMatchSnapshot();
  });

  it('matches snapshot for canceled banner copy and managed allowance restart hint', () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'canceled',
        cancelAtPeriodEnd: false,
      }),
      phase: 'ready',
      isActive: false,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded isMindstoneActive />);

    expect(mounted.container.textContent).toContain(
      "Your subscription has ended. Re-subscribe whenever you're ready — your settings are still here.",
    );
    expect(mounted.container.textContent).toContain(
      'Once you re-subscribe, your Mindstone allowance will pick back up automatically.',
    );
    expect(mounted.container.innerHTML).toMatchSnapshot();
  });

  it('renders renewal-vs-reset asymmetry hint on active subscription (not canceling)', () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: '2026-06-14T12:00:00.000Z',
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    const hint = mounted.container.querySelector(
      '[data-testid="settings-subscription-renewal-asymmetry"]',
    );
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe(
      'Your subscription renews on the 14th. Your usage allowance resets at the start of each calendar month.',
    );
  });

  it('suppresses renewal-vs-reset asymmetry hint when cancelAtPeriodEnd is true', () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-06-30T12:00:00.000Z',
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    expect(
      mounted.container.querySelector('[data-testid="settings-subscription-renewal-asymmetry"]'),
    ).toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="settings-subscription-cancel-hint"]'),
    ).not.toBeNull();
  });

  it('renders one-time cadence onboarding callout when subscription is active and not dismissed', () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: '2026-06-14T12:00:00.000Z',
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    const callout = mounted.container.querySelector(
      '[data-testid="settings-subscription-cadence-onboarding"]',
    );
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toContain('Heads up');
    expect(callout?.textContent).toContain('1st of each calendar month');
  });

  it('hides cadence onboarding callout when anchor-day dismissal key is set', () => {
    window.localStorage.setItem(
      'subscription:resetCadenceOnboarding:dismissed:day-14',
      '1',
    );

    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: '2026-06-14T12:00:00.000Z',
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    expect(
      mounted.container.querySelector('[data-testid="settings-subscription-cadence-onboarding"]'),
    ).toBeNull();
  });

  it('dismiss button hides callout and writes anchor-day key to localStorage', () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: '2026-06-14T12:00:00.000Z',
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    const dismissBtn = mounted.container.querySelector(
      '[data-testid="settings-subscription-cadence-onboarding-dismiss"]',
    ) as HTMLButtonElement | null;
    expect(dismissBtn).not.toBeNull();

    act(() => {
      dismissBtn!.click();
    });

    expect(
      mounted.container.querySelector('[data-testid="settings-subscription-cadence-onboarding"]'),
    ).toBeNull();
    expect(
      window.localStorage.getItem('subscription:resetCadenceOnboarding:dismissed:day-14'),
    ).toBe('1');
  });

  it('clamps anchor-day > 28 to 28 so short-month rollovers do not re-show the callout', () => {
    // Stripe's currentPeriodEnd flips between Jan 31 → Feb 28 → Mar 31 for
    // end-of-month billers. The dismissal key must stay stable across that
    // flip so the user doesn't see the callout twice.
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: '2026-01-31T12:00:00.000Z',
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    const dismissBtn = mounted.container.querySelector(
      '[data-testid="settings-subscription-cadence-onboarding-dismiss"]',
    ) as HTMLButtonElement | null;
    expect(dismissBtn).not.toBeNull();

    act(() => {
      dismissBtn!.click();
    });

    // Day 31 must clamp to 28 — single stable key for end-of-month billers.
    expect(
      window.localStorage.getItem('subscription:resetCadenceOnboarding:dismissed:day-28'),
    ).toBe('1');

    // Day 31 raw key must NOT be written.
    expect(
      window.localStorage.getItem('subscription:resetCadenceOnboarding:dismissed:day-31'),
    ).toBeNull();
  });

  it('suppresses cadence onboarding callout when cancelAtPeriodEnd is true', () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-06-30T12:00:00.000Z',
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    expect(
      mounted.container.querySelector('[data-testid="settings-subscription-cadence-onboarding"]'),
    ).toBeNull();
  });

  it('renders allowance-refresh cadence on Dash and Rogue cards (subscribe screen)', () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: null,
      phase: 'ready',
      isActive: false,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    const dashCadence = mounted.container.querySelector(
      '[data-testid="settings-subscription-dash-cadence"]',
    );
    const rogueCadence = mounted.container.querySelector(
      '[data-testid="settings-subscription-rogue-cadence"]',
    );

    expect(dashCadence?.textContent).toBe(
      'Your allowance refreshes on the 1st of each month.',
    );
    expect(rogueCadence?.textContent).toBe(
      'Your allowance refreshes on the 1st of each month.',
    );
  });

  it('renders allowance unavailable when managed creditUsedMonthly is undefined', () => {
    useManagedDefaultsMock.mockReturnValue({
      managedProvider: {
        provider: 'openrouter',
        keyHash: 'k-1',
        allowedModels: ['anthropic/claude-sonnet'],
        creditLimitMonthly: 20000,
        creditUsedMonthly: undefined,
      },
      requestServerRefresh: requestServerRefreshMock,
    });
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: false,
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    expect(
      mounted.container.querySelector('[data-testid="settings-subscription-allowance-unavailable"]'),
    ).not.toBeNull();
    expect(mounted.container.textContent).toContain('Allowance data unavailable');
    expect(mounted.container.textContent).not.toContain('0% used');
  });

  it('renders <1% used for genuine sub-1% positive spend instead of rounding to 0%', () => {
    useManagedDefaultsMock.mockReturnValue({
      managedProvider: {
        provider: 'openrouter',
        keyHash: 'k-1',
        allowedModels: ['anthropic/claude-sonnet'],
        creditLimitMonthly: 300,
        creditUsedMonthly: 0.408991468,
      },
      requestServerRefresh: requestServerRefreshMock,
    });
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: false,
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    const amount = mounted.container.querySelector(
      '[data-testid="settings-subscription-allowance-amount"]',
    );
    expect(amount?.textContent).toBe('<1% used');
    expect(mounted.container.textContent).not.toContain('0% used');
  });

  it('still renders 0% used when there is no spend at all', () => {
    useManagedDefaultsMock.mockReturnValue({
      managedProvider: {
        provider: 'openrouter',
        keyHash: 'k-1',
        allowedModels: ['anthropic/claude-sonnet'],
        creditLimitMonthly: 300,
        creditUsedMonthly: 0,
      },
      requestServerRefresh: requestServerRefreshMock,
    });
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: false,
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    const amount = mounted.container.querySelector(
      '[data-testid="settings-subscription-allowance-amount"]',
    );
    expect(amount?.textContent).toBe('0% used');
  });

  it('requests a server config refresh once when mounted with an active subscription', () => {
    useSubscriptionStateMock.mockReturnValue({
      subscription: makeSubscription({
        status: 'active',
        cancelAtPeriodEnd: false,
      }),
      phase: 'ready',
      isActive: true,
      isPastDueWithinGrace: false,
      refresh: vi.fn(async () => {}),
    });

    mounted = mount(<SubscriptionSection embedded />);

    expect(requestServerRefreshMock).toHaveBeenCalledTimes(1);
  });
});
