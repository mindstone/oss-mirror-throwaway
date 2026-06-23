/**
 * Stage 3.D unit tests — `contributionObservationService`.
 *
 * 22 tests organised into 5 sections per § "Test inventory → Unit tests"
 * of the Stage 3 plan:
 *
 *   - Reducer (4)              — pure reducer state-transition checks.
 *   - Mutex (4)                — `withMutex` semantics + isolation.
 *   - Entrypoint (4)           — `observeContribution` integration with
 *                                the in-memory store + mocked fs.
 *   - Cloud-parity (4)         — `agentAssertedFingerprint` flow.
 *   - State-machine (6)        — explicit reducer-output coverage matrix.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage3.md (Stage 3.D)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── In-memory store mock (mirrors contributionStore.test.ts) ──────────

let storeData: Record<string, unknown> = {};

 
vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) {
      return storeData[key];
    },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrObj === 'string') {
        storeData[keyOrObj] = value;
      } else {
        Object.assign(storeData, keyOrObj);
      }
    },
    has(key: string) {
      return key in storeData;
    },
    delete(key: string) {
      delete storeData[key];
    },
    clear() {
      storeData = {};
    },
    get store() {
      return storeData;
    },
    set store(val: Record<string, unknown>) {
      storeData = val;
    },
    path: '/mock/path',
  })),
}));

 
vi.mock('@core/utils/storeMigration', () => ({
  createMigrationRegistry: <T>(migrations: Record<number, unknown>): Record<number, unknown> => migrations as Record<number, T>,
  migrateStore: vi.fn((stored: Record<string, unknown>) => ({
    data: stored,
    status: 'current' as const,
    shouldPersist: false,
    fromVersion: (stored as { version?: number }).version ?? 1,
    toVersion: 1,
    backupPath: null,
  })),
  shouldEnterReadOnlyMode: (result: { status: string; shouldPersist: boolean }): boolean =>
    result.status === 'future_version' ||
    (result.status === 'corrupted' && result.shouldPersist === false),
}));

// canonicaliser collapses separators + lowercases on darwin/win32; the
// reducer's tests don't depend on platform-specific case behaviour, so we
// mock it to a deterministic identity-style normaliser the way other tests
// do (see `mcpBuildAutoDetectHook.test.ts`).
 
vi.mock('@core/utils/canonicalConnectorPath', () => ({
  canonicalizeConnectorPath: vi.fn((value: string | undefined | null) => {
    if (!value || !value.trim()) return '';
    return value.replace(/\\/g, '/').toLowerCase();
  }),
}));

// node:fs mock — `computeBuildFingerprint` calls `statSync(<path>/package.json)`.
// Default to ENOENT so most reducer tests don't accidentally pick up a
// fingerprint via the fs path. Entrypoint tests override per-case.
type FakeStats = { mtimeMs: number; size: number };
const fsMocks = vi.hoisted(() => ({
  statSync: vi.fn<(path: string) => { mtimeMs: number; size: number }>(() => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }),
}));

 
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      statSync: fsMocks.statSync,
    },
    statSync: fsMocks.statSync,
  };
});

// Imports MUST come after the mocks above so `vi.mock` resolves first.
import {
  observeContribution,
  reduceObservation,
  computeBuildFingerprint,
  buildMissingSeEvidenceTransitionError,
  _withMutexForTest,
  _resetMutexesForTest,
  type Observation,
  type ReducerInput,
  type ReducerOutput,
  type ReducerState,
} from '../contributionObservationService';
import {
  createContribution,
  getContributionById,
  getContributionByPath,
  updateContribution,
  _resetStore,
} from '../contributionStore';

// ─── Helpers ────────────────────────────────────────────────────────────

const NOW = '2026-04-26T12:00:00.000Z';
const SESSION = 'session-test-3d';
const CANONICAL_PATH = '/users/test/mcp-servers/observe-test';
const RAW_PATH = '/Users/Test/mcp-servers/observe-test';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

function makeBuildDetected(
  overrides?: Partial<Extract<Observation, { kind: 'build_detected' }>>,
): Observation {
  return {
    kind: 'build_detected',
    sessionId: SESSION,
    localServerPath: RAW_PATH,
    connectorName: 'observe-test',
    source: 'post-tool-bash',
    ...overrides,
  };
}
function makeTestPassed(
  overrides?: Partial<Extract<Observation, { kind: 'test_passed' }>>,
): Observation {
  return {
    kind: 'test_passed',
    sessionId: SESSION,
    localServerPath: RAW_PATH,
    source: 'post-tool-bash',
    ...overrides,
  };
}
function makeServerRegistered(
  overrides?: Partial<Extract<Observation, { kind: 'server_registered' }>>,
): Observation {
  return {
    kind: 'server_registered',
    sessionId: SESSION,
    localServerPath: RAW_PATH,
    connectorName: 'observe-test',
    source: 'post-tool-add-server',
    ...overrides,
  };
}
function makeReadyRequested(
  overrides?: Partial<Extract<Observation, { kind: 'ready_requested' }>>,
): Observation {
  return {
    kind: 'ready_requested',
    sessionId: SESSION,
    localServerPath: RAW_PATH,
    connectorName: 'observe-test',
    source: 'bridge-report-state',
    ...overrides,
  };
}
function makeState(overrides?: Partial<ReducerState>): ReducerState {
  return {
    status: 'testing',
    ...overrides,
  };
}
function reducerInput(
  observation: Observation,
  state: ReducerState | undefined,
  observedFingerprint?: string,
): ReducerInput {
  return { observation, state, observedFingerprint, now: NOW };
}

// ─── beforeEach / afterEach ────────────────────────────────────────────

beforeEach(() => {
  storeData = {};
  _resetStore();
  _resetMutexesForTest();
  fsMocks.statSync.mockImplementation(() => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Section 1: Reducer (4 tests) ──────────────────────────────────────

describe('reduceObservation — section 1: reducer', () => {
  it('build_detected with no record creates draft', () => {
    const out = reduceObservation(
      reducerInput(makeBuildDetected(), undefined, FINGERPRINT_A),
    );
    expect(out.kind).toBe('create_record');
    if (out.kind !== 'create_record') return;
    expect(out.status).toBe('draft');
    expect(out.fields.lastBuildDetectedAt).toBe(NOW);
    expect(out.fields.lastBuildFingerprint).toBe(FINGERPRINT_A);
  });

  it('build_detected with existing record applies writes (no promote)', () => {
    const state = makeState({ lastBuildFingerprint: FINGERPRINT_A });
    const out = reduceObservation(
      reducerInput(makeBuildDetected(), state, FINGERPRINT_A),
    );
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.fields.lastBuildDetectedAt).toBe(NOW);
    expect(out.fields.lastBuildFingerprint).toBe(FINGERPRINT_A);
    expect(out.promote).toBeUndefined();
    expect(out.deferralReason).toBeUndefined();
  });

  it('ready_requested with full evidence + matching fingerprint promotes', () => {
    const state = makeState({
      status: 'testing',
      lastTestPassedAt: '2026-04-26T11:00:00.000Z',
      lastBuildFingerprint: FINGERPRINT_A,
    });
    const out = reduceObservation(
      reducerInput(makeReadyRequested(), state, FINGERPRINT_A),
    );
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.promote).toBe('ready_to_submit');
    expect(out.fields.lastReadyRequestedAt).toBe(NOW);
    expect(out.deferralReason).toBeUndefined();
  });

  it('ready_requested defers with missing_se_evidence when gate is on and SE evidence is absent', () => {
    const state = makeState({
      status: 'testing',
      lastTestPassedAt: '2026-04-26T11:00:00.000Z',
      lastBuildFingerprint: FINGERPRINT_A,
    });
    const out = reduceObservation({
      ...reducerInput(makeReadyRequested(), state, FINGERPRINT_A),
      enforceSoftwareEngineerEvidence: true,
    });
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.promote).toBeUndefined();
    expect(out.deferralReason).toBe('missing_se_evidence');
  });

  it('ready_requested promotes with gate on when SE evidence exists', () => {
    const state = makeState({
      status: 'testing',
      lastTestPassedAt: '2026-04-26T11:00:00.000Z',
      lastBuildFingerprint: FINGERPRINT_A,
      lastSoftwareEngineerTaskCompletedAt: '2026-04-26T11:30:00.000Z',
    });
    const out = reduceObservation({
      ...reducerInput(makeReadyRequested(), state, FINGERPRINT_A),
      enforceSoftwareEngineerEvidence: true,
    });
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.promote).toBe('ready_to_submit');
    expect(out.deferralReason).toBeUndefined();
  });

  it('ready_requested with mismatched fingerprint defers + flags stale invalidation', () => {
    const state = makeState({
      status: 'testing',
      lastTestPassedAt: '2026-04-26T11:00:00.000Z',
      lastReadyRequestedAt: '2026-04-26T11:30:00.000Z',
      lastBuildFingerprint: FINGERPRINT_A,
    });
    const out = reduceObservation(
      reducerInput(makeReadyRequested(), state, FINGERPRINT_B),
    );
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.promote).toBeUndefined();
    expect(out.deferralReason).toBe('missing_evidence');
    expect(out.staleFingerprintInvalidation?.newFingerprint).toBe(FINGERPRINT_B);
    expect(out.fields.lastBuildFingerprint).toBe(FINGERPRINT_B);
  });
});

// ─── Section 2: Mutex (4 tests) ────────────────────────────────────────

describe('_withMutexForTest — section 2: mutex', () => {
  it('serial-on-same-path: concurrent calls on the SAME path execute strictly serially', async () => {
    const order: string[] = [];
    const fn1 = async (): Promise<void> => {
      order.push('fn1-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('fn1-end');
    };
    const fn2 = async (): Promise<void> => {
      order.push('fn2-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('fn2-end');
    };
    const p1 = _withMutexForTest('/p', fn1);
    const p2 = _withMutexForTest('/p', fn2);
    await Promise.all([p1, p2]);
    // fn2-start MUST come AFTER fn1-end (strict serialisation).
    expect(order).toEqual(['fn1-start', 'fn1-end', 'fn2-start', 'fn2-end']);
  });

  it('parallel-on-different-paths: concurrent calls on DIFFERENT paths overlap', async () => {
    const order: string[] = [];
    const fn1 = async (): Promise<void> => {
      order.push('fn1-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('fn1-end');
    };
    const fn2 = async (): Promise<void> => {
      order.push('fn2-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('fn2-end');
    };
    const p1 = _withMutexForTest('/p1', fn1);
    const p2 = _withMutexForTest('/p2', fn2);
    await Promise.all([p1, p2]);
    // fn2-start happens before fn1-end (parallel overlap).
    const fn1EndIdx = order.indexOf('fn1-end');
    const fn2StartIdx = order.indexOf('fn2-start');
    expect(fn2StartIdx).toBeLessThan(fn1EndIdx);
  });

  it('release-on-throw: rejection in fn does not strand the mutex', async () => {
    const fn1 = async (): Promise<never> => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('boom');
    };
    await expect(_withMutexForTest('/p', fn1)).rejects.toThrow('boom');
    // Subsequent caller proceeds.
    const fn2 = async (): Promise<string> => 'ok';
    const result = await _withMutexForTest('/p', fn2);
    expect(result).toBe('ok');
  });

  it('does-not-leak when a late caller installed a new entry mid-finally', async () => {
    // Caller A holds the mutex while doing async work. Caller B then C
    // queue up. After all settle, the map should be empty (the "only
    // delete if still ours" guard prevents A's finally from clobbering
    // C's surviving entry — the very last entry's finally removes it).
    const order: string[] = [];
    const a = _withMutexForTest('/p', async () => {
      order.push('A');
      await new Promise((r) => setTimeout(r, 10));
    });
    const b = _withMutexForTest('/p', async () => {
      order.push('B');
    });
    const c = _withMutexForTest('/p', async () => {
      order.push('C');
    });
    await Promise.all([a, b, c]);
    expect(order).toEqual(['A', 'B', 'C']);
    // After the final caller finishes, the map should be cleaned up.
    // (We can't observe the map directly; emit a fresh call and verify
    // it executes serially with itself when re-introduced.)
    const fresh = await _withMutexForTest('/p', async () => 'fresh');
    expect(fresh).toBe('fresh');
  });
});

// ─── Section 3: Entrypoint (4 tests) ───────────────────────────────────

describe('observeContribution — section 3: entrypoint', () => {
  it('routes through reducer + applies field writes via store', async () => {
    fsMocks.statSync.mockImplementation((): FakeStats => ({ mtimeMs: 1700000000000, size: 200 }));
    // Pre-create a testing record.
    createContribution({
      sessionId: SESSION,
      connectorName: 'observe-test',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: RAW_PATH,
    });
    const result = await observeContribution(makeBuildDetected());
    expect(result.decision).toBe('updated');
    expect(result.contributionId).toBeDefined();
    const stored = getContributionById(result.contributionId!);
    expect(stored?.lastBuildDetectedAt).toBeDefined();
    expect(stored?.lastBuildFingerprint).toBeDefined();
  });

  it('creates record at draft with computed fingerprint when none exists', async () => {
    fsMocks.statSync.mockImplementation((): FakeStats => ({ mtimeMs: 1700000000000, size: 200 }));
    const result = await observeContribution(makeBuildDetected());
    expect(result.decision).toBe('created');
    expect(result.contributionId).toBeDefined();
    const stored = getContributionById(result.contributionId!);
    expect(stored?.status).toBe('draft');
    expect(stored?.lastBuildFingerprint).toBeDefined();
    expect(stored?.lastBuildDetectedAt).toBeDefined();
  });

  it('dual-claim race serialised by mutex: same path, two concurrent observations yield one record', async () => {
    let mtime = 1700000000000;
    fsMocks.statSync.mockImplementation((): FakeStats => ({ mtimeMs: mtime++, size: 200 }));
    const obs1 = makeBuildDetected({ sessionId: 'race-session-A' });
    const obs2 = makeBuildDetected({ sessionId: 'race-session-B' });
    const [r1, r2] = await Promise.all([
      observeContribution(obs1),
      observeContribution(obs2),
    ]);
    // Exactly one created; the other landed on the same record (created
    // OR updated — both are valid serial outcomes since the second
    // observation may see the first record via path-first lookup).
    const decisions = [r1.decision, r2.decision].sort();
    expect(decisions).toEqual(['created', 'updated']);
    // Final record carries one canonical id.
    const finalRecords = (storeData.contributions as { canonicalConnectorPath: string }[]).filter(
      (c) => c.canonicalConnectorPath === CANONICAL_PATH,
    );
    expect(finalRecords).toHaveLength(1);
  });

  it('mutex isolation across DIFFERENT paths: parallel observations both succeed independently', async () => {
    fsMocks.statSync.mockImplementation((): FakeStats => ({ mtimeMs: 1700000000000, size: 200 }));
    const obs1 = makeBuildDetected({
      sessionId: 'session-iso-1',
      localServerPath: '/Users/test/mcp-servers/iso-1',
      connectorName: 'iso-1',
    });
    const obs2 = makeBuildDetected({
      sessionId: 'session-iso-2',
      localServerPath: '/Users/test/mcp-servers/iso-2',
      connectorName: 'iso-2',
    });
    const [r1, r2] = await Promise.all([
      observeContribution(obs1),
      observeContribution(obs2),
    ]);
    expect(r1.decision).toBe('created');
    expect(r2.decision).toBe('created');
    expect(r1.contributionId).not.toBe(r2.contributionId);
    expect((storeData.contributions as unknown[]).length).toBe(2);
  });
});

// ─── Section 4: Cloud-parity (4 tests) ─────────────────────────────────

describe('reduceObservation — section 4: cloud-parity (agentAssertedFingerprint)', () => {
  it('fail-open on first observation: no fingerprint either side, predicate proceeds', () => {
    const state = makeState({
      status: 'testing',
      lastTestPassedAt: '2026-04-26T11:00:00.000Z',
      // No lastBuildFingerprint.
    });
    const out = reduceObservation(
      reducerInput(makeReadyRequested(), state, undefined),
    );
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.promote).toBe('ready_to_submit');
    expect(out.deferralReason).toBeUndefined();
  });

  it('fail-closed when state has fingerprint but neither observed nor asserted', () => {
    const state = makeState({
      status: 'testing',
      lastTestPassedAt: '2026-04-26T11:00:00.000Z',
      lastBuildFingerprint: FINGERPRINT_A,
    });
    const out = reduceObservation(
      reducerInput(makeReadyRequested(), state, undefined),
    );
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.promote).toBeUndefined();
    expect(out.deferralReason).toBe('fingerprint_unavailable');
  });

  it('agentAssertedFingerprint matching state fingerprint: predicate proceeds via asserted fallback', () => {
    const state = makeState({
      status: 'testing',
      lastTestPassedAt: '2026-04-26T11:00:00.000Z',
      lastBuildFingerprint: FINGERPRINT_A,
    });
    const obs = makeReadyRequested({ agentAssertedFingerprint: FINGERPRINT_A });
    const out = reduceObservation(reducerInput(obs, state, undefined));
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.promote).toBe('ready_to_submit');
    expect(out.deferralReason).toBeUndefined();
  });

  it('agentAssertedFingerprint differing: invalidation fires + predicate defers', () => {
    const state = makeState({
      status: 'testing',
      lastTestPassedAt: '2026-04-26T11:00:00.000Z',
      lastReadyRequestedAt: '2026-04-26T11:30:00.000Z',
      lastBuildFingerprint: FINGERPRINT_A,
    });
    const obs = makeReadyRequested({ agentAssertedFingerprint: FINGERPRINT_B });
    const out = reduceObservation(reducerInput(obs, state, undefined));
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.staleFingerprintInvalidation?.newFingerprint).toBe(FINGERPRINT_B);
    expect(out.deferralReason).toBe('missing_evidence');
    expect(out.promote).toBeUndefined();
    expect(out.fields.lastBuildFingerprint).toBe(FINGERPRINT_B);
  });
});

// ─── Section 5: State-machine coverage (6 tests) ───────────────────────

describe('reduceObservation — section 5: state-machine', () => {
  it('server_registered + no record + post-turn-sweep → create at ready_to_submit', () => {
    const obs = makeServerRegistered({ source: 'post-turn-sweep' });
    const out = reduceObservation(reducerInput(obs, undefined, FINGERPRINT_A));
    expect(out.kind).toBe('create_record');
    if (out.kind !== 'create_record') return;
    expect(out.status).toBe('ready_to_submit');
    expect(out.fields.lastRegisteredAt).toBe(NOW);
  });

  it('server_registered + no record + startup-sweep → noop (boot must not synthesise)', () => {
    const obs = makeServerRegistered({ source: 'startup-sweep' });
    const out = reduceObservation(reducerInput(obs, undefined, FINGERPRINT_A));
    expect(out.kind).toBe('noop');
    if (out.kind !== 'noop') return;
    expect(out.reason).toBe('no_record_to_update');
  });

  it('server_registered + record + any source → apply_writes lastRegisteredAt only', () => {
    const state = makeState({ status: 'testing' });
    const obs = makeServerRegistered({ source: 'startup-sweep' });
    const out = reduceObservation(reducerInput(obs, state, FINGERPRINT_A));
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.fields.lastRegisteredAt).toBe(NOW);
    expect(out.fields.lastBuildDetectedAt).toBeUndefined();
    expect(out.fields.lastTestPassedAt).toBeUndefined();
    expect(out.fields.lastReadyRequestedAt).toBeUndefined();
    expect(out.promote).toBeUndefined();
  });

  it('test_passed + no record → noop (matrix #22 protection — test-pass alone never auto-creates)', () => {
    const out = reduceObservation(
      reducerInput(makeTestPassed(), undefined, FINGERPRINT_A),
    );
    expect(out.kind).toBe('noop');
    if (out.kind !== 'noop') return;
    expect(out.reason).toBe('no_record_to_update');
  });

  it('test_passed + record at draft + fingerprintMatches → status stays draft, lastTestPassedAt set', () => {
    const state = makeState({ status: 'draft', lastBuildFingerprint: FINGERPRINT_A });
    const out = reduceObservation(
      reducerInput(makeTestPassed(), state, FINGERPRINT_A),
    );
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.fields.lastTestPassedAt).toBe(NOW);
    expect(out.promote).toBeUndefined();
    expect(out.deferralReason).toBeUndefined();
  });

  it('ready_requested + record at submitted → reject (invalid_state)', () => {
    const state = makeState({ status: 'submitted', lastBuildFingerprint: FINGERPRINT_A });
    const out: ReducerOutput = reduceObservation(
      reducerInput(makeReadyRequested(), state, FINGERPRINT_A),
    );
    expect(out.kind).toBe('reject');
    if (out.kind !== 'reject') return;
    expect(out.reason).toBe('invalid_state');
    expect(out.details).toContain('submitted');
  });
});

describe('Stage 2 SE sensor transitions', () => {
  it('software_engineer_task_completed sets completion timestamp and clears invalidation metadata', async () => {
    const contribution = createContribution({
      sessionId: SESSION,
      connectorName: 'observe-test',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: RAW_PATH,
    });
    updateContribution(contribution.id, {
      lastSoftwareEngineerEvidenceInvalidatedAt: '2026-04-26T10:00:00.000Z',
      lastSoftwareEngineerEvidenceInvalidatedReason: 'fingerprint_mismatch',
    });

    const result = await observeContribution({
      kind: 'software_engineer_task_completed',
      sessionId: SESSION,
      contributionId: contribution.id,
      taskSubagentTypes: ['software-engineer'],
      observedAt: { sessionId: SESSION, turnIndex: 3 },
      source: 'post-turn-sweep',
    });

    expect(result.decision).toBe('updated');
    const stored = getContributionById(contribution.id);
    expect(stored?.lastSoftwareEngineerTaskCompletedAt).toBeDefined();
    expect(stored?.lastSoftwareEngineerEvidenceInvalidatedAt).toBeUndefined();
    expect(stored?.lastSoftwareEngineerEvidenceInvalidatedReason).toBeUndefined();
  });

  it('software_engineer_task_completed clears synthetic missing_se_evidence transition error', async () => {
    const contribution = createContribution({
      sessionId: SESSION,
      connectorName: 'observe-test',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: RAW_PATH,
    });
    updateContribution(contribution.id, {
      lastTransitionError: buildMissingSeEvidenceTransitionError({
        chatSafeGuidance: 'Let me think this through properly before I share it.',
      }),
    });

    const result = await observeContribution({
      kind: 'software_engineer_task_completed',
      sessionId: SESSION,
      contributionId: contribution.id,
      taskSubagentTypes: ['software-engineer'],
      observedAt: { sessionId: SESSION, turnIndex: 7 },
      source: 'post-turn-sweep',
    });

    expect(result.decision).toBe('updated');
    const stored = getContributionById(contribution.id);
    expect(stored?.lastTransitionError).toBeUndefined();
  });

  it('fingerprint mismatch cascade clears SE completion and sets invalidation reason', () => {
    const state = makeState({
      status: 'testing',
      lastBuildFingerprint: FINGERPRINT_A,
      lastSoftwareEngineerTaskCompletedAt: '2026-04-26T11:00:00.000Z',
    });
    const out = reduceObservation(
      reducerInput(
        makeReadyRequested({ agentAssertedFingerprint: FINGERPRINT_B }),
        state,
        undefined,
      ),
    );
    expect(out.kind).toBe('apply_writes');
    if (out.kind !== 'apply_writes') return;
    expect(out.clearSoftwareEngineerTaskCompletedAt).toBe(true);
    expect(out.setSoftwareEngineerEvidenceInvalidation).toEqual({
      at: NOW,
      reason: 'fingerprint_mismatch',
    });
  });

  it('single-active-build invariant closes prior open window when a new contribution path-locks', async () => {
    const a = createContribution({
      sessionId: SESSION,
      connectorName: 'connector-a',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: '/Users/Test/mcp-servers/connector-a',
    });
    const b = createContribution({
      sessionId: SESSION,
      connectorName: 'connector-b',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: '/Users/Test/mcp-servers/connector-b',
    });

    await observeContribution({
      kind: 'build_detected',
      sessionId: SESSION,
      localServerPath: '/Users/Test/mcp-servers/connector-a',
      connectorName: 'connector-a',
      source: 'post-tool-bash',
    });
    await observeContribution({
      kind: 'build_detected',
      sessionId: SESSION,
      localServerPath: '/Users/Test/mcp-servers/connector-b',
      connectorName: 'connector-b',
      source: 'post-tool-bash',
    });

    const storedA = getContributionById(a.id);
    const storedB = getContributionById(b.id);
    expect(storedA?.turnIndexWindow?.endTurn).toBe(-1);
    expect(storedB?.turnIndexWindow).toEqual({
      sessionId: SESSION,
      startTurn: 0,
      endTurn: null,
    });
  });

  it('terminal-state transition does not re-extend a force-closed window', () => {
    const contribution = createContribution({
      sessionId: SESSION,
      connectorName: 'connector-a',
      status: 'ready_to_submit',
      attributionMode: 'anonymous',
      localServerPath: '/Users/Test/mcp-servers/connector-a',
    });
    updateContribution(contribution.id, {
      turnIndexWindow: {
        sessionId: SESSION,
        startTurn: 2,
        endTurn: 5,
      },
    });

    const updated = updateContribution(contribution.id, { status: 'submitted' });
    expect(updated).not.toBeNull();
    expect(updated).not.toBeUndefined();
    expect(updated && updated.turnIndexWindow).toEqual({
      sessionId: SESSION,
      startTurn: 2,
      endTurn: 5,
    });
  });

  it('combined re-open + fingerprint cascade: reopened contribution still invalidates stale SE evidence', async () => {
    const aPath = '/Users/Test/mcp-servers/connector-a';
    const bPath = '/Users/Test/mcp-servers/connector-b';
    const a = createContribution({
      sessionId: SESSION,
      connectorName: 'connector-a',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: aPath,
      lastBuildFingerprint: FINGERPRINT_A,
    });
    createContribution({
      sessionId: SESSION,
      connectorName: 'connector-b',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: bPath,
    });
    updateContribution(a.id, {
      lastSoftwareEngineerTaskCompletedAt: '2026-04-26T09:00:00.000Z',
      turnIndexWindow: {
        sessionId: SESSION,
        startTurn: 1,
        endTurn: 2,
      },
    });

    await observeContribution({
      kind: 'build_detected',
      sessionId: SESSION,
      localServerPath: aPath,
      connectorName: 'connector-a',
      source: 'post-tool-bash',
    });
    await observeContribution({
      kind: 'ready_requested',
      sessionId: SESSION,
      localServerPath: aPath,
      connectorName: 'connector-a',
      source: 'bridge-report-state',
      agentAssertedFingerprint: FINGERPRINT_B,
    });

    const stored = getContributionByPath(aPath.toLowerCase());
    expect(stored?.turnIndexWindow?.endTurn).toBeNull();
    expect(stored?.lastSoftwareEngineerTaskCompletedAt).toBeUndefined();
    expect(stored?.lastSoftwareEngineerEvidenceInvalidatedReason).toBe('fingerprint_mismatch');
    expect(stored?.lastSoftwareEngineerEvidenceInvalidatedAt).toBeDefined();
  });
});

// ─── computeBuildFingerprint coverage (sanity, not part of the 22) ─────

describe('computeBuildFingerprint — sanity', () => {
  it('returns undefined on ENOENT', () => {
    fsMocks.statSync.mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(computeBuildFingerprint(RAW_PATH)).toBeUndefined();
  });

  it('returns deterministic SHA-256 hex from mtime+size', () => {
    fsMocks.statSync.mockImplementation((): FakeStats => ({ mtimeMs: 1700000000000, size: 200 }));
    const fp1 = computeBuildFingerprint(RAW_PATH);
    const fp2 = computeBuildFingerprint(RAW_PATH);
    expect(fp1).toEqual(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns undefined for empty / falsy input', () => {
    expect(computeBuildFingerprint('')).toBeUndefined();
  });
});
