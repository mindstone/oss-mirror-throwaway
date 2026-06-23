// Star topology: this hook MUST NOT import other cloud hooks.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, CloudInstanceConfig } from '@shared/types';
import { suggestTier, type TierSuggestionResult } from '@core/services/cloud/tierSuggestionEngine';
import type { CloudPressureState } from '@shared/types/cloudHealth';

const POLL_INTERVAL_MS = 60_000;
const BYTES_PER_GIB = 1024 ** 3;
/** Debounce window for showing the pressure banner (one full poll cycle). */
const PRESSURE_DEBOUNCE_MS = POLL_INTERVAL_MS;
/** 24-hour window for counting recent OOM events. */
const PRESSURE_OOM_WINDOW_MS = 24 * 60 * 60 * 1000;

type StorageThresholdState = 'calm' | 'mention' | 'warning' | 'urgent';

export type VolumeStatusOutcome =
  | {
    kind: 'ok';
    sizeGb: number;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    lastCheckedAt: number;
  }
  | {
    kind: 'cloud_unreachable';
    sizeGb?: number;
    reason?: 'endpoint_missing' | 'network';
    error: string;
    lastCheckedAt: number;
    lastKnown?: LastKnownVolumeStatus;
  }
  | { kind: 'fly_token_missing' }
  | { kind: 'not_applicable'; reason: 'managed' | 'non_fly' | 'not_byok' | 'not_connected' };

export type OkVolumeStatus = Extract<VolumeStatusOutcome, { kind: 'ok' }>;
export type LastKnownVolumeStatus = Omit<OkVolumeStatus, 'kind'>;

export interface ResizeVolumeResult {
  success: boolean;
  applied?: boolean;
  healthVerified?: boolean;
  sizeVerified?: boolean;
  sizeGbBefore?: number;
  sizeGbAfter?: number;
  settingsPersisted?: boolean;
  error?: string;
  helpKey?: 'billing_required' | 'capacity' | 'in_flight_conflict';
}

export interface TierChangeSuccessNotice {
  tierLabel: string;
}

export type ResizeVolumeUiState =
  | { kind: 'idle' }
  | { kind: 'in_flight'; targetSizeGb: number }
  | { kind: 'success'; result: ResizeVolumeResult }
  | { kind: 'failure'; result: ResizeVolumeResult };

export type TierChangeUiState =
  | { kind: 'idle' }
  | { kind: 'post_apply_verification_failed' };

export type UpdateRoot = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

/** A single pressure observation from cloudInstance settings (shape written by Stage D). */
type PressureSettingsEvent = NonNullable<CloudInstanceConfig['recentPressureEvents']>[number];

/** What the banner shows (or whether it shows at all). */
export type PressureBannerKind = 'none' | 'warning' | 'critical';

/** Pressure-banner state exposed to CloudTab. */
export interface PressureBanner {
  kind: PressureBannerKind;
  /** OOM restart count in the last 24 h (for `{restartCountText}` in the critical copy). */
  recentOomCount: number;
  /** Stage C tier suggestion, or null when no suggestion is actionable. */
  suggestion: TierSuggestionResult | null;
}

/** Records the dismissal context so the banner can re-surface on new events. */
type PressureDismissalScope = {
  pressureState: CloudPressureState;
  /** Timestamp of the most recent OOM event at dismissal time (0 = no OOM events).
   *  Re-show if any event with a LATER timestamp arrives — immune to event aging. */
  lastOomEventAt: number;
  /** Suggestion fingerprint at time of dismissal — re-show on a new suggestion. */
  suggestionKey: string;
};

export interface UseCloudCapacityParams {
  cloudInstance: CloudInstanceConfig | undefined;
  enabled: boolean;
  updateDraft: UpdateRoot;
}

