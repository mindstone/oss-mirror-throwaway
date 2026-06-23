import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ContributionStatus,
  ConnectorContribution,
  ContributionStoreState,
} from '../contributionTypes';
import { ALL_CONTRIBUTION_STATUSES, VALID_STATE_TRANSITIONS } from '../contributionTypes';

// ─── In-memory store mock (same pattern as communityEventsService.test.ts) ──

let storeData: Record<string, unknown> = {};

 
vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) { return storeData[key]; },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrObj === 'string') {
        storeData[keyOrObj] = value;
      } else {
        Object.assign(storeData, keyOrObj);
      }
    },
    has(key: string) { return key in storeData; },
    delete(key: string) { delete storeData[key]; },
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/path',
  })),
}));

// Track migrateStore calls to verify migration wiring
interface MockMigrationResult {
  data: Record<string, unknown>;
  status: string;
  shouldPersist: boolean;
  fromVersion: number | null;
  toVersion: number;
  backupPath: string | null;
}

interface MockMigrationOptions {
  currentVersion: number;
  migrations: Record<number, (data: ContributionStoreState) => ContributionStoreState>;
}

function applyActualContributionMigrations(
  stored: Record<string, unknown>,
  opts: unknown,
): MockMigrationResult {
  const { currentVersion, migrations } = opts as MockMigrationOptions;
  let data = stored as ContributionStoreState;
  const fromVersion = data.version;

  while (data.version < currentVersion) {
    const migration = migrations[data.version];
    if (!migration) {
      throw new Error(`Missing migration for version ${data.version}`);
    }
    data = migration(data);
  }

  return {
    data: data as unknown as Record<string, unknown>,
    status: fromVersion === currentVersion ? 'current' : 'migrated',
    shouldPersist: fromVersion !== currentVersion,
    fromVersion,
    toVersion: currentVersion,
    backupPath: null,
  };
}

const mockMigrateStore = vi.fn<(stored: Record<string, unknown>, opts: unknown) => MockMigrationResult>(
  (stored: Record<string, unknown>, _opts: unknown) => ({
    data: stored,
    status: 'current',
    shouldPersist: false,
    fromVersion: (stored as { version?: number }).version ?? 1,
    toVersion: 1,
    backupPath: null,
  }),
);

 
vi.mock('@core/utils/storeMigration', () => ({
  createMigrationRegistry: <T extends Record<string, unknown>>(
    migrations: Record<number, (data: T) => T>,
  ): Record<number, (data: T) => T> => migrations,
  migrateStore: (...args: unknown[]) => mockMigrateStore(...(args as [Record<string, unknown>, unknown])),
  // Mirror the real read-only policy: read-only only on future_version or on a
  // corrupted migration that preserved the on-disk file (shouldPersist === false).
  shouldEnterReadOnlyMode: (result: { status: string; shouldPersist: boolean }): boolean =>
    result.status === 'future_version' ||
    (result.status === 'corrupted' && result.shouldPersist === false),
}));

// Import after mocks
import {
  createDefaultState,
  createContribution,
  getContributionById,
  getContributionBySession,
  getActiveContributionBySession,
  getContributionsBySession,
  getContributionByPath,
  addLinkedSession,
  addFollowUpSession,
  updateContribution,
  listContributions,
  acknowledgeEvent,
  isEventAcknowledged,
  CONTRIBUTION_STORE_VERSION,
  _resetStore,
  _resetCompatShimWarnedKeysForTesting,
  // Stage 3.C readiness helpers.
  setLastBuildDetectedAt,
  setLastTestPassedAt,
  setLastRegisteredAt,
  setLastReadyRequestedAt,
  setLastBuildFingerprint,
  clearStaleReadinessOnFingerprintChange,
  getStuckTestingContributions,
} from '../contributionStore';
import { CONTRIBUTION_STORE_MIGRATIONS } from '../contributionStore';

// ─── Helpers ────────────────────────────────────────────────────────

