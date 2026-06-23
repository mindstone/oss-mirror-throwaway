import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import type { SlackRecentSender } from '@rebel/cloud-client';
import type { InboundAuthorPolicy } from '@rebel/shared';
import type { UseInboundAuthorPolicyResult } from '../../hooks/useInboundAuthorPolicy';
import { MultiRebelWorkspaceNotice } from './MultiRebelWorkspaceNotice';
import { RecentMessageAttemptsPanel, type UseSlackRecentSendersResult } from './RecentMessageAttemptsPanel';
import { UpgradeReviewNotice } from './UpgradeReviewNotice';
import { WhoCanMessageRebelPanel } from './WhoCanMessageRebelPanel';

interface MessagingPanelCompositeProps {
  policyState: UseInboundAuthorPolicyResult;
  recentSendersState: UseSlackRecentSendersResult;
  peerInstanceCount?: number;
  slackConnected?: boolean;
}

const meta = {
  title: 'Settings/Messaging/MessagingPanelComposite',
  component: MultiRebelWorkspaceNotice,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof MultiRebelWorkspaceNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

function buildPolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
  return {
    inboundAuthorPolicySchemaVersion: 1,
    policyRevision: 14,
    mode: 'legacyPermissive',
    allowlist: { slack: [] },
    blocklist: { slack: [] },
    surfaceTrusted: { slack: [] },
    agentAllowlist: { slack: ['rebel-peer-stage8'] },
    notices: { upgradeReviewPending: true },
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
    principalKey: 'slack:T1:human:U_STAGE8',
    kind: 'human',
    authorId: 'U_STAGE8',
    normalizedAuthorId: 'U_STAGE8',
    teamId: 'T1',
    lastSeenAt: Date.now() - 60 * 1000,
    attemptCount: 2,
    channelIds: ['launch-room'],
    lastChannelType: 'channel',
    ...overrides,
  };
}

function createRecentSendersState(senders: SlackRecentSender[]): UseSlackRecentSendersResult {
  return {
    senders,
    loading: false,
    error: null,
    refresh: async () => undefined,
    remove: async () => undefined,
    clearAll: async () => ({ cleared: senders.length }),
  };
}

function MessagingPanelComposite({
  policyState,
  recentSendersState,
  peerInstanceCount,
  slackConnected = true,
}: MessagingPanelCompositeProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', width: 920, maxWidth: '100%' }}>
      <MultiRebelWorkspaceNotice peerInstanceCount={peerInstanceCount} />
      <UpgradeReviewNotice
        policy={policyState.policy}
        recentSendersCount={recentSendersState.senders.length}
        onDismiss={policyState.dismissUpgradeReviewNotice}
        onMarkDismissedNow={policyState.markUpgradeReviewDismissedNow}
      />
      <WhoCanMessageRebelPanel
        policyState={policyState}
        slackConnected={slackConnected}
      />
      <RecentMessageAttemptsPanel
        policyState={policyState}
        recentSendersState={recentSendersState}
        slackConnected={slackConnected}
      />
    </div>
  );
}

function ThemePair(props: MessagingPanelCompositeProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 940, maxWidth: '100%' }}>
      <div className="light">
        <MessagingPanelComposite {...props} />
      </div>
      <div className="dark">
        <MessagingPanelComposite {...props} />
      </div>
    </div>
  );
}

function story(props: MessagingPanelCompositeProps): Story {
  return {
    render: () => <ThemePair {...props} />,
  };
}

export const LegacyReviewWithRecentAttempts = story({
  policyState: createPolicyState(buildPolicy()),
  recentSendersState: createRecentSendersState([
    sender({
      displayName: 'Scenario Stranger',
      handle: 'scenario-stranger',
      attemptCount: 5,
    }),
    sender({
      principalKey: 'slack:T1:agent:rebel-peer-stage8',
      kind: 'agent',
      authorId: 'rebel-peer-stage8',
      normalizedAuthorId: 'REBEL-PEER-STAGE8',
      displayName: 'Other Rebel',
      channelIds: ['D123'],
      lastChannelType: 'im',
      attemptCount: 1,
    }),
  ]),
  peerInstanceCount: 2,
  slackConnected: true,
});

export const OwnerOnlySteadyState = story({
  policyState: createPolicyState(
    buildPolicy({
      mode: 'ownerOnly',
      notices: { upgradeReviewPending: false },
      agentAllowlist: { slack: [] },
    }),
  ),
  recentSendersState: createRecentSendersState([]),
  peerInstanceCount: 1,
  slackConnected: true,
});
