/**
 * CloudTab
 *
 * Settings tab for cloud continuity: keep desktop local-first while
 * adding cross-device continuation.
 *
 * Flow:
 * 1. User selects "Add cloud continuity"
 * 2. Enters server URL + access token
 * 3. Clicks Connect — validates health + auth, saves immediately, auto-migrates
 * 4. Live progress indicator shows migration phases with witty status messages
 * 5. Status panel shows connection state
 * 6. Remove continuity returns to desktop-only mode
 *
 * Business logic is extracted into three hooks (star topology — hooks
 * don't import each other, CloudTab coordinates via callbacks):
 * - useCloudConnection: connect / disconnect / health / outbox / continuity
 * - useCloudSync: incremental sync / full resync / initial migration
 * - useCloudProvisioning: provision / deprovision / provider switch / OAuth / updates / repair
 */

import { useState, useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button, DecisionCardGroup, Input, Tooltip, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, MaturityBadge, Badge, Select, Notice, Spinner } from '@renderer/components/ui';
import {
  Cloud, Monitor, HelpCircle, AlertTriangle, Loader2, RefreshCw,
  CheckCircle, Unplug, PlugZap, HeartPulse, Smartphone, Copy, Eye, EyeOff,
  ExternalLink, Globe, Rocket, Trash2, ChevronDown, ChevronUp, ArrowUpCircle, KeyRound,
  Share2, Lock, Clock, Server, Bug, Download, Mail, Sparkles, Info,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import styles from '../SettingsSurface.module.css';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import type { CloudTabProps } from './types';
import { getProviderConfig, getVisibleCloudProviders, resolveHelpUrl } from '../../cloudProviders.config';
import { ProviderComparisonCard } from './cloud/ProviderComparisonCard';
import { ConnectorSetupDialog } from '../ConnectorSetupDialog';
import { MessagingChannelsSection } from '../messaging/MessagingChannelsSection';
import type { ProvisioningProgress } from '../../hooks/useProvisioningProgress';
import { getProvisioningQuip, getExtendedSubtext, getSwitchQuip } from '../../utils/cloudProvisioningQuips';
import { useNavigation } from '@renderer/contexts/NavigationContext';
import { useAppContextSafe } from '@renderer/contexts/AppContext';
import {
  STATUS_DOT, STATUS_LABEL, STATUS_BLURB, PHASE_COPY, PROVISION_PHASE_COPY, UPDATE_PHASE_COPY, MANAGED_REGIONS,
  getErrorBlurb, getUpdateCheckErrorDisplay, relativeTime, formatUptime, formatBuildDate, shouldHideRawErrorDetail,
  formatMB, formatDetailLine, shouldShowFlyTokenLinkForm, getCloudRollbackNotice,
} from './cloudTabUtils';

// Hooks (star topology)
import { useCloudConnection } from '../../hooks/useCloudConnection';
import { useCloudSync, type CloudMigrationProgress } from '../../hooks/useCloudSync';
import { useCloudProvisioning } from '../../hooks/useCloudProvisioning';
import { useCloudCapacity, type VolumeStatusOutcome, type ResizeVolumeResult, type TierChangeSuccessNotice, type ResizeVolumeUiState, type LastKnownVolumeStatus, type PressureBanner } from '../../hooks/useCloudCapacity';
import { useCloudStatusRefresh } from '../../hooks/useCloudStatusRefresh';
import { useMigrationHeartbeat } from '../../hooks/useMigrationHeartbeat';
import { VmTierSelector } from '../VmTierSelector';
import { FLY_VM_TIER_CATALOG, getDefaultTier, getTierById, type VmTier } from '@core/services/cloud/vmTierCatalog';
import { rendererIsOss } from '../../../../src/rendererIsOss';

// Stage 7: honest ETA from real throughput samples. Import via relative path
// because the @core/* alias is blocked at runtime from the renderer Vite
// build (see eslint.config.mjs "@typescript-eslint/no-restricted-imports").
// ThroughputEstimator is a pure-TS cross-surface utility with no Node-only
// deps, consumable from both main and renderer.
import { ThroughputEstimator } from '../../../../../core/utils/throughputEstimator';

// Shared volume-defaults (Stage 3)
import {
  FLY_BILLING_WALL_GB,
  recommendVolumeGb,
} from '../../../../../core/services/cloud/providers/volumeDefaults';

const EXTENDED_SUBTEXT_THRESHOLD_MS = 15_000;
const QUIP_ROTATION_MS = 6_500;

function ProvisioningProgressBar({ step, managed, switchMode }: { step: ProvisioningProgress; managed?: boolean; switchMode?: boolean }) {
  const quip = switchMode ? getSwitchQuip(step.phase) : (managed ? getProvisioningQuip(step.phase) : null);
  const info: { label: string; detail: string; estimate?: string } = quip
    ? { label: quip.text, detail: quip.subtext }
    : PROVISION_PHASE_COPY[step.phase] ?? { label: step.phase, detail: step.message };
  const pct = Math.min(100, Math.max(0, step.progress));
  const isFailed = step.phase === 'failed';

  // Extended subtext rotation for managed phases (when a phase lingers >15s)
  const [extendedSubtext, setExtendedSubtext] = useState<string | null>(null);
  const phaseRef = useRef(step.phase);
  const phaseStartRef = useRef(Date.now());
  const cycleIndexRef = useRef(0);

  useEffect(() => {
    if (step.phase !== phaseRef.current) {
      phaseRef.current = step.phase;
      phaseStartRef.current = Date.now();
      cycleIndexRef.current = 0;
      setExtendedSubtext(null);
    }

    if ((!managed && !switchMode) || isFailed || step.phase === 'complete') return;

    const interval = setInterval(() => {
      const elapsed = Date.now() - phaseStartRef.current;
      if (elapsed > EXTENDED_SUBTEXT_THRESHOLD_MS) {
        setExtendedSubtext(getExtendedSubtext(cycleIndexRef.current));
        cycleIndexRef.current++;
      }
    }, QUIP_ROTATION_MS);

    return () => clearInterval(interval);
  }, [step.phase, managed, switchMode, isFailed]);

  const displayDetail = (managed || switchMode)
    ? (extendedSubtext ?? info.detail)
    : (step.message || info.detail);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8,
      background: isFailed ? 'rgba(239, 68, 68, 0.06)' : 'color-mix(in srgb, var(--color-primary) 6%, transparent)',
      border: `1px solid ${isFailed ? 'rgba(239, 68, 68, 0.2)' : 'color-mix(in srgb, var(--color-primary) 20%, transparent)'}`,
      borderRadius: 10, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {info.label}
        </span>
        {!isFailed && (
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {pct}%
          </span>
        )}
      </div>

      {!isFailed && (
        <div style={{ height: 4, borderRadius: 2, background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 2,
            background: step.phase === 'complete' ? 'var(--color-success)' : 'var(--color-primary)',
            width: `${pct}%`,
            transition: 'width 0.4s ease-out',
          }} />
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: '0.8rem', color: isFailed ? 'var(--color-destructive)' : 'var(--color-text-secondary)', flex: 1 }}>
          {displayDetail}
        </span>
        {info.estimate && !isFailed && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            ~{info.estimate}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress Bar (inline, no CSS module needed)
// ---------------------------------------------------------------------------

/**
 * Render the live cloud-migration progress bar.
 *
 * Stage 7 of
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 * rewired this component to replace three fabrications with measurements:
 *
 *   1. The substring-match on `step.message` (fragile: would silently fall
 *      back to static copy whenever the producer changed a word) is gone.
 *      We now use `step.live === true` \u2014 a structured flag the producer
 *      sets when its message carries dynamic upload/extract detail.
 *   2. The static "~1\u20135 minutes" estimate is gone too. Live phases
 *      (workspace, extract) feed `ThroughputEstimator` samples keyed by
 *      `step.runId` so the ETA reflects observed throughput. Until the
 *      estimator has enough samples we show "Estimating..." instead of a
 *      made-up number.
 *   3. Stalls / silence / prolonged stalls are now observable via
 *      `useMigrationHeartbeat` \u2014 the UI swaps to calm, honest copy
 *      rather than pretending the upload is still making progress.
 *
 * Exported so `__tests__/MigrationProgressBar.estimator.test.tsx` can render
 * it in isolation.
 */
export function MigrationProgressBar({ step }: { step: CloudMigrationProgress }) {
  const phaseInfo = PHASE_COPY[step.phase] ?? { label: step.phase, detail: step.message, estimate: null };

  // Stage 7 change: substring-match on `step.message` replaced with the
  // structured `live` flag. `hasLiveDetail === true` means the producer is
  // emitting dynamic upload/extract progress and we should render derived
  // copy (formatDetailLine / heartbeat states) in place of the static
  // phase blurb.
  const hasLiveDetail = step.live === true;

  // One ThroughputEstimator per migration run. Re-using the same instance
  // across runs would let old samples bleed into a fresh upload's ETA, so
  // we re-initialise when `runId` changes. Writing refs during render is
  // the canonical React pattern for "reset derived state when a key
  // changes" (see the React docs on refs).
  const runIdRef = useRef<string | null>(null);
  const estimatorRef = useRef<ThroughputEstimator | null>(null);
  if (step.runId && step.runId !== runIdRef.current) {
    runIdRef.current = step.runId;
    estimatorRef.current = new ThroughputEstimator({ windowMs: 30_000 });
  }

  // Feed the estimator whenever a new step arrives with a valid byte count.
  // Depending on `step` (the whole object) rather than `step.current` /
  // `step.total` keeps react-hooks/exhaustive-deps happy \u2014 a fresh prop
  // reference on each event is how we reliably observe new samples.
  useEffect(() => {
    const est = estimatorRef.current;
    if (!est) return;
    if (step.current != null && Number.isFinite(step.current)) {
      est.addSample(step.current);
    }
  }, [step]);

  // Observe heartbeat (stalled / silent / prolonged stall) timings based
  // on the stream of progress events.
  const heartbeat = useMigrationHeartbeat(step);

  // Clamp byte counters: the tar stream adds small header overhead so a
  // raw counter can briefly overshoot `total` near end-of-upload. The
  // renderer must never show > 100% or a negative "remaining" value.
  const rawCurrent = step.current;
  const total = step.total;
  const clampedCurrent = rawCurrent != null && total != null
    ? Math.min(Math.max(0, rawCurrent), total)
    : rawCurrent;

  // Compute ETA only when we have a known total and the estimator says it
  // has enough samples. Otherwise `etaSeconds` stays undefined and the UI
  // renders an em-dash rather than a fabricated number.
  let etaSeconds: number | undefined;
  let hasEnoughSamples = false;
  if (estimatorRef.current && total != null && Number.isFinite(total) && clampedCurrent != null) {
    const snapshot = estimatorRef.current.snapshot(Math.max(0, total - clampedCurrent));
    hasEnoughSamples = snapshot.hasEnoughSamples;
    if (snapshot.hasEnoughSamples && Number.isFinite(snapshot.etaSeconds)) {
      etaSeconds = snapshot.etaSeconds;
    }
  }

  const rawPct = step.progress;
  const pct = Math.min(100, Math.max(0, Number.isFinite(rawPct) ? rawPct : 0));

  // Static items-progress label \u2014 kept for the sessions phase, which
  // reports conversations (not bytes) as current/total. Live-byte phases
  // use the formatted detail line below instead, so we only surface the
  // items label when the producer is NOT claiming live detail.
  let itemsLabel = '';
  if (!hasLiveDetail && step.current != null && step.total != null && step.total > 0) {
    itemsLabel = `${step.current} / ${step.total}`;
  }

  // Detail line: pick the most honest rendering for the current heartbeat
  // state. Priority is deliberately: prolonged stall > silent > stalled >
  // bootstrap > active. When there's no live detail, we fall back to the
  // phase's static blurb.
  let detailLine: string;
  if (!hasLiveDetail) {
    detailLine = phaseInfo.detail;
  } else if (heartbeat.prolongedStall) {
    detailLine = 'This is taking longer than expected';
  } else if (heartbeat.silent) {
    detailLine = 'Upload paused \u2014 waiting for response...';
  } else if (heartbeat.stalled) {
    const bytesLabel = total != null
      ? `${formatMB(clampedCurrent)}/${formatMB(total)}`
      : formatMB(clampedCurrent);
    detailLine = `Still uploading... ${bytesLabel} \u00b7 checking connection`;
  } else if (!hasEnoughSamples) {
    detailLine = 'Uploading workspace... Estimating...';
  } else {
    detailLine = formatDetailLine(etaSeconds, pct, clampedCurrent, total);
  }

  // Cancel is only surfaced during a prolonged stall. Emits the optional
  // `cloud:cancel-migration` IPC channel if the preload exposed one; else
  // it's a no-op so the UI still offers a calm out without fabricating.
  const showCancel = hasLiveDetail && heartbeat.prolongedStall;
  const onCancel = () => {
    const cloudApi = (globalThis as { window?: { cloudApi?: Record<string, unknown> } })
      .window?.cloudApi as { cancelMigration?: () => unknown } | undefined;
    if (cloudApi?.cancelMigration) {
      try { cloudApi.cancelMigration(); } catch { /* no-op */ }
    }
  };

  return (
    <div
      data-testid="cloud-migration-progress-bar"
      data-phase={step.phase}
      data-heartbeat={heartbeat.prolongedStall ? 'prolonged' : heartbeat.silent ? 'silent' : heartbeat.stalled ? 'stalled' : 'active'}
      style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
        borderRadius: 10, padding: '12px 14px',
      }}
    >
      {/* Phase label + percentage */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {phaseInfo.label}
        </span>
        <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
          {itemsLabel ? `${itemsLabel} \u00b7 ` : ''}{Math.round(pct)}%
        </span>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 4, borderRadius: 2, background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)', overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', borderRadius: 2,
          background: step.phase === 'complete' ? 'var(--color-success)' : 'var(--color-primary)',
          width: `${pct}%`,
          transition: 'width 0.4s ease-out',
        }} />
      </div>

      {/* Detail + estimate + optional cancel */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <span
          data-testid="cloud-migration-progress-detail"
          style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', flex: 1 }}
        >
          {detailLine}
        </span>
        {!hasLiveDetail && phaseInfo.estimate && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            ~{phaseInfo.estimate}
          </span>
        )}
        {showCancel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="cloud-migration-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Volume Size Control (Stage 3 — adaptive sizing)
// ---------------------------------------------------------------------------
//
// Renders a calm, informative summary of the measured footprint + the
// recommended volume size, with a "Customize" disclosure that reveals a
// slider + numeric input. Drives the `volumeSizeGb` threaded through the
// provisioning payload.
//
// States:
//   - loading          → subtle "Checking how much space your data needs..."
//   - measured_zero    → "Starting at 10 GB — you can resize later"
//   - measured_nonzero → "Recommended: N GB (your data is ~X GB, with room to grow)"
//   - unknown_partial  → handled by the parent dialog; this control hides
//
// See planning doc:
//   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
//   (Stage 3 — UI Footprint Measurement + Recommended Size + Customize)
// ---------------------------------------------------------------------------

type FootprintKind = 'measured_zero' | 'measured_nonzero' | 'unknown_partial';

interface VolumeSizeControlProps {
  loading: boolean;
  footprintKind: FootprintKind | null;
  workspaceBytes?: number;
  appDataBytes?: number;
  totalBytes: number;
  recommendedGb: number | null;
  volumeSizeGb: number | null;
  onChangeVolumeSizeGb: (gb: number) => void;
  customizing: boolean;
  onToggleCustomize: () => void;
  providerId: 'fly' | 'digitalocean' | 'hetzner' | 'mindstone';
  disabled: boolean;
}

const VOLUME_SIZE_MIN_GB = 10;
const VOLUME_SIZE_MAX_GB = 500;

function formatGb(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb < 0.1) return '<0.1 GB';
  if (gb < 10) return `${gb.toFixed(1)} GB`;
  return `${Math.round(gb)} GB`;
}

function clampVolumeSize(n: number): number {
  if (!Number.isFinite(n)) return VOLUME_SIZE_MIN_GB;
  return Math.min(VOLUME_SIZE_MAX_GB, Math.max(VOLUME_SIZE_MIN_GB, Math.round(n)));
}

function VolumeSizeControl(props: VolumeSizeControlProps) {
  const {
    loading, footprintKind, workspaceBytes, appDataBytes, totalBytes,
    recommendedGb, volumeSizeGb, onChangeVolumeSizeGb,
    customizing, onToggleCustomize, providerId, disabled,
  } = props;

  // Loading: subtle, non-blocking.
  if (loading || footprintKind === null) {
    return (
      <div className={styles.infoBanner} data-testid="cloud-volume-size-control" data-state="loading">
        <Loader2 size={14} className="animate-spin" style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} />
        <span className={styles.infoBannerText} style={{ color: 'var(--color-text-secondary)' }}>
          Checking how much space your data needs...
        </span>
      </div>
    );
  }

  const summary = footprintKind === 'unknown_partial'
    ? `We\u2019ll start with ${recommendedGb} GB of cloud storage. You can adjust this anytime.`
    : footprintKind === 'measured_zero'
    ? 'Starting at 10 GB — you can resize later when your data grows.'
    : (() => {
      const pieces: string[] = [];
      if (workspaceBytes != null && workspaceBytes > 0) {
        pieces.push(`${formatGb(workspaceBytes)} workspace`);
      }
      if (appDataBytes != null && appDataBytes > 0) {
        pieces.push(`${formatGb(appDataBytes)} app data`);
      }
      const breakdown = pieces.length > 0
        ? `your data is ~${formatGb(totalBytes)}${pieces.length > 1 ? ` (${pieces.join(' + ')})` : ''}`
        : `your data is ~${formatGb(totalBytes)}`;
      return `Recommended: ${recommendedGb} GB — ${breakdown}, with room to grow.`;
    })();

  const showFlyBillingWallWarning =
    providerId === 'fly'
    && volumeSizeGb !== null
    && volumeSizeGb > FLY_BILLING_WALL_GB;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid="cloud-volume-size-control"
      data-state={footprintKind}
    >
      <div className={styles.infoBanner}>
        <Cloud size={14} style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} />
        <span className={styles.infoBannerText}>{summary}</span>
      </div>

      <button
        type="button"
        onClick={onToggleCustomize}
        aria-expanded={customizing}
        disabled={disabled}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: disabled ? 'not-allowed' : 'pointer',
          color: 'var(--color-text-secondary)', fontSize: '0.85rem',
          display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
        }}
        data-testid="cloud-volume-size-customize-toggle"
      >
        {customizing ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {customizing ? 'Hide customize' : 'Customize'}
      </button>

      {customizing && volumeSizeGb !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="range"
              min={VOLUME_SIZE_MIN_GB}
              max={VOLUME_SIZE_MAX_GB}
              step={5}
              value={volumeSizeGb}
              onChange={(e) => onChangeVolumeSizeGb(clampVolumeSize(Number(e.target.value)))}
              disabled={disabled}
              style={{ flex: 1 }}
              aria-label="Volume size in GB"
              data-testid="cloud-volume-size-slider"
            />
            <Input
              type="number"
              min={VOLUME_SIZE_MIN_GB}
              max={VOLUME_SIZE_MAX_GB}
              step={5}
              value={volumeSizeGb}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onChangeVolumeSizeGb(n);
              }}
              onBlur={(e) => {
                const n = Number(e.target.value);
                onChangeVolumeSizeGb(clampVolumeSize(Number.isFinite(n) ? n : VOLUME_SIZE_MIN_GB));
              }}
              disabled={disabled}
              style={{ width: 90 }}
              aria-label="Volume size in GB (numeric)"
              data-testid="cloud-volume-size-input"
            />
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>GB</span>
          </div>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
            Range: {VOLUME_SIZE_MIN_GB}–{VOLUME_SIZE_MAX_GB} GB.
          </span>
        </div>
      )}

      {showFlyBillingWallWarning && (
        <div
          className={styles.infoBanner}
          style={{ background: 'rgba(234, 179, 8, 0.08)', borderColor: 'rgba(234, 179, 8, 0.25)' }}
          data-testid="cloud-volume-fly-billing-warning"
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-warning)' }} />
          <span className={styles.infoBannerText} style={{ color: 'var(--color-text-primary)' }}>
            Fly.io charges for volumes above {FLY_BILLING_WALL_GB} GB.{' '}
            <a
              href="https://fly.io/dashboard/personal/billing"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--color-accent)' }}
            >
              Add a payment method
            </a>{' '}
            first, or pick a smaller size.
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared connection form (used by both manual setup and reconnect flows)
// ---------------------------------------------------------------------------

