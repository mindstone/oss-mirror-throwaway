import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Info, RefreshCw, X } from 'lucide-react';
import { Button, IconButton, Tooltip } from '@renderer/components/ui';
import { useSubscriptionState } from '@renderer/hooks/useSubscriptionState';
import { useManagedDefaults } from '@renderer/hooks/useManagedDefaults';
import { useCreditMeterThresholdAnalytics } from '@renderer/hooks/useCreditMeterThresholdAnalytics';
import { tracking } from '@renderer/src/tracking';
import type { SubscriptionCheckoutOrigin } from '@shared/ipc/channels/subscription';
import type { ManagedProviderInfo } from '@shared/types/managedProvider';
import type { SubscriptionState, SubscriptionTier } from '@shared/types';
import {
  formatOrdinalDayOfMonth,
  getBillingAnchorDay,
  isAllowanceAvailable,
  meterStateForRatio,
} from '@renderer/features/settings/utils/allowanceMeter';
import styles from './SettingsSurface.module.css';
import { SettingSection } from './SettingSection';

const TIER_LABEL: Record<SubscriptionTier, string> = {
  dash: 'Dash',
  rogue: 'Rogue',
};

const TIER_PRICE: Record<SubscriptionTier, string> = {
  dash: '$200/mo',
  rogue: '$500/mo',
};

// Stage H8 — tier copy alignment.
// Dash and Rogue share the same monthly allowance (Decisions Record #8); the
// difference is model quality, not usage capacity. Both blurbs lead with that
// invariant so users don't read "Rogue" as "more turns".
const TIER_BLURB: Record<SubscriptionTier, string> = {
  dash:
    'Same monthly allowance as Rogue, with capable models for everyday work',
  rogue:
    'Same monthly allowance as Dash, with frontier-class models for work that demands the best',
};

// Stage H7 — one-time onboarding callout for billing-vs-reset asymmetry.
const CADENCE_ONBOARDING_KEY_PREFIX = 'subscription:resetCadenceOnboarding:dismissed:day-';

/**
 * Clamp the raw day-of-month to [1, 28] before keying H7 dismissal storage.
 *
 * Stripe sets `current_period_end` to the calendar-anchored renewal day —
 * for users whose anchor is the 29th/30th/31st, that day flips on short
 * months (e.g. Jan 31 → Feb 28 → Mar 31). Keying off the raw renewal day
 * would re-show the callout every short-month rollover. Clamping to 28
 * picks a stable bucket for all "end-of-month" billers without affecting
 * users on days 1-28.
 */
function cadenceOnboardingKey(anchorDay: number): string {
  const clamped = Math.min(Math.max(anchorDay, 1), 28);
  return `${CADENCE_ONBOARDING_KEY_PREFIX}${clamped}`;
}

function formatLongDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleDateString('en-GB', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function daysRemaining(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return 0;
  return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

type AllowanceMeterProps = {
  managedProvider: ManagedProviderInfo | undefined;
};

/**
 * Stage H1 — `<used> of <allowed>` spend gauge for managed-tier subscribers.
 *
 * When the server payload has not yet shipped real values (zero or missing
 * `creditLimitMonthly`), we render an "Allowance data unavailable" line rather
 * than misleading "$0.00 of $0.00 used" — per the plan's verification clause.
 */
function AllowanceMeter({ managedProvider }: AllowanceMeterProps) {
  if (!managedProvider) return null;

  const allowance = {
    creditLimitMonthly: managedProvider.creditLimitMonthly,
    creditUsedMonthly: managedProvider.creditUsedMonthly,
  };
  if (!isAllowanceAvailable(allowance)) {
    return (
      <p
        className={styles.allowanceMeterUnavailable}
        data-testid="settings-subscription-allowance-unavailable"
      >
        Allowance data unavailable
      </p>
    );
  }

  const { creditLimitMonthly, creditUsedMonthly } = allowance;
  const { resetsAt } = managedProvider;
  const ratio = Math.min(Math.max(creditUsedMonthly / creditLimitMonthly, 0), 1);
  const pct = Math.round(ratio * 100);
  // Render `<1% used` for genuine sub-1% spend so a small real charge is
  // distinguishable from "no usage tracked yet". The progress bar geometry
  // (fill width, aria-valuenow) still uses the integer pct.
  const pctLabel = pct === 0 && ratio > 0 ? '<1' : String(pct);
  const meterState = meterStateForRatio(ratio);
  const fillClassName =
    meterState === 'critical'
      ? styles.allowanceMeterFillCritical
      : meterState === 'warning'
        ? styles.allowanceMeterFillWarning
        : styles.allowanceMeterFillNeutral;

  const resetsDate = formatLongDate(resetsAt);

  return (
    <div className={styles.allowanceMeter} data-testid="settings-subscription-allowance-meter">
      <div className={styles.allowanceMeterHeader}>
        <span className={styles.allowanceMeterLabel}>Monthly allowance</span>
        <span
          className={styles.allowanceMeterValue}
          data-testid="settings-subscription-allowance-amount"
        >
          {pctLabel}% used
        </span>
      </div>
      <div
        className={styles.allowanceMeterBar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${pctLabel}% of monthly Mindstone allowance used`}
        data-meter-state={meterState}
        data-testid="settings-subscription-allowance-bar"
      >
        <div
          className={`${styles.allowanceMeterFill} ${fillClassName}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {resetsDate && (
        /* Stage H6 — tooltip explains why the reset date isn't tied to the renewal day. */
        <Tooltip
          content="Your allowance resets at the start of each calendar month, regardless of when your subscription renews."
          placement="top"
        >
          <p
            className={styles.allowanceMeterFooter}
            data-testid="settings-subscription-allowance-resets"
            tabIndex={0}
          >
            Resets on {resetsDate}
          </p>
        </Tooltip>
      )}
    </div>
  );
}

type SubscriptionTierCardProps = {
  tier: SubscriptionTier;
  isCurrentTier: boolean;
  busyTier: SubscriptionTier | null;
  onSubscribe: (tier: SubscriptionTier) => void;
};

function SubscriptionTierCard({ tier, isCurrentTier, busyTier, onSubscribe }: SubscriptionTierCardProps) {
  const isLoading = busyTier === tier;
  const disabled = busyTier !== null;

  return (
    <div
      className={`${styles.subscriptionCard} ${isCurrentTier ? styles.subscriptionCardSelected : ''}`}
      data-testid={`settings-subscription-${tier}-card`}
    >
      <div className={styles.subscriptionCardHeader}>
        <h4 className={styles.subscriptionCardTitle}>{TIER_LABEL[tier]}</h4>
        <span className={styles.subscriptionPriceBadge}>{TIER_PRICE[tier]}</span>
      </div>
      <p className={styles.subscriptionCardDescription}>{TIER_BLURB[tier]}</p>
      {/* Stage H5 — reset-cadence visibility on tier cards (unsubscribed view). */}
      <p
        className={styles.subscriptionCardCadence}
        data-testid={`settings-subscription-${tier}-cadence`}
      >
        Your allowance refreshes on the 1st of each month.
      </p>
      <div className={styles.subscriptionCardFooter}>
        {isCurrentTier ? (
          <span className={styles.subscriptionActiveBadge}>
            <Check size={12} aria-hidden />
            Subscription active
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSubscribe(tier)}
            disabled={disabled}
            data-testid={`settings-subscription-${tier}-button`}
            className={styles.providerCardConnectBtn}
          >
            {isLoading && <Loader2 size={12} className={styles.spinnerIcon} />}
            {isLoading ? 'Opening checkout...' : 'Subscribe'}
          </Button>
        )}
      </div>
    </div>
  );
}

type CadenceOnboardingCalloutProps = {
  anchorDay: number;
};

/**
 * Stage H7 — one-time first-run callout that surfaces the calendar-month
 * reset rule so the first reset isn't a surprise. Dismissal is anchored to
 * the subscription's billing day-of-month so it doesn't re-fire across normal
 * renewals, but does re-fire if the user re-subscribes on a different day.
 *
 * Always-visible H6 asymmetry hint remains beneath it — this callout is
 * additive, not a replacement.
 */
function CadenceOnboardingCallout({ anchorDay }: CadenceOnboardingCalloutProps) {
  const storageKey = cadenceOnboardingKey(anchorDay);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });

  // Re-evaluate on anchorDay change (e.g., user re-subscribes on a different
  // day) so the callout re-appears for the new anchor.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      setDismissed(window.localStorage.getItem(storageKey) === '1');
    } catch {
      setDismissed(false);
    }
  }, [storageKey]);

  const handleDismiss = useCallback(() => {
    try {
      window.localStorage.setItem(storageKey, '1');
    } catch {
      // localStorage may be unavailable; dismiss for this session anyway.
    }
    setDismissed(true);
  }, [storageKey]);

  if (dismissed) return null;

  return (
    <div
      className={styles.cadenceOnboardingCallout}
      role="status"
      data-testid="settings-subscription-cadence-onboarding"
    >
      <Info size={14} aria-hidden className={styles.cadenceOnboardingIcon} />
      <p className={styles.cadenceOnboardingBody}>
        Heads up: your monthly usage allowance resets on the 1st of each calendar month — separately from your subscription renewal day. So your first reset may land sooner than your next bill.
      </p>
      <IconButton
        size="xs"
        variant="ghost"
        className={styles.cadenceOnboardingDismiss}
        onClick={handleDismiss}
        aria-label="Dismiss"
        data-testid="settings-subscription-cadence-onboarding-dismiss"
      >
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  );
}

