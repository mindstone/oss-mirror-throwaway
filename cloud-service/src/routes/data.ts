/**
 * Data archive upload route — streaming tar.gz extraction.
 *
 * Stage 6 of the "Cloud Setup Adaptive Sizing + Honest Progress" plan adds
 * two content-negotiated responses:
 *
 * 1. `Accept: application/x-ndjson` — emit newline-delimited progress events
 *    during extract, and a terminal `result` event. Desktop's NDJSON-aware
 *    `postStream` (cloud/cloudServiceClient.ts) consumes these.
 * 2. Absent/other `Accept` — fall back to the legacy single-JSON `{success}`
 *    response so old desktop clients keep working.
 *
 * The route also writes an `.extraction_incomplete` marker at the start and
 * clears it on success. On abort / error we keep the marker so a subsequent
 * `/api/data/reconcile` call can report the workspace as partial and wipe it.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 6 — Cloud-side NDJSON + orphan cleanup + reconcile)
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sendJson, readBody, log, sendRouteError, RouteError } from '../httpUtils';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { CloudErrorCode } from '@core/services/cloudErrorCatalog';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Emit at most one progress line per this many ms (spike recommendation). */
const PROGRESS_THROTTLE_MS = 500;

/**
 * Marker file written at the root of an extract target while extraction is
 * in progress. Removed on successful completion. If a subsequent request
 * finds it present, the extract crashed / aborted mid-way and the
 * reconcile endpoint will surface that state to the desktop client.
 */
const INCOMPLETE_MARKER_FILE = '.extraction_incomplete';

type ExtractTarget = 'workspace' | 'appdata';

/**
 * Root directory each target extracts into. Matches the pre-Stage 6
 * behaviour (workspace is a full replacement; appdata merges into /data).
 * The helper is pure so tests can override it by env var too.
 */
function getExtractDir(target: ExtractTarget): string {
  const dataRoot = process.env.REBEL_USER_DATA || '/data';
  return target === 'workspace' ? path.join(dataRoot, 'workspace') : dataRoot;
}

function wantsNdjson(req: http.IncomingMessage): boolean {
  const acceptHeader = req.headers['accept'];
  if (!acceptHeader) return false;
  const joined = Array.isArray(acceptHeader) ? acceptHeader.join(',') : String(acceptHeader);
  return joined.toLowerCase().includes('application/x-ndjson');
}

