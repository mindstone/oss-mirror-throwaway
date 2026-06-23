import { describe, it, expect } from 'vitest';
import { checkCloudServiceLockfileParity } from '../check-cloud-service-lockfile-parity';

/**
 * Tests for the cloud-service package.json ↔ package-lock.json parity gate.
 * Pure-function tests against synthetic manifest/lock pairs (no fs, no npm).
 */

function lockWith(opts: {
  rootDeps?: Record<string, string>;
  rootDevDeps?: Record<string, string>;
  resolved?: string[]; // package names that get a node_modules/<name> entry
}) {
  const packages: Record<string, unknown> = {
    '': {
      dependencies: opts.rootDeps ?? {},
      devDependencies: opts.rootDevDeps ?? {},
    },
  };
  for (const name of opts.resolved ?? []) {
    packages[`node_modules/${name}`] = { version: '1.2.3' };
  }
  return { lockfileVersion: 3, packages };
}

describe('checkCloudServiceLockfileParity', () => {
  it('passes when manifest and lockfile root are in parity and all deps resolve', () => {
    const pkg = {
      dependencies: { ws: '^8.18.0' },
      devDependencies: { tsx: '^4.7.0' },
    };
    const lock = lockWith({
      rootDeps: { ws: '^8.18.0' },
      rootDevDeps: { tsx: '^4.7.0' },
      resolved: ['ws', 'tsx'],
    });
    const { errors } = checkCloudServiceLockfileParity(pkg, lock as never);
    expect(errors).toEqual([]);
  });

  it('fails when a dependency is added to package.json but missing from the lockfile root', () => {
    const pkg = { dependencies: { ws: '^8.18.0', tar: '^7.5.2' } };
    const lock = lockWith({ rootDeps: { ws: '^8.18.0' }, resolved: ['ws'] });
    const { errors } = checkCloudServiceLockfileParity(pkg, lock as never);
    expect(errors.some((e) => e.includes('tar') && e.includes('absent from the lockfile'))).toBe(
      true,
    );
  });

  it('fails when a dependency version range drifts between manifest and lock', () => {
    const pkg = { dependencies: { ws: '^8.19.0' } };
    const lock = lockWith({ rootDeps: { ws: '^8.18.0' }, resolved: ['ws'] });
    const { errors } = checkCloudServiceLockfileParity(pkg, lock as never);
    expect(errors.some((e) => e.includes('ws') && e.includes('version range differs'))).toBe(true);
  });

  it('fails when a dependency lingers in the lockfile root but was removed from package.json', () => {
    const pkg = { dependencies: {} };
    const lock = lockWith({ rootDeps: { ws: '^8.18.0' }, resolved: ['ws'] });
    const { errors } = checkCloudServiceLockfileParity(pkg, lock as never);
    expect(
      errors.some((e) => e.includes('ws') && e.includes('no longer declared in package.json')),
    ).toBe(true);
  });

  it('fails when a declared dependency has no resolved node_modules entry (stale/partial lock)', () => {
    const pkg = { dependencies: { ws: '^8.18.0' } };
    const lock = lockWith({ rootDeps: { ws: '^8.18.0' }, resolved: [] });
    const { errors } = checkCloudServiceLockfileParity(pkg, lock as never);
    expect(errors.some((e) => e.includes('ws') && e.includes('no resolved'))).toBe(true);
  });

  it('fails loudly when the lockfile has no root package entry', () => {
    const pkg = { dependencies: { ws: '^8.18.0' } };
    const { errors } = checkCloudServiceLockfileParity(pkg, { packages: {} } as never);
    expect(errors.some((e) => e.includes('no root package entry'))).toBe(true);
  });

  it('treats devDependencies with the same rigor as dependencies', () => {
    const pkg = { devDependencies: { typescript: '^5.7.0' } };
    const lock = lockWith({ rootDevDeps: { typescript: '^5.6.0' }, resolved: ['typescript'] });
    const { errors } = checkCloudServiceLockfileParity(pkg, lock as never);
    expect(
      errors.some((e) => e.includes('devDependencies') && e.includes('version range differs')),
    ).toBe(true);
  });
});
