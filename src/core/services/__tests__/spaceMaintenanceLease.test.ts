/**
 * Unit tests for spaceMaintenanceLease. Real tmpdir on disk — no vi.mock
 * of node:fs/promises so the atomic write + read-back contract is tested
 * against real filesystem semantics.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLease,
  LEASE_FILE_NAME,
  LEASE_SCHEMA_VERSION,
  LEASE_TTL_MS,
  releaseLease,
  type LeaseContent,
} from '../spaceMaintenanceLease';
import { deriveOriginalPath, matchConflictPattern } from '@shared/conflictPatterns';

describe('spaceMaintenanceLease', () => {
  let tmpDir: string;
  let spaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'space-maint-lease-'));
    spaceDir = path.join(tmpDir, 'shared-space');
    await fs.mkdir(spaceDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function leasePath(): string {
    return path.join(spaceDir, LEASE_FILE_NAME);
  }

  async function readLease(): Promise<LeaseContent> {
    const raw = await fs.readFile(leasePath(), 'utf8');
    return JSON.parse(raw);
  }

  async function writeLease(content: Record<string, unknown>): Promise<void> {
    await fs.writeFile(leasePath(), JSON.stringify(content, null, 2));
  }

  // --- acquire: fresh path ---------------------------------------------

  it('writes a fresh lease when none exists and returns acquired:true', async () => {
    const result = await acquireLease(spaceDir, {
      now: () => 1_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });

    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error('unreachable');
    expect(result.lease.leasePath).toBe(leasePath());
    expect(result.lease.content).toEqual({
      schemaVersion: LEASE_SCHEMA_VERSION,
      hostname: 'host-A',
      pid: 42,
      acquiredAt: 1_000,
      expiresAt: 1_000 + LEASE_TTL_MS,
    });

    const onDisk = await readLease();
    expect(onDisk.hostname).toBe('host-A');
    expect(onDisk.pid).toBe(42);
    expect(onDisk.schemaVersion).toBe(LEASE_SCHEMA_VERSION);
  });

  it('creates the space directory if missing (mkdir recursive)', async () => {
    const nestedSpace = path.join(tmpDir, 'nested', 'deep', 'space');
    const result = await acquireLease(nestedSpace, {
      now: () => 0,
      hostname: () => 'host',
      pid: () => 1,
    });
    expect(result.acquired).toBe(true);
    const onDisk = JSON.parse(await fs.readFile(path.join(nestedSpace, LEASE_FILE_NAME), 'utf8'));
    expect(onDisk.hostname).toBe('host');
  });

  // --- acquire: reacquire (same host/pid, unexpired) -------------------

  it('reacquires an existing lease held by us (same hostname + pid)', async () => {
    await writeLease({
      schemaVersion: LEASE_SCHEMA_VERSION,
      hostname: 'host-A',
      pid: 42,
      acquiredAt: 1_000,
      expiresAt: 1_000 + LEASE_TTL_MS,
    });

    const result = await acquireLease(spaceDir, {
      now: () => 2_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });

    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error('unreachable');
    expect(result.lease.content.acquiredAt).toBe(2_000);
    expect(result.lease.content.expiresAt).toBe(2_000 + LEASE_TTL_MS);

    const onDisk = await readLease();
    expect(onDisk.acquiredAt).toBe(2_000);
    expect(onDisk.expiresAt).toBe(2_000 + LEASE_TTL_MS);
  });

  // --- acquire: held by other desktop (unexpired) ----------------------

  it('returns acquired:false with holder info when another desktop holds an unexpired lease', async () => {
    await writeLease({
      schemaVersion: LEASE_SCHEMA_VERSION,
      hostname: 'host-B',
      pid: 99,
      acquiredAt: 1_000,
      expiresAt: 1_000 + LEASE_TTL_MS,
    });

    const result = await acquireLease(spaceDir, {
      now: () => 2_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });

    expect(result.acquired).toBe(false);
    if (result.acquired) throw new Error('unreachable');
    expect(result.reason).toBe('held-by-other');
    expect(result.holder).toEqual({
      hostname: 'host-B',
      pid: 99,
      expiresAt: 1_000 + LEASE_TTL_MS,
    });
    expect(result.leasePath).toBe(leasePath());

    // File bytes must be untouched — we did NOT clobber the holder.
    const onDisk = await readLease();
    expect(onDisk.hostname).toBe('host-B');
    expect(onDisk.pid).toBe(99);
  });

  it('concurrent fresh acquire: exactly one contender acquires the lease', async () => {
    const [a, b] = await Promise.all([
      acquireLease(spaceDir, {
        now: () => 5_000,
        hostname: () => 'host-A',
        pid: () => 111,
      }),
      acquireLease(spaceDir, {
        now: () => 5_000,
        hostname: () => 'host-B',
        pid: () => 222,
      }),
    ]);

    const acquiredCount = Number(a.acquired) + Number(b.acquired);
    expect(acquiredCount).toBe(1);

    const onDisk = await readLease();
    const winner = onDisk.hostname === 'host-A' ? a : b;
    const loser = winner === a ? b : a;
    expect(winner.acquired).toBe(true);
    expect(loser.acquired).toBe(false);
  });

  // --- acquire: expired lease is overridable ---------------------------

  it('overrides an expired lease from another host', async () => {
    await writeLease({
      schemaVersion: LEASE_SCHEMA_VERSION,
      hostname: 'host-B',
      pid: 99,
      acquiredAt: 1_000,
      expiresAt: 1_000 + LEASE_TTL_MS, // expires at 1_000 + 10min
    });

    const now = 1_000 + LEASE_TTL_MS + 1; // 1ms past expiry
    const result = await acquireLease(spaceDir, {
      now: () => now,
      hostname: () => 'host-A',
      pid: () => 42,
    });

    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error('unreachable');

    const onDisk = await readLease();
    expect(onDisk.hostname).toBe('host-A');
    expect(onDisk.pid).toBe(42);
    expect(onDisk.acquiredAt).toBe(now);
  });

  // --- acquire: unknown schemaVersion -> safe-skip ---------------------

  it('treats an unknown schemaVersion as held-by-other and leaves the file untouched', async () => {
    await writeLease({
      schemaVersion: 999,
      hostname: 'host-B',
      pid: 99,
      acquiredAt: 1_000,
      expiresAt: 1_000 + LEASE_TTL_MS,
    });
    const bytesBefore = await fs.readFile(leasePath());

    const result = await acquireLease(spaceDir, {
      now: () => 2_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });

    expect(result.acquired).toBe(false);
    if (result.acquired) throw new Error('unreachable');
    expect(result.reason).toBe('unknown-schema');

    const bytesAfter = await fs.readFile(leasePath());
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
  });

  // --- acquire: corrupt JSON is treated as absent ----------------------

  it('overwrites a corrupt lease file (invalid JSON treated as absent)', async () => {
    await fs.writeFile(leasePath(), 'not-json{{');

    const result = await acquireLease(spaceDir, {
      now: () => 2_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });

    expect(result.acquired).toBe(true);
    const onDisk = await readLease();
    expect(onDisk.hostname).toBe('host-A');
  });

  // --- release: happy path ---------------------------------------------

  it('releases a lease we acquired and removes the file', async () => {
    const acquired = await acquireLease(spaceDir, {
      now: () => 1_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error('unreachable');

    await releaseLease(acquired.lease);

    await expect(fs.access(leasePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // --- release: contested (another holder took over) -------------------

  it('does not delete the file when another holder has taken over (contested release)', async () => {
    const acquired = await acquireLease(spaceDir, {
      now: () => 1_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error('unreachable');

    // Another desktop takes over (e.g. our TTL expired before we finished).
    const newHolder: LeaseContent = {
      schemaVersion: LEASE_SCHEMA_VERSION,
      hostname: 'host-B',
      pid: 99,
      acquiredAt: 9_999_999,
      expiresAt: 9_999_999 + LEASE_TTL_MS,
    };
    await fs.writeFile(leasePath(), JSON.stringify(newHolder, null, 2));

    await releaseLease(acquired.lease);

    const stillThere = await readLease();
    expect(stillThere.hostname).toBe('host-B');
    expect(stillThere.pid).toBe(99);
  });

  it('release is a no-op when the lease file is already gone', async () => {
    const acquired = await acquireLease(spaceDir, {
      now: () => 1_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error('unreachable');

    await fs.unlink(leasePath());

    await expect(releaseLease(acquired.lease)).resolves.toBeUndefined();
  });

  // --- release: corrupt on-disk file doesn't clobber -------------------

  it('leaves a corrupt on-disk lease alone on release (no deletion)', async () => {
    const acquired = await acquireLease(spaceDir, {
      now: () => 1_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error('unreachable');

    await fs.writeFile(leasePath(), 'garbage{{');
    await releaseLease(acquired.lease);

    const bytes = await fs.readFile(leasePath(), 'utf8');
    expect(bytes).toBe('garbage{{');
  });

  // --- reacquire release: latest acquiredAt matters --------------------

  it('reacquire produces a lease handle that releases against the refreshed acquiredAt', async () => {
    const first = await acquireLease(spaceDir, {
      now: () => 1_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error('unreachable');

    const second = await acquireLease(spaceDir, {
      now: () => 2_000,
      hostname: () => 'host-A',
      pid: () => 42,
    });
    expect(second.acquired).toBe(true);
    if (!second.acquired) throw new Error('unreachable');

    // The original handle's acquiredAt is stale; releasing with it should
    // NOT delete the file (identity mismatch with the on-disk acquiredAt).
    await releaseLease(first.lease);
    const onDiskAfterStaleRelease = await readLease();
    expect(onDiskAfterStaleRelease.acquiredAt).toBe(2_000);

    // The new handle releases cleanly.
    await releaseLease(second.lease);
    await expect(fs.access(leasePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lease filename conflict artifact matches shared regex and derives back to the lock filename', () => {
    const artifactName = `${LEASE_FILE_NAME}.conflict-cloud`;
    const pattern = matchConflictPattern(artifactName);
    expect(pattern?.label).toBe('rebel-cloud-conflict');

    const derived = deriveOriginalPath(path.join(spaceDir, artifactName), 'rebel-cloud-conflict');
    expect(derived).toBe(path.join(spaceDir, LEASE_FILE_NAME));
  });
});
