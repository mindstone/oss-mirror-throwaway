import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the adapter
// ---------------------------------------------------------------------------

const mockGetSlackWorkspaces = vi.fn();
const mockGetSlackWorkspaceDetails = vi.fn();
const mockRefreshSlackTokens = vi.fn();
const mockGetSettings = vi.fn();

vi.mock('../slackAuthService', () => ({
  getSlackWorkspaces: (...args: unknown[]) => mockGetSlackWorkspaces(...args),
  getSlackWorkspaceDetails: (...args: unknown[]) => mockGetSlackWorkspaceDetails(...args),
  refreshSlackTokens: (...args: unknown[]) => mockRefreshSlackTokens(...args),
}));

const mockCreatePublicBroadcastSafetyHook = vi.fn();
vi.mock('../inboundTriggers/publicBroadcastSafetyHook', () => ({
  createPublicBroadcastSafetyHook: (...args: unknown[]) => mockCreatePublicBroadcastSafetyHook(...args),
}));

vi.mock('@core/services/settingsStore/index', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

let SlackMentionAdapter: typeof import('../inboundTriggers/slackMentionAdapter').SlackMentionAdapter;

beforeAll(async () => {
  const mod = await import('../inboundTriggers/slackMentionAdapter');
  SlackMentionAdapter = mod.SlackMentionAdapter;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(teamId: string, teamName = 'Test Workspace') {
  return { teamId, teamName, authedAt: new Date().toISOString() };
}

function makeDetails(overrides: Record<string, unknown> = {}) {
  return {
    botToken: 'xoxb-bot-token',
    userToken: 'xoxp-user-token',
    botUserId: 'UBOT123',
    botUsername: 'rebel',
    authedUserId: 'UAUTHED1',
    ...overrides,
  };
}

/** Build a minimal InboundTrigger matching the adapter's shape. */
function makeTrigger(overrides: Record<string, unknown> = {}) {
  return {
    adapterId: 'slack-mention',
    sourceId: 'T1234',
    timestamp: '1700000001.000000',
    messageId: 'T1234:C001:1700000001.000000',
    summary: 'Slack mention in #general',
    context: {
      channelId: 'C001',
      channelName: 'general',
      messageTs: '1700000001.000000',
      threadTs: '1700000001.000000',
      userId: 'UAUTHED1',
      ownerUserId: 'UAUTHED1',
      username: 'alice',
      text: 'Hey <@UBOT123> do something',
      permalink: 'https://slack.com/archives/C001/p1700000001000000',
      botToken: 'xoxb-bot-token',
      isPublicChannel: true,
      ...overrides,
    },
  };
}

/** Minimal mock fetch response helper. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackMentionAdapter', () => {
  let adapter: InstanceType<typeof SlackMentionAdapter>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetSettings.mockReturnValue({
      experimental: {
        agentInstanceId: '7a14c8f2-6ab7-4974-b53a-c13bf9d0a585',
      },
    });
    adapter = new SlackMentionAdapter();
  });

  // -----------------------------------------------------------------------
  // isConfigured
  // -----------------------------------------------------------------------

  describe('isConfigured()', () => {
    it('returns true when at least one workspace has userToken and botUserId', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([makeWorkspace('T1')]);
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
      expect(await adapter.isConfigured()).toBe(true);
    });

    it('returns false when no workspaces', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([]);
      expect(await adapter.isConfigured()).toBe(false);
    });

    it('returns false when workspace lacks userToken', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([makeWorkspace('T1')]);
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails({ userToken: undefined }));
      expect(await adapter.isConfigured()).toBe(false);
    });

    it('returns false when workspace lacks botUserId', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([makeWorkspace('T1')]);
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails({ botUserId: undefined }));
      expect(await adapter.isConfigured()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // checkPrerequisites
  // -----------------------------------------------------------------------

  describe('checkPrerequisites()', () => {
    it('returns ready:true when all workspaces have userToken and authedUserId', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([makeWorkspace('T1')]);
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
      const result = await adapter.checkPrerequisites();
      expect(result).toEqual({ ready: true, reason: null });
    });

    it('returns ready:false with reason when no workspaces', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([]);
      const result = await adapter.checkPrerequisites();
      expect(result.ready).toBe(false);
      expect(result.reason).toContain('No Slack workspace connected');
    });

    it('returns ready:false when workspace missing userToken', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([makeWorkspace('T1')]);
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails({ userToken: undefined }));
      const result = await adapter.checkPrerequisites();
      expect(result.ready).toBe(false);
      expect(result.reason).toContain('missing search permissions');
    });

    it('returns ready:false when workspace missing authedUserId', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([makeWorkspace('T1')]);
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails({ authedUserId: undefined }));
      const result = await adapter.checkPrerequisites();
      expect(result.ready).toBe(false);
      expect(result.reason).toContain('refreshed');
    });
  });

  // -----------------------------------------------------------------------
  // getSourceIds
  // -----------------------------------------------------------------------

  describe('getSourceIds()', () => {
    it('returns teamIds of configured workspaces only', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([
        makeWorkspace('T1'),
        makeWorkspace('T2'),
        makeWorkspace('T3'),
      ]);
      mockGetSlackWorkspaceDetails
        .mockResolvedValueOnce(makeDetails()) // T1 fully configured
        .mockResolvedValueOnce(makeDetails({ userToken: undefined })) // T2 missing userToken
        .mockResolvedValueOnce(makeDetails()); // T3 fully configured

      const ids = await adapter.getSourceIds();
      expect(ids).toEqual(['T1', 'T3']);
    });

    it('excludes workspaces without botUserId', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([makeWorkspace('T1')]);
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails({ botUserId: undefined }));
      const ids = await adapter.getSourceIds();
      expect(ids).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // poll
  // -----------------------------------------------------------------------

  describe('poll()', () => {
    const sourceId = 'T1234';
    const emptyProcessed = new Set<string>();

    it('returns null when workspace details not found', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(null);
      expect(await adapter.poll(sourceId, null, emptyProcessed)).toBeNull();
    });

    it('returns null when no userToken', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails({ userToken: undefined }));
      expect(await adapter.poll(sourceId, null, emptyProcessed)).toBeNull();
    });

    it('returns null when no botUserId', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails({ botUserId: undefined }));
      expect(await adapter.poll(sourceId, null, emptyProcessed)).toBeNull();
    });

    it('returns null when search returns no matches', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ ok: true, messages: { matches: [] } })
      );

      expect(await adapter.poll(sourceId, null, emptyProcessed)).toBeNull();
      fetchSpy.mockRestore();
    });

    it('filters out self-mentions (bot mentioning itself)', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
      const match = {
        ts: '1700000010.000000',
        text: 'I mentioned myself <@UBOT123>',
        channel: { id: 'C001', name: 'general' },
        user: 'UBOT123', // same as botUserId
        username: 'rebel',
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ ok: true, messages: { matches: [match] } })
      );

      expect(await adapter.poll(sourceId, '1700000000.000000', emptyProcessed)).toBeNull();
      fetchSpy.mockRestore();
    });

    it('filters out mentions from non-authenticated users', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails({ authedUserId: 'UAUTHED1' }));
      const match = {
        ts: '1700000010.000000',
        text: 'Hey <@UBOT123>',
        channel: { id: 'C001', name: 'general' },
        user: 'UOTHER', // not the authed user
        username: 'bob',
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ ok: true, messages: { matches: [match] } })
      );

      expect(await adapter.poll(sourceId, '1700000000.000000', emptyProcessed)).toBeNull();
      fetchSpy.mockRestore();
    });

    it('filters out already-processed messages (dedup)', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
      const match = {
        ts: '1700000010.000000',
        text: 'Hey <@UBOT123>',
        channel: { id: 'C001', name: 'general' },
        user: 'UAUTHED1',
        username: 'alice',
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ ok: true, messages: { matches: [match] } })
      );

      const processed = new Set(['T1234:C001:1700000010.000000']);
      expect(await adapter.poll(sourceId, '1700000000.000000', processed)).toBeNull();
      fetchSpy.mockRestore();
    });

    it('filters out messages before lastSeenTs', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
      const match = {
        ts: '1700000005.000000', // BEFORE lastSeenTs
        text: 'Hey <@UBOT123>',
        channel: { id: 'C001', name: 'general' },
        user: 'UAUTHED1',
        username: 'alice',
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ ok: true, messages: { matches: [match] } })
      );

      expect(await adapter.poll(sourceId, '1700000010.000000', emptyProcessed)).toBeNull();
      fetchSpy.mockRestore();
    });

    it('returns oldest unprocessed trigger', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());

      const matches = [
        {
          ts: '1700000020.000000',
          text: 'Second <@UBOT123>',
          channel: { id: 'C001', name: 'general' },
          user: 'UAUTHED1',
          username: 'alice',
        },
        {
          ts: '1700000010.000000',
          text: 'First <@UBOT123>',
          channel: { id: 'C001', name: 'general' },
          user: 'UAUTHED1',
          username: 'alice',
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // search.messages
        .mockResolvedValueOnce(jsonResponse({ ok: true, messages: { matches } }))
        // conversations.info
        .mockResolvedValueOnce(jsonResponse({
          ok: true,
          channel: { is_private: false, is_im: false, is_mpim: false, is_group: false },
        }));

      const trigger = await adapter.poll(sourceId, '1700000000.000000', emptyProcessed);
      expect(trigger).not.toBeNull();
      expect(trigger!.timestamp).toBe('1700000010.000000'); // oldest first
      expect(trigger!.context.text).toBe('First <@UBOT123>');
      fetchSpy.mockRestore();
    });

    it('sets isPublicChannel based on conversations.info', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
      const match = {
        ts: '1700000010.000000',
        text: 'Hey <@UBOT123>',
        channel: { id: 'C001', name: 'secret' },
        user: 'UAUTHED1',
        username: 'alice',
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ ok: true, messages: { matches: [match] } }))
        .mockResolvedValueOnce(jsonResponse({
          ok: true,
          channel: { is_private: true },
        }));

      const trigger = await adapter.poll(sourceId, '1700000000.000000', emptyProcessed);
      expect(trigger).not.toBeNull();
      expect(trigger!.context.isPublicChannel).toBe(false);
      fetchSpy.mockRestore();
    });

    it('defaults to isPublicChannel=true on conversations.info failure', async () => {
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());
      const match = {
        ts: '1700000010.000000',
        text: 'Hey <@UBOT123>',
        channel: { id: 'C001', name: 'general' },
        user: 'UAUTHED1',
        username: 'alice',
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ ok: true, messages: { matches: [match] } }))
        .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'channel_not_found' }));

      const trigger = await adapter.poll(sourceId, '1700000000.000000', emptyProcessed);
      expect(trigger).not.toBeNull();
      expect(trigger!.context.isPublicChannel).toBe(true);
      fetchSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // buildPrompt
  // -----------------------------------------------------------------------

  describe('buildPrompt()', () => {
    it('includes channel name and username', () => {
      const trigger = makeTrigger();
      const prompt = adapter.buildPrompt(trigger);
      expect(prompt).toContain('#general');
      expect(prompt).toContain('alice');
    });

    it('includes public channel privacy notice for public channels', () => {
      const trigger = makeTrigger({ isPublicChannel: true });
      const prompt = adapter.buildPrompt(trigger);
      expect(prompt).toContain('PUBLIC CHANNEL PRIVACY NOTICE');
    });

    it('does NOT include privacy notice for private channels', () => {
      const trigger = makeTrigger({ isPublicChannel: false });
      const prompt = adapter.buildPrompt(trigger);
      expect(prompt).not.toContain('PUBLIC CHANNEL PRIVACY NOTICE');
    });

    it('sanitizes message text (XML escaping)', () => {
      const trigger = makeTrigger({ text: 'Hello <script>alert("xss")</script> & stuff' });
      const prompt = adapter.buildPrompt(trigger);
      expect(prompt).toContain('&lt;script&gt;');
      expect(prompt).toContain('&amp;');
      expect(prompt).not.toContain('<script>');
    });

    it('includes channel ID and thread TS', () => {
      const trigger = makeTrigger({ channelId: 'C999', threadTs: '1700000001.000000' });
      const prompt = adapter.buildPrompt(trigger);
      expect(prompt).toContain('Channel ID: C999');
      expect(prompt).toContain('Thread TS: 1700000001.000000');
    });
  });

  // -----------------------------------------------------------------------
  // buildDisplayMessage
  // -----------------------------------------------------------------------

  describe('buildDisplayMessage()', () => {
    it('formats with username and channel name', () => {
      const trigger = makeTrigger();
      const msg = adapter.buildDisplayMessage(trigger);
      expect(msg).toContain('@alice');
      expect(msg).toContain('#general');
    });

    it('replaces @-mention markup with @Rebel', () => {
      const trigger = makeTrigger({ text: 'Hey <@UBOT123> can you help?' });
      const msg = adapter.buildDisplayMessage(trigger);
      expect(msg).toContain('@Rebel');
      expect(msg).not.toContain('<@UBOT123>');
    });
  });

  // -----------------------------------------------------------------------
  // postAcknowledgment
  // -----------------------------------------------------------------------

  describe('postAcknowledgment()', () => {
    it('posts "On it!" to correct channel and thread', async () => {
      const trigger = makeTrigger({ channelId: 'C001', threadTs: '1700000001.000000', botToken: 'xoxb-tok' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ ok: true })
      );

      await adapter.postAcknowledgment(trigger);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://slack.com/api/chat.postMessage');
      const body = JSON.parse(opts.body as string);
      expect(body.text).toBe('On it!');
      expect(body.channel).toBe('C001');
      expect(body.thread_ts).toBe('1700000001.000000');
      expect(body.metadata).toEqual({
        event_type: 'rebel_thread_open',
        event_payload: {
          agentInstanceId: '7a14c8f2-6ab7-4974-b53a-c13bf9d0a585',
          ownerUserId: 'UAUTHED1',
          threadScope: '1700000001.000000',
        },
      });
      fetchSpy.mockRestore();
    });

    it('uses dm_reply metadata intent for DM channel acknowledgments', async () => {
      const trigger = makeTrigger({ channelId: 'D001', threadTs: '1700000001.000000', botToken: 'xoxb-tok' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

      await adapter.postAcknowledgment(trigger);

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.metadata).toMatchObject({
        event_type: 'rebel_dm_reply',
      });
      fetchSpy.mockRestore();
    });

    it('ships without metadata when agentInstanceId is missing', async () => {
      mockGetSettings.mockReturnValue({ experimental: { agentInstanceId: '  ' } });
      const trigger = makeTrigger();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

      await adapter.postAcknowledgment(trigger);

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body.metadata).toBeUndefined();
      fetchSpy.mockRestore();
    });

    it('handles API errors gracefully (no throw)', async () => {
      const trigger = makeTrigger();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ ok: false, error: 'channel_not_found' })
      );

      // Should not throw
      await expect(adapter.postAcknowledgment(trigger)).resolves.toBeUndefined();
      fetchSpy.mockRestore();
    });

    it('handles network errors gracefully (no throw)', async () => {
      const trigger = makeTrigger();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      await expect(adapter.postAcknowledgment(trigger)).resolves.toBeUndefined();
      fetchSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // createSafetyHook
  // -----------------------------------------------------------------------

  describe('createSafetyHook()', () => {
    const settings = { behindTheScenesModel: 'claude-3-haiku' } as import('@shared/types').AppSettings;

    it('returns hook for public channels', () => {
      const hookFn = vi.fn();
      mockCreatePublicBroadcastSafetyHook.mockReturnValue(hookFn);

      const trigger = makeTrigger({ isPublicChannel: true });
      const result = adapter.createSafetyHook(trigger, settings);

      expect(mockCreatePublicBroadcastSafetyHook).toHaveBeenCalledWith(
        true,
        settings,
        undefined,
        undefined,
        undefined,
        settings.behindTheScenesModel
      );
      expect(result).toBe(hookFn);
    });

    it('returns null for private channels', () => {
      mockCreatePublicBroadcastSafetyHook.mockReturnValue(null);

      const trigger = makeTrigger({ isPublicChannel: false });
      const result = adapter.createSafetyHook(trigger, settings);

      expect(mockCreatePublicBroadcastSafetyHook).toHaveBeenCalledWith(
        false,
        settings,
        undefined,
        undefined,
        undefined,
        settings.behindTheScenesModel
      );
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getSlackChannelNameFromCache
  // -----------------------------------------------------------------------

  describe('getSlackChannelNameFromCache()', () => {
    let getSlackChannelNameFromCache: typeof import('../inboundTriggers/slackMentionAdapter').getSlackChannelNameFromCache;

    beforeAll(async () => {
      const mod = await import('../inboundTriggers/slackMentionAdapter');
      getSlackChannelNameFromCache = mod.getSlackChannelNameFromCache;
    });

    it('returns undefined for unknown channel IDs', () => {
      expect(getSlackChannelNameFromCache('C_UNKNOWN')).toBeUndefined();
    });

    it('returns cached channel name after poll populates it', async () => {
      mockGetSlackWorkspaces.mockResolvedValue([makeWorkspace('T1')]);
      mockGetSlackWorkspaceDetails.mockResolvedValue(makeDetails());

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse({
            ok: true,
            messages: {
              matches: [
                {
                  ts: '1700000001.000000',
                  text: 'Hey <@UBOT123> do something',
                  channel: { id: 'C_CACHED', name: 'cached-channel' },
                  user: 'UAUTHED1',
                  username: 'alice',
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ ok: true, channel: { is_private: false, name: 'cached-channel' } }),
        );

      await adapter.poll('T1', null, new Set());
      expect(getSlackChannelNameFromCache('C_CACHED')).toBe('cached-channel');
    });
  });
});
