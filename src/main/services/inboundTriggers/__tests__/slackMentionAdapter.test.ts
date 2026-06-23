import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@core/logger';

const mockGetSlackWorkspaces = vi.fn();
const mockGetSlackWorkspaceDetails = vi.fn();

vi.mock('../../slackAuthService', () => ({
  getSlackWorkspaces: (...args: unknown[]) => mockGetSlackWorkspaces(...args),
  getSlackWorkspaceDetails: (...args: unknown[]) => mockGetSlackWorkspaceDetails(...args),
  refreshSlackTokens: vi.fn(),
}));

vi.mock('../publicBroadcastSafetyHook', () => ({
  createPublicBroadcastSafetyHook: vi.fn(),
}));

let SlackMentionAdapter: typeof import('../slackMentionAdapter').SlackMentionAdapter;
let adapterTest: typeof import('../slackMentionAdapter').slackMentionAdapterTestHooks;

beforeAll(async () => {
  const mod = await import('../slackMentionAdapter');
  SlackMentionAdapter = mod.SlackMentionAdapter;
  adapterTest = mod.slackMentionAdapterTestHooks;
});

function makeDetails() {
  return {
    botToken: 'xoxb-bot-token',
    userToken: 'xoxp-user-token',
    botUserId: 'UBOT123',
    authedUserId: 'UAUTHED1',
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as Response;
}

function logger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

function searchResponse(match: Record<string, unknown>): Response {
  return jsonResponse({
    ok: true,
    messages: {
      matches: [match],
    },
  });
}

function conversationsInfoResponse(): Response {
  return jsonResponse({
    ok: true,
    channel: {
      name: 'general',
      is_private: false,
      is_im: false,
      is_mpim: false,
      is_group: false,
    },
  });
}

function slackMatch(overrides: Record<string, unknown> = {}) {
  return {
    ts: '1710000000.000002',
    text: '<@UBOT123> hello',
    channel: { id: 'C1', name: 'general' },
    user: 'UAUTHED1',
    username: 'alice',
    thread_ts: '1710000000.000001',
    permalink: 'https://example.slack.com/archives/C1/p1710000000000002',
    ...overrides,
  };
}

describe('SlackMentionAdapter desktop thread continuity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterTest.clearSlackPollingInflightEventIds();
    mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
    mockGetSlackWorkspaces.mockResolvedValue([{ teamId: 'T1', teamName: 'Acme', authedAt: 'now' }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enriches mentions with canonical slack-thread externalContext', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(searchResponse(slackMatch()))
      .mockResolvedValueOnce(conversationsInfoResponse());
    const adapter = new SlackMentionAdapter({ log: logger() });

    const trigger = await adapter.poll('T1', '1710000000.000000', new Set());

    expect(trigger?.externalContext).toEqual({
      kind: 'slack-thread',
      identity: {
        teamId: 'T1',
        channelId: 'C1',
        threadTs: '1710000000.000001',
      },
      metadata: expect.objectContaining({
        userId: 'UAUTHED1',
        userName: 'alice',
        userDisplayName: 'alice',
        channelName: 'general',
        teamName: 'Acme',
        permalink: 'https://example.slack.com/archives/C1/p1710000000000002',
      }),
    });
  });

  it('F11 skips duplicate in-process Slack events and advances the polling cursor', async () => {
    const info = vi.fn();
    const marked: Array<{ sourceId: string; timestamp: string }> = [];
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(searchResponse(slackMatch()))
      .mockResolvedValueOnce(conversationsInfoResponse())
      .mockResolvedValueOnce(searchResponse(slackMatch()));
    const adapter = new SlackMentionAdapter({
      log: { ...logger(), info } as unknown as Logger,
      markPolledNow: (sourceId, timestamp) => marked.push({ sourceId, timestamp }),
    });

    await expect(adapter.poll('T1', '1710000000.000000', new Set())).resolves.toEqual(expect.objectContaining({
      externalContext: expect.objectContaining({ kind: 'slack-thread' }),
    }));
    await expect(adapter.poll('T1', '1710000000.000000', new Set())).resolves.toBeNull();

    expect(marked).toEqual([{ sourceId: 'T1', timestamp: '1710000000.000002' }]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '1710000000.000002', reason: 'duplicate-in-process' }),
      'slack_polling_inflight_skip',
    );
  });

  it('falls back to legacy trigger shape and logs when Slack thread identity extraction fails', async () => {
    const warn = vi.fn();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(searchResponse(slackMatch({ channel: { name: 'general' } })))
      .mockResolvedValueOnce(conversationsInfoResponse());
    const adapter = new SlackMentionAdapter({
      log: { ...logger(), warn } as unknown as Logger,
    });

    const trigger = await adapter.poll('T1', '1710000000.000000', new Set());

    expect(trigger).toBeTruthy();
    expect(trigger?.externalContext).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '1710000000.000002', reason: 'missing-team-channel-or-thread-ts' }),
      'slack_thread_identity_extraction_failed',
    );
  });
});