function readBytesTotalHeader(req: http.IncomingMessage): number | undefined {
  const raw = req.headers['x-migration-bytes-total'];
  if (!raw) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

async function writeIncompleteMarker(extractDir: string): Promise<void> {
  try {
    await fs.writeFile(path.join(extractDir, INCOMPLETE_MARKER_FILE), new Date().toISOString(), 'utf8');
  } catch (err) {
    // Marker is best-effort — if the disk is full or the dir is unwritable,
    // the extract will surface the real error anyway.
    log({ level: 'warn', msg: 'Failed to write extraction marker', error: (err as Error).message });
  }
}

async function removeIncompleteMarker(extractDir: string): Promise<void> {
  try {
    await fs.rm(path.join(extractDir, INCOMPLETE_MARKER_FILE), { force: true });
  } catch {
    // If the marker didn't exist we don't care.
  }
}

/**
 * Wipe a partial workspace extraction so the user isn't left with a half-full
 * directory. Only wipes `workspace` targets — `appdata` is a merge extraction
 * and we cannot safely distinguish new data from pre-existing data in that
 * directory.
 */
async function cleanupPartialExtract(
  target: ExtractTarget,
  extractDir: string,
  reason: string,
): Promise<void> {
  if (target !== 'workspace') return;
  try {
    await fs.rm(extractDir, { recursive: true, force: true });
    log({ level: 'info', msg: 'Cleaned up partial workspace extract', reason, extractDir });
  } catch (err) {
    log({
      level: 'warn',
      msg: 'Failed to clean up partial workspace extract',
      error: (err as Error).message,
      reason,
    });
  }
}

// ---------------------------------------------------------------------------
// NDJSON response helper (writer side)
// ---------------------------------------------------------------------------

interface NdjsonWriter {
  emit: (obj: Record<string, unknown>) => Promise<void>;
  end: () => void;
}

function isResponseClosed(res: http.ServerResponse): boolean {
  return res.writableEnded || res.destroyed;
}

function canSendFreshJsonResponse(res: http.ServerResponse): boolean {
  return !res.headersSent && !isResponseClosed(res);
}

function logSkippedResponseWrite(res: http.ServerResponse, context: string): void {
  log({
    level: 'warn',
    msg: 'Skipping upload-archive response write because response is no longer writable',
    context,
    headersSent: res.headersSent,
    writableEnded: res.writableEnded,
    destroyed: res.destroyed,
  });
}

function sendUploadArchiveErrorIfWritable(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (!canSendFreshJsonResponse(res)) {
    logSkippedResponseWrite(res, 'legacy-error');
    return;
  }
  sendRouteError(res, undefined, new RouteError((code as CloudErrorCode), { status: status, message: message }));
}

function sendUploadArchiveJsonIfWritable(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void | Promise<void> {
  if (!canSendFreshJsonResponse(res)) {
    logSkippedResponseWrite(res, 'legacy-success');
    return;
  }
  return sendJson(res, status, data);
}

function openNdjsonResponse(res: http.ServerResponse): NdjsonWriter {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    // Defensive: prevent any future compression middleware from buffering the
    // entire stream and defeating the point of chunked progress emission.
    'Content-Encoding': 'identity',
    'Cache-Control': 'no-cache',
    // Hint to reverse proxies (Fly, nginx) not to buffer — match the spike.
    'X-Accel-Buffering': 'no',
  });
  // No Content-Length — forces chunked transfer.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (obj: Record<string, unknown>): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (isResponseClosed(res)) {
        logSkippedResponseWrite(res, 'ndjson-emit');
        resolve();
        return;
      }
      const line = JSON.stringify(obj) + '\n';
      const ok = res.write(line);
      if (ok) resolve();
      else {
        const cleanup = (): void => {
          res.off('drain', onDrain);
          res.off('close', onClose);
          res.off('error', onError);
        };
        const onDrain = (): void => {
          cleanup();
          resolve();
        };
        const onClose = (): void => {
          cleanup();
          resolve();
        };
        const onError = (): void => {
          cleanup();
          resolve();
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onError);
      }
    });
  };

  const end = (): void => {
    if (isResponseClosed(res)) return;
    try {
      res.end();
    } catch {
      // Best effort — client may have disconnected.
    }
  };

  return { emit, end };
}

// ---------------------------------------------------------------------------
// POST /api/data/upload-archive?target=workspace|appdata
// ---------------------------------------------------------------------------

/**
 * Receives a raw tar.gz stream and extracts it to the appropriate directory.
 * - workspace: rm -rf /data/workspace, then extract with strip:0 (relative paths)
 * - appdata: extract directly to /data/ (merge, no rm -rf — preserves sessions)
 *
 * MUST stream: pipes req → gunzip → tar.extract. Never buffers the request body.
 * Guards against path traversal in tar entries.
 */
