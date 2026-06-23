/**
 * Stage 7 — `useExternalContextQueue`
 *
 * Tracks external browser-extension state for renderer surfaces:
 *   - **tab context**, per session — set when the user triggers an
 *     intent from the extension popup. Powers `<BrowserContextChip>`.
 *   - **pending-input buffer depth**, per session — incremented when an
 *     intent message arrives during an active turn, cleared when the
 *     main-process drains the buffer. Powers `<ExternalContextIndicator>`.
 *
 * Wire-up: subscribes once to the three preload-exposed IPC factories
 * (`onIntentExternalContextArrived`, `onIntentBufferedMessage`,
 * `onIntentBufferDrained`) which handle buffering of events that arrive
 * before the subscriber registers.
 *
 * The store is a standalone Zustand store rather than a slice on
 * `sessionStore` because (a) this state is ephemeral (no persistence,
 * wiped on reload) and (b) sessionStore is already large and adding a
 * transient browser-specific concern there would bloat it.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md Stage 7
 */

import { useEffect } from 'react';
import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserTabContext {
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
}

export interface ExternalDocumentContext {
  host?: string;
  url?: string;
  title?: string;
}

export interface ExternalContextEntry {
  /** Latest tabContext snapshot seen for this conversation. */
  tabContext?: BrowserTabContext;
  /** Latest Office document context for this conversation, when present. */
  documentContext?: ExternalDocumentContext;
  /** Full validated ExternalContext representation. */
  externalContext?: unknown;
  /** App id that produced the last update (usually `'browser-extension'`). */
  appId: string;
  /** Number of messages currently held in the pending-input buffer. */
  queueSize: number;
  /** Last buffered message's text (first 120 chars) — for UI preview. */
  lastBufferedPreview?: string;
  /** ms-epoch of the most recent buffered-message update. */
  lastReceivedAt: number;
}

interface ExternalContextQueueState {
  /** sessionId → snapshot */
  bySession: Record<string, ExternalContextEntry>;

  recordArrival: (update: {
    sessionId: string;
    appId: string;
    tabContext?: BrowserTabContext;
    documentContext?: ExternalDocumentContext;
    externalContext?: unknown;
    receivedAt: number;
  }) => void;
  recordBuffered: (update: {
    sessionId: string;
    appId: string;
    text: string;
    queueSize: number;
    tabContext?: BrowserTabContext;
    documentContext?: ExternalDocumentContext;
    externalContext?: unknown;
    receivedAt: number;
  }) => void;
  recordDrained: (update: {
    sessionId: string;
    flushedCount: number;
    remaining: number;
  }) => void;
  clearForSession: (sessionId: string) => void;
  /** Test-only helper — wipe everything. Never call from production code. */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useExternalContextQueueStore = create<ExternalContextQueueState>((set) => ({
  bySession: {},
  recordArrival: ({ sessionId, appId, tabContext, documentContext, externalContext, receivedAt }) =>
    set((state) => {
      const prev = state.bySession[sessionId];
      const isBrowserUpdate = appId === 'browser-extension';
      const isOfficeUpdate = appId === 'office-addin';
      const isSlackUpdate = appId === 'slack';
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...(prev ?? { queueSize: 0, lastReceivedAt: receivedAt }),
            appId,
            tabContext: tabContext ?? (isOfficeUpdate || isSlackUpdate ? undefined : prev?.tabContext),
            documentContext: documentContext ?? (isBrowserUpdate || isSlackUpdate ? undefined : prev?.documentContext),
            externalContext: externalContext ?? prev?.externalContext,
            lastReceivedAt: receivedAt,
          },
        },
      };
    }),
  recordBuffered: ({ sessionId, appId, text, queueSize, tabContext, documentContext, externalContext, receivedAt }) =>
    set((state) => {
      const prev = state.bySession[sessionId];
      const isBrowserUpdate = appId === 'browser-extension';
      const isOfficeUpdate = appId === 'office-addin';
      const isSlackUpdate = appId === 'slack';
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            appId,
            tabContext: tabContext ?? (isOfficeUpdate || isSlackUpdate ? undefined : prev?.tabContext),
            documentContext: documentContext ?? (isBrowserUpdate || isSlackUpdate ? undefined : prev?.documentContext),
            externalContext: externalContext ?? prev?.externalContext,
            queueSize,
            lastBufferedPreview: text.slice(0, 120),
            lastReceivedAt: receivedAt,
          },
        },
      };
    }),
  recordDrained: ({ sessionId, remaining }) =>
    set((state) => {
      const prev = state.bySession[sessionId];
      if (!prev) return state;
      // `remaining === 0` → clear the buffer preview but keep the latest
      // tabContext so BrowserContextChip stays visible.
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...prev,
            queueSize: remaining,
            lastBufferedPreview: remaining === 0 ? undefined : prev.lastBufferedPreview,
          },
        },
      };
    }),
  clearForSession: (sessionId) =>
    set((state) => {
      if (!state.bySession[sessionId]) return state;
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    }),
  reset: () => set({ bySession: {} }),
}));

// ---------------------------------------------------------------------------
// Subscription hook — mounts once at the app root
// ---------------------------------------------------------------------------

/**
 * Subscribes to the three `intent:*` preload factories and mirrors them
 * into `useExternalContextQueueStore`. Mount exactly once at a stable
 * high-level component (App.tsx) — extra mounts will double-dispatch
 * every event.
 */
export function useSubscribeToExternalContextQueue(): void {
  const recordArrival = useExternalContextQueueStore((s) => s.recordArrival);
  const recordBuffered = useExternalContextQueueStore((s) => s.recordBuffered);
  const recordDrained = useExternalContextQueueStore((s) => s.recordDrained);

  useEffect(() => {
    const api = window.api as
      | {
          onIntentExternalContextArrived?: (
            cb: (data: {
              sessionId: string;
              appId: string;
              tabContext?: BrowserTabContext;
              documentContext?: ExternalDocumentContext;
              externalContext?: unknown;
              receivedAt: number;
            }) => void,
          ) => (() => void) | undefined;
          onIntentBufferedMessage?: (
            cb: (data: {
              sessionId: string;
              appId: string;
              text: string;
              queueSize: number;
              tabContext?: BrowserTabContext;
              documentContext?: ExternalDocumentContext;
              externalContext?: unknown;
              receivedAt: number;
            }) => void,
          ) => (() => void) | undefined;
          onIntentBufferDrained?: (
            cb: (data: {
              sessionId: string;
              flushedIds: string[];
              remaining: number;
            }) => void,
          ) => (() => void) | undefined;
        }
      | undefined;

    if (!api) return;

    const offArrived = api.onIntentExternalContextArrived?.((data) => {
      recordArrival(data);
    });
    const offBuffered = api.onIntentBufferedMessage?.((data) => {
      recordBuffered(data);
    });
    const offDrained = api.onIntentBufferDrained?.((data) => {
      recordDrained({
        sessionId: data.sessionId,
        flushedCount: data.flushedIds.length,
        remaining: data.remaining,
      });
    });

    return () => {
      offArrived?.();
      offBuffered?.();
      offDrained?.();
    };
  }, [recordArrival, recordBuffered, recordDrained]);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Returns the latest tab context + queue state for a specific session. */
export function useExternalContextForSession(
  sessionId: string | null | undefined,
): ExternalContextEntry | undefined {
  return useExternalContextQueueStore((s) =>
    sessionId ? s.bySession[sessionId] : undefined,
  );
}
