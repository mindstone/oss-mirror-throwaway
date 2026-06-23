// Star topology: this hook MUST NOT import other cloud hooks.

/**
 * useCloudProvisioning
 *
 * Manages provisioning, deprovisioning, provider switch, DigitalOcean OAuth,
 * Fly token linking, cloud updates, instance discovery, conflict resolution,
 * and infrastructure repair (ingress, token).
 *
 * Module-level state (_updateRestarting, _updateAbortController) survives
 * component unmount/remount for long-running update operations.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  classifyUpdatePhase,
  type ClassifyInput,
  type UpdateProgressDetail,
} from '@core/services/cloudUpdateProgress';
import type { CloudInstanceConfig, AppSettings } from '@shared/types';
import { useProvisioningProgress } from './useProvisioningProgress';
import { useConnectorSetupGuidance } from './useConnectorSetupGuidance';
import { beginExternalMigration, endExternalMigration } from './migrationProgressCoordinator';
import { getProviderConfig, type CloudProviderUIConfig } from '../cloudProviders.config';
import { mapCloudError, type CloudErrorInfo } from '../../../../core/services/cloudErrorMapper';
import { detectNearestRegion, type CloudHealthInfo } from '../components/tabs/cloudTabUtils';
import { categorize, type CloudErrorCategory } from '@core/services/cloud/cloudErrorCategory';
import { withRendererTimeout } from '@renderer/utils/withRendererTimeout';
import {
  DEFAULT_VOLUME_SIZE_GB,
  recommendVolumeGb,
} from '../../../../core/services/cloud/providers/volumeDefaults';
import type { FootprintOutcome } from '@shared/cloudMigrationTypes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateRoot = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

type CloudUpdateStatus = 'idle' | 'checking' | 'up_to_date' | 'update_available' | 'applying' | 'restarting' | 'updated' | 'error' | 'rate_limited';

interface DigitalOceanOAuthStatus {
  connected: boolean;
  accountEmail?: string;
  expiresAt?: number;
}

export interface ProvisionResult {
  success: boolean;
  cloudUrl?: string;
  cloudToken?: string;
}

export interface UseCloudProvisioningParams {
  draftSettings: AppSettings;
  cloudInstance: CloudInstanceConfig | undefined;
  updateDraft: UpdateRoot;
  isConnected: boolean;
  isFlyByok: boolean;
  isAutoProvisioned: boolean;
  isManaged: boolean;
  cloudHealth: CloudHealthInfo | null;
  setCloudHealth: (v: CloudHealthInfo | null) => void;
}

const DO_OAUTH_POLL_INTERVAL_MS = 2_000;
const DO_OAUTH_POLL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Module-level update state — survives component unmount/remount.
// ---------------------------------------------------------------------------

let _updateRestarting = false;
let _updateAbortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCloudProvisioning({
  draftSettings,
  cloudInstance: cloud,
  updateDraft,
  isConnected: _isConnected,
  isFlyByok,
  isAutoProvisioned: _isAutoProvisioned,
  isManaged,
  cloudHealth: _cloudHealth,
  setCloudHealth,
}: UseCloudProvisioningParams) {
  const buildChannel = (window as unknown as Record<string, unknown>).electronEnv
    ? ((window as unknown as Record<string, unknown>).electronEnv as Record<string, unknown>)?.buildChannel as string | undefined
    : undefined;
  const defaultChannel = buildChannel === 'stable' ? 'stable' : 'beta';
  const currentChannel = draftSettings.cloudUpdateChannel ?? defaultChannel;

  // Provider selection
  const [selectedProvider, setSelectedProvider] = useState<CloudProviderUIConfig['id']>(
    draftSettings.managedCloudEnabled ? 'mindstone' : 'fly',
  );
  const [showByokPicker, setShowByokPicker] = useState(false);

  // Sync selectedProvider when entitlement arrives after mount
  useEffect(() => {
    if (draftSettings.managedCloudEnabled && selectedProvider !== 'mindstone' && !showByokPicker) {
      setSelectedProvider('mindstone');
    }
  }, [draftSettings.managedCloudEnabled]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting selectedProvider/showByokPicker so local provider-picker changes do not force Mindstone selection

  const [providerTokenInput, setProviderTokenInput] = useState('');
  const [showManualSetup, setShowManualSetup] = useState(false);
  const [showTokenHelp, setShowTokenHelp] = useState(false);
  const providerConfig = getProviderConfig(selectedProvider);

  // DigitalOcean OAuth
  const [doOAuthStatus, setDoOAuthStatus] = useState<DigitalOceanOAuthStatus>({ connected: false });
  const [doOAuthLoading, setDoOAuthLoading] = useState(false);
  const [showPatFallback, setShowPatFallback] = useState(false);
  const connectorSetupGuidance = useConnectorSetupGuidance();

  // Provisioning
  const [provisionBusy, setProvisionBusy] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(() => detectNearestRegion());
  const [provisionError, setProvisionError] = useState<CloudErrorInfo | null>(null);
  const [_provisionWarning, setProvisionWarning] = useState<string | null>(null);
  /**
   * User-facing note from a failed provision describing whether we rolled
   * back the partial app on the provider. Surfaced under the error banner
   * so users know if anything is left to clean up / bill for.
   */
  const [provisionCleanupMessage, setProvisionCleanupMessage] = useState<string | null>(null);
  const { progress: provisionProgress, reset: resetProvisionProgress } = useProvisioningProgress();
  const doReconnectNeeded = selectedProvider === 'digitalocean'
    && !!provisionError?.technicalDetail
    && /expired|reconnect/i.test(provisionError.technicalDetail);

  // Deprovisioning
  const [confirmDeprovision, setConfirmDeprovision] = useState(false);

  // Provider switch
  const [switchInProgress, setSwitchInProgress] = useState(false);
  const [switchError, setSwitchError] = useState<{ error: string; failedStep?: string } | null>(null);
  const [showSwitchDialog, setShowSwitchDialog] = useState(false);
  const [switchProviderSelection, setSwitchProviderSelection] = useState<CloudProviderUIConfig['id']>('fly');
  const [switchTokenInput, setSwitchTokenInput] = useState('');
  const [switchCleanupWarning, setSwitchCleanupWarning] = useState<string | null>(null);

  // Fly token linking
  const [flyLinkTokenInput, setFlyLinkTokenInput] = useState('');
  const [flyLinkBusy, setFlyLinkBusy] = useState(false);
  const [flyLinkError, setFlyLinkError] = useState<string | null>(null);

  // Whether a Fly API token is stored locally (in safeStorage). null = unknown / loading.
  // Used to surface the "Connect Fly token" form when BYOK metadata is present but the
  // token itself is missing (e.g. instance was provisioned by an older build that didn't
  // persist the token, or token was cleared by a partial deprovision/repair).
  const [hasFlyToken, setHasFlyToken] = useState<boolean | null>(null);

  // Ingress repair
  const [flyDiagnostic, setFlyDiagnostic] = useState<{ reachable?: boolean; authenticated?: boolean; hasPublicIp?: boolean } | null>(null);
  const [repairIngressBusy, setRepairIngressBusy] = useState(false);
  const [repairIngressResult, setRepairIngressResult] = useState<string | null>(null);
  const [repairIngressError, setRepairIngressError] = useState<string | null>(null);

  // Token repair
  const [repairTokenBusy, setRepairTokenBusy] = useState(false);
  const [repairTokenResult, setRepairTokenResult] = useState<string | null>(null);
  const [repairTokenError, setRepairTokenError] = useState<string | null>(null);
  const [repairTokenConflict, setRepairTokenConflict] = useState(false);

  // Fly API token repair (bootstraps cloud-side self-update for legacy instances)
  const [repairFlyTokenBusy, setRepairFlyTokenBusy] = useState(false);
  const [repairFlyTokenResult, setRepairFlyTokenResult] = useState<string | null>(null);
  const [repairFlyTokenError, setRepairFlyTokenError] = useState<string | null>(null);

  // Cloud updates
  const [updateStatus, setUpdateStatus] = useState<CloudUpdateStatus>('idle');
  const [updateLatestTag, setUpdateLatestTag] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // Categorized form of `updateError`, so the renderer can sanitize it (and treat
  // a cold-boot network abort/timeout as a soft "still starting" signal instead of
  // a scary raw error). Stored alongside the raw string — raw is kept for logs.
  const [updateErrorCategory, setUpdateErrorCategory] = useState<CloudErrorCategory | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgressDetail | null>(null);
  const [confirmChannelSwitch, setConfirmChannelSwitch] = useState(false);

  // Discovery / conflict
  const [discoveryResult, setDiscoveryResult] = useState<{
    // `error` is "could not check" (non-404 / fetch-fail from
    // checkManagedInstance) vs a clean `exists:false` ("confirmed gone").
    // The IPC response already carries it (channels/cloud.ts) — without it in
    // this local type, a failed discovery looks identical to "confirmed gone",
    // which is the billing-honesty bug C-F1 fixes. (additive, no IPC change)
    managed: { exists: boolean; cloudUrl?: string; error?: string };
    byok: { exists: boolean; healthy: boolean; cloudUrl?: string; providerId?: string };
    conflict: boolean;
    activeInSettings: 'managed' | 'byok' | 'none';
  } | null>(null);
  const [conflictResolving, setConflictResolving] = useState(false);
  const [conflictResolveError, setConflictResolveError] = useState<string | null>(null);
  const lastConflictKeepRef = useRef<'managed' | 'byok' | null>(null);

  // Orphaned managed instance: the backend still has a running Mindstone Cloud
  // instance, but local settings point nowhere (e.g. after a "Forget on this
  // device"). Re-provisioning is blocked by the backend ("Instance already
  // exists"), so we offer an explicit reconnect / destroy recovery instead.
  const [reattachBusy, setReattachBusy] = useState(false);
  const [reattachError, setReattachError] = useState<string | null>(null);
  /**
   * C-F1 (billing honesty): set true when the last orphan-destroy attempt did
   * NOT positively confirm the remote instance was removed — i.e. the remote
   * DELETE failed (`success:false`) AND the follow-up discovery could not
   * confirm the instance is gone (either `managed.exists` is still true, or it
   * came back `exists:false` but WITH an `error` = "could not check", not a
   * clean 404). A `local-only-remote-uncertain` deprovision result is a local
   * no-op for an already-Forgotten orphan and is NEVER treated as proof the
   * remote was destroyed. While this is true we keep the recovery banner
   * visible so the orphan that may still be billing stays surfaced. Reset on a
   * confirmed removal.
   */
  const [lastDestroyUnconfirmed, setLastDestroyUnconfirmed] = useState(false);
  const orphanedManaged = Boolean(
    lastDestroyUnconfirmed ||
      (discoveryResult?.managed.exists &&
        discoveryResult.activeInSettings === 'none' &&
        !discoveryResult.conflict),
  );

  // ------ Footprint measurement + recommended volume size (Stage 3) ------
  /**
   * Measured cloud-migration footprint. `null` while loading or before the
   * first measurement. On `unknown_partial`, we surface an interactive
   * dialog instead of silently picking a number.
   */
  const [footprint, setFootprint] = useState<(FootprintOutcome & { durationMs?: number }) | null>(null);
  const [footprintLoading, setFootprintLoading] = useState(false);
  /**
   * Volume size selected for the next provision / switch. `null` while
   * loading or while the user hasn't yet resolved an `unknown_partial`
   * dialog — nothing is submitted until the user picks a size.
   */
  const [volumeSizeGb, setVolumeSizeGb] = useState<number | null>(null);
  /** Whether the user has opened the "Customize" disclosure. */
  const [customizing, setCustomizing] = useState(false);
  /** @deprecated Dialog removed — unknown_partial now auto-defaults silently. */
  const showUnknownPartialDialog = false;
  const setShowUnknownPartialDialog = (_v: boolean) => {};

  // Measure the footprint once on mount. Bounded to 2s in the main-process
  // util; failures (IPC reject, etc.) are treated as `unknown_partial` so
  // the UI can prompt for a choice rather than silently default.
  useEffect(() => {
    let cancelled = false;
    async function measure() {
      setFootprintLoading(true);
      try {
        const result = await window.cloudApi.measureFootprint();
        if (cancelled) return;
        setFootprint(result);
        if (result.kind === 'measured_nonzero') {
          setVolumeSizeGb(recommendVolumeGb(result.totalBytes));
        } else if (result.kind === 'measured_zero') {
          // "Starting at 10 GB — you can resize later" per Stage 3 spec.
          setVolumeSizeGb(10);
        } else {
          // unknown_partial: pick a safe default silently so the user
          // isn't asked to make an infrastructure sizing decision.
          setVolumeSizeGb(DEFAULT_VOLUME_SIZE_GB);
        }
      } catch (err) {
        if (cancelled) return;
        // IPC failure — treat as unknown_partial(mount_error) and pick a
        // safe default so the user isn't interrupted.
        console.warn('[useCloudProvisioning] measureFootprint failed:', err);
        setFootprint({ kind: 'unknown_partial', partialBytes: 0, reason: 'mount_error', durationMs: 0 });
        setVolumeSizeGb(DEFAULT_VOLUME_SIZE_GB);
      } finally {
        if (!cancelled) setFootprintLoading(false);
      }
    }
    void measure();
    return () => { cancelled = true; };
  }, []);

  /** @deprecated Dialog removed — unknown_partial auto-defaults now. */
  const acceptFootprintDefault = useCallback(() => {
    setVolumeSizeGb(DEFAULT_VOLUME_SIZE_GB);
    setCustomizing(false);
  }, []);

  /** @deprecated Dialog removed — unknown_partial auto-defaults now. */
  const openFootprintCustomize = useCallback((_providerId: CloudProviderUIConfig['id']) => {
    setCustomizing(true);
  }, []);

  // Run cloud instance discovery on mount to detect managed+BYOK conflicts
  useEffect(() => {
    let cancelled = false;
    async function runDiscovery() {
      try {
        const result = await window.cloudApi.discoverInstances();
        if (!cancelled) setDiscoveryResult(result);
      } catch (err) {
        console.warn('[CloudTab] Cloud instance discovery failed:', err);
      }
    }
    void runDiscovery();
    return () => { cancelled = true; };
  }, [cloud?.cloudUrl, cloud?.provisionMode]);

  // Fetch whether a Fly API token is stored locally. Re-run when the connection
  // state changes (so we re-check after link/unlink/provision/deprovision). The
  // result drives whether to surface the "Connect Fly token" recovery form for
  // already-connected BYOK users whose token is missing on this machine.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await window.cloudApi.hasFlyToken();
        if (!cancelled) setHasFlyToken(Boolean(res?.hasToken));
      } catch (err) {
        if (!cancelled) setHasFlyToken(null);
        console.warn('[useCloudProvisioning] hasFlyToken check failed:', err);
      }
    }
    void check();
    return () => { cancelled = true; };
  }, [cloud?.cloudUrl, cloud?.provisionMode, cloud?.flyAppName, cloud?.flyMachineId]);

  // Fetch DO OAuth status when DigitalOcean is selected
  useEffect(() => {
    let cancelled = false;

    if (selectedProvider !== 'digitalocean') {
      setDoOAuthStatus({ connected: false });
      setDoOAuthLoading(false);
      setShowPatFallback(false);
      return;
    }

    const fetchDOStatus = async () => {
      setDoOAuthLoading(true);
      try {
        const statusResult = await window.cloudApi.doOauthStatus();
        if (!cancelled) {
          setDoOAuthStatus(statusResult);
        }
      } catch {
        if (!cancelled) {
          setDoOAuthStatus({ connected: false });
        }
      } finally {
        if (!cancelled) {
          setDoOAuthLoading(false);
        }
      }
    };

    void fetchDOStatus();
    return () => { cancelled = true; };
  }, [selectedProvider]);

  // Ref for aborting update health polling on unmount
  const updateAbortRef = useRef<AbortController | null>(_updateAbortController);
  const updateTerminalErrorRef = useRef<string | null>(null);

  // Abort in-flight update polling on unmount
  useEffect(() => {
    return () => {
      updateAbortRef.current?.abort();
      updateAbortRef.current = null;
      _updateAbortController = null;
    };
  }, []);

  // Seed restarting state from module-level on mount
  useEffect(() => {
    if (_updateRestarting && updateStatus === 'idle') {
      setUpdateStatus('restarting');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting updateStatus so the module-level restarting flag seeds state only on mount
  }, []);

  // Hoisted ahead of the auto-check effect below so the effect's dep doesn't reference
  // a use-before-define binding. Only depends on top-of-hook state setters + updateStatus.
  const handleCheckForUpdateInternal = useCallback(async () => {
    if (updateStatus === 'checking' || updateStatus === 'applying' || updateStatus === 'restarting') return;
    setUpdateStatus('checking');
    setUpdateError(null);
    setUpdateErrorCategory(null);
    try {
      const result = await window.cloudApi.checkUpdate(undefined as never);
      if (result.rateLimited) {
        setUpdateStatus('rate_limited');
        return;
      }
      if (!result.success) {
        const rawError = result.error ?? 'Check failed.';
        setUpdateStatus('error');
        setUpdateError(rawError);
        setUpdateErrorCategory(categorize(rawError));
        return;
      }
      if (result.updateAvailable && result.latestTag) {
        setUpdateLatestTag(result.latestTag);
        setUpdateStatus('update_available');
      } else {
        setUpdateStatus('up_to_date');
      }
    } catch (err) {
      // Keep the raw message for logs/diagnostics; the renderer sanitizes it (and
      // treats a cold-boot abort/timeout as a soft "still starting" signal) via
      // the stored category. This is the only update-check stream that auto-fires
      // on mount for Fly BYOK, so an un-sanitized error here is what previously
      // leaked the raw DOMException as scary red text right after provisioning.
      setUpdateStatus('error');
      setUpdateError(err instanceof Error ? err.message : 'Check failed.');
      setUpdateErrorCategory(categorize(err));
    }
  }, [updateStatus]);

  // Auto-check for updates on mount when connected + Fly BYOK
  useEffect(() => {
    if (!isFlyByok) return;
    if (updateStatus === 'idle') {
      void handleCheckForUpdateInternal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting updateStatus/handleCheckForUpdateInternal to avoid rechecking on every status transition
  }, [isFlyByok]);

  // ------ DigitalOcean OAuth ------

  const handleStartDigitalOceanOAuth = useCallback(async () => {
    if (doOAuthLoading) return;

    setDoOAuthLoading(true);
    setProvisionError(null);

    try {
      const startResult = await window.cloudApi.doStartOauth();
      if (!startResult.success) {
        // Broken-by-default (no DigitalOcean OAuth client credentials): open the setup dialog
        // instead of surfacing a generic provision error.
        if (connectorSetupGuidance.handleResult(startResult)) {
          return;
        }
        throw new Error(startResult.error ?? 'Could not start DigitalOcean authorization.');
      }

      const deadline = Date.now() + DO_OAUTH_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, DO_OAUTH_POLL_INTERVAL_MS));
        const statusResult = await window.cloudApi.doOauthStatus();
        setDoOAuthStatus(statusResult);
        if (statusResult.connected) {
          setShowPatFallback(false);
          return;
        }
      }

      throw new Error('Timed out waiting for DigitalOcean authentication. Please try again.');
    } catch (err) {
      const rawError = err instanceof Error ? err.message : 'DigitalOcean authentication failed.';
      setProvisionError(mapCloudError(rawError, { providerId: 'digitalocean' }));
    } finally {
      setDoOAuthLoading(false);
    }
  }, [doOAuthLoading, connectorSetupGuidance]);

  const handleDisconnectDigitalOceanOAuth = useCallback(async () => {
    if (doOAuthLoading) return;

    setDoOAuthLoading(true);
    setProvisionError(null);

    try {
      const result = await window.cloudApi.doDisconnectOauth();
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to disconnect DigitalOcean.');
      }
      setDoOAuthStatus({ connected: false });
    } catch (err) {
      const rawError = err instanceof Error ? err.message : 'Failed to disconnect DigitalOcean.';
      setProvisionError(mapCloudError(rawError, { providerId: 'digitalocean' }));
    } finally {
      setDoOAuthLoading(false);
    }
  }, [doOAuthLoading]);

  // ------ Provision ------

  const handleProvision = useCallback(async (opts?: { volumeSizeGb?: number; vmTierId?: 'standard' | 'faster' | 'heavy-work' }): Promise<ProvisionResult> => {
    const failResult: ProvisionResult = { success: false };
    if (provisionBusy) return failResult;
    const isManagedProv = providerConfig.managed === true;
    const token = providerTokenInput.trim();
    const hasDigitalOceanOAuth = selectedProvider === 'digitalocean' && doOAuthStatus.connected;

    if (!isManagedProv && !token && !hasDigitalOceanOAuth) {
      setProvisionError({
        category: 'auth_invalid',
        userMessage: selectedProvider === 'digitalocean'
          ? 'Connect with DigitalOcean or enter an API token.'
          : `Enter your ${providerConfig.name} API token.`,
        guidance: '',
        helpKey: 'token_help',
        severity: 'error',
        technicalDetail: 'No token provided',
      });
      return failResult;
    }

    setProvisionBusy(true);
    setProvisionError(null);
    setProvisionWarning(null);
    setProvisionCleanupMessage(null);
    resetProvisionProgress();

    try {
      // `volumeSizeGb` is only threaded for BYOK — managed sizing is
      // decided server-side by rebel-platform. Prefer an explicit caller
      // override (for tests / power users), otherwise fall back to the
      // hook's own state which is derived from the footprint measurement.
      const resolvedVolumeGb = opts?.volumeSizeGb ?? volumeSizeGb ?? undefined;
      const byokVolumeField = !isManagedProv && resolvedVolumeGb !== undefined
        ? { volumeSizeGb: resolvedVolumeGb }
        : {};
      const flyTierField = !isManagedProv && selectedProvider === 'fly' && opts?.vmTierId
        ? { vmTierId: opts.vmTierId }
        : {};
      const provisionPayload = isManagedProv
        ? { providerId: selectedProvider, region: selectedRegion }
        : selectedProvider === 'fly'
          ? { flyApiToken: token, providerId: 'fly' as const, region: selectedRegion, ...byokVolumeField, ...flyTierField }
          : token
            ? { apiToken: token, providerId: selectedProvider, ...byokVolumeField }
            : { providerId: selectedProvider, ...byokVolumeField };
      const result = await window.cloudApi.provision(provisionPayload);

      if (result.success && result.cloudUrl && result.cloudToken) {
        if (result.warning) setProvisionWarning(result.warning);
        // Persist the new cloud config immediately so the reconciler reads the
        // provisioned URL/token before it writes canonical status fields.
        const isFlyBacked = selectedProvider === 'fly' || selectedProvider === 'mindstone';
        const provisionedAt = Date.now();
        const newCloudConfig: CloudInstanceConfig = {
          mode: 'cloud',
          cloudUrl: result.cloudUrl,
          cloudToken: result.cloudToken,
          providerId: selectedProvider,
          flyAppName: isFlyBacked ? result.appName : undefined,
          flyMachineId: isFlyBacked ? result.machineId : undefined,
          flyVolumeId: isFlyBacked ? result.volumeId : undefined,
          flyRegion: isFlyBacked ? result.region : undefined,
          // Preserve vmTierId persisted by the backend cloud:provision handler
          // so the renderer's settings write doesn't clobber it.
          vmTierId: isFlyBacked && !isManagedProv ? result.vmTierId : undefined,
          provisionedAt,
          provisionMode: isManagedProv ? 'managed' : 'byok',
          providerMetadata: !isFlyBacked ? { instanceId: result.appName ?? '' } : undefined,
        };
        await window.settingsApi.update({ cloudInstance: newCloudConfig });
        await window.cloudApi.reconcile({
          writer: 'manual-refresh',
          cloudUrl: result.cloudUrl,
          mode: 'reportSuccess',
        });
        const updatedCloud = (await window.settingsApi.get()).cloudInstance;
        updateDraft('cloudInstance', updatedCloud ?? newCloudConfig);
        resetProvisionProgress();
        return { success: true, cloudUrl: result.cloudUrl, cloudToken: result.cloudToken };
      } else {
        const rawError = result.error ?? 'Provisioning failed.';
        setProvisionError(mapCloudError(rawError, {
          providerId: selectedProvider,
          failedStep: result.failedStep,
        }));
        if (result.cleanupMessage) {
          setProvisionCleanupMessage(result.cleanupMessage);
        }
        resetProvisionProgress();
        return failResult;
      }
    } catch (err) {
      const rawError = err instanceof Error ? err.message : 'Provisioning failed unexpectedly.';
      setProvisionError(mapCloudError(rawError, { providerId: selectedProvider }));
      resetProvisionProgress();
      return failResult;
    } finally {
      setProvisionBusy(false);
    }
  }, [providerTokenInput, provisionBusy, selectedProvider, selectedRegion, providerConfig.name, providerConfig.managed, doOAuthStatus.connected, updateDraft, resetProvisionProgress, volumeSizeGb]);

  // ------ Deprovision ------

  const handleDeprovision = useCallback(async (opts: {
    setBusy: (v: boolean) => void;
    setConnectError: (v: string | null) => void;
    clearSyncResults: () => void;
  }) => {
    if (!confirmDeprovision) {
      setConfirmDeprovision(true);
      return;
    }

    opts.setBusy(true);
    try {
      // Sync down cloud-only data before destroying (pulls mobile/web sessions to desktop)
      let syncFailed = false;
      try {
        // DI-A (2026-04-27): adopted shared `withRendererTimeout` (was inline
        // Promise.race that did not clear its timer on early settle).
        const syncResult = await withRendererTimeout(
          window.cloudApi.syncNow(),
          { timeoutMs: 30_000 },
        );
        if (syncResult && !syncResult.success) syncFailed = true;
      } catch {
        syncFailed = true;
      }

      if (syncFailed) {
        opts.setConnectError('Could not sync cloud data before removing. Some cloud-only conversations may not have been saved locally. Proceeding with removal.');
      }

      // Bound the deprovision call so the spinner can't outlive a dead IPC. Main
      // already bounds auth (10s) + the remote call (30s); this is a renderer
      // safety net so `finally` always runs.
      const result = await withRendererTimeout(
        window.cloudApi.deprovision(),
        { timeoutMs: 45_000 },
      );
      if (result.kind === 'remote-removed') {
        setConfirmDeprovision(false);
        opts.clearSyncResults();
        resetProvisionProgress();
      } else if (result.kind === 'local-only-remote-uncertain') {
        // Partial: local config was wiped but the remote may still be running.
        setConfirmDeprovision(false);
        opts.clearSyncResults();
        resetProvisionProgress();
        // C-F3: route the partial-failure signal to the PERSISTENT
        // `provisionError` warning banner (rendered near the deprovision /
        // post-wipe setup surface, not gated on `isAutoProvisioned`) instead of
        // `connectError`, which only renders inside the collapsed "Connect
        // manually" disclosure on a now-different screen. Clear `connectError`
        // so the partial isn't buried there.
        setProvisionError({ ...mapCloudError(result.error, {}), severity: 'warning' });
        opts.setConnectError(null);
      } else {
        opts.setConnectError(result.error);
      }
    } catch (err) {
      opts.setConnectError(err instanceof Error ? err.message : 'Deprovisioning failed.');
    } finally {
      // Always re-read authoritative settings so the UI reflects the wipe (which
      // may have landed even on a timeout/partial failure); never hand-build a
      // `mode:'local'` draft.
      try {
        const latest = (await window.settingsApi.get()).cloudInstance;
        updateDraft('cloudInstance', latest);
      } catch { /* best-effort UI refresh */ }
      opts.setBusy(false);
    }
  }, [confirmDeprovision, resetProvisionProgress, updateDraft]);

  // ------ Switch provider ------

  const handleSwitchProvider = useCallback(async (opts?: { volumeSizeGb?: number }) => {
    if (switchInProgress) return;

    const isSwitchingFromManaged = cloud?.provisionMode === 'managed';
    const targetId = isSwitchingFromManaged ? switchProviderSelection : ('mindstone' as const);
    const token = switchTokenInput.trim();

    setSwitchInProgress(true);
    setSwitchError(null);
    setSwitchCleanupWarning(null);
    setShowSwitchDialog(false);
    resetProvisionProgress();

    // Mark migration as in-progress so useCloudSync forwards the main
    // process's `cloud:migration-progress` broadcasts to the UI. Without
    // this, the embedded doMigrate() call inside executeSwitchProvider
    // emits events that useCloudSync silently drops.
    beginExternalMigration();

    try {
      const payload: {
        targetProviderId: 'fly' | 'digitalocean' | 'hetzner' | 'mindstone';
        flyApiToken?: string;
        apiToken?: string;
        volumeSizeGb?: number;
      } = { targetProviderId: targetId };

      if (targetId === 'fly' && token) {
        payload.flyApiToken = token;
      } else if (targetId !== 'mindstone' && token) {
        payload.apiToken = token;
      }

      // Only thread volumeSizeGb when switching to a BYOK target — the
      // managed path derives volume size server-side. Prefer an explicit
      // caller override; otherwise fall back to the hook's footprint-
      // derived state.
      const resolvedSwitchVolumeGb = opts?.volumeSizeGb ?? volumeSizeGb ?? undefined;
      if (targetId !== 'mindstone' && resolvedSwitchVolumeGb !== undefined) {
        payload.volumeSizeGb = resolvedSwitchVolumeGb;
      }

      const result = await window.cloudApi.switchProvider(payload);

      if (result.success) {
        if (result.warning) {
          setSwitchCleanupWarning(result.warning);
        } else {
          setTimeout(() => window.location.reload(), 2000);
        }
      } else {
        setSwitchError({
          error: result.error ?? 'Switch failed.',
          failedStep: result.failedStep,
        });
      }
    } catch (err) {
      setSwitchError({
        error: err instanceof Error ? err.message : 'Switch failed unexpectedly.',
      });
    } finally {
      setSwitchInProgress(false);
      resetProvisionProgress();
      endExternalMigration();
    }
  }, [switchInProgress, cloud?.provisionMode, switchProviderSelection, switchTokenInput, resetProvisionProgress, volumeSizeGb]);

  // ------ Conflict resolution ------

  const handleResolveConflict = useCallback(async (keep: 'managed' | 'byok') => {
    lastConflictKeepRef.current = keep;
    setConflictResolving(true);
    setConflictResolveError(null);
    try {
      const result = await window.cloudApi.resolveConflict({ keep });
      if (result.success) {
        if (result.warning) {
          setConflictResolveError(result.warning);
        }
        try {
          const updated = await window.cloudApi.discoverInstances();
          setDiscoveryResult(updated);
        } catch {
          setDiscoveryResult(null);
        }
        setTimeout(() => window.location.reload(), 2000);
      } else {
        setConflictResolveError(result.error ?? 'Resolution failed. Please try again.');
      }
    } catch (err) {
      setConflictResolveError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setConflictResolving(false);
    }
  }, []);

  // ------ Orphaned managed instance recovery ------

  /**
   * Reconnect to an already-running managed instance discovered on the backend
   * (recovery after a local "Forget"). On success the main process has written
   * the recovered credentials back into settings; reload so every cloud hook
   * re-reads the authoritative connected state.
   */
  const handleReattachManaged = useCallback(async () => {
    setReattachBusy(true);
    setReattachError(null);
    try {
      const result = await withRendererTimeout(
        window.cloudApi.reattachManaged(),
        { timeoutMs: 20_000 },
      );
      if (result.success) {
        try {
          const latest = (await window.settingsApi.get()).cloudInstance;
          updateDraft('cloudInstance', latest);
        } catch { /* best-effort UI refresh */ }
        setTimeout(() => window.location.reload(), 800);
      } else {
        setReattachError(result.error ?? 'Could not reconnect. Please try again.');
      }
    } catch (err) {
      setReattachError(err instanceof Error ? err.message : 'Could not reconnect. Please try again.');
    } finally {
      setReattachBusy(false);
    }
  }, [updateDraft]);

  /**
   * Destroy an orphaned managed instance even though local settings no longer
   * carry `provisionMode:'managed'` (the `managed:true` scope forces the managed
   * teardown path in main). Refreshes discovery so the recovery banner clears.
   */
  const handleDestroyOrphanedManaged = useCallback(async () => {
    setReattachBusy(true);
    setReattachError(null);
    try {
      const result = await withRendererTimeout(
        window.cloudApi.deprovision({ managed: true }),
        { timeoutMs: 45_000 },
      );

      // C-F1 (billing honesty): hide the recovery banner ONLY on POSITIVE proof
      // the remote instance is gone. `local-only-remote-uncertain` is a local
      // no-op for an already-Forgotten orphan and is NOT evidence the remote
      // DELETE landed, so we never treat it as removal proof. Always
      // re-discover so the banner can clear on a clean "not found".
      let discoveryConfirmedGone = false;
      try {
        const updated = await window.cloudApi.discoverInstances();
        setDiscoveryResult(updated);
        // A CLEAN `exists:false` (no `managed.error`) is authoritative — the
        // status endpoint says the instance is gone even if the DELETE errored.
        // An `error`-bearing result is "could not check", NOT "confirmed gone".
        discoveryConfirmedGone = updated.managed.exists === false && !updated.managed.error;
      } catch {
        setDiscoveryResult(null);
        // Discovery itself failed → cannot confirm removal.
        discoveryConfirmedGone = false;
      }

      if (result.kind === 'remote-removed' || discoveryConfirmedGone) {
        // Positive removal proof: remote DELETE confirmed, or a clean
        // re-discovery shows it's gone. Clear the unconfirmed flag so the
        // banner is allowed to disappear.
        setLastDestroyUnconfirmed(false);
        if (result.kind !== 'remote-removed' && result.error) setReattachError(result.error);
      } else {
        // No positive proof the remote is gone — KEEP the banner visible (it may
        // still be billing) and surface the error inside it.
        setLastDestroyUnconfirmed(true);
        setReattachError(
          result.error ??
            'Could not confirm the instance was removed. It may still be running — try again, and if it keeps failing, contact support.',
        );
      }
    } catch (err) {
      // Destroy IPC threw outright — we have no proof of removal. Keep the banner.
      setLastDestroyUnconfirmed(true);
      setReattachError(err instanceof Error ? err.message : 'Could not remove the instance. Please try again.');
    } finally {
      setReattachBusy(false);
    }
  }, []);

  // ------ Cloud service update ------
  // Note: handleCheckForUpdateInternal is hoisted near the top of the hook to avoid
  // use-before-define in the auto-check effect. See above.

  /**
   * Poll health after a cloud update trigger until the new version is live.
   */
  const pollHealthAfterUpdate = useCallback(async (
    signal: AbortSignal,
    expectedTag?: string,
  ): Promise<boolean> => {
    if (!cloud?.cloudUrl) {
      updateTerminalErrorRef.current = 'Cloud URL is missing. Try updating again.';
      return false;
    }
    const url = `${cloud.cloudUrl.replace(/\/+$/, '')}/api/health`;
    type HealthBody = { status?: string; buildCommit?: string; version?: string; buildDate?: string; uptime?: number };
    type MachineStateResult = Awaited<ReturnType<typeof window.cloudApi.machineState>>;

    const startTime = Date.now();
    let lastPhase: UpdateProgressDetail['phase'] | null = null;
    let lastSignalChangeTime = startTime;
    let lastSignalKey = ''; // tracks underlying signals for stall detection
    let machineStateUnavailable = false;

    const fetchHealth = async (): Promise<{ healthStatus: number; healthBody?: HealthBody }> => {
      let healthStatus = 0;
      let healthBody: HealthBody | undefined;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        healthStatus = resp.status;
        if (resp.ok) {
          healthBody = await resp.json() as HealthBody;
        }
      } catch {
        healthStatus = 0;
      }
      return { healthStatus, healthBody };
    };

    const fetchMachineState = async (): Promise<MachineStateResult | undefined> => {
      if (machineStateUnavailable) return undefined;
      try {
        return await Promise.race([
          window.cloudApi.machineState(),
          new Promise<MachineStateResult>((resolve) => {
            window.setTimeout(() => resolve({ success: false, error: 'timeout' }), 5_000);
          }),
        ]);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    while (!signal.aborted) {
      if (signal.aborted) return false;

      const [healthResult, machineResultSettled] = await Promise.all([
        fetchHealth(),
        fetchMachineState(),
      ]);
      if (signal.aborted) return false;

      const { healthStatus, healthBody } = healthResult;
      const machineResult = machineResultSettled;
      if (machineResult?.success === false && machineResult.error === 'not_available') {
        machineStateUnavailable = true;
      }

      const elapsedMs = Date.now() - startTime;
      const machineState = machineResult?.success ? machineResult.machine?.state : undefined;
      const machineStateAvailable = machineResult?.success ?? false;
      const healthBucket = healthStatus === 0 ? '0' : healthStatus >= 500 ? '5xx' : String(healthStatus);
      const currentSignalKey = `${machineState ?? '-'}:${healthBucket}:${healthBody?.buildCommit ?? '-'}`;
      if (currentSignalKey !== lastSignalKey) {
        lastSignalChangeTime = Date.now();
        lastSignalKey = currentSignalKey;
      }

      const input: ClassifyInput = {
        machineState,
        machineStateAvailable,
        healthStatus,
        healthBody,
        expectedTag,
        elapsedMs,
        lastPhaseChangeMs: Date.now() - lastSignalChangeTime,
      };
      const result = classifyUpdatePhase(input);

      if (result === null || (!expectedTag && healthStatus === 200 && healthBody?.status === 'ok')) {
        if (!signal.aborted) {
          setCloudHealth({
            version: String(healthBody?.version ?? ''),
            buildCommit: String(healthBody?.buildCommit ?? ''),
            buildDate: String(healthBody?.buildDate ?? ''),
            uptimeSeconds: typeof healthBody?.uptime === 'number' ? healthBody.uptime : 0,
          });
        }
        return true;
      }

      if (result.isTerminalError) {
        updateTerminalErrorRef.current = 'Cloud machine stopped unexpectedly. Try updating again.';
        return false;
      }

      if (result.phase !== lastPhase) {
        console.warn('[cloud-update] Phase transition:', lastPhase, '→', result.phase, {
          elapsed: Math.floor(input.elapsedMs / 1000),
          machineState: input.machineState,
          healthStatus,
        });
        lastPhase = result.phase;
      }

      setUpdateProgress(result);

      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
    }
    return false;
  }, [cloud?.cloudUrl, setCloudHealth]);

  const finishUpdateRestart = useCallback(async (
    signal: AbortSignal,
    expectedTag?: string,
  ) => {
    updateTerminalErrorRef.current = null;
    const ownController = _updateAbortController;
    const healthy = await pollHealthAfterUpdate(signal, expectedTag);
    // Only clear module state if we still own the controller (prevents
    // a stale run from clobbering a newer polling session).
    if (_updateAbortController === ownController) {
      _updateRestarting = false;
      _updateAbortController = null;
      updateAbortRef.current = null;
    }
    if (signal.aborted) return;
    setUpdateProgress(null);
    if (healthy) {
      setUpdateStatus('updated');
      if (cloud) {
        window.cloudApi.reconcile({
          writer: 'manual-refresh',
          cloudUrl: cloud.cloudUrl,
          mode: 'reportSuccess',
        }).then(async () => {
          const updated = (await window.settingsApi.get()).cloudInstance;
          if (updated) {
            updateDraft('cloudInstance', updated);
          }
        }).catch(() => {});
      }
    } else {
      const terminalError = updateTerminalErrorRef.current;
      if (terminalError) {
        setUpdateStatus('error');
        setUpdateError(terminalError);
        setUpdateErrorCategory(categorize(terminalError));
      } else {
        setUpdateStatus('idle');
      }
    }
  }, [pollHealthAfterUpdate, cloud, updateDraft]);

  const startRestartPolling = useCallback((expectedTag?: string) => {
    _updateAbortController?.abort();
    const controller = new AbortController();
    _updateAbortController = controller;
    updateAbortRef.current = controller;
    _updateRestarting = true;
    updateTerminalErrorRef.current = null;
    setUpdateStatus('restarting');
    setUpdateProgress(null);
    void finishUpdateRestart(controller.signal, expectedTag);
  }, [finishUpdateRestart]);

  const handleStopWaiting = useCallback(() => {
    _updateAbortController?.abort();
    _updateAbortController = null;
    updateAbortRef.current = null;
    _updateRestarting = false;
    setUpdateStatus('idle');
    setUpdateProgress(null);
    setUpdateError(null);
    setUpdateErrorCategory(null);
  }, []);

  const handleApplyUpdate = useCallback(async () => {
    if (updateStatus === 'applying' || updateStatus === 'restarting') return;
    setUpdateStatus('applying');
    setUpdateError(null);
    setUpdateErrorCategory(null);
    try {
      const result = await window.cloudApi.applyUpdate(
        updateLatestTag ? { latestTag: updateLatestTag } : undefined as never,
      );
      if (result.rateLimited) {
        setUpdateStatus('rate_limited');
        return;
      }
      if (!result.success) {
        const rawError = result.error ?? 'Update failed.';
        setUpdateStatus('error');
        setUpdateError(rawError);
        setUpdateErrorCategory(categorize(rawError));
        return;
      }
      if (!result.updated) {
        setUpdateStatus('up_to_date');
        return;
      }
      startRestartPolling(result.latestTag ?? updateLatestTag ?? undefined);
    } catch (err) {
      setUpdateStatus('error');
      setUpdateError(err instanceof Error ? err.message : 'Update failed.');
      setUpdateErrorCategory(categorize(err));
    }
  }, [updateStatus, updateLatestTag, startRestartPolling]);

  const handleChannelToggle = useCallback(async () => {
    if (updateStatus === 'applying' || updateStatus === 'restarting') return;
    const newChannel = currentChannel === 'beta' ? 'stable' : 'beta';
    setUpdateStatus('applying');
    setUpdateError(null);
    setUpdateErrorCategory(null);
    try {
      if (isManaged) {
        const result = await window.cloudApi.applyUpdate({ channel: newChannel });
        if (!result.success) {
          const rawError = result.error ?? 'Channel switch failed.';
          setUpdateStatus('error');
          setUpdateError(rawError);
          setUpdateErrorCategory(categorize(rawError));
          return;
        }
        updateDraft('cloudUpdateChannel', newChannel);
        setUpdateStatus('up_to_date');
      } else {
        await window.settingsApi.update({ cloudUpdateChannel: newChannel });
        updateDraft('cloudUpdateChannel', newChannel);
        const result = await window.cloudApi.applyUpdate({ channel: newChannel });
        if (result.rateLimited) {
          setUpdateStatus('rate_limited');
          return;
        }
        if (!result.success) {
          const rawError = result.error ?? 'Update failed.';
          setUpdateStatus('error');
          setUpdateError(rawError);
          setUpdateErrorCategory(categorize(rawError));
          return;
        }
        if (!result.updated) {
          setUpdateStatus('up_to_date');
          return;
        }
        startRestartPolling(result.latestTag ?? undefined);
      }
    } catch (err) {
      setUpdateStatus('error');
      setUpdateError(err instanceof Error ? err.message : 'Update failed.');
      setUpdateErrorCategory(categorize(err));
    }
  }, [updateStatus, currentChannel, isManaged, updateDraft, startRestartPolling]);

  // ------ Fly token linking ------

  const handleLinkFlyToken = useCallback(async () => {
    if (flyLinkBusy) return;
    const token = flyLinkTokenInput.trim();
    if (!token) { setFlyLinkError('Enter your Fly.io Personal Access Token.'); return; }

    const urlMatch = cloud?.cloudUrl?.match(/^https:\/\/([a-z0-9-]+)\.fly\.dev/i);
    if (!urlMatch) { setFlyLinkError('Could not determine Fly app name from cloud URL.'); return; }
    const appName = urlMatch[1];

    setFlyLinkBusy(true);
    setFlyLinkError(null);

    try {
      const result = await window.cloudApi.linkFlyToken({ flyApiToken: token, appName });
      if (result.success) {
        updateDraft('cloudInstance', {
          ...cloud,
          provisionMode: 'byok',
          flyAppName: result.appName,
          flyMachineId: result.machineId,
          flyVolumeId: result.volumeId,
          flyRegion: result.region,
        } as CloudInstanceConfig);
        setFlyLinkTokenInput('');
        setHasFlyToken(true);
        if (result.diagnostic) {
          setFlyDiagnostic(result.diagnostic);
        }
      } else {
        setFlyLinkError(result.error ?? 'Failed to link Fly token.');
      }
    } catch (err) {
      setFlyLinkError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setFlyLinkBusy(false);
    }
  }, [flyLinkTokenInput, flyLinkBusy, cloud, updateDraft]);

  // ------ Repair ingress ------

  const handleRepairIngress = useCallback(async () => {
    if (repairIngressBusy) return;
    setRepairIngressBusy(true);
    setRepairIngressError(null);
    setRepairIngressResult(null);

    try {
      const result = await window.cloudApi.repairIngress();
      if (result.success) {
        setRepairIngressResult(
          result.alreadyExists
            ? 'Public IP already exists. No action needed.'
            : `Public IP allocated${result.address ? ` (${result.address})` : ''}. Cloud should be reachable now.`,
        );
        setFlyDiagnostic(prev => prev ? { ...prev, hasPublicIp: true } : prev);
      } else {
        setRepairIngressError(result.error ?? 'Failed to allocate public IP.');
      }
    } catch (err) {
      setRepairIngressError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRepairIngressBusy(false);
    }
  }, [repairIngressBusy]);

  // ------ Repair token ------

  const handleRepairToken = useCallback(async (force?: boolean) => {
    if (repairTokenBusy) return;
    setRepairTokenBusy(true);
    setRepairTokenError(null);
    setRepairTokenResult(null);
    setRepairTokenConflict(false);

    try {
      const result = await window.cloudApi.repairToken({ force });
      if (result.success) {
        if (result.alreadyCorrect) {
          setRepairTokenResult('Token is already configured correctly.');
        } else {
          setRepairTokenResult('Cloud token repaired. The instance is restarting.');
        }
        setFlyDiagnostic(prev => prev ? { ...prev, authenticated: true } : prev);
      } else if (result.conflict) {
        setRepairTokenConflict(true);
        setRepairTokenError('Remote token differs from local. Another device may be paired. Overwriting will require re-pairing other devices.');
      } else {
        setRepairTokenError(result.error ?? 'Failed to repair token.');
      }
    } catch (err) {
      setRepairTokenError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRepairTokenBusy(false);
    }
  }, [repairTokenBusy]);

  // ------ Repair Fly API token (enable cloud-side auto-update) ------

  const handleRepairFlyToken = useCallback(async () => {
    if (repairFlyTokenBusy) return;
    setRepairFlyTokenBusy(true);
    setRepairFlyTokenError(null);
    setRepairFlyTokenResult(null);

    try {
      const result = await window.cloudApi.repairFlyToken();
      if (result.success) {
        if (result.alreadyRepaired) {
          setRepairFlyTokenResult('Cloud auto-update is already enabled.');
        } else {
          setRepairFlyTokenResult('Cloud auto-update enabled. Your cloud is restarting and will keep itself current from now on.');
        }
      } else {
        setRepairFlyTokenError(result.error ?? 'Failed to enable cloud auto-update.');
      }
    } catch (err) {
      setRepairFlyTokenError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRepairFlyTokenBusy(false);
    }
  }, [repairFlyTokenBusy]);

  return {
    // Provider selection
    selectedProvider,
    setSelectedProvider,
    showByokPicker,
    setShowByokPicker,
    providerConfig,

    // Token input
    providerTokenInput,
    setProviderTokenInput,
    showManualSetup,
    setShowManualSetup,
    showTokenHelp,
    setShowTokenHelp,

    // Provisioning state
    provisionBusy,
    provisionError,
    setProvisionError,
    provisionProgress,
    provisionCleanupMessage,
    selectedRegion,
    setSelectedRegion,
    doReconnectNeeded,

    // Deprovisioning
    confirmDeprovision,
    setConfirmDeprovision,

    // DO OAuth
    doOAuthStatus,
    doOAuthLoading,
    showPatFallback,
    setShowPatFallback,

    // Provider switch
    switchInProgress,
    switchError,
    setSwitchError,
    showSwitchDialog,
    setShowSwitchDialog,
    switchProviderSelection,
    setSwitchProviderSelection,
    switchTokenInput,
    setSwitchTokenInput,
    switchCleanupWarning,
    setSwitchCleanupWarning,

    // Fly token linking
    flyLinkTokenInput,
    setFlyLinkTokenInput,
    flyLinkBusy,
    flyLinkError,
    hasFlyToken,

    // Diagnostics & repair
    flyDiagnostic,
    repairIngressBusy,
    repairIngressResult,
    repairIngressError,
    repairTokenBusy,
    repairTokenResult,
    repairTokenError,
    repairTokenConflict,
    repairFlyTokenBusy,
    repairFlyTokenResult,
    repairFlyTokenError,

    // Cloud updates
    updateStatus,
    updateLatestTag,
    updateError,
    updateErrorCategory,
    updateProgress,
    currentChannel,
    confirmChannelSwitch,
    setConfirmChannelSwitch,

    // Discovery / conflict
    discoveryResult,
    conflictResolving,
    conflictResolveError,
    lastConflictKeepRef,

    // Orphaned managed instance recovery
    orphanedManaged,
    reattachBusy,
    reattachError,

    // Footprint + recommended volume size (Stage 3)
    footprint,
    footprintLoading,
    volumeSizeGb,
    setVolumeSizeGb,
    customizing,
    setCustomizing,
    showUnknownPartialDialog,
    setShowUnknownPartialDialog,
    acceptFootprintDefault,
    openFootprintCustomize,

    // Handlers
    handleProvision,
    handleDeprovision,
    handleSwitchProvider,
    handleStartDigitalOceanOAuth,
    handleDisconnectDigitalOceanOAuth,

    // Structured OAuth setup guidance (DigitalOcean broken-by-default) for the ConnectorSetupDialog.
    connectorSetupGuidance,
    handleCheckForUpdate: handleCheckForUpdateInternal,
    handleApplyUpdate,
    handleChannelToggle,
    handleStopWaiting,
    handleLinkFlyToken,
    handleRepairIngress,
    handleRepairToken,
    handleRepairFlyToken,
    handleResolveConflict,
    handleReattachManaged,
    handleDestroyOrphanedManaged,

    // Provisioning progress reset
    resetProvisionProgress,
  };
}
