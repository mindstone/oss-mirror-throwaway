/**
 * useAppBridgePairedCount
 *
 * Small hook that tracks "how many browser extensions are currently paired
 * with the local App Bridge". It's a thin wrapper around the
 * `window.appBridgeApi.listPaired` IPC that:
 *
 *   - Loads once on mount
 *   - Re-loads on the broadcast signal `app-bridge:pending-approval-updated`
 *     (main emits this whenever pair-state-adjacent things happen — it's the
 *     cheapest "something changed" ping we have without adding a new channel)
 *   - Exposes a `refresh()` caller so consumers that *know* they just
 *     mutated pair state (e.g. `UnifiedConnectionsPanel.handleDisconnect`
 *     after a `revoke`) can force an immediate re-read instead of waiting
 *     for the broadcast to arrive.
 *
 * This exists because the Rebel Browser connector card in Settings used to
 * derive "connected / not connected" from the backing MCP server's health,
 * which is always `'ok'` for the internal `RebelAppBridge` server. Users
 * who clicked "Disconnect" saw no UI change because tokens get revoked but
 * the server keeps running. The card now consults this hook's count so
 * it can flip to "not connected" (and reveal the Install button again)
 * when no clients are paired.
 *
 * Intentional non-goals:
 *   - Does not expose per-client metadata (that still lives in the
 *     agent-mode pair section which owns the full list UI).
 *   - Does not poll. Load + broadcast + manual refresh is enough for a
 *     Settings panel users open occasionally.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface AppBridgeApi {
  listPaired: () => Promise<{ clients: Array<{ clientId: string }> }>;
}

interface AppBridgeSubscriptionsApi {
  onPendingApprovalUpdated: (cb: () => void) => () => void;
}

function getAppBridgeApi(): AppBridgeApi | null {
  const w = window as unknown as { appBridgeApi?: AppBridgeApi };
  return w.appBridgeApi ?? null;
}

function getAppBridgeSubscriptions(): AppBridgeSubscriptionsApi | null {
  const w = window as unknown as {
    appBridgeSubscriptions?: AppBridgeSubscriptionsApi;
  };
  return w.appBridgeSubscriptions ?? null;
}

export interface UseAppBridgePairedCountResult {
  /**
   * Number of paired clients. `null` means "not loaded yet" — callers should
   * NOT treat `null` as zero, or the card will briefly render as
   * "not connected" during the first paint and flash the Install button.
   */
  pairedCount: number | null;
  /** Loaded at least once. */
  loaded: boolean;
  /** Force a re-fetch (e.g. right after a `revoke`). */
  refresh: () => Promise<void>;
}

export function useAppBridgePairedCount(): UseAppBridgePairedCountResult {
  const [pairedCount, setPairedCount] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Latest-wins guard for overlapping fetches (e.g. broadcast + manual
  // refresh firing within ms of each other).
  const inflightSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const api = getAppBridgeApi();
    if (!api) {
      // In contexts where the bridge API isn't exposed (non-desktop
      // surfaces, tests without the preload script) we want the caller to
      // treat the count as zero rather than leaving the card stuck in
      // "loading" forever. This is a *structural* absence of the API,
      // not a transient IPC failure — it's safe to fall back to zero.
      setPairedCount(0);
      setLoaded(true);
      return;
    }
    const seq = ++inflightSeqRef.current;
    try {
      const res = await api.listPaired();
      if (seq !== inflightSeqRef.current) return; // A newer fetch superseded us
      setPairedCount(res.clients.length);
      setLoaded(true);
    } catch (err) {
      // Transient IPC failures (preload disconnect, main-process error,
      // etc.) must NOT silently become "zero paired clients" — that would
      // falsely flip the Rebel Browser card into the Available bucket and
      // hide the real problem. Preserve whatever value we already had.
      // The handler at `src/main/ipc/appBridgeHandlers.ts` is responsible
      // for returning an empty list (NOT throwing) when the bridge itself
      // is not running, so a throw here is a genuine error worth logging.
      if (seq !== inflightSeqRef.current) return;
      console.warn('[useAppBridgePairedCount] listPaired failed', err);
      setLoaded(true); // unblock the UI even if count stays stale
    }
  }, []);

  useEffect(() => {
    void refresh();
    const subs = getAppBridgeSubscriptions();
    if (!subs) return;
    const unsubscribe = subs.onPendingApprovalUpdated(() => {
      void refresh();
    });
    return unsubscribe;
  }, [refresh]);

  return { pairedCount, loaded, refresh };
}
