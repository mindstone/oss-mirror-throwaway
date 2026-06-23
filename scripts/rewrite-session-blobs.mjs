#!/usr/bin/env node
/**
 * One-shot migration script for legacy sessions with oversized inline tool-result blobs.
 *
 * For each target session:
 * - finds inline blocks > threshold in tool-result content payloads
 * - writes bytes to the session-scoped ContentStore layout
 * - replaces inline blocks with `{ type: 'content_ref', contentRef, summary }`
 * - writes the session JSON atomically (tmp + fsync + rename)
 *
 * Idempotent:
 * - existing `content_ref` blocks are skipped
 * - existing identical content-store bytes are reused
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const DEFAULT_THRESHOLD_BYTES = 200 * 1024;
const CONTENT_SUMMARY_LIMIT = 500;
const CONTENT_DIR = 'contentStore';
const CONTENT_FILE_EXT = '.bin';
const CONTENT_MANIFEST_FILE = '_manifest.json';
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const BLOCKING_OUTBOX_STATUSES = new Set([
  'pending',
  'permanent_failure',
  'failed',
  'retryable',
]);

const USAGE = `Usage:
  node scripts/rewrite-session-blobs.mjs [options]

Options:
  --session-id <id>       Session ID to migrate (repeatable). Alias: --session
  --data-dir <path>       Override user-data directory. Alias: --user-data
  --dry-run               Report what would change without writing files
  --threshold-bytes <n>   Offload threshold in bytes (default: ${DEFAULT_THRESHOLD_BYTES})
  --force                 Override outbox pre-flight guard
  --verbose               Detailed per-event logging
  --help                  Show this message

Examples:
  node scripts/rewrite-session-blobs.mjs --session-id 1f1d079b --session-id 8f0b7c32
  node scripts/rewrite-session-blobs.mjs --session-id 1f1d079b --dry-run
  node scripts/rewrite-session-blobs.mjs --session-id 1f1d079b --data-dir "/tmp/mr-user-data"
`;

function parseArgs(argv) {
  const args = {
    sessionIds: [],
    dataDir: null,
    dryRun: false,
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    force: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--force') {
      args.force = true;
      continue;
    }
    if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
      continue;
    }

    if (arg === '--session-id' || arg === '--session') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      args.sessionIds.push(value);
      continue;
    }
    if (arg.startsWith('--session-id=')) {
      args.sessionIds.push(arg.slice('--session-id='.length));
      continue;
    }
    if (arg.startsWith('--session=')) {
      args.sessionIds.push(arg.slice('--session='.length));
      continue;
    }

    if (arg === '--data-dir' || arg === '--user-data') {
      i += 1;
      const value = argv[i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      args.dataDir = value;
      continue;
    }
    if (arg.startsWith('--data-dir=')) {
      args.dataDir = arg.slice('--data-dir='.length);
      continue;
    }
    if (arg.startsWith('--user-data=')) {
      args.dataDir = arg.slice('--user-data='.length);
      continue;
    }

    if (arg === '--threshold-bytes') {
      i += 1;
      const raw = argv[i];
      if (!raw) throw new Error('Missing value for --threshold-bytes');
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --threshold-bytes value: ${raw}`);
      }
      args.thresholdBytes = parsed;
      continue;
    }
    if (arg.startsWith('--threshold-bytes=')) {
      const raw = arg.slice('--threshold-bytes='.length);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --threshold-bytes value: ${raw}`);
      }
      args.thresholdBytes = parsed;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function defaultDataDir() {
  if (process.env.REBEL_USER_DATA) return process.env.REBEL_USER_DATA;
  const productDir = 'mindstone-rebel';
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', productDir);
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), productDir);
    default: {
      const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
      return path.join(xdg, productDir);
    }
  }
}

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SAFE_ID_REGEX.test(sessionId);
}

function isTextLikeMime(mimeType) {
  if (typeof mimeType !== 'string') return false;
  const lower = mimeType.toLowerCase();
  return (
    lower.startsWith('text/')
    || lower.includes('json')
    || lower.includes('xml')
    || lower.includes('javascript')
    || lower.includes('yaml')
    || lower.includes('markdown')
  );
}

function dedupe(values) {
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function computePctReduction(beforeBytes, afterBytes) {
  if (!Number.isFinite(beforeBytes) || beforeBytes <= 0) return '0.0';
  const pct = ((beforeBytes - afterBytes) / beforeBytes) * 100;
  return Math.max(0, pct).toFixed(1);
}

function buildBackupTimestamp() {
  return new Date().toISOString().replace(/:/g, '-');
}

function computeContentId(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function maybeDecodeBase64(data) {
  const compact = data.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
  try {
    return Buffer.from(compact, 'base64');
  } catch {
    return null;
  }
}

function extractInlinePayload(block) {
  if (typeof block === 'string') {
    return {
      bytes: Buffer.from(block, 'utf8'),
      mimeType: 'text/plain',
      summarySeed: block,
    };
  }

  const obj = asRecord(block);
  if (!obj) return null;

  if (obj.type === 'content_ref') return null;
  if (obj.type === 'image') return null;

  if (obj.type === 'text' && typeof obj.text === 'string') {
    return {
      bytes: Buffer.from(obj.text, 'utf8'),
      mimeType: typeof obj.mimeType === 'string' ? obj.mimeType : 'text/plain',
      summarySeed: obj.text,
    };
  }

  if (!obj.type && typeof obj.text === 'string') {
    return {
      bytes: Buffer.from(obj.text, 'utf8'),
      mimeType: typeof obj.mimeType === 'string' ? obj.mimeType : 'text/plain',
      summarySeed: obj.text,
    };
  }

  if (obj.type === 'document') {
    const source = asRecord(obj.source);
    if (source && typeof source.data === 'string') {
      const bytes = Buffer.from(source.data, 'base64');
      const mimeType = typeof source.media_type === 'string'
        ? source.media_type
        : typeof obj.mimeType === 'string'
          ? obj.mimeType
          : 'application/octet-stream';
      return { bytes, mimeType };
    }
  }

  if (typeof obj.data === 'string') {
    const mimeType = typeof obj.mimeType === 'string'
      ? obj.mimeType
      : 'application/octet-stream';
    if (isTextLikeMime(mimeType)) {
      return {
        bytes: Buffer.from(obj.data, 'utf8'),
        mimeType,
        summarySeed: obj.data,
      };
    }
    const decoded = maybeDecodeBase64(obj.data);
    return {
      bytes: decoded ?? Buffer.from(obj.data, 'utf8'),
      mimeType,
      ...(decoded ? {} : { summarySeed: obj.data }),
    };
  }

  return null;
}

function buildSummary({ summarySeed, bytes, mimeType }) {
  if (typeof summarySeed === 'string') {
    return summarySeed.slice(0, CONTENT_SUMMARY_LIMIT);
  }
  if (isTextLikeMime(mimeType)) {
    return bytes.toString('utf8').slice(0, CONTENT_SUMMARY_LIMIT);
  }
  return '';
}

async function promptForSessionIds() {
  if (!process.stdin.isTTY) {
    throw new Error('No --session-id provided and stdin is not interactive');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise((resolve) => {
    rl.question('Enter one or more session IDs (comma-separated): ', resolve);
  });
  rl.close();

  const ids = String(answer)
    .split(/[,\s]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (ids.length === 0) {
    throw new Error('No session IDs provided');
  }
  return ids;
}

async function tryReadFile(runtimeFs, filePath) {
  try {
    return await runtimeFs.readFile(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function bestEffortUnlink(runtimeFs, filePath) {
  try {
    await runtimeFs.unlink(filePath);
  } catch {
    // ignore
  }
}

async function fsyncFile(runtimeFs, filePath) {
  const handle = await runtimeFs.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function bestEffortFsyncDir(runtimeFs, dirPath) {
  let handle = null;
  try {
    handle = await runtimeFs.open(dirPath, 'r');
    await handle.sync();
  } catch (err) {
    const code = err && err.code ? err.code : null;
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR' && code !== 'ENOTSUP') {
      throw err;
    }
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  }
}

async function writeFileAtomic(runtimeFs, finalPath, bytes) {
  await runtimeFs.mkdir(path.dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
  await runtimeFs.writeFile(tmpPath, bytes);
  await fsyncFile(runtimeFs, tmpPath);

  try {
    await runtimeFs.link(tmpPath, finalPath);
  } catch (err) {
    await bestEffortUnlink(runtimeFs, tmpPath);
    if (err && err.code === 'EEXIST') {
      const existing = await tryReadFile(runtimeFs, finalPath);
      if (existing && existing.equals(bytes)) return;
      throw new Error(`Conflict: ${finalPath} already exists with different bytes`);
    }
    throw err;
  }

  await bestEffortFsyncDir(runtimeFs, path.dirname(finalPath));
  await bestEffortUnlink(runtimeFs, tmpPath);
}

async function writeJsonAtomic(runtimeFs, filePath, payload, options = {}) {
  await runtimeFs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await runtimeFs.writeFile(tmpPath, payload, 'utf8');
  await fsyncFile(runtimeFs, tmpPath);

  if (typeof options.beforeRename === 'function') {
    await options.beforeRename(tmpPath, filePath);
  }

  await runtimeFs.rename(tmpPath, filePath);
  await bestEffortFsyncDir(runtimeFs, path.dirname(filePath));
}

function extractOutboxEntries(parsed) {
  const entries = [];
  const record = asRecord(parsed);
  if (!record) {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const row = asRecord(item);
        if (!row || typeof row.sessionId !== 'string') continue;
        const status = typeof row.status === 'string' ? row.status : 'pending';
        entries.push({ sessionId: row.sessionId, status });
      }
    }
    return entries;
  }

  const nestedEntries = Array.isArray(record.entries) ? record.entries : null;
  if (nestedEntries) {
    entries.push(...extractOutboxEntries(nestedEntries));
  }

  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('_')) continue;
    const row = asRecord(value);
    if (!row) continue;

    if (typeof row.sessionId === 'string') {
      entries.push({
        sessionId: row.sessionId,
        status: typeof row.status === 'string' ? row.status : 'pending',
      });
      continue;
    }

    if (typeof row.status === 'string' && isValidSessionId(key)) {
      entries.push({ sessionId: key, status: row.status });
    }
  }

  return entries;
}

async function runOutboxPreflight({
  runtimeFs,
  dataDir,
  sessionIds,
  force,
  verbose,
}) {
  const target = new Set(sessionIds);
  const lockPath = path.join(dataDir, 'outbox', 'lock');
  const candidates = [
    path.join(dataDir, 'outbox', 'pending.json'),
    path.join(dataDir, 'sessions', 'cloud-outbox.json'),
  ];

  const reasons = [];

  if (existsSync(lockPath)) {
    reasons.push(`lock file present at ${lockPath}`);
  }

  for (const outboxPath of candidates) {
    if (!existsSync(outboxPath)) continue;
    let parsed;
    try {
      const raw = await runtimeFs.readFile(outboxPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse outbox state file ${outboxPath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const entries = extractOutboxEntries(parsed);
    const blocking = entries.filter((entry) =>
      target.has(entry.sessionId) && BLOCKING_OUTBOX_STATUSES.has(entry.status),
    );
    if (blocking.length > 0) {
      const details = blocking.map((entry) => `${entry.sessionId}(${entry.status})`).join(', ');
      reasons.push(`outbox entries present in ${outboxPath}: ${details}`);
    }
  }

  if (reasons.length === 0) return;

  const message =
    `Outbox pre-flight failed: ${reasons.join('; ')}. ` +
    'Pause the outbox or wait for it to drain. Run with --force only if you know what you\'re doing.';

  if (!force) {
    throw new Error(message);
  }

  if (verbose) {
    console.warn(`[warn] ${message}`);
  } else {
    console.warn('Outbox pre-flight warnings ignored due to --force.');
  }
}

async function updateContentManifest({
  runtimeFs,
  sessionContentDir,
  contentId,
  mimeType,
  byteSize,
}) {
  const manifestPath = path.join(sessionContentDir, CONTENT_MANIFEST_FILE);
  const nextManifest = {};

  const existing = await tryReadFile(runtimeFs, manifestPath);
  if (existing) {
    try {
      const parsed = JSON.parse(existing.toString());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const row = asRecord(value);
          if (!row) continue;
          if (
            row.uploadStatus === 'pending'
            || row.uploadStatus === 'uploaded'
            || row.uploadStatus === 'missing'
          ) {
            nextManifest[key] = {
              uploadStatus: row.uploadStatus,
              ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
              ...(typeof row.mimeType === 'string' ? { mimeType: row.mimeType } : {}),
              ...(typeof row.byteSize === 'number' ? { byteSize: row.byteSize } : {}),
              ...(typeof row.firstQueuedAt === 'number' ? { firstQueuedAt: row.firstQueuedAt } : {}),
            };
          }
        }
      }
    } catch {
      // Corrupt manifest; overwrite with fresh content.
    }
  }

  const previous = asRecord(nextManifest[contentId]);
  nextManifest[contentId] = {
    uploadStatus: 'pending',
    mimeType,
    byteSize,
    firstQueuedAt: typeof previous?.firstQueuedAt === 'number'
      ? previous.firstQueuedAt
      : Date.now(),
  };

  await writeJsonAtomic(runtimeFs, manifestPath, JSON.stringify(nextManifest));
}

async function writeContentToStore({
  runtimeFs,
  dataDir,
  sessionId,
  contentId,
  bytes,
  mimeType,
}) {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session id for content store write: ${sessionId}`);
  }
  if (!SAFE_ID_REGEX.test(contentId)) {
    throw new Error(`Invalid content id for content store write: ${contentId}`);
  }

  const sessionContentDir = path.join(dataDir, CONTENT_DIR, sessionId);
  const finalPath = path.join(sessionContentDir, `${contentId}${CONTENT_FILE_EXT}`);
  const existing = await tryReadFile(runtimeFs, finalPath);
  if (existing) {
    if (!existing.equals(bytes)) {
      throw new Error(`Conflict writing ${contentId}: existing bytes differ`);
    }
  } else {
    await writeFileAtomic(runtimeFs, finalPath, bytes);
  }

  await updateContentManifest({
    runtimeFs,
    sessionContentDir,
    contentId,
    mimeType,
    byteSize: bytes.byteLength,
  });
}

async function rewriteToolResultContent({
  runtimeFs,
  dataDir,
  sessionId,
  contentValue,
  thresholdBytes,
  dryRun,
  verbose,
}) {
  const stats = {
    changed: false,
    blobsOffloaded: 0,
    bytesOffloaded: 0,
  };

  const rewriteBlock = async (block) => {
    const extracted = extractInlinePayload(block);
    if (!extracted) return { rewritten: block, changed: false };
    if (extracted.bytes.byteLength <= thresholdBytes) {
      return { rewritten: block, changed: false };
    }

    const contentId = computeContentId(extracted.bytes);
    const summary = buildSummary(extracted);
    if (!dryRun) {
      await writeContentToStore({
        runtimeFs,
        dataDir,
        sessionId,
        contentId,
        bytes: extracted.bytes,
        mimeType: extracted.mimeType,
      });
    }

    const contentRef = {
      sessionId,
      contentId,
      mimeType: extracted.mimeType,
      size: extracted.bytes.byteLength,
      byteSize: extracted.bytes.byteLength,
      etag: contentId,
      uploadStatus: 'pending',
      ...(summary ? { summary } : {}),
    };

    if (verbose) {
      console.log(
        `[verbose] ${sessionId}: offloaded block (${extracted.bytes.byteLength} bytes) -> ${contentId}`,
      );
    }

    stats.changed = true;
    stats.blobsOffloaded += 1;
    stats.bytesOffloaded += extracted.bytes.byteLength;

    return {
      rewritten: {
        type: 'content_ref',
        contentRef,
        ...(summary ? { summary } : {}),
      },
      changed: true,
    };
  };

  if (typeof contentValue === 'string') {
    const { rewritten, changed } = await rewriteBlock(contentValue);
    if (!changed) {
      return { content: contentValue, ...stats };
    }
    return { content: [rewritten], ...stats };
  }

  if (!Array.isArray(contentValue)) {
    return { content: contentValue, ...stats };
  }

  const next = contentValue.slice();
  for (let i = 0; i < next.length; i += 1) {
    const block = next[i];
    const asObj = asRecord(block);
    if (asObj && asObj.type === 'content_ref') continue;
    const { rewritten, changed } = await rewriteBlock(block);
    if (!changed) continue;
    next[i] = rewritten;
  }

  if (!stats.changed) {
    return { content: contentValue, ...stats };
  }
  return { content: next, ...stats };
}

function collectNestedToolResultTargets(root) {
  const targets = [];
  const stack = [root];
  const seen = new Set();

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === 'object') stack.push(item);
      }
      continue;
    }

    if (node.type === 'tool_result' && hasOwn(node, 'content')) {
      targets.push(node);
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return targets;
}

async function processSessionEvents({
  runtimeFs,
  dataDir,
  sessionId,
  session,
  thresholdBytes,
  dryRun,
  verbose,
}) {
  const metrics = {
    eventsModified: 0,
    blobsOffloaded: 0,
    bytesOffloaded: 0,
  };

  const eventsByTurn = asRecord(session.eventsByTurn);
  if (!eventsByTurn) return metrics;

  for (const events of Object.values(eventsByTurn)) {
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      const eventObj = asRecord(event);
      if (!eventObj) continue;

      let eventTouched = false;

      const toolResult = asRecord(eventObj.toolResult);
      if (toolResult && hasOwn(toolResult, 'content')) {
        const rewritten = await rewriteToolResultContent({
          runtimeFs,
          dataDir,
          sessionId,
          contentValue: toolResult.content,
          thresholdBytes,
          dryRun,
          verbose,
        });
        if (rewritten.changed) {
          toolResult.content = rewritten.content;
          eventTouched = true;
          metrics.blobsOffloaded += rewritten.blobsOffloaded;
          metrics.bytesOffloaded += rewritten.bytesOffloaded;
        }
      }

      const nestedTargets = collectNestedToolResultTargets(eventObj.output);
      for (const target of nestedTargets) {
        const rewritten = await rewriteToolResultContent({
          runtimeFs,
          dataDir,
          sessionId,
          contentValue: target.content,
          thresholdBytes,
          dryRun,
          verbose,
        });
        if (!rewritten.changed) continue;
        target.content = rewritten.content;
        eventTouched = true;
        metrics.blobsOffloaded += rewritten.blobsOffloaded;
        metrics.bytesOffloaded += rewritten.bytesOffloaded;
      }

      if (eventTouched) {
        metrics.eventsModified += 1;
      }
    }
  }

  return metrics;
}

async function migrateSingleSession({
  runtimeFs,
  sessionId,
  dataDir,
  thresholdBytes,
  dryRun,
  verbose,
  hooks,
}) {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }

  const sessionPath = path.join(dataDir, 'sessions', `${sessionId}.json`);
  if (!existsSync(sessionPath)) {
    throw new Error(`Session JSON not found: ${sessionPath}`);
  }

  const beforeBytes = (await runtimeFs.stat(sessionPath)).size;
  const raw = await runtimeFs.readFile(sessionPath, 'utf8');
  let session;
  try {
    session = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse session JSON at ${sessionPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!asRecord(session) || !asRecord(session.eventsByTurn)) {
    throw new Error(`Session JSON missing eventsByTurn: ${sessionPath}`);
  }

  const metrics = await processSessionEvents({
    runtimeFs,
    dataDir,
    sessionId,
    session,
    thresholdBytes,
    dryRun,
    verbose,
  });

  let backupPath = null;
  const shouldWriteSession = !dryRun && metrics.eventsModified > 0;
  if (shouldWriteSession) {
    backupPath = `${sessionPath}.backup-${buildBackupTimestamp()}`;
    if (existsSync(backupPath)) {
      throw new Error(`Refusing to overwrite existing backup: ${backupPath}`);
    }
    await runtimeFs.copyFile(sessionPath, backupPath);

    await writeJsonAtomic(runtimeFs, sessionPath, JSON.stringify(session), {
      beforeRename: hooks?.beforeSessionRename,
    });
  }

  const afterBytes = dryRun
    ? Buffer.byteLength(JSON.stringify(session))
    : shouldWriteSession
      ? (await runtimeFs.stat(sessionPath)).size
      : beforeBytes;

  return {
    sessionId,
    dryRun,
    sessionPath,
    backupPath,
    beforeBytes,
    afterBytes,
    eventsModified: metrics.eventsModified,
    blobsOffloaded: metrics.blobsOffloaded,
    bytesOffloaded: metrics.bytesOffloaded,
  };
}

function printSessionSummary(summary) {
  const pctReduction = computePctReduction(summary.beforeBytes, summary.afterBytes);
  const prefix = summary.dryRun ? 'would be ' : '';
  console.log(
    `${summary.sessionId}: ${prefix}${formatMb(summary.beforeBytes)}MB → ${formatMb(summary.afterBytes)}MB (${pctReduction}% smaller); ${summary.eventsModified} events; ${summary.blobsOffloaded} blobs offloaded`,
  );
  if (summary.backupPath) {
    console.log(`Backup: ${summary.backupPath}`);
  }
}

export async function runMigration(options = {}) {
  const runtimeFs = { ...fsp, ...(options.fs ?? {}) };
  const dataDir = options.dataDir ?? defaultDataDir();
  const thresholdBytes = options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const verbose = options.verbose === true;
  const hooks = options.hooks ?? {};

  let sessionIds = dedupe(Array.isArray(options.sessionIds) ? options.sessionIds : []);
  if (sessionIds.length === 0 && options.promptIfMissing !== false) {
    sessionIds = dedupe(await promptForSessionIds());
  }
  if (sessionIds.length === 0) {
    throw new Error('No session IDs provided');
  }

  for (const sessionId of sessionIds) {
    if (!isValidSessionId(sessionId)) {
      throw new Error(`Invalid session id: ${sessionId}`);
    }
  }

  await runOutboxPreflight({
    runtimeFs,
    dataDir,
    sessionIds,
    force,
    verbose,
  });

  const summaries = [];
  for (const sessionId of sessionIds) {
    if (verbose) {
      console.log(`[verbose] migrating session ${sessionId} (dryRun=${dryRun}, threshold=${thresholdBytes})`);
    }
    const summary = await migrateSingleSession({
      runtimeFs,
      sessionId,
      dataDir,
      thresholdBytes,
      dryRun,
      verbose,
      hooks,
    });
    summaries.push(summary);
  }

  return {
    dataDir,
    thresholdBytes,
    dryRun,
    force,
    sessionIds,
    summaries,
  };
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

  try {
    const result = await runMigration({
      sessionIds: args.sessionIds,
      dataDir: args.dataDir,
      dryRun: args.dryRun,
      thresholdBytes: args.thresholdBytes,
      force: args.force,
      verbose: args.verbose,
      promptIfMissing: true,
    });

    for (const summary of result.summaries) {
      printSessionSummary(summary);
    }
  } catch (err) {
    process.stderr.write(`Migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

const invokedAsScript = (() => {
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main(process.argv.slice(2));
}
