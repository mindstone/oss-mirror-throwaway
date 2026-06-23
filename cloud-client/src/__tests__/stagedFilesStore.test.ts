/**
 * stagedFilesStore tests
 *
 * Covers:
 * - fetchStagedFiles success / failure
 * - Idempotent-status handling (FM #26): `success`, `already-resolved`, and
 *   `not-found` all remove the row and do not surface an error.
 * - publishFile / discardFile / keepPrivate / resolveConflict error pass-through
 * - resetStore and refresh flows
 */

import { useStagedFilesStore } from '../stores/stagedFilesStore';
import type { StagedFile } from '../types';

vi.mock('../cloudClient', async () => {
  const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
  return {
    ...actual,
    ipcCall: vi.fn(),
  };
});

import * as cloudClient from '../cloudClient';
const mockedIpcCall = vi.mocked(cloudClient.ipcCall);

// Stage C (260417_approval_consolidation_closeout): v4 UUID matcher
// used to assert every staging IPC carries a `clientDedupKey`. Match
// the canonical lowercase v4 shape so it stays in lockstep with the
// Zod `z.string().uuid()` validator on the server schema.
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function buildFile(overrides: Partial<StagedFile> = {}): StagedFile {
  return {
    id: 'file-1',
    realPath: '/workspace/memory/note.md',
    spaceName: 'Memory',
    spacePath: 'memory/note.md',
    sessionId: 'session-a',
    baseHash: 'hash-1',
    summary: 'Summary',
    stagedAt: 100,
    sensitivity: 'high',
    ...overrides,
  };
}

beforeEach(() => {
  useStagedFilesStore.setState({
    files: [],
    isLoading: false,
    error: null,
  });
  mockedIpcCall.mockClear();
});