type CurrentPlanProps = {
  subscription: SubscriptionState;
  onManage: () => void;
  onUpgrade: () => void;
  manageLoading: boolean;
  upgradeLoading: boolean;
  isMindstoneActive?: boolean;
  onSelectMindstone?: () => void;
  managedProvider?: ManagedProviderInfo;
};

function CurrentPlanCard({
  subscription,
  onManage,
  onUpgrade,
  manageLoading,
  upgradeLoading,
  isMindstoneActive,
  onSelectMindstone,
  managedProvider,
}: CurrentPlanProps) {
  const tierLabel = TIER_LABEL[subscription.tier];
  const renewalDate = formatLongDate(subscription.currentPeriodEnd);
  const renewalOrdinal = formatOrdinalDayOfMonth(subscription.currentPeriodEnd);
  const billingAnchorDay = getBillingAnchorDay(subscription.currentPeriodEnd);
  const renewalLine = subscription.cancelAtPeriodEnd
    ? renewalDate
      ? `Cancels on ${renewalDate}`
      : 'Cancels at the end of the current period'
    : renewalDate
      ? `Renews on ${renewalDate}`
      : 'Renews automatically each month';

  return (
    <div className={styles.subscriptionCurrentPlan} data-testid="settings-subscription-current-plan">
      <div className={styles.subscriptionCurrentPlanHeader}>
        <h4 className={styles.subscriptionCurrentPlanTitle}>{tierLabel}</h4>
        {isMindstoneActive ? (
          <span className={styles.subscriptionActiveBadge}>
            <Check size={12} aria-hidden />
            In use
          </span>
        ) : (
          <span className={styles.subscriptionActiveBadge}>
            Subscription active
          </span>
        )}
      </div>
      <p className={styles.subscriptionCurrentPlanMeta}>{renewalLine}</p>
      {/* Stage H6 — renewal-vs-reset asymmetry. Calendar-month allowance resets ≠ Stripe renewal day, by design. Suppressed when canceling. */}
      {!subscription.cancelAtPeriodEnd && renewalOrdinal && (
        <p
          className={styles.subscriptionRenewalAsymmetryHint}
          data-testid="settings-subscription-renewal-asymmetry"
        >
          Your subscription renews on the {renewalOrdinal}. Your usage allowance resets at the start of each calendar month.
        </p>
      )}
      {subscription.cancelAtPeriodEnd && (
        <p
          className={styles.subscriptionCurrentPlanMeta}
          data-testid="settings-subscription-cancel-hint"
        >
          You&apos;ll keep full access until then.
        </p>
      )}
      {!subscription.routingAvailable && (
        <p className={styles.subscriptionRoutingHint}>
          Your AI is being set up — we&apos;ll switch you over automatically.
        </p>
      )}
      {!subscription.cancelAtPeriodEnd && billingAnchorDay !== null && (
        <CadenceOnboardingCallout anchorDay={billingAnchorDay} />
      )}
      <AllowanceMeter managedProvider={managedProvider} />
      <div className={styles.subscriptionActions}>
        {!isMindstoneActive && onSelectMindstone && subscription.routingAvailable && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onSelectMindstone}
            data-testid="settings-subscription-use-this-button"
          >
            Use this
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onManage}
          disabled={manageLoading}
          data-testid="settings-subscription-manage-button"
        >
          {manageLoading && <Loader2 size={12} className={styles.spinnerIcon} />}
          {manageLoading ? 'Opening...' : 'Manage subscription'}
        </Button>
        {subscription.tier === 'dash' && !subscription.cancelAtPeriodEnd && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onUpgrade}
            disabled={upgradeLoading}
            data-testid="settings-subscription-upgrade-button"
          >
            {upgradeLoading && <Loader2 size={12} className={styles.spinnerIcon} />}
            {upgradeLoading ? 'Opening checkout...' : 'Upgrade to Rogue'}
          </Button>
        )}
      </div>
    </div>
  );
}

