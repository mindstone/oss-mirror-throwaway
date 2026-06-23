/**
 * Disk-backed Sentry offline store for the cloud service (Stage 5 / Class B / C3).
 *
 * The cloud service initialised `@sentry/node` with NO offline transport: when a
 * cloud instance can't reach Sentry — which is *exactly* the moment a
 * connectivity bug is happening — its events were dropped permanently. Desktop
 * main (via @sentry/electron) and mobile already persist offline; cloud was the
 * lossy asymmetry. This wraps the Node transport with `@sentry/core`
 * `makeOfflineTransport`, backed by a small disk queue on the Fly `/data`
 * volume so envelopes survive a transport failure and replay when connectivity
 * returns.
 *
 * Bounded by design: a long outage must NOT fill the volume. The queue caps
 * both the number of persisted envelopes and the total bytes; on overflow the
 * OLDEST envelope is evicted (the freshest signal is the most useful). All
 * filesystem work is best-effort and never throws into the transport (a store
 * failure must degrade to "drop this one envelope", not crash telemetry).
 *
 * @see ../../docs/project/ERROR_MONITORING_AND_SENTRY.md — offline transport asymmetry
 * @see https://docs.sentry.io/platforms/javascript/best-practices/offline-caching/
 */

import fs from "node:fs";
import path from "node:path";
import { serializeEnvelope, parseEnvelope } from "@sentry/core";
import type { Envelope } from "@sentry/core";
import type { OfflineStore } from "@sentry/core";
import { createScopedLogger } from "@core/logger";
import { ignoreBestEffortCleanup } from "@shared/utils/intentionalSwallow";

const log = createScopedLogger({ service: "sentry-offline-store" });

// Conservative caps: enough to ride out a meaningful outage, small enough that
// it can never threaten the /data volume. ~200 envelopes / 20MB total.
const MAX_QUEUED_ENVELOPES = 200;
const MAX_QUEUE_BYTES = 20 * 1024 * 1024;

const resolveStoreDir = (): string => {
  const dataPath = process.env.REBEL_USER_DATA || "/data";
  return path.join(dataPath, "sentry-offline");
};

/** Monotonic-ish, lexically-sortable filename so directory order == FIFO order. */
let seq = 0;
const nextFileName = (): string => {
  seq = (seq + 1) % 1_000_000;
  return `${Date.now().toString().padStart(15, "0")}-${seq.toString().padStart(6, "0")}.envelope`;
};

const listQueuedFilesSorted = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".envelope"))
      .sort(); // lexical sort == chronological (timestamp-prefixed names)
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: "sentryOfflineStore.listQueuedFilesSorted",
      reason:
        "Best-effort offline-queue fs op; a raced/missing queue file must not perturb telemetry transport",
    });
    return [];
  }
};

const totalBytes = (dir: string, files: string[]): number => {
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(path.join(dir, f)).size;
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: "sentryOfflineStore.totalBytes",
        reason:
          "Best-effort offline-queue fs op; a raced/missing queue file must not perturb telemetry transport",
      });
    }
  }
  return bytes;
};

/**
 * Evict queued envelopes until within both caps.
 *
 * `evictFrom` chooses which end loses on overflow:
 *  - `'front'` (default, used by push) — evict the OLDEST (front); newest stays.
 *  - `'back'` (used by unshift) — evict the NEWEST (back). unshift just wrote
 *    the retry envelope at the FRONT, so evicting the front would delete the
 *    very item being requeued when the queue is already at cap (review F1).
 *    Evicting from the back preserves the requeued envelope.
 */
const evictUntilWithinCaps = (dir: string, evictFrom: 'front' | 'back' = 'front'): void => {
  const files = listQueuedFilesSorted(dir);
  const takeVictim = (): string | undefined => (evictFrom === 'front' ? files.shift() : files.pop());
  // Evict by count.
  while (files.length > MAX_QUEUED_ENVELOPES) {
    const victim = takeVictim();
    if (!victim) break;
    try {
      fs.rmSync(path.join(dir, victim), { force: true });
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'sentryOfflineStore.evictByCount',
        reason:
          'Best-effort offline-queue fs op; a raced/missing queue file must not perturb telemetry transport',
      });
    }
  }
  // Evict by total bytes.
  while (files.length > 0 && totalBytes(dir, files) > MAX_QUEUE_BYTES) {
    const victim = takeVictim();
    if (!victim) break;
    try {
      fs.rmSync(path.join(dir, victim), { force: true });
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'sentryOfflineStore.evictByBytes',
        reason:
          'Best-effort offline-queue fs op; a raced/missing queue file must not perturb telemetry transport',
      });
    }
  }
};

/**
 * Create the disk-backed OfflineStore consumed by makeOfflineTransport.
 *
 * Contract (from @sentry/core OfflineStore):
 *  - push(env): store at the BACK of the queue (failed-to-send, newest).
 *  - unshift(env): store at the FRONT (a popped envelope that failed again).
 *  - shift(): remove + return the FRONT (oldest) envelope to retry, or undefined.
 */
export const createCloudSentryOfflineStore = (): OfflineStore => {
  const dir = resolveStoreDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error), dir },
      "Failed to create Sentry offline store dir; offline caching disabled (events drop on transport failure)",
    );
  }

  const writeEnvelope = (fileName: string, env: Envelope): void => {
    const serialized = serializeEnvelope(env);
    const data =
      typeof serialized === "string"
        ? Buffer.from(serialized, "utf8")
        : Buffer.from(serialized);
    fs.writeFileSync(path.join(dir, fileName), data);
  };

  return {
    async push(env: Envelope): Promise<void> {
      try {
        writeEnvelope(nextFileName(), env);
        // push appends the newest at the back → on overflow evict the oldest (front).
        evictUntilWithinCaps(dir, 'front');
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Sentry offline store push failed; dropping this envelope",
        );
      }
    },

    async unshift(env: Envelope): Promise<void> {
      // Re-queue at the FRONT: a name that sorts BEFORE any existing entry.
      try {
        const front = listQueuedFilesSorted(dir)[0];
        // Prefix with a timestamp strictly older than the current front (or now).
        const frontTs = front ? Number(front.slice(0, 15)) : Date.now();
        const ts = (Number.isFinite(frontTs) ? frontTs : Date.now()) - 1;
        seq = (seq + 1) % 1_000_000;
        const fileName = `${Math.max(0, ts).toString().padStart(15, "0")}-${seq
          .toString()
          .padStart(6, "0")}.envelope`;
        writeEnvelope(fileName, env);
        // unshift just wrote the retry envelope at the FRONT → on overflow evict
        // the NEWEST (back), never the just-requeued item (review F1).
        evictUntilWithinCaps(dir, 'back');
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Sentry offline store unshift failed; dropping this envelope",
        );
      }
    },

    async shift(): Promise<Envelope | undefined> {
      try {
        const files = listQueuedFilesSorted(dir);
        const oldest = files[0];
        if (!oldest) {
          return undefined;
        }
        const full = path.join(dir, oldest);
        const raw = fs.readFileSync(full);
        // Remove first so a parse failure can't wedge the queue on a poison entry.
        try {
          fs.rmSync(full, { force: true });
        } catch (error) {
          ignoreBestEffortCleanup(error, {
            operation: "sentryOfflineStore.shift.rmSync",
            reason:
              "Best-effort offline-queue fs op; a raced/missing queue file must not perturb telemetry transport",
          });
        }
        return parseEnvelope(new Uint8Array(raw));
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Sentry offline store shift failed; skipping queued envelope",
        );
        return undefined;
      }
    },
  };
};
