/**
 * bootRealAgentServices() — boot the REAL agent-turn service graph in Vitest.
 *
 * TEST-ONLY (never imported by production code). Stands up the production
 * agent-turn pipeline wired exactly as production wires it (via the proven
 * `createHeadlessRuntime`), with ONLY the outbound provider HTTP call stubbed
 * (`globalThis.fetch`). A consuming test can then drive a REAL `executeAgentTurn`
 * through the REAL services and catch executor↔service contract drift for real —
 * instead of mocking ~all collaborators (the 753-`vi.mock` status quo).
 *
 * Design + decisions: docs/plans/260609_agent-turn-executor-real-services-boot/PLAN.md
 * (DECIDED section + Stage 2). The recipe was proven by the Stage-1 GO/NO-GO spike
 * (subagent_reports/260609_182245_spike-go-nogo-stage01.md).
 *
 * ─── What is REAL vs STUBBED ───────────────────────────────────────────────
 *  REAL: the entire turn pipeline below the network seam — `executeAgentTurn`,
 *        `runAgentQuery`, `queryRouter`, `rebelCoreQuery`, `createClientFromRoutePlan`,
 *        `AnthropicClient`, admission, queryOptions assembly, the runtime registry.
 *  STUBBED: ONLY `globalThis.fetch`, S7-style with a fail-closed allowlist:
 *        - `127.0.0.1`            → real fetch (local proxy / Super-MCP stay real)
 *        - `api.anthropic.com` `/v1/messages` → canned SSE `text/event-stream`
 *        - everything else       → `throw` (records the escape; fail-closed)
 *
 * ─── CRITICAL: the canned response is an SSE STREAM, not plain JSON ─────────
 *  The turn STREAMS (anthropicClient.ts:1319 `messages.stream`; :1061 expects
 *  `text/event-stream`; :897 parses an SSE buffer). A plain-JSON 200 makes the
 *  streaming reader hang forever → test timeout (Stage-1 finding; cost ~88min
 *  before root-caused). So the fake emits the Anthropic streaming event sequence
 *  `message_start → content_block_start → content_block_delta(text_delta) →
 *  content_block_stop → message_delta(stop_reason) → message_stop`. This is a
 *  DELIBERATE divergence from the S7 reference (`providerWireContract.capture.test.ts`),
 *  which only does a non-streaming `.create()` and so returns plain JSON — DO NOT
 *  lift S7's fake verbatim.
 *
 * ─── Settings injection (the production seam, NOT vi.mock) ──────────────────
 *  Admission and the executor read settings via the module-level `getSettings()`
 *  from `@core/services/settingsStore` (turnAdmission.ts:182, agentTurnExecute.ts:122),
 *  which dispatches to whatever adapter `setSettingsStoreAdapter()` last installed.
 *  A reusable helper CANNOT use `vi.mock('@core/services/settingsStore')` (vi.mock is
 *  file-scoped + hoisted — it only fires in the consuming test file). Instead this
 *  helper installs its direct-Anthropic settings through the PRODUCTION seam
 *  `setSettingsStoreAdapter(...)` (the same seam knowledge-work-bootstrap.ts uses),
 *  overriding the test-safe default that `vitest.setup.ts` installs. PRECONDITION:
 *  `settingsStore` exposes only a setter (no getter — settingsStore.ts:41-44), so the
 *  prior adapter CANNOT be read back. `cleanup()` therefore does NOT restore an
 *  arbitrary previous adapter; it REINSTALLS a fresh byte-identical default matching
 *  `vitest.setup.ts:222-225`. This is correct for clean SERIAL boots over that default
 *  adapter (the documented usage), but it would CLOBBER a suite-installed custom adapter
 *  — a consuming suite that installs its own adapter must re-install it after cleanup().
 *  NO `vi.mock` of settingsStore is required in consuming tests (the smoke test proves this).
 *
 * ─── Admission false-green guard ───────────────────────────────────────────
 *  Admission fails CLOSED on an empty `coreDirectory` (turnAdmission.ts:198) AND on
 *  missing/invalid creds (:205-290). If either fired, a turn would terminate BEFORE
 *  the fetch seam and a naive test would still see "a turn ran" (silent false green).
 *  So the helper supplies a non-empty temp `coreDirectory` + a fake direct-Anthropic
 *  api-key. Consuming tests MUST assert POSITIVELY that the seam was reached
 *  (`capturedRequests.length === 1`, terminal success event, NO admission/error event).
 *
 * ─── Client-factory seam invariant ─────────────────────────────────────────
 *  `localModel:{activeProfileId:null,profiles:[]}` is REQUIRED: it keeps the
 *  `executionClient`/`planningClient` short-circuit (rebelCoreQuery.ts:1148-1155, set
 *  at agentTurnExecute.ts:4815-4820) INACTIVE, so the real client factory builds a real
 *  `AnthropicClient` that hits `globalThis.fetch` — the very seam this helper claims to
 *  exercise. Do not add a local profile to the default settings.
 *
 * ─── Singleton / lifecycle (READ THIS) ─────────────────────────────────────
 *  `createHeadlessRuntime` is a per-process SINGLETON (headlessRuntime.ts:357-360 throws
 *  if called twice). `cleanup()` resets it only AFTER abort/drain/bridge/file-index/proxy
 *  shutdown. Therefore:
 *   - ONE runtime per process. A consumer MUST `await cleanup()` (in `afterEach`) before
 *     booting another.
 *   - Suites using this helper run SERIAL in the slow/opt-in tier (Stage 4) — NOT the
 *     quick pre-push tier. Run `--no-file-parallelism`.
 *
 * ─── Executor service deps that RIDE ALONG (no boot-time wiring) ───────────
 *  Some `@main/services/*` deps of the executor need no `createHeadlessRuntime`
 *  wiring because they are module-level in-memory state or per-turn constructs
 *  the executor builds itself. They are still REAL in a booted turn:
 *   - `@main/services/safety/sessionApprovals` — pure in-memory module store
 *     (single-use approvals + execution expectations, FOX-2771 Stage 2). No
 *     init; the executor reads `currentApprovalSequence()` at entry and the
 *     guard/predicate query it per stop. Tests SEED it via the production API
 *     (`storeSingleUseApproval(...)`) before `runTurn`. Cross-boot hygiene:
 *     `cleanup()` calls `_testing_resetSingleUseApprovals()` so approvals
 *     stored by one test can never leak a forced continuation into the next.
 *   - `@main/services/safety/approvalExecutionGuardHook` — constructed INSIDE
 *     `agentTurnExecute`'s Stop-hook wiring on every turn with a sessionId and
 *     `bypassToolSafety !== true` (both true for `runTurn({options:{sessionId}})`
 *     defaults). Nothing to boot; the smoke test proves it is live by seeding
 *     an execution-expected approval and observing the guard's forced
 *     continuation as a SECOND provider request on the wire.
 *
 * ─── Extension seams (documented, NOT built here) ──────────────────────────
 *  The default helper targets the TEXT-ONLY, `skipMcp:true`, DIRECT-ANTHROPIC path.
 *  Two future variants are deliberately left un-built (see PLAN Stage 2):
 *   (i)  A `skipMcp:false` real-Super-MCP variant: drop the `skipMcp:true` config and
 *        let `127.0.0.1` fall through to the real local router; tool-liveness then
 *        becomes wire-observable (the deferred `runtimeRouting` migration). Costs a
 *        real Super-MCP boot + teardown (`proxyManager.stop()` already in cleanup()).
 *   (ii) An OpenAI-dialect option: extend the allowlist with `api.openai.com` `/v1/...`
 *        `chat/completions` and add a canned OpenAI-dialect SSE chunk sequence
 *        (`data: {choices:[{delta:{content}}]}` ... `data: [DONE]`), plus OpenAI-direct
 *        settings. Needed only to migrate `buildQueryOptions`'s OpenAI subtest; the
 *        default Anthropic-only allowlist would fail-closed `throw` on that host.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

import type { AppSettings } from '@shared/types';
import type { SettingsStoreAdapter } from '@core/services/settingsStore';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import {
  createHeadlessRuntime,
  type HeadlessRuntime,
  type HeadlessRuntimeConfig,
} from '@core/services/headlessRuntime';
import { _testing_resetSingleUseApprovals } from '@main/services/safety/sessionApprovals';
import { buildSettings, DEFAULT_TEST_SETTINGS } from '@core/__tests__/builders/settingsBuilder';

/** Fake direct-Anthropic API key surfaced as the `x-api-key` header on the wire. */
export const DEFAULT_DIRECT_ANTHROPIC_API_KEY = 'fake-test-anthropic-direct-key';
/** A routable Anthropic model id (must pass the real model-routing path). */
export const DEFAULT_ROUTABLE_MODEL = 'claude-sonnet-4-20250514';

