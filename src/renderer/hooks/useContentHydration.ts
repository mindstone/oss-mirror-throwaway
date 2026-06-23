import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { ContentRef } from '@shared/types/agent';
import {
  normalizeContentResolutionReason,
  type ContentResolutionReason,
} from '@core/types/contentResolutionReason';

export type ContentHydrationState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; text: string; mimeType: string; byteSize: number }
  | { kind: 'failed'; reason: ContentResolutionReason };

export interface UseContentHydrationOptions {
  sessionId: string;
  contentRef: ContentRef;
  /** Auto-trigger hydration on mount. Defaults to false (renderer fetches on demand). */
  autoFetch?: boolean;
}

export interface UseContentHydrationResult {
  state: ContentHydrationState;
  hydrate: () => Promise<void>;
  reset: () => void;
}

interface CachedHydrationSuccess {
  text: string;
  mimeType: string;
  byteSize: number;
}

interface ContentHydrationCacheStore {
  entries: Record<string, CachedHydrationSuccess>;
  setEntry: (key: string, value: CachedHydrationSuccess) => void;
  deleteEntry: (key: string) => void;
}

const useContentHydrationCacheStore = create<ContentHydrationCacheStore>((set) => ({
  entries: {},
  setEntry: (key, value) => {
    set((state) => ({
      entries: {
        ...state.entries,
        [key]: value,
      },
    }));
  },
  deleteEntry: (key) => {
    set((state) => {
      const next = { ...state.entries };
      delete next[key];
      return { entries: next };
    });
  },
}));

function cacheKey(sessionId: string, contentId: string): string {
  return `${sessionId}::${contentId}`;
}

function decodeBase64ToString(b64: string): string {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  type NodeBufferLike = { toString(encoding: string): string };
  const globalCtx = globalThis as unknown as { Buffer?: { from(b: string, e: string): NodeBufferLike } };
  if (globalCtx.Buffer) {
    return globalCtx.Buffer.from(b64, 'base64').toString('utf8');
  }
  return '';
}

type SessionsReadContentResult =
  | { reason: 'ok'; bytesBase64: string; mimeType: string }
  | { reason: string };

function isSessionsReadContentSuccess(value: SessionsReadContentResult): value is {
  reason: 'ok';
  bytesBase64: string;
  mimeType: string;
} {
  return (
    value.reason === 'ok'
    && 'bytesBase64' in value
    && typeof value.bytesBase64 === 'string'
    && 'mimeType' in value
    && typeof value.mimeType === 'string'
  );
}

function isCloudDownloadOk(value: unknown): value is {
  reason: 'ok';
  bytes: Uint8Array;
  mimeType: string;
} {
  return (
    !!value
    && typeof value === 'object'
    && 'reason' in value
    && (value as { reason: unknown }).reason === 'ok'
    && 'bytes' in value
    && value.bytes instanceof Uint8Array
    && 'mimeType' in value
    && typeof value.mimeType === 'string'
  );
}

async function readContentViaDesktopIpc(sessionId: string, contentId: string): Promise<SessionsReadContentResult | null> {
  const sessionsApi = (window as unknown as {
    sessionsApi?: {
      readContent?: (args: { sessionId: string; contentId: string }) => Promise<unknown>;
      read?: (args: { sessionId: string; contentId: string }) => Promise<unknown>;
    };
  }).sessionsApi;

  if (sessionsApi?.readContent) {
    return sessionsApi.readContent({ sessionId, contentId }) as Promise<SessionsReadContentResult>;
  }
  if (sessionsApi?.read) {
    return sessionsApi.read({ sessionId, contentId }) as Promise<SessionsReadContentResult>;
  }
  return null;
}

