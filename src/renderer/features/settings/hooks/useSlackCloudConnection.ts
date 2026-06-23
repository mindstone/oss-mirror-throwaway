import { useCallback, useEffect, useRef, useState } from 'react';
import {
  configure,
  deleteSlackWorkspace,
  getSlackWorkspace,
  SlackAuthError,
  SlackNetworkError,
  SlackResponseValidationError,
  SlackTransientError,
  startByokSlackOAuth,
  startSlackOAuth,
  type SlackByokOAuthStartArgs,
  type SlackWorkspaceResponse,
} from '@rebel/cloud-client';
import type { AppSettings, CloudInstanceConfig } from '@shared/types/settings';
import { useSettingsSafe } from '../SettingsProvider';

export type SlackCloudConnectionStatus =
  | 'checking'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'reconnect-needed'
  | 'setup-error';

export interface SlackCloudConnectionState {
  status: SlackCloudConnectionStatus;
  workspace: { teamId: string; teamName: string; lastSeenAt: string | null } | null;
  error: SlackConnectError | null;
}

export interface UseSlackCloudConnectionResult {
  status: SlackCloudConnectionStatus;
  workspace: SlackCloudConnectionState['workspace'];
  error: SlackCloudConnectionState['error'];
  connect: () => Promise<void>;
  connectByok: (creds: SlackByokOAuthStartArgs) => Promise<void>;
  cancel: () => void;
  disconnect: () => Promise<void>;
  retry: () => Promise<void>;
  refresh: () => Promise<void>;
}

export interface SlackConnectError {
  code: string;
  message: string;
  retryAfterSeconds?: number;
  field?: 'clientId' | 'clientSecret' | 'signingSecret';
}

let pollingConfig = {
  initialDelayMs: 3_000,
  maxDelayMs: 30_000,
  timeoutMs: 5 * 60_000,
};

export function setSlackCloudConnectionPollingForTesting(
  overrides: Partial<typeof pollingConfig> | null,
): void {
  pollingConfig = {
    initialDelayMs: 3_000,
    maxDelayMs: 30_000,
    timeoutMs: 5 * 60_000,
    ...(overrides ?? {}),
  };
}

const INITIAL_STATE: SlackCloudConnectionState = {
  status: 'checking',
  workspace: null,
  error: null,
};

interface PollHandle {
  cancelled: boolean;
  abortController: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  reject: ((reason?: unknown) => void) | null;
}

function normalizeLastSeenAt(value: number | string | null | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return null;
}

function stateFromWorkspace(workspace: SlackWorkspaceResponse | null): SlackCloudConnectionState {
  if (!workspace || workspace.status === 'disconnected') {
    return { status: 'disconnected', workspace: null, error: null };
  }
  const normalizedWorkspace = {
    teamId: workspace.teamId,
    teamName: workspace.teamName,
    lastSeenAt: normalizeLastSeenAt(workspace.lastSeenAt),
  };
  if (workspace.status === 'needs_reconnect') {
    return { status: 'reconnect-needed', workspace: normalizedWorkspace, error: null };
  }
  if (workspace.status === 'disconnecting') {
    return { status: 'disconnecting', workspace: normalizedWorkspace, error: null };
  }
  return { status: 'connected', workspace: normalizedWorkspace, error: null };
}

export function deriveSlackConnectionStateFromSettings(settings: AppSettings | null | undefined): SlackCloudConnectionState {
  const workspace = settings?.experimental?.cloudSlackWorkspace;
  if (!workspace) {
    return { status: 'disconnected', workspace: null, error: null };
  }
  return stateFromWorkspace({
    teamId: workspace.teamId,
    teamName: workspace.teamName,
    status: workspace.status,
    lastSeenAt: normalizeLastSeenAt(workspace.lastSeenAt),
  });
}

function configureCloudClient(cloudInstance: CloudInstanceConfig | undefined): boolean {
  if (cloudInstance?.mode !== 'cloud' || !cloudInstance.cloudUrl || !cloudInstance.cloudToken) {
    return false;
  }
  configure({ cloudUrl: cloudInstance.cloudUrl, token: cloudInstance.cloudToken });
  return true;
}

function isSlackConnectError(err: unknown): err is SlackConnectError {
  if (!err || typeof err !== 'object') return false;
  const { code, message, field, retryAfterSeconds } = err as {
    code?: unknown;
    message?: unknown;
    field?: unknown;
    retryAfterSeconds?: unknown;
  };
  if (typeof code !== 'string' || typeof message !== 'string') return false;
  if (field !== undefined && field !== 'clientId' && field !== 'clientSecret' && field !== 'signingSecret') return false;
  if (retryAfterSeconds !== undefined && typeof retryAfterSeconds !== 'number') return false;
  return true;
}

