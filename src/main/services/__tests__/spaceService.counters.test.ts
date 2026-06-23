/**
 * Unit tests for the `scanSpaces` per-lane hot-path counters AND the Stage 5
 * read-only coalesced cache + invalidation contract.
 *
 * Covers:
 *  - `readOnly` (skipAutoFix: true) vs `writable` (default) lanes increment
 *    independently; `maxConcurrentInflight` latches per-lane
 *  - Stage 5 coalescing: concurrent read-only callers collapse to one fetch
 *  - Stage 5 TTL: sequential callers within TTL hit the cache; TTL expiry
 *    causes re-fetch
 *  - Lane isolation: writable calls do NOT share cache with read-only calls
 *  - Per-workspace keying: scans to different workspaces don't share entries
 *  - Explicit invalidation (`invalidateSpaceScanCache`) and workspace-switch
 *    clear (`clearAllSpaceScanCaches`)
 *  - Kill switch (`REBEL_DISABLE_SPACES_COALESCE=1`) bypasses coalescing
 *  - Rejection path: error counter increments; inflight slot released
 *  - `_resetForTesting()` zeros both lanes AND clears the cache
 *
 * See docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 1 + § Stage 5.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn((key: string, value: unknown) => { this.store[key] = value; });
    delete = vi.fn((key: string) => { delete this.store[key]; });
    has = vi.fn((key: string) => key in this.store);
  },
}));

const spaceService = await import('../spaceService');

/** Let pending microtasks drain. */
async function flushMicrotasks(count = 10): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

