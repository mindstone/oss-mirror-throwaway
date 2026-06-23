import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createScopedLogger, type Logger } from '@core/logger';
import { type StoreFactory } from '@core/storeFactory';
import { cloudStorePathOnlyFactory } from './cloudStorePathFactory';
import { normalizeAuthorId } from '@core/services/inboundAuthorPolicy/normalizeAuthorId';
import {
  SlackRecentSenderDtoSchema,
  type InboundAuthorConnector,
  type PrincipalKind,
  type SlackRecentSenderChannelType,
  type SlackRecentSenderDto,
  type SlackRecentSenderKind,
} from '@rebel/shared';

const defaultLog = createScopedLogger({ service: 'slackRecentSendersStore' });
const MAX_DISTINCT_PRINCIPALS = 50;

const SlackRecentSenderRecordSchema = SlackRecentSenderDtoSchema.extend({
  transport: z.enum(['slack', 'teams', 'email', 'whatsapp', 'discord']),
});
type SlackRecentSenderRecord = z.infer<typeof SlackRecentSenderRecordSchema>;

const LegacySlackRecentSenderRecordSchema = z.object({
  principalKey: z.string(),
  kind: z.enum(['human', 'agent', 'unknown']),
  authorId: z.string(),
  displayName: z.string().optional(),
  handle: z.string().optional(),
  teamId: z.string(),
  lastSeenAt: z.number(),
  attemptCount: z.number().int().nonnegative(),
  channelIds: z.array(z.string()),
  lastChannelType: z.enum(['channel', 'group', 'im', 'mpim']).optional(),
  transport: z.enum(['slack', 'teams', 'email', 'whatsapp', 'discord']),
});
type LegacySlackRecentSenderRecord = z.infer<typeof LegacySlackRecentSenderRecordSchema>;

const SlackRecentSendersFileSchema = z.object({
  entries: z.array(z.unknown()),
});

interface StorePathOnly {
  path: string;
}

export interface SlackRecentSenderAttempt {
  transport: InboundAuthorConnector;
  teamId: string;
  principalKind: Extract<SlackRecentSenderKind, 'human' | 'agent'>;
  authorId: string;
  normalizedAuthorId?: string;
  channelId: string;
  channelType: SlackRecentSenderChannelType;
  displayName?: string;
  handle?: string;
  seenAt?: number;
}

export interface SlackRecentSendersStore {
  recordAttempt(attempt: SlackRecentSenderAttempt): SlackRecentSenderDto;
  list(teamId: string): SlackRecentSenderDto[];
  remove(principalKey: string): boolean;
  clear(teamId: string): number;
}

export function buildSlackRecentSenderPrincipalKey(args: {
  transport: InboundAuthorConnector;
  teamId: string;
  principalKind: PrincipalKind;
  normalizedAuthorId: string;
}): string {
  return `${args.transport}:${args.teamId}:${args.principalKind}:${args.normalizedAuthorId}`;
}

