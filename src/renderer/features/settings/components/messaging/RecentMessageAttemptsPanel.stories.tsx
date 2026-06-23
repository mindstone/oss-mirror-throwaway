import type { Meta, StoryObj } from '@storybook/react';
import React, { useMemo, useState } from 'react';
import type { SlackRecentSender } from '@rebel/cloud-client';
import type { InboundAuthorPolicy } from '@rebel/shared';
import type { UseInboundAuthorPolicyResult } from '../../hooks/useInboundAuthorPolicy';
import type { UseSlackRecentSendersResult } from './RecentMessageAttemptsPanel';
import { RecentMessageAttemptsPanel, type RecentMessageAttemptsPanelProps } from './RecentMessageAttemptsPanel';

const meta = {
  title: 'Settings/Messaging/RecentMessageAttemptsPanel',
  component: RecentMessageAttemptsPanel,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof RecentMessageAttemptsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

function buildPolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
  return {
    inboundAuthorPolicySchemaVersion: 1,
    policyRevision: 4,
    mode: 'allowlist',
    allowlist: { slack: [] },
    blocklist: { slack: [] },
    surfaceTrusted: { slack: [] },
    agentAllowlist: { slack: [] },
    notices: { upgradeReviewPending: false },
    ...overrides,
  };
}

function createPolicyState(policy: InboundAuthorPolicy): UseInboundAuthorPolicyResult {
  const noop = async () => undefined;
  return {
    policy,
    setMode: noop,
    addToAllowlist: noop,
    addToBlocklist: noop,
    removeFromAllowlist: noop,
    removeFromBlocklist: noop,
    setSurfaceTrusted: noop,
    addToAgentAllowlist: noop,
    dismissUpgradeReviewNotice: noop,
    markUpgradeReviewDismissedNow: () => undefined,
  };
}

function sender(overrides: Partial<SlackRecentSender>): SlackRecentSender {
  return {
    principalKey: 'slack:T1:human:U12345678',
    kind: 'human',
    authorId: 'U12345678',
    normalizedAuthorId: 'U12345678',
    teamId: 'T1',
    lastSeenAt: Date.now() - 2 * 60 * 1000,
    attemptCount: 1,
    channelIds: ['general'],
    lastChannelType: 'channel',
    ...overrides,
  };
}

function stateWithSenders(senders: SlackRecentSender[]): UseSlackRecentSendersResult {
  return {
    senders,
    loading: false,
    error: null,
    refresh: async () => undefined,
    remove: async () => undefined,
    clearAll: async () => ({ cleared: senders.length }),
  };
}

function ThemePair(args: RecentMessageAttemptsPanelProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 860, maxWidth: '100%' }}>
      <div className="light">
        <RecentMessageAttemptsPanel {...args} />
      </div>
      <div className="dark">
        <RecentMessageAttemptsPanel {...args} />
      </div>
    </div>
  );
}

function story(args: RecentMessageAttemptsPanelProps): Story {
  return {
    render: () => <ThemePair {...args} />,
  };
}

const defaultPolicy = createPolicyState(buildPolicy());

export const Empty = story({
  policyState: defaultPolicy,
  recentSendersState: stateWithSenders([]),
  slackConnected: true,
});

export const OneHumanAttempt = story({
  policyState: defaultPolicy,
  recentSendersState: stateWithSenders([
    sender({
      displayName: 'Alex Harper',
      handle: 'aharper',
      channelIds: ['launch-room'],
      lastChannelType: 'channel',
      attemptCount: 2,
    }),
  ]),
  slackConnected: true,
});

export const RepeatedAttemptsFiftyPlus = story({
  policyState: defaultPolicy,
  recentSendersState: stateWithSenders([
    sender({
      principalKey: 'slack:T1:human:UHOT12345',
      authorId: 'UHOT12345',
      normalizedAuthorId: 'UHOT12345',
      displayName: 'Very Determined Person',
      attemptCount: 57,
      channelIds: ['ops-war-room'],
    }),
  ]),
  slackConnected: true,
});

function AllowedNowInteractivePair() {
  const [senders, setSenders] = useState<SlackRecentSender[]>([
    sender({
      principalKey: 'slack:T1:human:UALLOW0001',
      authorId: 'UALLOW0001',
      normalizedAuthorId: 'UALLOW0001',
      displayName: 'Needs Approval',
      attemptCount: 3,
    }),
  ]);

  const recentSendersState = useMemo<UseSlackRecentSendersResult>(() => ({
    senders,
    loading: false,
    error: null,
    refresh: async () => undefined,
    remove: async (principalKey: string) => {
      setSenders((current) => current.filter((entry) => entry.principalKey !== principalKey));
    },
    clearAll: async () => {
      const cleared = senders.length;
      setSenders([]);
      return { cleared };
    },
  }), [senders]);

  return (
    <ThemePair
      policyState={defaultPolicy}
      recentSendersState={recentSendersState}
      slackConnected
    />
  );
}

export const AllowedNowPostAction: Story = {
  render: () => <AllowedNowInteractivePair />,
};

export const UnknownUser = story({
  policyState: defaultPolicy,
  recentSendersState: stateWithSenders([
    sender({
      principalKey: 'slack:T1:human:UUNKNOWN',
      authorId: 'UUNKNOWN',
      normalizedAuthorId: 'UUNKNOWN',
      displayName: undefined,
      handle: undefined,
    }),
  ]),
  slackConnected: true,
});

export const HostileStrings = story({
  policyState: defaultPolicy,
  recentSendersState: stateWithSenders([
    sender({
      principalKey: 'slack:T1:human:UHOSTILE',
      authorId: 'UHOSTILE',
      normalizedAuthorId: 'UHOSTILE',
      displayName: '<script>alert(1)</script>',
      handle: 'u\u202Eevil',
      channelIds: ['\u202Echan'],
    }),
  ]),
  slackConnected: true,
});

export const AgentAuthored = story({
  policyState: defaultPolicy,
  recentSendersState: stateWithSenders([
    sender({
      principalKey: 'slack:T1:human:U11111111',
      authorId: 'U11111111',
      normalizedAuthorId: 'U11111111',
      displayName: 'Human Sender',
    }),
    sender({
      principalKey: 'slack:T1:agent:rebel-instance-A',
      kind: 'agent',
      authorId: 'rebel-instance-A',
      normalizedAuthorId: 'REBEL-INSTANCE-A',
      displayName: 'Rebel in Finance Workspace',
      lastChannelType: 'im',
      channelIds: ['D1234'],
    }),
  ]),
  slackConnected: true,
});

export const DisconnectedHistorical = story({
  policyState: defaultPolicy,
  recentSendersState: stateWithSenders([
    sender({
      principalKey: 'slack:T1:human:UHISTORY',
      authorId: 'UHISTORY',
      normalizedAuthorId: 'UHISTORY',
      displayName: 'Historical Sender',
      attemptCount: 5,
    }),
  ]),
  slackConnected: false,
});
