import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSession } from '@shared/types';
import { setErrorReporter } from '@core/errorReporter';

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-continuity-meta',
}));

// Mock cloudSyncMetadata for backward-compat inference tests
const mockSyncedSessions = new Set<string>();
vi.mock('../cloudSyncMetadata', () => ({
  isCloudSynced: vi.fn((id: string) => mockSyncedSessions.has(id)),
  markCloudSynced: vi.fn((id: string) => mockSyncedSessions.add(id)),
  loadCloudSyncMetadata: vi.fn(),
}));

const mockInvariantGetSession = vi.fn();
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockInvariantGetSession,
  }),
}));

import {
  getContinuityState,
  getContinuityEntry,
  isCloudActive,
  markCloudActive,
  markLocalOnly,
  setContinuityState,
  touchCloudActivity,
  pinToCloud,
  getAllContinuityStates,
  removeContinuityMetadata,
  recordTurnPersistenceAckStatus,
  flushContinuityMetadata,
  _resetForTesting,
} from '../cloudContinuityMetadata';

const META_PATH = path.join('/tmp/test-cloud-continuity-meta', 'sessions', 'cloud-continuity-meta.json');
const capturedBreadcrumbs: Array<{ category: string; message: string; data?: Record<string, unknown> }> = [];

function makeInvariantSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-invariant',
    title: 'Invariant Session',
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