type CanceledStateProps = {
  busyTier: SubscriptionTier | null;
  onSubscribe: (tier: SubscriptionTier) => void;
  isMindstoneActive: boolean;
};

function CanceledState({ busyTier, onSubscribe, isMindstoneActive }: CanceledStateProps) {
  return (
    <div
      className={`${styles.subscriptionBanner} ${styles.subscriptionBannerInfo}`}
      data-testid="settings-subscription-canceled-banner"
    >
      <Info size={16} aria-hidden />
      <div className={styles.subscriptionBannerBody}>
        <p>Your subscription has ended. Re-subscribe whenever you&apos;re ready — your settings are still here.</p>
        {isMindstoneActive && (
          <p className={styles.subscriptionRoutingHint}>
            Once you re-subscribe, your Mindstone allowance will pick back up automatically.
          </p>
        )}
        <div className={styles.subscriptionBannerActions}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSubscribe('dash')}
            disabled={busyTier !== null}
            data-testid="settings-subscription-resubscribe-dash"
          >
            {busyTier === 'dash' && <Loader2 size={12} className={styles.spinnerIcon} />}
            Re-subscribe (Dash)
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSubscribe('rogue')}
            disabled={busyTier !== null}
            data-testid="settings-subscription-resubscribe-rogue"
          >
            {busyTier === 'rogue' && <Loader2 size={12} className={styles.spinnerIcon} />}
            Re-subscribe (Rogue)
          </Button>
        </div>
      </div>
    </div>
  );
}

type PastDueBannerProps = {
  subscription: SubscriptionState;
  onManage: () => void;
  manageLoading: boolean;
};