function ConnectionForm({
  idPrefix,
  urlValue,
  tokenValue,
  onUrlChange,
  onTokenChange,
  error,
  phase,
  progress,
  busy,
  onSubmit,
  submitLabel,
  busyLabel,
  showTooltips,
}: {
  idPrefix: string;
  urlValue: string;
  tokenValue: string;
  onUrlChange: (v: string) => void;
  onTokenChange: (v: string) => void;
  error: string | null;
  phase: string | null;
  progress: CloudMigrationProgress | null;
  busy: boolean;
  onSubmit: () => void;
  submitLabel: string;
  busyLabel: string;
  showTooltips?: boolean;
}) {
  return (
    <>
      <SettingRow
        label="Server URL"
        variant="stacked"
        htmlFor={`${idPrefix}-url`}
        tooltip={showTooltips ? 'The HTTPS address of your Rebel cloud instance' : undefined}
      >
        <Input
          id={`${idPrefix}-url`}
          data-testid={`${idPrefix}-url-input`}
          type="url"
          value={urlValue}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://your-rebel-cloud.fly.dev"
          disabled={busy}
        />
      </SettingRow>

      <SettingRow
        label="Access token"
        variant="stacked"
        htmlFor={`${idPrefix}-token`}
        tooltip={showTooltips ? 'The REBEL_CLOUD_TOKEN secret set on your cloud instance' : undefined}
      >
        <Input
          id={`${idPrefix}-token`}
          data-testid={`${idPrefix}-token-input`}
          type="password"
          value={tokenValue}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="Your bridge token"
          disabled={busy}
        />
      </SettingRow>

      {error && (
        <div className={styles.infoBanner} style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.25)' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-destructive)' }} />
          <span className={styles.infoBannerText} style={{ color: 'var(--color-destructive)' }}>{error}</span>
        </div>
      )}

      {phase && !progress && (
        <div className={styles.infoBanner}>
          <Loader2 size={14} className="animate-spin" style={{ flexShrink: 0 }} />
          <span className={styles.infoBannerText}>{phase}</span>
        </div>
      )}

      {progress && <MigrationProgressBar step={progress} />}

      <div className={styles.actionButtonGroup}>
        <Button
          variant="default"
          size="sm"
          onClick={onSubmit}
          disabled={!urlValue.trim() || !tokenValue.trim() || busy}
          data-testid={`${idPrefix}-button`}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared Conversations Section
// ---------------------------------------------------------------------------

interface ShareEntry {
  sessionId: string;
  shareId: string;
  title?: string;
  createdAt: number;
  expiresAt?: number;
  hasPassword: boolean;
}

