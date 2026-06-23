/**
 * Live E2E integration tests against an explicitly configured cloud-service.
 *
 * Requires REBEL_E2E_LIVE=1 plus CLOUD_URL and CLOUD_TOKEN. The suite never
 * reads desktop Rebel settings or silently targets the deployed cloud.
 *
 * Tests the configured cloud end-to-end:
 *   - Deployment freshness (buildCommit matches local HEAD)
 *   - Pairing (health + authenticated endpoints)
 *   - Session CRUD
 *   - Event channel (real WS)
 *   - Agent turn (real Anthropic API call)
 *   - Multi-turn conversation with memory
 *   - Stop turn
 *
 * Run: CLOUD_URL=http://127.0.0.1:8080 CLOUD_TOKEN=... npm run test:e2e:live
 */

import path from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Configuration: explicit live opt-in plus env vars only
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LIVE_E2E_ENABLED = process.env.REBEL_E2E_LIVE === '1';

interface CloudConfig {
  cloudUrl: string;
  cloudToken: string;
}

function loadCloudConfig(): CloudConfig {
  if (!process.env.CLOUD_URL || !process.env.CLOUD_TOKEN) {
    throw new Error(
      'Live mobile E2E requires CLOUD_URL and CLOUD_TOKEN. ' +
      'The suite does not read desktop Rebel settings; point it at an explicit local or test cloud.',
    );
  }
  return { cloudUrl: process.env.CLOUD_URL, cloudToken: process.env.CLOUD_TOKEN };
}

function getLocalGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
}

if (!LIVE_E2E_ENABLED) {
  console.warn(
    '[mobile-e2e] Skipping live mobile E2E. Set REBEL_E2E_LIVE=1, CLOUD_URL, and CLOUD_TOKEN to run it.',
  );
}

const config = LIVE_E2E_ENABLED ? loadCloudConfig() : null;

const BASE_URL = config?.cloudUrl?.replace(/\/+$/, '') || '';
const WS_URL = BASE_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const TOKEN = config?.cloudToken || '';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

const describeIf = LIVE_E2E_ENABLED ? describe : describe.skip;

