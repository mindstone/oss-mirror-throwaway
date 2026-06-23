/**
 * Boot State Store
 *
 * Per-boot record on the Fly /data volume tracking whether the most recent
 * boot reached the success-marker grace expiry. The pre-bootstrap watchdog
 * (Stage C2 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md)
 * reads this record at startup. If `boot_pending === true`, the prior boot
 * crashed before the grace period elapsed, and the watchdog triggers
 * recovery synchronously before the real server module is dynamically
 * imported.
 *
 * Cross-boot persistence is the entire point of this design: an in-process
 * setTimeout cannot fire after `process.exit(1)`, so the protection must
 * live in the NEXT boot's startup sequence. See Decision D4 (revised).
 *
 * Intentionally narrow imports — `node:fs` and `node:path` only. No store
 * factory, no Zod, no pino. Errors thrown by the underlying file ops
 * propagate to the caller (the entry shim handles them and writes a
 * synchronous stderr record before exiting).
 *
 * File layout:
 *   <dataPath>/boot-state.json     — main record
 *   <dataPath>/boot-state.json.tmp — atomic-rename staging
 */

import fs from 'node:fs';
import path from 'node:path';

export const BOOT_STATE_VERSION = 1;

export interface BootStateRecord {
  version: typeof BOOT_STATE_VERSION;
  /**
   * True while a boot is in progress and has NOT yet reached the success-
   * marker grace expiry. Cleared by `clearBootPending` from Stage C1.
   */
  bootPending: boolean;
  /**
   * The image tag this boot is running. Captured at `writeStart` time
   * (typically from `process.env.FLY_IMAGE_REF`).
   */
  imageTag: string;
  /**
   * Number of consecutive `writeStart` calls without an intervening
   * `clearBootPending`. The watchdog uses this to enforce the rollback cap
   * (D4: max 2 rollback attempts per boot lifecycle).
   */
  attempt: number;
  /** Milliseconds since epoch when this boot record was written. */
  startedAt: number;
  /**
   * Set on `clearBootPending` to mark the most recent healthy completion.
   * Used for telemetry only; the watchdog reads `bootPending`.
   */
  lastCleanAt?: number;
}

export interface BootStateStore {
  read(): BootStateRecord | null;
  /**
   * Records a new boot attempt. If the prior record matches `currentImageTag`
   * and `bootPending` was true, `attempt` is incremented; otherwise `attempt`
   * resets to 1.
   */
  writeStart(currentImageTag: string, now?: number): BootStateRecord;
  /** Marks the current boot as healthy. Resets `attempt` to 0. */
  clearBootPending(currentImageTag: string, now?: number): BootStateRecord;
  /** Removes both main and tmp files. */
  clear(): void;
  filePath(): string;
}

export interface CreateBootStateStoreOptions {
  dataPath: string;
  fileName?: string;
}

const DEFAULT_FILE_NAME = 'boot-state.json';

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

function coerceRecord(parsed: unknown): BootStateRecord | null {
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== BOOT_STATE_VERSION) return null;
  if (typeof parsed.bootPending !== 'boolean') return null;
  if (typeof parsed.imageTag !== 'string' || parsed.imageTag.length === 0) return null;
  if (typeof parsed.attempt !== 'number' || !Number.isFinite(parsed.attempt)) return null;
  if (typeof parsed.startedAt !== 'number' || !Number.isFinite(parsed.startedAt)) return null;
  const record: BootStateRecord = {
    version: BOOT_STATE_VERSION,
    bootPending: parsed.bootPending,
    imageTag: parsed.imageTag,
    attempt: parsed.attempt,
    startedAt: parsed.startedAt,
  };
  if (typeof parsed.lastCleanAt === 'number' && Number.isFinite(parsed.lastCleanAt)) {
    record.lastCleanAt = parsed.lastCleanAt;
  }
  return record;
}

export function createBootStateStore(options: CreateBootStateStoreOptions): BootStateStore {
  const filePath = path.join(options.dataPath, options.fileName ?? DEFAULT_FILE_NAME);

  function read(): BootStateRecord | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      return coerceRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  return {
    read,
    writeStart(currentImageTag: string, now: number = Date.now()): BootStateRecord {
      const prior = read();
      const sameImagePending =
        prior !== null && prior.bootPending === true && prior.imageTag === currentImageTag;
      const next: BootStateRecord = {
        version: BOOT_STATE_VERSION,
        bootPending: true,
        imageTag: currentImageTag,
        attempt: sameImagePending ? prior.attempt + 1 : 1,
        startedAt: now,
      };
      writeAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    },
    clearBootPending(currentImageTag: string, now: number = Date.now()): BootStateRecord {
      const next: BootStateRecord = {
        version: BOOT_STATE_VERSION,
        bootPending: false,
        imageTag: currentImageTag,
        attempt: 0,
        startedAt: now,
        lastCleanAt: now,
      };
      writeAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
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
