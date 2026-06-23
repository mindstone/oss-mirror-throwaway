import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetInPlaceCloudDocumentsCache,
  createWorkspaceWriteAuthorityCache,
  detectCloudStorage,
  detectInPlaceCloudDocuments,
  FS_TIMEOUT_CLOUD_MS,
  FS_TIMEOUT_LOCAL_MS,
  getTimeoutForPath,
  resolveWorkspaceWriteAuthority,
  shouldSkipCloudSymlinkTarget,
} from './cloudStorageUtils';

function createEnoentError(message = 'ENOENT'): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

describe('resolveWorkspaceWriteAuthority', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cloud_authoritative for non-cloud paths', () => {
    vi.spyOn(fs, 'realpathSync').mockReturnValue('/Users/test/workspace/sources/2026/05-May/18');

    expect(resolveWorkspaceWriteAuthority('/Users/test/workspace/sources/2026/05-May/18')).toBe('cloud_authoritative');
  });

  it('returns desktop_fs_authoritative for Google Drive paths', () => {
    vi.spyOn(fs, 'realpathSync').mockReturnValue('/Users/test/Library/CloudStorage/GoogleDrive-user/workspace/sources');

    expect(resolveWorkspaceWriteAuthority('/Users/test/Library/CloudStorage/GoogleDrive-user/workspace/sources')).toBe(
      'desktop_fs_authoritative',
    );
  });

  it('follows symlink targets before cloud-storage detection', () => {
    vi.spyOn(fs, 'realpathSync').mockReturnValue(
      '/Users/test/Library/CloudStorage/GoogleDrive-user/workspace/symlinked-space/sources',
    );

    expect(resolveWorkspaceWriteAuthority('/Users/test/workspace-link/sources')).toBe('desktop_fs_authoritative');
  });

  it('falls back to nearest existing parent on ENOENT paths', () => {
    const missing = '/Users/test/Library/CloudStorage/GoogleDrive-user/workspace/sources/2026/05-May/18';
    const parent = path.dirname(missing);
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((inputPath: fs.PathLike) => {
      const asString = String(inputPath);
      if (asString === missing) throw createEnoentError();
      if (asString === parent) return parent;
      throw createEnoentError(`Unexpected path: ${asString}`);
    });

    expect(resolveWorkspaceWriteAuthority(missing)).toBe('desktop_fs_authoritative');
    expect(realpathSpy).toHaveBeenCalledWith(missing);
    expect(realpathSpy).toHaveBeenCalledWith(parent);
  });

  it('handles case-variant macOS-style Drive paths', () => {
    vi.spyOn(fs, 'realpathSync').mockReturnValue(
      '/Users/Test/Library/CloudStorage/GoogleDrive-USER/workspace/Sources',
    );

    expect(resolveWorkspaceWriteAuthority('/users/test/library/cloudstorage/googledrive-user/workspace/sources')).toBe(
      'desktop_fs_authoritative',
    );
  });

  it('reuses cache entries for sibling paths in one sync cycle', () => {
    const cache = createWorkspaceWriteAuthorityCache();
    const siblingA = '/Users/test/Library/CloudStorage/GoogleDrive-user/workspace/sources/2026/05-May/18/notes-a.md';
    const siblingB = '/Users/test/Library/CloudStorage/GoogleDrive-user/workspace/sources/2026/05-May/18/notes-b.md';
    const sharedParentDir = path.dirname(siblingA);
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockReturnValue(sharedParentDir);

    const first = resolveWorkspaceWriteAuthority(path.dirname(siblingA), { cache });
    const second = resolveWorkspaceWriteAuthority(path.dirname(siblingB), { cache });

    expect(first).toBe('desktop_fs_authoritative');
    expect(second).toBe('desktop_fs_authoritative');
    expect(realpathSpy).toHaveBeenCalledTimes(1);
  });

  it('does not leak ancestor cache entries into Drive-symlinked descendants', () => {
    const cache = createWorkspaceWriteAuthorityCache();
    const localWorkspacePath = '/Users/test/workspace/sources';
    const symlinkedDrivePath = '/Users/test/workspace/spaces/team-space/sources/2026/05-May';
    const symlinkedDriveRealPath =
      '/Users/test/Library/CloudStorage/GoogleDrive-user/shared/team-space/sources/2026/05-May';
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation((inputPath: fs.PathLike) => {
      const asString = String(inputPath);
      if (asString === localWorkspacePath) return localWorkspacePath;
      if (asString === symlinkedDrivePath) return symlinkedDriveRealPath;
      throw new Error(`Unexpected path: ${asString}`);
    });

    const first = resolveWorkspaceWriteAuthority(localWorkspacePath, { cache });
    const second = resolveWorkspaceWriteAuthority(symlinkedDrivePath, { cache });

    expect(first).toBe('cloud_authoritative');
    expect(second).toBe('desktop_fs_authoritative');
    expect(realpathSpy).toHaveBeenCalledTimes(2);
  });
});

