// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@renderer/test-utils';
import { useDraftPersistence, migrateLocalStorageDrafts } from '../useDraftPersistence';
import { _resetSanitisationStateForTests } from '@renderer/features/composer/utils/draftSanitisationState';
import { sanitiseCorruptedDraftText } from '@renderer/features/composer/utils/draftSanitisation';

const STORAGE_KEY_PREFIX = 'draft:';
const SANITISATION_BACKUP_PREFIX = 'draft-sanitisation-backup:';
const DRAFT_EXPIRY_MS = 24 * 60 * 60 * 1000;

const mockSetDraftForSession = vi.fn();

type UpsertResult =
  | { ok: true }
  | { ok: false; reason: 'concurrent_write' | 'persist_failure' | 'timeout' };

const mockUpsertDraftDurable = vi.fn<
  (sessionId: string, text: string, expectedCurrent?: string) => Promise<UpsertResult>
>();

const mockState: {
  currentSessionId: string;
  draftsBySessionId: Record<string, { text: string; updatedAt: number }>;
  loadedSessions: Map<string, { draft?: { updatedAt: number } }>;
  sessionSummaries: { id: string }[];
  setDraftForSession: typeof mockSetDraftForSession;
  upsertDraftDurable: typeof mockUpsertDraftDurable;
} = {
  currentSessionId: 'current-session',
  draftsBySessionId: {},
  loadedSessions: new Map(),
  sessionSummaries: [{ id: 'session-1' }, { id: 'session-2' }],
  setDraftForSession: mockSetDraftForSession,
  upsertDraftDurable: mockUpsertDraftDurable,
};

vi.mock('@renderer/features/agent-session/store', () => ({
  getSessionStoreState: () => mockState,
}));

function setDraft(sessionId: string, text: string, timestamp?: number): void {
  localStorage.setItem(
    `${STORAGE_KEY_PREFIX}${sessionId}`,
    JSON.stringify({ text, timestamp: timestamp ?? Date.now() }),
  );
}

