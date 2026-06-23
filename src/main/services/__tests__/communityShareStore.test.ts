import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { CommunityShareEligibility, CommunitySharePreview } from '@shared/types';

// Stub logger
const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

const setupModule = async () => {
  vi.resetModules();
  await initTestPlatformConfig();

  vi.doMock('electron-store', () => {
    class MemoryStore<T extends Record<string, unknown>> {
      private data: T;
      constructor(options: { defaults: T }) {
        this.data = structuredClone(options.defaults);
      }
      get<K extends keyof T>(key: K): T[K] {
        return this.data[key];
      }
      set<K extends keyof T>(key: K, value: T[K]): void {
        this.data[key] = value;
      }
      get store(): T {
        return this.data;
      }
    }
    return { default: MemoryStore };
  });

  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
  }));

  return await import('../communityShareStore');
};

const makeEligibility = (sessionId: string): CommunityShareEligibility => ({
  sessionId,
  timeSavedMinutes: 350,
  timeSavedFormatted: '5.8h',
  impact: 'high',
  quip: 'Not bad for a Tuesday.',
  evaluatedAt: Date.now(),
});

const makePreview = (sessionId: string): CommunitySharePreview => ({
  sessionId,
  title: `How I saved ~5h on meeting prep`,
  body: 'I used Rebel to automate research for a client meeting...',
  timeSavedMinutes: 350,
  timeSavedFormatted: '5.8h',
  impact: 'high',
  quip: 'Not bad for a Tuesday.',
  composedAt: Date.now(),
});