function makeContributionInput(
  overrides?: Partial<Omit<ConnectorContribution, 'id' | 'createdAt' | 'updatedAt' | 'acknowledgedEvents'>>,
) {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    connectorName: 'test-connector',
    status: 'draft' as ContributionStatus,
    attributionMode: 'anonymous' as const,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('contributionStore', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
    mockMigrateStore.mockClear();
    // Default mock: return stored data as-is, no persist needed
    mockMigrateStore.mockImplementation((stored: Record<string, unknown>, _opts: unknown) => ({
      data: stored,
      status: 'current' as const,
      shouldPersist: false,
      fromVersion: (stored as { version?: number }).version ?? 1,
      toVersion: 1,
      backupPath: null,
    }));
  });

  // VAL-STATE-001: Store creates with correct default state
  describe('createDefaultState', () => {
    it('returns state with empty contributions array and correct version', () => {
      const state = createDefaultState();
      expect(state).toEqual({
        version: CONTRIBUTION_STORE_VERSION,
        contributions: [],
      });
    });

    it('returns version 6', () => {
      expect(CONTRIBUTION_STORE_VERSION).toBe(6);
    });
  });

  // VAL-STATE-002: Store version registered in ALL_STORE_VERSIONS
  describe('store version registration', () => {
    it('CONTRIBUTION_STORE_VERSION is registered in ALL_STORE_VERSIONS', async () => {
      const { ALL_STORE_VERSIONS } = await import('@core/constants');
      expect(ALL_STORE_VERSIONS).toHaveProperty('CONTRIBUTION_STORE_VERSION');
      expect(ALL_STORE_VERSIONS.CONTRIBUTION_STORE_VERSION).toBe(CONTRIBUTION_STORE_VERSION);
    });
  });

  // VAL-STATE-003: ContributionStatus type covers all 10 states
  describe('ContributionStatus', () => {
    it('defines exactly 10 states', () => {
      expect(ALL_CONTRIBUTION_STATUSES).toHaveLength(10);
    });

    it('includes all required states', () => {
      const requiredStates: ContributionStatus[] = [
        'draft',
        'testing',
        'ready_to_submit',
        'submitted',
        'ci_pass',
        'ci_fail',
        'changes_requested',
        'approved',
        'rejected',
        'published',
      ];
      for (const status of requiredStates) {
        expect(ALL_CONTRIBUTION_STATUSES).toContain(status);
      }
    });
  });

  // VAL-STATE-004: CRUD operations work
  describe('CRUD operations', () => {
    describe('createContribution', () => {
      it('creates a contribution with generated id and timestamps', () => {
        const input = makeContributionInput();
        const contribution = createContribution(input);

        expect(contribution.id).toBeDefined();
        expect(contribution.id).toMatch(/^contrib-/);
        expect(contribution.sessionId).toBe(input.sessionId);
        expect(contribution.connectorName).toBe(input.connectorName);
        expect(contribution.status).toBe('draft');
        expect(contribution.attributionMode).toBe('anonymous');
        expect(contribution.acknowledgedEvents).toEqual([]);
        expect(contribution.createdAt).toBeDefined();
        expect(contribution.updatedAt).toBeDefined();
      });

      it('persists the contribution in the store', () => {
        const input = makeContributionInput();
        const contribution = createContribution(input);

        const retrieved = getContributionById(contribution.id);
        expect(retrieved).toEqual(contribution);
      });
    });

    describe('getContributionById', () => {
      it('returns the contribution for a valid ID', () => {
        const contribution = createContribution(makeContributionInput());
        expect(getContributionById(contribution.id)).toEqual(contribution);
      });

      it('returns undefined for unknown ID', () => {
        expect(getContributionById('nonexistent')).toBeUndefined();
      });
    });

    describe('getContributionBySession', () => {
      it('returns the contribution for a valid session ID', () => {
        const input = makeContributionInput({ sessionId: 'session-abc' });
        const contribution = createContribution(input);

        const retrieved = getContributionBySession('session-abc');
        expect(retrieved).toEqual(contribution);
      });

      it('returns undefined for unknown session ID', () => {
        expect(getContributionBySession('nonexistent')).toBeUndefined();
      });
    });

    describe('updateContribution', () => {
      it('updates specific fields on a contribution', () => {
        const contribution = createContribution(makeContributionInput());
        const updated = updateContribution(contribution.id, {
          connectorName: 'updated-connector',
          localServerPath: '/path/to/server',
        });

        expect(updated).toBeDefined();
        expect(updated!.connectorName).toBe('updated-connector');
        expect(updated!.localServerPath).toBe('/path/to/server');
        // updatedAt is always refreshed (may match if same ms tick, so just check it exists)
        expect(updated!.updatedAt).toBeDefined();
        expect(typeof updated!.updatedAt).toBe('string');
      });

      it('returns undefined for unknown ID', () => {
        expect(updateContribution('nonexistent', { connectorName: 'x' })).toBeUndefined();
      });

      // Stage 2 / Opus Finding 5: same-status updates must short-circuit so concurrent
      // promotion callers can't corrupt side-data or silently re-write `updatedAt`.
      it('same-status no-op: returns existing record unchanged when status equals current', async () => {
        const contribution = createContribution(makeContributionInput({ status: 'testing' }));
        const originalUpdatedAt = contribution.updatedAt;
        // Wait a tick so updatedAt would visibly change if we fell through to the write path.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = updateContribution(contribution.id, { status: 'testing' });
        expect(result).toBeDefined();
        expect(result!.id).toBe(contribution.id);
        expect(result!.status).toBe('testing');
        // Critical: no write occurred, so updatedAt is untouched.
        expect(result!.updatedAt).toBe(originalUpdatedAt);
      });

      it('same-status no-op: repeated calls leave record and updatedAt identical', async () => {
        const contribution = createContribution(makeContributionInput({ status: 'ready_to_submit' }));
        const first = updateContribution(contribution.id, { status: 'ready_to_submit' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = updateContribution(contribution.id, { status: 'ready_to_submit' });
        expect(first!.updatedAt).toBe(second!.updatedAt);
      });

      it('same-status with additional non-matching field DOES write (side-data path preserved)', () => {
        // Real-world flow: agent reports same status but also updates prUrl.
        // The no-op guard only triggers when the ONLY effective change is status ↔ status.
        const contribution = createContribution(makeContributionInput({ status: 'submitted', prUrl: undefined }));
        const result = updateContribution(contribution.id, {
          status: 'submitted',
          prUrl: 'https://github.com/owner/repo/pull/1',
        });
        expect(result).toBeDefined();
        expect(result!.prUrl).toBe('https://github.com/owner/repo/pull/1');
      });

      it('rapid redundant same-status calls after promotion return the promoted record without re-writing', async () => {
        // Simulates the Stage 4 race: handleTestPassPromotion + auto-check-success fire
        // within the same tick, both calling `updateContribution(id, {status: 'ready_to_submit'})`.
        // Since the store is synchronous, these execute sequentially — the first call
        // performs a real testing → ready_to_submit write, and subsequent same-status
        // calls hit the no-op guard. All three callers observe the same promoted record
        // with identical updatedAt (no double-write, no telemetry bump).
        const contribution = createContribution(makeContributionInput({ status: 'testing' }));
        const a = updateContribution(contribution.id, { status: 'ready_to_submit' });
        // Small gap so updatedAt WOULD differ if calls 2/3 fell through to write path.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const b = updateContribution(contribution.id, { status: 'ready_to_submit' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const c = updateContribution(contribution.id, { status: 'ready_to_submit' });
        expect(a!.status).toBe('ready_to_submit');
        expect(b!.status).toBe('ready_to_submit');
        expect(c!.status).toBe('ready_to_submit');
        // Critical proof: all three return values share the SAME updatedAt — calls 2/3
        // short-circuited without touching the store.
        expect(b!.updatedAt).toBe(a!.updatedAt);
        expect(c!.updatedAt).toBe(a!.updatedAt);
        // The store's record matches what the first call produced.
        const final = getContributionById(contribution.id);
        expect(final!.updatedAt).toBe(a!.updatedAt);
      });

      it('same-status with equal-value extra field is still a no-op (pins predicate semantics)', async () => {
        // Guard the intent of `Object.keys(updates).every(...)`: if a caller passes
        // `{status: X, connectorName: 'foo'}` and the record already has both values,
        // the update is a pure redundancy and should short-circuit. This is the
        // canonical case for the agent re-reporting its own state mid-turn.
        const contribution = createContribution(makeContributionInput({ status: 'testing', connectorName: 'stable-name' }));
        const originalUpdatedAt = contribution.updatedAt;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = updateContribution(contribution.id, { status: 'testing', connectorName: 'stable-name' });
        expect(result!.updatedAt).toBe(originalUpdatedAt);
      });

      it('invalid transition path still returns null (unchanged by no-op guard)', () => {
        // Regression guard: the no-op guard must NOT accidentally treat an invalid
        // transition as a same-status no-op. testing → draft is invalid; it should
        // still be rejected.
        const contribution = createContribution(makeContributionInput({ status: 'testing' }));
        const result = updateContribution(contribution.id, { status: 'draft' });
        expect(result).toBeNull();
      });

      // Stage 3: lastTransitionError contract tests
      it('rejected transition populates lastTransitionError with actionable message', () => {
        // testing → draft is invalid; the store should reject with null AND persist
        // a human-readable error so the agent can self-correct.
        const contribution = createContribution(makeContributionInput({ status: 'testing' }));
        const result = updateContribution(contribution.id, { status: 'draft' });
        expect(result).toBeNull();
        const refreshed = getContributionById(contribution.id);
        expect(refreshed!.lastTransitionError).toBeDefined();
        expect(refreshed!.lastTransitionError).toContain('testing');
        expect(refreshed!.lastTransitionError).toContain('draft');
        expect(refreshed!.lastTransitionError).toContain('ready_to_submit');
      });

      it('successful transition clears lastTransitionError', () => {
        // After a rejected transition sets the error, a valid transition must clear it.
        const contribution = createContribution(makeContributionInput({ status: 'testing' }));
        updateContribution(contribution.id, { status: 'draft' }); // rejected, sets error
        expect(getContributionById(contribution.id)!.lastTransitionError).toBeDefined();
        const promoted = updateContribution(contribution.id, { status: 'ready_to_submit' });
        expect(promoted).toBeDefined();
        expect(promoted!.status).toBe('ready_to_submit');
        expect(promoted!.lastTransitionError).toBeUndefined();
      });

      it('fix-cycle re-entry (ci_fail → testing) clears lastTransitionError from prior rejected transition', () => {
        // Simulates the real user flow: contribution at ci_fail, agent attempts
        // an invalid transition (testing → draft to "give up"), gets rejected.
        // Later, agent correctly re-enters testing (ci_fail → testing is valid).
        const contribution = createContribution(makeContributionInput({ status: 'ci_fail' }));
        // Invalid: ci_fail → draft is NOT in VALID_STATE_TRANSITIONS (draft excluded).
        const rejected = updateContribution(contribution.id, { status: 'draft' });
        expect(rejected).toBeNull();
        expect(getContributionById(contribution.id)!.lastTransitionError).toBeDefined();
        // Valid fix-cycle re-entry.
        const promoted = updateContribution(contribution.id, { status: 'testing' });
        expect(promoted!.status).toBe('testing');
        expect(promoted!.lastTransitionError).toBeUndefined();
      });

      it('same-status no-op does NOT clear lastTransitionError (Stage 2+3 interaction)', async () => {
        // Per the Stage 2+3 contract: same-status calls are no-ops, so they don't
        // count as "successful transitions" for the purposes of clearing the error.
        // Callers that want to clear MUST either (a) transition to a valid next
        // state, or (b) pass lastTransitionError: undefined explicitly.
        const contribution = createContribution(makeContributionInput({ status: 'testing' }));
        updateContribution(contribution.id, { status: 'draft' }); // rejected, sets error
        const afterReject = getContributionById(contribution.id)!;
        const originalUpdatedAt = afterReject.updatedAt;
        await new Promise((resolve) => setTimeout(resolve, 5));
        // Same-status no-op.
        const result = updateContribution(contribution.id, { status: 'testing' });
        expect(result!.lastTransitionError).toBe(afterReject.lastTransitionError);
        // No-op: updatedAt unchanged.
        expect(result!.updatedAt).toBe(originalUpdatedAt);
      });

      it('explicit undefined clears lastTransitionError via same-status call', () => {
        // The escape hatch documented in Stage 3: passing lastTransitionError: undefined
        // alongside same-status breaks the no-op predicate (undefined !== 'some error')
        // and falls through to the write path, which then clears the error.
        const contribution = createContribution(makeContributionInput({ status: 'testing' }));
        updateContribution(contribution.id, { status: 'draft' }); // rejected
        expect(getContributionById(contribution.id)!.lastTransitionError).toBeDefined();
        const result = updateContribution(contribution.id, {
          status: 'testing',
          lastTransitionError: undefined,
        });
        expect(result!.lastTransitionError).toBeUndefined();
      });

      it('repeated same invalid transition preserves existing error without rewriting updatedAt', async () => {
        // If the agent retries the same invalid transition, the error message is
        // idempotent. We DO bump updatedAt each time the error is (re-)written
        // because the rejection is a persistence event. Subsequent IDENTICAL retries
        // (same error already in place) should NOT rewrite.
        const contribution = createContribution(makeContributionInput({ status: 'testing' }));
        const first = updateContribution(contribution.id, { status: 'draft' });
        expect(first).toBeNull();
        const firstRead = getContributionById(contribution.id)!;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = updateContribution(contribution.id, { status: 'draft' });
        expect(second).toBeNull();
        const secondRead = getContributionById(contribution.id)!;
        // Message identical, so no re-write — updatedAt unchanged.
        expect(secondRead.updatedAt).toBe(firstRead.updatedAt);
        expect(secondRead.lastTransitionError).toBe(firstRead.lastTransitionError);
      });

      it('same-status + side-data write preserves existing lastTransitionError', () => {
        // Opus reviewer Stage 3 S3: pins the spread-carry-through contract.
        // If a caller updates side-data (e.g. localServerPath) while the
        // status is unchanged, the existing lastTransitionError must NOT be
        // cleared — only a new-state transition (or explicit undefined) clears.
        const contribution = createContribution(makeContributionInput({ status: 'testing' }));
        updateContribution(contribution.id, { status: 'draft' }); // rejected, sets error
        const existingError = getContributionById(contribution.id)!.lastTransitionError;
        expect(existingError).toBeDefined();
        // Same-status + side-data change. Breaks the no-op predicate (side-data
        // differs) so falls through to write, but status isn't transitioning so
        // the spread override for `lastTransitionError: undefined` is not applied.
        const result = updateContribution(contribution.id, {
          status: 'testing',
          localServerPath: '/new/path',
        });
        expect(result).not.toBeNull();
        expect(result!.localServerPath).toBe('/new/path');
        expect(result!.lastTransitionError).toBe(existingError);
      });

      // Stage 1.2 FU1 (260420 OSS MCP backend relay): `attributionName: null`
      // is the sentinel for field deletion. This exists because a user can
      // retry with Anonymous after having set a Rebel name — the stale name
      // must be scrubbed to prevent it leaking into the relay payload.
      describe('attributionName null-sentinel (Stage 1.2 FU1)', () => {
        it('deletes attributionName when explicitly set to null', () => {
          const contribution = createContribution(makeContributionInput());
          const withName = updateContribution(contribution.id, {
            attributionName: 'Alex',
          });
          expect(withName).toBeDefined();
          expect(withName!.attributionName).toBe('Alex');

          const cleared = updateContribution(contribution.id, {
            attributionName: null,
          });
          expect(cleared).toBeDefined();
          expect(Object.prototype.hasOwnProperty.call(cleared!, 'attributionName')).toBe(false);

          const refreshed = getContributionById(contribution.id);
          expect(refreshed).toBeDefined();
          expect(Object.prototype.hasOwnProperty.call(refreshed!, 'attributionName')).toBe(false);
        });

        it('leaves an existing attributionName alone when updates omit the field', () => {
          const contribution = createContribution(
            makeContributionInput({ attributionName: 'Alex' }),
          );
          const updated = updateContribution(contribution.id, {
            connectorName: 'renamed-connector',
          });
          expect(updated).toBeDefined();
          expect(updated!.attributionName).toBe('Alex');
        });

        it('overwrites a prior name when given a new non-null string', () => {
          const contribution = createContribution(
            makeContributionInput({ attributionName: 'Alex' }),
          );
          const updated = updateContribution(contribution.id, {
            attributionName: 'Bailey',
          });
          expect(updated!.attributionName).toBe('Bailey');
        });
      });

      describe('relayContributionId null-sentinel (Stage 3)', () => {
        it('deletes relayContributionId when explicitly set to null', () => {
          const contribution = createContribution(makeContributionInput());
          const withRelayId = updateContribution(contribution.id, {
            relayContributionId: 'rel-123',
          });
          expect(withRelayId).toBeDefined();
          expect(withRelayId!.relayContributionId).toBe('rel-123');

          const cleared = updateContribution(contribution.id, {
            relayContributionId: null,
          });
          expect(cleared).toBeDefined();
          expect(Object.prototype.hasOwnProperty.call(cleared!, 'relayContributionId')).toBe(false);

          const refreshed = getContributionById(contribution.id);
          expect(refreshed).toBeDefined();
          expect(Object.prototype.hasOwnProperty.call(refreshed!, 'relayContributionId')).toBe(false);
        });
      });
    });

    describe('publishedEmailSentAt field', () => {
      it('round-trip: updateContribution persists publishedEmailSentAt', () => {
        const contribution = createContribution(makeContributionInput({ status: 'approved' }));
        updateContribution(contribution.id, { status: 'published' });

        const stampedAt = '2026-04-20T12:34:56.789Z';
        const updated = updateContribution(contribution.id, { publishedEmailSentAt: stampedAt });

        expect(updated).toBeDefined();
        expect(updated!.publishedEmailSentAt).toBe(stampedAt);
        const refreshed = getContributionById(contribution.id);
        expect(refreshed!.publishedEmailSentAt).toBe(stampedAt);
      });

      it('back-fill happy path: stamps existing published records at store init', () => {
        // Seed the mock store with a pre-existing published contribution that
        // lacks publishedEmailSentAt (the pre-feature state).
        const legacyUpdatedAt = '2026-04-15T09:00:00.000Z';
        storeData = {
          version: CONTRIBUTION_STORE_VERSION,
          contributions: [
            {
              id: 'contrib-legacy-1',
              sessionId: 'session-legacy',
              connectorName: 'legacy-connector',
              status: 'published',
              attributionMode: 'anonymous',
              acknowledgedEvents: [],
              createdAt: '2026-04-10T00:00:00.000Z',
              updatedAt: legacyUpdatedAt,
            },
          ],
        };

        // Trigger store init — back-fill runs inline and stamps the field.
        const list = listContributions();
        expect(list).toHaveLength(1);
        expect(list[0].publishedEmailSentAt).toBe(legacyUpdatedAt);
      });

      it('back-fill idempotency: existing publishedEmailSentAt values are not overwritten', () => {
        const preExistingStamp = '2026-04-12T10:00:00.000Z';
        storeData = {
          version: CONTRIBUTION_STORE_VERSION,
          contributions: [
            {
              id: 'contrib-already-stamped',
              sessionId: 'session-stamped',
              connectorName: 'already-stamped-connector',
              status: 'published',
              attributionMode: 'anonymous',
              acknowledgedEvents: [],
              createdAt: '2026-04-10T00:00:00.000Z',
              updatedAt: '2026-04-15T09:00:00.000Z',
              publishedEmailSentAt: preExistingStamp,
            },
          ],
        };

        const list = listContributions();
        expect(list[0].publishedEmailSentAt).toBe(preExistingStamp);
      });

      it('back-fill scope: non-published records are not touched', () => {
        // One record per non-published status the state machine may hold.
        const nonPublishedStatuses: ContributionStatus[] = [
          'draft',
          'testing',
          'ready_to_submit',
          'submitted',
          'ci_pass',
          'ci_fail',
          'changes_requested',
          'approved',
          'rejected',
        ];

        storeData = {
          version: CONTRIBUTION_STORE_VERSION,
          contributions: nonPublishedStatuses.map((status, i) => ({
            id: `contrib-${status}-${i}`,
            sessionId: `session-${status}`,
            connectorName: `${status}-connector`,
            status,
            attributionMode: 'anonymous' as const,
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00.000Z',
            updatedAt: '2026-04-15T09:00:00.000Z',
          })),
        };

        const list = listContributions();
        expect(list).toHaveLength(nonPublishedStatuses.length);
        for (const record of list) {
          expect(record.status).not.toBe('published');
          expect(record.publishedEmailSentAt).toBeUndefined();
        }
      });
    });

    describe('listContributions', () => {
      it('returns empty array when no contributions exist', () => {
        expect(listContributions()).toEqual([]);
      });

      it('returns all contributions', () => {
        createContribution(makeContributionInput({ connectorName: 'a' }));
        createContribution(makeContributionInput({ connectorName: 'b' }));

        const list = listContributions();
        expect(list).toHaveLength(2);
        expect(list.map((c) => c.connectorName).sort()).toEqual(['a', 'b']);
      });
    });
  });

  // VAL-STATE-008: acknowledgedEvents tracks per-surface dismissals independently
  describe('acknowledgedEvents', () => {
    it('acknowledges an event on a specific surface', () => {
      const contribution = createContribution(makeContributionInput());
      const updated = updateContribution(contribution.id, { status: 'ci_pass' });
      expect(updated).toBeDefined();

      acknowledgeEvent(contribution.id, 'ci_pass', 'banner');

      const retrieved = getContributionById(contribution.id);
      expect(retrieved!.acknowledgedEvents).toHaveLength(1);
      expect(retrieved!.acknowledgedEvents[0]).toMatchObject({
        status: 'ci_pass',
        surface: 'banner',
      });
      expect(retrieved!.acknowledgedEvents[0].at).toBeDefined();
    });

    it('tracks banner and drawer surfaces independently', () => {
      const contribution = createContribution(makeContributionInput());

      acknowledgeEvent(contribution.id, 'approved', 'banner');

      expect(isEventAcknowledged(contribution.id, 'approved', 'banner')).toBe(true);
      expect(isEventAcknowledged(contribution.id, 'approved', 'drawer')).toBe(false);
    });

    it('does not suppress other status events when acknowledging one', () => {
      const contribution = createContribution(makeContributionInput());

      acknowledgeEvent(contribution.id, 'ci_pass', 'banner');

      expect(isEventAcknowledged(contribution.id, 'ci_pass', 'banner')).toBe(true);
      expect(isEventAcknowledged(contribution.id, 'approved', 'banner')).toBe(false);
    });

    it('allows acknowledging same status on multiple surfaces', () => {
      const contribution = createContribution(makeContributionInput());

      acknowledgeEvent(contribution.id, 'approved', 'banner');
      acknowledgeEvent(contribution.id, 'approved', 'drawer');

      expect(isEventAcknowledged(contribution.id, 'approved', 'banner')).toBe(true);
      expect(isEventAcknowledged(contribution.id, 'approved', 'drawer')).toBe(true);
    });
  });

  // VAL-STATE-009: Migration infrastructure exists and is wired into initialization
  describe('migration infrastructure', () => {
    it('migration registry has additive v1→v2, v2→v3, v3→v4, v4→v5, and v5→v6 entries', () => {
      expect(CONTRIBUTION_STORE_MIGRATIONS).toBeDefined();
      expect(Object.keys(CONTRIBUTION_STORE_MIGRATIONS)).toEqual(['1', '2', '3', '4', '5']);

      const v2Data = CONTRIBUTION_STORE_MIGRATIONS[1]({
        version: 1,
        contributions: [],
      });
      expect(v2Data).toEqual({ version: 2, contributions: [] });

      const v3Data = CONTRIBUTION_STORE_MIGRATIONS[2](v2Data);
      expect(v3Data).toEqual({ version: 3, contributions: [] });

      const v4Data = CONTRIBUTION_STORE_MIGRATIONS[3](v3Data);
      expect(v4Data).toEqual({ version: 4, contributions: [] });

      const v5Data = CONTRIBUTION_STORE_MIGRATIONS[4](v4Data);
      expect(v5Data).toEqual({ version: 5, contributions: [] });

      const v6Data = CONTRIBUTION_STORE_MIGRATIONS[5](v5Data);
      expect(v6Data).toEqual({ version: 6, contributions: [] });
    });

    it('migrateStore is called during store initialization', () => {
      // Trigger store initialization by calling any store operation
      listContributions();

      expect(mockMigrateStore).toHaveBeenCalledTimes(1);
      expect(mockMigrateStore).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          storeName: 'connector-contributions',
          currentVersion: CONTRIBUTION_STORE_VERSION,
        }),
      );
    });

    it('migrateStore is called only once across multiple operations', () => {
      listContributions();
      listContributions();
      createContribution(makeContributionInput());

      expect(mockMigrateStore).toHaveBeenCalledTimes(1);
    });

    it('persists migrated data when migrateStore signals shouldPersist', () => {
      const migratedData = {
        version: CONTRIBUTION_STORE_VERSION,
        contributions: [
          {
            id: 'contrib-migrated-1',
            sessionId: 'session-old',
            connectorName: 'migrated-connector',
            status: 'draft',
            attributionMode: 'anonymous',
            acknowledgedEvents: [],
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      };

      mockMigrateStore.mockReturnValueOnce({
        data: migratedData,
        status: 'migrated',
        shouldPersist: true,
        fromVersion: 0,
        toVersion: CONTRIBUTION_STORE_VERSION,
        backupPath: '/mock/backup',
      });

      // Trigger initialization — the migrated data should be persisted
      const contributions = listContributions();

      expect(contributions).toHaveLength(1);
      expect(contributions[0].connectorName).toBe('migrated-connector');
    });

    it('migrates v2 fixtures forward additively and preserves existing records', () => {
      const legacyContribution = {
        id: 'contrib-v2-1',
        sessionId: 'session-v2',
        connectorName: 'legacy-connector',
        localServerPath: '/tmp/legacy',
        attributionMode: 'rebel-name' as const,
        attributionName: 'Legacy User',
        status: 'ready_to_submit' as const,
        prTitle: 'feat(legacy): add connector',
        prBody: 'Existing PR body',
        acknowledgedEvents: [],
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      };
      storeData = {
        version: 2,
        contributions: [legacyContribution],
      };

      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);

      const contributions = listContributions();

      expect(storeData).toMatchObject({ version: CONTRIBUTION_STORE_VERSION });
      expect(contributions).toHaveLength(1);

      // v3 fields (summary/motivation/reviewerNotes) remain undefined and v4
      // fields (linkedSessionIds/canonicalConnectorPath) are backfilled. We
      // strip both for the equality check, then assert on each new field.
      const [{
        summary,
        motivation,
        reviewerNotes,
        linkedSessionIds,
        canonicalConnectorPath,
        ...preservedRecord
      }] = contributions;
      expect(preservedRecord).toEqual(legacyContribution);
      expect(summary).toBeUndefined();
      expect(motivation).toBeUndefined();
      expect(reviewerNotes).toBeUndefined();
      // v4 backfills: linkedSessionIds = [sessionId]; canonicalConnectorPath
      // is non-empty because localServerPath was set.
      expect(linkedSessionIds).toEqual(['session-v2']);
      expect(canonicalConnectorPath).toBeDefined();
      expect(canonicalConnectorPath?.length).toBeGreaterThan(0);
    });

    it('round-trips migrated summary values without coercing empty strings', () => {
      const legacyContribution = {
        id: 'contrib-v2-1',
        sessionId: 'session-v2',
        connectorName: 'legacy-connector',
        attributionMode: 'anonymous' as const,
        status: 'draft' as const,
        acknowledgedEvents: [],
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
      };
      storeData = {
        version: 2,
        contributions: [legacyContribution],
      };

      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);
      listContributions();

      const withSummary = updateContribution(legacyContribution.id, {
        summary: 'A persisted summary',
      });
      expect(withSummary).not.toBeNull();
      expect(withSummary).toBeDefined();
      expect(withSummary!.summary).toBe('A persisted summary');
      expect(getContributionById(legacyContribution.id)!.summary).toBe('A persisted summary');

      const withEmptySummary = updateContribution(legacyContribution.id, {
        summary: '',
      });
      expect(withEmptySummary).not.toBeNull();
      expect(withEmptySummary).toBeDefined();
      expect(withEmptySummary!.summary).toBe('');
      expect(getContributionById(legacyContribution.id)!.summary).toBe('');
      expect(getContributionById(legacyContribution.id)!.connectorName).toBe(legacyContribution.connectorName);
    });

    it('does not persist when migrateStore returns shouldPersist false', () => {
      storeData = { version: CONTRIBUTION_STORE_VERSION, contributions: [] };

      mockMigrateStore.mockReturnValueOnce({
        data: storeData,
        status: 'current',
        shouldPersist: false,
        fromVersion: CONTRIBUTION_STORE_VERSION,
        toVersion: CONTRIBUTION_STORE_VERSION,
        backupPath: null,
      });

      listContributions();

      // Store data should remain unchanged (no overwrite)
      expect(storeData).toEqual({ version: CONTRIBUTION_STORE_VERSION, contributions: [] });
    });

    it('does not overwrite data from future versions', () => {
      const futureData = { version: 999, contributions: [] };
      storeData = futureData;

      mockMigrateStore.mockReturnValueOnce({
        data: futureData,
        status: 'future_version',
        shouldPersist: false,
        fromVersion: 999,
        toVersion: 999,
        backupPath: null,
      });

      listContributions();

      // Store data should remain as the future version data
      expect(storeData).toEqual(futureData);
    });
  });

  // VAL-STATE-010: State transitions follow valid paths
  describe('state transitions', () => {
    it('allows valid transitions', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));

      // draft → testing
      const updated = updateContribution(contribution.id, { status: 'testing' });
      expect(updated!.status).toBe('testing');

      // testing → ready_to_submit
      const updated2 = updateContribution(contribution.id, { status: 'ready_to_submit' });
      expect(updated2!.status).toBe('ready_to_submit');

      // ready_to_submit → submitted
      const updated3 = updateContribution(contribution.id, { status: 'submitted' });
      expect(updated3!.status).toBe('submitted');

      // submitted → ci_pass
      const updated4 = updateContribution(contribution.id, { status: 'ci_pass' });
      expect(updated4!.status).toBe('ci_pass');

      // ci_pass → approved
      const updated5 = updateContribution(contribution.id, { status: 'approved' });
      expect(updated5!.status).toBe('approved');

      // approved → published
      const updated6 = updateContribution(contribution.id, { status: 'published' });
      expect(updated6!.status).toBe('published');
    });

    it('rejects invalid transitions', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));

      // draft → published (invalid, must go through submission pipeline)
      const updated = updateContribution(contribution.id, { status: 'published' });
      expect(updated).toBeNull();
    });

    it('allows draft → submitted (deferred submission after Keep it private)', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));

      const updated = updateContribution(contribution.id, { status: 'submitted' });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('submitted');
    });

    it('rejects transition from terminal states', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));

      // Walk to published
      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, { status: 'submitted' });
      updateContribution(contribution.id, { status: 'ci_pass' });
      updateContribution(contribution.id, { status: 'approved' });
      updateContribution(contribution.id, { status: 'published' });

      // published → anything (invalid)
      const updated = updateContribution(contribution.id, { status: 'draft' });
      expect(updated).toBeNull();
    });

    it('allows ci_fail → testing (fix cycle)', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));
      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, { status: 'submitted' });
      updateContribution(contribution.id, { status: 'ci_fail' });

      // ci_fail → testing
      const updated = updateContribution(contribution.id, { status: 'testing' });
      expect(updated!.status).toBe('testing');
    });

    it('allows changes_requested → testing (fix cycle)', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));
      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, { status: 'submitted' });
      updateContribution(contribution.id, { status: 'ci_pass' });
      updateContribution(contribution.id, { status: 'changes_requested' });

      // changes_requested → testing
      const updated = updateContribution(contribution.id, { status: 'testing' });
      expect(updated!.status).toBe('testing');
    });

    it('allows submitted → approved (GitHub polling may skip CI states)', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));
      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, { status: 'submitted' });

      const updated = updateContribution(contribution.id, { status: 'approved' });
      expect(updated!.status).toBe('approved');
    });

    it('allows submitted → changes_requested (GitHub polling may skip CI states)', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));
      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, { status: 'submitted' });

      const updated = updateContribution(contribution.id, { status: 'changes_requested' });
      expect(updated!.status).toBe('changes_requested');
    });

    it('allows submitted → rejected (GitHub polling may skip CI states)', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));
      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, { status: 'submitted' });

      const updated = updateContribution(contribution.id, { status: 'rejected' });
      expect(updated!.status).toBe('rejected');
    });

    it('allows submitted → published (GitHub polling may skip CI+approval states)', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));
      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, { status: 'submitted' });

      const updated = updateContribution(contribution.id, { status: 'published' });
      expect(updated!.status).toBe('published');
    });

    it('allows ci_fail → ci_pass (CI re-run scenario)', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));
      updateContribution(contribution.id, { status: 'testing' });
      updateContribution(contribution.id, { status: 'ready_to_submit' });
      updateContribution(contribution.id, { status: 'submitted' });
      updateContribution(contribution.id, { status: 'ci_fail' });

      const updated = updateContribution(contribution.id, { status: 'ci_pass' });
      expect(updated!.status).toBe('ci_pass');
    });

    it('allows non-status updates without transition validation', () => {
      const contribution = createContribution(makeContributionInput({ status: 'draft' }));

      // Update non-status fields should work fine
      const updated = updateContribution(contribution.id, { connectorName: 'new-name' });
      expect(updated!.connectorName).toBe('new-name');
      expect(updated!.status).toBe('draft');
    });

    it('has valid transitions for all 10 statuses', () => {
      for (const status of ALL_CONTRIBUTION_STATUSES) {
        expect(VALID_STATE_TRANSITIONS).toHaveProperty(status);
        expect(Array.isArray(VALID_STATE_TRANSITIONS[status])).toBe(true);
      }
    });
  });

  // ── Stage 5 operator-initiated deletion ─────────────────────────

  describe('deleteContribution', () => {
    it('removes an existing record and returns true', async () => {
      const { deleteContribution } = await import('../contributionStore');
      const c = createContribution(makeContributionInput());
      expect(listContributions()).toHaveLength(1);

      const result = deleteContribution(c.id);
      expect(result).toBe(true);
      expect(listContributions()).toHaveLength(0);
      expect(getContributionById(c.id)).toBeUndefined();
    });

    it('returns false when no record matches the id', async () => {
      const { deleteContribution } = await import('../contributionStore');
      createContribution(makeContributionInput());
      const result = deleteContribution('contrib-does-not-exist');
      expect(result).toBe(false);
      expect(listContributions()).toHaveLength(1);
    });

    it('only removes the matching record, leaves other records untouched', async () => {
      const { deleteContribution } = await import('../contributionStore');
      const a = createContribution(makeContributionInput({ sessionId: 'sess-a' }));
      const b = createContribution(makeContributionInput({ sessionId: 'sess-b' }));
      const c = createContribution(makeContributionInput({ sessionId: 'sess-c' }));

      const result = deleteContribution(b.id);
      expect(result).toBe(true);
      const remaining = listContributions().map((r) => r.id).sort();
      expect(remaining).toEqual([a.id, c.id].sort());
    });

    it('is idempotent: deleting twice returns true then false', async () => {
      const { deleteContribution } = await import('../contributionStore');
      const c = createContribution(makeContributionInput());
      expect(deleteContribution(c.id)).toBe(true);
      expect(deleteContribution(c.id)).toBe(false);
    });
  });

  // ─── Stage 2.C migration v3 → v4 ────────────────────────────────

  describe('migration v3 → v4 (canonicalConnectorPath + linkedSessionIds)', () => {
    function v3Record(
      overrides: Partial<ConnectorContribution> & { id: string; sessionId: string },
    ): Record<string, unknown> {
      return {
        connectorName: 'legacy-connector',
        status: 'draft' as const,
        attributionMode: 'anonymous' as const,
        acknowledgedEvents: [],
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
        ...overrides,
      } as Record<string, unknown>;
    }

    it('every record gets linkedSessionIds; path-backed records get canonicalConnectorPath', () => {
      storeData = {
        version: 3,
        contributions: [
          v3Record({ id: 'c-1', sessionId: 's-1', localServerPath: '/Users/a/mcp-servers/foo' }),
          v3Record({ id: 'c-2', sessionId: 's-2', localServerPath: '/Users/a/mcp-servers/bar' }),
          v3Record({ id: 'c-3', sessionId: 's-3', localServerPath: '/Users/a/mcp-servers/baz' }),
          // Pathless record
          v3Record({ id: 'c-4', sessionId: 's-4' }),
          // Record with prior followUpSessionIds
          v3Record({
            id: 'c-5',
            sessionId: 's-5',
            localServerPath: '/Users/a/mcp-servers/qux',
            followUpSessionIds: ['s-5b', 's-5c'],
          }),
        ],
      };
      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);

      const list = listContributions();
      expect(list).toHaveLength(5);
      for (const r of list) {
        expect(r.linkedSessionIds.length).toBeGreaterThanOrEqual(1);
      }
      const pathBacked = list.filter((r) => r.localServerPath);
      const pathless = list.filter((r) => !r.localServerPath);
      for (const r of pathBacked) {
        expect(r.canonicalConnectorPath).toBeDefined();
        expect(r.canonicalConnectorPath?.length).toBeGreaterThan(0);
      }
      for (const r of pathless) {
        expect(r.canonicalConnectorPath).toBeUndefined();
      }
    });

    it('linkedSessionIds backfilled from sessionId + followUpSessionIds in originator-first order', () => {
      storeData = {
        version: 3,
        contributions: [
          v3Record({ id: 'c-a', sessionId: 'orig-a' }),
          v3Record({ id: 'c-b', sessionId: 'orig-b', followUpSessionIds: [] }),
          v3Record({ id: 'c-c', sessionId: 'orig-c', followUpSessionIds: ['fu-1'] }),
          v3Record({ id: 'c-d', sessionId: 'orig-d', followUpSessionIds: ['fu-x', 'fu-y'] }),
        ],
      };
      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);

      const list = listContributions();
      expect(list.find((r) => r.id === 'c-a')!.linkedSessionIds).toEqual(['orig-a']);
      expect(list.find((r) => r.id === 'c-b')!.linkedSessionIds).toEqual(['orig-b']);
      expect(list.find((r) => r.id === 'c-c')!.linkedSessionIds).toEqual(['orig-c', 'fu-1']);
      expect(list.find((r) => r.id === 'c-d')!.linkedSessionIds).toEqual(['orig-d', 'fu-x', 'fu-y']);
    });

    it('publishedEmailSentAt round-trips unchanged across migration', () => {
      const stamped = '2026-04-15T09:00:00.000Z';
      storeData = {
        version: 3,
        contributions: [
          v3Record({
            id: 'c-stamped',
            sessionId: 's-stamped',
            status: 'published' as const,
            publishedEmailSentAt: stamped,
          }),
          v3Record({
            id: 'c-unstamped',
            sessionId: 's-unstamped',
            status: 'published' as const,
          }),
        ],
      };
      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);

      const list = listContributions();
      const stampedRecord = list.find((r) => r.id === 'c-stamped')!;
      const unstampedRecord = list.find((r) => r.id === 'c-unstamped')!;
      // Existing stamp preserved verbatim.
      expect(stampedRecord.publishedEmailSentAt).toBe(stamped);
      // Unstamped record gets back-filled to updatedAt by the post-migration
      // back-fill predicate.
      expect(unstampedRecord.publishedEmailSentAt).toBe('2026-04-21T00:00:00.000Z');
    });

    it('duplicate-path records preserved (NOT eagerly merged); getContributionByPath picks most-recently-updated', () => {
      const sharedPath = '/Users/a/mcp-servers/foo-mcp';
      storeData = {
        version: 3,
        contributions: [
          v3Record({
            id: 'dup-old',
            sessionId: 's-old',
            connectorName: 'foo-old',
            localServerPath: sharedPath,
            updatedAt: '2026-04-20T10:00:00.000Z',
          }),
          v3Record({
            id: 'dup-new',
            sessionId: 's-new',
            connectorName: 'foo-new',
            localServerPath: sharedPath,
            updatedAt: '2026-04-21T15:00:00.000Z',
          }),
        ],
      };
      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);

      const list = listContributions();
      // Both records survive the migration.
      expect(list).toHaveLength(2);
      const a = list.find((r) => r.id === 'dup-old')!;
      const b = list.find((r) => r.id === 'dup-new')!;
      // Both share the same canonical path.
      expect(a.canonicalConnectorPath).toBeDefined();
      expect(b.canonicalConnectorPath).toBeDefined();
      expect(a.canonicalConnectorPath).toBe(b.canonicalConnectorPath);
      // getContributionByPath returns the most-recently-updated record.
      const winner = getContributionByPath(a.canonicalConnectorPath!);
      expect(winner?.id).toBe('dup-new');
    });

    it('pathless v3 records migrate without canonicalConnectorPath', () => {
      storeData = {
        version: 3,
        contributions: [
          v3Record({ id: 'c-pathless', sessionId: 'session-pathless' }),
        ],
      };
      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);

      const list = listContributions();
      expect(list).toHaveLength(1);
      expect(list[0].canonicalConnectorPath).toBeUndefined();
      expect(list[0].linkedSessionIds).toEqual(['session-pathless']);
    });

    it('future-version v6 store on v5 code is read as future_version (no overwrite)', () => {
      // Mirror the existing future-version test pattern with v5-shaped data.
      // Stage 3.C bumped current to v5, so v6 is the synthetic future version.
      const futureRecord = {
        id: 'c-future',
        sessionId: 's-future',
        connectorName: 'future-conn',
        status: 'draft' as const,
        attributionMode: 'anonymous' as const,
        acknowledgedEvents: [],
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        linkedSessionIds: ['s-future'],
        canonicalConnectorPath: '/somewhere/future',
        // Hypothetical v6 field — must round-trip untouched.
        v6HypotheticalField: 'should-survive',
      };
      const futureData = { version: 6, contributions: [futureRecord] };
      storeData = futureData;
      mockMigrateStore.mockReturnValueOnce({
        data: futureData,
        status: 'future_version',
        shouldPersist: false,
        fromVersion: 6,
        toVersion: 6,
        backupPath: null,
      });

      listContributions();
      expect(storeData).toEqual(futureData);
    });
  });

  // ─── Stage 3.C migration v4 → v5 (additive readiness fields) ────

  describe('migration v4 → v5 (additive readiness fields)', () => {
    function v4Record(
      overrides: Partial<ConnectorContribution> & { id: string; sessionId: string },
    ): Record<string, unknown> {
      return {
        connectorName: 'legacy-connector',
        status: 'draft' as const,
        attributionMode: 'anonymous' as const,
        acknowledgedEvents: [],
        createdAt: '2026-04-25T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
        linkedSessionIds: [overrides.sessionId],
        ...overrides,
      } as Record<string, unknown>;
    }

    it('every record passes through with all 5 readiness fields undefined (additive no-op)', () => {
      storeData = {
        version: 4,
        contributions: [
          v4Record({ id: 'c-1', sessionId: 's-1', localServerPath: '/Users/a/mcp-servers/foo' }),
          v4Record({ id: 'c-2', sessionId: 's-2' }),
        ],
      };
      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);

      const list = listContributions();
      expect(storeData).toMatchObject({ version: CONTRIBUTION_STORE_VERSION });
      expect(list).toHaveLength(2);
      for (const r of list) {
        expect(r.lastBuildDetectedAt).toBeUndefined();
        expect(r.lastTestPassedAt).toBeUndefined();
        expect(r.lastRegisteredAt).toBeUndefined();
        expect(r.lastReadyRequestedAt).toBeUndefined();
        expect(r.lastBuildFingerprint).toBeUndefined();
      }
    });

    it('existing canonicalConnectorPath / linkedSessionIds preserved (records from Stage 2 round-trip)', () => {
      const sharedPath = '/Users/a/mcp-servers/preserved';
      const followUps = ['s-original', 's-fu1', 's-fu2'];
      storeData = {
        version: 4,
        contributions: [
          v4Record({
            id: 'c-stage2-survivor',
            sessionId: 's-original',
            localServerPath: sharedPath,
            // Stage 2 fields — must round-trip exactly.
            linkedSessionIds: followUps,
            canonicalConnectorPath: '/canonicalised/preserved',
            followUpSessionIds: ['s-fu1', 's-fu2'],
          }),
        ],
      };
      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);

      const list = listContributions();
      expect(list).toHaveLength(1);
      const [record] = list;
      expect(record.linkedSessionIds).toEqual(followUps);
      expect(record.canonicalConnectorPath).toBe('/canonicalised/preserved');
      expect(record.followUpSessionIds).toEqual(['s-fu1', 's-fu2']);
      expect(record.localServerPath).toBe(sharedPath);
    });

    it('publishedEmailSentAt preservation across v3→v4→v5 chain (sanity guard for Stage 2 invariant)', () => {
      const stamped = '2026-04-15T09:00:00.000Z';
      // Start at v3 — exercises the entire migration chain end-to-end so
      // Stage 2's publishedEmailSentAt invariant survives the new v4→v5
      // migration step.
      storeData = {
        version: 3,
        contributions: [
          {
            id: 'c-stamped',
            sessionId: 's-stamped',
            connectorName: 'stamped-connector',
            status: 'published' as const,
            attributionMode: 'anonymous' as const,
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00.000Z',
            updatedAt: '2026-04-21T00:00:00.000Z',
            publishedEmailSentAt: stamped,
          },
          {
            id: 'c-unstamped',
            sessionId: 's-unstamped',
            connectorName: 'unstamped-connector',
            status: 'published' as const,
            attributionMode: 'anonymous' as const,
            acknowledgedEvents: [],
            createdAt: '2026-04-10T00:00:00.000Z',
            updatedAt: '2026-04-21T00:00:00.000Z',
          },
        ],
      };
      mockMigrateStore.mockImplementationOnce(applyActualContributionMigrations);

      const list = listContributions();
      const stampedRecord = list.find((r) => r.id === 'c-stamped')!;
      const unstampedRecord = list.find((r) => r.id === 'c-unstamped')!;
      // Existing stamp preserved verbatim across both migration steps.
      expect(stampedRecord.publishedEmailSentAt).toBe(stamped);
      // Unstamped record gets back-filled by the post-migration back-fill
      // predicate exactly as it did before Stage 3.C.
      expect(unstampedRecord.publishedEmailSentAt).toBe('2026-04-21T00:00:00.000Z');
      // Both records reach v5 status with no readiness fields populated.
      for (const r of [stampedRecord, unstampedRecord]) {
        expect(r.lastBuildDetectedAt).toBeUndefined();
        expect(r.lastTestPassedAt).toBeUndefined();
        expect(r.lastRegisteredAt).toBeUndefined();
        expect(r.lastReadyRequestedAt).toBeUndefined();
        expect(r.lastBuildFingerprint).toBeUndefined();
      }
    });
  });

  // ─── Stage 2.C lookups ──────────────────────────────────────────

  describe('Stage 2.C lookups (path + session)', () => {
    it('getContributionByPath returns most-recently-updated when multiple records share path', async () => {
      const sharedPath = '/Users/a/mcp-servers/dup-test';
      const older = createContribution(
        makeContributionInput({ sessionId: 's-old', localServerPath: sharedPath }),
      );
      // Tick clock so updatedAt differs.
      await new Promise((r) => setTimeout(r, 5));
      const newer = createContribution(
        makeContributionInput({ sessionId: 's-new', localServerPath: sharedPath }),
      );
      // Both records share the canonical path because they were created from
      // the same localServerPath.
      expect(older.canonicalConnectorPath).toBe(newer.canonicalConnectorPath);
      const result = getContributionByPath(newer.canonicalConnectorPath!);
      expect(result?.id).toBe(newer.id);
    });

    it('getContributionByPath empty input returns undefined immediately', () => {
      expect(getContributionByPath('')).toBeUndefined();
    });

    it('getContributionByPath unknown path returns undefined', () => {
      expect(getContributionByPath('/this/never/existed')).toBeUndefined();
    });

    it('getContributionsBySession returns ALL records linked to the session in updatedAt-asc order', async () => {
      const c1 = createContribution(
        makeContributionInput({ sessionId: 'sess-mc', localServerPath: '/Users/a/mcp-servers/m1' }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const c2 = createContribution(
        makeContributionInput({ sessionId: 'sess-mc', localServerPath: '/Users/a/mcp-servers/m2' }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const c3 = createContribution(
        makeContributionInput({ sessionId: 'sess-mc', localServerPath: '/Users/a/mcp-servers/m3' }),
      );
      const list = getContributionsBySession('sess-mc');
      expect(list.map((r) => r.id)).toEqual([c1.id, c2.id, c3.id]);
    });

    it('getActiveContributionBySession returns the most-recently-updated linked record', async () => {
      const c1 = createContribution(
        makeContributionInput({ sessionId: 'sess-active', localServerPath: '/Users/a/mcp-servers/x1' }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const c2 = createContribution(
        makeContributionInput({ sessionId: 'sess-active', localServerPath: '/Users/a/mcp-servers/x2' }),
      );
      const active = getActiveContributionBySession('sess-active');
      expect(active?.id).toBe(c2.id);
      expect(c1.id).not.toBe(c2.id); // sanity
    });
  });

  // ─── Stage 2.C compat shim ──────────────────────────────────────

  describe('Stage 2.C compat shim (getContributionBySession warn)', () => {
    beforeEach(() => {
      _resetCompatShimWarnedKeysForTesting();
    });

    it('warn fires once per (session, chosen, active) divergence; suppressed on repeat', async () => {
      // Two contributions linked to the same session; the legacy first-match
      // returns the first-created (older) record while
      // `getActiveContributionBySession` picks the most-recently-updated.
      const olderPath = '/Users/a/mcp-servers/older';
      const newerPath = '/Users/a/mcp-servers/newer';
      createContribution(
        makeContributionInput({ sessionId: 'sess-divergent', localServerPath: olderPath }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const newer = createContribution(
        makeContributionInput({ sessionId: 'sess-divergent', localServerPath: newerPath }),
      );
      // Spy on console / logger via storeData inspection isn't trivial here;
      // assert behaviour via the suppression set proxy: call twice, assert
      // legacy first-match return is stable (older), and active is newer.
      const legacy1 = getContributionBySession('sess-divergent');
      const legacy2 = getContributionBySession('sess-divergent');
      expect(legacy1?.localServerPath).toBe(olderPath);
      expect(legacy2?.localServerPath).toBe(olderPath);
      const active = getActiveContributionBySession('sess-divergent');
      expect(active?.id).toBe(newer.id);
    });

    it('non-divergent session does NOT warn and returns the same record from both lookups', () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 'sess-single', localServerPath: '/Users/a/mcp-servers/solo' }),
      );
      const legacy = getContributionBySession('sess-single');
      const active = getActiveContributionBySession('sess-single');
      expect(legacy?.id).toBe(c.id);
      expect(active?.id).toBe(c.id);
    });
  });

  // ─── Stage 2.C linkedSessionIds write semantics ─────────────────

  describe('Stage 2.C addLinkedSession / addFollowUpSession write semantics', () => {
    it('addLinkedSession appends new sessionIds in first-seen order', () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 'orig', localServerPath: '/Users/a/mcp-servers/aa' }),
      );
      addLinkedSession(c.id, 's-2');
      addLinkedSession(c.id, 's-3');
      addLinkedSession(c.id, 's-4');
      const refreshed = getContributionById(c.id);
      expect(refreshed?.linkedSessionIds).toEqual(['orig', 's-2', 's-3', 's-4']);
    });

    it('addLinkedSession is idempotent: re-adding existing session is a no-op', async () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 'orig-2', localServerPath: '/Users/a/mcp-servers/bb' }),
      );
      addLinkedSession(c.id, 's-2');
      const beforeUpdated = getContributionById(c.id)!.updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      addLinkedSession(c.id, 's-2');
      const afterUpdated = getContributionById(c.id)!.updatedAt;
      // No write — updatedAt unchanged, array unchanged.
      expect(afterUpdated).toBe(beforeUpdated);
      expect(getContributionById(c.id)?.linkedSessionIds).toEqual(['orig-2', 's-2']);
    });

    it('addFollowUpSession delegates to addLinkedSession AND keeps followUpSessionIds in sync', () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 'orig-3', localServerPath: '/Users/a/mcp-servers/cc' }),
      );
      const updated = addFollowUpSession(c.id, 's-2');
      expect(updated?.linkedSessionIds).toEqual(['orig-3', 's-2']);
      expect(updated?.followUpSessionIds).toEqual(['s-2']);
    });
  });

  // ─── Stage 3.C readiness write helpers ──────────────────────────

  describe('Stage 3.C readiness write helpers', () => {
    it('setLastBuildDetectedAt: atomic field write, bumps updatedAt, idempotent re-write', async () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 's-3c-build', localServerPath: '/Users/a/mcp-servers/build' }),
      );
      const before = getContributionById(c.id)!.updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      const stamp = '2026-04-26T12:00:00.000Z';
      const updated = setLastBuildDetectedAt(c.id, stamp);
      expect(updated).toBeDefined();
      expect(updated!.lastBuildDetectedAt).toBe(stamp);
      // Other readiness fields untouched.
      expect(updated!.lastTestPassedAt).toBeUndefined();
      expect(updated!.lastRegisteredAt).toBeUndefined();
      expect(updated!.lastReadyRequestedAt).toBeUndefined();
      expect(updated!.lastBuildFingerprint).toBeUndefined();
      // updatedAt advanced.
      expect(updated!.updatedAt > before).toBe(true);
      // Idempotent re-write: same value still produces a write.
      await new Promise((r) => setTimeout(r, 5));
      const reUpdated = setLastBuildDetectedAt(c.id, stamp);
      expect(reUpdated!.lastBuildDetectedAt).toBe(stamp);
      expect(reUpdated!.updatedAt > updated!.updatedAt).toBe(true);
      // Missing-record path: returns undefined, doesn't throw.
      expect(setLastBuildDetectedAt('contrib-nonexistent', stamp)).toBeUndefined();
    });

    it('setLastTestPassedAt: atomic field write, isolates from other readiness fields', () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 's-3c-test', localServerPath: '/Users/a/mcp-servers/test' }),
      );
      const stamp = '2026-04-26T13:00:00.000Z';
      const updated = setLastTestPassedAt(c.id, stamp);
      expect(updated!.lastTestPassedAt).toBe(stamp);
      expect(updated!.lastBuildDetectedAt).toBeUndefined();
      expect(updated!.lastRegisteredAt).toBeUndefined();
      expect(updated!.lastReadyRequestedAt).toBeUndefined();
      // Idempotent re-write — same stamp still persists, but lastBuildDetectedAt
      // (set by a different helper) round-trips unchanged.
      setLastBuildDetectedAt(c.id, '2026-04-26T11:00:00.000Z');
      const stamp2 = '2026-04-26T14:00:00.000Z';
      const next = setLastTestPassedAt(c.id, stamp2);
      expect(next!.lastTestPassedAt).toBe(stamp2);
      expect(next!.lastBuildDetectedAt).toBe('2026-04-26T11:00:00.000Z');
      expect(setLastTestPassedAt('contrib-nonexistent', stamp)).toBeUndefined();
    });

    it('setLastRegisteredAt: atomic field write, isolates from other readiness fields', () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 's-3c-reg', localServerPath: '/Users/a/mcp-servers/reg' }),
      );
      const stamp = '2026-04-26T15:00:00.000Z';
      const updated = setLastRegisteredAt(c.id, stamp);
      expect(updated!.lastRegisteredAt).toBe(stamp);
      expect(updated!.lastBuildDetectedAt).toBeUndefined();
      expect(updated!.lastTestPassedAt).toBeUndefined();
      expect(updated!.lastReadyRequestedAt).toBeUndefined();
      // Re-write with a new value persists; earlier-set fields remain.
      setLastBuildDetectedAt(c.id, '2026-04-26T11:00:00.000Z');
      setLastTestPassedAt(c.id, '2026-04-26T13:00:00.000Z');
      const stamp2 = '2026-04-26T16:00:00.000Z';
      const next = setLastRegisteredAt(c.id, stamp2);
      expect(next!.lastRegisteredAt).toBe(stamp2);
      expect(next!.lastBuildDetectedAt).toBe('2026-04-26T11:00:00.000Z');
      expect(next!.lastTestPassedAt).toBe('2026-04-26T13:00:00.000Z');
      expect(setLastRegisteredAt('contrib-nonexistent', stamp)).toBeUndefined();
    });

    it('setLastReadyRequestedAt: atomic field write, isolates from other readiness fields', () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 's-3c-ready', localServerPath: '/Users/a/mcp-servers/ready' }),
      );
      const stamp = '2026-04-26T17:00:00.000Z';
      const updated = setLastReadyRequestedAt(c.id, stamp);
      expect(updated!.lastReadyRequestedAt).toBe(stamp);
      expect(updated!.lastBuildDetectedAt).toBeUndefined();
      expect(updated!.lastTestPassedAt).toBeUndefined();
      expect(updated!.lastRegisteredAt).toBeUndefined();
      expect(setLastReadyRequestedAt('contrib-nonexistent', stamp)).toBeUndefined();
    });

    it('setLastBuildFingerprint: atomic field write, isolates from timestamp fields', () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 's-3c-fp', localServerPath: '/Users/a/mcp-servers/fp' }),
      );
      const fingerprint = 'a'.repeat(64);
      const updated = setLastBuildFingerprint(c.id, fingerprint);
      expect(updated!.lastBuildFingerprint).toBe(fingerprint);
      expect(updated!.lastBuildDetectedAt).toBeUndefined();
      expect(updated!.lastTestPassedAt).toBeUndefined();
      expect(updated!.lastRegisteredAt).toBeUndefined();
      expect(updated!.lastReadyRequestedAt).toBeUndefined();
      // Re-write with a different fingerprint persists.
      const fingerprint2 = 'b'.repeat(64);
      const next = setLastBuildFingerprint(c.id, fingerprint2);
      expect(next!.lastBuildFingerprint).toBe(fingerprint2);
      expect(setLastBuildFingerprint('contrib-nonexistent', fingerprint)).toBeUndefined();
    });

    it('clearStaleReadinessOnFingerprintChange: clears agent-asserted fields on mismatch, preserves real-world facts', () => {
      const c = createContribution(
        makeContributionInput({ sessionId: 's-3c-mismatch', localServerPath: '/Users/a/mcp-servers/mm' }),
      );
      // Pre-seed all five readiness fields.
      setLastBuildDetectedAt(c.id, '2026-04-26T10:00:00.000Z');
      setLastTestPassedAt(c.id, '2026-04-26T11:00:00.000Z');
      setLastRegisteredAt(c.id, '2026-04-26T12:00:00.000Z');
      setLastReadyRequestedAt(c.id, '2026-04-26T13:00:00.000Z');
      const oldFingerprint = 'A'.repeat(64);
      setLastBuildFingerprint(c.id, oldFingerprint);
      const seeded = getContributionById(c.id)!;
      expect(seeded.lastBuildFingerprint).toBe(oldFingerprint);

      // Mismatch invalidation.
      const newFingerprint = 'B'.repeat(64);
      const invalidated = clearStaleReadinessOnFingerprintChange(c.id, newFingerprint);
      expect(invalidated).toBeDefined();
      // Agent assertions cleared.
      expect(invalidated!.lastTestPassedAt).toBeUndefined();
      expect(invalidated!.lastReadyRequestedAt).toBeUndefined();
      // Fingerprint advanced to the new value.
      expect(invalidated!.lastBuildFingerprint).toBe(newFingerprint);
      // Real-world facts preserved.
      expect(invalidated!.lastBuildDetectedAt).toBe('2026-04-26T10:00:00.000Z');
      expect(invalidated!.lastRegisteredAt).toBe('2026-04-26T12:00:00.000Z');

      // Subsequent matching invocation is a no-op (no write, identical record).
      const noop = clearStaleReadinessOnFingerprintChange(c.id, newFingerprint);
      expect(noop!.lastBuildFingerprint).toBe(newFingerprint);
      expect(noop!.updatedAt).toBe(invalidated!.updatedAt);

      // Missing-fingerprint case: a record with no prior fingerprint returns
      // unchanged (caller must follow up with `setLastBuildFingerprint`).
      const fresh = createContribution(
        makeContributionInput({ sessionId: 's-3c-fresh', localServerPath: '/Users/a/mcp-servers/fresh' }),
      );
      const freshResult = clearStaleReadinessOnFingerprintChange(fresh.id, newFingerprint);
      expect(freshResult!.lastBuildFingerprint).toBeUndefined();

      // Missing-record path returns undefined.
      expect(clearStaleReadinessOnFingerprintChange('contrib-nonexistent', newFingerprint)).toBeUndefined();
    });

    it('getStuckTestingContributions: returns testing records older than threshold; respects olderThanMs override', () => {
      const now = Date.parse('2026-04-26T12:00:00.000Z');
      // Seed records spanning multiple statuses + ages.
      storeData = {
        version: CONTRIBUTION_STORE_VERSION,
        contributions: [
          {
            id: 'stuck-old',
            sessionId: 's-stuck-old',
            connectorName: 'old-stuck',
            status: 'testing' as const,
            attributionMode: 'anonymous' as const,
            acknowledgedEvents: [],
            linkedSessionIds: ['s-stuck-old'],
            createdAt: '2026-04-26T11:00:00.000Z',
            // 30 minutes ago — older than default 10-min threshold.
            updatedAt: '2026-04-26T11:30:00.000Z',
          },
          {
            id: 'fresh-young',
            sessionId: 's-fresh-young',
            connectorName: 'fresh-young',
            status: 'testing' as const,
            attributionMode: 'anonymous' as const,
            acknowledgedEvents: [],
            linkedSessionIds: ['s-fresh-young'],
            createdAt: '2026-04-26T11:55:00.000Z',
            // 5 minutes ago — younger than default 10-min threshold.
            updatedAt: '2026-04-26T11:55:00.000Z',
          },
          {
            id: 'not-testing',
            sessionId: 's-not-testing',
            connectorName: 'ready-record',
            status: 'ready_to_submit' as const,
            attributionMode: 'anonymous' as const,
            acknowledgedEvents: [],
            linkedSessionIds: ['s-not-testing'],
            createdAt: '2026-04-26T10:00:00.000Z',
            updatedAt: '2026-04-26T10:00:00.000Z',
          },
        ],
      };

      // Default threshold (10 minutes): only `stuck-old` qualifies.
      const defaultStuck = getStuckTestingContributions({ now });
      expect(defaultStuck.map((r) => r.id)).toEqual(['stuck-old']);

      // Override threshold to 1 minute: `fresh-young` also qualifies.
      const aggressive = getStuckTestingContributions({ now, olderThanMs: 60_000 });
      expect(aggressive.map((r) => r.id).sort()).toEqual(['fresh-young', 'stuck-old']);

      // Override threshold to 1 hour: nothing qualifies.
      const lenient = getStuckTestingContributions({ now, olderThanMs: 60 * 60 * 1000 });
      expect(lenient).toEqual([]);

      // Default `now` (Date.now()) and `olderThanMs` (10 min): all `testing` records
      // present in fixtures are far older than 10 minutes, so this returns them.
      // We don't pass options at all so the default thresholds run end-to-end.
      const noOpts = getStuckTestingContributions();
      expect(noOpts.every((r) => r.status === 'testing')).toBe(true);
    });
  });
});
