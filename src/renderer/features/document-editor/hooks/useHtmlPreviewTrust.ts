/**
 * useHtmlPreviewTrust — per-file trust state for the rebel-html viewer.
 *
 * Two-state model: 'strict' (default) and 'trusted'. The user toggles between
 * them via the banner in DocumentRenderers.tsx. When the state changes, the
 * caller is expected to remount the iframe (e.g. via a `reloadKey`) so the
 * rebel-html protocol handler reissues with the appropriate CSP.
 *
 * @see src/core/services/htmlPreviewTrustService.ts
 * @see src/main/services/rebelHtmlCsp.ts
 * @see docs/plans/260525_html_preview_trust_tiers.md
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type HtmlPreviewTrustState = 'unknown' | 'strict' | 'trusted';

export interface UseHtmlPreviewTrustResult {
  state: HtmlPreviewTrustState;
  /** Bumps each time trust changes — feed into the iframe `key` to force CSP refetch. */
  reloadKey: number;
  /** Mark the current file as trusted. Returns true on success. */
  trust: () => Promise<boolean>;
  /** Reset trust for the current file. */
  reset: () => Promise<void>;
}

export function useHtmlPreviewTrust(documentPath: string | null): UseHtmlPreviewTrustResult {
  const [state, setState] = useState<HtmlPreviewTrustState>('unknown');
  const [reloadKey, setReloadKey] = useState(0);
  const activePathRef = useRef<string | null>(null);

  const refresh = useCallback(async (path: string) => {
    try {
      const result = await window.htmlPreviewTrustApi.isTrusted({ workspacePath: path });
      // Late-arriving results for a previous path must not overwrite the current state.
      if (activePathRef.current !== path) return;
      setState(result.trusted ? 'trusted' : 'strict');
    } catch (err) {
      if (activePathRef.current !== path) return;
      // Degrade to strict on error — strict is the safe default.
      console.warn('[htmlPreviewTrust] isTrusted failed', err);
      setState('strict');
    }
  }, []);

  useEffect(() => {
    activePathRef.current = documentPath;
    if (!documentPath) {
      setState('unknown');
      return;
    }
    setState('unknown');
    void refresh(documentPath);
  }, [documentPath, refresh]);

  const trust = useCallback(async (): Promise<boolean> => {
    if (!documentPath) return false;
    try {
      const result = await window.htmlPreviewTrustApi.trust({ workspacePath: documentPath });
      if (!result.success) {
        console.warn('[htmlPreviewTrust] trust failed', result.error);
        return false;
      }
      if (activePathRef.current === documentPath) {
        setState('trusted');
        setReloadKey((k) => k + 1);
      }
      return true;
    } catch (err) {
      console.warn('[htmlPreviewTrust] trust threw', err);
      return false;
    }
  }, [documentPath]);

  const reset = useCallback(async (): Promise<void> => {
    if (!documentPath) return;
    try {
      await window.htmlPreviewTrustApi.reset({ workspacePath: documentPath });
      if (activePathRef.current === documentPath) {
        setState('strict');
        setReloadKey((k) => k + 1);
      }
    } catch (err) {
      console.warn('[htmlPreviewTrust] reset threw', err);
    }
  }, [documentPath]);

  return { state, reloadKey, trust, reset };
}
