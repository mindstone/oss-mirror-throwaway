/**
 * Turn Pipeline Replay — Test Driver (R1 Stage 1C Phase 1)
 *
 * Stage 1C Phase 1 ships the central mock-driver infrastructure plus 8
 * representative shipped corpus rows. The infrastructure lifts the heavy
 * `vi.mock(...)` block ONCE (Option A from the parent brief — vi.mock
 * blocks must live alongside the test file because Vitest hoists them
 * per file) and exposes `runMonolithUnderHarness(scenario, harness)` for
 * row-specific scenario configuration.
 *
 * Each shipped row's fixture JSON contains:
 *   - `input` — the scenario configuration (turnOptions, prompt, settings
 *     overrides, mock behaviors).
 *   - `expected` — the canonical trace recorded from a real
 *     `executeAgentTurn(...)` invocation under the harness, locked as a
 *     byte-equivalent regression check.
 *
 * Recording mode: Set `RECORD_REPLAY_FIXTURES=1` to overwrite the
 *   `expected` block of each fixture with the freshly-recorded trace.
 *   Without the flag, tests load the saved `expected` and assert
 *   byte-equivalent (`expect(actual).toEqual(fixture.expected)`).
 *
 * See:
 *   - `docs/plans/260427_refactor_agent_turn_executor_pipeline.md` (Stage 1C)
 *   - `docs/plans/260427_r1_stage1b_working_notes.md` (Stage 1C spike findings)
 *   - `docs/plans/260427_r1_stage1c_phase1_working_notes.md` (this phase)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBuildContinuationContextMock,
  createModelNormalizationMock,
} from './agentTurnExecutor.testHarness';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CORPUS_INDEX, type CorpusRow } from './fixtures/turnPipelineReplay/corpusIndex';
import {
  installReplayHarness,
  type ReplayHarnessHandle,
  type ReplayRecorder,
} from './turnPipelineReplay.harness';
import { canonicalize, type CanonicalizedTrace } from './turnPipelineReplay.canonicalizer';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'turnPipelineReplay');
const RECORD_MODE = process.env.RECORD_REPLAY_FIXTURES === '1';

// ---------------------------------------------------------------------------
// vi.hoisted shared state — accessible from inside `vi.mock(...)` factories.
// ---------------------------------------------------------------------------
const {
  harnessRef,
  scenarioRef,
  queryMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  resolveModelConfigMock,
  stripExtendedContextFromConfigMock,
  isExtendedContextUnavailableErrorMock,
  getErrorKindMock,
  getSettingsMock,
  hasValidAuthMock,
  cleanupTurnMock,
  setActiveTurnControllerMock,
  setRendererSessionMock,
  recordSessionTurnMock,
  setTurnPromptMock,
  setTurnLoggerMock,
  setTurnPrivateModeMock,
  setTurnCategoryMock,
  setTurnExtendedContextMock,
  setTurnThinkingEffortMock,
  setTurnAuthMethodMock,
  setTurnSpawnDelayedMock,
  setTurnModelMock,
  cleanupForRetryMock,
  addTurnFallbackMock,
  hasSessionHadTurnsMock,
  getRendererSessionMock,
  clearExtendedContextFailedMock,
  addRoutesMock,
  removeRoutesMock,
  getAndResetTurnStatsMock,
  getUrlMock,
  getAuthTokenMock,
  resolveMcpServersMock,
  resolveSystemPromptMock,
  buildConnectedPackagesMock,
  appendCostEntryMock,
  captureExceptionMock,
  captureMessageMock,
  setupNodeEnvironmentMock,
  chatSessionCreatedMock,
  apiRateLimitRecordSuccessMock,
  apiRateLimitUpdateLastApiCallTimeMock,
  buildCouncilConfigMock,
  resolveCouncilLeadModelMock,
  detectModelReferencesMock,
  buildAdHocAgentConfigMock,
  detectClaudeModelReferencesMock,
  buildClaudeSubagentConfigMock,
  getThinkingProfileMock,
  getWorkingProfileMock,
  delayWithAbortMock,
  mockTurnLogger,
  rootLoggerMock,
  preTurnWorkerIsAvailableMock,
  preTurnWorkerGetStatusMock,
  preTurnWorkerWaitForReadyMock,
  preTurnWorkerAssembleMock,
  preTurnWorkerDisposeMock,
  startCheckpointingMock,
  stopCheckpointingMock,
  getTurnCheckpointManagerMock,
  _activeQueryImpl,
  getActiveTurnCountMock,
  apiRateLimitRemainingMsMock,
} = vi.hoisted(() => {
  const harnessRef: { current: ReplayHarnessHandle | null } = { current: null };
  const scenarioRef: { current: ScenarioMockOverrides } = { current: {} };

  const recorder = (): ReplayRecorder | null => harnessRef.current?.recorder ?? null;
  // Helpers that record into the active harness when present. Use these
  // wrappers everywhere a real production module surface fires a side
  // effect we need in the canonical trace.
  const recordEvent = (method: string, args: unknown[]) =>
    recorder()?.recordEvent(method, args);
  const recordRegistry = (method: string, args: unknown[]) =>
    recorder()?.recordRegistry(method, args);
  const recordSentry = (method: 'captureException' | 'captureMessage' | 'reportMcpError', args: unknown[]) =>
    recorder()?.recordSentry(method, args);
  const recordLog = (method: 'info' | 'warn' | 'error' | 'debug', args: unknown[]) =>
    recorder()?.recordLog(method, args);
  const recordCost = (method: string, args: unknown[]) =>
    recorder()?.recordCost(method, args);
  const recordProxy = (method: 'addRoutes' | 'removeRoutes' | 'getAndResetTurnStats', args: unknown[]) =>
    recorder()?.recordProxy(method, args);
  const recordTracking = (method: string, args: unknown[]) =>
    recorder()?.recordTracking(method, args);
  const recordCooldown = (
    method: 'recordSuccess' | 'recordRateLimit' | 'updateLastApiCallTime' | 'remainingMs',
    args: unknown[],
  ) => recorder()?.recordCooldown(method, args);
  const recordEnv = (method: 'setPath' | 'setAuthEnvVar' | 'unsetEnvVar', args: unknown[]) =>
    recorder()?.recordEnvMutation(method, args);
  const recordQuery = (method: 'queryWithRuntime' | 'queryEnded', args: unknown[]) =>
    recorder()?.recordQuery(method, args);

  // Pino-style logger that fans out to the harness recorder.
  const mockTurnLogger = {
    info: vi.fn((...args: unknown[]) => recordLog('info', args)),
    warn: vi.fn((...args: unknown[]) => recordLog('warn', args)),
    error: vi.fn((...args: unknown[]) => recordLog('error', args)),
    debug: vi.fn((...args: unknown[]) => recordLog('debug', args)),
    trace: vi.fn(),
    child: vi.fn(),
    flushSessionLogs: vi.fn(async () => {}),
    sessionLogPath: '/tmp/test-turn.log',
  };
  const rootLoggerMock = {
    info: vi.fn((...args: unknown[]) => recordLog('info', args)),
    warn: vi.fn((...args: unknown[]) => recordLog('warn', args)),
    error: vi.fn((...args: unknown[]) => recordLog('error', args)),
    debug: vi.fn((...args: unknown[]) => recordLog('debug', args)),
  };

  // Recording-enabled side-effect mocks. Each forwards args into the
  // harness so the canonical trace captures the exact production-shape
  // invocation.
  const dispatchAgentEventMock = vi.fn((win: unknown, turnId: string, event: unknown) => {
    recordEvent('dispatchAgentEvent', [win, turnId, event]);
  });
  // dispatchAgentErrorEvent forwards through dispatchAgentEvent for unified
  // event recording (mirrors the runtime behaviour where error events are
  // structurally indistinguishable from `{type: 'error', ...}`).
  const dispatchAgentErrorEventMock = vi.fn((
    win: unknown,
    turnId: string,
    rawError: unknown,
    opts?: {
      humanizedOverride?: string;
      isTransient?: boolean;
      errorKindOverride?: string;
      providerOverride?: string;
      timeoutDiagnostic?: unknown;
      watchdogDiagnostic?: unknown;
      rateLimitMetaOverride?: unknown;
      timestampOverride?: number;
    },
  ) => {
    const rawMessage =
      typeof rawError === 'string'
        ? rawError
        : rawError instanceof Error
          ? rawError.message
          : String(rawError ?? '');
    const event: Record<string, unknown> = {
      type: 'error',
      error: opts?.humanizedOverride ?? rawMessage,
      errorSource: 'main',
      timestamp: opts?.timestampOverride ?? 0,
    };
    if (opts?.isTransient !== undefined) event.isTransient = opts.isTransient;
    if (opts?.errorKindOverride) event.errorKind = opts.errorKindOverride;
    if (opts?.providerOverride) event.provider = opts.providerOverride;
    if (opts?.timeoutDiagnostic) event.timeoutDiagnostic = opts.timeoutDiagnostic;
    if (opts?.watchdogDiagnostic) event.watchdogDiagnostic = opts.watchdogDiagnostic;
    if (opts?.errorKindOverride === 'rate_limit' && opts?.rateLimitMetaOverride) {
      event.rateLimitMeta = opts.rateLimitMetaOverride;
    }
    recordEvent('dispatchAgentEvent', [win, turnId, event]);
    return { ok: true as const };
  });

  // Registry mocks: every mutation flows through recordRegistry.
  const setActiveTurnControllerMock = vi.fn((turnId: string, ctrl: unknown) => {
    recordRegistry('setActiveTurnController', [turnId, ctrl]);
  });
  const setRendererSessionMock = vi.fn((turnId: string, sessionId: string | null) => {
    recordRegistry('setRendererSession', [turnId, sessionId]);
  });
  const recordSessionTurnMock = vi.fn((sessionId: string, turnId: string) => {
    recordRegistry('recordSessionTurn', [sessionId, turnId]);
  });
  const setTurnPromptMock = vi.fn((turnId: string, prompt: string) => {
    recordRegistry('setTurnPrompt', [turnId, prompt]);
  });
  const setTurnLoggerMock = vi.fn((turnId: string) => {
    recordRegistry('setTurnLogger', [turnId]);
  });
  const setTurnPrivateModeMock = vi.fn((turnId: string, mode: boolean) => {
    recordRegistry('setTurnPrivateMode', [turnId, mode]);
  });
  const setTurnCategoryMock = vi.fn((turnId: string, category: string) => {
    recordRegistry('setTurnCategory', [turnId, category]);
  });
  const setTurnExtendedContextMock = vi.fn((turnId: string, enabled: boolean) => {
    recordRegistry('setTurnExtendedContext', [turnId, enabled]);
  });
  const setTurnThinkingEffortMock = vi.fn((turnId: string, effort: unknown) => {
    recordRegistry('setTurnThinkingEffort', [turnId, effort]);
  });
  const setTurnAuthMethodMock = vi.fn((turnId: string, method: unknown) => {
    recordRegistry('setTurnAuthMethod', [turnId, method]);
  });
  const setTurnSpawnDelayedMock = vi.fn((turnId: string, delayed: boolean) => {
    recordRegistry('setTurnSpawnDelayed', [turnId, delayed]);
  });
  const setTurnModelMock = vi.fn((turnId: string, model: string) => {
    recordRegistry('setTurnModel', [turnId, model]);
  });
  const cleanupTurnMock = vi.fn((turnId: string) => {
    recordRegistry('cleanupTurn', [turnId]);
  });
  const cleanupForRetryMock = vi.fn((turnId: string) => {
    recordRegistry('cleanupForRetry', [turnId]);
  });
  const addTurnFallbackMock = vi.fn((turnId: string, fb: unknown) => {
    recordRegistry('addTurnFallback', [turnId, fb]);
  });
  const hasSessionHadTurnsMock = vi.fn(() => false);
  const getRendererSessionMock = vi.fn(() => null);
  const clearExtendedContextFailedMock = vi.fn((turnId: string) => {
    recordRegistry('clearExtendedContextFailed', [turnId]);
  });

  // Proxy mocks: addRoutes / removeRoutes recorded for council/ad-hoc/single-provider.
  const addRoutesMock = vi.fn(async (turnId: string, routes: unknown) => {
    recordProxy('addRoutes', [turnId, routes]);
  });
  const removeRoutesMock = vi.fn((turnId: string) => {
    recordProxy('removeRoutes', [turnId]);
  });
  const getAndResetTurnStatsMock = vi.fn(() => {
    recordProxy('getAndResetTurnStats', []);
    return new Map();
  });
  const getUrlMock = vi.fn(() => 'http://proxy.local');
  const getAuthTokenMock = vi.fn(() => 'proxy-auth-token');

  // MCP / system prompt resolution. Untyped via `as ReturnType<typeof vi.fn>`
  // so per-row scenarios can override `mode` to 'direct' (with a non-null
  // servers map) or invoke abort-via-implementation hooks without TS
  // narrowing the inferred 'unavailable' literal type.
  const resolveMcpServersMock = vi.fn(async () => ({
    servers: undefined,
    mode: 'unavailable' as const,
    upstreamCount: 0,
    configPath: undefined,
  })) as ReturnType<typeof vi.fn>;
  const resolveSystemPromptMock = vi.fn(async () => '');
  const buildConnectedPackagesMock = vi.fn(() => []);

  // Cost ledger.
  const appendCostEntryMock = vi.fn((entry: unknown) => {
    recordCost('appendCostEntry', [entry]);
    return { costEntryId: 'test-cost-entry-id-replay' };
  });

  // Sentry / error reporter.
  const captureExceptionMock = vi.fn((err: unknown, ctx?: unknown) => {
    recordSentry('captureException', [err, ctx]);
  });
  const captureMessageMock = vi.fn((msg: unknown, ctx?: unknown) => {
    recordSentry('captureMessage', [msg, ctx]);
  });

  // Env mutation.
  const setupNodeEnvironmentMock = vi.fn(() => {
    recordEnv('setPath', ['<PATH_MUTATED>']);
  });

  // Tracking / analytics.
  const chatSessionCreatedMock = vi.fn((data: unknown) => {
    recordTracking('chatSessionCreated', [data]);
  });

  // Cooldown service.
  const apiRateLimitRecordSuccessMock = vi.fn(() => {
    recordCooldown('recordSuccess', []);
  });
  const apiRateLimitUpdateLastApiCallTimeMock = vi.fn(() => {
    recordCooldown('updateLastApiCallTime', []);
  });

  // Council / ad-hoc / Claude-subagent.
  const buildCouncilConfigMock = vi.fn() as ReturnType<typeof vi.fn>;
  const resolveCouncilLeadModelMock = vi.fn(() => 'claude-sonnet-4-5');
  // Untyped so per-row scenarios can flip these mocks from their default
  // empty / null shape to the ad-hoc config object without TS narrowing.
  const detectModelReferencesMock = vi.fn(() => []) as ReturnType<typeof vi.fn>;
  const buildAdHocAgentConfigMock = vi.fn(() => null) as ReturnType<typeof vi.fn>;
  const detectClaudeModelReferencesMock = vi.fn(() => []);
  const buildClaudeSubagentConfigMock = vi.fn(() => null);

  // Profile / settings utilities.
  const getThinkingProfileMock = vi.fn(() => null);
  const getWorkingProfileMock = vi.fn(() => null);

  // Misc.
  // Stage 1C Phase 3: queryMock wraps the actual iterator-producing
  // implementation so each invocation is recorded into the harness's
  // `query` surface BEFORE delegating to the per-row scenario impl.
  // Per-row code replaces `_activeQueryImpl.current` (NOT
  // `queryMock.mockImplementation(...)`) so the recorder always fires.
  // Default impl is set in `resetMocksToDefaults()` because
  // `makeSuccessIterator()` lives in module scope (outside the hoisted
  // block).
  const _activeQueryImpl: { current: ((opts: unknown, ctx?: unknown) => unknown) | null } = {
    current: null,
  };
  // Strip non-deterministic / non-canonical fields from the query options
  // payload (function references, AbortSignals, generated session/turn ids,
  // etc.). Preserves the structural fields the byte-equivalence corpus
  // cares about: model, systemPrompt, agents, mcpServers, env (with
  // sensitive secrets redacted), permissionMode, hooks (as method names).
  const normalizeQueryOpts = (opts: unknown): unknown => {
    if (!opts || typeof opts !== 'object') return opts;
    const o = opts as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      // Drop fields that change every run.
      if (k === 'abortController' || k === 'signal') continue;
      if (k === 'prompt') {
        out[k] = typeof v === 'function' ? '<PromptGenerator>' : v;
        continue;
      }
      if (k === 'cwd' && typeof v === 'string') {
        // Project-root path is machine-specific.
        out[k] = '<CWD>';
        continue;
      }
      if (k === 'env' && v && typeof v === 'object') {
        // Production code does `env: { ...process.env, ...overrides }`,
        // so the whole shell env leaks into the trace. We only retain
        // executor-managed keys (the ones the code path explicitly sets
        // / overrides) and mark everything else as `<INHERITED_FROM_PROCESS_ENV>`.
        // This makes traces deterministic across machines.
        const env = v as Record<string, unknown>;
        const ALLOW_LIST = new Set<string>([
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_AUTH_TOKEN',
          'ANTHROPIC_BASE_URL',
          'ANTHROPIC_CUSTOM_HEADERS',
          'ANTHROPIC_DEFAULT_HAIKU_MODEL',
          'ANTHROPIC_DEFAULT_OPUS_MODEL',
          'ANTHROPIC_DEFAULT_SONNET_MODEL',
          'ANTHROPIC_MODEL',
          'ANTHROPIC_SMALL_FAST_MODEL',
          'API_TIMEOUT_MS',
          'CLAUDE_CODE_EFFORT_LEVEL',
          'DISABLE_AUTOUPDATER',
          'DISABLE_BUG_COMMAND',
          'DISABLE_TELEMETRY',
          'OPENAI_API_KEY',
          'OPENAI_BASE_URL',
          'OPENROUTER_API_KEY',
          'REBEL_ENABLE_STAGED_WRITES',
        ]);
        const redacted: Record<string, unknown> = {};
        for (const [ek, ev] of Object.entries(env)) {
          if (!ALLOW_LIST.has(ek)) {
            // Drop inherited process.env entries — they're machine-specific.
            continue;
          }
          if (typeof ev === 'string' && (
            ek === 'ANTHROPIC_API_KEY' ||
            ek === 'ANTHROPIC_AUTH_TOKEN' ||
            ek === 'OPENAI_API_KEY' ||
            ek === 'OPENROUTER_API_KEY' ||
            ek.endsWith('_API_KEY') ||
            ek.endsWith('_TOKEN')
          )) {
            redacted[ek] = ev.length > 0 ? '<REDACTED>' : '';
          } else {
            redacted[ek] = ev;
          }
        }
        out[k] = redacted;
        continue;
      }
      if (k === 'hooks' && v && typeof v === 'object') {
        // Replace hook function refs with method-name skeletons.
        const hooks = v as Record<string, unknown>;
        const hookOut: Record<string, number> = {};
        for (const [hk, hv] of Object.entries(hooks)) {
          if (Array.isArray(hv)) hookOut[hk] = hv.length;
        }
        out[k] = hookOut;
        continue;
      }
      if (k === 'agents' && v && typeof v === 'object') {
        out[k] = Object.keys(v as Record<string, unknown>).sort();
        continue;
      }
      if (k === 'mcpServers' && v && typeof v === 'object') {
        out[k] = Object.keys(v as Record<string, unknown>).sort();
        continue;
      }
      if (typeof v === 'function') {
        out[k] = '<Function>';
        continue;
      }
      out[k] = v;
    }
    return out;
  };
  const normalizeRouterContext = (ctx: unknown): unknown => {
    if (!ctx || typeof ctx !== 'object') return ctx;
    const c = ctx as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === 'function') {
        out[k] = '<Function>';
        continue;
      }
      // Drop client instances (SDK clients hold non-deterministic state).
      if (k === 'executionClient' || k === 'planningClient') {
        out[k] = v == null ? null : '<Client>';
        continue;
      }
      // Machine-specific paths.
      if (k === 'homePath' && typeof v === 'string') {
        out[k] = '<HOME>';
        continue;
      }
      // Machine-specific bundled-system path. Empty string is intentionally
      // NOT redacted so a regression in getSystemSettingsPath() (returning
      // '' or undefined) surfaces as a fixture diff rather than silently
      // matching the sentinel. See plan
      // 260428_turnpipeline_rebelsystemroot_fixture_redaction.md for
      // rationale; lens-behavioral-safety review highlighted this gap.
      if (k === 'rebelSystemRoot' && typeof v === 'string' && v.length > 0) {
        out[k] = '<REBEL_SYSTEM_ROOT>';
        continue;
      }
      if (k === 'userDataPath' && typeof v === 'string') {
        out[k] = '<USER_DATA_PATH>';
        continue;
      }
      out[k] = v;
    }
    return out;
  };
  const queryMock = vi.fn((opts: unknown, ctx?: unknown) => {
    recordQuery('queryWithRuntime', [normalizeQueryOpts(opts), normalizeRouterContext(ctx)]);
    if (_activeQueryImpl.current) {
      return _activeQueryImpl.current(opts, ctx);
    }
    // No impl installed — return an empty iterator so the executor's
    // for-await loop terminates cleanly. This branch should never execute
    // in practice because resetMocksToDefaults() always sets an impl.
    async function* empty(): AsyncGenerator<never, void, unknown> {}
    const iter = empty() as AsyncGenerator<never, void, unknown> & { close: () => void };
    iter.close = () => {};
    return iter;
  });
  const resolveModelConfigMock = vi.fn();
  const stripExtendedContextFromConfigMock = vi.fn();
  const isExtendedContextUnavailableErrorMock = vi.fn();
  const getErrorKindMock = vi.fn();
  const getSettingsMock = vi.fn();
  const hasValidAuthMock = vi.fn();
  const delayWithAbortMock = vi.fn(async () => false);

  // Phase 2 — F5 deferred mocks.
  // _preTurnWorker is a dynamic-import surface; we mock the module the
  // executor's `await import('./preTurnWorkerService')` resolves to. The
  // dynamic-import resolution itself is recorded via the harness's
  // `recordDynamicImport` surface, then each per-method call is recorded
  // through the existing log/event surfaces (the worker's side effects
  // are already covered by other surfaces — the `dynamicImport` entry
  // exists to mark the boundary cross).
  const preTurnWorkerIsAvailableMock = vi.fn(() => false);
  // Untyped so the `workspacePath` can be either `null` (default) or a
  // sentinel string per scenario without TS narrowing the union to one
  // branch.
  const preTurnWorkerGetStatusMock = vi.fn(() => ({
    isReady: false,
    permanentlyDisabled: false,
    consecutiveCrashes: 0,
    workspacePath: null,
  })) as ReturnType<typeof vi.fn>;
  const preTurnWorkerWaitForReadyMock = vi.fn(async () => {});
  const preTurnWorkerAssembleMock = vi.fn(async () => ({})) as ReturnType<typeof vi.fn>;
  const preTurnWorkerDisposeMock = vi.fn(async () => {});

  // turnCheckpointManager mock — singleton getter that drives the
  // checkpoint surface. By default we return null (matches the
  // `getTurnCheckpointManager()?.startCheckpointing(...)` optional-chain
  // no-op shape so most rows don't see checkpoint side effects).
  const startCheckpointingMock = vi.fn();
  const stopCheckpointingMock = vi.fn();
  const getTurnCheckpointManagerMock = vi.fn() as ReturnType<typeof vi.fn>;

  // Phase 3 — concurrent-turn / cooldown / activeTurnCount overrides.
  // These mocks are extracted from the inline `vi.fn(() => …)` literals
  // inside the agentTurnRegistry / apiRateLimitCooldown vi.mock factories
  // so per-row scenarios can override them without redefining the whole
  // mock block.
  const getActiveTurnCountMock = vi.fn(() => 1);
  const apiRateLimitRemainingMsMock = vi.fn(() => 0);

  return {
    harnessRef,
    scenarioRef,
    queryMock,
    dispatchAgentEventMock,
    dispatchAgentErrorEventMock,
    resolveModelConfigMock,
    stripExtendedContextFromConfigMock,
    isExtendedContextUnavailableErrorMock,
    getErrorKindMock,
    getSettingsMock,
    hasValidAuthMock,
    cleanupTurnMock,
    setActiveTurnControllerMock,
    setRendererSessionMock,
    recordSessionTurnMock,
    setTurnPromptMock,
    setTurnLoggerMock,
    setTurnPrivateModeMock,
    setTurnCategoryMock,
    setTurnExtendedContextMock,
    setTurnThinkingEffortMock,
    setTurnAuthMethodMock,
    setTurnSpawnDelayedMock,
    setTurnModelMock,
    cleanupForRetryMock,
    addTurnFallbackMock,
    hasSessionHadTurnsMock,
    getRendererSessionMock,
    clearExtendedContextFailedMock,
    addRoutesMock,
    removeRoutesMock,
    getAndResetTurnStatsMock,
    getUrlMock,
    getAuthTokenMock,
    resolveMcpServersMock,
    resolveSystemPromptMock,
    buildConnectedPackagesMock,
    appendCostEntryMock,
    captureExceptionMock,
    captureMessageMock,
    setupNodeEnvironmentMock,
    chatSessionCreatedMock,
    apiRateLimitRecordSuccessMock,
    apiRateLimitUpdateLastApiCallTimeMock,
    buildCouncilConfigMock,
    resolveCouncilLeadModelMock,
    detectModelReferencesMock,
    buildAdHocAgentConfigMock,
    detectClaudeModelReferencesMock,
    buildClaudeSubagentConfigMock,
    getThinkingProfileMock,
    getWorkingProfileMock,
    delayWithAbortMock,
    mockTurnLogger,
    rootLoggerMock,
    preTurnWorkerIsAvailableMock,
    preTurnWorkerGetStatusMock,
    preTurnWorkerWaitForReadyMock,
    preTurnWorkerAssembleMock,
    preTurnWorkerDisposeMock,
    startCheckpointingMock,
    stopCheckpointingMock,
    getTurnCheckpointManagerMock,
    _activeQueryImpl,
    getActiveTurnCountMock,
    apiRateLimitRemainingMsMock,
  };
});

// ---------------------------------------------------------------------------
// Module mocks — lifted verbatim from agentTurnExecutor.abortHandling.test.ts
// (See "Stage 1B working notes" — driving the monolith requires ~50 module
// mocks; consolidating them in this single replay-parity test is exactly
// the parent brief's recommendation.)
// ---------------------------------------------------------------------------
vi.mock('@core/rebelCore/queryRouter', () => ({
  queryWithRuntime: queryMock,
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('@core/logger', () => ({
  logger: rootLoggerMock,
  createTurnSessionLogger: vi.fn(() => mockTurnLogger),
  createScopedLogger: vi.fn(() => mockTurnLogger),
  runWithTurnContext: vi.fn(async (_ctx: unknown, fn: () => Promise<void>) => fn()),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: getSettingsMock,
  updateSettings: vi.fn(),
  updateSettingsAtomic: vi.fn(),
  onSettingsChange: vi.fn(() => () => undefined),
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    setActiveTurnController: setActiveTurnControllerMock,
    setRendererSession: setRendererSessionMock,
    setTurnPrivateMode: setTurnPrivateModeMock,
    setTurnCategory: setTurnCategoryMock,
    setTurnLogger: setTurnLoggerMock,
    getTurnLogger: vi.fn(() => mockTurnLogger),
    deleteTurnLogger: vi.fn(),
    deleteContextAccumulator: vi.fn(),
    cleanupTurn: cleanupTurnMock,
    setTurnPrompt: setTurnPromptMock,
    getTurnPrompt: vi.fn(() => undefined),
    setTurnExtendedContext: setTurnExtendedContextMock,
    setTurnThinkingEffort: setTurnThinkingEffortMock,
    setTurnAuthMethod: setTurnAuthMethodMock,
    getActiveTurnCount: getActiveTurnCountMock,
    setTurnSpawnDelayed: setTurnSpawnDelayedMock,
    getTurnSpawnDelayed: vi.fn(() => false),
    getTurnModel: vi.fn(() => null),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
    setTurnModel: setTurnModelMock,
    addTurnFallback: addTurnFallbackMock,
    cleanupForRetry: cleanupForRetryMock,
    hasContextOverflowDispatched: vi.fn(() => false),
    markContextOverflowDispatched: vi.fn(),
    markExtendedContextFailed: vi.fn(),
    clearExtendedContextFailed: clearExtendedContextFailedMock,
    hasExtendedContextFailed: vi.fn(() => false),
    getRendererSession: getRendererSessionMock,
    hasActionableErrorDispatched: vi.fn(() => false),
    getRetryCount: vi.fn(() => 0),
    incrementRetryCount: vi.fn(() => 1),
    deleteRetryCount: vi.fn(),
    getRetryStartTime: vi.fn((): number | undefined => undefined),
    setRetryStartTime: vi.fn(),
    deleteRetryStartTime: vi.fn(),
    getContextAccumulator: vi.fn(() => ''),
    getTurnExtendedContext: vi.fn(() => false),
    getTurnContextWindow: vi.fn(() => null),
    setTurnContextWindow: vi.fn(),
    getActiveTurnController: vi.fn(() => null),
    setTurnCloseCallback: vi.fn(),
    getTurnCloseCallback: vi.fn(() => undefined),
    deleteTurnCloseCallback: vi.fn(),
    hasSuccessResultDispatched: vi.fn(() => false),
    hasCostRecorded: vi.fn(() => false),
    hasUserQuestionPending: vi.fn(() => false),
    markCostRecorded: vi.fn(),
    recordSessionTurn: recordSessionTurnMock,
    hasSessionHadTurns: hasSessionHadTurnsMock,
    getUpstreamActivity: vi.fn(() => null),
    getTurnAuthMethod: vi.fn(() => 'api-key'),
    hasCodexProfileDriftWarningEmitted: vi.fn(() => false),
    markCodexProfileDriftWarningEmitted: vi.fn(),
    hasOutputCapRetryAttempted: vi.fn(() => false),
    markOutputCapRetryAttempted: vi.fn(),
    clearOutputCapRetryAttempted: vi.fn(),
    setTurnPlanningModel: vi.fn(),
    setTurnFastModel: vi.fn(),
    getTurnPlanningModel: vi.fn(() => undefined),
    getTurnFastModel: vi.fn(() => undefined),
    recordWatchdogSelfResolution: vi.fn(),
  },
  cleanupTurnAggregator: vi.fn(),
  cleanupPendingApprovals: vi.fn(),
}));

vi.mock('../localModelProxyServer', () => ({
  proxyManager: {
    getAndResetTurnStats: getAndResetTurnStatsMock,
    removeRoutes: removeRoutesMock,
    addRoutes: addRoutesMock,
    getUrl: getUrlMock,
    getAuthToken: getAuthTokenMock,
  },
}));

vi.mock('../councilService', () => ({
  buildCouncilConfig: buildCouncilConfigMock,
  resolveCouncilLeadModel: resolveCouncilLeadModelMock,
  buildAvailableModelsPrompt: vi.fn(() => ''),
}));

vi.mock('../adHocAgentService', () => ({
  detectModelReferences: detectModelReferencesMock,
  buildAdHocAgentConfig: buildAdHocAgentConfigMock,
}));

vi.mock('../claudeMentionAgentService', () => ({
  CLAUDE_MENTION_TARGETS: [],
  detectClaudeModelReferences: detectClaudeModelReferencesMock,
  buildClaudeSubagentConfig: buildClaudeSubagentConfigMock,
}));

vi.mock('../mcpService', () => ({
  resolveMcpServers: resolveMcpServersMock,
  resolveSystemPrompt: resolveSystemPromptMock,
  buildConnectedPackages: buildConnectedPackagesMock,
  buildServerAccountMap: vi.fn(() => new Map()),
  buildFrequentToolGroups: vi.fn(() => []),
  resolveMcpConfigPath: vi.fn(() => null),
  reportMcpError: vi.fn((err: unknown, ctx?: unknown) => {
    harnessRef.current?.recorder.recordSentry('reportMcpError', [err, ctx]);
  }),
}));

vi.mock('../turnPipeline/turnAdmission', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../turnPipeline/turnAdmission')>();
  return {
    ...actual,
    admit: (...args: Parameters<typeof actual.admit>) => {
      if (scenarioRef.current.admissionThrows) {
        throw new Error('admission threw before runtime');
      }
      return actual.admit(...args);
    },
  };
});

vi.mock('@core/rebelCore/providerRouting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/rebelCore/providerRouting')>();
  return {
    ...actual,
    resolveProviderRoutePlan: (...args: Parameters<typeof actual.resolveProviderRoutePlan>) => {
      if (scenarioRef.current.resolveProviderRoutePlanThrows) {
        throw new Error('routing proxy threw before runtime-ready');
      }
      if (scenarioRef.current.forcedTerminalInvalidReason === 'missing-openrouter-credentials') {
        return Promise.resolve({
          decision: {
            kind: 'terminal',
            provider: 'openrouter',
            transport: 'no-credentials',
            dispatchPath: 'none',
            modelDialect: 'openrouter-prefixed',
            role: 'execution',
            routeScope: 'normal-turn',
            routedModel: null,
            canonicalModelId: 'openai/gpt-5.5',
            wireModelId: 'openai/gpt-5.5',
            profileId: null,
            resolvedFrom: 'settings',
            codexConnectivity: 'unknown',
            fallbackHint: null,
            credentialSource: 'missing-openrouter',
            invalidReason: 'missing-openrouter-credentials',
          },
          auth: {
            kind: 'none',
            resolvedAuthLabel: 'none',
            credentialSource: 'missing-openrouter',
            credentialStatus: 'missing',
            env: [],
          },
          headers: [],
          proxyBaseURL: null,
          resolvedAuthLabel: 'none',
          proxyRequired: false,
          invalidReason: 'missing-openrouter-credentials',
        } as unknown as Awaited<ReturnType<typeof actual.resolveProviderRoutePlan>>);
      }
      if (scenarioRef.current.forcedTerminalInvalidReason === 'missing-profile-credentials') {
        return Promise.resolve({
          decision: {
            kind: 'terminal',
            provider: 'profile',
            transport: 'no-credentials',
            dispatchPath: 'none',
            modelDialect: 'profile-ref',
            role: 'execution',
            routeScope: 'normal-turn',
            routedModel: null,
            canonicalModelId: 'openai/gpt-5.5',
            wireModelId: 'openai/gpt-5.5',
            profileId: 'profile-missing-key',
            resolvedFrom: 'working-profile',
            codexConnectivity: 'unknown',
            fallbackHint: null,
            credentialSource: 'missing-profile',
            invalidReason: 'missing-profile-credentials',
          },
          auth: {
            kind: 'none',
            resolvedAuthLabel: 'none',
            credentialSource: 'missing-profile',
            credentialStatus: 'missing',
            env: [],
          },
          headers: [],
          proxyBaseURL: null,
          resolvedAuthLabel: 'none',
          proxyRequired: false,
          invalidReason: 'missing-profile-credentials',
        } as unknown as Awaited<ReturnType<typeof actual.resolveProviderRoutePlan>>);
      }
      return actual.resolveProviderRoutePlan(...args);
    },
  };
});

vi.mock('../toolSafetyService', () => ({
  createToolSafetyHook: vi.fn(() => undefined),
  createCanUseTool: vi.fn(() => undefined),
  cleanupPendingApprovals: vi.fn(),
  cleanupSessionPendingApprovals: vi.fn(),
}));

vi.mock('../safety/memoryWriteHook', () => ({
  createMemoryWriteHook: vi.fn(() => undefined),
  createCheckpointIntegrityHook: vi.fn(() => undefined),
  clearCheckpointLockedState: vi.fn(),
}));

vi.mock('../safety/stagedReadHook', () => ({
  createStagedReadHook: vi.fn(() => undefined),
}));

vi.mock('../fileConversationTrackingHook', () => ({
  createFileConversationTrackingHook: vi.fn(() => undefined),
}));

vi.mock('../autoContinueHook', () => ({
  createAutoContinueHook: vi.fn(() => undefined),
}));

vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

vi.mock('../safety/pendingApprovalsStore', () => ({
  getPendingApprovals: vi.fn(() => []),
  getPendingMemoryApprovals: vi.fn(() => []),
  clearPendingApprovalsForSession: vi.fn(),
}));

vi.mock('../agentMessageHandler', () => ({
  handleAgentMessage: vi.fn(),
}));

vi.mock('../../utils/systemUtils', () => ({
  setupNodeEnvironment: setupNodeEnvironmentMock,
  resolveLibraryPath: vi.fn(() => null),
}));

vi.mock('../utils/authEnvUtils', () => ({
  getAuthEnvVars: vi.fn(() => ({})),
  hasValidAuth: hasValidAuthMock,
  isUsingOAuth: vi.fn(() => false),
  isUsingOpenRouter: vi.fn((settings: { activeProvider?: string }) => settings.activeProvider === 'openrouter'),
  getApiKeyAuthEnvVars: vi.fn(() => null),
  getProviderKeyEnvVars: vi.fn(() => null),
  getAuthMethodDescription: vi.fn(() => 'api-key'),
}));

// The main shim `src/main/utils/authEnvUtils.ts` is a re-export of
// `@core/utils/authEnvUtils`. Vitest's module mocking handles re-exports
// correctly in most cases, but the executor might short-circuit through
// the canonical core path; mock that too so the per-row `hasValidAuth`
// behavior overrides take effect regardless of import path.
vi.mock('@core/utils/authEnvUtils', () => ({
  getAuthEnvVars: vi.fn(() => ({})),
  hasValidAuth: hasValidAuthMock,
  isUsingOAuth: vi.fn(() => false),
  isUsingOpenRouter: vi.fn((settings: { activeProvider?: string }) => settings.activeProvider === 'openrouter'),
  getApiKeyAuthEnvVars: vi.fn(() => null),
  getProviderKeyEnvVars: vi.fn(() => null),
  getAuthMethodDescription: vi.fn(() => 'api-key'),
  getAuthForDirectUse: vi.fn(() => null),
  getRateLimitFallbackTarget: vi.fn(() => null),
}));

vi.mock('@shared/utils/modelNormalization', () =>
  createModelNormalizationMock({ resolveModelConfigMock }, {
    stripExtendedContextFromConfig: stripExtendedContextFromConfigMock,
    isExtendedContextUnavailableError: isExtendedContextUnavailableErrorMock,
  }));

vi.mock('@shared/utils/settingsUtils', () => ({
  getThinkingProfile: getThinkingProfileMock,
  getWorkingProfile: getWorkingProfileMock,
}));

vi.mock('../semanticContextService', () => ({
  enhancePromptWithSemanticContext: vi.fn(async (prompt: string) => ({
    enhancedPrompt: prompt,
    contextAdded: false,
    fileCount: 0,
  })),
  RELEVANCE_THRESHOLDS: {
    default: 0.5,
    explicitSearch: 0.3,
    actionIntent: 0.35,
  },
}));

vi.mock('../conversationContextService', () => ({
  enhancePromptWithConversationContext: vi.fn(async (prompt: string) => ({
    enhancedPrompt: prompt,
    contextAdded: false,
    conversationCount: 0,
  })),
  extractBookendExcerpt: vi.fn(() => ({ excerpt: '', messageRange: null })),
  formatAutoConversationContext: vi.fn(() => ''),
  parseConversationSearchKeyword: vi.fn((prompt: string) => ({ hasConversationSearch: false, sanitizedPrompt: prompt })),
  AUTO_CONVERSATION_THRESHOLD: 0.70,
  MAX_AUTO_CONVERSATION_CHARS: 10_000,
  MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION: 5_000,
  loadFilterAndFormatConversations: vi.fn(async () => null),
}));

vi.mock('../conversationHistoryService', () => ({
  loadConversationHistory: vi.fn(async () => ''),
  loadIntelligentConversationHistory: vi.fn(async () => ''),
  buildConversationHistoryContext: vi.fn(() => ''),
}));

vi.mock('@core/services/buildContinuationContext', () => createBuildContinuationContextMock());

vi.mock('../../utils/agentTurnFormatters', () => ({
  formatFrequentToolsContext: vi.fn(() => undefined),
  formatConnectedPackagesContext: vi.fn(() => undefined),
  formatSuggestedToolsContext: vi.fn(() => undefined),
  extractParamHints: vi.fn(() => ''),
  isEmptyParamSchema: vi.fn(() => false),
}));

vi.mock('../conversationIndexService', () => ({
  searchConversations: vi.fn(async () => []),
}));

vi.mock('../toolIndexService', () => ({
  searchTools: vi.fn(async () => []),
  hasToolIndex: vi.fn(() => false),
}));

vi.mock('../../tracking', () => ({
  getTurnAggregator: vi.fn(() => ({ pushMessage: vi.fn() })),
  cleanupTurnAggregator: vi.fn(),
  mainTracking: { chatSessionCreated: chatSessionCreatedMock },
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    captureException: captureExceptionMock,
    captureMessage: captureMessageMock,
  })),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
  })),
}));

vi.mock('../../constants', () => ({
  KNOWLEDGE_WORKER_AGENT_NAME: 'Rebel',
  KNOWLEDGE_WORKER_AGENT_DESCRIPTION: 'Test',
}));

vi.mock('../promptCacheWarmupService', () => ({
  updateLastApiCallTime: apiRateLimitUpdateLastApiCallTimeMock,
  getLastApiCallTime: vi.fn(() => undefined),
}));

vi.mock('../mcpServerAlias', () => ({
  aliasMcpServersForClaudeSdk: vi.fn((servers: unknown) => servers),
}));

vi.mock('@core/preTurnWorker', () => ({
  getPreTurnWorker: vi.fn(() => ({
    isWorkerAvailable: preTurnWorkerIsAvailableMock,
    getWorkerStatus: preTurnWorkerGetStatusMock,
    waitForWorkerReady: preTurnWorkerWaitForReadyMock,
    assemblePreTurnContext: preTurnWorkerAssembleMock,
    disposeWorker: preTurnWorkerDisposeMock,
  })),
}));

vi.mock('../powerSaveBlockerService', () => {
  const reasons = new Map<string, number>();
  const getRefCount = () => {
    let total = 0;
    for (const count of reasons.values()) total += count;
    return total;
  };
  return {
    acquireBlock: vi.fn((reason: string) => {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }),
    releaseBlock: vi.fn((reason: string) => {
      const current = reasons.get(reason) ?? 0;
      if (current <= 1) {
        reasons.delete(reason);
      } else {
        reasons.set(reason, current - 1);
      }
      if (getRefCount() === 0) {
        mockTurnLogger.info({ reason }, 'Power save block released (system sleep allowed)');
      }
    }),
    getBlockerStatus: vi.fn(() => ({
      active: getRefCount() > 0,
      refCount: getRefCount(),
      reasons: Object.fromEntries(reasons),
      startedAt: null,
      durationMs: null,
    })),
    dispose: vi.fn(() => reasons.clear()),
    _resetForTesting: vi.fn(() => reasons.clear()),
  };
});

// 2) `getTurnCheckpointManager` — returns either `null` (default,
//    no-op via the executor's optional-chain) or a manager-shaped object
//    whose `startCheckpointing` / `stopCheckpointing` methods record into
//    the harness's `checkpoint` surface. The factory dispatches at call
//    time so per-row scenarios can flip the manager between null and a
//    live recorder.
vi.mock('@core/services/turnCheckpointService', () => ({
  getTurnCheckpointManager: getTurnCheckpointManagerMock,
}));

vi.mock('@shared/utils/friendlyErrors', () => ({
  humanizeError: vi.fn((msg: string) => msg),
  isTransientError: vi.fn(() => false),
  isNetworkError: vi.fn(() => false),
  isRateLimitMessage: vi.fn(() => false),
  extractRetryAfterMs: vi.fn(() => undefined),
}));

vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/utils/agentErrorCatalog');
  return {
    ...actual,
    getErrorKind: getErrorKindMock,
    isRoutedError: vi.fn(() => false),
    createRoutedError: vi.fn((kind: string, msg: string) => {
      const err = new Error(`${kind}: ${msg}`);
      (err as unknown as Record<string, unknown>).__agentErrorKind = kind;
      (err as unknown as Record<string, unknown>).__rawMessage = msg;
      return err;
    }),
  };
});

vi.mock('@shared/utils/toolNameValidation', () => ({
  isToolNameLengthError: vi.fn(() => false),
}));

vi.mock('@core/utils/delayWithAbort', () => ({
  delayWithAbort: delayWithAbortMock,
}));

vi.mock('@core/services/apiRateLimitCooldown', () => ({
  apiRateLimitCooldown: {
    remainingMs: apiRateLimitRemainingMsMock,
    recordRateLimit: vi.fn(),
    recordSuccess: apiRateLimitRecordSuccessMock,
  },
  safetyEvalRateLimitCooldown: {
    remainingMs: vi.fn(() => 0),
    isAvailable: vi.fn(() => true),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: appendCostEntryMock,
}));

// Mocked because production-init of `@core/services/contributionStore` (one-time
// `_storeInitialized` migration + back-fill log emission) leaks into the
// agent-turn-pipeline trace via the only call site reachable from the executor:
// `buildStuckRegistrationReminder` -> `getContributionsBySession` -> `getStore()`.
// Whichever row runs first in a given vitest worker captures the migration logs
// at sequences 14-15, while subsequent rows in the same process do not. This
// makes per-row pass/fail outcome dependent on `-t` filter ordering instead of
// the executor's actual behavior. The replay corpus tests turn-pipeline behavior,
// not the contribution-store init surface, so we no-op the three production
// surfaces the executor consumes from this module. Resolves I4 in
// `docs/plans/260428_turnpipeline_rebelsystemroot_fixture_redaction.md`.
vi.mock('../mcpBuildAutoDetectHook', () => ({
  buildStuckRegistrationReminder: vi.fn(() => undefined),
  promoteTestingContributionIfRegistered: vi.fn(() => Promise.resolve()),
  createMcpBuildAutoDetectHook: vi.fn(() => async () => ({})),
}));

vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCost: vi.fn(() => 0),
  calculateCostOrWarn: vi.fn(() => 0),
}));

vi.mock('../../utils/agentTurnUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/agentTurnUtils')>();
  return {
    buildUserMessageContext: actual.buildUserMessageContext,
    buildResponseShapeContractForPrompt: actual.buildResponseShapeContractForPrompt,
    MAX_RENDERER_ATTACHMENTS: 20,
    MAX_ATTACHMENT_CHAR_LENGTH: 50_000,
    MAX_IMAGE_ATTACHMENTS: 4,
    MAX_IMAGE_SIZE_BYTES: 32 * 1024 * 1024,
    MAX_TEXT_FILE_ATTACHMENTS: 10,
    MAX_TEXT_FILE_CONTENT_BYTES: 200_000,
    appendAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    appendOfficeAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    appendExtractedPdfAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    appendTextFileAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    appendBinaryAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    attachSkillMetadataToTextAttachments: vi.fn((attachments: unknown[]) => attachments),
    collectSkillModelRecommendations: vi.fn(() => []),
    computeEffectiveEffort: vi.fn((userEffort: string | undefined, profileEffort: string | undefined) => profileEffort ?? userEffort),
    resolveSkillModelRecommendations: vi.fn(() => ({
      claudeAliases: [],
      profileMatches: [],
      unresolvedModels: [],
    })),
    separateAttachments: vi.fn(() => ({
      textAttachments: [],
      imageAttachments: [],
      documentAttachments: [],
      extractedPdfAttachments: [],
      officeAttachments: [],
      textFileAttachments: [],
      binaryAttachments: [],
    })),
    createUserMessageGenerator: vi.fn((prompt: string) => prompt),
    getErrorMessage: actual.getErrorMessage,
    getErrorName: actual.getErrorName,
    getRawErrorMessage: actual.getRawErrorMessage,
    getErrorProvider: actual.getErrorProvider,
    isApiOutputMessage: actual.isApiOutputMessage,
  };
});

// ---------------------------------------------------------------------------
// Import the SUT after all `vi.mock(...)` calls are hoisted.
// ---------------------------------------------------------------------------
import { executeAgentTurn } from '../agentTurnExecutor';

// Phase 2 — Per-row codex provider override. Imported AFTER vi.mock(...)
// hoisting so the `setCodexAuthProvider` reference resolves to the same
// in-memory module instance the executor's `getCodexAuthProvider()` reads
// from. The global `vitest.setup.ts` defaults the provider to
// `NULL_CODEX_AUTH_PROVIDER`; per-row scenarios that need a connected
// codex (row 25) flip the provider in `applyScenarioMocks(...)` and reset
// in the `runMonolithUnderHarness(...)` finally block.
import {
  setCodexAuthProvider,
  NULL_CODEX_AUTH_PROVIDER,
  type CodexAuthProvider,
} from '@core/codexAuth';

// ---------------------------------------------------------------------------
// Scenario configuration types and helpers
// ---------------------------------------------------------------------------

/**
 * Per-scenario mock-behavior overrides applied INSIDE
 * `runMonolithUnderHarness(...)`. Each override flips a single mock from
 * its default (happy-path) shape to the row-specific shape.
 *
 * Add new override fields here as new corpus rows demand them; the
 * scenario file's `input.mockOverrides` JSON shape mirrors this contract
 * one-for-one.
 */
