import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLastKnownGoodImageTagStore,
  LKG_RECORD_VERSION,
  type LkgRecord,
} from '../lastKnownGoodImageTagStore';

function makeRecord(overrides: Partial<LkgRecord> = {}): LkgRecord {
  return {
    version: LKG_RECORD_VERSION,
    imageTag: 'ghcr.io/mindstone/rebel-cloud:dev-good',
    buildCommit: 'abc1234',
    schemaFingerprint: 'fp-current',
    recordedAt: 1_700_000_000_000,
    previousLastKnownGood: null,
    ...overrides,
  };
}

describe('lastKnownGoodImageTagStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkg-store-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes then reads back an identical record', () => {
    const store = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const record = makeRecord();
    store.write(record);
    expect(store.read()).toEqual(record);
  });

  it('returns null when the file does not exist', () => {
    const store = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    expect(store.read()).toBeNull();
  });

  it('returns null when the JSON is corrupted', () => {
    const store = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    fs.writeFileSync(store.filePath(), '{ this is not json', 'utf8');
    expect(store.read()).toBeNull();
  });

  it('returns null when the version differs (forward-compat)', () => {
    const store = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    fs.writeFileSync(
      store.filePath(),
      JSON.stringify({ ...makeRecord(), version: 999 }),
      'utf8',
    );
    expect(store.read()).toBeNull();
  });

  it('writes atomically via temp-rename (no .tmp left behind)', () => {
    const store = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    store.write(makeRecord());
    const tmpPath = `${store.filePath()}.tmp`;
    expect(fs.existsSync(store.filePath())).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('round-trips a record with previousLastKnownGood populated', () => {
    const store = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const record = makeRecord({
      previousLastKnownGood: {
        imageTag: 'ghcr.io/mindstone/rebel-cloud:dev-prior',
        schemaFingerprint: 'fp-prior',
        recordedAt: 1_600_000_000_000,
      },
    });
    store.write(record);
    expect(store.read()).toEqual(record);
  });

  it('rejects a malformed previousLastKnownGood (missing imageTag) by returning null', () => {
    const store = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    fs.writeFileSync(
      store.filePath(),
      JSON.stringify({
        ...makeRecord(),
        previousLastKnownGood: { schemaFingerprint: 'fp-prior', recordedAt: 100 },
      }),
      'utf8',
    );
    expect(store.read()).toBeNull();
  });

  it('preserves the isBootstrapFallback marker when present', () => {
    const store = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    const record = makeRecord({ isBootstrapFallback: true });
    store.write(record);
    expect(store.read()).toEqual(record);
  });

  it('clear() removes both the main file and any leftover tmp file', () => {
    const store = createLastKnownGoodImageTagStore({ dataPath: tmpDir });
    store.write(makeRecord());
    fs.writeFileSync(`${store.filePath()}.tmp`, 'leftover', 'utf8');
    store.clear();
    expect(fs.existsSync(store.filePath())).toBe(false);
    expect(fs.existsSync(`${store.filePath()}.tmp`)).toBe(false);
  });
});
