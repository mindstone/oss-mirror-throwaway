import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { handleSlackWebhook, replayPendingSlackInbound, __setSlackWebhookRouteDepsForTesting } from '../routes/slackWebhook';
import { WebhookAuthError } from '@core/services/externalConversation/externalConversationAdapter';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import type { SlackWorkspaceStore } from '../services/slackWorkspaceStore';
import type { PendingInboundLog } from '../services/slackPendingInboundLog';
import { evaluatePollGate } from '@shared/utils/slackPollGate';

// Mock the factory to return test doubles
const {
  mockCreateConversation,
  mockInjectMessage,
  mockVerifyRequestSignatureForInbound,
  mockVerifyInbound,
  mockReplayInboundFromTrustedLog,
} = vi.hoisted(() => ({
  mockCreateConversation: vi.fn(),
  mockInjectMessage: vi.fn(),
  mockVerifyRequestSignatureForInbound: vi.fn(),
  mockVerifyInbound: vi.fn(),
  mockReplayInboundFromTrustedLog: vi.fn(),
}));

vi.mock('../services/externalConversationServiceFactory', () => ({
  getExternalConversationService: vi.fn(() => ({
    createConversation: mockCreateConversation,
    injectMessage: mockInjectMessage,
  })),
  slackThreadAdapterInstance: {
    verifyRequestSignatureForInbound: mockVerifyRequestSignatureForInbound,
    verifyInbound: mockVerifyInbound,
    replayInboundFromTrustedLog: mockReplayInboundFromTrustedLog,
  },
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    captureException: vi.fn(),
  })),
}));

class MockIncomingMessage extends IncomingMessage {
  constructor(private body: string, private customHeaders: Record<string, string> = {}) {
    super(null as any);
    this.method = 'POST';
    this.headers = customHeaders;
  }

  on(event: string, callback: (...args: any[]) => void) {
    if (event === 'data') {
      callback(Buffer.from(this.body));
    }
    if (event === 'end') {
      callback();
    }
    return this;
  }
}

class MockServerResponse extends ServerResponse {
  statusCode: number = 200;
  headers: Record<string, string> = {};
  body: string = '';

  constructor() {
    super({} as any);
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
    return this;
  }

  writeHead(statusCode: number, ...args: any[]) {
    this.statusCode = statusCode;
    const headers = args.find(arg => typeof arg === 'object' && arg !== null);
    if (headers) {
      Object.assign(this.headers, headers);
    }
    return this as any;
  }

  end(data?: any) {
    if (data) {
      this.body += data;
    }
    return this;
  }
}

