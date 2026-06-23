// Star topology: this hook MUST NOT import other cloud hooks.

/**
 * useCloudConnection
 *
 * Manages cloud connection lifecycle: URL/token form state, connect
 * (health → auth → save), disconnect (with sync-failed dialog), health
 * check, outbox & continuity stats, clipboard, and web link.
 *
 * Returns a ConnectResult from handleConnect so CloudTab can orchestrate
 * post-connect migration via useCloudSync.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { CloudInstanceConfig, AppSettings } from '@shared/types';
import { fetchHealthInfo, validateConnectInputs, type CloudHealthInfo } from '../components/tabs/cloudTabUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateRoot = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

export interface ConnectResult {
  success: boolean;
  isReconnect: boolean;
  /** true = token-only update, skip migration */
  urlUnchanged: boolean;
}

export interface UseCloudConnectionParams {
  cloudInstance: CloudInstanceConfig | undefined;
  updateDraft: UpdateRoot;
}

export interface CloudStatusRefreshResult {
  success: boolean;
  error?: string;
  skipped?: boolean;
}

export interface UseCloudConnectionResult {
  // Derived state
  mode: 'local' | 'cloud';
  isConnected: boolean;
  isSetupNeeded: boolean;
  status: CloudInstanceConfig['lastKnownStatus'] | undefined;

  // Form state
  urlInput: string;
  tokenInput: string;
  setUrlInput: (v: string) => void;
  setTokenInput: (v: string) => void;

  // Connection state
  pendingMode: 'local' | 'cloud' | null;
  setPendingMode: (v: 'local' | 'cloud' | null) => void;
  connectError: string | null;
  connectPhase: string | null;
  setConnectError: (v: string | null) => void;

  // Disconnect state
  confirmDisconnect: boolean;

  // Cloud health
  cloudHealth: CloudHealthInfo | null;
  setCloudHealth: (v: CloudHealthInfo | null) => void;

  // Outbox & continuity stats
  outboxStatus: { pending: number; failed: number } | null;
  continuityStats: { cloudActive: number; pinned: number } | null;

  // Clipboard
  copiedField: 'url' | 'token' | null;

  // Busy flag (shared — connect/disconnect/health check)
  busy: boolean;
  setBusy: (v: boolean) => void;

  // Handlers
  handleModeChange: (newMode: 'local' | 'cloud') => void;
  handleConnect: () => Promise<ConnectResult>;
  handleDisconnect: (opts?: { force?: boolean }) => Promise<void>;
  refreshCloudStatus: (opts?: { interactive?: boolean }) => Promise<CloudStatusRefreshResult>;
  handleCheckHealth: () => Promise<void>;
  handleCopyField: (field: 'url' | 'token') => void;
  handleOpenWebLink: () => void;
}

function getCloudRefreshIdentity(cloud: CloudInstanceConfig | undefined): string | null {
  if (!cloud?.cloudUrl) {
    return null;
  }

  return [
    cloud.mode,
    cloud.cloudUrl,
    cloud.providerId ?? '',
    cloud.provisionMode ?? '',
  ].join('|');
}

