import { describe, expect, it } from 'vitest';
import {
  CLOUD_CHANNEL_POLICIES,
  CLOUD_IPC_ALLOWLIST,
  CLOUD_ROUTABLE_CHANNELS,
  DUAL_WRITE_CHANNELS,
} from '../cloudChannelPolicies';
import { identityChannels } from '../ipc/channels/identity';

/**
 * The OSS lead-capture egress channel must be DESKTOP-ONLY: the lead-capture
 * POST is the sole Mindstone egress in the analytics-dark OSS build, and
 * routing it through the cloud surface would leak that egress cross-surface.
 * This regression test pins the channel's absence from every cloud-routing set.
 * See docs/plans/260623_oss-identity-ask-lead-capture/PLAN.md (Stage 3 / A1).
 */
describe('identity:capture-oss-lead — desktop-only (not cloud-routable)', () => {
  const channel = identityChannels['identity:capture-oss-lead'].channel;

  it('is absent from CLOUD_CHANNEL_POLICIES', () => {
    expect(Object.keys(CLOUD_CHANNEL_POLICIES)).not.toContain(channel);
  });

  it('is absent from CLOUD_ROUTABLE_CHANNELS', () => {
    expect(CLOUD_ROUTABLE_CHANNELS.has(channel)).toBe(false);
  });

  it('is absent from CLOUD_IPC_ALLOWLIST', () => {
    expect(CLOUD_IPC_ALLOWLIST.has(channel)).toBe(false);
  });

  it('is absent from DUAL_WRITE_CHANNELS', () => {
    expect(DUAL_WRITE_CHANNELS.has(channel)).toBe(false);
  });
});
