/**
 * Stage C (260417_approval_consolidation_closeout) — handler-level tests
 * for the IPC dedup wrapper on the 4 staging channels:
 *   - `memory:staging-publish`
 *   - `memory:staging-discard`
 *   - `memory:staging-keep-private`
 *   - `memory:staging-resolve-conflict`
 *
 * Follows the same mocking/capturing pattern as
 * `memoryHandlers.conflictCapability.test.ts`. Confirms the handler:
 *   1. Runs the body on a cold cache (cache miss).
 *   2. Replays the cached response on the second call with the same key
 *      — without re-running any collaborator.
 *   3. Runs the body again when the key is missing (no dedup).
 *   4. For `resolve-conflict`, composes correctly with the Stage B
 *      capability-token gate (replay does NOT re-consume the nonce;
 *      fresh calls with a new dedup key and the same token still land
 *      on CAPABILITY_REUSED).
 *   5. Respects TTL — after the cache entry expires, a third call
 *      re-runs the body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIpcDedupService } from '@core/services/safety/ipcDedupService';

// ---------------------------------------------------------------------------
// Mocks — hoisted before importing the handler module.
// ---------------------------------------------------------------------------

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock();
});

vi.mock('../../services/memoryHistoryStore', () => ({
  getMemoryHistory: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({ total: 0 }),
  getMemoryHistoryEntry: vi.fn().mockReturnValue(null),
  removeMemoryHistoryEntry: vi.fn(),
  repairStaleFilePathsIfNeeded: vi.fn().mockResolvedValue({ repaired: 0, totalScanned: 0, skipped: true }),
  repairMemoryHistoryEntryPath: vi.fn().mockReturnValue(true),
}));

vi.mock('../../services/safety', () => ({
  getPendingMemoryApprovals: vi.fn().mockReturnValue([]),
  handleMemoryWriteApprovalResponse: vi.fn(),
  removePendingMemoryApproval: vi.fn(),
}));

const cosPendingMock = vi.hoisted(() => ({
  listPendingFiles: vi.fn().mockResolvedValue([]),
  getPendingFile: vi.fn(),
  getPendingContent: vi.fn(),
  publishPendingFile: vi.fn(),
  deletePendingFile: vi.fn(),
  keepPendingFilePrivate: vi.fn(),
  publishWithConflictResolution: vi.fn(),
  detectPendingConflict: vi.fn(),
  canonicalizePath: (p: string) => p,
}));
vi.mock('../../services/safety/cosPendingService', () => cosPendingMock);

vi.mock('../../services/meetingBot/transcriptEventBus', () => ({
  emitDeferredTranscriptSaved: vi.fn().mockReturnValue(false),
  emitTranscriptSavedFromMeta: vi.fn(),
  removeDeferredTranscriptSaved: vi.fn(),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/tmp/workspace' }),
}));

vi.mock('../../services/safety/automationPendingItemsTracker', () => ({
  resolveItem: vi.fn(),
}));

vi.mock('../../services/safety/automationContextLookup', () => ({
  getAutomationContext: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    classifySharedSkillPath: vi.fn().mockResolvedValue(null),
    writeManagedSkillFile: vi.fn(),
  },
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: () => ({ id: 'user-1' }),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));


// Capture registered handlers so we can invoke them directly.
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn);
  },
}));

// Import AFTER mocks are declared.
import { registerMemoryHandlers } from '../memoryHandlers';
import type { ConflictCapabilityService } from '@core/services/safety/conflictCapabilityService';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makePendingFile(id: string) {
  return {
    id,
    filePath: `/tmp/pending/${id}.md`,
    content: '# staged body',
    frontmatter: {
      approval_kind: undefined,
      pending_destination: 'notes/out.md',
      pending_transcript_meta: undefined,
      session_id: 'session-1',
      base_hash: 'hash',
      tool_use_id: undefined,
    },
  };
}

function makeCapabilityServiceStub(): ConflictCapabilityService & {
  mintMock: ReturnType<typeof vi.fn>;
  validateMock: ReturnType<typeof vi.fn>;
} {
  const mintMock = vi.fn();
  const validateMock = vi.fn();
  const stub = {
    mint: mintMock,
    validate: validateMock,
    mintMock,
    validateMock,
  };
  return stub as ConflictCapabilityService & {
    mintMock: ReturnType<typeof vi.fn>;
    validateMock: ReturnType<typeof vi.fn>;
  };
}

function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const DEDUP_KEY_A = '11111111-1111-4111-8111-111111111111';
const DEDUP_KEY_B = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// memory:staging-publish
// ---------------------------------------------------------------------------

describe('memory:staging-publish — Stage C dedup', () => {
  beforeEach(() => {
    handlers.clear();
    cosPendingMock.getPendingFile.mockReset();
    cosPendingMock.publishPendingFile.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs the handler body on first call (cache miss)', async () => {
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.publishPendingFile.mockResolvedValue({ status: 'success' });
    registerMemoryHandlers({ ipcDedupService: createIpcDedupService() });
    const handler = handlers.get('memory:staging-publish')!;

    const result = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    expect(result).toEqual({ status: 'success' });
    expect(cosPendingMock.publishPendingFile).toHaveBeenCalledTimes(1);
  });

  it('replays the cached response on retry with the same dedup key (no second body run)', async () => {
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.publishPendingFile.mockResolvedValue({ status: 'success' });
    registerMemoryHandlers({ ipcDedupService: createIpcDedupService() });
    const handler = handlers.get('memory:staging-publish')!;

    const first = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    const second = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });

    expect(first).toEqual({ status: 'success' });
    expect(second).toEqual({ status: 'success' });
    // Handler body runs EXACTLY once — this is the dedup guarantee.
    expect(cosPendingMock.publishPendingFile).toHaveBeenCalledTimes(1);
  });

  it('runs the handler body twice when no dedup key is attached (fail-open)', async () => {
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.publishPendingFile.mockResolvedValue({ status: 'success' });
    registerMemoryHandlers({ ipcDedupService: createIpcDedupService() });
    const handler = handlers.get('memory:staging-publish')!;

    await handler(null, { id: 'stg_1' });
    await handler(null, { id: 'stg_1' });
    expect(cosPendingMock.publishPendingFile).toHaveBeenCalledTimes(2);
  });

  it('treats distinct dedup keys as independent cache entries', async () => {
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.publishPendingFile.mockResolvedValue({ status: 'success' });
    registerMemoryHandlers({ ipcDedupService: createIpcDedupService() });
    const handler = handlers.get('memory:staging-publish')!;

    await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_B });
    expect(cosPendingMock.publishPendingFile).toHaveBeenCalledTimes(2);
  });

  it('re-runs the body after TTL expires', async () => {
    const clock = makeClock();
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.publishPendingFile.mockResolvedValue({ status: 'success' });
    registerMemoryHandlers({
      ipcDedupService: createIpcDedupService({ ttlMs: 1_000, now: clock.now }),
    });
    const handler = handlers.get('memory:staging-publish')!;

    await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    clock.advance(2_000);
    await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    expect(cosPendingMock.publishPendingFile).toHaveBeenCalledTimes(2);
  });

  it('does NOT poison the cache on handler-thrown exceptions — next retry re-runs', async () => {
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    // First call throws, second call succeeds. A well-behaved dedup
    // wrapper must NOT cache exceptions — callers need the chance to
    // recover on retry.
    cosPendingMock.publishPendingFile
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ status: 'success' });
    registerMemoryHandlers({ ipcDedupService: createIpcDedupService() });
    const handler = handlers.get('memory:staging-publish')!;

    await expect(
      handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A }),
    ).rejects.toThrow('transient');
    const second = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    expect(second).toEqual({ status: 'success' });
    expect(cosPendingMock.publishPendingFile).toHaveBeenCalledTimes(2);
  });

  it('caches returned error responses (same key + error → replayed error)', async () => {
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.publishPendingFile.mockResolvedValue({
      status: 'error',
      error: 'disk-full',
    });
    registerMemoryHandlers({ ipcDedupService: createIpcDedupService() });
    const handler = handlers.get('memory:staging-publish')!;

    const first = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    const second = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    expect(first).toEqual({ status: 'error', error: 'disk-full' });
    expect(second).toEqual({ status: 'error', error: 'disk-full' });
    // Body ran once; the error was cached and replayed. Retries of a
    // transient error with the SAME key within TTL don't retry the
    // underlying operation — callers that want to retry should
    // regenerate the dedup key.
    expect(cosPendingMock.publishPendingFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// memory:staging-discard
// ---------------------------------------------------------------------------

describe('memory:staging-discard — Stage C dedup', () => {
  beforeEach(() => {
    handlers.clear();
    cosPendingMock.getPendingFile.mockReset();
    cosPendingMock.deletePendingFile.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('replays the cached response on retry with the same dedup key', async () => {
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.deletePendingFile.mockResolvedValue({ status: 'success' });
    registerMemoryHandlers({ ipcDedupService: createIpcDedupService() });
    const handler = handlers.get('memory:staging-discard')!;

    const first = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    const second = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    expect(first).toEqual({ status: 'success' });
    expect(second).toEqual({ status: 'success' });
    expect(cosPendingMock.deletePendingFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// memory:staging-keep-private
// ---------------------------------------------------------------------------

describe('memory:staging-keep-private — Stage C dedup', () => {
  beforeEach(() => {
    handlers.clear();
    cosPendingMock.getPendingFile.mockReset();
    cosPendingMock.keepPendingFilePrivate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('replays the cached response on retry with the same dedup key', async () => {
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.keepPendingFilePrivate.mockResolvedValue({
      status: 'success',
      destinationPath: '/tmp/private.md',
    });
    registerMemoryHandlers({ ipcDedupService: createIpcDedupService() });
    const handler = handlers.get('memory:staging-keep-private')!;

    const first = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    const second = await handler(null, { id: 'stg_1', clientDedupKey: DEDUP_KEY_A });
    expect(first).toEqual({ status: 'success', destinationPath: '/tmp/private.md' });
    expect(second).toEqual({ status: 'success', destinationPath: '/tmp/private.md' });
    expect(cosPendingMock.keepPendingFilePrivate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// memory:staging-resolve-conflict — composes with Stage B capability token
// ---------------------------------------------------------------------------

describe('memory:staging-resolve-conflict — Stage C dedup × Stage B capability token', () => {
  beforeEach(() => {
    handlers.clear();
    cosPendingMock.getPendingFile.mockReset();
    cosPendingMock.publishWithConflictResolution.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('replays the cached response on retry and does NOT re-consume the token', async () => {
    // Simulate the "lost-response retry" scenario that Stage C fixes:
    // 1. First call runs, consumes the token nonce, returns success.
    // 2. `fetchWithRetry` re-dispatches the same payload (same token,
    //    same dedup key).
    // 3. Second call MUST return the cached success WITHOUT calling
    //    validate() again (which would flag the nonce as REUSED and
    //    surface a spurious error).
    const svc = makeCapabilityServiceStub();
    svc.validateMock.mockReturnValueOnce({
      ok: true,
      payload: { stagedFileId: 'stg_1', nonce: 'n1', exp: Date.now() + 60_000 },
    });
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.publishWithConflictResolution.mockResolvedValue({ status: 'success' });
    registerMemoryHandlers({
      conflictCapabilityService: svc,
      ipcDedupService: createIpcDedupService(),
    });
    const handler = handlers.get('memory:staging-resolve-conflict')!;

    const payload = {
      id: 'stg_1',
      resolution: 'keep-staged' as const,
      capabilityToken: 'tok.sig',
      clientDedupKey: DEDUP_KEY_A,
    };
    const first = await handler(null, payload);
    const second = await handler(null, payload);

    expect(first).toEqual({ status: 'success' });
    expect(second).toEqual({ status: 'success' });
    // validate() must only run on the first (cold-cache) call.
    expect(svc.validateMock).toHaveBeenCalledTimes(1);
    // Handler body must only run once.
    expect(cosPendingMock.publishWithConflictResolution).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache the CAPABILITY_MALFORMED short-circuit (it fires BEFORE the dedup wrapper)', async () => {
    // The short-circuits for empty token / empty id / invalid
    // resolution sit OUTSIDE the dedup wrapper so that nonsense inputs
    // never poison the cache. This test pins that design — with the
    // same dedup key and a missing token, the handler keeps returning
    // CAPABILITY_MALFORMED but MUST NOT replay a cached response.
    const svc = makeCapabilityServiceStub();
    registerMemoryHandlers({
      conflictCapabilityService: svc,
      ipcDedupService: createIpcDedupService(),
    });
    const handler = handlers.get('memory:staging-resolve-conflict')!;

    const payload = {
      id: 'stg_1',
      resolution: 'keep-staged' as const,
      capabilityToken: '',
      clientDedupKey: DEDUP_KEY_A,
    };
    const first = await handler(null, payload);
    const second = await handler(null, payload);
    expect(first).toEqual({ status: 'error', error: 'CAPABILITY_MALFORMED' });
    expect(second).toEqual({ status: 'error', error: 'CAPABILITY_MALFORMED' });
    // A subsequent call WITH a valid token (same dedup key) must still
    // run the body — the malformed short-circuit never populated the
    // cache.
    svc.validateMock.mockReturnValueOnce({
      ok: true,
      payload: { stagedFileId: 'stg_1', nonce: 'n1', exp: Date.now() + 60_000 },
    });
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.publishWithConflictResolution.mockResolvedValue({ status: 'success' });
    const third = await handler(null, { ...payload, capabilityToken: 'tok.sig' });
    expect(third).toEqual({ status: 'success' });
    expect(svc.validateMock).toHaveBeenCalledTimes(1);
    expect(cosPendingMock.publishWithConflictResolution).toHaveBeenCalledTimes(1);
  });

  it('fresh dedup key + reused token still surfaces CAPABILITY_REUSED (layers compose correctly)', async () => {
    // Security composition check: the dedup cache is keyed by
    // dedupKey, not by token. An attacker (or buggy caller) that
    // regenerates the dedup key but reuses the token gets a fresh
    // validate() call, which MUST flag the consumed nonce as REUSED.
    const svc = makeCapabilityServiceStub();
    svc.validateMock
      .mockReturnValueOnce({
        ok: true,
        payload: { stagedFileId: 'stg_1', nonce: 'n1', exp: Date.now() + 60_000 },
      })
      .mockReturnValueOnce({ ok: false, code: 'REUSED' });
    cosPendingMock.getPendingFile.mockResolvedValue(makePendingFile('stg_1'));
    cosPendingMock.publishWithConflictResolution.mockResolvedValue({ status: 'success' });
    registerMemoryHandlers({
      conflictCapabilityService: svc,
      ipcDedupService: createIpcDedupService(),
    });
    const handler = handlers.get('memory:staging-resolve-conflict')!;

    const first = await handler(null, {
      id: 'stg_1',
      resolution: 'keep-staged' as const,
      capabilityToken: 'tok.sig',
      clientDedupKey: DEDUP_KEY_A,
    });
    const second = await handler(null, {
      id: 'stg_1',
      resolution: 'keep-staged' as const,
      capabilityToken: 'tok.sig',
      clientDedupKey: DEDUP_KEY_B, // fresh dedup key
    });

    expect(first).toEqual({ status: 'success' });
    expect(second).toEqual({ status: 'error', error: 'CAPABILITY_REUSED' });
    expect(svc.validateMock).toHaveBeenCalledTimes(2);
    // Publish runs exactly once — the second call was blocked at the
    // capability-token gate.
    expect(cosPendingMock.publishWithConflictResolution).toHaveBeenCalledTimes(1);
  });
});
