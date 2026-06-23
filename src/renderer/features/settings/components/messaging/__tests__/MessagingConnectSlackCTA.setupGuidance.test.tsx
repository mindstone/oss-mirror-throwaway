// @vitest-environment happy-dom

/**
 * Phase 7 (F2): the Messaging Slack connect CTA must open the shared `ConnectorSetupDialog` when the
 * Slack connector is broken-by-default (no OAuth client credentials). Before the fix it called
 * `useConnectSlackMcpAction()` WITHOUT `onSetupGuidance`, so the not-configured `setupGuidance` was
 * dropped and the user saw only a generic "connection failed" notice.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE, type OAuthSetupGuidance } from '@shared/ipc/schemas/common';
import { MessagingConnectSlackCTA } from '../MessagingConnectSlackCTA';
import { connectSlackMcpActionTesting } from '../../../hooks/useConnectSlackMcpAction';

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    settings: {
      messagingPanelConnectCtaClicked: vi.fn(),
      connectorConnected: vi.fn(),
      connectorConnectionFailed: vi.fn(),
    },
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLACK_GUIDANCE: OAuthSetupGuidance = {
  code: OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE,
  provider: 'slack',
  displayName: 'Slack',
  message: 'Slack OAuth app not configured.',
  selfServe: true,
  setupUrl: 'https://api.slack.com/apps',
  envVars: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'],
  redirectUris: ['mindstone://slack/callback'],
};

describe('MessagingConnectSlackCTA — setup guidance', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalSlackApi: typeof window.slackApi;

  beforeEach(() => {
    vi.clearAllMocks();
    connectSlackMcpActionTesting.reset();
    originalSlackApi = window.slackApi;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    connectSlackMcpActionTesting.reset();
    Object.defineProperty(window, 'slackApi', { configurable: true, writable: true, value: originalSlackApi });
    document.body.innerHTML = '';
  });

  it('opens the ConnectorSetupDialog when Slack start-auth returns not-configured guidance', async () => {
    Object.defineProperty(window, 'slackApi', {
      configurable: true,
      writable: true,
      value: {
        startAuth: vi.fn().mockResolvedValue({
          success: false,
          error: SLACK_GUIDANCE.message,
          setupGuidance: SLACK_GUIDANCE,
        }),
      },
    });

    act(() => root.render(React.createElement(MessagingConnectSlackCTA)));

    const button = container.querySelector<HTMLButtonElement>('[data-testid="messaging-connect-slack-cta"] button');
    expect(button).not.toBeNull();

    await act(async () => {
      button!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The shared dialog opened (guidance routed), NOT the generic failure notice.
    expect(document.querySelector('[data-testid="connector-setup-dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
