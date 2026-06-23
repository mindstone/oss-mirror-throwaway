import { useEffect, useRef, useState, useCallback, useMemo, memo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, ExternalLink, Maximize2, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { IconButton } from '@renderer/components/ui';
import {
  buildCSPString,
  injectCspMeta,
  isMessageFromAllowedSandboxFrame,
} from '@renderer/components/sandbox/utilities';
import { resolveSourceDisplayName } from '@shared/utils/mcpAppDisplayNames';
import type {
  McpAppUiMeta,
  McpAppViewData,
  RendererLogPayload,
  TrustBoundaryLogKind,
  TrustBoundaryRejection,
  TrustBoundaryRejectionReason,
} from '@shared/types';
import styles from './McpAppView.module.css';

function extractPackageIdFromResourceUri(resourceUri: string | undefined): string | null {
  if (!resourceUri || !resourceUri.startsWith('ui://')) {
    return null;
  }

  try {
    const parsed = new URL(resourceUri);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

function buildToolResultPayload(
  toolResult: McpAppViewData['toolResult'] | undefined,
  toolResultText: string | undefined,
): McpAppViewData['toolResult'] | null {
  if (toolResult) {
    return toolResult;
  }
  if (!toolResultText) {
    return null;
  }
  return {
    content: [{ type: 'text', text: toolResultText }],
  };
}

const RESIZE_RATE_LIMIT_WINDOW_MS = 60_000;
const RESIZE_IFRAME_LIMIT = 30;
const RESIZE_AGGREGATE_LIMIT = 500;
const RESIZE_EXCESS_LOG_THROTTLE_MS = 1_000;
const resizeAggregateBuckets = new Map<string, number[]>();

export function createIframeInstanceId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure MCP App iframe instance IDs require crypto.randomUUID');
  }
  return globalThis.crypto.randomUUID();
}

type McpPermissionChangedForForwarding = {
  kind?: 'granted' | 'revoked';
  scope?: string;
  sourcePackageId?: string;
  conversationId?: string;
  method?: string;
  methods?: string[];
};

function pruneTimestamps(timestamps: number[], now: number): number[] {
  return timestamps.filter((timestamp) => timestamp > now - RESIZE_RATE_LIMIT_WINDOW_MS);
}

function getResizeAggregateKey(sessionId: string | undefined, conversationId: string | undefined): string {
  return `resize\u0000${sessionId ?? 'unknown-session'}\u0000${conversationId ?? 'unknown-conversation'}`;
}

function makeRendererRejection(
  reason: TrustBoundaryRejectionReason,
  safeMessage: string,
  jsonRpcCode: TrustBoundaryRejection['jsonRpcCode'] = -32603,
): TrustBoundaryRejection {
  return { reason, safeMessage, jsonRpcCode };
}

/**
 * True for messages shaped like an MCP App JSON-RPC *request* (has a method and
 * a correlation id). Used to tell our protocol's own dropped requests apart from
 * the ambient `postMessage` chatter that arrives on `window` — so telemetry at
 * the trust boundary only fires for messages an iframe is actually awaiting a
 * reply to, never for foreign noise.
 */
/**
 * MCP-App iframe send-and-wait contract (durable handshake)
 * ---------------------------------------------------------
 * The host ALWAYS replies to an id-correlated iframe request (`tools/call`,
 * `ui/sendMessage`, `ui/updateModelContext`, `ui/initialize`) — success or
 * error — and logs the reply when it can't be delivered (see
 * `emitRendererDeliveryLog` / `logIfUndeliverable` below; REBEL-677). But the
 * reply can still be lost in transit (the iframe reloads / its window changes
 * identity mid-flight), so the iframe side MUST NOT wait forever.
 *
 * **Any iframe that posts an id-correlated request and re-enables UI on the
 * reply MUST arm a bounded `setTimeout` and recover if no reply arrives.**
 * The two existing send-and-wait substrates already do this and are the
 * reference implementations:
 *   - google-workspace `compose-email-template.ts` (75s, self-contained)
 *   - `resources/mcp/rebel-canvas/views/_actionSubstrate.js` (30s, shared by the
 *     canvas form/confirm/picker views — new canvas views inherit it for free)
 *
 * A new send-and-wait iframe should reuse the substrate for its domain, or
 * (for an OSS-portable connector iframe) **vendor** the timeout logic inline —
 * do NOT depend on a Rebel-host-injected helper for the handshake. The host
 * only injects `__MCP_HOST_CONTEXT__` as a *soft/optional* dependency (theme);
 * a *hard* handshake dependency would break the connector's standalone/OSS use.
 *
 * Decision record: a universal host-injected handshake helper and a static
 * "missing timeout" CI guard were both evaluated and rejected as
 * over-engineering (0 current exposure; both consumers already bounded + tested;
 * the static guard can't reliably see JS inside template-literal iframe strings).
 * See docs/plans/260609_mcp-app-durable-handshake/.
 */
function looksLikeMcpAppRequest(
  data: unknown,
): data is { jsonrpc: string; method: string; id: unknown } {
  return (
    !!data
    && typeof data === 'object'
    && (data as { jsonrpc?: unknown }).jsonrpc === '2.0'
    && typeof (data as { method?: unknown }).method === 'string'
    && 'id' in (data as object)
  );
}

/**
 * Strip query/hash from an MCP App resource URI before logging. Family URIs
 * (e.g. `ui://RebelCanvas/form?id=<uuid>`) can carry per-instance ids; telemetry
 * must stay PII-safe, so log only the scheme/authority/path.
 */
function redactResourceUri(uri: string | undefined): string | undefined {
  return uri ? uri.split(/[?#]/)[0] : undefined;
}

/**
 * Observability for the two silent sinks on the iframe↔host request/response
 * handshake (REBEL-677 / FOX-3484): a request-shaped message dropped at the
 * sandbox-frame guard, or a reply that can't be delivered because the awaiting
 * iframe window is gone. Without this, a lost reply leaves the iframe's button
 * stuck with zero feedback AND zero telemetry. PII-safe (family name only);
 * never throws (must not worsen an already-bad message).
 */
function emitRendererDeliveryLog(message: string, context: Record<string, unknown>): void {
  try {
    const payload: RendererLogPayload = {
      level: 'warn',
      message,
      source: 'renderer',
      timestamp: Date.now(),
      context: {
        boundary: 'mcp-apps-bidirectional-trust',
        ...context,
      },
    };
    (window as unknown as { api?: { logEvent?: (payload: RendererLogPayload) => void } }).api?.logEvent?.(payload);
  } catch {
    // Delivery logging must not make an already-bad iframe message worse.
  }
}

function emitRendererTrustRejectionLog(params: {
  sourcePackageId?: string;
  sessionId?: string;
  conversationId?: string;
  toolUseId?: string;
  resourceUri?: string;
  method: string;
  nonce?: string;
  rejection: TrustBoundaryRejection;
  kind: TrustBoundaryLogKind;
  attemptedContentBytes?: number;
  rateLimitTier?: 'iframe' | 'conversation' | 'session' | 'aggregate';
  attemptCount?: number;
}): void {
  try {
    const payload: RendererLogPayload = {
      level: 'warn',
      message: 'Rejected MCP App iframe message at renderer trust boundary',
      source: 'renderer',
      timestamp: Date.now(),
      context: {
        boundary: 'mcp-apps-bidirectional-trust',
        sessionId: params.sessionId ?? 'unknown',
        conversationId: params.conversationId ?? 'unknown',
        sourcePackageFamily: resolveSourceDisplayName(params.sourcePackageId).displayName,
        kind: params.kind,
        method: params.method,
        nonce: params.nonce || 'none',
        reason: params.rejection.reason,
        attemptedContentBytes: params.attemptedContentBytes ?? 0,
        ...(params.toolUseId ? { toolUseId: params.toolUseId } : {}),
        ...(params.resourceUri ? { resourceUri: params.resourceUri } : {}),
        ...(params.rateLimitTier ? { rateLimitTier: params.rateLimitTier } : {}),
        ...(typeof params.attemptCount === 'number' ? { attemptCount: params.attemptCount } : {}),
      },
    };
    (window as unknown as { api?: { logEvent?: (payload: RendererLogPayload) => void } }).api?.logEvent?.(payload);
  } catch {
    // Trust-boundary logging must not make an already-bad iframe message worse.
  }
}

function useResizeRateLimit(params: {
  sourcePackageId?: string;
  sessionId?: string;
  conversationId?: string;
  iframeInstanceId: string;
  toolUseId?: string;
  resourceUri: string;
  onResize: (height: number) => void;
}): (height: number) => void {
  const {
    sourcePackageId,
    sessionId,
    conversationId,
    toolUseId,
    resourceUri,
    onResize,
  } = params;
  const iframeResizeHitsRef = useRef<number[]>([]);
  const pendingHeightRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const coalesceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastExcessLogAtRef = useRef(0);

  const applyPendingHeight = useCallback(() => {
    animationFrameRef.current = null;
    const height = pendingHeightRef.current;
    pendingHeightRef.current = null;
    if (height !== null) {
      onResize(height);
    }
  }, [onResize]);

  const scheduleAnimationFrame = useCallback(() => {
    if (animationFrameRef.current !== null) return;
    const requestFrame = globalThis.requestAnimationFrame
      ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
    animationFrameRef.current = requestFrame(applyPendingHeight);
  }, [applyPendingHeight]);

  const scheduleCoalescedResize = useCallback(() => {
    if (coalesceTimerRef.current !== null) return;
    coalesceTimerRef.current = setTimeout(() => {
      coalesceTimerRef.current = null;
      scheduleAnimationFrame();
    }, 250);
  }, [scheduleAnimationFrame]);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) {
      const cancelFrame = globalThis.cancelAnimationFrame ?? window.clearTimeout;
      cancelFrame(animationFrameRef.current);
    }
    if (coalesceTimerRef.current !== null) {
      clearTimeout(coalesceTimerRef.current);
    }
  }, []);

  return useCallback((rawHeight: number) => {
    const height = Math.max(40, Math.min(rawHeight, 2000));
    const now = Date.now();
    const aggregateKey = getResizeAggregateKey(sessionId, conversationId);
    const aggregateHits = pruneTimestamps(resizeAggregateBuckets.get(aggregateKey) ?? [], now);
    const iframeHits = pruneTimestamps(iframeResizeHitsRef.current, now);
    const iframeRejected = iframeHits.length >= RESIZE_IFRAME_LIMIT;
    const aggregateRejected = aggregateHits.length >= RESIZE_AGGREGATE_LIMIT;

    if (iframeRejected || aggregateRejected) {
      pendingHeightRef.current = height;
      scheduleCoalescedResize();
      if (now - lastExcessLogAtRef.current > RESIZE_EXCESS_LOG_THROTTLE_MS) {
        lastExcessLogAtRef.current = now;
        const rejection = makeRendererRejection(
          'rate_limited',
          'View is sending too many resize events. Rebel is coalescing them.',
          -32029,
        );
        emitRendererTrustRejectionLog({
          sourcePackageId,
          sessionId,
          conversationId,
          toolUseId,
          resourceUri,
          method: 'ui/resize',
          rejection,
          kind: 'rate_limit',
          rateLimitTier: aggregateRejected ? 'aggregate' : 'iframe',
          attemptCount: (aggregateRejected ? aggregateHits.length : iframeHits.length) + 1,
        });
      }
      return;
    }

    iframeHits.push(now);
    aggregateHits.push(now);
    iframeResizeHitsRef.current = iframeHits;
    resizeAggregateBuckets.set(aggregateKey, aggregateHits);
    pendingHeightRef.current = height;
    scheduleAnimationFrame();
  }, [
    conversationId,
    resourceUri,
    scheduleAnimationFrame,
    scheduleCoalescedResize,
    sessionId,
    sourcePackageId,
    toolUseId,
  ]);
}

