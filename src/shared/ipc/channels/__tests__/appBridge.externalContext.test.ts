import { describe, expect, it } from 'vitest';
import {
  IntentBufferedMessageSchema,
  IntentExternalContextArrivedSchema,
} from '../appBridge';

const slackExternalContext = {
  kind: 'slack-thread' as const,
  identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
  metadata: { userId: 'U1', channelName: 'general' },
};

describe('appBridge intent externalContext schemas', () => {
  it('IntentExternalContextArrivedSchema accepts legacy payloads without externalContext', () => {
    expect(IntentExternalContextArrivedSchema.safeParse({
      sessionId: 'session-1',
      appId: 'browser-extension',
      intent: 'ask',
      initialText: 'What is this?',
      receivedAt: 1,
    }).success).toBe(true);
  });

  it('IntentExternalContextArrivedSchema accepts payloads with externalContext', () => {
    expect(IntentExternalContextArrivedSchema.safeParse({
      sessionId: 'session-1',
      appId: 'slack',
      intent: 'chat',
      initialText: 'Slack asked',
      externalContext: slackExternalContext,
      receivedAt: 1,
      focus: false,
    }).success).toBe(true);
  });

  it('IntentBufferedMessageSchema accepts legacy payloads without externalContext', () => {
    expect(IntentBufferedMessageSchema.safeParse({
      sessionId: 'session-1',
      appId: 'browser-extension',
      messageId: 'message-1',
      text: 'Hold this',
      receivedAt: 1,
      queueSize: 1,
    }).success).toBe(true);
  });

  it('IntentBufferedMessageSchema accepts payloads with externalContext', () => {
    expect(IntentBufferedMessageSchema.safeParse({
      sessionId: 'session-1',
      appId: 'slack',
      messageId: 'message-1',
      text: 'Hold this',
      externalContext: slackExternalContext,
      receivedAt: 1,
      queueSize: 1,
    }).success).toBe(true);
  });
});
