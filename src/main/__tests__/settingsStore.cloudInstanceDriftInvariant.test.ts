/**
 * Contract test for the cloud-teardown drift invariant.
 *
 * Invariant: a persisted `cloudInstance` must NEVER be in local mode while still
 * carrying a live `cloudUrl`/`cloudToken`. That state is what strands the UI on
 * "Offline (queued)" / "Last checked: Never" (the reconciler refuses to write
 * status once mode !== 'cloud'). Teardown is the canonical full-clear writer;
 * this test guards the OTHER `mode:'local'` producer that a literal-string grep
 * misses — the legacy sprite→Fly migration, which computes `mode` into a
 * variable and historically carried `spriteUrl` forward as `cloudUrl`.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

// migrateCloudInstanceFieldsIfNeeded is a pure function, but its module
// instantiates an electron-store at import time. Mock the store so the module
// evaluates in the test environment (mirrors the other settingsStore migration
// tests).
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Record<string, unknown> = {};
    get store(): Record<string, unknown> { return this.data; }
    set store(value: Record<string, unknown>) { this.data = value; }
    get(key: string): unknown { return this.data[key]; }
    set(key: string, value: unknown): void { this.data[key] = value; }
    delete(key: string): void { delete this.data[key]; }
    clear(): void { this.data = {}; }
  },
}));

import { migrateCloudInstanceFieldsIfNeeded } from '@core/services/settingsStore/index';

/** The drift state this whole change exists to make unrepresentable. */
function hasDrift(settings: AppSettings): boolean {
  const ci = settings.cloudInstance;
  if (!ci) return false;
  return ci.mode === 'local' && Boolean(ci.cloudUrl || ci.cloudToken);
}

function settingsWith(cloudInstance: Record<string, unknown>): AppSettings {
  return { cloudInstance } as unknown as AppSettings;
}

describe('cloudInstance drift invariant — legacy sprite→Fly migration', () => {
  it('does NOT produce mode:local + live URL when migrating a local-mode sprite record', () => {
    const input = settingsWith({
      mode: 'local',
      spriteUrl: 'https://legacy-sprite.example.com',
      spriteId: 'sprite-123',
    });

    const result = migrateCloudInstanceFieldsIfNeeded(input);

    expect(result.cloudInstance?.mode).toBe('local');
    expect(result.cloudInstance?.cloudUrl).toBeUndefined();
    expect(hasDrift(result)).toBe(false);
  });

  it('migrates a cloud-mode sprite record to cloudUrl (connected state preserved)', () => {
    const input = settingsWith({
      mode: 'cloud',
      spriteUrl: 'https://legacy-sprite.example.com',
    });

    const result = migrateCloudInstanceFieldsIfNeeded(input);

    expect(result.cloudInstance?.mode).toBe('cloud');
    expect(result.cloudInstance?.cloudUrl).toBe('https://legacy-sprite.example.com');
    expect(hasDrift(result)).toBe(false);
  });

  it('migrates a record with no explicit mode as cloud (a live URL implies connected)', () => {
    const input = settingsWith({
      spriteUrl: 'https://legacy-sprite.example.com',
    });

    const result = migrateCloudInstanceFieldsIfNeeded(input);

    expect(result.cloudInstance?.mode).toBe('cloud');
    expect(result.cloudInstance?.cloudUrl).toBe('https://legacy-sprite.example.com');
    expect(hasDrift(result)).toBe(false);
  });

  it('is a no-op for already-migrated records (has cloudUrl)', () => {
    const input = settingsWith({
      mode: 'cloud',
      cloudUrl: 'https://already.example.com',
    });

    const result = migrateCloudInstanceFieldsIfNeeded(input);

    expect(result.cloudInstance?.cloudUrl).toBe('https://already.example.com');
    expect(hasDrift(result)).toBe(false);
  });
});
