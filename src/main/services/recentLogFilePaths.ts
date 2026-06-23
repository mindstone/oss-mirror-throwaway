import path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import type { Stats } from 'node:fs';
import { getDataPath } from '@core/utils/dataPaths';
import { MAIN_LOG_FILENAME_RE } from '@core/services/diagnostics/recentLogsConstants';

export interface LogFilePathsEntry {
  readonly path: string;
  readonly basename: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtimeIso: string;
}

export interface LogFilePathsResult {
  readonly logDir: string;
  readonly files: ReadonlyArray<LogFilePathsEntry>;
  readonly totalBytes: number;
  readonly errors: ReadonlyArray<{ path: string; reason: string }>;
}

export interface LogFilePathsFsLike {
  readdir(dir: string): Promise<string[]>;
  stat(filePath: string): Promise<Pick<Stats, 'size' | 'mtimeMs' | 'isFile'>>;
}

export interface LogFilePathsOpts {
  resolveLogDir?: () => string;
  fs?: LogFilePathsFsLike;
}

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

export async function listRecentLogFilePaths(
  opts: LogFilePathsOpts = {},
): Promise<LogFilePathsResult> {
  const resolveLogDir = opts.resolveLogDir ?? (() => path.join(getDataPath(), 'logs'));
  const fsLike = opts.fs ?? nodeFs;
  let logDir = 'logDir';

  try {
    logDir = resolveLogDir();
    const names = await fsLike.readdir(logDir);
    const files: LogFilePathsEntry[] = [];
    const errors: Array<{ path: string; reason: string }> = [];

    for (const name of names) {
      if (!MAIN_LOG_FILENAME_RE.test(name)) {
        continue;
      }

      const filePath = path.join(logDir, name);
      try {
        const stats = await fsLike.stat(filePath);
        if (!stats.isFile()) {
          continue;
        }
        files.push({
          path: filePath,
          basename: name,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          mtimeIso: new Date(stats.mtimeMs).toISOString(),
        });
      } catch (err) {
        errors.push({ path: filePath, reason: reasonFor(err) });
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return {
      logDir,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      errors,
    };
  } catch (err) {
    return {
      logDir,
      files: [],
      totalBytes: 0,
      errors: [{ path: 'logDir', reason: reasonFor(err) }],
    };
  }
}
