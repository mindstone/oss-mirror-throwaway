import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DecisionCardGroup,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Notice,
  Spinner,
  Tooltip,
} from '@renderer/components/ui';
import { HelpCircle, Loader2, Rocket, ServerCog, Zap } from 'lucide-react';
import {
  FLY_VM_TIER_CATALOG,
  getDisplayLabels,
  getTierById,
  summarizeTierMatch,
  type VmTier,
} from '@core/services/cloud/vmTierCatalog';

interface VmTierSelectorProps {
  /** Currently configured tier id from settings (may be undefined for legacy users). */
  cachedTierId: string | undefined;
  /** Disable interactive selection (e.g. when other cloud ops are busy). */
  disabled?: boolean;
  /**
   * Optional callback to notify the parent that a tier change succeeded so it
   * can refresh any cached settings views (e.g. CloudTab's draftSettings cache
   * of `cloudInstance.vmTierId`). Without this, parent UI relying on the cache
   * could remain stale until full settings reload.
   */
  onTierChanged?: (tierId: VmTier['id']) => void;
  /** Called when the user starts a new tier-change attempt. */
  onTierChangeStart?: () => void;
  /** Called when Fly applied the tier write but post-apply health could not be verified. */
  onTierChangeVerificationFailed?: () => void;
  /** True when the parent already knows the shared Fly-token Notice is visible. */
  flyTokenMissing?: boolean;
  /**
   * Tier to visually highlight as the Stage C suggestion. The card is accented
   * and labelled "Suggested" — selecting it opens the existing confirmation
   * dialog (no auto-open).
   */
  suggestedTierId?: VmTier['id'];
  /** Human-readable reason copy from Stage C (e.g. "Cloud is running tight"). */
  suggestionReason?: string;
  /** Optional quick path to open the existing storage-resize flow. */
  onAddStorageInstead?: () => void;
}

const TIER_ICONS: Record<VmTier['id'], typeof Zap> = {
  standard: Zap,
  faster: Rocket,
  'heavy-work': ServerCog,
};

const FALLBACK_CHANGE_ERROR = 'Couldn\'t change the tier. Your cloud is still running on the previous tier.';
const APPLIED_NOT_HEALTHY_MESSAGE = 'Tier change applied but we couldn\'t confirm your cloud is healthy. Refresh in a moment.';
const PERSISTENCE_WARNING = 'Your cloud is on the new tier, but we couldn\'t save your preference. Try refreshing.';
const SPEED_TIER_HELPER = 'Speed tiers do not add storage. Storage is managed below.';
const SPEED_TIER_COUNT = FLY_VM_TIER_CATALOG.length;
const TOKEN_MISSING_FRAGMENT = 'Fly API token not found';

type TierReadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'cloud_unreachable'; error: string }
  | { kind: 'fly_token_missing' }
  | { kind: 'unknown_fly_size' };

type CurrentTierMatch = {
  state: 'exact' | 'approx' | 'none';
  exceeds: Array<'cpus' | 'memoryMb'>;
  raw?: { cpuKind?: string; cpus?: number; memoryMb?: number };
};

function formatMonthlyCost(usd: number): string {
  return `~$${usd.toFixed(2)}/month`;
}

function formatCostDelta(currentUsd: number, nextUsd: number): { text: string; cheaper: boolean } {
  const delta = nextUsd - currentUsd;
  if (delta === 0) return { text: 'No change in cost', cheaper: false };
  const sign = delta > 0 ? '+' : '-';
  return { text: `${sign}$${Math.abs(delta).toFixed(2)}/month`, cheaper: delta < 0 };
}

function formatSpeed(tier: VmTier): string {
  return `Speed: ${getDisplayLabels(tier).speedRank}/${SPEED_TIER_COUNT}`;
}

function formatMemoryGb(memoryMb: number): string {
  const gb = memoryMb / 1024;
  if (Number.isInteger(gb)) {
    return String(gb);
  }
  return gb.toFixed(1).replace(/\.0$/, '');
}

