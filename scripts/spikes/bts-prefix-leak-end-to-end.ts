/**
 * BTS Prefix Leak End-to-End Spike
 *
 * Empirically validates that the Phase 2 (a) decoder pipeline produces
 * clean wire requests for both the S2 (normalizer) and S2.5 (sink) paths.
 *
 * REQUIRES:
 *   - RUN_BTS_PREFIX_SPIKE=1 (explicit opt-in)
 *   - ANTHROPIC_API_KEY (preferred) or OPENROUTER_API_KEY
 *
 * Cost: ~$0.001 on Anthropic; up to ~$0.05 on OpenRouter (proxy floor 4096 tokens).
 * SAFETY: This script makes real API calls. Run only when needed.
 *
 * Run: npm run spike:bts-prefix-leak
 * Or:  npx tsx scripts/spikes/bts-prefix-leak-end-to-end.ts
 */

import path from 'node:path';
import type { AppSettings } from '@shared/types';
import { stripStoredModelPrefix } from '@shared/utils/modelChoiceCodec';
import {
  callWithModelAuthAware,
  registerBtsProxyProviders,
} from '@core/services/behindTheScenesClient';
import { clearLogBuffer, getRecentLogs } from '@core/logger';

type CredentialKind = 'anthropic' | 'openrouter';

interface ResolvedCredential {
  kind: CredentialKind;
  envName: 'ANTHROPIC_API_KEY' | 'OPENROUTER_API_KEY';
  key: string;
}

interface WireCapture {
  url: string;
  model: string | null;
  maxTokens: number | null;
  status: number;
}

interface ScenarioResult {
  wireModel: string;
  maxTokens: number;
  maxTokensLabel: string;
  maxTokensWarn: boolean;
  status: number;
  sinkWarnFired: boolean;
}

const BARE_MODEL = 'claude-haiku-4-5';
const PREFIXED_MODEL = `model:${BARE_MODEL}`;
const MINIMAL_PROMPT = `Reply with just 'OK' and nothing else.`;
const SINK_BACKSTOP_WARN =
  'sink-boundary backstop stripped a `model:` prefix — upstream caller bypassed S2; investigate';

function resolveCredential(): ResolvedCredential | null {
  const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) {
    return { kind: 'anthropic', envName: 'ANTHROPIC_API_KEY', key: anthropic };
  }

  const openRouter = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouter) {
    return { kind: 'openrouter', envName: 'OPENROUTER_API_KEY', key: openRouter };
  }

  return null;
}

function ensureLoggerEnv(): void {
  process.env.REBEL_USER_DATA ??= path.join(process.cwd(), '.tmp', 'bts-prefix-spike-user-data');
  process.env.REBEL_VERSION ??= '0.0.0-bts-prefix-spike';
}

