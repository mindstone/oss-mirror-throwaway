import type { Meta, StoryObj } from '@storybook/react';
import React, { useEffect } from 'react';
import type { InboundAuthorPolicy } from '@rebel/shared';
import {
  INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY,
  INBOUND_AUTHOR_UPGRADE_REPROMPT_SUPPRESSED_KEY,
} from '../../hooks/useInboundAuthorPolicy';
import { UpgradeReviewNotice, type UpgradeReviewNoticeProps } from './UpgradeReviewNotice';

const meta = {
  title: 'Settings/Messaging/UpgradeReviewNotice',
  component: UpgradeReviewNotice,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof UpgradeReviewNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

function buildPolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
  return {
    inboundAuthorPolicySchemaVersion: 1,
    policyRevision: 7,
    mode: 'legacyPermissive',
    allowlist: {},
    blocklist: {},
    surfaceTrusted: {},
    agentAllowlist: {},
    notices: {
      upgradeReviewPending: true,
    },
    ...overrides,
  };
}

function ThemePair(args: UpgradeReviewNoticeProps) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', width: 720, maxWidth: '100%' }}>
      <div className="light">
        <UpgradeReviewNotice {...args} />
      </div>
      <div className="dark">
        <UpgradeReviewNotice {...args} />
      </div>
    </div>
  );
}

function story(args: UpgradeReviewNoticeProps): Story {
  return {
    render: () => <ThemePair {...args} />,
  };
}

const noop = () => undefined;

export const Pending = story({
  policy: buildPolicy(),
  recentSendersCount: 4,
  onDismiss: noop,
  onMarkDismissedNow: noop,
});

export const Dismissed = story({
  policy: buildPolicy({
    mode: 'ownerOnly',
    notices: {
      upgradeReviewPending: false,
    },
  }),
  recentSendersCount: 0,
  onDismiss: noop,
  onMarkDismissedNow: noop,
});

function RepromptPair() {
  useEffect(() => {
    const now = Date.now();
    window.localStorage.setItem(
      INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY,
      String(now - (61 * 24 * 60 * 60 * 1000)),
    );
    window.localStorage.removeItem(INBOUND_AUTHOR_UPGRADE_REPROMPT_SUPPRESSED_KEY);
    return () => {
      window.localStorage.removeItem(INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY);
      window.localStorage.removeItem(INBOUND_AUTHOR_UPGRADE_REPROMPT_SUPPRESSED_KEY);
    };
  }, []);

  return (
    <ThemePair
      policy={buildPolicy({
        notices: { upgradeReviewPending: false },
      })}
      recentSendersCount={8}
      onDismiss={noop}
      onMarkDismissedNow={noop}
    />
  );
}

export const SixtyDayReprompt: Story = {
  render: () => <RepromptPair />,
};
