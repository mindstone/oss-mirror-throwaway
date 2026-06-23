/**
 * Stage 6 — NDJSON response parser + postStream integration.
 *
 * Verifies:
 *   - Parser handles chunk fragmentation (mid-line, mid-JSON, many-in-one).
 *   - Malformed lines are skipped (warn-logged) without aborting the stream.
 *   - EOF without terminating newline still flushes the final line.
 *   - EOF without a `result` event surfaces an error sentinel.
 *   - Legacy single-JSON responses are returned unchanged when the client
 *     does not opt into NDJSON mode.
 *   - `postStream` wires `Accept: application/x-ndjson` and
 *     `X-Migration-Bytes-Total` correctly when `onProgress`/`bytesTotal`
 *     are supplied.
 *
 * See the Stage 0 spike `tmp/agent-tests/ndjson-spike.ts` for the reference
 * fragmentation vectors; most of the parser tests port directly from there.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import {
  parseNdjsonResponse,
  type NdjsonChunkSource,
  type NdjsonProgressEvent,
} from '../ndjsonResponseParser';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a synthetic async-iterable stream from a list of UTF-8 chunks. */
function chunks(parts: string[]): NdjsonChunkSource {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<Buffer>> => {
          if (i >= parts.length) return { value: undefined as unknown as Buffer, done: true };
          return { value: Buffer.from(parts[i++], 'utf8'), done: false };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

describe('parseNdjsonResponse', () => {
  it('handles the happy path: 3 progress + 1 result line', async () => {
    const progressSeen: NdjsonProgressEvent[] = [];
    const outcome = await parseNdjsonResponse(
      chunks([
        '{"type":"progress","phase":"extract","bytesProcessed":100,"bytesTotal":900}\n',
        '{"type":"progress","phase":"extract","bytesProcessed":400,"bytesTotal":900}\n',
        '{"type":"progress","phase":"extract","bytesProcessed":700,"bytesTotal":900}\n',
        '{"type":"result","success":true,"fileCount":7,"archiveSize":900}\n',
      ]),
      (evt) => progressSeen.push(evt),
    );

    expect(progressSeen).toHaveLength(3);
    expect(progressSeen.map((p) => p.bytesProcessed)).toEqual([100, 400, 700]);
    expect(outcome.result?.success).toBe(true);
    expect(outcome.result?.fileCount).toBe(7);
    expect(outcome.error).toBeUndefined();
  });

  it('handles chunks split mid-line', async () => {
    const full =
      '{"type":"progress","phase":"extract","bytesProcessed":100,"bytesTotal":900}\n' +
      '{"type":"result","success":true}\n';
    const mid = Math.floor(full.length / 2);
    const progressSeen: NdjsonProgressEvent[] = [];
    const outcome = await parseNdjsonResponse(
      chunks([full.slice(0, mid), full.slice(mid)]),
      (evt) => progressSeen.push(evt),
    );
    expect(progressSeen).toHaveLength(1);
    expect(outcome.result?.success).toBe(true);
  });

  it('handles chunks split mid-JSON (no newline in first chunk)', async () => {
    const line = '{"type":"progress","phase":"extract","bytesProcessed":100,"bytesTotal":900}';
    const first = line.slice(0, 15);
    const second = line.slice(15) + '\n{"type":"result","success":true}\n';
    const progressSeen: NdjsonProgressEvent[] = [];
    const outcome = await parseNdjsonResponse(
      chunks([first, second]),
      (evt) => progressSeen.push(evt),
    );
    expect(progressSeen).toHaveLength(1);
    expect(progressSeen[0].bytesProcessed).toBe(100);
    expect(outcome.result?.success).toBe(true);
  });

  it('handles many events in one chunk and one event across many chunks', async () => {
    const progressSeen: NdjsonProgressEvent[] = [];
    const outcome = await parseNdjsonResponse(
      chunks([
        '{"type":"progress","phase":"extract","bytesProcessed":100}\n{"type":"progress","phase":"extract","bytesProcessed":200}\n',
        '{"type":"prog',
        'ress","phase":"extract","bytesProcessed":',
        '300}\n{"type":"result","success":true}\n',
      ]),
      (evt) => progressSeen.push(evt),
    );
    expect(progressSeen.map((p) => p.bytesProcessed)).toEqual([100, 200, 300]);
    expect(outcome.result?.success).toBe(true);
  });

  it('skips malformed lines but preserves valid events', async () => {
    const progressSeen: NdjsonProgressEvent[] = [];
    const outcome = await parseNdjsonResponse(
      chunks([
        '{"type":"progress","phase":"extract","bytesProcessed":100}\n',
        'GARBAGE-NOT-JSON\n',
        '{"type":"result","success":true}\n',
      ]),
      (evt) => progressSeen.push(evt),
    );
    expect(progressSeen).toHaveLength(1);
    expect(outcome.result?.success).toBe(true);
  });

  it('flushes a final line without trailing newline', async () => {
    const progressSeen: NdjsonProgressEvent[] = [];
    const outcome = await parseNdjsonResponse(
      chunks([
        '{"type":"progress","phase":"extract","bytesProcessed":100}\n',
        '{"type":"result","success":true}',
      ]),
      (evt) => progressSeen.push(evt),
    );
    expect(progressSeen).toHaveLength(1);
    expect(outcome.result?.success).toBe(true);
    expect(outcome.error).toBeUndefined();
  });

  it('surfaces EOF without a result event as an error sentinel', async () => {
    const outcome = await parseNdjsonResponse(
      chunks([
        '{"type":"progress","phase":"extract","bytesProcessed":100}\n',
        '{"type":"progress","phase":"extract","bytesProcessed":200}\n',
      ]),
    );
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBe('EOF without result event');
  });

  it('skips events with an unknown `type`', async () => {
    const progressSeen: NdjsonProgressEvent[] = [];
    const outcome = await parseNdjsonResponse(
      chunks([
        '{"type":"heartbeat"}\n',
        '{"type":"progress","phase":"extract","bytesProcessed":50}\n',
        '{"type":"result","success":true}\n',
      ]),
      (evt) => progressSeen.push(evt),
    );
    expect(progressSeen).toHaveLength(1);
    expect(progressSeen[0].bytesProcessed).toBe(50);
    expect(outcome.result?.success).toBe(true);
  });

  it('keeps going even when onProgress throws', async () => {
    let invocations = 0;
    const outcome = await parseNdjsonResponse(
      chunks([
        '{"type":"progress","phase":"extract","bytesProcessed":1}\n',
        '{"type":"progress","phase":"extract","bytesProcessed":2}\n',
        '{"type":"result","success":true}\n',
      ]),
      () => {
        invocations++;
        throw new Error('boom');
      },
    );
    expect(invocations).toBe(2);
    expect(outcome.result?.success).toBe(true);
  });

  it('surfaces an empty body (no events at all) as EOF without result', async () => {
    const outcome = await parseNdjsonResponse(chunks([]));
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBe('EOF without result event');
  });

  it('surfaces a single empty chunk body as EOF without result', async () => {
    const outcome = await parseNdjsonResponse(chunks(['']));
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBe('EOF without result event');
  });

  // ---------------------------------------------------------------------------
  // UTF-8 safety — multi-byte characters split across chunk boundaries
  // ---------------------------------------------------------------------------
  // Without a streaming TextDecoder, each chunk would be decoded independently
  // and a byte split mid-codepoint would collapse into U+FFFD replacement
  // characters, corrupting the JSON before it reaches JSON.parse. This test
  // feeds the parser a payload containing a 4-byte UTF-8 emoji split across
  // two Buffer chunks and asserts the reassembled error message survives.
  //
  // Stage 8 NDJSON robustness audit — see planning doc.
  function byteChunks(parts: Buffer[]) {
    let i = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (i >= parts.length) {
              return { value: undefined as unknown as Buffer, done: true as const };
            }
            return { value: parts[i++], done: false as const };
          },
        };
      },
    };
  }

  it('reassembles multi-byte UTF-8 split across chunk boundaries', async () => {
    // "🎉" is U+1F389 — encoded in UTF-8 as four bytes: F0 9F 8E 89.
    // Put it in both a progress phase string (to exercise the progress path)
    // and a result error string (end-of-stream flush path).
    const line =
      '{"type":"result","success":false,"error":"Failed 🎉 extracting"}\n';
    const bytes = Buffer.from(line, 'utf8');

    // Deterministic split: find the first byte of the 4-byte emoji and split
    // the chunk right after the second of those bytes (so each chunk has
    // half the emoji in it — guaranteed to produce U+FFFD without streaming).
    const emojiStart = bytes.indexOf(0xf0);
    expect(emojiStart).toBeGreaterThan(0);
    const splitAt = emojiStart + 2;
    const first = bytes.subarray(0, splitAt);
    const second = bytes.subarray(splitAt);

    const outcome = await parseNdjsonResponse(byteChunks([first, second]));
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.error).toBe('Failed 🎉 extracting');
  });

  it('reassembles many splits inside multi-byte sequences across many chunks', async () => {
    const line = '{"type":"result","success":true,"error":"💥🎉🚀"}\n';
    const bytes = Buffer.from(line, 'utf8');
    // Split into single-byte chunks — every emoji byte is its own chunk.
    const singleBytes: Buffer[] = [];
    for (let i = 0; i < bytes.length; i++) {
      singleBytes.push(bytes.subarray(i, i + 1));
    }
    const outcome = await parseNdjsonResponse(byteChunks(singleBytes));
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.error).toBe('💥🎉🚀');
  });
});

