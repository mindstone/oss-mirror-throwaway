import path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import type { Stats } from 'node:fs';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import {
  DEFAULT_RECENT_LOGS_BYTES,
  DEFAULT_RECENT_LOGS_LINES,
  MAX_RECENT_LOGS_LINES,
  MAX_TAIL_BYTES_PER_FILE,
  MAX_TOTAL_TAIL_BYTES,
  MIN_RECENT_LOGS_BYTES,
  MIN_RECENT_LOGS_LINES,
  MAIN_LOG_FILENAME_RE,
} from '@core/services/diagnostics/recentLogsConstants';

const log = createScopedLogger({ service: 'recentLogsTail' });

export interface FsFileHandleLike {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

export interface FsLike {
  readdir(dir: string): Promise<string[]>;
  stat(filePath: string): Promise<Pick<Stats, 'size' | 'mtimeMs' | 'isFile'>>;
  open(filePath: string, flags: 'r'): Promise<FsFileHandleLike>;
}

export interface RecentLogsTailOpts {
  maxBytes?: number;
  maxLines?: number;
  resolveLogDir?: () => string;
  fs?: FsLike;
}

export interface RecentLogsTailResult {
  readonly content: string;
  readonly lines: number;
  readonly bytesReturned: number;
  readonly bytesAvailable: number;
  readonly truncated: boolean;
  readonly filesRead: ReadonlyArray<{ path: string; bytesRead: number }>;
  readonly errors: ReadonlyArray<{ path: string; reason: string }>;
}

interface CandidateFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface ReadBuffer {
  readonly path: string;
  readonly bytesRead: number;
  readonly data: Buffer;
}

const emptyResult = (
  errors: ReadonlyArray<{ path: string; reason: string }> = [],
): RecentLogsTailResult => ({
  content: '',
  lines: 0,
  bytesReturned: 0,
  bytesAvailable: 0,
  truncated: false,
  filesRead: [],
  errors,
});

const clampMaxBytes = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RECENT_LOGS_BYTES;
  }
  return Math.min(Math.max(Math.floor(value), MIN_RECENT_LOGS_BYTES), MAX_TOTAL_TAIL_BYTES);
};

const clampMaxLines = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_RECENT_LOGS_LINES;
  }
  return Math.min(Math.max(Math.floor(value), MIN_RECENT_LOGS_LINES), MAX_RECENT_LOGS_LINES);
};

const reasonFor = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) {
    return code;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
};

const isMainLogFileName = (name: string): boolean => MAIN_LOG_FILENAME_RE.test(name);

