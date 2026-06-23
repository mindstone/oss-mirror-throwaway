import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import type { StoreFactory } from '@core/storeFactory';

const log = createScopedLogger({ service: 'slackOAuthStateStore' });

export const SLACK_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const SLACK_OAUTH_MAX_ACTIVE_STATES = 10;

const SlackOAuthStateRecordSchema = z.object({
  state: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  oauthCredentials: z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    signingSecret: z.string(),
  }).nullable().default(null),
  provisionMode: z.enum(['managed', 'byok']).optional(),
  redirectUri: z.string().optional(),
  createdAt: z.number(),
  used: z.boolean(),
});

const StoreDataSchema = z.object({
  states: z.record(z.string(), SlackOAuthStateRecordSchema),
});

export type SlackOAuthStateRecord = z.infer<typeof SlackOAuthStateRecordSchema>;

export interface SlackOAuthStateStore {
  activeCount(now?: number): number;
  put(record: Omit<SlackOAuthStateRecord, 'used' | 'oauthCredentials'> & Pick<Partial<SlackOAuthStateRecord>, 'oauthCredentials'>): void;
  consume(state: string, now?: number):
    | { status: 'ok'; record: SlackOAuthStateRecord }
    | { status: 'missing' | 'expired' | 'used' };
  complete(state: string): void;
  clear(): void;
}

interface StorePathOnly {
  path: string;
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function writeAtomic(filePath: string, data: z.infer<typeof StoreDataSchema>): void {
  ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function createSlackOAuthStateStore(deps: { storeFactory: StoreFactory }): SlackOAuthStateStore {
  const storePath = (deps.storeFactory({ name: 'slack/oauthStates', defaults: {} }) as StorePathOnly).path;

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

  function read(): z.infer<typeof StoreDataSchema> {
    try {
      recoverTmp();
      if (!fs.existsSync(storePath)) return { states: {} };
      return StoreDataSchema.parse(JSON.parse(fs.readFileSync(storePath, 'utf8')));
    } catch (err) {
      log.error({ err, filePath: storePath }, 'Slack OAuth state store is unreadable; resetting');
      return { states: {} };
    }
  }

  function prune(data: z.infer<typeof StoreDataSchema>, now: number): z.infer<typeof StoreDataSchema> {
    const states = Object.fromEntries(
      Object.entries(data.states).filter(([, record]) => now - record.createdAt <= SLACK_OAUTH_STATE_TTL_MS),
    );
    return { states };
  }

  return {
    activeCount(now = Date.now()) {
      const data = prune(read(), now);
      writeAtomic(storePath, data);
      return Object.values(data.states).filter((record) => !record.used).length;
    },
    put(record) {
      const now = Date.now();
      const data = prune(read(), now);
      data.states[record.state] = { ...record, oauthCredentials: record.oauthCredentials ?? null, used: false };
      writeAtomic(storePath, data);
    },
    consume(state, now = Date.now()) {
      const data = read();
      const record = data.states[state];
      if (!record) return { status: 'missing' };
      if (now - record.createdAt > SLACK_OAUTH_STATE_TTL_MS) {
        delete data.states[state];
        writeAtomic(storePath, data);
        return { status: 'expired' };
      }
      if (record.used) return { status: 'used' };
      const usedRecord = { ...record, used: true };
      data.states[state] = usedRecord;
      writeAtomic(storePath, data);
      return { status: 'ok', record: usedRecord };
    },
    complete(state) {
      const data = read();
      delete data.states[state];
      writeAtomic(storePath, data);
    },
    clear() {
      for (const filePath of [storePath, `${storePath}.tmp`]) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    },
  };
}