export interface ScenarioMockOverrides {
  hasValidAuth?: boolean;
  coreDirectory?: string | null;
  activeProvider?: 'anthropic' | 'codex' | 'openrouter' | 'unset';
  openRouterOauthToken?: string | null;
  forcedTerminalInvalidReason?: 'missing-openrouter-credentials' | 'missing-profile-credentials';
  /** Abort the controller as soon as it's registered (admission TERM-4 path). */
  abortOnControllerRegistered?: boolean;
  queryOutcome?: 'success' | 'abort-mid' | 'upstream-abort' | 'rate-limit' | 'session-not-found-then-success';
  admissionThrows?: boolean;
  resolveMcpServersThrows?: boolean;
  resolveProviderRoutePlanThrows?: boolean;
  /** Number of times to throw a server error before succeeding (recursive retry depth). */
  serverErrorRetries?: number;
  /** Have addRoutes throw — exercises proxy-startup-failure terminal. */
  proxyStartupFailure?: boolean;
  /** Activate council mode (buildCouncilConfig returns a non-null config). */
  councilMode?: boolean;
  /** Renderer-explicit reset flag (vs. main-process derived). */
  resetConversationOverride?: boolean;
  /**
   * Whether the session has already had turns (drives the main-process
   * resetConversation decision branch in continuation rows).
   */
  sessionHadTurns?: boolean;
  /**
   * Phase 2 — Per-row codex provider override. When `true`, the executor's
   * `getCodexAuthProvider()` returns a connected provider for the duration of
   * the row; reset to NULL_CODEX_AUTH_PROVIDER in the cleanup finally.
   * Used for codex-connected route-plan rows.
   */
  codexAuthConnected?: boolean;
  /**
   * Phase 2 — Drive the `_preTurnWorker` lazy-import + assembly surface.
   * - 'unavailable' (default) — worker not available; executor fast-paths to fallback.
   * - 'happy' — worker resolves with `assemblePreTurnContext` returning a result.
   * - 'fallback-empty' — worker is loaded but `permanentlyDisabled`; main-process fallback runs.
   * - 'cancel' — worker resolves but the controller aborts mid-assembly.
   */
  preTurnWorker?: 'unavailable' | 'happy' | 'fallback-empty' | 'cancel';
  /**
   * Phase 2 — Drive the `getTurnCheckpointManager()` surface. When `true`,
   * returns a manager whose `startCheckpointing` / `stopCheckpointing` are
   * recorded into the harness's `checkpoint` surface.
   */
  enableCheckpointing?: boolean;
  /**
   * Phase 2 — Abort the controller from inside `resolveMcpServers(...)`.
   * Routes the executor through the post-MCP abort checkpoint terminal.
   */
  abortAfterMcpResolve?: boolean;
  /**
   * Phase 2 — Drive the ad-hoc multi-model mention arm. When `true`,
   * `buildAdHocAgentConfig` returns a non-null config and the executor
   * enters the ad-hoc dispatch branch.
   */
  adHocConfig?: boolean;
  /**
   * Phase 2 — Drive the MCP direct-mode arm. When `true`, `resolveMcpServers`
   * returns a non-null servers map and `mode: 'direct'`.
   */
  mcpDirectMode?: boolean;
  /**
   * Phase 3 — Override `agentTurnRegistry.getActiveTurnCount()` to drive
   * the REBEL-J1 concurrent-spawn-delay branch. Default is 1; setting to
   * ≥2 makes the executor enter the spawn-delay path.
   */
  activeTurnCount?: number;
  /**
   * Phase 3 — Override `apiRateLimitCooldown.remainingMs()` to drive the
   * cooldown-wait branch. Default is 0; setting to >0 makes the executor
   * delay before the primary query.
   */
  cooldownRemainingMs?: number;
  /**
   * Phase 3 — When `true`, `delayWithAbort(...)` resolves to `true`
   * (signalling that the controller aborted during the wait). Used by
   * spawn-delay-abort and cooldown-abort terminal rows.
   */
  delayAborted?: boolean;
}