function isSameCloudRefreshTarget(
  expectedIdentity: string | null,
  cloud: CloudInstanceConfig | undefined,
): cloud is CloudInstanceConfig {
  return expectedIdentity !== null && getCloudRefreshIdentity(cloud) === expectedIdentity;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCloudConnection({
  cloudInstance: cloud,
  updateDraft,
}: UseCloudConnectionParams): UseCloudConnectionResult {
  // Track pending mode locally so the 'cloud' toggle doesn't get auto-saved
  // before credentials exist (prevents orphaned mode:'cloud' without URL/token).
  const [pendingMode, setPendingMode] = useState<'local' | 'cloud' | null>(null);
  const mode = pendingMode ?? cloud?.mode ?? 'local';
  const status = cloud?.lastKnownStatus;

  // Form state — seeded from persisted settings so reconnect doesn't require re-entry
  const [urlInput, setUrlInput] = useState(cloud?.cloudUrl ?? '');
  const [tokenInput, setTokenInput] = useState(cloud?.cloudToken ?? '');

  // UI state
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectPhase, setConnectPhase] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [copiedField, setCopiedField] = useState<'url' | 'token' | null>(null);

  const [outboxStatus, setOutboxStatus] = useState<{ pending: number; failed: number } | null>(null);
  const [continuityStats, setContinuityStats] = useState<{ cloudActive: number; pinned: number } | null>(null);

  // Cloud health info (fetched from /api/health on mount)
  const [cloudHealth, setCloudHealth] = useState<CloudHealthInfo | null>(null);
  const refreshInFlightRef = useRef(false);

  // Derived
  const connected = mode === 'cloud' && !!cloud?.cloudUrl;

  // Fetch initial outbox status and subscribe to live changes when connected
  useEffect(() => {
    if (!connected) { setOutboxStatus(null); return; }
    window.cloudApi.outboxStatus().then(setOutboxStatus).catch(() => {});
    const unsub = window.cloudApi.onOutboxChanged(setOutboxStatus);
    return unsub;
  }, [connected]);

  // Fetch continuity stats and subscribe to changes when connected
  const fetchContinuityStats = useCallback(() => {
    if (!window.cloudContinuityApi) return;
    window.cloudContinuityApi.getAll().then((all: Record<string, { state?: string; cloudPinnedAt?: number }>) => {
      let cloudActive = 0;
      let pinned = 0;
      for (const entry of Object.values(all)) {
        if (entry.state === 'cloud_active') cloudActive++;
        if (entry.cloudPinnedAt) pinned++;
      }
      setContinuityStats({ cloudActive, pinned });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!connected) { setContinuityStats(null); return; }
    fetchContinuityStats();
    const unsub = window.cloudApi.onContinuityChanged(fetchContinuityStats);
    return unsub;
  }, [connected, fetchContinuityStats]);

  // Fetch cloud health info on mount when connected
  useEffect(() => {
    if (!connected || !cloud?.cloudUrl) { setCloudHealth(null); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    fetchHealthInfo(cloud.cloudUrl, controller.signal).then((info) => {
      if (!controller.signal.aborted) setCloudHealth(info);
    }).finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [connected, cloud?.cloudUrl]);

  // Reset disconnect confirmation when leaving connected state
  useEffect(() => {
    if (mode !== 'cloud' || !cloud?.cloudUrl) setConfirmDisconnect(false);
  }, [mode, cloud?.cloudUrl]);

  // ------ Mode switch ------

  const handleModeChange = useCallback((newMode: 'local' | 'cloud') => {
    setConnectError(null);
    if (newMode === 'local') {
      // Switching to local means "forget the cloud on this device". Route it
      // through the canonical teardown IPC (a full, network-free local wipe) and
      // then re-read authoritative settings — never hand-build a `mode:'local'`
      // draft, which would re-introduce the `mode:'local'` + live-URL drift state
      // that strands the UI on "Offline (queued)".
      setPendingMode(null);
      void (async () => {
        try {
          await window.cloudApi.destroy({ force: true });
        } finally {
          try {
            const latest = (await window.settingsApi.get()).cloudInstance;
            updateDraft('cloudInstance', latest);
          } catch { /* best-effort UI refresh */ }
        }
      })();
    } else {
      // Switching to cloud is just a UI intent — don't persist until
      // credentials are available (connect/provision writes the full config).
      setPendingMode('cloud');
    }
  }, [updateDraft]);

  // ------ Connect ------

  const handleConnect = useCallback(async (): Promise<ConnectResult> => {
    const failResult: ConnectResult = { success: false, isReconnect: false, urlUnchanged: false };
    if (busy) return failResult;
    const url = urlInput.trim().replace(/\/+$/, '');
    const token = tokenInput.trim();

    // Centralised client-side validation — also catches the "Fly PAT pasted into
    // URL or cloud-token field" failure mode with a clearer message than the
    // server-side 401 that would otherwise surface as the generic "Invalid token".
    const validationError = validateConnectInputs(urlInput, tokenInput);
    if (validationError) { setConnectError(validationError); return failResult; }

    setBusy(true);
    setConnectError(null);

    try {
      // 1. Health check
      setConnectPhase('Knocking on the door...');
      const healthResp = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(15_000) });
      if (!healthResp.ok) throw new Error(`Health check failed (HTTP ${healthResp.status})`);
      const health = await healthResp.json() as { status?: string };
      if (health.status !== 'ok') throw new Error(`Server unhealthy: ${JSON.stringify(health)}`);

      // 2. Auth check
      setConnectPhase('Checking your credentials...');
      const authResp = await fetch(`${url}/api/settings`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (authResp.status === 401) throw new Error('Invalid token. Double-check and try again.');
      if (!authResp.ok) throw new Error(`Auth failed (HTTP ${authResp.status})`);

      // 3. Save immediately (bypass debounce so cloudRouter picks it up)
      //    Spread existing cloud config to preserve BYOK metadata (flyAppName, flyMachineId, etc.)
      setConnectPhase('Saving configuration...');
      const isReconnect = !!cloud?.cloudUrl;
      const newCloudConfig: CloudInstanceConfig = {
        ...cloud,
        mode: 'cloud',
        cloudUrl: url,
        cloudToken: token,
      };
      await window.settingsApi.update({ cloudInstance: newCloudConfig });
      await window.cloudApi.reconcile({
        writer: 'manual-refresh',
        cloudUrl: url,
        mode: 'reportSuccess',
      });
      const updatedCloud = (await window.settingsApi.get()).cloudInstance;
      updateDraft('cloudInstance', updatedCloud ?? newCloudConfig);
      setPendingMode(null);
      setConnectPhase(null);

      const urlUnchanged = isReconnect && url === cloud?.cloudUrl;
      return { success: true, isReconnect, urlUnchanged };
    } catch (err) {
      // Connection failed — reset pending mode (only matters for first-time connect;
      // reconnects already have mode:'cloud' persisted with credentials).
      if (!cloud?.cloudUrl) {
        setPendingMode(null);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('timeout') || msg.includes('Failed to fetch')) {
        setConnectError(`Can't reach ${url}. Is the server running?`);
      } else {
        setConnectError(msg);
      }
      setConnectPhase(null);
      return failResult;
    } finally {
      setBusy(false);
    }
  }, [urlInput, tokenInput, busy, cloud, updateDraft]);

  // ------ Disconnect ------

  const handleDisconnect = useCallback(async (opts?: { force?: boolean }) => {
    const force = opts?.force ?? false;

    // First click: show confirmation (unless already confirmed or forcing)
    if (!confirmDisconnect && !force) {
      setConfirmDisconnect(true);
      return;
    }

    setBusy(true);
    setConnectError(null);
    try {
      // Forget is a network-free, full local wipe in main — it always terminates.
      const result = await window.cloudApi.destroy({ force });
      if (!result.success) {
        setConnectError(result.error ?? "Couldn't update your settings. Reload Rebel and try again.");
      }
    } catch {
      setConnectError("Couldn't forget the cloud connection. Reload Rebel and try again.");
    } finally {
      // Always re-read authoritative settings so the UI reflects the wipe; never
      // leave a hand-built `mode:'local'` draft behind (drift source).
      try {
        const latest = (await window.settingsApi.get()).cloudInstance;
        updateDraft('cloudInstance', latest);
      } catch { /* best-effort UI refresh */ }
      setConfirmDisconnect(false);
      setBusy(false);
    }
  }, [confirmDisconnect, updateDraft]);

  // ------ Health check ------

  const refreshCloudStatus = useCallback(async (opts?: { interactive?: boolean }): Promise<CloudStatusRefreshResult> => {
    if (!cloud?.cloudUrl || refreshInFlightRef.current) {
      return { success: false, skipped: true };
    }

    const interactive = opts?.interactive ?? false;
    const requestedCloudIdentity = getCloudRefreshIdentity(cloud);
    if (interactive) {
      setBusy(true);
    }
    refreshInFlightRef.current = true;

    try {
      const [healthInfoResult, reconcileResult] = await Promise.allSettled([
        fetchHealthInfo(cloud.cloudUrl),
        window.cloudApi.reconcile({
          writer: 'manual-refresh',
          cloudUrl: cloud.cloudUrl,
          mode: 'reconcile',
        }),
      ]);

      const latestSettings = await window.settingsApi.get();
      const latestCloud = latestSettings.cloudInstance;
      if (!isSameCloudRefreshTarget(requestedCloudIdentity, latestCloud)) {
        return { success: false, skipped: true };
      }

      setCloudHealth(healthInfoResult.status === 'fulfilled' ? healthInfoResult.value : null);
      updateDraft('cloudInstance', latestCloud);

      if (reconcileResult.status === 'rejected') {
        const message = reconcileResult.reason instanceof Error ? reconcileResult.reason.message : 'Unreachable';
        return { success: false, error: message };
      }

      if (reconcileResult.value.outcome?.result === 'failure') {
        return { success: false, error: latestCloud.lastError ?? reconcileResult.value.outcome.rawError };
      }

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unreachable';
      const latestSettings = await window.settingsApi.get();
      const latestCloud = latestSettings.cloudInstance;
      if (!isSameCloudRefreshTarget(requestedCloudIdentity, latestCloud)) {
        return { success: false, skipped: true };
      }

      setCloudHealth(null);
      await window.cloudApi.reconcile({
        writer: 'manual-refresh',
        cloudUrl: cloud.cloudUrl,
        mode: 'reconcile',
      }).catch(() => undefined);
      const refreshedCloud = (await window.settingsApi.get()).cloudInstance;
      if (isSameCloudRefreshTarget(requestedCloudIdentity, refreshedCloud)) {
        updateDraft('cloudInstance', refreshedCloud);
      }
      return { success: false, error: message };
    } finally {
      refreshInFlightRef.current = false;
      if (interactive) {
        setBusy(false);
      }
    }
  }, [cloud, updateDraft]);

  const handleCheckHealth = useCallback(async () => {
    if (busy || !cloud?.cloudUrl) return;
    await refreshCloudStatus({ interactive: true });
  }, [busy, cloud?.cloudUrl, refreshCloudStatus]);

  // ------ Clipboard & web link ------

  const handleCopyField = useCallback((field: 'url' | 'token') => {
    const value = field === 'url' ? cloud?.cloudUrl : cloud?.cloudToken;
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }, [cloud?.cloudUrl, cloud?.cloudToken]);

  const handleOpenWebLink = useCallback(() => {
    if (!cloud?.cloudUrl || !cloud?.cloudToken) return;
    const webUrl = `${cloud.cloudUrl}/app#token=${encodeURIComponent(cloud.cloudToken)}`;
    window.open(webUrl, '_blank', 'noopener,noreferrer');
  }, [cloud?.cloudUrl, cloud?.cloudToken]);

  return {
    // Derived state
    mode,
    isConnected: connected,
    isSetupNeeded: mode === 'cloud' && !cloud?.cloudUrl,
    status,

    // Form state
    urlInput,
    tokenInput,
    setUrlInput,
    setTokenInput,

    // Connection state
    pendingMode,
    setPendingMode,
    connectError,
    connectPhase,
    setConnectError,

    // Disconnect state
    confirmDisconnect,

    // Cloud health
    cloudHealth,
    setCloudHealth,

    // Outbox & continuity
    outboxStatus,
    continuityStats,

    // Clipboard
    copiedField,

    // Busy
    busy,
    setBusy,

    // Handlers
    handleModeChange,
    handleConnect,
    handleDisconnect,
    refreshCloudStatus,
    handleCheckHealth,
    handleCopyField,
    handleOpenWebLink,
  };
}