/**
 * Inject CSP meta tag and host context into HTML content.
 * Handles various <head> tag formats safely.
 */
function injectHostContext(
  html: string,
  csp: McpAppUiMeta['csp'] | undefined,
  hostContext: { theme: string; locale?: string; platform: string },
  trustedDomains?: string[]
): string {
  const cspString = buildCSPString(csp, trustedDomains);
  
  // Escape the JSON to prevent </script> from breaking the document
  const escapedContext = JSON.stringify(hostContext).replace(/</g, '\\u003c');
  // Inject the neutral OSS name plus the legacy Rebel alias for one app-version
  // cycle: newly-published MCP Apps read __MCP_HOST_CONTEXT__, while bundled
  // Google Workspace callback HTML in this version still reads __REBEL_HOST_CONTEXT__.
  const contextScript =
    `<script>window.__MCP_HOST_CONTEXT__=${escapedContext}</script>` +
    '<script>window.__REBEL_HOST_CONTEXT__=window.__MCP_HOST_CONTEXT__</script>';

  // Error-capture / readiness script: collects runtime/CSP errors and sends them
  // to the host after a 2-second debounce. It also reports readiness once the
  // document has visible content so the host can distinguish asynchronous render
  // from a genuinely blank iframe.
  //
  // Uses addEventListener('error') instead of window.onerror to avoid clobbering
  // the preview page's own error handlers.
  const errorCaptureScript = `<script>(function() {
  var errors = [];
  var seen = new Set();
  var timer = null;
  var sent = false;
  var readySent = false;
  function collect(msg) {
    if (sent || !msg) return;
    if (seen.has(msg)) return;
    seen.add(msg);
    errors.push(msg);
    if (!timer) {
      timer = setTimeout(function() {
        sent = true;
        try { parent.postMessage({ type: 'rebel-preview-error', errors: errors }, '*'); } catch(e) {}
      }, 2000);
    }
  }
  function hasVisibleContent() {
    var body = document.body;
    if (!body) return false;
    return Boolean((body.textContent || '').trim() || body.children.length > 0);
  }
  function reportReady() {
    if (readySent || !hasVisibleContent()) return;
    readySent = true;
    try { parent.postMessage({ method: 'mcp-app:ready' }, '*'); } catch(e) {}
  }
  window.addEventListener('error', function(e) {
    var s = e.message || String(e);
    if (e.lineno) s += ' (line ' + e.lineno + (e.colno ? ':' + e.colno : '') + ')';
    collect(s);
  });
  window.addEventListener('unhandledrejection', function(e) {
    var r = e.reason;
    var s = r instanceof Error ? r.message : String(r || 'Unhandled promise rejection');
    collect(s);
  });
  window.addEventListener('securitypolicyviolation', function(e) {
    var blocked = e.blockedURI ? ' blocked ' + e.blockedURI : '';
    var directive = e.violatedDirective || e.effectiveDirective || 'content security policy';
    collect('Content Security Policy violation: ' + directive + blocked);
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      requestAnimationFrame(reportReady);
    });
  } else {
    requestAnimationFrame(reportReady);
  }
  if (typeof MutationObserver === 'function') {
    var observer = new MutationObserver(reportReady);
    observer.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
  }
})()</script>`;
  
  return injectCspMeta(html, {
    mode: 'mcp-app',
    cspString,
    additionalHeadInserts: `${contextScript}${errorCaptureScript}`,
  });
}