describe('shouldSkipCloudSymlinkTarget (RC-1 scan-hang predicate)', () => {
  it('skips a Google Drive shared-drive target (the reported hang)', () => {
    // The exact shape of the user's `Company Memories` symlink target.
    const target =
      '/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/Shared drives/Company Memories';
    expect(shouldSkipCloudSymlinkTarget(target)).toEqual({
      skip: true,
      provider: 'google_drive',
    });
  });

  it('skips OneDrive / Dropbox / iCloud / Box targets', () => {
    expect(shouldSkipCloudSymlinkTarget('/Users/test/OneDrive - Acme/docs').skip).toBe(true);
    expect(shouldSkipCloudSymlinkTarget('/Users/test/Dropbox/docs').skip).toBe(true);
    expect(
      shouldSkipCloudSymlinkTarget(
        '/Users/test/Library/Mobile Documents/com~apple~CloudDocs/docs',
      ).skip,
    ).toBe(true);
    expect(shouldSkipCloudSymlinkTarget('/Users/test/Box/docs').skip).toBe(true);
  });

  it('does NOT skip the rebel-system symlink target (must keep being followed)', () => {
    // The CRITICAL carve-out: rebel-system is also an outside-workspace symlink,
    // but it is NOT a cloud mount, so it must be followed (Skills / AGENTS.md).
    const rebelSystemTarget =
      '/Applications/Mindstone Rebel.app/Contents/Resources/rebel-system';
    expect(shouldSkipCloudSymlinkTarget(rebelSystemTarget)).toEqual({ skip: false });
  });

  it('does NOT skip an ordinary in-workspace directory target', () => {
    expect(
      shouldSkipCloudSymlinkTarget('/Users/test/Documents/Mindstone Rebel/sources/2026'),
    ).toEqual({ skip: false });
  });
});

