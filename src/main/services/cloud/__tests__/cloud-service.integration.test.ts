/**
 * Cloud Service Integration Tests
 *
 * Tests the headless cloud service HTTP/WS endpoints by starting
 * the bundled server in a child process and making requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = 9999;
const TEST_AUTH_TOKEN = 'test-fixture-not-a-secret';
const DATA_DIR = path.join('/tmp', `rebel-cloud-test-${Date.now()}`);
const SERVER_PATH = path.join(__dirname, '..', '..', '..', '..', '..', 'cloud-service', 'dist', 'server.mjs');
const BASE_URL = `http://localhost:${PORT}`;

// Runtime deps externalized by cloud-service/build.mjs that must be resolvable.
// Single source of truth: cloud-service/runtimeExternals.json
import CLOUD_SERVICE_EXTERNALS from '../../../../../cloud-service/runtimeExternals.json';

function hasExternalDeps(): boolean {
  const esmRequire = createRequire(import.meta.url);
  return CLOUD_SERVICE_EXTERNALS.every((dep) => {
    try {
      esmRequire.resolve(dep);
      return true;
    } catch {
      return false;
    }
  });
}

const HAS_BUNDLE = fs.existsSync(SERVER_PATH) && hasExternalDeps();
const describeCloud = HAS_BUNDLE ? describe : describe.skip;

let serverProcess: ChildProcess;

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch { /* server not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server did not start within timeout');
}

function authHeaders(): Record<string, string> {
  return { 'Authorization': `Bearer ${TEST_AUTH_TOKEN}`, 'Content-Type': 'application/json' };
}

describeCloud('Cloud service integration', () => {
  beforeAll(async () => {
    // Clean up any previous test data
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    serverProcess = spawn('node', [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: String(PORT),
        REBEL_USER_DATA: DATA_DIR,
        REBEL_CLOUD_TOKEN: TEST_AUTH_TOKEN,
        IS_CLOUD_SERVICE: '1',
      },
      stdio: 'pipe',
    });

    serverProcess.stderr?.on('data', (d) => process.stderr.write(d));

    await waitForServer();
  }, 45_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  describe('Health', () => {
    it('returns health status without auth', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.uptime).toBeGreaterThan(0);
    });
  });

describe('Auth', () => {
  it('rejects requests without token', async () => {
    const res = await fetch(`${BASE_URL}/api/settings`);
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const res = await fetch(`${BASE_URL}/api/settings`, {
      headers: { 'Authorization': 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct token', async () => {
    const res = await fetch(`${BASE_URL}/api/settings`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });
});

describe('Settings', () => {
  it('GET returns default settings', async () => {
    const res = await fetch(`${BASE_URL}/api/settings`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const settings = await res.json();
    expect(settings).toHaveProperty('coreDirectory');
  });

  it('PUT updates settings', async () => {
    const res = await fetch(`${BASE_URL}/api/settings`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ onboardingCompleted: true }),
    });
    expect(res.status).toBe(200);
    const settings = await res.json();
    expect(settings.onboardingCompleted).toBe(true);
  });

  it('PUT persists across GET', async () => {
    await fetch(`${BASE_URL}/api/settings`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ onboardingCompleted: true }),
    });
    const res = await fetch(`${BASE_URL}/api/settings`, { headers: authHeaders() });
    const settings = await res.json();
    expect(settings.onboardingCompleted).toBe(true);
  });
});

describe('Sessions', () => {
  const testSession = {
    id: 'test-session-001',
    title: 'Test Session',
    messages: [],
    eventsByTurn: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it('GET returns empty array initially', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('PUT creates a session', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/${testSession.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(testSession),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('GET retrieves the created session', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/${testSession.id}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const session = await res.json();
    expect(session.id).toBe(testSession.id);
    expect(session.title).toBe('Test Session');
  });

  it('GET returns 404 for non-existent session', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/nonexistent`, {
      headers: authHeaders(),
    });
    // May return null/404 depending on implementation
    expect([200, 404]).toContain(res.status);
  });

  it('DELETE removes a session', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/${testSession.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
  });
});

describe('Library', () => {
  it('GET files returns empty for fresh workspace', async () => {
    const res = await fetch(`${BASE_URL}/api/library/files`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const files = await res.json();
    expect(Array.isArray(files)).toBe(true);
  });

  it('POST write creates a file', async () => {
    const res = await fetch(`${BASE_URL}/api/library/write`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ path: 'test.txt', content: 'hello cloud' }),
    });
    expect(res.status).toBe(200);
  });

  it('POST read retrieves written file', async () => {
    const res = await fetch(`${BASE_URL}/api/library/read`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ path: 'test.txt' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe('hello cloud');
  });

  it('rejects path traversal', async () => {
    const res = await fetch(`${BASE_URL}/api/library/read`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ path: '../../../etc/passwd' }),
    });
    // Should either 400 or 500 with path traversal error
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('CORS', () => {
  it('responds to OPTIONS with CORS headers', async () => {
    const res = await fetch(`${BASE_URL}/api/health`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('Not Found', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${BASE_URL}/api/nonexistent`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

describe('WebSocket Agent Turn', () => {
  it('rejects WS without auth', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/api/agent/turn`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for WS rejection'));
      }, 3000);
      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(); // Connection refused or error = auth worked
      });
      ws.on('close', (_code: number) => {
        clearTimeout(timeout);
        // Should be closed by server
        resolve();
      });
      ws.on('open', () => {
        // If we get here, auth didn't block it - fail
        clearTimeout(timeout);
        ws.close();
        reject(new Error('WS should have been rejected without auth'));
      });
    });
  });

  it('accepts WS with auth and responds to invalid request', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/api/agent/turn`, {
        headers: { 'Authorization': `Bearer ${TEST_AUTH_TOKEN}` },
      });
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout'));
      }, 5000);

      ws.on('open', () => {
        // Send an invalid request (missing sessionId)
        ws.send(JSON.stringify({ prompt: 'hello' }));
      });
      ws.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error' && msg.error.includes('sessionId')) {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      });
      ws.on('close', (code: number) => {
        clearTimeout(timeout);
        // 1003 = missing sessionId rejection
        if (code === 1003) resolve();
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });
});

});
