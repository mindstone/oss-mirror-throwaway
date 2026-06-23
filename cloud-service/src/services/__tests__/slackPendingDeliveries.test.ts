import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStoreFactory } from '@core/storeFactory';
import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';
import { SlackThreadAdapter, type SlackWorkspaceStoreLike } from '@core/services/externalConversation/adapters/slackThreadAdapter';
import type { AgentResponse } from '@core/services/externalConversation/types';
import type { BroadcastService } from '@core/broadcastService';

describe('Slack pending deliveries', () => {
  let workspaceStore: SlackWorkspaceStoreLike;
  let broadcasts: Array<{ channel: string; payload: unknown }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
    setStoreFactory((opts) => new TestMemoryStore(opts) as never);
    workspaceStore = {
      get: () => ({
        teamId: 'T1',
        teamName: 'Acme',
        botUserId: 'UBOT',
        botToken: 'xoxb-token',
        installedAt: Date.now(),
        status: 'connected',
      }),
      set: vi.fn(),
      updateStatus: vi.fn(),
      updateLastSeen: vi.fn(),
      clear: vi.fn(),
    };
    broadcasts = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function responseMessage(): AgentResponse {
    return {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello from Rebel' }],
      },
    };
  }

  it('cancelByTeamId cancels matching pending deliveries and broadcasts permanent failures', async () => {
    const broadcast: BroadcastService = {
      sendToAllWindows: (channel, payload) => broadcasts.push({ channel, payload }),
      sendToFocusedWindow: vi.fn(),
    };
    const adapter = new SlackThreadAdapter({
      signingSecret: 'secret',
      workspaceStore,
      broadcast,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: () => Promise.resolve({ ok: false, error: 'rate_limited' }),
      } as Response),
    });

    await adapter.deliverResponse({
      context: {
        kind: 'slack-thread',
        identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
        metadata: {},
      },
      conversationId: 'conversation-1',
      message: responseMessage(),
    });
    await adapter.deliverResponse({
      context: {
        kind: 'slack-thread',
        identity: { teamId: 'T2', channelId: 'C2', threadTs: '200.000' },
        metadata: {},
      },
      conversationId: 'conversation-2',
      message: responseMessage(),
    });

    adapter.cancelByTeamId('T1');

    expect(broadcasts).toEqual([
      {
        channel: 'external-delivery:failed',
        payload: expect.objectContaining({
          conversationId: 'conversation-1',
          teamId: 'T1',
          reason: 'workspace_disconnected',
          permanent: true,
        }),
      },
    ]);
  });

  it('cancelByTeamId clears scheduled retry timeouts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: () => Promise.resolve({ ok: false, error: 'temporary_glitch' }),
    } as Response);
    const adapter = new SlackThreadAdapter({
      signingSecret: 'secret',
      workspaceStore,
      fetchImpl,
    });

    await adapter.deliverResponse({
      context: {
        kind: 'slack-thread',
        identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
        metadata: {},
      },
      conversationId: 'conversation-1',
      message: responseMessage(),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    adapter.cancelByTeamId('T1');
    fetchImpl.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancelByTeamId prevents ghost posts after reconnecting the same team before retry fires', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let connected = true;
    workspaceStore = {
      get: () => connected
        ? {
          teamId: 'T1',
          teamName: 'Acme',
          botUserId: 'UBOT',
          botToken: 'xoxb-token',
          installedAt: Date.now(),
          status: 'connected',
        }
        : null,
      set: vi.fn(),
      updateStatus: vi.fn(),
      updateLastSeen: vi.fn(),
      clear: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      json: () => Promise.resolve({ ok: false, error: 'temporary_glitch' }),
    } as Response).mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: () => Promise.resolve({ ok: true }),
    } as Response);
    const adapter = new SlackThreadAdapter({
      signingSecret: 'secret',
      workspaceStore,
      fetchImpl,
    });

    await adapter.deliverResponse({
      context: {
        kind: 'slack-thread',
        identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
        metadata: {},
      },
      conversationId: 'conversation-1',
      message: responseMessage(),
    });
    adapter.cancelByTeamId('T1');
    connected = false;
    connected = true;
    fetchImpl.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('attemptDelivery no-ops when the delivery is no longer in the persisted store', async () => {
    const fetchImpl = vi.fn();
    const adapter = new SlackThreadAdapter({
      signingSecret: 'secret',
      workspaceStore,
      fetchImpl,
    });
    const attemptDelivery = (adapter as unknown as {
      attemptDelivery(delivery: {
        id: string;
        context: { kind: 'slack-thread'; identity: { teamId: string; channelId: string; threadTs: string }; metadata: Record<string, never> };
        conversationId: string;
        message: AgentResponse;
        attempt: number;
        addedAt: number;
      }): Promise<{ status: string }>;
    }).attemptDelivery.bind(adapter);

    const result = await attemptDelivery({
      id: 'delivery-missing',
      context: {
        kind: 'slack-thread',
        identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
        metadata: {},
      },
      conversationId: 'conversation-1',
      message: responseMessage(),
      attempt: 1,
      addedAt: Date.now(),
    });

    expect(result.status).toBe('permanent-failure');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
