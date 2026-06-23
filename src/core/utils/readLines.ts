import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Sentinel return value for `readFileLines` callbacks that need early exit.
 */
export const STOP_READING_FILE_LINES = Symbol('STOP_READING_FILE_LINES');

export interface ReadFileLinesOptions {
  /**
   * Passed to `createReadStream`.
   * Defaults to `'utf8'` for line-based readers.
   */
  encoding?: BufferEncoding;
  /**
   * Passed to `readline.createInterface`.
   * Defaults to `Infinity`.
   */
  crlfDelay?: number;
}

export type ReadFileLineCallbackResult =
  | void
  | typeof STOP_READING_FILE_LINES
  | Promise<void | typeof STOP_READING_FILE_LINES>;

export type ReadFileLineCallback = (line: string, lineNumber: number) => ReadFileLineCallbackResult;

/**
 * Ownership wrapper for line-by-line file reads.
 *
 * Contract:
 * - This helper owns the stream and readline interface lifetimes.
 * - Callers must not close/destroy either resource directly.
 * - Cleanup is guaranteed via `finally` on EOF, early exit, and throw paths.
 *
 * This kills the anonymous `createReadStream` + `createInterface` fd-leak class
 * documented in `260611_searchfiles_fd_leak_ebadf_postmortem.md`.
 */
export async function readFileLines(
  filePath: string,
  onLine: ReadFileLineCallback,
  options: ReadFileLinesOptions = {},
): Promise<void> {
  const stream = createReadStream(filePath, {
    encoding: options.encoding ?? 'utf8',
  });
  const lineReader = createInterface({
    input: stream,
    crlfDelay: options.crlfDelay ?? Number.POSITIVE_INFINITY,
  });
  const streamErrorPromise = new Promise<never>((_, reject) => {
    stream.once('error', reject);
  });

  const consumeLines = async () => {
    let lineNumber = 0;
    for await (const line of lineReader) {
      lineNumber += 1;
      const callbackResult = await onLine(line, lineNumber);
      if (callbackResult === STOP_READING_FILE_LINES) {
        break;
      }
    }
  };

  try {
    await Promise.race([consumeLines(), streamErrorPromise]);
  } finally {
    lineReader.close();
    stream.destroy();
  }
}