export function useCloudCapacity({
  cloudInstance,
  enabled,
  updateDraft,
}: UseCloudCapacityParams) {
  const [volume, setVolume] = useState<VolumeStatusOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [resizeState, setResizeState] = useState<ResizeVolumeUiState>({ kind: 'idle' });
  const [tierChangeState, setTierChangeState] = useState<TierChangeUiState>({ kind: 'idle' });
  const [lastTierChangeSuccess, setLastTierChangeSuccess] = useState<TierChangeSuccessNotice | null>(null);

  // ── Pressure state ──────────────────────────────────────────────────────────
  const [rawPressureState, setRawPressureState] = useState<CloudPressureState>(
    cloudInstance?.lastPressureState ?? 'ok',
  );
  /** Debounced: only transitions to non-ok after one full poll cycle of confirmation. */
  const [confirmedPressureState, setConfirmedPressureState] = useState<CloudPressureState>(() => {
    const state = cloudInstance?.lastPressureState;
    const checkedAt = cloudInstance?.lastPressureCheckedAt;
    if (!state || state === 'ok' || state === 'unknown') return 'ok';
    if (checkedAt && Date.now() - checkedAt >= PRESSURE_DEBOUNCE_MS) return state;
    return 'ok';
  });
  const [pressureEvents, setPressureEvents] = useState<PressureSettingsEvent[]>(
    cloudInstance?.recentPressureEvents ?? [],
  );
  const [dismissalScope, setDismissalScope] = useState<PressureDismissalScope | null>(null);
  const confirmedPressureStateRef = useRef(confirmedPressureState);
  const pressureEventsRef = useRef(pressureEvents);
  const pressureDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressureBannerShownAtRef = useRef<number | null>(null);
  const lastShownBannerToneRef = useRef<'warning' | 'critical' | null>(null);
  // ────────────────────────────────────────────────────────────────────────────

  const mountedRef = useRef(false);
  const lastKnownVolumeRef = useRef<LastKnownVolumeStatus | null>(null);
  const cloudInstanceRef = useRef(cloudInstance);
  const flyVolumeSizeGbRef = useRef(cloudInstance?.flyVolumeSizeGb);
  const updateDraftRef = useRef(updateDraft);
  const pollingRef = useRef(false);
  const pollPromiseRef = useRef<Promise<VolumeStatusOutcome | null> | null>(null);

  const cachedVolume = useMemo(() => {
    if (
      typeof cloudInstance?.flyVolumeSizeGb !== 'number'
      || typeof cloudInstance.lastVolumeUsedBytes !== 'number'
      || typeof cloudInstance.lastVolumeAvailableBytes !== 'number'
    ) {
      return null;
    }
    const totalBytes = cloudInstance.lastVolumeUsedBytes + cloudInstance.lastVolumeAvailableBytes;
    const cached = {
      kind: 'ok' as const,
      sizeGb: cloudInstance.flyVolumeSizeGb,
      totalBytes,
      usedBytes: cloudInstance.lastVolumeUsedBytes,
      availableBytes: cloudInstance.lastVolumeAvailableBytes,
      lastCheckedAt: cloudInstance.lastVolumeUsageCheckedAt ?? 0,
    };
    return normalizeOkVolume(cached);
  }, [
    cloudInstance?.flyVolumeSizeGb,
    cloudInstance?.lastVolumeAvailableBytes,
    cloudInstance?.lastVolumeUsageCheckedAt,
    cloudInstance?.lastVolumeUsedBytes,
  ]);

  const resizeResult = useMemo(() => {
    if (resizeState.kind === 'success' || resizeState.kind === 'failure') {
      return resizeState.result;
    }
    return null;
  }, [resizeState]);

  const lastKnownVolume = useMemo(() => {
    if (volume?.kind === 'ok') return toLastKnownVolume(volume);
    if (volume?.kind === 'cloud_unreachable' && volume.lastKnown) return volume.lastKnown;
    return lastKnownVolumeRef.current ?? (cachedVolume ? toLastKnownVolume(cachedVolume) : null);
  }, [cachedVolume, volume]);

  useEffect(() => {
    cloudInstanceRef.current = cloudInstance;
    flyVolumeSizeGbRef.current = cloudInstance?.flyVolumeSizeGb;
  }, [cloudInstance]);

  useEffect(() => {
    updateDraftRef.current = updateDraft;
  }, [updateDraft]);

  const cachedVolumeRef = useRef(cachedVolume);
  useEffect(() => {
    cachedVolumeRef.current = cachedVolume;
  }, [cachedVolume]);

  const persistDraftCache = useCallback((outcome: VolumeStatusOutcome) => {
    const currentCloudInstance = cloudInstanceRef.current;
    if (!currentCloudInstance || outcome.kind !== 'ok') return;
    const hasSameVolumeSnapshot =
      currentCloudInstance.flyVolumeSizeGb === outcome.sizeGb
      && currentCloudInstance.lastVolumeUsedBytes === outcome.usedBytes
      && currentCloudInstance.lastVolumeAvailableBytes === outcome.availableBytes;
    if (hasSameVolumeSnapshot) return;
    updateDraftRef.current('cloudInstance', {
      ...currentCloudInstance,
      flyVolumeSizeGb: outcome.sizeGb,
      lastVolumeUsedBytes: outcome.usedBytes,
      lastVolumeAvailableBytes: outcome.availableBytes,
      lastVolumeUsageCheckedAt: outcome.lastCheckedAt,
    });
  }, []);

  const pollNow = useCallback(async () => {
    if (!enabled) return null;
    if (pollingRef.current) return pollPromiseRef.current;
    pollingRef.current = true;
    setLoading(true);
    const pollPromise = (async () => {
      try {
        const result = normalizeVolumeOutcome(
          await window.cloudApi.getVolumeStatus(),
          lastKnownVolumeRef.current,
        );
        if (result.kind === 'ok') {
          lastKnownVolumeRef.current = toLastKnownVolume(result);
          emitThresholdState(result);
        }
        setVolume(result);
        persistDraftCache(result);
        return result;
      } catch (err) {
        const result: VolumeStatusOutcome = {
          kind: 'cloud_unreachable',
          reason: 'network',
          sizeGb: flyVolumeSizeGbRef.current,
          error: err instanceof Error ? err.message : String(err),
          lastCheckedAt: Date.now(),
          lastKnown: lastKnownVolumeRef.current ?? undefined,
        };
        emitCloudCapacityIssue('cloud-storage-poll-failed', {
          reason: 'ipc_or_renderer_error',
          hasLastKnown: Boolean(result.lastKnown),
        });
        setVolume(result);
        return result;
      } finally {
        pollingRef.current = false;
        pollPromiseRef.current = null;
        setLoading(false);
      }
    })();
    pollPromiseRef.current = pollPromise;
    return pollPromise;
  }, [enabled, persistDraftCache]);

  const resize = useCallback(async (targetSizeGb: number) => {
    if (!enabled) {
      const result: ResizeVolumeResult = {
        success: false,
        applied: false,
        error: 'Storage controls are unavailable for this cloud instance.',
      };
      setResizeState({ kind: 'failure', result });
      return result;
    }
    setResizing(true);
    setResizeState({ kind: 'in_flight', targetSizeGb });
    try {
      const result = await window.cloudApi.resizeVolume({ targetSizeGb });
      setResizeState(result.success ? { kind: 'success', result } : { kind: 'failure', result });
      if (result.success) {
        await pollNow();
      }
      return result;
    } catch (err) {
      const result: ResizeVolumeResult = {
        success: false,
        applied: false,
        error: err instanceof Error ? err.message : String(err),
      };
      emitCloudCapacityIssue('cloud-storage-resize-failed', {
        reason: 'ipc_or_renderer_error',
        targetSizeGb,
      });
      setResizeState({ kind: 'failure', result });
      return result;
    } finally {
      setResizing(false);
    }
  }, [enabled, pollNow]);

  const setResizeResult = useCallback((result: ResizeVolumeResult | null) => {
    if (!result) {
      setResizeState({ kind: 'idle' });
      return;
    }
    setResizeState(result.success ? { kind: 'success', result } : { kind: 'failure', result });
  }, []);

  /** Internal: applies a pressure observation and manages the debounce timer. */
  const handlePressureUpdate = useCallback((
    state: CloudPressureState,
    events: PressureSettingsEvent[],
    observedAt: number,
  ) => {
    setPressureEvents(events);
    pressureEventsRef.current = events;

    // Cancel any in-flight debounce
    if (pressureDebounceTimerRef.current) {
      clearTimeout(pressureDebounceTimerRef.current);
      pressureDebounceTimerRef.current = null;
    }

    if (state === 'ok' || state === 'unknown') {
      // Pressure resolved — confirm immediately
      confirmedPressureStateRef.current = state;
      setRawPressureState(state);
      setConfirmedPressureState(state);
      return;
    }

    setRawPressureState(state);

    // Already confirmed at a non-ok level → update immediately (e.g. warning→critical)
    const prevConfirmed = confirmedPressureStateRef.current;
    if (prevConfirmed !== 'ok' && prevConfirmed !== 'unknown') {
      confirmedPressureStateRef.current = state;
      setConfirmedPressureState(state);
      return;
    }

    // First non-ok observation: debounce for one full poll cycle
    const msSinceObservation = Math.max(0, Date.now() - observedAt);
    const remainingMs = Math.max(0, PRESSURE_DEBOUNCE_MS - msSinceObservation);
    const stateToConfirm = state;
    pressureDebounceTimerRef.current = setTimeout(() => {
      pressureDebounceTimerRef.current = null;
      confirmedPressureStateRef.current = stateToConfirm;
      setConfirmedPressureState(stateToConfirm);
    }, remainingMs);
  }, []);

  const recordTierChangeSuccess = useCallback((tierLabel: string) => {
    setTierChangeState({ kind: 'idle' });
    setLastTierChangeSuccess({ tierLabel });
  }, []);

  const recordTierChangeVerificationFailure = useCallback(() => {
    setLastTierChangeSuccess(null);
    setTierChangeState({ kind: 'post_apply_verification_failed' });
    emitCloudCapacityIssue('cloud-tier-post-apply-verification-failed', {
      reason: 'health_unverified',
    });
  }, []);

  const dismissTierChangeNotice = useCallback(() => {
    setLastTierChangeSuccess(null);
    setTierChangeState({ kind: 'idle' });
  }, []);

  const dismissTierChangeVerificationFailure = useCallback(() => {
    setTierChangeState({ kind: 'idle' });
  }, []);

  /** Dismiss the pressure banner for the current event scope. Re-shows on escalation or new events. */
  const dismissPressureNotice = useCallback(() => {
    const state = confirmedPressureStateRef.current;
    if (state === 'ok' || state === 'unknown') return;
    const now = Date.now();
    const events = pressureEventsRef.current;
    const tierId = cloudInstanceRef.current?.vmTierId;
    const suggestion = computeSuggestionFromEvents(tierId, events, now);
    const oomEvents = events.filter((e) => e.oom);
    const lastOomEventAt = oomEvents.length > 0 ? Math.max(...oomEvents.map((e) => e.at)) : 0;
    const scope: PressureDismissalScope = {
      pressureState: state,
      lastOomEventAt,
      suggestionKey: getSuggestionKey(suggestion),
    };
    setDismissalScope(scope);
    const shownAt = pressureBannerShownAtRef.current;
    emitCloudCapacityIssue('cloud_pressure_banner_dismissed', {
      tone: state === 'critical' ? 'critical' : 'warning',
      after_seconds: shownAt ? Math.round((now - shownAt) / 1000) : 0,
    });
  }, []);

  useEffect(() => {
    if (cachedVolume) {
      lastKnownVolumeRef.current = toLastKnownVolume(cachedVolume);
    }
  }, [cachedVolume]);

  useEffect(() => {
    if (!enabled) {
      setVolume(null);
      mountedRef.current = false;
      return;
    }
    if (!mountedRef.current && cachedVolumeRef.current) {
      setVolume(cachedVolumeRef.current);
    }
    mountedRef.current = true;
    void pollNow();
  }, [enabled, pollNow]);

  useEffect(() => {
    if (!enabled) return undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') {
        void pollNow();
      }
    };
    const interval = window.setInterval(tick, POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void pollNow();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, pollNow]);

  // ── Pressure effects ────────────────────────────────────────────────────────

  // Keep confirmedPressureStateRef in sync so callbacks read current value without re-creating.
  useEffect(() => {
    confirmedPressureStateRef.current = confirmedPressureState;
  }, [confirmedPressureState]);

  // Keep pressureEventsRef in sync for callbacks.
  useEffect(() => {
    pressureEventsRef.current = pressureEvents;
  }, [pressureEvents]);

  // Sync pressure state from cloudInstance settings (covers initial mount + settings refreshes).
  useEffect(() => {
    handlePressureUpdate(
      cloudInstance?.lastPressureState ?? 'ok',
      cloudInstance?.recentPressureEvents ?? [],
      cloudInstance?.lastPressureCheckedAt ?? Date.now(),
    );
  }, [
    cloudInstance?.lastPressureState,
    cloudInstance?.lastPressureCheckedAt,
    cloudInstance?.recentPressureEvents,
    handlePressureUpdate,
  ]);

  // Subscribe to cloud:pressure-state push channel for between-poll updates.
  useEffect(() => {
    if (!cloudInstance) return undefined;
    const unsub = window.cloudApi?.onPressureState?.((data) => {
      handlePressureUpdate(
        data.state,
        data.recentPressureEvents ?? [],
        data.timestamp,
      );
    });
    return () => unsub?.();
  }, [cloudInstance, handlePressureUpdate]);

  // Cleanup debounce timer on unmount.
  useEffect(() => () => {
    if (pressureDebounceTimerRef.current) {
      clearTimeout(pressureDebounceTimerRef.current);
    }
  }, []);

  // ────────────────────────────────────────────────────────────────────────────

  /** Derived pressure banner state (debounced, dismissal-scoped). */
  const pressureBanner: PressureBanner = useMemo(() => {
    if (confirmedPressureState === 'ok' || confirmedPressureState === 'unknown') {
      return { kind: 'none', recentOomCount: 0, suggestion: null };
    }

    const now = Date.now();
    const recentOomCount = countRecentOom(pressureEvents, now);
    const suggestion = computeSuggestionFromEvents(cloudInstance?.vmTierId, pressureEvents, now);

    // Check dismissal scope — re-surface on severity escalation, new OOM, or new suggestion.
    if (dismissalScope) {
      const sevNow = confirmedPressureState === 'critical' ? 1 : 0;
      const sevDismissed = dismissalScope.pressureState === 'critical' ? 1 : 0;
      const severityEscalated = sevNow > sevDismissed;
      // Compare by timestamp so OOM event aging never suppresses re-show.
      const currentLastOomAt = pressureEvents
        .filter((e) => e.oom)
        .reduce((max, e) => Math.max(max, e.at), 0);
      const newOom = currentLastOomAt > dismissalScope.lastOomEventAt;
      const newSuggestion = getSuggestionKey(suggestion) !== dismissalScope.suggestionKey;

      if (!severityEscalated && !newOom && !newSuggestion) {
        return { kind: 'none', recentOomCount, suggestion };
      }
    }

    return {
      kind: confirmedPressureState === 'critical' ? 'critical' : 'warning',
      recentOomCount,
      suggestion,
    };
  }, [confirmedPressureState, pressureEvents, dismissalScope, cloudInstance?.vmTierId]);

  // Telemetry: banner_shown / resolved transitions.
  useEffect(() => {
    const prev = pressureBannerShownAtRef.current;
    if (pressureBanner.kind !== 'none' && prev === null) {
      pressureBannerShownAtRef.current = Date.now();
      lastShownBannerToneRef.current = pressureBanner.kind;
      emitCloudCapacityIssue('cloud_pressure_banner_shown', {
        tone: pressureBanner.kind,
        current_tier: cloudInstance?.vmTierId,
        suggested_tier:
          pressureBanner.suggestion?.kind === 'suggestion'
            ? pressureBanner.suggestion.tierId
            : null,
      });
    } else if (pressureBanner.kind === 'none' && prev !== null) {
      pressureBannerShownAtRef.current = null;
      emitCloudCapacityIssue('cloud_pressure_resolved', {
        previous_tone: lastShownBannerToneRef.current ?? 'warning',
        after_minutes: Math.round((Date.now() - prev) / 60_000),
      });
    }
  }, [pressureBanner.kind, pressureBanner.suggestion, cloudInstance?.vmTierId]);

  return {
    volume: volume ?? cachedVolume,
    loading,
    resizing,
    resizeResult,
    resizeState,
    tierChangeState,
    lastTierChangeSuccess,
    lastKnownVolume,
    pressureBanner,
    setResizeResult,
    recordTierChangeSuccess,
    recordTierChangeVerificationFailure,
    dismissTierChangeNotice,
    dismissTierChangeVerificationFailure,
    dismissPressureNotice,
    pollNow,
    resize,
  };
}