describe('stagedFilesStore', () => {
  describe('fetchStagedFiles', () => {
    it('loads files successfully', async () => {
      mockedIpcCall.mockResolvedValueOnce({ files: [buildFile({ id: 'a' })] });
      await useStagedFilesStore.getState().fetchStagedFiles();
      const state = useStagedFilesStore.getState();
      expect(state.files).toHaveLength(1);
      expect(state.files[0].id).toBe('a');
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('handles non-array result by defaulting to []', async () => {
      mockedIpcCall.mockResolvedValueOnce({ files: null });
      await useStagedFilesStore.getState().fetchStagedFiles();
      expect(useStagedFilesStore.getState().files).toEqual([]);
    });

    it('records an error message when ipcCall rejects', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('boom'));
      await useStagedFilesStore.getState().fetchStagedFiles();
      expect(useStagedFilesStore.getState().error).toBe('boom');
    });
  });

  describe('publishFile', () => {
    beforeEach(() => {
      useStagedFilesStore.setState({ files: [buildFile({ id: 'a' })], isLoading: false, error: null });
    });

    it('removes file on status=success', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'success' });
      const result = await useStagedFilesStore.getState().publishFile('a');
      expect(result.status).toBe('success');
      expect(useStagedFilesStore.getState().files).toEqual([]);
      expect(useStagedFilesStore.getState().error).toBeNull();
    });

    it('idempotent-success: status=already-resolved removes file', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'already-resolved' });
      const result = await useStagedFilesStore.getState().publishFile('a');
      expect(result.status).toBe('already-resolved');
      expect(useStagedFilesStore.getState().files).toEqual([]);
      expect(useStagedFilesStore.getState().error).toBeNull();
    });

    it('idempotent-success: status=not-found removes file (FM #26)', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'not-found' });
      const result = await useStagedFilesStore.getState().publishFile('a');
      expect(result.status).toBe('not-found');
      expect(useStagedFilesStore.getState().files).toEqual([]);
      expect(useStagedFilesStore.getState().error).toBeNull();
    });

    it('records error for non-success status with error payload', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'error', error: 'oops' });
      await useStagedFilesStore.getState().publishFile('a');
      expect(useStagedFilesStore.getState().error).toBe('oops');
    });

    it('passes through conflict result', async () => {
      const conflict = { realContent: 'real', stagedContent: 'staged' };
      mockedIpcCall.mockResolvedValueOnce({ status: 'conflict', conflict });
      const result = await useStagedFilesStore.getState().publishFile('a');
      expect(result.status).toBe('conflict');
      expect(result.conflict).toEqual(conflict);
      // File is not removed on conflict.
      expect(useStagedFilesStore.getState().files).toHaveLength(1);
    });

    // F3-5e: non-idempotent error-branch (rejection) coverage.
    it('returns error payload when ipcCall rejects', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('net-down'));
      const result = await useStagedFilesStore.getState().publishFile('a');
      expect(result.status).toBe('error');
      expect(result.error).toBe('net-down');
      expect(useStagedFilesStore.getState().error).toBe('net-down');
    });
  });

  describe('discardFile', () => {
    beforeEach(() => {
      useStagedFilesStore.setState({ files: [buildFile({ id: 'a' })], isLoading: false, error: null });
    });

    it('removes file on status=success', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'success' });
      const result = await useStagedFilesStore.getState().discardFile('a');
      expect(result.status).toBe('success');
      expect(useStagedFilesStore.getState().files).toEqual([]);
    });

    it('idempotent-success: status=already-resolved removes file', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'already-resolved' });
      const result = await useStagedFilesStore.getState().discardFile('a');
      expect(result.status).toBe('already-resolved');
      expect(useStagedFilesStore.getState().files).toEqual([]);
    });

    it('idempotent-success: status=not-found removes file', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'not-found' });
      await useStagedFilesStore.getState().discardFile('a');
      expect(useStagedFilesStore.getState().files).toEqual([]);
    });

    it('records error for non-terminal status with error', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'error', error: 'nope' });
      await useStagedFilesStore.getState().discardFile('a');
      expect(useStagedFilesStore.getState().error).toBe('nope');
    });

    // F3-5e: non-idempotent error-branch (rejection) coverage.
    it('returns error payload when ipcCall rejects', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('rejected'));
      const result = await useStagedFilesStore.getState().discardFile('a');
      expect(result.status).toBe('error');
      expect(result.error).toBe('rejected');
      expect(useStagedFilesStore.getState().error).toBe('rejected');
    });
  });

  describe('keepPrivate', () => {
    beforeEach(() => {
      useStagedFilesStore.setState({ files: [buildFile({ id: 'a' })], isLoading: false, error: null });
    });

    it('removes file on status=success', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'success' });
      const result = await useStagedFilesStore.getState().keepPrivate('a');
      expect(result.status).toBe('success');
      expect(useStagedFilesStore.getState().files).toEqual([]);
    });

    it('idempotent-success: status=already-resolved removes file (FM #26)', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'already-resolved' });
      const result = await useStagedFilesStore.getState().keepPrivate('a');
      expect(result.status).toBe('already-resolved');
      expect(useStagedFilesStore.getState().files).toEqual([]);
      expect(useStagedFilesStore.getState().error).toBeNull();
    });

    it('idempotent-success: status=not-found removes file', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'not-found' });
      await useStagedFilesStore.getState().keepPrivate('a');
      expect(useStagedFilesStore.getState().files).toEqual([]);
    });

    // F3-5e: non-idempotent error-branch (rejection) coverage.
    it('returns error payload when ipcCall rejects', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('kp-fail'));
      const result = await useStagedFilesStore.getState().keepPrivate('a');
      expect(result.status).toBe('error');
      expect(result.error).toBe('kp-fail');
      expect(useStagedFilesStore.getState().error).toBe('kp-fail');
    });
  });

  describe('resolveConflict', () => {
    // Stage B (260417_approval_consolidation_closeout): every resolve
    // call now requires a capability token. Tests use a well-shaped
    // mock so they exercise the real call-signature invariants.
    const MOCK_TOKEN = 'test.capability.token';

    beforeEach(() => {
      useStagedFilesStore.setState({ files: [buildFile({ id: 'a' })], isLoading: false, error: null });
    });

    it('removes file on status=success for keep-staged', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'success' });
      const result = await useStagedFilesStore.getState().resolveConflict('a', 'keep-staged', MOCK_TOKEN);
      expect(result.status).toBe('success');
      expect(useStagedFilesStore.getState().files).toEqual([]);
      // Stage C: `clientDedupKey` is a generated v4 UUID; match shape
      // rather than a fixed value so tests stay deterministic.
      expect(mockedIpcCall).toHaveBeenCalledWith('memory:staging-resolve-conflict', {
        id: 'a',
        resolution: 'keep-staged',
        capabilityToken: MOCK_TOKEN,
        clientDedupKey: expect.stringMatching(UUID_V4),
      });
    });

    it('idempotent-success: status=already-resolved removes file (FM #26)', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'already-resolved' });
      const result = await useStagedFilesStore.getState().resolveConflict('a', 'keep-real', MOCK_TOKEN);
      expect(result.status).toBe('already-resolved');
      expect(useStagedFilesStore.getState().files).toEqual([]);
      expect(useStagedFilesStore.getState().error).toBeNull();
    });

    it('idempotent-success: status=not-found removes file (FM #26)', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'not-found' });
      const result = await useStagedFilesStore.getState().resolveConflict('a', 'keep-real', MOCK_TOKEN);
      expect(result.status).toBe('not-found');
      expect(useStagedFilesStore.getState().files).toEqual([]);
      expect(useStagedFilesStore.getState().error).toBeNull();
    });

    it('records error on non-terminal status with error', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'error', error: 'backend-down' });
      await useStagedFilesStore.getState().resolveConflict('a', 'keep-real', MOCK_TOKEN);
      expect(useStagedFilesStore.getState().error).toBe('backend-down');
      // File remains because the call did not reach a terminal state.
      expect(useStagedFilesStore.getState().files).toHaveLength(1);
    });

    it('returns error payload when ipcCall rejects', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('network-fail'));
      const result = await useStagedFilesStore.getState().resolveConflict('a', 'keep-staged', MOCK_TOKEN);
      expect(result.status).toBe('error');
      expect(result.error).toBe('network-fail');
      expect(useStagedFilesStore.getState().error).toBe('network-fail');
    });

    // Stage B: explicit guard for empty / missing tokens.
    it('short-circuits with error when capabilityToken is an empty string (no IPC call)', async () => {
      const result = await useStagedFilesStore.getState().resolveConflict('a', 'keep-real', '');
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/missing capability token/i);
      expect(mockedIpcCall).not.toHaveBeenCalled();
      // Error is recorded so the UI can surface it.
      expect(useStagedFilesStore.getState().error).toMatch(/missing capability token/i);
    });

    // F-B-R2-7: when the first resolve succeeded on the server but the
    // response was lost and fetchWithRetry re-dispatched the call, the
    // retry consumes its own nonce-slot and lands as CAPABILITY_REUSED.
    // Treat that as idempotent success — the staged file is already
    // resolved; no user-visible error.
    it('treats CAPABILITY_REUSED as idempotent success (retry-after-success path)', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'error', error: 'CAPABILITY_REUSED' });
      const result = await useStagedFilesStore
        .getState()
        .resolveConflict('a', 'keep-staged', MOCK_TOKEN);
      // Status is normalized to 'already-resolved' so callers branching
      // on isIdempotentSuccess handle it uniformly.
      expect(result.status).toBe('already-resolved');
      // File removed, error NOT surfaced.
      expect(useStagedFilesStore.getState().files).toEqual([]);
      expect(useStagedFilesStore.getState().error).toBeNull();
    });

    // Other CAPABILITY_* codes must still surface as errors — only
    // REUSED maps to idempotent success.
    it.each([
      'CAPABILITY_EXPIRED',
      'CAPABILITY_SCOPE_MISMATCH',
      'CAPABILITY_INVALID_SIGNATURE',
      'CAPABILITY_MALFORMED',
      'CAPABILITY_UNAVAILABLE',
    ])('surfaces %s as a user-visible error (NOT idempotent)', async (code) => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'error', error: code });
      const result = await useStagedFilesStore
        .getState()
        .resolveConflict('a', 'keep-staged', MOCK_TOKEN);
      expect(result.error).toBe(code);
      // File remains — the action did NOT reach a terminal state.
      expect(useStagedFilesStore.getState().files).toHaveLength(1);
      expect(useStagedFilesStore.getState().error).toBe(code);
    });
  });

  // ---------------------------------------------------------------------
  // Stage C (260417_approval_consolidation_closeout) — `clientDedupKey`
  //
  // Every staging mutation MUST carry a per-action v4 UUID so the
  // server-side `ipcDedupService` can replay the first response if
  // `fetchWithRetry` re-dispatches a lost-response POST. The UUID must
  // be generated OUTSIDE the retry loop, which in this store means
  // "once per action call" — these tests assert exactly that.
  // ---------------------------------------------------------------------
  describe('Stage C — clientDedupKey', () => {
    beforeEach(() => {
      useStagedFilesStore.setState({ files: [buildFile({ id: 'a' })], isLoading: false, error: null });
    });

    it.each([
      ['publishFile', 'memory:staging-publish'] as const,
      ['discardFile', 'memory:staging-discard'] as const,
      ['keepPrivate', 'memory:staging-keep-private'] as const,
    ])(
      '%s attaches a well-shaped v4 UUID clientDedupKey',
      async (action, channel) => {
        mockedIpcCall.mockResolvedValueOnce({ status: 'success' });
        await useStagedFilesStore.getState()[action]('a');
        expect(mockedIpcCall).toHaveBeenCalledTimes(1);
        const [callChannel, payload] = mockedIpcCall.mock.calls[0] as [
          string,
          { id: string; clientDedupKey?: string },
        ];
        expect(callChannel).toBe(channel);
        expect(payload.id).toBe('a');
        expect(payload.clientDedupKey).toEqual(expect.stringMatching(UUID_V4));
      },
    );

    it('generates a fresh UUID per action (two sequential publish calls get distinct keys)', async () => {
      mockedIpcCall.mockResolvedValue({ status: 'success' });
      await useStagedFilesStore.getState().publishFile('a');
      useStagedFilesStore.setState({ files: [buildFile({ id: 'b' })], error: null });
      await useStagedFilesStore.getState().publishFile('b');
      expect(mockedIpcCall).toHaveBeenCalledTimes(2);
      const firstKey = (mockedIpcCall.mock.calls[0][1] as { clientDedupKey?: string })
        .clientDedupKey;
      const secondKey = (mockedIpcCall.mock.calls[1][1] as { clientDedupKey?: string })
        .clientDedupKey;
      expect(firstKey).toEqual(expect.stringMatching(UUID_V4));
      expect(secondKey).toEqual(expect.stringMatching(UUID_V4));
      expect(firstKey).not.toBe(secondKey);
    });

    it('resolveConflict attaches a v4 UUID distinct from the capability token', async () => {
      mockedIpcCall.mockResolvedValueOnce({ status: 'success' });
      await useStagedFilesStore
        .getState()
        .resolveConflict('a', 'keep-staged', 'test.capability.token');
      expect(mockedIpcCall).toHaveBeenCalledTimes(1);
      const [, payload] = mockedIpcCall.mock.calls[0] as [
        string,
        { capabilityToken: string; clientDedupKey?: string },
      ];
      expect(payload.capabilityToken).toBe('test.capability.token');
      expect(payload.clientDedupKey).toEqual(expect.stringMatching(UUID_V4));
      expect(payload.clientDedupKey).not.toBe(payload.capabilityToken);
    });
  });

  describe('mintConflictCapability', () => {
    it('returns the server-issued token on success', async () => {
      mockedIpcCall.mockResolvedValueOnce({
        success: true,
        token: 'eyJhIjoxfQ.sig',
        expiresAt: 1234567890,
      });
      const result = await useStagedFilesStore.getState().mintConflictCapability('stg_abc');
      expect(result).toEqual({ success: true, token: 'eyJhIjoxfQ.sig', expiresAt: 1234567890 });
      expect(mockedIpcCall).toHaveBeenCalledWith(
        'memory:staging-mint-conflict-capability',
        { stagedFileId: 'stg_abc' },
      );
    });

    it('surfaces the typed server error (UNKNOWN_STAGED_FILE)', async () => {
      mockedIpcCall.mockResolvedValueOnce({ success: false, error: 'UNKNOWN_STAGED_FILE' });
      const result = await useStagedFilesStore.getState().mintConflictCapability('stg_nope');
      expect(result).toEqual({ success: false, error: 'UNKNOWN_STAGED_FILE' });
    });

    it('returns success:false with a message when the IPC call rejects', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('network-down'));
      const result = await useStagedFilesStore.getState().mintConflictCapability('stg_abc');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('network-down');
      }
    });
  });

  describe('resetStore', () => {
    it('clears files, loading, and error', () => {
      useStagedFilesStore.setState({
        files: [buildFile()],
        isLoading: true,
        error: 'something',
      });
      useStagedFilesStore.getState().resetStore();
      const state = useStagedFilesStore.getState();
      expect(state.files).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });
  });
});
