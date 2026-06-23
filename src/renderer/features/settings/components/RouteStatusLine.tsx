import { Button, Tooltip } from '@renderer/components/ui';
import type { TurnAuthLabel } from '@shared/agentEvents';
import { assertNever } from '@shared/utils/assertNever';
import type { RouteLabelCacheEntry } from '../store/routeLabelCacheStore';
import { useRouteStatusViewState } from '../hooks/useLastResolvedRouteLabel';
import styles from './RouteStatusLine.module.css';

const ROUTE_STATUS_TOOLTIP =
  'Shows how your last message was billed. Updates at the start of each new message.';

export interface RouteStatusLineProps {
  codexConnected?: boolean;
  codexNeedsReconnect?: boolean;
  openRouterConnected?: boolean;
  openRouterNeedsReconnect?: boolean;
  hasAnthropicAuth?: boolean;
  onReconnectCodex?: () => void;
  onReconnectOpenRouter?: () => void;
}

interface BrokenAuthDescriptor {
  providerName: string;
  onReconnect?: () => void;
  testIdProvider: 'codex' | 'openrouter' | 'anthropic';
}

function formatRouteStatusLine(label: TurnAuthLabel, profileName?: string): string {
  switch (label) {
    case 'codex-subscription':
      return 'Routed via: your ChatGPT Pro subscription';
    case 'openrouter':
      return 'Routed via: your OpenRouter credits';
    case 'mindstone':
      return 'Routed via: your Mindstone subscription';
    case 'api-key':
      return 'Routed via: your Anthropic API key (pay-per-use)';
    case 'oauth-token':
      return 'Routed via: your Anthropic OAuth session';
    case 'local':
      return 'Routed via: your local model';
    case 'profile-direct': {
      const trimmed = profileName?.trim();
      return trimmed
        ? `Routed via: your ${trimmed} profile`
        : 'Routed via: your profile';
    }
    default:
      return assertNever(label);
  }
}

function detectBrokenAuth(
  entry: RouteLabelCacheEntry,
  props: RouteStatusLineProps,
): BrokenAuthDescriptor | null {
  switch (entry.turnAuthLabel) {
    case 'codex-subscription':
      if (props.codexNeedsReconnect && !props.codexConnected) {
        return {
          providerName: 'ChatGPT Pro',
          onReconnect: props.onReconnectCodex,
          testIdProvider: 'codex',
        };
      }
      return null;
    case 'openrouter':
      if (props.openRouterNeedsReconnect && !props.openRouterConnected) {
        return {
          providerName: 'OpenRouter',
          onReconnect: props.onReconnectOpenRouter,
          testIdProvider: 'openrouter',
        };
      }
      return null;
    case 'mindstone':
      return null;
    case 'api-key':
    case 'oauth-token':
      if (props.hasAnthropicAuth === false) {
        return {
          providerName: 'Anthropic',
          testIdProvider: 'anthropic',
        };
      }
      return null;
    case 'local':
    case 'profile-direct':
      return null;
    default:
      return assertNever(entry.turnAuthLabel);
  }
}

export function RouteStatusLine(props: RouteStatusLineProps = {}) {
  const { entry, inflight } = useRouteStatusViewState();

  if (inflight) {
    return (
      <Tooltip content={ROUTE_STATUS_TOOLTIP}>
        <div
          className={styles.routeStatusLine}
          data-testid="settings-models-route-status-line"
          data-state="checking"
          tabIndex={0}
        >
          <span className={styles.routeStatusText}>Checking route…</span>
        </div>
      </Tooltip>
    );
  }

  if (!entry) {
    return null;
  }

  const brokenAuth = detectBrokenAuth(entry, props);
  if (brokenAuth) {
    return (
      <Tooltip content={ROUTE_STATUS_TOOLTIP}>
        <div
          className={styles.routeStatusLine}
          data-testid="settings-models-route-status-line"
          data-state="broken-auth"
          tabIndex={0}
        >
          <span className={styles.routeStatusText}>
            Not ready: reconnect {brokenAuth.providerName}
          </span>
          {brokenAuth.onReconnect ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={brokenAuth.onReconnect}
              data-testid={`settings-models-route-status-reconnect-${brokenAuth.testIdProvider}`}
              className={styles.reconnectButton}
            >
              Reconnect
            </Button>
          ) : null}
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={ROUTE_STATUS_TOOLTIP}>
      <div
        className={styles.routeStatusLine}
        data-testid="settings-models-route-status-line"
        data-state="resolved"
        tabIndex={0}
      >
        <span className={styles.routeStatusText}>
          {formatRouteStatusLine(entry.turnAuthLabel, entry.profileName)}
        </span>
      </div>
    </Tooltip>
  );
}
