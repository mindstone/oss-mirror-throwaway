import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Buffer } from '@core/utils/safeSnapshotCopy';
import type { AppSettings, SpaceConfig } from '@shared/types/settings';
import { exportMigrationBundle } from '../migrationExportService';
import {
  adoptPreparedMigrationImportSync,
  consumeMigrationImportNoticeSync,
  describeMigrationImportTargetFreshnessSync,
  isFreshMigrationImportTargetSync,
  MigrationImportError,
  MIGRATION_IMPORT_STAGING_COMPLETE_FILENAME,
  prepareMigrationImport,
  validateMigrationBundle,
  type MigrationImportErrorCode,
} from '../migrationImportService';
import type { MigrationBundleManifest } from '../migrationManifest';

const NOW = new Date('2026-06-09T16:00:00.000Z');
const IMPORT_ID = 'a89ebd43-7c41-4a30-b81b-b8cc886b9824';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-migration-import-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function writeFixtureFile(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFixtureFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function listFiles(rootPath: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dirPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        result.push(path.relative(rootPath, absolutePath).replace(/\\/g, '/'));
      }
    }
  }
  await walk(rootPath);
  return result.sort();
}

async function treeSnapshot(
  rootPath: string,
): Promise<Record<string, { sha256?: string; type: string; mode: number; mtimeMs: number }>> {
  const result: Record<string, { sha256?: string; type: string; mode: number; mtimeMs: number }> = {};
  async function walk(currentPath: string): Promise<void> {
    const stat = await fs.lstat(currentPath);
    const relativePath = path.relative(rootPath, currentPath).replace(/\\/g, '/') || '.';
    const type = stat.isFile()
      ? 'file'
      : stat.isDirectory()
        ? 'dir'
        : stat.isSymbolicLink()
          ? 'symlink'
          : 'other';
    result[relativePath] = {
      type,
      sha256: stat.isFile() ? sha256Buffer(await fs.readFile(currentPath)) : undefined,
      // Capture mode + mtime so the refusal test proves nothing was *touched*
      // (content + metadata identical), not merely that content is unchanged.
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    };
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(currentPath)) {
      await walk(path.join(currentPath, entry));
    }
  }
  await walk(rootPath);
  return result;
}

function makeSpace(overrides: Partial<SpaceConfig>): SpaceConfig {
  return {
    name: 'Space',
    path: 'work/Space',
    type: 'team',
    isSymlink: false,
    createdAt: 1,
    ...overrides,
  };
}

function makeSettings(args: {
  sourceUserDataPath: string;
  coreDirectory: string;
  cloudSpacePath?: string;
  spaces?: SpaceConfig[];
  includeCloud?: boolean;
}): AppSettings {
  return {
    coreDirectory: args.coreDirectory,
    mcpConfigFile: path.join(args.sourceUserDataPath, 'mcp', 'super-mcp-router.json'),
    onboardingCompleted: true,
    userEmail: 'user@example.com',
    userFirstName: 'User',
    onboardingFirstCompletedAt: 1,
    theme: 'dark',
    models: {
      apiKey: 'anthropic-secret',
      authMethod: 'api-key',
      model: 'claude-sonnet-4-5',
      permissionMode: 'plan',
      executablePath: '/usr/bin/claude',
      planMode: true,
    },
    voice: {
      provider: 'custom-openai',
      openaiApiKey: 'voice-secret',
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: false,
    },
    diagnostics: {},
    providerKeys: { openai: 'openai-secret' },
    cloudInstance: args.includeCloud === false ? undefined : {
      mode: 'cloud',
      cloudUrl: 'https://cloud.example.com',
      cloudToken: 'cloud-secret',
    },
    spaces: args.spaces ?? [
      makeSpace({
        name: 'Local',
        path: 'work/Local',
      }),
      makeSpace({
        name: 'Drive',
        path: 'work/Drive',
        isSymlink: true,
        sourcePath: args.cloudSpacePath,
        storageProvider: 'google_drive',
      }),
    ],
  } as unknown as AppSettings;
}

