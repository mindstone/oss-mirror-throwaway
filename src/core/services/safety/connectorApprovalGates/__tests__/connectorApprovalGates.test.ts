import { describe, it, expect } from 'vitest';
import {
  getCohabitedTrustApprovalOverride,
  getInboundAutoApproveDecision,
  type ToolApprovalContext,
} from '../index';

function ctx(over: Partial<ToolApprovalContext> = {}): ToolApprovalContext {
  return {
    toolName: 'send_message',
    effectiveToolId: 'send_message',
    packageId: undefined,
    routerPackageId: undefined,
    routerArgs: {},
    ...over,
  };
}

describe('getCohabitedTrustApprovalOverride', () => {
  it('returns override for Slack DM by tool id when prompt is silent', () => {
    const result = getCohabitedTrustApprovalOverride(
      ctx({ effectiveToolId: 'open_slack_dm', packageId: 'slack' }),
      'You may post to public channels.',
    );
    expect(result).toBeDefined();
    expect(result?.gateId).toBe('slack-direct-message');
    expect(result?.reason).toContain('Slack direct messages require approval');
  });

  it('returns override when channel id matches DM pattern', () => {
    const result = getCohabitedTrustApprovalOverride(
      ctx({
        effectiveToolId: 'slack_post_message',
        packageId: 'slack',
        routerArgs: { channel_id: 'D012345' },
      }),
      '',
    );
    expect(result?.gateId).toBe('slack-direct-message');
  });

  it('returns undefined when the safety prompt explicitly grants DM permission', () => {
    const result = getCohabitedTrustApprovalOverride(
      ctx({ effectiveToolId: 'open_slack_dm', packageId: 'slack' }),
      'You are allowed to send Slack DMs automatically.',
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when the tool is not a Slack tool', () => {
    const result = getCohabitedTrustApprovalOverride(
      ctx({ effectiveToolId: 'send_email', packageId: 'email' }),
      '',
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when a Slack tool targets a public channel (no DM signal)', () => {
    const result = getCohabitedTrustApprovalOverride(
      ctx({
        effectiveToolId: 'slack_post_message',
        packageId: 'slack',
        routerArgs: { channel_id: 'C098765' },
      }),
      '',
    );
    expect(result).toBeUndefined();
  });

  it('matches via router package id when packageId is not set on context', () => {
    const result = getCohabitedTrustApprovalOverride(
      ctx({
        effectiveToolId: 'mcp_router_tool',
        routerPackageId: 'slack',
        routerArgs: { channel: 'D9999' },
      }),
      '',
    );
    expect(result?.gateId).toBe('slack-direct-message');
  });

  it('case-insensitive channel id match (lowercase D prefix)', () => {
    const result = getCohabitedTrustApprovalOverride(
      ctx({
        effectiveToolId: 'slack_send',
        packageId: 'slack',
        routerArgs: { channelId: 'd123abc' },
      }),
      '',
    );
    expect(result?.gateId).toBe('slack-direct-message');
  });

  it('recognises "direct message" phrasing + permission verb in safety prompt', () => {
    const result = getCohabitedTrustApprovalOverride(
      ctx({ effectiveToolId: 'open_slack_dm', packageId: 'slack' }),
      'Direct messages on Slack: can send without asking.',
    );
    expect(result).toBeUndefined();
  });
});

describe('getInboundAutoApproveDecision', () => {
  it('matches reply_to_slack_thread', () => {
    const result = getInboundAutoApproveDecision('reply_to_slack_thread');
    expect(result?.gateId).toBe('slack-inbound-reply');
    expect(result?.reason).toBe('Slack reply auto-approved');
  });

  it('matches post_slack_message', () => {
    const result = getInboundAutoApproveDecision('post_slack_message');
    expect(result?.gateId).toBe('slack-inbound-reply');
  });

  it('returns undefined for unrelated tool ids', () => {
    expect(getInboundAutoApproveDecision('send_email')).toBeUndefined();
    expect(getInboundAutoApproveDecision('Write')).toBeUndefined();
    expect(getInboundAutoApproveDecision('post_message')).toBeUndefined();
  });
});