export async function handleDataUploadArchive(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST' }));

  // Parse query string for target parameter
  const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const target = urlObj.searchParams.get('target') as ExtractTarget | null;

  if (target !== 'workspace' && target !== 'appdata') {
    return sendRouteError(res, undefined, new RouteError('INVALID_TARGET', { status: 400, message: 'Query param target must be "workspace" or "appdata"' }));
  }

  const { createGunzip } = await import('node:zlib');
  const { PassThrough } = await import('node:stream');
  const tar = await import('tar');

  const extractDir = getExtractDir(target);
  const stripCount = 0;
  const useNdjson = wantsNdjson(req);
  const bytesTotalFromHeader = readBytesTotalHeader(req);
  const ndjson = useNdjson ? openNdjsonResponse(res) : null;

  if (target === 'workspace') {
    // Clean stale files for workspace (full replacement)
    await fs.rm(extractDir, { recursive: true, force: true });
    await fs.mkdir(extractDir, { recursive: true });
  } else {
    await fs.mkdir(extractDir, { recursive: true });
  }

  // Record that an extract is in progress. We remove the marker on success;
  // if the server crashes / the client aborts, the marker is left behind so
  // /api/data/reconcile can report partial_extract and wipe.
  await writeIncompleteMarker(extractDir);

  log({
    level: 'info',
    msg: 'Starting archive extraction',
    target,
    extractDir,
    mode: useNdjson ? 'ndjson' : 'legacy',
    bytesTotalFromHeader,
  });

  // Counters shared with the stream pipeline below.
  let archiveSize = 0; // compressed bytes (post-wire, pre-gunzip)
  let uncompressedBytes = 0; // bytes flowing out of gunzip (used for progress)

  // Throttled progress emitter — only wires up in NDJSON mode.
  let lastEmittedAt = 0;
  let lastEmittedBytes = 0;
  const maybeEmitProgress = async (): Promise<void> => {
    if (!ndjson) return;
    const now = Date.now();
    if (now - lastEmittedAt < PROGRESS_THROTTLE_MS) return;
    if (uncompressedBytes === lastEmittedBytes) return;
    lastEmittedAt = now;
    lastEmittedBytes = uncompressedBytes;
    await ndjson.emit({
      type: 'progress',
      phase: 'extract',
      bytesProcessed: uncompressedBytes,
      ...(bytesTotalFromHeader !== undefined ? { bytesTotal: bytesTotalFromHeader } : {}),
    });
  };

  let extractError: Error | null = null;
  // Track rejected tar entries (linkpath traversal, invalid headers, strict-check failures).
  // tar 7.5.13+ hardens link sanitization and emits 'warn' events for entries it skips rather
  // than aborting the extract. Without a warning handler those rejections are invisible and
  // the route would return 200 with silently-missing files. See data.ts git-blame + planning
  // doc docs/plans/260421_dependabot_safe_fixes.md (Stage 1b) for context.
  let rejectedEntryCount = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const EXTRACTION_TIMEOUT = 30 * 60 * 1000; // 30 min safety net
      const timer = setTimeout(() => {
        log({ level: 'error', msg: 'Archive extraction timed out', target, archiveSize });
        reject(new Error('Archive extraction timed out'));
      }, EXTRACTION_TIMEOUT);

      const requestCounter = new PassThrough();
      requestCounter.on('data', (chunk: Buffer) => {
        archiveSize += chunk.length;
      });

      const uncompressedCounter = new PassThrough();
      uncompressedCounter.on('data', (chunk: Buffer) => {
        uncompressedBytes += chunk.length;
        // Fire-and-forget: emission is throttled inside maybeEmitProgress.
        // We deliberately don't await so we don't back-pressure the pipe.
        fireAndForget(maybeEmitProgress(), 'cloud.dataUploadArchive.maybeEmitProgress');
      });

      const gunzip = createGunzip();
      const extract = tar.extract({
        cwd: extractDir,
        strip: stripCount,
        // Surface tar's internal warnings (TAR_ENTRY_ERROR for traversal / linkpath rejection,
        // TAR_ENTRY_INVALID for checksum/header failures) as structured logs rather than letting
        // tar silently skip them. TAR_ENTRY_INFO (e.g. "stripping root from absolute path") is
        // benign and logged at a lower level.
        onwarn: (code: string, message: string, data: unknown) => {
          const entryPath =
            data && typeof data === 'object' && 'entry' in data
              ? (data as { entry?: { path?: string } }).entry?.path
              : data && typeof data === 'object' && 'path' in data
                ? (data as { path?: string }).path
                : undefined;
          if (code === 'TAR_ENTRY_INFO') {
            log({ level: 'debug', msg: 'tar entry info', code, message, entryPath });
            return;
          }
          rejectedEntryCount += 1;
          log({
            level: 'warn',
            msg: 'tar extraction rejected an entry',
            code,
            message,
            entryPath,
            target,
          });
        },
        filter: (entryPath: string) => {
          const normalized = path.normalize(entryPath);
          const resolved = path.resolve(extractDir, normalized);
          if (!resolved.startsWith(extractDir + path.sep) && resolved !== extractDir) {
            log({ level: 'warn', msg: 'Rejecting path traversal tar entry', entryPath });
            rejectedEntryCount += 1;
            return false;
          }
          return true;
        },
      });

      // Pipeline: req → requestCounter → gunzip → uncompressedCounter → tar.extract
      req.pipe(requestCounter).pipe(gunzip).pipe(uncompressedCounter).pipe(extract);

      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const fail = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };

      extract.on('finish', done);
      extract.on('error', fail);
      gunzip.on('error', fail);
      req.on('error', fail);
      req.on('aborted', () => fail(new Error('Client disconnected during extraction')));
    });
  } catch (err) {
    extractError = err instanceof Error ? err : new Error(String(err));
    await cleanupPartialExtract(target, extractDir, extractError.message);
  }

  if (extractError) {
    const message = extractError.message;
    if (ndjson) {
      try {
        await ndjson.emit({ type: 'result', success: false, error: message });
      } finally {
        ndjson.end();
      }
      return;
    }
    // Legacy path: if we already wrote the marker but the stream failed before
    // we sent any response, send a 500 so the desktop client surfaces the error.
    if (canSendFreshJsonResponse(res)) {
      return sendUploadArchiveErrorIfWritable(res, 500, 'EXTRACT_FAILED', message);
    }
    logSkippedResponseWrite(res, 'legacy-error-after-extract-failure');
    if (!isResponseClosed(res)) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    return;
  }

  // Success — remove marker, count entries, reload stores as before.
  await removeIncompleteMarker(extractDir);

  let fileCount = 0;
  try {
    const entries = await fs.readdir(extractDir);
    // Don't count the marker if it somehow survived
    fileCount = entries.filter((e) => e !== INCOMPLETE_MARKER_FILE).length;
  } catch {
    // Directory may not exist if archive was empty
  }

  log({
    level: 'info',
    msg: 'Archive extraction complete',
    target,
    fileCount,
    archiveSize,
    uncompressedBytes,
    rejectedEntryCount,
    mode: useNdjson ? 'ndjson' : 'legacy',
  });

  // Reload in-memory stores so they pick up the new data from disk
  if (target === 'appdata') {
    const { reloadAllStores } = await import('../electronStoreShim');
    reloadAllStores();
    const { runCloudAutomationStoreEagerMigration } = await import('../cloudAutomationStore');
    runCloudAutomationStoreEagerMigration();
    log({ level: 'info', msg: 'Reloaded all in-memory stores after appdata extraction' });
  }

  if (ndjson) {
    try {
      await ndjson.emit({
        type: 'result',
        success: true,
        fileCount,
        archiveSize,
        ...(rejectedEntryCount > 0 ? { rejectedEntryCount } : {}),
      });
    } finally {
      ndjson.end();
    }
    return;
  }

  return sendUploadArchiveJsonIfWritable(res, 200, {
    success: true,
    fileCount,
    archiveSize,
    ...(rejectedEntryCount > 0 ? { rejectedEntryCount } : {}),
  });
}