function errorFromUnknown(err: unknown, fallbackCode = 'OAUTH_FAILED'): SlackConnectError {
  if (isSlackConnectError(err)) return err;
  if (err instanceof SlackNetworkError) {
    return { code: 'NETWORK_UNREACHABLE', message: 'The cloud could not be reached. Slack setup can try again when it is back.' };
  }
  if (err instanceof SlackTransientError) {
    if (err.statusCode === 429) {
      return { code: 'RATE_LIMITED', message: 'Slack setup is temporarily rate-limited.', retryAfterSeconds: 60 };
    }
    return { code: 'OAUTH_FAILED', message: 'The Slack setup service is temporarily unavailable.' };
  }
  if (err instanceof SlackAuthError) {
    if (err.field) {
      return { code: 'INVALID_FIELD', field: err.field, message: err.message };
    }
    return { code: 'OAUTH_FAILED', message: 'The cloud session needs a fresh sign-in before Slack can connect.' };
  }
  if (err instanceof SlackResponseValidationError) {
    return { code: 'OAUTH_FAILED', message: 'The Slack setup response did not look right.' };
  }
  return {
    code: fallbackCode,
    message: err instanceof Error ? err.message : 'Slack setup did not finish.',
  };
}

function validateByokCredentials(creds: SlackByokOAuthStartArgs): SlackCloudConnectionState['error'] {
  if (!/^\d+\.\d+$/.test(creds.clientId.trim())) {
    return { code: 'INVALID_FIELD', field: 'clientId', message: 'Client ID looks like 12345.67890' };
  }
  if (creds.clientSecret.trim().length < 10) {
    return { code: 'INVALID_FIELD', field: 'clientSecret', message: 'Looks too short to be valid' };
  }
  if (creds.signingSecret.trim().length < 10) {
    return { code: 'INVALID_FIELD', field: 'signingSecret', message: 'Looks too short to be valid' };
  }
  return null;
}

function waitForPollDelay(handle: PollHandle, delayMs: number): Promise<void> {
  if (handle.cancelled) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    handle.reject = reject;
    handle.timer = setTimeout(() => {
      handle.timer = null;
      handle.reject = null;
      if (handle.cancelled) {
        reject(new DOMException('Cancelled', 'AbortError'));
      } else {
        resolve();
      }
    }, delayMs);
  });
}

