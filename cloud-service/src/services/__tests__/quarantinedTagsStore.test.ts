import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuarantinedTagsStore,
  DEFAULT_QUARANTINE_TTL_MS,
  MAX_QUARANTINE_ENTRIES,
} from '../quarantinedTagsStore';

describe('quarantinedTagsStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-'));
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('addRejected then readActive round-trip', () => {
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    store.addRejected('ghcr.io/x:dev-bad', { now: 1_700_000_000_000 });
    const active = store.readActive(1_700_000_000_100);
    expect(active).toHaveLength(1);
    expect(active[0].imageTag).toBe('ghcr.io/x:dev-bad');
    expect(active[0].rejectedAt).toBe(1_700_000_000_000);
    expect(active[0].ttlMs).toBe(DEFAULT_QUARANTINE_TTL_MS);
  });

  it('readActive filters out entries whose TTL has expired', () => {
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    const now = 1_700_000_000_000;
    store.addRejected('ghcr.io/x:short', { now, ttlMs: 1_000 });
    store.addRejected('ghcr.io/x:long', { now, ttlMs: DEFAULT_QUARANTINE_TTL_MS });
    const afterExpiry = store.readActive(now + 2_000);
    expect(afterExpiry.map((e) => e.imageTag)).toEqual(['ghcr.io/x:long']);
  });

  it('addRejected dedupes by imageTag — newer rejection replaces older', () => {
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    store.addRejected('ghcr.io/x:dev-bad', { now: 1_000 });
    store.addRejected('ghcr.io/x:dev-bad', { now: 5_000 });
    const active = store.readActive(6_000);
    expect(active).toHaveLength(1);
    expect(active[0].rejectedAt).toBe(5_000);
  });

  it('caps the list at MAX_QUARANTINE_ENTRIES, evicting the oldest', () => {
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    for (let i = 0; i < MAX_QUARANTINE_ENTRIES + 5; i++) {
      store.addRejected(`ghcr.io/x:dev-${i}`, { now: 1_000 + i });
    }
    const active = store.readActive(1_000 + MAX_QUARANTINE_ENTRIES + 5);
    expect(active).toHaveLength(MAX_QUARANTINE_ENTRIES);
    // Oldest should have been evicted; newest (highest index) should remain.
    const tags = active.map((e) => e.imageTag);
    expect(tags).toContain(`ghcr.io/x:dev-${MAX_QUARANTINE_ENTRIES + 4}`);
    expect(tags).not.toContain('ghcr.io/x:dev-0');
  });

  it('does not leave a .tmp file behind on write', () => {
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    store.addRejected('ghcr.io/x:dev-bad');
    expect(fs.existsSync(`${store.filePath()}.tmp`)).toBe(false);
  });

  it('readActive returns an empty array when the file is missing', () => {
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    expect(store.readActive()).toEqual([]);
  });

  it('readActive returns an empty array when the file is corrupted', () => {
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    fs.writeFileSync(store.filePath(), '{not json', 'utf8');
    expect(store.readActive()).toEqual([]);
  });

  it('respects REBEL_QUARANTINE_TTL_MS override', () => {
    vi.stubEnv('REBEL_QUARANTINE_TTL_MS', '60000');
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    store.addRejected('ghcr.io/x:dev-tuned', { now: 1_000 });
    const active = store.readActive(2_000);
    expect(active[0].ttlMs).toBe(60_000);
  });

  it('throws when imageTag is empty', () => {
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    expect(() => store.addRejected('')).toThrow('non-empty string');
  });

  it('clear removes both main and tmp files', () => {
    const store = createQuarantinedTagsStore({ dataPath: tmpDir });
    store.addRejected('ghcr.io/x:dev-bad');
    fs.writeFileSync(`${store.filePath()}.tmp`, 'leftover', 'utf8');
    store.clear();
    expect(fs.existsSync(store.filePath())).toBe(false);
    expect(fs.existsSync(`${store.filePath()}.tmp`)).toBe(false);
  });
});