function makeSyntheticSettings(credential: ResolvedCredential): AppSettings {
  const settings = {
    activeProvider: credential.kind === 'openrouter' ? 'openrouter' : 'anthropic',
    coreDirectory: '/tmp/bts-prefix-spike',
    behindTheScenesModel: PREFIXED_MODEL,
    providerKeys: credential.kind === 'openrouter' ? { openrouter: credential.key } : {},
    customProviders: [],
    claude: {
      apiKey: credential.kind === 'anthropic' ? credential.key : null,
      oauthToken: null,
      authMethod: 'api-key',
      model: BARE_MODEL,
    },
    openRouter: credential.kind === 'openrouter'
      ? { enabled: true, oauthToken: credential.key }
      : { enabled: false, oauthToken: null },
    localModel: {
      activeProfileId: null,
      profiles: [],
    },
  } as AppSettings;

  return settings;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function captureWireBody(init?: RequestInit): { model: string | null; maxTokens: number | null } {
  if (!init || typeof init.body !== 'string') {
    return { model: null, maxTokens: null };
  }
  try {
    const parsed = JSON.parse(init.body) as { model?: unknown; max_tokens?: unknown; maxTokens?: unknown };
    return {
      model: typeof parsed.model === 'string' ? parsed.model : null,
      maxTokens: parseFiniteNumber(parsed.max_tokens ?? parsed.maxTokens),
    };
  } catch {
    return { model: null, maxTokens: null };
  }
}

function isTargetUrl(url: string): boolean {
  return url.includes('api.anthropic.com/v1/messages') || url.includes('openrouter.ai/api/v1/messages');
}

function toUrlString(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function evaluateMaxTokens(capture: WireCapture, credential: ResolvedCredential, scenarioName: string): {
  maxTokens: number;
  maxTokensLabel: string;
  maxTokensWarn: boolean;
} {
  if (capture.maxTokens === null) {
    throw new Error(`${scenarioName}: failed to capture outbound max_tokens`);
  }

  if (credential.kind === 'anthropic') {
    const anthropicMaxTokensOk = capture.maxTokens === 16 || capture.maxTokens <= 100;
    if (!anthropicMaxTokensOk) {
      throw new Error(
        `${scenarioName}: expected Anthropic max_tokens to be 16 or <=100, got ${capture.maxTokens}`,
      );
    }

    return {
      maxTokens: capture.maxTokens,
      maxTokensLabel: `${capture.maxTokens} (Anthropic)`,
      maxTokensWarn: false,
    };
  }

  const maxTokensWarn = capture.maxTokens > 100;
  if (maxTokensWarn) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'bts-prefix-spike-openrouter-max-tokens-floor',
      status: 'WARN',
      scenario: scenarioName,
      max_tokens: capture.maxTokens,
      message: 'OpenRouter path inflated max_tokens above requested 16 (known proxy floor).',
    }));
  }

  return {
    maxTokens: capture.maxTokens,
    maxTokensLabel: `${capture.maxTokens} (OpenRouter${maxTokensWarn ? '; proxy floor known constraint' : ''})`,
    maxTokensWarn,
  };
}

function didSinkWarnFire(): boolean {
  const logs = getRecentLogs(60_000);
  return logs.some((entry) =>
    entry.message === SINK_BACKSTOP_WARN
    && entry.data?.sinkName === 'callWithModelAuthAware',
  );
}

