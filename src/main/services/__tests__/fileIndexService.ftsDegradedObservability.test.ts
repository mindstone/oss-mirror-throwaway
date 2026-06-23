/**
 * FTS-degraded observability (Stage 1 of
 * docs/plans/260618_semantic-index-error-surfacing/PLAN.md).
 *
 * Red→green proof that an FTS (keyword) index-build failure is captured to
 * Sentry via the `file_index_fts_degraded` known condition — bounded by a
 * module-level once-per-process latch, with a PII-safe (redacted, synthetic)
 * Error so raw LanceDB error strings (which can embed workspace paths) never
 * leave the device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  // Fake LanceDB native module — ensureFTSIndexes only needs `Index.fts`.
  fakeLancedb: {
    Index: { fts: vi.fn(() => ({ __ftsConfig: true })) },
  },
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    isPackaged: false,
    userDataPath: '/tmp/fts-degraded-observability-userdata',
    version: '0.0.0',
  }),
}));

vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  logger: {
    debug: testState.loggerDebug,
    info: testState.loggerInfo,
    warn: testState.loggerWarn,
    error: testState.loggerError,
  },
  createScopedLogger: () => ({
    debug: testState.loggerDebug,
    info: testState.loggerInfo,
    warn: testState.loggerWarn,
    error: testState.loggerError,
  }),
}));

vi.mock('@core/embeddingGenerator', () => ({
  getEmbeddingGenerator: () => ({
    generateEmbedding: async () => Float32Array.from([1, 0, 0]),
    generateQueryEmbedding: async () => Float32Array.from([1, 0, 0]),
    generateEmbeddings: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0, 0])),
  }),
}));

vi.mock('@core/utils/loadNativeModule', () => ({
  loadNativeModule: vi.fn(() => testState.fakeLancedb),
}));

vi.mock('./visibilityAwareScheduler', () => ({
  isAnyTurnActive: vi.fn(() => false),
  waitForTurnIdle: vi.fn(async () => 'idle' as const),
}));

vi.mock('../sourceMetadataStore', () => ({
  isSourcePath: vi.fn(() => false),
  indexSource: vi.fn(),
}));

vi.mock('../entityMetadataStore', () => ({
  isEntityFile: vi.fn(() => false),
  indexEntity: vi.fn(),
  removeEntity: vi.fn(),
}));

vi.mock('../../utils/systemUtils', () => ({
  tryConvertToWorkspacePath: vi.fn(() => null),
}));

vi.mock('../../utils/emfileRetry', () => ({
  isTooManyOpenFilesError: vi.fn(() => false),
}));

vi.mock('../../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: vi.fn(() => ({ isFirstDetection: false })),
}));

vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: vi.fn(),
}));

vi.mock('../../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

import { setErrorReporter } from '@core/errorReporter';
import {
  _ensureFTSIndexesForTesting,
  _resetFtsDegradedLatchForTesting,
} from '../fileIndexService';

type Captured = Array<{ error: unknown; context?: Record<string, unknown> }>;

function installCaptureRecorder(): Captured {
  const captured: Captured = [];
  setErrorReporter({
    captureException: (error, context) => {
      captured.push({ error, context });
    },
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
  return captured;
}

// A workspace path that doubles as the PII canary: if the raw error string
// leaks into the Sentry payload, this substring will show up.
const WORKSPACE = '/Users/jane/Library/Mobile Documents/com~apple~CloudDocs/Acme';
const SECRET_IN_RAW_ERROR = `${WORKSPACE}/file_embeddings.lance`;

/** Fake table whose `createIndex` throws (drives the catch branch). */
function makeThrowingCreateTable(): any {
  return {
    listIndices: vi.fn(async () => []), // nothing indexed yet → createIndex runs
    createIndex: vi.fn(async () => {
      throw new Error(`LanceDB FTS create failed at ${SECRET_IN_RAW_ERROR}`);
    }),
  };
}

/** Fake table whose post-create verify finds the indexes missing (verify branch). */
function makeVerifyFailsTable(): any {
  let createCalls = 0;
  return {
    // First listIndices: empty (so createIndex runs). After "create",
    // listIndices STILL returns empty → verify fails.
    listIndices: vi.fn(async () => []),
    createIndex: vi.fn(async () => {
      createCalls += 1;
    }),
    get _createCalls() {
      return createCalls;
    },
  };
}

describe('fileIndexService FTS-degraded Sentry observability', () => {
  let captured: Captured;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetFtsDegradedLatchForTesting();
    captured = installCaptureRecorder();
  });

  afterEach(() => {
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
  });

  it('captures file_index_fts_degraded once on a build failure (catch branch)', async () => {
    const table = makeThrowingCreateTable();

    const ok = await _ensureFTSIndexesForTesting(table, WORKSPACE);
    expect(ok).toBe(false); // fallback behaviour preserved

    expect(captured).toHaveLength(1);
    const ctx = captured[0].context ?? {};
    // Routed through captureKnownCondition: registry level + fingerprint + flag.
    expect(ctx).toMatchObject({
      level: 'warning',
      fingerprint: ['file-index-fts-degraded', 'create'],
      _knownConditionWrapped: true,
      phase: 'create',
    });

    // PII proof: the synthetic Error (and the entire serialized payload) must
    // contain NO workspace path — neither in message nor stack.
    const err = captured[0].error as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(WORKSPACE);
    expect(err.message).not.toContain(SECRET_IN_RAW_ERROR);
    const serialized = JSON.stringify({ message: err.message, stack: err.stack, context: ctx });
    expect(serialized).not.toContain(WORKSPACE);
  });

  it('captures phase "verify" on the post-create verification failure', async () => {
    const table = makeVerifyFailsTable();

    const ok = await _ensureFTSIndexesForTesting(table, WORKSPACE);
    expect(ok).toBe(false);

    expect(captured).toHaveLength(1);
    expect(captured[0].context).toMatchObject({
      level: 'warning',
      fingerprint: ['file-index-fts-degraded', 'verify'],
      phase: 'verify',
    });
  });

  it('LATCH: a second failing init for the same workspace+phase does NOT re-capture', async () => {
    await _ensureFTSIndexesForTesting(makeThrowingCreateTable(), WORKSPACE);
    expect(captured).toHaveLength(1);

    // Second failing init, same workspace, same phase (create).
    await _ensureFTSIndexesForTesting(makeThrowingCreateTable(), WORKSPACE);

    // Latch bounds Sentry volume to one event per workspace per phase per
    // process — the flood guard, asserted (not commented).
    expect(captured).toHaveLength(1);
  });

  it('LATCH: a DIFFERENT workspace re-captures (latch is keyed per workspace)', async () => {
    await _ensureFTSIndexesForTesting(makeThrowingCreateTable(), WORKSPACE);
    expect(captured).toHaveLength(1);

    await _ensureFTSIndexesForTesting(makeThrowingCreateTable(), '/Users/jane/OtherWorkspace');
    expect(captured).toHaveLength(2);
  });

  it('does NOT capture when FTS build succeeds', async () => {
    const table: any = {
      // Already indexed → no createIndex, no verify failure.
      listIndices: vi.fn(async () => [
        { columns: ['content'] },
        { columns: ['filename_stem'] },
      ]),
      createIndex: vi.fn(),
    };

    const ok = await _ensureFTSIndexesForTesting(table, WORKSPACE);
    expect(ok).toBe(true);
    expect(captured).toHaveLength(0);
  });
});
