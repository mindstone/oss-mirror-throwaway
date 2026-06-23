import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  __test,
  formatThreadHistoryDigest,
  SLACK_USER_CACHE_TTL_MS,
  SLACK_THREAD_HISTORY_PREFETCH_LIMIT,
  SlackThreadAdapter,
  type SlackWorkspaceStoreLike,
} from '../slackThreadAdapter';
import { WebhookAuthError } from '../../externalConversationAdapter';
import { setStoreFactory, type StoreFactoryOptions } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';
import * as settingsStore from '@core/services/settingsStore/index';
import { deriveScopeKey, type SlackThreadContext } from '../../externalContext';
import type { AgentResponse } from '../../types';
import type { Logger } from '@core/logger';
import type { InboundAuthorPolicy } from '@rebel/shared';
import {
  SLACK_WORKSPACE_CHANGED_CHANNEL,
  SLACK_WORKSPACE_DISCONNECTED_CHANNEL,
  SlackWorkspaceChangedSchema,
  SlackWorkspaceDisconnectedSchema,
} from '@shared/ipc/channels/slack';

describe('SlackThreadAdapter', () => {
  const signingSecret = 'test_secret';
  type WorkspaceRecord = NonNullable<ReturnType<SlackWorkspaceStoreLike['get']>>;
  let workspace: WorkspaceRecord | null;
  let broadcasts: Array<{ channel: string; payload: unknown }>;
  let logLines: string[];
  let getSettingsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
    setStoreFactory(<T extends Record<string, unknown>>(opts: StoreFactoryOptions<T>) => new TestMemoryStore(opts) as unknown as KeyValueStore<T>);
    getSettingsSpy = vi.spyOn(settingsStore, 'getSettings').mockReturnValue({
      experimental: {
        agentInstanceId: '7a14c8f2-6ab7-4974-b53a-c13bf9d0a585',
      },
    } as any);
    workspace = connectedWorkspace();
    broadcasts = [];
    logLines = [];
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function connectedWorkspace(): WorkspaceRecord {
    return {
      teamId: 'T123',
      teamName: 'Acme',
      botUserId: 'UBOT',
      botToken: 'xoxb-test-token',
      authedUserId: 'U_OWNER_1',
      installedAt: Date.now(),
      status: 'connected' as const,
    };
  }

  function workspaceStore(): SlackWorkspaceStoreLike {
    return {
      get: () => workspace,
      set: (record) => { workspace = record; },
      updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
      updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
      clear: () => { workspace = null; },
    };
  }

  function mockLogger(): Logger {
    const logger = {
      info: (...args: unknown[]) => logLines.push(JSON.stringify(args)),
      warn: (...args: unknown[]) => logLines.push(JSON.stringify(args)),
      error: (...args: unknown[]) => logLines.push(JSON.stringify(args)),
      debug: (...args: unknown[]) => logLines.push(JSON.stringify(args)),
    };
    return logger as unknown as Logger;
  }

  function logEntriesFor(event: string): Array<Record<string, unknown>> {
    return logLines.flatMap((line) => {
      const parsed = JSON.parse(line) as unknown;
      if (!Array.isArray(parsed)) return [];
      const [data] = parsed;
      if (typeof data !== 'object' || data === null) return [];
      const entry = data as Record<string, unknown>;
      return entry['event'] === event ? [entry] : [];
    });
  }

  function adapter(fetchImpl?: typeof fetch): SlackThreadAdapter {
    return new SlackThreadAdapter({
      signingSecret,
      workspaceStore: workspaceStore(),
      fetchImpl,
      log: mockLogger(),
      broadcast: {
        sendToAllWindows: (channel, payload) => broadcasts.push({ channel, payload }),
        sendToFocusedWindow: (channel, payload) => broadcasts.push({ channel, payload }),
      },
    });
  }

  function createSignature(timestamp: number, body: string): string {
    const sigBasestring = `v0:${timestamp}:${body}`;
    return `v0=${crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex')}`;
  }

  function mockHeaders(timestamp: number, signature: string) {
    return {
      get(name: string) {
        if (name === 'x-slack-request-timestamp') return timestamp.toString();
        if (name === 'x-slack-signature') return signature;
        return null;
      },
    };
  }

  function signedPayload(payload: unknown) {
    const body = Buffer.from(JSON.stringify(payload));
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createSignature(timestamp, body.toString('utf8'));
    return { body, headers: mockHeaders(timestamp, signature) };
  }

  function assistantMessage(text: string): AgentResponse {
    return { type: 'assistant', message: { content: [{ type: 'text', text }] } } as AgentResponse;
  }

  function assistantTextBlocks(...blocks: string[]): AgentResponse {
    return { type: 'assistant', message: { content: blocks.map((text) => ({ type: 'text', text })) } } as AgentResponse;
  }

  function slackResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: () => Promise.resolve(body),
    } as Response;
  }

  it('constructor allows missing static signing secret for BYOK-only deployments', () => {
    expect(() => new SlackThreadAdapter({ signingSecret: null, workspaceStore: workspaceStore() })).not.toThrow();
  });

  it('verifyInbound throws SIGNING_SECRET_UNAVAILABLE when the provider returns null', async () => {
    const payload = { event: { channel: 'C123', ts: '123.456', user: 'U123' }, team_id: 'T123', event_id: 'E-no-secret' };
    const body = Buffer.from(JSON.stringify(payload));
    const timestamp = Math.floor(Date.now() / 1000);
    const slackAdapter = new SlackThreadAdapter({
      signingSecret: null,
      signingSecretProvider: async () => null,
      workspaceStore: workspaceStore(),
      log: mockLogger(),
    });

    await expect(slackAdapter.verifyInbound(body, mockHeaders(timestamp, 'v0=irrelevant'))).rejects.toMatchObject({
      code: 'SIGNING_SECRET_UNAVAILABLE',
    });
  });

  it('replayInboundFromTrustedLog signs replay payloads with the dynamic signingSecretProvider', async () => {
    workspace = { ...connectedWorkspace(), provisionMode: 'byok' };
    const byokSecret = 'byok_replay_secret';
    const payload = { event: { channel: 'C123', ts: '123.456', user: 'U123' }, team_id: 'T123', event_id: 'E-replay-provider' };
    const body = Buffer.from(JSON.stringify(payload));
    const provider = vi.fn().mockResolvedValue(byokSecret);
    const slackAdapter = new SlackThreadAdapter({
      signingSecret: null,
      signingSecretProvider: provider,
      workspaceStore: workspaceStore(),
      log: mockLogger(),
    });

    await expect(slackAdapter.replayInboundFromTrustedLog(body, Date.now())).resolves.toMatchObject({
      kind: 'slack-thread',
      identity: { teamId: 'T123' },
    });
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ provisionMode: 'byok' }), body);
  });

  it('replayInboundFromTrustedLog allows trusted durable replay of an already processed event', async () => {
    const payload = { event: { channel: 'C123', ts: '123.456', user: 'U123' }, team_id: 'T123', event_id: 'E-trusted-replay' };
    const { body, headers } = signedPayload(payload);
    const slackAdapter = adapter();

    await slackAdapter.verifyInbound(body, headers);

    await expect(slackAdapter.replayInboundFromTrustedLog(body, Date.now())).resolves.toMatchObject({
      kind: 'slack-thread',
      identity: { teamId: 'T123', channelId: 'C123' },
    });
  });

  it('public replayInbound still rejects already processed events', async () => {
    const payload = { event: { channel: 'C123', ts: '123.456', user: 'U123' }, team_id: 'T123', event_id: 'E-public-replay' };
    const { body, headers } = signedPayload(payload);
    const slackAdapter = adapter();

    await slackAdapter.verifyInbound(body, headers);

    await expect(slackAdapter.replayInbound(body, headers)).rejects.toMatchObject({
      code: 'REPLAY',
    });
  });

  it('HMAC verify passes for valid signature', async () => {
    const payload = { event: { channel: 'C123', ts: '123.456', user: 'U123' }, team_id: 'T123', event_id: 'E1' };
    const { body, headers } = signedPayload(payload);

    const ctx = await adapter().verifyInbound(body, headers);
    expect(ctx.kind).toBe('slack-thread');
    if (ctx.kind !== 'slack-thread') throw new Error('expected context');
    expect(ctx.identity.teamId).toBe('T123');
    expect(ctx.identity.channelId).toBe('C123');
    expect(ctx.identity.threadTs).toBe('123.456');
  });

  it('verifyInbound accepts team_id nested on event when top-level team_id is absent', async () => {
    workspace = { ...connectedWorkspace(), teamId: 'T-event-only' };
    const payload = { event: { team_id: 'T-event-only', channel: 'C123', ts: '123.456', user: 'U123' }, event_id: 'E-event-team' };
    const { body, headers } = signedPayload(payload);

    await expect(adapter().verifyInbound(body, headers)).resolves.toMatchObject({
      kind: 'slack-thread',
      identity: { teamId: 'T-event-only', channelId: 'C123' },
    });
  });

  it('HMAC verify fails with WebhookAuthError on signature mismatch', async () => {
    const body = Buffer.from(JSON.stringify({ event: { channel: 'C123' }, team_id: 'T123' }));
    const timestamp = Math.floor(Date.now() / 1000);
    await expect(adapter().verifyInbound(body, mockHeaders(timestamp, 'v0=badsignature'))).rejects.toThrow(WebhookAuthError);
  });

  it('verifyInbound uses BYOK signing secret provider instead of managed env secret', async () => {
    workspace = { ...connectedWorkspace(), provisionMode: 'byok' };
    const byokSecret = 'byok_signing_secret';
    const payload = { event: { channel: 'C123', ts: '123.456', user: 'U123' }, team_id: 'T123', event_id: 'E-byok' };
    const body = Buffer.from(JSON.stringify(payload));
    const timestamp = Math.floor(Date.now() / 1000);
    const byokSignature = `v0=${crypto
      .createHmac('sha256', byokSecret)
      .update(`v0:${timestamp}:${body.toString('utf8')}`)
      .digest('hex')}`;
    const managedSignature = createSignature(timestamp, body.toString('utf8'));
    const slackAdapter = new SlackThreadAdapter({
      signingSecret,
      signingSecretProvider: async (currentWorkspace) => (
        currentWorkspace?.provisionMode === 'byok' ? byokSecret : signingSecret
      ),
      workspaceStore: workspaceStore(),
      log: mockLogger(),
    });

    await expect(slackAdapter.verifyInbound(body, mockHeaders(timestamp, byokSignature))).resolves.toMatchObject({
      kind: 'slack-thread',
      identity: { teamId: 'T123' },
    });
    await expect(slackAdapter.verifyInbound(
      Buffer.from(JSON.stringify({ ...payload, event_id: 'E-byok-managed-secret' })),
      mockHeaders(timestamp, managedSignature),
    )).rejects.toThrow(WebhookAuthError);
  });

  it('Enforces 5-minute timestamp window', async () => {
    const body = Buffer.from(JSON.stringify({ event: { channel: 'C123' }, team_id: 'T123' }));
    const staleTimestamp = Math.floor(Date.now() / 1000) - 6 * 60;
    const signature = createSignature(staleTimestamp, body.toString('utf8'));
    await expect(adapter().verifyInbound(body, mockHeaders(staleTimestamp, signature))).rejects.toThrowError(/outside of 5-minute window/);
  });

  it('Rejects replays based on event_id', async () => {
    const payload = { event: { channel: 'C123', ts: '123.456', user: 'U123' }, team_id: 'T123', event_id: 'E1' };
    const { body, headers } = signedPayload(payload);
    const slackAdapter = adapter();
    await slackAdapter.verifyInbound(body, headers);
    await expect(slackAdapter.verifyInbound(body, headers)).rejects.toThrowError(/Replay detected/);
  });

  it('verifyInbound rejects when workspace not connected', async () => {
    workspace = null;
    const { body, headers } = signedPayload({ team_id: 'T123', event_id: 'E2', event: { type: 'message', channel: 'C1', ts: '1', user: 'U1' } });
    await expect(adapter().verifyInbound(body, headers)).resolves.toEqual({ kind: 'workspace-not-connected' });
  });

  it('verifyInbound rejects bot self-mention and emits structured log', async () => {
    const { body, headers } = signedPayload({ team_id: 'T123', event_id: 'E3', event: { type: 'message', channel: 'C1', ts: '1', user: 'UBOT' } });
    await expect(adapter().verifyInbound(body, headers)).resolves.toEqual({ kind: 'self-mention-ignored' });
    expect(logLines.join('\n')).toContain('self-mention');
  });

  it('verifyInbound rejects message.im without event.channel', async () => {
    const { body, headers } = signedPayload({ team_id: 'T123', event_id: 'E4', event: { type: 'message', channel_type: 'im', ts: '1', user: 'U1' } });
    await expect(adapter().verifyInbound(body, headers)).resolves.toEqual({ kind: 'signature-invalid', reason: 'missing_dm_channel' });
  });

  it('formatInitialPrompt wraps with untrusted-input prompt', () => {
    const prompt = adapter().formatInitialPrompt(ctx(), '<@UBOT> hello <script>', 'im');
    expect(prompt).toContain('<slack_message>');
    expect(prompt).toContain('&lt;@UBOT&gt; hello &lt;script&gt;');
  });

  it('formatInitialPrompt explicitly requires reply_to_slack_thread tool use', () => {
    const prompt = adapter().formatInitialPrompt(ctx(), 'hello', 'im');
    expect(prompt).toContain('You MUST call the tool');
    expect(prompt).toContain('reply_to_slack_thread');
  });

  it('formatInitialPrompt includes public-channel safety prompt for public channels', () => {
    expect(adapter().formatInitialPrompt(ctx(), 'hello', 'channel')).toContain('PUBLIC CHANNEL PRIVACY NOTICE');
  });

  it('formatInitialPrompt does not include public-channel safety prompt for DMs/private groups', () => {
    expect(adapter().formatInitialPrompt(ctx(), 'hello', 'im')).not.toContain('PUBLIC CHANNEL PRIVACY NOTICE');
    expect(adapter().formatInitialPrompt(ctx(), 'hello', 'group')).not.toContain('PUBLIC CHANNEL PRIVACY NOTICE');
  });

  it('formatInitialPrompt object-form respects metadata.channelType for DM contexts', () => {
    const dmContext: SlackThreadContext = {
      kind: 'slack-thread',
      identity: { teamId: 'T123', channelId: 'D1', threadTs: '100.000' },
      metadata: { userId: 'U1', channelType: 'im' },
    };
    const prompt = adapter().formatInitialPrompt({ context: dmContext, userText: 'hi' });
    expect(prompt).not.toContain('PUBLIC CHANNEL PRIVACY NOTICE');
  });

  it('formatInitialPrompt object-form infers DM from channelId D-prefix when metadata.channelType missing', () => {
    const dmContext: SlackThreadContext = {
      kind: 'slack-thread',
      identity: { teamId: 'T123', channelId: 'D1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    };
    const prompt = adapter().formatInitialPrompt({ context: dmContext, userText: 'hi' });
    expect(prompt).not.toContain('PUBLIC CHANNEL PRIVACY NOTICE');
  });

  it('formatInitialPrompt object-form treats public channel C-prefix as public when metadata.channelType missing', () => {
    const publicContext: SlackThreadContext = {
      kind: 'slack-thread',
      identity: { teamId: 'T123', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    };
    const prompt = adapter().formatInitialPrompt({ context: publicContext, userText: 'hi' });
    expect(prompt).toContain('PUBLIC CHANNEL PRIVACY NOTICE');
  });

  it('slack_get_thread_history calls conversations.replies and returns sanitized list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({
      ok: true,
      messages: [
        { ts: '1', user: 'U1', text: 'hello', avatar: 'drop', files: [{ id: 'F1' }] },
        { ts: '2', user: 'U2', text: 'world' },
      ],
    }));
    const historyTool = adapter(fetchImpl).getContextTools(ctx()).find((tool) => tool.name === 'slack_get_thread_history');
    const result = await (historyTool?.execute as (input: unknown) => Promise<unknown>)({ limit: 2 });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('conversations.replies'), expect.objectContaining({
      headers: { Authorization: 'Bearer xoxb-test-token' },
    }));
    expect(fetchImpl.mock.calls[0][0]).toContain('channel=C1');
    expect(fetchImpl.mock.calls[0][0]).toContain('ts=100.000');
    expect(result).toEqual([
      { ts: '1', author: { kind: 'human', normalizedAuthorId: 'U1' }, text: 'hello' },
      { ts: '2', author: { kind: 'human', normalizedAuthorId: 'U2' }, text: 'world' },
    ]);
  });

  it('slack_post_in_thread tool attaches outbound metadata when posting', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    const tool = adapter(fetchImpl).getContextTools(ctx()).find((entry) => entry.name === 'slack_post_in_thread');
    await (tool?.execute as (input: unknown) => Promise<unknown>)({ text: 'tool hello' });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.metadata).toEqual({
      event_type: 'rebel_thread_reply',
      event_payload: {
        agentInstanceId: '7a14c8f2-6ab7-4974-b53a-c13bf9d0a585',
        ownerUserId: 'U_OWNER_1',
        threadScope: '100.000',
      },
    });
  });

  it('slack_get_thread_history throws structured error when workspace not connected', async () => {
    workspace = null;
    const historyTool = adapter().getContextTools(ctx()).find((tool) => tool.name === 'slack_get_thread_history');
    await expect((historyTool?.execute as (input: unknown) => Promise<unknown>)({ limit: 1 })).rejects.toThrow('No Slack workspace connected');
  });

  it('deliverResponse short reply sends one chat.postMessage with Authorization header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    const result = await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
    expect(result.status).toBe('delivered');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://slack.com/api/chat.postMessage', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer xoxb-test-token' }),
    }));
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.metadata).toEqual({
      event_type: 'rebel_thread_reply',
      event_payload: {
        agentInstanceId: '7a14c8f2-6ab7-4974-b53a-c13bf9d0a585',
        ownerUserId: 'U_OWNER_1',
        threadScope: '100.000',
      },
    });
  });

  it('deliverResponse uses dm_reply metadata intent for DM channels', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    const dmContext: SlackThreadContext = {
      ...ctx(),
      identity: {
        ...ctx().identity,
        channelId: 'D123',
      },
    };

    await adapter(fetchImpl).deliverResponse({
      context: dmContext,
      conversationId: 'c1',
      message: assistantMessage('hello'),
    });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.metadata).toMatchObject({
      event_type: 'rebel_dm_reply',
    });
  });

  it('deliverResponse ships without metadata when agentInstanceId is unavailable', async () => {
    getSettingsSpy.mockReturnValue({ experimental: { agentInstanceId: '   ' } } as any);
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));

    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.metadata).toBeUndefined();
    expect(logLines.join('\n')).toContain('slack_outbound_metadata_missing_agent_instance_id');
  });

  it('successful delivery emits attempted then succeeded telemetry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });

    expect(logEntriesFor('slack_delivery_attempted')[0]).toMatchObject({
      conversationId: 'c1',
      attempt: 1,
      chunksSent: 0,
      chunkChars: 5,
    });
    expect(logEntriesFor('slack_delivery_succeeded')[0]).toMatchObject({
      conversationId: 'c1',
      attempt: 1,
      chunkBytes: 5,
    });
    expect(Number(logEntriesFor('slack_delivery_succeeded')[0]?.durationMs)).toBeGreaterThan(0);
    expect(logEntriesFor('slack_delivery_completed')[0]).toMatchObject({
      conversationId: 'c1',
      outcome: 'success',
      attempts: 1,
    });
    expect(Number(logEntriesFor('slack_delivery_completed')[0]?.durationMs)).toBeGreaterThan(0);
    expect(JSON.stringify(logEntriesFor('slack_delivery_completed')[0])).toContain('teamIdHash');
    expect(JSON.stringify(logEntriesFor('slack_delivery_completed')[0])).not.toContain('"teamId"');
    expect(logLines.findIndex((line) => line.includes('slack_delivery_attempted')))
      .toBeLessThan(logLines.findIndex((line) => line.includes('slack_delivery_succeeded')));
  });

  it('deliverResponse 7000-char reply sends 2 chunked posts without truncation footer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('a'.repeat(7000)) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as { text: string });
    expect(bodies.every((body) => !body.text.includes('Reply truncated'))).toBe(true);
  });

  it('deliverResponse 12001-char reply sends 4 chunked posts without truncation footer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('a'.repeat(12001)) });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as { text: string });
    expect(bodies.every((body) => !body.text.includes('Reply truncated'))).toBe(true);
    expect(bodies.map((body) => body.text).join('')).toHaveLength(12001);
  });

  it('deliverResponse 25000-char reply sends 5 chunked posts and truncates last', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('a'.repeat(25000)) });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const lastBody = JSON.parse((fetchImpl.mock.calls[4][1] as RequestInit).body as string) as { text: string };
    expect(lastBody.text).toContain('Reply truncated');
  });

  it.each(['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive'] as const)(
    'deliverResponse %s maps to reconnect status and ordered workspace broadcasts',
    async (errorCode) => {
      const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: errorCode }));
      const result = await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
      expect(result).toMatchObject({ status: 'permanent-failure', userActionable: true });
      expect(workspace?.status).toBe('needs_reconnect');
      expect(broadcasts).toHaveLength(2);
      expect(broadcasts[0]).toMatchObject({
        channel: SLACK_WORKSPACE_CHANGED_CHANNEL,
        payload: { teamId: 'T123', teamName: 'Acme', status: 'needs_reconnect', occurredAt: Date.now() },
      });
      expect(broadcasts[1]).toMatchObject({
        channel: SLACK_WORKSPACE_DISCONNECTED_CHANNEL,
        payload: {
          teamId: 'T123',
          reason: errorCode === 'token_revoked' ? 'tokens_revoked' : 'invalid_auth',
          occurredAt: Date.now(),
        },
      });
      expect(SlackWorkspaceChangedSchema.safeParse(broadcasts[0].payload).success).toBe(true);
      expect(SlackWorkspaceDisconnectedSchema.safeParse(broadcasts[1].payload).success).toBe(true);
    },
  );

  it('deliverResponse tokens_revoked maps to tokens_revoked workspace-disconnected reason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: 'tokens_revoked' }));
    const result = await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
    expect(result).toMatchObject({ status: 'permanent-failure', userActionable: true });
    expect(workspace?.status).toBe('needs_reconnect');
    expect(broadcasts.map((broadcast) => broadcast.channel)).toEqual([
      SLACK_WORKSPACE_CHANGED_CHANNEL,
      SLACK_WORKSPACE_DISCONNECTED_CHANNEL,
    ]);
    expect(broadcasts[1].payload).toMatchObject({ reason: 'tokens_revoked' });
  });

  it('tokens_revoked permanent delivery emits user-actionable failure telemetry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: 'tokens_revoked' }));
    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });

    expect(logEntriesFor('slack_delivery_failed_permanent')[0]).toMatchObject({
      conversationId: 'c1',
      attempt: 1,
      reason: 'tokens_revoked',
      userActionable: true,
    });
    expect(logEntriesFor('slack_delivery_completed')[0]).toMatchObject({
      conversationId: 'c1',
      outcome: 'failed_permanent',
      attempts: 1,
    });
  });

  it.each(['channel_not_found', 'not_in_channel', 'is_archived'] as const)(
    'deliverResponse %s maps to non-actionable permanent failure with status unchanged',
    async (errorCode) => {
      const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: errorCode }));
      const result = await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
      expect(result).toMatchObject({ status: 'permanent-failure', userActionable: false });
      expect(workspace?.status).toBe('connected');
      expect(broadcasts).toEqual([]);
    },
  );

  it('deliverResponse unknown Slack error maps to transient retryAfterSec=5', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: 'something_new' }));
    const result = await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
    expect(result).toMatchObject({ status: 'transient-failure', retryAfterSec: 5 });
  });

  it('deliverResponse rate_limited maps to retryAfterSec', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: 'rate_limited' }, 200, { 'retry-after': '5' }));
    const result = await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
    expect(result).toMatchObject({ status: 'transient-failure', retryAfterSec: 5 });
  });

  it('broadcasts external-delivery:failed when Slack delivery retries exhaust', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: 'temporary_glitch' }));
    const slackAdapter = adapter(fetchImpl);

    const result = await slackAdapter.deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
    expect(result).toMatchObject({ status: 'transient-failure' });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(30000);

    const failedBroadcasts = broadcasts.filter((broadcast) => broadcast.channel === 'external-delivery:failed');
    expect(failedBroadcasts).toHaveLength(1);
    expect(failedBroadcasts[0]?.payload).toMatchObject({
      conversationId: 'c1',
      teamId: 'T123',
      reason: 'retries_exhausted',
      permanent: true,
    });
    expect((failedBroadcasts[0]?.payload as { deliveryId?: unknown }).deliveryId).toEqual(expect.any(String));
  });

  it('rate-limited delivery emits attempted telemetry for the retry', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(slackResponse({ ok: false, error: 'rate_limited' }, 200, { 'retry-after': '5' }))
      .mockResolvedValueOnce(slackResponse({ ok: true }));

    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
    await vi.advanceTimersByTimeAsync(2000);

    expect(logEntriesFor('slack_delivery_attempted')).toMatchObject([
      expect.objectContaining({ conversationId: 'c1', attempt: 1 }),
      expect.objectContaining({ conversationId: 'c1', attempt: 2 }),
    ]);
  });

  it('deliverResponse workspace not connected at delivery time is user-actionable permanent failure', async () => {
    workspace = null;
    const result = await adapter().deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
    expect(result).toMatchObject({ status: 'permanent-failure', userActionable: true });
  });

  it.each(['', '   \n\t  '] as const)(
    'deliverResponse rejects empty agent response %#',
    async (text) => {
      const fetchImpl = vi.fn();
      const result = await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage(text) });
      expect(result).toMatchObject({ status: 'permanent-failure', reason: 'Agent response is empty', userActionable: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('extractAgentResponseText joins assistant text blocks with a single newline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantTextBlocks('first', 'second') });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as { text: string };
    expect(body.text).toBe('first\nsecond');
  });

  it('deliverResponse splits multi-byte UTF-8 replies by character without breaking surrogates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    const text = `${'a'.repeat(3499)}😀${'b'.repeat(10)}`;
    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage(text) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as { text: string });
    expect(Array.from(bodies[0].text)).toHaveLength(3500);
    expect(bodies[0].text.endsWith('😀')).toBe(true);
    expect(bodies.map((body) => body.text).join('')).toBe(text);
    for (const body of bodies) {
      expect(hasDanglingSurrogate(body.text)).toBe(false);
    }
    expect(logEntriesFor('slack_delivery_succeeded')[0]?.chunkBytes).toBe(Buffer.byteLength(bodies[0].text, 'utf8'));
  });

  it('transient failure on chunk 3 retries only chunks 3 and 4', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(slackResponse({ ok: true }))
      .mockResolvedValueOnce(slackResponse({ ok: true }))
      .mockResolvedValueOnce(slackResponse({ ok: false, error: 'temporary_glitch' }))
      .mockResolvedValueOnce(slackResponse({ ok: true }))
      .mockResolvedValueOnce(slackResponse({ ok: true }));

    const fourChunkMessage = `${'a'.repeat(3500)}${'b'.repeat(3500)}${'c'.repeat(3500)}${'d'.repeat(1501)}`;
    const result = await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage(fourChunkMessage) });
    expect(result).toMatchObject({ status: 'transient-failure', retryAfterSec: 5 });

    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as { text: string });
    expect(bodies[3].text).toBe(bodies[2].text);
    expect(bodies[3].text).not.toBe(bodies[0].text);
    expect(bodies[3].text).not.toBe(bodies[1].text);
    expect(bodies[3].text).toHaveLength(3500);
    expect(bodies[4].text).toHaveLength(1501);
  });

  it('permanent failure on chunk 3 leaves posted chunks in Slack and logs partial delivery', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(slackResponse({ ok: true }))
      .mockResolvedValueOnce(slackResponse({ ok: true }))
      .mockResolvedValueOnce(slackResponse({ ok: false, error: 'is_archived' }));

    const fourChunkMessage = `${'a'.repeat(3500)}${'b'.repeat(3500)}${'c'.repeat(3500)}${'d'.repeat(1501)}`;
    const result = await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage(fourChunkMessage) });
    expect(result).toMatchObject({ status: 'permanent-failure', userActionable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(logLines.join('\n')).toContain('partial delivery: 2 of 4 chunks posted; manual review may be required');
  });

  it('deliverResponse disables unfurls in every postMessage body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: true }));
    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as { unfurl_links: boolean; unfurl_media: boolean };
    expect(body.unfurl_links).toBe(false);
    expect(body.unfurl_media).toBe(false);
  });

  it('deliverResponse never writes bot token to log lines', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: 'invalid_auth' }));
    await adapter(fetchImpl).deliverResponse({ context: ctx(), conversationId: 'c1', message: assistantMessage('hello') });
    expect(logLines.join('\n')).not.toContain('xoxb-test-token');
  });

  it('enrichMetadata caches users.info results by team and user', async () => {
    workspace = { ...connectedWorkspace(), teamDomain: 'acme' };
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({
      ok: true,
      user: { id: 'U1', profile: { display_name: 'Alice' } },
    }));
    const slackAdapter = adapter(fetchImpl);
    const context = { ...ctx(), metadata: { ...ctx().metadata, channelName: 'planning' } };

    await expect(slackAdapter.enrichContextMetadata(context)).resolves.toMatchObject({
      metadata: {
        userName: 'Alice',
        userDisplayName: 'Alice',
        channelName: 'planning',
        teamName: 'Acme',
        permalink: 'https://acme.slack.com/archives/C1/p100000000',
      },
    });
    await slackAdapter.enrichContextMetadata(context);

    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('users.info'))).toHaveLength(1);
  });

  it('enrichMetadata isolates users.info cache entries by team and user id', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(slackResponse({ ok: true, user: { id: 'U123', profile: { display_name: 'Alice T1' } } }))
      .mockResolvedValueOnce(slackResponse({ ok: true, user: { id: 'U123', profile: { display_name: 'Bob T2' } } }));
    const slackAdapter = adapter(fetchImpl);

    const t1 = await slackAdapter.enrichMetadata({
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '1700000000.123456',
      userId: 'U123',
      channelName: 'planning',
    }, {
      token: 'xoxb-t1',
      teamId: 'T1',
      teamName: 'Team One',
      teamDomain: 'team-one',
      fetchImpl,
    });
    const t2 = await slackAdapter.enrichMetadata({
      teamId: 'T2',
      channelId: 'C1',
      threadTs: '1700000000.123456',
      userId: 'U123',
      channelName: 'planning',
    }, {
      token: 'xoxb-t2',
      teamId: 'T2',
      teamName: 'Team Two',
      teamDomain: 'team-two',
      fetchImpl,
    });

    expect(t1.userName).toBe('Alice T1');
    expect(t2.userName).toBe('Bob T2');
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('users.info'))).toHaveLength(2);
  });

  it('enrichMetadata evicts user cache entries at the 200-entry cap', async () => {
    workspace = { ...connectedWorkspace(), teamDomain: 'acme' };
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      const parsed = new URL(url);
      const userId = parsed.searchParams.get('user') ?? 'unknown';
      return Promise.resolve(slackResponse({
        ok: true,
        user: { id: userId, profile: { display_name: `User ${userId}` } },
      }));
    });
    const slackAdapter = adapter(fetchImpl);

    for (let index = 0; index <= 200; index += 1) {
      await slackAdapter.enrichContextMetadata({
        ...ctx(),
        metadata: { userId: `U${index}`, channelName: 'planning' },
      });
    }
    await slackAdapter.enrichContextMetadata({
      ...ctx(),
      metadata: { userId: 'U0', channelName: 'planning' },
    });

    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('users.info'))).toHaveLength(202);
  });

  it('enrichMetadata refreshes users.info after TTL expiry', async () => {
    workspace = { ...connectedWorkspace(), teamDomain: 'acme' };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(slackResponse({ ok: true, user: { id: 'U1', profile: { display_name: 'Alice' } } }))
      .mockResolvedValueOnce(slackResponse({ ok: true, user: { id: 'U1', profile: { display_name: 'Alice Updated' } } }));
    const slackAdapter = adapter(fetchImpl);
    const context = { ...ctx(), metadata: { ...ctx().metadata, channelName: 'planning' } };

    await slackAdapter.enrichContextMetadata(context);
    vi.advanceTimersByTime(SLACK_USER_CACHE_TTL_MS + 1);
    const enriched = await slackAdapter.enrichContextMetadata(context);

    expect(enriched.metadata.userName).toBe('Alice Updated');
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('users.info'))).toHaveLength(2);
  });

  it('enrichMetadata negative-caches 401 users.info failures for 5 minutes', async () => {
    workspace = { ...connectedWorkspace(), teamDomain: 'acme' };
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: 'invalid_auth' }, 401));
    const slackAdapter = adapter(fetchImpl);
    const context = { ...ctx(), metadata: { ...ctx().metadata, channelName: 'planning' } };

    await expect(slackAdapter.enrichContextMetadata(context)).resolves.toMatchObject({
      metadata: { userName: null },
    });
    await slackAdapter.enrichContextMetadata(context);

    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('users.info'))).toHaveLength(1);
    expect(logLines.join('\n')).toContain('slack.usersinfo.unauthorized');
  });

  it.each(['invalid_auth', 'user_not_found', 'account_inactive'] as const)(
    'enrichMetadata negative-caches users.info ok:false %s responses',
    async (errorCode) => {
      workspace = { ...connectedWorkspace(), teamDomain: 'acme' };
      const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: errorCode }));
      const slackAdapter = adapter(fetchImpl);
      const context = { ...ctx(), metadata: { ...ctx().metadata, channelName: 'planning' } };

      await expect(slackAdapter.enrichContextMetadata(context)).resolves.toMatchObject({
        metadata: { userName: null },
      });
      await slackAdapter.enrichContextMetadata(context);

      expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('users.info'))).toHaveLength(1);
      expect(logLines.join('\n')).toContain(
        errorCode === 'user_not_found' ? 'slack.usersinfo.user_not_found' : 'slack.usersinfo.unauthorized',
      );
    },
  );

  it('enrichMetadata does not negative-cache transient users.info ok:false responses', async () => {
    workspace = { ...connectedWorkspace(), teamDomain: 'acme' };
    const fetchImpl = vi.fn().mockResolvedValue(slackResponse({ ok: false, error: 'ratelimited' }));
    const slackAdapter = adapter(fetchImpl);
    const context = { ...ctx(), metadata: { ...ctx().metadata, channelName: 'planning' } };

    await slackAdapter.enrichContextMetadata(context);
    await slackAdapter.enrichContextMetadata(context);

    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('users.info'))).toHaveLength(2);
  });

  it('builds deterministic Slack permalinks and returns null without a team domain', () => {
    expect(__test.buildSlackPermalink({
      teamDomain: 'acme',
      channelId: 'C123',
      ts: '1700000000.123456',
    })).toBe('https://acme.slack.com/archives/C123/p1700000000123456');
    expect(__test.buildSlackPermalink({
      teamDomain: 'acme',
      channelId: 'C123',
      ts: '1700000000.0',
    })).toBe('https://acme.slack.com/archives/C123/p1700000000000000');
    expect(__test.buildSlackPermalink({
      teamDomain: 'acme',
      channelId: 'C123',
      ts: '1700000000',
    })).toBe('https://acme.slack.com/archives/C123/p1700000000000000');
    expect(__test.buildSlackPermalink({
      teamDomain: null,
      channelId: 'C123',
      ts: '1700000000.123456',
    })).toBeNull();
  });

  it('builds Slack permalinks for thread replies with parent thread parameters', () => {
    expect(__test.buildSlackPermalink({
      teamDomain: 'acme',
      channelId: 'C123',
      ts: '1700000001.000002',
      threadTs: '1700000000.123456',
    })).toBe('https://acme.slack.com/archives/C123/p1700000001000002?thread_ts=1700000000.123456&cid=C123');
    expect(__test.buildSlackPermalink({
      teamDomain: 'acme',
      channelId: 'C123',
      ts: '1700000000.123456',
      threadTs: '1700000000.123456',
    })).toBe('https://acme.slack.com/archives/C123/p1700000000123456');
  });

  it('getThreadHistory honours AbortSignal when the fetch is aborted mid-flight', async () => {
    const ctrl = new AbortController();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }));
    const slackAdapter = adapter(fetchImpl as typeof fetch);

    const pending = slackAdapter.getThreadHistory('C1', '100.000', ctrl.signal);
    ctrl.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/api/conversations.replies'),
      expect.objectContaining({ signal: ctrl.signal }),
    );
  });

  it('formatThreadHistoryDigest excludes the current event timestamp', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'User A' }, text: 'prior message' },
      { ts: '1779460380.000000', author: { kind: 'human', normalizedAuthorId: 'User B' }, text: 'current event' },
    ], { excludeEventTs: '1779460380.000000' });

    expect(digest.digest).toContain('Prior thread context:');
    expect(digest.digest).toContain('[User A, 2026-05-22 14:32]: prior message');
    expect(digest.digest).not.toContain('current event');
    expect(digest.filteredCount).toBe(0);
  });

  it('formatThreadHistoryDigest enforces the hard cap of 20 messages', () => {
    const replies = Array.from({ length: SLACK_THREAD_HISTORY_PREFETCH_LIMIT + 5 }, (_, index) => ({
      ts: `${1779460320 + index}.000000`,
      author: { kind: 'human' as const, normalizedAuthorId: `User ${index}` },
      text: `message ${index}`,
    }));

    const digest = formatThreadHistoryDigest(replies);

    const messageLines = digest.digest.split('\n').filter((line) => line.startsWith('['));
    expect(messageLines).toHaveLength(SLACK_THREAD_HISTORY_PREFETCH_LIMIT);
    expect(digest.digest).not.toContain('message 0');
    expect(digest.digest).toContain('message 24');
    expect(digest.filteredCount).toBe(0);
  });

  it('formatThreadHistoryDigest returns an empty string for empty replies', () => {
    expect(formatThreadHistoryDigest([])).toEqual({ digest: '', filteredCount: 0 });
  });

  it('formatThreadHistoryDigest neutralizes triple-backtick fences in reply text', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'User A' }, text: '```run dangerous command``` then continue' },
    ]);

    expect(digest.digest).toContain("''run dangerous command'' then continue");
    expect(digest.digest).not.toContain('```');
    expect(digest.filteredCount).toBe(0);
  });

  function makePolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
    const base: InboundAuthorPolicy = {
      inboundAuthorPolicySchemaVersion: 1,
      policyRevision: 1,
      mode: 'ownerOnly',
      allowlist: { slack: [] },
      blocklist: { slack: [] },
      surfaceTrusted: { slack: [] },
      agentAllowlist: { slack: [] },
      notices: { upgradeReviewPending: false },
    };
    return {
      ...base,
      ...overrides,
      allowlist: { ...base.allowlist, ...(overrides.allowlist ?? {}) },
      blocklist: { ...base.blocklist, ...(overrides.blocklist ?? {}) },
      surfaceTrusted: { ...base.surfaceTrusted, ...(overrides.surfaceTrusted ?? {}) },
      agentAllowlist: { ...base.agentAllowlist, ...(overrides.agentAllowlist ?? {}) },
      notices: { ...base.notices, ...(overrides.notices ?? {}) },
    };
  }

  it('formatThreadHistoryDigest legacyPermissive keeps all replies and filteredCount 0 (Inv-4a)', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner message' },
      { ts: '1779460330.000000', author: { kind: 'human', normalizedAuthorId: 'U_STRANGER' }, text: 'stranger message' },
      { ts: '1779460340.000000', author: { kind: 'agent', normalizedAuthorId: 'B_REBEL' }, text: 'agent message' },
    ], {
      inboundAuthorPolicy: makePolicy({ mode: 'legacyPermissive' }),
      ownerNormalizedAuthorId: 'U_OWNER',
      teamId: 'T1',
      surfaceId: 'C1',
    });

    expect(digest.digest).toContain('owner message');
    expect(digest.digest).toContain('stranger message');
    expect(digest.digest).toContain('agent message');
    expect(digest.filteredCount).toBe(0);
  });

  it('formatThreadHistoryDigest in legacyPermissive mode filters blocklisted replies (Inv-1 precedence)', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner message' },
      { ts: '1779460330.000000', author: { kind: 'human', normalizedAuthorId: 'U_STRANGER' }, text: 'stranger message' },
      { ts: '1779460340.000000', author: { kind: 'human', normalizedAuthorId: 'U_BLOCKED' }, text: 'blocked stranger message' },
    ], {
      inboundAuthorPolicy: makePolicy({
        mode: 'legacyPermissive',
        blocklist: { slack: ['U_BLOCKED'] },
      }),
      ownerNormalizedAuthorId: 'U_OWNER',
      teamId: 'T1',
      surfaceId: 'C1',
    });

    expect(digest.digest).toContain('owner message');
    expect(digest.digest).toContain('stranger message');
    expect(digest.digest).not.toContain('blocked stranger message');
    expect(digest.filteredCount).toBe(1);
  });

  it('formatThreadHistoryDigest ownerOnly filters strangers and keeps owner replies', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner message' },
      { ts: '1779460330.000000', author: { kind: 'human', normalizedAuthorId: 'U_STRANGER' }, text: 'stranger message' },
    ], {
      inboundAuthorPolicy: makePolicy({ mode: 'ownerOnly' }),
      ownerNormalizedAuthorId: 'U_OWNER',
      teamId: 'T1',
      surfaceId: 'C1',
    });

    expect(digest.digest).toContain('owner message');
    expect(digest.digest).not.toContain('stranger message');
    expect(digest.filteredCount).toBe(1);
  });

  it('formatThreadHistoryDigest allowlist mode keeps allowlisted users and filters others', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_ALLOWED' }, text: 'allowed message' },
      { ts: '1779460330.000000', author: { kind: 'human', normalizedAuthorId: 'U_STRANGER' }, text: 'stranger message' },
    ], {
      inboundAuthorPolicy: makePolicy({
        mode: 'allowlist',
        allowlist: { slack: ['U_ALLOWED'] },
      }),
      ownerNormalizedAuthorId: 'U_OWNER',
      teamId: 'T1',
      surfaceId: 'C1',
    });

    expect(digest.digest).toContain('allowed message');
    expect(digest.digest).not.toContain('stranger message');
    expect(digest.filteredCount).toBe(1);
  });

  it('formatThreadHistoryDigest allows listed agents via agentAllowlist', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'agent', normalizedAuthorId: 'B_ALLOWED' }, text: 'agent allowed' },
      { ts: '1779460330.000000', author: { kind: 'agent', normalizedAuthorId: 'B_OTHER' }, text: 'agent blocked' },
    ], {
      inboundAuthorPolicy: makePolicy({
        mode: 'ownerOnly',
        agentAllowlist: { slack: ['B_ALLOWED'] },
      }),
      ownerNormalizedAuthorId: 'U_OWNER',
      teamId: 'T1',
      surfaceId: 'C1',
    });

    expect(digest.digest).toContain('agent allowed');
    expect(digest.digest).not.toContain('agent blocked');
    expect(digest.filteredCount).toBe(1);
  });

  it('formatThreadHistoryDigest blocklist precedence drops blocked owner replies', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner blocked' },
      { ts: '1779460330.000000', author: { kind: 'human', normalizedAuthorId: 'U_ALLOWED' }, text: 'allowed user' },
    ], {
      inboundAuthorPolicy: makePolicy({
        mode: 'allowlist',
        allowlist: { slack: ['U_ALLOWED'] },
        blocklist: { slack: ['U_OWNER'] },
      }),
      ownerNormalizedAuthorId: 'U_OWNER',
      teamId: 'T1',
      surfaceId: 'C1',
    });

    expect(digest.digest).not.toContain('owner blocked');
    expect(digest.digest).toContain('allowed user');
    expect(digest.filteredCount).toBe(1);
  });

  it('formatThreadHistoryDigest evaluates replies independently (D13 no-inheritance)', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner first' },
      { ts: '1779460330.000000', author: { kind: 'human', normalizedAuthorId: 'U_STRANGER' }, text: 'stranger second' },
      { ts: '1779460340.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner third' },
    ], {
      inboundAuthorPolicy: makePolicy({ mode: 'ownerOnly' }),
      ownerNormalizedAuthorId: 'U_OWNER',
      teamId: 'T1',
      surfaceId: 'C1',
    });

    expect(digest.digest).toContain('owner first');
    expect(digest.digest).not.toContain('stranger second');
    expect(digest.digest).toContain('owner third');
    expect(digest.filteredCount).toBe(1);
  });

  it('formatThreadHistoryDigest returns digest + filteredCount shape and accurate exclusion count', () => {
    const digest = formatThreadHistoryDigest([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner message' },
      { ts: '1779460330.000000', author: { kind: 'unknown' }, text: 'unknown sender message' },
      { ts: '1779460340.000000', author: { kind: 'human', normalizedAuthorId: 'U_STRANGER' }, text: 'stranger message' },
    ], {
      inboundAuthorPolicy: makePolicy({ mode: 'ownerOnly' }),
      ownerNormalizedAuthorId: 'U_OWNER',
      teamId: 'T1',
      surfaceId: 'C1',
    });

    expect(digest).toEqual({
      digest: expect.any(String),
      filteredCount: 2,
    });
    expect(digest.digest).toContain('owner message');
    expect(digest.digest).not.toContain('unknown sender message');
    expect(digest.digest).not.toContain('stranger message');
  });

  it('Scope key derivation matches §5 D6', () => {
    expect(deriveScopeKey(ctx())).toBe('slack-thread:T123:C1:100.000');
  });

  function ctx(): SlackThreadContext {
    return {
      kind: 'slack-thread',
      identity: { teamId: 'T123', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    };
  }

  function hasDanglingSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        const previous = value.charCodeAt(index - 1);
        if (!(previous >= 0xd800 && previous <= 0xdbff)) return true;
      }
    }
    return false;
  }
});