async function runScenario(
  name: string,
  settings: AppSettings,
  modelInput: string | undefined,
  expectSinkWarn: boolean,
  credential: ResolvedCredential,
): Promise<ScenarioResult> {
  const originalFetch = globalThis.fetch.bind(globalThis);
  let capture: WireCapture | null = null;

  try {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = toUrlString(input);
      let nextInit = init;

      // OpenRouter compatibility mode:
      // BTS openrouter transport sends proxy headers (x-proxy-auth). For this spike
      // we hit OpenRouter's Anthropic-compatible endpoint directly, so we map that
      // proxy header to Authorization.
      if (url.includes('openrouter.ai/api/v1/messages')) {
        const headers = new Headers(nextInit?.headers ?? (input instanceof Request ? input.headers : undefined));
        const proxyAuth = headers.get('x-proxy-auth') ?? credential.key;
        if (proxyAuth) headers.set('authorization', `Bearer ${proxyAuth}`);
        headers.delete('x-proxy-auth');
        nextInit = { ...nextInit, headers };
      }

      const response = await originalFetch(input, nextInit);

      if (isTargetUrl(url)) {
        const wireBody = captureWireBody(nextInit);
        capture = {
          url,
          model: wireBody.model,
          maxTokens: wireBody.maxTokens,
          status: response.status,
        };
      }

      return response;
    };

    clearLogBuffer();

    const response = await callWithModelAuthAware(
      settings,
      modelInput,
      {
        messages: [{ role: 'user', content: MINIMAL_PROMPT }],
        maxTokens: 16,
        temperature: 0,
      },
      { category: 'memory' },
    );

    if (!capture) {
      throw new Error(`${name}: failed to capture outbound wire request body`);
    }
    if (capture.model !== BARE_MODEL) {
      throw new Error(`${name}: expected wire model '${BARE_MODEL}', got '${capture.model ?? '<missing>'}'`);
    }
    if (capture.status !== 200) {
      throw new Error(`${name}: expected HTTP 200, got ${capture.status}`);
    }
    if (!Array.isArray(response.content) || response.content.length === 0) {
      throw new Error(`${name}: API response missing content blocks`);
    }

    const { maxTokens, maxTokensLabel, maxTokensWarn } = evaluateMaxTokens(capture, credential, name);

    const sinkWarnFired = didSinkWarnFire();
    if (sinkWarnFired !== expectSinkWarn) {
      throw new Error(
        `${name}: expected sink warn ${expectSinkWarn ? 'to fire' : 'not to fire'}, but observed ${sinkWarnFired}`,
      );
    }

    return {
      wireModel: capture.model,
      maxTokens,
      maxTokensLabel,
      maxTokensWarn,
      status: capture.status,
      sinkWarnFired,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  if (process.env.RUN_BTS_PREFIX_SPIKE !== '1') {
    console.warn(JSON.stringify({
      level: 'warn',
      status: 'SKIP',
      reason: 'explicit-opt-in-required',
      message: 'Set RUN_BTS_PREFIX_SPIKE=1 to enable real API calls.',
      hint: 'RUN_BTS_PREFIX_SPIKE=1 ANTHROPIC_API_KEY=sk-... npm run spike:bts-prefix-leak',
    }));
    process.exit(0);
  }

  const credential = resolveCredential();
  if (!credential) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'bts-prefix-spike-skip',
      status: 'SKIP',
      reason: 'no-api-credentials',
      message: 'SKIP: no API credentials available (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY).',
      hint: 'RUN_BTS_PREFIX_SPIKE=1 ANTHROPIC_API_KEY=sk-... npm run spike:bts-prefix-leak',
    }));
    return;
  }

  ensureLoggerEnv();
  const settings = makeSyntheticSettings(credential);

  if (credential.kind === 'openrouter') {
    registerBtsProxyProviders({
      url: () => 'https://openrouter.ai/api',
      auth: () => credential.key,
    });
  }
  // For the anthropic credential path the BTS call routes direct (no proxy), so
  // the proxy seam is left unwired — correct: if a proxy path were ever hit it
  // would now throw BtsProxyNotWiredError loudly rather than silently no-op.

  try {
    const decoded = stripStoredModelPrefix(settings.behindTheScenesModel ?? '');
    const scenario1Model = decoded ?? BARE_MODEL;

    const scenario1 = await runScenario(
      'Scenario 1',
      settings,
      scenario1Model,
      false,
      credential,
    );

    const scenario2 = await runScenario(
      'Scenario 2',
      settings,
      PREFIXED_MODEL,
      true,
      credential,
    );

    console.log('=== BTS Prefix Leak End-to-End Spike ===');
    console.log(`Credentials: ${credential.envName} (present)`);
    console.log(
      credential.kind === 'anthropic'
        ? 'Cost estimate: ~$0.001 (Anthropic)'
        : 'Cost estimate: up to ~$0.05 (OpenRouter proxy floor may inflate max_tokens)',
    );
    console.log('');
    console.log('Scenario 1:');
    console.log(`  Model: '${scenario1.wireModel}' (bare) ✓`);
    console.log(
      `  max_tokens: ${scenario1.maxTokensLabel} ${scenario1.maxTokensWarn ? '⚠ (warning only)' : '✓'}`,
    );
    console.log(`  Status: ${scenario1.status} ✓`);
    console.log(`  Sink warn: ${scenario1.sinkWarnFired ? 'DID fire' : 'did NOT fire (S2 caught it)'} ✓`);
    console.log('');
    console.log('Scenario 2:');
    console.log(`  Model: '${scenario2.wireModel}' (sink stripped) ✓`);
    console.log(
      `  max_tokens: ${scenario2.maxTokensLabel} ${scenario2.maxTokensWarn ? '⚠ (warning only)' : '✓'}`,
    );
    console.log(`  Status: ${scenario2.status} ✓`);
    console.log(`  Sink warn: ${scenario2.sinkWarnFired ? 'DID fire' : 'did NOT fire'} ✓`);
    console.log('');
    console.log('PASS — Phase 2 (a) decoder pipeline produces clean wire requests.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('=== BTS Prefix Leak End-to-End Spike ===');
    console.error(`Credentials: ${credential.envName} (present)`);
    console.error('');
    console.error(`FAIL — ${message}`);
    process.exitCode = 1;
  }
}

void main();
