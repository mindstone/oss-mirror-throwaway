import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBootStateStore, BOOT_STATE_VERSION } from '../bootStateStore';

describe('bootStateStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    expect(store.read()).toBeNull();
  });

  it('writeStart records attempt=1 when no prior record exists', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    const record = store.writeStart('image:v1', 1_700_000_000_000);
    expect(record).toEqual({
      version: BOOT_STATE_VERSION,
      bootPending: true,
      imageTag: 'image:v1',
      attempt: 1,
      startedAt: 1_700_000_000_000,
    });
    expect(store.read()).toEqual(record);
  });

  it('writeStart increments attempt when prior record matches and is pending', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    store.writeStart('image:v1', 1_700_000_000_000);
    const second = store.writeStart('image:v1', 1_700_000_000_500);
    expect(second.attempt).toBe(2);
    const third = store.writeStart('image:v1', 1_700_000_001_000);
    expect(third.attempt).toBe(3);
  });

  it('writeStart resets attempt when image tag changes', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    store.writeStart('image:v1', 1_700_000_000_000);
    store.writeStart('image:v1', 1_700_000_000_500);
    const newImage = store.writeStart('image:v2', 1_700_000_001_000);
    expect(newImage.attempt).toBe(1);
  });

  it('writeStart resets attempt when prior record is not pending', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    store.writeStart('image:v1', 1_700_000_000_000);
    store.clearBootPending('image:v1', 1_700_000_000_100);
    const afterClean = store.writeStart('image:v1', 1_700_000_000_500);
    expect(afterClean.attempt).toBe(1);
  });

  it('clearBootPending sets bootPending=false, attempt=0, and stamps lastCleanAt', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    store.writeStart('image:v1', 1_700_000_000_000);
    const cleared = store.clearBootPending('image:v1', 1_700_000_000_500);
    expect(cleared.bootPending).toBe(false);
    expect(cleared.attempt).toBe(0);
    expect(cleared.lastCleanAt).toBe(1_700_000_000_500);
  });

  it('writeAtomic does not leave a .tmp file behind', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    store.writeStart('image:v1');
    expect(fs.existsSync(`${store.filePath()}.tmp`)).toBe(false);
  });

  it('read returns null when JSON is corrupted', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    fs.writeFileSync(store.filePath(), '{not json', 'utf8');
    expect(store.read()).toBeNull();
  });

  it('read returns null when version differs (forward-compat)', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    fs.writeFileSync(
      store.filePath(),
      JSON.stringify({
        version: 999,
        bootPending: true,
        imageTag: 'x:y',
        attempt: 1,
        startedAt: 1,
      }),
      'utf8',
    );
    expect(store.read()).toBeNull();
  });

  it('clear removes both main and tmp files', () => {
    const store = createBootStateStore({ dataPath: tmpDir });
    store.writeStart('image:v1');
    fs.writeFileSync(`${store.filePath()}.tmp`, 'leftover', 'utf8');
    store.clear();
    expect(fs.existsSync(store.filePath())).toBe(false);
    expect(fs.existsSync(`${store.filePath()}.tmp`)).toBe(false);
  });
});
