import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dispatchSlackInboundRaw,
  handleSlackWebhook,
  __setSlackWebhookRouteDepsForTesting,
  replayPendingSlackInbound,
} from '../slackWebhook';
import * as factory from '../../services/externalConversationServiceFactory';
import { SlackThreadAdapter, SlackThreadHistoryError } from '@core/services/externalConversation/adapters/slackThreadAdapter';
import type { SlackThreadContext } from '@core/services/externalConversation/externalContext';
import * as inboundAuthorGates from '@core/services/inboundAuthorGates';
import { setStoreFactory } from '@core/storeFactory';
import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import type { SlackWorkspaceStoreLike } from '@core/services/externalConversation/adapters/slackThreadAdapter';
import type { PendingInboundEntry, PendingInboundLog } from '../../services/slackPendingInboundLog';
import type { Logger } from '@core/logger';
import { buildOutboundMetadata } from '@core/services/externalConversation/slackOutboundMetadata';
import { SlackInboundRateLimiter } from '../../services/slackInboundRateLimiter';
import {
  __setSlackRecentSendersRouteDepsForTesting,
  handleSlackRecentSenders,
} from '../slackRecentSenders';
import { createSlackRecentSendersStore } from '../../services/slackRecentSendersStore';

describe('slackWebhook route', () => {
  const signingSecret = 'test_secret';
  let mockRes: any;
  let sentStatus: number;
  let sentJson: any;
  let workspace: NonNullable<ReturnType<SlackWorkspaceStoreLike['get']>> | null;
  let pendingLog: PendingInboundLog;
  let service: { createConversation: ReturnType<typeof vi.fn>; injectMessage: ReturnType<typeof vi.fn> };
  let slackAdapter: SlackThreadAdapter;
  let warningLines: string[];
  let infoLines: string[];
  let broadcasts: Array<{ channel: string; payload: unknown }>;
  let cancelByTeamId: (teamId: string) => void;
  let recentSendersStore: {
    recordAttempt: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
  let inboundRateLimiter: SlackInboundRateLimiter;
  let updateSettingsMock: ReturnType<typeof vi.fn>;
  let currentSettings: Record<string, unknown>;

  function createPendingLogMock(entries: ReturnType<PendingInboundLog['drainUnprocessed']> = []): PendingInboundLog {
    const markProcessed = vi.fn();
    return {
      enqueue: vi.fn(),
      markProcessed,
      drainUnprocessed: vi.fn(() => entries),
      claimEventProcessing: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
      releaseAfterSuccess: vi.fn(({ eventId }) => markProcessed(eventId)),
      markBroadcastDeferred: vi.fn(),
      tryResumeClaim: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
    };
  }

  function pendingEntry(entry: Omit<PendingInboundEntry, 'state' | 'ownerToken' | 'claimedAt'>): PendingInboundEntry {
    return { ...entry, state: 'pending', ownerToken: null, claimedAt: null };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));
    setStoreFactory((opts) => new TestMemoryStore(opts) as any);
    process.env.SLACK_SIGNING_SECRET = signingSecret;
    workspace = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'connected' };
    pendingLog = createPendingLogMock();
    broadcasts = [];
    cancelByTeamId = vi.fn<(teamId: string) => void>();
    warningLines = [];
    infoLines = [];
    currentSettings = { experimental: { slackCloudWebhookEnabled: true } };
    updateSettingsMock = vi.fn((partial: Record<string, unknown>) => {
      currentSettings = { ...currentSettings, ...partial };
    });
    inboundRateLimiter = new SlackInboundRateLimiter({
      tokensPerWindow: 10,
      windowMs: 60_000,
    });
    recentSendersStore = {
      recordAttempt: vi.fn(),
      list: vi.fn(() => []),
      remove: vi.fn(() => false),
      clear: vi.fn(() => 0),
    };
    const routeLog = {
      warn: (...args: unknown[]) => warningLines.push(JSON.stringify(args)),
      error: vi.fn(),
      info: (...args: unknown[]) => infoLines.push(JSON.stringify(args)),
      debug: vi.fn(),
    } as unknown as Logger;
    const workspaceStore: SlackWorkspaceStoreLike = {
      get: () => workspace,
      set: (record) => { workspace = record; },
      updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
      updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
      clear: () => { workspace = null; },
    };
    slackAdapter = new SlackThreadAdapter({ signingSecret, workspaceStore });
    vi.spyOn(slackAdapter, 'enrichContextMetadata').mockImplementation(async (context) => context);
    service = {
      createConversation: vi.fn(),
      injectMessage: vi.fn(),
    };
    vi.spyOn(factory, 'getExternalConversationService').mockReturnValue(service as any);
    factory.__setSlackThreadAdapterForTesting(slackAdapter);
    conversationScopeResolver.clearAll();
    __setSlackWebhookRouteDepsForTesting({
      pendingLog,
      workspaceStore,
      recentSendersStore: recentSendersStore as any,
      inboundRateLimiter,
      getSettings: () => currentSettings as any,
      updateSettings: updateSettingsMock as any,
      log: routeLog,
      broadcast: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
      hasOpenBroadcastClient: () => true,
      pendingDeliveries: { cancelByTeamId },
    });

    sentStatus = 0;
    sentJson = null;
    mockRes = {
      setHeader: vi.fn(),
      writeHead: vi.fn((status) => { sentStatus = status; }),
      end: vi.fn((body) => {
        if (body) {
          try { sentJson = JSON.parse(body); } catch {}
        }
      }),
      getHeader: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    inboundRateLimiter.dispose();
    factory.__setSlackThreadAdapterForTesting(null);
    conversationScopeResolver.clearAll();
    __setSlackWebhookRouteDepsForTesting(null);
    __setSlackRecentSendersRouteDepsForTesting(null);
    vi.restoreAllMocks();
    delete process.env.REBEL_DISABLE_CLOUD_WEBHOOK_ADAPTERS;
    delete process.env.REBEL_INBOUND_AUTHOR_POLICY_BYPASS;
    delete process.env.SLACK_SIGNING_SECRET;
  });

  function createMockReq(payload: any, timestamp: number, badSignature = false, secret = signingSecret) {
    const bodyStr = JSON.stringify(payload);
    const sigBasestring = `v0:${timestamp}:${bodyStr}`;
    const mySignature = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');
    
    const headers: Record<string, string> = {
      'x-slack-request-timestamp': timestamp.toString(),
      'x-slack-signature': badSignature ? 'v0=bad' : mySignature,
    };

    let dataCallback: any;
    let endCallback: any;
    
    return {
      method: 'POST',
      headers,
      on(event: string, cb: any) {
        if (event === 'data') dataCallback = cb;
        if (event === 'end') endCallback = cb;
      },
      _simulateData() {
        dataCallback(Buffer.from(bodyStr));
        endCallback();
      }
    } as any;
  }

  function createMockReqFromRawBody(rawBody: string, headers: Record<string, string> = {}) {
    let dataCallback: any;
    let endCallback: any;
    return {
      method: 'POST',
      headers,
      on(event: string, cb: any) {
        if (event === 'data') dataCallback = cb;
        if (event === 'end') endCallback = cb;
      },
      _simulateData() {
        dataCallback(Buffer.from(rawBody, 'utf8'));
        endCallback();
      },
    } as any;
  }

  function createRecentSendersGetReq() {
    return {
      method: 'GET',
      url: '/api/slack/recent-senders',
      headers: { host: 'cloud.example' },
    } as any;
  }

  function createRouteRes() {
    const out = { status: 0, body: '' };
    return {
      out,
      writeHead: vi.fn((status: number) => { out.status = status; }),
      end: vi.fn((body?: string) => { out.body = body ?? ''; }),
      setHeader: vi.fn(),
      getHeader: vi.fn(),
    } as any;
  }

  async function flushAsyncProcessing(): Promise<void> {
    await new Promise(resolve => process.nextTick(resolve));
    await Promise.resolve();
  }

  function routeDepsForSettings(settings: Record<string, unknown>) {
    currentSettings = { ...currentSettings, experimental: settings };
    const workspaceStore: SlackWorkspaceStoreLike = {
      get: () => workspace,
      set: (record) => { workspace = record; },
      updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
      updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
      clear: () => { workspace = null; },
    };
    return {
      pendingLog,
      workspaceStore,
      recentSendersStore: recentSendersStore as any,
      inboundRateLimiter,
      getSettings: () => currentSettings as any,
      updateSettings: updateSettingsMock as any,
      log: {
        warn: (...args: unknown[]) => warningLines.push(JSON.stringify(args)),
        error: vi.fn(),
        info: (...args: unknown[]) => infoLines.push(JSON.stringify(args)),
        debug: vi.fn(),
      } as unknown as Logger,
      broadcast: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
      hasOpenBroadcastClient: () => true,
      pendingDeliveries: { cancelByTeamId },
    };
  }

  function setExperimentalSettings(settings: Record<string, unknown>): void {
    __setSlackWebhookRouteDepsForTesting(routeDepsForSettings(settings));
  }

  function inboundPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      inboundAuthorPolicySchemaVersion: 1,
      policyRevision: 1,
      mode: 'legacyPermissive',
      allowlist: { slack: [] },
      blocklist: { slack: [] },
      surfaceTrusted: { slack: [] },
      agentAllowlist: { slack: [] },
      notices: { upgradeReviewPending: false },
      ...overrides,
    };
  }

  function logEntries(eventName: string): Array<Record<string, unknown>> {
    return [...warningLines, ...infoLines].flatMap((line) => {
      const parsed = JSON.parse(line) as unknown;
      if (!Array.isArray(parsed)) return [];
      const [entry] = parsed;
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      return record.event === eventName ? [record] : [];
    });
  }

  async function postSlackEvent(payload: any): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq(payload, timestamp);
    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await flushAsyncProcessing();
  }

  it('Returns 503 + Retry-After when disabled by env var', async () => {
    process.env.REBEL_DISABLE_CLOUD_WEBHOOK_ADAPTERS = '1';
    const req = { method: 'POST' } as any;
    await handleSlackWebhook(req, mockRes);
    expect(mockRes.setHeader).toHaveBeenCalledWith('Retry-After', '300');
    expect(sentStatus).toBe(503);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'])(
    'Returns 405 (no hang) when request method is %s',
    async (method) => {
      const req = { method } as any;
      await handleSlackWebhook(req, mockRes);
      expect(sentStatus).toBe(405);
      expect(sentJson).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'METHOD_NOT_ALLOWED' }),
        }),
      );
    },
  );

  it('URL verification challenge path', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({ type: 'url_verification', challenge: 'ch123' }, timestamp);
    
    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ challenge: 'ch123' });
  });

  it('acknowledges invalid JSON payloads as dropped with structured schema-invalid logging', async () => {
    await dispatchSlackInboundRaw({
      rawBody: Buffer.from('{"team_id":"T1","event":', 'utf8'),
      headers: { get: () => null },
      res: mockRes,
      returnSlackAuthFailureAsDropped: false,
    });

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'invalid_body' });
    expect(logEntries('slack_webhook_schema_invalid')).toContainEqual(
      expect.objectContaining({
        stage: 'json',
      }),
    );
  });

  it('acknowledges schema-invalid payloads as dropped and logs zod diagnostics', async () => {
    const req = createMockReq({
      team_id: 'T1',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' },
    }, Math.floor(Date.now() / 1000));

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'invalid_body' });
    const schemaLog = logEntries('slack_webhook_schema_invalid').find((entry) => entry.stage === 'schema');
    expect(schemaLog).toBeDefined();
    expect(schemaLog).toMatchObject({
      event: 'slack_webhook_schema_invalid',
      stage: 'schema',
      issuePaths: expect.any(Array),
    });
    expect((schemaLog?.issuePaths as unknown[])?.length ?? 0).toBeGreaterThan(0);
  });

  it('200-drops known unsupported top-level envelope types before schema parsing', async () => {
    const req = createMockReq({
      type: 'app_rate_limited',
      team_id: 'T1',
      minute_rate_limited: 1,
      api_app_id: 'A1',
    }, Math.floor(Date.now() / 1000));

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'unsupported_envelope_type' });
    expect(logEntries('slack_webhook_unsupported_envelope_type')).toContainEqual(
      expect.objectContaining({
        envelopeType: 'app_rate_limited',
      }),
    );
    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('does not ACK-drop app_uninstalled event_callback payloads at the envelope gate', async () => {
    const req = createMockReq({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-app-uninstalled',
      event: {
        type: 'app_uninstalled',
        team_id: 'T1',
        channel: 'D1',
        channel_type: 'im',
        ts: '100.000',
        user: 'U1',
        text: '',
      },
    }, Math.floor(Date.now() / 1000));

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true });
    expect(logEntries('slack_webhook_unsupported_envelope_type')).toHaveLength(0);
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-app-uninstalled');
    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('Valid signed payload reaches the service', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E1',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);
    
    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true });
    
    // Process happens async, wait a tick
    await new Promise(resolve => process.nextTick(resolve));
    expect(service.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'slack-thread' }),
      { userText: '<@UBOT> hello' },
    );
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('accepts well-formed Slack event metadata without parse-failure logging', async () => {
    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-meta-ok',
      event: {
        type: 'message',
        channel: 'C1',
        ts: '100.000',
        user: 'U1',
        text: '<@UBOT> hello',
        metadata: {
          event_type: 'assistant_context',
          event_payload: {
            agentInstanceId: 'agent-123',
            ownerUserId: 'U123',
            threadScope: 'thread',
          },
        },
      },
    });

    expect(sentStatus).toBe(200);
    expect(logEntries('slack_metadata_parse_failed')).toHaveLength(0);
    expect(service.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'slack-thread' }),
      { userText: '<@UBOT> hello' },
    );
  });

  it('round-trips Stage 4 outbound metadata through inbound parse without failures', async () => {
    const metadata = buildOutboundMetadata('thread_reply', {
      settings: {
        experimental: {
          agentInstanceId: '7a14c8f2-6ab7-4974-b53a-c13bf9d0a585',
        },
      },
      workspace: {
        authedUserId: 'U_OWNER_1',
      },
      threadScope: '100.000',
    });
    expect(metadata).not.toBeNull();

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-meta-round-trip',
      event: {
        type: 'message',
        channel: 'C1',
        ts: '100.000',
        user: 'U1',
        text: '<@UBOT> hello',
        metadata,
      },
    });

    expect(sentStatus).toBe(200);
    expect(logEntries('slack_metadata_parse_failed')).toHaveLength(0);
    expect(service.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'slack-thread' }),
      { userText: '<@UBOT> hello' },
    );
  });

  it('drops malformed metadata while continuing webhook processing', async () => {
    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-meta-invalid',
      event: {
        type: 'message',
        channel: 'C1',
        ts: '100.000',
        user: 'U1',
        text: '<@UBOT> hello',
        metadata: {
          event_type: 'assistant_context',
          event_payload: 'not-an-object',
        },
      },
    });

    expect(sentStatus).toBe(200);
    expect(service.createConversation).toHaveBeenCalled();
    const metadataFailures = logEntries('slack_metadata_parse_failed');
    expect(metadataFailures).toHaveLength(1);
    expect(metadataFailures[0]).toMatchObject({
      eventId: 'E-meta-invalid',
      principalKind: 'unknown',
      decision: 'drop_metadata_parse_failed',
      gateId: 'metadata-parse',
      reason: 'metadata_schema_invalid',
      policyRevision: expect.any(String),
      policySummary: expect.objectContaining({
        mode: expect.any(String),
      }),
    });
  });

  it('drops oversized metadata blobs while continuing webhook processing', async () => {
    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-meta-large',
      event: {
        type: 'message',
        channel: 'C1',
        ts: '100.000',
        user: 'U1',
        text: '<@UBOT> hello',
        metadata: {
          event_type: 'assistant_context',
          event_payload: {
            ownerUserId: 'U123',
            oversized: 'x'.repeat(2_000),
          },
        },
      },
    });

    expect(sentStatus).toBe(200);
    expect(service.createConversation).toHaveBeenCalled();
    const metadataFailures = logEntries('slack_metadata_parse_failed');
    expect(metadataFailures).toHaveLength(1);
    expect(metadataFailures[0]).toMatchObject({
      eventId: 'E-meta-large',
      decision: 'drop_metadata_parse_failed',
      reason: 'metadata_too_large',
    });
    expect(Number(metadataFailures[0].metadataBytes)).toBeGreaterThan(1024);
  });

  it('uses the shared slack thread identity projector output for webhook routing', async () => {
    vi.spyOn(slackAdapter, 'verifyInbound').mockResolvedValue({
      kind: 'slack-thread',
      identity: { teamId: 'T-wrong', channelId: 'C-wrong', threadTs: '999.000' },
      metadata: { userId: 'U1' },
    } as SlackThreadContext);
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-projector',
      event: { type: 'message', channel: 'C1', ts: '100.000', text: '<@UBOT> projector route' },
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await flushAsyncProcessing();

    expect(service.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          teamId: 'T1',
          channelId: 'C1',
          threadTs: '100.000',
        }),
      }),
      { userText: '<@UBOT> projector route' },
    );
  });

  it('drops signed webhook events when thread identity extraction fails and logs the failure', async () => {
    vi.spyOn(slackAdapter, 'verifyInbound').mockResolvedValue({
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    } as SlackThreadContext);
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-identity-missing',
      event: { type: 'message', text: '<@UBOT> identity missing' },
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await flushAsyncProcessing();

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'thread_identity_extraction_failed' });
    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(warningLines.join('\n')).toContain('slack_thread_identity_extraction_failed');
  });

  it('F1 drops channel messages without a bot mention after subtype filtering', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-no-mention',
      event: { type: 'message', channel_type: 'channel', channel: 'C1', ts: '100.000', user: 'U1', text: 'ordinary channel message' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-no-mention');
    expect(logEntries('slack_inbound_dropped_no_bot_mention')).toEqual([
      expect.objectContaining({
        eventId: 'E-no-mention',
        principalUserIdHash: expect.any(String),
        principalKind: 'human',
        surfaceId: 'C1',
        decision: 'drop_no_bot_mention',
        gateId: 'mention_gate',
        reason: 'bot_mention_required_for_non_im',
        policyRevision: expect.any(String),
        policySummary: expect.objectContaining({
          mode: expect.any(String),
        }),
      }),
    ]);
  });

  it('F16 drops a code-fenced literal bot mention', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-code-mention',
      event: { type: 'message', channel_type: 'channel', channel: 'C1', ts: '100.000', user: 'U1', text: '```<@UBOT>```' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_dropped_no_bot_mention')).toEqual([
      expect.objectContaining({
        eventId: 'E-code-mention',
        principalUserIdHash: expect.any(String),
        decision: 'drop_no_bot_mention',
        gateId: 'mention_gate',
      }),
    ]);
  });

  it('F17 accepts pretty mention labels in channel messages', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-pretty-mention',
      event: { type: 'message', channel_type: 'channel', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT|rebel> please help' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).toHaveBeenCalledTimes(1);
  });

  it('F18 requires explicit mentions in mpim conversations but auto-passes ims', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const mpimWithoutMention = createMockReq({
      team_id: 'T1',
      event_id: 'E-mpim-no-mention',
      event: { type: 'message', channel_type: 'mpim', channel: 'G1', ts: '100.000', user: 'U1', text: 'hello group' }
    }, timestamp);

    const mpimPromise = handleSlackWebhook(mpimWithoutMention, mockRes);
    mpimWithoutMention._simulateData();
    await mpimPromise;
    await new Promise(resolve => process.nextTick(resolve));
    expect(service.createConversation).not.toHaveBeenCalled();

    const imWithNoMention = createMockReq({
      team_id: 'T1',
      event_id: 'E-im-no-mention',
      event: { type: 'message', channel_type: 'im', channel: 'D1', ts: '101.000', user: 'U1', text: 'hello dm' }
    }, timestamp);

    const imPromise = handleSlackWebhook(imWithNoMention, mockRes);
    imWithNoMention._simulateData();
    await imPromise;
    await new Promise(resolve => process.nextTick(resolve));
    expect(service.createConversation).toHaveBeenCalledTimes(1);

    const mpimWithMention = createMockReq({
      team_id: 'T1',
      event_id: 'E-mpim-with-mention',
      event: { type: 'message', channel_type: 'mpim', channel: 'G1', ts: '102.000', user: 'U1', text: '<@UBOT> hello group' }
    }, timestamp);

    const mentionedMpimPromise = handleSlackWebhook(mpimWithMention, mockRes);
    mpimWithMention._simulateData();
    await mentionedMpimPromise;
    await new Promise(resolve => process.nextTick(resolve));
    expect(service.createConversation).toHaveBeenCalledTimes(2);
  });

  it('F13 recovers app_mention text from rich text blocks', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-block-text',
      event: {
        type: 'app_mention',
        channel: 'C1',
        ts: '100.000',
        user: 'U1',
        text: '',
        blocks: [{
          type: 'rich_text',
          elements: [{
            type: 'rich_text_section',
            elements: [{ type: 'text', text: 'please answer from blocks' }],
          }],
        }],
      }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'slack-thread' }),
      { userText: 'please answer from blocks' },
    );
  });

  it('F2 joins simultaneous same-event processing inside one process', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const context = {
      kind: 'slack-thread' as const,
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    };
    vi.spyOn(slackAdapter, 'verifyInbound').mockResolvedValue(context);
    let releaseCreate: () => void = () => undefined;
    service.createConversation.mockImplementation(() => new Promise<void>((resolve) => {
      releaseCreate = resolve;
    }));
    const payload = {
      team_id: 'T1',
      event_id: 'E-same-process',
      event: { type: 'message', channel_type: 'channel', channel: 'C1', ts: '100.000', text: '<@UBOT> hello' }
    };
    const firstReq = createMockReq(payload, timestamp);
    const secondReq = createMockReq(payload, timestamp);

    const first = handleSlackWebhook(firstReq, mockRes);
    firstReq._simulateData();
    await first;
    await new Promise(resolve => process.nextTick(resolve));
    const second = handleSlackWebhook(secondReq, mockRes);
    secondReq._simulateData();
    await second;
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(infoLines.join('\n')).toContain('slack_webhook_inflight_dedup_joined');
    releaseCreate();
    await new Promise(resolve => process.nextTick(resolve));
    expect(pendingLog.releaseAfterSuccess).toHaveBeenCalledTimes(1);
  });

  it('defers markProcessed when no broadcast consumer is connected', async () => {
    __setSlackWebhookRouteDepsForTesting({
      pendingLog,
      workspaceStore: {
        get: () => workspace,
        set: (record) => { workspace = record; },
        updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
        updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
        clear: () => { workspace = null; },
      },
      recentSendersStore: recentSendersStore as any,
      inboundRateLimiter,
      getSettings: () => currentSettings as any,
      updateSettings: updateSettingsMock as any,
      log: {
        warn: (...args: unknown[]) => warningLines.push(JSON.stringify(args)),
        error: vi.fn(),
        info: (...args: unknown[]) => infoLines.push(JSON.stringify(args)),
        debug: vi.fn(),
      } as unknown as Logger,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      hasOpenBroadcastClient: () => false,
      pendingDeliveries: { cancelByTeamId },
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-deferred',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(pendingLog.markProcessed).not.toHaveBeenCalled();
    expect(pendingLog.markBroadcastDeferred).toHaveBeenCalledWith({
      teamId: 'T1',
      eventId: 'E-deferred',
      ownerToken: 'owner-token',
    });
    expect(warningLines.join('\n')).toContain('slack_broadcast_deferred_no_consumer');
  });

  it('marks processed when at least one broadcast client is OPEN', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-with-consumer',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-with-consumer');
  });

  it('replay re-drives a previously-deferred entry once a consumer is OPEN', async () => {
    const enqueuedEntries: PendingInboundEntry[] = [];
    let consumerOpen = false;

    const replayPendingLog = createPendingLogMock(enqueuedEntries);
    replayPendingLog.enqueue = vi.fn((entry) => {
      enqueuedEntries.push(pendingEntry(entry));
    });
    replayPendingLog.drainUnprocessed = vi.fn(() => enqueuedEntries.slice());

    __setSlackWebhookRouteDepsForTesting({
      pendingLog: replayPendingLog,
      workspaceStore: {
        get: () => workspace,
        set: (record) => { workspace = record; },
        updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
        updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
        clear: () => { workspace = null; },
      },
      recentSendersStore: recentSendersStore as any,
      inboundRateLimiter,
      getSettings: () => currentSettings as any,
      updateSettings: updateSettingsMock as any,
      log: {
        warn: (...args: unknown[]) => warningLines.push(JSON.stringify(args)),
        error: vi.fn(),
        info: (...args: unknown[]) => infoLines.push(JSON.stringify(args)),
        debug: vi.fn(),
      } as unknown as Logger,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      hasOpenBroadcastClient: () => consumerOpen,
      pendingDeliveries: { cancelByTeamId },
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-replay-on-connect',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));
    await new Promise(resolve => process.nextTick(resolve));

    expect(replayPendingLog.markProcessed).not.toHaveBeenCalled();
    expect(enqueuedEntries.map((e) => e.eventId)).toEqual(['E-replay-on-connect']);
    expect(service.createConversation).toHaveBeenCalledTimes(1);

    consumerOpen = true;
    await replayPendingSlackInbound();

    expect(replayPendingLog.markProcessed).toHaveBeenCalledWith('E-replay-on-connect');
  });

  it('injects existing Slack thread messages without creating a duplicate conversation', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const existingContext = {
      kind: 'slack-thread' as const,
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    };
    conversationScopeResolver.bindConversation('conversation-existing', existingContext);
    vi.spyOn(slackAdapter, 'getThreadHistory').mockResolvedValue([]);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-existing',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> follow-up' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).toHaveBeenCalledTimes(1);
    expect(service.injectMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-existing',
      text: expect.stringContaining('follow-up'),
    }));
  });

  it('F3 prepends thread-history digest for existing thread continuations when enabled', async () => {
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    });
    const historySpy = vi.spyOn(slackAdapter, 'getThreadHistory').mockResolvedValue([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'User A' }, text: 'prior message' },
      { ts: '101.000', author: { kind: 'human', normalizedAuthorId: 'User B' }, text: 'current event should be excluded' },
    ]);

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-history-enabled',
      event: { type: 'message', channel: 'C1', thread_ts: '100.000', ts: '101.000', user: 'U1', text: '<@UBOT> follow-up' },
    });

    expect(historySpy).toHaveBeenCalledWith('C1', '100.000', expect.any(AbortSignal));
    expect(service.injectMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-existing',
      text: expect.stringContaining('Prior thread context:\n[User A, 2026-05-22 14:32]: prior message\n\n'),
    }));
    expect(service.injectMessage.mock.calls[0]?.[0]?.text).not.toContain('current event should be excluded');
    expect(logEntries('slack_thread_history_fetched')).toHaveLength(1);
  });

  it('filters disallowed history replies in ownerOnly mode and forwards digestFilteredCount in context metadata', async () => {
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: {
        inboundAuthorPolicySchemaVersion: 1,
        policyRevision: 1,
        mode: 'ownerOnly',
        allowlist: { slack: [] },
        blocklist: { slack: [] },
        surfaceTrusted: { slack: [] },
        agentAllowlist: { slack: [] },
        notices: { upgradeReviewPending: false },
      },
    });
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U_OWNER' },
    });
    vi.spyOn(slackAdapter, 'getThreadHistory').mockResolvedValue([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner first' },
      { ts: '1779460330.000000', author: { kind: 'human', normalizedAuthorId: 'U_STRANGER' }, text: 'stranger second' },
      { ts: '1779460340.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner third' },
    ]);

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-history-owner-only',
      event: { type: 'message', channel: 'C1', thread_ts: '100.000', ts: '101.000', user: 'U_OWNER', text: '<@UBOT> follow-up' },
    });

    expect(service.injectMessage).toHaveBeenCalledTimes(1);
    const injectedCall = service.injectMessage.mock.calls[0]?.[0];
    expect(injectedCall?.text).toContain('owner first');
    expect(injectedCall?.text).toContain('owner third');
    expect(injectedCall?.text).not.toContain('stranger second');
    expect((injectedCall?.context as SlackThreadContext | undefined)?.metadata?.digestFilteredCount).toBe(1);
    expect(logEntries('slack_inbound_dropped_author_policy')).toEqual([
      expect.objectContaining({
        decision: 'drop_context',
        principalKind: 'human',
        gateId: 'slack_owner_allowlist',
      }),
    ]);
  });

  it('filters blocklisted history replies in legacyPermissive mode and emits context-drop logs (Inv-1 precedence)', async () => {
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: {
        inboundAuthorPolicySchemaVersion: 1,
        policyRevision: 1,
        mode: 'legacyPermissive',
        allowlist: { slack: [] },
        blocklist: { slack: ['U_STRANGER'] },
        surfaceTrusted: { slack: [] },
        agentAllowlist: { slack: [] },
        notices: { upgradeReviewPending: false },
      },
    });
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U_OWNER' },
    });
    vi.spyOn(slackAdapter, 'getThreadHistory').mockResolvedValue([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'owner message' },
      { ts: '1779460330.000000', author: { kind: 'human', normalizedAuthorId: 'U_STRANGER' }, text: 'stranger message' },
      { ts: '1779460340.000000', author: { kind: 'agent', normalizedAuthorId: 'B_AGENT' }, text: 'agent message' },
    ]);

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-history-legacy-permissive',
      event: { type: 'message', channel: 'C1', thread_ts: '100.000', ts: '101.000', user: 'U_OWNER', text: '<@UBOT> follow-up' },
    });

    expect(service.injectMessage).toHaveBeenCalledTimes(1);
    const injectedCall = service.injectMessage.mock.calls[0]?.[0];
    expect(injectedCall?.text).toContain('owner message');
    expect(injectedCall?.text).not.toContain('stranger message');
    expect(injectedCall?.text).toContain('agent message');
    expect((injectedCall?.context as SlackThreadContext | undefined)?.metadata?.digestFilteredCount).toBe(1);
    expect(logEntries('slack_inbound_dropped_author_policy')).toEqual([
      expect.objectContaining({
        decision: 'drop_context',
        principalKind: 'human',
        gateId: 'legacy_blocklist',
        reason: 'blocklist',
      }),
    ]);
  });

  it('Stage 3 allows stranger inbound in legacyPermissive mode', async () => {
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'legacyPermissive' }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-legacy-allow',
      event: { type: 'message', channel_type: 'im', channel: 'D1', ts: '101.000', user: 'U_STRANGER', text: 'hello from stranger' },
    });

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_allowed_author_policy')).toEqual([
      expect.objectContaining({
        principalKind: 'human',
        reason: 'legacy_permissive',
        decision: 'allow',
      }),
    ]);
    expect(recentSendersStore.recordAttempt).not.toHaveBeenCalled();
  });

  it('Stage 3 allows owner in ownerOnly mode', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-owner-allow',
      event: { type: 'message', channel_type: 'im', channel: 'D1', ts: '101.000', user: 'U_OWNER', text: 'owner hello' },
    });

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_allowed_author_policy')).toEqual([
      expect.objectContaining({
        principalKind: 'human',
        reason: 'owner',
        decision: 'allow',
      }),
    ]);
    expect(recentSendersStore.recordAttempt).not.toHaveBeenCalled();
  });

  it('Stage 3 denies ownerOnly stranger with silent drop + structured log + recent sender write', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-owner-deny',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D_DENY',
        ts: '101.000',
        user: 'U_STRANGER',
        text: 'stranger hello',
      },
    });

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true });
    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_dropped_author_policy')).toEqual([
      expect.objectContaining({
        decision: 'drop',
        principalKind: 'human',
        gateId: 'slack_owner_allowlist',
        reason: 'not_owner_or_allowlisted',
      }),
    ]);
    expect(recentSendersStore.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'U_STRANGER',
      channelId: 'D_DENY',
      channelType: 'im',
    }));
  });

  it('Stage 3 denies non-listed stranger in allowlist mode', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['U_LISTED'] },
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-allowlist-deny',
      event: { type: 'message', channel_type: 'im', channel: 'D1', ts: '101.000', user: 'U_STRANGER', text: 'deny me' },
    });

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_dropped_author_policy')).toEqual([
      expect.objectContaining({
        decision: 'drop',
        reason: 'not_owner_or_allowlisted',
      }),
    ]);
    expect(recentSendersStore.recordAttempt).toHaveBeenCalledTimes(1);
  });

  it('Stage 3 allows listed user in allowlist mode', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['U_LISTED'] },
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-allowlist-allow',
      event: { type: 'message', channel_type: 'im', channel: 'D1', ts: '101.000', user: 'U_LISTED', text: 'listed hello' },
    });

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_inbound_allowed_author_policy')).toEqual([
      expect.objectContaining({
        decision: 'allow',
        reason: 'allowlist',
      }),
    ]);
    expect(recentSendersStore.recordAttempt).not.toHaveBeenCalled();
  });

  it('Stage 3 allows listed users in trusted channels under allowlist mode', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['U_LISTED'] },
        surfaceTrusted: { slack: ['C_TRUSTED'] },
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-trusted-listed-allow',
      event: {
        type: 'message',
        channel_type: 'channel',
        channel: 'C_TRUSTED',
        ts: '101.000',
        user: 'U_LISTED',
        text: '<@UBOT> listed in trusted channel',
      },
    });

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_inbound_allowed_author_policy')).toEqual([
      expect.objectContaining({
        decision: 'allow',
        reason: 'allowlist',
      }),
    ]);
  });

  it('Stage 3 allows non-listed users in trusted channels under allowlist mode', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['U_LISTED'] },
        surfaceTrusted: { slack: ['C_TRUSTED'] },
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-trusted-stranger-deny',
      event: {
        type: 'message',
        channel_type: 'channel',
        channel: 'C_TRUSTED',
        ts: '101.000',
        user: 'U_STRANGER',
        text: '<@UBOT> stranger in trusted channel',
      },
    });

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_inbound_allowed_author_policy')).toEqual([
      expect.objectContaining({
        decision: 'allow',
        reason: 'surface_trusted',
      }),
    ]);
    expect(recentSendersStore.recordAttempt).not.toHaveBeenCalled();
  });

  it('Stage 7 fail-closes when the inbound author gate evaluator throws', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({
        mode: 'allowlist',
        allowlist: { slack: ['U_LISTED'] },
      }),
    });

    vi.spyOn(inboundAuthorGates, 'evaluateInboundAuthor').mockImplementation(() => {
      throw new Error('simulated inbound evaluator crash');
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage7-evaluator-error',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D_EVAL',
        ts: '101.000',
        user: 'U_STRANGER',
        text: 'evaluator should fail closed',
      },
    });

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_gate_evaluator_error')).toEqual([
      expect.objectContaining({
        decision: 'drop',
        gateId: 'evaluator_error',
        reason: 'simulated inbound evaluator crash',
      }),
    ]);
    expect(recentSendersStore.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      principalKind: 'human',
      authorId: 'U_STRANGER',
      channelId: 'D_EVAL',
      channelType: 'im',
    }));
  });

  it('Stage 7 emergency bypass skips policy gating and routes the inbound event', async () => {
    process.env.REBEL_INBOUND_AUTHOR_POLICY_BYPASS = '1';
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({
        mode: 'ownerOnly',
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage7-bypass',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D_BYPASS',
        ts: '101.000',
        user: 'U_STRANGER',
        text: 'bypass should route this',
      },
    });

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_inbound_author_policy_bypassed')).toEqual([
      expect.objectContaining({
        decision: 'allow',
        gateId: 'policy_bypass',
        reason: 'REBEL_INBOUND_AUTHOR_POLICY_BYPASS=1',
      }),
    ]);
    expect(updateSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
      experimental: expect.objectContaining({
        inboundAuthorPolicyBypassActive: true,
      }),
    }));
    expect(logEntries('slack_inbound_dropped_author_policy')).toHaveLength(0);
  });

  it('Stage 3 drops self bot events with dedicated log schema', async () => {
    workspace = workspace ? { ...workspace, botUserId: 'B_SELF' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'allowlist' }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-self-bot',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '101.000',
        bot_id: 'B_SELF',
        text: 'self bot message',
      },
    });

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_dropped_self_message')).toEqual([
      expect.objectContaining({
        decision: 'drop_self_message',
        gateId: 'self_message',
      }),
    ]);
  });

  it('Stage 3 routes non-self bot events to the gate as agent principals', async () => {
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({
        mode: 'allowlist',
        agentAllowlist: { slack: ['A_HELPER'] },
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-agent-allow',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '101.000',
        bot_id: 'B_HELPER',
        bot_profile: {
          app_id: 'A_HELPER',
        },
        text: 'agent hello',
      },
    });

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_inbound_allowed_author_policy')).toEqual([
      expect.objectContaining({
        principalKind: 'agent',
        decision: 'allow',
        reason: 'agent_allowlist',
      }),
    ]);
  });

  it('Stage 5 drops metadata-matched self messages before bot_id/user fallback layers', async () => {
    workspace = workspace ? { ...workspace, botUserId: 'B_SELF' } : workspace;
    vi.spyOn(slackAdapter, 'verifyInbound').mockResolvedValue({
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'D1', threadTs: '101.000' },
      metadata: { userId: 'U_PROXY' },
    } as SlackThreadContext);
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      agentInstanceId: 'agent-self',
      inboundAuthorPolicy: inboundPolicy({
        mode: 'allowlist',
        agentAllowlist: { slack: ['agent-self'] },
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage5-self-metadata-priority',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '101.000',
        bot_id: 'B_SELF',
        user: 'B_SELF',
        text: 'metadata self loop',
        metadata: {
          event_type: 'rebel_thread_reply',
          event_payload: {
            agentInstanceId: 'agent-self',
          },
        },
      },
    });

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_dropped_self_message_metadata')).toEqual([
      expect.objectContaining({
        decision: 'drop_self_message',
        gateId: 'self_message',
        reason: 'metadata_agent_instance_id_matches',
      }),
    ]);
    expect(logEntries('slack_inbound_dropped_self_message')).toHaveLength(0);
    expect(logEntries('slack_inbound_dropped_self_message_user')).toHaveLength(0);
  });

  it('Stage 5 drops synthetic self messages when bot_id is missing but event.user matches bot user', async () => {
    workspace = workspace ? { ...workspace, botUserId: 'B_SELF' } : workspace;
    vi.spyOn(slackAdapter, 'verifyInbound').mockResolvedValue({
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'D1', threadTs: '101.000' },
      metadata: { userId: 'U_PROXY' },
    } as SlackThreadContext);
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'allowlist' }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage5-self-user-fallback',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '101.000',
        user: 'B_SELF',
        text: 'synthetic self message',
      },
    });

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_dropped_self_message_user')).toEqual([
      expect.objectContaining({
        decision: 'drop_self_message',
        gateId: 'self_message',
        reason: 'user_matches_workspace_bot_user_id',
      }),
    ]);
  });

  it('Stage 5 routes other Rebel bot messages by metadata agentInstanceId instead of dropping self-bot events', async () => {
    workspace = workspace ? { ...workspace, botUserId: 'B_SHARED' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      agentInstanceId: 'agent-self',
      inboundAuthorPolicy: inboundPolicy({
        mode: 'allowlist',
        agentAllowlist: { slack: ['agent-peer-1'] },
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage5-other-rebel',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '101.000',
        bot_id: 'B_SHARED',
        text: 'other rebel message',
        metadata: {
          event_type: 'rebel_thread_reply',
          event_payload: {
            agentInstanceId: 'agent-peer-1',
          },
        },
      },
    });

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_inbound_other_rebel_detected')).toEqual([
      expect.objectContaining({
        principalKind: 'agent',
        decision: 'allow',
        gateId: 'self_message',
        reason: 'metadata_agent_instance_id_mismatch',
      }),
    ]);
    expect(logEntries('slack_inbound_allowed_author_policy')).toEqual([
      expect.objectContaining({
        principalKind: 'agent',
        decision: 'allow',
        reason: 'agent_allowlist',
      }),
    ]);
    expect(logEntries('slack_inbound_dropped_self_message')).toHaveLength(0);
    expect(logEntries('slack_inbound_dropped_self_message_metadata')).toHaveLength(0);
    expect(recentSendersStore.recordAttempt).not.toHaveBeenCalled();
  });

  it('Stage 5 records denied other Rebel messages in Recent senders as agent principals', async () => {
    workspace = workspace ? { ...workspace, botUserId: 'B_SHARED' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      agentInstanceId: 'agent-self',
      inboundAuthorPolicy: inboundPolicy({
        mode: 'allowlist',
        agentAllowlist: { slack: [] },
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage5-other-rebel-deny',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '101.000',
        bot_id: 'B_SHARED',
        text: 'other rebel denied',
        metadata: {
          event_type: 'rebel_thread_reply',
          event_payload: {
            agentInstanceId: 'agent-peer-denied',
          },
        },
      },
    });

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_other_rebel_detected')).toEqual([
      expect.objectContaining({
        principalKind: 'agent',
        reason: 'metadata_agent_instance_id_mismatch',
      }),
    ]);
    expect(logEntries('slack_inbound_dropped_author_policy')).toEqual([
      expect.objectContaining({
        principalKind: 'agent',
        decision: 'drop',
        reason: 'not_owner_or_allowlisted',
      }),
    ]);
    expect(recentSendersStore.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      principalKind: 'agent',
      authorId: 'agent-peer-denied',
      channelId: 'D1',
      channelType: 'im',
    }));
  });

  it('Stage 5 rate-limits non-owner principals after 10 events in 60 seconds', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
    });

    for (let index = 0; index < 11; index += 1) {
      await postSlackEvent({
        team_id: 'T1',
        event_id: `E-stage5-rate-limit-${index}`,
        event: {
          type: 'message',
          channel_type: 'im',
          channel: 'D1',
          ts: `${101 + index}.000`,
          user: 'U_SPAMMER',
          text: 'spam',
        },
      });
    }

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_dropped_rate_limited')).toEqual([
      expect.objectContaining({
        decision: 'drop_rate_limited',
        gateId: 'inbound_rate_limit',
        reason: 'principal_rate_limited',
      }),
    ]);
    expect(logEntries('slack_inbound_dropped_author_policy')).toHaveLength(10);
    expect(recentSendersStore.recordAttempt).toHaveBeenCalledTimes(11);
  });

  it('Stage 5 rate-limit deny increments durable recent sender attempts to 11', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-rate-limit-recent-senders-'));
    const storePath = path.join(tempDir, 'slackRecentSenders.json');
    const durableRecentSendersStore = createSlackRecentSendersStore({
      storeFactory: () => ({ path: storePath } as any),
      log: { error: vi.fn() } as any,
    });

    try {
      workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
      const webhookDeps = routeDepsForSettings({
        slackCloudWebhookEnabled: true,
        inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
      });
      __setSlackWebhookRouteDepsForTesting({
        ...webhookDeps,
        recentSendersStore: durableRecentSendersStore as any,
      });

      for (let index = 0; index < 11; index += 1) {
        await postSlackEvent({
          team_id: 'T1',
          event_id: `E-stage5-rate-limit-durable-${index}`,
          event: {
            type: 'message',
            channel_type: 'im',
            channel: 'D_RATE',
            ts: `${601 + index}.000`,
            user: 'U_SPAMMER_DURABLE',
            text: 'durable spam',
          },
        });
      }

      expect(logEntries('slack_inbound_dropped_rate_limited')).toHaveLength(1);
      const senders = durableRecentSendersStore.list('T1');
      expect(senders).toHaveLength(1);
      expect(senders[0]).toMatchObject({
        kind: 'human',
        authorId: 'U_SPAMMER_DURABLE',
        attemptCount: 11,
        channelIds: ['D_RATE'],
        lastChannelType: 'im',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Stage 5 exempts owner principals from rate limiting', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
    });

    for (let index = 0; index < 50; index += 1) {
      await postSlackEvent({
        team_id: 'T1',
        event_id: `E-stage5-owner-${index}`,
        event: {
          type: 'message',
          channel_type: 'im',
          channel: 'D_OWNER',
          ts: `${201 + index}.000`,
          user: 'U_OWNER',
          text: 'owner firehose',
        },
      });
    }

    expect(logEntries('slack_inbound_dropped_rate_limited')).toHaveLength(0);
    expect(logEntries('slack_inbound_allowed_author_policy')).toHaveLength(50);
  });

  it('Stage 5 keeps rate-limit buckets isolated by principal within the same workspace', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
    });

    for (let index = 0; index < 10; index += 1) {
      await postSlackEvent({
        team_id: 'T1',
        event_id: `E-stage5-principal-a-${index}`,
        event: {
          type: 'message',
          channel_type: 'im',
          channel: 'D1',
          ts: `${301 + index}.000`,
          user: 'U_SPAMMER_A',
          text: 'principal a',
        },
      });
    }

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage5-principal-b-0',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '400.000',
        user: 'U_SPAMMER_B',
        text: 'principal b',
      },
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage5-principal-a-10',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '401.000',
        user: 'U_SPAMMER_A',
        text: 'principal a overflow',
      },
    });

    expect(logEntries('slack_inbound_dropped_rate_limited')).toHaveLength(1);
    expect(recentSendersStore.recordAttempt).toHaveBeenCalledTimes(12);
  });

  it('Stage 5 rate-limit window resets after 60 seconds', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
    });

    for (let index = 0; index < 11; index += 1) {
      await postSlackEvent({
        team_id: 'T1',
        event_id: `E-stage5-window-${index}`,
        event: {
          type: 'message',
          channel_type: 'im',
          channel: 'D1',
          ts: `${501 + index}.000`,
          user: 'U_WINDOW',
          text: 'window test',
        },
      });
    }

    vi.advanceTimersByTime(60_000);

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage5-window-reset',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '700.000',
        user: 'U_WINDOW',
        text: 'after window',
      },
    });

    expect(logEntries('slack_inbound_dropped_rate_limited')).toHaveLength(1);
    expect(recentSendersStore.recordAttempt).toHaveBeenCalledTimes(12);
  });

  it('Fix 6 checks missing owner identity before principal rate limiting', async () => {
    workspace = workspace ? { ...workspace, authedUserId: undefined } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
    });

    for (let index = 0; index < 10; index += 1) {
      inboundRateLimiter.consume('slack:T1:human:U_STRANGER', false);
    }

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-missing-owner-before-rate-limit',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        ts: '799.000',
        user: 'U_STRANGER',
        text: 'owner missing should win',
      },
    });

    expect(logEntries('slack_inbound_dropped_no_owner_identity')).toEqual([
      expect.objectContaining({
        eventId: 'E-stage3-missing-owner-before-rate-limit',
        decision: 'drop_no_owner_identity',
      }),
    ]);
    expect(logEntries('slack_inbound_dropped_rate_limited')).toHaveLength(0);
  });

  it('Stage 3 drops ownerOnly human messages when owner identity is missing and persists settings notice', async () => {
    workspace = workspace ? { ...workspace, authedUserId: undefined } : workspace;
    currentSettings = {
      experimental: {
        slackCloudWebhookEnabled: true,
        inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
      },
      dismissedAnnouncements: {
        'some-other-announcement': true,
      },
    };

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-missing-owner',
      event: { type: 'message', channel_type: 'im', channel: 'D1', ts: '101.000', user: 'U_STRANGER', text: 'hello' },
    });

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_dropped_no_owner_identity')).toEqual([
      expect.objectContaining({
        decision: 'drop_no_owner_identity',
        gateId: 'slack_owner_allowlist',
        reason: 'owner_identity_missing',
      }),
    ]);
    expect(updateSettingsMock).toHaveBeenCalledWith({
      dismissedAnnouncements: {
        'some-other-announcement': true,
        'slack-owner-identity-missing': false,
      },
    });
  });

  it('Stage 3 enforces blocklist precedence even when the blocked principal is the owner', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({
        mode: 'ownerOnly',
        blocklist: { slack: ['U_OWNER'] },
      }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-owner-blocked',
      event: { type: 'message', channel_type: 'im', channel: 'D1', ts: '101.000', user: 'U_OWNER', text: 'owner but blocked' },
    });

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(logEntries('slack_inbound_dropped_author_policy')).toEqual([
      expect.objectContaining({
        decision: 'drop',
        reason: 'blocklist',
      }),
    ]);
    expect(recentSendersStore.recordAttempt).toHaveBeenCalledTimes(1);
  });

  it('Stage 3 records denied recent-sender attempts with display metadata', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-stage3-recent-sender-shape',
      event: {
        type: 'message',
        channel_type: 'mpim',
        channel: 'G_DENY',
        ts: '101.000',
        user: 'U_STRANGER',
        text: '<@UBOT> hello',
        user_profile: {
          display_name: 'Display Stranger',
          name: 'stranger-handle',
        },
      },
    });

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(recentSendersStore.recordAttempt).toHaveBeenCalledWith({
      transport: 'slack',
      teamId: 'T1',
      principalKind: 'human',
      authorId: 'U_STRANGER',
      normalizedAuthorId: 'U_STRANGER',
      displayName: 'Display Stranger',
      handle: 'stranger-handle',
      channelId: 'G_DENY',
      channelType: 'mpim',
    });
  });

  it('Stage 6 integration: deny path writes a sender that GET /api/slack/recent-senders returns', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-recent-senders-integration-'));
    const storePath = path.join(tempDir, 'slackRecentSenders.json');
    const durableRecentSendersStore = createSlackRecentSendersStore({
      storeFactory: () => ({ path: storePath } as any),
      log: { error: vi.fn() } as any,
    });

    try {
      workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
      const webhookDeps = routeDepsForSettings({
        slackCloudWebhookEnabled: true,
        inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
      });
      __setSlackWebhookRouteDepsForTesting({
        ...webhookDeps,
        recentSendersStore: durableRecentSendersStore as any,
      });
      __setSlackRecentSendersRouteDepsForTesting({
        workspaceStore: webhookDeps.workspaceStore,
        recentSendersStore: durableRecentSendersStore as any,
      });

      await postSlackEvent({
        team_id: 'T1',
        event_id: 'E-stage6-deny-to-rest',
        event: {
          type: 'message',
          channel_type: 'im',
          channel: 'D_DENY',
          ts: '201.000',
          user: 'u_stranger',
          text: 'stranger hello',
        },
      });

      const req = createRecentSendersGetReq();
      const res = createRouteRes();
      await handleSlackRecentSenders(req, res);

      expect(res.out.status).toBe(200);
      const body = JSON.parse(res.out.body) as { senders: Array<Record<string, unknown>> };
      expect(body.senders).toHaveLength(1);
      expect(body.senders[0]).toMatchObject({
        principalKey: 'slack:T1:human:U_STRANGER',
        kind: 'human',
        authorId: 'u_stranger',
        normalizedAuthorId: 'U_STRANGER',
        teamId: 'T1',
        attemptCount: 1,
        channelIds: ['D_DENY'],
        lastChannelType: 'im',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('F3 skip: disabled flag avoids pre-fetch and digest prefix', async () => {
    setExperimentalSettings({ slackCloudWebhookEnabled: true, slackInboundThreadHistory: false });
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    });
    const historySpy = vi.spyOn(slackAdapter, 'getThreadHistory').mockResolvedValue([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'User A' }, text: 'prior message' },
    ]);

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-history-disabled',
      event: { type: 'message', channel: 'C1', thread_ts: '100.000', ts: '101.000', user: 'U1', text: '<@UBOT> follow-up' },
    });

    expect(historySpy).not.toHaveBeenCalled();
    expect(service.injectMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-existing',
      text: expect.not.stringContaining('Prior thread context:'),
    }));
    expect(logEntries('slack_thread_history_fetched')).toHaveLength(0);
  });

  it('F3 new conversations do not pre-fetch thread history', async () => {
    const historySpy = vi.spyOn(slackAdapter, 'getThreadHistory').mockResolvedValue([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'User A' }, text: 'prior message' },
    ]);

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-history-new-conversation',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' },
    });

    expect(historySpy).not.toHaveBeenCalled();
    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('emits slack_digest_predicate_error when digest predicate evaluation throws', async () => {
    workspace = workspace ? { ...workspace, authedUserId: 'U_OWNER' } : workspace;
    setExperimentalSettings({
      slackCloudWebhookEnabled: true,
      inboundAuthorPolicy: inboundPolicy({ mode: 'ownerOnly' }),
    });
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U_OWNER' },
    });
    vi.spyOn(slackAdapter, 'getThreadHistory').mockResolvedValue([
      { ts: '1779460320.000000', author: { kind: 'human', normalizedAuthorId: 'U_THROW_DIGEST' }, text: 'throw this reply' },
      { ts: '1779460330.000000', author: { kind: 'human', normalizedAuthorId: 'U_OWNER' }, text: 'keep this reply' },
    ]);
    const evaluateInboundAuthorOriginal = inboundAuthorGates.evaluateInboundAuthor;
    vi.spyOn(inboundAuthorGates, 'evaluateInboundAuthor').mockImplementation((ctx, policy, gates) => {
      if (ctx.normalizedAuthorId === 'U_THROW_DIGEST') {
        throw new Error('digest predicate crash');
      }
      return evaluateInboundAuthorOriginal(ctx, policy, gates);
    });

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-history-predicate-error',
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'C1',
        thread_ts: '100.000',
        ts: '101.000',
        user: 'U_OWNER',
        text: '<@UBOT> follow-up',
      },
    });

    expect(service.injectMessage).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_digest_predicate_error')).toEqual([
      expect.objectContaining({
        decision: 'drop_context',
        gateId: 'digest-author-predicate',
        reason: 'predicate_error',
      }),
    ]);
  });

  it('F6 skips missing thread history, logs once per thread, and still injects', async () => {
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    });
    vi.spyOn(slackAdapter, 'getThreadHistory').mockRejectedValue(
      new SlackThreadHistoryError('missing', 'Slack conversations.replies HTTP 404', { status: 404 }),
    );

    for (let index = 0; index < 5; index += 1) {
      await postSlackEvent({
        team_id: 'T1',
        event_id: `E-history-missing-${index}`,
        event: { type: 'message', channel: 'C1', thread_ts: '100.000', ts: `101.00${index}`, user: 'U1', text: `<@UBOT> follow-up ${index}` },
      });
    }

    expect(service.injectMessage).toHaveBeenCalledTimes(5);
    expect(logEntries('slack_thread_history_unavailable')).toHaveLength(1);
    expect(logEntries('slack_thread_history_unavailable')[0]).toMatchObject({ reason: 'missing' });
  });

  it('F10 skips token-revoked thread-history failures without blocking inject', async () => {
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    });
    vi.spyOn(slackAdapter, 'getThreadHistory').mockRejectedValue(
      new SlackThreadHistoryError('401', 'Slack conversations.replies HTTP 401', { status: 401 }),
    );

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-history-401',
      event: { type: 'message', channel: 'C1', thread_ts: '100.000', ts: '101.000', user: 'U1', text: '<@UBOT> follow-up' },
    });

    expect(service.injectMessage).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_thread_history_unavailable')).toHaveLength(1);
    expect(logEntries('slack_thread_history_unavailable')[0]).toMatchObject({ reason: '401' });
  });

  it('F21 skips rate-limited thread history and emits retryAfter', async () => {
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    });
    vi.spyOn(slackAdapter, 'getThreadHistory').mockRejectedValue(
      new SlackThreadHistoryError('429', 'Slack conversations.replies HTTP 429', { status: 429, retryAfter: '17' }),
    );

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-history-429',
      event: { type: 'message', channel: 'C1', thread_ts: '100.000', ts: '101.000', user: 'U1', text: '<@UBOT> follow-up' },
    });

    expect(service.injectMessage).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_thread_history_rate_limited')).toEqual([
      expect.objectContaining({ retryAfter: '17' }),
    ]);
  });

  it('skips 5xx thread-history failures without blocking inject', async () => {
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    });
    vi.spyOn(slackAdapter, 'getThreadHistory').mockRejectedValue(
      new SlackThreadHistoryError('5xx', 'Slack conversations.replies HTTP 503', { status: 503 }),
    );

    await postSlackEvent({
      team_id: 'T1',
      event_id: 'E-history-5xx',
      event: { type: 'message', channel: 'C1', thread_ts: '100.000', ts: '101.000', user: 'U1', text: '<@UBOT> follow-up' },
    });

    expect(service.injectMessage).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_thread_history_unavailable')).toEqual([
      expect.objectContaining({ reason: '5xx' }),
    ]);
  });

  it('times out thread-history pre-fetch after 5s and still injects', async () => {
    conversationScopeResolver.bindConversation('conversation-existing', {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: { userId: 'U1' },
    });
    vi.spyOn(slackAdapter, 'getThreadHistory').mockImplementation((_channelId, _threadTs, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve([]), 6000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }));
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-history-timeout',
      event: { type: 'message', channel: 'C1', thread_ts: '100.000', ts: '101.000', user: 'U1', text: '<@UBOT> follow-up' },
    }, Math.floor(Date.now() / 1000));

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await flushAsyncProcessing();
    await vi.advanceTimersByTimeAsync(5000);
    await flushAsyncProcessing();

    expect(service.injectMessage).toHaveBeenCalledTimes(1);
    expect(logEntries('slack_thread_history_unavailable')).toEqual([
      expect.objectContaining({ reason: 'timeout', timeoutMs: 5000 }),
    ]);
  });

  it.each([
    'message_changed',
    'message_deleted',
    'channel_join',
    'channel_leave',
    'message_replied',
    'bot_message',
    'thread_broadcast',
    'pinned_item',
    'channel_topic',
    'channel_purpose',
    'me_message',
    'tombstone',
  ])('drops Slack message subtype %s after verification', async (subtype) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: `E-${subtype}`,
      event: { type: 'message', subtype, channel: 'C1', ts: '100.000', user: 'U1', text: 'noise' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));

    expect(sentStatus).toBe(200);
    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(pendingLog.markProcessed).toHaveBeenCalledWith(`E-${subtype}`);
  });

  it('preserves app_mention events without a subtype', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-app-mention',
      event: { type: 'app_mention', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).toHaveBeenCalledTimes(1);
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-app-mention');
  });

  it('accepts payloads with team_id only on event and dispatches with that team', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    workspace = { teamId: 'T-event-only', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'connected' };
    const req = createMockReq({
      event_id: 'E-event-team',
      event: { team_id: 'T-event-only', type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));

    expect(sentStatus).toBe(200);
    expect(service.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ teamId: 'T-event-only' }) }),
      { userText: '<@UBOT> hello' },
    );
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('keeps non-denylisted Slack message subtypes eligible for handling', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-custom-subtype',
      event: { type: 'message', subtype: 'future_custom_subtype', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    await new Promise(resolve => process.nextTick(resolve));

    expect(service.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ teamId: 'T1' }) }),
      { userText: '<@UBOT> hello' },
    );
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(infoLines.join('\n')).toContain('slack_unknown_subtype');
    expect(infoLines.join('\n')).toContain('future_custom_subtype');
  });

  it('rejects payloads with no top-level or event team_id before rate limiting', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      event_id: 'E-no-team',
      event: { type: 'message', channel: 'C1', ts: '100.000', text: 'hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(400);
    expect(sentJson).toEqual({ error: 'NO_TEAM_ID' });
    expect(warningLines.join('\n')).toContain('slack_webhook_no_team_id');
  });

  it('returns 200 within 100ms even when Slack metadata APIs are slow', async () => {
    vi.useRealTimers();
    vi.spyOn(slackAdapter, 'enrichContextMetadata').mockImplementation(async (context) => (
      new Promise((resolve) => {
        setTimeout(() => resolve(context), 200);
      })
    ));
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-slow-metadata',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const startTime = Date.now();
    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;
    const elapsed = Date.now() - startTime;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true });
    expect(elapsed).toBeLessThan(100);

    await new Promise((resolve) => setTimeout(resolve, 225));
    expect(service.createConversation).toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    vi.useFakeTimers();
  });

  it('uses BYOK signing secret for BYOK workspace verification', async () => {
    const byokSecret = 'byok_secret';
    workspace = {
      teamId: 'T1',
      teamName: 'Acme',
      botUserId: 'UBOT',
      botToken: 'xoxb-token',
      provisionMode: 'byok',
      installedAt: Date.now(),
      status: 'connected',
    };
    slackAdapter = new SlackThreadAdapter({
      signingSecret,
      signingSecretProvider: async (currentWorkspace) => (
        currentWorkspace?.provisionMode === 'byok' ? byokSecret : signingSecret
      ),
      workspaceStore: {
        get: () => workspace,
        set: (record) => { workspace = record; },
        updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
        updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
        clear: () => { workspace = null; },
      },
    });
    vi.spyOn(slackAdapter, 'enrichContextMetadata').mockImplementation(async (context) => context);
    factory.__setSlackThreadAdapterForTesting(slackAdapter);
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
      team_id: 'T1',
      event_id: 'E-byok',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' },
    };
    const req = createMockReq(payload, timestamp, false, byokSecret);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true });
  });

  it('200-drops with structured warning when signing secret provider returns null', async () => {
    workspace = {
      teamId: 'T1',
      teamName: 'Acme',
      botUserId: 'UBOT',
      botToken: 'xoxb-token',
      provisionMode: 'byok',
      installedAt: Date.now(),
      status: 'connected',
    };
    slackAdapter = new SlackThreadAdapter({
      signingSecret: null,
      signingSecretProvider: async () => null,
      workspaceStore: {
        get: () => workspace,
        set: (record) => { workspace = record; },
        updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
        updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
        clear: () => { workspace = null; },
      },
    });
    factory.__setSlackThreadAdapterForTesting(slackAdapter);
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-no-secret',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' },
    }, timestamp, false, 'irrelevant-secret');

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'secret_unavailable' });
    expect(warningLines.join('\n')).toContain('slack_webhook_dropped_secret_unavailable');
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('self-mention is acknowledged and dropped without injectMessage', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-self',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'UBOT', text: 'hello self' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true });
    expect(pendingLog.enqueue).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('workspace needs reconnect is acknowledged and dropped without injectMessage', async () => {
    workspace = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'needs_reconnect' };
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-not-connected',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'workspace_needs_reconnect' });
    expect(pendingLog.enqueue).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(service.injectMessage).not.toHaveBeenCalled();
  });

  it('200-drops when the cloud webhook flag is false without enqueueing', async () => {
    __setSlackWebhookRouteDepsForTesting({
      pendingLog,
      workspaceStore: {
        get: () => workspace,
        set: (record) => { workspace = record; },
        updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
        updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
        clear: () => { workspace = null; },
      },
      recentSendersStore: recentSendersStore as any,
      inboundRateLimiter,
      getSettings: () => ({ experimental: { slackCloudWebhookEnabled: false } } as any),
      updateSettings: updateSettingsMock as any,
      log: {
        warn: (...args: unknown[]) => warningLines.push(JSON.stringify(args)),
        error: vi.fn(),
        info: (...args: unknown[]) => infoLines.push(JSON.stringify(args)),
        debug: vi.fn(),
      } as unknown as Logger,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-disabled',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'cloud_webhook_disabled' });
    expect(pendingLog.enqueue).not.toHaveBeenCalled();
    expect(infoLines.join('\n')).toContain('slack_webhook_dropped_disabled');
  });

  it('200-drops when workspace is missing without enqueueing', async () => {
    workspace = null;
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-missing-workspace',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'workspace_not_connected' });
    expect(pendingLog.enqueue).not.toHaveBeenCalled();
    expect(warningLines.join('\n')).toContain('slack_webhook_dropped_not_connected');
  });

  it('200-drops when workspace is disconnected without enqueueing', async () => {
    workspace = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'disconnected' };
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-disconnected',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'workspace_not_connected' });
    expect(pendingLog.enqueue).not.toHaveBeenCalled();
  });

  it('does not re-emit workspace-changed for an idempotent needs_reconnect drop', async () => {
    workspace = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'needs_reconnect' };
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-needs-reconnect',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'workspace_needs_reconnect' });
    expect(pendingLog.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['flag off, no workspace', false, null],
    ['flag off, connected', false, 'connected'],
    ['flag off, needs reconnect', false, 'needs_reconnect'],
    ['flag on, no workspace', true, null],
    ['flag on, connected', true, 'connected'],
    ['flag on, disconnected', true, 'disconnected'],
  ] as const)('URL verification challenge works regardless of %s', async (_label, flagEnabled, status) => {
    workspace = status
      ? { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status }
      : null;
    __setSlackWebhookRouteDepsForTesting({
      pendingLog,
      workspaceStore: {
        get: () => workspace,
        set: (record) => { workspace = record; },
        updateStatus: (nextStatus, lastError) => { if (workspace) workspace = { ...workspace, status: nextStatus, lastError }; },
        updateLastSeen: () => { if (workspace) workspace = { ...workspace, lastSeenAt: Date.now() }; },
        clear: () => { workspace = null; },
      },
      recentSendersStore: recentSendersStore as any,
      inboundRateLimiter,
      getSettings: () => ({ experimental: { slackCloudWebhookEnabled: flagEnabled } } as any),
      updateSettings: updateSettingsMock as any,
      log: {
        warn: (...args: unknown[]) => warningLines.push(JSON.stringify(args)),
        error: vi.fn(),
        info: (...args: unknown[]) => infoLines.push(JSON.stringify(args)),
        debug: vi.fn(),
      } as unknown as Logger,
    });
    const req = createMockReq({ type: 'url_verification', challenge: 'always' }, Math.floor(Date.now() / 1000));

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ challenge: 'always' });
  });

  it('handles a real tokens_revoked payload before verifyInbound and marks workspace reconnect-needed', async () => {
    const verifySpy = vi.spyOn(slackAdapter, 'verifyInbound');
    __setSlackWebhookRouteDepsForTesting({
      pendingLog,
      workspaceStore: {
        get: () => workspace,
        set: (record) => { workspace = record; },
        updateStatus: (status, lastError) => { if (workspace) workspace = { ...workspace, status, lastError }; },
        updateLastSeen: vi.fn(),
        clear: () => { workspace = null; },
      },
      recentSendersStore: recentSendersStore as any,
      inboundRateLimiter,
      getSettings: () => ({ experimental: { slackCloudWebhookEnabled: false } } as any),
      updateSettings: updateSettingsMock as any,
      log: {
        warn: (...args: unknown[]) => warningLines.push(JSON.stringify(args)),
        error: vi.fn(),
        info: (...args: unknown[]) => infoLines.push(JSON.stringify(args)),
        debug: vi.fn(),
      } as unknown as Logger,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      pendingDeliveries: { cancelByTeamId },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-token-revoked',
      event: { type: 'tokens_revoked' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, action: 'tokens_revoked_handled' });
    expect(verifySpy).not.toHaveBeenCalled();
    expect(workspace?.status).toBe('needs_reconnect');
    expect(workspace?.lastError).toMatchObject({ code: 'tokens_revoked', occurredAt: Date.now() });
    expect(broadcasts).toEqual([
      {
        channel: 'slack:workspace-changed',
        payload: {
          teamId: 'T1',
          teamName: 'Acme',
          status: 'needs_reconnect',
          reason: 'tokens_revoked',
          occurredAt: Date.now(),
        },
      },
      {
        channel: 'slack:workspace-disconnected',
        payload: {
          teamId: 'T1',
          reason: 'tokens_revoked',
          occurredAt: Date.now(),
        },
      },
    ]);
    expect(cancelByTeamId).toHaveBeenCalledWith('T1');
  });

  it('200-drops orphan tokens_revoked events without changing workspace state', async () => {
    workspace = null;
    const verifySpy = vi.spyOn(slackAdapter, 'verifyInbound');
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T-orphan',
      event_id: 'E-token-revoked-orphan',
      event: { type: 'tokens_revoked' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'tokens_revoked_no_workspace' });
    expect(verifySpy).not.toHaveBeenCalled();
    expect(cancelByTeamId).not.toHaveBeenCalled();
    expect(infoLines.join('\n')).toContain('slack_webhook_tokens_revoked_no_workspace');
  });

  it('drops workspace team_id mismatch before verifyInbound or injectMessage', async () => {
    workspace = { teamId: 'T1', teamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-token', installedAt: Date.now(), status: 'connected' };
    const verifySpy = vi.spyOn(slackAdapter, 'verifyInbound');
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T2',
      event_id: 'E-team-mismatch',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'hello' }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true, dropped: true, reason: 'workspace_team_id_mismatch' });
    expect(verifySpy).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(warningLines.join('\n')).toContain('slack_webhook_dropped_team_mismatch');
  });

  it('throttles dropped-route logs once per team', async () => {
    __setSlackWebhookRouteDepsForTesting({
      pendingLog,
      workspaceStore: {
        get: () => workspace,
        set: vi.fn(),
        updateStatus: vi.fn(),
        updateLastSeen: vi.fn(),
        clear: vi.fn(),
      },
      recentSendersStore: recentSendersStore as any,
      inboundRateLimiter,
      getSettings: () => ({ experimental: { slackCloudWebhookEnabled: false } } as any),
      updateSettings: updateSettingsMock as any,
      log: {
        warn: (...args: unknown[]) => warningLines.push(JSON.stringify(args)),
        error: vi.fn(),
        info: (...args: unknown[]) => infoLines.push(JSON.stringify(args)),
        debug: vi.fn(),
      } as unknown as Logger,
    });
    for (const eventId of ['E-disabled-1', 'E-disabled-2']) {
      const req = createMockReq({
        team_id: 'T1',
        event_id: eventId,
        event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'hello' }
      }, Math.floor(Date.now() / 1000));
      const promise = handleSlackWebhook(req, mockRes);
      req._simulateData();
      await promise;
    }

    expect(infoLines.filter((line) => line.includes('slack_webhook_dropped_disabled'))).toHaveLength(1);
  });

  it('raw body over 16KB is acknowledged with warning path and not enqueued', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({
      team_id: 'T1',
      event_id: 'E-large',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'x'.repeat(17 * 1024) }
    }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(200);
    expect(sentJson).toEqual({ ok: true });
    expect(warningLines.join('\n')).toContain('Slack inbound payload too large for durable replay; dropping');
    expect(pendingLog.enqueue).not.toHaveBeenCalled();
  });

  it('replay skips an event already in the adapter LRU and marks it processed', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
      team_id: 'T1',
      event_id: 'E-replay',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello' }
    };
    const body = JSON.stringify(payload);
    await slackAdapter.verifyInbound(Buffer.from(body), {
      get(name: string) {
        if (name === 'x-slack-request-timestamp') return timestamp.toString();
        if (name === 'x-slack-signature') return 'v0=' + crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex');
        return null;
      },
    });
    vi.mocked(pendingLog.drainUnprocessed).mockReturnValue([pendingEntry({
      eventId: 'E-replay',
      teamId: 'T1',
      payloadHash: crypto.createHash('sha256').update(body).digest('hex'),
      rawBody: body,
      receivedAt: Date.now(),
    })]);

    await replayPendingSlackInbound();

    expect(service.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ teamId: 'T1' }) }),
      expect.objectContaining({
        userText: '<@UBOT> hello',
        replayMetadata: expect.objectContaining({ replayed: true }),
      }),
    );
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-replay');
    expect(warningLines.join('\n')).toContain('slack_replay_potential_duplicate');
  });

  it('replay drops entries whose persisted payloadHash does not match the rawBody', async () => {
    const payload = {
      team_id: 'T1',
      event_id: 'E-tampered',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> tampered' }
    };
    const body = JSON.stringify(payload);
    vi.mocked(pendingLog.drainUnprocessed).mockReturnValue([pendingEntry({
      eventId: 'E-tampered',
      teamId: 'T1',
      payloadHash: 'this-does-not-match-the-body',
      rawBody: body,
      receivedAt: Date.now(),
    })]);

    await replayPendingSlackInbound();

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-tampered');
    expect(warningLines.join('\n')).toContain('slack_replay_payload_hash_mismatch');
  });

  it('replay logs parse failures and marks malformed entries processed', async () => {
    const malformedRawBody = '{"team_id":"T1","event_id":"E-malformed","event":';
    vi.mocked(pendingLog.drainUnprocessed).mockReturnValue([pendingEntry({
      eventId: 'E-malformed',
      teamId: 'T1',
      payloadHash: crypto.createHash('sha256').update(malformedRawBody).digest('hex'),
      rawBody: malformedRawBody,
      receivedAt: Date.now(),
    })]);

    await replayPendingSlackInbound();

    expect(service.createConversation).not.toHaveBeenCalled();
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-malformed');
    expect(warningLines.join('\n')).toContain('slack_replay_payload_parse_failed');
  });

  it('replay uses the adapter signing secret even if SLACK_SIGNING_SECRET changes after enqueue', async () => {
    const payload = {
      team_id: 'T1',
      event_id: 'E-replay-env-rotated',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello replay' }
    };
    const body = JSON.stringify(payload);
    process.env.SLACK_SIGNING_SECRET = 'rotated-or-unset';
    vi.mocked(pendingLog.drainUnprocessed).mockReturnValue([pendingEntry({
      eventId: 'E-replay-env-rotated',
      teamId: 'T1',
      payloadHash: crypto.createHash('sha256').update(body).digest('hex'),
      rawBody: body,
      receivedAt: Date.now(),
    })]);

    await replayPendingSlackInbound();

    expect(service.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ teamId: 'T1' }) }),
      expect.objectContaining({
        userText: '<@UBOT> hello replay',
        replayMetadata: expect.objectContaining({ replayed: true }),
      }),
    );
    expect(service.injectMessage).not.toHaveBeenCalled();
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-replay-env-rotated');
  });

  it('Invalid signature returns 401', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const req = createMockReq({ team_id: 'T1', event_id: 'E-bad', event: { type: 'message', channel: 'C1' } }, timestamp, true);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(401);
    expect(sentJson).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      }),
    );
  });

  it('Stale timestamp returns 401', async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 10 * 60; // 10 mins ago
    const req = createMockReq({ team_id: 'T1', event_id: 'E-stale', event: { type: 'message', channel: 'C1' } }, timestamp);

    const promise = handleSlackWebhook(req, mockRes);
    req._simulateData();
    await promise;

    expect(sentStatus).toBe(401);
    expect(sentJson).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      }),
    );
  });

  it('Replay returns 200 idempotently', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = { team_id: 'T1', event_id: 'E1', event: { type: 'message', channel: 'C1', ts: '100.000', text: 'hello' } };
    
    const req1 = createMockReq(payload, timestamp);
    const promise1 = handleSlackWebhook(req1, mockRes);
    req1._simulateData();
    await promise1;
    expect(sentStatus).toBe(200);

    const req2 = createMockReq(payload, timestamp);
    const promise2 = handleSlackWebhook(req2, mockRes);
    req2._simulateData();
    await promise2;
    expect(sentStatus).toBe(200); // Because REPLAY WebhookAuthError is mapped to 200
  });
});
