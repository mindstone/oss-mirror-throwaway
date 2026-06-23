import { describe, expect, it } from 'vitest';
import { isSlackAuthErrorCode } from '../slackAuthErrorCodes';
import {
  createPublicChannelSafetyHookForSlack,
  wrapInboundSlackMessageForAgent,
  type SlackPromptSafetyContext,
} from '../slackPromptSafety';

const publicContext: SlackPromptSafetyContext = {
  rawText: 'Hello <script>alert("x")</script> & secrets?',
  channelType: 'channel',
  authorUserId: 'U123',
  isPublicChannel: true,
};

describe('slack inbound trigger shared helpers', () => {
  it('classifies Slack auth errors including token_expired', () => {
    expect(isSlackAuthErrorCode('token_expired')).toBe(true);
    expect(isSlackAuthErrorCode('invalid_auth')).toBe(true);
    expect(isSlackAuthErrorCode('channel_not_found')).toBe(false);
  });

  it('wraps inbound Slack text as untrusted prompt content', () => {
    const wrapped = wrapInboundSlackMessageForAgent(publicContext);
    expect(wrapped).toContain('<slack_message>');
    expect(wrapped).toContain('&lt;script&gt;');
    expect(wrapped).toContain('&amp;');
    expect(wrapped).not.toContain('<script>');
  });

  it('emits public-channel safety prompt only for public channels', () => {
    expect(createPublicChannelSafetyHookForSlack(publicContext)?.promptLines.join('\n')).toContain('PUBLIC CHANNEL PRIVACY NOTICE');
    expect(createPublicChannelSafetyHookForSlack({ ...publicContext, isPublicChannel: false })).toBeNull();
  });
});
