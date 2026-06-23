/**
 * Full E2E integration tests for the cloud-client API contract.
 *
 * Boots a real cloud-service instance, reads the API key from
 * TEST_CLAUDE_API_KEY env var (or falls back to the local device's
 * app-settings.json), then exercises the full stack:
 *   - Pairing (health + authenticated endpoint)
 *   - Session CRUD
 *   - Event channel (real WS)
 *   - Agent turn (real Anthropic API call)
 *   - Multi-turn conversation
 *   - Stop turn
 *   - 401 rejection
 *
 * Requires: cloud-service/dist/server.mjs to be built.
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

// Paths — cloud-client/src/__tests__/ → repo root is 3 levels up
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'cloud-service', 'dist', 'server.mjs');

const PORT = 19876;
const TEST_TOKEN = 'e2e-test-token-not-a-secret';
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;

// Mock mode uses synthetic agent turns (fast, deterministic, no API key needed).
// Live mode uses real Anthropic API (slow, exercises full executor path).
// Default: mock enabled. Set REBEL_MOCK_AGENT_TURNS=0 for live mode.
const MOCK_MODE = (process.env.REBEL_MOCK_AGENT_TURNS ?? '1') === '1';
const TURN_TIMEOUT = MOCK_MODE ? 15_000 : 60_000;
const POST_TURN_WAIT = MOCK_MODE ? 500 : 1_000;
const TEST_TIMEOUT = MOCK_MODE ? 30_000 : 90_000;
const MULTI_TURN_TIMEOUT = MOCK_MODE ? 30_000 : 120_000;

let serverProcess: ChildProcess;
let dataDir: string;

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };
}

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Cloud-service did not start within ${timeoutMs}ms (waited ${Date.now() - start}ms)`);
}

/** Read API key from env var, or fall back to local macOS device settings. */
function readApiKey(): string | null {
  if (process.env.TEST_CLAUDE_API_KEY) return process.env.TEST_CLAUDE_API_KEY;

  // Fallback: macOS local device settings
  const settingsPath = path.join(
    process.env.HOME || '',
    'Library',
    'Application Support',
    'mindstone-rebel',
    'app-settings.json',
  );
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return settings?.claude?.apiKey || null;
  } catch {
    return null;
  }
}

// Runtime deps externalized by cloud-service/build.mjs that must be resolvable.
// Single source of truth: cloud-service/runtimeExternals.json
import CLOUD_SERVICE_EXTERNALS from '../../../cloud-service/runtimeExternals.json';

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

function hasRequiredFiles(): boolean {
  // Mock mode doesn't need a real API key — only the server bundle and runtime deps.
  if (MOCK_MODE) return fs.existsSync(SERVER_PATH) && hasExternalDeps();
  return fs.existsSync(SERVER_PATH) && readApiKey() !== null && hasExternalDeps();
}

// Skip the entire suite if prerequisites aren't met
const describeIf = hasRequiredFiles() ? describe : describe.skip;

