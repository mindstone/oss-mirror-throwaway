/**
 * Stage B (260417_approval_consolidation_closeout) — handler-level tests
 * for the capability-token gate on `memory:staging-resolve-conflict` and
 * the new `memory:staging-mint-conflict-capability` endpoint.
 *
 * Follows the pattern of `safetyPromptHandlers.broadcast.test.ts` —
 * `vi.mock`s the handler's collaborators, then invokes the registered
 * handler function directly via a capturing `registerHandler` mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// ---------------------------------------------------------------------------
// memory:staging-mint-conflict-capability
// ---------------------------------------------------------------------------

describe('memory:staging-mint-conflict-capability', () => {
  beforeEach(() => {
    handlers.clear();
    cosPendingMock.getPendingFile.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns UNKNOWN_STAGED_FILE for an empty staged file id', async () => {
    const svc = makeCapabilityServiceStub();
    registerMemoryHandlers({ conflictCapabilityService: svc });
    const handler = handlers.get('memory:staging-mint-conflict-capability')!;
    expect(handler).toBeDefined();

    const result = await handler(null, { stagedFileId: '' });
    expect(result).toEqual({ success: false, error: 'UNKNOWN_STAGED_FILE' });
    expect(svc.mintMock).not.toHaveBeenCalled();
  });

  it('returns UNKNOWN_STAGED_FILE when the pending file does not exist', async () => {
    cosPendingMock.getPendingFile.mockResolvedValueOnce(null);
    const svc = makeCapabilityServiceStub();
    registerMemoryHandlers({ conflictCapabilityService: svc });
    const handler = handlers.get('memory:staging-mint-conflict-capability')!;

    const result = await handler(null, { stagedFileId: 'stg_ghost' });
    expect(result).toEqual({ success: false, error: 'UNKNOWN_STAGED_FILE' });
    expect(svc.mintMock).not.toHaveBeenCalled();
  });

  it('returns SERVICE_UNAVAILABLE when the service is not wired into handlers', async () => {
    registerMemoryHandlers({});
    const handler = handlers.get('memory:staging-mint-conflict-capability')!;
    expect(handler).toBeDefined();

    const result = await handler(null, { stagedFileId: 'stg_xyz' });
    // R2 F-B-R2-2: the unwired-service path is an operational bug,
    // separate from the reserved product-level READ_ONLY code.
    expect(result).toEqual({ success: false, error: 'SERVICE_UNAVAILABLE' });
  });

  it('mints a token and returns { success: true, token, expiresAt } on the happy path', async () => {
    cosPendingMock.getPendingFile.mockResolvedValueOnce(makePendingFile('stg_ok'));
    const svc = makeCapabilityServiceStub();
    svc.mintMock.mockReturnValue({ token: 'tok.sig', expiresAt: 42 });
    registerMemoryHandlers({ conflictCapabilityService: svc });
    const handler = handlers.get('memory:staging-mint-conflict-capability')!;

    const result = await handler(null, { stagedFileId: 'stg_ok' });
    expect(result).toEqual({ success: true, token: 'tok.sig', expiresAt: 42 });
    expect(svc.mintMock).toHaveBeenCalledWith({ stagedFileId: 'stg_ok' });
  });

  // R2 F-B-R2-3: the Zod schema already caps id at 256 chars, so a
  // RangeError from mint() means the id slipped past schema validation.
  // Handler should surface INVALID_INPUT rather than masking as
  // UNKNOWN_STAGED_FILE.
  it('returns INVALID_INPUT when mint() throws RangeError (defense-in-depth)', async () => {
    cosPendingMock.getPendingFile.mockResolvedValueOnce(makePendingFile('stg_bad'));
    const svc = makeCapabilityServiceStub();
    svc.mintMock.mockImplementation(() => {
      throw new RangeError('stagedFileId exceeds max length');
    });
    registerMemoryHandlers({ conflictCapabilityService: svc });
    const handler = handlers.get('memory:staging-mint-conflict-capability')!;

    const result = await handler(null, { stagedFileId: 'stg_bad' });
    expect(result).toEqual({ success: false, error: 'INVALID_INPUT' });
  });
});

// ---------------------------------------------------------------------------
// memory:staging-resolve-conflict — capability-token gate
// ---------------------------------------------------------------------------

describe('memory:staging-resolve-conflict — capability-token gate', () => {
  beforeEach(() => {
    handlers.clear();
    cosPendingMock.getPendingFile.mockReset();
    cosPendingMock.publishWithConflictResolution.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with CAPABILITY_MALFORMED when capabilityToken is an empty string', async () => {
    const svc = makeCapabilityServiceStub();
    registerMemoryHandlers({ conflictCapabilityService: svc });
    const handler = handlers.get('memory:staging-resolve-conflict')!;

    const result = await handler(null, {
      id: 'stg_1',
      resolution: 'keep-staged',
      capabilityToken: '',
    });
    expect(result).toEqual({ status: 'error', error: 'CAPABILITY_MALFORMED' });
    // Fail-closed: never call validate, never call publish.
    expect(svc.validateMock).not.toHaveBeenCalled();
    expect(cosPendingMock.publishWithConflictResolution).not.toHaveBeenCalled();
  });

  it('rejects with CAPABILITY_UNAVAILABLE when no service is wired', async () => {
    registerMemoryHandlers({});
    const handler = handlers.get('memory:staging-resolve-conflict')!;

    const result = await handler(null, {
      id: 'stg_1',
      resolution: 'keep-staged',
      capabilityToken: 'tok.sig',
    });
    expect(result).toEqual({ status: 'error', error: 'CAPABILITY_UNAVAILABLE' });
    expect(cosPendingMock.publishWithConflictResolution).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_SIGNATURE'],
    ['EXPIRED'],
    ['SCOPE_MISMATCH'],
    ['REUSED'],
    ['MALFORMED'],
  ] as const)(
    'surfaces CAPABILITY_%s when the service rejects the token',
    async (code) => {
      const svc = makeCapabilityServiceStub();
      svc.validateMock.mockReturnValue({ ok: false, code });
      registerMemoryHandlers({ conflictCapabilityService: svc });
      const handler = handlers.get('memory:staging-resolve-conflict')!;

      const result = await handler(null, {
        id: 'stg_1',
        resolution: 'keep-real',
        capabilityToken: 'tok.sig',
      });
      expect(result).toEqual({ status: 'error', error: `CAPABILITY_${code}` });
      expect(cosPendingMock.publishWithConflictResolution).not.toHaveBeenCalled();
    },
  );

  it('forwards to publishWithConflictResolution with the mapped resolution when validation passes', async () => {
    const svc = makeCapabilityServiceStub();
    svc.validateMock.mockReturnValue({
      ok: true,
      payload: { stagedFileId: 'stg_1', nonce: 'abcd', exp: Date.now() + 60_000 },
    });
    cosPendingMock.getPendingFile.mockResolvedValueOnce(makePendingFile('stg_1'));
    cosPendingMock.publishWithConflictResolution.mockResolvedValueOnce({ status: 'success' });
    registerMemoryHandlers({ conflictCapabilityService: svc });
    const handler = handlers.get('memory:staging-resolve-conflict')!;

    const result = await handler(null, {
      id: 'stg_1',
      resolution: 'keep-staged',
      capabilityToken: 'tok.sig',
    });
    expect(result).toEqual({ status: 'success' });
    expect(svc.validateMock).toHaveBeenCalledWith({ token: 'tok.sig', stagedFileId: 'stg_1' });
    expect(cosPendingMock.publishWithConflictResolution).toHaveBeenCalledWith('stg_1', 'keep-pending');
  });

  it('maps keep-real to keep-current for the pending service', async () => {
    const svc = makeCapabilityServiceStub();
    svc.validateMock.mockReturnValue({
      ok: true,
      payload: { stagedFileId: 'stg_2', nonce: 'dcba', exp: Date.now() + 60_000 },
    });
    cosPendingMock.getPendingFile.mockResolvedValueOnce(makePendingFile('stg_2'));
    cosPendingMock.publishWithConflictResolution.mockResolvedValueOnce({ status: 'success' });
    registerMemoryHandlers({ conflictCapabilityService: svc });
    const handler = handlers.get('memory:staging-resolve-conflict')!;

    await handler(null, {
      id: 'stg_2',
      resolution: 'keep-real',
      capabilityToken: 'tok.sig',
    });
    expect(cosPendingMock.publishWithConflictResolution).toHaveBeenCalledWith('stg_2', 'keep-current');
  });

  it('returns the invalid-resolution error WITHOUT consuming the token', async () => {
    const svc = makeCapabilityServiceStub();
    registerMemoryHandlers({ conflictCapabilityService: svc });
    const handler = handlers.get('memory:staging-resolve-conflict')!;

    // Intentionally pass an unsupported resolution value.
    const result = await handler(null, {
      id: 'stg_1',
      resolution: 'merge',
      capabilityToken: 'tok.sig',
    });
    expect(result).toEqual({ status: 'error', error: 'Invalid resolution' });
    // Token must NOT be consumed when the resolution is invalid — the
    // user should be able to retry without re-minting.
    expect(svc.validateMock).not.toHaveBeenCalled();
  });
});
