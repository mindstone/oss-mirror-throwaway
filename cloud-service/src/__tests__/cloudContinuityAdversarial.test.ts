/**
 * Adversarial tests for cloud continuity edge cases.
 *
 * Tests bugs that were found during code audit:
 *
 * 1. Concurrent turn message merge — two turns on the same session must not
 *    clobber each other's messages (was: full-array overwrite, now: dedup merge).
 *
 * 2. markSessionAsCloudActive mutex — concurrent calls must not lose entries
 *    (was: read-modify-write race, now: serialized via promise chain).
 *
 * 3. markSessionAsCloudActive awaited in agent turns — sessions must be visible
 *    in activeOnly queries immediately after turn_started.
 *
 * 4. activeOnly filtering — sessions not in the state map must be excluded
 *    (was: test incorrectly expected inclusion).
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

const PORT = 19878;
const TEST_TOKEN = 'adversarial-test-token';
const BASE_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;

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
  if (MOCK_MODE) return fs.existsSync(SERVER_PATH) && hasExternalDeps();
  return fs.existsSync(SERVER_PATH) && readApiKey() !== null && hasExternalDeps();
}

const describeIf = hasRequiredFiles() ? describe : describe.skip;

describeIf('Cloud Continuity Adversarial Tests', () => {
  beforeAll(async () => {
    dataDir = path.join('/tmp', `rebel-adversarial-e2e-${Date.now()}`);
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
  // Bug 1: Concurrent turns on the same session must not lose messages
  // --------------------------------------------------------------------------

  describe('concurrent turn message safety', () => {
    const createdSessions: string[] = [];

    afterAll(async () => {
      for (const id of createdSessions) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'DELETE', headers: authHeaders(),
        }).catch(() => {});
      }
    });

    it('pre-existing messages survive when a new turn is started and completes', async () => {
      // Simulate: desktop synced a session with 2 turns, then mobile starts turn 3.
      // After turn 3 completes, turns 1 and 2 must still be present.
      const sessionId = `merge-safety-${Date.now()}`;
      createdSessions.push(sessionId);
      const now = Date.now();

      // Pre-populate session with 2 turns (as if desktop synced them)
      const existingSession = {
        id: sessionId,
        title: 'Merge Safety Test',
        createdAt: now,
        updatedAt: now,
        doneAt: null,
        messages: [
          { id: 'pre-msg-1', turnId: 'pre-turn-1', role: 'user', text: 'Turn 1 user', createdAt: now - 2000 },
          { id: 'pre-msg-2', turnId: 'pre-turn-1', role: 'assistant', text: 'Turn 1 reply', createdAt: now - 1900 },
          { id: 'pre-msg-3', turnId: 'pre-turn-2', role: 'user', text: 'Turn 2 user', createdAt: now - 1000 },
          { id: 'pre-msg-4', turnId: 'pre-turn-2', role: 'assistant', text: 'Turn 2 reply', createdAt: now - 900 },
        ],
        eventsByTurn: {
          'pre-turn-1': [{ type: 'result', text: 'Turn 1 reply' }],
          'pre-turn-2': [{ type: 'result', text: 'Turn 2 reply' }],
        },
      };
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify(existingSession),
      });

      // Start turn 3 via WS
      const WebSocket = require('ws');
      const events: { type: string; [key: string]: unknown }[] = [];

      const ws = new WebSocket(`${WS_URL}/api/agent/turn`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      ws.send(JSON.stringify({
        sessionId,
        prompt: 'Say exactly "turn 3 done" and nothing else.',
      }));

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`Timed out. Events: ${events.map((e) => e.type).join(',')}`));
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

      // Wait for persistence
      await waitForSessionIdle(BASE_URL, TEST_TOKEN, sessionId);

      // Verify ALL messages from all 3 turns are present
      const getRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(getRes.status).toBe(200);
      const session = (await getRes.json()) as {
        messages: { id: string; turnId: string; role: string; text: string }[];
        eventsByTurn: Record<string, unknown[]>;
      };

      // Pre-existing messages must NOT be lost
      const preMessages = session.messages.filter((m) => m.id.startsWith('pre-'));
      expect(preMessages).toHaveLength(4);
      expect(preMessages.map((m) => m.id).sort()).toEqual([
        'pre-msg-1', 'pre-msg-2', 'pre-msg-3', 'pre-msg-4',
      ]);

      // Pre-existing events must NOT be lost
      expect(session.eventsByTurn['pre-turn-1']).toBeDefined();
      expect(session.eventsByTurn['pre-turn-2']).toBeDefined();

      // Turn 3 messages should also be present
      const turn3UserMsgs = session.messages.filter(
        (m) => m.role === 'user' && !m.id.startsWith('pre-'),
      );
      expect(turn3UserMsgs.length).toBeGreaterThanOrEqual(1);

      // Total messages: 4 pre-existing + at least 2 from turn 3 (user + assistant)
      expect(session.messages.length).toBeGreaterThanOrEqual(6);
    }, TEST_TIMEOUT);
  });

  // --------------------------------------------------------------------------
  // Bug 2 & 3: markSessionAsCloudActive is awaited and serialized
  // --------------------------------------------------------------------------

  describe('markSessionAsCloudActive correctness', () => {
    it('session is visible in activeOnly immediately after agent turn starts', async () => {
      const WebSocket = require('ws');
      const sessionId = `visibility-${Date.now()}`;

      const ws = new WebSocket(`${WS_URL}/api/agent/turn`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      // Start a turn (creates the session)
      ws.send(JSON.stringify({
        sessionId,
        prompt: 'Say "hi" and nothing else.',
      }));

      // Wait for turn_started (markSessionAsCloudActive has now completed)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, TURN_TIMEOUT);
        ws.on('message', (data: Buffer) => {
          const event = JSON.parse(data.toString());
          if (event.type === 'turn_started') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      // Immediately query activeOnly — session should be visible
      const res = await fetch(`${BASE_URL}/api/sessions?summaries=true&activeOnly=true`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };
      const found = sessions.some((s) => s.id === sessionId);
      expect(found).toBe(true);

      // Wait for turn to complete, then cleanup
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { ws.close(); resolve(); }, TURN_TIMEOUT);
        ws.on('message', (data: Buffer) => {
          const event = JSON.parse(data.toString());
          if (event.type === 'result' || event.type === 'error') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, TEST_TIMEOUT);

    it('concurrent session creations via PUT both appear in state map', async () => {
      const sessionA = `concurrent-a-${Date.now()}`;
      const sessionB = `concurrent-b-${Date.now()}`;

      // Create both sessions simultaneously
      const [resA, resB] = await Promise.all([
        fetch(`${BASE_URL}/api/sessions/${sessionA}`, {
          method: 'PUT', headers: authHeaders(),
          body: JSON.stringify({
            id: sessionA, title: 'A', messages: [], eventsByTurn: {},
            createdAt: Date.now(), updatedAt: Date.now(), doneAt: null,
          }),
        }),
        fetch(`${BASE_URL}/api/sessions/${sessionB}`, {
          method: 'PUT', headers: authHeaders(),
          body: JSON.stringify({
            id: sessionB, title: 'B', messages: [], eventsByTurn: {},
            createdAt: Date.now(), updatedAt: Date.now(), doneAt: null,
          }),
        }),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      // Both should be in the state map as cloud_active
      const stateRes = await fetch(`${BASE_URL}/api/continuity/state`, { headers: authHeaders() });
      const stateMap = (await stateRes.json()) as Record<string, { state: string }> | null;

      expect(stateMap).not.toBeNull();
      expect(stateMap![sessionA]?.state).toBe('cloud_active');
      expect(stateMap![sessionB]?.state).toBe('cloud_active');

      // Cleanup
      await fetch(`${BASE_URL}/api/sessions/${sessionA}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
      await fetch(`${BASE_URL}/api/sessions/${sessionB}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
    });
  });

  // --------------------------------------------------------------------------
  // Bug 4: activeOnly filtering correctness
  // --------------------------------------------------------------------------

  describe('activeOnly filtering edge cases', () => {
    it('session explicitly marked local_only in state map is excluded from activeOnly', async () => {
      const sessionId = `local-only-filter-${Date.now()}`;

      // Create session (this marks it cloud_active via markSessionAsCloudActive)
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: sessionId, title: 'Will Be Local', messages: [], eventsByTurn: {},
          createdAt: Date.now(), updatedAt: Date.now(), doneAt: null,
        }),
      });

      // Verify it initially appears in activeOnly
      const beforeRes = await fetch(`${BASE_URL}/api/sessions?summaries=true&activeOnly=true`, {
        headers: authHeaders(),
      });
      const { sessions: beforeSessions } = (await beforeRes.json()) as {
        sessions: Array<{ id: string }>;
      };
      expect(beforeSessions.some((s) => s.id === sessionId)).toBe(true);

      // Desktop pushes state map marking it local_only (simulates user un-pinning)
      await fetch(`${BASE_URL}/api/continuity/state`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          [sessionId]: {
            state: 'local_only',
            cloudRemovalIntent: {
              requestedAt: Date.now(),
              requestedBy: 'user',
            },
          },
        }),
      });

      // Now it should be excluded from activeOnly
      const afterRes = await fetch(`${BASE_URL}/api/sessions?summaries=true&activeOnly=true`, {
        headers: authHeaders(),
      });
      const { sessions: afterSessions } = (await afterRes.json()) as {
        sessions: Array<{ id: string }>;
      };
      expect(afterSessions.some((s) => s.id === sessionId)).toBe(false);

      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
    });

    it('refuses unsafe local_only demotion when cloudRemovalIntent is missing', async () => {
      const sessionId = `local-only-unsafe-${Date.now()}`;

      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          id: sessionId,
          title: 'Unsafe Demotion Candidate',
          messages: [],
          eventsByTurn: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
          doneAt: null,
        }),
      });
      const now = Date.now();
      const seedRes = await fetch(`${BASE_URL}/api/continuity/state`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          [sessionId]: {
            state: 'cloud_active',
            lastCloudActivityAt: now,
          },
        }),
      });
      expect(seedRes.status).toBe(200);

      await fetch(`${BASE_URL}/api/continuity/state`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          [sessionId]: { state: 'local_only' },
        }),
      });

      const stateRes = await fetch(`${BASE_URL}/api/continuity/state`, { headers: authHeaders() });
      const stateMap = (await stateRes.json()) as Record<string, { state: string }> | null;
      expect(stateMap).not.toBeNull();
      expect(stateMap![sessionId]?.state).toBe('cloud_active');

      const activeOnlyRes = await fetch(`${BASE_URL}/api/sessions?summaries=true&activeOnly=true`, {
        headers: authHeaders(),
      });
      const { sessions } = (await activeOnlyRes.json()) as { sessions: Array<{ id: string }> };
      expect(sessions.some((session) => session.id === sessionId)).toBe(true);

      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
    });

    it('cloud-native session preserved when desktop pushes state map without it', async () => {
      // This tests the preserve-cloud-active merge logic in handleContinuity PUT.
      const cloudNativeId = `cloud-native-preserve-${Date.now()}`;
      const desktopKnownId = `desktop-known-preserve-${Date.now()}`;

      // Create cloud-native session (automatically marked cloud_active)
      await fetch(`${BASE_URL}/api/sessions/${cloudNativeId}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          id: cloudNativeId, title: 'Cloud Native', messages: [], eventsByTurn: {},
          createdAt: Date.now(), updatedAt: Date.now(), doneAt: null,
        }),
      });

      // Desktop pushes state map that only knows about desktopKnownId
      await fetch(`${BASE_URL}/api/continuity/state`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({
          [desktopKnownId]: { state: 'cloud_active', lastCloudActivityAt: Date.now() },
        }),
      });

      // Cloud-native session should still be in the state map (preserved by merge)
      const stateRes = await fetch(`${BASE_URL}/api/continuity/state`, { headers: authHeaders() });
      const stateMap = (await stateRes.json()) as Record<string, { state: string }> | null;
      expect(stateMap![cloudNativeId]?.state).toBe('cloud_active');

      await fetch(`${BASE_URL}/api/sessions/${cloudNativeId}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
    });
  });
});
