import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadAudioFile } from '../plaudApiClient';

function makePatternBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function toReadableStream(data: Uint8Array, chunkSize = 16 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }

      const nextOffset = Math.min(offset + chunkSize, data.length);
      controller.enqueue(data.slice(offset, nextOffset));
      offset = nextOffset;
    },
  });
}

describe('downloadAudioFile streaming', () => {
  let tempDir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plaud-api-client-streaming-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('streams response bytes to disk with exact content', async () => {
    const expectedBytes = makePatternBytes(256 * 1024);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(toReadableStream(expectedBytes), { status: 200 })));

    const destPath = path.join(tempDir, 'recording.mp3');
    await downloadAudioFile('https://example.test/audio', destPath);

    const stat = await fs.stat(destPath);
    expect(stat.size).toBe(expectedBytes.length);

    const fileBytes = await fs.readFile(destPath);
    expect(fileBytes.equals(Buffer.from(expectedBytes))).toBe(true);
  });

  it('does not call arrayBuffer while downloading', async () => {
    const response = new Response(toReadableStream(makePatternBytes(32 * 1024)), { status: 200 });
    const arrayBufferSpy = vi.spyOn(response, 'arrayBuffer');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const destPath = path.join(tempDir, 'streamed.mp3');
    await downloadAudioFile('https://example.test/audio', destPath);

    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('cleans up partial temp files and leaves no final file when stream fails mid-write', async () => {
    const streamError = new Error('stream broke mid-flight');
    const destPath = path.join(tempDir, 'broken.mp3');
    const fixedNow = 1_762_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    const expectedTempPath = `${destPath}.partial-${process.pid}-${fixedNow}`;
    const unlinkSpy = vi.spyOn(fs, 'unlink');

    let pullCount = 0;
    let firstChunkResolved = false;
    let bytesWrittenBeforeError = false;
    const failingStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new Uint8Array(256 * 1024).fill(1));
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const stat = await fs.stat(expectedTempPath).catch(() => null);
            if (stat && stat.size > 0) {
              bytesWrittenBeforeError = true;
              break;
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          firstChunkResolved = true;
          return;
        }
        controller.error(streamError);
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(failingStream, { status: 200 })));

    await expect(downloadAudioFile('https://example.test/audio', destPath)).rejects.toThrow(
      'stream broke mid-flight',
    );

    expect(firstChunkResolved).toBe(true);
    expect(bytesWrittenBeforeError).toBe(true);
    expect(unlinkSpy).toHaveBeenCalledWith(expectedTempPath);

    await expect(fs.stat(destPath)).rejects.toThrow();
    const lingeringPartials = (await fs.readdir(tempDir)).filter((name) => name.startsWith('broken.mp3.partial-'));
    expect(lingeringPartials).toHaveLength(0);
  });

  it('does not create a file when fetch returns non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

    const destPath = path.join(tempDir, 'failed.mp3');
    await expect(downloadAudioFile('https://example.test/audio', destPath)).rejects.toThrow(
      'Failed to download audio: 503',
    );

    await expect(fs.stat(destPath)).rejects.toThrow();
  });
});