/**
 * Resolve the full scenario input from a corpus row's saved fixture.
 * Scenario inputs are intentionally minimal; the runner fills in safe
 * defaults via per-mock implementations.
 */
export interface ScenarioInput {
  turnId: string;
  prompt: string;
  turnOptions?: Parameters<typeof executeAgentTurn>[3];
  settingsOverrides?: Record<string, unknown>;
  mockOverrides?: ScenarioMockOverrides;
}

/**
 * Default settings used by `getSettingsMock`. Each scenario can override
 * specific fields via `settingsOverrides` in its input.
 */
function defaultSettings(): Record<string, unknown> {
  return {
    coreDirectory: process.cwd(),
    activeProvider: 'anthropic',
    claude: {
      model: 'claude-sonnet-4-5',
      thinkingModel: null,
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'test-key',
      longContextFallbackModel: null,
    },
    models: {
      model: 'claude-sonnet-4-5',
      thinkingModel: null,
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'test-key',
      longContextFallbackModel: null,
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: 'Alt+Space',
      activationHotkeyVoiceMode: 'Alt+Space',
    },
    localModel: { profiles: [], activeProfileId: null },
    preventSleepDuringTurns: false,
  };
}

function makeSuccessIterator() {
  async function* gen(): AsyncGenerator<{ type: string }, void, unknown> {
    yield { type: 'result' };
  }
  const iter = gen() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

function makeErrorIterator(error: Error) {
  async function* gen(): AsyncGenerator<never, void, unknown> {
    throw error;
  }
  const iter = gen() as AsyncGenerator<never, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

function makeAbortMidStreamIterator(controller: AbortController) {
  async function* gen(): AsyncGenerator<{ type: string }, void, unknown> {
    yield { type: 'assistant' };
    controller.abort();
    yield { type: 'assistant' };
  }
  const iter = gen() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

/**
 * Reset every mock to its happy-path default. Called at the start of each
 * `runMonolithUnderHarness(...)` invocation so previous-row state cannot
 * leak between runs.
 */
function resetMocksToDefaults(): void {
  vi.clearAllMocks();

  resolveModelConfigMock.mockImplementation((model: string) => ({
    model,
    envOverrides: undefined,
  }));
  isExtendedContextUnavailableErrorMock.mockReturnValue(false);
  stripExtendedContextFromConfigMock.mockImplementation((cfg: unknown) => cfg);
  getErrorKindMock.mockReturnValue('unknown');
  hasValidAuthMock.mockReturnValue(true);
  hasSessionHadTurnsMock.mockReturnValue(false);
  getRendererSessionMock.mockReturnValue(null);
  getSettingsMock.mockReturnValue(defaultSettings());
  resolveMcpServersMock.mockResolvedValue({
    servers: undefined,
    mode: 'unavailable',
    upstreamCount: 0,
    configPath: undefined,
  });
  resolveSystemPromptMock.mockResolvedValue('');
  buildConnectedPackagesMock.mockResolvedValue([]);
  buildCouncilConfigMock.mockReturnValue(null as unknown as never);
  resolveCouncilLeadModelMock.mockReturnValue('claude-sonnet-4-5');
  detectModelReferencesMock.mockReturnValue([]);
  buildAdHocAgentConfigMock.mockReturnValue(null);
  detectClaudeModelReferencesMock.mockReturnValue([]);
  buildClaudeSubagentConfigMock.mockReturnValue(null);
  getThinkingProfileMock.mockReturnValue(null);
  getWorkingProfileMock.mockReturnValue(null);
  // Reinstall the recorder-preserving implementations. Earlier we naively
  // called `addRoutesMock.mockResolvedValue(undefined)` here which OVERWROTE
  // the recorder hooks attached to the original `vi.fn(async (turnId, routes) => recordProxy(...))`
  // factory at construction time, so proxy side effects vanished from the
  // recorded trace (Stage 1C Phase 1 reviewer must-fix). Always re-attach the
  // recorder; per-row scenario overrides that need to throw use
  // `mockImplementation` so the recorder runs first.
  addRoutesMock.mockImplementation(async (turnId: string, routes: unknown) => {
    harnessRef.current?.recorder.recordProxy('addRoutes', [turnId, routes]);
  });
  removeRoutesMock.mockImplementation((turnId: string) => {
    harnessRef.current?.recorder.recordProxy('removeRoutes', [turnId]);
  });
  getAndResetTurnStatsMock.mockImplementation(() => {
    harnessRef.current?.recorder.recordProxy('getAndResetTurnStats', []);
    return new Map();
  });
  getUrlMock.mockReturnValue('http://proxy.local');
  getAuthTokenMock.mockReturnValue('proxy-auth-token');
  delayWithAbortMock.mockResolvedValue(false);
  // Stage 1C Phase 3: queryMock's factory wrapper records the call into
  // the harness's `query` surface and then delegates to the per-row
  // `_activeQueryImpl`. We reset the impl here (NOT the wrapper). Per-row
  // scenarios assign `_activeQueryImpl.current` to alter behaviour.
  _activeQueryImpl.current = () => makeSuccessIterator();

  // Phase 2 — F5 deferred mocks.
  preTurnWorkerIsAvailableMock.mockReturnValue(false);
  preTurnWorkerGetStatusMock.mockReturnValue({
    isReady: false,
    permanentlyDisabled: false,
    consecutiveCrashes: 0,
    workspacePath: null,
  });
  preTurnWorkerWaitForReadyMock.mockResolvedValue(undefined);
  preTurnWorkerAssembleMock.mockResolvedValue({});
  preTurnWorkerDisposeMock.mockResolvedValue(undefined);

  // Default: checkpoint manager singleton is null — matches the
  // production-default surface state when bootstrap has not run.
  getTurnCheckpointManagerMock.mockReturnValue(null as unknown as never);

  // Default: codex provider is the NULL provider (matches vitest.setup.ts
  // global default).
  setCodexAuthProvider(NULL_CODEX_AUTH_PROVIDER);

  // Phase 3 — concurrent-turn / cooldown defaults.
  getActiveTurnCountMock.mockReturnValue(1);
  apiRateLimitRemainingMsMock.mockReturnValue(0);
}

/**
 * Apply per-scenario mock overrides. Called immediately after
 * `resetMocksToDefaults()` so the previous-row settings cannot leak.
 *
 * Settings overrides are deep-merged into the base default settings.
 */
function applyScenarioMocks(
  scenario: ScenarioInput,
  abortController: AbortController,
): void {
  const ov = scenario.mockOverrides ?? {};

  // Settings: shallow-merge with custom override map.
  const baseSettings = defaultSettings();
  const merged: Record<string, unknown> = { ...baseSettings, ...(scenario.settingsOverrides ?? {}) };
  if (ov.coreDirectory === null) {
    merged.coreDirectory = '';
  } else if (ov.coreDirectory !== undefined) {
    merged.coreDirectory = ov.coreDirectory;
  }
  if (ov.activeProvider) {
    merged.activeProvider = ov.activeProvider === 'unset' ? undefined : ov.activeProvider;
  }
  if (ov.openRouterOauthToken !== undefined) {
    merged.openRouter = {
      enabled: true,
      oauthToken: ov.openRouterOauthToken,
    };
  }
  getSettingsMock.mockReturnValue(merged);

  if (ov.hasValidAuth === false) {
    hasValidAuthMock.mockReturnValue(false);
  }

  if (ov.resolveMcpServersThrows) {
    resolveMcpServersMock.mockRejectedValueOnce(new Error('model MCP assembly threw before runtime'));
  }

  if (ov.abortOnControllerRegistered) {
    setActiveTurnControllerMock.mockImplementationOnce((turnId: string, ctrl: unknown) => {
      harnessRef.current?.recorder.recordRegistry('setActiveTurnController', [turnId, ctrl]);
      (ctrl as AbortController).abort();
    });
  }

  if (ov.proxyStartupFailure) {
    // Use mockImplementation so the recorder fires BEFORE the throw —
    // otherwise the trace loses the addRoutes attempt that production
    // actually made (Stage 1C Phase 1 reviewer must-fix).
    addRoutesMock.mockImplementation(async (turnId: string, routes: unknown) => {
      harnessRef.current?.recorder.recordProxy('addRoutes', [turnId, routes]);
      throw new Error('proxy startup failed');
    });
  }

  if (ov.councilMode) {
    buildCouncilConfigMock.mockReturnValue({
      leadModel: 'claude-sonnet-4-5',
      systemPromptSuffix: '',
      agents: { alpha: {}, beta: {} },
      routeTable: {
        routes: new Map([
          ['openai/gpt-4o', { name: 'GPT-4o' }],
          ['google/gemini-2.5-pro', { name: 'Gemini 2.5 Pro' }],
        ]),
      },
    });
  }

  if (ov.sessionHadTurns) {
    hasSessionHadTurnsMock.mockReturnValue(true);
  }

  // Phase 2 — Codex provider override. The default is
  // `NULL_CODEX_AUTH_PROVIDER` (set by `resetMocksToDefaults`); when a row
  // requests a connected codex, install a stub provider that reports
  // connected. The cleanup in `runMonolithUnderHarness`'s finally block
  // resets to NULL.
  if (ov.codexAuthConnected) {
    const connectedProvider: CodexAuthProvider = {
      isConnected: () => true,
      getAccessToken: async () => 'fake-codex-access-token',
      getAccountId: () => 'fake-codex-account',
      forceRefreshToken: async () => 'fake-codex-access-token',
      getStatus: () => ({ connected: true, accountEmail: 'codex-user@example.com' }),
    };
    setCodexAuthProvider(connectedProvider);
  }

  // Phase 2 — _preTurnWorker mode override. The dynamicImport-recorder
  // captures only a stable sentinel ('<WORKSPACE>') instead of the real
  // `settings.coreDirectory` (which is `process.cwd()` and therefore
  // machine-dependent), so the recorded fixture stays portable across
  // local + CI environments.
  switch (ov.preTurnWorker) {
    case 'happy':
      preTurnWorkerIsAvailableMock.mockReturnValue(true);
      preTurnWorkerGetStatusMock.mockReturnValue({
        isReady: true,
        permanentlyDisabled: false,
        consecutiveCrashes: 0,
        workspacePath: '<WORKSPACE>',
      });
      preTurnWorkerAssembleMock.mockImplementation(async () => {
        harnessRef.current?.recorder.recordDynamicImport('preTurnWorkerService.assemblePreTurnContext', ['<WORKSPACE>']);
        return {
          semanticContext: undefined,
          suggestedTools: undefined,
          suggestedConversations: undefined,
          suggestedSkills: undefined,
        };
      });
      break;
    case 'fallback-empty':
      // Worker is loaded but permanently disabled; assembly returns {}.
      preTurnWorkerIsAvailableMock.mockReturnValue(false);
      preTurnWorkerGetStatusMock.mockReturnValue({
        isReady: false,
        permanentlyDisabled: true,
        consecutiveCrashes: 3,
        workspacePath: null,
      });
      preTurnWorkerAssembleMock.mockResolvedValue({});
      break;
    case 'cancel':
      // Cancel-protocol: worker spawn would be in flight; controller aborts.
      preTurnWorkerIsAvailableMock.mockReturnValue(true);
      preTurnWorkerGetStatusMock.mockReturnValue({
        isReady: true,
        permanentlyDisabled: false,
        consecutiveCrashes: 0,
        workspacePath: '<WORKSPACE>',
      });
      preTurnWorkerAssembleMock.mockImplementation(async () => {
        harnessRef.current?.recorder.recordDynamicImport('preTurnWorkerService.assemblePreTurnContext', ['<WORKSPACE>']);
        // Simulate cooperative abort.
        abortController.abort();
        return {};
      });
      break;
    case 'unavailable':
    default:
      // Default behavior — already set in resetMocksToDefaults.
      break;
  }

  // Phase 2 — Checkpoint manager.
  if (ov.enableCheckpointing) {
    const manager = {
      startCheckpointing: vi.fn((turnId: string, sessionId: string) => {
        harnessRef.current?.recorder.recordCheckpoint('startCheckpointing', [turnId, sessionId]);
      }),
      stopCheckpointing: vi.fn((turnId: string) => {
        harnessRef.current?.recorder.recordCheckpoint('stopCheckpointing', [turnId]);
      }),
    };
    getTurnCheckpointManagerMock.mockReturnValue(manager as unknown as never);
  }

  // Phase 2 — Abort after MCP resolve.
  if (ov.abortAfterMcpResolve) {
    resolveMcpServersMock.mockImplementationOnce(async () => {
      abortController.abort();
      return {
        servers: undefined,
        mode: 'unavailable' as const,
        upstreamCount: 0,
        configPath: undefined,
      };
    });
  }

  // Phase 2 — MCP direct-mode (non-null servers map).
  if (ov.mcpDirectMode) {
    resolveMcpServersMock.mockResolvedValue({
      servers: {
        // Minimal stable map shape — name → endpoint config. The executor
        // passes this through to the runtime config and logs the server
        // list.
        'mock-mcp': { command: 'node', args: ['mock'] },
      },
      mode: 'direct' as const,
      upstreamCount: 1,
      configPath: '/tmp/mock-mcp-config.json',
    });
  }

  // Phase 3 — concurrent-turn override (REBEL-J1 spawn-delay branch).
  if (ov.activeTurnCount !== undefined) {
    getActiveTurnCountMock.mockReturnValue(ov.activeTurnCount);
  }

  // Phase 3 — cooldown remainingMs override.
  if (ov.cooldownRemainingMs !== undefined) {
    apiRateLimitRemainingMsMock.mockReturnValue(ov.cooldownRemainingMs);
  }

  // Phase 3 — delayWithAbort override (returns true → aborted-during-wait).
  if (ov.delayAborted) {
    delayWithAbortMock.mockResolvedValue(true);
  }

  // Phase 2 — Ad-hoc multi-model mention.
  if (ov.adHocConfig) {
    detectModelReferencesMock.mockReturnValue([
      { modelKey: 'openai/gpt-4o', detectedAtIndex: 0 },
    ]);
    buildAdHocAgentConfigMock.mockReturnValue({
      systemPromptSuffix: '',
      agents: { gpt: {} },
      routeTable: {
        routes: new Map([
          ['openai/gpt-4o', { name: 'GPT-4o' }],
        ]),
      },
    });
  }

  switch (ov.queryOutcome) {
    case 'abort-mid':
      _activeQueryImpl.current = () => makeAbortMidStreamIterator(abortController);
      break;
    case 'upstream-abort': {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      _activeQueryImpl.current = () => makeErrorIterator(e);
      break;
    }
    case 'rate-limit':
      _activeQueryImpl.current = () => makeErrorIterator(new Error('rate limit reached'));
      break;
    case 'session-not-found-then-success': {
      let calls = 0;
      _activeQueryImpl.current = () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error('session not found');
          (err as unknown as Record<string, unknown>).__agentErrorKind = 'session_not_found';
          return makeErrorIterator(err);
        }
        return makeSuccessIterator();
      };
      break;
    }
    case 'success':
    default:
      _activeQueryImpl.current = () => makeSuccessIterator();
      break;
  }
}

/**
 * Central driver. Lifts the heavy `vi.mock(...)` block out of
 * `agentTurnExecutor.abortHandling.test.ts` ONCE and parametrizes
 * row-specific behavior via `scenario.mockOverrides`.
 *
 * Lifecycle:
 *   1. Set `harnessRef.current = harness` so all recording mocks fan
 *      their args into the active recorder.
 *   2. Reset every mock to defaults (`vi.clearAllMocks()` + happy-path
 *      stubs).
 *   3. Apply per-scenario overrides (settings, auth, abort fixtures,
 *      query outcome).
 *   4. Construct the AbortController the row's `mockOverrides` may need
 *      to abort, and pass it via `existingAbortController` when relevant.
 *   5. Invoke `executeAgentTurn(null, turnId, prompt, turnOptions)`.
 *   6. Clear the harness reference.
 *
 * The function never throws — `executeAgentTurn` swallows internal errors
 * via `dispatchErrorRecovery`. Callers assert against the recorded
 * canonical trace.
 */
export async function runMonolithUnderHarness(
  scenario: ScenarioInput,
  harness: ReplayHarnessHandle,
): Promise<void> {
  harnessRef.current = harness;
  scenarioRef.current = scenario.mockOverrides ?? {};
  try {
    resetMocksToDefaults();
    const abortController = new AbortController();
    applyScenarioMocks(scenario, abortController);

    const turnOpts = (scenario.turnOptions ?? {}) as Parameters<typeof executeAgentTurn>[3];
    const turnOptsWithAbort = {
      ...turnOpts,
      existingAbortController: abortController,
    } as Parameters<typeof executeAgentTurn>[3];

    await executeAgentTurn(null, scenario.turnId, scenario.prompt, turnOptsWithAbort);
  } finally {
    // Phase 2 — Always reset codex provider so a row's per-row override
    // does not leak into the next row's run.
    setCodexAuthProvider(NULL_CODEX_AUTH_PROVIDER);
    harnessRef.current = null;
    scenarioRef.current = {};
  }
}

// ---------------------------------------------------------------------------
// Fixture loading + record-mode write-back
// ---------------------------------------------------------------------------

interface CorpusFixture {
  id: number;
  description: string;
  stage: string;
  addedIn?: string;
  notes?: string[];
  input: ScenarioInput;
  expected: CanonicalizedTrace | Record<string, unknown>;
}

function loadFixture(fixtureFile: string): CorpusFixture {
  const fullPath = path.join(FIXTURES_DIR, fixtureFile);
  if (!existsSync(fullPath)) {
    throw new Error(`fixture file missing: ${fullPath}`);
  }
  return JSON.parse(readFileSync(fullPath, 'utf8')) as CorpusFixture;
}

function writeFixture(fixtureFile: string, fixture: CorpusFixture): void {
  const fullPath = path.join(FIXTURES_DIR, fixtureFile);
  writeFileSync(fullPath, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
}

/**
 * Stable substitutions: every scenario uses `<TURN_ID>` and
 * `<SESSION_ID>` as sentinels in its `input` block, so the canonicalizer
 * doesn't need per-row substitution maps for the simple cases.
 *
 * The harness records args verbatim; the canonicalizer normalizes
 * `timestamp`/`durationMs`/`stack` fields automatically.
 */
function canonicalizeForRow(harness: ReplayHarnessHandle, scenario: ScenarioInput): CanonicalizedTrace {
  return canonicalize(harness.records, {
    turnIdSubstitutions: scenario.turnId === '<TURN_ID>' ? {} : { [scenario.turnId]: '<TURN_ID>' },
    sessionIdSubstitutions: (() => {
      const sid = (scenario.turnOptions as { sessionId?: string } | undefined)?.sessionId;
      if (!sid || sid === '<SESSION_ID>') return {};
      return { [sid]: '<SESSION_ID>' };
    })(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Turn Pipeline Replay — corpus index sanity', () => {
  it('enumerates at least 47 rows (Round-1..4) plus Phase 3 variant rows', () => {
    // Round 1–4 closed enumeration shipped 47 rows. Stage 1C Phase 3 added
    // variant rows (48–55) covering turnOptions / proxy / activation-flag
    // surfaces; Phase 4+ may add further rows. Lower bound is 47.
    expect(CORPUS_INDEX.length).toBeGreaterThanOrEqual(47);
  });

  it('has at least 33 shipped rows for Stage 1C Phase 3 acceptance bar', () => {
    // Phase 1 shipped 8; Phase 2 shipped 12 more (20 total); Phase 3 ships
    // 13+ more rows to land the corpus at the ≥33 acceptance bar.
    const shipped = CORPUS_INDEX.filter(r => r.status === 'shipped');
    expect(shipped.length).toBeGreaterThanOrEqual(33);
  });

  it('at least 3 rows exercise proxyManager.addRoutes (Phase 3 must-fix)', () => {
    // Phase 2 reviewer must-fix: until Phase 3, only rows 21 (council
    // failure) + 25 (codex connected) reached `proxyManager.addRoutes`.
    // Phase 3 ships ad-hoc + openrouter-connected + council-happy rows
    // that successfully traverse the proxy gate.
    const rowsExercisingProxy: ReadonlyArray<number> = [20, 21, 25, 27, 48];
    const shippedIds = new Set(
      CORPUS_INDEX.filter(r => r.status === 'shipped').map(r => r.id),
    );
    const shippedProxyRows = rowsExercisingProxy.filter(id => shippedIds.has(id));
    expect(shippedProxyRows.length).toBeGreaterThanOrEqual(3);
  });

  it('all corpus row ids are unique and contiguous', () => {
    const ids = CORPUS_INDEX.map(r => r.id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
  });

  it('every row references a stage in the closed seam set', () => {
    const allowed: ReadonlyArray<CorpusRow['stage']> = ['S1', 'S2', 'S3', 'S4', 'S5', 'orchestrator'];
    for (const row of CORPUS_INDEX) {
      expect(allowed).toContain(row.stage);
    }
  });

  it('shipped rows cover at least 4 distinct stage seams', () => {
    const shipped = CORPUS_INDEX.filter(r => r.status === 'shipped');
    const stages = new Set(shipped.map(r => r.stage));
    expect(stages.size).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Test isolation invariant — guards against I4 regression.
//
// The replay corpus is sensitive to ANY production import path that
// lazy-loads a versioned store with init-time logging from within the turn
// pipeline. When that happens, whichever row runs first in a fresh vitest
// worker captures the once-per-process init logs while subsequent rows do
// not, making per-row pass/fail outcome dependent on `-t` filter ordering
// instead of the executor's actual behavior.
//
// `mcpBuildAutoDetectHook` is the canonical example — its three exported
// surfaces (buildStuckRegistrationReminder, promoteTestingContributionIfRegistered,
// createMcpBuildAutoDetectHook) all reach contributionStore singleton init
// from the executor. The vi.mock(...) above no-ops them at the test boundary.
//
// This test locks in the mock contract. If anyone removes the mock or
// changes the no-op return shape, this fails immediately rather than
// silently breaking per-row isolation. See I4 in
// docs/plans/260428_turnpipeline_rebelsystemroot_fixture_redaction.md and
// the canonical fix in commit 79dcd8777.
// ---------------------------------------------------------------------------
describe('Turn Pipeline Replay — test isolation invariants (I4 regression guard)', () => {
  it('mcpBuildAutoDetectHook surfaces are mocked to no-ops', async () => {
    const mockedHook = await import('../mcpBuildAutoDetectHook');
    expect(vi.isMockFunction(mockedHook.buildStuckRegistrationReminder)).toBe(true);
    expect(mockedHook.buildStuckRegistrationReminder({} as never)).toBeUndefined();

    expect(vi.isMockFunction(mockedHook.promoteTestingContributionIfRegistered)).toBe(true);
    await expect(
      mockedHook.promoteTestingContributionIfRegistered({} as never),
    ).resolves.toBeUndefined();

    expect(vi.isMockFunction(mockedHook.createMcpBuildAutoDetectHook)).toBe(true);
    const hook = mockedHook.createMcpBuildAutoDetectHook({} as never);
    expect(typeof hook).toBe('function');
    await expect(hook({} as never)).resolves.toEqual({});
  });

  it('mcpBuildAutoDetectHook source export surface is statically accounted for', () => {
    const sourceText = readFileSync(
      path.join(__dirname, '..', 'mcpBuildAutoDetectHook.ts'),
      'utf-8',
    );
    const exportPattern = /^export\s+(?:async\s+)?function\s+(\w+)/gm;
    const sourceFunctionExports = Array.from(sourceText.matchAll(exportPattern), (m) => m[1]).sort();

    const mockedExportNames = [
      'buildStuckRegistrationReminder',
      'promoteTestingContributionIfRegistered',
      'createMcpBuildAutoDetectHook',
    ];
    const intentionallyUnmocked = [
      '_resetSeEvidenceFlagTrackingForTest',
      'waitForPendingPromotion',
    ];
    const expectedAccountedFor = [...mockedExportNames, ...intentionallyUnmocked].sort();

    expect(sourceFunctionExports).toEqual(expectedAccountedFor);
  });
});

describe('Turn Pipeline Replay — corpus driver (Stage 1C Phase 1)', () => {
  let harness: ReplayHarnessHandle;

  beforeEach(() => {
    harness = installReplayHarness();
  });

  for (const row of CORPUS_INDEX) {
    if (row.status === 'shipped') {
      it(`row ${row.id}: ${row.description}`, async () => {
        const fixture = loadFixture(row.fixtureFile);

        await runMonolithUnderHarness(fixture.input, harness);

        const trace = canonicalizeForRow(harness, fixture.input);

        // Round-trip the recorded trace through JSON.stringify/parse to
        // match the on-disk fixture's serialization (undefined → omitted,
        // dates → strings, etc.). This is necessary because
        // `expect(actual).toEqual(...)` differentiates `null` from
        // `undefined`, and the on-disk fixture sees the JSON-normalized
        // form.
        const traceJson = JSON.parse(JSON.stringify(trace));

        if (RECORD_MODE) {
          // Persist the freshly-recorded trace as the row's expected.
          writeFixture(row.fixtureFile, {
            id: fixture.id,
            description: fixture.description,
            stage: fixture.stage,
            addedIn: fixture.addedIn,
            notes: fixture.notes,
            input: fixture.input,
            expected: traceJson as Record<string, unknown>,
          });
          // After a record-mode write, byte-equivalence is trivially
          // true (we just wrote it). Still assert so the test reports
          // pass, not a no-op.
          expect(traceJson).toEqual(traceJson);
        } else {
          // Byte-equivalent assertion against the saved fixture.
          expect(traceJson).toEqual(fixture.expected);
        }

        harness.uninstall();
      });
    } else {
      it.skip(`row ${row.id}: ${row.description} (${row.status} — Stage 1C+ Phase 2+)`, () => {
        // Intentional skip: subsequent phases fill in remaining rows.
      });
    }
  }
});

describe('Turn Pipeline Replay — harness wiring smoke tests', () => {
  it('records calls in monotonic capture-sequence order across surfaces', () => {
    const handle = installReplayHarness();
    handle.recorder.recordRegistry('setActiveTurnController', ['turn-1']);
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 'turn-1', { type: 'turn_started' }]);
    handle.recorder.recordLog('info', [{ event: 'a' }, 'msg']);
    handle.recorder.recordSentry('captureMessage', ['watchdog auto-abort fired', { turnId: 'turn-1' }]);
    handle.recorder.recordCost('appendCostEntry', [{ turnId: 'turn-1', amount: 0.01 }]);

    const trace = canonicalize(handle.records);
    expect(trace.timeline.length).toBe(5);
    expect(trace.timeline.map(t => t.surface)).toEqual([
      'registry',
      'event',
      'log',
      'sentry',
      'cost',
    ]);
    expect(trace.registry.length).toBe(1);
    expect(trace.events.length).toBe(1);
    expect(trace.log.length).toBe(1);
    expect(trace.sentry.length).toBe(1);
    expect(trace.cost.length).toBe(1);

    handle.uninstall();
  });

  it('partitions per-surface arrays in capture order even with interleaved calls', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('e1', []);
    handle.recorder.recordRegistry('r1', []);
    handle.recorder.recordEvent('e2', []);
    handle.recorder.recordRegistry('r2', []);
    handle.recorder.recordEvent('e3', []);

    const trace = canonicalize(handle.records);
    expect(trace.events.map(c => c.method)).toEqual(['e1', 'e2', 'e3']);
    expect(trace.registry.map(c => c.method)).toEqual(['r1', 'r2']);
    expect(trace.timeline.map(t => t.surface)).toEqual(['event', 'registry', 'event', 'registry', 'event']);
  });

  it('canonical sentry array unifies captureException/captureMessage/reportMcpError', () => {
    const handle = installReplayHarness();
    handle.recorder.recordSentry('captureException', [
      new Error('boom'),
      { tag: 'phase', phase: 'admission' },
    ]);
    handle.recorder.recordSentry('captureMessage', [
      'level-1 stall detected',
      { turnId: 'turn-1' },
    ]);
    handle.recorder.recordSentry('reportMcpError', [
      new Error('mcp config invalid'),
      { server: 'super-mcp' },
    ]);

    const trace = canonicalize(handle.records);
    expect(trace.sentry).toHaveLength(3);
    expect(trace.sentry.map(s => s.method)).toEqual([
      'captureException',
      'captureMessage',
      'reportMcpError',
    ]);
    expect(trace.sentry[0].message).toBe('boom');
    expect(trace.sentry[1].message).toBe('level-1 stall detected');
    expect(trace.sentry[2].message).toBe('mcp config invalid');
  });

  it('strips non-deterministic fields (timestamp / durationMs / stack)', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('dispatchAgentEvent', [
      null,
      'turn-1',
      {
        type: 'turn_started',
        timestamp: Date.now(),
        durationMs: 42,
        nested: { stack: 'Error\n  at fn () ...' },
      },
    ]);

    const trace = canonicalize(handle.records);
    const evtPayload = trace.events[0].args[2] as Record<string, unknown>;
    expect(evtPayload.timestamp).toBe('<TIMESTAMP>');
    expect(evtPayload.durationMs).toBe('<DURATION_MS>');
    expect((evtPayload.nested as Record<string, unknown>).stack).toBe('<STACK>');
  });

  it('substitutes turnId / sessionId tokens for stable comparison', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('dispatchAgentEvent', [
      null,
      'real-turn-uuid-abc',
      { sessionId: 'real-session-uuid-xyz' },
    ]);

    const trace = canonicalize(handle.records, {
      turnIdSubstitutions: { 'real-turn-uuid-abc': '<TURN_ID>' },
      sessionIdSubstitutions: { 'real-session-uuid-xyz': '<SESSION_ID>' },
    });
    expect(trace.events[0].args[1]).toBe('<TURN_ID>');
    expect((trace.events[0].args[2] as Record<string, unknown>).sessionId).toBe('<SESSION_ID>');
  });

  it('records env-mutation surface (Round-2 F6 expansion)', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEnvMutation('setPath', ['PATH', '/usr/local/bundled-node/bin:/usr/bin']);
    handle.recorder.recordEnvMutation('setAuthEnvVar', ['ANTHROPIC_API_KEY', '<REDACTED>']);
    handle.recorder.recordEnvMutation('unsetEnvVar', ['OPENAI_API_KEY']);
    const trace = canonicalize(handle.records);
    expect(trace.envMutation).toHaveLength(3);
    expect(trace.envMutation.map(c => c.method)).toEqual(['setPath', 'setAuthEnvVar', 'unsetEnvVar']);
    expect(trace.envMutation[0].args[0]).toBe('PATH');
    expect(trace.timeline.map(t => t.surface)).toEqual(['envMutation', 'envMutation', 'envMutation']);
    handle.uninstall();
  });

  it('records settings-mutation surface (Round-2 F6 expansion)', () => {
    const handle = installReplayHarness();
    handle.recorder.recordSettingsMutation('markProfileIncompatible', [
      'profile-id-claude-code-3-0',
      { reason: 'auto-mark-from-error-recovery' },
    ]);
    handle.recorder.recordSettingsMutation('updateSettings', [
      { activeProfileId: 'fallback-profile-id' },
    ]);
    const trace = canonicalize(handle.records);
    expect(trace.settingsMutation).toHaveLength(2);
    expect(trace.settingsMutation.map(c => c.method)).toEqual([
      'markProfileIncompatible',
      'updateSettings',
    ]);
    expect(trace.settingsMutation[0].args[0]).toBe('profile-id-claude-code-3-0');
    expect(trace.timeline.map(t => t.surface)).toEqual(['settingsMutation', 'settingsMutation']);
    handle.uninstall();
  });

  it('reset() clears the timeline; uninstall() does the same', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('e1', []);
    expect(handle.records.timeline.length).toBe(1);
    handle.reset();
    expect(handle.records.timeline.length).toBe(0);
    handle.recorder.recordEvent('e2', []);
    expect(handle.records.timeline.length).toBe(1);
    handle.uninstall();
    expect(handle.records.timeline.length).toBe(0);
  });

  it('records query surface (Phase 3 expansion)', () => {
    const handle = installReplayHarness();
    handle.recorder.recordQuery('queryWithRuntime', [{ model: 'claude-sonnet-4-5', toolCount: 5 }]);
    handle.recorder.recordQuery('queryEnded', [{ stopReason: 'end_turn' }]);
    const trace = canonicalize(handle.records);
    expect(trace.query).toHaveLength(2);
    expect(trace.query.map(c => c.method)).toEqual(['queryWithRuntime', 'queryEnded']);
    handle.uninstall();
  });

  it('query surface preserves capture-sequence ordering with interleaved surfaces', () => {
    const handle = installReplayHarness();
    handle.recorder.recordRegistry('setActiveTurnController', ['turn-q']);
    handle.recorder.recordQuery('queryWithRuntime', [{ model: 'sonnet' }]);
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 'turn-q', { type: 'assistant' }]);
    handle.recorder.recordQuery('queryEnded', [{ stopReason: 'end_turn' }]);
    const trace = canonicalize(handle.records);
    expect(trace.query).toHaveLength(2);
    expect(trace.timeline.map(t => t.surface)).toEqual(['registry', 'query', 'event', 'query']);
    expect(trace.query[0].method).toBe('queryWithRuntime');
    expect(trace.query[1].method).toBe('queryEnded');
    handle.uninstall();
  });
});