describe('Slack Webhook End-to-End', () => {
  const ORIGINAL_ENV = process.env;
  let workspaceStatus: 'connected' | 'needs_reconnect' | 'disconnecting' | 'disconnected' | null;
  let pendingLog: PendingInboundLog;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.REBEL_DISABLE_CLOUD_WEBHOOK_ADAPTERS;
    workspaceStatus = 'connected';
    const workspaceStore: SlackWorkspaceStore = {
      get: () => workspaceStatus
        ? {
          teamId: 'T1',
          teamName: 'Acme',
          botUserId: 'UBOT',
          botToken: 'xoxb-token',
          installedAt: Date.now(),
          status: workspaceStatus,
        }
        : null,
      set: vi.fn(),
      updateStatus: (status) => { workspaceStatus = status; },
      updateLastSeen: vi.fn(),
      clear: () => { workspaceStatus = null; },
    };
    const markProcessed = vi.fn();
    pendingLog = {
      enqueue: vi.fn(),
      markProcessed,
      drainUnprocessed: vi.fn(() => []),
      claimEventProcessing: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
      releaseAfterSuccess: vi.fn(({ eventId }) => markProcessed(eventId)),
      markBroadcastDeferred: vi.fn(),
      tryResumeClaim: vi.fn(() => ({ acquired: true as const, ownerToken: 'owner-token' })),
    };
    conversationScopeResolver.clearAll();
    __setSlackWebhookRouteDepsForTesting({
      workspaceStore,
      getSettings: () => ({ experimental: { slackCloudWebhookEnabled: true } } as never),
      pendingLog,
      hasOpenBroadcastClient: () => true,
    });
  });

  afterEach(() => {
    conversationScopeResolver.clearAll();
    __setSlackWebhookRouteDepsForTesting(null);
    process.env = ORIGINAL_ENV;
  });

  it('rejects if REBEL_DISABLE_CLOUD_WEBHOOK_ADAPTERS is set', async () => {
    process.env.REBEL_DISABLE_CLOUD_WEBHOOK_ADAPTERS = '1';
    
    const req = new MockIncomingMessage('{}');
    const res = new MockServerResponse();

    await handleSlackWebhook(req as any, res as any);
    
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('300');
  });

  it('handles URL verification challenge', async () => {
    const payload = {
      type: 'url_verification',
      challenge: 'test-challenge-123',
    };
    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();

    await handleSlackWebhook(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ challenge: 'test-challenge-123' });
  });

  it('returns 200 immediately for replays', async () => {
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-replay',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'hello' }
    };
    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();

    mockVerifyInbound.mockRejectedValueOnce(new WebhookAuthError('replay detected', 'REPLAY', false));

    await handleSlackWebhook(req as any, res as any);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('returns 401 UNAUTHORIZED for invalid signatures', async () => {
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-invalid',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'hello' }
    };
    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();

    mockVerifyInbound.mockRejectedValueOnce(new WebhookAuthError('invalid sig', 'SIGNATURE_MISMATCH', false));

    await handleSlackWebhook(req as any, res as any);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      }),
    );
  });

  it('processes verified standard messages asynchronously', async () => {
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-ok',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello bot' }
    };
    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();

    const mockContext = {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' }
    };
    mockVerifyInbound.mockResolvedValueOnce(mockContext);

    await handleSlackWebhook(req as any, res as any);

    // Response should be sent immediately
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    // Wait for processAsync to finish
    await new Promise(process.nextTick);

    // New Slack threads are handed to createConversation only; it owns the
    // single conversations:start-requested broadcast with sendMessage: true.
    expect(mockCreateConversation).toHaveBeenCalledWith(
      mockContext,
      { userText: '<@UBOT> hello bot' }
    );
    expect(mockInjectMessage).not.toHaveBeenCalled();
  });

  it('new Slack thread inbound reaches exactly one start-requested broadcast path', async () => {
    const broadcastSpy = vi.fn();
    mockCreateConversation.mockImplementationOnce(async () => {
      broadcastSpy('conversations:start-requested', { sendMessage: true });
    });
    mockInjectMessage.mockImplementationOnce(async () => {
      broadcastSpy('conversations:start-requested', { sendMessage: true });
    });
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-single-broadcast',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello once' }
    };
    const mockContext = {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' }
    };
    mockVerifyInbound.mockResolvedValueOnce(mockContext);

    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();
    await handleSlackWebhook(req as any, res as any);
    await new Promise(process.nextTick);

    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledWith('conversations:start-requested', { sendMessage: true });
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage).not.toHaveBeenCalled();
  });

  it('keeps existing Slack thread inbounds on the injectMessage path', async () => {
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-existing-thread',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello again' }
    };
    const mockContext = {
      kind: 'slack-thread' as const,
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
      metadata: {},
    };
    conversationScopeResolver.bindConversation('conversation-existing', mockContext);
    mockVerifyInbound.mockResolvedValueOnce(mockContext);

    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();
    await handleSlackWebhook(req as any, res as any);
    await new Promise(process.nextTick);

    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockInjectMessage).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-existing',
      context: mockContext,
      text: '<@UBOT> hello again',
    }));
  });

  it('drops noisy Slack message subtypes after verification', async () => {
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-message-changed',
      event: { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '100.000', user: 'U1', text: 'edited' }
    };
    const mockContext = {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' }
    };
    mockVerifyInbound.mockResolvedValueOnce(mockContext);

    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();
    await handleSlackWebhook(req as any, res as any);
    await new Promise(process.nextTick);

    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockInjectMessage).not.toHaveBeenCalled();
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-message-changed');
  });

  it('mutual exclusion: cloud webhook handles one event while desktop polling is paused', async () => {
    expect(evaluatePollGate({
      cloudFlagEnabled: true,
      cloudWorkspaceTeamId: 'T1',
      cloudWorkspaceStatus: 'connected',
      cloudReachable: true,
    }, 'T1')).toEqual({ paused: true, reason: 'cloud-canonical' });
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-mutual-exclusion',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello once' }
    };
    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();
    const mockContext = {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' }
    };
    mockVerifyInbound.mockResolvedValueOnce(mockContext);

    await handleSlackWebhook(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    await new Promise(process.nextTick);

    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage).not.toHaveBeenCalled();
  });

  it('disconnect resumes polling gate by making cloud workspace not connected', async () => {
    workspaceStatus = null;
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-after-disconnect',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: 'hello' }
    };
    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();

    await handleSlackWebhook(req as unknown as IncomingMessage, res as unknown as ServerResponse);

    expect(JSON.parse(res.body)).toEqual({ ok: true, dropped: true, reason: 'workspace_not_connected' });
    expect(mockInjectMessage).not.toHaveBeenCalled();
  });

  it('leaves transient workspace-not-connected replay drops pending and succeeds after reconnect', async () => {
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-replay-transient-disconnect',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello after reconnect' }
    };
    const rawBody = JSON.stringify(payload);
    const pendingEntry = {
      eventId: 'E-replay-transient-disconnect',
      teamId: 'T1',
      payloadHash: crypto.createHash('sha256').update(rawBody).digest('hex'),
      rawBody,
      receivedAt: Date.now(),
      state: 'pending' as const,
      ownerToken: null,
      claimedAt: null,
    };
    vi.mocked(pendingLog.drainUnprocessed)
      .mockReturnValueOnce([pendingEntry])
      .mockReturnValueOnce([pendingEntry]);
    mockReplayInboundFromTrustedLog
      .mockResolvedValueOnce({ kind: 'workspace-not-connected' })
      .mockResolvedValueOnce({
        kind: 'slack-thread',
        identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' },
        metadata: {},
      });

    await replayPendingSlackInbound();

    expect(pendingLog.markProcessed).not.toHaveBeenCalledWith('E-replay-transient-disconnect');
    expect(mockCreateConversation).not.toHaveBeenCalled();

    workspaceStatus = 'connected';
    await replayPendingSlackInbound();
    await new Promise(process.nextTick);

    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ teamId: 'T1' }) }),
      expect.objectContaining({
        userText: '<@UBOT> hello after reconnect',
        replayMetadata: expect.objectContaining({ replayed: true }),
      })
    );
    expect(mockInjectMessage).not.toHaveBeenCalled();
    expect(pendingLog.markProcessed).toHaveBeenCalledWith('E-replay-transient-disconnect');
  });

  it('workspace mismatch: cloud route and desktop poll for a different team stay independent', async () => {
    expect(evaluatePollGate({
      cloudFlagEnabled: true,
      cloudWorkspaceTeamId: 'T1',
      cloudWorkspaceStatus: 'connected',
      cloudReachable: true,
    }, 'T2')).toEqual({ paused: false, reason: null });
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-workspace-mismatch',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello cloud' }
    };
    const req = new MockIncomingMessage(JSON.stringify(payload));
    const res = new MockServerResponse();
    const mockContext = {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' }
    };
    mockVerifyInbound.mockResolvedValueOnce(mockContext);

    await handleSlackWebhook(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    await new Promise(process.nextTick);

    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage).not.toHaveBeenCalled();
  });

  it('flag flip-flop within 60s does not double-handle the same event', async () => {
    const payload = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'E-flip-flop',
      event: { type: 'message', channel: 'C1', ts: '100.000', user: 'U1', text: '<@UBOT> hello once' }
    };
    const mockContext = {
      kind: 'slack-thread',
      identity: { teamId: 'T1', channelId: 'C1', threadTs: '100.000' }
    };
    mockVerifyInbound
      .mockResolvedValueOnce(mockContext)
      .mockRejectedValueOnce(new WebhookAuthError('replay detected', 'REPLAY', false));

    const req1 = new MockIncomingMessage(JSON.stringify(payload));
    const res1 = new MockServerResponse();
    await handleSlackWebhook(req1 as unknown as IncomingMessage, res1 as unknown as ServerResponse);
    await new Promise(process.nextTick);

    const req2 = new MockIncomingMessage(JSON.stringify(payload));
    const res2 = new MockServerResponse();
    await handleSlackWebhook(req2 as unknown as IncomingMessage, res2 as unknown as ServerResponse);
    await new Promise(process.nextTick);

    expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    expect(mockInjectMessage).not.toHaveBeenCalled();
  });
});
