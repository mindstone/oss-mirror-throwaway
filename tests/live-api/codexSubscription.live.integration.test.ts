/**
 * Gated live ChatGPT Pro (Codex OAuth subscription) integration test.
 *
 * Drives a real one-shot request through the production Codex egress path — the
 * local model proxy (`proxyManager`) with `codexEnabled` + a codex-subscription
 * route → `forwardToCodexModel` → the real Codex Responses endpoint
 * (chatgpt.com) — using the user's desktop ChatGPT Pro login and the registered
 * global `CodexAuthProvider` (exactly how a ChatGPT-Pro turn reaches the wire).
 * This surfaces the real-world failure modes (auth/reconnect, 429 usage-limit,
 * network) that an API-key tier cannot reach.
 *
 * Gating contract:
 *  - Whole tier opt-in via `RUN_LIVE_API_TESTS` (harness invariant).
 *  - Gated on a NON-env `credentialProbe`: presence of the desktop
 *    `codex-oauth-tokens.json`. Absent (CI / no ChatGPT Pro login) -> the cell
 *    SKIPS cleanly, never fails. Codex OAuth tokens are `safeStorage`-encrypted
 *    and cannot be sourced from `.env.test`, so NO secret flows through the
 *    harness for this cell (see `liveApiHarness.ts` module docstring).
 *  - The real credential is decrypted inside `beforeAll` via the sanctioned
 *    Electron helper (`codexLiveAuth.ts`), read-only — it never writes the user's
 *    token store, and `forceRefreshToken` is a no-op (an expired token surfaces
 *    as a real auth failure rather than silently mutating stored tokens).
 *  - Settings are a pure object literal (a WRITE); this never READS
 *    `settings.claude.*` / getAuthForDirectUse, so
 *    `check-integration-test-provider-gates.ts` stays green.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NULL_CODEX_AUTH_PROVIDER, setCodexAuthProvider } from '@core/codexAuth';
import type { AppSettings, ModelProfile } from '@shared/types';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describeLiveApi, CHEAP_LIVE_MODELS } from '../../src/test-utils/liveApiHarness';
import { codexTokenFileProbe, loadLiveCodexAuth, type LiveCodexAuth } from '../../src/test-utils/codexLiveAuth';

const MODEL = unsafeAssertRoutingModelId(CHEAP_LIVE_MODELS.codex);
const LIVE_TIMEOUT_MS = 90_000;
const LATENCY_WARN_MS = 30_000;

/**
 * True when the proxy response body carries the upstream Team-plan quota signal.
 * A Team/Pro subscription can be usage-capped at test time — an EXTERNAL condition
 * we can't control. When it fires we skip the round-trip/content asserts (the
 * subscription is exhausted) but still assert proxy FIDELITY: quota must surface
 * as a clean 429 (`rate_limit_error` + preserved `code`), NOT a generic 500/502
 * (REBEL-4GH / FOX-3152 — the `codexUpstreamErrorResponse` contract). So this
 * turns an uncontrollable external state into a meaningful assertion instead of
 * red-on-quota noise, without masking the fidelity bug.
 */
function bodyHasUsageLimit(body: string): boolean {
  return typeof body === 'string' && body.includes('usage_limit_reached');
}

/**
 * Golden-fixture path. Set `RECORD_CODEX_FIXTURE=1` alongside `RUN_LIVE_API_TESTS=1`
 * to (re)capture the REAL upstream Codex Responses SSE into this file — the
 * deterministic CI test (`localModelProxyServer.codexGoldenFixture.test.ts`) then
 * replays it so our parser/translator is guarded against the real shape every push.
 * Refreshing it from the weekly live run is how we catch upstream-shape drift the
 * frozen fixture can't (the SSE seam that regressed 5× in 22 days — see
 * docs/plans/260617_chatgpt-pro-test-hardening/).
 */
