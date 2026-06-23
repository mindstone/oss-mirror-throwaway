import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import type { InboundAuthorPolicy } from '@rebel/shared';
import type { UseInboundAuthorPolicyResult } from '../../hooks/useInboundAuthorPolicy';
import { WhoCanMessageRebelPanel, type WhoCanMessageRebelPanelProps } from './WhoCanMessageRebelPanel';

const meta = {
  title: 'Settings/Messaging/WhoCanMessageRebelPanel',
  component: WhoCanMessageRebelPanel,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof WhoCanMessageRebelPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

function buildPolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
  return {
    inboundAuthorPolicySchemaVersion: 1,
    policyRevision: 12,
    mode: 'ownerOnly',
    allowlist: { slack: ['UOWNER123'] },
    blocklist: { slack: [] },
    surfaceTrusted: { slack: ['C12345'] },
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

function ThemePair(args: WhoCanMessageRebelPanelProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 820, maxWidth: '100%' }}>
      <div className="light">
        <WhoCanMessageRebelPanel {...args} />
      </div>
      <div className="dark">
        <WhoCanMessageRebelPanel {...args} />
      </div>
    </div>
  );
}

function story(args: WhoCanMessageRebelPanelProps): Story {
  return {
    render: () => <ThemePair {...args} />,
  };
}

export const FreshStrict = story({
  policyState: createPolicyState(buildPolicy({ mode: 'ownerOnly' })),
  slackConnected: true,
});

export const UpgradeLegacyPermissiveReviewPending = story({
  policyState: createPolicyState(
    buildPolicy({
      mode: 'legacyPermissive',
      notices: { upgradeReviewPending: true },
      allowlist: { slack: [] },
      blocklist: { slack: [] },
      surfaceTrusted: { slack: [] },
    }),
  ),
  slackConnected: true,
});

export const DisconnectedSlack = story({
  policyState: createPolicyState(buildPolicy({ mode: 'allowlist' })),
  slackConnected: false,
});

export const HostileStrings = story({
  policyState: createPolicyState(
    buildPolicy({
      mode: 'allowlist',
      allowlist: { slack: ['<script>alert(1)</script>', 'U\u202E321ABC'] },
      blocklist: { slack: ['@раураl', 'U\u202DZZZ111'] },
      surfaceTrusted: { slack: ['C\u202Eevil-channel'] },
    }),
  ),
  slackConnected: true,
});

export const AgentAuthoredAttemptVisible = story({
  policyState: createPolicyState(
    buildPolicy({
      mode: 'allowlist',
      agentAllowlist: { slack: ['rebel-instance-A', 'rebel-instance-B'] },
    }),
  ),
  slackConnected: true,
});

export const OwnerIdentityUnknown = story({
  policyState: createPolicyState(buildPolicy({ mode: 'ownerOnly' })),
  slackConnected: true,
  ownerIdentityUnknown: true,
});

export const BypassActive = story({
  policyState: {
    ...createPolicyState(buildPolicy({ mode: 'allowlist' })),
    inboundAuthorPolicyBypassActive: true,
  },
  slackConnected: true,
});