// ── Pressure helpers ──────────────────────────────────────────────────────────

function computeSuggestionFromEvents(
  tierId: string | undefined,
  events: PressureSettingsEvent[],
  nowMs: number,
): TierSuggestionResult | null {
  if (!tierId) return null;
  return suggestTier({
    currentTierId: tierId,
    recentPressureEvents: events.map((e) => ({
      timestampMs: e.at,
      pressure_state: e.state,
      oomRecent: e.oom,
    })),
    machineSpecMb: 0, // unused by the current suggestTier implementation
    nowMs,
  });
}

function countRecentOom(events: PressureSettingsEvent[], nowMs: number): number {
  const windowStart = nowMs - PRESSURE_OOM_WINDOW_MS;
  return events.filter((e) => e.oom && e.at >= windowStart).length;
}

function getSuggestionKey(suggestion: TierSuggestionResult | null): string {
  if (!suggestion) return 'null';
  if (suggestion.kind === 'suggestion') return `suggestion:${suggestion.tierId}`;
  return suggestion.kind;
}

// ─────────────────────────────────────────────────────────────────────────────

function toLastKnownVolume(volume: OkVolumeStatus): LastKnownVolumeStatus {
  return {
    sizeGb: volume.sizeGb,
    totalBytes: volume.totalBytes,
    usedBytes: volume.usedBytes,
    availableBytes: volume.availableBytes,
    lastCheckedAt: volume.lastCheckedAt,
  };
}

