import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  defaultCapabilities,
  setPlatformConfig,
  type PlatformConfig,
} from '@core/platform';
import {
  pruneUserDataBackupSnapshots,
  resolveUserDataBackupRoot,
  runUserDataBackupIfDue,
  runUserDataBackupNow,
} from '../userDataBackupService';

const modeOf = async (filePath: string): Promise<number> => {
  const stats = await fs.stat(filePath);
  return stats.mode & 0o777;
};

function buildPlatformConfig(userDataPath: string, isOss: boolean): PlatformConfig {
  return {
    userDataPath,
    appPath: '/tmp/rebel-test-app',
    tempPath: '/tmp/rebel-test-temp',
    logsPath: '/tmp/rebel-test-logs',
    homePath: '/tmp/rebel-test-home',
    documentsPath: '/tmp/rebel-test-documents',
    desktopPath: '/tmp/rebel-test-desktop',
    appDataPath: '/tmp/rebel-test-app-data',
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface: 'desktop',
    isOss,
    capabilities: defaultCapabilities('desktop'),
  };
}

describe('userDataBackupService', () => {
  let tmpRoot: string;
  let userDataPath: string;
  let backupRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-userdata-backup-'));
    userDataPath = path.join(tmpRoot, 'mindstone-rebel');
    backupRoot = resolveUserDataBackupRoot(userDataPath);
    await fs.mkdir(userDataPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('resolves enterprise and OSS backup roots from the actual userData directory name', () => {
    expect(resolveUserDataBackupRoot(path.join(tmpRoot, 'mindstone-rebel'))).toBe(
      path.join(tmpRoot, 'mindstone-rebel-backups'),
    );
    expect(resolveUserDataBackupRoot(path.join(tmpRoot, 'mindstone-rebel-oss'))).toBe(
      path.join(tmpRoot, 'mindstone-rebel-oss-backups'),
    );
  });

  it('uses the PlatformConfig userData path by default with isOss set explicitly', () => {
    const ossUserDataPath = path.join(tmpRoot, 'mindstone-rebel-oss');
    setPlatformConfig(buildPlatformConfig(ossUserDataPath, true));

    expect(resolveUserDataBackupRoot()).toBe(path.join(tmpRoot, 'mindstone-rebel-oss-backups'));
  });

  it('copies allowlisted files and directories to an external 0700/0600 snapshot without secret contents in the manifest', async () => {
    const settingsSecret = 'fake-test-secret-should-not-be-in-manifest';
    const tokenSecret = 'xoxb-secret-should-not-be-in-manifest';
    const settingsPath = path.join(userDataPath, 'app-settings.json');
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ providerKeys: { openai: settingsSecret }, theme: 'dark' }),
      'utf8',
    );
    await fs.mkdir(path.join(userDataPath, 'mcp', 'slack'), { recursive: true });
    await fs.writeFile(
      path.join(userDataPath, 'mcp', 'slack', 'workspace.json'),
      JSON.stringify({ botToken: tokenSecret }),
      'utf8',
    );

    const originalSettings = await fs.readFile(settingsPath, 'utf8');
    const result = await runUserDataBackupNow({
      userDataPath,
      backupRoot,
      appVersion: '9.9.9-test',
      now: new Date('2026-06-05T12:00:00Z'),
      allowlist: ['app-settings.json', 'mcp/slack'],
    });

    expect(result.backupRoot).toBe(path.join(tmpRoot, 'mindstone-rebel-backups'));
    expect(path.relative(userDataPath, result.snapshotPath).startsWith('..')).toBe(true);
    expect(await modeOf(result.backupRoot)).toBe(0o700);
    expect(await modeOf(result.snapshotPath)).toBe(0o700);
    expect(await modeOf(path.join(result.snapshotPath, 'app-settings.json'))).toBe(0o600);
    expect(await modeOf(path.join(result.snapshotPath, 'mcp', 'slack', 'workspace.json'))).toBe(0o600);
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe(originalSettings);

    const copiedSettings = await fs.readFile(path.join(result.snapshotPath, 'app-settings.json'), 'utf8');
    expect(copiedSettings).toContain(settingsSecret);

    const manifestPath = path.join(result.snapshotPath, 'manifest.json');
    expect(await modeOf(manifestPath)).toBe(0o600);
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    expect(manifestRaw).not.toContain(settingsSecret);
    expect(manifestRaw).not.toContain(tokenSecret);
    const manifest = JSON.parse(manifestRaw);
    expect(manifest).toMatchObject({ appVersion: '9.9.9-test' });
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: 'app-settings.json', copied: 'ok', sha256: expect.any(String) }),
        expect.objectContaining({ relativePath: path.join('mcp', 'slack', 'workspace.json'), copied: 'ok', sha256: expect.any(String) }),
      ]),
    );
  });

  it('keeps the newest N snapshots, prunes older-than-window snapshots, and never deletes the newest snapshot', async () => {
    await fs.mkdir(backupRoot, { recursive: true });
    const names = [
      'snapshot-20260401-000000',
      'snapshot-20260402-000000',
      'snapshot-20260601-000000',
      'snapshot-20260602-000000',
      'snapshot-20260603-000000',
    ];
    for (const name of names) {
      const dir = path.join(backupRoot, name);
      await fs.mkdir(dir, { recursive: true });
      // A valid snapshot is gated on a completion-marker manifest.
      await fs.writeFile(path.join(dir, 'manifest.json'), '{"entries":[]}', 'utf8');
    }

    await pruneUserDataBackupSnapshots(backupRoot, {
      now: new Date('2026-06-05T00:00:00Z'),
      retentionCount: 3,
      retentionMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
    });

    await expect(fs.readdir(backupRoot).then((entries) => entries.sort())).resolves.toEqual([
      'snapshot-20260601-000000',
      'snapshot-20260602-000000',
      'snapshot-20260603-000000',
    ]);

    await pruneUserDataBackupSnapshots(backupRoot, {
      now: new Date('2026-08-01T00:00:00Z'),
      retentionCount: 3,
      retentionMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
    });

    await expect(fs.readdir(backupRoot)).resolves.toEqual(['snapshot-20260603-000000']);
  });

  it('enforces the total-size budget: prunes oldest until the kept set fits, always keeping the newest', async () => {
    await fs.mkdir(backupRoot, { recursive: true });
    const mk = async (name: string, sizeBytes: number): Promise<void> => {
      const dir = path.join(backupRoot, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ entries: [{ relativePath: 'f', sizeBytes, sha256: 'x', copied: 'ok' }] }),
        'utf8',
      );
    };
    await mk('snapshot-20260601-000000', 40);
    await mk('snapshot-20260602-000000', 40);
    await mk('snapshot-20260603-000000', 40);
    await mk('snapshot-20260604-000000', 40);

    // Budget 100B: newest (40) + next (80) fit; the rest bust the budget → pruned.
    await pruneUserDataBackupSnapshots(backupRoot, {
      now: new Date('2026-06-05T00:00:00Z'),
      retentionCount: 100,
      retentionMaxAgeMs: 365 * 24 * 60 * 60 * 1000,
      retentionMaxTotalBytes: 100,
    });
    await expect(fs.readdir(backupRoot).then((e) => e.sort())).resolves.toEqual([
      'snapshot-20260603-000000',
      'snapshot-20260604-000000',
    ]);

    // Budget smaller than even one snapshot → still keep the single newest.
    await pruneUserDataBackupSnapshots(backupRoot, {
      now: new Date('2026-06-05T00:00:00Z'),
      retentionCount: 100,
      retentionMaxAgeMs: 365 * 24 * 60 * 60 * 1000,
      retentionMaxTotalBytes: 1,
    });
    await expect(fs.readdir(backupRoot)).resolves.toEqual(['snapshot-20260604-000000']);
  });

  it('continues when one allowlisted directory cannot be read and records the failure', async () => {
    await fs.writeFile(path.join(userDataPath, 'app-settings.json'), '{"ok":true}', 'utf8');
    const blockedDir = path.join(userDataPath, 'blocked-dir');
    await fs.mkdir(blockedDir, { recursive: true });
    await fs.writeFile(path.join(blockedDir, 'secret.json'), '{"blocked":true}', 'utf8');

    try {
      if (process.platform !== 'win32') {
        await fs.chmod(blockedDir, 0o000);
      }
      const result = await runUserDataBackupNow({
        userDataPath,
        backupRoot,
        appVersion: 'test',
        now: new Date('2026-06-05T12:00:00Z'),
        allowlist: ['app-settings.json', 'blocked-dir'],
      });

      expect(result.manifest.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: 'app-settings.json', copied: 'ok' }),
        ]),
      );
      if (process.platform !== 'win32') {
        expect(result.manifest.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ relativePath: 'blocked-dir', copied: 'failed' }),
          ]),
        );
      }
    } finally {
      await fs.chmod(blockedDir, 0o700).catch(() => undefined);
    }
  });

  it('skips launch backup when a recent snapshot exists', async () => {
    await fs.writeFile(path.join(userDataPath, 'app-settings.json'), '{"ok":true}', 'utf8');
    await runUserDataBackupNow({
      userDataPath,
      backupRoot,
      appVersion: 'test',
      now: new Date('2026-06-05T12:00:00Z'),
      allowlist: ['app-settings.json'],
    });

    const result = await runUserDataBackupIfDue({
      userDataPath,
      backupRoot,
      appVersion: 'test',
      now: new Date('2026-06-05T13:00:00Z'),
      allowlist: ['app-settings.json'],
    });

    expect(result).toMatchObject({ skipped: true, reason: 'recent-snapshot' });
    await expect(fs.readdir(backupRoot)).resolves.toHaveLength(1);
  });

  it('does not let a manifest-less (crashed) snapshot throttle the next backup (F2)', async () => {
    await fs.writeFile(path.join(userDataPath, 'app-settings.json'), '{"ok":true}', 'utf8');
    // A recent but manifest-less partial snapshot (crashed before manifest write).
    const partialName = 'snapshot-20260605-115500';
    await fs.mkdir(path.join(backupRoot, partialName), { recursive: true });

    const result = await runUserDataBackupIfDue({
      userDataPath,
      backupRoot,
      appVersion: 'test',
      now: new Date('2026-06-05T12:00:00Z'),
      allowlist: ['app-settings.json'],
    });

    // The partial is NOT a valid snapshot, so the backup proceeds.
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(await modeOf(path.join(result.snapshotPath, 'manifest.json'))).toBe(0o600);
    }
  });

  it('never deletes a manifest-less dir as if it were a valid snapshot; only stale ones are cleaned (F2)', async () => {
    // Recent manifest-less dir (could be a concurrent in-progress run) — keep.
    const recentPartial = 'snapshot-20260605-115900';
    // Old manifest-less junk (crashed long ago) — clean up.
    const stalePartial = 'snapshot-20260101-000000';
    // A valid snapshot — always kept.
    const valid = 'snapshot-20260605-110000';
    for (const name of [recentPartial, stalePartial, valid]) {
      await fs.mkdir(path.join(backupRoot, name), { recursive: true });
    }
    await fs.writeFile(path.join(backupRoot, valid, 'manifest.json'), '{"entries":[]}', 'utf8');

    await pruneUserDataBackupSnapshots(backupRoot, {
      now: new Date('2026-06-05T12:00:00Z'),
      retentionCount: 10,
      retentionMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
    });

    const remaining = (await fs.readdir(backupRoot)).sort();
    expect(remaining).toContain(valid);
    expect(remaining).toContain(recentPartial); // within in-progress window → preserved
    expect(remaining).not.toContain(stalePartial); // clearly-stale junk → cleaned
  });

  it('refuses to back up through a symlinked backup root (F2)', async () => {
    if (process.platform === 'win32') return;
    await fs.writeFile(path.join(userDataPath, 'app-settings.json'), '{"ok":true}', 'utf8');
    const realDir = path.join(tmpRoot, 'real-backups');
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, backupRoot);

    await expect(
      runUserDataBackupNow({
        userDataPath,
        backupRoot,
        appVersion: 'test',
        now: new Date('2026-06-05T12:00:00Z'),
        allowlist: ['app-settings.json'],
      }),
    ).rejects.toThrow(/symlink/i);

    // And runUserDataBackupIfDue refuses too.
    await expect(
      runUserDataBackupIfDue({
        userDataPath,
        backupRoot,
        appVersion: 'test',
        now: new Date('2026-06-05T12:00:00Z'),
        allowlist: ['app-settings.json'],
      }),
    ).rejects.toThrow(/symlink/i);
  });

  it('does not fail a directory backup that contains a cloud-looking symlink — the symlink is skipped and the walk is treated complete (Rec-1 F1)', async () => {
    if (process.platform === 'win32') return;
    // Real files we DO expect to back up.
    const dir = path.join(userDataPath, 'plugin-data');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'keep.json'), '{"keep":true}', 'utf8');

    // A nested symlink inside the backed-up dir whose realpath looks like a
    // cloud mount (Dropbox). Pre-fix the default-on cloud-skip pushes a
    // 'cloud-symlink-skipped' truncation reason → the walk is "incomplete" →
    // the whole plugin-data dir is recorded as a failed backup.
    const cloudTarget = path.join(tmpRoot, 'Dropbox', 'linked-folder');
    await fs.mkdir(cloudTarget, { recursive: true });
    await fs.writeFile(path.join(cloudTarget, 'cloud.json'), '{"cloud":true}', 'utf8');
    await fs.symlink(cloudTarget, path.join(dir, 'cloud-link'));

    const result = await runUserDataBackupNow({
      userDataPath,
      backupRoot,
      appVersion: 'test',
      now: new Date('2026-06-05T12:00:00Z'),
      allowlist: ['plugin-data'],
    });

    // The real file is backed up; nothing is marked failed; the cloud file
    // (reached only through the symlink) is NOT copied.
    expect(result.manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: path.join('plugin-data', 'keep.json'), copied: 'ok' }),
      ]),
    );
    expect(result.manifest.entries.some((e) => e.copied === 'failed')).toBe(false);
    expect(result.manifest.entries.some((e) => e.relativePath.includes('cloud.json'))).toBe(false);
    await expect(
      fs.readFile(path.join(result.snapshotPath, 'plugin-data', 'keep.json'), 'utf8'),
    ).resolves.toBe('{"keep":true}');
  });

  it('round-trips a non-UTF8 binary file byte-identically with a matching manifest hash (F4)', async () => {
    // Bytes that are NOT valid UTF-8 (lone continuation/high bytes).
    const rawBytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0xc0, 0x01, 0x7f]);
    const binPath = path.join(userDataPath, 'cloud-service-client-id.json');
    await fs.writeFile(binPath, rawBytes);
    const expectedHash = crypto.createHash('sha256').update(rawBytes).digest('hex');

    const result = await runUserDataBackupNow({
      userDataPath,
      backupRoot,
      appVersion: 'test',
      now: new Date('2026-06-05T12:00:00Z'),
      allowlist: ['cloud-service-client-id.json'],
    });

    const copied = await fs.readFile(path.join(result.snapshotPath, 'cloud-service-client-id.json'));
    expect(Buffer.compare(copied, rawBytes)).toBe(0); // byte-identical
    const entry = result.manifest.entries.find((e) => e.relativePath === 'cloud-service-client-id.json');
    expect(entry?.copied).toBe('ok');
    expect(entry?.sha256).toBe(expectedHash);
    expect(crypto.createHash('sha256').update(copied).digest('hex')).toBe(expectedHash);
  });
});