function TierSupportDetails({ tier }: { tier: VmTier }) {
  return (
    <Tooltip
      placement="bottom"
      delayShow={0}
      content={(
        <div style={{ display: 'grid', gap: 2 }}>
          <span>cpu_kind: {tier.cpuKind}</span>
          <span>cpus: {tier.cpus}</span>
          <span>memory_mb: {tier.memoryMb}</span>
        </div>
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-decision-card-interactive
        data-testid={`vm-tier-support-${tier.id}`}
        style={{
          alignSelf: 'flex-start',
          minHeight: 0,
          height: 'auto',
          padding: 0,
          color: 'var(--color-text-secondary)',
          fontSize: '0.78rem',
        }}
      >
        <HelpCircle size={12} />
        What&apos;s this?
      </Button>
    </Tooltip>
  );
}

export function VmTierSelector({
  cachedTierId,
  disabled = false,
  onTierChanged,
  onTierChangeStart,
  onTierChangeVerificationFailed,
  flyTokenMissing = false,
  suggestedTierId,
  suggestionReason,
  onAddStorageInstead,
}: VmTierSelectorProps) {
  const [currentTierId, setCurrentTierId] = useState<string | undefined>(cachedTierId);
  const [pendingTierId, setPendingTierId] = useState<VmTier['id'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [tierReadState, setTierReadState] = useState<TierReadState>({ kind: 'loading' });
  const [currentMatch, setCurrentMatch] = useState<CurrentTierMatch>({ state: 'none', exceeds: [] });

  const currentTier = useMemo(
    () => (currentTierId ? getTierById(currentTierId) : undefined),
    [currentTierId],
  );
  const pendingTier = useMemo(
    () => (pendingTierId ? getTierById(pendingTierId) ?? null : null),
    [pendingTierId],
  );
  const isUnknownFlySize = tierReadState.kind === 'unknown_fly_size';
  const hideCardSelection = isUnknownFlySize || currentMatch.state === 'none';
  const selectedTierId: VmTier['id'] | '' = hideCardSelection ? '' : (currentTier?.id ?? '');
  const matchedCurrentTierId = currentMatch.state === 'none' ? undefined : currentTier?.id;
  const lastKnownTierLabel = currentTier?.label ?? 'Unknown';
  const pickerUnavailable =
    disabled
    || tierReadState.kind === 'loading'
    || tierReadState.kind === 'cloud_unreachable'
    || tierReadState.kind === 'fly_token_missing'
    || flyTokenMissing;
  const pickerDisabled = pickerUnavailable || busy;

  const refreshCurrentTier = useCallback(async (fallbackTierId?: VmTier['id']) => {
    setTierReadState({ kind: 'loading' });
    try {
      const result = await window.cloudApi.getVmTier();
      if (result.success && result.tier?.id) {
        const matchedTier = getTierById(result.tier.id);
        if (!matchedTier) {
          setTierReadState({ kind: 'cloud_unreachable', error: 'Cloud returned an unknown tier id.' });
          return;
        }
        setCurrentTierId(matchedTier.id);
        const raw = result.raw ?? {
          cpuKind: matchedTier.cpuKind,
          cpus: matchedTier.cpus,
          memoryMb: matchedTier.memoryMb,
        };
        setCurrentMatch({ ...summarizeTierMatch(matchedTier, raw), raw });
        setTierReadState({ kind: 'ready' });
        return;
      }

      if (result.success && result.raw) {
        setCurrentTierId(undefined);
        setCurrentMatch({ state: 'none', exceeds: [], raw: result.raw });
        setTierReadState({ kind: 'unknown_fly_size' });
        return;
      }

      if (result.error?.includes(TOKEN_MISSING_FRAGMENT)) {
        setTierReadState({ kind: 'fly_token_missing' });
        return;
      }

      setTierReadState({ kind: 'cloud_unreachable', error: result.error ?? 'Cloud tier lookup failed.' });
      return;
    } catch (err) {
      setTierReadState({
        kind: 'cloud_unreachable',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (fallbackTierId) {
      setCurrentTierId(fallbackTierId);
      const fallbackTier = getTierById(fallbackTierId);
      if (fallbackTier) {
        setCurrentMatch({
          state: 'exact',
          exceeds: [],
          raw: {
            cpuKind: fallbackTier.cpuKind,
            cpus: fallbackTier.cpus,
            memoryMb: fallbackTier.memoryMb,
          },
        });
      }
    }
  }, []);

  useEffect(() => {
    setCurrentTierId(cachedTierId);
  }, [cachedTierId]);

  useEffect(() => {
    void refreshCurrentTier();
  }, [refreshCurrentTier]);

  useEffect(() => {
    if (!pickerUnavailable) return;
    setPendingTierId(null);
    setError(null);
  }, [pickerUnavailable]);

  const handleValueChange = useCallback((id: VmTier['id']) => {
    if (pickerDisabled) return;
    if (matchedCurrentTierId && id === matchedCurrentTierId) return;
    setError(null);
    setPersistenceWarning(null);
    onTierChangeStart?.();
    setPendingTierId(id);
  }, [matchedCurrentTierId, onTierChangeStart, pickerDisabled]);

  const handleCloseDialog = useCallback(() => {
    if (busy || disabled) return;
    setPendingTierId(null);
    setError(null);
  }, [busy, disabled]);

  const handleConfirm = useCallback(async () => {
    if (!pendingTier || busy) return;
    setBusy(true);
    setError(null);

    try {
      const result = await window.cloudApi.changeVmTier({ tierId: pendingTier.id });
      if (result.success) {
        setCurrentTierId(pendingTier.id);
        await refreshCurrentTier(pendingTier.id);
        setPendingTierId(null);
        setPersistenceWarning(result.settingsPersisted === false ? PERSISTENCE_WARNING : null);
        onTierChanged?.(pendingTier.id);
        return;
      }

      if (result.applied === true && result.healthVerified !== true) {
        setError(APPLIED_NOT_HEALTHY_MESSAGE);
        setPendingTierId(null);
        onTierChangeVerificationFailed?.();
        return;
      }

      setError(result.error ?? FALLBACK_CHANGE_ERROR);
    } catch {
      // Surface a friendly fallback rather than raw transport/IPC errors.
      setError(FALLBACK_CHANGE_ERROR);
    } finally {
      setBusy(false);
    }
  }, [busy, onTierChangeVerificationFailed, onTierChanged, pendingTier, refreshCurrentTier]);

  const options = useMemo(
    () =>
      FLY_VM_TIER_CATALOG.map((tier) => {
        const isCurrent = !hideCardSelection && tier.id === currentTier?.id;
        const isSuggested = tier.id === suggestedTierId && !isCurrent;
        const showApproxCapacityNote = isCurrent
          && currentMatch.state === 'approx'
          && currentMatch.exceeds.includes('memoryMb')
          && typeof currentMatch.raw?.memoryMb === 'number';
        const currentRawMemoryMb = currentMatch.raw?.memoryMb;
        const approxCapacityNote = showApproxCapacityNote && typeof currentRawMemoryMb === 'number'
          ? `Working room: ${formatMemoryGb(currentRawMemoryMb)} GB now; ${tier.label} usually includes ${formatMemoryGb(tier.memoryMb)} GB`
          : null;
        return {
          id: tier.id,
          icon: TIER_ICONS[tier.id] ?? Zap,
          title: tier.label,
          description: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <span>Working room: {getDisplayLabels(tier).workingRoom}</span>
              <span>{formatSpeed(tier)}</span>
              {approxCapacityNote && (
                <span
                  data-testid="vm-tier-extra-capacity"
                  style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}
                >
                  {approxCapacityNote}
                </span>
              )}
              {isSuggested && suggestionReason && (
                <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                  {suggestionReason}
                </span>
              )}
            </div>
          ),
          badge: isCurrent
            ? <Badge variant="secondary">Current</Badge>
            : isSuggested
              ? <Badge variant="warning" data-testid={`vm-tier-suggested-badge-${tier.id}`}>Suggested</Badge>
              : undefined,
          footer: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                {formatMonthlyCost(tier.estimatedMonthlyCostUsd)}
              </span>
              <TierSupportDetails tier={tier} />
            </div>
          ),
        };
      }),
    [currentMatch.exceeds, currentMatch.raw?.memoryMb, currentMatch.state, currentTier?.id, hideCardSelection, suggestedTierId, suggestionReason],
  );

  const costDelta = pendingTier
    && currentTier
    ? formatCostDelta(currentTier.estimatedMonthlyCostUsd, pendingTier.estimatedMonthlyCostUsd)
    : null;

  return (
    <div
      data-testid="vm-tier-selector"
      aria-disabled={pickerDisabled ? 'true' : 'false'}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}
    >
      {tierReadState.kind === 'loading' && (
        <div data-testid="vm-tier-loading" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <Spinner size="sm" label="Checking cloud speed…" />
        </div>
      )}
      {tierReadState.kind === 'cloud_unreachable' && (
        <Notice tone="warning" placement="embedded" data-testid="vm-tier-cloud-unreachable">
          Couldn&apos;t reach the cloud just now — last known: {lastKnownTierLabel}
        </Notice>
      )}
      {tierReadState.kind === 'fly_token_missing' && !flyTokenMissing && (
        <Notice tone="warning" placement="embedded" data-testid="vm-tier-token-missing">
          Connect your Fly token to see and resize cloud storage. The cloud is not being dramatic; it just needs credentials.
        </Notice>
      )}
      {isUnknownFlySize && (
        <Notice
          tone="info"
          placement="embedded"
          data-testid="vm-tier-unknown-fly-size"
          title="Custom cloud size"
        >
          This cloud does not match a Rebel speed tier. Pick Standard, Faster, or Heavy Work to put it on a standard size.
        </Notice>
      )}
      <div
        // Make the disabled radios truly inert (not just visually dimmed).
        // The `inert` attribute removes the subtree from focus/tab order and
        // hit-testing across browsers; aria-hidden mirrors that for AT.
        {...(pickerDisabled ? { inert: true, 'aria-hidden': true } : {})}
        style={{ opacity: pickerDisabled ? 0.65 : 1, width: '100%' }}
      >
        <DecisionCardGroup<VmTier['id'] | ''>
          aria-label="Cloud performance tier"
          options={options}
          value={selectedTierId}
          onValueChange={(id) => {
            if (!id) return;
            handleValueChange(id);
          }}
        />
      </div>

      <span
        tabIndex={0}
        data-testid="vm-tier-helper-text"
        style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}
      >
        {SPEED_TIER_HELPER}
      </span>
      {onAddStorageInstead && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onAddStorageInstead}
          data-testid="vm-tier-add-storage-instead"
          style={{ alignSelf: 'flex-start', color: 'var(--color-text-secondary)' }}
        >
          Need more room, not more speed? Add storage instead.
        </Button>
      )}

      {persistenceWarning && (
        <span
          data-testid="vm-tier-persistence-warning"
          style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}
        >
          {persistenceWarning}
        </span>
      )}

      <Dialog
        open={Boolean(pendingTier)}
        onOpenChange={(open) => {
          if (open) return;
          handleCloseDialog();
        }}
        disableOutsideClose={busy}
        disableEscapeClose={busy}
      >
        <DialogContent size="md" data-testid="vm-tier-dialog" aria-labelledby="vm-tier-dialog-title">
          <DialogHeader>
            <DialogTitle id="vm-tier-dialog-title">
              {pendingTier ? `Switch cloud speed to ${pendingTier.label}?` : 'Switch cloud speed?'}
            </DialogTitle>
            <DialogDescription>
              This gives your cloud more working room for heavier Slack, mobile, and agent activity. Storage stays the same.
            </DialogDescription>
          </DialogHeader>

          <DialogBody
            aria-busy={busy}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
          >
            {pendingTier && (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr',
                    gap: 'var(--space-2)',
                    fontSize: '0.85rem',
                  }}
                >
                  <span style={{ color: 'var(--color-text-secondary)' }}>Current</span>
                  <span style={{ color: 'var(--color-text-primary)' }}>{currentTier?.label ?? 'Custom cloud size'}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>New</span>
                  <span style={{ color: 'var(--color-text-primary)' }}>{pendingTier.label}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>Speed</span>
                  <span data-testid="vm-tier-speed-delta" style={{ color: 'var(--color-text-primary)' }}>
                    {currentTier
                      ? `${formatSpeed(currentTier)} → ${getDisplayLabels(pendingTier).speedRank}/${SPEED_TIER_COUNT}`
                      : `Custom cloud size → ${getDisplayLabels(pendingTier).speedRank}/${SPEED_TIER_COUNT}`}
                  </span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>Cost delta</span>
                  <span
                    data-testid="vm-tier-cost-delta"
                    style={{ color: costDelta?.cheaper ? 'var(--color-success)' : 'var(--color-text-primary)' }}
                  >
                    {costDelta?.text ?? 'Not available for custom cloud size'}
                  </span>
                  <span
                    data-testid="vm-tier-storage-delta"
                    style={{ gridColumn: '1 / -1', color: 'var(--color-text-primary)' }}
                  >
                    Storage: unchanged
                  </span>
                  <span
                    data-testid="vm-tier-storage-hint"
                    style={{ gridColumn: '1 / -1', color: 'var(--color-text-secondary)' }}
                  >
                    Need more room, not more speed? Add storage instead; no tier change required.
                  </span>
                  <span
                    data-testid="vm-tier-restart-note"
                    style={{ gridColumn: '1 / -1', color: 'var(--color-text-primary)' }}
                  >
                    Same Fly machine, brief restart
                  </span>
                </div>

                <span
                  data-testid="vm-tier-pricing-caveat"
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--color-text-secondary)',
                    fontStyle: 'italic',
                  }}
                >
                  Pricing is approximate. Check Fly.io for current rates.
                </span>

                {busy && (
                  <div
                    data-testid="vm-tier-dialog-busy"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      fontSize: '0.8rem',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    <Loader2 size={14} className="animate-spin" />
                    <span>Changing speed now. The cloud may be briefly unavailable while the same Fly machine restarts.</span>
                  </div>
                )}
              </>
            )}
          </DialogBody>

          <DialogFooter style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-2)' }}>
            {error && (
              <span
                data-testid="vm-tier-dialog-error"
                style={{ fontSize: '0.8rem', color: 'var(--color-destructive)' }}
              >
                {error}
              </span>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCloseDialog}
                disabled={busy}
              >
                Not now
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => void handleConfirm()}
                disabled={busy || !pendingTier}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                Switch speed
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
