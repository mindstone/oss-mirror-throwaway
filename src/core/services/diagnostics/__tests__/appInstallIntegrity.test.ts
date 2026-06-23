import { describe, it, expect } from 'vitest';
import {
  classifyAppInstallIntegrity,
  isAppTranslocatedPath,
  isForgeOutDirBundlePath,
  type DiscoveredBundle,
} from '../appInstallIntegrity';

const BETA_ID = 'com.mindstone.rebel.beta';
const STABLE_ID = 'com.mindstone.rebel';
const RUNNING = '/Applications/Mindstone Rebel Beta.app';

function bundle(path: string, bundleId: string | null): DiscoveredBundle {
  return { path, bundleId, shortVersion: null };
}

describe('classifyAppInstallIntegrity', () => {
  it('returns ok for a single clean install', () => {
    const r = classifyAppInstallIntegrity({
      runningBundlePath: RUNNING,
      runningBundleId: BETA_ID,
      discovered: [bundle(RUNNING, BETA_ID)],
      isTranslocated: false,
    });
    expect(r.status).toBe('ok');
    expect(r.duplicateCount).toBe(0);
    expect(r.duplicateBundlePaths).toEqual([]);
  });

  it('detects a same-bundle-id duplicate (the "Beta 2.app" case)', () => {
    const r = classifyAppInstallIntegrity({
      runningBundlePath: RUNNING,
      runningBundleId: BETA_ID,
      discovered: [
        bundle(RUNNING, BETA_ID),
        bundle('/Applications/Mindstone Rebel Beta 2.app', BETA_ID),
      ],
      isTranslocated: false,
    });
    expect(r.status).toBe('duplicates');
    expect(r.duplicateBundlePaths).toEqual(['/Applications/Mindstone Rebel Beta 2.app']);
    expect(r.duplicateCount).toBe(1);
  });

  it('does NOT flag the legitimate stable + beta coexistence (different bundle ids)', () => {
    const r = classifyAppInstallIntegrity({
      runningBundlePath: RUNNING,
      runningBundleId: BETA_ID,
      discovered: [
        bundle(RUNNING, BETA_ID),
        bundle('/Applications/Mindstone Rebel.app', STABLE_ID),
      ],
      isTranslocated: false,
    });
    expect(r.status).toBe('ok');
    expect(r.duplicateCount).toBe(0);
  });

  it('detects a RENAMED duplicate — different filename, SAME bundle id ("Rebel.app" beside "Mindstone Rebel.app")', () => {
    // The reported real-world case: a copy left behind from before a rename keeps
    // its CFBundleIdentifier, so only id-matching (not name) catches it. This is
    // exactly what the name-prefilter used to miss.
    const r = classifyAppInstallIntegrity({
      runningBundlePath: '/Applications/Mindstone Rebel.app',
      runningBundleId: STABLE_ID,
      discovered: [
        bundle('/Applications/Mindstone Rebel.app', STABLE_ID),
        bundle('/Applications/Rebel.app', STABLE_ID), // old name, same id
      ],
      isTranslocated: false,
    });
    expect(r.status).toBe('duplicates');
    expect(r.duplicateBundlePaths).toEqual(['/Applications/Rebel.app']);
  });

  it('does NOT flag an unrelated app that merely shares a name word ("Rebel.app" with a different bundle id)', () => {
    const r = classifyAppInstallIntegrity({
      runningBundlePath: '/Applications/Mindstone Rebel.app',
      runningBundleId: STABLE_ID,
      discovered: [
        bundle('/Applications/Mindstone Rebel.app', STABLE_ID),
        bundle('/Applications/Rebel.app', 'com.someone-else.rebel'), // different product
      ],
      isTranslocated: false,
    });
    expect(r.status).toBe('ok');
    expect(r.duplicateCount).toBe(0);
  });

  it('ignores the running bundle itself even with a trailing slash mismatch', () => {
    const r = classifyAppInstallIntegrity({
      runningBundlePath: `${RUNNING}/`,
      runningBundleId: BETA_ID,
      discovered: [bundle(RUNNING, BETA_ID)],
      isTranslocated: false,
    });
    expect(r.status).toBe('ok');
    expect(r.runningBundlePath).toBe(RUNNING);
  });

  it('deduplicates repeated discovered paths', () => {
    const dup = '/Applications/Mindstone Rebel Beta 2.app';
    const r = classifyAppInstallIntegrity({
      runningBundlePath: RUNNING,
      runningBundleId: BETA_ID,
      discovered: [bundle(dup, BETA_ID), bundle(dup, BETA_ID)],
      isTranslocated: false,
    });
    expect(r.duplicateBundlePaths).toEqual([dup]);
    expect(r.duplicateCount).toBe(1);
  });

  it('cannot assert duplicates when the running bundle id is unknown (fail-safe)', () => {
    const r = classifyAppInstallIntegrity({
      runningBundlePath: RUNNING,
      runningBundleId: null,
      discovered: [bundle('/Applications/Mindstone Rebel Beta 2.app', BETA_ID)],
      isTranslocated: false,
    });
    expect(r.status).toBe('ok');
    expect(r.duplicateCount).toBe(0);
  });

  it('ignores discovered bundles with an unreadable bundle id', () => {
    const r = classifyAppInstallIntegrity({
      runningBundlePath: RUNNING,
      runningBundleId: BETA_ID,
      discovered: [bundle('/Applications/Something Else.app', null)],
      isTranslocated: false,
    });
    expect(r.status).toBe('ok');
  });

  it('reports translocation on its own', () => {
    const tPath =
      '/private/var/folders/ab/AppTranslocation/ABC-123/d/Mindstone Rebel Beta.app';
    const r = classifyAppInstallIntegrity({
      runningBundlePath: tPath,
      runningBundleId: BETA_ID,
      discovered: [bundle(tPath, BETA_ID)],
      isTranslocated: true,
    });
    expect(r.status).toBe('translocated');
  });

  it('reports translocated_and_duplicates when both hold', () => {
    const tPath =
      '/private/var/folders/ab/AppTranslocation/ABC-123/d/Mindstone Rebel Beta.app';
    const r = classifyAppInstallIntegrity({
      runningBundlePath: tPath,
      runningBundleId: BETA_ID,
      discovered: [
        bundle(tPath, BETA_ID),
        bundle('/Applications/Mindstone Rebel Beta.app', BETA_ID),
      ],
      isTranslocated: true,
    });
    expect(r.status).toBe('translocated_and_duplicates');
    expect(r.duplicateBundlePaths).toEqual(['/Applications/Mindstone Rebel Beta.app']);
  });
});

