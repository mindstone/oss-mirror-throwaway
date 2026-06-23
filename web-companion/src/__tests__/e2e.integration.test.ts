/**
 * E2E integration tests for the web companion against the deployed cloud-service on Fly.io.
 *
 * Tests the same API surface as the mobile E2E tests but from the web companion's
 * perspective -- exercising the cloud-client shared package that both mobile and
 * web-companion consume.
 *
 * Reads cloud URL and bridge token from the local device's app-settings.json
 * (same credentials the desktop app uses), or from env vars for CI.
 *
 * Tests:
 *   - Web app static serving (/app, /app/index.html)
 *   - Auth flow (token in URL fragment, rejection of bad tokens)
 *   - Session CRUD via cloud-client API
 *   - Event channel WebSocket (real-time session updates)
 *   - Agent turn -- single-turn conversation (real Anthropic API)
 *   - Agent turn -- multi-turn conversation with memory across turns
 *   - Stop turn
 *
 * Run: npx vitest run src/__tests__/e2e.integration.test.ts
 */

import fs from 'fs';
import path from 'path';

const DEVICE_SETTINGS = path.join(
  process.env.HOME || '',
  'Library',
  'Application Support',
  'mindstone-rebel',
  'app-settings.json',
);

interface CloudConfig {
  cloudUrl: string;
  cloudToken: string;
}

function loadCloudConfig(): CloudConfig | null {
  if (process.env.CLOUD_URL && process.env.CLOUD_TOKEN) {
    return { cloudUrl: process.env.CLOUD_URL, cloudToken: process.env.CLOUD_TOKEN };
  }
  if (!fs.existsSync(DEVICE_SETTINGS)) return null;
  try {
    const settings = JSON.parse(fs.readFileSync(DEVICE_SETTINGS, 'utf-8'));
    const cloud = settings.cloudInstance;
    if (cloud?.cloudUrl && cloud?.cloudToken) {
      return { cloudUrl: cloud.cloudUrl, cloudToken: cloud.cloudToken };
    }
  } catch { /* ignore */ }
  return null;
}

const config = loadCloudConfig();
const BASE_URL = config?.cloudUrl?.replace(/\/+$/, '') || '';
const WS_URL = BASE_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const TOKEN = config?.cloudToken || '';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

const describeIf = config ? describe : describe.skip;