async function listCandidateFiles(
  logDir: string,
  fsLike: FsLike,
  errors: Array<{ path: string; reason: string }>,
): Promise<CandidateFile[]> {
  const names = await fsLike.readdir(logDir);
  const candidates: CandidateFile[] = [];

  for (const name of names) {
    if (!isMainLogFileName(name)) {
      continue;
    }
    const filePath = path.join(logDir, name);
    try {
      const stats = await fsLike.stat(filePath);
      if (!stats.isFile()) {
        continue;
      }
      candidates.push({
        path: filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch (err) {
      const reason = reasonFor(err);
      log.warn({ err, filePath }, 'Failed to stat recent log file');
      errors.push({ path: filePath, reason });
    }
  }

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function readTail(
  file: CandidateFile,
  readLen: number,
  fsLike: FsLike,
): Promise<ReadBuffer> {
  const buffer = Buffer.alloc(readLen);
  const position = Math.max(0, file.size - readLen);
  const handle = await fsLike.open(file.path, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, readLen, position);
    return {
      path: file.path,
      bytesRead,
      data: bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
    };
  } finally {
    await handle.close();
  }
}

function applySoftCaps(
  raw: string,
  maxBytes: number,
  maxLines: number,
): {
  content: string;
  lines: number;
  bytesReturned: number;
  bytesBeforeSoftCaps: number;
  lineCapApplied: boolean;
  byteCapApplied: boolean;
} {
  if (raw.length === 0) {
    return {
      content: '',
      lines: 0,
      bytesReturned: 0,
      bytesBeforeSoftCaps: 0,
      lineCapApplied: false,
      byteCapApplied: false,
    };
  }

  const allLines = raw.split('\n');
  if (allLines.at(-1) === '') {
    allLines.pop();
  }
  const bytesBeforeSoftCaps = Buffer.byteLength(allLines.join('\n'), 'utf8');
  const lineCapApplied = allLines.length > maxLines;
  let selected = lineCapApplied ? allLines.slice(-maxLines) : allLines;
  let content = selected.join('\n');
  let bytesReturned = Buffer.byteLength(content, 'utf8');
  let byteCapApplied = false;

  while (selected.length > 1 && bytesReturned > maxBytes) {
    byteCapApplied = true;
    selected = selected.slice(1);
    content = selected.join('\n');
    bytesReturned = Buffer.byteLength(content, 'utf8');
  }

  if (bytesReturned > maxBytes) {
    byteCapApplied = true;
    // Single-line case: trim by codepoints from the front so the byte cap
    // cannot split multi-byte UTF-8 and introduce U+FFFD replacement chars.
    // Linear-time accounting: walk codepoints and subtract their byte cost
    // until we fit under maxBytes, then slice. A naive shift+join+byteLength
    // loop is O(n²) and times out on 100 KiB-class single-line content.
    const codepoints = Array.from(content);
    let dropCount = 0;
    let remainingBytes = bytesReturned;
    while (dropCount < codepoints.length && remainingBytes > maxBytes) {
      const cp = codepoints[dropCount];
      if (cp === undefined) break;
      remainingBytes -= Buffer.byteLength(cp, 'utf8');
      dropCount += 1;
    }
    content = codepoints.slice(dropCount).join('');
    bytesReturned = remainingBytes;
    selected = content.length === 0 ? [] : content.split('\n');
  }

  return {
    content,
    lines: content.length === 0 ? 0 : selected.length,
    bytesReturned,
    bytesBeforeSoftCaps,
    lineCapApplied,
    byteCapApplied,
  };
}

export async function tailRecentMainLogs(opts: RecentLogsTailOpts = {}): Promise<RecentLogsTailResult> {
  const maxBytes = clampMaxBytes(opts.maxBytes);
  const maxLines = clampMaxLines(opts.maxLines);
  const fsLike = opts.fs ?? nodeFs;
  const resolveLogDir = opts.resolveLogDir ?? (() => path.join(getDataPath(), 'logs'));
  const errors: Array<{ path: string; reason: string }> = [];

  try {
    const logDir = resolveLogDir();
    const filesNewestFirst = await listCandidateFiles(logDir, fsLike, errors);
    if (filesNewestFirst.length === 0) {
      return emptyResult(errors);
    }

    let remainingBudget = MAX_TOTAL_TAIL_BYTES;
    let bytesAvailable = 0;
    let hardCapApplied = false;
    const reads: ReadBuffer[] = [];

    for (const [index, file] of filesNewestFirst.entries()) {
      if (remainingBudget <= 0) {
        hardCapApplied = index < filesNewestFirst.length;
        break;
      }
      const readLen = Math.min(file.size, MAX_TAIL_BYTES_PER_FILE, remainingBudget);
      if (readLen <= 0) {
        continue;
      }
      if (readLen < file.size) {
        hardCapApplied = true;
      }

      bytesAvailable += readLen;
      try {
        const read = await readTail(file, readLen, fsLike);
        reads.push(read);
        remainingBudget -= read.bytesRead;
      } catch (err) {
        const reason = reasonFor(err);
        log.warn({ err, filePath: file.path }, 'Failed to read recent log file tail');
        errors.push({ path: file.path, reason });
      }
    }

    const raw = Buffer.concat([...reads].reverse().map((read) => read.data)).toString('utf8');
    const capped = applySoftCaps(raw, maxBytes, maxLines);
    const effectiveBytesAvailable = Math.min(bytesAvailable, capped.bytesBeforeSoftCaps);

    return {
      content: capped.content,
      lines: capped.lines,
      bytesReturned: capped.bytesReturned,
      bytesAvailable: effectiveBytesAvailable,
      truncated:
        capped.bytesReturned < effectiveBytesAvailable ||
        capped.lineCapApplied ||
        capped.byteCapApplied ||
        hardCapApplied,
      filesRead: reads.map((read) => ({ path: read.path, bytesRead: read.bytesRead })),
      errors,
    };
  } catch (err) {
    const reason = reasonFor(err);
    log.warn({ err }, 'Failed to read recent log directory');
    return emptyResult([{ path: 'logDir', reason }]);
  }
}