/** Repo root, resolved relative to this file (src/test-utils/ → repo root is ../..). */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * One captured provider request (the canned-SSE branch of the fetch spy). The
 * `body` is the parsed JSON request body (the SDK always sends a JSON string body
 * to `/v1/messages`); `{}` if the body was not a string.
 */
export interface CapturedProviderRequest {
  url: string;
  method: string;
  /** Header names lower-cased for stable lookup (e.g. `x-api-key`, `content-type`). */
  headers: Record<string, string>;
  /**
   * The provider request body. For `/v1/messages` this is the parsed JSON object the
   * SDK sent; `{}` if the body was absent/non-string/non-Request. Typed `unknown`-ish
   * (an open JSON-object alias) so wire assertions are not locked to a forced shape —
   * cast at the assertion site (Stage 5).
   */
  body: Record<string, unknown>;
}

/**
 * Fail-closed override surface for `createHeadlessRuntime` config.
 *
 * The helper's whole point is that the REAL service graph runs unmodified below the
 * fetch seam. So graph-changing / dependency-injection / service-substitution fields
 * are forbidden BY TYPE — passing one is a compile error, not a silent false-green:
 *   - `__testOverrides`            (swaps deps wholesale; consumed before dep loading)
 *   - `executeAgentTurn`,
 *     `executeAgentTurnWithRecovery` (substitute the executor under test)
 *   - `getSettings`, `updateSettings` (the helper owns settings via the store seam)
 *   - `skipMcp`                    (the helper pins `true`; the real-MCP variant is un-built)
 *   - `preToolHook`, `memoryWriteHook` (alter tool/turn behavior mid-graph)
 * Plus the lifecycle-owned required fields the helper itself sets (`userDataDir`,
 * `resourcesDir`, `isPackaged`, `routerConfigPath`, `win`, `loadAgentSessions`,
 * `preOAuthCallHook`). Only safe knobs remain (timeouts / Super-MCP port hints / the
 * `afterCoreStartup` callback / opt-in service getters that don't touch the turn graph).
 */