describeIf('Web Companion E2E (deployed cloud-service)', () => {

  // ------------------------------------------------------------------
  // Deployment freshness
  // ------------------------------------------------------------------

  describe('deployment', () => {
    it('is reachable and healthy', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ok');
    });

    // Deployment-freshness assertion removed 2026-04-23 (Stage 5 of
    // docs/plans/260423_i10_outstanding_work_STAGED_PLAN.md — AMD-9).
    //
    // Why: the assertion compared `/api/health.buildCommit` (cloud-service
    // build) against the local git HEAD, but this session's web-only edits
    // are deployed by `deploy-web.yml` which ships static assets to GCS and
    // does NOT rebuild the Fly.io cloud-service. The two signals were never
    // for the same artifact — every web-only change caused a false-positive
    // test failure and the test offered a misleading "Redeploy: fly deploy"
    // remediation that would not have fixed anything.
    //
    // The structural fix lives on the cloud side: `/api/health` needs to
    // expose `webBuildCommit` (from the web deploy pipeline, stamped into
    // the shipped bundle) in addition to `cloudBuildCommit`. See OW-14 in
    // docs/plans/260422_i10_followups_STAGED_PLAN.md for the pickup task.
    //
    // Interim deployment-freshness verification now lives in
    // `deploy-web.yml` (post-deploy synthetic canary) or manual checks, not
    // in the Vitest integration suite (which is opt-in and requires user
    // creds anyway).
  });

  // ------------------------------------------------------------------
  // Web app static serving
  // ------------------------------------------------------------------

  describe('web app serving', () => {
    let spaHtml: string;

    beforeAll(async () => {
      const res = await fetch(`${BASE_URL}/app/`);
      spaHtml = await res.text();
    });

    it('serves the real SPA (not a placeholder)', async () => {
      const res = await fetch(`${BASE_URL}/app/`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get('content-type') || '';
      expect(contentType).toContain('text/html');

      // Must be a real Vite-built SPA, not the "Web companion not available" placeholder
      expect(spaHtml).toContain('<div id="root">');
      expect(spaHtml).toContain('<script type="module"');
      expect(spaHtml).not.toContain('not available');
      expect(spaHtml).not.toContain('not installed');
    });

    it('includes hashed JS and CSS assets from Vite build', () => {
      // Vite injects hashed asset references like /app/assets/index-DYWoGukH.js
      const jsMatch = spaHtml.match(/src="([^"]+[-\.][a-zA-Z0-9_-]{8,}\.js)"/);
      expect(jsMatch).not.toBeNull();

      const cssMatch = spaHtml.match(/href="([^"]+[-\.][a-zA-Z0-9_-]{8,}\.css)"/);
      expect(cssMatch).not.toBeNull();
    });

    it('JS bundle is fetchable and non-empty', async () => {
      const jsMatch = spaHtml.match(/src="([^"]+[-\.][a-zA-Z0-9_-]{8,}\.js)"/);
      expect(jsMatch).not.toBeNull();
      const jsPath = jsMatch![1].startsWith('/') ? jsMatch![1] : `/app/${jsMatch![1]}`;
      const jsRes = await fetch(`${BASE_URL}${jsPath}`);
      expect(jsRes.status).toBe(200);
      const jsContent = await jsRes.text();
      expect(jsContent.length).toBeGreaterThan(1000);
      // Verify it's actual JavaScript, not an error page
      expect(jsContent).not.toContain('<!DOCTYPE');
    });

    it('SPA fallback: unknown routes serve the same index.html', async () => {
      const res = await fetch(`${BASE_URL}/app/conversations/some-id`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // Same SPA shell (Vite inserts identical content)
      expect(html).toContain('<div id="root">');
      expect(html).toContain('<script type="module"');
    });

    it('returns CSP headers', async () => {
      const res = await fetch(`${BASE_URL}/app/`);
      const csp = res.headers.get('content-security-policy') || '';
      expect(csp).toContain("default-src 'self'");
    });

    it('caches hashed assets with long max-age', async () => {
      const jsMatch = spaHtml.match(/src="([^"]+[-\.][a-zA-Z0-9_-]{8,}\.js)"/);
      expect(jsMatch).not.toBeNull();
      const jsPath = jsMatch![1].startsWith('/') ? jsMatch![1] : `/app/${jsMatch![1]}`;
      const jsRes = await fetch(`${BASE_URL}${jsPath}`);
      expect(jsRes.status).toBe(200);
      const cacheControl = jsRes.headers.get('cache-control') || '';
      expect(cacheControl).toContain('max-age');
    });
  });

  // ------------------------------------------------------------------
  // Auth flow
  // ------------------------------------------------------------------

  describe('auth', () => {
    it('health check succeeds without auth', async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
    });

    it('rejects unauthenticated API requests', async () => {
      const res = await fetch(`${BASE_URL}/api/settings`);
      expect(res.status).toBe(401);
    });

    it('accepts correct bearer token', async () => {
      const res = await fetch(`${BASE_URL}/api/settings`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const settings = await res.json();
      expect(settings).toHaveProperty('claude');
    });

    it('rejects wrong bearer token', async () => {
      const res = await fetch(`${BASE_URL}/api/settings`, {
        headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(401);
    });

    it('serves web app without auth (auth is client-side)', async () => {
      const res = await fetch(`${BASE_URL}/app/`);
      expect(res.status).toBe(200);
    });
  });

  // ------------------------------------------------------------------
  // Session CRUD (same API as mobile, shared cloud-client)
  // ------------------------------------------------------------------

  describe('sessions', () => {
    const testSessionId = `web-e2e-crud-${Date.now()}`;

    afterAll(async () => {
      await fetch(`${BASE_URL}/api/sessions/${testSessionId}`, {
        method: 'DELETE', headers: authHeaders(),
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
        title: 'Web E2E CRUD',
        messages: [{ id: 'msg-1', turnId: 't1', role: 'user', text: 'Hello from web', createdAt: Date.now() }],
        eventsByTurn: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const putRes = await fetch(`${BASE_URL}/api/sessions/${testSessionId}`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify(session),
      });
      expect(putRes.status).toBe(200);

      const getRes = await fetch(`${BASE_URL}/api/sessions/${testSessionId}`, { headers: authHeaders() });
      expect(getRes.status).toBe(200);
      const retrieved = (await getRes.json()) as { id: string; title: string; messages: unknown[] };
      expect(retrieved.id).toBe(testSessionId);
      expect(retrieved.title).toBe('Web E2E CRUD');
      expect(retrieved.messages).toHaveLength(1);
    });

    it('deletes a session', async () => {
      const delRes = await fetch(`${BASE_URL}/api/sessions/${testSessionId}`, {
        method: 'DELETE', headers: authHeaders(),
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
    it('connects and receives session-changed broadcast', async () => {
      const WebSocket = (await import('ws')).default;
      const evtSessionId = `web-e2e-evt-${Date.now()}`;
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

      await fetch(`${BASE_URL}/api/sessions/${evtSessionId}`, {
        method: 'PUT', headers: authHeaders(),
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

      await fetch(`${BASE_URL}/api/sessions/${evtSessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, 15_000);

    it('rejects event WS without auth', async () => {
      const WebSocket = (await import('ws')).default;
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

    async function sendTurn(
      sessionId: string,
      prompt: string,
      timeoutMs = 60_000,
    ): Promise<{ type: string; [key: string]: unknown }[]> {
      const WebSocket = (await import('ws')).default;
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

    it('completes a single-turn conversation', async () => {
      const sessionId = `web-e2e-turn-${Date.now()}`;
      createdSessions.push(sessionId);
      const events = await sendTurn(sessionId, 'Reply with exactly the word "pong" and nothing else.');
      const types = events.map((e) => e.type);

      expect(types).toContain('turn_started');
      expect(types.some((t) => t === 'result' || t === 'error')).toBe(true);

      const turnStarted = events.find((e) => e.type === 'turn_started');
      expect(turnStarted?.turnId).toBeDefined();

      const hasAssistant = types.includes('assistant') || types.includes('assistant_delta');
      expect(hasAssistant).toBe(true);

      const fullText = events
        .filter((e) => e.type === 'assistant' || e.type === 'assistant_delta')
        .map((e) => (e.text as string) || '')
        .join('');
      expect(fullText.toLowerCase()).toContain('pong');

      // Verify session persisted
      await new Promise((r) => setTimeout(r, 2000));
      const sessionRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(sessionRes.status).toBe(200);
      const session = (await sessionRes.json()) as { messages: { role: string }[] };
      expect(session.messages.filter((m) => m.role === 'user').length).toBeGreaterThanOrEqual(1);
      expect(session.messages.filter((m) => m.role === 'assistant' || m.role === 'result').length).toBeGreaterThanOrEqual(1);

      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, 90_000);

    it('completes a multi-turn conversation with memory across turns', async () => {
      const sessionId = `web-e2e-multi-${Date.now()}`;
      createdSessions.push(sessionId);

      // Turn 1: establish a fact
      const turn1 = await sendTurn(sessionId, 'My favorite number is 42. Just say "ok got it" and nothing else.');
      expect(turn1.map((e) => e.type)).toContain('turn_started');
      expect(turn1.some((e) => e.type === 'result')).toBe(true);

      await new Promise((r) => setTimeout(r, 2000));

      // Verify persistence after turn 1
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

      // Turn 2 should recall "42"
      const turn2Text = turn2
        .filter((e) => e.type === 'assistant' || e.type === 'assistant_delta' || e.type === 'result')
        .map((e) => (e.text as string) || '')
        .join('');
      expect(turn2Text).toMatch(/42/);

      // Verify final session has both turns
      await new Promise((r) => setTimeout(r, 2000));
      const s2Res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(s2Res.status).toBe(200);
      const s2 = (await s2Res.json()) as { messages: { role: string }[] };
      expect(s2.messages.length).toBeGreaterThanOrEqual(4);

      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, 120_000);

    it('rejects turn WS without auth', async () => {
      const WebSocket = (await import('ws')).default;
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`${WS_URL}/api/agent/turn`);
        ws.on('close', () => resolve());
        ws.on('error', () => resolve());
      });
    });

    it('handles missing sessionId gracefully', async () => {
      const WebSocket = (await import('ws')).default;
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
      const WebSocket = (await import('ws')).default;
      const sessionId = `web-e2e-stop-${Date.now()}`;
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

      const stopRes = await fetch(`${BASE_URL}/api/agent/stop`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ turnId }),
      });
      expect(stopRes.status).toBe(200);

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

      await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        method: 'DELETE', headers: authHeaders(),
      }).catch(() => {});
    }, 30_000);
  });
});