function writeAtomic(filePath: string, entries: SlackRecentSenderRecord[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function normalizeChannelType(channelType: LegacySlackRecentSenderRecord['lastChannelType']): SlackRecentSenderChannelType {
  if (channelType === 'im' || channelType === 'mpim' || channelType === 'channel') {
    return channelType;
  }
  return 'channel';
}

function migrateLegacyRecord(record: LegacySlackRecentSenderRecord): SlackRecentSenderRecord | null {
  if (record.kind === 'unknown') {
    return null;
  }
  const normalizedAuthorId = normalizeAuthorId(record.transport, record.authorId);
  return SlackRecentSenderRecordSchema.parse({
    principalKey: record.principalKey,
    kind: record.kind,
    authorId: record.authorId,
    normalizedAuthorId,
    displayName: record.displayName,
    handle: record.handle,
    teamId: record.teamId,
    lastSeenAt: record.lastSeenAt,
    attemptCount: record.attemptCount,
    channelIds: [...new Set(record.channelIds)],
    lastChannelType: normalizeChannelType(record.lastChannelType),
    transport: record.transport,
  });
}

function evictOldestByTeam(entries: SlackRecentSenderRecord[], teamId: string): SlackRecentSenderRecord[] {
  const sameTeam = entries.filter((entry) => entry.teamId === teamId);
  if (sameTeam.length <= MAX_DISTINCT_PRINCIPALS) return entries;

  const removeCount = sameTeam.length - MAX_DISTINCT_PRINCIPALS;
  const toEvict = [...sameTeam]
    .sort((a, b) => a.lastSeenAt - b.lastSeenAt)
    .slice(0, removeCount);
  const evictKeys = new Set(toEvict.map((entry) => entry.principalKey));

  return entries.filter((entry) => !(entry.teamId === teamId && evictKeys.has(entry.principalKey)));
}

function toDto(entry: SlackRecentSenderRecord): SlackRecentSenderDto {
  return {
    principalKey: entry.principalKey,
    kind: entry.kind,
    authorId: entry.authorId,
    normalizedAuthorId: entry.normalizedAuthorId,
    displayName: entry.displayName,
    handle: entry.handle,
    teamId: entry.teamId,
    lastSeenAt: entry.lastSeenAt,
    attemptCount: entry.attemptCount,
    channelIds: [...entry.channelIds],
    lastChannelType: entry.lastChannelType,
  };
}

export function createSlackRecentSendersStore(deps?: {
  storeFactory?: StoreFactory;
  log?: Logger;
  now?: () => number;
}): SlackRecentSendersStore {
  const storeFactory = deps?.storeFactory ?? cloudStorePathOnlyFactory;
  const logger = deps?.log ?? defaultLog;
  const now = deps?.now ?? Date.now;
  const storePath = (storeFactory({ name: 'slack/recentSenders', defaults: {} }) as StorePathOnly).path;

  function readEntries(): SlackRecentSenderRecord[] {
    if (!fs.existsSync(storePath)) return [];
    try {
      const parsed = SlackRecentSendersFileSchema.parse(JSON.parse(fs.readFileSync(storePath, 'utf8')));
      let didMigrate = false;
      const entries = parsed.entries.flatMap((candidate) => {
        const current = SlackRecentSenderRecordSchema.safeParse(candidate);
        if (current.success) return [current.data];

        const legacy = LegacySlackRecentSenderRecordSchema.safeParse(candidate);
        if (!legacy.success) {
          didMigrate = true;
          return [];
        }

        const migrated = migrateLegacyRecord(legacy.data);
        didMigrate = true;
        return migrated ? [migrated] : [];
      });

      if (didMigrate) {
        writeEntries(entries);
      }
      return entries;
    } catch (err) {
      logger.error({ err, filePath: storePath }, 'Slack recent senders store is unreadable; returning an empty list');
      return [];
    }
  }

  function writeEntries(entries: SlackRecentSenderRecord[]): void {
    writeAtomic(storePath, entries);
  }

  return {
    recordAttempt(attempt) {
      const entries = readEntries();
      const rawAuthorId = attempt.authorId.trim();
      const normalizedAuthorId = attempt.normalizedAuthorId
        ? normalizeAuthorId(attempt.transport, attempt.normalizedAuthorId)
        : normalizeAuthorId(attempt.transport, rawAuthorId);
      const principalKey = buildSlackRecentSenderPrincipalKey({
        transport: attempt.transport,
        teamId: attempt.teamId,
        principalKind: attempt.principalKind,
        normalizedAuthorId,
      });
      const seenAt = attempt.seenAt ?? now();
      const channelIdSet = new Set<string>();
      const normalizedChannelId = attempt.channelId.trim();
      if (normalizedChannelId) {
        channelIdSet.add(normalizedChannelId);
      }

      const existingIndex = entries.findIndex((entry) => entry.principalKey === principalKey);
      if (existingIndex >= 0) {
        const existing = entries[existingIndex];
        const mergedChannelIds = new Set(existing.channelIds);
        for (const channelId of channelIdSet) {
          mergedChannelIds.add(channelId);
        }
        entries[existingIndex] = SlackRecentSenderRecordSchema.parse({
          ...existing,
          authorId: rawAuthorId || existing.authorId,
          normalizedAuthorId,
          displayName: attempt.displayName ?? existing.displayName,
          handle: attempt.handle ?? existing.handle,
          lastSeenAt: seenAt,
          attemptCount: existing.attemptCount + 1,
          channelIds: [...mergedChannelIds],
          lastChannelType: attempt.channelType,
        });
      } else {
        entries.push(SlackRecentSenderRecordSchema.parse({
          principalKey,
          teamId: attempt.teamId,
          transport: attempt.transport,
          kind: attempt.principalKind,
          authorId: rawAuthorId || normalizedAuthorId,
          normalizedAuthorId,
          displayName: attempt.displayName,
          handle: attempt.handle,
          lastSeenAt: seenAt,
          attemptCount: 1,
          channelIds: [...channelIdSet],
          lastChannelType: attempt.channelType,
        }));
      }

      const prunedEntries = evictOldestByTeam(entries, attempt.teamId);
      writeEntries(prunedEntries);
      const persisted = prunedEntries.find((entry) => entry.principalKey === principalKey);
      if (!persisted) {
        return {
          principalKey,
          kind: attempt.principalKind,
          authorId: rawAuthorId || normalizedAuthorId,
          normalizedAuthorId,
          displayName: attempt.displayName,
          handle: attempt.handle,
          teamId: attempt.teamId,
          lastSeenAt: seenAt,
          attemptCount: 1,
          channelIds: [...channelIdSet],
          lastChannelType: attempt.channelType,
        };
      }
      return toDto(persisted);
    },

    list(teamId) {
      return readEntries()
        .filter((entry) => entry.teamId === teamId)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map(toDto);
    },

    remove(principalKey) {
      const entries = readEntries();
      const nextEntries = entries.filter((entry) => entry.principalKey !== principalKey);
      if (nextEntries.length === entries.length) return false;
      writeEntries(nextEntries);
      return true;
    },

    clear(teamId) {
      const entries = readEntries();
      const nextEntries = entries.filter((entry) => entry.teamId !== teamId);
      const cleared = entries.length - nextEntries.length;
      if (cleared > 0) {
        writeEntries(nextEntries);
      }
      return cleared;
    },
  };
}