describe('detectCloudStorage — provider-agnostic macOS CloudStorage (a Mindstone-employee Dropbox-under-CloudStorage gap)', () => {
  // A Mindstone-employee set of 9 space symlinks: 8 → Google Drive CloudStorage, 1 → Dropbox. The
  // modern macOS layout puts EVERY provider under `~/Library/CloudStorage/
  // <Provider>-<Account>` (since 12.3), so a GoogleDrive-prefix-only match would
  // MISS the Dropbox space and still wedge on it. These pin the provider-agnostic
  // CloudStorage branch.
  it('detects the modern ~/Library/CloudStorage/Dropbox-<Team> layout (the gap that wedged a Mindstone employee)', () => {
    expect(
      detectCloudStorage('/Users/test/Library/CloudStorage/Dropbox-Acme/Florida AI Weekend'),
    ).toEqual({ isCloud: true, provider: 'dropbox' });
    // A bare `Dropbox` CloudStorage folder (no account suffix) is also covered.
    expect(
      detectCloudStorage('/Users/test/Library/CloudStorage/Dropbox/Florida AI Weekend').isCloud,
    ).toBe(true);
  });

  it('detects the modern ~/Library/CloudStorage/OneDrive-* and Box layouts', () => {
    expect(
      detectCloudStorage('/Users/test/Library/CloudStorage/OneDrive-Personal/docs'),
    ).toEqual({ isCloud: true, provider: 'onedrive' });
    expect(
      detectCloudStorage('/Users/test/Library/CloudStorage/Box-Acme/docs'),
    ).toEqual({ isCloud: true, provider: 'box' });
  });

  it('still detects Google Drive under CloudStorage (regression — was the only mapped provider before)', () => {
    expect(
      detectCloudStorage('/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/My Drive/x'),
    ).toEqual({ isCloud: true, provider: 'google_drive' });
  });

  it('treats an UNKNOWN/future provider under CloudStorage as cloud (isCloud:true, provider omitted)', () => {
    // A new provider macOS forces under CloudStorage must still be skipped by the
    // watcher/walker even though we cannot attribute the enum.
    const info = detectCloudStorage('/Users/test/Library/CloudStorage/SomeNewCloud-Acct/files');
    expect(info.isCloud).toBe(true);
    expect(info.provider).toBeUndefined();
  });

  it('does NOT mislabel a startsWith-collision vendor (Boxcryptor != box) — F1', () => {
    // Conservative attribution: a wrong provider is worse than none (consumers
    // tolerate undefined). Boxcryptor is still cloud, but NOT attributed `box`.
    const info = detectCloudStorage('/Users/test/Library/CloudStorage/Boxcryptor-Acme/files');
    expect(info.isCloud).toBe(true);
    expect(info.provider).toBeUndefined();
  });

  it('classifies a provider folder beginning with a non-letter as cloud (isCloud robust to attribution) — F3', () => {
    // `isCloud` must not depend on `[a-z]+` matching the vendor token.
    expect(
      detectCloudStorage('/Users/test/Library/CloudStorage/2BringCloud-Acct/files').isCloud,
    ).toBe(true);
  });

  it('shouldSkipCloudSymlinkTarget skips a modern CloudStorage-Dropbox target (a Mindstone employee)', () => {
    expect(
      shouldSkipCloudSymlinkTarget(
        '/Users/test/Library/CloudStorage/Dropbox-Acme/Florida AI Weekend',
      ),
    ).toEqual({ skip: true, provider: 'dropbox' });
  });

  it('does NOT match the bare ~/Library/CloudStorage container dir (no provider child) or unrelated Library paths', () => {
    expect(detectCloudStorage('/Users/test/Library/CloudStorage').isCloud).toBe(false);
    expect(detectCloudStorage('/Users/test/Library/Application Support/foo').isCloud).toBe(false);
    // The in-place iCloud carve-out (~/Documents) is unaffected.
    expect(detectCloudStorage('/Users/test/Documents/Mindstone Rebel').isCloud).toBe(false);
  });
});

