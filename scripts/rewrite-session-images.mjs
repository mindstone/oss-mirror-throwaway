#!/usr/bin/env node
/**
 * Stage 10 — operator migration script for legacy inline-base64 sessions.
 *
 * One-shot, user-invoked, idempotent. Rewrites a single session JSON
 * in place so its inline `imageContent[].data` payloads are externalised
 * into the Stage 2 asset store (`${userData}/sessions/${sessionId}.assets/`)
 * and replaced with positional `imageRef[i]` entries that match the schema
 * Stage 1 added.
 *
 * Layout (kept consistent with `DesktopAssetStore` in
 * `src/main/services/assetStoreDesktop.ts`):
 *
 *   ${userData}/sessions/${sessionId}.json                      <- rewritten in place
 *   ${userData}/sessions/${sessionId}.json.backup-${timestamp}  <- written before any mutation
 *   ${userData}/sessions/${sessionId}.assets/${assetId}.${ext}  <- atomic publish via fs.link
 *   ${userData}/sessions/${sessionId}.assets/_manifest.json     <- uploadStatus side table
 *
 * The script does NOT import the TypeScript `DesktopAssetStore` directly:
 *   - it must run as a standalone Node script with no Electron runtime
 *   - thumbnail generation (which uses Electron's `nativeImage`) is intentionally
 *     skipped here. The renderer/protocol falls back to the full-size asset when
 *     no thumbnail file is present.
 *
 * Everything else mirrors the production write path:
 *   - MIME allowlist (PNG / JPEG / GIF / WebP)
 *   - Magic-byte sniff before write
 *   - Atomic publish via tmp file + `fs.link` (deterministic conflict on race)
 *   - Idempotent re-runs: if `${assetId}.${ext}` already holds identical bytes,
 *     the write is a no-op and the existing ref is reused
 *   - Positional `imageRef[i]` (Stage 5): failed materialisations stay `null`
 *     so the corresponding `imageContent[i]` is preserved as fallback bytes
 *   - `_manifest.json` records `uploadStatus: 'pending'` for the migrated
 *     assets so the desktop outbox (Stage 7a) picks them up after next launch
 *
 * See `docs/plans/260516_image_asset_architecture.md` § Stage 10 and
 * `docs/project/IMAGE_ASSET_MIGRATION.md` for rationale and usage.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// MIME / magic-byte helpers (mirror src/shared/markdownImageAssets.ts and the
// magicBytesMatch() helper in assetStoreDesktop.ts).
// ---------------------------------------------------------------------------

const ALLOWED_IMAGE_MIME_TYPES = /** @type {const} */ ([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const IMAGE_MIME_TO_EXTENSION = /** @type {Record<string, string>} */ ({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
});

function isAllowedImageMimeType(mimeType) {
  return ALLOWED_IMAGE_MIME_TYPES.includes(mimeType);
}

function magicBytesMatch(buffer, mimeType) {
  if (buffer.length < 12) return false;
  switch (mimeType) {
    case 'image/png':
      return (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      );
    case 'image/jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/gif': {
      const sig = buffer.toString('ascii', 0, 6);
      return sig === 'GIF87a' || sig === 'GIF89a';
    }
    case 'image/webp': {
      const riff = buffer.toString('ascii', 0, 4);
      const webp = buffer.toString('ascii', 8, 12);
      return riff === 'RIFF' && webp === 'WEBP';
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/rewrite-session-images.mjs --session <sessionId> [options]

Options:
  --session <id>           Session UUID to migrate (required)
  --user-data <path>       Override userData directory. Default: \$REBEL_USER_DATA
                           or the platform default (e.g. on macOS:
                           ~/Library/Application Support/mindstone-rebel)
  --dry-run                Inspect only; do not write any files
  --verbose                Log each event processed
  --help                   Show this message

Examples:
  node scripts/rewrite-session-images.mjs --session 1f1d079b-dd16-4c23-9f8d-fda7a05162ee
  node scripts/rewrite-session-images.mjs --session 1f1d079b-dd16-4c23-9f8d-fda7a05162ee --dry-run

Behaviour
  - Backs up the session JSON to <id>.json.backup-<unix-ms> before any write.
  - Writes assets atomically (tmp file + fs.link). Restart-safe.
  - Idempotent: re-running on an already-migrated session is a no-op.
  - Failed images stay as positional \`null\` slots; inline bytes are preserved
    as fallback so the renderer still has something to display.
`;

function parseArgs(argv) {
  const args = {
    session: null,
    userData: null,
    dryRun: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--session':
      case '--session-id':
        i += 1;
        args.session = argv[i] ?? null;
        break;
      case '--user-data':
        i += 1;
        args.userData = argv[i] ?? null;
        break;
      default:
        if (arg.startsWith('--session=')) {
          args.session = arg.slice('--session='.length);
        } else if (arg.startsWith('--user-data=')) {
          args.userData = arg.slice('--user-data='.length);
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function defaultUserDataDir() {
  if (process.env.REBEL_USER_DATA) return process.env.REBEL_USER_DATA;

  const productDirName = 'mindstone-rebel';
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', productDirName);
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), productDirName);
    default: {
      const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
      return path.join(xdg, productDirName);
    }
  }
}

/**
 * Mirrors `incrementalSessionStore.isValidSessionId`. Tight charset; bounded
 * length. Anything else would either escape the sessions/ directory at write
 * time or hit `DesktopAssetStore.assertSafeSessionIdOrLogAndThrow` at read time.
 */
function isValidSessionId(id) {
  return typeof id === 'string' && id.length > 0 && id.length < 100 && /^[a-zA-Z0-9_-]+$/.test(id);
}

// ---------------------------------------------------------------------------
// Logging (redacted, matching the structured-log convention of Stage 2)
// ---------------------------------------------------------------------------

function hashSessionId(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

function makeLogger({ sessionId, verbose }) {
  const sessionIdHash = hashSessionId(sessionId);
  return {
    info: (msg, fields = {}) => {
      console.log(JSON.stringify({ level: 'info', sessionIdHash, msg, ...fields }));
    },
    warn: (msg, fields = {}) => {
      console.warn(JSON.stringify({ level: 'warn', sessionIdHash, msg, ...fields }));
    },
    error: (msg, fields = {}) => {
      console.error(JSON.stringify({ level: 'error', sessionIdHash, msg, ...fields }));
    },
    debug: (msg, fields = {}) => {
      if (!verbose) return;
      console.log(JSON.stringify({ level: 'debug', sessionIdHash, msg, ...fields }));
    },
  };
}

// ---------------------------------------------------------------------------
// Atomic asset writer (ported from DesktopAssetStore.writeFileAtomic + the
// manifest update path; no thumbnail generation, no Electron dependency).
// ---------------------------------------------------------------------------

const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeAssetId(assetId) {
  if (!SAFE_ID_REGEX.test(assetId)) {
    throw new Error(`Refusing to write asset with unsafe id: ${assetId}`);
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function tryReadFile(p) {
  try {
    return await fsp.readFile(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeFileAtomic(finalPath, bytes) {
  await ensureDir(path.dirname(finalPath));
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmpPath, bytes);
  try {
    await fsp.link(tmpPath, finalPath);
  } catch (err) {
    await bestEffortUnlink(tmpPath);
    if (err && err.code === 'EEXIST') {
      const existing = await tryReadFile(finalPath);
      if (existing && existing.equals(bytes)) return;
      throw new Error(`Conflict: ${finalPath} already exists with different bytes`);
    }
    throw err;
  }
  await bestEffortUnlink(tmpPath);
}

async function bestEffortUnlink(p) {
  try {
    await fsp.unlink(p);
  } catch {
    // ignore
  }
}

/**
 * Mirrors `DesktopAssetStore.updateManifestUploadStatus`. Records
 * `uploadStatus: 'pending'` so the desktop outbox knows to push the bytes
 * to cloud after launch.
 */
async function recordManifestStatus(sessionAssetDir, entries) {
  if (entries.length === 0) return;
  const manifestPath = path.join(sessionAssetDir, '_manifest.json');
  const existing = await tryReadFile(manifestPath);
  const manifest = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing.toString());
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (
            v && typeof v === 'object' &&
            (v.uploadStatus === 'pending' ||
              v.uploadStatus === 'uploaded' ||
              v.uploadStatus === 'missing')
          ) {
            manifest[k] = { uploadStatus: v.uploadStatus };
          }
        }
      }
    } catch {
      // Corrupt manifest; we'll overwrite with a fresh one.
    }
  }
  for (const entry of entries) {
    manifest[entry.assetId] = { uploadStatus: 'pending' };
  }
  await ensureDir(sessionAssetDir);
  const tmpPath = `${manifestPath}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmpPath, Buffer.from(JSON.stringify(manifest)));
  await fsp.rename(tmpPath, manifestPath);
}

// ---------------------------------------------------------------------------
// Session traversal & ref materialisation
// ---------------------------------------------------------------------------

const KNOWN_UPLOAD_STATUSES = new Set(['pending', 'uploaded', 'missing']);

function isExistingImageRef(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.assetId === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.byteSize === 'number'
  );
}

function isInlineImageBlock(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.type === 'image' &&
    typeof value.data === 'string' &&
    value.data.length > 0 &&
    typeof value.mimeType === 'string'
  );
}

/**
 * Strip inline source bytes from a `toolResult.content[]` image block once a
 * matching ref exists. Mirrors `sanitizeToolResultContentImages()` in
 * src/shared/utils/eventSanitization.ts so persisted-form parity with what
 * the runtime would emit is preserved.
 */
function sanitizeToolResultContentBlock(block, ref) {
  if (!block || typeof block !== 'object' || block.type !== 'image') return block;
  if (!ref) return block;
  const sanitized = { ...block, imageRef: ref };
  delete sanitized.source;
  delete sanitized.data;
  return sanitized;
}

/**
 * For each tool event with inline images, compute a positional `imageRef[]`,
 * write the bytes to the asset store, and strip the inline base64 from
 * `imageContent[i]` and the parallel `toolResult.content[]` image blocks.
 *
 * Returns a per-event change summary so the caller can emit a final tally.
 */
async function processSession({
  session,
  sessionId,
  sessionAssetDir,
  logger,
  dryRun,
}) {
  const stats = {
    eventsScanned: 0,
    eventsTouched: 0,
    imagesScanned: 0,
    imagesMigrated: 0,
    imagesSkippedAlreadyRef: 0,
    imagesFailed: 0,
    bytesWritten: 0,
  };

  /** @type {Array<{ assetId: string }>} */
  const manifestEntries = [];

  const eventsByTurn = session?.eventsByTurn;
  if (!eventsByTurn || typeof eventsByTurn !== 'object') {
    return { stats, manifestEntries };
  }

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    if (!Array.isArray(events)) continue;

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      if (!event || typeof event !== 'object' || event.type !== 'tool') continue;
      stats.eventsScanned += 1;

      const imageContent = Array.isArray(event.imageContent) ? event.imageContent : null;
      const existingRefs = Array.isArray(event.imageRef) ? event.imageRef.slice() : null;

      if (!imageContent || imageContent.length === 0) {
        // Nothing to migrate; leave existing refs (if any) alone.
        continue;
      }

      // Initialise positional refs aligned to imageContent length.
      const refs = new Array(imageContent.length).fill(null);
      if (existingRefs) {
        for (let i = 0; i < imageContent.length && i < existingRefs.length; i += 1) {
          if (isExistingImageRef(existingRefs[i])) {
            refs[i] = existingRefs[i];
          }
        }
      }

      let touched = false;
      const newlyWritten = []; // image-content indices migrated this run

      const eventSeq = typeof event.seq === 'number' ? event.seq : eventIndex;

      for (let i = 0; i < imageContent.length; i += 1) {
        stats.imagesScanned += 1;

        if (refs[i] && isExistingImageRef(refs[i])) {
          stats.imagesSkippedAlreadyRef += 1;
          continue;
        }

        const block = imageContent[i];
        if (!isInlineImageBlock(block)) {
          // Already stripped in a previous run, or never had bytes.
          stats.imagesSkippedAlreadyRef += 1;
          continue;
        }

        const mimeType = String(block.mimeType).toLowerCase();
        if (!isAllowedImageMimeType(mimeType)) {
          stats.imagesFailed += 1;
          logger.warn('image skipped: mime not allowed', {
            turnIdSuffix: turnId.slice(-8),
            eventIndex,
            imageIndex: i,
            mimeType,
          });
          continue;
        }

        let bytes;
        try {
          bytes = Buffer.from(block.data, 'base64');
        } catch (err) {
          stats.imagesFailed += 1;
          logger.warn('image skipped: base64 decode failed', {
            turnIdSuffix: turnId.slice(-8),
            eventIndex,
            imageIndex: i,
            error: err instanceof Error ? err.message.slice(0, 100) : 'decode-error',
          });
          continue;
        }

        if (!magicBytesMatch(bytes, mimeType)) {
          stats.imagesFailed += 1;
          logger.warn('image skipped: magic bytes do not match declared mime', {
            turnIdSuffix: turnId.slice(-8),
            eventIndex,
            imageIndex: i,
            mimeType,
            byteSize: bytes.byteLength,
          });
          continue;
        }

        const assetId = `legacy-${turnId}-${eventSeq}-${i}`;
        try {
          assertSafeAssetId(assetId);
        } catch (err) {
          stats.imagesFailed += 1;
          logger.warn('image skipped: unsafe asset id', {
            turnIdSuffix: turnId.slice(-8),
            eventIndex,
            imageIndex: i,
            error: err instanceof Error ? err.message.slice(0, 120) : 'unsafe-id',
          });
          continue;
        }

        const ext = IMAGE_MIME_TO_EXTENSION[mimeType];
        const finalPath = path.join(sessionAssetDir, `${assetId}${ext}`);

        if (!dryRun) {
          try {
            const existing = await tryReadFile(finalPath);
            if (existing && existing.equals(bytes)) {
              // Idempotent.
            } else {
              await writeFileAtomic(finalPath, bytes);
            }
          } catch (err) {
            stats.imagesFailed += 1;
            logger.warn('image skipped: asset write failed', {
              turnIdSuffix: turnId.slice(-8),
              eventIndex,
              imageIndex: i,
              error: err instanceof Error ? err.message.slice(0, 200) : 'write-failed',
            });
            continue;
          }
        }

        const ref = {
          assetId,
          mimeType,
          byteSize: bytes.byteLength,
          uploadStatus: 'pending',
        };
        refs[i] = ref;
        manifestEntries.push({ assetId });
        newlyWritten.push(i);
        stats.imagesMigrated += 1;
        stats.bytesWritten += bytes.byteLength;
        touched = true;
        logger.debug('image migrated', {
          turnIdSuffix: turnId.slice(-8),
          eventIndex,
          imageIndex: i,
          assetIdSuffix: assetId.slice(-8),
          byteSize: bytes.byteLength,
        });
      }

      if (!touched) {
        // No new image migrated this run. If a prior run already wrote refs
        // and stripped the inline bytes, nothing left to do; if it left
        // failed slots as inline-only, those bytes are intentionally kept
        // as the legacy-fallback path. Either way: skip rewriting the event.
        continue;
      }

      // At this point at least one ref exists at refs[*]; persist them and
      // strip the corresponding inline payloads from both imageContent and
      // toolResult.content[] image blocks.
      event.imageRef = refs;

      // Strip inline imageContent[i].data where the matching ref exists.
      // We keep the entries themselves as legacy fallback only where the ref
      // is null (per Stage 5 positional sanitization).
      const retainedImageContent = imageContent.map((block, i) => {
        if (refs[i]) return null;
        return block;
      });
      const remainingInline = retainedImageContent.filter((b) => b !== null);
      if (remainingInline.length === 0) {
        delete event.imageContent;
      } else if (remainingInline.length !== imageContent.length) {
        event.imageContent = remainingInline;
      }

      // Rewrite the parallel toolResult.content[] image blocks if present so
      // the persisted form matches what the runtime sanitizer would emit.
      if (event.toolResult && Array.isArray(event.toolResult.content)) {
        let imageBlockIndex = 0;
        let contentChanged = false;
        const updated = event.toolResult.content.map((block) => {
          if (!block || typeof block !== 'object' || block.type !== 'image') return block;
          const ref = refs[imageBlockIndex];
          imageBlockIndex += 1;
          if (!ref) return block;
          const sanitized = sanitizeToolResultContentBlock(block, ref);
          if (sanitized !== block) contentChanged = true;
          return sanitized;
        });
        if (contentChanged) {
          event.toolResult = { ...event.toolResult, content: updated };
        }
      }

      stats.eventsTouched += 1;
    }
  }

  return { stats, manifestEntries };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function writeSessionAtomic(sessionJsonPath, session) {
  const tmpPath = `${sessionJsonPath}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(session));
  await fsp.rename(tmpPath, sessionJsonPath);
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function runMigration({ sessionId, userDataDir, dryRun, verbose }) {
  if (!sessionId) {
    throw new Error('Missing required --session <id>');
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }

  const baseDir = userDataDir ?? defaultUserDataDir();
  const sessionJsonPath = path.join(baseDir, 'sessions', `${sessionId}.json`);
  const sessionAssetDir = path.join(baseDir, 'sessions', `${sessionId}.assets`);

  if (!existsSync(sessionJsonPath)) {
    throw new Error(`Session JSON not found: ${sessionJsonPath}`);
  }

  const logger = makeLogger({ sessionId, verbose });

  const beforeStat = await fsp.stat(sessionJsonPath);
  const beforeSize = beforeStat.size;
  logger.info('migration starting', {
    dryRun,
    sessionJsonPath,
    sessionAssetDir,
    sessionFileSize: beforeSize,
    sessionFileSizeFormatted: formatMb(beforeSize),
  });

  const raw = await fsp.readFile(sessionJsonPath, 'utf8');
  let session;
  try {
    session = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse session JSON at ${sessionJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!session || typeof session !== 'object') {
    throw new Error('Session JSON did not parse to an object');
  }
  if (session.id !== sessionId) {
    logger.warn('session.id does not match the requested session id', {
      expected: sessionId.slice(-8),
      foundSuffix: typeof session.id === 'string' ? session.id.slice(-8) : '<missing>',
    });
  }
  if (!session.eventsByTurn || typeof session.eventsByTurn !== 'object') {
    throw new Error('Session JSON missing "eventsByTurn" — refusing to migrate');
  }

  let backupPath = null;
  if (!dryRun) {
    backupPath = `${sessionJsonPath}.backup-${Date.now()}`;
    await fsp.copyFile(sessionJsonPath, backupPath);
    logger.info('backup written', { backupPath });
  } else {
    logger.info('dry-run: no backup created');
  }

  const { stats, manifestEntries } = await processSession({
    session,
    sessionId,
    sessionAssetDir,
    logger,
    dryRun,
  });

  if (!dryRun && stats.eventsTouched > 0) {
    await ensureDir(sessionAssetDir);
    await recordManifestStatus(sessionAssetDir, manifestEntries);
    await writeSessionAtomic(sessionJsonPath, session);
  }

  let afterSize = beforeSize;
  if (!dryRun && stats.eventsTouched > 0) {
    afterSize = (await fsp.stat(sessionJsonPath)).size;
  } else if (dryRun) {
    // Estimate after-size by serialising in memory.
    const projected = JSON.stringify(session);
    afterSize = Buffer.byteLength(projected);
  }

  const summary = {
    dryRun,
    backupPath,
    sessionJsonPath,
    sessionAssetDir,
    beforeBytes: beforeSize,
    afterBytes: afterSize,
    bytesShaved: Math.max(0, beforeSize - afterSize),
    bytesWrittenToAssets: stats.bytesWritten,
    eventsScanned: stats.eventsScanned,
    eventsTouched: stats.eventsTouched,
    imagesScanned: stats.imagesScanned,
    imagesMigrated: stats.imagesMigrated,
    imagesSkippedAlreadyRef: stats.imagesSkippedAlreadyRef,
    imagesFailed: stats.imagesFailed,
  };

  logger.info('migration complete', summary);
  return summary;
}

function printSummary(summary) {
  const banner = summary.dryRun ? '[dry-run] ' : '';
  console.log('');
  console.log(`${banner}Session JSON: ${formatMb(summary.beforeBytes)} -> ${formatMb(summary.afterBytes)}`);
  console.log(`${banner}Events touched: ${summary.eventsTouched}/${summary.eventsScanned}`);
  console.log(`${banner}Images migrated: ${summary.imagesMigrated}  skipped-already-ref: ${summary.imagesSkippedAlreadyRef}  failed: ${summary.imagesFailed}`);
  console.log(`${banner}Asset bytes written: ${formatMb(summary.bytesWrittenToAssets)}`);
  if (summary.backupPath) {
    console.log(`${banner}Backup: ${summary.backupPath}`);
  } else if (summary.dryRun) {
    console.log('[dry-run] No backup created. No files written. Re-run without --dry-run to apply.');
  }
  if (!summary.dryRun) {
    console.log('Done. Restore from the backup file if anything looks wrong.');
  }
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
    return;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (!args.session) {
    process.stderr.write('Missing required --session <id>\n');
    process.stderr.write(USAGE);
    process.exit(2);
    return;
  }

  try {
    const summary = await runMigration({
      sessionId: args.session,
      userDataDir: args.userData,
      dryRun: args.dryRun,
      verbose: args.verbose,
    });
    printSummary(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Migration failed: ${message}\n`);
    process.exit(1);
  }
}

// Only execute when run directly (allows the script to be imported by tests).
const invokedAsScript = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const self = new URL(import.meta.url).pathname;
    return entry === self || entry.endsWith('/rewrite-session-images.mjs');
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main(process.argv.slice(2));
}