function SharedConversationsSection({ cloudUrl }: { cloudUrl: string }) {
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copiedShareId, setCopiedShareId] = useState<string | null>(null);

  const fetchShares = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.cloudApi.shareList({});
      if (result.success && result.shares) {
        setShares(result.shares as ShareEntry[]);
      }
    } catch { /* ignore */ }
    setLoading(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (expanded && !loaded) fetchShares();
  }, [expanded, loaded, fetchShares]);

  const handleRevoke = useCallback(async (sessionId: string) => {
    try {
      const result = await window.cloudApi.shareRevoke({ sessionId });
      if (result.success) {
        setShares((prev) => prev.filter((s) => s.sessionId !== sessionId));
      }
    } catch { /* ignore */ }
  }, []);

  const handleCopyLink = useCallback((shareId: string) => {
    const url = `${cloudUrl.replace(/\/+$/, '')}/app/shared/${shareId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedShareId(shareId);
      setTimeout(() => setCopiedShareId(null), 2000);
    });
  }, [cloudUrl]);

  const formatExpiry = (expiresAt?: number) => {
    if (!expiresAt) return 'Never';
    const diff = expiresAt - Date.now();
    if (diff <= 0) return 'Expired';
    const days = Math.ceil(diff / 864e5);
    return days === 1 ? '1 day left' : `${days} days left`;
  };

  return (
    <SettingSection title="Shared conversations" icon={Share2}>
      <p className={styles.groupDescription} style={{ margin: 0 }}>
        Conversations you&apos;ve shared publicly via link.
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        style={{ marginTop: 8 }}
      >
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {expanded ? 'Hide' : `Show shared conversations${shares.length > 0 ? ` (${shares.length})` : ''}`}
      </Button>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0', fontSize: 13 }}>
              <Loader2 size={14} className="animate-spin" /> Loading...
            </div>
          )}
          {loaded && shares.length === 0 && !loading && (
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '8px 0' }}>
              No shared conversations yet.
            </p>
          )}
          {shares.map((share) => (
            <div
              key={share.shareId}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 0',
                borderBottom: '1px solid var(--color-border)',
                gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {share.title || 'Untitled conversation'}
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  {share.hasPassword && <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}><Lock size={10} /> Password</span>}
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}><Clock size={10} /> {formatExpiry(share.expiresAt)}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <Tooltip content={copiedShareId === share.shareId ? 'Copied!' : 'Copy link'}>
                  <Button variant="ghost" size="sm" onClick={() => handleCopyLink(share.shareId)}>
                    {copiedShareId === share.shareId ? <CheckCircle size={14} /> : <Copy size={14} />}
                  </Button>
                </Tooltip>
                <Tooltip content="Revoke">
                  <Button variant="ghost" size="sm" onClick={() => handleRevoke(share.sessionId)}>
                    <Trash2 size={14} />
                  </Button>
                </Tooltip>
              </div>
            </div>
          ))}
          {loaded && shares.length > 0 && (
            <Button variant="ghost" size="sm" onClick={fetchShares} style={{ marginTop: 8 }}>
              <RefreshCw size={14} /> Refresh
            </Button>
          )}
        </div>
      )}
    </SettingSection>
  );
}

function formatStorageGb(bytes: number): string {
  return `${(Math.max(0, bytes) / (1024 ** 3)).toFixed(1)} GB`;
}

function formatCheckedAt(timestamp: number | undefined): string {
  if (!timestamp) return 'Last checked: not yet';
  return `Last checked: ${relativeTime(timestamp)}`;
}

function storageTone(volume: Extract<VolumeStatusOutcome, { kind: 'ok' }>): 'calm' | 'mention' | 'warning' | 'urgent' {
  const ratio = volume.totalBytes > 0 ? volume.usedBytes / volume.totalBytes : 0;
  if (ratio >= 0.95) return 'urgent';
  if (ratio >= 0.8) return 'warning';
  if (ratio >= 0.5) return 'mention';
  return 'calm';
}

function toOkVolume(lastKnown: LastKnownVolumeStatus): Extract<VolumeStatusOutcome, { kind: 'ok' }> {
  const totalBytes = Math.max(0, lastKnown.totalBytes);
  const usedBytes = Math.min(Math.max(0, lastKnown.usedBytes), totalBytes);
  return {
    kind: 'ok',
    ...lastKnown,
    totalBytes,
    usedBytes,
    availableBytes: Math.max(0, totalBytes - usedBytes),
  };
}

function formatResizeTargetLabel(sizeGb: number): string {
  return Number.isInteger(sizeGb) ? `${sizeGb} GB` : `${sizeGb.toFixed(1)} GB`;
}

export function CloudCapacitySection({
  mode = 'byok',
  currentVmTierId,
  tierSelectorDisabled,
  lastTierChangeSuccess,
  tierChangeState,
  lastKnownVolume,
  volume,
  loading,
  resizing,
  resizeResult,
  resizeState,
  pressureBanner,
  onTierChanged,
  onTierChangeStart,
  onTierChangeVerificationFailed,
  onDismissTierChangeNotice,
  onDismissResizeResult,
  onDismissPressureNotice,
  onPollNow,
  onResize,
}: {
  mode?: 'byok' | 'managed';
  currentVmTierId: string | undefined;
  tierSelectorDisabled: boolean;
  lastTierChangeSuccess: TierChangeSuccessNotice | null;
  tierChangeState?: { kind: 'idle' } | { kind: 'post_apply_verification_failed' };
  lastKnownVolume?: LastKnownVolumeStatus | null;
  volume: VolumeStatusOutcome | null;
  loading: boolean;
  resizing: boolean;
  resizeResult: ResizeVolumeResult | null;
  resizeState?: ResizeVolumeUiState;
  pressureBanner?: PressureBanner;
  onTierChanged: (tierId: VmTier['id']) => void;
  onTierChangeStart: () => void;
  onTierChangeVerificationFailed?: () => void;
  onDismissTierChangeNotice: () => void;
  onDismissResizeResult: () => void;
  onDismissPressureNotice: () => void;
  onPollNow: () => void;
  onResize: (targetSizeGb: number) => Promise<ResizeVolumeResult>;
}) {
  const isManagedMode = mode === 'managed';
  const [dialogOpen, setDialogOpen] = useState(false);
  const [targetSizeGb, setTargetSizeGb] = useState(10);
  const resizeDialogRef = useRef<HTMLDivElement | null>(null);
  const speedRowRef = useRef<HTMLDivElement | null>(null);
  const okVolume = volume?.kind === 'ok'
    ? toOkVolume(volume)
    : volume?.kind === 'cloud_unreachable' && volume.lastKnown
      ? toOkVolume(volume.lastKnown)
      : lastKnownVolume
        ? toOkVolume(lastKnownVolume)
        : null;
  const liveOkVolume = volume?.kind === 'ok' ? okVolume : null;
  const pendingResizeTargetGb = resizeState?.kind === 'in_flight' ? resizeState.targetSizeGb : null;
  const defaultTarget = okVolume && okVolume.usedBytes > 0
    ? Math.max(okVolume.sizeGb + 5, recommendVolumeGb(okVolume.usedBytes))
    : Math.max((okVolume?.sizeGb ?? 10) + 5, 10);
  const tone = okVolume ? storageTone(okVolume) : 'calm';
  const usedPct = okVolume && okVolume.totalBytes > 0
    ? Math.min(100, Math.max(0, (okVolume.usedBytes / okVolume.totalBytes) * 100))
    : 0;
  const totalLabel = okVolume ? formatStorageGb(okVolume.totalBytes) : '\u2014';
  const usedLabel = okVolume ? formatStorageGb(okVolume.usedBytes) : '\u2014';
  const freeLabel = okVolume ? formatStorageGb(okVolume.availableBytes) : '\u2014';
  const tokenMissing = volume?.kind === 'fly_token_missing';
  const atMaxStorage = Boolean(okVolume && okVolume.sizeGb >= 500);
  const addStorageDisabled = !liveOkVolume || atMaxStorage;
  const canAddStorageInstead = !isManagedMode && !atMaxStorage && !resizing && Boolean(liveOkVolume);
  const storageMentionLabel = `${Math.round(usedPct)}% used`;
  const cloudUnreachableMessage = volume?.kind === 'cloud_unreachable'
    ? volume.reason === 'endpoint_missing'
      ? 'Your cloud needs an update before storage usage can be read. (Reconnect once the cloud server is updated.)'
      : okVolume
        ? `Couldn't reach the cloud just now — showing the last reading from ${formatCheckedAt(okVolume.lastCheckedAt).replace(/^Last checked: /, '')}.`
        : volume.sizeGb
          ? `Couldn't reach the cloud just now — last known: ${volume.sizeGb} GB.`
          : 'Couldn\'t reach the cloud just now.'
    : null;

  useEffect(() => {
    if (volume?.kind !== 'ok' || volume.usedBytes <= volume.totalBytes) return;
    void window.miscApi?.captureMessage?.({
      message: 'cloud-storage-usage-exceeded-total',
      level: 'warning',
      context: {
        area: 'cloud-capacity',
        reason: 'storage_usage_counter_diverged',
        sizeGb: volume.sizeGb,
      },
    });
  }, [volume]);

  const openDialog = useCallback(() => {
    setTargetSizeGb(defaultTarget);
    setDialogOpen(true);
  }, [defaultTarget]);

  const closeDialog = useCallback((open: boolean) => {
    if (resizing) return;
    setDialogOpen(open);
  }, [resizing]);

  const confirmResize = useCallback(async () => {
    const result = await onResize(targetSizeGb);
    if (result.success) setDialogOpen(false);
  }, [onResize, targetSizeGb]);

  const getResizeDialogFocusable = useCallback(() => {
    const dialog = resizeDialogRef.current;
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
  }, []);

  const handleResizeDialogKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = getResizeDialogFocusable();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [getResizeDialogFocusable]);

  useEffect(() => {
    if (!dialogOpen) return;
    window.setTimeout(() => {
      getResizeDialogFocusable()[0]?.focus();
    }, 0);
  }, [dialogOpen, getResizeDialogFocusable]);

  return (
    <SettingSection
      title="Cloud capacity"
      description={isManagedMode
        ? 'Mindstone keeps your cloud running. Speed and storage are managed for you — here\'s what\'s in it.'
        : 'Control how quick your cloud feels and how much room it has. Speed and storage are separate knobs, because infrastructure enjoys paperwork.'}
      icon={Server}
      data-testid="cloud-capacity-section"
      data-section="cloudCapacity"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!isManagedMode && lastTierChangeSuccess && (
          <Notice
            tone="success"
            placement="inline"
            dismissible
            onDismiss={onDismissTierChangeNotice}
            data-testid="cloud-tier-change-success"
          >
            {lastTierChangeSuccess.tierLabel} is now active. Same Fly machine, new size. Storage unchanged.
          </Notice>
        )}
        {!isManagedMode && tierChangeState?.kind === 'post_apply_verification_failed' && (
          <Notice
            tone="warning"
            placement="inline"
            data-testid="cloud-tier-verification-failure"
          >
            Tier change applied but we couldn&apos;t confirm your cloud is healthy. Refresh in a moment.
          </Notice>
        )}
        {!isManagedMode && resizeResult?.success && (
          <Notice tone="success" placement="inline" dismissible onDismiss={onDismissResizeResult} data-testid="cloud-storage-resize-success">
            Storage now {(resizeResult.sizeGbAfter ?? targetSizeGb).toFixed(1)} GB. Same Fly machine, brief restart applied.
          </Notice>
        )}
        {!isManagedMode && resizeResult && !resizeResult.success && (
          <Notice
            tone={resizeResult.applied ? 'warning' : 'error'}
            placement="inline"
            dismissible
            onDismiss={onDismissResizeResult}
            actions={[{ label: 'Retry', onClick: openDialog, variant: 'primary', 'data-testid': 'cloud-storage-resize-retry' }]}
            data-testid="cloud-storage-resize-error"
          >
            {resizeResult.error ?? 'Storage resize failed.'}
          </Notice>
        )}
        {!isManagedMode && tokenMissing && (
          <Notice tone="warning" placement="inline" data-testid="cloud-storage-token-missing">
            Connect your Fly token to see and resize cloud storage. The cloud is not being dramatic; it just needs credentials.
          </Notice>
        )}
        {(tone === 'warning' || tone === 'urgent') && okVolume && (
          <Notice tone={tone === 'urgent' ? 'error' : 'warning'} placement="inline" data-testid="cloud-storage-threshold-notice">
            {isManagedMode
              ? 'Cloud storage is getting snug. Mindstone manages capacity — reach out if sync slows down.'
              : 'Cloud storage is getting snug. Add room before sync has to become dramatic.'}
          </Notice>
        )}
        {pressureBanner && pressureBanner.kind !== 'none' && (
          <Notice
            tone="warning"
            placement="inline"
            dismissible
            onDismiss={onDismissPressureNotice}
            title={pressureBanner.kind === 'critical' ? 'Cloud needs more room' : 'Cloud is running tight'}
            actions={isManagedMode ? undefined : [{ label: 'Review speed options', onClick: () => { speedRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, variant: 'primary', 'data-testid': 'cloud-pressure-cta' }]}
            data-testid={`cloud-pressure-banner-${pressureBanner.kind}`}
          >
            {isManagedMode
              ? 'Rebel noticed this cloud needs more room. Mindstone manages this one, so there\u2019s nothing for you to buy or configure. We\u2019ll keep checking and clear this when it settles.'
              : pressureBanner.kind === 'critical'
                ? `Rebel saw your cloud run out of working room and restart ${pressureBanner.recentOomCount === 1 ? 'once' : `${pressureBanner.recentOomCount} times`} in the last day. It recovered, but Slack and mobile updates can be missed while that happens. Moving up should steady it.`
                : 'Rebel saw your cloud getting close to its working-room limit. It can keep going, but heavier Slack or mobile activity may start to lag. A faster speed gives it more room to breathe.'}
          </Notice>
        )}
        {!isManagedMode && (
          <div ref={speedRowRef}>
          <SettingRow
            label="Speed"
            description="Pick how quick your cloud feels. Storage stays separate."
            variant="stacked"
            data-testid="cloud-speed-row"
          >
            <VmTierSelector
              cachedTierId={currentVmTierId}
              disabled={tierSelectorDisabled || tokenMissing || resizing}
              flyTokenMissing={tokenMissing}
              onTierChangeStart={onTierChangeStart}
              onTierChangeVerificationFailed={onTierChangeVerificationFailed}
              onTierChanged={onTierChanged}
              suggestedTierId={
                pressureBanner?.suggestion?.kind === 'suggestion'
                  ? pressureBanner.suggestion.tierId
                  : undefined
              }
              suggestionReason={
                pressureBanner?.suggestion?.kind === 'suggestion'
                  ? pressureBanner.suggestion.reasonCopy
                  : undefined
              }
              onAddStorageInstead={canAddStorageInstead ? openDialog : undefined}
            />
          </SettingRow>
          </div>
        )}
        <SettingRow
          label="Storage"
          description={isManagedMode
            ? 'Mindstone manages how much room your cloud has. This shows what\'s in use.'
            : 'Cloud stores Rebel continuity data, not your whole computer.'}
          variant="stacked"
          data-testid="cloud-storage-row"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
            {loading && !volume && (
              <div className={styles.cloudStorageLoading} data-testid="cloud-storage-loading" aria-busy="true">
                <div className={styles.cloudStorageSkeletonMeter} aria-hidden="true">
                  <div className={styles.cloudStorageSkeletonFill} />
                </div>
                <div className={styles.infoBanner}>
                  <Loader2 size={14} className="animate-spin" style={{ flexShrink: 0 }} />
                  <span className={styles.infoBannerText}>Checking storage…</span>
                </div>
              </div>
            )}
            {volume?.kind === 'cloud_unreachable' && (
              <Notice tone="warning" placement="embedded" data-testid="cloud-storage-unreachable">
                {cloudUnreachableMessage}
              </Notice>
            )}
            {okVolume && (
              <div
                data-testid="cloud-storage-meter"
                data-tone={tone}
                role="img"
                aria-label={`${usedLabel} used of ${totalLabel}, ${freeLabel} free`}
                tabIndex={0}
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    {usedLabel} used of {totalLabel}
                  </span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                    {freeLabel} free
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: 'color-mix(in srgb, var(--color-border) 55%, transparent)', overflow: 'hidden' }}>
                  <div
                    className={styles.cloudStorageMeterFill}
                    data-tone={tone}
                    style={{ width: `${usedPct}%` }}
                  />
                </div>
                {tone === 'mention' && (
                  <span
                    data-testid="cloud-storage-mention-cue"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}
                  >
                    <Info size={14} aria-hidden="true" />
                    Cloud is starting to fill — {storageMentionLabel}. Plenty of room, but worth keeping an eye on.
                  </span>
                )}
                {pendingResizeTargetGb !== null && (
                  <span
                    data-testid="cloud-storage-pending-target"
                    style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}
                  >
                    Resizing to {formatResizeTargetLabel(pendingResizeTargetGb)}…
                  </span>
                )}
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                  {formatCheckedAt(okVolume.lastCheckedAt)}
                </span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {!isManagedMode && (resizing ? (
                <div
                  role="status"
                  aria-live="polite"
                  data-testid="cloud-storage-resizing-status"
                  style={{ display: 'inline-flex', alignItems: 'center', minHeight: 32 }}
                >
                  <Spinner size="sm" label="Resizing…" />
                </div>
              ) : atMaxStorage ? (
                <Tooltip content="Maximum cloud storage is 500 GB. Contact us if you need more.">
                  <span
                    tabIndex={0}
                    style={{ display: 'inline-flex' }}
                    aria-label="Maximum cloud storage is 500 GB. Contact us if you need more."
                    data-testid="cloud-storage-at-max-tooltip-trigger"
                  >
                    <Button variant="outline" size="sm" onClick={openDialog} disabled data-testid="cloud-storage-add-button">
                      <ArrowUpCircle size={14} />
                      Add storage
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button variant="outline" size="sm" onClick={openDialog} disabled={addStorageDisabled} data-testid="cloud-storage-add-button">
                  <ArrowUpCircle size={14} />
                  Add storage
                </Button>
              ))}
              <Button variant="ghost" size="sm" onClick={onPollNow} disabled={loading || resizing} data-testid="cloud-storage-refresh-button">
                {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Refresh
              </Button>
            </div>
          </div>
        </SettingRow>
      </div>

      <Dialog open={!isManagedMode && dialogOpen} onOpenChange={closeDialog} disableEscapeClose={resizing} disableOutsideClose={resizing} ariaLabelledBy="cloud-storage-resize-title">
        <DialogContent size="sm" ref={resizeDialogRef} onKeyDown={handleResizeDialogKeyDown}>
          <DialogHeader onClose={resizing ? undefined : () => setDialogOpen(false)}>
            <DialogTitle id="cloud-storage-resize-title">Add storage</DialogTitle>
            <DialogDescription>Choose the new total size. Fly volumes grow; they do not shrink.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span className={styles.groupDescription} style={{ margin: 0 }}>Current total</span>
                <strong>{okVolume ? `${okVolume.sizeGb} GB` : '—'}</strong>
              </div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>New total size</span>
                <Input
                  type="number"
                  min={Math.max((okVolume?.sizeGb ?? 10) + 1, 10)}
                  max={500}
                  step={5}
                  value={String(targetSizeGb)}
                  onChange={(event) => setTargetSizeGb(Number(event.target.value))}
                  disabled={resizing}
                  data-testid="cloud-storage-target-input"
                />
              </label>
              <p className={styles.groupDescription} style={{ margin: 0 }}>
                Default picked from current usage with headroom. Very scientific. Mostly multiplication.
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={resizing}>Cancel</Button>
            <Button
              variant="default"
              onClick={confirmResize}
              disabled={resizing || !Number.isFinite(targetSizeGb) || targetSizeGb <= (okVolume?.sizeGb ?? 0) || targetSizeGb > 500}
              data-testid="cloud-storage-confirm-resize"
            >
              {resizing ? <Loader2 size={14} className="animate-spin" /> : null}
              {resizing ? 'Resizing…' : `Resize to ${targetSizeGb} GB`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingSection>
  );
}

// ---------------------------------------------------------------------------
// Advanced troubleshooting drawer
// ---------------------------------------------------------------------------