const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const GOLDEN_SSE_FIXTURE = path.join(FIXTURE_DIR, 'codex-responses-completed.golden.sse.txt');
// Reasoning models spend tokens on hidden reasoning before any text, so give the
// budget headroom (ChatGPT Pro bills against the subscription, not per-token).
const MAX_TOKENS = 400;

/**
 * Minimal AppSettings (pure object literal — `models: { apiKey }` is a WRITE, so
 * the provider-gate AST check does not flag it). Active provider is `codex`; the
 * Codex auth itself is injected via the registered global provider, not settings.
 */
function makeSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'codex',
    voice: { enabled: false },
    models: {
      apiKey: 'dummy-anthropic-key-not-used',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    diagnostics: { enabled: false },
    providerKeys: {},
    openRouter: { oauthToken: null },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => makeSettings(),
}));

// NB: do NOT mock '@core/codexAuth' — this test registers a REAL (read-only)
// provider and the proxy's forwardToCodexModel reads it via getCodexAuthProvider().
import { proxyManager, type ModelRouteTable } from '@main/services/localModelProxyServer';

/**
 * A ChatGPT Pro subscription profile: `providerType: 'openai'` + `authSource:
 * 'codex-subscription'` + NO apiKey → `isCodexSubscriptionProfile()` true, which
 * (with `codexEnabled`) makes the proxy forward to the Codex Responses endpoint.
 */
function makeCodexProfile(): ModelProfile {
  return {
    id: `codex-subscription-${CHEAP_LIVE_MODELS.codex}-live`,
    name: `ChatGPT Pro ${CHEAP_LIVE_MODELS.codex} live`,
    providerType: 'openai',
    authSource: 'codex-subscription',
    serverUrl: 'https://api.openai.com/v1',
    model: MODEL,
    reasoningEffort: 'low',
    enabled: true,
    createdAt: 0,
  } as unknown as ModelProfile;
}

interface ProxyResult {
  status: number;
  body: string;
  contentType: string;
}