describeIf('Live E2E Integration (explicit cloud-service)', () => {

  // ------------------------------------------------------------------
  // Deployment freshness check
  // ------------------------------------------------------------------

  describe('deployment', () => {
    it('is reachable and healthy', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; buildCommit?: string; buildDate?: string };
      expect(body.status).toBe('ok');
    });

    it('is running the latest local commit', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      const body = (await res.json()) as { buildCommit?: string; buildDate?: string };
      const localHash = getLocalGitHash();

      if (body.buildCommit === 'unknown' || !body.buildCommit) {
        console.warn(
          '[e2e] Deployed service does not expose buildCommit. ' +
          'Redeploy with the latest cloud-service build to enable freshness checks.',
        );
        return; // Don't fail -- old deployments won't have this field
      }

      if (body.buildCommit !== localHash) {
        throw new Error(
          `Deployed build (${body.buildCommit}, built ${body.buildDate || '?'}) ` +
          `does not match local HEAD (${localHash}). ` +
          'Redeploy the cloud-service before running E2E tests:\n' +
          '  cd cloud-service && fly deploy',
        );
      }
    });
  });

  // ------------------------------------------------------------------
  // Pairing flow
  // ------------------------------------------------------------------

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
      expect(settings).not.toHaveProperty('claude');
    });

    it('rejects wrong token', async () => {
      const res = await fetch(`${BASE_URL}/api/settings`, {
        headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(401);
    });
  });

  // ------------------------------------------------------------------
  // Session CRUD
  // ------------------------------------------------------------------

  describe('sessions', () => {
    const testSessionId = `e2e-crud-${Date.now()}`;

    afterAll(async () => {
      // Best-effort cleanup
      await fetch(`${BASE_URL}/api/sessions/${testSessionId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      }).catch(() => {});
    });

    it('lists sessions', async () => {
      const res = await fetch(`${BASE_URL}/api/sessions?summaries=true`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const sessions = await res.json();
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('creates and retrieves a session', async () => {
      const session = {
        id: testSessionId,
        title: 'E2E CRUD Test',
        messages: [{ id: 'msg-1', turnId: 't1', role: 'user', text: 'Hello', createdAt: Date.now() }],
        eventsByTurn: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const putRes = await fetch(`${BASE_URL}/api/sessions/${testSessionId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(session),
      });
      expect(putRes.status).toBe(200);

      const getRes = await fetch(`${BASE_URL}/api/sessions/${testSessionId}`, { headers: authHeaders() });
      expect(getRes.status).toBe(200);
      const retrieved = (await getRes.json()) as { id: string; title: string; messages: unknown[] };
      expect(retrieved.id).toBe(testSessionId);
      expect(retrieved.title).toBe('E2E CRUD Test');
      expect(retrieved.messages).toHaveLength(1);
    });

    it('deletes a session', async () => {
      const delRes = await fetch(`${BASE_URL}/api/sessions/${testSessionId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      expect(delRes.status).toBe(200);

      const getRes = await fetch(`${BASE_URL}/api/sessions/${testSessionId}`, { headers: authHeaders() });
      expect(getRes.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  // Event channel (WebSocket)
  // ------------------------------------------------------------------

  describe('event channel', () => {
    it('connects with auth and receives session-changed broadcast', async () => {
      const WebSocket = require('ws');
      const evtSessionId = `e2e-evt-${Date.now()}`;

      const received: unknown[] = [];
      const ws = new WebSocket(`${WS_URL}/api/events`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, 10_000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      ws.on('message', (data: Buffer) => {
        received.push(JSON.parse(data.toString()));
      });

      // Trigger a session-changed event
      await fetch(`${BASE_URL}/api/sessions/${evtSessionId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          id: evtSessionId, title: 'Event Test', messages: [],
          eventsByTurn: {}, createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });

      await new Promise((r) => setTimeout(r, 1000));
      ws.close();

      const sessionEvent = received.find(
        (e: unknown) => (e as { channel: string }).channel === 'cloud:session-changed',
      );
      expect(sessionEvent).toBeDefined();
      expect((sessionEvent as { args: unknown[] }).args[0]).toEqual(
        expect.objectContaining({ sessionId: evtSessionId, action: 'upserted' }),
      );

      // Cleanup
      await fetch(`${BASE_URL}/api/sessions/${evtSessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, 15_000);

    it('rejects event WS without auth', async () => {
      const WebSocket = require('ws');
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`${WS_URL}/api/events`);
        ws.on('close', () => resolve());
        ws.on('error', () => resolve());
      });
    });
  });

  // ------------------------------------------------------------------
  // Agent turn (real Anthropic API)
  // ------------------------------------------------------------------

  describe('agent turn', () => {
    const createdSessions: string[] = [];

    afterAll(async () => {
      for (const id of createdSessions) {
        await fetch(`${BASE_URL}/api/sessions/${id}`, {
          method: 'DELETE', headers: authHeaders(),
        }).catch(() => {});
      }
    });

    /** Helper: open WS, send prompt, collect events until result/error */
    async function sendTurn(
      sessionId: string,
      prompt: string,
      timeoutMs = 60_000,
    ): Promise<{ type: string; [key: string]: unknown }[]> {
      const WebSocket = require('ws');
      const events: { type: string; [key: string]: unknown }[] = [];

      const ws = new WebSocket(`${WS_URL}/api/agent/turn`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, 10_000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      ws.send(JSON.stringify({ sessionId, prompt }));

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`Turn timed out. Events: ${JSON.stringify(events.map((e) => e.type))}`));
        }, timeoutMs);

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

    it('completes a single-turn conversation with real AI response', async () => {
      const sessionId = `e2e-turn-${Date.now()}`;
      createdSessions.push(sessionId);

      const events = await sendTurn(sessionId, 'Reply with exactly the word "pong" and nothing else.');
      const types = events.map((e) => e.type);

      expect(types).toContain('turn_started');
      expect(types.some((t) => t === 'result' || t === 'error')).toBe(true);

      const turnStarted = events.find((e) => e.type === 'turn_started');
      expect(turnStarted?.turnId).toBeDefined();

      // Should have assistant content
      const hasAssistant = types.includes('assistant') || types.includes('assistant_delta');
      expect(hasAssistant).toBe(true);

      const fullText = events
        .filter((e) => e.type === 'assistant' || e.type === 'assistant_delta')
        .map((e) => (e.text as string) || '')
        .join('');
      expect(fullText.toLowerCase()).toContain('pong');

      // Verify session was persisted
      await new Promise((r) => setTimeout(r, 2000));
      const sessionRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(sessionRes.status).toBe(200);
      const session = (await sessionRes.json()) as { messages: { role: string }[] };
      expect(session.messages.filter((m) => m.role === 'user').length).toBeGreaterThanOrEqual(1);
      expect(session.messages.filter((m) => m.role === 'assistant' || m.role === 'result').length).toBeGreaterThanOrEqual(1);

      // Cleanup
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, 90_000);

    it('completes a multi-turn conversation with memory across turns', async () => {
      const sessionId = `e2e-multi-${Date.now()}`;
      createdSessions.push(sessionId);

      // Turn 1: establish a fact
      const turn1 = await sendTurn(sessionId, 'My favorite number is 42. Just say "ok got it" and nothing else.');
      expect(turn1.map((e) => e.type)).toContain('turn_started');
      expect(turn1.some((e) => e.type === 'result')).toBe(true);

      // Wait for session persistence
      await new Promise((r) => setTimeout(r, 2000));

      // Verify session persisted after turn 1
      const s1Res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(s1Res.status).toBe(200);
      const s1 = (await s1Res.json()) as { messages: { role: string }[] };
      expect(s1.messages.length).toBeGreaterThanOrEqual(2);

      // Turn 2: recall the fact (proves cross-turn memory)
      const turn2 = await sendTurn(sessionId, 'What is my favorite number? Reply with just the number.');
      expect(turn2.map((e) => e.type)).toContain('turn_started');
      expect(turn2.some((e) => e.type === 'result')).toBe(true);

      // Different turn IDs
      const t1Id = turn1.find((e) => e.type === 'turn_started')?.turnId;
      const t2Id = turn2.find((e) => e.type === 'turn_started')?.turnId;
      expect(t1Id).not.toBe(t2Id);

      // Turn 2 response should contain "42"
      const turn2Text = turn2
        .filter((e) => e.type === 'assistant' || e.type === 'assistant_delta' || e.type === 'result')
        .map((e) => (e.text as string) || '')
        .join('');
      expect(turn2Text).toMatch(/42/);

      // Verify final session has messages from both turns
      await new Promise((r) => setTimeout(r, 2000));
      const s2Res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(s2Res.status).toBe(200);
      const s2 = (await s2Res.json()) as { messages: { role: string }[] };
      expect(s2.messages.length).toBeGreaterThanOrEqual(4);

      // Cleanup
      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, 120_000);

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
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 10_000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      ws.send(JSON.stringify({ prompt: 'no session id' }));

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { ws.close(); resolve(); }, 5000);
        ws.on('message', (data: Buffer) => { events.push(JSON.parse(data.toString())); });
        ws.on('close', () => { clearTimeout(timeout); resolve(); });
      });

      expect(events.find((e: unknown) => (e as { type: string }).type === 'error')).toBeDefined();
    }, 15_000);

    it('supports query-param auth for WS (mobile compatibility)', async () => {
      const WebSocket = require('ws');
      const ws = new WebSocket(`${WS_URL}/api/agent/turn?token=${encodeURIComponent(TOKEN)}`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 10_000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      ws.close();
    });

    it('supports query-param auth for event WS', async () => {
      const WebSocket = require('ws');
      const ws = new WebSocket(`${WS_URL}/api/events?token=${encodeURIComponent(TOKEN)}`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 10_000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      ws.close();
    });
  });

  // ------------------------------------------------------------------
  // Stop turn
  // ------------------------------------------------------------------

  describe('stop turn', () => {
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
        headers: { Authorization: `Bearer ${TOKEN}` },
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 10_000);
        ws.on('open', () => { clearTimeout(timeout); resolve(); });
        ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      });

      ws.send(JSON.stringify({
        sessionId,
        prompt: 'Write a very long 500-word essay about the history of computing.',
      }));

      // Wait for turn_started
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 15_000);
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

      // Wait for WS to close
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { ws.close(); resolve(); }, 10_000);
        ws.on('close', () => { clearTimeout(timeout); resolve(); });
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
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, 30_000);
  });
});
