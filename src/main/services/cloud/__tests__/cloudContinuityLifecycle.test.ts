import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runStateMapGC, GC_GRACE_WINDOW_MS } from '@core/services/cloudContinuityStateService';

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-continuity-lifecycle',
}));

// Mock cloudSyncMetadata for backward-compat inference tests
const mockSyncedSessions = new Set<string>();
vi.mock('../cloudSyncMetadata', () => ({
  isCloudSynced: vi.fn((id: string) => mockSyncedSessions.has(id)),
  markCloudSynced: vi.fn((id: string) => mockSyncedSessions.add(id)),
  loadCloudSyncMetadata: vi.fn(),
}));

import {
  getContinuityState,
  getContinuityEntry,
  markCloudActive,
  markLocalOnly,
  touchCloudActivity,
  pinToCloud,
  unpinFromCloud,
  getStaleCloudSessions,
  getAllContinuityStates,
  flushContinuityMetadata,
  _resetForTesting,
} from '../cloudContinuityMetadata';

const META_PATH = path.join('/tmp/test-cloud-continuity-lifecycle', 'sessions', 'cloud-continuity-meta.json');

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1_000;

describe('cloudContinuityLifecycle', () => {
  beforeEach(() => {
    _resetForTesting();
    mockSyncedSessions.clear();
    try { fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    _resetForTesting();
    mockSyncedSessions.clear();
    try { fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ---------------------------------------------------------------------------
  // touchCloudActivity
  // ---------------------------------------------------------------------------

  it('touchCloudActivity updates lastCloudActivityAt', () => {
    markCloudActive('session-1');
    expect(getContinuityEntry('session-1')?.lastCloudActivityAt).toBeUndefined();

    touchCloudActivity('session-1');
    const entry = getContinuityEntry('session-1');
    expect(entry?.lastCloudActivityAt).toBeGreaterThan(0);
    expect(entry?.lastCloudActivityAt).toBeLessThanOrEqual(Date.now());
  });

  it('touchCloudActivity is no-op for unknown sessions', () => {
    touchCloudActivity('nonexistent');
    expect(getContinuityEntry('nonexistent')).toBeNull();
  });

  it('touchCloudActivity updates timestamp on repeated calls', () => {
    markCloudActive('session-1');
    touchCloudActivity('session-1');
    const first = getContinuityEntry('session-1')?.lastCloudActivityAt;

    // Advance time slightly
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    touchCloudActivity('session-1');
    const second = getContinuityEntry('session-1')?.lastCloudActivityAt;
    vi.useRealTimers();

    expect(second).toBeGreaterThanOrEqual(first!);
  });

  // ---------------------------------------------------------------------------
  // pinToCloud / unpinFromCloud
  // ---------------------------------------------------------------------------

  it('pinToCloud sets cloudPinnedAt', () => {
    markCloudActive('session-1');
    pinToCloud('session-1');

    const entry = getContinuityEntry('session-1');
    expect(entry?.cloudPinnedAt).toBeGreaterThan(0);
    expect(entry?.state).toBe('cloud_active');
  });

  it('pinToCloud auto-promotes local_only to cloud_active', () => {
    markLocalOnly('session-1', 'cloud-disabled', 'inferred');
    expect(getContinuityState('session-1')).toBe('local_only');

    pinToCloud('session-1');
    expect(getContinuityState('session-1')).toBe('cloud_active');
    expect(getContinuityEntry('session-1')?.cloudPinnedAt).toBeGreaterThan(0);
  });

  it('pinToCloud creates entry for session without explicit state (local_only by default)', () => {
    mockSyncedSessions.add('legacy-session');
    // Sessions are local_only by default (no backward-compat inference)
    expect(getContinuityState('legacy-session')).toBe('local_only');

    // pinToCloud should promote to cloud_active regardless
    pinToCloud('legacy-session');
    const entry = getContinuityEntry('legacy-session');
    expect(entry?.state).toBe('cloud_active');
    expect(entry?.cloudPinnedAt).toBeGreaterThan(0);
  });

  it('unpinFromCloud clears cloudPinnedAt', () => {
    markCloudActive('session-1');
    pinToCloud('session-1');
    expect(getContinuityEntry('session-1')?.cloudPinnedAt).toBeGreaterThan(0);

    unpinFromCloud('session-1');
    expect(getContinuityEntry('session-1')?.cloudPinnedAt).toBeUndefined();
  });

  it('unpinFromCloud is no-op for non-pinned sessions', () => {
    markCloudActive('session-1');
    unpinFromCloud('session-1'); // should not throw
    expect(getContinuityEntry('session-1')?.cloudPinnedAt).toBeUndefined();
  });

  it('markLocalOnly clears pin', () => {
    markCloudActive('session-1');
    pinToCloud('session-1');
    expect(getContinuityEntry('session-1')?.cloudPinnedAt).toBeGreaterThan(0);

    markLocalOnly('session-1', 'cloud-disabled', 'inferred');
    expect(getContinuityEntry('session-1')?.cloudPinnedAt).toBeUndefined();
    expect(getContinuityState('session-1')).toBe('local_only');
  });

  // ---------------------------------------------------------------------------
  // getStaleCloudSessions
  // ---------------------------------------------------------------------------

  it('returns empty array when no sessions exist', () => {
    expect(getStaleCloudSessions(FOURTEEN_DAYS_MS)).toEqual([]);
  });

  it('returns empty array for sessions with undefined lastCloudActivityAt', () => {
    markCloudActive('session-1');
    // lastCloudActivityAt is undefined — should NOT be considered stale
    expect(getStaleCloudSessions(FOURTEEN_DAYS_MS)).toEqual([]);
  });

  it('returns sessions that are inactive beyond threshold', () => {
    markCloudActive('session-1');
    touchCloudActivity('session-1');

    // Manually set lastCloudActivityAt to 15 days ago
    const entry = getContinuityEntry('session-1');
    entry!.lastCloudActivityAt = Date.now() - (15 * 24 * 60 * 60 * 1_000);

    expect(getStaleCloudSessions(FOURTEEN_DAYS_MS)).toEqual(['session-1']);
  });

  it('does not return recently active sessions', () => {
    markCloudActive('session-1');
    touchCloudActivity('session-1');
    // Activity is recent — should NOT be stale
    expect(getStaleCloudSessions(FOURTEEN_DAYS_MS)).toEqual([]);
  });

  it('does not return pinned sessions even if stale', () => {
    markCloudActive('session-1');
    touchCloudActivity('session-1');
    pinToCloud('session-1');

    // Make stale
    const entry = getContinuityEntry('session-1');
    entry!.lastCloudActivityAt = Date.now() - (15 * 24 * 60 * 60 * 1_000);

    // Pinned — exempt from stale detection
    expect(getStaleCloudSessions(FOURTEEN_DAYS_MS)).toEqual([]);
  });

  it('does not return local_only sessions', () => {
    markLocalOnly('session-1', 'cloud-disabled', 'inferred');
    expect(getStaleCloudSessions(FOURTEEN_DAYS_MS)).toEqual([]);
  });

  it('returns only stale sessions from a mixed set', () => {
    // Session A: stale, not pinned
    markCloudActive('session-a');
    touchCloudActivity('session-a');
    getContinuityEntry('session-a')!.lastCloudActivityAt = Date.now() - (15 * 24 * 60 * 60 * 1_000);

    // Session B: recent activity
    markCloudActive('session-b');
    touchCloudActivity('session-b');

    // Session C: stale but pinned
    markCloudActive('session-c');
    touchCloudActivity('session-c');
    pinToCloud('session-c');
    getContinuityEntry('session-c')!.lastCloudActivityAt = Date.now() - (15 * 24 * 60 * 60 * 1_000);

    // Session D: no activity tracked (migrated)
    markCloudActive('session-d');

    // Session E: local_only
    markLocalOnly('session-e', 'cloud-disabled', 'inferred');

    const stale = getStaleCloudSessions(FOURTEEN_DAYS_MS);
    expect(stale).toEqual(['session-a']);
  });

  // ---------------------------------------------------------------------------
  // getAllContinuityStates
  // ---------------------------------------------------------------------------

  it('returns all states including lifecycle fields', () => {
    markCloudActive('session-a');
    touchCloudActivity('session-a');
    pinToCloud('session-b');

    const all = getAllContinuityStates();
    expect(all['session-a'].state).toBe('cloud_active');
    expect(all['session-a'].lastCloudActivityAt).toBeGreaterThan(0);
    expect(all['session-b'].state).toBe('cloud_active'); // auto-promoted
    expect(all['session-b'].cloudPinnedAt).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Metadata migration: old flat string format
  // ---------------------------------------------------------------------------

  it('migrates old flat string format on load', () => {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(
      META_PATH,
      JSON.stringify({
        'old-session': 'cloud_active',
        'old-local': 'local_only',
      }),
      'utf8',
    );

    _resetForTesting();
    expect(getContinuityState('old-session')).toBe('cloud_active');
    expect(getContinuityState('old-local')).toBe('local_only');

    // Migrated sessions have no lifecycle fields
    const entry = getContinuityEntry('old-session');
    expect(entry?.lastCloudActivityAt).toBeUndefined();
    expect(entry?.cloudPinnedAt).toBeUndefined();
  });

  it('loads new object format correctly', () => {
    const now = Date.now();
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(
      META_PATH,
      JSON.stringify({
        'new-session': {
          state: 'cloud_active',
          lastCloudActivityAt: now - 1000,
          cloudPinnedAt: now - 2000,
        },
      }),
      'utf8',
    );

    _resetForTesting();
    const entry = getContinuityEntry('new-session');
    expect(entry?.state).toBe('cloud_active');
    expect(entry?.lastCloudActivityAt).toBe(now - 1000);
    expect(entry?.cloudPinnedAt).toBe(now - 2000);
  });

  it('skips entries with invalid state in object format', () => {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(
      META_PATH,
      JSON.stringify({
        'valid': { state: 'cloud_active' },
        'bad-state': { state: 'invalid' },
        'no-state': { lastCloudActivityAt: 123 },
        'number': 42,
        'null': null,
      }),
      'utf8',
    );

    _resetForTesting();
    const all = getAllContinuityStates();
    expect(Object.keys(all)).toEqual(['valid']);
    expect(all['valid'].state).toBe('cloud_active');
  });

  it('handles mixed old and new format in same file', () => {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(
      META_PATH,
      JSON.stringify({
        'old-format': 'cloud_active',
        'new-format': { state: 'local_only', lastCloudActivityAt: 100 },
      }),
      'utf8',
    );

    _resetForTesting();
    expect(getContinuityState('old-format')).toBe('cloud_active');
    expect(getContinuityState('new-format')).toBe('local_only');
    expect(getContinuityEntry('new-format')?.lastCloudActivityAt).toBe(100);
  });

  // ---------------------------------------------------------------------------
  // Persistence with lifecycle fields
  // ---------------------------------------------------------------------------

  it('persists lifecycle fields to disk and reloads', async () => {
    markCloudActive('session-1');
    touchCloudActivity('session-1');
    pinToCloud('session-1');
    await flushContinuityMetadata();

    const raw = JSON.parse(fs.readFileSync(META_PATH, 'utf8')) as Record<string, unknown>;
    const persistedEntry = (
      (raw['session-1'] as { state?: string; lastCloudActivityAt?: number; cloudPinnedAt?: number } | undefined)
      ?? (raw.sessions as Record<string, { state?: string; lastCloudActivityAt?: number; cloudPinnedAt?: number }> | undefined)?.['session-1']
    );
    expect(persistedEntry?.state).toBe('cloud_active');
    expect(persistedEntry?.lastCloudActivityAt).toBeGreaterThan(0);
    expect(persistedEntry?.cloudPinnedAt).toBeGreaterThan(0);

    // Reset and reload
    const savedActivity = persistedEntry?.lastCloudActivityAt;
    const savedPinned = persistedEntry?.cloudPinnedAt;
    _resetForTesting();
    const reloaded = getContinuityEntry('session-1');
    expect(reloaded?.state).toBe('cloud_active');
    expect(reloaded?.lastCloudActivityAt).toBe(savedActivity);
    expect(reloaded?.cloudPinnedAt).toBe(savedPinned);
  });

  it('retention-policy local_only entries stay protected from cloud GC deletion', async () => {
    markLocalOnly('session-retention', 'cloud-disabled', 'retention-policy');
    const stateMap = getAllContinuityStates();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const sink = { emit: vi.fn() };

    const outcome = await runStateMapGC(
      stateMap,
      {
        listSessions: () => [{ id: 'session-retention', updatedAt: Date.now() - (GC_GRACE_WINDOW_MS + 5_000) }],
        deleteSession,
      },
      sink,
    );

    expect(stateMap['session-retention']?.cloudRemovalIntent?.requestedBy).toBe('retention-policy');
    expect(deleteSession).not.toHaveBeenCalled();
    expect(outcome.deleted).toEqual([]);
    expect(outcome.protected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'session-retention',
          reason: 'retention-policy-visibility-only',
        }),
      ]),
    );
  });
});