function AdvancedTroubleshootingDrawer({
  children,
  onCollapse,
}: {
  children: ReactNode;
  onCollapse: () => void;
}) {
  const [open, setOpen] = useState(false);

  const handleToggle = useCallback(() => {
    setOpen((previous) => {
      if (previous) {
        onCollapse();
      }
      return !previous;
    });
  }, [onCollapse]);

  return (
    <SettingSection
      title="Advanced troubleshooting"
      icon={HelpCircle}
      data-testid="cloud-advanced-troubleshooting-section"
    >
      <p className={styles.groupDescription} style={{ margin: 0 }}>
        Diagnostics, repair actions, and sharp tools for when continuity needs a nudge.
      </p>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleToggle}
        aria-expanded={open}
        aria-controls="cloud-advanced-troubleshooting-content"
        style={{ alignSelf: 'flex-start', color: 'var(--color-text-secondary)' }}
        data-testid="cloud-advanced-troubleshooting-toggle"
      >
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {open ? 'Hide advanced troubleshooting' : 'Show advanced troubleshooting'}
      </Button>

      {open && (
        <div
          id="cloud-advanced-troubleshooting-content"
          data-testid="cloud-advanced-troubleshooting-content"
          style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 4 }}
        >
          {children}
        </div>
      )}
    </SettingSection>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CloudTab = ({ draftSettings, updateDraft, embedded = false }: CloudTabProps) => {
  const { navigate } = useNavigation();
  const appContext = useAppContextSafe();
  const isOss = rendererIsOss();
  const effectiveDraftSettings = isOss && draftSettings.managedCloudEnabled
    ? { ...draftSettings, managedCloudEnabled: false }
    : draftSettings;
  const cloud = effectiveDraftSettings.cloudInstance;
  const visibleCloudProviders = getVisibleCloudProviders({ isOss });
  const managedCloudEnabled = !isOss && !!effectiveDraftSettings.managedCloudEnabled;

  // ------ Hook composition (star topology) ------

  const connection = useCloudConnection({
    cloudInstance: cloud,
    updateDraft,
  });

  const sync = useCloudSync({
    cloudInstance: cloud,
    updateDraft,
    isConnected: connection.isConnected,
  });

  // Derived flags
  const isFlyByok = connection.mode === 'cloud' && !!cloud?.cloudUrl && cloud.provisionMode === 'byok' && !!cloud.flyAppName && !!cloud.flyMachineId;
  const isAutoProvisioned = connection.mode === 'cloud' && !!cloud?.cloudUrl && (cloud.provisionMode === 'byok' || cloud.provisionMode === 'managed');
  const isManaged = cloud?.provisionMode === 'managed';
  const connectedProviderId = cloud?.providerId ?? (isFlyByok ? 'fly' : undefined);
  const connectedProviderConfig = getProviderConfig(connectedProviderId);
  const isFlyUrl = !!cloud?.cloudUrl?.match(/^https:\/\/[a-z0-9-]+\.fly\.dev\/?$/i);

  const provisioning = useCloudProvisioning({
    draftSettings: effectiveDraftSettings,
    cloudInstance: cloud,
    updateDraft,
    isConnected: connection.isConnected,
    isFlyByok,
    isAutoProvisioned,
    isManaged,
    cloudHealth: connection.cloudHealth,
    setCloudHealth: connection.setCloudHealth,
  });

  const capacity = useCloudCapacity({
    cloudInstance: cloud,
    enabled: (isFlyByok && connectedProviderId === 'fly') || isManaged,
    updateDraft,
  });

  useCloudStatusRefresh({
    cloudUrl: cloud?.cloudUrl,
    isConnected: connection.isConnected,
    isManaged,
    busy: connection.busy,
    syncInProgress: sync.syncInProgress,
    provisionBusy: provisioning.provisionBusy,
    switchInProgress: provisioning.switchInProgress,
    updateStatus: provisioning.updateStatus,
    refreshStatus: connection.refreshCloudStatus,
    emitLog: appContext?.emitLog,
  });

  // ------ UI-only state ------

  const [showWebQR, setShowWebQR] = useState(false);
  const [recentLogs, setRecentLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  // Composite busy flag for UI elements that need to be disabled during ANY operation
  const anyBusy = connection.busy || sync.syncInProgress || provisioning.provisionBusy;

  // ------ Orchestration wrappers (cross-hook sequences) ------

  const handleConnectAndMigrate = useCallback(async () => {
    sync.clearResults();
    connection.setBusy(true);
    const result = await connection.handleConnect();
    if (!result.success) {
      connection.setBusy(false);
      return;
    }
    if (result.isReconnect && result.urlUnchanged) {
      // Token-only update — no migration needed
      const msg = 'Connection details updated.';
      sync.setMigrationResult(msg);
      connection.setBusy(false);
      return;
    }
    // Trigger migration via sync hook
    const migrateResult = await sync.migrate();
    connection.setBusy(false);
    if (migrateResult.shouldReload) {
      setTimeout(() => window.location.reload(), 1500);
    }
  }, [connection, sync]);

  // Stage 5 — VM tier selection during initial provisioning. Defaults to the
  // Standard tier (= current hardcoded shared-cpu-4x/4096MB config) so users
  // who skip this step get the same behavior as before.
  const [setupVmTierId, setSetupVmTierId] = useState<VmTier['id']>(() => getDefaultTier().id);

  const handleProvisionAndMigrate = useCallback(async () => {
    const result = await provisioning.handleProvision(
      provisioning.selectedProvider === 'fly' ? { vmTierId: setupVmTierId } : undefined,
    );
    if (!result.success || !result.cloudUrl || !result.cloudToken) return;
    // Seed connection form with new credentials
    connection.setUrlInput(result.cloudUrl);
    connection.setTokenInput(result.cloudToken);
    connection.setPendingMode(null);
    // Trigger migration
    connection.setBusy(true);
    const migrateResult = await sync.migrate();
    connection.setBusy(false);
    if (migrateResult.success) {
      if (migrateResult.shouldReload) {
        setTimeout(() => window.location.reload(), 1500);
      }
    }
  }, [provisioning, connection, sync, setupVmTierId]);

  const handleDeprovisionWithSync = useCallback(async () => {
    await provisioning.handleDeprovision({
      setBusy: connection.setBusy,
      setConnectError: connection.setConnectError,
      clearSyncResults: sync.clearResults,
    });
  }, [provisioning, connection, sync]);

  const handleSyncNow = useCallback(async () => {
    if (connection.busy || sync.syncInProgress) return;
    connection.setBusy(true);
    await sync.handleSync();
    connection.setBusy(false);
  }, [connection, sync]);

  const handleFullResyncWrapped = useCallback(async () => {
    if (connection.busy || sync.syncInProgress) return;
    connection.setBusy(true);
    await sync.handleFullResync();
    connection.setBusy(false);
  }, [connection, sync]);

  // ------ View recent cloud logs ------

  const handleFetchLogs = useCallback(async () => {
    setLogsLoading(true);
    setRecentLogs(null);
    try {
      const result = await window.cloudApi.exportDiagnostics();
      if (result.success && result.bundle) {
        const remote = result.bundle.remote as Record<string, unknown> | undefined;
        if (remote?.unavailable) {
          setRecentLogs('Cloud service is unreachable. Cannot fetch logs.');
        } else if (remote?.recentLogs && Array.isArray(remote.recentLogs)) {
          const lines = (remote.recentLogs as Array<Record<string, unknown>>)
            .map((entry) => {
              const ts = entry.timestamp ?? entry.ts ?? '';
              const level = entry.level ?? '';
              const msg = entry.msg ?? entry.message ?? '';
              return `[${ts}] ${String(level).toUpperCase().padEnd(5)} ${msg}`;
            })
            .join('\n');
          setRecentLogs(lines || 'No recent logs available.');
        } else {
          setRecentLogs('No recent logs available.');
        }
      } else {
        setRecentLogs('Failed to fetch diagnostics.');
      }
    } catch {
      setRecentLogs('Failed to fetch diagnostics.');
    } finally {
      setLogsLoading(false);
    }
  }, []);

  // ------ Mode change orchestration ------

  const handleModeChange = useCallback((newMode: 'local' | 'cloud') => {
    connection.handleModeChange(newMode);
    sync.clearResults();
  }, [connection, sync]);

  // ------ Render ------

  const {
    mode, isConnected, isSetupNeeded, status,
    urlInput, tokenInput, setUrlInput, setTokenInput,
    connectError, connectPhase, setConnectError,
    confirmDisconnect,
    cloudHealth, outboxStatus, continuityStats,
    copiedField, busy,
    handleDisconnect, handleCheckHealth, handleCopyField, handleOpenWebLink,
  } = connection;

  const {
    migrationProgress, migrationResult, migrationResultIsError,
    confirmFullResync,
  } = sync;

  const {
    selectedProvider, setSelectedProvider, showByokPicker, setShowByokPicker, providerConfig,
    providerTokenInput, setProviderTokenInput, showManualSetup, setShowManualSetup,
    showTokenHelp, setShowTokenHelp,
    provisionBusy, provisionError, setProvisionError, provisionProgress,
    provisionCleanupMessage,
    selectedRegion, setSelectedRegion, doReconnectNeeded,
    confirmDeprovision,
    doOAuthStatus, doOAuthLoading, showPatFallback, setShowPatFallback,
    switchInProgress, switchError, setSwitchError,
    showSwitchDialog, setShowSwitchDialog,
    switchProviderSelection, setSwitchProviderSelection,
    switchTokenInput, setSwitchTokenInput,
    switchCleanupWarning, setSwitchCleanupWarning,
    flyLinkTokenInput, setFlyLinkTokenInput, flyLinkBusy, flyLinkError, hasFlyToken,
    flyDiagnostic,
    repairIngressBusy, repairIngressResult, repairIngressError,
    repairTokenBusy, repairTokenResult, repairTokenError, repairTokenConflict,
    repairFlyTokenBusy, repairFlyTokenResult, repairFlyTokenError,
    updateStatus, updateError, updateErrorCategory, updateProgress, currentChannel,
    confirmChannelSwitch, setConfirmChannelSwitch,
    discoveryResult, conflictResolving, conflictResolveError, lastConflictKeepRef,
    orphanedManaged, reattachBusy, reattachError,
    // Stage 3 — footprint measurement + recommended size
    footprint, footprintLoading,
    volumeSizeGb, setVolumeSizeGb, customizing, setCustomizing,
    handleSwitchProvider, handleStartDigitalOceanOAuth, handleDisconnectDigitalOceanOAuth,
    handleCheckForUpdate, handleApplyUpdate, handleChannelToggle, handleStopWaiting,
    handleLinkFlyToken, handleRepairIngress, handleRepairToken, handleRepairFlyToken, handleResolveConflict,
    connectorSetupGuidance,
    handleReattachManaged, handleDestroyOrphanedManaged,
    resetProvisionProgress: _resetProvisionProgress,
  } = provisioning;

  // Shared provision-error/warning banner element. Extracted so the partial
  // deprovision warning (C-F3) can render at a site that survives the post-wipe
  // `mode==='local'` state (the setup-form sites at :1634/:1947 unmount once
  // `isSetupNeeded` flips false), without duplicating a third divergent banner.
  // Reused at the managed setup-form site below and at the local-mode site.
  const provisionErrorBanner = provisionError ? (
    <div
      data-testid="cloud-provision-error-banner"
      className={styles.infoBanner}
      style={{
        background: provisionError.severity === 'warning' ? 'rgba(234, 179, 8, 0.08)' : 'rgba(239, 68, 68, 0.08)',
        borderColor: provisionError.severity === 'warning' ? 'rgba(234, 179, 8, 0.25)' : 'rgba(239, 68, 68, 0.25)',
        flexDirection: 'column', alignItems: 'flex-start', gap: '4px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <AlertTriangle size={14} style={{ flexShrink: 0, color: provisionError.severity === 'warning' ? 'var(--color-warning)' : 'var(--color-destructive)' }} />
        <span className={styles.infoBannerText} style={{ color: provisionError.severity === 'warning' ? 'var(--color-warning)' : 'var(--color-destructive)' }}>
          {provisionError.userMessage}
        </span>
      </div>
      {provisionError.guidance && (
        <span className={styles.infoBannerText} style={{ color: 'var(--color-text-secondary)', fontSize: '12px', paddingLeft: '22px' }}>
          {provisionError.guidance}
        </span>
      )}
      {provisionError.providerDetail && (
        <span className={styles.infoBannerText} style={{ color: 'var(--color-text-secondary)', fontSize: '12px', paddingLeft: '22px', fontStyle: 'italic' }}>
          The provider said: {provisionError.providerDetail}
        </span>
      )}
      {provisionCleanupMessage && (
        <span className={styles.infoBannerText} style={{ color: 'var(--color-text-secondary)', fontSize: '12px', paddingLeft: '22px' }}>
          {provisionCleanupMessage}
        </span>
      )}
    </div>
  ) : null;

  return (
    <>
      {!embedded && (
        <header className={styles.pageHeader}>
          <h2 className={styles.pageTitle}>
            Cloud continuity
            <MaturityBadge level="beta" featureName="Cloud Continuity" />
          </h2>
          <p className={styles.pageDescription}>
            Rebel stays local-first on desktop. Add cloud continuity so your work
            can continue on phone, tablet, or browser when needed.
          </p>
        </header>
      )}

      {/* ====== MODE SELECTOR ====== */}
      <SettingSection title="Cloud continuity" data-section="cloudSync" data-testid="settings-section-cloud-sync">
        <DecisionCardGroup
          aria-label="Cloud continuity"
          value={mode}
          onValueChange={handleModeChange}
          options={[
            {
              id: 'local',
              icon: Monitor,
              title: 'Desktop only',
              description: 'Everything stays local on this computer. No continuity layer.',
              footer: 'Local by default',
            },
            {
              id: 'cloud',
              icon: Cloud,
              title: 'Add cloud continuity',
              description: 'Attach your cloud instance so work can continue across devices.',
              badge: <MaturityBadge level="beta" featureName="Cloud Continuity" />,
              footer: 'Works across devices',
            },
          ]}
        />
      </SettingSection>

      {/* Partial-deprovision warning (C-F3). After a deprovision wipes settings,
          `mode` flips to 'local' so `isSetupNeeded` is false and the setup-form
          banner sites unmount. Render the persistent warning HERE — in the
          local-mode surface the user actually sees post-wipe — so a partial
          teardown failure ("instance may still be running") stays visible and
          is not silently dropped. Only when the setup form is NOT showing (it
          renders its own copy). Clears when `provisionError` is reset (re-act /
          reconnect). */}
      {!isSetupNeeded && provisionErrorBanner}

      {/* ====== SETUP FORM ====== */}
      {isSetupNeeded && (
        <>
          {/* Managed-first layout — eligible users get a simplified one-click experience */}
          {managedCloudEnabled && !showByokPicker && (
            <SettingSection title="Mindstone Cloud">
              <p className={styles.groupDescription} style={{ margin: 0 }}>
                Access your conversations from any device.
                We handle the infrastructure, keep it patched, and quietly update it — no accounts or API keys needed.
              </p>

              {/* Orphaned managed instance: still running on the backend after a local
                  Forget, so a fresh setup is blocked ("Instance already exists"). Offer
                  reconnect / destroy in-card so it's clearly tied to Mindstone Cloud. */}
              {orphanedManaged && !discoveryResult?.conflict && (
                <div
                  data-testid="cloud-orphaned-managed-banner"
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 12,
                    background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)',
                    borderRadius: 10, padding: '14px 16px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Cloud size={18} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
                    <strong style={{ fontSize: '0.95rem', color: 'var(--color-text-primary)' }}>
                      Your Mindstone Cloud is still running
                    </strong>
                  </div>

                  <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    You forgot Mindstone Cloud on this device, but the instance is still running on
                    our servers — so a fresh setup is blocked. Reconnect to pick up where you left
                    off, or destroy it if you're done with it.
                  </p>

                  {reattachError && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      background: 'rgba(239, 68, 68, 0.08)',
                      border: '1px solid rgba(239, 68, 68, 0.25)',
                      borderRadius: 8, padding: '8px 12px',
                    }}>
                      <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-destructive)' }} />
                      <span style={{ fontSize: '0.8rem', color: 'var(--color-destructive)' }}>
                        {reattachError}
                      </span>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => void handleReattachManaged()}
                      disabled={reattachBusy}
                      data-testid="cloud-reattach-managed"
                    >
                      {reattachBusy ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
                      Reconnect to Mindstone Cloud
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleDestroyOrphanedManaged()}
                      disabled={reattachBusy}
                      data-testid="cloud-destroy-orphaned-managed"
                    >
                      <Trash2 size={14} />
                      Destroy it
                    </Button>
                  </div>
                </div>
              )}

              {provisionErrorBanner}

              {provisionProgress && <ProvisioningProgressBar step={provisionProgress} managed />}

              {/* New-setup affordance is hidden while a backend instance is orphaned —
                  provisioning a fresh one would just be rejected ("already exists"). The
                  recovery banner above is the correct path; setup returns after destroy. */}
              {!orphanedManaged && (
                <>
                  {!provisionProgress && !provisionError && (
                    <div className={styles.infoBanner}>
                      <Cloud size={14} style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} />
                      <span className={styles.infoBannerText}>
                        Managed by Mindstone. Kept up to date automatically.
                      </span>
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label htmlFor="managed-region" style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                      Region
                    </label>
                    <Select id="managed-region" value={selectedRegion} onChange={(e) => setSelectedRegion(e.target.value)} disabled={provisionBusy}>
                      {MANAGED_REGIONS.map(r => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </Select>
                  </div>

                  <div className={styles.actionButtonGroup}>
                    <Button
                      variant="default"
                      onClick={handleProvisionAndMigrate}
                      disabled={provisionBusy}
                      data-testid="cloud-provision-button"
                    >
                      {provisionBusy ? <Loader2 size={14} className="animate-spin" /> : <Cloud size={14} />}
                      {provisionBusy ? 'Setting up...' : 'Enable Mindstone Cloud'}
                    </Button>
                  </div>
                </>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowByokPicker(true);
                  setSelectedProvider('fly');
                  setProvisionError(null);
                }}
                disabled={provisionBusy}
                style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem', padding: 0 }}
              >
                Use your own cloud provider instead ›
              </Button>
            </SettingSection>
          )}

          {/* BYOK setup — provider picker for non-eligible users or when "Use your own" is clicked */}
          {(!managedCloudEnabled || showByokPicker) && (
          <>
          {/* Quick setup — auto-provision (default, prominent) */}
          <SettingSection title="Get started">
            <p className={styles.groupDescription} style={{ margin: 0 }}>
              Rebel will set up a private cloud instance on your chosen provider.
              Your data stays on your own account — we never see it.
            </p>

            {/* Provider comparison card — Stage 4 (supplementary; radio cards below stay). */}
            <ProviderComparisonCard
              providers={visibleCloudProviders.filter(
                (p) => !p.managed && !p.hidden && (!p.featureFlag || !!effectiveDraftSettings[p.featureFlag]),
              )}
              recommendedVolumeGb={volumeSizeGb}
              selectedProviderId={selectedProvider}
              onSelectProvider={(id) => {
                if (provisionBusy) return;
                if (id === 'fly' || id === 'digitalocean' || id === 'hetzner' || id === 'mindstone') {
                  setSelectedProvider(id);
                  setProviderTokenInput('');
                  setProvisionError(null);
                  setShowTokenHelp(false);
                  setShowPatFallback(false);
                }
              }}
            />

            {/*
              Provider selector — radio cards (filtered by feature flags).
              The outer div owns the CSS grid; the inner radiogroup wrapper
              uses `display: contents` so that its radio children participate
              directly in the grid while the radiogroup's ARIA role is
              scoped to the actual `<input type="radio">` elements. The
              "More soon" signpost sits as a grid sibling outside the
              radiogroup so screen-reader users still hear the message
              without it polluting the radio-option enumeration.
            */}
            <div className={styles.safetyLevelCards}>
              <div role="radiogroup" aria-label="Cloud provider" style={{ display: 'contents' }}>
                {visibleCloudProviders
                  .filter((p) => !p.managed && !p.hidden && (!p.featureFlag || !!effectiveDraftSettings[p.featureFlag]))
                  .map((provider) => (
                  <label
                    key={provider.id}
                    className={`${styles.safetyLevelCard} ${selectedProvider === provider.id ? styles.safetyLevelCardSelected : ''}`}
                    style={{ cursor: provisionBusy ? 'not-allowed' : 'pointer' }}
                  >
                    <input
                      type="radio"
                      name="cloud-provider"
                      value={provider.id}
                      checked={selectedProvider === provider.id}
                      onChange={() => {
                        setSelectedProvider(provider.id);
                        setProviderTokenInput('');
                        setProvisionError(null);
                        setShowTokenHelp(false);
                        setShowPatFallback(false);
                      }}
                      disabled={provisionBusy}
                    />
                    <div className={styles.safetyLevelCardHeader}>
                      <span className={styles.safetyLevelCardTitle}>{provider.name}</span>
                    </div>
                    <p className={styles.safetyLevelCardDescription}>{provider.costBlurb}</p>
                  </label>
                ))}
              </div>
              {/*
                Coming-soon signpost — fills the grid slots left empty while
                additional BYOK providers (DigitalOcean, Hetzner, and new
                entrants) are being readied. Non-interactive by design: no
                radio input, no hover. Exposed to screen readers via
                `role="note"` so the message reaches everyone. When more
                providers are added back to the picker, this tile's
                `grid-column: span` value in CSS will need to be revisited.
              */}
              <div
                className={styles.providerComingSoon}
                role="note"
                data-testid="cloud-provider-coming-soon"
              >
                <div className={styles.providerComingSoonHeader}>
                  <Sparkles size={14} className={styles.providerComingSoonIcon} aria-hidden="true" />
                  <span className={styles.providerComingSoonTitle}>More soon</span>
                </div>
                <p className={styles.providerComingSoonDescription}>
                  We&rsquo;re adding more cloud providers so you can pick the one that fits your setup best.
                </p>
              </div>
            </div>

            {/* DigitalOcean OAuth-first auth UI */}
            {selectedProvider === 'digitalocean' && providerConfig.supportsOAuth && !showPatFallback && !providerConfig.managed && (
              <SettingRow label="DigitalOcean account" variant="stacked">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {!doOAuthStatus.connected ? (
                    <>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={handleStartDigitalOceanOAuth}
                        disabled={doOAuthLoading || provisionBusy}
                      >
                        {doOAuthLoading ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                        {doOAuthLoading ? 'Waiting for authorization...' : (providerConfig.oauthButtonLabel ?? 'Connect with DigitalOcean')}
                      </Button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowPatFallback(true);
                          setProvisionError(null);
                        }}
                        disabled={doOAuthLoading || provisionBusy}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          color: 'var(--color-text-secondary)', fontSize: '0.8rem', textAlign: 'left',
                          textDecoration: 'underline',
                        }}
                      >
                        Or enter token manually
                      </button>
                    </>
                  ) : (
                    <>
                      <div className={styles.infoBanner} style={{ background: 'rgba(34, 197, 94, 0.08)', borderColor: 'rgba(34, 197, 94, 0.25)' }}>
                        <CheckCircle size={14} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                        <span className={styles.infoBannerText} style={{ color: 'var(--color-success)' }}>
                          Connected as {doOAuthStatus.accountEmail ?? 'your DigitalOcean account'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleDisconnectDigitalOceanOAuth}
                          disabled={doOAuthLoading || provisionBusy}
                        >
                          {doOAuthLoading ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}
                          {doOAuthLoading ? 'Disconnecting...' : 'Disconnect'}
                        </Button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowPatFallback(true);
                            setProvisionError(null);
                          }}
                          disabled={doOAuthLoading || provisionBusy}
                          style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            color: 'var(--color-text-secondary)', fontSize: '0.8rem',
                            textDecoration: 'underline',
                          }}
                        >
                          Or enter token manually
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </SettingRow>
            )}

            {/* Token input — driven by selected provider (hidden for managed providers and OAuth-first providers) */}
            {!providerConfig.managed && (!providerConfig.supportsOAuth || selectedProvider !== 'digitalocean' || showPatFallback) && (
              <SettingRow
                label={providerConfig.tokenLabel ?? 'API token'}
                variant="stacked"
                htmlFor="provider-token"
                badge={(
                  <button
                    type="button"
                    onClick={() => setShowTokenHelp(prev => !prev)}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center',
                    }}
                    aria-label="How to get a token"
                  >
                    <HelpCircle size={14} />
                  </button>
                )}
              >
                <>
                  {showTokenHelp && providerConfig.tokenHelpSteps && (
                    <div className={styles.infoBanner} style={{ background: 'rgba(99, 102, 241, 0.06)', borderColor: 'rgba(99, 102, 241, 0.15)', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                      <span className={styles.infoBannerText} style={{ lineHeight: 1.5 }}>
                        <strong>How to get a token (takes 30 seconds):</strong><br />
                        {providerConfig.tokenHelpSteps.map((step, i) => (
                          <span key={i}>
                            {i + 1}. {step}
                            {i === 0 && providerConfig.tokenHelpUrl && (
                              <>
                                {' '}
                                <a href={providerConfig.tokenHelpUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}>
                                  <ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
                                </a>
                              </>
                            )}
                            <br />
                          </span>
                        ))}
                      </span>
                      {providerConfig.tokenHelpNote && (
                        <span className={styles.infoBannerText} style={{ fontSize: '12px', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                          {providerConfig.tokenHelpNote}
                        </span>
                      )}
                    </div>
                  )}

                  <Input
                    id="provider-token"
                    data-testid="provider-token-input"
                    type="password"
                    value={providerTokenInput}
                    onChange={(e) => { setProviderTokenInput(e.target.value); setProvisionError(null); }}
                    placeholder={providerConfig.tokenPlaceholder ?? 'Paste your API token'}
                    disabled={provisionBusy}
                  />
                </>
              </SettingRow>
            )}

            {provisionError && (
              <div className={styles.infoBanner} style={{
                background: provisionError.severity === 'warning' ? 'rgba(234, 179, 8, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                borderColor: provisionError.severity === 'warning' ? 'rgba(234, 179, 8, 0.25)' : 'rgba(239, 68, 68, 0.25)',
                flexDirection: 'column', alignItems: 'flex-start', gap: '4px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, color: provisionError.severity === 'warning' ? 'var(--color-warning)' : 'var(--color-destructive)' }} />
                  <span className={styles.infoBannerText} style={{ color: provisionError.severity === 'warning' ? 'var(--color-warning)' : 'var(--color-destructive)' }}>
                    {provisionError.userMessage}
                  </span>
                </div>
                {provisionError.guidance && (
                  <span className={styles.infoBannerText} style={{ color: 'var(--color-text-secondary)', fontSize: '12px', paddingLeft: '22px' }}>
                    {provisionError.guidance}
                    {provisionError.helpKey && (() => {
                      const url = resolveHelpUrl(selectedProvider, provisionError.helpKey ?? undefined, provisionError.providerContext);
                      return url ? (
                        <>
                          {' '}
                          <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}>
                            Learn more
                          </a>
                        </>
                      ) : null;
                    })()}
                  </span>
                )}
                {provisionError.providerDetail && (
                  <span className={styles.infoBannerText} style={{ color: 'var(--color-text-secondary)', fontSize: '12px', paddingLeft: '22px', fontStyle: 'italic' }}>
                    The provider said: {provisionError.providerDetail}
                  </span>
                )}
                {provisionCleanupMessage && (
                  <span className={styles.infoBannerText} style={{ color: 'var(--color-text-secondary)', fontSize: '12px', paddingLeft: '22px' }}>
                    {provisionCleanupMessage}
                  </span>
                )}
                {doReconnectNeeded && (
                  <div style={{ paddingLeft: '22px', marginTop: 4 }}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleStartDigitalOceanOAuth}
                      disabled={doOAuthLoading || provisionBusy}
                    >
                      {doOAuthLoading ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                      {doOAuthLoading ? 'Reconnecting...' : 'Reconnect'}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {provisionProgress && <ProvisioningProgressBar step={provisionProgress} />}

            {!provisionProgress && !provisionError && (
              <div className={styles.infoBanner}>
                <Cloud size={14} style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} />
                <span className={styles.infoBannerText}>
                  {providerConfig.managed
                    ? providerConfig.costBlurb
                    : `${providerConfig.costBlurb} Rebel only creates resources prefixed with "rebel-cloud-".`}
                </span>
              </div>
            )}

            {/* Volume size control (BYOK only — managed sizing is server-side) */}
            {!providerConfig.managed && (
              <VolumeSizeControl
                loading={footprintLoading}
                footprintKind={footprint?.kind ?? null}
                workspaceBytes={footprint?.kind === 'measured_nonzero' ? footprint.workspaceBytes : 0}
                appDataBytes={footprint?.kind === 'measured_nonzero' ? footprint.appDataBytes : (footprint?.kind === 'measured_zero' ? footprint.appDataBytes : 0)}
                totalBytes={footprint?.kind === 'measured_nonzero' ? footprint.totalBytes : 0}
                recommendedGb={volumeSizeGb}
                volumeSizeGb={volumeSizeGb}
                onChangeVolumeSizeGb={setVolumeSizeGb}
                customizing={customizing}
                onToggleCustomize={() => setCustomizing((v) => !v)}
                providerId={selectedProvider}
                disabled={provisionBusy}
              />
            )}

            {/* Region picker for Fly BYOK provisioning. Mirrors the managed-region
                select above; defaults to detectNearestRegion() (the hook's initial
                value). Without this, a user whose timezone resolves to a
                capacity-constrained region had no way to change it and would retry
                straight into the same "no capacity" wall. */}
            {!providerConfig.managed && selectedProvider === 'fly' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label htmlFor="setup-region" style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                  Region
                </label>
                <Select
                  id="setup-region"
                  value={selectedRegion}
                  onChange={(e) => setSelectedRegion(e.target.value)}
                  disabled={provisionBusy}
                  data-testid="setup-region-select"
                >
                  {MANAGED_REGIONS.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </Select>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                  If setup fails for lack of capacity, try a different region.
                </span>
              </div>
            )}

            {/* Stage 5 — Compact VM tier picker for Fly BYOK provisioning. Defaults
                to Standard so users who skip selection get the same config as before. */}
            {!providerConfig.managed && selectedProvider === 'fly' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label
                  htmlFor="setup-vm-tier"
                  style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}
                >
                  Cloud performance
                </label>
                <Select
                  id="setup-vm-tier"
                  value={setupVmTierId}
                  onChange={(e) => setSetupVmTierId(e.target.value as VmTier['id'])}
                  disabled={provisionBusy}
                  data-testid="setup-vm-tier-select"
                >
                  {FLY_VM_TIER_CATALOG.map((tier) => (
                    <option key={tier.id} value={tier.id}>
                      {tier.label} — ~${tier.estimatedMonthlyCostUsd.toFixed(2)}/month ({tier.description})
                    </option>
                  ))}
                </Select>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                  You can change this later in cloud settings.
                </span>
              </div>
            )}

            <div className={styles.actionButtonGroup}>
              <Button
                variant="default"
                onClick={handleProvisionAndMigrate}
                disabled={
                  (!providerConfig.managed
                    && !(providerTokenInput.trim() || (selectedProvider === 'digitalocean' && doOAuthStatus.connected)))
                  || provisionBusy
                  // Block submit while the footprint is still loading
                  // in the initial render.
                  || (!providerConfig.managed && volumeSizeGb === null)
                }
                data-testid="cloud-provision-button"
              >
                {provisionBusy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                {provisionBusy ? 'Setting up...' : 'Set up cloud sync'}
              </Button>
            </div>
          </SettingSection>

          {/* Advanced: manual connect (hidden behind disclosure) */}
          <SettingSection title="">
            <button
              type="button"
              onClick={() => setShowManualSetup(prev => !prev)}
              aria-expanded={showManualSetup}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--color-text-secondary)', fontSize: '0.85rem',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              {showManualSetup ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              Already have a server? Connect manually
            </button>

            {showManualSetup && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <ConnectionForm
                  idPrefix="cloud-connect"
                  urlValue={urlInput}
                  tokenValue={tokenInput}
                  onUrlChange={(v) => { setUrlInput(v); setConnectError(null); }}
                  onTokenChange={(v) => { setTokenInput(v); setConnectError(null); }}
                  error={connectError}
                  phase={connectPhase}
                  progress={migrationProgress}
                  busy={busy}
                  onSubmit={handleConnectAndMigrate}
                  submitLabel="Connect"
                  busyLabel="Connecting..."
                  showTooltips
                />
              </div>
            )}
          </SettingSection>
          </>
          )}
        </>
      )}

      {/* ====== CONFLICT BANNER — blocks when both managed + BYOK exist ====== */}
      {discoveryResult?.conflict && (
        <SettingSection title="">
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            background: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)',
            borderRadius: 10, padding: '16px 18px',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={18} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />
              <strong style={{ fontSize: '0.95rem', color: 'var(--color-text-primary)' }}>
                Two cloud instances detected
              </strong>
            </div>

            {/* Body copy */}
            <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.5 }}>
              Both <strong>Mindstone Cloud</strong> and your{' '}
              <strong>{getProviderConfig(discoveryResult.byok.providerId ?? 'fly').name}</strong> instance
              are active. Please choose which one to keep.
            </p>
            <p style={{ fontSize: '0.8rem', color: 'var(--color-text-tertiary)', margin: 0, lineHeight: 1.5 }}>
              Your data is safe on both instances. Choosing one will cleanly remove the other — nothing will be lost.
            </p>

            {/* Error message */}
            {conflictResolveError && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                borderRadius: 8, padding: '8px 12px',
              }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-destructive)' }} />
                <span style={{ fontSize: '0.8rem', color: 'var(--color-destructive)' }}>
                  {conflictResolveError}
                </span>
              </div>
            )}

            {/* Resolution progress */}
            {conflictResolving && (
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 8,
                background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
                borderRadius: 8, padding: '10px 12px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                    Resolving — this may take a moment…
                  </span>
                </div>
                <div style={{ height: 3, borderRadius: 2, background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)', overflow: 'hidden' }}>
                  <div className="animate-pulse" style={{
                    height: '100%', borderRadius: 2,
                    background: 'var(--color-primary)',
                    width: '60%',
                  }} />
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <Button
                variant="default"
                size="sm"
                onClick={() => handleResolveConflict('managed')}
                disabled={conflictResolving}
              >
                <Cloud size={14} />
                Use Mindstone Cloud
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleResolveConflict('byok')}
                disabled={conflictResolving}
              >
                <Server size={14} />
                Use {getProviderConfig(discoveryResult.byok.providerId ?? 'fly').name}
              </Button>
              {conflictResolveError && lastConflictKeepRef.current && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { if (lastConflictKeepRef.current) handleResolveConflict(lastConflictKeepRef.current); }}
                  disabled={conflictResolving}
                >
                  <RefreshCw size={14} />
                  Retry
                </Button>
              )}
            </div>
          </div>
        </SettingSection>
      )}

      {/* ====== CONNECTED STATUS — DASHBOARD ====== */}
      {isConnected && (
        <SettingSection title="Continuity is on">
          <div className={styles.modelConfigCard}>
            {/* Status header + channel badge */}
            <div className={styles.flexBetweenWrap}>
              <div className={styles.flexCol}>
                <div className={styles.flexCenter}>
                  <span
                    style={{
                      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                      background: STATUS_DOT[status ?? 'cold'] ?? STATUS_DOT.cold,
                    }}
                    aria-hidden
                  />
                  <strong style={{ fontSize: '0.95rem' }}>
                    {STATUS_LABEL[status ?? 'cold'] ?? 'Unknown'}
                  </strong>
                  {isAutoProvisioned && (
                    <Badge variant="outline" size="sm">{connectedProviderConfig.name}</Badge>
                  )}
                </div>
                <p className={styles.groupDescription} style={{ margin: 0 }}>
                  {status === 'error'
                    ? getErrorBlurb(cloud?.lastError, cloud?.errorCategory)
                    : (STATUS_BLURB[status ?? 'cold'] ?? '')}
                </p>
              </div>
            </div>

            {/* Cloud auto-recovered from a bad update (watchdog rolled back to
                last-known-good). Informational; managed gets soft reassurance,
                BYOK gets a nudge to the "Check for updates" affordance below. */}
            {(() => {
              // `isAutoProvisioned` gates the "Check for updates" controls block,
              // so only reference it in the copy when it's actually rendered.
              const rollbackNotice = getCloudRollbackNotice(isManaged, cloudHealth?.cloudUpdate, {
                canCheckForUpdates: isAutoProvisioned,
              });
              return rollbackNotice ? (
                <Notice
                  tone={rollbackNotice.tone}
                  placement="embedded"
                  title={rollbackNotice.title}
                  data-testid="cloud-rollback-notice"
                >
                  {rollbackNotice.body}
                </Notice>
              ) : null;
            })()}

            {/* Info grid — version, uptime, last checked, region */}
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: '8px 24px',
              marginTop: 4, paddingTop: 8,
              borderTop: '1px solid var(--color-border-soft)',
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className={styles.groupDescription} style={{ margin: 0, fontSize: '0.75rem' }}>Version</span>
                {cloudHealth ? (
                  <Tooltip
                    content={cloudHealth.buildCommit ? `Commit: ${cloudHealth.buildCommit}` : ''}
                    placement="top"
                    delayShow={300}
                  >
                    <span style={{ fontSize: '0.85rem', color: 'var(--color-text-primary)' }}>
                      {cloudHealth.version && cloudHealth.version !== '0.0.0-cloud'
                        ? `v${cloudHealth.version}`
                        : formatBuildDate(cloudHealth.buildDate) || (
                          cloudHealth.buildCommit
                            ? <code style={{ fontSize: '0.85em' }}>{cloudHealth.buildCommit.slice(0, 7)}</code>
                            : '\u2014'
                        )}
                    </span>
                  </Tooltip>
                ) : (
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>{'\u2014'}</span>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className={styles.groupDescription} style={{ margin: 0, fontSize: '0.75rem' }}>Uptime</span>
                <span style={{
                  fontSize: '0.85rem',
                  color: cloudHealth ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {cloudHealth ? formatUptime(cloudHealth.uptimeSeconds) : '\u2014'}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className={styles.groupDescription} style={{ margin: 0, fontSize: '0.75rem' }}>Last checked</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--color-text-primary)' }}>
                  {relativeTime(cloud?.lastSyncedAt)}
                </span>
              </div>

              {continuityStats && continuityStats.cloudActive > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className={styles.groupDescription} style={{ margin: 0, fontSize: '0.75rem' }}>Cloud sessions</span>
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                    {continuityStats.cloudActive} active{continuityStats.pinned > 0 ? ` \u00b7 ${continuityStats.pinned} pinned` : ''}
                  </span>
                </div>
              )}
            </div>

            {/* Update status (inline with version area) — shown for both BYOK and managed */}
            {isAutoProvisioned && updateStatus !== 'idle' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {(updateStatus === 'checking' || updateStatus === 'applying') && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Loader2 size={12} className="animate-spin" />
                    {updateStatus === 'checking' ? 'Checking for updates...' : 'Triggering update...'}
                  </span>
                )}
                {updateStatus === 'restarting' && (
                  <span style={{ fontSize: '0.8rem', color: updateProgress?.phase === 'stalled' || updateProgress?.phase === 'backstop' ? 'var(--color-warning)' : 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                    <Loader2 size={12} className="animate-spin" />
                    <span>
                      {UPDATE_PHASE_COPY[updateProgress?.phase ?? 'deploying']?.label ?? 'Updating...'}
                      {updateProgress && updateProgress.elapsedSeconds >= 10 && (
                        <span style={{ opacity: 0.6 }}>{' '}({updateProgress.elapsedSeconds}s)</span>
                      )}
                    </span>
                    <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                      {UPDATE_PHASE_COPY[updateProgress?.phase ?? 'deploying']?.detail ?? ''}
                    </span>
                    <Button variant="ghost" size="sm" onClick={handleStopWaiting} data-testid="cloud-update-stop-waiting">
                      Stop waiting
                    </Button>
                  </span>
                )}
                {updateStatus === 'up_to_date' && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-success)' }}>Cloud service is up to date.</span>
                )}
                {updateStatus === 'updated' && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-success)' }}>Cloud service updated.</span>
                )}
                {updateStatus === 'update_available' && (
                  <>
                    <Badge variant="primary" size="sm">Update available</Badge>
                    <Button variant="outline" size="sm" onClick={handleApplyUpdate} data-testid="cloud-apply-update-button">
                      <ArrowUpCircle size={14} />
                      Update now
                    </Button>
                  </>
                )}
                {updateStatus === 'rate_limited' && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                    Couldn&apos;t check right now. Try again in a few minutes.
                  </span>
                )}
                {updateStatus === 'error' && updateError && (() => {
                  // Route the raw update-check error through the same sanitizer the
                  // other cloud error streams use. A cold-boot network abort/timeout
                  // is shown as a calm "still starting up" line (muted, not red)
                  // rather than leaking a scary raw DOMException.
                  const display = getUpdateCheckErrorDisplay(updateError, updateErrorCategory ?? undefined);
                  return (
                    <span style={{ fontSize: '0.8rem', color: display.tone === 'muted' ? 'var(--color-text-secondary)' : 'var(--color-destructive)' }}>
                      {display.text}
                    </span>
                  );
                })()}
                {updateStatus !== 'checking' && updateStatus !== 'applying' && updateStatus !== 'restarting' && (
                  <Button variant="ghost" size="sm" onClick={handleCheckForUpdate} data-testid="cloud-check-update-button">
                    <RefreshCw size={14} />
                    Check for updates
                  </Button>
                )}
              </div>
            )}

            {/* Error detail (raw, for troubleshooting) */}
            {status === 'error' && cloud?.lastError && !shouldHideRawErrorDetail(cloud.lastError, cloud?.errorCategory) && (
              <div className={styles.infoBanner} style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.25)' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-destructive)' }} />
                <span className={styles.infoBannerText} style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem' }}>
                  Error detail: {cloud.lastError}
                </span>
              </div>
            )}

            {/* Missing public IP warning + repair (only for canonical *.fly.dev with linked Fly token) */}
            {isFlyByok && isFlyUrl && flyDiagnostic?.hasPublicIp === false && !repairIngressResult && (
              <div className={styles.infoBanner} style={{ background: 'rgba(245, 158, 11, 0.08)', borderColor: 'rgba(245, 158, 11, 0.25)' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-warning)' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                  <span className={styles.infoBannerText} style={{ color: 'var(--color-text-primary)' }}>
                    Your Fly app is missing a public IP address. Cloud continuity requires one to work.
                  </span>
                  {repairIngressError && (
                    <span style={{ fontSize: '0.8rem', color: 'var(--color-destructive)' }}>{repairIngressError}</span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRepairIngress}
                    disabled={repairIngressBusy}
                    style={{ alignSelf: 'flex-start' }}
                    data-testid="cloud-repair-ingress-button"
                  >
                    {repairIngressBusy ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
                    {repairIngressBusy ? 'Allocating...' : 'Allocate public IP'}
                  </Button>
                </div>
              </div>
            )}

            {/* Ingress repair success */}
            {repairIngressResult && (
              <div className={styles.infoBanner} style={{ background: 'rgba(34, 197, 94, 0.08)', borderColor: 'rgba(34, 197, 94, 0.25)' }}>
                <CheckCircle size={14} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                <span className={styles.infoBannerText} style={{ color: 'var(--color-success)' }}>{repairIngressResult}</span>
              </div>
            )}

            {/* Authentication failure warning + token repair (only for canonical *.fly.dev with linked Fly token) */}
            {isFlyByok && isFlyUrl && flyDiagnostic?.authenticated === false && !repairTokenResult && (
              <div className={styles.infoBanner} style={{ background: 'rgba(245, 158, 11, 0.08)', borderColor: 'rgba(245, 158, 11, 0.25)' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-warning)' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                  <span className={styles.infoBannerText} style={{ color: 'var(--color-text-primary)' }}>
                    Authentication failed. The cloud token may not be configured on the remote instance.
                  </span>
                  {repairTokenError && (
                    <span style={{ fontSize: '0.8rem', color: 'var(--color-destructive)' }}>{repairTokenError}</span>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-start' }}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRepairToken(repairTokenConflict ? true : undefined)}
                      disabled={repairTokenBusy}
                      data-testid="cloud-repair-token-button"
                    >
                      {repairTokenBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                      {repairTokenBusy ? 'Repairing...' : repairTokenConflict ? 'Overwrite token' : 'Repair cloud token'}
                    </Button>
                  </div>
                  {repairTokenConflict && !repairTokenBusy && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                      This will restart the cloud instance and may disconnect other paired devices.
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Token repair success */}
            {repairTokenResult && (
              <div className={styles.infoBanner} style={{ background: 'rgba(34, 197, 94, 0.08)', borderColor: 'rgba(34, 197, 94, 0.25)' }}>
                <CheckCircle size={14} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                <span className={styles.infoBannerText} style={{ color: 'var(--color-success)' }}>{repairTokenResult}</span>
              </div>
            )}

            {/* Live migration progress */}
            {migrationProgress && <MigrationProgressBar step={migrationProgress} />}

            {/* Sync result (shown when NOT actively syncing) */}
            {!migrationProgress && migrationResult && (
              <div className={styles.infoBanner} style={{
                background: migrationResultIsError ? 'rgba(239, 68, 68, 0.08)' : 'rgba(34, 197, 94, 0.08)',
                borderColor: migrationResultIsError ? 'rgba(239, 68, 68, 0.25)' : 'rgba(34, 197, 94, 0.25)',
              }}>
                {migrationResultIsError
                  ? <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-destructive)' }} />
                  : <CheckCircle size={14} style={{ flexShrink: 0, color: 'var(--color-success)' }} />}
                <span className={styles.infoBannerText} style={{ color: migrationResultIsError ? 'var(--color-destructive)' : 'var(--color-success)' }}>
                  {migrationResult}
                </span>
              </div>
            )}

            {/* Idle "all good" state */}
            {!migrationProgress && !migrationResult && status === 'running' && (
              <div className={styles.infoBanner} style={{ background: 'rgba(34, 197, 94, 0.08)', borderColor: 'rgba(34, 197, 94, 0.25)' }}>
                <CheckCircle size={14} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                <span className={styles.infoBannerText} style={{ color: 'var(--color-success)' }}>
                  All good. Continuity is current and ready when you continue elsewhere.
                </span>
              </div>
            )}

            {/* Outbox indicator */}
            {outboxStatus && outboxStatus.pending > 0 && (
              <div className={styles.infoBanner} style={{
                background: 'rgba(99, 102, 241, 0.08)',
                borderColor: 'rgba(99, 102, 241, 0.25)',
              }}>
                <Loader2 size={14} style={{ flexShrink: 0, color: 'var(--color-accent)' }} />
                <span className={styles.infoBannerText} style={{ color: 'var(--color-accent)' }}>
                  {outboxStatus.pending} item{outboxStatus.pending === 1 ? '' : 's'} queued for sync.
                </span>
              </div>
            )}

            {/* Primary actions */}
            <div className={styles.actionButtonGroup} style={{ marginTop: 4 }}>
              <Button variant="outline" size="sm" onClick={handleSyncNow} disabled={anyBusy || switchInProgress || updateStatus === 'restarting'} data-testid="cloud-sync-button">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Sync now
              </Button>
              <Button variant="outline" size="sm" onClick={handleCheckHealth} disabled={anyBusy || switchInProgress || updateStatus === 'restarting'} data-testid="cloud-health-button">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <HeartPulse size={14} />}
                Check status
              </Button>
              <Button
                variant={confirmDisconnect ? 'destructive' : 'ghost'}
                size="sm"
                onClick={() => handleDisconnect()}
                disabled={anyBusy || switchInProgress}
                data-testid="cloud-disconnect-button"
              >
                <Unplug size={14} />
                {confirmDisconnect ? 'Confirm forget' : 'Forget cloud on this device'}
              </Button>
            </div>

            {confirmDisconnect && (
              <p className={styles.groupDescription} style={{ margin: 0, color: 'var(--color-destructive)' }}>
                {isManaged
                  ? "This only forgets the connection on this device — your Mindstone Cloud instance keeps running on our servers. You'll be offered Reconnect or Destroy here afterward. To shut the instance down now, use \u201CRemove Mindstone Cloud\u201D below instead."
                  : "This forgets your cloud URL and token on this device. Your cloud keeps running, you'll re-enter them to reconnect."}
              </p>
            )}

            {/* ---- Provider switch ---- */}
            {switchInProgress && provisionProgress && (
              <ProvisioningProgressBar step={provisionProgress} switchMode />
            )}
            {switchInProgress && !provisionProgress && (
              <div className={styles.infoBanner}>
                <Loader2 size={14} className="animate-spin" style={{ flexShrink: 0 }} />
                <span className={styles.infoBannerText}>Preparing to switch providers…</span>
              </div>
            )}

            {switchError && (
              <div className={styles.infoBanner} style={{
                background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.25)',
                flexDirection: 'column', alignItems: 'flex-start', gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-destructive)' }} />
                  <span className={styles.infoBannerText} style={{ color: 'var(--color-destructive)' }}>
                    {switchError.error}
                  </span>
                </div>
                {switchError.failedStep && (
                  <span className={styles.infoBannerText} style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', paddingLeft: 22 }}>
                    Failed at: {switchError.failedStep}. Your current cloud is untouched.
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setSwitchError(null); setShowSwitchDialog(true); }}
                  style={{ alignSelf: 'flex-start', marginTop: 4 }}
                >
                  Try again
                </Button>
              </div>
            )}

            {switchCleanupWarning && (
              <div className={styles.infoBanner} style={{ background: 'rgba(245, 158, 11, 0.08)', borderColor: 'rgba(245, 158, 11, 0.25)' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-warning)' }} />
                <span className={styles.infoBannerText} style={{ color: 'var(--color-text-primary)' }}>
                  {switchCleanupWarning}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => window.location.reload()}
                  style={{ flexShrink: 0 }}
                >
                  Reload
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSwitchCleanupWarning(null)}
                  style={{ flexShrink: 0 }}
                >
                  Dismiss
                </Button>
              </div>
            )}

            {!switchInProgress && !switchError && isAutoProvisioned && !isManaged && managedCloudEnabled && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSwitchDialog(true)}
                disabled={anyBusy || switchInProgress}
                style={{ alignSelf: 'flex-start' }}
                data-testid="cloud-switch-to-managed"
              >
                <Cloud size={14} />
                Switch to Mindstone Cloud
              </Button>
            )}

            {!switchInProgress && !switchError && isAutoProvisioned && isManaged && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setShowSwitchDialog(true); setSwitchProviderSelection('fly'); setSwitchTokenInput(''); }}
                disabled={anyBusy || switchInProgress}
                style={{ alignSelf: 'flex-start', color: 'var(--color-text-secondary)', fontSize: '0.85rem', padding: 0 }}
                data-testid="cloud-switch-to-byok"
              >
                Switch to your own cloud provider ›
              </Button>
            )}

          </div>
        </SettingSection>
      )}

      {isConnected && ((isFlyByok && connectedProviderId === 'fly') || isManaged) && (
        <CloudCapacitySection
          mode={isManaged ? 'managed' : 'byok'}
          currentVmTierId={cloud?.vmTierId}
          tierSelectorDisabled={anyBusy || switchInProgress}
          lastTierChangeSuccess={capacity.lastTierChangeSuccess}
          tierChangeState={capacity.tierChangeState}
          lastKnownVolume={capacity.lastKnownVolume}
          volume={capacity.volume}
          loading={capacity.loading}
          resizing={capacity.resizing}
          resizeResult={capacity.resizeResult}
          resizeState={capacity.resizeState}
          pressureBanner={capacity.pressureBanner}
          onTierChangeStart={capacity.dismissTierChangeNotice}
          onTierChangeVerificationFailed={capacity.recordTierChangeVerificationFailure}
          onDismissTierChangeNotice={capacity.dismissTierChangeNotice}
          onTierChanged={(tierId) => {
            if (cloud) {
              updateDraft('cloudInstance', { ...cloud, vmTierId: tierId });
            }
            capacity.recordTierChangeSuccess(getTierById(tierId)?.label ?? 'Cloud speed');
          }}
          onDismissResizeResult={() => capacity.setResizeResult(null)}
          onDismissPressureNotice={capacity.dismissPressureNotice}
          onPollNow={() => { void capacity.pollNow(); }}
          onResize={capacity.resize}
        />
      )}

      {/* ====== PAIR MOBILE APP ====== */}
      {isConnected && (
        <SettingSection title="Continue on mobile" icon={Smartphone}>

          <p className={styles.groupDescription} style={{ margin: 0 }}>
            Scan this in the Rebel mobile app to continue from the same cloud instance.
          </p>

          {/* Get the app */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
            borderRadius: 10, padding: '12px 14px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Download size={14} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                Get the mobile app
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.appApi.openUrl('https://testflight.apple.com/join/EVr7NFP2')}
                data-testid="get-ios-app"
              >
                <ExternalLink size={14} />
                iOS (TestFlight)
              </Button>
              <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Mail size={12} />
                Android? Reach out to <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); window.appApi.openUrl('mailto:hello@mindstone.com?subject=Android%20beta%20access'); }}
                  style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 500 }}
                >hello@mindstone.com</a>
              </span>
            </div>
          </div>

          <div className={styles.modelConfigCard}>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
              <QRCodeSVG
                value={JSON.stringify({
                  v: 1,
                  type: 'rebel-pair',
                  cloudUrl: cloud?.cloudUrl,
                  token: cloud?.cloudToken,
                })}
                size={200}
                fgColor="var(--color-text-primary)"
                bgColor="transparent"
                level="M"
                data-testid="mobile-pairing-qr"
              />
            </div>

            <div className={styles.actionButtonGroup} style={{ justifyContent: 'center' }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopyField('url')}
                data-testid="cloud-pairing-copy-url"
              >
                <Copy size={14} />
                {copiedField === 'url' ? 'Copied!' : 'Copy URL'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopyField('token')}
                data-testid="cloud-pairing-copy-token"
              >
                <Copy size={14} />
                {copiedField === 'token' ? 'Copied!' : 'Copy token'}
              </Button>
            </div>
          </div>
        </SettingSection>
      )}

      {/* ====== WEB ACCESS ====== */}
      {isConnected && (
        <SettingSection title="Continue on web" icon={Globe}>
          <p className={styles.groupDescription} style={{ margin: 0 }}>
            Open in any browser when you want continuity without the desktop app.
          </p>

          <div className={styles.actionButtonGroup}>
            <Button
              variant="default"
              size="sm"
              onClick={handleOpenWebLink}
              data-testid="open-web-link"
            >
              <ExternalLink size={14} />
              Open in browser
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowWebQR((prev) => !prev)}
              data-testid="web-qr-toggle"
            >
              {showWebQR ? <EyeOff size={14} /> : <Eye size={14} />}
              {showWebQR ? 'Hide QR' : 'Show QR'}
            </Button>
          </div>

          {showWebQR && (
            <div className={styles.modelConfigCard}>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
                <QRCodeSVG
                  value={`${cloud?.cloudUrl ?? ''}/app#token=${encodeURIComponent(cloud?.cloudToken ?? '')}`}
                  size={200}
                  fgColor="var(--color-text-primary)"
                  bgColor="transparent"
                  level="M"
                  data-testid="web-qr-code"
                />
              </div>
            </div>
          )}
        </SettingSection>
      )}

      <MessagingChannelsSection />

      {/* ====== SHARED CONVERSATIONS ====== */}
      {isConnected && <SharedConversationsSection cloudUrl={cloud?.cloudUrl ?? ''} />}

      {/* ====== ADVANCED TROUBLESHOOTING ====== */}
      {isConnected && (
        <AdvancedTroubleshootingDrawer onCollapse={() => setConfirmChannelSwitch(false)}>
                {/* Connection details */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="cloud-connection-details-section">
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    Connection details
                  </span>
                  <div className={styles.flexCenter} style={{ gap: 6 }}>
                    <span className={styles.groupDescription} style={{ margin: 0 }}>URL:</span>
                    <code style={{ fontSize: '0.85em', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>{cloud?.cloudUrl}</code>
                    <Button variant="ghost" size="sm" onClick={() => handleCopyField('url')} style={{ padding: '2px 6px', minWidth: 0 }}>
                      <Copy size={12} />
                      {copiedField === 'url' ? 'Copied' : ''}
                    </Button>
                  </div>
                  <div className={styles.flexCenter} style={{ gap: 6 }}>
                    <span className={styles.groupDescription} style={{ margin: 0 }}>Token:</span>
                    <code style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}>{'•'.repeat(12)}</code>
                    <Button variant="ghost" size="sm" onClick={() => handleCopyField('token')} style={{ padding: '2px 6px', minWidth: 0 }}>
                      <Copy size={12} />
                      {copiedField === 'token' ? 'Copied' : ''}
                    </Button>
                  </div>
                  {connectedProviderId && (
                    <div className={styles.flexCenter} style={{ gap: 6 }}>
                      <span className={styles.groupDescription} style={{ margin: 0 }}>Provider:</span>
                      <span style={{ fontSize: '0.85em', color: 'var(--color-text-primary)' }}>{connectedProviderConfig.name}</span>
                    </div>
                  )}
                  <div className={styles.flexCenter} style={{ gap: 6 }}>
                    <span className={styles.groupDescription} style={{ margin: 0 }}>Setup:</span>
                    <span style={{ fontSize: '0.85em', color: 'var(--color-text-primary)' }}>
                      {isManaged ? 'Managed' : isFlyByok ? 'BYOK' : isAutoProvisioned ? 'Auto-provisioned' : 'Manual connect'}
                    </span>
                  </div>
                  {cloud?.flyAppName && (
                    <div className={styles.flexCenter} style={{ gap: 6 }}>
                      <span className={styles.groupDescription} style={{ margin: 0 }}>Fly App:</span>
                      <code style={{ fontSize: '0.85em', color: 'var(--color-text-primary)' }}>{cloud.flyAppName}</code>
                    </div>
                  )}
                  {cloud?.flyMachineId && (
                    <div className={styles.flexCenter} style={{ gap: 6 }}>
                      <span className={styles.groupDescription} style={{ margin: 0 }}>Machine:</span>
                      <code style={{ fontSize: '0.85em', color: 'var(--color-text-primary)' }}>{cloud.flyMachineId}</code>
                    </div>
                  )}
                  {cloud?.flyRegion && (
                    <div className={styles.flexCenter} style={{ gap: 6 }}>
                      <span className={styles.groupDescription} style={{ margin: 0 }}>Region:</span>
                      <span style={{ fontSize: '0.85em', color: 'var(--color-text-primary)' }}>{cloud.flyRegion}</span>
                    </div>
                  )}
                </div>

                {/* Full resync */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="cloud-full-resync-section">
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    Full resync
                  </span>
                  <p className={styles.groupDescription} style={{ margin: 0 }}>
                    Re-uploads your entire desktop to cloud from scratch. Only use this if sync seems genuinely stuck.
                  </p>
                  {migrationProgress && <MigrationProgressBar step={migrationProgress} />}
                  <Button
                    variant={confirmFullResync ? 'destructive' : 'outline'}
                    size="sm"
                    onClick={handleFullResyncWrapped}
                    disabled={anyBusy || switchInProgress}
                    data-testid="cloud-full-resync-button"
                    style={{ alignSelf: 'flex-start' }}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {confirmFullResync ? 'Yes, resync everything' : 'Full resync'}
                  </Button>
                </div>

                {/* Connect Fly.io access token */}
                {shouldShowFlyTokenLinkForm({ isConnected, isManaged, isFlyByok, isFlyUrl, hasFlyToken }) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="cloud-link-fly-token-section">
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                      Connect Fly.io access token
                    </span>
                    <p className={styles.groupDescription} style={{ margin: 0 }}>
                      Your cloud is connected, but some actions (auto-updates, performance tier
                      changes, infrastructure repair) need a Fly.io access token to work their magic.
                    </p>
                    <SettingRow
                      label="Fly.io access token"
                      variant="stacked"
                      htmlFor="fly-link-token"
                    >
                      <Input
                        id="fly-link-token"
                        type="password"
                        value={flyLinkTokenInput}
                        onChange={(e) => { setFlyLinkTokenInput(e.target.value); }}
                        placeholder="Paste your Fly.io Personal Access Token"
                        disabled={flyLinkBusy}
                      />
                    </SettingRow>
                    {flyLinkError && (
                      <div className={styles.infoBanner} style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.25)' }}>
                        <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-destructive)' }} />
                        <span className={styles.infoBannerText} style={{ color: 'var(--color-destructive)' }}>{flyLinkError}</span>
                      </div>
                    )}
                    <div className={styles.actionButtonGroup}>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={handleLinkFlyToken}
                        disabled={!flyLinkTokenInput.trim() || flyLinkBusy}
                        data-testid="cloud-link-fly-token-button"
                      >
                        {flyLinkBusy ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
                        {flyLinkBusy ? 'Connecting...' : 'Connect Fly token'}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Enable cloud auto-update — bootstraps FLY_API_TOKEN secret on legacy Fly BYOK
                    instances so the cloud can keep itself current without this Mac being on.
                    Only shown when applicable: BYOK Fly + not yet repaired. */}
                {isFlyByok && connectedProviderId === 'fly' && !cloud.flyApiTokenSecretRepairedAt && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="cloud-auto-update-section">
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                      Enable cloud auto-update
                    </span>
                    <p className={styles.groupDescription} style={{ margin: 0 }}>
                      Lets your cloud keep itself current even when this Mac is off. Restarts the
                      cloud once to apply.
                    </p>
                    {repairFlyTokenError && (
                      <span style={{ fontSize: '0.8rem', color: 'var(--color-destructive)' }}>{repairFlyTokenError}</span>
                    )}
                    {repairFlyTokenResult && (
                      <div className={styles.infoBanner} style={{ background: 'rgba(34, 197, 94, 0.08)', borderColor: 'rgba(34, 197, 94, 0.25)' }}>
                        <CheckCircle size={14} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                        <span className={styles.infoBannerText} style={{ color: 'var(--color-success)' }}>{repairFlyTokenResult}</span>
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRepairFlyToken}
                      disabled={repairFlyTokenBusy || anyBusy || switchInProgress}
                      data-testid="cloud-repair-fly-token-button"
                      style={{ alignSelf: 'flex-start' }}
                    >
                      {repairFlyTokenBusy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                      {repairFlyTokenBusy ? 'Enabling...' : 'Enable cloud auto-update'}
                    </Button>
                  </div>
                )}

                {/* Recent cloud logs */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="cloud-recent-logs-section">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="cloud-recent-logs-toggle"
                    onClick={() => {
                      setShowLogs(prev => {
                        if (!prev && !recentLogs) handleFetchLogs();
                        return !prev;
                      });
                    }}
                    aria-expanded={showLogs}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    Recent cloud logs
                  </Button>
                  {showLogs && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {logsLoading ? (
                        <div className={styles.flexCenter} style={{ gap: 8, color: 'var(--color-text-secondary)' }}>
                          <Loader2 size={14} className="animate-spin" /> Fetching logs...
                        </div>
                      ) : (
                        <>
                          <pre style={{
                            fontSize: '11px',
                            lineHeight: '1.5',
                            color: 'var(--color-text-secondary)',
                            background: 'var(--color-bg-secondary, rgba(0,0,0,0.1))',
                            borderRadius: '6px',
                            padding: '12px',
                            maxHeight: '300px',
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            margin: 0,
                          }}>
                            {recentLogs ?? 'No logs loaded.'}
                          </pre>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleFetchLogs}
                            disabled={logsLoading}
                            style={{ alignSelf: 'flex-start' }}
                          >
                            <RefreshCw size={12} /> Refresh
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Report a bug */}
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="cloud-report-bug-button"
                  onClick={() => navigate({
                    type: 'feedback',
                    feedbackType: 'bug',
                    description: [
                      '[Cloud continuity issue]',
                      `Cloud URL: ${cloud?.cloudUrl}`,
                      `Status: ${status ?? 'unknown'}`,
                      `Provider: ${connectedProviderConfig.name}`,
                      cloud?.lastError ? `Last error: ${cloud.lastError}` : '',
                    ].filter(Boolean).join('\n'),
                  })}
                  style={{ alignSelf: 'flex-start' }}
                >
                  <Bug size={14} />
                  Report a bug
                </Button>

                {/* Cloud channel override */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="cloud-channel-section">
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    Cloud channel
                  </span>
                  <p className={styles.groupDescription} style={{ margin: 0 }}>
                    Your cloud instance is on the {currentChannel} channel.
                    {currentChannel === 'beta'
                      ? ' Newer features, occasional rough edges.'
                      : ' Reliable and tested.'}
                  </p>
                  {!confirmChannelSwitch ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmChannelSwitch(true)}
                      disabled={updateStatus === 'checking' || updateStatus === 'applying' || updateStatus === 'restarting'}
                      style={{ alignSelf: 'flex-start' }}
                      data-testid="cloud-channel-toggle"
                    >
                      {currentChannel === 'beta' ? 'Switch to stable' : 'Switch to beta'}
                    </Button>
                  ) : (
                    <div className={styles.infoBanner} style={{
                      background: 'rgba(99, 102, 241, 0.06)',
                      borderColor: 'rgba(99, 102, 241, 0.2)',
                    }}>
                      <span className={styles.infoBannerText} style={{ flex: 1 }}>
                        {currentChannel === 'beta'
                          ? 'Back to solid ground? Switching to stable may roll back to an older version.'
                          : 'Ready for the bleeding edge? Newer features, occasional excitement.'}
                      </span>
                      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmChannelSwitch(false)}>
                          Cancel
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => { setConfirmChannelSwitch(false); handleChannelToggle(); }}
                          disabled={updateStatus === 'checking' || updateStatus === 'applying' || updateStatus === 'restarting'}
                        >
                          {(updateStatus === 'applying' || updateStatus === 'restarting') ? <Loader2 size={14} className="animate-spin" /> : null}
                          {currentChannel === 'beta' ? 'Switch to stable' : 'Switch to beta'}
                        </Button>
                      </div>
                    </div>
                  )}
                  {/* Inline status — shown right below the channel toggle so the user
                      sees progress/errors next to the button they just clicked, not in a
                      distant status row. */}
                  {(updateStatus === 'applying' || updateStatus === 'restarting') && (
                    <span
                      data-testid="cloud-channel-switch-progress"
                      style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      <Loader2 size={12} className="animate-spin" />
                      {updateStatus === 'restarting'
                        ? 'Restarting cloud instance. This may take a minute or two.'
                        : 'Switching channel. This may take up to a minute.'}
                    </span>
                  )}
                  {updateStatus === 'error' && updateError && (
                    <div
                      className={styles.infoBanner}
                      data-testid="cloud-channel-switch-error"
                      style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.25)' }}
                    >
                      <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-destructive)' }} />
                      <span className={styles.infoBannerText} style={{ color: 'var(--color-text-primary)' }}>
                        {/* Sanitize the raw error so a DOMException / internal string never reaches the user. */}
                        Channel switch didn&apos;t stick: {getUpdateCheckErrorDisplay(updateError, updateErrorCategory ?? undefined).text} You can try again.
                      </span>
                    </div>
                  )}
                </div>

                {/* Deprovision (auto-provisioned, any provider) */}
                {isAutoProvisioned && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="cloud-deprovision-section">
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                      {isManaged ? 'Remove Mindstone Cloud' : 'Destroy cloud instance'}
                    </span>
                    <p className={styles.groupDescription} style={{ margin: 0 }}>
                      {isManaged
                        ? 'Removes your Mindstone Cloud instance and disconnects all devices. Your local data is kept.'
                        : (
                          <>
                            Permanently deletes your {connectedProviderConfig.name} cloud instance and all data on it. This cannot be undone.
                            {' '}You can also clean up manually at{' '}
                            <a href={`https://${connectedProviderConfig.cleanupUrl}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}>
                              {connectedProviderConfig.cleanupUrl}
                            </a>.
                          </>
                        )}
                    </p>
                    <Button
                      variant={confirmDeprovision ? 'destructive' : 'outline'}
                      size="sm"
                      onClick={handleDeprovisionWithSync}
                      disabled={anyBusy || switchInProgress}
                      style={{ alignSelf: 'flex-start' }}
                      data-testid="cloud-deprovision-button"
                    >
                      <Trash2 size={14} />
                      {isManaged
                        ? (confirmDeprovision ? 'Yes, remove Mindstone Cloud' : 'Remove Mindstone Cloud')
                        : (confirmDeprovision ? 'Yes, destroy instance' : 'Destroy instance')}
                    </Button>
                  </div>
                )}

        </AdvancedTroubleshootingDrawer>
      )}

      {/* ====== SWITCH PROVIDER DIALOG ====== */}
      <Dialog open={showSwitchDialog} onOpenChange={setShowSwitchDialog}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {cloud?.provisionMode === 'managed'
                ? 'Switch to your own cloud provider'
                : 'Switch to Mindstone Cloud'}
            </DialogTitle>
            <DialogDescription>
              {cloud?.provisionMode === 'managed'
                ? 'Your data will be moved to your own infrastructure. Your Mindstone Cloud instance will be cleaned up afterward.'
                : `Your data will be moved to a managed Mindstone Cloud instance. Your current ${connectedProviderConfig.name} instance will be cleaned up afterward.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {/* Managed→BYOK: provider picker + token */}
            {cloud?.provisionMode === 'managed' && (
              <>
                <div className={styles.safetyLevelCards} role="radiogroup" aria-label="Cloud provider" style={{ marginBottom: 12 }}>
                  {visibleCloudProviders
                    .filter((p) => !p.managed && !p.hidden && (!p.featureFlag || !!effectiveDraftSettings[p.featureFlag]))
                    .map((provider) => (
                    <label
                      key={provider.id}
                      className={`${styles.safetyLevelCard} ${switchProviderSelection === provider.id ? styles.safetyLevelCardSelected : ''}`}
                    >
                      <input
                        type="radio"
                        name="switch-provider"
                        value={provider.id}
                        checked={switchProviderSelection === provider.id}
                        onChange={() => { setSwitchProviderSelection(provider.id); setSwitchTokenInput(''); }}
                      />
                      <div className={styles.safetyLevelCardHeader}>
                        <span className={styles.safetyLevelCardTitle}>{provider.name}</span>
                      </div>
                      <p className={styles.safetyLevelCardDescription}>{provider.costBlurb}</p>
                    </label>
                  ))}
                </div>

                {/*
                  Compact "More soon" note — mirrors the signpost on the
                  main provider picker but at dialog density (no tile, no
                  grid, just an inline muted sentence) since this modal is
                  narrow.
                */}
                <div
                  role="note"
                  data-testid="cloud-provider-coming-soon-switch"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    margin: '0 0 12px 0',
                    fontSize: '0.8rem',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  <Sparkles size={12} aria-hidden="true" />
                  <span>More providers coming soon.</span>
                </div>

                {switchProviderSelection === 'digitalocean' && doOAuthStatus.connected && (
                  <div className={styles.infoBanner} style={{ background: 'rgba(34, 197, 94, 0.08)', borderColor: 'rgba(34, 197, 94, 0.25)' }}>
                    <CheckCircle size={14} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                    <span className={styles.infoBannerText} style={{ color: 'var(--color-success)' }}>
                      Connected as {doOAuthStatus.accountEmail ?? 'your DigitalOcean account'}
                    </span>
                  </div>
                )}

                <SettingRow
                  label={getProviderConfig(switchProviderSelection).tokenLabel ?? 'API token'}
                  variant="stacked"
                  htmlFor="switch-token"
                >
                  <Input
                    id="switch-token"
                    type="password"
                    value={switchTokenInput}
                    onChange={(e) => setSwitchTokenInput(e.target.value)}
                    placeholder={getProviderConfig(switchProviderSelection).tokenPlaceholder ?? 'Paste your API token'}
                  />
                </SettingRow>
              </>
            )}

            {/* Workspace limitation warning */}
            <div className={styles.infoBanner} style={{
              background: 'rgba(245, 158, 11, 0.06)',
              borderColor: 'rgba(245, 158, 11, 0.15)',
              marginTop: cloud?.provisionMode === 'managed' ? 12 : 0,
            }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, color: 'var(--color-warning)' }} />
              <span className={styles.infoBannerText} style={{ fontSize: '0.8rem' }}>
                Workspace files larger than 7 MB or binary files stored only in your current cloud may not transfer.
                Conversations and text files will be moved.
              </span>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowSwitchDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={() => { void handleSwitchProvider(); }}
              disabled={
                cloud?.provisionMode === 'managed'
                && !switchTokenInput.trim()
                && !(switchProviderSelection === 'digitalocean' && doOAuthStatus.connected)
              }
            >
              {cloud?.provisionMode === 'managed' ? 'Switch' : 'Switch to Mindstone Cloud'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConnectorSetupDialog
        guidance={connectorSetupGuidance.guidance}
        open={connectorSetupGuidance.isOpen}
        onOpenChange={connectorSetupGuidance.setOpen}
      />
    </>
  );
};
