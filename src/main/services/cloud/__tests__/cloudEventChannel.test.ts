import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'module';
// ws CJS/ESM interop is inconsistent across vitest configs and CI environments;
// CJS require is deterministic. See cloudEventBroadcaster.test.ts for same pattern.
const require = createRequire(import.meta.url);
const ws = require('ws');
const _WebSocket = ws as typeof import('ws').default;
const WebSocketServer = ws.Server as typeof import('ws').WebSocketServer;
type WsClient = InstanceType<typeof _WebSocket>;
type WsServer = InstanceType<typeof WebSocketServer>;

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  mergeEntries: vi.fn((entries: unknown[]) => ({ added: entries.length })),
  send: vi.fn(),
}));
const mockSend = mocks.send;
const mockLogWarn = mocks.logWarn;
const mockLogInfo = mocks.logInfo;
const mockMergeEntries = mocks.mergeEntries;
const warnLines: unknown[] = [];
let mirroredSettings: { experimental?: Record<string, unknown> } = {};
let lastSafetyActivityLogRequestBody: unknown = null;
let safetyActivityLogStatus = 200;
let safetyActivityLogResponse: unknown;
// Overridable responses for the array-returning catch-up channels. Default to
// the valid array fixtures below; a test can set one to a non-array to exercise
// the `fetchIpcParsed` wrong-shape drop while the others stay valid arrays.
let toolPendingResponse: unknown;
let stagedCallsResponse: unknown;
let memoryPendingResponse: unknown;

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mocks.send,
    sendToFocusedWindow: vi.fn(),
  }),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: mocks.logInfo,
    warn: mocks.logWarn,
  }),
}));

vi.mock('@core/safetyActivityLogStore', () => ({
  mergeEntries: mocks.mergeEntries,
}));

import { cloudEventChannel, __setSlackWorkspaceSettingsMirrorDepsForTesting, CLOUD_PUSH_ALLOWLIST } from '../cloudEventChannel';
import { SAFETY_ACTIVITY_LOG_MAX_ENTRIES } from '@core/safetyActivityLogTypes';

let httpServer: HttpServer;
let wss: WsServer;
let port: number;

// shape: PersistedToolApprovalRequest (pendingApprovalsStore.ts:21) — the catch-up
// route returns the persisted records, whose schema requires turnId/input/timestamp.
const pendingToolApprovals = [
  { toolUseID: 'tool-1', turnId: 'turn-1', toolName: 'Bash', input: {}, reason: 'Needs approval', timestamp: Date.now() },
];
// shape: ToolSafetyStagedCallBroadcast (approvalBroadcasts.ts:66) — staged-call
// catch-up forwards the sanitized staged DTO (sessionId/packageId/toolId/timestamp
// required). `status` is NOT a schema field (extra keys are tolerated by the
// non-strict parse + forwarded byte-identical), but the catch-up route filters on
// `status === 'pending'` (cloudEventChannel.ts:459) — so it must stay to select
// staged-1 and drop the executed staged-2.
const stagedCalls = [
  { id: 'staged-1', sessionId: 's1', status: 'pending', displayName: 'search_files', packageId: 'pkg', toolId: 'search_files', timestamp: Date.now() },
  { id: 'staged-2', sessionId: 's1', status: 'executed', displayName: 'old_call', packageId: 'pkg', toolId: 'old_call', timestamp: Date.now() },
];
const pendingMemoryApprovals = [
  {
    toolUseId: 'mem-1',
    originalTurnId: 'turn-1',
    originalSessionId: 'session-1',
    turnId: 'bg-turn-1',
    sessionId: 'bg-session-1',
    filePath: '/workspace/work/notes.md',
    spaceName: 'work',
    spacePath: 'work',
    summary: 'Save notes',
    content: 'test content',
    timestamp: Date.now(),
  },
];
const safetyActivityLogEntries = [
  {
    id: 'safety-eval-1',
    timestamp: 1_700_000_000_000,
    type: 'evaluation',
    toolDisplayName: 'Send Slack message',
    toolId: 'slack_send_message',
    actionSummary: 'Send a note to the team',
    decision: 'allowed',
    reason: 'Allowed by safety prompt',
    sessionType: 'interactive',
    source: 'safety-prompt',
    flagged: false,
  },
  {
    id: 'safety-version-1',
    timestamp: 1_700_000_000_100,
    type: 'version-change',
    fromVersion: 2,
    toVersion: 3,
    source: 'system',
  },
];
safetyActivityLogResponse = { entries: safetyActivityLogEntries };
toolPendingResponse = pendingToolApprovals;
stagedCallsResponse = stagedCalls;
memoryPendingResponse = pendingMemoryApprovals;

function handleIpcRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = decodeURIComponent(req.url || '');

  if (url.includes('tool-safety:pending')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(toolPendingResponse));
  } else if (url.includes('tool-safety:staged-get-all')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stagedCallsResponse));
  } else if (url.includes('memory:get-pending-approvals')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(memoryPendingResponse));
  } else if (url.includes('safety-activity-log:get')) {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        lastSafetyActivityLogRequestBody = body ? JSON.parse(body) : null;
      } catch {
        lastSafetyActivityLogRequestBody = body;
      }
      res.writeHead(safetyActivityLogStatus, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(safetyActivityLogResponse));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
}

beforeAll(() => {
  return new Promise<void>((resolve) => {
    httpServer = createServer(handleIpcRequest);
    wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url === '/api/events') {
        const auth = req.headers.authorization;
        if (auth !== 'Bearer test-token') {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws: WsClient) => {
          wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    httpServer.listen(0, () => {
      port = (httpServer.address() as { port: number }).port;
      resolve();
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  cloudEventChannel.disconnect();
  mockSend.mockClear();
  mockLogWarn.mockClear();
  mockLogInfo.mockClear();
  mockMergeEntries.mockReset();
  mockMergeEntries.mockImplementation((entries: unknown[]) => ({
    added: entries.length,
  }));
  warnLines.length = 0;
  mirroredSettings = {};
  lastSafetyActivityLogRequestBody = null;
  safetyActivityLogStatus = 200;
  safetyActivityLogResponse = { entries: safetyActivityLogEntries };
  toolPendingResponse = pendingToolApprovals;
  stagedCallsResponse = stagedCalls;
  memoryPendingResponse = pendingMemoryApprovals;
  __setSlackWorkspaceSettingsMirrorDepsForTesting(null);
});

afterAll(() => {
  return new Promise<void>((resolve) => {
    wss.close();
    httpServer.close(() => resolve());
  });
});

async function connectEventChannel(): Promise<void> {
  cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  expect(cloudEventChannel.isConnected).toBe(true);
}

describe('CloudEventChannel', () => {
  it('does not fetch pending events on initial connect (renderer does its own fetch)', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    expect(cloudEventChannel.isConnected).toBe(true);

    // On initial connect, no catch-up events should be dispatched
    const approvalCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'tool-safety:approval-request'
    );
    expect(approvalCalls).toHaveLength(0);
  });

  it('fetches pending events on reconnect (catch-up)', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(cloudEventChannel.isConnected).toBe(true);

    // Force a disconnect by closing all server-side clients
    wss.clients.forEach((ws: WsClient) => ws.close());
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    mockSend.mockClear();

    // Wait for reconnect (backoff starts at 1s with jitter)
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));

    expect(cloudEventChannel.isConnected).toBe(true);

    // After reconnect, pending events should be dispatched as catch-up
    const toolApprovalCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'tool-safety:approval-request'
    );
    expect(toolApprovalCalls).toHaveLength(1);
    expect(toolApprovalCalls[0][1]).toEqual(pendingToolApprovals[0]);

    const stagedCallCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'tool-safety:staged-call'
    );
    expect(stagedCallCalls).toHaveLength(1);
    expect(stagedCallCalls[0][1].id).toBe('staged-1');

    // The staged-call catch-up log must report the FILTERED count (only the
    // status:'pending' staged-1, not the executed staged-2). The fixture feeds a
    // 1-pending + 1-executed mix, so the count must be 1 (not the total of 2).
    expect(mockLogInfo).toHaveBeenCalledWith(
      { count: 1 },
      'Caught up on pending staged calls',
    );

    const memoryApprovalCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'memory:write-approval-request'
    );
    expect(memoryApprovalCalls).toHaveLength(1);
    const dispatched = memoryApprovalCalls[0][1] as Record<string, unknown>;
    // Flat shape should be normalized to nested destination
    expect(dispatched.destination).toBeDefined();
    const dest = dispatched.destination as Record<string, unknown>;
    expect(dest.path).toBe('/workspace/work/notes.md');
    expect(dest.spaceName).toBe('work');
    // Original flat fields preserved via spread
    expect(dispatched.toolUseId).toBe('mem-1');

    expect(lastSafetyActivityLogRequestBody).toEqual({
      params: [{ limit: SAFETY_ACTIVITY_LOG_MAX_ENTRIES }],
    });
    expect(mockMergeEntries).toHaveBeenCalledWith(safetyActivityLogEntries);
    expect(mockSend).toHaveBeenCalledWith(
      'safety-activity-log:updated',
      expect.objectContaining({ timestamp: expect.any(Number) }),
    );
  });

  it('drops a non-array tool-safety:pending catch-up response loudly while other sources still dispatch', async () => {
    toolPendingResponse = { not: 'an-array' };
    const stagingSpy = vi.fn();
    cloudEventChannel.onStagedFilesChanged(stagingSpy);
    await connectEventChannel();

    await (cloudEventChannel as unknown as { fetchPendingEvents(): Promise<void> }).fetchPendingEvents();

    // (a) the wrong-shape source dispatches nothing
    const toolApprovalCalls = mockSend.mock.calls.filter((c: unknown[]) => c[0] === 'tool-safety:approval-request');
    expect(toolApprovalCalls).toHaveLength(0);
    // (b) a loud invalid-shape warn fired for that channel
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'tool-safety:pending' }),
      'IPC catch-up returned an invalid response shape',
    );
    // (c) the other array sources still dispatch their items
    const stagedCallCalls = mockSend.mock.calls.filter((c: unknown[]) => c[0] === 'tool-safety:staged-call');
    expect(stagedCallCalls).toHaveLength(1);
    const memoryApprovalCalls = mockSend.mock.calls.filter((c: unknown[]) => c[0] === 'memory:write-approval-request');
    expect(memoryApprovalCalls).toHaveLength(1);
    // (d) the trailing staging bridge side-effect still fires
    expect(stagingSpy).toHaveBeenCalledTimes(1);
  });

  it('drops a non-array tool-safety:staged-get-all catch-up response loudly while other sources still dispatch', async () => {
    stagedCallsResponse = { not: 'an-array' };
    const stagingSpy = vi.fn();
    cloudEventChannel.onStagedFilesChanged(stagingSpy);
    await connectEventChannel();

    await (cloudEventChannel as unknown as { fetchPendingEvents(): Promise<void> }).fetchPendingEvents();

    const stagedCallCalls = mockSend.mock.calls.filter((c: unknown[]) => c[0] === 'tool-safety:staged-call');
    expect(stagedCallCalls).toHaveLength(0);
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'tool-safety:staged-get-all' }),
      'IPC catch-up returned an invalid response shape',
    );
    const toolApprovalCalls = mockSend.mock.calls.filter((c: unknown[]) => c[0] === 'tool-safety:approval-request');
    expect(toolApprovalCalls).toHaveLength(1);
    const memoryApprovalCalls = mockSend.mock.calls.filter((c: unknown[]) => c[0] === 'memory:write-approval-request');
    expect(memoryApprovalCalls).toHaveLength(1);
    expect(stagingSpy).toHaveBeenCalledTimes(1);
  });

  it('drops a non-array memory:get-pending-approvals catch-up response loudly while other sources still dispatch', async () => {
    memoryPendingResponse = { not: 'an-array' };
    const stagingSpy = vi.fn();
    cloudEventChannel.onStagedFilesChanged(stagingSpy);
    await connectEventChannel();

    await (cloudEventChannel as unknown as { fetchPendingEvents(): Promise<void> }).fetchPendingEvents();

    const memoryApprovalCalls = mockSend.mock.calls.filter((c: unknown[]) => c[0] === 'memory:write-approval-request');
    expect(memoryApprovalCalls).toHaveLength(0);
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'memory:get-pending-approvals' }),
      'IPC catch-up returned an invalid response shape',
    );
    const toolApprovalCalls = mockSend.mock.calls.filter((c: unknown[]) => c[0] === 'tool-safety:approval-request');
    expect(toolApprovalCalls).toHaveLength(1);
    const stagedCallCalls = mockSend.mock.calls.filter((c: unknown[]) => c[0] === 'tool-safety:staged-call');
    expect(stagedCallCalls).toHaveLength(1);
    expect(stagingSpy).toHaveBeenCalledTimes(1);
  });

  it('syncs safety activity log entries from the cloud response object and broadcasts after a non-empty merge', async () => {
    await connectEventChannel();

    const result = await cloudEventChannel.syncSafetyActivityLogFromCloud();

    expect(result).toEqual({ cloudSyncState: 'success' });
    expect(lastSafetyActivityLogRequestBody).toEqual({
      params: [{ limit: SAFETY_ACTIVITY_LOG_MAX_ENTRIES }],
    });
    expect(mockMergeEntries).toHaveBeenCalledTimes(1);
    expect(mockMergeEntries).toHaveBeenCalledWith(safetyActivityLogEntries);
    const mergedEntries = mockMergeEntries.mock.calls[0][0] as typeof safetyActivityLogEntries;
    expect(mergedEntries[1]).toEqual(
      expect.objectContaining({
        type: 'version-change',
        source: 'system',
      }),
    );
    expect(mockSend).toHaveBeenCalledWith(
      'safety-activity-log:updated',
      expect.objectContaining({ timestamp: expect.any(Number) }),
    );
  });

  it('drops malformed cloud safety activity log entries before merging and logs the drop', async () => {
    const malformedEntry = {
      id: 'malformed-entry',
      type: 'evaluation',
      toolDisplayName: 'Bad payload',
    };
    safetyActivityLogResponse = {
      entries: [safetyActivityLogEntries[0], malformedEntry],
    };
    await connectEventChannel();

    const result = await cloudEventChannel.syncSafetyActivityLogFromCloud();

    expect(result).toEqual({ cloudSyncState: 'success' });
    expect(mockMergeEntries).toHaveBeenCalledWith([safetyActivityLogEntries[0]]);
    expect(JSON.stringify(mockLogWarn.mock.calls)).toContain(
      'Dropped malformed safety activity log entry from cloud sync',
    );
    // FU-D "only when": a partial mix (>=1 valid entry survives) must NOT trigger
    // the all-dropped aggregate schema-skew warn — that fires solely when every
    // fetched row is dropped.
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      'All cloud safety-activity-log entries dropped during catch-up — possible desktop/cloud schema skew',
    );
  });

  it('returns failed when the safety activity log cloud response shape is invalid', async () => {
    safetyActivityLogResponse = { entries: 'not-an-array' };
    await connectEventChannel();

    const result = await cloudEventChannel.syncSafetyActivityLogFromCloud();

    expect(result).toEqual({ cloudSyncState: 'failed' });
    expect(mockMergeEntries).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalledWith(
      'safety-activity-log:updated',
      expect.anything(),
    );
  });

  it('treats an all-malformed safety activity log entry set as a successful no-op', async () => {
    safetyActivityLogResponse = {
      entries: [
        { id: 'malformed-entry-1', type: 'evaluation' },
        { id: 'malformed-entry-2', source: 'system' },
      ],
    };
    await connectEventChannel();

    const result = await cloudEventChannel.syncSafetyActivityLogFromCloud();

    // Pins valid response shape + all dropped entries as success/no-broadcast so any future change is deliberate.
    expect(result).toEqual({ cloudSyncState: 'success' });
    expect(mockMergeEntries).toHaveBeenCalledWith([]);
    expect(mockSend).not.toHaveBeenCalledWith(
      'safety-activity-log:updated',
      expect.anything(),
    );
  });

  it('emits a distinct schema-skew warn when every fetched safety activity log entry is dropped (FU-D)', async () => {
    safetyActivityLogResponse = {
      entries: [
        { id: 'malformed-entry-1', type: 'evaluation' },
        { id: 'malformed-entry-2', source: 'system' },
      ],
    };
    await connectEventChannel();

    const result = await cloudEventChannel.syncSafetyActivityLogFromCloud();

    // FU-D: the all-dropped aggregate warn fires...
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ fetched: 2, channel: 'safety-activity-log:get' }),
      'All cloud safety-activity-log entries dropped during catch-up — possible desktop/cloud schema skew',
    );
    // ...while the success / merge([]) noop / no-broadcast contract is unchanged.
    expect(result).toEqual({ cloudSyncState: 'success' });
    expect(mockMergeEntries).toHaveBeenCalledWith([]);
    expect(mockSend).not.toHaveBeenCalledWith(
      'safety-activity-log:updated',
      expect.anything(),
    );
  });

  it('does not broadcast after a valid safety activity log sync when no entries are added', async () => {
    mockMergeEntries.mockImplementation(() => ({ added: 0 }));
    await connectEventChannel();

    const result = await cloudEventChannel.syncSafetyActivityLogFromCloud();

    expect(result).toEqual({ cloudSyncState: 'success' });
    expect(mockMergeEntries).toHaveBeenCalledWith(safetyActivityLogEntries);
    expect(mockSend).not.toHaveBeenCalledWith(
      'safety-activity-log:updated',
      expect.anything(),
    );
  });

  it('returns failed when the safety activity log fetch fails', async () => {
    safetyActivityLogStatus = 500;
    await connectEventChannel();

    const result = await cloudEventChannel.syncSafetyActivityLogFromCloud();

    expect(result).toEqual({ cloudSyncState: 'failed' });
    expect(mockMergeEntries).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'safety-activity-log:get',
        status: 500,
      }),
      'IPC fetch failed during catch-up',
    );
  });

  it('returns failed instead of hanging when the safety activity log fetch times out', async () => {
    await connectEventChannel();
    vi.useFakeTimers();
    let abortSignal: AbortSignal | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      abortSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (!abortSignal) {
          reject(new Error('Expected timeout signal'));
          return;
        }
        abortSignal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const resultPromise = cloudEventChannel.syncSafetyActivityLogFromCloud();

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(resultPromise).resolves.toEqual({ cloudSyncState: 'failed' });
    expect(abortSignal?.aborted).toBe(true);
    expect(mockMergeEntries).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'Failed to sync safety activity log from cloud',
    );
  });

  it('returns failed when merging fetched safety activity log entries throws', async () => {
    mockMergeEntries.mockImplementation(() => {
      throw new Error('store write failed');
    });
    await connectEventChannel();

    const result = await cloudEventChannel.syncSafetyActivityLogFromCloud();

    expect(result).toEqual({ cloudSyncState: 'failed' });
    expect(mockSend).not.toHaveBeenCalledWith(
      'safety-activity-log:updated',
      expect.anything(),
    );
  });

  it('returns not-configured or offline before attempting a cloud safety activity log fetch', async () => {
    await expect(
      cloudEventChannel.syncSafetyActivityLogFromCloud(),
    ).resolves.toEqual({
      cloudSyncState: 'not-configured',
    });

    (
      cloudEventChannel as unknown as { cloudUrl: string; token: string }
    ).cloudUrl = `http://localhost:${port}`;
    (
      cloudEventChannel as unknown as { cloudUrl: string; token: string }
    ).token = 'test-token';
    await expect(
      cloudEventChannel.syncSafetyActivityLogFromCloud(),
    ).resolves.toEqual({
      cloudSyncState: 'offline',
    });
    expect(lastSafetyActivityLogRequestBody).toBeNull();
    expect(mockMergeEntries).not.toHaveBeenCalled();
  });

  it('dispatches push events from WS to renderer (args format)', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // Server pushes an event using the args format (what cloudEventBroadcaster sends)
    wss.clients.forEach((ws: WsClient) => {
      // shape: ToolSafetyStagedCallBroadcast (src/main/index.ts:5304 real emit)
      ws.send(JSON.stringify({
        channel: 'tool-safety:staged-call',
        args: [{ id: 'new-staged', sessionId: 's1', displayName: 'create_file', packageId: 'pkg', toolId: 'create_file', timestamp: Date.now() }],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const stagedPush = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'tool-safety:staged-call' && (c[1] as { id?: string } | undefined)?.id === 'new-staged'
    );
    expect(stagedPush).toHaveLength(1);
  });

  it('dispatches push events with legacy payload format', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // Legacy payload format (backwards compat) — use an allowlisted channel
    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'memory:update-status',
        payload: { value: 42 },
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const legacyCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'memory:update-status'
    );
    expect(legacyCalls).toHaveLength(1);
    expect(legacyCalls[0][1]).toEqual({ value: 42 });
  });

  it('disconnects cleanly', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(cloudEventChannel.isConnected).toBe(true);
    cloudEventChannel.disconnect();
    expect(cloudEventChannel.isConnected).toBe(false);
  });

  it('handles malformed events gracefully', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    wss.clients.forEach((ws: WsClient) => {
      ws.send('not-valid-json');
      ws.send(JSON.stringify({ noChannel: true }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    // Should not throw — verify channel is still connected
    expect(cloudEventChannel.isConnected).toBe(true);
  });

  it('blocks channels not in cloud push allowlist (inbox:state, user-tasks:state, unknown)', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // Cloud pushes state channels — ALL should be blocked (not in allowlist)
    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'inbox:state',
        args: [{ version: 4, items: [{ id: 'cloud-item', title: 'From cloud' }], history: [] }],
      }));
      ws.send(JSON.stringify({
        channel: 'user-tasks:state',
        args: [{ tasks: [{ id: 'cloud-task' }] }],
      }));
      ws.send(JSON.stringify({
        channel: 'some-future-channel:state',
        args: [{ data: 'should be blocked by default' }],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const inboxCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'inbox:state'
    );
    const taskCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'user-tasks:state'
    );
    const futureCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'some-future-channel:state'
    );
    expect(inboxCalls).toHaveLength(0);
    expect(taskCalls).toHaveLength(0);
    expect(futureCalls).toHaveLength(0);
  });

  it('forwards agent:route-plan-resolved cloud pushes so cloud-executed turns update the renderer route cache', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    const payload = {
      sessionId: 'session-cloud-1',
      turnAuthLabel: 'openrouter',
      resolvedAt: 1_700_000_000_000,
    };

    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'agent:route-plan-resolved',
        args: [payload],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const routeCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'agent:route-plan-resolved',
    );
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0][1]).toEqual(payload);
  });

  it('forwards session:activity-summary-generated cloud pushes so cloud-generated summaries live-swap the disclosure label', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    const payload = {
      sessionId: 'session-cloud-1',
      turnId: 'turn-cloud-1',
      summary: 'Searched three reports and drafted a one-page summary.',
    };

    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'session:activity-summary-generated',
        args: [payload],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const summaryCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'session:activity-summary-generated',
    );
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0][1]).toEqual(payload);
  });

  it('forwards session:title-generated cloud pushes so cloud-generated titles live-swap the sidebar', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    const payload = {
      sessionId: 'session-cloud-1',
      title: 'Quarterly Sales Review',
      autoTitleGeneratedAt: 1_700_000_000_000,
      autoTitleTurnCount: 1,
    };

    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'session:title-generated',
        args: [payload],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const titleCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'session:title-generated',
    );
    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0][1]).toEqual(payload);
  });

  it('drops session:title-generated when it is removed from the allowlist (proves the allowlist gate is load-bearing)', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    const wasAllowlisted = CLOUD_PUSH_ALLOWLIST.delete('session:title-generated');
    expect(wasAllowlisted).toBe(true);
    try {
      wss.clients.forEach((ws: WsClient) => {
        ws.send(JSON.stringify({
          channel: 'session:title-generated',
          args: [{ sessionId: 's1', title: 'should be dropped' }],
        }));
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      const titleCalls = mockSend.mock.calls.filter(
        (c: unknown[]) => c[0] === 'session:title-generated',
      );
      expect(titleCalls).toHaveLength(0);
    } finally {
      // Restore so this test cannot poison the shared module-level allowlist.
      CLOUD_PUSH_ALLOWLIST.add('session:title-generated');
    }
  });

  it('drops session:activity-summary-generated when it is removed from the allowlist (proves the allowlist gate is load-bearing)', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    const wasAllowlisted = CLOUD_PUSH_ALLOWLIST.delete('session:activity-summary-generated');
    expect(wasAllowlisted).toBe(true);
    try {
      wss.clients.forEach((ws: WsClient) => {
        ws.send(JSON.stringify({
          channel: 'session:activity-summary-generated',
          args: [{ sessionId: 's1', turnId: 't1', summary: 'should be dropped' }],
        }));
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      const summaryCalls = mockSend.mock.calls.filter(
        (c: unknown[]) => c[0] === 'session:activity-summary-generated',
      );
      expect(summaryCalls).toHaveLength(0);
    } finally {
      // Restore so this test cannot poison the shared module-level allowlist.
      CLOUD_PUSH_ALLOWLIST.add('session:activity-summary-generated');
    }
  });

  it('forwards allowlisted cloud events (tool-safety, memory, etc.)', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    wss.clients.forEach((ws: WsClient) => {
      // shape: ToolSafetyApprovalRequestBroadcast (turnId/input/timestamp required)
      ws.send(JSON.stringify({
        channel: 'tool-safety:approval-request',
        args: [{ toolUseID: 'tool-99', turnId: 'turn-99', toolName: 'Bash', input: {}, timestamp: Date.now() }],
      }));
      ws.send(JSON.stringify({
        channel: 'memory:staged-files-changed',
        args: [],
      }));
      ws.send(JSON.stringify({
        channel: 'cloud:session-conflict',
        args: [{ sessionId: 'session-1', conflictType: 'concurrent-edit', detectedAt: Date.now() }],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const approvalCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'tool-safety:approval-request'
    );
    const stagingCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'memory:staged-files-changed'
    );
    const conflictCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'cloud:session-conflict'
    );
    expect(approvalCalls.length).toBeGreaterThanOrEqual(1);
    expect(stagingCalls.length).toBeGreaterThanOrEqual(1);
    expect(conflictCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('suppresses cloud:session-conflict events with source "desktop"', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'cloud:session-conflict',
        args: [{ sessionId: 'session-1', conflictType: 'stale-metadata', detectedAt: Date.now(), source: 'desktop' }],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const conflictCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'cloud:session-conflict'
    );
    expect(conflictCalls).toHaveLength(0);
  });

  it('forwards cloud:session-conflict events with source "mobile"', async () => {
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'cloud:session-conflict',
        args: [{ sessionId: 'session-1', conflictType: 'stale-metadata', detectedAt: Date.now(), source: 'mobile' }],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const conflictCalls = mockSend.mock.calls.filter(
      (c: unknown[]) => c[0] === 'cloud:session-conflict'
    );
    expect(conflictCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('mirrors valid slack:workspace-changed pushes into local settings synchronously', async () => {
    __setSlackWorkspaceSettingsMirrorDepsForTesting({
      getSettings: () => mirroredSettings as never,
      updateSettings: (partial) => {
        mirroredSettings = { ...mirroredSettings, ...partial } as typeof mirroredSettings;
      },
      log: { warn: (...args: unknown[]) => warnLines.push(args), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'slack:workspace-changed',
        args: [{ teamId: 'T1', teamName: 'Acme', status: 'connected', occurredAt: 1_714_000_000_000 }],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(mirroredSettings.experimental?.cloudSlackWorkspace).toEqual({
      teamId: 'T1',
      teamName: 'Acme',
      status: 'connected',
      occurredAt: 1_714_000_000_000,
    });
    expect(warnLines).toHaveLength(0);
  });

  it('mirrors peerInstanceCount from slack:workspace-changed when present', async () => {
    __setSlackWorkspaceSettingsMirrorDepsForTesting({
      getSettings: () => mirroredSettings as never,
      updateSettings: (partial) => {
        mirroredSettings = { ...mirroredSettings, ...partial } as typeof mirroredSettings;
      },
      log: { warn: (...args: unknown[]) => warnLines.push(args), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'slack:workspace-changed',
        args: [{ teamId: 'T1', teamName: 'Acme', status: 'connected', peerInstanceCount: 3, occurredAt: 1_714_000_000_000 }],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(mirroredSettings.experimental?.cloudSlackWorkspace).toEqual({
      teamId: 'T1',
      teamName: 'Acme',
      status: 'connected',
      peerInstanceCount: 3,
      occurredAt: 1_714_000_000_000,
    });
    expect(warnLines).toHaveLength(0);
  });

  it('drops invalid slack:workspace-changed pushes without changing settings and logs a warning', async () => {
    mirroredSettings = {
      experimental: {
        cloudSlackWorkspace: { teamId: 'T-old', teamName: 'Old', status: 'connected', occurredAt: 1 },
      },
    };
    __setSlackWorkspaceSettingsMirrorDepsForTesting({
      getSettings: () => mirroredSettings as never,
      updateSettings: (partial) => {
        mirroredSettings = { ...mirroredSettings, ...partial } as typeof mirroredSettings;
      },
      log: { warn: (...args: unknown[]) => warnLines.push(args), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'slack:workspace-changed',
        args: [{ teamId: 'T1', status: 'connected', occurredAt: 1_714_000_000_000 }],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(mirroredSettings.experimental?.cloudSlackWorkspace).toEqual({
      teamId: 'T-old',
      teamName: 'Old',
      status: 'connected',
      occurredAt: 1,
    });
    expect(JSON.stringify(warnLines)).toContain('settings not updated');
  });

  it('mirrors slack:workspace-disconnected pushes as disconnected while preserving workspace name', async () => {
    mirroredSettings = {
      experimental: {
        cloudSlackWorkspace: { teamId: 'T1', teamName: 'Acme', status: 'connected', occurredAt: 1 },
      },
    };
    __setSlackWorkspaceSettingsMirrorDepsForTesting({
      getSettings: () => mirroredSettings as never,
      updateSettings: (partial) => {
        mirroredSettings = { ...mirroredSettings, ...partial } as typeof mirroredSettings;
      },
      log: { warn: (...args: unknown[]) => warnLines.push(args), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    cloudEventChannel.connect(`http://localhost:${port}`, 'test-token');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    wss.clients.forEach((ws: WsClient) => {
      ws.send(JSON.stringify({
        channel: 'slack:workspace-disconnected',
        args: [{ teamId: 'T1', reason: 'tokens_revoked', occurredAt: 1_714_000_001_000 }],
      }));
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(mirroredSettings.experimental?.cloudSlackWorkspace).toEqual({
      teamId: 'T1',
      teamName: 'Acme',
      status: 'disconnected',
      occurredAt: 1_714_000_001_000,
    });
  });
});
