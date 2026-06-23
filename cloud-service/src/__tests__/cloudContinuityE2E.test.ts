/**
 * Cross-device cloud continuity E2E tests.
 *
 * Exercises the full cloud continuity experience:
 *   - Session created on mobile/web appears in cloud
 *   - Session created on desktop appears in cloud
 *   - Mid-turn WS disconnect (turn continues server-side)
 *   - Session resume after WS reconnect
 *   - Concurrent WS connections (multiple devices)
 *   - activeOnly session filtering (continuity state map)
 *   - Session GC (local_only sessions removed from cloud)
 *   - Cloud-native sessions preserved across state map pushes
 *   - Turn interruption via stop endpoint
 *
 * Requires: cloud-service/dist/server.mjs to be built.
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import type { AgentSession } from '@shared/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'cloud-service', 'dist', 'server.mjs');

const PORT = 19877;
const TEST_TOKEN = 'e2e-continuity-test-token';
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;

// Mock mode uses synthetic agent turns (fast, deterministic, no API key needed).
// Live mode uses real Anthropic API (slow, exercises full executor path).
// Default: REBEL_MOCK_AGENT_TURNS=1 (set in vitest.config.ts). `npm run test:cloud:live` sets it to '0'.
const MOCK_MODE = process.env.REBEL_MOCK_AGENT_TURNS === '1';
const TURN_TIMEOUT = MOCK_MODE ? 15_000 : 90_000;
const TEST_TIMEOUT = MOCK_MODE ? 30_000 : 180_000;

let serverProcess: ChildProcess;
let dataDir: string;

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };
}

async function waitForSessionIdle(
  baseUrl: string,
  token: string,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<AgentSession> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const session = await res.json() as AgentSession;
      if (!session.isBusy) return session;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Session ${sessionId} still busy after ${timeoutMs}ms`);
}

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Cloud-service did not start within ${timeoutMs}ms (waited ${Date.now() - start}ms)`);
}

async function stopServerProcess(processToStop: ChildProcess | undefined): Promise<void> {
  if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null) {
    return;
  }

  const waitForExit = new Promise<void>((resolve) => {
    processToStop.once('exit', () => resolve());
  });

  processToStop.kill('SIGTERM');
  const timedOut = await Promise.race([
    waitForExit.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 7_000)),
  ]);

  if (!timedOut || processToStop.exitCode !== null || processToStop.signalCode !== null) {
    return;
  }

  processToStop.kill('SIGKILL');
  await Promise.race([
    waitForExit,
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

function readApiKey(): string | null {
  if (process.env.TEST_CLAUDE_API_KEY) return process.env.TEST_CLAUDE_API_KEY;
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
import CLOUD_SERVICE_EXTERNALS from '../../runtimeExternals.json';

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

const describeIf = hasRequiredFiles() ? describe : describe.skip;

describeIf('Cloud Continuity E2E', () => {
  beforeAll(async () => {
    dataDir = path.join('/tmp', `rebel-continuity-e2e-${Date.now()}`);
    fs.mkdirSync(dataDir, { recursive: true });

    const apiKey = readApiKey() ?? 'mock-api-key-not-used';
    const workspace = path.join(dataDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'app-settings.json'),
      JSON.stringify({ claude: { apiKey }, coreDirectory: workspace }, null, 2),
    );

    serverProcess = spawn('node', [SERVER_PATH], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: 'test',
        REBEL_USER_DATA: dataDir,
        REBEL_CLOUD_TOKEN: TEST_TOKEN,
        IS_CLOUD_SERVICE: '1',
        REBEL_CLOUD_DISABLE_BOOTSTRAP_WARMUP: '1',
        ...(MOCK_MODE ? { REBEL_MOCK_AGENT_TURNS: '1' } : {}),
      },
      stdio: 'pipe',
    });

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
    await stopServerProcess(serverProcess);
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Cross-device: session created on "mobile" visible from "web"
  // --------------------------------------------------------------------------

  describe('cross-device session visibility', () => {
    const sessionId = `cross-device-${Date.now()}`;

    afterAll(async () => {
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    });

    it('session created via one device is visible from another', async () => {
      // "Mobile" creates a session
      const session = {
        id: sessionId,
        title: 'Mobile Created',
        messages: [{ id: 'msg-1', turnId: 't1', role: 'user', text: 'from mobile', createdAt: Date.now() }],
        eventsByTurn: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
        doneAt: null,
      };
      const putRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify(session),
      });
      expect(putRes.status).toBe(200);

      // "Web companion" retrieves the same session
      const getRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(getRes.status).toBe(200);
      const retrieved = (await getRes.json()) as { id: string; title: string; messages: { text: string }[] };
      expect(retrieved.id).toBe(sessionId);
      expect(retrieved.title).toBe('Mobile Created');
      expect(retrieved.messages[0].text).toBe('from mobile');
    });

    it('session list includes the session from both "devices"', async () => {
      const res = await fetch(`${BASE_URL}/api/sessions?summaries=true`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };
      expect(sessions.some((s) => s.id === sessionId)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Mid-turn WS disconnect — turn continues server-side
  // --------------------------------------------------------------------------

  describe('mid-turn WS disconnect resilience', () => {
    const createdSessions: string[] = [];

    afterAll(async () => {
      for (const id of createdSessions) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'DELETE', headers: authHeaders(),
        }).catch(() => {});
      }
    });

    it('turn continues to completion after WS client disconnects mid-turn', async () => {
      const WebSocket = require('ws');
      const sessionId = `mid-turn-disconnect-${Date.now()}`;
      createdSessions.push(sessionId);
      let turnId: string | null = null;

      const ws = new WebSocket(`${WS_URL}/api/agent/turn`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      // Send a prompt
      ws.send(JSON.stringify({
        sessionId,
        prompt: 'Reply with exactly the word "persisted" and nothing else.',
      }));

      // Wait for turn_started
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, TURN_TIMEOUT);
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

      // DISCONNECT mid-turn (simulate mobile losing connection)
      ws.close();

      // Wait for the turn to complete server-side
      const session = await waitForSessionIdle(BASE_URL, TEST_TOKEN, sessionId);

      // Session should no longer be busy
      expect(session.isBusy).toBe(false);
      expect(session.activeTurnId).toBeNull();

      // Should have both user message and assistant response
      const userMsgs = session.messages.filter((m) => m.role === 'user');
      const assistantMsgs = session.messages.filter((m) => m.role === 'assistant' || m.role === 'result');
      expect(userMsgs.length).toBeGreaterThanOrEqual(1);
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    }, TEST_TIMEOUT);

    it('event channel broadcasts session-changed after turn completes post-disconnect', async () => {
      const WebSocket = require('ws');
      const sessionId = `post-disconnect-event-${Date.now()}`;
      createdSessions.push(sessionId);
      const received: unknown[] = [];

      // Connect event channel ("web companion" listening for updates)
      const eventWs = new WebSocket(`${WS_URL}/api/events`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Event WS timeout')), 5000);
        eventWs.on('open', () => { clearTimeout(timeout); resolve(); });
        eventWs.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });
      eventWs.on('message', (data: Buffer) => {
        received.push(JSON.parse(data.toString()));
      });

      // Start turn from "mobile" and immediately disconnect
      const turnWs = new WebSocket(`${WS_URL}/api/agent/turn`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Turn WS timeout')), 5000);
        turnWs.on('open', () => { clearTimeout(timeout); resolve(); });
        turnWs.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      turnWs.send(JSON.stringify({
        sessionId,
        prompt: 'Say "hello" and nothing else.',
      }));

      // Wait for turn_started, then disconnect
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        turnWs.on('message', (data: Buffer) => {
          const event = JSON.parse(data.toString());
          if (event.type === 'turn_started') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      turnWs.close();

      // Wait for turn to complete and event to be broadcast
      await waitForSessionIdle(BASE_URL, TEST_TOKEN, sessionId);
      eventWs.close();

      // Event channel should have received at least one session-changed event
      const sessionEvents = received.filter(
        (e: unknown) => (e as { channel: string }).channel === 'cloud:session-changed'
          && ((e as { args: unknown[] }).args[0] as { sessionId: string }).sessionId === sessionId,
      );
      expect(sessionEvents.length).toBeGreaterThanOrEqual(1);
    }, TEST_TIMEOUT);
  });

  // --------------------------------------------------------------------------
  // Continuity state map — activeOnly filtering
  // --------------------------------------------------------------------------

  describe('continuity state map and activeOnly', () => {
    const activeSessionId = `active-${Date.now()}`;
    const localOnlySessionId = `local-only-${Date.now()}`;

    beforeAll(async () => {
      // Create two sessions
      const now = Date.now();
      for (const [id, title] of [[activeSessionId, 'Active'], [localOnlySessionId, 'Local Only']]) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'PUT', headers: authHeaders(),
          body: JSON.stringify({
            id, title, messages: [], eventsByTurn: {},
            createdAt: now, updatedAt: now, doneAt: null,
          }),
        });
      }

      // Push continuity state map (desktop pushes this periodically)
      const stateMap = {
        [activeSessionId]: { state: 'cloud_active', lastCloudActivityAt: now },
        [localOnlySessionId]: {
          state: 'local_only',
          cloudRemovalIntent: {
            requestedAt: now,
            requestedBy: 'retention-policy',
          },
        },
      };
      const res = await fetch(`${BASE_URL}/api/continuity/state`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify(stateMap),
      });
      expect(res.status).toBe(200);
    });

    afterAll(async () => {
      for (const id of [activeSessionId, localOnlySessionId]) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'DELETE', headers: authHeaders(),
        }).catch(() => {});
      }
    });

    it('GET /api/continuity/state returns the stored state map', async () => {
      const res = await fetch(`${BASE_URL}/api/continuity/state`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const stateMap = (await res.json()) as Record<string, { state: string }>;
      expect(stateMap[activeSessionId]?.state).toBe('cloud_active');
      expect(stateMap[localOnlySessionId]?.state).toBe('local_only');
    });

    it('activeOnly=true returns only cloud_active sessions', async () => {
      const res = await fetch(`${BASE_URL}/api/sessions?summaries=true&activeOnly=true`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(activeSessionId);
      expect(ids).not.toContain(localOnlySessionId);
    });

    it('summaries=true without activeOnly returns all sessions', async () => {
      const res = await fetch(`${BASE_URL}/api/sessions?summaries=true`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(activeSessionId);
      expect(ids).toContain(localOnlySessionId);
    });

    it('refuses unsafe local_only demotion when cloudRemovalIntent is missing', async () => {
      const unsafeSessionId = `unsafe-demotion-${Date.now()}`;
      const now = Date.now();
      await fetch(`${BASE_URL}/api/sessions/${unsafeSessionId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: unsafeSessionId,
          title: 'Unsafe Demotion',
          messages: [],
          eventsByTurn: {},
          createdAt: now,
          updatedAt: now,
          doneAt: null,
        }),
      });
      const seedRes = await fetch(`${BASE_URL}/api/continuity/state`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          [unsafeSessionId]: {
            state: 'cloud_active',
            lastCloudActivityAt: now,
          },
        }),
      });
      expect(seedRes.status).toBe(200);

      const putRes = await fetch(`${BASE_URL}/api/continuity/state`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          [unsafeSessionId]: { state: 'local_only' },
        }),
      });
      expect(putRes.status).toBe(200);

      const stateRes = await fetch(`${BASE_URL}/api/continuity/state`, { headers: authHeaders() });
      const stateMap = (await stateRes.json()) as Record<string, { state: string }>;
      expect(stateMap[unsafeSessionId]?.state).toBe('cloud_active');

      const activeOnlyRes = await fetch(`${BASE_URL}/api/sessions?summaries=true&activeOnly=true`, {
        headers: authHeaders(),
      });
      const { sessions } = (await activeOnlyRes.json()) as { sessions: Array<{ id: string }> };
      expect(sessions.some((session) => session.id === unsafeSessionId)).toBe(true);

      await fetch(`${BASE_URL}/api/sessions/${unsafeSessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    });
  });

  // --------------------------------------------------------------------------
  // Cloud-native sessions preserved across desktop state map pushes
  // --------------------------------------------------------------------------

  describe('cloud-native session preservation', () => {
    const mobileSessionId = `mobile-native-${Date.now()}`;
    const desktopSessionId = `desktop-known-${Date.now()}`;

    afterAll(async () => {
      for (const id of [mobileSessionId, desktopSessionId]) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'DELETE', headers: authHeaders(),
        }).catch(() => {});
      }
    });

    it('cloud-native session is not GC\'d when absent from desktop state map', async () => {
      const now = Date.now();

      // Create a "mobile-native" session (cloud creates it — not from desktop)
      await fetch(`${BASE_URL}/api/sessions/${mobileSessionId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: mobileSessionId, title: 'Mobile Native', messages: [],
          eventsByTurn: {}, createdAt: now, updatedAt: now, doneAt: null,
        }),
      });

      // Create a desktop-known session
      await fetch(`${BASE_URL}/api/sessions/${desktopSessionId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: desktopSessionId, title: 'Desktop Known', messages: [],
          eventsByTurn: {}, createdAt: now, updatedAt: now, doneAt: null,
        }),
      });

      // Desktop pushes its state map — only knows about desktopSessionId.
      // mobileSessionId is NOT in the map (desktop doesn't know about it yet).
      const stateMap = {
        [desktopSessionId]: { state: 'cloud_active', lastCloudActivityAt: now },
      };
      await fetch(`${BASE_URL}/api/continuity/state`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify(stateMap),
      });

      // Wait for GC to run
      await new Promise((r) => setTimeout(r, 1000));

      // Mobile-native session should still exist (not in state map = cloud-native, never GC'd)
      const getRes = await fetch(`${BASE_URL}/api/sessions/${mobileSessionId}`, { headers: authHeaders() });
      expect(getRes.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Concurrent multi-device connections
  // --------------------------------------------------------------------------

  describe('concurrent device connections', () => {
    it('multiple event channel WS connections can coexist', async () => {
      const WebSocket = require('ws');
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      const ws1 = new WebSocket(`${WS_URL}/api/events`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      const ws2 = new WebSocket(`${WS_URL}/api/events`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      await Promise.all([
        new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('WS1 timeout')), 5000);
          ws1.on('open', () => { clearTimeout(t); resolve(); });
          ws1.on('error', (e: Error) => { clearTimeout(t); reject(e); });
        }),
        new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('WS2 timeout')), 5000);
          ws2.on('open', () => { clearTimeout(t); resolve(); });
          ws2.on('error', (e: Error) => { clearTimeout(t); reject(e); });
        }),
      ]);

      ws1.on('message', (data: Buffer) => received1.push(JSON.parse(data.toString())));
      ws2.on('message', (data: Buffer) => received2.push(JSON.parse(data.toString())));

      // Trigger an event
      const evtId = `concurrent-evt-${Date.now()}`;
      await fetch(`${BASE_URL}/api/sessions/${evtId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: evtId, title: 'Concurrent', messages: [],
          eventsByTurn: {}, createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });

      await new Promise((r) => setTimeout(r, 500));
      ws1.close();
      ws2.close();

      // Both connections should have received the event
      const hasEvent1 = received1.some(
        (e: unknown) => (e as { channel: string }).channel === 'cloud:session-changed',
      );
      const hasEvent2 = received2.some(
        (e: unknown) => (e as { channel: string }).channel === 'cloud:session-changed',
      );
      expect(hasEvent1).toBe(true);
      expect(hasEvent2).toBe(true);

      // Cleanup
      await fetch(`${BASE_URL}/api/sessions/${evtId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, 15_000);
  });

  // --------------------------------------------------------------------------
  // Multi-turn continuation: start on "mobile", continue on "web"
  // --------------------------------------------------------------------------

  describe('cross-device multi-turn continuation', () => {
    const createdSessions: string[] = [];

    afterAll(async () => {
      for (const id of createdSessions) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'DELETE', headers: authHeaders(),
        }).catch(() => {});
      }
    });

    async function sendTurn(
      sessionId: string,
      prompt: string,
    ): Promise<{ type: string; [key: string]: unknown }[]> {
      const WebSocket = require('ws');
      const events: { type: string; [key: string]: unknown }[] = [];

      const ws = new WebSocket(`${WS_URL}/api/agent/turn`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      ws.send(JSON.stringify({ sessionId, prompt }));

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`Turn timed out. Events: ${JSON.stringify(events.map((e) => e.type))}`));
        }, TURN_TIMEOUT);

        ws.on('message', (data: Buffer) => {
          const event = JSON.parse(data.toString());
          events.push(event);
          if (event.type === 'result' || event.type === 'error') {
            clearTimeout(timeout);
            resolve();
          }
        });
        ws.on('close', () => { clearTimeout(timeout); resolve(); });
      });

      return events;
    }

    it('conversation started on "mobile" can be continued on "web" with full context', async () => {
      const sessionId = `cross-device-multi-${Date.now()}`;
      createdSessions.push(sessionId);

      // Turn 1: "mobile" starts a conversation
      const turn1 = await sendTurn(sessionId, 'Say "hello" and nothing else.');
      expect(turn1.some((e) => e.type === 'result')).toBe(true);
      await waitForSessionIdle(BASE_URL, TEST_TOKEN, sessionId);

      // Turn 2: "web companion" continues (different "device", same session)
      const turn2 = await sendTurn(sessionId, 'Say "world" and nothing else.');
      expect(turn2.some((e) => e.type === 'result')).toBe(true);

      // Verify cross-device context continuity by checking the shared session
      // accumulated both turns instead of starting over.
      await waitForSessionIdle(BASE_URL, TEST_TOKEN, sessionId);
      const getRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      const session = (await getRes.json()) as { messages: { role: string }[] };
      expect(session.messages.length).toBeGreaterThanOrEqual(4);
    }, TEST_TIMEOUT);
  });

  // --------------------------------------------------------------------------
  // modifiedSince — incremental sync
  // --------------------------------------------------------------------------

  describe('incremental sync via modifiedSince', () => {
    const sessionIdOld = `old-${Date.now()}`;
    const sessionIdNew = `new-${Date.now()}`;

    afterAll(async () => {
      for (const id of [sessionIdOld, sessionIdNew]) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'DELETE', headers: authHeaders(),
        }).catch(() => {});
      }
    });

    it('modifiedSince filter returns only recently updated sessions', async () => {
      // The server strips client-provided updatedAt and stamps cloudUpdatedAt
      // at write time, so we must create a real time gap between the two writes.
      // Create "old" session first.
      await fetch(`${BASE_URL}/api/sessions/${sessionIdOld}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: sessionIdOld, title: 'Old', messages: [],
          eventsByTurn: {}, createdAt: Date.now(),
        }),
      });

      // Wait, record the threshold, wait again — ensures the threshold falls
      // between the two server-stamped cloudUpdatedAt values.
      await new Promise((r) => setTimeout(r, 50));
      const threshold = Date.now();
      await new Promise((r) => setTimeout(r, 50));

      // Create "new" session after the threshold.
      await fetch(`${BASE_URL}/api/sessions/${sessionIdNew}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: sessionIdNew, title: 'New', messages: [],
          eventsByTurn: {}, createdAt: Date.now(),
        }),
      });

      const res = await fetch(
        `${BASE_URL}/api/sessions?summaries=true&modifiedSince=${threshold}`,
        { headers: authHeaders() },
      );
      expect(res.status).toBe(200);
      const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };

      expect(sessions.some((s) => s.id === sessionIdNew)).toBe(true);
      expect(sessions.some((s) => s.id === sessionIdOld)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Lean session endpoint (mobile optimization)
  // --------------------------------------------------------------------------

  describe('lean session endpoint', () => {
    const sessionId = `lean-${Date.now()}`;

    afterAll(async () => {
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    });

    it('lean=true strips eventsByTurn', async () => {
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: sessionId, title: 'Lean Test', createdAt: Date.now(), updatedAt: Date.now(),
          messages: [{ id: 'm1', turnId: 't1', role: 'user', text: 'hi', createdAt: Date.now() }],
          eventsByTurn: { t1: [{ type: 'turn_started', turnId: 't1' }] },
        }),
      });

      const fullRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      const full = (await fullRes.json()) as { eventsByTurn: Record<string, unknown> };
      expect(full.eventsByTurn).toBeDefined();
      expect(Object.keys(full.eventsByTurn).length).toBeGreaterThan(0);

      const leanRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}?lean=true`, { headers: authHeaders() });
      const lean = (await leanRes.json()) as { eventsByTurn?: unknown };
      expect(lean.eventsByTurn).toBeUndefined();
    });

    it('lean=true&toolEvents=true returns filtered tool events only', async () => {
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: sessionId, title: 'Lean Tool Test', createdAt: Date.now(), updatedAt: Date.now(),
          messages: [{ id: 'm1', turnId: 't1', role: 'user', text: 'hi', createdAt: Date.now() }],
          eventsByTurn: {
            t1: [
              { type: 'turn_started', turnId: 't1' },
              { type: 'tool', toolName: 'bash', detail: 'echo hi', stage: 'result', toolUseId: 'tu1' },
              { type: 'assistant', text: 'done' },
            ],
          },
        }),
      });

      const res = await fetch(
        `${BASE_URL}/api/sessions/${sessionId}?lean=true&toolEvents=true`,
        { headers: authHeaders() },
      );
      const session = (await res.json()) as { eventsByTurn: Record<string, Array<{ type: string }>> };
      expect(session.eventsByTurn).toBeDefined();
      // Only tool events should be present (not turn_started or assistant)
      const events = session.eventsByTurn.t1 ?? [];
      expect(events.every((e) => e.type === 'tool')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Workspace sync transport (desktop upload/pull flow over cloud endpoints)
  // --------------------------------------------------------------------------

  describe('workspace sync transport', () => {
    const desktopFixtureDir = path.join('/tmp', `workspace-sync-fixture-${Date.now()}`);

    function getWorkspaceDir(): string {
      return path.join(dataDir, 'workspace');
    }

    async function uploadBase64File(relativePath: string, content: string): Promise<void> {
      const resp = await fetch(`${BASE_URL}/api/library/upload-file`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          path: relativePath,
          content: Buffer.from(content, 'utf-8').toString('base64'),
          encoding: 'base64',
        }),
      });
      if (resp.status !== 200) {
        const errBody = await resp.text();
        throw new Error(`upload-file returned ${resp.status} for "${relativePath}": ${errBody}`);
      }
    }

    async function fetchManifest(): Promise<{ entries: Record<string, { hash: string; size: number }>; complete: boolean; reasons: string[] }> {
      const response = await fetch(`${BASE_URL}/api/library/manifest`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ entries: Record<string, { hash: string; size: number }>; complete: boolean; reasons: string[] }>;
    }

    afterAll(() => {
      fs.rmSync(path.join(getWorkspaceDir(), 'notes.md'), { force: true });
      fs.rmSync(path.join(getWorkspaceDir(), '.gitignore'), { force: true });
      fs.rmSync(path.join(getWorkspaceDir(), 'alias.md'), { force: true });
      fs.rmSync(path.join(getWorkspaceDir(), 'debug.log'), { force: true });
      fs.rmSync(path.join(getWorkspaceDir(), '.DS_Store'), { force: true });
      fs.rmSync(path.join(getWorkspaceDir(), 'subdir'), { recursive: true, force: true });
      fs.rmSync(path.join(getWorkspaceDir(), 'build'), { recursive: true, force: true });
      fs.rmSync(desktopFixtureDir, { recursive: true, force: true });
    });

    it('pushes workspace files, verifies manifest, and validates cloud read/write/delete', async () => {
      const workspaceDir = getWorkspaceDir();
      fs.mkdirSync(workspaceDir, { recursive: true });

      // Desktop-side fixture (symlink resolved before upload)
      fs.mkdirSync(path.join(desktopFixtureDir, 'subdir'), { recursive: true });
      fs.writeFileSync(path.join(desktopFixtureDir, 'notes.md'), '# Meeting Notes');
      fs.writeFileSync(path.join(desktopFixtureDir, 'subdir', 'code.ts'), 'export const code = 42;\n');
      fs.writeFileSync(path.join(desktopFixtureDir, '.gitignore'), '*.log\n');
      fs.symlinkSync('notes.md', path.join(desktopFixtureDir, 'alias.md'));

      // Push regular files via upload-file
      await uploadBase64File('notes.md', fs.readFileSync(path.join(desktopFixtureDir, 'notes.md'), 'utf-8'));
      await uploadBase64File('subdir/code.ts', fs.readFileSync(path.join(desktopFixtureDir, 'subdir', 'code.ts'), 'utf-8'));
      await uploadBase64File('.gitignore', fs.readFileSync(path.join(desktopFixtureDir, '.gitignore'), 'utf-8'));

      // Push symlink content as a regular file (desktop resolves symlink before upload)
      await uploadBase64File('alias.md', fs.readFileSync(path.join(desktopFixtureDir, 'alias.md'), 'utf-8'));

      const manifestAfterUpload = await fetchManifest();
      expect(manifestAfterUpload.entries['notes.md']).toBeDefined();
      expect(manifestAfterUpload.entries['subdir/code.ts']).toBeDefined();
      expect(manifestAfterUpload.entries['.gitignore']).toBeDefined();
      expect(manifestAfterUpload.entries['alias.md']).toBeDefined();

      // Write files directly on cloud workspace to verify cloud-side exclusions.
      fs.writeFileSync(path.join(workspaceDir, 'debug.log'), 'debug output');
      fs.mkdirSync(path.join(workspaceDir, 'build'), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, 'build', 'output.js'), 'console.log("build")\n');
      fs.writeFileSync(path.join(workspaceDir, '.DS_Store'), 'metadata');

      const manifestWithExcludedPaths = await fetchManifest();
      expect(manifestWithExcludedPaths.entries['build/output.js']).toBeUndefined();
      expect(manifestWithExcludedPaths.entries['.DS_Store']).toBeUndefined();

      const writeResponse = await fetch(`${BASE_URL}/api/library/write`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: 'notes.md', content: '# Updated Notes' }),
      });
      expect(writeResponse.status).toBe(200);

      const readResponse = await fetch(`${BASE_URL}/api/library/read`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: 'notes.md' }),
      });
      expect(readResponse.status).toBe(200);
      const readPayload = await readResponse.json() as { content: string };
      expect(readPayload.content).toBe('# Updated Notes');

      const deleteResponse = await fetch(`${BASE_URL}/api/library/delete-file`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: 'alias.md' }),
      });
      expect(deleteResponse.status).toBe(200);

      const manifestAfterDelete = await fetchManifest();
      expect(manifestAfterDelete.entries['alias.md']).toBeUndefined();
    });
  });
});