// ---------------------------------------------------------------------------
// postStream integration tests (ad-hoc HTTP server — no fly.io roundtrip)
// ---------------------------------------------------------------------------

interface ServerSpec {
  emitNdjson: boolean;
  omitResult?: boolean;
  progressCount?: number;
  intervalMs?: number;
}

interface StartedServer {
  url: string;
  close: () => Promise<void>;
  capturedAccept: { value: string | undefined };
  capturedBytesTotalHeader: { value: string | undefined };
}

async function startServer(opts: ServerSpec): Promise<StartedServer> {
  const progressCount = opts.progressCount ?? 3;
  const intervalMs = opts.intervalMs ?? 25;
  const captured: {
    capturedAccept: { value: string | undefined };
    capturedBytesTotalHeader: { value: string | undefined };
  } = {
    capturedAccept: { value: undefined },
    capturedBytesTotalHeader: { value: undefined },
  };
  const server = http.createServer(async (req, res) => {
    captured.capturedAccept.value = req.headers['accept'] as string | undefined;
    captured.capturedBytesTotalHeader.value = req.headers['x-migration-bytes-total'] as string | undefined;
    // Drain request so client's stream completes.
    req.on('data', () => {});
    await new Promise<void>((resolve) => {
      req.on('end', resolve);
      req.on('error', resolve);
    });

    if (!opts.emitNdjson) {
      const body = JSON.stringify({ success: true, fileCount: 9, archiveSize: 1234 });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Content-Encoding': 'identity',
      'Cache-Control': 'no-cache',
    });
    res.flushHeaders();
    const emit = (obj: Record<string, unknown>): Promise<void> =>
      new Promise<void>((r) => {
        const ok = res.write(JSON.stringify(obj) + '\n');
        if (ok) r();
        else res.once('drain', () => r());
      });
    const total = 900;
    const step = Math.floor(total / (progressCount + 1));
    for (let i = 1; i <= progressCount; i++) {
      await emit({
        type: 'progress',
        phase: 'extract',
        bytesProcessed: step * i,
        bytesTotal: total,
      });
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (!opts.omitResult) {
      await emit({ type: 'result', success: true, fileCount: 5, archiveSize: total });
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
    ...captured,
  };
}

// Avoid real Sentry / store initialization inside CloudServiceClient.
vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get: vi.fn(() => null),
    set: vi.fn(),
  })),
}));