export type SafeRuntimeConfigOverrides = Omit<
  HeadlessRuntimeConfig,
  | '__testOverrides'
  | 'executeAgentTurn'
  | 'executeAgentTurnWithRecovery'
  | 'getSettings'
  | 'updateSettings'
  | 'skipMcp'
  | 'preToolHook'
  | 'memoryWriteHook'
  | 'userDataDir'
  | 'resourcesDir'
  | 'isPackaged'
  | 'routerConfigPath'
  | 'win'
  | 'loadAgentSessions'
  | 'preOAuthCallHook'
>;

export interface BootRealAgentServicesOverrides {
  /**
   * Deep-ish settings overrides merged on top of the default direct-Anthropic
   * settings via `buildSettings()`. Override `claude`/`models` as PARTIALS (the
   * builder spreads them onto the defaults). NOTE: changing `localModel` to add an
   * active profile will activate the client short-circuit and defeat the seam — see
   * the invariant in the file header. Prefer leaving `localModel` alone.
   */
  settings?: Parameters<typeof buildSettings>[0];
  /**
   * Extra `createHeadlessRuntime` config — SAFE KNOBS ONLY (see `SafeRuntimeConfigOverrides`).
   * Graph-changing / DI fields (`__testOverrides`, `executeAgentTurn`, `getSettings`,
   * `skipMcp`, `preToolHook`, …) and the helper's lifecycle-owned required fields are
   * forbidden by type — passing one is a compile error. The required fields the helper
   * sets are applied AFTER this spread, so the helper's values genuinely take precedence.
   */
  runtimeConfig?: Partial<SafeRuntimeConfigOverrides>;
  /**
   * Override the fake assistant text emitted by the canned SSE stream. Default
   * `'real-boot-ok'`. Useful when a test wants to assert on the streamed content.
   */
  assistantText?: string;
}

