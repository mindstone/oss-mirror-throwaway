import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

import { MessagingChannelsSection, type MessagingChannelsSectionProps } from './MessagingChannelsSection';
import type { McpServerPreview } from '@shared/types';
import type {
  SlackCloudConnectionState,
  UseSlackCloudConnectionResult,
} from '../../hooks/useSlackCloudConnection';

const meta = {
  title: 'Settings/Messaging Channels Section',
  component: MessagingChannelsSection,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof MessagingChannelsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

function state(
  status: SlackCloudConnectionState['status'],
  overrides: Partial<SlackCloudConnectionState> = {},
): SlackCloudConnectionState {
  return {
    status,
    workspace: status === 'connected' || status === 'disconnecting' || status === 'reconnect-needed'
      ? { teamId: 'T1', teamName: 'Acme Slack', lastSeenAt: '2026-05-03T11:58:00.000Z' }
      : null,
    error: status === 'setup-error'
      ? { code: 'OAUTH_FAILED', message: 'Slack setup failed before the handshake completed.' }
      : null,
    ...overrides,
  };
}

function connection(value: SlackCloudConnectionState): UseSlackCloudConnectionResult {
  return {
    status: value.status,
    workspace: value.workspace,
    error: value.error,
    connect: async () => undefined,
    connectByok: async () => undefined,
    cancel: () => undefined,
    disconnect: async () => undefined,
    retry: async () => undefined,
    refresh: async () => undefined,
  };
}

function slackMcpServer(): McpServerPreview {
  return {
    name: 'Slack-acme-slack',
    transport: 'stdio',
    catalogId: 'bundled-slack',
    workspace: 'Acme Slack',
    health: 'ok',
  };
}

function ThemePair(args: MessagingChannelsSectionProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 720, maxWidth: '100%' }}>
      <div className="light">
        <MessagingChannelsSection {...args} />
      </div>
      <div className="dark">
        <MessagingChannelsSection {...args} />
      </div>
    </div>
  );
}

function story(args: MessagingChannelsSectionProps): Story {
  return {
    render: () => <ThemePair {...args} />,
  };
}

export const S1NoSlackConnector = story({
  mcpServers: [],
});

export const S2ConnectorConnectedListenerDisabled = story({
  mcpServers: [slackMcpServer()],
  connectSlackCardProps: {
    connection: connection(state('disconnected')),
    localFallback: { enabled: false, onToggle: () => undefined },
    cloudStatus: 'running',
  },
});

export const S3ListenerCheckingOrAuthorising = story({
  mcpServers: [slackMcpServer()],
  connectSlackCardProps: {
    connection: connection(state('connecting')),
    localFallback: { enabled: false, onToggle: () => undefined },
    cloudStatus: 'running',
  },
});

export const S4ListenerEnabled = story({
  mcpServers: [slackMcpServer()],
  connectSlackCardProps: {
    connection: connection(state('connected')),
    localFallback: { enabled: false, onToggle: () => undefined },
    cloudStatus: 'running',
  },
});

export const S7CloudNotProvisioned = story({
  mcpServers: [slackMcpServer()],
  cloudContinuityMode: 'desktop-only',
  connectSlackCardProps: {
    connection: connection(state('disconnected')),
    localFallback: { enabled: false, onToggle: () => undefined },
    cloudStatus: 'running',
  },
});

export const S8WorkspaceMismatch = story({
  mcpServers: [slackMcpServer()],
  cloudContinuityMode: 'cloud',
  cloudSlackWorkspace: { teamId: 'TB', teamName: 'Beta Slack', status: 'connected' },
  slackWorkspaces: [{ teamId: 'TA', teamName: 'Acme Slack' }],
  connectSlackCardProps: {
    connection: connection(state('connected', {
      workspace: { teamId: 'TB', teamName: 'Beta Slack', lastSeenAt: '2026-05-03T11:58:00.000Z' },
    })),
    localFallback: { enabled: false, onToggle: () => undefined },
    cloudStatus: 'running',
  },
});

export const S8AndS4Overlay = story({
  mcpServers: [slackMcpServer()],
  cloudContinuityMode: 'cloud',
  cloudSlackWorkspace: { teamId: 'TB', teamName: 'Beta Slack', status: 'connected' },
  slackWorkspaces: [{ teamId: 'TA', teamName: 'Acme Slack' }],
  connectSlackCardProps: {
    connection: connection(state('connected', {
      workspace: { teamId: 'TB', teamName: 'Beta Slack', lastSeenAt: '2026-05-03T11:58:00.000Z' },
    })),
    localFallback: { enabled: false, onToggle: () => undefined },
    cloudStatus: 'running',
  },
});

export const MultiWorkspaceMatchNoS8 = story({
  mcpServers: [slackMcpServer()],
  cloudContinuityMode: 'cloud',
  cloudSlackWorkspace: { teamId: 'TB', teamName: 'Beta Slack', status: 'connected' },
  slackWorkspaces: [
    { teamId: 'TA', teamName: 'Acme Slack' },
    { teamId: 'TB', teamName: 'Beta Slack' },
  ],
  connectSlackCardProps: {
    connection: connection(state('connected', {
      workspace: { teamId: 'TB', teamName: 'Beta Slack', lastSeenAt: '2026-05-03T11:58:00.000Z' },
    })),
    localFallback: { enabled: false, onToggle: () => undefined },
    cloudStatus: 'running',
  },
});

export const CloudVsDesktopFallbackSignal = story({
  mcpServers: [slackMcpServer()],
  cloudContinuityMode: 'cloud',
  cloudStatus: 'error',
  localFallbackEnabled: true,
  connectSlackCardProps: {
    connection: connection(state('connected')),
    localFallback: { enabled: true, onToggle: () => undefined },
    cloudStatus: 'error',
  },
});

export const S5NeedsReconnect = story({
  mcpServers: [slackMcpServer()],
  connectSlackCardProps: {
    connection: connection(state('reconnect-needed')),
    localFallback: { enabled: false, onToggle: () => undefined },
    cloudStatus: 'running',
  },
});

export const S6Error = story({
  mcpServers: [slackMcpServer()],
  connectSlackCardProps: {
    connection: connection(state('setup-error')),
    localFallback: { enabled: false, onToggle: () => undefined },
    cloudStatus: 'running',
  },
});
