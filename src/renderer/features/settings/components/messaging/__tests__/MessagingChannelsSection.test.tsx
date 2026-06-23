// @vitest-environment happy-dom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppSettings } from '@shared/types/settings';

const connectSlackActionMock = vi.hoisted(() => ({
  connect: vi.fn<(args?: { workspaceHint?: string }) => Promise<void>>(),
  isInFlight: false,
}));

const trackingMocks = vi.hoisted(() => ({
  messagingPanelConnectCtaClicked: vi.fn(),
  messagingChannelInterestClicked: vi.fn(),
}));

vi.mock('../../../hooks/useConnectSlackMcpAction', () => ({
  useConnectSlackMcpAction: () => connectSlackActionMock,
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    settings: trackingMocks,
  },
}));

import { MessagingChannelsSection } from '../MessagingChannelsSection';
import type { McpServerPreview } from '@shared/types';
import type {
  SlackCloudConnectionState,
  UseSlackCloudConnectionResult,
} from '../../../hooks/useSlackCloudConnection';
import { SettingsProvider, type SettingsContextValue } from '../../../SettingsProvider';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  rerender: (ui: React.ReactElement) => void;
  unmount: () => void;
}

function render(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    rerender: (nextUi: React.ReactElement) => {
      act(() => {
        root.render(nextUi);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button with text "${text}" not found`);
  return button;
}

function state(status: SlackCloudConnectionState['status']): SlackCloudConnectionState {
  return {
    status,
    workspace: status === 'connected' || status === 'disconnecting' || status === 'reconnect-needed'
      ? { teamId: 'T1', teamName: 'Acme Slack', lastSeenAt: '2026-05-03T11:58:00.000Z' }
      : null,
    error: status === 'setup-error'
      ? { code: 'OAUTH_FAILED', message: 'Slack setup failed before the handshake completed.' }
      : null,
  };
}

function connectionFor(value: SlackCloudConnectionState): UseSlackCloudConnectionResult {
  return {
    status: value.status,
    workspace: value.workspace,
    error: value.error,
    connect: vi.fn().mockResolvedValue(undefined),
    connectByok: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

function slackMcpServer(overrides: Partial<McpServerPreview> = {}): McpServerPreview {
  return {
    name: 'Slack-acme-slack',
    transport: 'stdio',
    catalogId: 'bundled-slack',
    workspace: 'Acme Slack',
    health: 'ok',
    ...overrides,
  };
}

function renderMessagingSection({
  mcpServers = [slackMcpServer()],
  status = 'disconnected',
  cloudContinuityMode,
  cloudSlackWorkspace,
  slackWorkspaces,
  cloudStatus = 'running',
  localFallbackEnabled = false,
  settings,
}: {
  mcpServers?: McpServerPreview[];
  status?: SlackCloudConnectionState['status'];
  cloudContinuityMode?: 'desktop-only' | 'cloud';
  cloudSlackWorkspace?: { teamId: string; teamName: string; status?: 'connected' | 'needs_reconnect' | 'disconnecting' | 'disconnected'; peerInstanceCount?: number } | null;
  slackWorkspaces?: { teamId: string; teamName: string }[];
  cloudStatus?: 'running' | 'warm' | 'cold' | 'provisioning' | 'error' | null;
  localFallbackEnabled?: boolean;
  settings?: AppSettings | null;
} = {}) {
  const node = (
    <MessagingChannelsSection
      mcpServers={mcpServers}
      cloudContinuityMode={cloudContinuityMode}
      cloudSlackWorkspace={cloudSlackWorkspace}
      slackWorkspaces={slackWorkspaces}
      cloudStatus={cloudStatus}
      localFallbackEnabled={localFallbackEnabled}
      connectSlackCardProps={{
        connection: connectionFor(state(status)),
        localFallback: { enabled: false, onToggle: vi.fn() },
        cloudStatus,
      }}
    />
  );

  if (!settings) {
    return render(node);
  }

  return render(
    <SettingsProvider
      value={{
        settings,
        draftSettings: settings,
        saveSettingsWith: vi.fn().mockResolvedValue(undefined),
      } as unknown as SettingsContextValue}
    >
      {node}
    </SettingsProvider>,
  );
}

describe('settings/messaging MessagingChannelsSection', () => {
  let mounted: Mounted[] = [];

  beforeEach(() => {
    connectSlackActionMock.connect.mockResolvedValue(undefined);
    connectSlackActionMock.isInFlight = false;
  });

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted = [];
    vi.clearAllMocks();
    delete (window as unknown as { slackApi?: unknown }).slackApi;
    document.body.innerHTML = '';
  });

  it('renders the section heading and description', () => {
    const section = renderMessagingSection();
    mounted.push(section);

    expect(section.container.querySelector('h2')?.textContent).toBe('Messaging');
    expect(section.container.textContent).toContain('Let Rebel answer @mentions from Slack threads, with more messaging apps coming later.');
    expect(section.container.querySelectorAll('[data-section="messagingChannels"]')).toHaveLength(1);
  });

  it('renders the ConnectSlackCard inside the section', () => {
    const section = renderMessagingSection();
    mounted.push(section);

    expect(section.container.querySelector('section[aria-label="Slack connection"]')).not.toBeNull();
    expect(section.container.textContent).toContain('Respond in Slack when mentioned');
  });

  it('renders the S1 inline CTA and hides the ConnectSlackCard when no Slack MCP is connected', () => {
    const section = renderMessagingSection({ mcpServers: [] });
    mounted.push(section);

    const cta = section.container.querySelector('[data-testid="messaging-connect-slack-cta"]');
    const slackCard = section.container.querySelector('section[aria-label="Slack connection"]');
    expect(cta).not.toBeNull();
    expect(slackCard).toBeNull();
    expect(section.container.textContent).toContain('Connect Slack first');
    expect(section.container.textContent).toContain('Rebel needs the Slack connector before it can listen for @mentions and reply in the thread.');
    expect(section.container.textContent).toContain('Manage or disconnect Slack later in Connectors.');
    expect(section.container.textContent).toContain('How Slack replies work');
    expect(section.container.textContent).toContain('Connect Slack to add people from recent attempts.');
  });

  it('renders Stage 7 inbound policy surfaces in the locked order under connector state', () => {
    const section = renderMessagingSection({
      status: 'connected',
      settings: {
        experimental: {
          inboundAuthorPolicy: {
            inboundAuthorPolicySchemaVersion: 1,
            policyRevision: 3,
            mode: 'legacyPermissive',
            allowlist: {},
            blocklist: {},
            surfaceTrusted: {},
            agentAllowlist: {},
            notices: { upgradeReviewPending: true },
          },
          cloudSlackWorkspace: {
            teamId: 'T1',
            teamName: 'Acme Slack',
            status: 'connected',
            peerInstanceCount: 2,
          },
        },
      } as AppSettings,
    });
    mounted.push(section);

    const connector = section.container.querySelector('section[aria-label="Slack connection"]');
    const multi = section.container.querySelector('[data-testid="multi-rebel-workspace-notice"]');
    const upgrade = section.container.querySelector('[data-testid="upgrade-review-notice"]');
    const who = section.container.querySelector('[data-testid="who-can-message-rebel-panel"]');
    const recent = section.container.querySelector('[data-testid="recent-message-attempts-panel"]');
    const moreChannels = section.container.querySelector('[data-testid="messaging-more-channels"]');

    expect(connector).not.toBeNull();
    expect(multi).not.toBeNull();
    expect(upgrade).not.toBeNull();
    expect(who).not.toBeNull();
    expect(recent).not.toBeNull();
    expect(moreChannels).not.toBeNull();

    expect(connector!.compareDocumentPosition(multi!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(multi!.compareDocumentPosition(upgrade!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(upgrade!.compareDocumentPosition(who!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(who!.compareDocumentPosition(recent!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recent!.compareDocumentPosition(moreChannels!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('omits the S1 inline CTA when a Slack MCP is connected and still renders the ConnectSlackCard', () => {
    const section = renderMessagingSection({ mcpServers: [slackMcpServer()] });
    mounted.push(section);

    expect(section.container.querySelector('[data-testid="messaging-connect-slack-cta"]')).toBeNull();
    expect(section.container.querySelector('section[aria-label="Slack connection"]')).not.toBeNull();
    expect(section.container.textContent).toContain('Respond in Slack when mentioned');
  });

  it('removes the S1 inline CTA when connector state transitions to Slack connected', () => {
    const section = renderMessagingSection({ mcpServers: [] });
    mounted.push(section);
    expect(section.container.querySelector('[data-testid="messaging-connect-slack-cta"]')).not.toBeNull();

    section.rerender(
      <MessagingChannelsSection
        mcpServers={[slackMcpServer()]}
        connectSlackCardProps={{
          connection: connectionFor(state('disconnected')),
          localFallback: { enabled: false, onToggle: vi.fn() },
          cloudStatus: 'running',
        }}
      />,
    );

    expect(section.container.querySelector('[data-testid="messaging-connect-slack-cta"]')).toBeNull();
    expect(section.container.querySelector('section[aria-label="Slack connection"]')).not.toBeNull();
  });

  it('disables the S1 inline CTA and shows Connecting… while the shared Slack MCP action is in flight', () => {
    connectSlackActionMock.isInFlight = true;
    const section = renderMessagingSection({ mcpServers: [] });
    mounted.push(section);

    const button = buttonByText(section.container, 'Connecting…');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Connecting to Slack…');
  });

  it('fires the Messaging connect CTA tracking event exactly once per click', async () => {
    const section = renderMessagingSection({ mcpServers: [] });
    mounted.push(section);

    await click(buttonByText(section.container, 'Connect Slack'));

    expect(trackingMocks.messagingPanelConnectCtaClicked).toHaveBeenCalledTimes(1);
    expect(connectSlackActionMock.connect).toHaveBeenCalledTimes(1);
  });

  it('renders an inline error notice when the Slack MCP action rejects', async () => {
    connectSlackActionMock.connect.mockRejectedValueOnce(new Error('Slack OAuth window was closed.'));
    const section = renderMessagingSection({ mcpServers: [] });
    mounted.push(section);

    await click(buttonByText(section.container, 'Connect Slack'));

    const alert = section.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Slack connection failed');
    expect(alert?.textContent).toContain('Slack OAuth window was closed.');
  });

  it('renders three coming-soon rows with the correct platform labels', () => {
    const section = renderMessagingSection();
    mounted.push(section);

    expect(section.container.textContent).toContain('Telegram');
    expect(section.container.textContent).toContain('WhatsApp');
    expect(section.container.textContent).toContain('Microsoft Teams');
    expect(section.container.querySelectorAll('[id$="-coming-soon-badge"]')).toHaveLength(3);
  });

  it('renders S7 alone with locked copy and cloud continuity setup link', () => {
    const section = renderMessagingSection({ cloudContinuityMode: 'desktop-only' });
    mounted.push(section);

    const notice = section.container.querySelector('[data-testid="messaging-s7-cloud-continuity-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Cloud continuity needed for always-on Slack');
    expect(notice?.textContent).toContain('Rebel can listen from this computer while it is open. Add cloud continuity to catch Slack mentions when it is not.');
    expect(notice?.textContent).toContain('Set up cloud continuity');
    expect(section.container.querySelector('[data-testid="messaging-s8-workspace-mismatch-notice"]')).toBeNull();
  });

  it('renders S8 alone and the Reinstall CTA invokes the Slack MCP hook with workspaceHint', async () => {
    const section = renderMessagingSection({
      cloudContinuityMode: 'cloud',
      cloudSlackWorkspace: { teamId: 'TB', teamName: 'Beta Slack', status: 'connected' },
      slackWorkspaces: [{ teamId: 'TA', teamName: 'Acme Slack' }],
      status: 'connected',
    });
    mounted.push(section);

    const notice = section.container.querySelector('[data-testid="messaging-s8-workspace-mismatch-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Slack connector and listener point to different workspaces');
    expect(notice?.textContent).toContain('Reinstall Slack for Beta Slack');

    await click(buttonByText(section.container, 'Reinstall Slack for Beta Slack'));

    expect(connectSlackActionMock.connect).toHaveBeenCalledWith({
      workspaceHint: 'Beta Slack',
      // Phase 7 (F2): the reinstall CTA now forwards the setup-guidance funnel so a
      // broken-by-default Slack connector opens ConnectorSetupDialog.
      onSetupGuidance: expect.any(Function),
    });
  });

  it('loads Slack MCP workspaces from the canonical slack:get-workspaces IPC for S8 detection', async () => {
    const getWorkspaces = vi.fn().mockResolvedValue({
      workspaces: [{ teamId: 'TA', teamName: 'Acme Slack' }],
    });
    (window as unknown as { slackApi?: { getWorkspaces: typeof getWorkspaces } }).slackApi = { getWorkspaces };

    const section = renderMessagingSection({
      cloudContinuityMode: 'cloud',
      cloudSlackWorkspace: { teamId: 'TB', teamName: 'Beta Slack', status: 'connected' },
      status: 'connected',
    });
    mounted.push(section);

    expect(getWorkspaces).toHaveBeenCalledTimes(1);
    await flushPromises();

    expect(section.container.querySelector('[data-testid="messaging-s8-workspace-mismatch-notice"]')).not.toBeNull();
  });

  it('hides S7 when S1 and S7 are both applicable', () => {
    const section = renderMessagingSection({
      mcpServers: [],
      cloudContinuityMode: 'desktop-only',
    });
    mounted.push(section);

    expect(section.container.querySelector('[data-testid="messaging-connect-slack-cta"]')).not.toBeNull();
    expect(section.container.querySelector('[data-testid="messaging-s7-cloud-continuity-notice"]')).toBeNull();
    expect(section.container.textContent).toContain('Connect Slack first');
  });

  it('renders S8 above the Slack card when S8 and S4 both apply', () => {
    const section = renderMessagingSection({
      cloudContinuityMode: 'cloud',
      cloudSlackWorkspace: { teamId: 'TB', teamName: 'Beta Slack', status: 'connected' },
      slackWorkspaces: [{ teamId: 'TA', teamName: 'Acme Slack' }],
      status: 'connected',
    });
    mounted.push(section);

    const s8 = section.container.querySelector('[data-testid="messaging-s8-workspace-mismatch-notice"]');
    const slackCard = section.container.querySelector('section[aria-label="Slack connection"]');
    expect(s8).not.toBeNull();
    expect(slackCard).not.toBeNull();
    expect(s8!.compareDocumentPosition(slackCard!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders S7 above S8 when both apply', () => {
    const section = renderMessagingSection({
      cloudContinuityMode: 'desktop-only',
      cloudSlackWorkspace: { teamId: 'TB', teamName: 'Beta Slack', status: 'connected' },
      slackWorkspaces: [{ teamId: 'TA', teamName: 'Acme Slack' }],
      status: 'connected',
    });
    mounted.push(section);

    const s7 = section.container.querySelector('[data-testid="messaging-s7-cloud-continuity-notice"]');
    const s8 = section.container.querySelector('[data-testid="messaging-s8-workspace-mismatch-notice"]');
    expect(s7).not.toBeNull();
    expect(s8).not.toBeNull();
    expect(s7!.compareDocumentPosition(s8!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });


  it('does not render S8 when any Slack MCP workspace matches the listener teamId', () => {
    const section = renderMessagingSection({
      cloudContinuityMode: 'cloud',
      cloudSlackWorkspace: { teamId: 'TB', teamName: 'Beta Slack', status: 'connected' },
      slackWorkspaces: [
        { teamId: 'TA', teamName: 'Acme Slack' },
        { teamId: 'TB', teamName: 'Beta Slack' },
      ],
      status: 'connected',
    });
    mounted.push(section);

    expect(section.container.querySelector('[data-testid="messaging-s8-workspace-mismatch-notice"]')).toBeNull();
  });

  it('renders the cloud-vs-desktop signal when desktop fallback is active and hides it when cloud is healthy', () => {
    const fallbackSection = renderMessagingSection({
      cloudContinuityMode: 'cloud',
      cloudStatus: 'running',
      localFallbackEnabled: true,
    });
    mounted.push(fallbackSection);

    expect(fallbackSection.container.querySelector('[data-testid="messaging-desktop-fallback-signal"]')?.textContent)
      .toContain('Listening via desktop fallback — cloud continuity is unreachable. Mentions are caught while this app is open.');

    const healthySection = renderMessagingSection({
      cloudContinuityMode: 'cloud',
      cloudStatus: 'running',
      localFallbackEnabled: false,
    });
    mounted.push(healthySection);

    expect(healthySection.container.querySelector('[data-testid="messaging-desktop-fallback-signal"]')).toBeNull();
  });

  it.each([
    ['telegram', 'telegram'],
    ['whatsapp', 'whatsapp'],
    ['teams', 'teams'],
  ] as const)('fires messagingChannelInterestClicked when the %s coming-soon button is clicked', async (testIdPlatform, channel) => {
    const section = renderMessagingSection();
    mounted.push(section);

    const row = section.container.querySelector(`[data-testid="messaging-coming-soon-${testIdPlatform}"]`);
    const button = row?.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.hasAttribute('disabled')).toBe(false);

    await click(button!);

    expect(trackingMocks.messagingChannelInterestClicked).toHaveBeenCalledWith({ channel });
  });

  it.each([
    ['S2 connector connected, listener disabled', 'disconnected'],
    ['S3 listener checking or authorising', 'connecting'],
    ['S4 listener enabled', 'connected'],
    ['S5 needs reconnect', 'reconnect-needed'],
    ['S6 error', 'setup-error'],
  ] as const)('renders the %s story state without error', (_label, status) => {
    let rendered: Mounted | null = null;
    expect(() => {
      rendered = render(
        <MessagingChannelsSection
          mcpServers={[slackMcpServer()]}
          connectSlackCardProps={{
            connection: connectionFor(state(status)),
            localFallback: { enabled: false, onToggle: vi.fn() },
            cloudStatus: 'running',
          }}
        />,
      );
    }).not.toThrow();
    if (rendered) mounted.push(rendered);
  });
});