export interface BootedRealAgentServices {
  /** The real headless runtime (singleton). Drive turns via `runtime.runTurn(...)`. */
  runtime: HeadlessRuntime;
  /**
   * Every provider request that hit the canned-SSE branch (host `api.anthropic.com`,
   * path `/v1/messages`). For a simple text turn this is exactly ONE — assert
   * `capturedRequests.length === 1` (Stage 3).
   */
  capturedRequests: CapturedProviderRequest[];
  /**
   * Non-allowlisted hosts the turn tried to reach (the fail-closed escapes). Should
   * be empty for a clean direct-Anthropic turn — assert `[]`.
   */
  unexpectedFetches: string[];
  /** Convenience passthrough to the runtime's per-turn event-listener seam. */
  setEventListener: HeadlessRuntime['setEventListener'];
  /**
   * Tear down: `runtime.cleanup()` (singleton reset + proxy stop, if started) +
   * restore the fetch spy + REINSTALL the default test settings adapter (NOT an
   * arbitrary prior adapter — settingsStore has no getter; see file header) + restore
   * the `REBEL_*` env vars to their pre-boot values + best-effort remove the temp
   * userDataDir/coreDirectory. MUST be awaited in `afterEach` before another
   * `bootRealAgentServices()` in the same process.
   */
  cleanup: () => Promise<void>;
}

/** SSE frame: `event: <name>\ndata: <json>\n\n`. */
function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Build the canned Anthropic streaming response. MUST be `text/event-stream`
 * (see file header) — a plain-JSON 200 hangs the streaming reader.
 */
function fakeAnthropicSseResponse(model: string, assistantText: string): Response {
  const chunks = [
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_real_boot',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: assistantText },
    }),
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
    sseFrame('message_stop', { type: 'message_stop' }),
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

