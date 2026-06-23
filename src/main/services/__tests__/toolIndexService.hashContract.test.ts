import { describe, expect, it } from 'vitest';
import { detectPackageChanges } from '../toolIndexService';

/**
 * Contract test: Server-provided package hashes survive the full-refresh → manifest round-trip.
 *
 * The two-tier selective refresh relies on hash parity between what's stored after a full
 * refresh and what the manifest reports. Super-MCP is the single authority for package hashes.
 * These tests verify that server-provided hashes flow through correctly, preventing the
 * false "all packages changed" bug that occurs when Rebel uses a different hash algorithm.
 */
describe('hash contract: server-provided hashes survive round-trip', () => {
  const SERVER_HASHES = new Map([
    ['slack-server', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'],
    ['gmail-server', 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5'],
    ['calendar-server', '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'],
  ]);

  it('reports zero changes when stored hashes match manifest hashes', () => {
    // Simulate: full refresh stored server hashes → next manifest returns same hashes
    const storedHashes = new Map(SERVER_HASHES);
    const manifestHashes = new Map(SERVER_HASHES);

    const { addedPackages, modifiedPackages, removedPackages, unchangedPackages } =
      detectPackageChanges(storedHashes, manifestHashes);

    expect(addedPackages).toEqual([]);
    expect(modifiedPackages).toEqual([]);
    expect(removedPackages).toEqual([]);
    expect(unchangedPackages).toHaveLength(3);
  });

  it('detects a single modified package when one hash changes', () => {
    const storedHashes = new Map(SERVER_HASHES);
    const manifestHashes = new Map(SERVER_HASHES);
    manifestHashes.set('slack-server', 'changed_hash_value_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const { addedPackages, modifiedPackages, removedPackages, unchangedPackages } =
      detectPackageChanges(storedHashes, manifestHashes);

    expect(addedPackages).toEqual([]);
    expect(modifiedPackages).toEqual(['slack-server']);
    expect(removedPackages).toEqual([]);
    expect(unchangedPackages).toHaveLength(2);
  });

  it('detects added packages', () => {
    const storedHashes = new Map(SERVER_HASHES);
    const manifestHashes = new Map(SERVER_HASHES);
    manifestHashes.set('new-server', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const { addedPackages, modifiedPackages, removedPackages } =
      detectPackageChanges(storedHashes, manifestHashes);

    expect(addedPackages).toEqual(['new-server']);
    expect(modifiedPackages).toEqual([]);
    expect(removedPackages).toEqual([]);
  });

  it('detects removed packages', () => {
    const storedHashes = new Map(SERVER_HASHES);
    const manifestHashes = new Map([
      ['slack-server', SERVER_HASHES.get('slack-server')!],
      ['gmail-server', SERVER_HASHES.get('gmail-server')!],
      // calendar-server removed
    ]);

    const { addedPackages, modifiedPackages, removedPackages } =
      detectPackageChanges(storedHashes, manifestHashes);

    expect(addedPackages).toEqual([]);
    expect(modifiedPackages).toEqual([]);
    expect(removedPackages).toEqual(['calendar-server']);
  });

  it('handles empty server hashes (package not loaded) correctly', () => {
    // Server returns "" for packages that failed to load
    const storedHashes = new Map([
      ['slack-server', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'],
      ['failing-server', ''],
    ]);
    const manifestHashes = new Map([
      ['slack-server', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'],
      ['failing-server', ''],
    ]);

    const { modifiedPackages, unchangedPackages } =
      detectPackageChanges(storedHashes, manifestHashes);

    expect(modifiedPackages).toEqual([]);
    expect(unchangedPackages).toHaveLength(2);
  });

  it('treats empty hash → non-empty hash as a modification (package recovered)', () => {
    const storedHashes = new Map([
      ['slack-server', ''],
    ]);
    const manifestHashes = new Map([
      ['slack-server', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'],
    ]);

    const { modifiedPackages } = detectPackageChanges(storedHashes, manifestHashes);

    expect(modifiedPackages).toEqual(['slack-server']);
  });
});
