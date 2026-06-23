/**
 * Quarantined Image Tags Store
 *
 * Records image tags the cloud watchdog rolled back away from, so the
 * selfUpdateScheduler does not immediately re-install the same broken tag on
 * its next 6-hour cycle (Stage F of
 * docs/plans/260510_cloud_image_rollback_defense_in_depth.md, Decision D11).
 *
 * Entries expire after `ttlMs` (default 7 days, override via
 * `REBEL_QUARANTINE_TTL_MS`). After the TTL, the tag becomes eligible again
 * — useful when the underlying problem was a transient GHCR artifact issue
 * rather than a code bug. The list is bounded (~10 entries) and self-evicts.
 *
 * Narrow imports — `node:fs` and `node:path` only.
 *
 * File layout:
 *   <dataPath>/quarantined-image-tags.json     — main record
 *   <dataPath>/quarantined-image-tags.json.tmp — atomic-rename staging
 */

import fs from 'node:fs';
import path from 'node:path';

export const QUARANTINE_STORE_VERSION = 1;
export const DEFAULT_QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_QUARANTINE_ENTRIES = 10;

export interface QuarantineEntry {
  imageTag: string;
  rejectedAt: number;
  ttlMs: number;
}

interface QuarantineFile {
  version: typeof QUARANTINE_STORE_VERSION;
  entries: QuarantineEntry[];
}

export interface QuarantinedTagsStore {
  readActive(now?: number): QuarantineEntry[];
  addRejected(imageTag: string, options?: { ttlMs?: number; now?: number }): void;
  clear(): void;
  filePath(): string;
}

export interface CreateQuarantinedTagsStoreOptions {
  dataPath: string;
  fileName?: string;
}

const DEFAULT_FILE_NAME = 'quarantined-image-tags.json';

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

function coerceEntry(value: unknown): QuarantineEntry | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.imageTag !== 'string' || value.imageTag.length === 0) return null;
  if (typeof value.rejectedAt !== 'number' || !Number.isFinite(value.rejectedAt)) return null;
  if (typeof value.ttlMs !== 'number' || !Number.isFinite(value.ttlMs) || value.ttlMs <= 0) {
    return null;
  }
  return { imageTag: value.imageTag, rejectedAt: value.rejectedAt, ttlMs: value.ttlMs };
}

function coerceFile(parsed: unknown): QuarantineFile {
  if (!isPlainObject(parsed)) return { version: QUARANTINE_STORE_VERSION, entries: [] };
  if (parsed.version !== QUARANTINE_STORE_VERSION) {
    return { version: QUARANTINE_STORE_VERSION, entries: [] };
  }
  if (!Array.isArray(parsed.entries)) return { version: QUARANTINE_STORE_VERSION, entries: [] };
  const entries: QuarantineEntry[] = [];
  for (const item of parsed.entries) {
    const entry = coerceEntry(item);
    if (entry) entries.push(entry);
  }
  return { version: QUARANTINE_STORE_VERSION, entries };
}

function isActive(entry: QuarantineEntry, now: number): boolean {
  return now - entry.rejectedAt < entry.ttlMs;
}

function resolveDefaultTtlMs(): number {
  const envValue = process.env.REBEL_QUARANTINE_TTL_MS;
  if (envValue === undefined) return DEFAULT_QUARANTINE_TTL_MS;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUARANTINE_TTL_MS;
  return parsed;
}

export function createQuarantinedTagsStore(
  options: CreateQuarantinedTagsStoreOptions,
): QuarantinedTagsStore {
  const filePath = path.join(options.dataPath, options.fileName ?? DEFAULT_FILE_NAME);

  function readFile(): QuarantineFile {
    try {
      if (!fs.existsSync(filePath)) return { version: QUARANTINE_STORE_VERSION, entries: [] };
      const raw = fs.readFileSync(filePath, 'utf8');
      return coerceFile(JSON.parse(raw));
    } catch {
      return { version: QUARANTINE_STORE_VERSION, entries: [] };
    }
  }

  function persist(file: QuarantineFile): void {
    writeAtomic(filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  return {
    readActive(now: number = Date.now()): QuarantineEntry[] {
      const file = readFile();
      return file.entries.filter((entry) => isActive(entry, now));
    },
    addRejected(imageTag: string, opts?: { ttlMs?: number; now?: number }): void {
      if (typeof imageTag !== 'string' || imageTag.length === 0) {
        throw new Error('quarantinedTagsStore.addRejected: imageTag must be a non-empty string');
      }
      const now = opts?.now ?? Date.now();
      const ttlMs = opts?.ttlMs ?? resolveDefaultTtlMs();
      const file = readFile();
      const filtered = file.entries.filter(
        (entry) => isActive(entry, now) && entry.imageTag !== imageTag,
      );
      filtered.push({ imageTag, rejectedAt: now, ttlMs });
      // Bound the list: keep the most recent `MAX_QUARANTINE_ENTRIES` by rejectedAt.
      filtered.sort((a, b) => a.rejectedAt - b.rejectedAt);
      const trimmed = filtered.slice(Math.max(0, filtered.length - MAX_QUARANTINE_ENTRIES));
      persist({ version: QUARANTINE_STORE_VERSION, entries: trimmed });
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