describe('communityShareStore', () => {
  beforeEach(() => {
    Object.values(stubLogger).forEach((fn) => (fn as Mock).mockClear());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Opt-Out
  // ─────────────────────────────────────────────────────────────────────────

  describe('opt-out', () => {
    it('isOptedOut() returns false initially', async () => {
      const store = await setupModule();

      expect(store.isOptedOut()).toBe(false);
    });

    it('setOptedOut(true) makes isOptedOut() return true', async () => {
      const store = await setupModule();

      store.setOptedOut(true);

      expect(store.isOptedOut()).toBe(true);
    });

    it('setOptedOut(false) makes isOptedOut() return false after being true', async () => {
      const store = await setupModule();

      store.setOptedOut(true);
      expect(store.isOptedOut()).toBe(true);

      store.setOptedOut(false);
      expect(store.isOptedOut()).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Daily Limit
  // ─────────────────────────────────────────────────────────────────────────

  describe('daily limit', () => {
    it('getDailyCount() returns 0 initially', async () => {
      const store = await setupModule();

      expect(store.getDailyCount()).toBe(0);
    });

    it('incrementDailyCount() increases count', async () => {
      const store = await setupModule();

      store.incrementDailyCount();
      expect(store.getDailyCount()).toBe(1);

      store.incrementDailyCount();
      expect(store.getDailyCount()).toBe(2);
    });

    it('getDailyCount() resets when date changes', async () => {
      const store = await setupModule();

      // Increment today
      store.incrementDailyCount();
      expect(store.getDailyCount()).toBe(1);

      // Mock Date to simulate tomorrow
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const originalDateString = Date.prototype.toDateString;
      vi.spyOn(Date.prototype, 'toDateString').mockReturnValue(tomorrow.toDateString());

      // Count should reset to 0 for the new day
      expect(store.getDailyCount()).toBe(0);

      // Restore
      Date.prototype.toDateString = originalDateString;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Session Evaluation Tracking
  // ─────────────────────────────────────────────────────────────────────────

  describe('session evaluation tracking', () => {
    it('isSessionEvaluated() returns false for unknown sessions', async () => {
      const store = await setupModule();

      expect(store.isSessionEvaluated('unknown-session')).toBe(false);
    });

    it('markSessionEvaluated() makes isSessionEvaluated() return true', async () => {
      const store = await setupModule();

      store.markSessionEvaluated('session-1');

      expect(store.isSessionEvaluated('session-1')).toBe(true);
    });

    it('does not duplicate session IDs', async () => {
      const store = await setupModule();

      store.markSessionEvaluated('session-1');
      store.markSessionEvaluated('session-1');

      // Still returns true; no crash, no duplicate
      expect(store.isSessionEvaluated('session-1')).toBe(true);
    });

    it('bounded to last 100 sessions (oldest evicted first)', async () => {
      const store = await setupModule();

      // Add 101 sessions
      for (let i = 0; i < 101; i++) {
        store.markSessionEvaluated(`session-${i}`);
      }

      // First session should be evicted
      expect(store.isSessionEvaluated('session-0')).toBe(false);

      // Last session should be present
      expect(store.isSessionEvaluated('session-100')).toBe(true);

      // Session at index 1 should still be present (kept in the last 100)
      expect(store.isSessionEvaluated('session-1')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Eligibility Storage
  // ─────────────────────────────────────────────────────────────────────────

  describe('eligibility storage', () => {
    it('storeEligibility() and getEligibility() round-trip', async () => {
      const store = await setupModule();
      const eligibility = makeEligibility('session-1');

      store.storeEligibility(eligibility);
      const retrieved = store.getEligibility('session-1');

      expect(retrieved).toBeDefined();
      expect(retrieved!.sessionId).toBe('session-1');
      expect(retrieved!.timeSavedMinutes).toBe(350);
      expect(retrieved!.impact).toBe('high');
    });

    it('getEligibility() returns undefined for unknown session', async () => {
      const store = await setupModule();

      expect(store.getEligibility('nonexistent')).toBeUndefined();
    });

    it('getAllPendingEligible() returns stored eligibilities', async () => {
      const store = await setupModule();

      store.storeEligibility(makeEligibility('session-1'));
      store.storeEligibility(makeEligibility('session-2'));

      const all = store.getAllPendingEligible();

      expect(all).toHaveLength(2);
      expect(all.map((e) => e.sessionId).sort()).toEqual(['session-1', 'session-2']);
    });

    it('getAllPendingEligible() returns empty array initially', async () => {
      const store = await setupModule();

      expect(store.getAllPendingEligible()).toHaveLength(0);
    });

    it('clearSessionData() removes eligibility for a session', async () => {
      const store = await setupModule();

      store.storeEligibility(makeEligibility('session-1'));
      store.storeEligibility(makeEligibility('session-2'));

      store.clearSessionData('session-1');

      expect(store.getEligibility('session-1')).toBeUndefined();
      expect(store.getEligibility('session-2')).toBeDefined();
    });

    it('dismissEligibility() removes eligibility', async () => {
      const store = await setupModule();

      store.storeEligibility(makeEligibility('session-1'));
      expect(store.getEligibility('session-1')).toBeDefined();

      store.dismissEligibility('session-1');

      expect(store.getEligibility('session-1')).toBeUndefined();
    });

    it('dismissEligibility() does not affect other sessions', async () => {
      const store = await setupModule();

      store.storeEligibility(makeEligibility('session-1'));
      store.storeEligibility(makeEligibility('session-2'));

      store.dismissEligibility('session-1');

      expect(store.getEligibility('session-2')).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Preview Storage
  // ─────────────────────────────────────────────────────────────────────────

  describe('preview storage', () => {
    it('storePreview() and getPreview() round-trip', async () => {
      const store = await setupModule();
      const preview = makePreview('session-1');

      store.storePreview(preview);
      const retrieved = store.getPreview('session-1');

      expect(retrieved).toBeDefined();
      expect(retrieved!.sessionId).toBe('session-1');
      expect(retrieved!.title).toContain('How I saved');
    });

    it('getPreview() returns undefined for unknown session', async () => {
      const store = await setupModule();

      expect(store.getPreview('nonexistent')).toBeUndefined();
    });

    it('clearSessionData() removes preview for a session', async () => {
      const store = await setupModule();

      store.storePreview(makePreview('session-1'));
      store.storeEligibility(makeEligibility('session-1'));

      store.clearSessionData('session-1');

      expect(store.getPreview('session-1')).toBeUndefined();
      expect(store.getEligibility('session-1')).toBeUndefined();
    });

    it('clearSessionData() removes session from evaluatedSessionIds so it can be re-evaluated', async () => {
      const store = await setupModule();

      store.markSessionEvaluated('session-1');
      store.markSessionEvaluated('session-2');
      expect(store.isSessionEvaluated('session-1')).toBe(true);
      expect(store.isSessionEvaluated('session-2')).toBe(true);

      store.clearSessionData('session-1');

      expect(store.isSessionEvaluated('session-1')).toBe(false);
      expect(store.isSessionEvaluated('session-2')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Future-version read-only guard (F3 first-touch protection)
  // ─────────────────────────────────────────────────────────────────────────

  describe('future-version read-only guard', () => {
    // A store factory whose on-disk state is from a FUTURE app version. It
    // records every write so a test can assert the file was never mutated.
    type State = Record<string, unknown>;
    const seedFutureVersionModule = async (seeded: State) => {
      vi.resetModules();
      await initTestPlatformConfig();

      const data: State = structuredClone(seeded);
      const writes: Array<{ key: string; value: unknown }> = [];

      const store = {
        get<K extends keyof State>(key: K, def?: State[K]): State[K] | undefined {
          const v = data[key];
          return v !== undefined ? v : def;
        },
        set<K extends keyof State>(key: K, value: State[K]): void {
          writes.push({ key: String(key), value });
          data[key] = value;
        },
        get store(): State {
          return data;
        },
      };

      const { setStoreFactory } = await import('@core/storeFactory');
      setStoreFactory(() => store as unknown as never);
      vi.doMock('@core/logger', () => ({ createScopedLogger: () => stubLogger }));

      const mod = await import('../communityShareStore');
      return { mod, writes, data };
    };

    const futureVersionSeed = (): State => ({
      // version 2 is from the future relative to the store's version (1)
      version: 2,
      optedOut: false,
      evaluatedSessionIds: ['existing-session'],
      eligibleSessions: {},
      previews: {},
      dailyCount: 3,
      dailyCountDate: new Date().toDateString(),
    });

    it('blocks a FIRST-TOUCH setOptedOut write against a future-version store', async () => {
      const { mod, writes, data } = await seedFutureVersionModule(futureVersionSeed());

      // The very first API call is a writer — no prior read forced init.
      mod.setOptedOut(true);

      // Write must be blocked: read-only honored, on-disk state untouched.
      expect(writes).toHaveLength(0);
      expect(data.optedOut).toBe(false);
      expect(mod.isOptedOut()).toBe(false);
    });

    it('blocks first-touch writers (markSessionEvaluated, incrementDailyCount, storeEligibility) without mutating disk', async () => {
      // markSessionEvaluated
      {
        const { mod, writes, data } = await seedFutureVersionModule(futureVersionSeed());
        mod.markSessionEvaluated('new-session');
        expect(writes).toHaveLength(0);
        expect(data.evaluatedSessionIds).toEqual(['existing-session']);
      }
      // incrementDailyCount
      {
        const { mod, writes, data } = await seedFutureVersionModule(futureVersionSeed());
        mod.incrementDailyCount();
        expect(writes).toHaveLength(0);
        expect(data.dailyCount).toBe(3);
      }
      // storeEligibility
      {
        const { mod, writes, data } = await seedFutureVersionModule(futureVersionSeed());
        mod.storeEligibility(makeEligibility('new-session'));
        expect(writes).toHaveLength(0);
        expect(data.eligibleSessions).toEqual({});
      }
    });

    it('getDailyCount() does NOT reset/persist on a future-version store even when the date is stale', async () => {
      const seed = futureVersionSeed();
      seed.dailyCount = 5;
      seed.dailyCountDate = 'Thu Jan 01 1970'; // deliberately stale
      const { mod, writes, data } = await seedFutureVersionModule(seed);

      // First touch is the date-reset path inside getDailyCount.
      expect(mod.getDailyCount()).toBe(0); // reports reset value...
      expect(writes).toHaveLength(0); // ...but never persists it
      expect(data.dailyCount).toBe(5);
      expect(data.dailyCountDate).toBe('Thu Jan 01 1970');
    });

    it('still allows writes on a current-version store (guard is version-gated, not always-on)', async () => {
      const seed = futureVersionSeed();
      seed.version = 1; // current version
      const { mod, writes, data } = await seedFutureVersionModule(seed);

      mod.setOptedOut(true);

      expect(writes).toHaveLength(1);
      expect(data.optedOut).toBe(true);
    });
  });
});
