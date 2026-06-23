/**
 * R2 Stage 3a-D1 (260502 plan): cloud WebSocket ingress regression tests.
 *
 * Validates that the post-cutover ingress correctly:
 *   (a) routes `turn_started` to the turnId-resolution branch
 *   (b) rejects pre-`turnId` `error` with the error message (using the
 *       `error` field, not `message`)
 *   (c) handles `turn_persisted` post-`turnId` without dispatching it to `onEvent`
 *   (d) handles `turn_in_flight` post-`turnId` without dispatching it to `onEvent`
 *   (e) forwards manifest-valid AgentEvents post-`turnId` to `onEvent`
 *   (f) drops manifest-rejected AgentEvents post-`turnId` (log + counter)
 *   (g) drops non-control frames pre-`turn_started` (log + counter)
 *   (x) [Phase-2 P1] turnId-mismatch on `turn_in_flight` is logged + counted
 *   (y) [Phase-2 P1] log-spam guard: bounded raw-message preview
 *   (z) [Phase-2 P0-1 SCHEMA-COLLISION GUARD] real AgentEvent `error`
 *       post-`turnId` routes to `onEvent` (NOT silently dropped via control-
 *       frame branch). Without `.strict()` on control schemas, this test fails.
 *
 * Refs: docs/plans/260502_r2_stage3a_residual_implementation_plan.md § S3a-D1
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'module';
import type { RawData } from 'ws';

type WebSocket = import('ws').default;

const { mockRecordTurnPersistenceAckStatus } = vi.hoisted(() => ({
  mockRecordTurnPersistenceAckStatus: vi.fn(),
}));

vi.mock('../cloudContinuityMetadata', () => ({
  recordTurnPersistenceAckStatus: (...args: Parameters<typeof mockRecordTurnPersistenceAckStatus>) =>
    mockRecordTurnPersistenceAckStatus(...args),
}));

const require = createRequire(import.meta.url);
const ws = require('ws');
const WebSocketServer = ws.Server as typeof import('ws').WebSocketServer;

import { CloudServiceClient } from '../cloudServiceClient';
import { cloudIngressRejectionCounter, RAW_MESSAGE_LOG_PREVIEW_LIMIT, truncateRawMessageForLog } from '../cloudIngressMetrics';
import { buildAgentEvent } from '@shared/contracts/agentEventManifest';

let httpServer: HttpServer;
let wss: InstanceType<typeof WebSocketServer>;
let baseUrl: string;
let port: number;

beforeAll(async () => {
  httpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  wss = new WebSocketServer({ server: httpServer, path: '/api/agent/turn' });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (addr && typeof addr !== 'string') {
        port = addr.port;
        baseUrl = `http://127.0.0.1:${port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const TOKEN = 'test-bearer-token';
let client: CloudServiceClient;

beforeEach(() => {
  cloudIngressRejectionCounter.reset();
  mockRecordTurnPersistenceAckStatus.mockReset();
  client = new CloudServiceClient(baseUrl, TOKEN);
  // Remove all connection handlers from previous tests to avoid double-firing
  wss.removeAllListeners('connection');
});

afterEach(() => {
  client.disconnect();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// (a) turn_started routes to turnId-resolution branch
// ---------------------------------------------------------------------------
describe('R2 S3a-D1 (a) turn_started control frame', () => {
  it('routes to turnId resolution and resolves the promise', async () => {
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-a1' }));
        setTimeout(() => sock.close(1000), 30);
      });
    });
    const { turnId } = await client.startAgentTurn(
      { prompt: 'hi', sessionId: 's1' },
      vi.fn(),
    );
    expect(turnId).toBe('turn-a1');
    expect(mockRecordTurnPersistenceAckStatus).toHaveBeenCalledWith('s1', 'turn-a1', 'in_flight');
  });

  it('accepts supportsPersistedAck:true on turn_started', async () => {
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-a2', supportsPersistedAck: true }));
        setTimeout(() => sock.close(1000), 30);
      });
    });
    const { turnId } = await client.startAgentTurn(
      { prompt: 'hi', sessionId: 's1' },
      vi.fn(),
    );
    expect(turnId).toBe('turn-a2');
  });
});

// ---------------------------------------------------------------------------
// (b) error pre-turnId rejects with error message (uses `error` field)
// ---------------------------------------------------------------------------
describe('R2 S3a-D1 (b) pre-turnId error control frame', () => {
  it('rejects the promise with error message from `error` field (not `message`)', async () => {
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'error', error: 'session not found' }));
        sock.close(1003);
      });
    });
    await expect(
      client.startAgentTurn({ prompt: 'x', sessionId: 'bad' }, vi.fn()),
    ).rejects.toThrow(/session not found/);
  });
});

// ---------------------------------------------------------------------------
// (c) turn_persisted post-turnId is silent no-op
// (d) turn_in_flight post-turnId is silent no-op
// ---------------------------------------------------------------------------
describe('R2 S3a-D1 (c, d) post-turnId lifecycle control frames', () => {
  it('silently no-ops turn_persisted; onEvent NOT invoked', async () => {
    const onEvent = vi.fn();
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-c1' }));
        setTimeout(() => {
          sock.send(JSON.stringify({
            type: 'turn_persisted',
            clientTurnId: 'cli-1',
            turnId: 'turn-c1',
            sessionId: 's1',
            status: 'completed',
          }));
        }, 10);
        setTimeout(() => sock.close(1000), 50);
      });
    });
    await client.startAgentTurn({ prompt: 'p', sessionId: 's1' }, onEvent);
    await new Promise((r) => setTimeout(r, 100));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('silently no-ops turn_in_flight; onEvent NOT invoked', async () => {
    const onEvent = vi.fn();
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-d1' }));
        setTimeout(() => {
          sock.send(JSON.stringify({
            type: 'turn_in_flight',
            clientTurnId: 'cli-1',
            turnId: 'turn-d1',
            sessionId: 's1',
            status: 'in_flight',
          }));
        }, 10);
        setTimeout(() => sock.close(1000), 50);
      });
    });
    await client.startAgentTurn({ prompt: 'p', sessionId: 's1' }, onEvent);
    await new Promise((r) => setTimeout(r, 100));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('records ack statuses for turn_persisted and turn_in_flight control frames', async () => {
    const onEvent = vi.fn();
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-ack-1' }));
        setTimeout(() => {
          sock.send(JSON.stringify({
            type: 'turn_in_flight',
            clientTurnId: 'cli-ack',
            turnId: 'turn-ack-1',
            sessionId: 's1',
            status: 'in_flight',
          }));
        }, 10);
        setTimeout(() => {
          sock.send(JSON.stringify({
            type: 'turn_persisted',
            clientTurnId: 'cli-ack',
            turnId: 'turn-ack-1',
            sessionId: 's1',
            status: 'persisted',
          }));
        }, 20);
        setTimeout(() => sock.close(1000), 60);
      });
    });

    await client.startAgentTurn({ prompt: 'p', sessionId: 's1' }, onEvent);
    await new Promise((r) => setTimeout(r, 100));

    expect(onEvent).not.toHaveBeenCalled();
    expect(mockRecordTurnPersistenceAckStatus).toHaveBeenCalledWith('s1', 'turn-ack-1', 'in_flight');
    expect(mockRecordTurnPersistenceAckStatus).toHaveBeenCalledWith('s1', 'turn-ack-1', 'persisted');
  });
});

// ---------------------------------------------------------------------------
// (e) valid AgentEvent post-turnId passes through to onEvent
// ---------------------------------------------------------------------------
describe('R2 S3a-D1 (e) manifest-valid AgentEvent post-turnId', () => {
  it('forwards a status AgentEvent to onEvent', async () => {
    const onEvent = vi.fn();
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-e1' }));
        setTimeout(() => {
          sock.send(JSON.stringify({
            type: 'status',
            message: 'thinking',
            timestamp: 1700000000000,
            sessionId: 's1',
            turnId: 'turn-e1',
          }));
        }, 10);
        setTimeout(() => sock.close(1000), 60);
      });
    });
    await client.startAgentTurn({ prompt: 'p', sessionId: 's1' }, onEvent);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      type: 'status',
      message: 'thinking',
      timestamp: 1700000000000,
    });
  });
});

// ---------------------------------------------------------------------------
// (f) malformed AgentEvent post-turnId is dropped (log + counter)
// ---------------------------------------------------------------------------
describe('R2 S3a-D1 (f) manifest-rejected AgentEvent post-turnId', () => {
  it('drops malformed event; counter increments with manifest-reject reason', async () => {
    const onEvent = vi.fn();
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-f1' }));
        setTimeout(() => {
          // Type 'status' is a real AgentEvent type, but missing required `timestamp`
          // — should fail manifest validation.
          sock.send(JSON.stringify({ type: 'status', message: 'no-timestamp' }));
        }, 10);
        setTimeout(() => sock.close(1000), 60);
      });
    });
    await client.startAgentTurn({ prompt: 'p', sessionId: 's1' }, onEvent);
    await new Promise((r) => setTimeout(r, 100));
    expect(onEvent).not.toHaveBeenCalled();
    const snap = cloudIngressRejectionCounter.snapshot();
    expect(snap.byReason['manifest-reject']).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// (g) non-control frame pre-turn_started is dropped (log + counter)
// ---------------------------------------------------------------------------
describe('R2 S3a-D1 (g) non-control frame pre-turn_started', () => {
  it('drops the frame; counter increments with pre-turnstarted-non-control reason', async () => {
    let resolveDone: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const onEvent = vi.fn();
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        // Send something that doesn't match control schema before turn_started.
        // Use a manifest-valid AgentEvent to demonstrate the gating.
        sock.send(JSON.stringify({
          type: 'status',
          message: 'premature',
          timestamp: 1700000000000,
        }));
        setTimeout(() => {
          sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-g1' }));
        }, 20);
        setTimeout(() => {
          sock.close(1000);
          resolveDone();
        }, 60);
      });
    });
    await client.startAgentTurn({ prompt: 'p', sessionId: 's1' }, onEvent);
    await done;
    await new Promise((r) => setTimeout(r, 30));
    const snap = cloudIngressRejectionCounter.snapshot();
    expect(snap.byReason['pre-turnstarted-non-control']).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// (x) [Phase-2 P1] turnId-mismatch on turn_in_flight
// ---------------------------------------------------------------------------
describe('R2 S3a-D1 (x) [Phase-2 P1] turnId-mismatch guard', () => {
  it('logs + counts turn_in_flight with mismatched turnId', async () => {
    const onEvent = vi.fn();
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-x1' }));
        setTimeout(() => {
          sock.send(JSON.stringify({
            type: 'turn_in_flight',
            clientTurnId: 'cli-1',
            turnId: 'turn-DIFFERENT',
            sessionId: 's1',
            status: 'in_flight',
          }));
        }, 10);
        setTimeout(() => sock.close(1000), 60);
      });
    });
    await client.startAgentTurn({ prompt: 'p', sessionId: 's1' }, onEvent);
    await vi.waitFor(() => {
      const snap = cloudIngressRejectionCounter.snapshot();
      expect(snap.byReason['turnid-mismatch']).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });
  });
});

// ---------------------------------------------------------------------------
// (y) [Phase-2 P1] log-spam guard: bounded raw-message preview
// ---------------------------------------------------------------------------
describe('R2 S3a-D1 (y) [Phase-2 P1] log-spam guard', () => {
  it('truncates raw messages to RAW_MESSAGE_LOG_PREVIEW_LIMIT', () => {
    const longMessage = 'x'.repeat(RAW_MESSAGE_LOG_PREVIEW_LIMIT + 500);
    const truncated = truncateRawMessageForLog(longMessage);
    expect(truncated.length).toBeLessThan(longMessage.length);
    expect(truncated).toMatch(/\[truncated; full length=\d+\]$/);
  });

  it('preserves short messages unchanged', () => {
    const shortMessage = 'short';
    expect(truncateRawMessageForLog(shortMessage)).toBe('short');
  });

  it('handles unserializable inputs gracefully', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic; // creates a cycle
    expect(truncateRawMessageForLog(cyclic)).toBe('<unserializable>');
  });

  it('counter does not saturate over 1000 malformed messages', async () => {
    cloudIngressRejectionCounter.reset();
    for (let i = 0; i < 1000; i++) {
      cloudIngressRejectionCounter.inc({ reason: 'manifest-reject' });
    }
    const snap = cloudIngressRejectionCounter.snapshot();
    expect(snap.byReason['manifest-reject']).toBe(1000);
    expect(snap.total).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// (z) [Phase-2 P0-1 SCHEMA-COLLISION GUARD]
//     Real AgentEvent `error` post-turnId MUST route to onEvent, NOT be
//     silently dropped via the control-frame branch.
// ---------------------------------------------------------------------------
describe('R2 S3a-D1 (z) [Phase-2 P0-1] AgentEvent error schema-collision guard', () => {
  it('real AgentEvent error post-turnId routes to onEvent (NOT control-frame branch)', async () => {
    const onEvent = vi.fn();
    // Construct a real AgentEvent of type 'error' via buildAgentEvent.error
    // — guaranteed to be manifest-conformant. Includes envelope axes
    // (sessionId, turnId) and payload axes (error message, kind, etc.).
    const realError = buildAgentEvent.error(
      {
        error: 'tool failed',
        errorSource: 'main',
        errorKind: 'mcp_error',
        timestamp: 1700000000000,
      },
      { sessionId: 's1', turnId: 'turn-z1' },
    );
    wss.on('connection', (sock: WebSocket) => {
      sock.once('message', () => {
        sock.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-z1' }));
        setTimeout(() => {
          // This event has the same `{ type: 'error', error: string }` prefix
          // as the control-frame error. Without `.strict()` on the control
          // schema, Zod would strip the envelope fields and incorrectly
          // accept this as a control frame (silently dropping it).
          sock.send(JSON.stringify(realError));
        }, 10);
        setTimeout(() => sock.close(1000), 60);
      });
    });
    await client.startAgentTurn({ prompt: 'p', sessionId: 's1' }, onEvent);

    // Critical: onEvent MUST be invoked. If `.strict()` is not on the control
    // error schema, this fails — the AgentEvent error is silently dropped.
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      type: 'error',
      error: 'tool failed',
      errorKind: 'mcp_error',
    });

    // The control-frame post-turnId-error counter MUST NOT have incremented:
    // a real AgentEvent error MUST NOT be classified as a control frame.
    const snap = cloudIngressRejectionCounter.snapshot();
    expect(snap.byReason['post-turnstarted-control-error']).toBe(0);
  });
});
