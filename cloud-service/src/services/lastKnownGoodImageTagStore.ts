/**
 * Last-Known-Good Image Tag Store
 *
 * Persists, in the Fly /data volume, the image tag of the last cloud-service
 * boot that reached the success-marker grace expiry (see Stage C1 of
 * docs/plans/260510_cloud_image_rollback_defense_in_depth.md). The
 * pre-bootstrap watchdog (Stage C2) reads this record on the next boot if
 * `bootStateStore` shows the prior boot crashed, and rolls the Fly machine
 * back to this tag.
 *
 * Intentionally narrow imports — the watchdog must run before any heavy
 * server module evaluates, so this file uses only `node:fs` and `node:path`.
 * No store factory, no electron-store, no Zod, no pino. All errors are
 * caught and surfaced via the caller's structured-logging contract.
 *
 * File layout under the configured data path:
 *   <dataPath>/last-known-good-image.json   — main record
 *   <dataPath>/last-known-good-image.json.tmp — atomic-rename staging
 *
 * Per Decision D5 (and D7-revised: no GHCR HEAD precheck in this module —
 * the watchdog handles it).
 */

import fs from 'node:fs';
import path from 'node:path';

export const LKG_RECORD_VERSION = 1;

export interface LkgRecordPreviousEntry {
  imageTag: string;
  schemaFingerprint: string;
  recordedAt: number;
}

export interface LkgRecord {
  version: typeof LKG_RECORD_VERSION;
  imageTag: string;
  buildCommit: string;
  schemaFingerprint: string;
  recordedAt: number;
  previousLastKnownGood: LkgRecordPreviousEntry | null;
  /**
   * True only when this record was the Dockerfile-baked fallback (see Stage
   * C1 first-boot mitigation, F7). Watchdog uses this hint to recognise a
   * synthetic record so it does not loop trying to roll back to the running
   * image. The anti-self-rollback check (C2 step 3d) is the primary guard.
   */
  isBootstrapFallback?: true;
}

export interface LastKnownGoodImageTagStore {
  /** Returns the parsed record, or `null` if the file is missing or unparsable. */
  read(): LkgRecord | null;
  /** Atomic write via temp-file rename. Throws on filesystem failure. */
  write(record: LkgRecord): void;
  /** Convenience: deletes both the main record and any leftover tmp file. */
  clear(): void;
  /** Returns the absolute file path the store reads/writes from. */
  filePath(): string;
}

export interface CreateLkgStoreOptions {
  /**
   * Directory containing the record file. In production this is the Fly
   * volume root (typically `/data`). Tests pass a temp directory.
   */
  dataPath: string;
  /**
   * Optional alternate file name. Defaults to `last-known-good-image.json`.
   */
  fileName?: string;
}

const DEFAULT_FILE_NAME = 'last-known-good-image.json';

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeAtomic(filePath: string, contents: string): void {
  ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, contents, { encoding: 'utf8' });
  fs.renameSync(tmpPath, filePath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceRecord(parsed: unknown): LkgRecord | null {
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== LKG_RECORD_VERSION) return null;

  const {
    imageTag,
    buildCommit,
    schemaFingerprint,
    recordedAt,
    previousLastKnownGood,
    isBootstrapFallback,
  } = parsed;

  if (typeof imageTag !== 'string' || imageTag.length === 0) return null;
  if (typeof buildCommit !== 'string') return null;
  if (typeof schemaFingerprint !== 'string' || schemaFingerprint.length === 0) return null;
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) return null;

  let previous: LkgRecordPreviousEntry | null = null;
  if (previousLastKnownGood !== null && previousLastKnownGood !== undefined) {
    if (!isPlainObject(previousLastKnownGood)) return null;
    const prevTag = previousLastKnownGood.imageTag;
    const prevFingerprint = previousLastKnownGood.schemaFingerprint;
    const prevRecordedAt = previousLastKnownGood.recordedAt;
    if (typeof prevTag !== 'string' || prevTag.length === 0) return null;
    if (typeof prevFingerprint !== 'string' || prevFingerprint.length === 0) return null;
    if (typeof prevRecordedAt !== 'number' || !Number.isFinite(prevRecordedAt)) return null;
    previous = {
      imageTag: prevTag,
      schemaFingerprint: prevFingerprint,
      recordedAt: prevRecordedAt,
    };
  }

  const record: LkgRecord = {
    version: LKG_RECORD_VERSION,
    imageTag,
    buildCommit,
    schemaFingerprint,
    recordedAt,
    previousLastKnownGood: previous,
  };

  if (isBootstrapFallback === true) {
    record.isBootstrapFallback = true;
  }

  return record;
}

export function createLastKnownGoodImageTagStore(
  options: CreateLkgStoreOptions,
): LastKnownGoodImageTagStore {
  const filePath = path.join(options.dataPath, options.fileName ?? DEFAULT_FILE_NAME);

  return {
    read(): LkgRecord | null {
      try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        return coerceRecord(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    write(record: LkgRecord): void {
      writeAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`);
    },
    clear(): void {
      for (const target of [filePath, `${filePath}.tmp`]) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
    },
    filePath(): string {
      return filePath;
    },
  };
}
