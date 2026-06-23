import { describe, expect, it } from 'vitest';

import {
  OUTBOUND_BROADCAST_TOOL_IDS,
  resolveOutboundBroadcastTarget,
} from '../index';

describe('resolveOutboundBroadcastTarget', () => {
  it('resolves a bare Slack outbound tool call with text', () => {
    const target = resolveOutboundBroadcastTarget('reply_to_slack_thread', {
      channel: 'C123',
      text: 'hello world',
    });
    expect(target).not.toBeNull();
    expect(target?.gateId).toBe('slack-public-channel');
    expect(target?.replyContent).toBe('hello world');
    expect(target?.userFacingSurfaceLabel).toBe('Slack channel');
    expect(target?.promptContext.surfaceKind).toBe('Slack channel');
    expect(target?.privateAlternativeSuggestion).toBe('DM you or use a private channel');
    expect(target?.denyAudienceWarning).toBe(
      'This is a PUBLIC channel — your reply would be visible to everyone in the workspace.',
    );
  });

  it('resolves all three Slack outbound tool ids', () => {
    for (const toolName of ['reply_to_slack_thread', 'post_slack_message', 'send_slack_message']) {
      const target = resolveOutboundBroadcastTarget(toolName, { text: 'ping' });
      expect(target?.gateId).toBe('slack-public-channel');
    }
  });

  it('resolves an MCP router use_tool wrapping a Slack tool', () => {
    const target = resolveOutboundBroadcastTarget('mcp__super-mcp-router__use_tool', {
      tool_id: 'reply_to_slack_thread',
      args: { text: 'forwarded reply' },
    });
    expect(target?.gateId).toBe('slack-public-channel');
    expect(target?.replyContent).toBe('forwarded reply');
  });

  it('returns null for unrelated tools', () => {
    expect(resolveOutboundBroadcastTarget('read_file', { path: '/tmp/x' })).toBeNull();
  });

  it('returns null when MCP router forwards to a non-broadcast tool', () => {
    expect(
      resolveOutboundBroadcastTarget('mcp__super-mcp-router__use_tool', {
        tool_id: 'list_slack_channels',
        args: {},
      }),
    ).toBeNull();
  });

  it('returns null when reply text is missing on a known Slack tool', () => {
    expect(
      resolveOutboundBroadcastTarget('reply_to_slack_thread', { channel: 'C123' }),
    ).toBeNull();
  });

  it('returns null when reply text is missing on an MCP-wrapped Slack tool', () => {
    expect(
      resolveOutboundBroadcastTarget('mcp__super-mcp-router__use_tool', {
        tool_id: 'post_slack_message',
        args: { channel: 'C123' },
      }),
    ).toBeNull();
  });

  it('returns null when reply text is not a string', () => {
    expect(
      resolveOutboundBroadcastTarget('reply_to_slack_thread', { text: 42 }),
    ).toBeNull();
  });

  it('returns null for null or non-object input', () => {
    expect(resolveOutboundBroadcastTarget('reply_to_slack_thread', null)).toBeNull();
    expect(resolveOutboundBroadcastTarget('reply_to_slack_thread', 'oops')).toBeNull();
  });

  it('carries connector-agnostic prompt context fields', () => {
    const target = resolveOutboundBroadcastTarget('reply_to_slack_thread', { text: 'x' });
    expect(target?.promptContext).toEqual({
      surfaceKind: 'Slack channel',
      inboundTriggerDescription: "a user's @-mention",
      audienceVisibilityStatement:
        'Everyone in the workspace can see messages in public channels.',
    });
  });
});

describe('OUTBOUND_BROADCAST_TOOL_IDS', () => {
  it('contains all Slack outbound tool ids', () => {
    expect(OUTBOUND_BROADCAST_TOOL_IDS.has('reply_to_slack_thread')).toBe(true);
    expect(OUTBOUND_BROADCAST_TOOL_IDS.has('post_slack_message')).toBe(true);
    expect(OUTBOUND_BROADCAST_TOOL_IDS.has('send_slack_message')).toBe(true);
  });

  it('does not include the MCP router id (which is not itself a broadcast tool)', () => {
    expect(OUTBOUND_BROADCAST_TOOL_IDS.has('mcp__super-mcp-router__use_tool')).toBe(false);
  });
});
