// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types/settings';
import { SettingsProvider, type SettingsContextValue } from '../../SettingsProvider';
import {
  deriveSlackConnectionStateFromSettings,
  setSlackCloudConnectionPollingForTesting,
  useSlackCloudConnection,
  type UseSlackCloudConnectionResult,
} from '../useSlackCloudConnection';
import {
  deleteSlackWorkspace,
  getSlackWorkspace,
  startByokSlackOAuth,
  startSlackOAuth,
} from '@rebel/cloud-client';

 
vi.mock('@rebel/cloud-client', async () => {
  const actual = await vi.importActual<typeof import('@rebel/cloud-client')>('@rebel/cloud-client');
  return {
    ...actual,
    configure: vi.fn(),
    startSlackOAuth: vi.fn(),
    startByokSlackOAuth: vi.fn(),
    getSlackWorkspace: vi.fn(),
    deleteSlackWorkspace: vi.fn(),
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const startSlackOAuthMock = vi.mocked(startSlackOAuth);
const startByokSlackOAuthMock = vi.mocked(startByokSlackOAuth);
const getSlackWorkspaceMock = vi.mocked(getSlackWorkspace);
const deleteSlackWorkspaceMock = vi.mocked(deleteSlackWorkspace);
let saveSettingsWithMock: ReturnType<typeof vi.fn>;

function createSettings(status?: 'connected' | 'needs_reconnect' | 'disconnecting' | 'disconnected'): AppSettings {
  return {
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://cloud.example.test',
      cloudToken: 'token-123',
      provisionMode: 'managed',
      lastKnownStatus: 'running',
    },
    experimental: status
      ? {
          cloudSlackWorkspace: {
            teamId: 'T1',
            teamName: 'Acme',
            status,
            lastSeenAt: Date.parse('2026-05-03T12:00:00.000Z'),
          },
        }
      : {},
  } as AppSettings;
}

function createSettingsContext(settings: AppSettings | null): SettingsContextValue {
  return {
    settings,
    saveSettingsWith: saveSettingsWithMock,
  } as unknown as SettingsContextValue;
}

interface MountedHook {
  result: { current: UseSlackCloudConnectionResult };
  rerender: (settings: AppSettings | null) => void;
  unmount: () => void;
}

function mountHook(settings: AppSettings | null): MountedHook {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const result = { current: undefined as unknown as UseSlackCloudConnectionResult };

  function TestHarness() {
    result.current = useSlackCloudConnection();
    return null;
  }

  function render(value: AppSettings | null) {
    root.render(
      React.createElement(
        SettingsProvider,
        {
          value: createSettingsContext(value),
          children: React.createElement(TestHarness),
        },
      ),
    );
  }

  act(() => render(settings));

  return {
    result,
    rerender(nextSettings) {
      act(() => render(nextSettings));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useSlackCloudConnection', () => {
  let originalAppApi: typeof window.appApi;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
    setSlackCloudConnectionPollingForTesting({
      initialDelayMs: 10,
      maxDelayMs: 20,
      timeoutMs: 50,
    });
    vi.clearAllMocks();
    saveSettingsWithMock = vi.fn().mockResolvedValue(undefined);
    originalAppApi = window.appApi;
    Object.defineProperty(window, 'appApi', {
      configurable: true,
      writable: true,
      value: {
        openUrl: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setSlackCloudConnectionPollingForTesting(null);
    Object.defineProperty(window, 'appApi', {
      configurable: true,
      writable: true,
      value: originalAppApi,
    });
    document.body.innerHTML = '';
  });

  it('derives initial state from all mirrored Slack workspace statuses', () => {
    expect(deriveSlackConnectionStateFromSettings(createSettings('connected')).status).toBe('connected');
    expect(deriveSlackConnectionStateFromSettings(createSettings('needs_reconnect')).status).toBe('reconnect-needed');
    expect(deriveSlackConnectionStateFromSettings(createSettings('disconnecting')).status).toBe('disconnecting');
    expect(deriveSlackConnectionStateFromSettings(createSettings('disconnected')).status).toBe('disconnected');
  });

  it('connect opens the browser, polls, and transitions to connected', async () => {
    startSlackOAuthMock.mockResolvedValue({ authUrl: 'https://slack.com/oauth/v2/authorize?state=s1', state: 's1' });
    getSlackWorkspaceMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ teamId: 'T1', teamName: 'Acme', status: 'connected', lastSeenAt: '2026-05-03T12:00:00.000Z' });
    const mounted = mountHook(createSettings());

    let promise: Promise<void>;
    await act(async () => {
      promise = mounted.result.current.connect();
      await Promise.resolve();
    });

    expect(window.appApi.openUrl).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?state=s1');
    expect(mounted.result.current.status).toBe('connecting');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await promise!;
    });

    expect(mounted.result.current.status).toBe('connected');
    expect(mounted.result.current.workspace?.teamName).toBe('Acme');
    mounted.unmount();
  });

  it('starts as checking before settings hydrate', () => {
    const mounted = mountHook(null);

    expect(mounted.result.current.status).toBe('checking');

    mounted.unmount();
  });

  it('connect sets slackCloudWebhookEnabled before transitioning to connected', async () => {
    startSlackOAuthMock.mockResolvedValue({ authUrl: 'https://slack.com/oauth/v2/authorize?state=s1', state: 's1' });
    getSlackWorkspaceMock.mockResolvedValue({ teamId: 'T1', teamName: 'Acme', status: 'connected', lastSeenAt: '2026-05-03T12:00:00.000Z' });
    const mounted = mountHook(createSettings());
    const savesDuring: Array<{ status: string; result: AppSettings }> = [];
    saveSettingsWithMock.mockImplementation(async (override: unknown) => {
      const update = override as (draft: AppSettings) => AppSettings;
      savesDuring.push({ status: mounted.result.current.status, result: update(createSettings()) });
    });

    let promise: Promise<void>;
    await act(async () => {
      promise = mounted.result.current.connect();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await promise!;
    });

    const webhookSave = savesDuring.find((entry) => entry.result.experimental?.slackCloudWebhookEnabled === true);
    expect(webhookSave?.status).toBe('connecting');
    expect(mounted.result.current.status).toBe('connected');
    mounted.unmount();
  });

  it('connect mirrors the polled workspace into experimental.cloudSlackWorkspace', async () => {
    startSlackOAuthMock.mockResolvedValue({ authUrl: 'https://slack.com/oauth/v2/authorize?state=s1', state: 's1' });
    getSlackWorkspaceMock.mockResolvedValue({
      teamId: 'TKQ8HRFQ8',
      teamName: 'Mindstone',
      status: 'connected',
      lastSeenAt: '2026-05-03T12:00:00.000Z',
    });
    const mounted = mountHook(createSettings());

    let promise: Promise<void>;
    await act(async () => {
      promise = mounted.result.current.connect();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await promise!;
    });

    const mirrorSave = saveSettingsWithMock.mock.calls
      .map(([override]) => (override as (draft: AppSettings) => AppSettings)(createSettings()))
      .find((result) => result.experimental?.cloudSlackWorkspace);
    expect(mirrorSave?.experimental?.cloudSlackWorkspace).toMatchObject({
      teamId: 'TKQ8HRFQ8',
      teamName: 'Mindstone',
      status: 'connected',
      lastSeenAt: Date.parse('2026-05-03T12:00:00.000Z'),
    });
    expect(typeof mirrorSave?.experimental?.cloudSlackWorkspace?.occurredAt).toBe('number');
    mounted.unmount();
  });

  it('connectByok opens the browser, polls, transitions to connected, and enables Slack cloud webhook', async () => {
    startByokSlackOAuthMock.mockResolvedValue({ authUrl: 'https://slack.com/oauth/v2/authorize?state=byok1', state: 'byok1' });
    getSlackWorkspaceMock.mockResolvedValue({ teamId: 'T1', teamName: 'Acme', status: 'connected', lastSeenAt: '2026-05-03T12:00:00.000Z' });
    const mounted = mountHook(createSettings());

    let promise: Promise<void>;
    await act(async () => {
      promise = mounted.result.current.connectByok({
        clientId: '123.456',
        clientSecret: 'client-secret',
        signingSecret: 'signing-secret',
      });
      await Promise.resolve();
    });

    expect(startByokSlackOAuthMock).toHaveBeenCalledWith({
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    }, { signal: expect.any(AbortSignal) });
    expect(window.appApi.openUrl).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?state=byok1');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await promise!;
    });

    expect(mounted.result.current.status).toBe('connected');
    // Two saves on a successful connectByok: workspace mirror, then webhook flag.
    expect(saveSettingsWithMock).toHaveBeenCalledTimes(2);
    mounted.unmount();
  });

  it('connectByok with bad credentials transitions to setup-error', async () => {
    const mounted = mountHook(createSettings());

    await expect(act(async () => {
      await expect(mounted.result.current.connectByok({
        clientId: 'not-valid',
        clientSecret: 'client-secret',
        signingSecret: 'signing-secret',
      })).rejects.toMatchObject({ field: 'clientId' });
    })).resolves.toBeUndefined();

    expect(mounted.result.current.status).toBe('setup-error');
    expect(mounted.result.current.error).toMatchObject({
      code: 'INVALID_FIELD',
      field: 'clientId',
      message: 'Client ID looks like 12345.67890',
    });
    expect(startByokSlackOAuthMock).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('connectByok rethrows OAUTH_TIMEOUT errors for wizard-level handling', async () => {
    startByokSlackOAuthMock.mockResolvedValue({ authUrl: 'https://slack.com/oauth/v2/authorize?state=byok-timeout', state: 'byok-timeout' });
    getSlackWorkspaceMock.mockResolvedValue(null);
    const mounted = mountHook(createSettings());

    let rejection: Promise<unknown> | null = null;
    await act(async () => {
      rejection = mounted.result.current.connectByok({
        clientId: '123.456',
        clientSecret: 'client-secret',
        signingSecret: 'signing-secret',
      }).catch((error) => error);
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    await expect(rejection).resolves.toMatchObject({
      code: 'OAUTH_TIMEOUT',
      message: 'The browser setup did not finish.',
    });
    expect(mounted.result.current.status).toBe('setup-error');
    expect(mounted.result.current.error?.code).toBe('OAUTH_TIMEOUT');
    mounted.unmount();
  });

  it('connect times out with setup-error when polling never finds a workspace', async () => {
    startSlackOAuthMock.mockResolvedValue({ authUrl: 'https://slack.com/oauth/v2/authorize?state=s1', state: 's1' });
    getSlackWorkspaceMock.mockResolvedValue(null);
    const mounted = mountHook(createSettings());

    let promise: Promise<void>;
    await act(async () => {
      promise = mounted.result.current.connect();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await promise!;
    });

    expect(mounted.result.current.status).toBe('setup-error');
    expect(mounted.result.current.error?.code).toBe('OAUTH_TIMEOUT');
    mounted.unmount();
  });

  it('cancel stops an in-flight connect and returns to disconnected', async () => {
    startSlackOAuthMock.mockResolvedValue({ authUrl: 'https://slack.com/oauth/v2/authorize?state=s1', state: 's1' });
    getSlackWorkspaceMock.mockResolvedValue(null);
    const mounted = mountHook(createSettings());

    let promise: Promise<void>;
    await act(async () => {
      promise = mounted.result.current.connect();
      await Promise.resolve();
    });
    act(() => mounted.result.current.cancel());
    await act(async () => {
      await promise!;
    });

    expect(mounted.result.current.status).toBe('disconnected');
    mounted.unmount();
  });

  it('cancel aborts an in-flight workspace poll without orphaning the connect promise', async () => {
    startSlackOAuthMock.mockResolvedValue({ authUrl: 'https://slack.com/oauth/v2/authorize?state=s1', state: 's1' });
    let aborted = false;
    getSlackWorkspaceMock.mockImplementation((signal?: AbortSignal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }));
    const mounted = mountHook(createSettings());

    let promise: Promise<void>;
    await act(async () => {
      promise = mounted.result.current.connect();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    act(() => mounted.result.current.cancel());
    await act(async () => {
      await promise!;
    });

    expect(aborted).toBe(true);
    expect(mounted.result.current.status).toBe('disconnected');
    mounted.unmount();
  });

  it('disconnect success transitions to disconnected', async () => {
    deleteSlackWorkspaceMock.mockResolvedValue(undefined);
    const mounted = mountHook(createSettings('connected'));

    await act(async () => {
      await mounted.result.current.disconnect();
    });

    expect(mounted.result.current.status).toBe('disconnected');
    mounted.unmount();
  });

  it('disconnect clears slackCloudWebhookEnabled and the workspace mirror', async () => {
    deleteSlackWorkspaceMock.mockResolvedValue(undefined);
    const mounted = mountHook(createSettings('connected'));

    await act(async () => {
      await mounted.result.current.disconnect();
    });

    // Two saves on a successful disconnect: webhook flag false, then workspace mirror clear.
    expect(saveSettingsWithMock).toHaveBeenCalledTimes(2);
    const webhookOverride = saveSettingsWithMock.mock.calls[0][0] as (draft: AppSettings) => AppSettings;
    expect(webhookOverride(createSettings('connected')).experimental?.slackCloudWebhookEnabled).toBe(false);
    const clearOverride = saveSettingsWithMock.mock.calls[1][0] as (draft: AppSettings) => AppSettings;
    expect(clearOverride(createSettings('connected')).experimental?.cloudSlackWorkspace).toBeUndefined();
    mounted.unmount();
  });

  it('refresh mirrors a freshly polled workspace when the broadcast was missed', async () => {
    getSlackWorkspaceMock.mockResolvedValue({
      teamId: 'TKQ8HRFQ8',
      teamName: 'Mindstone',
      status: 'connected',
      lastSeenAt: '2026-05-03T12:00:00.000Z',
    });
    const mounted = mountHook(createSettings());

    await act(async () => {
      await mounted.result.current.refresh();
    });

    expect(saveSettingsWithMock).toHaveBeenCalledTimes(1);
    const override = saveSettingsWithMock.mock.calls[0][0] as (draft: AppSettings) => AppSettings;
    expect(override(createSettings()).experimental?.cloudSlackWorkspace).toMatchObject({
      teamId: 'TKQ8HRFQ8',
      teamName: 'Mindstone',
      status: 'connected',
    });
    mounted.unmount();
  });

  it('refresh clears the workspace mirror when the cloud now reports disconnected', async () => {
    getSlackWorkspaceMock.mockResolvedValue(null);
    const mounted = mountHook(createSettings('connected'));

    await act(async () => {
      await mounted.result.current.refresh();
    });

    expect(saveSettingsWithMock).toHaveBeenCalledTimes(1);
    const override = saveSettingsWithMock.mock.calls[0][0] as (draft: AppSettings) => AppSettings;
    expect(override(createSettings('connected')).experimental?.cloudSlackWorkspace).toBeUndefined();
    mounted.unmount();
  });

  it('disconnect failure returns to connected with an inline error', async () => {
    deleteSlackWorkspaceMock.mockRejectedValue(new Error('boom'));
    const mounted = mountHook(createSettings('connected'));

    await act(async () => {
      await mounted.result.current.disconnect();
    });

    expect(mounted.result.current.status).toBe('connected');
    expect(mounted.result.current.error?.message).toBe('boom');
    mounted.unmount();
  });

  it('settings changes transition connected workspaces to reconnect-needed', () => {
    const mounted = mountHook(createSettings('connected'));

    mounted.rerender(createSettings('needs_reconnect'));

    expect(mounted.result.current.status).toBe('reconnect-needed');
    mounted.unmount();
  });

  it('cleanup on unmount cancels polling', async () => {
    startSlackOAuthMock.mockResolvedValue({ authUrl: 'https://slack.com/oauth/v2/authorize?state=s1', state: 's1' });
    getSlackWorkspaceMock.mockResolvedValue(null);
    const mounted = mountHook(createSettings());

    let promise: Promise<void>;
    await act(async () => {
      promise = mounted.result.current.connect();
      await Promise.resolve();
    });
    mounted.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await promise!;
    });

    expect(getSlackWorkspaceMock).not.toHaveBeenCalled();
  });
});
