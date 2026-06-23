import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authChannels } from '@shared/ipc/channels/auth';
import { registerAuthHandlers } from '../authHandlers';

type AuthChannelName = keyof typeof authChannels;
type CapturedHandler = (event: unknown, request?: unknown) => Promise<unknown> | unknown;

const capturedHandlers = vi.hoisted(() => new Map<string, CapturedHandler>());

vi.mock('@main/ipc/utils/registerHandler', () => ({
  registerHandler: (channel: string, handler: CapturedHandler) => {
    capturedHandlers.set(channel, handler);
  },
}));

const throwingChannels = new Set<AuthChannelName>([
  'auth:login',
  'auth:send-otp',
  'auth:verify-otp',
]);

describe('OSS auth handlers contract guard', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    registerAuthHandlers();
  });

  it('registers every auth contract channel', () => {
    expect([...capturedHandlers.keys()].sort()).toEqual(
      Object.values(authChannels).map((channel) => channel.channel).sort(),
    );
  });

  it('returns values that parse through each auth response schema', async () => {
    for (const channelName of Object.keys(authChannels) as AuthChannelName[]) {
      if (throwingChannels.has(channelName)) {
        continue;
      }

      const channel = authChannels[channelName];
      const handler = capturedHandlers.get(channel.channel);
      if (!handler) {
        throw new Error(`missing OSS stub handler for ${channelName}`);
      }

      const result = await handler(undefined);
      expect(() => channel.response.parse(result), channelName).not.toThrow();
    }
  });

  it('rejects login-only channels with OSS_NO_LOGIN', async () => {
    for (const channelName of throwingChannels) {
      const channel = authChannels[channelName];
      const handler = capturedHandlers.get(channel.channel);
      if (!handler) {
        throw new Error(`missing OSS stub handler for ${channelName}`);
      }

      await expect(handler(undefined)).rejects.toMatchObject({
        code: 'OSS_NO_LOGIN',
      });
    }
  });
});