/** Normalize a `fetch` init's headers into a lower-cased plain record. */
function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = String(value);
  } else {
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * Construction guard for the client-factory seam invariant (file header).
 *
 * An active local profile (or ANY profile present) makes the executor build a
 * pre-wired `directExecutionClient` from the active local profile
 * (agentTurnExecute.ts:3852-3868) and pass it into `rebelCoreQuery` as a
 * short-circuit client (rebelCoreQuery.ts:1148-1155), BYPASSING `createClientForModel()`
 * → the real `AnthropicClient` → `globalThis.fetch`. The whole helper would then be a
 * silent false-green: it would claim "the real client factory was exercised" while the
 * captured-fetch seam was never reached. So we throw, loudly, BEFORE booting.
 *
 * A local-model variant of this helper must be built explicitly (it needs a different
 * seam — there is no outbound HTTP for the directExecutionClient path to capture).
 */
function assertNoActiveLocalProfile(settings: AppSettings): void {
  const activeProfileId = settings.localModel?.activeProfileId;
  const profileCount = settings.localModel?.profiles?.length ?? 0;
  if (activeProfileId || profileCount > 0) {
    throw new Error(
      'bootRealAgentServices: an active local-model profile defeats the client-factory ' +
        '→ AnthropicClient → fetch seam this helper exercises (the executor would build a ' +
        'pre-wired directExecutionClient and never hit globalThis.fetch — a silent false-green). ' +
        `Got localModel.activeProfileId=${JSON.stringify(activeProfileId)}, ` +
        `localModel.profiles.length=${profileCount}. ` +
        'Do not set localModel.{activeProfileId,profiles} via overrides.settings; a local-model ' +
        'variant of this helper must be built explicitly (it captures a different seam).',
    );
  }
}

function buildDefaultSettings(
  coreDirectory: string,
  overrides: BootRealAgentServicesOverrides,
): AppSettings {
  const apiKeyModelBlock = {
    apiKey: DEFAULT_DIRECT_ANTHROPIC_API_KEY,
    oauthToken: null,
    authMethod: 'api-key' as const,
    model: DEFAULT_ROUTABLE_MODEL,
    planMode: false,
  };
  // `buildSettings` is the real settings builder (typed `permissionMode` etc.), so
  // the default literal type-checks under `lint:ts` — the spike's hand-rolled literal
  // tripped `ModelSettings.permissionMode`.
  return buildSettings({
    coreDirectory,
    onboardingCompleted: true,
    activeProvider: 'anthropic',
    // INVARIANT: no active local profile → client short-circuit stays inactive →
    // the real client factory is exercised (see file header).
    localModel: { activeProfileId: null, profiles: [] },
    ...overrides.settings,
    claude: { ...apiKeyModelBlock, ...overrides.settings?.claude },
    models: { ...apiKeyModelBlock, ...overrides.settings?.models },
  });
}

/**
 * Boot the real agent-turn service graph with only `globalThis.fetch` stubbed.
 * See the file header for the full contract (singleton lifecycle, the SSE-stream
 * requirement, the settings-injection seam, and the documented un-built variants).
 *
 * Usage:
 * ```ts
 * let booted: Awaited<ReturnType<typeof bootRealAgentServices>>;
 * afterEach(async () => { await booted.cleanup(); });
 * it('runs a real direct-Anthropic turn', async () => {
 *   booted = await bootRealAgentServices();
 *   const events: AgentEvent[] = [];
 *   await booted.runtime.runTurn({
 *     prompt: 'Say hello',
 *     onEvent: (e) => events.push(e),
 *     options: { sessionType: 'cli', persistMode: { kind: 'none' } },
 *   });
 *   expect(booted.capturedRequests).toHaveLength(1);
 * });
 * ```
 */
export async function bootRealAgentServices(
  overrides: BootRealAgentServicesOverrides = {},
): Promise<BootedRealAgentServices> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-boot-userdata-'));
  const coreDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'real-boot-core-'));

  // Env knobs — set before createHeadlessRuntime triggers any @main import side
  // effects (electron-store reads REBEL_USER_DATA). The helper is loaded after the
  // test file's top-level imports, so we set them here defensively; the smoke test
  // also runs in the |desktop| project where vitest.setup.ts has already run.
  // F4: capture prior values FIRST so cleanup() can restore/delete them (no env leak
  // into the next suite in the same worker).
  const ENV_KEYS = ['REBEL_USER_DATA', 'REBEL_HEADLESS', 'REBEL_DISABLE_APP_BRIDGE'] as const;
  const priorEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
    REBEL_USER_DATA: process.env.REBEL_USER_DATA,
    REBEL_HEADLESS: process.env.REBEL_HEADLESS,
    REBEL_DISABLE_APP_BRIDGE: process.env.REBEL_DISABLE_APP_BRIDGE,
  };
  const restoreEnv = (): void => {
    for (const key of ENV_KEYS) {
      const prev = priorEnv[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
  // Best-effort removal of the two temp dirs. coreStartup.ts:611-641 fire-and-forgets a
  // conflict-copy scan, so only remove dirs AFTER runtime.cleanup() (in cleanup()/catch).
  const removeTempDirs = (): void => {
    for (const dir of [userDataDir, coreDirectory]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort: a lingering async handle may briefly hold the dir */
      }
    }
  };
  process.env.REBEL_USER_DATA = userDataDir;
  process.env.REBEL_HEADLESS = '1';
  if (!process.env.REBEL_DISABLE_APP_BRIDGE) process.env.REBEL_DISABLE_APP_BRIDGE = '1';

  const settings = buildDefaultSettings(coreDirectory, overrides);
  assertNoActiveLocalProfile(settings);
  const assistantText = overrides.assistantText ?? 'real-boot-ok';

  // ── Settings injection via the PRODUCTION seam (NOT vi.mock). ──
  // Install our direct-Anthropic adapter, overriding vitest.setup.ts's test-safe
  // default. cleanup() restores a default-test-settings adapter so we don't leak
  // into other suites in the same worker (see restoreDefaultSettingsAdapter).
  const helperAdapter: SettingsStoreAdapter = {
    getSettings: () => settings,
    updateSettings: () => { /* settings are fixed for the booted turn */ },
    updateSettingsAtomic: () => { /* no-op: helper settings are immutable */ },
  };
  setSettingsStoreAdapter(helperAdapter);

  // ── S7-style fetch spy with the SSE-stream fake + fail-closed allowlist. ──
  const capturedRequests: CapturedProviderRequest[] = [];
  const unexpectedFetches: string[] = [];
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === '127.0.0.1') {
        return originalFetch(input, init);
      }
      if (parsed.hostname === 'api.anthropic.com' && parsed.pathname === '/v1/messages') {
        // F5: also handle the SDK passing a `Request` object (not just (url, init)).
        // Prefer `init` when present (the SDK's current shape), else read from the Request.
        const isRequest = input instanceof Request;
        const method = init?.method ?? (isRequest ? input.method : 'GET');
        const headers = init?.headers
          ? normalizeHeaders(init.headers)
          : isRequest
            ? normalizeHeaders(input.headers)
            : {};
        let bodyText: string | undefined;
        if (typeof init?.body === 'string') {
          bodyText = init.body;
        } else if (isRequest) {
          // `Request` body is a one-shot stream; clone before reading so we never
          // consume the body the SDK is about to send (we return our own fake anyway).
          bodyText = await input.clone().text();
        }
        let body: Record<string, unknown> = {};
        if (bodyText) {
          try {
            body = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            body = {};
          }
        }
        capturedRequests.push({ url, method, headers, body });
        return fakeAnthropicSseResponse(DEFAULT_ROUTABLE_MODEL, assistantText);
      }
      // Fail-closed: any other non-local host is an unexpected network escape.
      unexpectedFetches.push(url);
      throw new Error(`bootRealAgentServices: unexpected non-local fetch to ${url}`);
    });

  // Runtime backstop for the type-level SafeRuntimeConfigOverrides Omit: a consumer using
  // `as any` / a cast could still smuggle a graph-defeating field past the compiler. Fail
  // CLOSED here so the real-graph + provider-seam invariant holds even under TS escape
  // hatches. (GPT final-review F1.)
  if (overrides.runtimeConfig) {
    const FORBIDDEN_RUNTIME_CONFIG_KEYS = [
      '__testOverrides',
      'executeAgentTurn',
      'executeAgentTurnWithRecovery',
      'getSettings',
      'updateSettings',
      'skipMcp',
      'preToolHook',
      'memoryWriteHook',
      'userDataDir',
      'resourcesDir',
      'isPackaged',
      'routerConfigPath',
      'win',
      'loadAgentSessions',
      'preOAuthCallHook',
    ];
    const smuggled = Object.keys(overrides.runtimeConfig).filter((k) =>
      FORBIDDEN_RUNTIME_CONFIG_KEYS.includes(k),
    );
    if (smuggled.length > 0) {
      throw new Error(
        `bootRealAgentServices: runtimeConfig may not override graph-defeating/DI field(s): ` +
          `${smuggled.join(', ')}. These would bypass the real service graph or the provider ` +
          `seam the helper exists to exercise. Build an explicit variant instead.`,
      );
    }
  }

  let runtime: HeadlessRuntime;
  try {
    runtime = await createHeadlessRuntime({
      // Safe knobs first — the helper's required/graph-owning fields below OVERRIDE them.
      // (The override type already forbids graph-changing/DI fields by `Omit`; this spread
      // order makes that doubly true so the "required fields take precedence" claim holds.)
      ...overrides.runtimeConfig,
      userDataDir,
      resourcesDir: path.join(REPO_ROOT, 'resources'),
      isPackaged: false,
      routerConfigPath: path.join(coreDirectory, 'super-mcp-router.json'),
      getSettings: () => settings,
      updateSettings: () => { /* fixed settings for the booted turn */ },
      win: null,
      loadAgentSessions: () => [],
      preOAuthCallHook: () => Promise.resolve(),
      skipMcp: true,
    });
  } catch (err) {
    // Boot failed — undo the global side effects so we don't poison the next suite.
    fetchSpy.mockRestore();
    restoreDefaultSettingsAdapter();
    restoreEnv();
    _testing_resetSingleUseApprovals();
    // No runtime to tear down (boot threw); temp dirs are safe to remove now.
    removeTempDirs();
    throw err;
  }

  const cleanup = async (): Promise<void> => {
    try {
      await runtime.cleanup();
    } finally {
      fetchSpy.mockRestore();
      restoreDefaultSettingsAdapter();
      restoreEnv();
      // Reset the in-memory single-use approval store (rides along with the
      // executor — see "Executor service deps that RIDE ALONG" in the header).
      // Without this, an approval seeded by one test could trigger the
      // approval-execution guard's forced continuation in the NEXT booted turn.
      _testing_resetSingleUseApprovals();
      // AFTER runtime teardown (coreStartup's fire-and-forget conflict-copy scan must
      // have stopped touching these dirs) — best-effort recursive removal.
      removeTempDirs();
    }
  };

  return {
    runtime,
    capturedRequests,
    unexpectedFetches,
    setEventListener: runtime.setEventListener,
    cleanup,
  };
}

// ── Settings-adapter restore ──
// settingsStore.ts keeps a module-private `_adapter` with a setter but NO getter, so
// the prior adapter cannot be read back to restore it. We don't need to: the only
// adapter installed before this helper runs is vitest.setup.ts's STATELESS test-safe
// default (`getSettings: () => structuredClone(DEFAULT_TEST_SETTINGS)`, no-op writes).
// `cleanup()` re-installs a byte-identical default so subsequent suites in the same
// worker see exactly what vitest.setup.ts gave them. (If a consuming test installs its
// OWN adapter before booting, it should re-install it after cleanup — documented.)
function restoreDefaultSettingsAdapter(): void {
  setSettingsStoreAdapter({
    getSettings: () => structuredClone(DEFAULT_TEST_SETTINGS),
    updateSettings: () => { /* no-op in tests (matches vitest.setup.ts) */ },
    updateSettingsAtomic: () => { /* no-op in tests (matches vitest.setup.ts) */ },
  });
}