function getThresholdState(volume: OkVolumeStatus): StorageThresholdState {
  const ratio = volume.totalBytes > 0 ? volume.usedBytes / volume.totalBytes : 0;
  if (ratio >= 0.95) return 'urgent';
  if (ratio >= 0.8) return 'warning';
  if (ratio >= 0.5) return 'mention';
  return 'calm';
}

function normalizeVolumeOutcome(
  outcome: VolumeStatusOutcome,
  lastKnown: LastKnownVolumeStatus | null,
): VolumeStatusOutcome {
  if (outcome.kind === 'ok') return normalizeOkVolume(outcome);
  if (outcome.kind === 'cloud_unreachable' && lastKnown && !outcome.lastKnown) {
    return { ...outcome, lastKnown };
  }
  return outcome;
}

function normalizeOkVolume(outcome: OkVolumeStatus): OkVolumeStatus {
  const totalBytes = Math.max(0, outcome.totalBytes);
  const rawUsedBytes = Math.max(0, outcome.usedBytes);
  const usedExceededTotal = rawUsedBytes > totalBytes;
  const usedBytes = Math.min(rawUsedBytes, totalBytes);
  const availableBytes = Math.max(0, totalBytes - usedBytes);

  if (usedExceededTotal) {
    emitCloudCapacityIssue('cloud-storage-usage-exceeded-total', {
      reason: 'storage_usage_counter_diverged',
      thresholdState: getThresholdState({
        ...outcome,
        totalBytes,
        usedBytes,
        availableBytes,
      }),
      sizeGb: outcome.sizeGb,
      totalGiBRounded: Math.round(totalBytes / BYTES_PER_GIB),
    });
  }

  return {
    ...outcome,
    totalBytes,
    usedBytes,
    availableBytes,
  };
}

function emitThresholdState(volume: OkVolumeStatus): void {
  globalThis.window?.api?.logEvent?.({
    level: 'info',
    message: 'Cloud storage threshold state polled',
    timestamp: Date.now(),
    context: {
      area: 'cloud-capacity',
      thresholdState: getThresholdState(volume),
      sizeGb: volume.sizeGb,
    },
    source: 'renderer',
  });
}

function emitCloudCapacityIssue(message: string, context: Record<string, unknown>): void {
  const payload = {
    message,
    level: 'warning' as const,
    context: {
      area: 'cloud-capacity',
      ...context,
    },
  };
  const capture = globalThis.window?.miscApi?.captureMessage;
  if (typeof capture === 'function') {
    void capture(payload).catch(() => {
      globalThis.window?.api?.logEvent?.({
        level: 'warn',
        message,
        timestamp: Date.now(),
        context: payload.context,
        source: 'renderer',
      });
    });
    return;
  }

  globalThis.window?.api?.logEvent?.({
    level: 'warn',
    message,
    timestamp: Date.now(),
    context: payload.context,
    source: 'renderer',
  });
}
