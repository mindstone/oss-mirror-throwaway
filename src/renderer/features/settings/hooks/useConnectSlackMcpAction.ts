import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { tracking } from '@renderer/src/tracking';
import type { ConnectorCatalogEntry } from '@shared/types';
import { generateWorkspaceInstanceId } from '@shared/utils/mcpInstanceUtils';
import type { SetupWithRebelParams } from '../components/tabs/types';
import { isOAuthSetupGuidance, type MaybeSetupGuidanceResult } from './useConnectorSetupGuidance';

type ConnectorConnectionMethod = 'oauth' | 'api_key' | 'rebel_assist' | 'manual';

export interface ConnectSlackMcpActionArgs {
  workspaceHint?: string;
  connectionName?: string;
  category?: string;
  catalogEntry?: ConnectorCatalogEntry;
  launchRebel?: boolean;
  connectStartedAt?: number;
  connectorType?: 'bundled' | 'custom';
  isAttemptCurrent?: () => boolean;
  onConfigureWithRebel?: (params: SetupWithRebelParams) => void | Promise<void>;
  /**
   * Routes a not-configured `setupGuidance` result to the shared `ConnectorSetupDialog`. When this
   * returns `true` the dialog is taking over, so we skip throwing (which would surface a generic
   * toast) and treat the attempt as gracefully not-completed.
   */
  onSetupGuidance?: (result: MaybeSetupGuidanceResult) => boolean;
}

export interface UseConnectSlackMcpActionOptions {
  onConfigureWithRebel?: (params: SetupWithRebelParams) => void | Promise<void>;
}

export interface UseConnectSlackMcpActionResult {
  connect: (args?: ConnectSlackMcpActionArgs) => Promise<void>;
  isInFlight: boolean;
}

interface SlackOAuthResult extends MaybeSetupGuidanceResult {
  success: boolean;
  error?: string;
  accountIdentity?: string;
}

let inFlightPromise: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function getInFlightSnapshot(): boolean {
  return inFlightPromise !== null;
}

function subscribeToInFlight(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

function notifySubscribers(): void {
  for (const subscriber of subscribers) {
    subscriber();
  }
}

function getLastOauthStep(error: string | undefined): 'browser_opened' | 'callback_received' | 'not_started' {
  if (/timed?\s*out|timeout/i.test(error ?? '')) return 'browser_opened';
  if (/state mismatch|invalid/i.test(error ?? '')) return 'callback_received';
  return 'not_started';
}

async function doConnectSlackMcp(args: ConnectSlackMcpActionArgs): Promise<void> {
  const {
    workspaceHint,
    connectionName = 'Slack',
    category = 'other',
    catalogEntry,
    launchRebel = false,
    connectStartedAt = Date.now(),
    connectorType = 'bundled',
    isAttemptCurrent,
    onConfigureWithRebel,
    onSetupGuidance,
  } = args;

  const serverName = catalogEntry?.bundledConfig?.serverName ?? 'Slack';

  // Slack's OAuth handler owns MCP registration: it creates the per-workspace
  // entry (Slack-{workspace}) after the browser flow succeeds. Calling
  // mcpAddBundledServer here would briefly recreate the legacy base "Slack"
  // entry and can double-install, so the extracted hook preserves the panel's
  // existing skip behaviour.
  let oauthResult: SlackOAuthResult | undefined;
  let setupSuccess = true;
  let setupError: string | undefined;

  try {
    const slackResult = await window.slackApi.startAuth();
    const accountIdentity = slackResult.teamName?.trim() || workspaceHint?.trim() || undefined;
    oauthResult = {
      success: slackResult.success,
      error: slackResult.error,
      accountIdentity,
      setupGuidance: slackResult.setupGuidance,
    };

    if (!oauthResult.success) {
      console.error('OAuth authentication failed:', oauthResult.error);
      setupSuccess = false;
      setupError = oauthResult.error;
    }
  } catch (authError) {
    console.error('Failed to trigger OAuth:', authError);
    setupSuccess = false;
    setupError = authError instanceof Error ? authError.message : 'Unknown error';
    oauthResult = { success: false, error: setupError };
  }

  if (setupSuccess) {
    const method: ConnectorConnectionMethod = 'oauth';
    tracking.settings.connectorConnected(connectionName, category, method);
  } else {
    // Broken-by-default (no OAuth client credentials): hand off to the shared setup dialog instead
    // of throwing (which the caller surfaces as a generic toast), and record `not_configured`.
    const handledByDialog =
      isOAuthSetupGuidance(oauthResult?.setupGuidance) &&
      onSetupGuidance?.(oauthResult ?? {}) === true;
    tracking.settings.connectorConnectionFailed(
      connectionName,
      category,
      'bundled_setup_failed',
      setupError,
      {
        connectorType,
        durationMs: Date.now() - connectStartedAt,
        lastOauthStep: handledByDialog ? 'not_configured' : getLastOauthStep(setupError),
        source: 'settings_ui',
      },
    );
    if (handledByDialog) return;
    throw new Error(setupError ?? 'Slack connection failed');
  }

  if (isAttemptCurrent && !isAttemptCurrent()) return;

  if (launchRebel) {
    let finalServerName = serverName;
    if (oauthResult?.accountIdentity) {
      finalServerName = generateWorkspaceInstanceId(serverName, oauthResult.accountIdentity);
    }
    if (catalogEntry?.provider === 'rebel-oss') {
      finalServerName = serverName;
    }

    await onConfigureWithRebel?.({
      serverName: finalServerName,
      catalogEntry,
      setupResult: { success: setupSuccess, error: setupError },
      oauthResult: oauthResult as SetupWithRebelParams['oauthResult'],
      isNewConnection: true,
    });
  }
}

function connectSlackMcp(args: ConnectSlackMcpActionArgs = {}): Promise<void> {
  if (inFlightPromise) {
    return inFlightPromise;
  }

  inFlightPromise = doConnectSlackMcp(args).finally(() => {
    inFlightPromise = null;
    notifySubscribers();
  });
  notifySubscribers();
  return inFlightPromise;
}

export function useConnectSlackMcpAction(
  options: UseConnectSlackMcpActionOptions = {},
): UseConnectSlackMcpActionResult {
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const isInFlight = useSyncExternalStore(
    subscribeToInFlight,
    getInFlightSnapshot,
    getInFlightSnapshot,
  );

  const connect = useCallback((args: ConnectSlackMcpActionArgs = {}) => (
    connectSlackMcp({
      onConfigureWithRebel: optionsRef.current.onConfigureWithRebel,
      ...args,
    })
  ), []);

  return { connect, isInFlight };
}

export const connectSlackMcpActionTesting = {
  connectSlackMcp,
  getInFlightSnapshot,
  subscribeToInFlight,
  reset(): void {
    inFlightPromise = null;
    notifySubscribers();
  },
};