async function loadClient() {
  // Lazy-load AFTER mocks are registered.
  return (await import('../cloudServiceClient')).CloudServiceClient;
}

describe('CloudServiceClient.postStream', () => {
  const servers: StartedServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('returns the legacy single-JSON body unchanged when onProgress is not set', async () => {
    const server = await startServer({ emitNdjson: false });
    servers.push(server);
    const CloudServiceClient = await loadClient();
    const client = new CloudServiceClient(server.url, 'token');

    const body = Readable.from(Buffer.from('dummy-archive-bytes'));
    const res = (await client.postStream('/api/data/upload-archive?target=workspace', body)) as {
      success: boolean;
      fileCount: number;
      archiveSize: number;
    };
    expect(res.success).toBe(true);
    expect(res.fileCount).toBe(9);
    expect(res.archiveSize).toBe(1234);
    // No opt-in → no Accept header set by postStream
    expect((server.capturedAccept.value ?? '').toLowerCase()).not.toContain('application/x-ndjson');
    expect(server.capturedBytesTotalHeader.value).toBeUndefined();
  });

  it('streams NDJSON progress + result and returns a legacy-shaped object', async () => {
    const server = await startServer({ emitNdjson: true, progressCount: 3, intervalMs: 15 });
    servers.push(server);
    const CloudServiceClient = await loadClient();
    const client = new CloudServiceClient(server.url, 'token');

    const seen: NdjsonProgressEvent[] = [];
    const body = Readable.from(Buffer.from('dummy-archive-bytes'));
    const res = (await client.postStream('/api/data/upload-archive?target=workspace', body, {
      onProgress: (evt) => seen.push(evt),
      bytesTotal: 942,
    })) as { success: boolean; fileCount?: number; archiveSize?: number };

    expect(seen.length).toBe(3);
    expect(res.success).toBe(true);
    expect(res.fileCount).toBe(5);
    expect(res.archiveSize).toBe(900);
    expect((server.capturedAccept.value ?? '').toLowerCase()).toContain('application/x-ndjson');
    expect(server.capturedBytesTotalHeader.value).toBe('942');
  });

  it('throws a clean CloudServiceError when NDJSON ends without a result event', async () => {
    const server = await startServer({ emitNdjson: true, progressCount: 2, omitResult: true });
    servers.push(server);
    const CloudServiceClient = await loadClient();
    const client = new CloudServiceClient(server.url, 'token');

    const body = Readable.from(Buffer.from('dummy-archive-bytes'));
    await expect(
      client.postStream('/api/data/upload-archive?target=workspace', body, {
        onProgress: () => {},
        bytesTotal: 900,
      }),
    ).rejects.toThrow(/EOF without result event|ended without result/);
  });

  it('still accepts a positional timeoutMs argument (backward compat)', async () => {
    const server = await startServer({ emitNdjson: false });
    servers.push(server);
    const CloudServiceClient = await loadClient();
    const client = new CloudServiceClient(server.url, 'token');
    const body = Readable.from(Buffer.from('dummy'));
    const res = (await client.postStream(
      '/api/data/upload-archive?target=appdata',
      body,
      10_000,
    )) as { success: boolean };
    expect(res.success).toBe(true);
  });
});