describe('detectInPlaceCloudDocuments (macOS Desktop & Documents in iCloud)', () => {
  const HOME = '/Users/arthur';
  const WORKSPACE = `${HOME}/Documents/Mindstone Rebel`;

  afterEach(() => {
    vi.restoreAllMocks();
    _resetInPlaceCloudDocumentsCache();
  });

  function mockDarwin() {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(os, 'homedir').mockReturnValue(HOME);
  }

  function restorePlatform(original: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }

  it('returns true when the ~/Documents ROOT carries the iCloud file-provider xattr', () => {
    const original = process.platform;
    mockDarwin();
    const exec = vi
      .spyOn(childProcess, 'execFileSync')
      // value lives on the ROOT only, read on the root not the subfolder
      .mockReturnValue('com.apple.CloudDocs.iCloudDriveFileProvider/iCloud.com.apple.CloudDocs\n');

    try {
      expect(detectInPlaceCloudDocuments(WORKSPACE)).toBe(true);
      // Reads the xattr on the ROOT (~/Documents), NOT the workspace subfolder.
      expect(exec).toHaveBeenCalledWith(
        'xattr',
        ['-p', 'com.apple.file-provider-domain-id', `${HOME}/Documents`],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    } finally {
      restorePlatform(original);
    }
  });

  it('returns true for a ~/Desktop workspace when its root carries the xattr', () => {
    const original = process.platform;
    mockDarwin();
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue(
      'com.apple.CloudDocs.iCloudDriveFileProvider/iCloud.com.apple.CloudDocs',
    );
    try {
      expect(detectInPlaceCloudDocuments(`${HOME}/Desktop/notes`)).toBe(true);
    } finally {
      restorePlatform(original);
    }
  });

  it('returns false when the xattr is absent (xattr exits non-zero → fail-safe)', () => {
    const original = process.platform;
    mockDarwin();
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw Object.assign(new Error('No such xattr'), { status: 1 });
    });
    try {
      expect(detectInPlaceCloudDocuments(WORKSPACE)).toBe(false);
    } finally {
      restorePlatform(original);
    }
  });

  it('returns false for a path outside ~/Documents and ~/Desktop without any I/O', () => {
    const original = process.platform;
    mockDarwin();
    const exec = vi.spyOn(childProcess, 'execFileSync');
    try {
      expect(detectInPlaceCloudDocuments(`${HOME}/Projects/local-ws`)).toBe(false);
      // String guard short-circuits before any child process spawns.
      expect(exec).not.toHaveBeenCalled();
    } finally {
      restorePlatform(original);
    }
  });

  it('returns false off darwin without any I/O', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.spyOn(os, 'homedir').mockReturnValue('C:/Users/arthur');
    const exec = vi.spyOn(childProcess, 'execFileSync');
    try {
      expect(detectInPlaceCloudDocuments('C:/Users/arthur/Documents/ws')).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      restorePlatform(original);
    }
  });

  it('caches the xattr read per root (one spawn for repeated checks)', () => {
    const original = process.platform;
    mockDarwin();
    const exec = vi
      .spyOn(childProcess, 'execFileSync')
      .mockReturnValue('com.apple.CloudDocs.iCloudDriveFileProvider/iCloud.com.apple.CloudDocs');
    try {
      expect(detectInPlaceCloudDocuments(`${HOME}/Documents/a`)).toBe(true);
      expect(detectInPlaceCloudDocuments(`${HOME}/Documents/b`)).toBe(true);
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform(original);
    }
  });
});

describe('getTimeoutForPath with in-place iCloud Documents', () => {
  const HOME = '/Users/arthur';

  afterEach(() => {
    vi.restoreAllMocks();
    _resetInPlaceCloudDocumentsCache();
  });

  it('returns the CLOUD budget for an in-place-iCloud ~/Documents workspace on the FIRST probe', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(os, 'homedir').mockReturnValue(HOME);
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue(
      'com.apple.CloudDocs.iCloudDriveFileProvider/iCloud.com.apple.CloudDocs',
    );
    try {
      // The path pattern is NOT a known cloud mount (detectCloudStorage says local),
      // yet the timeout must be the extended cloud budget.
      expect(detectCloudStorage(`${HOME}/Documents/Mindstone Rebel`).isCloud).toBe(false);
      expect(getTimeoutForPath(`${HOME}/Documents/Mindstone Rebel`)).toBe(FS_TIMEOUT_CLOUD_MS);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('returns the LOCAL budget for a genuinely-local ~/Documents workspace (xattr absent)', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(os, 'homedir').mockReturnValue(HOME);
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw Object.assign(new Error('No such xattr'), { status: 1 });
    });
    try {
      expect(getTimeoutForPath(`${HOME}/Documents/Mindstone Rebel`)).toBe(FS_TIMEOUT_LOCAL_MS);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});

describe('RC-1 / migration contract: in-place-iCloud signal must NOT leak into detectCloudStorage', () => {
  // These guards make the data-loss-shaped failure mode (migrationExportService
  // skipping the workspace bytes for "cloud" paths) impossible to reintroduce by
  // folding detectInPlaceCloudDocuments into the provider enum.
  it('detectCloudStorage stays isCloud:false for a ~/Documents workspace', () => {
    expect(detectCloudStorage('/Users/arthur/Documents/Mindstone Rebel').isCloud).toBe(false);
  });

  it('shouldSkipCloudSymlinkTarget stays {skip:false} for a ~/Documents workspace target', () => {
    expect(
      shouldSkipCloudSymlinkTarget('/Users/arthur/Documents/Mindstone Rebel/sources'),
    ).toEqual({ skip: false });
  });
});