describe('isAppTranslocatedPath', () => {
  it('detects AppTranslocation paths', () => {
    expect(
      isAppTranslocatedPath(
        '/private/var/folders/x/AppTranslocation/UUID/d/Foo.app',
      ),
    ).toBe(true);
  });
  it('returns false for normal Applications paths', () => {
    expect(isAppTranslocatedPath('/Applications/Mindstone Rebel Beta.app')).toBe(false);
    expect(isAppTranslocatedPath('/Users/x/Applications/Foo.app')).toBe(false);
  });
});

describe('isForgeOutDirBundlePath', () => {
  // FIRE: developer `npm run package:run` builds — must suppress the install-hygiene nags.
  it('matches a stable arm64 forge out/ build', () => {
    expect(
      isForgeOutDirBundlePath(
        '/Users/you/dev/rebel-app/out/Mindstone Rebel-darwin-arm64/Mindstone Rebel.app',
        'darwin',
        'arm64',
      ),
    ).toBe(true);
  });

  it('matches a beta arm64 forge out/ build', () => {
    expect(
      isForgeOutDirBundlePath(
        '/Users/you/dev/rebel-app/out/Mindstone Rebel Beta-darwin-arm64/Mindstone Rebel Beta.app',
        'darwin',
        'arm64',
      ),
    ).toBe(true);
  });

  it('matches an x64 forge out/ build when running under x64', () => {
    expect(
      isForgeOutDirBundlePath(
        '/Users/dev/repo/out/Mindstone Rebel-darwin-x64/Mindstone Rebel.app',
        'darwin',
        'x64',
      ),
    ).toBe(true);
  });

  it('matches a realpath-resolved /private-prefixed path (symlinked repo ancestor)', () => {
    expect(
      isForgeOutDirBundlePath(
        '/private/var/folders/zz/T/checkout/out/Mindstone Rebel-darwin-arm64/Mindstone Rebel.app',
        'darwin',
        'arm64',
      ),
    ).toBe(true);
    expect(
      isForgeOutDirBundlePath(
        '/Volumes/External/rebel-app/out/Mindstone Rebel-darwin-arm64/Mindstone Rebel.app',
        'darwin',
        'arm64',
      ),
    ).toBe(true);
  });

  it('tolerates a trailing slash', () => {
    expect(
      isForgeOutDirBundlePath(
        '/repo/out/Mindstone Rebel-darwin-arm64/Mindstone Rebel.app/',
        'darwin',
        'arm64',
      ),
    ).toBe(true);
  });

  // SKIP: real distributed installs — must NEVER suppress (R3).
  it('does not match a /Applications install', () => {
    expect(
      isForgeOutDirBundlePath('/Applications/Mindstone Rebel Beta.app', 'darwin', 'arm64'),
    ).toBe(false);
  });

  it('does not match a ~/Applications alpha install', () => {
    expect(
      isForgeOutDirBundlePath('/Users/x/Applications/Mindstone Rebel Alpha.app', 'darwin', 'arm64'),
    ).toBe(false);
  });

  it('does not match a translocated path', () => {
    expect(
      isForgeOutDirBundlePath(
        '/private/var/folders/x/AppTranslocation/UUID/d/Mindstone Rebel.app',
        'darwin',
        'arm64',
      ),
    ).toBe(false);
  });

  it('does not match a Downloads path', () => {
    expect(
      isForgeOutDirBundlePath('/Users/x/Downloads/Mindstone Rebel.app', 'darwin', 'arm64'),
    ).toBe(false);
  });

  // Fail-closed on off-nominal / mismatched input.
  it('does not match when the running arch differs from the build folder', () => {
    expect(
      isForgeOutDirBundlePath(
        '/repo/out/Mindstone Rebel-darwin-x64/Mindstone Rebel.app',
        'darwin',
        'arm64',
      ),
    ).toBe(false);
  });

  it('does not match a non-.app path', () => {
    expect(
      isForgeOutDirBundlePath('/repo/out/Mindstone Rebel-darwin-arm64/Mindstone Rebel', 'darwin', 'arm64'),
    ).toBe(false);
  });

  it('does not match an empty or garbage path', () => {
    expect(isForgeOutDirBundlePath('', 'darwin', 'arm64')).toBe(false);
    expect(isForgeOutDirBundlePath('.app', 'darwin', 'arm64')).toBe(false);
    expect(isForgeOutDirBundlePath('not-a-path', 'darwin', 'arm64')).toBe(false);
  });

  it('does not match on non-darwin platforms', () => {
    expect(
      isForgeOutDirBundlePath('/repo/out/Mindstone Rebel-win32-x64/Mindstone Rebel.app', 'win32', 'x64'),
    ).toBe(false);
    expect(
      isForgeOutDirBundlePath('/repo/out/Mindstone Rebel-linux-x64/Mindstone Rebel.app', 'linux', 'x64'),
    ).toBe(false);
  });

  it('does not match a coincidental out/ grandparent with a wrong parent name', () => {
    expect(
      isForgeOutDirBundlePath('/repo/out/some-other-folder/Mindstone Rebel.app', 'darwin', 'arm64'),
    ).toBe(false);
    expect(
      isForgeOutDirBundlePath('/repo/build/Mindstone Rebel-darwin-arm64/Mindstone Rebel.app', 'darwin', 'arm64'),
    ).toBe(false);
  });
});