describeIf('E2E Integration (real cloud-service)', () => {
  beforeAll(async () => {
    // Create temp data dir
    dataDir = path.join('/tmp', `rebel-cloud-client-e2e-${Date.now()}`);
    fs.mkdirSync(dataDir, { recursive: true });

    // Write settings with the API key (placeholder in mock mode)
    const apiKey = readApiKey() ?? 'mock-api-key-not-used';
    const workspace = path.join(dataDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'app-settings.json'),
      JSON.stringify({ claude: { apiKey }, coreDirectory: workspace }, null, 2),
    );

    // Start cloud-service (cwd must be repo root for rebel-system path resolution)
    serverProcess = spawn('node', [SERVER_PATH], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        REBEL_USER_DATA: dataDir,
        REBEL_CLOUD_TOKEN: TEST_TOKEN,
        IS_CLOUD_SERVICE: '1',
        ...(MOCK_MODE ? { REBEL_MOCK_AGENT_TURNS: '1' } : {}),
      },
      stdio: 'pipe',
    });

    // Pipe full stdout/stderr through prefixed writers so a slow-but-healthy
    // bootstrap is distinguishable from a crash on slow CI runners.
    serverProcess.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(`[cloud-service:stderr] ${d.toString()}`);
    });
    serverProcess.stdout?.on('data', (d: Buffer) => {
      process.stderr.write(`[cloud-service:stdout] ${d.toString()}`);
    });
    serverProcess.on('exit', (code, signal) => {
      process.stderr.write(`[cloud-service] exited code=${code} signal=${signal}\n`);
    });

    await waitForServer();
  }, 90_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // ---- Pairing Flow ----

  describe('pairing', () => {
    it('health check succeeds without auth', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });

    it('rejects unauthenticated requests', async () => {
      const res = await fetch(`${BASE_URL}/api/settings`);
      expect(res.status).toBe(401);
    });

    it('accepts correct token and returns settings', async () => {
      const res = await fetch(`${BASE_URL}/api/settings`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const settings = await res.json();
      expect(settings).toHaveProperty('models');
      expect(settings.models).toHaveProperty('apiKey');
    });

    it('rejects wrong token', async () => {
      const res = await fetch(`${BASE_URL}/api/settings`, {
        headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(401);
    });
  });

  // ---- Session CRUD ----

  describe('sessions', () => {
    it('lists sessions (initially may have existing or empty)', async () => {
      const res = await fetch(`${BASE_URL}/api/sessions?summaries=true`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('sessions');
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(typeof body.totalCount).toBe('number');
    });

    it('creates and retrieves a session', async () => {
      const session = {
        id: 'e2e-test-session-crud',
        title: 'E2E Test',
        messages: [{ id: 'msg-1', turnId: 't1', role: 'user', text: 'Hello', createdAt: Date.now() }],
        eventsByTurn: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const putRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(session),
      });
      expect(putRes.status).toBe(200);

      const getRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, { headers: authHeaders() });
      expect(getRes.status).toBe(200);
      const retrieved = await getRes.json();
      expect(retrieved.id).toBe('e2e-test-session-crud');
      expect(retrieved.title).toBe('E2E Test');
      expect(retrieved.messages).toHaveLength(1);
    });

    it('deletes a session', async () => {
      const delRes = await fetch(`${BASE_URL}/api/sessions/e2e-test-session-crud`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      expect(delRes.status).toBe(200);
    });
  });

  // ---- Event Channel (WebSocket) ----

  describe('event channel', () => {
    it('connects with auth and receives session-changed broadcast', async () => {
      // This uses Node.js ws module (not browser WebSocket)
      const WebSocket = require('ws');

      const received: unknown[] = [];
      const ws = new WebSocket(`${WS_URL}/api/events`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('WS connect timeout'));
        }, 5000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('error', (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        });
      });

      ws.on('message', (data: Buffer) => {
        received.push(JSON.parse(data.toString()));
      });

      // Trigger a session-changed event by creating a session
      await fetch(`${BASE_URL}/api/sessions/e2e-event-test`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          id: 'e2e-event-test',
          title: 'Event Test',
          messages: [],
          eventsByTurn: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      });

      // Wait for the broadcast
      await new Promise((r) => setTimeout(r, 500));

      ws.close();

      const sessionEvent = received.find(
        (e: unknown) => (e as { channel: string }).channel === 'cloud:session-changed',
      );
      expect(sessionEvent).toBeDefined();
      expect((sessionEvent as { args: unknown[] }).args[0]).toEqual(
        expect.objectContaining({ sessionId: 'e2e-event-test', action: 'upserted' }),
      );

      // Cleanup
      await fetch(`${BASE_URL}/api/sessions/e2e-event-test`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
    }, 10_000);

    it('rejects event WS without auth', async () => {
      const WebSocket = require('ws');

      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`${WS_URL}/api/events`);
        ws.on('close', () => resolve());
        ws.on('error', () => resolve());
      });
    });
  });

  // ---- Agent Turn WS (Real Anthropic API) ----

  describe('agent turn', () => {
    const createdSessions: string[] = [];

    afterAll(async () => {
      for (const id of createdSessions) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'DELETE', headers: authHeaders(),
        }).catch(() => {});
      }
    });

    it('completes a single-turn conversation with real AI response', async () => {
      const WebSocket = require('ws');
      const sessionId = `e2e-turn-${Date.now()}`;
      createdSessions.push(sessionId);
      const events: { type: string; [key: string]: unknown }[] = [];

      const ws = new WebSocket(`${WS_URL}/api/agent/turn`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('error', (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        });
      });

      // Send the turn request
      ws.send(
        JSON.stringify({
          sessionId,
          prompt: 'Reply with exactly the word "pong" and nothing else.',
        }),
      );

      // Collect events until result or error, or timeout
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`Agent turn timed out. Events received: ${JSON.stringify(events.map((e) => e.type))}`));
        }, TURN_TIMEOUT);

        ws.on('message', (data: Buffer) => {
          const event = JSON.parse(data.toString());
          events.push(event);
          if (event.type === 'result' || event.type === 'error') {
            clearTimeout(timeout);
            resolve();
          }
        });

        ws.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // --- Protocol invariants (always asserted) ---

      // Verify event sequence
      const types = events.map((e) => e.type);
      expect(types).toContain('turn_started');
      expect(types.some((t) => t === 'result' || t === 'error')).toBe(true);

      // Check turn_started has a turnId
      const turnStarted = events.find((e) => e.type === 'turn_started');
      expect(turnStarted?.turnId).toBeDefined();

      // There should be at least one assistant or assistant_delta event
      const hasAssistant = types.includes('assistant') || types.includes('assistant_delta');
      expect(hasAssistant).toBe(true);

      // Verify the assistant produced a response
      const assistantEvents = events.filter((e) => e.type === 'assistant' || e.type === 'assistant_delta');
      expect(assistantEvents.length).toBeGreaterThan(0);

      // Collect all text from assistant events
      const fullText = assistantEvents
        .map((e) => (e.text as string) || '')
        .join('');

      // --- Mode-specific assertions ---
      if (MOCK_MODE) {
        // Mock mode can return either legacy "[mock]..." prefixed text or deterministic literal mock replies.
        expect(fullText).toMatch(/^\[mock\]|pong/i);
      } else {
        expect(fullText.toLowerCase()).toContain('pong');
      }

      // Verify session was persisted with messages
      await new Promise((r) => setTimeout(r, POST_TURN_WAIT));
      const sessionRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(sessionRes.status).toBe(200);
      const session = (await sessionRes.json()) as { messages: { role: string }[] };
      const userMsgs = session.messages.filter((m) => m.role === 'user');
      const assistantMsgs = session.messages.filter((m) => m.role === 'assistant' || m.role === 'result');
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

      // Cleanup
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
    }, TEST_TIMEOUT);

    it('completes a multi-turn conversation with memory across turns', async () => {
      const WebSocket = require('ws');
      const sessionId = `e2e-multi-${Date.now()}`;
      createdSessions.push(sessionId);

      async function sendTurn(prompt: string): Promise<{ type: string; [key: string]: unknown }[]> {
        const events: { type: string; [key: string]: unknown }[] = [];

        const ws = new WebSocket(`${WS_URL}/api/agent/turn`, {
          headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        });

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
          ws.on('open', () => {
            clearTimeout(timeout);
            resolve();
          });
          ws.on('error', (e: Error) => {
            clearTimeout(timeout);
            reject(e);
          });
        });

        ws.send(JSON.stringify({ sessionId, prompt }));

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error(`Turn timed out for "${prompt}". Events: ${JSON.stringify(events.map((e) => e.type))}`));
          }, TURN_TIMEOUT);

          ws.on('message', (data: Buffer) => {
            const event = JSON.parse(data.toString());
            events.push(event);
            if (event.type === 'result' || event.type === 'error') {
              clearTimeout(timeout);
              resolve();
            }
          });

          ws.on('close', () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        return events;
      }

      // --- Protocol invariants (always asserted) ---

      // Turn 1: establish a fact
      const turn1 = await sendTurn('My favorite number is 42. Just say "ok got it" and nothing else.');
      expect(turn1.map((e) => e.type)).toContain('turn_started');
      expect(turn1.some((e) => e.type === 'result')).toBe(true);

      // Wait for session persistence
      await new Promise((r) => setTimeout(r, POST_TURN_WAIT));

      // Verify session was persisted with messages
      const sessionAfterTurn1 = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(sessionAfterTurn1.status).toBe(200);
      const session1 = (await sessionAfterTurn1.json()) as { messages: { role: string; text: string }[] };
      expect(session1.messages.length).toBeGreaterThanOrEqual(2); // user + assistant/result

      // Turn 2: recall the fact (proves conversation memory works)
      const turn2 = await sendTurn('What is my favorite number? Reply with just the number.');
      expect(turn2.map((e) => e.type)).toContain('turn_started');
      expect(turn2.some((e) => e.type === 'result')).toBe(true);

      // Verify different turn IDs
      const turn1Id = turn1.find((e) => e.type === 'turn_started')?.turnId;
      const turn2Id = turn2.find((e) => e.type === 'turn_started')?.turnId;
      expect(turn1Id).not.toBe(turn2Id);

      // Turn 2 response text
      const turn2Text = turn2
        .filter((e) => e.type === 'assistant' || e.type === 'assistant_delta' || e.type === 'result')
        .map((e) => (e.text as string) || '')
        .join('');

      // --- Mode-specific assertions ---
      if (MOCK_MODE) {
        // Mock mode can return either legacy "[mock]..." prefixed text or deterministic literal mock replies.
        expect(turn2Text).toMatch(/^\[mock\]|42/);
      } else {
        // Live mode: turn 2 should recall "42" from conversation memory
        expect(turn2Text).toMatch(/42/);
      }

      // Verify final session has messages from both turns
      await new Promise((r) => setTimeout(r, POST_TURN_WAIT));
      const sessionAfterTurn2 = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(sessionAfterTurn2.status).toBe(200);
      const session2 = (await sessionAfterTurn2.json()) as { messages: { role: string; text: string }[] };
      expect(session2.messages.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant/result

      // Cleanup
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
    }, MULTI_TURN_TIMEOUT);

    it('rejects turn WS without auth', async () => {
      const WebSocket = require('ws');

      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`${WS_URL}/api/agent/turn`);
        ws.on('close', () => resolve());
        ws.on('error', () => resolve());
      });
    });

    it('handles missing sessionId gracefully', async () => {
      const WebSocket = require('ws');
      const events: unknown[] = [];

      const ws = new WebSocket(`${WS_URL}/api/agent/turn`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('error', (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        });
      });

      ws.send(JSON.stringify({ prompt: 'no session id' }));

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve();
        }, 3000);
        ws.on('message', (data: Buffer) => {
          events.push(JSON.parse(data.toString()));
        });
        ws.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      const errorEvent = events.find((e: unknown) => (e as { type: string }).type === 'error');
      expect(errorEvent).toBeDefined();
    }, 10_000);

    it('supports query-param auth for WS (mobile compatibility)', async () => {
      const WebSocket = require('ws');

      // Connect using query-param auth (like the mobile app does)
      const ws = new WebSocket(`${WS_URL}/api/agent/turn?token=${encodeURIComponent(TEST_TOKEN)}`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('error', (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        });
      });

      // If we got here, auth succeeded
      ws.close();
    });

    it('supports query-param auth for event WS', async () => {
      const WebSocket = require('ws');

      const ws = new WebSocket(`${WS_URL}/api/events?token=${encodeURIComponent(TEST_TOKEN)}`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('error', (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        });
      });

      ws.close();
    });
  });

  // ---- Stop Turn ----

  // Stop-turn requires a slow real API call — mock completes in ~60ms,
  // making stop impossible to test reliably.
  const stopDescribe = MOCK_MODE ? describe.skip : describe;

  stopDescribe('stop turn', () => {
    const createdSessions: string[] = [];

    afterAll(async () => {
      for (const id of createdSessions) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'DELETE', headers: authHeaders(),
        }).catch(() => {});
      }
    });

    it('stops an active turn', async () => {
      const WebSocket = require('ws');
      const sessionId = `e2e-stop-${Date.now()}`;
      createdSessions.push(sessionId);
      let turnId: string | null = null;

      const ws = new WebSocket(`${WS_URL}/api/agent/turn`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('error', (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        });
      });

      // Send a prompt that should take a while
      ws.send(
        JSON.stringify({
          sessionId,
          prompt: 'Write a very long 500-word essay about the history of computing.',
        }),
      );

      // Wait for turn_started to get the turnId
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 10_000);
        ws.on('message', (data: Buffer) => {
          const event = JSON.parse(data.toString());
          if (event.type === 'turn_started' && event.turnId) {
            turnId = event.turnId;
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      expect(turnId).not.toBeNull();

      // Stop the turn
      const stopRes = await fetch(`${BASE_URL}/api/agent/stop`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ turnId }),
      });
      expect(stopRes.status).toBe(200);

      // Wait for the WS to close or get a result/error
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve();
        }, 5000);
        ws.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.on('message', (data: Buffer) => {
          const event = JSON.parse(data.toString());
          if (event.type === 'result' || event.type === 'error') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      // Cleanup
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
    }, 30_000);
  });
});
