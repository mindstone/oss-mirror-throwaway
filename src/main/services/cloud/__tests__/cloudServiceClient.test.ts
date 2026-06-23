import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'module';
import type { RawData } from 'ws';

type WebSocket = import('ws').default;

// Root resolves ws@7 (transitive via chrome-remote-interface) which lacks
// named WebSocketServer export. Use createRequire for stable CJS resolution.
const require = createRequire(import.meta.url);
const ws = require('ws');
const _WebSocket = ws as typeof import('ws').default;
const WebSocketServer = ws.Server as typeof import('ws').WebSocketServer;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { CloudServiceClient, CloudServiceError } from '../cloudServiceClient';

// ---------------------------------------------------------------------------
// Test HTTP server
// ---------------------------------------------------------------------------

let httpServer: HttpServer;
let wss: InstanceType<typeof WebSocketServer>;
let baseUrl: string;
let port: number;

/** Registered route handlers for the test server. */
const routes = new Map<string, (req: IncomingMessage, res: ServerResponse, body: string) => void>();

function addRoute(
  methodAndPath: string,
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): void {
  routes.set(methodAndPath, handler);
}

function clearRoutes(): void {
  routes.clear();
}

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const key = `${req.method} ${req.url}`;
      const handler = routes.get(key);
      if (handler) {
        handler(req, res, body);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Route not found' }));
      }
    });
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