async function createSourceFixture(): Promise<{
  sourceUserDataPath: string;
  coreDirectory: string;
  cloudSpacePath: string;
  destBundleDir: string;
  settings: AppSettings;
}> {
  const sourceUserDataPath = path.join(tempRoot, 'source-user-data');
  const coreDirectory = path.join(tempRoot, 'Library');
  const cloudSpacePath = path.join(tempRoot, 'Library', 'CloudStorage', 'GoogleDrive-user@example.com', 'Drive');
  const destBundleDir = path.join(tempRoot, 'bundle');

  await writeFixtureFile(path.join(sourceUserDataPath, 'sessions', 'session-1.json'), '{"messages":["hello"]}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'sessions', 'session-1.assets', 'asset.png'), Buffer.from([1, 2, 3]));
  await writeFixtureFile(path.join(sourceUserDataPath, 'inbox.json'), '{"items":[1]}');
  await writeFixtureFile(path.join(coreDirectory, 'work', 'Local', 'README.md'), 'local readme');
  await writeFixtureFile(path.join(coreDirectory, 'work', 'Local', 'notes.md'), 'local notes');
  await writeFixtureFile(path.join(cloudSpacePath, 'README.md'), 'drive readme');
  await writeFixtureFile(path.join(cloudSpacePath, 'drive.md'), 'drive notes');

  const settings = makeSettings({ sourceUserDataPath, coreDirectory, cloudSpacePath });
  return { sourceUserDataPath, coreDirectory, cloudSpacePath, destBundleDir, settings };
}

async function createExportedBundle(): Promise<Awaited<ReturnType<typeof exportMigrationBundle>>> {
  const fixture = await createSourceFixture();
  return exportMigrationBundle({
    sourceUserDataPath: fixture.sourceUserDataPath,
    coreDirectory: fixture.coreDirectory,
    settings: fixture.settings,
    appVersion: '0.4.46',
    dataSchemaEpoch: 123,
    importId: IMPORT_ID,
    destBundleDir: fixture.destBundleDir,
    now: NOW,
  });
}

async function readManifest(bundleDir: string): Promise<MigrationBundleManifest> {
  return readJson<MigrationBundleManifest>(path.join(bundleDir, 'manifest.json'));
}

async function writeManifest(bundleDir: string, manifest: MigrationBundleManifest): Promise<void> {
  await writeJson(path.join(bundleDir, 'manifest.json'), manifest);
}

async function addManifestEntry(
  result: Awaited<ReturnType<typeof exportMigrationBundle>>,
  relPath: string,
  content = `tampered ${relPath}`,
): Promise<void> {
  const manifest = await readManifest(result.bundleDir);
  const bytes = Buffer.from(content);
  await writeFixtureFile(path.join(result.dataDir, relPath), bytes);
  manifest.entries.push({
    relPath,
    bytes: bytes.byteLength,
    sha256: sha256Buffer(bytes),
  });
  manifest.entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  await writeManifest(result.bundleDir, manifest);
}

async function expectImportRejects(
  bundleDir: string,
  code: MigrationImportErrorCode,
  limits?: Parameters<typeof validateMigrationBundle>[0]['limits'],
): Promise<void> {
  await expect(validateMigrationBundle({
    bundleDir,
    targetDataSchemaEpoch: 123,
    limits,
  })).rejects.toMatchObject({
    name: 'MigrationImportError',
    code,
  } satisfies Partial<MigrationImportError>);
}

describe('migration import validation and staging', () => {
  it('round-trips an exported bundle into staging with repaired settings and no cloud config', async () => {
    const result = await createExportedBundle();
    const targetUserDataPath = path.join(tempRoot, 'target-user-data');
    const targetWorkspace = path.join(targetUserDataPath, 'workspace');
    const highConfidenceDrive = path.join(tempRoot, 'new-home', 'Library', 'CloudStorage', 'GoogleDrive-user@example.com', 'Drive');
    await writeFixtureFile(path.join(highConfidenceDrive, 'README.md'), 'drive readme');

    const prepared = await prepareMigrationImport({
      bundleDir: result.bundleDir,
      targetDataSchemaEpoch: 123,
      targetUserDataPath,
      targetCoreDirectory: targetWorkspace,
      spaceSourcePathCandidates: [highConfidenceDrive],
      importFlagPath: path.join(tempRoot, 'migration-flag.json'),
      now: NOW,
    });

    expect(await listFiles(prepared.stagingDir)).toEqual(expect.arrayContaining([
      MIGRATION_IMPORT_STAGING_COMPLETE_FILENAME,
      'app-settings.json',
      `logs/migration-import-${IMPORT_ID}.log`,
      'sessions/session-1.json',
      'sessions/session-1.assets/asset.png',
      'inbox.json',
      'workspace/work/Local/README.md',
      'workspace/work/Local/notes.md',
    ]));
    const stagedSettings = await readJson<AppSettings>(path.join(prepared.stagingDir, 'app-settings.json'));
    expect(stagedSettings.cloudInstance).toBeUndefined();
    expect(stagedSettings.mcpConfigFile).toBeNull();
    expect(stagedSettings.coreDirectory).toBe(targetWorkspace);
    expect(stagedSettings.spaces?.find((space) => space.name === 'Local')?.sourcePath).toBeUndefined();
    expect(stagedSettings.spaces?.find((space) => space.name === 'Local')?.isSymlink).toBe(false);
    expect(stagedSettings.spaces?.find((space) => space.name === 'Drive')?.sourcePath).toBe(highConfidenceDrive);
    expect(stagedSettings.spaces?.find((space) => space.name === 'Drive')?.storageProvider).toBe('google_drive');
    expect(await readJson(path.join(prepared.flagPath))).toMatchObject({
      importId: IMPORT_ID,
      stagingDir: prepared.stagingDir,
    });
    const supportLog = await fs.readFile(path.join(prepared.stagingDir, 'logs', `migration-import-${IMPORT_ID}.log`), 'utf8');
    expect(supportLog).toContain('Migration import log');
    expect(supportLog).toContain('status: started');
    expect(supportLog).toContain('flag-written');
    expect(supportLog).toContain('reauth_connectors:');
    expect(supportLog).not.toContain('user@example.com');
    expect(supportLog).not.toContain(result.bundleDir);
  });

  it('validates a legitimate exporter-produced bundle before prepare', async () => {
    const result = await createExportedBundle();

    await expect(validateMigrationBundle({
      bundleDir: result.bundleDir,
      targetDataSchemaEpoch: 123,
    })).resolves.toMatchObject({
      bundleDir: result.bundleDir,
      manifest: {
        importId: IMPORT_ID,
      },
    });
  });

  it('leaves cloud-backed space sourcePath unset when high-confidence README evidence is missing', async () => {
    const result = await createExportedBundle();
    const targetUserDataPath = path.join(tempRoot, 'target-user-data');
    const lowConfidenceDrive = path.join(tempRoot, 'new-home', 'Library', 'CloudStorage', 'GoogleDrive-user@example.com', 'Drive');
    await writeFixtureFile(path.join(lowConfidenceDrive, 'README.md'), 'different drive readme');

    const prepared = await prepareMigrationImport({
      bundleDir: result.bundleDir,
      targetDataSchemaEpoch: 123,
      targetUserDataPath,
      spaceSourcePathCandidates: [lowConfidenceDrive],
      importFlagPath: path.join(tempRoot, 'migration-flag.json'),
      now: NOW,
    });

    const stagedSettings = await readJson<AppSettings>(path.join(prepared.stagingDir, 'app-settings.json'));
    const driveSpace = stagedSettings.spaces?.find((space) => space.name === 'Drive');
    expect(driveSpace?.sourcePath).toBeUndefined();
    expect(driveSpace?.isSymlink).toBe(true);
  });

  it('rejects epoch-incompatible bundles', async () => {
    const result = await createExportedBundle();
    await expect(validateMigrationBundle({
      bundleDir: result.bundleDir,
      targetDataSchemaEpoch: 122,
    })).rejects.toMatchObject({
      name: 'MigrationImportError',
      code: 'bundle-incompatible',
    } satisfies Partial<MigrationImportError>);
  });

  it('rejects tampered checksums', async () => {
    const result = await createExportedBundle();
    await fs.writeFile(path.join(result.dataDir, 'inbox.json'), '{"items":[9]}');
    await expectImportRejects(result.bundleDir, 'entry-checksum-mismatch');
  });

  it.each([
    ['provider token store', 'auth-tokens.json'],
    ['MCP router state', 'mcp/super-mcp-router.json'],
    ['cloud client identity', 'cloud-service-client-id.json'],
  ])('rejects manifest-listed files outside import policy: %s', async (_label, relPath) => {
    const result = await createExportedBundle();
    await addManifestEntry(result, relPath);

    await expectImportRejects(result.bundleDir, 'entry-not-in-import-policy');
  });

  it('rejects workspace files for cloud-backed pointer-only spaces', async () => {
    const result = await createExportedBundle();
    await addManifestEntry(result, 'workspace/work/Drive/drive.md');

    await expectImportRejects(result.bundleDir, 'entry-not-in-import-policy');
  });

  it('rejects unlisted data files outside import policy with the policy error', async () => {
    const result = await createExportedBundle();
    await writeFixtureFile(path.join(result.dataDir, 'cloud-service-client-id.json'), '{"clientId":"tampered"}');

    await expectImportRejects(result.bundleDir, 'entry-not-in-import-policy');
  });

  it.each([
    ['zip-slip traversal', '../outside.json', 'entry-path-invalid'],
    ['absolute path', '/tmp/outside.json', 'entry-path-invalid'],
    ['Windows-reserved name', 'CON/settings.json', 'entry-path-reserved'],
    ['NTFS ADS marker', 'notes.txt:stream', 'entry-path-ads'],
    ['trailing dot segment', 'folder./file.json', 'entry-path-trailing-dot-or-space'],
  ] satisfies ReadonlyArray<readonly [string, string, MigrationImportErrorCode]>)('rejects hostile manifest entry paths: %s', async (_label, relPath, code) => {
    const result = await createExportedBundle();
    const manifest = await readManifest(result.bundleDir);
    manifest.entries = [{ ...manifest.entries[0], relPath }];
    await writeManifest(result.bundleDir, manifest);
    await expectImportRejects(result.bundleDir, code);
  });

  it('rejects case-fold collisions across entries', async () => {
    const result = await createExportedBundle();
    const manifest = await readManifest(result.bundleDir);
    const sourceEntry = manifest.entries.find((entry) => entry.relPath === 'inbox.json');
    expect(sourceEntry).toBeDefined();
    if (!sourceEntry) return;
    await writeFixtureFile(path.join(result.dataDir, 'INBOX.json'), await fs.readFile(path.join(result.dataDir, 'inbox.json')));
    manifest.entries.push({ ...sourceEntry, relPath: 'INBOX.json' });
    await writeManifest(result.bundleDir, manifest);
    await expectImportRejects(result.bundleDir, 'entry-case-collision');
  });

  it('rejects symlinks in bundle data', async () => {
    const result = await createExportedBundle();
    await fs.rm(path.join(result.dataDir, 'inbox.json'));
    await fs.symlink(path.join(result.dataDir, 'sessions', 'session-1.json'), path.join(result.dataDir, 'inbox.json'));
    await expectImportRejects(result.bundleDir, 'entry-file-symlink');
  });

  it('rejects hardlinks in bundle data', async () => {
    const result = await createExportedBundle();
    const manifest = await readManifest(result.bundleDir);
    const sourceEntry = manifest.entries.find((entry) => entry.relPath === 'sessions/session-1.json');
    expect(sourceEntry).toBeDefined();
    if (!sourceEntry) return;
    await fs.link(
      path.join(result.dataDir, 'sessions', 'session-1.json'),
      path.join(result.dataDir, 'sessions', 'hardlink.json'),
    );
    manifest.entries.push({ ...sourceEntry, relPath: 'sessions/hardlink.json' });
    await writeManifest(result.bundleDir, manifest);
    await expectImportRejects(result.bundleDir, 'entry-file-hardlink');
  });

  it('rejects oversized and too-many-entry bundles', async () => {
    const result = await createExportedBundle();
    await expectImportRejects(result.bundleDir, 'entry-count-exceeded', { maxEntryCount: 0 });
    await expectImportRejects(result.bundleDir, 'entry-size-exceeded', { maxEntryBytes: 1 });
    await expectImportRejects(result.bundleDir, 'bundle-size-exceeded', { maxTotalBytes: 1_000 });
  });
});

describe('migration import boot adoption', () => {
  async function prepareForAdoption(targetUserDataPath: string, flagPath: string) {
    const result = await createExportedBundle();
    return prepareMigrationImport({
      bundleDir: result.bundleDir,
      targetDataSchemaEpoch: 123,
      targetUserDataPath,
      importFlagPath: flagPath,
      now: NOW,
    });
  }

  it('refuses adoption into an existing real profile and leaves userData byte-identical', async () => {
    const targetUserDataPath = path.join(tempRoot, 'target-user-data');
    const flagPath = path.join(tempRoot, 'migration-flag.json');
    const errorStatePath = path.join(tempRoot, 'migration-error.json');
    await writeFixtureFile(path.join(targetUserDataPath, 'app-settings.json'), '{"onboardingCompleted":true,"keep":"me"}');
    await writeFixtureFile(path.join(targetUserDataPath, 'sessions', 'existing.json'), '{"real":true}');
    const before = await treeSnapshot(targetUserDataPath);
    const prepared = await prepareForAdoption(targetUserDataPath, flagPath);

    const result = adoptPreparedMigrationImportSync({
      targetUserDataPath,
      importFlagPath: flagPath,
      errorStatePath,
      now: NOW,
    });

    expect(result).toMatchObject({ status: 'refused', code: 'target-not-fresh' });
    expect(await treeSnapshot(targetUserDataPath)).toEqual(before);
    expect(await fs.access(prepared.stagingDir).then(() => true, () => false)).toBe(true);
    expect(await fs.access(flagPath).then(() => true, () => false)).toBe(false);
    // The freshness reason is persisted in the error-state `detail` for remote diagnosis.
    expect(await readJson(errorStatePath)).toMatchObject({
      code: 'target-not-fresh',
      detail: 'sessions-have-user-data',
      importId: IMPORT_ID,
    });
  });

  it('moves aside a fresh profile and renames staging into userData', async () => {
    const targetUserDataPath = path.join(tempRoot, 'target-user-data');
    const flagPath = path.join(tempRoot, 'migration-flag.json');
    await writeFixtureFile(path.join(targetUserDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await writeFixtureFile(path.join(targetUserDataPath, 'Cache', 'boot-cache'), 'cache');
    const prepared = await prepareForAdoption(targetUserDataPath, flagPath);

    const result = adoptPreparedMigrationImportSync({
      targetUserDataPath,
      importFlagPath: flagPath,
      errorStatePath: path.join(tempRoot, 'migration-error.json'),
      now: NOW,
    });

    expect(result).toMatchObject({ status: 'adopted', importId: IMPORT_ID, userDataPath: targetUserDataPath });
    expect(result.status === 'adopted' ? result.backupDir : null).toBe(`${targetUserDataPath}.pre-import-backup-20260609T160000Z`);
    expect(await fs.readFile(path.join(targetUserDataPath, 'sessions', 'session-1.json'), 'utf8')).toBe('{"messages":["hello"]}');
    expect(await fs.readFile(path.join(result.status === 'adopted' && result.backupDir ? result.backupDir : '', 'Cache', 'boot-cache'), 'utf8')).toBe('cache');
    const supportLog = await fs.readFile(path.join(targetUserDataPath, 'logs', `migration-import-${IMPORT_ID}.log`), 'utf8');
    expect(supportLog).toContain('Boot adoption');
    expect(supportLog).toContain('status: success');
    expect(supportLog).toContain('backup_kept: yes');
    expect(supportLog).not.toContain(targetUserDataPath);
    expect(consumeMigrationImportNoticeSync(targetUserDataPath)).toMatchObject({
      importId: IMPORT_ID,
      reAuthChecklist: {
        connectors: expect.arrayContaining(['github', 'google', 'microsoft', 'slack']),
      },
    });
    expect(await fs.access(prepared.stagingDir).then(() => true, () => false)).toBe(false);
    expect(await fs.access(flagPath).then(() => true, () => false)).toBe(false);
  });

  it('consumes migration import notices once', async () => {
    const targetUserDataPath = path.join(tempRoot, 'target-user-data');
    const notice = {
      importId: IMPORT_ID,
      adoptedAt: NOW.toISOString(),
      reAuthChecklist: {
        providerKeys: ['openai'],
        connectors: ['github', 'microsoft'],
        cloudRepairRequired: true,
      },
    };
    await writeJson(path.join(targetUserDataPath, 'migration-import-notice.json'), notice);

    expect(consumeMigrationImportNoticeSync(targetUserDataPath)).toEqual(notice);
    expect(consumeMigrationImportNoticeSync(targetUserDataPath)).toBeNull();
    expect(await fs.access(path.join(targetUserDataPath, 'migration-import-notice.json')).then(() => true, () => false)).toBe(false);
  });

  it('is idempotent after successful adoption when the flag is gone', async () => {
    const targetUserDataPath = path.join(tempRoot, 'target-user-data');
    const flagPath = path.join(tempRoot, 'migration-flag.json');
    await writeFixtureFile(path.join(targetUserDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await prepareForAdoption(targetUserDataPath, flagPath);
    expect(adoptPreparedMigrationImportSync({
      targetUserDataPath,
      importFlagPath: flagPath,
      now: NOW,
    }).status).toBe('adopted');

    expect(adoptPreparedMigrationImportSync({
      targetUserDataPath,
      importFlagPath: flagPath,
      now: NOW,
    })).toEqual({ status: 'no-flag' });
  });
});

describe('migration import target freshness predicate', () => {
  // Mirrors a real fresh-install session index: default automations are seeded
  // into sessions/ on first launch (origin "automation", zero turns/cost) before
  // the user reaches the transfer step. See PLAN 260610_fix-migration-fresh-target-sessions.
  function automationSummary(id: string) {
    return {
      id,
      title: 'Morning Triage',
      createdAt: 1781092992137,
      updatedAt: 1781092992208,
      resolvedAt: 1781092992151,
      doneAt: null,
      starredAt: null,
      deletedAt: null,
      origin: 'automation',
      isCorrupted: false,
      preview: '# Morning Triage …',
      messageCount: 1,
      hasUserMessages: true,
      hasDraft: false,
      draftPreview: null,
      draftUpdatedAt: null,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
    };
  }

  async function writeSessionIndex(userDataPath: string, sessions: unknown[]): Promise<void> {
    await writeFixtureFile(
      path.join(userDataPath, 'sessions', 'index.json'),
      JSON.stringify({ version: 7, lastUpdated: 1781093142641, sessions }),
    );
  }

  it('treats a freshly-seeded profile (only auto-seeded automation sessions) as FRESH', async () => {
    // This is the exact bug: sessions/ exists with seeded automations and a real
    // index.json, onboardingCompleted false. It must read as fresh so import proceeds.
    const userDataPath = path.join(tempRoot, 'fresh-seeded');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await writeFixtureFile(path.join(userDataPath, 'sessions', 'folders.json'), '{}');
    await writeFixtureFile(
      path.join(userDataPath, 'sessions', 'automation-morning-triage--236fe8ba.json'),
      '{"id":"automation-morning-triage--236fe8ba"}',
    );
    await writeSessionIndex(userDataPath, [
      automationSummary('automation-morning-triage--236fe8ba'),
      automationSummary('automation-focus-weekly-prep--3f0c5cba'),
    ]);

    expect(describeMigrationImportTargetFreshnessSync(userDataPath)).toEqual({ fresh: true, reason: 'fresh' });
    expect(isFreshMigrationImportTargetSync(userDataPath)).toBe(true);
  });

  it('treats a completely empty profile as FRESH', async () => {
    const userDataPath = path.join(tempRoot, 'empty');
    await fs.mkdir(userDataPath, { recursive: true });
    expect(describeMigrationImportTargetFreshnessSync(userDataPath)).toEqual({ fresh: true, reason: 'fresh' });
  });

  it('refuses when a manual (user-opened) session exists', async () => {
    const userDataPath = path.join(tempRoot, 'manual');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await writeSessionIndex(userDataPath, [
      automationSummary('automation-morning-triage--1'),
      { ...automationSummary('chat--abc'), origin: 'manual' },
    ]);
    expect(describeMigrationImportTargetFreshnessSync(userDataPath)).toEqual({
      fresh: false,
      reason: 'sessions-have-user-data',
    });
  });

  it('refuses when a session shows real model usage (a turn ran)', async () => {
    const userDataPath = path.join(tempRoot, 'used-automation');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await writeSessionIndex(userDataPath, [
      { ...automationSummary('automation-x--1'), usage: { costUsd: 0.01, inputTokens: 10, outputTokens: 5, turnCount: 1 } },
    ]);
    expect(describeMigrationImportTargetFreshnessSync(userDataPath).fresh).toBe(false);
  });

  it('refuses (conservatively) when sessions/ has session files but no parseable index', async () => {
    const userDataPath = path.join(tempRoot, 'no-index');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await writeFixtureFile(path.join(userDataPath, 'sessions', 'real-session.json'), '{"real":true}');
    expect(describeMigrationImportTargetFreshnessSync(userDataPath)).toEqual({
      fresh: false,
      reason: 'sessions-have-user-data',
    });
  });

  it('refuses when onboarding has been completed', async () => {
    const userDataPath = path.join(tempRoot, 'onboarded');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":true}');
    expect(describeMigrationImportTargetFreshnessSync(userDataPath)).toEqual({
      fresh: false,
      reason: 'onboarding-completed',
    });
  });

  it('refuses when app-settings.json is unreadable', async () => {
    const userDataPath = path.join(tempRoot, 'broken-settings');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), 'not json {');
    expect(describeMigrationImportTargetFreshnessSync(userDataPath)).toEqual({
      fresh: false,
      reason: 'settings-unreadable',
    });
  });

  it('refuses when the legacy agent-sessions dir exists', async () => {
    const userDataPath = path.join(tempRoot, 'legacy-agent-sessions');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await fs.mkdir(path.join(userDataPath, 'agent-sessions'), { recursive: true });
    expect(describeMigrationImportTargetFreshnessSync(userDataPath)).toEqual({
      fresh: false,
      reason: 'agent-sessions-present',
    });
  });

  it('treats other zero-usage seeded origins (role, focus) as FRESH', async () => {
    const userDataPath = path.join(tempRoot, 'other-seeded');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await writeSessionIndex(userDataPath, [
      { ...automationSummary('role--1'), origin: 'role' },
      { ...automationSummary('focus--2'), origin: 'focus' },
    ]);
    expect(describeMigrationImportTargetFreshnessSync(userDataPath).fresh).toBe(true);
  });

  // F1 (reviewer must-address): a parseable but stale/empty index must not hide a
  // real session payload left on disk by a crash before the index was rewritten.
  it('refuses when an unindexed session payload exists on disk (stale/empty index)', async () => {
    const userDataPath = path.join(tempRoot, 'orphan-payload');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await writeSessionIndex(userDataPath, []); // index lists nothing…
    await writeFixtureFile(path.join(userDataPath, 'sessions', 'real-chat--orphan.json'), '{"id":"real-chat--orphan"}'); // …but a real payload exists
    expect(describeMigrationImportTargetFreshnessSync(userDataPath)).toEqual({
      fresh: false,
      reason: 'sessions-have-user-data',
    });
  });

  it('refuses when the index contains a malformed entry', async () => {
    const userDataPath = path.join(tempRoot, 'malformed-index');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await writeSessionIndex(userDataPath, [{ notAnEntry: true }]);
    expect(describeMigrationImportTargetFreshnessSync(userDataPath).fresh).toBe(false);
  });

  // F3 (reviewer suggestion): cloud sidecar files are not session payloads, so a
  // profile holding only sidecars (no payloads, no index) stays FRESH.
  it('treats a sessions/ dir with only cloud sidecar files as FRESH', async () => {
    const userDataPath = path.join(tempRoot, 'sidecars-only');
    await writeFixtureFile(path.join(userDataPath, 'app-settings.json'), '{"onboardingCompleted":false}');
    await writeFixtureFile(path.join(userDataPath, 'sessions', 'cloud-outbox.json'), '[]');
    await writeFixtureFile(path.join(userDataPath, 'sessions', 'cloud-sync-meta.json'), '{}');
    expect(describeMigrationImportTargetFreshnessSync(userDataPath).fresh).toBe(true);
  });
});
