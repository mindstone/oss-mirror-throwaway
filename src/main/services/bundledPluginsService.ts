import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import {
  PluginManifestIpcSchema,
  type PluginManifestIpc as PluginManifest,
} from '@shared/ipc/schemas/plugins';
import { getChiefOfStaffPath, writePluginToSpace } from './pluginSpaceService';
import { getSystemSettingsPath } from './systemSettingsSync';

const log = createScopedLogger({ service: 'bundledPluginsService' });

export interface BundledPluginRecord {
  id: string;
  manifest: PluginManifest;
  source: string;
  readme: string;
}

export interface SeedBundledPluginsResult {
  seeded: string[];
  skipped: string[];
  failed: string[];
  malformed: string[];
}

export async function readBundledPluginManifests(): Promise<{
  records: BundledPluginRecord[];
  malformed: Array<{ id: string; reason: string }>;
}> {
  const bundledPluginsRoot = path.join(getSystemSettingsPath(), 'plugins');
  const records: BundledPluginRecord[] = [];
  const malformed: Array<{ id: string; reason: string }> = [];

  let entries: Array<import('node:fs').Dirent<string>>;
  try {
    entries = await fs.readdir(bundledPluginsRoot, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.warn({ bundledPluginsRoot, err }, 'Bundled plugins root missing; skipping scan');
      return { records, malformed };
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(bundledPluginsRoot, entry.name);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    const sourcePath = path.join(pluginDir, 'index.tsx');
    const readmePath = path.join(pluginDir, 'README.md');

    let manifestRaw: string;
    try {
      manifestRaw = await fs.readFile(manifestPath, 'utf-8');
    } catch (err) {
      const reason = `manifest-read-failed: ${err instanceof Error ? err.message : String(err)}`;
      malformed.push({ id: entry.name, reason });
      log.warn({ pluginId: entry.name, pluginDir, err }, 'malformed-manifest');
      continue;
    }

    let source: string;
    try {
      source = await fs.readFile(sourcePath, 'utf-8');
    } catch (err) {
      const reason = `source-missing: ${err instanceof Error ? err.message : String(err)}`;
      malformed.push({ id: entry.name, reason });
      log.warn({ pluginId: entry.name, pluginDir, err }, 'source-missing');
      continue;
    }

    let manifestData: unknown;
    try {
      manifestData = JSON.parse(manifestRaw);
    } catch (err) {
      const reason = `manifest-json-invalid: ${err instanceof Error ? err.message : String(err)}`;
      malformed.push({ id: entry.name, reason });
      log.warn({ pluginId: entry.name, pluginDir, err }, 'malformed-manifest');
      continue;
    }

    const parseResult = PluginManifestIpcSchema.safeParse(manifestData);
    if (!parseResult.success) {
      const reason = parseResult.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      malformed.push({ id: entry.name, reason });
      log.warn({ pluginId: entry.name, pluginDir, reason }, 'malformed-manifest');
      continue;
    }

    let readme = '';
    try {
      readme = await fs.readFile(readmePath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.warn({ pluginId: parseResult.data.id, pluginDir, err }, 'readme-read-failed');
      }
    }

    records.push({
      id: parseResult.data.id,
      manifest: parseResult.data,
      source,
      readme,
    });
  }

  return { records, malformed };
}

export async function verifyPluginOnDisk(cosPath: string, pluginId: string): Promise<boolean> {
  const pluginDir = path.join(cosPath, 'plugins', pluginId);
  const manifestPath = path.join(pluginDir, 'manifest.json');
  const sourcePath = path.join(pluginDir, 'index.tsx');

  try {
    const [manifestRaw] = await Promise.all([
      fs.readFile(manifestPath, 'utf-8'),
      fs.readFile(sourcePath, 'utf-8'),
    ]);

    const parsed = JSON.parse(manifestRaw);
    return PluginManifestIpcSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
}

export async function seedBundledPluginsToSpace(opts: {
  alreadySeededIds: string[];
}): Promise<SeedBundledPluginsResult> {
  const result: SeedBundledPluginsResult = {
    seeded: [],
    skipped: [],
    failed: [],
    malformed: [],
  };

  const { records, malformed } = await readBundledPluginManifests();
  for (const entry of malformed) {
    result.malformed.push(entry.id);
    log.warn({ pluginId: entry.id, reason: entry.reason }, 'malformed-manifest');
  }

  if (records.length === 0) {
    log.info(
      {
        seededCount: result.seeded.length,
        skippedCount: result.skipped.length,
        failedCount: result.failed.length,
        malformedCount: result.malformed.length,
      },
      'seed-bundled-plugins-complete',
    );
    return result;
  }

  let cosPath = await getChiefOfStaffPath();
  if (!cosPath) {
    const settings = getSettings();
    const workspacePath = settings.coreDirectory;

    if (!workspacePath) {
      log.warn('No workspace configured — skipping bundled plugin seed');
      return result;
    }

    cosPath = path.join(workspacePath, 'Chief-of-Staff');
    try {
      await fs.mkdir(path.join(cosPath, 'plugins'), { recursive: true });
      log.info({ cosPath }, 'Created Chief-of-Staff/plugins/ for bundled plugin seed');
    } catch (err) {
      log.error({ cosPath, err }, 'Failed to create Chief-of-Staff/plugins for bundled plugin seed');
      return result;
    }
  }

  const alreadySeededIds = new Set(opts.alreadySeededIds);

  for (const record of records) {
    const pluginId = record.id;

    if (alreadySeededIds.has(pluginId)) {
      result.skipped.push(pluginId);
      log.warn({ pluginId, cosPath }, 'skipped-already-seeded');
      continue;
    }

    try {
      if (await verifyPluginOnDisk(cosPath, pluginId)) {
        result.skipped.push(pluginId);
        log.warn({ pluginId, cosPath }, 'skipped-cos-has-it');
        continue;
      }

      const writeResult = await writePluginToSpace(
        record.manifest as unknown as Record<string, unknown>,
        record.source,
        cosPath,
        { readmeOverride: record.readme || undefined },
      );

      if (!writeResult.ok) {
        result.failed.push(pluginId);
        log.error({ pluginId, cosPath, error: writeResult.error }, 'failed-write');
        continue;
      }

      const verified = await verifyPluginOnDisk(cosPath, pluginId);
      if (!verified) {
        result.failed.push(pluginId);
        log.error({ pluginId, cosPath }, 'failed-verify');
        continue;
      }

      result.seeded.push(pluginId);
      log.info({ pluginId, cosPath }, 'seeded');
    } catch (err) {
      result.failed.push(pluginId);
      log.error({ pluginId, cosPath, err }, 'failed-write');
    }
  }

  log.info(
    {
      cosPath,
      seededCount: result.seeded.length,
      skippedCount: result.skipped.length,
      failedCount: result.failed.length,
      malformedCount: result.malformed.length,
    },
    'seed-bundled-plugins-complete',
  );
  return result;
}