afterEach(() => {
  clearRoutes();
  wss.removeAllListeners('connection');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudServiceClient', () => {
  const TOKEN = 'test-bearer-token';
  let client: CloudServiceClient;

  beforeEach(() => {
    client = new CloudServiceClient(baseUrl, TOKEN);
  });

  afterEach(() => {
    client.disconnect();
  });

  // =========================================================================
  // HTTP method routing
  // =========================================================================

  describe('HTTP methods', () => {
    it('GET sends correct method and auth header', async () => {
      let receivedAuth = '';
      addRoute('GET /api/test', (req, res) => {
        receivedAuth = req.headers.authorization ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });

      const result = await client.get('/api/test');
      expect(result).toEqual({ ok: true });
      expect(receivedAuth).toBe(`Bearer ${TOKEN}`);
    });

    it('POST sends JSON body', async () => {
      let receivedBody = '';
      let receivedContentType = '';
      addRoute('POST /api/test', (req, res, body) => {
        receivedBody = body;
        receivedContentType = req.headers['content-type'] ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });

      await client.post('/api/test', { key: 'value' });
      expect(receivedContentType).toBe('application/json');
      expect(JSON.parse(receivedBody)).toEqual({ key: 'value' });
    });

    it('PUT sends JSON body', async () => {
      let receivedBody = '';
      addRoute('PUT /api/sessions/abc', (req, res, body) => {
        receivedBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });

      const result = await client.put('/api/sessions/abc', { name: 'updated' });
      expect(result).toEqual({ success: true });
      expect(JSON.parse(receivedBody)).toEqual({ name: 'updated' });
    });

    it('PATCH sends JSON body', async () => {
      let receivedMethod = '';
      addRoute('PATCH /api/settings', (req, res) => {
        receivedMethod = req.method ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updated: true }));
      });

      await client.patch('/api/settings', { voice: {} });
      expect(receivedMethod).toBe('PATCH');
    });

    it('DELETE sends correct method', async () => {
      let receivedMethod = '';
      addRoute('DELETE /api/sessions/xyz', (req, res) => {
        receivedMethod = req.method ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: true }));
      });

      const result = await client.delete('/api/sessions/xyz');
      expect(result).toEqual({ deleted: true });
      expect(receivedMethod).toBe('DELETE');
    });

    it('handles 204 No Content', async () => {
      addRoute('DELETE /api/sessions/no-content', (_req, res) => {
        res.writeHead(204);
        res.end();
      });

      const result = await client.delete('/api/sessions/no-content');
      expect(result).toBeUndefined();
    });
  });

  // =========================================================================
  // Auth header injection
  // =========================================================================

  describe('auth header', () => {
    it('includes Bearer token on every request', async () => {
      const authHeaders: string[] = [];

      addRoute('GET /api/a', (req, res) => {
        authHeaders.push(req.headers.authorization ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      addRoute('POST /api/b', (req, res) => {
        authHeaders.push(req.headers.authorization ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });

      await client.get('/api/a');
      await client.post('/api/b');

      expect(authHeaders).toEqual([
        `Bearer ${TOKEN}`,
        `Bearer ${TOKEN}`,
      ]);
    });

    it('includes a stable X-Rebel-Client-Id header on every request', async () => {
      const clientIds: string[] = [];

      addRoute('GET /api/a', (req, res) => {
        clientIds.push((req.headers['x-rebel-client-id'] as string) ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      addRoute('POST /api/b', (req, res) => {
        clientIds.push((req.headers['x-rebel-client-id'] as string) ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });

      await client.get('/api/a');
      await client.post('/api/b');

      expect(clientIds).toHaveLength(2);
      expect(clientIds[0]).toBeTruthy();
      expect(clientIds[0]).toBe(clientIds[1]);
    });
  });

  // =========================================================================
  // Error parsing
  // =========================================================================

  describe('error handling', () => {
    it('parses JSON error body from cloud service', async () => {
      addRoute('GET /api/fail', (_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'INVALID_PARAMS', message: 'Bad request' }));
      });

      await expect(client.get('/api/fail')).rejects.toThrow(CloudServiceError);
      try {
        await client.get('/api/fail');
      } catch (err) {
        expect(err).toBeInstanceOf(CloudServiceError);
        const cloudErr = err as CloudServiceError;
        expect(cloudErr.code).toBe('INVALID_PARAMS');
        expect(cloudErr.message).toBe('Bad request');
        expect(cloudErr.statusCode).toBe(400);
      }
    });

    it('handles non-JSON error response', async () => {
      addRoute('GET /api/html-error', (_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Internal Server Error</h1>');
      });

      await expect(client.get('/api/html-error')).rejects.toThrow(CloudServiceError);
      try {
        await client.get('/api/html-error');
      } catch (err) {
        const cloudErr = err as CloudServiceError;
        expect(cloudErr.code).toBe('CLOUD_HTTP_ERROR');
        expect(cloudErr.statusCode).toBe(500);
      }
    });

    it('throws CLOUD_UNREACHABLE for network errors', async () => {
      const badClient = new CloudServiceClient('http://127.0.0.1:1', TOKEN);

      await expect(badClient.get('/api/test')).rejects.toThrow(CloudServiceError);
      try {
        await badClient.get('/api/test');
      } catch (err) {
        const cloudErr = err as CloudServiceError;
        expect(cloudErr.code).toBe('CLOUD_UNREACHABLE');
      }
    });
  });

  // =========================================================================
  // Health check
  // =========================================================================

  describe('healthCheck', () => {
    it('returns true when cloud service is healthy', async () => {
      addRoute('GET /api/health', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });

      const result = await client.healthCheck();
      expect(result).toBe(true);
    });

    it('returns false when cloud service returns error', async () => {
      addRoute('GET /api/health', (_req, res) => {
        res.writeHead(500);
        res.end();
      });

      const result = await client.healthCheck();
      expect(result).toBe(false);
    });

    it('returns false when cloud service is unreachable', async () => {
      const badClient = new CloudServiceClient('http://127.0.0.1:1', TOKEN);
      const result = await badClient.healthCheck();
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // WebSocket agent turn
  // =========================================================================

  describe('startAgentTurn', () => {
    it('sends request and receives turn_started + events', async () => {
      // R2 Stage 3a-D1 (260502 plan): post-cutover ingress now manifest-validates
      // AgentEvents. Pre-cutover fixtures used `{ type: 'result', content: 'done' }`
      // (wrong field; manifest expects `text`) and `status` events missing `timestamp`
      // and envelope axes (sessionId, turnId). Updated to manifest-conformant shapes.
      const events: unknown[] = [];

      wss.on('connection', (ws: WebSocket) => {
        ws.once('message', (data: RawData) => {
          const request = JSON.parse(data.toString());
          expect(request.prompt).toBe('hello');
          expect(request.sessionId).toBe('session-1');

          // Send turn_started (control frame — pre-turnId)
          ws.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-abc' }));

          // Stream manifest-conformant AgentEvents (post-turnId)
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'status',
              message: 'thinking',
              timestamp: 1700000001000,
              sessionId: 'session-1',
              turnId: 'turn-abc',
            }));
          }, 10);
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'result',
              text: 'done',
              timestamp: 1700000002000,
              sessionId: 'session-1',
              turnId: 'turn-abc',
            }));
          }, 20);
          setTimeout(() => {
            ws.close(1000, 'Turn completed');
          }, 50);
        });
      });

      const request = { prompt: 'hello', sessionId: 'session-1' };
      const { turnId } = await client.startAgentTurn(request, (event) => {
        events.push(event);
      });

      expect(turnId).toBe('turn-abc');

      // Wait for events to stream
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(events.length).toBeGreaterThanOrEqual(1);
      // `AgentEventSchemaFromManifest` is built via `discriminatedUnionFromManifest`
      // which uses Zod default (non-strict) object mode — envelope axes
      // (sessionId, turnId) sent on the wire are STRIPPED at parse time. The
      // renderer doesn't depend on them; pre-cutover the cast forwarded them
      // transparently as "unknown extra fields" that no consumer accessed.
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'thinking',
        timestamp: 1700000001000,
      });
    });

    it('rejects when cloud service sends error before turn_started', async () => {
      wss.on('connection', (ws: WebSocket) => {
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
          ws.close(1003, 'Bad request');
        });
      });

      await expect(
        client.startAgentTurn({ prompt: 'test', sessionId: 'bad' }, vi.fn()),
      ).rejects.toThrow(CloudServiceError);
    });

    it('rejects when WS closes before turn_started', async () => {
      wss.on('connection', (ws: WebSocket) => {
        ws.close(1011, 'Server error');
      });

      await expect(
        client.startAgentTurn({ prompt: 'test', sessionId: 's1' }, vi.fn()),
      ).rejects.toThrow(CloudServiceError);
    });
  });

  // =========================================================================
  // disconnect
  // =========================================================================

  describe('disconnect', () => {
    it('closes active WebSocket', async () => {
      let serverWs: WebSocket | null = null;
      wss.on('connection', (ws: WebSocket) => {
        serverWs = ws;
        ws.once('message', () => {
          ws.send(JSON.stringify({ type: 'turn_started', turnId: 'turn-d1' }));
          // Don't close — keep streaming
        });
      });

      await client.startAgentTurn({ prompt: 'long', sessionId: 's1' }, vi.fn());

      client.disconnect();

      // Wait a moment for close to propagate
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(serverWs).not.toBeNull();
    });

    it('is safe to call multiple times', () => {
      client.disconnect();
      client.disconnect();
      // No error thrown
    });
  });
});
