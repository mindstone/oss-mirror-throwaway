// @vitest-environment happy-dom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectSlackCard,
  formatRelativeTime,
  type SlackLocalFallbackState,
} from '../ConnectSlackCard';
import type {
  SlackCloudConnectionState,
  UseSlackCloudConnectionResult,
} from '../../hooks/useSlackCloudConnection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mount(ui: React.ReactElement, theme?: 'light' | 'dark'): Mounted {
  const container = document.createElement('div');
  if (theme) container.className = theme;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function baseState(status: SlackCloudConnectionState['status']): SlackCloudConnectionState {
  return {
    status,
    workspace: status === 'connected' || status === 'disconnecting' || status === 'reconnect-needed'
      ? { teamId: 'T1', teamName: 'Acme Slack', lastSeenAt: '2026-05-03T11:58:00.000Z' }
      : null,
    error: status === 'setup-error'
      ? { code: 'OAUTH_TIMEOUT', message: 'The browser setup did not finish. xoxb-secret-token' }
      : null,
  };
}

function connectionFor(
  state: SlackCloudConnectionState,
  overrides: Partial<UseSlackCloudConnectionResult> = {},
): UseSlackCloudConnectionResult {
  return {
    status: state.status,
    workspace: state.workspace,
    error: state.error,
    connect: vi.fn().mockResolvedValue(undefined),
    connectByok: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fallbackState(enabled = false): SlackLocalFallbackState {
  return {
    enabled,
    onToggle: vi.fn(),
  };
}

function buttonByName(name: string): HTMLButtonElement {
  const match = Array.from(document.body.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(name));
  if (!match) throw new Error(`Button not found: ${name}`);
  return match as HTMLButtonElement;
}

describe('ConnectSlackCard', () => {
  let mounted: Mounted[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    Object.defineProperty(window, 'inboundTriggersApi', {
      configurable: true,
      writable: true,
      value: {
        getAdapterState: vi.fn().mockResolvedValue({ enabled: false }),
        setAdapterEnabled: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it.each([
    ['checking', 'Checking Slack connection…'],
    ['disconnected', 'Connect Slack'],
    ['connecting', 'Authorising in your browser...'],
    ['connected', 'Slack connected'],
    ['disconnecting', 'Disconnecting Slack...'],
    ['reconnect-needed', 'Slack needs reconnecting'],
    ['setup-error', "Couldn't connect Slack"],
  ] as const)('renders correct copy for %s state', (status, expectedCopy) => {
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState(status))}
        localFallback={fallbackState()}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    expect(card.container.textContent).toContain(expectedCopy);
  });

  it('connecting state shows Cancel and clicking it returns to Disconnected', () => {
    function Harness() {
      const [state, setState] = useState(baseState('connecting'));
      return (
        <ConnectSlackCard
          connection={connectionFor(state, {
            cancel: () => setState(baseState('disconnected')),
          })}
          localFallback={fallbackState()}
          cloudStatus="running"
        />
      );
    }
    const card = mount(<Harness />);
    mounted.push(card);

    act(() => buttonByName('Cancel').click());

    expect(card.container.textContent).toContain('Mention Rebel in a Slack thread');
  });

  it('connected state shows workspace name and relative time', () => {
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('connected'))}
        localFallback={fallbackState()}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    expect(formatRelativeTime('2026-05-03T11:58:00.000Z')).toBe('2 minutes ago');
    expect(card.container.textContent).toContain('Acme Slack · 2 minutes ago');
  });

  it('clicking Connect from disconnected calls connect', () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('disconnected'), { connect })}
        localFallback={fallbackState()}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    act(() => buttonByName('Connect Slack').click());

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('BYOK disconnected state opens the setup wizard from Get started', () => {
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('disconnected'))}
        localFallback={fallbackState()}
        cloudStatus="running"
        provisionMode="byok"
        cloudBaseUrl="https://cloud.example.test"
      />,
    );
    mounted.push(card);

    expect(card.container.textContent).toContain('Set up your Slack connection');
    act(() => buttonByName('Get started').click());

    expect(document.body.textContent).toContain('Create a Slack app');
  });

  it('disconnecting state has no visible actions', () => {
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('disconnecting'))}
        localFallback={fallbackState()}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    expect(card.container.querySelector('button')).toBeNull();
  });

  it('opens ConfirmDisconnectSlackDialog and calls disconnect from the destructive action', () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('connected'), { disconnect })}
        localFallback={fallbackState()}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    act(() => buttonByName('Disconnect').click());
    expect(document.body.textContent).toContain('Disconnect Slack?');

    const disconnectButtons = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.textContent?.includes('Disconnect'));
    act(() => (disconnectButtons.at(-1) as HTMLButtonElement).click());

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('opens ConfirmReplaceSlackDialog and disconnects before continuing', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('connected'), { disconnect })}
        localFallback={fallbackState()}
        cloudStatus="running"
        provisionMode="byok"
        cloudBaseUrl="https://cloud.example.test"
      />,
    );
    mounted.push(card);

    act(() => buttonByName('Replace').click());
    expect(document.body.textContent).toContain('Disconnect current Slack?');

    await act(async () => {
      buttonByName('Disconnect and continue').click();
      await Promise.resolve();
    });

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Create a Slack app');
  });

  it('managed connected users see Disconnect without Replace, while BYOK users can Replace', () => {
    const managed = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('connected'))}
        localFallback={fallbackState()}
        cloudStatus="running"
        provisionMode="managed"
      />,
    );
    const byok = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('connected'))}
        localFallback={fallbackState()}
        cloudStatus="running"
        provisionMode="byok"
        cloudBaseUrl="https://cloud.example.test"
      />,
    );
    mounted.push(managed, byok);

    expect(Array.from(managed.container.querySelectorAll('button')).some((button) => button.textContent?.includes('Replace'))).toBe(false);
    expect(managed.container.textContent).toContain('Disconnect');
    expect(Array.from(byok.container.querySelectorAll('button')).some((button) => button.textContent?.includes('Replace'))).toBe(true);
  });

  it('expands setup-error details and copies a redacted support blob', async () => {
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('setup-error'))}
        localFallback={fallbackState()}
        cloudStatus="running"
        cloudBaseUrl="https://cloud.example.test"
      />,
    );
    mounted.push(card);

    act(() => buttonByName('What happened?').click());
    expect(card.container.textContent).toContain('The browser setup did not finish.');

    await act(async () => {
      buttonByName('Copy details to share with support').click();
      await Promise.resolve();
    });

    const writeText = vi.mocked(navigator.clipboard.writeText);
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    expect(copied).toContain('Code: OAUTH_TIMEOUT');
    expect(copied).toContain('Cloud base: https://cloud.example.test');
    expect(copied).not.toMatch(/xox[baprs]-/);
    expect(copied).not.toContain('secret-token');
  });

  it('redacts OAuth codes, JSON secrets, bearer tokens, Slack tokens, and long raw payloads from support copy', async () => {
    const longPayloadSecret = 'payload-secret-value';
    const rawPayload = `{"body":"${'x'.repeat(3_100)}","client_secret":"${longPayloadSecret}"}`;
    const secretValues = [
      'oauth-code-value',
      'client-secret-value',
      'signing-secret-value',
      'bot-token-value',
      'refresh-token-value',
      'camel-client-secret-value',
      'camel-signing-secret-value',
      'camel-bot-token-value',
      'camel-oauth-code-value',
      'camel-refresh-token-value',
      'bearer-secret-value',
      'xoxb-secret-token',
      longPayloadSecret,
    ];
    const errorMessage = [
      'https://cloud.example.test/callback?code=oauth-code-value&state=s1',
      '"client_secret": "client-secret-value"',
      '"signing_secret": "signing-secret-value"',
      '"bot_token": "bot-token-value"',
      '"oauth_code": "oauth-code-value"',
      '"refresh_token": "refresh-token-value"',
      '"clientSecret": "camel-client-secret-value"',
      '"signingSecret": "camel-signing-secret-value"',
      '"botToken": "camel-bot-token-value"',
      '"oauthCode": "camel-oauth-code-value"',
      '"refreshToken": "camel-refresh-token-value"',
      'Authorization: Bearer bearer-secret-value',
      'token=xoxb-secret-token',
      rawPayload,
    ].join('\n');
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor({
          status: 'setup-error',
          workspace: null,
          error: { code: 'UNKNOWN_VENDOR_ERROR', message: errorMessage },
        })}
        localFallback={fallbackState()}
        cloudStatus="running"
        cloudBaseUrl="https://cloud.example.test"
      />,
    );
    mounted.push(card);

    act(() => buttonByName('What happened?').click());
    await act(async () => {
      buttonByName('Copy details to share with support').click();
      await Promise.resolve();
    });

    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    for (const secret of secretValues) {
      expect(copied).not.toContain(secret);
    }
    expect(copied).toContain('[redacted-payload-');
  });

  it('Reconnect Slack calls connect', () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('reconnect-needed'), { connect })}
        localFallback={fallbackState()}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    act(() => buttonByName('Reconnect Slack').click());

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('renders reconnect-needed with retry metadata', () => {
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor({
          ...baseState('reconnect-needed'),
          error: { code: 'RATE_LIMITED', message: 'Try again shortly.', retryAfterSeconds: 60 },
        })}
        localFallback={fallbackState()}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    expect(card.container.textContent).toContain('Slack needs reconnecting');
    expect(card.container.textContent).toContain('Reconnect Slack');
  });

  it('connected state with no workspace metadata falls back to ready copy', () => {
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor({ ...baseState('connected'), workspace: null })}
        localFallback={fallbackState()}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    expect(card.container.textContent).toContain('Ready for new mentions');
  });

  it('shows local fallback only when cloud is cold or when fallback remains enabled', () => {
    const running = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('disconnected'))}
        localFallback={fallbackState(false)}
        cloudStatus="running"
      />,
    );
    const cold = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('disconnected'))}
        localFallback={fallbackState(false)}
        cloudStatus="cold"
      />,
    );
    const enabled = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('connected'))}
        localFallback={fallbackState(true)}
        cloudStatus="running"
      />,
    );
    mounted.push(running, cold, enabled);

    expect(running.container.textContent).not.toContain('Advanced - run from this computer instead');
    expect(cold.container.textContent).toContain('Advanced - run from this computer instead');
    expect(enabled.container.textContent).toContain('Advanced - run from this computer instead');
  });

  it('shows duplicate-reply warning without expanding fallback details', () => {
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('connected'))}
        localFallback={fallbackState(true)}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    expect(card.container.textContent).toContain('Both Slack paths active. Disable the fallback to avoid duplicate replies.');
    expect(card.container.textContent).not.toContain('Slower, but useful if your Rebel cloud is not available.');
  });

  it('renders through light and dark theme containers', () => {
    const light = mount(
      <ConnectSlackCard connection={connectionFor(baseState('disconnected'))} localFallback={fallbackState()} cloudStatus="running" />,
      'light',
    );
    const dark = mount(
      <ConnectSlackCard connection={connectionFor(baseState('disconnected'))} localFallback={fallbackState()} cloudStatus="running" />,
      'dark',
    );
    mounted.push(light, dark);

    expect(light.container.classList.contains('light')).toBe(true);
    expect(dark.container.classList.contains('dark')).toBe(true);
    expect(light.container.textContent).toContain('Connect Slack');
    expect(dark.container.textContent).toContain('Connect Slack');
  });

  it('includes status, alert, aria-live, and explicit button types', () => {
    const card = mount(
      <ConnectSlackCard
        connection={connectionFor(baseState('setup-error'))}
        localFallback={fallbackState()}
        cloudStatus="running"
      />,
    );
    mounted.push(card);

    const status = card.container.querySelector('[role="status"]');
    const alert = card.container.querySelector('[role="alert"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(alert).not.toBeNull();
    for (const button of Array.from(card.container.querySelectorAll('button'))) {
      expect(button.getAttribute('type')).toBe('button');
    }
  });
});
