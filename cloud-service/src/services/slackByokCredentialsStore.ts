import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '@core/logger';
import type { StoreFactory } from '@core/storeFactory';

const SlackByokCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  signingSecret: z.string().min(1),
  installedAt: z.string().min(1),
});

export interface SlackByokCredentials {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  installedAt: string;
}

export interface SlackByokCredentialsStore {
  get(): Promise<SlackByokCredentials | null>;
  set(creds: SlackByokCredentials): Promise<void>;
  clear(): Promise<void>;
}

interface StorePathOnly {
  path: string;
}

export class SlackByokCredentialsStorePermissionError extends Error {
  public readonly code = 'SLACK_BYOK_CREDENTIALS_STORE_INSECURE_PERMISSIONS';

  constructor(
    public readonly targetPath: string,
    public readonly actualMode: number,
    public readonly expectedMode: number,
  ) {
    super(
      `Slack BYOK credentials store permissions are too broad for ${targetPath}: ${actualMode.toString(8)} !== ${expectedMode.toString(8)}`,
    );
    this.name = 'SlackByokCredentialsStorePermissionError';
  }
}

function modeBits(stats: fsSync.Stats): number {
  return stats.mode & 0o777;
}

async function assertSecureFileMode(filePath: string, log: Logger): Promise<void> {
  if (process.platform === 'win32') return;
  const stats = await fs.stat(filePath);
  const actualMode = modeBits(stats);
  if (actualMode === 0o600) return;

  const err = new SlackByokCredentialsStorePermissionError(filePath, actualMode, 0o600);
  log.error(
    { err, targetPath: filePath, mode: actualMode.toString(8), expectedMode: '600', kind: 'file' },
    'Slack BYOK credentials store permissions are too broad; refusing to read secrets',
  );
  throw err;
}

async function ensureSecureDirectory(dirPath: string, log: Logger): Promise<void> {
  if (!fsSync.existsSync(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(dirPath, 0o700);
    return;
  }

  if (process.platform === 'win32') return;
  const actualMode = modeBits(await fs.stat(dirPath));
  if (actualMode <= 0o700) return;

  const err = new SlackByokCredentialsStorePermissionError(dirPath, actualMode, 0o700);
  log.error(
    { err, targetPath: dirPath, mode: actualMode.toString(8), expectedMode: '700', kind: 'directory' },
    'Slack BYOK credentials directory permissions are too broad; refusing to read secrets',
  );
  throw err;
}

async function writeAtomic(filePath: string, value: SlackByokCredentials, log: Logger): Promise<void> {
  const dirPath = path.dirname(filePath);
  await ensureSecureDirectory(dirPath, log);
  if (fsSync.existsSync(filePath)) {
    await assertSecureFileMode(filePath, log);
  }
  const tmpPath = `${filePath}.tmp`;
  const fd = await fs.open(tmpPath, 'wx', 0o600);
  try {
    await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
  } finally {
    await fd.close();
  }
  if (process.platform !== 'win32') await assertSecureFileMode(tmpPath, log);
  await fs.rename(tmpPath, filePath);
  if (process.platform !== 'win32') await assertSecureFileMode(filePath, log);
}

export function createSlackByokCredentialsStore(opts: {
  storeFactory: StoreFactory;
  log: Logger;
}): SlackByokCredentialsStore {
  const storePath = (opts.storeFactory({ name: 'cloud/slack-byok-credentials', defaults: {} }) as StorePathOnly).path;
  const { log } = opts;

  async function recoverTmp(): Promise<void> {
    const tmpPath = `${storePath}.tmp`;
    if (!fsSync.existsSync(tmpPath)) return;
    if (fsSync.existsSync(storePath)) {
      log.warn({ filePath: storePath, tmpPath }, 'tmp file found alongside main BYOK credentials store; using main, removing tmp');
      await fs.unlink(tmpPath);
      return;
    }
    log.warn({ filePath: storePath, tmpPath }, 'tmp file found without main BYOK credentials store; removing tmp');
    await fs.unlink(tmpPath);
  }

  async function read(): Promise<SlackByokCredentials | null> {
    await recoverTmp();
    if (!fsSync.existsSync(storePath)) return null;
    await assertSecureFileMode(storePath, log);

    try {
      const raw = await fs.readFile(storePath, 'utf8');
      return SlackByokCredentialsSchema.parse(JSON.parse(raw));
    } catch (err) {
      if (err instanceof SlackByokCredentialsStorePermissionError) {
        throw err;
      }
      log.error({ err, filePath: storePath }, 'Slack BYOK credentials store JSON is unreadable');
      return null;
    }
  }

  return {
    get: read,
    async set(creds) {
      await writeAtomic(storePath, SlackByokCredentialsSchema.parse(creds), log);
    },
    async clear() {
      await Promise.all([storePath, `${storePath}.tmp`].map(async (filePath) => {
        if (!fsSync.existsSync(filePath)) return;
        await fs.unlink(filePath);
      }));
    },
  };
}