// ---------------------------------------------------------------------------
// POST /api/data/reconcile
// ---------------------------------------------------------------------------

/**
 * Check whether a prior extract left a partial directory behind, and clean it
 * up if so. Called on desktop startup when `cloudInstance.migrationInFlight`
 * was true (see Stage 6 "reconcile-migration" in the planning doc).
 *
 * Request body: `{ target: 'workspace' | 'appdata' }`
 * Response:
 *   - `{ state: 'partial_extract' }` — a marker was present; we wiped the
 *     workspace directory (for target=workspace) so the next migration can
 *     start clean. For appdata we leave the directory alone because extract
 *     merges rather than replaces.
 *   - `{ state: 'complete' }` — directory exists and has content (and no
 *     marker).
 *   - `{ state: 'none' }` — no directory, no data.
 */
export async function handleDataReconcile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST' }));

  let body: { target?: unknown } | null = null;
  try {
    body = (await readBody(req)) as { target?: unknown } | null;
  } catch (err) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: (err as Error).message }));
  }

  const target = body?.target;
  if (target !== 'workspace' && target !== 'appdata') {
    return sendRouteError(res, undefined, new RouteError('INVALID_TARGET', { status: 400, message: 'Body field "target" must be "workspace" or "appdata"' }));
  }

  const extractDir = getExtractDir(target);
  const markerPath = path.join(extractDir, INCOMPLETE_MARKER_FILE);

  let markerExists = false;
  try {
    await fs.access(markerPath);
    markerExists = true;
  } catch {
    markerExists = false;
  }

  if (markerExists) {
    // Clean up partial data for workspace targets; leave appdata alone so we
    // don't nuke merged user data.
    if (target === 'workspace') {
      await cleanupPartialExtract(target, extractDir, 'reconcile-partial');
    } else {
      // Still remove the marker so future reconciles don't loop.
      await removeIncompleteMarker(extractDir);
    }
    log({ level: 'info', msg: 'Reconcile: cleaned partial extract', target, extractDir });
    return sendJson(res, 200, { state: 'partial_extract' });
  }

  let dirExists = false;
  let dirHasEntries = false;
  try {
    const entries = await fs.readdir(extractDir);
    dirExists = true;
    dirHasEntries = entries.length > 0;
  } catch {
    dirExists = false;
  }

  if (dirExists && dirHasEntries) {
    return sendJson(res, 200, { state: 'complete' });
  }
  return sendJson(res, 200, { state: 'none' });
}
