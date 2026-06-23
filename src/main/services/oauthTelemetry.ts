import { trackMainEvent, getOrGenerateAnonymousId } from '../analytics';
import { parseMultiInstanceServer } from '../../shared/utils/mcpInstanceUtils';

// ── Types ────────────────────────────────────────────────────────────────────

type ConnectorType = 'bundled' | 'custom';
type CallbackMethod = 'deep_link' | 'localhost' | 'loopback' | 'manual';

interface OAuthFlowState {
  openedAt: number;
  connectorName: string;
  connectorType: ConnectorType;
  callbackMethod: CallbackMethod;
}

interface BrowserOpenedProps {
  connectorName: string;
  connectorType: ConnectorType;
  oauthMethod?: string;
  oauthUrl?: string;
  callbackMethod: CallbackMethod;
}

interface CallbackReceivedProps {
  connectorName: string;
  success: boolean;
  errorMessage?: string;
}

// ── Flow State Map ───────────────────────────────────────────────────────────

const STALE_FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

const activeOAuthFlows = new Map<string, OAuthFlowState>();

function flowKey(connectorName: string): string {
  return connectorName.toLowerCase();
}

function evictStaleEntries(): void {
  const now = Date.now();
  for (const [key, state] of activeOAuthFlows) {
    if (now - state.openedAt > STALE_FLOW_TTL_MS) {
      activeOAuthFlows.delete(key);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function safeConnectorName(name: string): string {
  const parsed = parseMultiInstanceServer(name);
  return parsed.isInstance && parsed.baseName ? parsed.baseName : name;
}

function sanitizeErrorMessage(msg: string | undefined): string | undefined {
  if (!msg) return undefined;
  return msg
    .replace(/https?:\/\/[^\s"'<>]+/g, '[URL]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    .replace(/\b(code|access_token|refresh_token|client_secret|state|token|key|secret|password|credential)=[^\s&"'<>]+/gi, '$1=[REDACTED]')
    .slice(0, 200);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function trackOAuthBrowserOpened(props: BrowserOpenedProps): void {
  try {
    evictStaleEntries();

    const name = safeConnectorName(props.connectorName);
    activeOAuthFlows.set(flowKey(name), {
      openedAt: Date.now(),
      connectorName: name,
      connectorType: props.connectorType,
      callbackMethod: props.callbackMethod,
    });

    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Connector OAuth Browser Opened',
      properties: {
        connectorName: name,
        connectorType: props.connectorType,
        oauthMethod: props.oauthMethod ?? 'browser_redirect',
        ...(safeDomain(props.oauthUrl) && { oauthUrl: safeDomain(props.oauthUrl) }),
        callbackMethod: props.callbackMethod,
      },
    });
  } catch {
    // Telemetry must never break OAuth flows
  }
}

export function trackOAuthCallbackReceived(props: CallbackReceivedProps): void {
  try {
    const name = safeConnectorName(props.connectorName);
    const key = flowKey(name);
    const flowState = activeOAuthFlows.get(key);
    activeOAuthFlows.delete(key);

    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Connector OAuth Callback Received',
      properties: {
        connectorName: name,
        connectorType: flowState?.connectorType ?? 'bundled',
        callbackMethod: flowState?.callbackMethod ?? 'deep_link',
        ...(flowState && { durationMs: Date.now() - flowState.openedAt }),
        success: props.success,
        ...(props.errorMessage && { errorMessage: sanitizeErrorMessage(props.errorMessage) }),
      },
    });
  } catch {
    // Telemetry must never break OAuth flows
  }
}

// ── Deep-link URL parser (used in handleDeepLink) ────────────────────────────

const DEEP_LINK_CONNECTOR_MAP: Record<string, string> = {
  slack: 'Slack',
  microsoft: 'Microsoft',
  salesforce: 'Salesforce',
  plaud: 'Plaud',
  github: 'GitHub',
  digitalocean: 'DigitalOcean',
  discourse: 'Discourse',
};

export function trackDeepLinkCallback(url: string): void {
  try {
    const match = url.match(/:\/\/([^/]+)\/callback/);
    if (!match) return;
    const provider = match[1].toLowerCase();
    const connectorName = DEEP_LINK_CONNECTOR_MAP[provider];
    if (!connectorName) return;

    const callbackUrl = new URL(url);
    const hasCode = callbackUrl.searchParams.has('code') || callbackUrl.searchParams.has('payload');
    const hasError = callbackUrl.searchParams.has('error');
    const errorParam = callbackUrl.searchParams.get('error');

    trackOAuthCallbackReceived({
      connectorName,
      success: hasCode && !hasError,
      errorMessage: hasError ? (errorParam ?? 'OAuth error') : undefined,
    });
  } catch {
    // Telemetry must never break deep link handling
  }
}

// ── Exported for testing ─────────────────────────────────────────────────────

export const _testOnly = {
  activeOAuthFlows,
  flowKey,
  safeDomain,
  safeConnectorName,
  sanitizeErrorMessage,
  evictStaleEntries,
};
