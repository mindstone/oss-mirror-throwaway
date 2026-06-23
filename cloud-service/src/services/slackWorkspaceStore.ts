import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import type { StoreFactory } from '@core/storeFactory';

const log = createScopedLogger({ service: 'slackWorkspaceStore' });

const LastErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  occurredAt: z.number(),
});

const SlackWorkspaceRecordSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  teamDomain: z.string().optional(),
  botUserId: z.string(),
  botToken: z.string(),
  authedUserId: z.string().optional(),
  peerInstanceCount: z.number().int().nonnegative().optional(),
  provisionMode: z.enum(['managed', 'byok']).optional(),
  installedAt: z.number(),
  lastSeenAt: z.number().optional(),
  status: z.enum(['connected', 'needs_reconnect', 'disconnecting', 'disconnected']),
  lastError: LastErrorSchema.optional(),
});

export type SlackWorkspaceRecord = z.infer<typeof SlackWorkspaceRecordSchema>;

type SlackWorkspaceStatus = SlackWorkspaceRecord['status'];

export interface SlackWorkspaceStore {
  get(): SlackWorkspaceRecord | null;
  set(record: SlackWorkspaceRecord): void;
  updateStatus(status: SlackWorkspaceStatus, error?: SlackWorkspaceRecord['lastError']): void;
  updateLastSeen(): void;
  clear(): void;
}

interface StorePathOnly {
  path: string;
}

export class SlackWorkspaceStorePermissionError extends Error {
  public readonly code = 'SLACK_WORKSPACE_STORE_INSECURE_PERMISSIONS';

  constructor(
    public readonly targetPath: string,
    public readonly actualMode: number,
    public readonly expectedMaxMode: number,
  ) {
    super(
      `Slack workspace store permissions are too broad for ${targetPath}: ${actualMode.toString(8)} > ${expectedMaxMode.toString(8)}`,
    );
    this.name = 'SlackWorkspaceStorePermissionError';
  }
}

function modeBits(stats: fs.Stats): number {
  return stats.mode & 0o777;
}

function assertSecureMode(targetPath: string, actualMode: number, expectedMaxMode: number, kind: 'file' | 'directory'): void {
  if (process.platform === 'win32' || actualMode <= expectedMaxMode) return;

  const err = new SlackWorkspaceStorePermissionError(targetPath, actualMode, expectedMaxMode);
  log.error(
    { err, targetPath, mode: actualMode.toString(8), expectedMaxMode: expectedMaxMode.toString(8), kind },
    'Slack workspace store permissions are too broad; refusing to read secrets',
  );
  throw err;
}

function ensureSecureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dirPath, 0o700);
    return;
  }

  assertSecureMode(dirPath, modeBits(fs.statSync(dirPath)), 0o700, 'directory');
}

function writeAtomic(filePath: string, value: SlackWorkspaceRecord): void {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
    assertSecureMode(filePath, modeBits(fs.statSync(filePath)), 0o600, 'file');
  }
}

export function createSlackWorkspaceStore(deps: { storeFactory: StoreFactory }): SlackWorkspaceStore {
  const storePath = (deps.storeFactory({ name: 'slack/workspace', defaults: {} }) as StorePathOnly).path;
  const dirPath = path.dirname(storePath);
  ensureSecureDirectory(dirPath);

  function recoverTmp(): void {
    const tmpPath = `${storePath}.tmp`;
    if (!fs.existsSync(tmpPath)) return;
    if (fs.existsSync(storePath)) {
      log.warn({ filePath: storePath, tmpPath }, 'tmp file found alongside main store; using main, removing tmp');
      fs.unlinkSync(tmpPath);
      return;
    }
    log.warn({ filePath: storePath, tmpPath }, 'tmp file found without main store; removing tmp');
    fs.unlinkSync(tmpPath);
  }

  function read(): SlackWorkspaceRecord | null {
    recoverTmp();
    if (!fs.existsSync(storePath)) return null;

    try {
      const stats = fs.statSync(storePath);
      assertSecureMode(storePath, modeBits(stats), 0o600, 'file');

      return SlackWorkspaceRecordSchema.parse(JSON.parse(fs.readFileSync(storePath, 'utf8')));
    } catch (err) {
      if (err instanceof SlackWorkspaceStorePermissionError) {
        throw err;
      }
      log.error({ err, filePath: storePath }, 'Slack workspace store JSON is unreadable');
      return null;
    }
  }

  return {
    get: read,
    set(record) {
      writeAtomic(storePath, SlackWorkspaceRecordSchema.parse(record));
    },
    updateStatus(status, error) {
      const current = read();
      if (!current) return;
      const next: SlackWorkspaceRecord = { ...current, status };
      if (error) {
        next.lastError = error;
      } else {
        delete next.lastError;
      }
      writeAtomic(storePath, next);
    },
    updateLastSeen() {
      const current = read();
      if (!current) return;
      writeAtomic(storePath, { ...current, lastSeenAt: Date.now() });
    },
    clear() {
      for (const filePath of [storePath, `${storePath}.tmp`]) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    },
  };
}