function PastDueBanner({ subscription, onManage, manageLoading }: PastDueBannerProps) {
  const days = daysRemaining(subscription.graceEndsAt);
  const detail =
    days !== null && days > 0
      ? `We'll keep retrying for ${days} more day${days === 1 ? '' : 's'} before your access pauses.`
      : "We'll keep trying to charge your card. Update your payment method to avoid interruption.";

  return (
    <div
      className={`${styles.subscriptionBanner} ${styles.subscriptionBannerWarning}`}
      data-testid="settings-subscription-past-due-banner"
    >
      <AlertTriangle size={16} aria-hidden />
      <div className={styles.subscriptionBannerBody}>
        <p>
          <strong>Payment issue.</strong> {detail}
        </p>
        <div className={styles.subscriptionBannerActions}>
          <Button
            variant="outline"
            size="sm"
            onClick={onManage}
            disabled={manageLoading}
            data-testid="settings-subscription-past-due-portal-button"
          >
            {manageLoading && <Loader2 size={12} className={styles.spinnerIcon} />}
            Update payment method
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Subscription management content — renders managed-tier UI.
 *
 * When `embedded` is true, renders just the content without a wrapping
 * `SettingSection` — used inside the unified AI provider section in AgentsTab.
 *
 * Behavior:
 * - No subscription: Shows tier cards with Subscribe buttons.
 * - Active: Shows current plan + Manage / Upgrade actions.
 * - Past due: Shows a payment warning banner with a portal link.
 * - Canceled / inactive (post-active): Shows a re-subscribe banner.
 */
type SubscriptionSectionProps = {
  embedded?: boolean;
  /** When embedded, whether Mindstone is the active AI provider. */
  isMindstoneActive?: boolean;
  /** When embedded, callback to switch active provider to Mindstone. */
  onSelectMindstone?: () => void;
};

export function SubscriptionSection({ embedded = false, isMindstoneActive = false, onSelectMindstone }: SubscriptionSectionProps) {
  const { subscription, phase, isActive, isPastDueWithinGrace, refresh } = useSubscriptionState();
  const { managedProvider, requestServerRefresh } = useManagedDefaults();
  useCreditMeterThresholdAnalytics({ managedProvider, subscription });
  const [busyTier, setBusyTier] = useState<SubscriptionTier | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (subscription?.status !== 'active') return;
    void requestServerRefresh();
  }, [requestServerRefresh, subscription?.status]);

  const handleSubscribe = useCallback(async (tier: SubscriptionTier, origin: SubscriptionCheckoutOrigin) => {
    setError(null);
    setBusyTier(tier);
    try {
      await window.subscriptionApi.createCheckout({ tier, origin });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open checkout. Please try again.");
    } finally {
      setBusyTier(null);
    }
  }, []);

  const handleManage = useCallback(async (origin: 'settings' | 'resubscribe') => {
    setError(null);
    setPortalLoading(true);
    try {
      tracking.subscription.manageClicked({ origin });
      await window.subscriptionApi.createPortal();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open the management portal. Please try again.");
    } finally {
      setPortalLoading(false);
    }
  }, []);

  const handleSubscribeClick = useCallback((tier: SubscriptionTier) => {
    tracking.subscription.subscribeClicked({ tier, origin: 'settings' });
    void handleSubscribe(tier, 'settings');
  }, [handleSubscribe]);

  const handleResubscribeClick = useCallback((tier: SubscriptionTier) => {
    tracking.subscription.resubscribeClicked({ tier, origin: 'resubscribe' });
    void handleSubscribe(tier, 'resubscribe');
  }, [handleSubscribe]);

  const handleUpgradeClick = useCallback(() => {
    tracking.subscription.upgradeToRogueClicked({ origin: 'settings' });
    void handleSubscribe('rogue', 'settings');
  }, [handleSubscribe]);

  const handleUseThisClick = useCallback(() => {
    tracking.subscription.useThisClicked({ target: 'mindstone' });
    onSelectMindstone?.();
  }, [onSelectMindstone]);

  if (phase === 'loading' || phase === 'idle') {
    return null;
  }

  const status = subscription?.status;
  const showCurrentPlan = subscription !== null && (isActive || isPastDueWithinGrace);
  const showCanceled = subscription !== null && (status === 'canceled' || status === 'inactive');
  const showIncomplete = subscription !== null && status === 'incomplete';
  const showSubscribeCards = subscription === null && phase !== 'error';

  const content = (
    <>
      {phase === 'error' && (
        <div
          className={`${styles.subscriptionBanner} ${styles.subscriptionBannerWarning}`}
          data-testid="settings-subscription-error-banner"
        >
          <AlertTriangle size={16} aria-hidden />
          <div className={styles.subscriptionBannerBody}>
            <p>Couldn&apos;t load your subscription status. Check your connection and try again.</p>
            <div className={styles.subscriptionBannerActions}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
                data-testid="settings-subscription-retry-button"
              >
                <RefreshCw size={12} aria-hidden />
                Retry
              </Button>
            </div>
          </div>
        </div>
      )}

      {status === 'past_due' && (
        <PastDueBanner
          subscription={subscription as SubscriptionState}
          onManage={() => void handleManage('settings')}
          manageLoading={portalLoading}
        />
      )}

      {showCurrentPlan && subscription !== null && (
        <CurrentPlanCard
          subscription={subscription}
          onManage={() => void handleManage('settings')}
          onUpgrade={handleUpgradeClick}
          manageLoading={portalLoading}
          upgradeLoading={busyTier === 'rogue'}
          isMindstoneActive={isMindstoneActive}
          onSelectMindstone={onSelectMindstone ? handleUseThisClick : undefined}
          managedProvider={managedProvider}
        />
      )}

      {showCanceled && (
        <CanceledState
          busyTier={busyTier}
          onSubscribe={handleResubscribeClick}
          isMindstoneActive={isMindstoneActive}
        />
      )}

      {showIncomplete && (
        <div
          className={`${styles.subscriptionBanner} ${styles.subscriptionBannerInfo}`}
          data-testid="settings-subscription-incomplete-banner"
        >
          <Loader2 size={16} className={styles.spinnerIcon} aria-hidden />
          <div className={styles.subscriptionBannerBody}>
            <p>Your checkout is in progress. Once payment completes, your subscription will activate automatically.</p>
          </div>
        </div>
      )}

      {showSubscribeCards && (
        <div className={styles.subscriptionGrid}>
          <SubscriptionTierCard
            tier="dash"
            isCurrentTier={false}
            busyTier={busyTier}
            onSubscribe={handleSubscribeClick}
          />
          <SubscriptionTierCard
            tier="rogue"
            isCurrentTier={false}
            busyTier={busyTier}
            onSubscribe={handleSubscribeClick}
          />
        </div>
      )}

      {error && (
        <p className={styles.errorMessage} style={{ margin: 0, fontSize: '0.72rem' }}>
          {error}
        </p>
      )}
    </>
  );

  if (embedded) {
    return (
      <div data-section="subscription" data-testid="settings-subscription-section">
        {content}
      </div>
    );
  }

  return (
    <SettingSection
      title="Mindstone subscription"
      description="A simpler way to power Rebel — we cover the AI bill. Powered by OpenRouter."
      data-section="subscription"
      data-testid="settings-subscription-section"
    >
      {content}
    </SettingSection>
  );
}