async function readContentViaCloudClient(sessionId: string, contentId: string): Promise<SessionsReadContentResult | null> {
  const cloudClient = (window as unknown as {
    cloudClient?: {
      downloadContent?: (sessionId: string, contentId: string) => Promise<unknown>;
    };
  }).cloudClient;

  if (!cloudClient?.downloadContent) {
    return null;
  }

  const result = await cloudClient.downloadContent(sessionId, contentId) as
    | { reason: 'ok'; bytes: Uint8Array; mimeType: string }
    | { reason: string };
  if (!isCloudDownloadOk(result)) {
    return { reason: result.reason };
  }
  let bytesBase64 = '';
  const globalCtx = globalThis as unknown as {
    Buffer?: { from: (value: Uint8Array) => { toString: (encoding: string) => string } };
  };
  if (globalCtx.Buffer) {
    bytesBase64 = globalCtx.Buffer.from(result.bytes).toString('base64');
  } else {
    const binary = Array.from(result.bytes).map((byte) => String.fromCharCode(byte)).join('');
    bytesBase64 = btoa(binary);
  }
  return {
    reason: 'ok',
    bytesBase64,
    mimeType: result.mimeType,
  };
}

/**
 * `useContentHydration` — renderer-side state machine for `content_ref`
 * payloads. Defaults to `idle` (renderer shows `summary`); transitions to
 * `loading → success | failed` via the `hydrate()` callback. Successful
 * hydrations are memoized per-session to avoid re-fetching across remounts.
 *
 * @see docs/plans/260518_cloud_sync_reconciliation_hardening.md § Stage B1b
 */
export function useContentHydration(
  options: UseContentHydrationOptions,
): UseContentHydrationResult {
  const { sessionId, contentRef, autoFetch = false } = options;
  const key = cacheKey(sessionId, contentRef.contentId);
  const cachedEntry = useContentHydrationCacheStore((state) => state.entries[key]);
  const setEntry = useContentHydrationCacheStore((state) => state.setEntry);
  const deleteEntry = useContentHydrationCacheStore((state) => state.deleteEntry);
  const initialCached = cachedEntry
    ? {
      kind: 'success' as const,
      text: cachedEntry.text,
      mimeType: cachedEntry.mimeType,
      byteSize: cachedEntry.byteSize,
    }
    : undefined;
  const [state, setState] = useState<ContentHydrationState>(
    initialCached ?? { kind: 'idle' },
  );
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hydrate = useCallback(async () => {
    if (state.kind === 'loading' || state.kind === 'success') return;
    setState({ kind: 'loading' });
    try {
      const desktopResult = await readContentViaDesktopIpc(sessionId, contentRef.contentId);
      const result = desktopResult ?? await readContentViaCloudClient(sessionId, contentRef.contentId);

      if (!result) {
        if (mountedRef.current) {
          setState({ kind: 'failed', reason: 'unknown' });
        }
        return;
      }

      if (!mountedRef.current) return;
      if (isSessionsReadContentSuccess(result)) {
        const text = decodeBase64ToString(result.bytesBase64);
        const byteSize = new TextEncoder().encode(text).byteLength;
        const success: ContentHydrationState = {
          kind: 'success',
          text,
          mimeType: result.mimeType,
          byteSize,
        };
        setEntry(key, {
          text,
          mimeType: result.mimeType,
          byteSize,
        });
        setState(success);
        return;
      }
      const normalized = normalizeContentResolutionReason(result.reason);
      const reason: ContentResolutionReason =
        normalized === 'unknown' && result.reason === 'corrupt'
          ? 'unknown'
          : (normalized === 'unknown' && typeof result.reason === 'string' ? result.reason : normalized);
      setState({ kind: 'failed', reason });
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setState({
        kind: 'failed',
        reason: /network|fetch|abort|timeout/i.test(message) ? 'fetch-failed' : 'unknown',
      });
    }
  }, [contentRef.contentId, key, sessionId, setEntry, state.kind]);

  const reset = useCallback(() => {
    deleteEntry(key);
    setState({ kind: 'idle' });
  }, [deleteEntry, key]);

  useEffect(() => {
    if (autoFetch && state.kind === 'idle') {
      void hydrate();
    }
  }, [autoFetch, hydrate, state.kind]);

  return { state, hydrate, reset };
}

export function clearContentHydrationCacheForTests(): void {
  useContentHydrationCacheStore.setState({ entries: {} });
}