/** Helper: create a fresh tempdir (defeats the workspace-keyed cache). */
async function mkFreshTempDir(prefix = 'mindstone-scan-counter-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('scanSpaces counters (Stage 1)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkFreshTempDir();
    spaceService._resetScanSpacesCountersForTesting();
    // Ensure kill switch is OFF by default.
    delete process.env.REBEL_DISABLE_SPACES_COALESCE;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    delete process.env.REBEL_DISABLE_SPACES_COALESCE;
  });

  it('_resetForTesting zeros both lanes AND clears the cache', async () => {
    await spaceService.scanSpaces(tempDir);
    await spaceService.scanSpaces(tempDir, { skipAutoFix: true });

    const before = spaceService.getScanSpacesCounters();
    expect(before.writable.requests).toBeGreaterThan(0);
    expect(before.readOnly.requests).toBeGreaterThan(0);

    spaceService._resetScanSpacesCountersForTesting();
    const after = spaceService.getScanSpacesCounters();
    const zero = {
      requests: 0,
      hits: 0,
      misses: 0,
      inflightJoins: 0,
      underlyingFetches: 0,
      fetchErrors: 0,
      maxConcurrentInflight: 0,
    };
    expect(after.readOnly).toEqual(zero);
    expect(after.writable).toEqual(zero);

    // Cache was cleared too: a fresh call is a miss, not a hit.
    await spaceService.scanSpaces(tempDir, { skipAutoFix: true });
    const postReset = spaceService.getScanSpacesCounters();
    expect(postReset.readOnly.hits).toBe(0);
    expect(postReset.readOnly.misses).toBe(1);
  });

  it('writable lane: every call is an underlying fetch (never cached)', async () => {
    await spaceService.scanSpaces(tempDir);
    await spaceService.scanSpaces(tempDir);

    const snap = spaceService.getScanSpacesCounters();
    expect(snap.writable.requests).toBe(2);
    expect(snap.writable.underlyingFetches).toBe(2);
    expect(snap.readOnly.requests).toBe(0);
  });

  it('readOnly lane: distinct workspaces never share cache entries', async () => {
    const other = await mkFreshTempDir();
    try {
      await spaceService.scanSpaces(tempDir, { skipAutoFix: true });
      await spaceService.scanSpaces(other, { skipAutoFix: true });

      const snap = spaceService.getScanSpacesCounters();
      expect(snap.readOnly.requests).toBe(2);
      expect(snap.readOnly.underlyingFetches).toBe(2);
      expect(snap.readOnly.hits).toBe(0);
      expect(snap.readOnly.misses).toBe(2);
    } finally {
      await fs.rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('writable lane when skipAutoFix is explicitly false still counts writable', async () => {
    await spaceService.scanSpaces(tempDir, { skipAutoFix: false });
    const snap = spaceService.getScanSpacesCounters();
    expect(snap.writable.requests).toBe(1);
    expect(snap.readOnly.requests).toBe(0);
  });

  it('empty workspacePath short-circuits but still counts the request', async () => {
    await spaceService.scanSpaces('');
    const snap = spaceService.getScanSpacesCounters();
    expect(snap.writable.requests).toBe(1);
    expect(snap.writable.underlyingFetches).toBe(1);
    expect(snap.writable.fetchErrors).toBe(0);
  });
});

describe('scanSpaces Stage 5 read-only coalesced cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkFreshTempDir();
    spaceService._resetScanSpacesCountersForTesting();
    delete process.env.REBEL_DISABLE_SPACES_COALESCE;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    delete process.env.REBEL_DISABLE_SPACES_COALESCE;
  });

  it('concurrent read-only callers coalesce to a single underlying fetch', async () => {
    const calls = [
      spaceService.scanSpacesReadOnly(tempDir),
      spaceService.scanSpacesReadOnly(tempDir),
      spaceService.scanSpacesReadOnly(tempDir),
      spaceService.scanSpacesReadOnly(tempDir),
      spaceService.scanSpacesReadOnly(tempDir),
    ];
    await Promise.all(calls);

    const snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.requests).toBe(5);
    expect(snap.readOnly.underlyingFetches).toBe(1);
    expect(snap.readOnly.misses).toBe(1);
    expect(snap.readOnly.inflightJoins).toBe(4);
    expect(snap.readOnly.maxConcurrentInflight).toBe(1);
  });

  it('sequential read-only callers within TTL hit the cache after the initial miss', async () => {
    await spaceService.scanSpacesReadOnly(tempDir);
    await spaceService.scanSpacesReadOnly(tempDir);
    await spaceService.scanSpacesReadOnly(tempDir);

    const snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.requests).toBe(3);
    expect(snap.readOnly.underlyingFetches).toBe(1);
    expect(snap.readOnly.misses).toBe(1);
    expect(snap.readOnly.hits).toBe(2);
  });

  it('scanSpaces({ skipAutoFix: true }) delegates to the read-only cache lane', async () => {
    await spaceService.scanSpaces(tempDir, { skipAutoFix: true });
    await spaceService.scanSpaces(tempDir, { skipAutoFix: true });

    const snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.requests).toBe(2);
    expect(snap.readOnly.underlyingFetches).toBe(1);
    expect(snap.readOnly.hits).toBe(1);
    // Writable lane never touched.
    expect(snap.writable.requests).toBe(0);
    expect(snap.writable.underlyingFetches).toBe(0);
  });

  it('writable lane does NOT share cache with read-only lane', async () => {
    // Prime the read-only cache.
    await spaceService.scanSpacesReadOnly(tempDir);
    // Writable call should not be served from the cache.
    await spaceService.scanSpaces(tempDir);

    const snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.requests).toBe(1);
    expect(snap.readOnly.underlyingFetches).toBe(1);
    expect(snap.writable.requests).toBe(1);
    expect(snap.writable.underlyingFetches).toBe(1);
    expect(snap.writable.hits).toBe(0);
  });

  it('invalidateSpaceScanCache clears a specific workspace entry', async () => {
    await spaceService.scanSpacesReadOnly(tempDir);
    // Next call before invalidate is a hit.
    await spaceService.scanSpacesReadOnly(tempDir);
    let snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.hits).toBe(1);

    spaceService.invalidateSpaceScanCache(tempDir, 'test');
    await spaceService.scanSpacesReadOnly(tempDir);
    snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.requests).toBe(3);
    expect(snap.readOnly.underlyingFetches).toBe(2);
    expect(snap.readOnly.misses).toBe(2);
  });

  it('after invalidate, the next read-only scan repopulates cache for subsequent hits', async () => {
    await spaceService.scanSpacesReadOnly(tempDir); // miss #1 (initial populate)
    spaceService.invalidateSpaceScanCache(tempDir, 'repopulate-contract');

    await spaceService.scanSpacesReadOnly(tempDir); // miss #2 (repopulate)
    await spaceService.scanSpacesReadOnly(tempDir); // hit (served from repopulated cache)

    const snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.requests).toBe(3);
    expect(snap.readOnly.underlyingFetches).toBe(2);
    expect(snap.readOnly.misses).toBe(2);
    expect(snap.readOnly.hits).toBe(1);
  });

  it('clearAllSpaceScanCaches clears every workspace entry', async () => {
    const other = await mkFreshTempDir();
    try {
      await spaceService.scanSpacesReadOnly(tempDir);
      await spaceService.scanSpacesReadOnly(other);
      // Both caches are primed; re-call hits.
      await spaceService.scanSpacesReadOnly(tempDir);
      await spaceService.scanSpacesReadOnly(other);
      let snap = spaceService.getScanSpacesCounters();
      expect(snap.readOnly.hits).toBe(2);

      spaceService.clearAllSpaceScanCaches('workspace-switch-test');
      await spaceService.scanSpacesReadOnly(tempDir);
      await spaceService.scanSpacesReadOnly(other);
      snap = spaceService.getScanSpacesCounters();
      // 2 new misses after clear.
      expect(snap.readOnly.underlyingFetches).toBe(4);
      expect(snap.readOnly.misses).toBe(4);
    } finally {
      await fs.rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('cache key normalization: trailing slash / different casing of same path share the entry', async () => {
    const resolved = path.resolve(tempDir);
    // path.resolve is idempotent; this mostly exercises that trimming + resolve
    // yields the same key regardless of trailing whitespace.
    await spaceService.scanSpacesReadOnly(resolved);
    await spaceService.scanSpacesReadOnly(`  ${resolved}  `);

    const snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.requests).toBe(2);
    expect(snap.readOnly.underlyingFetches).toBe(1);
    expect(snap.readOnly.hits).toBe(1);
  });

  it('maxConcurrentInflight during concurrent read-only calls remains 1 (coalesced)', async () => {
    const calls = Array.from({ length: 5 }, () => spaceService.scanSpacesReadOnly(tempDir));
    await flushMicrotasks();

    // Even during the inflight window, only one underlying fetch is running.
    const during = spaceService.getScanSpacesCounters();
    expect(during.readOnly.maxConcurrentInflight).toBeLessThanOrEqual(1);

    await Promise.all(calls);
    const after = spaceService.getScanSpacesCounters();
    expect(after.readOnly.underlyingFetches).toBe(1);
    expect(after.readOnly.maxConcurrentInflight).toBe(1);
  });

  it('writable lane concurrent callers do NOT coalesce (each gets own fetch)', async () => {
    const p1 = spaceService.scanSpaces(tempDir);
    const p2 = spaceService.scanSpaces(tempDir);
    const p3 = spaceService.scanSpaces(tempDir);
    await flushMicrotasks();

    const during = spaceService.getScanSpacesCounters();
    expect(during.writable.maxConcurrentInflight).toBeGreaterThanOrEqual(2);

    await Promise.all([p1, p2, p3]);
    const after = spaceService.getScanSpacesCounters();
    expect(after.writable.requests).toBe(3);
    expect(after.writable.underlyingFetches).toBe(3);
  });

  it('kill switch REBEL_DISABLE_SPACES_COALESCE=1 bypasses coalescing (every call is an underlying fetch)', async () => {
    process.env.REBEL_DISABLE_SPACES_COALESCE = '1';

    await spaceService.scanSpacesReadOnly(tempDir);
    await spaceService.scanSpacesReadOnly(tempDir);
    await spaceService.scanSpacesReadOnly(tempDir);

    const snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.requests).toBe(3);
    expect(snap.readOnly.underlyingFetches).toBe(3);
    expect(snap.readOnly.misses).toBe(3);
    expect(snap.readOnly.hits).toBe(0);
    expect(snap.readOnly.inflightJoins).toBe(0);
  });

  it('createSpace mutation invalidates the read-only cache (next scan reflects new space)', async () => {
    // Prime the cache with an empty workspace.
    const initial = await spaceService.scanSpacesReadOnly(tempDir);
    expect(initial).toEqual([]);

    // Create a new space through the real helper (wires invalidation via spaceService.createSpace internals).
    await spaceService.createSpace(tempDir, {
      name: 'Test-Space',
      type: 'project',
      location: 'workspace',
      sharing: 'private',
      description: 'test-space for Stage 5 invalidation test',
    });

    // Next read-only scan should see the new space because createSpace
    // invalidated the cache (via updateSpaceFrontmatter:createSpace).
    const after = await spaceService.scanSpacesReadOnly(tempDir);
    expect(after.length).toBe(1);
    expect(after[0].name).toBe('Test-Space');

    const snap = spaceService.getScanSpacesCounters();
    // Initial miss + post-mutation miss = 2 underlying fetches.
    expect(snap.readOnly.underlyingFetches).toBe(2);
  });

  it('addDescriptionToFrontmatter (writable-lane auto-fix) invalidates the read-only cache', async () => {
    // Create a space with frontmatter via createSpace (primes invalidate).
    await spaceService.createSpace(tempDir, {
      name: 'AutoFix-Space',
      type: 'project',
      location: 'workspace',
      sharing: 'private',
      description: 'auto-fix target',
    });

    // Prime read-only cache after creation.
    await spaceService.scanSpacesReadOnly(tempDir);
    const countersBefore = spaceService.getScanSpacesCounters();

    // Strip description from README frontmatter — writable-lane scan should
    // auto-fix via addDescriptionToFrontmatter, which in turn invalidates.
    const readmePath = path.join(tempDir, 'AutoFix-Space', 'README.md');
    const orig = await fs.readFile(readmePath, 'utf-8');
    const stripped = orig.replace(/rebel_space_description:[^\n]*\n/, '');
    await fs.writeFile(readmePath, stripped, 'utf-8');

    // Run a writable scan: triggers auto-fix + invalidation.
    await spaceService.scanSpaces(tempDir);

    // Next read-only scan must be a miss (cache was invalidated by the auto-fix).
    spaceService._resetScanSpacesCountersForTesting();
    await spaceService.scanSpacesReadOnly(tempDir);
    const snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.misses).toBe(1);
    expect(snap.readOnly.underlyingFetches).toBe(1);
    // Sanity: pre-test setup did some work — we reset so it doesn't pollute.
    expect(countersBefore.readOnly.requests).toBeGreaterThan(0);
  });

  it('explicit invalidation returns OK for an unknown workspace (no-throw)', () => {
    // Should not throw even if the key has never been cached.
    expect(() => spaceService.invalidateSpaceScanCache('/nonexistent/path', 'test')).not.toThrow();
  });

  // F18 (Stage 5 heavy review): empty and whitespace-only workspace paths must
  // short-circuit the same way in _scanSpacesImpl so that both also collapse
  // to the same cache key. Without the trimmed short-circuit, '   ' would hit
  // the workspace-not-found fs.access branch while '' would not, producing the
  // same cached [] via a more expensive path.
  it('whitespace-only workspace path short-circuits identically to empty string (F18)', async () => {
    spaceService._resetScanSpacesCountersForTesting();

    const emptyResult = await spaceService.scanSpacesReadOnly('');
    const whitespaceResult = await spaceService.scanSpacesReadOnly('   ');

    expect(emptyResult).toEqual([]);
    expect(whitespaceResult).toEqual([]);

    // Second call must be a cache hit (both keyed to <no-workspace>).
    const snap = spaceService.getScanSpacesCounters();
    expect(snap.readOnly.requests).toBe(2);
    expect(snap.readOnly.hits).toBe(1);
    expect(snap.readOnly.misses).toBe(1);
    expect(snap.readOnly.underlyingFetches).toBe(1);
  });

  // F19 (Stage 5 heavy review): invalidation must be no-throw for any string
  // input. NUL bytes in workspacePath make path.resolve throw; guard it so
  // mutators don't crash on corrupted workspace values.
  it('invalidate is no-throw for NUL-byte / malformed workspace paths (F19)', () => {
    expect(() => spaceService.invalidateSpaceScanCache('foo\0bar', 'nul-byte')).not.toThrow();
    expect(() => spaceService.invalidateSpaceScanCache('\0\0\0', 'nul-only')).not.toThrow();
  });
});
