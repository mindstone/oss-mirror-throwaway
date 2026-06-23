import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { PushNotificationOptions } from '../services/pushNotificationService';

const { mockRegistry } = vi.hoisted(() => ({
  mockRegistry: {
    getActiveTurnController: vi.fn() as ReturnType<typeof vi.fn>,
    getTurnCloseCallback: vi.fn() as ReturnType<typeof vi.fn>,
    subscribeTurnCleanup: vi.fn(() => () => {}) as ReturnType<typeof vi.fn>,
  },
}));

vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  }),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: mockRegistry,
}));

vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
}));

vi.mock('../services/pushNotificationService', () => ({
  sendPushNotification: vi.fn<(options: PushNotificationOptions) => Promise<void>>(async () => {}),
}));

import { handleAgentStop } from '../routes/agent';

function makeRequest(body: unknown): http.IncomingMessage {
  const req = Object.create(http.IncomingMessage.prototype) as http.IncomingMessage & {
    _body: string;
  };
  req.method = 'POST';
  req._body = JSON.stringify(body);

  const chunks: Buffer[] = [Buffer.from(req._body)];
  let onDataCb: ((chunk: Buffer) => void) | null = null;
  let onEndCb: (() => void) | null = null;

  req.on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'data') {
      onDataCb = cb as (chunk: Buffer) => void;
      queueMicrotask(() => {
        for (const chunk of chunks) onDataCb?.(chunk);
      });
    }
    if (event === 'end') {
      onEndCb = cb as () => void;
      queueMicrotask(() => queueMicrotask(() => onEndCb?.()));
    }
    return req;
  }) as unknown as typeof req.on;

  return req;
}

function makeResponse(): http.ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) {
      res._status = status;
      return res;
    },
    end(body?: string) {
      res._body = body ?? '';
    },
  } as unknown as http.ServerResponse & { _status: number; _body: string };
  return res;
}

describe('handleAgentStop — force-kill escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRegistry.getActiveTurnController.mockReset();
    mockRegistry.getTurnCloseCallback.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the controller and returns success', async () => {
    const controller = new AbortController();
    mockRegistry.getActiveTurnController.mockReturnValue(controller);
    const req = makeRequest({ turnId: 'turn-1' });
    const res = makeResponse();

    await handleAgentStop(req, res);

    expect(res._status).toBe(200);
    expect(controller.signal.aborted).toBe(true);
  });

  it('escalates to Query.close() after 10s if turn is still active', async () => {
    const controller = new AbortController();
    const closeCallback = vi.fn();
    mockRegistry.getActiveTurnController.mockReturnValue(controller);
    mockRegistry.getTurnCloseCallback.mockReturnValue(closeCallback);
    const req = makeRequest({ turnId: 'turn-1' });
    const res = makeResponse();

    await handleAgentStop(req, res);
    expect(closeCallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);

    expect(closeCallback).toHaveBeenCalledTimes(1);
  });

  it('does not call Query.close() if turn completes before 10s', async () => {
    const controller = new AbortController();
    const closeCallback = vi.fn();
    let turnActive = true;
    mockRegistry.getActiveTurnController.mockImplementation(() => (turnActive ? controller : undefined));
    mockRegistry.getTurnCloseCallback.mockReturnValue(closeCallback);
    const req = makeRequest({ turnId: 'turn-1' });
    const res = makeResponse();

    await handleAgentStop(req, res);

    // Simulate turn completing before timeout
    turnActive = false;
    vi.advanceTimersByTime(10_000);

    expect(closeCallback).not.toHaveBeenCalled();
  });

  it('immediately force-kills on re-stop of already-aborted turn', async () => {
    const controller = new AbortController();
    controller.abort(); // Already aborted
    const closeCallback = vi.fn();
    mockRegistry.getActiveTurnController.mockReturnValue(controller);
    mockRegistry.getTurnCloseCallback.mockReturnValue(closeCallback);
    const req = makeRequest({ turnId: 'turn-1' });
    const res = makeResponse();

    await handleAgentStop(req, res);

    expect(res._status).toBe(200);
    expect(closeCallback).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when turn is not found', async () => {
    mockRegistry.getActiveTurnController.mockReturnValue(undefined);
    const req = makeRequest({ turnId: 'turn-nonexistent' });
    const res = makeResponse();

    await handleAgentStop(req, res);

    expect(res._status).toBe(404);
  });
});
