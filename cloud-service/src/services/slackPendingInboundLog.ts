import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createScopedLogger, type Logger } from '@core/logger';
import { type StoreFactory } from '@core/storeFactory';
import { hashTeamId } from '@shared/utils/teamIdHash';

const defaultLog = createScopedLogger({ service: 'slackPendingInboundLog' });

export const SLACK_PENDING_INBOUND_RAW_BODY_MAX_BYTES = 16 * 1024;
export const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_LOG_ENTRIES = 10_000;
export const CLAIMED_IN_PROGRESS_TTL_MS = 10 * 60 * 1000;
export const PROCESSED_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DEFERRED_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Override the pending-inbound deferred TTL via env. The canonical name is
 * `SLACK_PENDING_INBOUND_DEFERRED_TTL_MS`; the legacy `REBEL_`-prefixed name is
 * still accepted so existing deployments don't silently revert to the default
 * during this rename. Remove the legacy fallback after the next release.
 */
function parseDeferredTtlOverride(): number | null {
  const raw =
    process.env.SLACK_PENDING_INBOUND_DEFERRED_TTL_MS
    ?? process.env.REBEL_SLACK_PENDING_INBOUND_DEFERRED_TTL_MS;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}
export const PENDING_INBOUND_DEFERRED_TTL_MS: number =
  parseDeferredTtlOverride() ?? DEFAULT_DEFERRED_TTL_MS;

const PendingInboundStateSchema = z.enum(['pending', 'claimed-in-progress', 'broadcast-deferred', 'processed']);
export type PendingInboundState = z.infer<typeof PendingInboundStateSchema>;
export type PendingInboundPriorState = 'in-progress' | 'deferred' | 'processed';

const PendingInboundEntrySchema = z.object({
  eventId: z.string().min(1),
  teamId: z.string().min(1),
  payloadHash: z.string().min(1),
  rawBody: z.string(),
  receivedAt: z.number(),
  state: PendingInboundStateSchema.default('pending'),
  ownerToken: z.string().nullable().default(null),
  claimedAt: z.number().nullable().default(null),
  processedAt: z.number().optional(),
  /**
   * Absolute time at which this non-processed entry should be dropped to
   * prevent days-stale Slack mentions replaying as ghost conversations.
   * Optional for backward compatibility with logs written before TTL existed;
   * legacy entries fall back to `receivedAt + PENDING_INBOUND_DEFERRED_TTL_MS`
   * during the next prune.
   */
  expiresAt: z.number().optional(),
});

const PendingInboundFileSchema = z.object({
  entries: z.array(PendingInboundEntrySchema),
});

export type PendingInboundEntry = z.infer<typeof PendingInboundEntrySchema>;

export interface PendingInboundLog {
  enqueue(entry: { eventId: string; teamId: string; payloadHash: string; rawBody: string; receivedAt: number }): void;
  markProcessed(eventId: string): void;
  drainUnprocessed(): PendingInboundEntry[];
  claimEventProcessing(args: { teamId: string; eventId: string }): ClaimEventProcessingResult;
  releaseAfterSuccess(args: { teamId: string; eventId: string; ownerToken: string }): void;
  markBroadcastDeferred(args: { teamId: string; eventId: string; ownerToken: string }): void;
  tryResumeClaim(args: { teamId: string; eventId: string }): ClaimEventProcessingResult;
}

export type ClaimEventProcessingResult =
  | { acquired: true; ownerToken: string; priorState?: PendingInboundPriorState }
  | { acquired: false; priorState: PendingInboundPriorState };

interface StorePathOnly {
  path: string;
}

interface CreatePendingInboundLogDeps {
  storeFactory: StoreFactory;
  log?: Logger;
  maxRawBodyBytes?: number;
  now?: () => number;
}