interface AnthropicProxyResponse {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  stop_reason?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  headers: Record<string, string> = {},
): Promise<ProxyResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${proxyUrl}/v1/messages`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Auth': authToken,
          Host: '127.0.0.1',
          Connection: 'close',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            contentType: (res.headers['content-type'] as string | undefined) ?? '',
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function textFromAnthropicContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''))
    .join('');
}

let nextPort = 50120;

describeLiveApi(
  {
    provider: 'codex',
    label: 'ChatGPT Pro (Codex subscription) Responses — live integration',
    credentialProbe: codexTokenFileProbe,
    model: MODEL,
  },
  () => {
    let auth: LiveCodexAuth;
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeAll(() => {
      // The cell only runs when the token FILE exists + the tier is opted-in, so
      // a decrypt failure here is a real, surfaceable problem (fail loud).
      auth = loadLiveCodexAuth();
      const mins = Math.round((auth.expiresAt - Date.now()) / 60_000);
      // Do NOT log the account email (PII-adjacent) — just token health.
      console.warn(
        `[live] ChatGPT Pro token ${auth.expired ? 'EXPIRED' : `expires in ~${mins} min`}` +
          (auth.expired ? ' — expect an auth/reconnect failure (this surfaces the real issue).' : ''),
      );
      // Register a read-only global provider — the proxy's forwardToCodexModel
      // pulls the bearer token + account id from getCodexAuthProvider(). No store
      // writes; reset in afterAll.
      setCodexAuthProvider({
        isConnected: () => true,
        getAccessToken: auth.codexMode.getAccessToken,
        getAccountId: auth.codexMode.getAccountId,
        forceRefreshToken: auth.codexMode.forceRefreshToken,
        getStatus: () => ({ connected: true, accountEmail: auth.accountEmail }),
      });
    });

    afterEach(async () => {
      fetchSpy?.mockRestore();
      fetchSpy = undefined;
      await proxyManager.stop();
      nextPort += 10;
    });

    afterAll(() => {
      setCodexAuthProvider(NULL_CODEX_AUTH_PROVIDER);
    });

    it(
      'round-trips a tiny message through the ChatGPT Pro subscription (real Codex endpoint)',
      async () => {
        const routeTable: ModelRouteTable = {
          routes: new Map([[MODEL, makeCodexProfile()]]),
        };
        const turnId = 'turn-codex-subscription-live';
        // 6th arg = codexEnabled: routes this turn's egress to the Codex endpoint.
        await proxyManager.addRoutes(turnId, routeTable, undefined, nextPort++, false, true);
        const proxyUrl = proxyManager.getUrl()!;
        const token = proxyManager.getAuthToken()!;

        const startedAt = Date.now();
        const response = await sendToProxy(
          proxyUrl,
          JSON.stringify({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            stream: false,
            system: 'You are terse. Reply with exactly one short word.',
            messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
          }),
          token,
          { 'x-routed-turn-id': turnId, 'x-routed-model': MODEL },
        );
        const latencyMs = Date.now() - startedAt;
        const latencyLabel = latencyMs > LATENCY_WARN_MS ? 'past generous budget' : 'within generous budget';

        // External Team-plan quota: can't round-trip an exhausted subscription.
        // Skip the round-trip on a CLEAN 429 (proxy fidelity OK); FAIL on a
        // 500/502-with-quota — that's the fidelity bug (quota must surface as 429),
        // not an external condition. REBEL-4GH / FOX-3152.
        if (bodyHasUsageLimit(response.body)) {
          expect(
            response.status,
            `Codex quota surfaced with wrong proxy status ${response.status}; expected 429 (fidelity bug — see codexUpstreamErrorResponse). Upstream body: ${response.body}`,
          ).toBe(429);
          console.warn('[live] ChatGPT Pro Team-plan usage limit reached (external); round-trip skipped, proxy fidelity (429) asserted.');
          return;
        }

        // Assert status BEFORE parsing: a non-200 proxy/upstream failure (e.g. an
        // auth/network error) returns a body that may not be JSON, so parsing
        // first would throw a bare SyntaxError and bury the real diagnostic. This
        // is the surfacing point for the live failure modes (401 reconnect /
        // network / etc) — keep the raw body in the message.
        expect(
          response.status,
          `ChatGPT Pro proxy returned ${response.status}. Upstream body: ${response.body}`,
        ).toBe(200);
        expect(response.contentType).toContain('application/json');

        const responseJson = JSON.parse(response.body) as AnthropicProxyResponse;
        const text = textFromAnthropicContent(responseJson.content);
        console.warn(
          `[live] ChatGPT Pro ${CHEAP_LIVE_MODELS.codex} proxy call took ${latencyMs}ms (${latencyLabel}); ` +
            `status=${response.status}; stop=${String(responseJson.stop_reason)}; ` +
            `in=${String(responseJson.usage?.input_tokens)} out=${String(responseJson.usage?.output_tokens)}; ` +
            `text="${text.trim().slice(0, 40)}"`,
        );

        expect(responseJson.type).toBe('message');
        expect(responseJson.role).toBe('assistant');
        expect(typeof responseJson.usage?.input_tokens).toBe('number');
        expect(responseJson.usage!.input_tokens as number).toBeGreaterThan(0);
        expect(textFromAnthropicContent(responseJson.content).trim().length).toBeGreaterThan(0);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      'asserts the Codex egress request contract + records the golden upstream SSE fixture',
      async () => {
        const originalFetch = globalThis.fetch;
        let capturedRequest: Record<string, unknown> | undefined;
        let capturedAuthShape = 'missing';
        let capturedSse = '';
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
          const urlStr = typeof url === 'string' ? url : url.toString();
          if (urlStr.includes('chatgpt.com/backend-api/codex')) {
            if (typeof init?.body === 'string') {
              try { capturedRequest = JSON.parse(init.body) as Record<string, unknown>; } catch { /* non-JSON body — leave undefined */ }
            }
            const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
            // Record only the SHAPE of the auth header, never the token itself
            // (live-tier keys-never-logged invariant).
            capturedAuthShape = authHeader.startsWith('Bearer ') && authHeader.length > 'Bearer '.length ? 'bearer-present' : 'missing';
            const real = await originalFetch(url, init);
            // NOTE: buffering the full body here removes chunked-streaming timing —
            // this test covers the egress request SHAPE + the final parsed result,
            // NOT stream-chunk cadence or parser-stall behaviour (the translator has
            // a first-chunk timeout). Those stay the live streaming path's concern.
            capturedSse = await real.text();
            // Re-serve the buffered body so the proxy can read it. Use a minimal
            // header set (the upstream content-encoding no longer applies post-decode).
            return new Response(capturedSse, {
              status: real.status,
              headers: { 'content-type': real.headers.get('content-type') ?? 'text/event-stream' },
            });
          }
          return originalFetch(url, init);
        });

        const routeTable: ModelRouteTable = { routes: new Map([[MODEL, makeCodexProfile()]]) };
        const turnId = 'turn-codex-egress-contract';
        await proxyManager.addRoutes(turnId, routeTable, undefined, nextPort++, false, true);
        const proxyUrl = proxyManager.getUrl()!;
        const token = proxyManager.getAuthToken()!;

        const response = await sendToProxy(
          proxyUrl,
          JSON.stringify({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            stream: false,
            system: 'You are terse. Reply with exactly one short word.',
            messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
          }),
          token,
          { 'x-routed-turn-id': turnId, 'x-routed-model': MODEL },
        );

        // --- Egress REQUEST contract (only the real endpoint proves this) ---
        // Asserted FIRST: the egress request is captured by the fetch spy BEFORE
        // the upstream responds, so this contract holds even when the subscription
        // is quota-limited (the seam that regressed 5× in 22 days; 260617 analysis).
        expect(capturedRequest, 'no Codex egress request captured').toBeDefined();
        // Stream-invariant: the proxy MUST send stream:true upstream even for a
        // stream:false caller (Codex 400s on stream:false).
        expect(capturedRequest!.stream).toBe(true);
        expect(typeof capturedRequest!.model).toBe('string');
        // Positive: the egress model is a Codex/GPT-family model — catches a
        // wrong-model regression, not only the claude-leak case.
        expect(String(capturedRequest!.model)).toMatch(/codex|gpt/i);
        // A native-Anthropic model must NEVER reach the Codex egress (REBEL-540/67V).
        expect(String(capturedRequest!.model).startsWith('claude-')).toBe(false);
        expect(capturedAuthShape).toBe('bearer-present');
        console.warn(`[live] codex egress model=${String(capturedRequest!.model)} stream=${String(capturedRequest!.stream)}`);

        // External Team-plan quota: egress contract above is proven; the response
        // can't be (subscription exhausted). Skip the response-shape asserts on a
        // CLEAN 429, but FAIL on 500/502-with-quota (the fidelity bug). REBEL-4GH.
        if (bodyHasUsageLimit(response.body)) {
          expect(
            response.status,
            `Codex quota surfaced with wrong proxy status ${response.status}; expected 429 (fidelity bug — see codexUpstreamErrorResponse). Body: ${response.body}`,
          ).toBe(429);
          console.warn('[live] ChatGPT Pro Team-plan usage limit reached (external); egress contract asserted, response-shape skipped.');
          return;
        }

        expect(response.status, `Upstream body: ${response.body}`).toBe(200);

        // --- Upstream RESPONSE-shape canary (catches drift a frozen fixture can't) ---
        expect(capturedSse).toContain('response.completed');

        // Optional capture: refresh the deterministic golden fixture from reality.
        if (process.env.RECORD_CODEX_FIXTURE) {
          fs.mkdirSync(FIXTURE_DIR, { recursive: true });
          fs.writeFileSync(GOLDEN_SSE_FIXTURE, capturedSse, 'utf8');
          console.warn(`[live] recorded golden Codex SSE fixture (${capturedSse.length} bytes) → ${GOLDEN_SSE_FIXTURE}`);
        }
      },
      LIVE_TIMEOUT_MS,
    );
  },
);