describe('useDraftPersistence', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('draft restoration on session load', () => {
    it('restores draft from localStorage when switching sessions', () => {
      setDraft('session-A', 'saved draft text');
      const setTextPrompt = vi.fn();

      const { unmount } = renderHook(() =>
        useDraftPersistence('session-A', '', setTextPrompt),
      );

      expect(setTextPrompt).toHaveBeenCalledWith('saved draft text');
      unmount();
    });

    it('restores legacy localStorage draft sanitised — &nbsp; entries do not reach setTextPrompt raw', () => {
      const corrupted = 'hello&nbsp;world\n\n&nbsp;\n\nfoo&nbsp;bar';
      setDraft('session-A', corrupted);
      const setTextPrompt = vi.fn();

      const { unmount } = renderHook(() =>
        useDraftPersistence('session-A', '', setTextPrompt),
      );

      expect(setTextPrompt).toHaveBeenCalledTimes(1);
      const restoredArg = setTextPrompt.mock.calls[0][0];
      expect(restoredArg).not.toContain('&nbsp;');
      expect(restoredArg).toBe(sanitiseCorruptedDraftText(corrupted));
      unmount();
    });

    it('does not restore expired drafts', () => {
      const expired = Date.now() - DRAFT_EXPIRY_MS - 1000;
      setDraft('session-A', 'old draft', expired);
      const setTextPrompt = vi.fn();

      const { unmount } = renderHook(() =>
        useDraftPersistence('session-A', '', setTextPrompt),
      );

      expect(setTextPrompt).not.toHaveBeenCalled();
      expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-A`)).toBeNull();
      unmount();
    });

    it('does not restore empty or whitespace-only drafts', () => {
      setDraft('session-A', '   ');
      const setTextPrompt = vi.fn();

      const { unmount } = renderHook(() =>
        useDraftPersistence('session-A', '', setTextPrompt),
      );

      expect(setTextPrompt).not.toHaveBeenCalled();
      unmount();
    });

    it('handles corrupted localStorage data gracefully', () => {
      localStorage.setItem(`${STORAGE_KEY_PREFIX}session-A`, 'not-json');
      const setTextPrompt = vi.fn();

      const { unmount } = renderHook(() =>
        useDraftPersistence('session-A', '', setTextPrompt),
      );

      expect(setTextPrompt).not.toHaveBeenCalled();
      expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-A`)).toBeNull();
      unmount();
    });

    it('does nothing when no draft exists for session', () => {
      const setTextPrompt = vi.fn();

      const { unmount } = renderHook(() =>
        useDraftPersistence('session-X', '', setTextPrompt),
      );

      expect(setTextPrompt).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('clearDraft', () => {
    it('removes draft from localStorage', () => {
      setDraft('session-A', 'will be cleared');
      const setTextPrompt = vi.fn();

      const { result, unmount } = renderHook(() =>
        useDraftPersistence('session-A', '', setTextPrompt),
      );

      act(() => {
        result.current.clearDraft();
      });

      expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-A`)).toBeNull();
      unmount();
    });

    it('is stable across rerenders (same session)', () => {
      const setTextPrompt = vi.fn();

      const { result, rerender, unmount } = renderHook(
        ({ sid }: { sid: string }) => useDraftPersistence(sid, '', setTextPrompt),
        { initialProps: { sid: 'session-A' } },
      );

      const first = result.current.clearDraft;
      rerender({ sid: 'session-A' });
      const second = result.current.clearDraft;

      expect(first).toBe(second);
      unmount();
    });
  });
});

describe('migrateLocalStorageDrafts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    _resetSanitisationStateForTests();
    mockState.draftsBySessionId = {};
    mockState.loadedSessions = new Map();
    mockState.sessionSummaries = [{ id: 'session-1' }, { id: 'session-2' }];
    mockState.currentSessionId = 'current-session';
    // Default: durable upsert resolves ok.
    mockUpsertDraftDurable.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('migrates valid drafts via upsertDraftDurable and removes localStorage on { ok: true }', async () => {
    setDraft('session-1', 'draft one');

    const result = await migrateLocalStorageDrafts();

    expect(result.migratedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.concurrentWriteCount).toBe(0);
    expect(mockUpsertDraftDurable).toHaveBeenCalledWith('session-1', 'draft one', '');
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-1`)).toBeNull();
  });

  it('skips drafts already migrated to store (idempotent)', async () => {
    const now = Date.now();
    setDraft('session-1', 'old draft', now - 1000);
    mockState.draftsBySessionId = { 'session-1': { text: 'old draft', updatedAt: now } };

    const result = await migrateLocalStorageDrafts();

    expect(result.migratedCount).toBe(0);
    expect(mockUpsertDraftDurable).not.toHaveBeenCalled();
  });

  it('skips expired drafts and removes them', async () => {
    const expired = Date.now() - DRAFT_EXPIRY_MS - 1;
    setDraft('session-1', 'expired', expired);

    const result = await migrateLocalStorageDrafts();

    expect(result.migratedCount).toBe(0);
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-1`)).toBeNull();
  });

  it('skips empty drafts and removes them', async () => {
    setDraft('session-1', '   ');

    const result = await migrateLocalStorageDrafts();

    expect(result.migratedCount).toBe(0);
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-1`)).toBeNull();
  });

  it('does not migrate drafts for non-existent sessions (orphans preserved)', async () => {
    setDraft('unknown-session', 'orphan draft');

    const result = await migrateLocalStorageDrafts();

    expect(result.migratedCount).toBe(0);
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}unknown-session`)).not.toBeNull();
  });

  it('migrates draft for current session', async () => {
    setDraft('current-session', 'current draft');

    const result = await migrateLocalStorageDrafts();

    expect(result.migratedCount).toBe(1);
    expect(mockUpsertDraftDurable).toHaveBeenCalledWith('current-session', 'current draft', '');
  });

  it('handles corrupted localStorage entries without crashing', async () => {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}session-1`, 'not-json');

    const result = await migrateLocalStorageDrafts();

    expect(result.migratedCount).toBe(0);
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-1`)).toBeNull();
  });

  it('migrates multiple valid drafts in one pass', async () => {
    setDraft('session-1', 'draft one');
    setDraft('session-2', 'draft two');

    const result = await migrateLocalStorageDrafts();

    expect(result.migratedCount).toBe(2);
    expect(mockUpsertDraftDurable).toHaveBeenCalledTimes(2);
  });

  it('prefers newer localStorage draft over stale store draft', async () => {
    const now = Date.now();
    setDraft('session-1', 'newer local', now);
    mockState.draftsBySessionId = { 'session-1': { text: 'older', updatedAt: now - 5000 } };

    const result = await migrateLocalStorageDrafts();

    expect(result.migratedCount).toBe(1);
    expect(mockUpsertDraftDurable).toHaveBeenCalledWith('session-1', 'newer local', 'older');
  });

  describe('sanitisation + persistence (Stage 6)', () => {
    it('sanitises NBSP-corrupted localStorage drafts and durably persists the cleaned form via upsertDraftDurable', async () => {
      const corrupted = 'hello\n\n&nbsp;\n\nworld';
      const cleaned = 'hello\n\n\n\nworld';
      setDraft('session-1', corrupted);

      const result = await migrateLocalStorageDrafts();

      expect(result.migratedCount).toBe(1);
      expect(mockUpsertDraftDurable).toHaveBeenCalledTimes(1);
      expect(mockUpsertDraftDurable).toHaveBeenCalledWith('session-1', cleaned, '');
    });

    it('writes a backup with TTL metadata before sanitising', async () => {
      const corrupted = 'foo&nbsp;bar';
      setDraft('session-1', corrupted);

      await migrateLocalStorageDrafts();

      const backupRaw = localStorage.getItem(`${SANITISATION_BACKUP_PREFIX}session-1`);
      expect(backupRaw).not.toBeNull();
      const backup = JSON.parse(backupRaw!);
      expect(backup.text).toBe(corrupted);
      expect(typeof backup.timestamp).toBe('number');
      expect(typeof backup.ttl).toBe('number');
      expect(backup.ttl).toBeGreaterThan(0);
    });

    it('only deletes localStorage original on { ok: true }', async () => {
      mockUpsertDraftDurable.mockResolvedValueOnce({ ok: true });
      setDraft('session-1', 'draft one');

      await migrateLocalStorageDrafts();

      expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-1`)).toBeNull();
    });

    it('retains localStorage original on { ok: false, reason: "persist_failure" }', async () => {
      mockUpsertDraftDurable.mockResolvedValueOnce({ ok: false, reason: 'persist_failure' });
      setDraft('session-1', 'draft one');

      const result = await migrateLocalStorageDrafts();

      expect(result.failedCount).toBe(1);
      expect(result.migratedCount).toBe(0);
      expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-1`)).not.toBeNull();
    });

    it('retains localStorage original on { ok: false, reason: "concurrent_write" } and counts the deferral', async () => {
      mockUpsertDraftDurable.mockResolvedValueOnce({ ok: false, reason: 'concurrent_write' });
      setDraft('session-1', 'draft one');
      mockState.draftsBySessionId = {
        'session-1': { text: 'user-typed-this', updatedAt: 1 },
      };

      const result = await migrateLocalStorageDrafts();

      expect(result.concurrentWriteCount).toBe(1);
      expect(result.migratedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      // localStorage original retained for next-reload retry.
      expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}session-1`)).not.toBeNull();
    });

    it('passes the read-time store text as expectedCurrent for the CAS check', async () => {
      const now = Date.now();
      setDraft('session-1', 'newer local', now);
      mockState.draftsBySessionId = {
        'session-1': { text: 'snapshot-at-read-time', updatedAt: now - 5000 },
      };

      await migrateLocalStorageDrafts();

      expect(mockUpsertDraftDurable).toHaveBeenCalledWith(
        'session-1',
        'newer local',
        'snapshot-at-read-time',
      );
    });

    it('rate-limits the boundary log via wasSessionSanitised across two migration passes', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const corrupted = 'foo&nbsp;bar';

      setDraft('session-1', corrupted);
      await migrateLocalStorageDrafts();

      // Re-introduce a corrupted draft and run again; the boundary log
      // should NOT fire a second time for the same session this run.
      setDraft('session-1', corrupted);
      await migrateLocalStorageDrafts();

      const sanitisationLogs = warnSpy.mock.calls.filter((call) =>
        call.some((arg) =>
          typeof arg === 'string' &&
          arg.includes('Sanitised corrupted composer draft on migration'),
        ),
      );
      expect(sanitisationLogs).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });
});
