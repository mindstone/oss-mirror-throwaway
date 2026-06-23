 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AppSettings, ModelProfile } from '@shared/types';

const getSettingsMock = vi.hoisted(() => vi.fn());

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: getSettingsMock,
}));

vi.mock('@core/codexAuth', () => ({
  CODEX_ENDPOINT_URL: 'https://chatgpt.com/backend-api/codex',
  getCodexAuthProvider: vi.fn(() => ({
    isConnected: vi.fn(() => true),
    getAccessToken: vi.fn(async () => 'codex-token'),
    getAccountId: vi.fn(() => 'org_123'),
    forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
    getStatus: vi.fn(() => ({ connected: true })),
  })),
}));

import { proxyManager, type ModelRouteTable } from '../localModelProxyServer';
import {
  callBehindTheScenesWithAuth,
  registerBtsProxyProviders,
} from '@core/services/behindTheScenesClient';

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'codex-gpt-5.5',
    name: 'GPT-5.5 (ChatGPT Pro)',
    authSource: 'codex-subscription',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    createdAt: 0,
    reasoningEffort: 'high',
    ...overrides,
  };
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const workingProfile = makeProfile();
  return {
    claude: { workingProfileId: workingProfile.id },
    models: { workingProfileId: workingProfile.id },
    providerKeys: {},
    customProviders: [],
    localModel: {
      profiles: [workingProfile],
      activeProfileId: workingProfile.id,
    },
    ...overrides,
  } as AppSettings;
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${proxyUrl}/v1/messages`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Auth': authToken,
          Host: '127.0.0.1',
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

function makeCodexSuccessResponse(): Response {
  const encoder = new TextEncoder();
  const completedResponse = {
    id: 'resp_profile_resolution',
    model: 'gpt-5.5',
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Profile resolved', annotations: [] }],
    }],
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    status: 'completed',
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeCodexCompletedErrorResponse(message: string): Response {
  const encoder = new TextEncoder();
  const completedResponse = {
    id: 'resp_profile_resolution_error',
    model: 'gpt-5.5',
    output: [],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    status: 'failed',
    error: { message, type: 'invalid_request_error' },
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

let nextPort = 49750;

describe('localModelProxyServer profile resolution edge cases', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedCodexBodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    capturedCodexBodies = [];
    getSettingsMock.mockReturnValue(makeSettings());
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = typeof init?.body === 'string' ? init.body : '';

      if (urlStr.includes('/v1/messages') && urlStr.startsWith('http://127.0.0.1:')) {
        const parsedBody = JSON.parse(body) as Record<string, unknown>;
        capturedCodexBodies.push(parsedBody);
        return new Response(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `unsupported model ${String(parsedBody.model)}` },
        }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        const parsedBody = JSON.parse(body) as Record<string, unknown>;
        capturedCodexBodies.push(parsedBody);
        if (parsedBody.model !== 'gpt-5.5') {
          return makeCodexCompletedErrorResponse(`unsupported model ${String(parsedBody.model)}`);
        }
        return makeCodexSuccessResponse();
      }

      return new Response(JSON.stringify({ error: { message: 'direct route missing credentials' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    getSettingsMock.mockReset();
    await proxyManager.stop();
    nextPort += 10;
  });

  async function callActualBtsWithSettings(settings: AppSettings) {
    getSettingsMock.mockReturnValue(settings);
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes(`turn-bts-${nextPort}`, routeTable, undefined, nextPort++, false, true);
    registerBtsProxyProviders({ url: () => proxyManager.getUrl(), auth: () => proxyManager.getAuthToken() });

    return callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'connected',
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 128,
      timeout: 1000,
    }, { category: 'safety' });
  }

  it('does not silently stop for stale profile:<id> BTS references', async () => {
    const settings = makeSettings({
      activeProvider: 'codex',
      behindTheScenesModel: 'profile:deleted-profile',
    } as Partial<AppSettings>);

    // After S3 router sanitize, the stale `profile:<id>` reference no longer
    // reaches the wire; routing degrades to the BTS role default. The mock
    // upstream may still surface an error on the substituted default model,
    // but the wire body must NOT carry the stale `profile:<id>` string.
    await expect(callActualBtsWithSettings(settings)).rejects.toThrow();
    expect(capturedCodexBodies[0]?.model).not.toBe('profile:deleted-profile');
    expect(String(capturedCodexBodies[0]?.model ?? '')).not.toMatch(/^profile:/);
  });

  it('falls back to the request model when a routed Codex profile has an empty model', async () => {
    const emptyModelProfile = makeProfile({ id: 'empty-model-profile', model: '' });
    const routeTable: ModelRouteTable = { routes: new Map([['empty-model-profile', emptyModelProfile]]) };
    await proxyManager.addRoutes('turn-empty-model-profile', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-routed-turn-id': 'turn-empty-model-profile', 'x-routed-model': 'empty-model-profile' },
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain('Profile resolved');
    expect(capturedCodexBodies[0]).toMatchObject({ model: 'gpt-5.5' });
  });

  it('returns a clear error when a Codex-tagged profile has the wrong providerType', async () => {
    const wrongProviderProfile = makeProfile({
      id: 'wrong-provider-profile',
      providerType: 'google',
      serverUrl: 'https://api.invalid.test/v1',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['wrong-provider-profile', wrongProviderProfile]]) };
    await proxyManager.addRoutes('turn-wrong-provider-profile', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-routed-turn-id': 'turn-wrong-provider-profile', 'x-routed-model': 'wrong-provider-profile' },
    );

    expect(response.status).toBe(500);
    expect(response.body).toContain('Local model error (401)');
    expect(response.body).toContain('direct route missing credentials');
  });

  it('returns a clear error when an OpenAI profile has mismatched authSource', async () => {
    const mismatchedAuthProfile = makeProfile({
      id: 'mismatched-auth-profile',
      authSource: undefined,
    });
    const routeTable: ModelRouteTable = { routes: new Map([['mismatched-auth-profile', mismatchedAuthProfile]]) };
    await proxyManager.addRoutes('turn-mismatched-auth-profile', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-routed-turn-id': 'turn-mismatched-auth-profile', 'x-routed-model': 'mismatched-auth-profile' },
    );

    expect(response.status).toBe(500);
    expect(response.body).toContain('Local model error (401)');
    expect(response.body).not.toHaveLength(0);
  });

  it('does not silently stop for literal "default" BTS settings values', async () => {
    const settings = makeSettings({
      activeProvider: 'codex',
      behindTheScenesModel: 'default',
    } as Partial<AppSettings>);

    // memory-BTS route mismatch fix: the literal `default` is not a codex-servable
    // model (dialect `anthropic-native`, not `openai-compatible`), so the codex
    // route arm now fails CLOSED at the route seam with a clean `codex-unsupported-model`
    // terminal — observable, descriptive, and BEFORE the proxy egress — rather than
    // letting it reach the wire and 502 with the mocked upstream "unsupported model default".
    // The anti-silent-stop contract is preserved (it still throws); the throw is now
    // earlier and clearer. No body reaches the codex egress.
    await expect(callActualBtsWithSettings(settings)).rejects.toThrow(
      /ChatGPT Pro does not support background task model "default"/,
    );
    expect(capturedCodexBodies).toHaveLength(0);
  });

  it('does not silently stop when a referenced BTS profile was deleted before the turn fires', async () => {
    const settings = makeSettings({
      activeProvider: 'codex',
      behindTheScenesModel: 'profile:deleted-before-turn',
      localModel: { profiles: [], activeProfileId: null },
      claude: {},
      models: {},
    } as unknown as Partial<AppSettings>);

    // Same S3 router-sanitize contract: the stale profile reference is replaced
    // by the BTS role default before reaching the wire.
    await expect(callActualBtsWithSettings(settings)).rejects.toThrow();
    expect(capturedCodexBodies[0]?.model).not.toBe('profile:deleted-before-turn');
    expect(String(capturedCodexBodies[0]?.model ?? '')).not.toMatch(/^profile:/);
  });

  // Regression: storage-shaped `model:<id>` prefix MUST be decoded before reaching the wire.
  // Sentry REBEL-5EZ / 7465697085 -- when a user picked a Background-task model via the
  // AgentsTab, the codec wrote `behindTheScenesModel: 'model:<id>'` and the resolver
  // returned it verbatim, leaking the prefix into Codex/OpenRouter request bodies and
  // surfacing as 400 `The 'model:<id>' model is not supported when using Codex with a
  // ChatGPT account.` Reproduced empirically across gpt-5.4-mini and claude-haiku-4-5.
  // The mock fetch in this fixture always 502s the local proxy path (existing pattern),
  // so we assert by inspecting the captured wire body rather than success.
  it('decodes the model: prefix from behindTheScenesModel before the Codex wire body', async () => {
    const settings = makeSettings({
      activeProvider: 'codex',
      behindTheScenesModel: 'model:gpt-5.5',
    } as Partial<AppSettings>);

    await expect(callActualBtsWithSettings(settings)).rejects.toThrow();

    expect(capturedCodexBodies[0]).toMatchObject({ model: 'gpt-5.5', stream: false });
    expect(capturedCodexBodies[0]?.model).not.toMatch(/^model:/);
  });
});