async function flushPromises(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

describe('cloudContinuityMetadata', () => {
  beforeEach(() => {
    _resetForTesting();
    mockSyncedSessions.clear();
    mockInvariantGetSession.mockReset();
    capturedBreadcrumbs.length = 0;
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: (breadcrumb) => {
        capturedBreadcrumbs.push({
          category: breadcrumb.category,
          message: breadcrumb.message,
          data: breadcrumb.data,
        });
      },
    });
    try { fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    _resetForTesting();
    mockSyncedSessions.clear();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
    try { fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ---------------------------------------------------------------------------
  // Backward-compat inference
  // ---------------------------------------------------------------------------

  it('returns local_only for a session with no metadata and no cloudSyncedAt', () => {
    expect(getContinuityState('unknown-session')).toBe('local_only');
    expect(isCloudActive('unknown-session')).toBe(false);
  });

  it('returns local_only for a session with cloudSyncedAt but no explicit entry (local_only by default)', () => {
    mockSyncedSessions.add('legacy-session');
    expect(getContinuityState('legacy-session')).toBe('local_only');
    expect(isCloudActive('legacy-session')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // markCloudActive / markLocalOnly
  // ---------------------------------------------------------------------------

  it('marks a session as cloud_active', () => {
    markCloudActive('session-1');
    expect(isCloudActive('session-1')).toBe(true);
    expect(getContinuityState('session-1')).toBe('cloud_active');
  });

  it('marks a session as local_only', () => {
    markCloudActive('session-1');
    markLocalOnly('session-1', 'cloud-disabled', 'inferred');
    expect(isCloudActive('session-1')).toBe(false);
    expect(getContinuityState('session-1')).toBe('local_only');
  });

  it('setContinuityState delegates correctly', () => {
    setContinuityState('session-1', 'cloud_active');
    expect(getContinuityState('session-1')).toBe('cloud_active');

    setContinuityState('session-1', 'local_only');
    expect(getContinuityState('session-1')).toBe('local_only');
  });

  it('emits state-transition breadcrumbs for local_only ↔ cloud_active transitions', async () => {
    mockInvariantGetSession.mockResolvedValue(makeInvariantSession({ id: 'session-1' }));

    markCloudActive('session-1');
    markLocalOnly('session-1', 'cloud-disabled', 'inferred');
    await flushPromises();

    const transitionEvents = capturedBreadcrumbs.filter((breadcrumb) => breadcrumb.message === 'state-transition');
    expect(transitionEvents.length).toBeGreaterThanOrEqual(2);
    expect(transitionEvents[0]?.data).toMatchObject({
      from: 'local_only',
      to: 'cloud_active',
    });
    expect(transitionEvents[1]?.data).toMatchObject({
      from: 'cloud_active',
      to: 'local_only',
    });
  });

  it('emits invariant-violation when cloud_active session has an unacked active turn', async () => {
    mockInvariantGetSession.mockResolvedValueOnce(makeInvariantSession({
      id: 'session-acked',
      activeTurnId: 'turn-acked-1',
    }));

    markCloudActive('session-acked');
    await flushPromises();

    expect(
      capturedBreadcrumbs.some((breadcrumb) => (
        breadcrumb.message === 'invariant-violation'
        && breadcrumb.data?.invariant === 'cloud-active-requires-acked-turn-id'
      )),
    ).toBe(true);
  });

  it('does not emit cloud-active invariant when active turn is marked persisted', async () => {
    recordTurnPersistenceAckStatus('session-acked-persisted', 'turn-persisted-1', 'persisted');
    mockInvariantGetSession.mockResolvedValueOnce(makeInvariantSession({
      id: 'session-acked-persisted',
      activeTurnId: 'turn-persisted-1',
    }));

    markCloudActive('session-acked-persisted');
    await flushPromises();

    expect(
      capturedBreadcrumbs.some((breadcrumb) => (
        breadcrumb.message === 'invariant-violation'
        && breadcrumb.data?.invariant === 'cloud-active-requires-acked-turn-id'
      )),
    ).toBe(false);
  });

  it('emits invariant-violation when local_only session still has cloudUpdatedAt', async () => {
    mockInvariantGetSession
      .mockResolvedValueOnce(makeInvariantSession({ id: 'session-local', cloudUpdatedAt: 0 }))
      .mockResolvedValueOnce(makeInvariantSession({ id: 'session-local', cloudUpdatedAt: 123 }));

    markCloudActive('session-local');
    markLocalOnly('session-local', 'cloud-disabled', 'inferred');
    await flushPromises();

    expect(
      capturedBreadcrumbs.some((breadcrumb) => (
        breadcrumb.message === 'invariant-violation'
        && breadcrumb.data?.invariant === 'local-only-has-cloud-updated-at'
      )),
    ).toBe(true);
  });

  it('markCloudActive is idempotent', () => {
    markCloudActive('session-1');
    markCloudActive('session-1'); // second call should be no-op
    expect(getContinuityState('session-1')).toBe('cloud_active');
  });

  it('markLocalOnly is idempotent', () => {
    markLocalOnly('session-1', 'cloud-disabled', 'inferred');
    markLocalOnly('session-1', 'cloud-disabled', 'inferred');
    expect(getContinuityState('session-1')).toBe('local_only');
  });

  // ---------------------------------------------------------------------------
  // Explicit state takes precedence over backward-compat inference
  // ---------------------------------------------------------------------------

  it('explicit local_only overrides backward-compat cloud_active inference', () => {
    mockSyncedSessions.add('session-x'); // would infer cloud_active
    markLocalOnly('session-x', 'manual-reset', 'user'); // explicit override
    expect(getContinuityState('session-x')).toBe('local_only');
  });

  // ---------------------------------------------------------------------------
  // Remove
  // ---------------------------------------------------------------------------

  it('removes continuity metadata for a session', () => {
    markCloudActive('session-1');
    expect(isCloudActive('session-1')).toBe(true);

    removeContinuityMetadata('session-1');
    // After removal: falls back to cloudSyncedAt inference
    expect(isCloudActive('session-1')).toBe(false); // no cloudSyncedAt → local_only
  });

  it('remove is idempotent for unknown sessions', () => {
    removeContinuityMetadata('nonexistent'); // should not throw
    expect(getContinuityState('nonexistent')).toBe('local_only');
  });

  // ---------------------------------------------------------------------------
  // Persistence (new object format)
  // ---------------------------------------------------------------------------

  it('persists to disk on flush and reloads', async () => {
    markCloudActive('session-a');
    markLocalOnly('session-b', 'cloud-disabled', 'inferred');
    await flushContinuityMetadata();

    expect(fs.existsSync(META_PATH)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    // New format: entries are objects with `state` field
    expect(raw.sessions?.['session-a']).toEqual({ state: 'cloud_active' });
    expect(raw.sessions?.['session-b']).toEqual({ state: 'local_only' });

    // Reset and reload from disk
    _resetForTesting();
    expect(getContinuityState('session-a')).toBe('cloud_active');
    expect(getContinuityState('session-b')).toBe('local_only');
  });

  it('handles missing meta file gracefully', () => {
    expect(getContinuityState('session-1')).toBe('local_only');
  });

  it('handles corrupt meta file gracefully', () => {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(META_PATH, 'not-json', 'utf8');

    // Should warn and start fresh
    expect(getContinuityState('session-1')).toBe('local_only');
    markCloudActive('session-1');
    expect(isCloudActive('session-1')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Backward-compat: old flat string format migration
  // ---------------------------------------------------------------------------

  it('migrates old flat string format to object format on load', () => {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    // Old format: plain string values
    fs.writeFileSync(
      META_PATH,
      JSON.stringify({ 'session-a': 'cloud_active', 'session-b': 'local_only' }),
      'utf8',
    );

    _resetForTesting();
    expect(getContinuityState('session-a')).toBe('cloud_active');
    expect(getContinuityState('session-b')).toBe('local_only');

    // Verify migration produces object entries
    const entryA = getContinuityEntry('session-a');
    expect(entryA).toEqual({ state: 'cloud_active' });
  });

  it('ignores invalid values in meta file (both old and new format)', () => {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(
      META_PATH,
      JSON.stringify({
        'session-a': 'cloud_active', // old format, valid
        'session-b': 'invalid_state', // old format, invalid state
        'session-c': 42, // not a string or object
        'session-d': { state: 'cloud_active' }, // new format, valid
        'session-e': { state: 'bad_state' }, // new format, invalid state
        'session-f': { noState: true }, // new format, missing state
      }),
      'utf8',
    );

    _resetForTesting();
    expect(getContinuityState('session-a')).toBe('cloud_active');
    expect(getContinuityState('session-b')).toBe('local_only'); // invalid → inference fallback
    expect(getContinuityState('session-c')).toBe('local_only'); // invalid → inference fallback
    expect(getContinuityState('session-d')).toBe('cloud_active');
    expect(getContinuityState('session-e')).toBe('local_only'); // invalid state → inference fallback
    expect(getContinuityState('session-f')).toBe('local_only'); // no state → inference fallback
  });

  it('sanitizes invalid cloudRemovalIntent payloads from disk without dropping entries', () => {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(
      META_PATH,
      JSON.stringify({
        'invalid-requested-by': {
          state: 'local_only',
          cloudRemovalIntent: { requestedAt: 1000, requestedBy: 'someone-else', source: 'desktop' },
        },
        'invalid-requested-at': {
          state: 'local_only',
          cloudRemovalIntent: { requestedAt: Number.NaN, requestedBy: 'user', source: 'desktop' },
        },
        'invalid-source': {
          state: 'local_only',
          cloudRemovalIntent: { requestedAt: 2000, requestedBy: 'user', source: 'desktop-app' },
        },
        'cloud-active-with-intent': {
          state: 'cloud_active',
          cloudRemovalIntent: { requestedAt: 3000, requestedBy: 'user', source: 'desktop' },
        },
      }),
      'utf8',
    );

    _resetForTesting();
    expect(getContinuityEntry('invalid-requested-by')).toEqual({ state: 'local_only' });
    expect(getContinuityEntry('invalid-requested-at')).toEqual({ state: 'local_only' });
    expect(getContinuityEntry('invalid-source')).toEqual({
      state: 'local_only',
      cloudRemovalIntent: {
        requestedAt: 2000,
        requestedBy: 'user',
      },
    });
    expect(getContinuityEntry('cloud-active-with-intent')).toEqual({ state: 'cloud_active' });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle fields
  // ---------------------------------------------------------------------------

  it('preserves lifecycle fields across markCloudActive/markLocalOnly', () => {
    markCloudActive('session-1');
    touchCloudActivity('session-1');
    const entryBefore = getContinuityEntry('session-1');
    expect(entryBefore?.lastCloudActivityAt).toBeGreaterThan(0);

    markLocalOnly('session-1', 'cloud-disabled', 'inferred');
    const entryAfter = getContinuityEntry('session-1');
    expect(entryAfter?.state).toBe('local_only');
    // lastCloudActivityAt is preserved across state changes
    expect(entryAfter?.lastCloudActivityAt).toBe(entryBefore!.lastCloudActivityAt);
  });

  it('markLocalOnly clears pin', () => {
    markCloudActive('session-1');
    pinToCloud('session-1');
    expect(getContinuityEntry('session-1')?.cloudPinnedAt).toBeGreaterThan(0);

    markLocalOnly('session-1', 'cloud-disabled', 'inferred');
    expect(getContinuityEntry('session-1')?.cloudPinnedAt).toBeUndefined();
  });

  it('getAllContinuityStates returns all entries', () => {
    markCloudActive('session-a');
    markLocalOnly('session-b', 'cloud-disabled', 'inferred');
    const all = getAllContinuityStates();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['session-a'].state).toBe('cloud_active');
    expect(all['session-b'].state).toBe('local_only');
  });

  it('persists cloudRemovalIntent for explicit user demotion', () => {
    markCloudActive('session-intent');
    markLocalOnly('session-intent', 'cloud-disabled', 'user');

    const entry = getContinuityEntry('session-intent');
    expect(entry?.state).toBe('local_only');
    expect(entry?.cloudRemovalIntent?.requestedBy).toBe('user');
    expect(entry?.cloudRemovalIntent?.source).toBe('desktop');
    expect(entry?.cloudRemovalIntent?.requestedAt).toEqual(expect.any(Number));
  });

  it('does not persist cloudRemovalIntent for inferred demotion intent', () => {
    markCloudActive('session-inferred-intent');
    markLocalOnly('session-inferred-intent', 'cloud-disabled', 'inferred');

    const entry = getContinuityEntry('session-inferred-intent');
    expect(entry?.state).toBe('local_only');
    expect(entry?.cloudRemovalIntent).toBeUndefined();
  });

  it('markCloudActive clears cloudRemovalIntent from metadata', () => {
    markLocalOnly('session-intent-clear', 'manual-reset', 'user');
    expect(getContinuityEntry('session-intent-clear')?.cloudRemovalIntent?.requestedBy).toBe('user');

    markCloudActive('session-intent-clear');
    expect(getContinuityEntry('session-intent-clear')?.cloudRemovalIntent).toBeUndefined();
  });

  it('markCloudActive records an intent-cleared breadcrumb when clearing prior intent', () => {
    markLocalOnly('session-intent-breadcrumb', 'manual-reset', 'user');
    capturedBreadcrumbs.length = 0;

    markCloudActive('session-intent-breadcrumb');

    expect(capturedBreadcrumbs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'continuity.intent-cleared',
          message: 'cloud-removal-intent-cleared',
          data: expect.objectContaining({
            reason: 'cloud-active-promotion',
            previousIntent: expect.objectContaining({
              requestedBy: 'user',
              requestedAt: expect.any(Number),
            }),
            sessionIdHash: expect.any(String),
          }),
        }),
      ]),
    );
  });

  it('pinToCloud clears cloudRemovalIntent on re-promotion', () => {
    markLocalOnly('session-pin-intent-clear', 'manual-reset', 'user');
    expect(getContinuityEntry('session-pin-intent-clear')?.cloudRemovalIntent?.requestedBy).toBe('user');

    pinToCloud('session-pin-intent-clear');

    const entry = getContinuityEntry('session-pin-intent-clear');
    expect(entry?.state).toBe('cloud_active');
    expect(entry?.cloudRemovalIntent).toBeUndefined();
  });

  it('preserves cloudRemovalIntent across flush and cold-start reset', async () => {
    markLocalOnly('session-cold-start-intent', 'manual-reset', 'user');
    const intentBeforeFlush = getContinuityEntry('session-cold-start-intent')?.cloudRemovalIntent;
    expect(intentBeforeFlush).toEqual(
      expect.objectContaining({
        requestedBy: 'user',
        requestedAt: expect.any(Number),
        source: 'desktop',
      }),
    );

    await flushContinuityMetadata();
    _resetForTesting();

    const reloadedIntent = getContinuityEntry('session-cold-start-intent')?.cloudRemovalIntent;
    expect(reloadedIntent).toEqual(intentBeforeFlush);
  });

  it('returns a flush failure result when disk write fails', async () => {
    const sessionsPath = path.join('/tmp/test-cloud-continuity-meta', 'sessions');
    fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
    fs.writeFileSync(sessionsPath, 'not-a-directory', 'utf8');

    markCloudActive('session-flush-failure');

    const result = await flushContinuityMetadata();

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('EEXIST');
  });
});