function writeAtomic(filePath: string, entries: PendingInboundEntry[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function effectiveExpiresAt(entry: PendingInboundEntry): number {
  return typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
    ? entry.expiresAt
    : entry.receivedAt + PENDING_INBOUND_DEFERRED_TTL_MS;
}

function pruneEntries(
  entries: PendingInboundEntry[],
  now: number,
  logger?: Logger,
): PendingInboundEntry[] {
  const cutoff = now - PROCESSED_TOMBSTONE_TTL_MS;
  const freshEntries: PendingInboundEntry[] = [];
  for (const entry of entries) {
    if (entry.state === 'processed') {
      if ((entry.processedAt ?? entry.receivedAt) >= cutoff) {
        freshEntries.push(entry);
      }
      continue;
    }
    const expiresAt = effectiveExpiresAt(entry);
    if (now >= expiresAt) {
      logger?.warn(
        {
          event: 'pending_inbound_expired',
          eventId: entry.eventId,
          teamIdHash: hashTeamId(entry.teamId),
          state: entry.state,
          ageMs: Math.max(0, now - entry.receivedAt),
          ttlMs: PENDING_INBOUND_DEFERRED_TTL_MS,
        },
        'Dropping expired Slack pending inbound entry',
      );
      continue;
    }
    freshEntries.push(entry);
  }
  if (freshEntries.length <= MAX_LOG_ENTRIES) {
    return freshEntries;
  }

  return [...freshEntries]
    .sort((a, b) => (a.processedAt ?? a.receivedAt) - (b.processedAt ?? b.receivedAt))
    .slice(freshEntries.length - MAX_LOG_ENTRIES);
}

function isClaimFresh(entry: PendingInboundEntry, now: number): boolean {
  return entry.state === 'claimed-in-progress'
    && typeof entry.claimedAt === 'number'
    && now - entry.claimedAt < CLAIMED_IN_PROGRESS_TTL_MS;
}

function priorStateFor(entry: PendingInboundEntry): PendingInboundPriorState | undefined {
  if (entry.state === 'claimed-in-progress') return 'in-progress';
  if (entry.state === 'broadcast-deferred') return 'deferred';
  if (entry.state === 'processed') return 'processed';
  return undefined;
}

const sweepIntervalsByPath = new Map<string, NodeJS.Timeout>();

function startProcessedTombstoneSweep(
  filePath: string,
  readEntries: () => PendingInboundEntry[],
  now: () => number,
  logger: Logger,
): void {
  if (sweepIntervalsByPath.has(filePath)) return;
  const interval = setInterval(() => {
    const entries = readEntries();
    const next = pruneEntries(entries, now(), logger);
    if (next.length !== entries.length) {
      writeAtomic(filePath, next);
    }
  }, CLAIMED_IN_PROGRESS_TTL_MS);
  interval.unref?.();
  sweepIntervalsByPath.set(filePath, interval);
}

export function createSlackPendingInboundLog(deps: CreatePendingInboundLogDeps): PendingInboundLog {
  const logger = deps.log ?? defaultLog;
  const maxRawBodyBytes = deps.maxRawBodyBytes ?? SLACK_PENDING_INBOUND_RAW_BODY_MAX_BYTES;
  const now = deps.now ?? Date.now;
  const storePath = (deps.storeFactory({ name: 'slack/pendingInbound', defaults: {} }) as StorePathOnly).path;

  function readEntries(): PendingInboundEntry[] {
    if (!fs.existsSync(storePath)) return [];
    try {
      const parsed = PendingInboundFileSchema.parse(JSON.parse(fs.readFileSync(storePath, 'utf8')));
      return parsed.entries;
    } catch (err) {
      logger.error({ err, filePath: storePath }, 'Slack pending inbound log is unreadable; starting with an empty replay set');
      return [];
    }
  }

  function writePruned(entries: PendingInboundEntry[]): void {
    writeAtomic(storePath, pruneEntries(entries, now(), logger));
  }

  function findEntry(entries: PendingInboundEntry[], teamId: string, eventId: string): PendingInboundEntry | undefined {
    return entries.find((entry) => entry.teamId === teamId && entry.eventId === eventId);
  }

  function claim(args: { teamId: string; eventId: string }): ClaimEventProcessingResult {
    const entries = readEntries();
    const existing = findEntry(entries, args.teamId, args.eventId);
    const ownerToken = randomUUID();
    const claimedAt = now();

    if (!existing) {
      entries.push({
        eventId: args.eventId,
        teamId: args.teamId,
        payloadHash: 'claim-pending',
        rawBody: '',
        receivedAt: claimedAt,
        state: 'claimed-in-progress',
        ownerToken,
        claimedAt,
      });
      writePruned(entries);
      return { acquired: true, ownerToken };
    }

    if (existing.state === 'processed') {
      return { acquired: false, priorState: 'processed' };
    }

    if (existing.state === 'claimed-in-progress' && isClaimFresh(existing, claimedAt)) {
      return { acquired: false, priorState: 'in-progress' };
    }

    const priorState = priorStateFor(existing);
    Object.assign(existing, {
      state: 'claimed-in-progress' satisfies PendingInboundState,
      ownerToken,
      claimedAt,
      processedAt: undefined,
    });
    writePruned(entries);
    return priorState === 'deferred'
      ? { acquired: true, ownerToken, priorState }
      : { acquired: true, ownerToken };
  }

  startProcessedTombstoneSweep(storePath, readEntries, now, logger);

  return {
    enqueue(entry) {
      if (Buffer.byteLength(entry.rawBody, 'utf8') > maxRawBodyBytes) {
        logger.warn(
          { eventId: entry.eventId, teamIdHash: hashTeamId(entry.teamId), rawBodyBytes: Buffer.byteLength(entry.rawBody, 'utf8'), maxRawBodyBytes },
          'Dropping oversized Slack pending inbound entry',
        );
        return;
      }
      const entries = readEntries();
      const existingIndex = entries.findIndex((candidate) => candidate.teamId === entry.teamId && candidate.eventId === entry.eventId);
      const parsed = PendingInboundEntrySchema.parse({
        ...entry,
        state: 'pending',
        ownerToken: null,
        claimedAt: null,
        // Anchor the deferred TTL on enqueue wall-clock rather than the
        // event's `receivedAt`. Some Slack retransmits backdate `receivedAt`
        // to the original event time, which would otherwise mark a fresh
        // enqueue as already expired. Production callers always pass the
        // real wall-clock receivedAt, but this preserves correctness when
        // they don't.
        expiresAt: now() + PENDING_INBOUND_DEFERRED_TTL_MS,
      });
      if (existingIndex >= 0) {
        entries[existingIndex] = {
          ...entries[existingIndex],
          payloadHash: parsed.payloadHash,
          rawBody: parsed.rawBody,
          receivedAt: parsed.receivedAt,
          expiresAt: parsed.expiresAt,
        };
      } else {
        entries.push(parsed);
      }
      writePruned(entries);
    },
    markProcessed(eventId) {
      const entries = readEntries();
      const processedAt = now();
      const next = entries.map((entry) => entry.eventId === eventId ? {
        ...entry,
        state: 'processed' as const,
        ownerToken: null,
        claimedAt: null,
        processedAt,
      } : entry);
      writePruned(next);
    },
    drainUnprocessed() {
      const currentTime = now();
      const allEntries = readEntries();
      const liveEntries: PendingInboundEntry[] = [];
      for (const entry of allEntries) {
        if (entry.state === 'processed') continue;
        const expiresAt = effectiveExpiresAt(entry);
        if (expiresAt <= currentTime) {
          logger.warn(
            {
              event: 'slack_replay_skipped_expired',
              eventId: entry.eventId,
              teamIdHash: hashTeamId(entry.teamId),
              state: entry.state,
              ageMs: Math.max(0, currentTime - entry.receivedAt),
              ttlMs: PENDING_INBOUND_DEFERRED_TTL_MS,
            },
            'Skipping replay of expired Slack pending inbound entry',
          );
          continue;
        }
        liveEntries.push(entry);
      }
      return liveEntries;
    },
    claimEventProcessing: claim,
    releaseAfterSuccess({ teamId, eventId, ownerToken }) {
      const entries = readEntries();
      const entry = findEntry(entries, teamId, eventId);
      if (!entry || entry.state === 'processed') {
        return;
      }
      if (entry.ownerToken !== ownerToken) {
        logger.warn({ eventId, teamIdHash: hashTeamId(teamId) }, 'Slack pending inbound release skipped because owner token did not match');
        return;
      }
      Object.assign(entry, {
        state: 'processed' satisfies PendingInboundState,
        ownerToken: null,
        claimedAt: null,
        processedAt: now(),
      });
      writePruned(entries);
    },
    markBroadcastDeferred({ teamId, eventId, ownerToken }) {
      const entries = readEntries();
      const entry = findEntry(entries, teamId, eventId);
      if (!entry || entry.state === 'processed') {
        return;
      }
      if (entry.ownerToken !== ownerToken) {
        logger.warn({ eventId, teamIdHash: hashTeamId(teamId) }, 'Slack pending inbound defer skipped because owner token did not match');
        return;
      }
      Object.assign(entry, {
        state: 'broadcast-deferred' satisfies PendingInboundState,
        ownerToken: null,
        claimedAt: null,
        processedAt: undefined,
      });
      writePruned(entries);
    },
    tryResumeClaim: claim,
  };
}