export interface McpAppViewProps {
  /** MCP Apps UI metadata (includes resourceUri to fetch) */
  uiMeta: McpAppUiMeta;
  /** Host-owned session ID for trust-boundary requests. */
  sessionId?: string;
  /** Host-owned conversation ID for trust-boundary requests. */
  conversationId?: string;
  /** Host-owned tool use ID for trust-boundary requests. */
  toolUseId?: string;
  /** Current theme from app settings */
  theme: 'light' | 'dark';
  /** Full tool result payload passed to MCP App via ui/notifications/tool-result */
  toolResult?: McpAppViewData['toolResult'];
  /** Tool result to send to the View (optional) */
  toolResultText?: string;
  /** Locale for the view (defaults to navigator.language) */
  locale?: string;
  /** User-trusted domains for loading scripts/styles in HTML previews */
  trustedPreviewDomains?: string[];
  /** Accessible title for the sandboxed iframe. */
  iframeTitle?: string;
  /** Host-rendered recovery surface when the iframe cannot load. */
  renderErrorFallback?: (args: { error: string; retry: () => void }) => ReactNode;
  /** Notifies parent chrome when the iframe has fallen back to host-rendered recovery. */
  onFailureStateChange?: (hasFailure: boolean) => void;
}

/**
 * McpAppView renders MCP App Views in sandboxed iframes.
 * 
 * This component fetches HTML from the resourceUri via IPC and renders it
 * in a sandboxed iframe with CSP protection.
 * 
 * @see https://modelcontextprotocol.io/docs/extensions/apps
 */
