import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Buffer } from '@core/utils/safeSnapshotCopy';
import type { AppSettings, SpaceConfig } from '@shared/types/settings';
import {
  exportMigrationBundle,
  MigrationExportError,
} from '../migrationExportService';
import { parseMigrationBundleManifest } from '../migrationManifest';

const NOW = new Date('2026-06-09T14:00:00.000Z');
const IMPORT_ID = 'a89ebd43-7c41-4a30-b81b-b8cc886b9824';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-migration-export-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function writeFixtureFile(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
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

async function sourceTreeSnapshot(rootPath: string): Promise<Record<string, {
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
  sha256?: string;
  linkTarget?: string;
}>> {
  const result: Record<string, {
    type: 'file' | 'dir' | 'symlink' | 'other';
    size: number;
    mtimeMs: number;
    sha256?: string;
    linkTarget?: string;
  }> = {};

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
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: stat.isFile() ? sha256Buffer(await fs.readFile(currentPath)) : undefined,
      linkTarget: stat.isSymbolicLink() ? await fs.readlink(currentPath) : undefined,
    };
    if (!stat.isDirectory()) return;
    const entries = await fs.readdir(currentPath);
    for (const entry of entries) {
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
  externalSpacePath?: string;
  spaces?: SpaceConfig[];
  includeCloud?: boolean;
}): AppSettings {
  return {
    coreDirectory: args.coreDirectory,
    mcpConfigFile: path.join(args.sourceUserDataPath, 'mcp', 'super-mcp-router.json'),
    onboardingCompleted: true,
    theme: 'dark',
    providerKeys: { openai: 'openai-secret' },
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
      makeSpace({
        name: 'External',
        path: 'work/External',
        isSymlink: true,
        sourcePath: args.externalSpacePath,
        storageProvider: 'local',
      }),
    ],
  } as unknown as AppSettings;
}

async function createSourceFixture(): Promise<{
  sourceUserDataPath: string;
  coreDirectory: string;
  cloudSpacePath: string;
  externalSpacePath: string;
  destBundleDir: string;
  settings: AppSettings;
}> {
  const sourceUserDataPath = path.join(tempRoot, 'source-user-data');
  const coreDirectory = path.join(tempRoot, 'Library');
  const cloudSpacePath = path.join(tempRoot, 'Library', 'CloudStorage', 'GoogleDrive-user@example.com', 'Drive');
  const externalSpacePath = path.join(tempRoot, 'external-local-space');
  const destBundleDir = path.join(tempRoot, 'bundle');

  await writeFixtureFile(path.join(sourceUserDataPath, 'app-settings.json'), JSON.stringify({
    providerKeys: { openai: 'raw-openai-secret' },
    cloudInstance: { cloudToken: 'raw-cloud-secret' },
  }));
  await writeFixtureFile(path.join(sourceUserDataPath, 'sessions', 'session-1.json'), '{"messages":["hello"]}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'sessions', 'session-1.assets', 'asset.png'), Buffer.from([1, 2, 3]));
  await writeFixtureFile(path.join(sourceUserDataPath, 'sessions', 'continuity-v2-cleanup-done'), 'derived');
  await writeFixtureFile(path.join(sourceUserDataPath, 'sessions-deleted', 'deleted.json'), '{"deleted":true}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'agent-sessions', 'legacy.json'), '{"legacy":true}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'inbox.json'), '{"items":[]}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'memory-history.json'), '{"memories":[]}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'mcp', 'super-mcp-router.json'), '{"secret":"router"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'mcp', 'slack', 'config.json'), '{"token":"slack"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'auth-tokens.json'), '{"token":"auth"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'codex-oauth-tokens.json'), '{"token":"codex"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'fly-tokens.json'), '{"token":"fly"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'cloud-token-store.json'), '{"token":"cloud"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'plugin-storage.json'), '{"token":"plugin"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'plugin-data', 'plugin.json'), '{"token":"plugin-data"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'cloud-service-client-id.json'), '{"id":"device"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'connector-contributions.json'), '{"token":"connector"}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'cloud-outbox', 'pending.json'), '{"pending":true}');
  await writeFixtureFile(path.join(sourceUserDataPath, 'logs', 'app.log'), 'log');
  await writeFixtureFile(path.join(sourceUserDataPath, 'cost-ledger.jsonl'), '{}\n');

  await writeFixtureFile(path.join(coreDirectory, 'README.md'), 'library root');
  await writeFixtureFile(path.join(coreDirectory, 'work', 'Local', 'README.md'), 'local readme');
  await writeFixtureFile(path.join(coreDirectory, 'work', 'Local', 'notes.md'), 'local notes');
  await writeFixtureFile(path.join(cloudSpacePath, 'README.md'), 'drive readme');
  await writeFixtureFile(path.join(cloudSpacePath, 'drive.md'), 'drive notes');
  await writeFixtureFile(path.join(externalSpacePath, 'README.md'), 'external readme');
  await writeFixtureFile(path.join(externalSpacePath, 'external.md'), 'external notes');

  const settings = makeSettings({
    sourceUserDataPath,
    coreDirectory,
    cloudSpacePath,
    externalSpacePath,
  });

  return { sourceUserDataPath, coreDirectory, cloudSpacePath, externalSpacePath, destBundleDir, settings };
}