export function useSlackCloudConnection(): UseSlackCloudConnectionResult {
  const settingsContext = useSettingsSafe();
  const settings = settingsContext?.settings ?? null;
  const settingsRef = useRef<AppSettings | null>(settings);
  const saveSettingsWithRef = useRef(settingsContext?.saveSettingsWith);
  const mountedRef = useRef(true);
  const pollHandleRef = useRef<PollHandle | null>(null);
  const [state, setState] = useState<SlackCloudConnectionState>(() => (
    settings ? deriveSlackConnectionStateFromSettings(settings) : INITIAL_STATE
  ));

  useEffect(() => {
    settingsRef.current = settings;
    saveSettingsWithRef.current = settingsContext?.saveSettingsWith;
    if (!settings) {
      setState(INITIAL_STATE);
      return;
    }
    const derived = deriveSlackConnectionStateFromSettings(settings);
    setState((prev) => {
      if (prev.status === 'connecting' && derived.status === 'disconnected') return prev;
      if (prev.status === 'disconnecting' && derived.status === 'connected') return prev;
      return derived;
    });
  }, [settings, settingsContext?.saveSettingsWith]);

  const clearPoll = useCallback(() => {
    const handle = pollHandleRef.current;
    if (!handle) return;
    handle.cancelled = true;
    handle.abortController.abort(new DOMException('Cancelled', 'AbortError'));
    if (handle.timer) {
      clearTimeout(handle.timer);
      handle.timer = null;
    }
    handle.reject?.(new DOMException('Cancelled', 'AbortError'));
    handle.reject = null;
    pollHandleRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPoll();
    };
  }, [clearPoll]);

  const safeSetState = useCallback((next: SlackCloudConnectionState) => {
    if (mountedRef.current) {
      setState(next);
    }
  }, []);

  const saveSlackCloudWebhookFlag = useCallback(async (enabled: boolean) => {
    const saveSettingsWith = saveSettingsWithRef.current;
    if (!saveSettingsWith) {
      throw new Error('Settings save is unavailable for Slack cloud connection state.');
    }
    await saveSettingsWith((draft) => ({
      ...draft,
      experimental: {
        ...(draft.experimental ?? {}),
        slackCloudWebhookEnabled: enabled,
      },
    }), { keepOpen: true });
  }, []);

  // The cloud-service is supposed to push slack:workspace-changed events that
  // cloudEventChannel mirrors into experimental.cloudSlackWorkspace; that field
  // is what the Settings panel reads to know we are connected. If the push is
  // lost (initial-connect race, schema drop, disconnected channel) the panel
  // silently shows "Disconnected" even though the cloud has the workspace and
  // this hook's REST poll sees it. Mirror the polled workspace into settings
  // ourselves so the panel state cannot drift away from the connection state.
  const saveSlackCloudWorkspaceMirror = useCallback(async (
    workspace: SlackWorkspaceResponse | null,
  ) => {
    const saveSettingsWith = saveSettingsWithRef.current;
    if (!saveSettingsWith) return;
    if (!workspace || !workspace.teamId) return;
    const lastSeenAt = typeof workspace.lastSeenAt === 'number' && Number.isFinite(workspace.lastSeenAt)
      ? workspace.lastSeenAt
      : typeof workspace.lastSeenAt === 'string' && workspace.lastSeenAt.length > 0
        ? (Number.isFinite(Date.parse(workspace.lastSeenAt)) ? Date.parse(workspace.lastSeenAt) : undefined)
        : undefined;
    await saveSettingsWith((draft) => {
      const previous = draft.experimental?.cloudSlackWorkspace;
      const next = {
        teamId: workspace.teamId,
        teamName: workspace.teamName,
        status: workspace.status,
        ...(typeof previous?.peerInstanceCount === 'number' ? { peerInstanceCount: previous.peerInstanceCount } : {}),
        occurredAt: Date.now(),
        ...(typeof lastSeenAt === 'number' ? { lastSeenAt } : {}),
      };
      if (
        previous
        && previous.teamId === next.teamId
        && previous.teamName === next.teamName
        && previous.status === next.status
        && previous.lastSeenAt === next.lastSeenAt
      ) {
        return draft;
      }
      return {
        ...draft,
        experimental: {
          ...(draft.experimental ?? {}),
          cloudSlackWorkspace: next,
        },
      };
    }, { keepOpen: true });
  }, []);

  const clearSlackCloudWorkspaceMirror = useCallback(async () => {
    const saveSettingsWith = saveSettingsWithRef.current;
    if (!saveSettingsWith) return;
    await saveSettingsWith((draft) => {
      if (!draft.experimental?.cloudSlackWorkspace) return draft;
      const { cloudSlackWorkspace: _removed, ...rest } = draft.experimental;
      return { ...draft, experimental: rest };
    }, { keepOpen: true });
  }, []);

  const refresh = useCallback(async () => {
    if (!configureCloudClient(settingsRef.current?.cloudInstance)) {
      safeSetState({ status: 'setup-error', workspace: null, error: { code: 'NETWORK_UNREACHABLE', message: 'No cloud connection is available for Slack setup.' } });
      return;
    }
    try {
      const workspace = await getSlackWorkspace();
      const next = stateFromWorkspace(workspace);
      if (workspace && workspace.teamId && next.status !== 'disconnected') {
        await saveSlackCloudWorkspaceMirror(workspace);
      } else if (next.status === 'disconnected' && settingsRef.current?.experimental?.cloudSlackWorkspace) {
        await clearSlackCloudWorkspaceMirror();
      }
      safeSetState(next);
    } catch (err) {
      safeSetState({ status: 'setup-error', workspace: state.workspace, error: errorFromUnknown(err) });
    }
  }, [clearSlackCloudWorkspaceMirror, safeSetState, saveSlackCloudWorkspaceMirror, state.workspace]);

  const connectWithOAuthStart = useCallback(async (
    startOAuth: (signal: AbortSignal) => Promise<{ authUrl: string }>,
    options: { rethrowErrors?: boolean } = {},
  ) => {
    clearPoll();
    if (!configureCloudClient(settingsRef.current?.cloudInstance)) {
      const error = { code: 'NETWORK_UNREACHABLE', message: 'No cloud connection is available for Slack setup.' } satisfies SlackConnectError;
      safeSetState({ status: 'setup-error', workspace: null, error });
      if (options.rethrowErrors) throw error;
      return;
    }

    const handle: PollHandle = { cancelled: false, abortController: new AbortController(), timer: null, reject: null };
    pollHandleRef.current = handle;
    safeSetState({ status: 'connecting', workspace: state.workspace, error: null });

    try {
      const { authUrl } = await startOAuth(handle.abortController.signal);
      await window.appApi.openUrl(authUrl);

      const startedAt = Date.now();
      let delayMs = pollingConfig.initialDelayMs;
      while (!handle.cancelled && Date.now() - startedAt < pollingConfig.timeoutMs) {
        await waitForPollDelay(handle, delayMs);
        const workspace = await getSlackWorkspace(handle.abortController.signal);
        const next = stateFromWorkspace(workspace);
        if (next.status === 'connected' || next.status === 'reconnect-needed') {
          if (workspace) {
            await saveSlackCloudWorkspaceMirror(workspace);
          }
          if (next.status === 'connected') {
            await saveSlackCloudWebhookFlag(true);
          }
          safeSetState(next);
          pollHandleRef.current = null;
          return;
        }
        delayMs = Math.min(delayMs * 2, pollingConfig.maxDelayMs);
      }

      if (!handle.cancelled) {
        const error = { code: 'OAUTH_TIMEOUT', message: 'The browser setup did not finish.' } satisfies SlackConnectError;
        safeSetState({
          status: 'setup-error',
          workspace: null,
          error,
        });
        if (options.rethrowErrors) {
          throw error;
        }
      }
    } catch (err) {
      if (handle.cancelled) {
        return;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      if (isSlackConnectError(err)) {
        if (options.rethrowErrors) throw err;
        return;
      }
      const error = errorFromUnknown(err);
      safeSetState({ status: 'setup-error', workspace: state.workspace, error });
      if (options.rethrowErrors) {
        throw error;
      }
    } finally {
      if (pollHandleRef.current === handle) {
        pollHandleRef.current = null;
      }
    }
  }, [clearPoll, safeSetState, saveSlackCloudWebhookFlag, saveSlackCloudWorkspaceMirror, state.workspace]);

  const connect = useCallback(async () => {
    await connectWithOAuthStart((signal) => startSlackOAuth(signal));
  }, [connectWithOAuthStart]);

  const connectByok = useCallback(async (creds: SlackByokOAuthStartArgs) => {
    const validationError = validateByokCredentials(creds);
    if (validationError) {
      safeSetState({ status: 'setup-error', workspace: state.workspace, error: validationError });
      throw validationError;
    }
    await connectWithOAuthStart(
      (signal) => startByokSlackOAuth(creds, { signal }),
      { rethrowErrors: true },
    );
  }, [connectWithOAuthStart, safeSetState, state.workspace]);

  const cancel = useCallback(() => {
    clearPoll();
    safeSetState({ status: 'disconnected', workspace: null, error: null });
  }, [clearPoll, safeSetState]);

  const disconnect = useCallback(async () => {
    clearPoll();
    const previous = state;
    if (!configureCloudClient(settingsRef.current?.cloudInstance)) {
      safeSetState({
        status: previous.workspace ? 'connected' : 'setup-error',
        workspace: previous.workspace,
        error: { code: 'NETWORK_UNREACHABLE', message: 'No cloud connection is available to disconnect Slack.' },
      });
      return;
    }
    safeSetState({ status: 'disconnecting', workspace: previous.workspace, error: null });
    let deleted = false;
    try {
      await deleteSlackWorkspace();
      deleted = true;
      await saveSlackCloudWebhookFlag(false);
      await clearSlackCloudWorkspaceMirror();
      safeSetState({ status: 'disconnected', workspace: null, error: null });
    } catch (err) {
      safeSetState({
        status: deleted ? 'setup-error' : previous.workspace ? 'connected' : 'setup-error',
        workspace: deleted ? null : previous.workspace,
        error: errorFromUnknown(err, 'DISCONNECT_FAILED'),
      });
    }
  }, [clearPoll, clearSlackCloudWorkspaceMirror, safeSetState, saveSlackCloudWebhookFlag, state]);

  const retry = useCallback(async () => {
    await connect();
  }, [connect]);

  return {
    status: state.status,
    workspace: state.workspace,
    error: state.error,
    connect,
    connectByok,
    cancel,
    disconnect,
    retry,
    refresh,
  };
}