function McpAppViewComponent({
  uiMeta,
  sessionId,
  conversationId,
  toolUseId,
  theme,
  toolResult,
  toolResultText,
  locale,
  trustedPreviewDomains,
  iframeTitle,
  renderErrorFallback,
  onFailureStateChange,
}: McpAppViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeInstanceIdRef = useRef(createIframeInstanceId());
  const blobUrlRef = useRef<string | null>(null);
  const appliedProtocolUrlRef = useRef<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedHtml, setFetchedHtml] = useState<string | null>(null);
  const [iframeHeight, setIframeHeight] = useState<number>(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const fullscreenIframeRef = useRef<HTMLIFrameElement>(null);
  const fullscreenCloseRef = useRef<HTMLButtonElement>(null);
  const fullscreenTriggerRef = useRef<HTMLButtonElement>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blankViewWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewReadyRef = useRef(false);
  const cspViolationCleanupRef = useRef<(() => void) | null>(null);
  const inlineIframeInstanceId = `${iframeInstanceIdRef.current}:inline`;
  const fullscreenIframeInstanceId = `${iframeInstanceIdRef.current}:fullscreen`;
  const handleResize = useResizeRateLimit({
    sourcePackageId: uiMeta.sourcePackageId ?? undefined,
    sessionId,
    conversationId,
    iframeInstanceId: inlineIframeInstanceId,
    toolUseId,
    resourceUri: uiMeta.resourceUri,
    onResize: setIframeHeight,
  });
  const toolResultPayload = useMemo(
    () => buildToolResultPayload(toolResult, toolResultText),
    [toolResult, toolResultText]
  );
  // Kept in sync with toolResultPayload so the message-handling effect can deliver
  // the prefill when the iframe signals `mcp-app:ready`, without re-subscribing the
  // listener on every payload change. See the ready handler below for why this
  // re-delivery exists (the onLoad post is a single fire-and-forget that can lose
  // the draft if the iframe's listener isn't yet attached — REBEL-5YD/5YE/609).
  const toolResultPayloadRef = useRef(toolResultPayload);
  useEffect(() => {
    toolResultPayloadRef.current = toolResultPayload;
  }, [toolResultPayload]);
  const trustedPreviewDomainsSignature = useMemo(
    () => (trustedPreviewDomains ?? []).join('\u0000'),
    [trustedPreviewDomains],
  );
  const resolvedIframeTitle = iframeTitle ?? `MCP App View: ${uiMeta.resourceUri}`;

  useEffect(() => () => {
    void window.mcpAppsApi?.invalidateNonce?.({ iframeInstanceId: inlineIframeInstanceId });
    void window.mcpAppsApi?.invalidateNonce?.({ iframeInstanceId: fullscreenIframeInstanceId });
  }, [fullscreenIframeInstanceId, inlineIframeInstanceId]);

  useEffect(() => {
    const unsubscribe = window.api?.onMcpPermissionChanged?.((payload: McpPermissionChangedForForwarding) => {
      if (
        payload?.kind !== 'granted'
        || !uiMeta.sourcePackageId
        || payload.sourcePackageId !== uiMeta.sourcePackageId
        || payload.conversationId !== conversationId
      ) {
        // eslint-disable-next-line no-console -- diagnostic for permission-broadcast filter; debug-level by intent (not captured in production)
        console.debug('[McpAppView] Filtered permission-changed broadcast for iframe forwarding', {
          scope: payload?.scope,
          sourcePackageId: payload?.sourcePackageId,
          conversationId: payload?.conversationId,
          method: payload?.method,
          expectedSourcePackageId: uiMeta.sourcePackageId,
          expectedConversationId: conversationId,
        });
        return;
      }

      const appliesToSendMessage = payload.method === 'ui/sendMessage'
        || payload.methods?.includes('ui/sendMessage') === true;
      if (!appliesToSendMessage) {
        // eslint-disable-next-line no-console -- diagnostic for permission-broadcast filter; debug-level by intent (not captured in production)
        console.debug('[McpAppView] Filtered permission-changed broadcast for iframe forwarding', {
          scope: payload.scope,
          sourcePackageId: payload.sourcePackageId,
          conversationId: payload.conversationId,
          method: payload.method,
        });
        return;
      }

      const forwardedPayload = {
        kind: 'mcp-app:permission-changed',
        scope: payload.scope,
        sourcePackageId: uiMeta.sourcePackageId,
      };
      // eslint-disable-next-line no-console -- diagnostic for permission-broadcast forwarding; debug-level by intent (not captured in production)
      console.debug('[McpAppView] Forwarding permission-changed broadcast to matching iframe', {
        scope: payload.scope,
        sourcePackageId: uiMeta.sourcePackageId,
        conversationId,
        method: payload.method,
      });
      iframeRef.current?.contentWindow?.postMessage(forwardedPayload, '*');
      fullscreenIframeRef.current?.contentWindow?.postMessage(forwardedPayload, '*');
    });

    return () => unsubscribe?.();
  }, [conversationId, uiMeta.sourcePackageId]);

  useEffect(() => {
    if (error !== null) {
      onFailureStateChange?.(true);
    }
  }, [error, onFailureStateChange]);

  const clearBlankViewWatchdog = useCallback(() => {
    if (blankViewWatchdogTimerRef.current) {
      clearTimeout(blankViewWatchdogTimerRef.current);
      blankViewWatchdogTimerRef.current = null;
    }
  }, []);

  const markPreviewReady = useCallback(() => {
    previewReadyRef.current = true;
    clearBlankViewWatchdog();
  }, [clearBlankViewWatchdog]);

  const detachCspViolationListener = useCallback(() => {
    cspViolationCleanupRef.current?.();
    cspViolationCleanupRef.current = null;
  }, []);

  const handleRetry = useCallback(() => {
    onFailureStateChange?.(false);
    setError(null);
    setIsLoading(true);
    previewReadyRef.current = false;
    clearBlankViewWatchdog();
    detachCspViolationListener();
    setBlobUrl(null);
    setFetchedHtml(null);
    setIframeHeight(0);
    appliedProtocolUrlRef.current = null;
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setRetryNonce((value) => value + 1);
  }, [clearBlankViewWatchdog, detachCspViolationListener, onFailureStateChange]);

  // Fetch HTML content from resourceUri
  useEffect(() => {
    // Protocol URL mode: load directly from custom protocol (no fetch needed)
    if (uiMeta.protocolUrl) {
      if (!uiMeta.protocolUrl.startsWith('rebel-preview://')) {
        setError("That URL isn't quite right.");
        setIsLoading(false);
        return;
      }
      // Skip if protocol URL is already applied (theme/locale change doesn't need reload)
      if (appliedProtocolUrlRef.current === uiMeta.protocolUrl) return;
      appliedProtocolUrlRef.current = uiMeta.protocolUrl;
      previewReadyRef.current = false;
      clearBlankViewWatchdog();
      detachCspViolationListener();
      // Revoke any previous blob URL
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setBlobUrl(uiMeta.protocolUrl);
      setIsLoading(true); // will be set to false on iframe load
      setError(null);
      return;
    }

    // Standard blob URL mode: fetch HTML via IPC
    if (!uiMeta.resourceUri) {
      setError('Missing the resource URI.');
      setIsLoading(false);
      return;
    }

    // Defence-in-depth: refuse to fetch obviously malformed URIs (e.g. bare `ui://`
    // produced when Method 3 regex matches prose like `[View: ui://...]` and the
    // trailing-dot strip collapses the capture). Main-process Method 3 now validates
    // shape at emission; this guard catches any path that bypasses that.
    if (!/^ui:\/\/[^\s/]+/.test(uiMeta.resourceUri)) {
      setError("Couldn't load this view");
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const fetchHtml = async () => {
      try {
        setIsLoading(true);
        setError(null);

        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
          blobUrlRef.current = null;
        }
        previewReadyRef.current = false;
        clearBlankViewWatchdog();
        detachCspViolationListener();

        const response = await window.mcpAppsApi.readResource({
          uri: uiMeta.resourceUri,
          sourcePackageId: uiMeta.sourcePackageId ?? undefined,
        });

        if (cancelled) return;

        if (!response.success || !response.contents?.[0]) {
          setError(response.error || 'Failed to fetch view content');
          setIsLoading(false);
          return;
        }

        const content = response.contents[0];
        const htmlContent = content.text || (content.blob ? atob(content.blob) : null);

        if (!htmlContent) {
          setError('The response came back blank.');
          setIsLoading(false);
          return;
        }

        // Store fetched HTML for "Open in Browser" feature
        setFetchedHtml(htmlContent);

        const htmlWithInjections = injectHostContext(
          htmlContent,
          uiMeta.csp,
          {
            theme,
            locale: locale ?? navigator.language,
            platform: 'desktop',
          },
          trustedPreviewDomainsSignature ? trustedPreviewDomainsSignature.split('\u0000') : undefined
        );

        const blob = new Blob([htmlWithInjections], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load view';
        setError(message);
        setIsLoading(false);
      }
    };

    fetchHtml();

    return () => {
      cancelled = true;
      clearBlankViewWatchdog();
      detachCspViolationListener();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [
    uiMeta.resourceUri,
    uiMeta.protocolUrl,
    uiMeta.csp,
    uiMeta.sourcePackageId,
    theme,
    locale,
    trustedPreviewDomainsSignature,
    retryNonce,
    clearBlankViewWatchdog,
    detachCspViolationListener,
  ]);

  const FALLBACK_HEIGHT = 300;

  // Handle postMessage from both inline and fullscreen iframes
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const isInline = event.source === iframeRef.current?.contentWindow;
      if (!isMessageFromAllowedSandboxFrame(
        event,
        [iframeRef.current?.contentWindow ?? null, fullscreenIframeRef.current?.contentWindow ?? null],
        ['null', 'rebel-preview:'],
      )) {
        // A request-shaped message that fails the sandbox-frame guard (e.g. a
        // stale `event.source` after the iframe changed identity) is dropped
        // here with no reply — leaving the iframe awaiting a response that never
        // comes. Surface it so this silent sink is diagnosable (REBEL-677).
        if (looksLikeMcpAppRequest(event.data)) {
          emitRendererDeliveryLog('MCP App request dropped at renderer sandbox-frame guard', {
            kind: 'dropped_request_source_mismatch',
            method: event.data.method,
            origin: event.origin,
            sourceMatchedInline: event.source === iframeRef.current?.contentWindow,
            sourceMatchedFullscreen: event.source === fullscreenIframeRef.current?.contentWindow,
            resourceUri: redactResourceUri(uiMeta.resourceUri),
            sourcePackageFamily: resolveSourceDisplayName(uiMeta.sourcePackageId ?? undefined).displayName,
          });
        }
        return;
      }

      const data = event.data;
      if (!data || typeof data !== 'object') {
        return;
      }

      const targetWindow = isInline
        ? iframeRef.current?.contentWindow
        : fullscreenIframeRef.current?.contentWindow;
      const messageIframeInstanceId = isInline ? inlineIframeInstanceId : fullscreenIframeInstanceId;

      // A reply posts to `targetWindow` — the window captured when the request
      // arrived. For async replies (tools/call) the iframe can reload or unmount
      // during the await, swapping its `contentWindow`; the reply then no-ops
      // against a stale/null window and the iframe is left awaiting forever
      // (REBEL-677). Re-resolve the live window at post time and log when it is
      // gone OR no longer the window we're replying to, so this lost-reply sink
      // is diagnosable. (The iframe-side send timeout is what recovers the UI.)
      const logIfUndeliverable = (responseType: 'result' | 'error') => {
        const liveWindow = isInline
          ? iframeRef.current?.contentWindow
          : fullscreenIframeRef.current?.contentWindow;
        if (!targetWindow || targetWindow !== liveWindow) {
          // Accurate reason for the live-window state at post time:
          //  - no_capture:      no window when the request arrived (rare)
          //  - iframe_unmounted: captured window existed but the iframe is now gone
          //  - window_changed:   iframe reloaded → live contentWindow differs from captured
          const reason = !targetWindow
            ? 'no_capture'
            : !liveWindow
              ? 'iframe_unmounted'
              : 'window_changed';
          emitRendererDeliveryLog('MCP App reply undeliverable (awaiting iframe window gone or changed)', {
            kind: 'undeliverable_reply',
            responseType,
            reason,
            isInline,
            resourceUri: redactResourceUri(uiMeta.resourceUri),
            sourcePackageFamily: resolveSourceDisplayName(uiMeta.sourcePackageId ?? undefined).displayName,
          });
        }
      };

      const respondWithError = (id: unknown, message: string, code = -32000) => {
        logIfUndeliverable('error');
        targetWindow?.postMessage(
          {
            jsonrpc: '2.0',
            id,
            error: { code, message },
          },
          '*'
        );
      };

      const postJsonRpcResult = (id: unknown, result: unknown) => {
        logIfUndeliverable('result');
        targetWindow?.postMessage(
          {
            jsonrpc: '2.0',
            id,
            result,
          },
          '*'
        );
      };

      const dispatchTrustRejection = (
        rejection: TrustBoundaryRejection,
        options?: {
          method?: string;
          kind?: TrustBoundaryLogKind;
          nonce?: string;
          attemptedContentBytes?: number;
          toolName?: string;
        },
      ) => {
        if (options) {
          emitRendererTrustRejectionLog({
            sourcePackageId: uiMeta.sourcePackageId ?? undefined,
            sessionId,
            conversationId,
            toolUseId,
            resourceUri: uiMeta.resourceUri,
            method: options.method ?? 'unknown',
            nonce: options.nonce,
            rejection,
            kind: options.kind ?? 'invalid_params',
            attemptedContentBytes: options.attemptedContentBytes,
          });
        }
        window.dispatchEvent(
          new CustomEvent('mcp-app:trust-rejection', {
            detail: {
              resourceUri: uiMeta.resourceUri,
              sourcePackageId: uiMeta.sourcePackageId ?? undefined,
              toolUseId,
              sessionId,
              conversationId,
              method: options?.method,
              toolName: options?.toolName,
              rejection,
            },
          })
        );
      };

      const issueFreshNonce = async (
        method: 'ui/updateModelContext' | 'ui/sendMessage' | 'tools/call',
        iframeInstanceId: string,
      ): Promise<{ success: true; nonce: string } | { success: false; rejection: TrustBoundaryRejection }> => {
        if (!uiMeta.sourcePackageId || !sessionId || !conversationId || !toolUseId) {
          const rejection = makeRendererRejection(
            'source_mismatch',
            'MCP App bridge is missing host context',
          );
          dispatchTrustRejection(rejection, {
            method,
            kind: 'invalid_params',
          });
          return { success: false, rejection };
        }
        if (typeof window.mcpAppsApi?.issueNonce !== 'function') {
          const rejection = makeRendererRejection(
            'invalid_params',
            'MCP App nonce bridge not available',
            -32603,
          );
          dispatchTrustRejection(rejection, {
            method,
            kind: 'invalid_params',
          });
          return { success: false, rejection };
        }

        const response = await window.mcpAppsApi.issueNonce({
          sourcePackageId: uiMeta.sourcePackageId,
          sessionId,
          conversationId,
          toolUseId,
          iframeInstanceId,
        });
        if (!response.success) {
          const rejection = response.rejection as TrustBoundaryRejection;
          dispatchTrustRejection(rejection, {
            method,
            nonce: 'none',
          });
          return { success: false, rejection };
        }
        return { success: true, nonce: response.nonce };
      };

      // Handle preview runtime errors from the error-capture script
      if (data.type === 'rebel-preview-error' && Array.isArray(data.errors)) {
        window.dispatchEvent(
          new CustomEvent('mcp-app:preview-error', {
            detail: { resourceUri: uiMeta.resourceUri, errors: data.errors },
          })
        );
        clearBlankViewWatchdog();
        setError("This view didn't load.");
        setIsLoading(false);
        return;
      }

      if (
        data.method === 'mcp-app:ready'
        || data.method === 'ui/notifications/ready'
        || data.type === 'mcp-app:ready'
      ) {
        markPreviewReady();
        // Re-deliver the tool-result prefill now that the iframe has proven its
        // message listener is attached. The onLoad post (postToolResultNotification
        // in handleIframeLoad) is a single fire-and-forget that is lost if the
        // iframe's listener isn't yet bound when it fires — leaving the compose
        // form permanently on placeholders (REBEL-5YD/5YE/609). The iframe's
        // applyDraftData is idempotent, so re-posting here is safe and makes
        // delivery robust regardless of onLoad/ready ordering.
        const readyPayload = toolResultPayloadRef.current;
        if (targetWindow && readyPayload) {
          targetWindow.postMessage(
            {
              jsonrpc: '2.0',
              method: 'ui/notifications/tool-result',
              params: readyPayload,
            },
            '*',
          );
        }
        return;
      }

      // Handle content resize notifications (inline only)
      if (isInline && data.method === 'ui/resize' && typeof data.params?.height === 'number') {
        markPreviewReady();
        if (fallbackTimerRef.current) {
          clearTimeout(fallbackTimerRef.current);
          fallbackTimerRef.current = null;
        }
        handleResize(data.params.height);
        return;
      }

      // Handle model-context updates from the iframe. The IDs sent to IPC are
      // host-derived React props, not iframe-supplied authority.
      if (data.method === 'ui/updateModelContext' && 'id' in data) {
        const params = data.params;
        const hasContent = typeof params?.content === 'string';
        const hasStructuredContent = params && Object.prototype.hasOwnProperty.call(params, 'structuredContent');

        if (!uiMeta.sourcePackageId || !sessionId || !conversationId || !toolUseId) {
          const rejection = makeRendererRejection(
            'source_mismatch',
            'MCP App context bridge is missing host context',
          );
          dispatchTrustRejection(rejection, {
            method: 'ui/updateModelContext',
            kind: 'invalid_params',
          });
          respondWithError(data.id, 'MCP App context bridge is missing host context', -32603);
          return;
        }
        if (typeof window.mcpAppsApi?.updateContext !== 'function') {
          const rejection = makeRendererRejection(
            'invalid_params',
            'MCP App context bridge not available',
            -32603,
          );
          dispatchTrustRejection(rejection, {
            method: 'ui/updateModelContext',
            kind: 'invalid_params',
          });
          respondWithError(data.id, 'MCP App context bridge not available', -32603);
          return;
        }
        const sourcePackageId = uiMeta.sourcePackageId;

        void (async () => {
          try {
            const nonceResult = await issueFreshNonce('ui/updateModelContext', messageIframeInstanceId);
            if (!nonceResult.success) {
              respondWithError(data.id, nonceResult.rejection.safeMessage, nonceResult.rejection.jsonRpcCode);
              return;
            }
            const response = await window.mcpAppsApi.updateContext({
              sourcePackageId,
              toolUseId,
              sessionId,
              conversationId,
              iframeInstanceId: messageIframeInstanceId,
              nonce: nonceResult.nonce,
              ...(hasContent ? { content: params.content } : {}),
              ...(hasStructuredContent ? { structuredContent: params.structuredContent } : {}),
            });

            if (response.success) {
              postJsonRpcResult(data.id, { success: true });
              return;
            }

            dispatchTrustRejection(response.rejection as TrustBoundaryRejection, {
              method: 'ui/updateModelContext',
              nonce: nonceResult.nonce,
            });
            respondWithError(data.id, response.rejection.safeMessage, response.rejection.jsonRpcCode);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Context update failed';
            respondWithError(data.id, message, -32603);
          }
        })();
        return;
      }

      // Handle user-role messages from the iframe. The IDs sent to IPC are
      // host-derived React props, not iframe-supplied authority.
      if (data.method === 'ui/sendMessage' && 'id' in data) {
        const params = data.params;
        const content = typeof params?.content === 'string' ? params.content : null;
        const role = typeof params?.role === 'string' ? params.role : null;

        if (content === null || role === null) {
          const rejection = makeRendererRejection(
            'invalid_params',
            'Invalid send message request',
            -32602,
          );
          dispatchTrustRejection(rejection, {
            method: 'ui/sendMessage',
            kind: 'invalid_params',
          });
          respondWithError(data.id, rejection.safeMessage, rejection.jsonRpcCode);
          return;
        }
        if (!uiMeta.sourcePackageId || !sessionId || !conversationId || !toolUseId) {
          const rejection = makeRendererRejection(
            'source_mismatch',
            'MCP App message bridge is missing host context',
          );
          dispatchTrustRejection(rejection, {
            method: 'ui/sendMessage',
            kind: 'invalid_params',
            attemptedContentBytes: content.length,
          });
          respondWithError(data.id, 'MCP App message bridge is missing host context', -32603);
          return;
        }
        if (typeof window.mcpAppsApi?.sendMessage !== 'function') {
          const rejection = makeRendererRejection(
            'invalid_params',
            'MCP App message bridge not available',
            -32603,
          );
          dispatchTrustRejection(rejection, {
            method: 'ui/sendMessage',
            kind: 'invalid_params',
            attemptedContentBytes: content.length,
          });
          respondWithError(data.id, 'MCP App message bridge not available', -32603);
          return;
        }
        const sourcePackageId = uiMeta.sourcePackageId;

        void (async () => {
          try {
            const nonceResult = await issueFreshNonce('ui/sendMessage', messageIframeInstanceId);
            if (!nonceResult.success) {
              respondWithError(data.id, nonceResult.rejection.safeMessage, nonceResult.rejection.jsonRpcCode);
              return;
            }
            const response = await window.mcpAppsApi.sendMessage({
              sourcePackageId,
              toolUseId,
              sessionId,
              conversationId,
              iframeInstanceId: messageIframeInstanceId,
              nonce: nonceResult.nonce,
              content,
              role,
            });

            if (response.success) {
              postJsonRpcResult(data.id, { success: true });
              return;
            }

            dispatchTrustRejection(response.rejection as TrustBoundaryRejection, {
              method: 'ui/sendMessage',
              nonce: nonceResult.nonce,
              attemptedContentBytes: content.length,
            });
            respondWithError(data.id, response.rejection.safeMessage, response.rejection.jsonRpcCode);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Send message failed';
            respondWithError(data.id, message, -32603);
          }
        })();
        return;
      }

      // Handle app-initiated MCP tool calls
      if (data.method === 'tools/call' && 'id' in data) {
        const toolName = typeof data.params?.name === 'string'
          ? data.params.name
          : null;
        const toolArgs = data.params?.arguments;

        if (!toolName) {
          const rejection = makeRendererRejection(
            'invalid_params',
            'Invalid tools/call request: missing tool name',
            -32602,
          );
          dispatchTrustRejection(rejection, {
            method: 'tools/call',
            kind: 'invalid_params',
          });
          respondWithError(data.id, rejection.safeMessage, rejection.jsonRpcCode);
          return;
        }
        if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
          const rejection = makeRendererRejection(
            'invalid_params',
            'Invalid tools/call request: arguments must be an object',
            -32602,
          );
          dispatchTrustRejection(rejection, {
            method: 'tools/call',
            kind: 'invalid_params',
            toolName,
          });
          respondWithError(data.id, rejection.safeMessage, rejection.jsonRpcCode);
          return;
        }

        // Split allowlist key (app-family from URI authority) from routing key (instance package ID).
        // Allowlist uses "google-workspace"; Super-MCP routing uses "GoogleWorkspace-jane-example-com".
        const appFamily = extractPackageIdFromResourceUri(uiMeta.resourceUri);
        if (!appFamily) {
          const rejection = makeRendererRejection(
            'invalid_params',
            `Invalid MCP App resource URI: ${uiMeta.resourceUri}`,
            -32603,
          );
          dispatchTrustRejection(rejection, {
            method: 'tools/call',
            kind: 'invalid_params',
            toolName,
          });
          respondWithError(data.id, rejection.safeMessage, rejection.jsonRpcCode);
          return;
        }
        if (!uiMeta.sourcePackageId || !sessionId || !conversationId || !toolUseId) {
          const rejection = makeRendererRejection(
            'source_mismatch',
            'MCP App tool bridge is missing host context',
          );
          dispatchTrustRejection(rejection, {
            method: 'tools/call',
            kind: 'invalid_params',
            toolName,
          });
          respondWithError(data.id, 'MCP App tool bridge is missing host context', -32603);
          return;
        }

        if (typeof window.mcpAppsApi?.callTool !== 'function') {
          const rejection = makeRendererRejection(
            'invalid_params',
            'MCP tool bridge not available',
            -32603,
          );
          dispatchTrustRejection(rejection, {
            method: 'tools/call',
            kind: 'invalid_params',
            toolName,
          });
          respondWithError(data.id, 'MCP tool bridge not available', -32603);
          return;
        }
        const sourcePackageId = uiMeta.sourcePackageId;

        void (async () => {
          try {
            const nonceResult = await issueFreshNonce('tools/call', messageIframeInstanceId);
            if (!nonceResult.success) {
              respondWithError(data.id, nonceResult.rejection.safeMessage, nonceResult.rejection.jsonRpcCode);
              return;
            }
            const response = await window.mcpAppsApi.callTool({
              appFamily,
              sourcePackageId,
              toolUseId,
              sessionId,
              conversationId,
              iframeInstanceId: messageIframeInstanceId,
              nonce: nonceResult.nonce,
              toolName,
              args: toolArgs as Record<string, unknown>,
            });

            if (response.success) {
              postJsonRpcResult(data.id, response.result ?? null);
              return;
            }

            if ('rejection' in response && response.rejection) {
              dispatchTrustRejection(response.rejection as TrustBoundaryRejection, {
                method: 'tools/call',
                nonce: nonceResult.nonce,
                toolName,
              });
              respondWithError(data.id, response.rejection.safeMessage, response.rejection.jsonRpcCode);
              return;
            }

            respondWithError(data.id, response.error || 'Tool call failed');
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Tool call failed';
            respondWithError(data.id, message);
          }
        })();
        return;
      }

      // Handle ui/initialize request
      if (data.method === 'ui/initialize' && 'id' in data) {
        if (!uiMeta.sourcePackageId || !sessionId || !conversationId || !toolUseId) {
          const rejection = makeRendererRejection(
            'source_mismatch',
            'MCP App initialize is missing host context',
          );
          dispatchTrustRejection(rejection, {
            method: 'ui/initialize',
            kind: 'invalid_params',
          });
          respondWithError(data.id, 'MCP App initialize is missing host context', -32603);
          return;
        }
        if (typeof window.mcpAppsApi?.issueNonce !== 'function') {
          const rejection = makeRendererRejection(
            'invalid_params',
            'MCP App nonce bridge not available',
            -32603,
          );
          dispatchTrustRejection(rejection, {
            method: 'ui/initialize',
            kind: 'invalid_params',
          });
          respondWithError(data.id, 'MCP App nonce bridge not available', -32603);
          return;
        }
        const sourcePackageId = uiMeta.sourcePackageId;

        void (async () => {
          try {
            const response = await window.mcpAppsApi.issueNonce({
              sourcePackageId,
              sessionId,
              conversationId,
              toolUseId,
              iframeInstanceId: messageIframeInstanceId,
            });
            if (!response.success) {
              dispatchTrustRejection(response.rejection as TrustBoundaryRejection);
              respondWithError(data.id, response.rejection.safeMessage, response.rejection.jsonRpcCode);
              return;
            }
            postJsonRpcResult(data.id, {
              hostInfo: {
                name: 'Rebel',
                version: '1.0.0',
              },
              hostContext: {
                theme,
                locale: locale ?? navigator.language,
                platform: 'desktop',
              },
              nonce: response.nonce,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'MCP App initialize failed';
            respondWithError(data.id, message, -32603);
          }
        })();
        return;
      }

      if (typeof data.method === 'string' && 'id' in data) {
        const rejection = makeRendererRejection(
          'unknown_method',
          "View tried something Rebel doesn't know how to do.",
          -32601,
        );
        dispatchTrustRejection(rejection, {
          method: data.method,
          kind: 'unknown_method',
        });
        respondWithError(data.id, `Unknown MCP App method: ${data.method}`, -32601);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      clearBlankViewWatchdog();
    };
  }, [
    theme,
    locale,
    uiMeta.resourceUri,
    uiMeta.sourcePackageId,
    sessionId,
    conversationId,
    toolUseId,
    isFullscreen,
    inlineIframeInstanceId,
    fullscreenIframeInstanceId,
    markPreviewReady,
    handleResize,
    clearBlankViewWatchdog,
  ]);

  const attachCspViolationListener = useCallback((targetWindow: WindowProxy | null | undefined) => {
    detachCspViolationListener();
    if (!targetWindow) {
      return;
    }

    const handleSecurityPolicyViolation = (event: Event) => {
      event.preventDefault();
      clearBlankViewWatchdog();
      setError("This view didn't load.");
      setIsLoading(false);
    };

    try {
      if (typeof targetWindow.addEventListener !== 'function') {
        return;
      }
      targetWindow.addEventListener('securitypolicyviolation', handleSecurityPolicyViolation);
      cspViolationCleanupRef.current = () => {
        try {
          targetWindow.removeEventListener('securitypolicyviolation', handleSecurityPolicyViolation);
        } catch {
          // The iframe may already be gone; cleanup is best-effort.
        }
      };
    } catch {
      // Sandboxed or protocol-backed frames may refuse listener attachment.
      // The injected script still reports CSP violations via postMessage when it can.
    }
  }, [clearBlankViewWatchdog, detachCspViolationListener]);

  const scheduleBlankViewWatchdog = useCallback(() => {
    clearBlankViewWatchdog();
    blankViewWatchdogTimerRef.current = setTimeout(() => {
      blankViewWatchdogTimerRef.current = null;
      if (previewReadyRef.current) {
        return;
      }

      try {
        const frameDocument = iframeRef.current?.contentWindow?.document;
        const body = frameDocument?.body;
        if (body && ((body.textContent ?? '').trim() || body.children.length > 0)) {
          markPreviewReady();
          return;
        }
      } catch {
        // Sandbox without allow-same-origin makes DOM inspection unavailable.
        // In that case the postMessage readiness signal is the contract; if it
        // never arrives, recover rather than leaving a blank iframe onscreen.
      }

      setError("This view didn't load.");
      setIsLoading(false);
    }, 1000);
  }, [clearBlankViewWatchdog, markPreviewReady]);

  const postToolResultNotification = useCallback((targetWindow: WindowProxy | null | undefined) => {
    if (!targetWindow || !toolResultPayload) {
      return;
    }
    targetWindow.postMessage(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: toolResultPayload,
      },
      '*'
    );
  }, [toolResultPayload]);

  // Send tool result after iframe loads
  const handleIframeLoad = useCallback(() => {
    setIsLoading(false);
    attachCspViolationListener(iframeRef.current?.contentWindow);
    scheduleBlankViewWatchdog();
    
    // If no ui/resize received within 500ms, apply fallback height
    // so views without resize support still render visibly
    fallbackTimerRef.current = setTimeout(() => {
      setIframeHeight((h) => (h === 0 ? FALLBACK_HEIGHT : h));
    }, 500);
    
    // TODO: Inject error-capture script for protocol URL mode (folderPath previews).
    // Blob URL mode gets it via injectHostContext(), but protocol-served pages
    // skip that path. Needs a mechanism to inject into the iframe post-load.

    // Send tool result notification via postMessage
    postToolResultNotification(iframeRef.current?.contentWindow);
  }, [attachCspViolationListener, postToolResultNotification, scheduleBlankViewWatchdog]);

  const handleIframeError = useCallback(() => {
    clearBlankViewWatchdog();
    setError("This view didn't load.");
    setIsLoading(false);
  }, [clearBlankViewWatchdog]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !blobUrl) {
      return;
    }

    iframe.addEventListener('error', handleIframeError);
    return () => iframe.removeEventListener('error', handleIframeError);
  }, [blobUrl, handleIframeError]);

  // Fullscreen: Escape key + focus management
  useEffect(() => {
    if (!isFullscreen) return;

    const triggerEl = fullscreenTriggerRef.current;

    // Focus the close button when fullscreen opens
    requestAnimationFrame(() => fullscreenCloseRef.current?.focus());

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
      triggerEl?.focus();
    };
  }, [isFullscreen]);

  const handleFullscreenIframeLoad = useCallback(() => {
    postToolResultNotification(fullscreenIframeRef.current?.contentWindow);
  }, [postToolResultNotification]);

  const handleOpenInBrowser = useCallback(async () => {
    try {
      // For file-backed modes (filePath, folderPath), open the original file directly
      if (uiMeta.originalFilePath) {
        await window.appApi.openPath(uiMeta.originalFilePath);
        return;
      }
      // For raw HTML mode, write to temp file via IPC and open
      if (fetchedHtml) {
        await window.mcpAppsApi.openHtmlInBrowser({ html: fetchedHtml });
      }
    } catch (err) {
      console.error('Failed to open in browser:', err);
    }
  }, [uiMeta.originalFilePath, fetchedHtml]);

  const canOpenInBrowser = !!(uiMeta.originalFilePath || fetchedHtml);

  if (error) {
    if (renderErrorFallback) {
      return <>{renderErrorFallback({ error, retry: handleRetry })}</>;
    }

    return (
      <div className={cn(styles.container, styles.error)}>
        <AlertTriangle size={16} className={styles.errorIcon} />
        <span>{error}</span>
      </div>
    );
  }

  return (
    <>
      <div className={cn(styles.container, isLoading && styles.containerLoading)}>
        {isLoading && (
          <div className={styles.loading}>
            <Loader2 size={16} className={styles.spinner} />
            <span>Loading view...</span>
          </div>
        )}
        {blobUrl && (
          <iframe
            ref={iframeRef}
            src={blobUrl}
            sandbox="allow-scripts"
            className={cn(styles.iframe, isLoading && styles.hidden)}
            style={iframeHeight > 0 ? { height: `${iframeHeight}px` } : undefined}
            onLoad={handleIframeLoad}
            onError={handleIframeError}
            title={resolvedIframeTitle}
          />
        )}
        {!isLoading && !error && (
          <div className={styles.actionButtons}>
            {blobUrl && (
              <IconButton
                ref={fullscreenTriggerRef}
                size="xs"
                className={styles.actionButton}
                onClick={() => setIsFullscreen(true)}
                aria-label="Expand preview"
              >
                <Maximize2 size={14} />
              </IconButton>
            )}
            {canOpenInBrowser && (
              <IconButton
                size="xs"
                className={styles.actionButton}
                onClick={handleOpenInBrowser}
                aria-label="Open in browser"
              >
                <ExternalLink size={14} />
              </IconButton>
            )}
          </div>
        )}
      </div>

      {isFullscreen && blobUrl && createPortal(
        <div
          className={styles.fullscreenOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Fullscreen preview"
          onClick={() => setIsFullscreen(false)}
        >
          <div
            className={styles.fullscreenContent}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.fullscreenHeader}>
              <div className={styles.fullscreenActions}>
                {canOpenInBrowser && (
                  <IconButton
                    size="xs"
                    className={styles.fullscreenHeaderButton}
                    onClick={handleOpenInBrowser}
                    aria-label="Open in browser"
                  >
                    <ExternalLink size={16} />
                  </IconButton>
                )}
                <IconButton
                  ref={fullscreenCloseRef}
                  size="xs"
                  className={styles.fullscreenHeaderButton}
                  onClick={() => setIsFullscreen(false)}
                  aria-label="Close fullscreen preview"
                >
                  <X size={16} />
                </IconButton>
              </div>
            </div>
            <iframe
              ref={fullscreenIframeRef}
              src={blobUrl}
              sandbox="allow-scripts"
              className={styles.fullscreenIframe}
              onLoad={handleFullscreenIframeLoad}
              onError={handleIframeError}
              title={`${resolvedIframeTitle} (fullscreen)`}
            />
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

McpAppViewComponent.displayName = 'McpAppView';

export const McpAppView = memo(McpAppViewComponent);