async function runExport(fixture: Awaited<ReturnType<typeof createSourceFixture>>) {
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

describe('exportMigrationBundle', () => {
  it('exports a parseable, hash-verified bundle without modifying the source userData fixture', async () => {
    const fixture = await createSourceFixture();
    const before = await sourceTreeSnapshot(fixture.sourceUserDataPath);

    const result = await runExport(fixture);
    const after = await sourceTreeSnapshot(fixture.sourceUserDataPath);

    expect(after).toEqual(before);
    expect(result.containsSensitiveHistory).toBe(true);
    expect(result.sensitiveCounts.copiedSessionFiles).toBe(2);
    expect(result.sensitiveCounts.copiedSpaceFiles).toBe(2);
    expect(await listFiles(result.bundleDir)).toContain(`logs/migration-export-${IMPORT_ID}.log`);
    const supportLog = await fs.readFile(path.join(result.bundleDir, 'logs', `migration-export-${IMPORT_ID}.log`), 'utf8');
    expect(supportLog).toContain('Migration export log');
    expect(supportLog).toContain('status: success');
    expect(supportLog).toContain('reauth_connectors:');
    expect(supportLog).not.toContain(fixture.sourceUserDataPath);
    expect(supportLog).not.toContain('user@example.com');

    const manifestRaw = JSON.parse(await fs.readFile(result.manifestPath, 'utf8')) as unknown;
    const parsed = parseMigrationBundleManifest(manifestRaw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.manifest.createdAt).toBe(NOW.toISOString());
    expect(parsed.manifest.oldPaths.userDataPath).toBe(fixture.sourceUserDataPath);
    expect(parsed.manifest.entries.map((entry) => entry.relPath)).toEqual(expect.arrayContaining([
      'app-settings.json',
      'sessions/session-1.json',
      'sessions/session-1.assets/asset.png',
      'agent-sessions/legacy.json',
      'inbox.json',
      'memory-history.json',
      'workspace/work/Local/README.md',
      'workspace/work/Local/notes.md',
    ]));
    expect(parsed.manifest.entries.map((entry) => entry.relPath)).not.toContain('sessions/continuity-v2-cleanup-done');

    for (const entry of parsed.manifest.entries) {
      const filePath = path.join(result.dataDir, ...entry.relPath.split('/'));
      const bytes = await fs.readFile(filePath);
      expect(bytes.byteLength, entry.relPath).toBe(entry.bytes);
      expect(sha256Buffer(bytes), entry.relPath).toBe(entry.sha256);
    }

    expect(parsed.manifest.reAuthChecklist.cloudRepairRequired).toBe(true);
    expect(parsed.manifest.reAuthChecklist.providerKeys).toEqual(expect.arrayContaining([
      'models',
      'providerKeys',
      'voice',
    ]));
    expect(parsed.manifest.reAuthChecklist.connectors).toEqual(expect.arrayContaining([
      'google',
      'hubspot',
      'microsoft',
      'salesforce',
      'slack',
    ]));
  });

  it('does not put deny-listed secret, cloud, mcp, plugin, or transient stores in data/', async () => {
    const fixture = await createSourceFixture();
    const result = await runExport(fixture);
    const files = await listFiles(result.dataDir);

    expect(files).not.toContain('sessions-deleted/deleted.json');
    expect(files).not.toContain('sessions/continuity-v2-cleanup-done');
    for (const relPath of files) {
      expect(relPath, relPath).not.toMatch(/^mcp(?:\/|$)/);
      expect(relPath, relPath).not.toMatch(/(^|\/)[^/]*-tokens\.json$/);
      expect(relPath, relPath).not.toMatch(/^auth-tokens\.json$/);
      expect(relPath, relPath).not.toMatch(/^plugin-storage\.json$/);
      expect(relPath, relPath).not.toMatch(/^plugin-data(?:\/|$)/);
      expect(relPath, relPath).not.toMatch(/^cloud-service-client-id\.json$/);
      expect(relPath, relPath).not.toMatch(/^connector-contributions\.json$/);
      expect(relPath, relPath).not.toMatch(/^cloud-token-store\.json$/);
    }

    const bundledSettings = await fs.readFile(path.join(result.dataDir, 'app-settings.json'), 'utf8');
    for (const forbidden of [
      'providerKeys',
      'apiKey',
      'cloudToken',
      'raw-openai-secret',
      'raw-cloud-secret',
      'openai-secret',
      'anthropic-secret',
      'voice-secret',
    ]) {
      expect(bundledSettings).not.toContain(forbidden);
    }
  });

  it('copies only internal-local spaces and records cloud-backed/external spaces as pointer-only', async () => {
    const fixture = await createSourceFixture();
    const result = await runExport(fixture);
    const spaceByName = new Map(result.manifest.spaces.map((space) => [space.name, space]));

    expect(spaceByName.get('Local')?.classification).toBe('internal-local');
    expect(spaceByName.get('Drive')?.classification).toBe('cloud-backed');
    expect(spaceByName.get('Drive')?.provider).toBe('google_drive');
    expect(spaceByName.get('External')?.classification).toBe('external-symlink');
    expect(spaceByName.get('Library root')?.classification).toBe('internal-local');
    expect(spaceByName.get('Drive')?.detectionEvidence?.resolvedPath).toBe(await fs.realpath(fixture.cloudSpacePath));
    expect(spaceByName.get('External')?.detectionEvidence?.resolvedPath).toBe(await fs.realpath(fixture.externalSpacePath));

    const files = await listFiles(result.dataDir);
    expect(files).toContain('workspace/work/Local/README.md');
    expect(files).toContain('workspace/work/Local/notes.md');
    expect(files).not.toContain('workspace/work/Drive/drive.md');
    expect(files).not.toContain('workspace/work/External/external.md');
    expect(result.sensitiveCounts.pointerOnlySpaces).toBe(2);
  });

  it('treats all spaces as pointer-only when coreDirectory is cloud-backed', async () => {
    const sourceUserDataPath = path.join(tempRoot, 'source-user-data');
    const coreDirectory = path.join(tempRoot, 'Library', 'CloudStorage', 'GoogleDrive-user@example.com', 'Rebel');
    const destBundleDir = path.join(tempRoot, 'bundle');
    await writeFixtureFile(path.join(sourceUserDataPath, 'sessions', 'session-1.json'), '{}');
    await writeFixtureFile(path.join(coreDirectory, 'work', 'Local', 'README.md'), 'cloud-backed core');

    const settings = makeSettings({
      sourceUserDataPath,
      coreDirectory,
      includeCloud: false,
      spaces: [
        makeSpace({
          name: 'Local',
          path: 'work/Local',
        }),
      ],
    });

    const result = await exportMigrationBundle({
      sourceUserDataPath,
      coreDirectory,
      settings,
      appVersion: '0.4.46',
      dataSchemaEpoch: 123,
      importId: IMPORT_ID,
      destBundleDir,
      now: NOW,
    });

    expect(result.manifest.spaces.find((space) => space.name === 'Library root')?.classification).toBe('cloud-backed');
    expect(result.manifest.spaces.find((space) => space.name === 'Local')?.classification).toBe('cloud-backed');
    expect(result.manifest.spaces.find((space) => space.name === 'Local')?.provider).toBe('google_drive');
    expect(await listFiles(result.dataDir)).not.toContain('workspace/work/Local/README.md');
  });

  it('aborts with a retryable error when a source file changes during copy', async () => {
    const fixture = await createSourceFixture();

    await expect(exportMigrationBundle({
      sourceUserDataPath: fixture.sourceUserDataPath,
      coreDirectory: fixture.coreDirectory,
      settings: fixture.settings,
      appVersion: '0.4.46',
      dataSchemaEpoch: 123,
      importId: IMPORT_ID,
      destBundleDir: fixture.destBundleDir,
      now: NOW,
      hooks: {
        afterCopyBeforeVerify: async (entry) => {
          if (entry.sourceRelativePath === 'sessions/session-1.json') {
            await fs.writeFile(entry.sourcePath, '{"messages":["mutated"]}');
          }
        },
      },
    })).rejects.toMatchObject({
      name: 'MigrationExportError',
      code: 'source-changed-during-export',
      retryable: true,
    } satisfies Partial<MigrationExportError>);
  });
});
