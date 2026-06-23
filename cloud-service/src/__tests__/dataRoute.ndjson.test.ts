/**
 * Stage 6 — cloud-service data route:
 *   - NDJSON extract progress emission (`Accept: application/x-ndjson`)
 *   - Legacy single-JSON response (no Accept header)
 *   - Orphan cleanup on mid-stream error
 *   - `POST /api/data/reconcile` returns partial_extract / complete / none
 *
 * The route reads/writes real files on disk, so we point
 * `REBEL_USER_DATA` at a per-test temp directory before importing the
 * handler. The handler closes over the env var at the time `getExtractDir`
 * runs, so the override must happen before each test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import * as tar from 'tar';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  }),
}));

// Don't hit the real store reload path on appdata extracts.
vi.mock('../electronStoreShim', () => ({
  reloadAllStores: vi.fn(),
}));

let tempDataRoot: string;

async function buildTarGz(files: Record<string, string>): Promise<Buffer> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-data-ndjson-stage-'));
  try {
    for (const [relPath, contents] of Object.entries(files)) {
      const target = path.join(stagingDir, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, 'utf8');
    }
    const entries = Object.keys(files);
    const tarStream = tar.create({ cwd: stagingDir, gzip: false, follow: true, strict: false }, entries);
    const chunks: Buffer[] = [];
    return await new Promise<Buffer>((resolve, reject) => {
      const gzip = createGzip();
      tarStream.pipe(gzip);
      gzip.on('data', (c: Buffer) => chunks.push(c));
      gzip.on('end', () => resolve(Buffer.concat(chunks)));
      gzip.on('error', reject);
      tarStream.on('error', reject);
    });
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

/** Start an ad-hoc HTTP server that routes to the upload + reconcile handlers. */
async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const { handleDataUploadArchive, handleDataReconcile } = await import('../routes/data');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost`);
    if (url.pathname === '/api/data/upload-archive') {
      return handleDataUploadArchive(req, res);
    }
    if (url.pathname === '/api/data/reconcile') {
      return handleDataReconcile(req, res);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

beforeEach(async () => {
  tempDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-data-ndjson-'));
  process.env.REBEL_USER_DATA = tempDataRoot;
  // The route imports getExtractDir lazily on each request; no module-reset
  // dance needed. Reset modules anyway so each test uses a fresh import tree.
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tempDataRoot, { recursive: true, force: true }).catch(() => {});
  delete process.env.REBEL_USER_DATA;
});

describe('POST /api/data/upload-archive', () => {
  it('returns legacy single-JSON when Accept header omitted', async () => {
    const server = await startServer();
    try {
      const body = await buildTarGz({ 'hello.txt': 'world' });
      const res = await fetch(`${server.url}/api/data/upload-archive?target=workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip' },
        body: body as unknown as BodyInit,
      });
      expect(res.status).toBe(200);
      expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/json');
      const json = (await res.json()) as { success: boolean; fileCount: number };
      expect(json.success).toBe(true);
      expect(json.fileCount).toBe(1);
      // File actually landed on disk.
      const landed = await fs.readFile(
        path.join(tempDataRoot, 'workspace', 'hello.txt'),
        'utf8',
      );
      expect(landed).toBe('world');
      // Marker was cleared on success.
      const markerPresent = await fs
        .access(path.join(tempDataRoot, 'workspace', '.extraction_incomplete'))
        .then(() => true)
        .catch(() => false);
      expect(markerPresent).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('streams NDJSON progress + result when Accept header requests NDJSON', async () => {
    const server = await startServer();
    try {
      // Build a larger archive so the server emits at least one progress event.
      // Throttle is 500ms in the server; we don't assert the number of progress
      // events (that depends on IO timing) — just that the result arrives.
      const files: Record<string, string> = {};
      for (let i = 0; i < 20; i++) {
        files[`f-${i}.txt`] = 'x'.repeat(50_000);
      }
      const body = await buildTarGz(files);

      const res = await fetch(`${server.url}/api/data/upload-archive?target=workspace`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/gzip',
          Accept: 'application/x-ndjson',
          'X-Migration-Bytes-Total': '1000000',
        },
        body: body as unknown as BodyInit,
      });
      expect(res.status).toBe(200);
      expect((res.headers.get('content-type') ?? '').toLowerCase()).toContain('application/x-ndjson');
      expect(res.headers.get('content-length')).toBeNull(); // chunked transfer

      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const parsed = lines.map((l) => JSON.parse(l) as { type: string });
      const resultLine = parsed.find((p) => p.type === 'result') as
        | { type: 'result'; success: boolean; fileCount?: number }
        | undefined;
      expect(resultLine?.success).toBe(true);
      expect(resultLine?.fileCount).toBe(20);

      // If any progress line arrived it must carry bytesTotal echoed from header.
      const progressLines = parsed.filter((p) => p.type === 'progress') as Array<{
        type: 'progress';
        phase: string;
        bytesProcessed: number;
        bytesTotal?: number;
      }>;
      for (const p of progressLines) {
        expect(p.phase).toBe('extract');
        expect(p.bytesTotal).toBe(1_000_000);
        expect(typeof p.bytesProcessed).toBe('number');
      }
    } finally {
      await server.close();
    }
  });

  it('cleans up partial workspace + reports failure in NDJSON when input is malformed', async () => {
    const server = await startServer();
    try {
      // Not a valid gzip stream — gunzip will fail immediately.
      const res = await fetch(`${server.url}/api/data/upload-archive?target=workspace`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/gzip',
          Accept: 'application/x-ndjson',
        },
        body: Buffer.from('not-a-gzip-stream') as unknown as BodyInit,
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      const result = lines
        .map((l) => JSON.parse(l) as { type: string; success?: boolean })
        .find((p) => p.type === 'result');
      expect(result?.success).toBe(false);
      // Workspace dir was cleaned up — no marker, no leftover files.
      const workspaceExists = await fs
        .access(path.join(tempDataRoot, 'workspace'))
        .then(() => true)
        .catch(() => false);
      expect(workspaceExists).toBe(false);
    } finally {
      await server.close();
    }
  });

  // tar 7.5.13 hardening + Stage 1b of docs/plans/260421_dependabot_safe_fixes.md:
  // verify that when the extract filter/onwarn rejects an entry (path traversal
  // here), the rejection is counted and surfaced in the success response so
  // callers can detect "200 OK with silently-missing files". The traversal
  // entry is crafted via a parent-referencing relative path which tar will
  // preserve verbatim; the route's filter then rejects it during extraction.
  it('surfaces rejected-entry count when tar entries are filtered out', async () => {
    const server = await startServer();
    // Allocate staging dirs outside the server try so cleanup always runs.
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-data-reject-stage-'));
    const parentDir = path.dirname(stagingDir);
    const evilBasename = `evil-${path.basename(stagingDir)}.txt`;
    const evilFullPath = path.join(parentDir, evilBasename);
    try {
      await fs.writeFile(path.join(stagingDir, 'ok.txt'), 'legitimate');
      await fs.writeFile(evilFullPath, 'traversal');
      // strict:false + relative paths with `..` lets tar encode the escape entry.
      const tarStream = tar.create(
        { cwd: stagingDir, gzip: false, follow: true, strict: false },
        ['ok.txt', path.relative(stagingDir, evilFullPath)],
      );
      const chunks: Buffer[] = [];
      const body = await new Promise<Buffer>((resolve, reject) => {
        const gzip = createGzip();
        tarStream.pipe(gzip);
        gzip.on('data', (c: Buffer) => chunks.push(c));
        gzip.on('end', () => resolve(Buffer.concat(chunks)));
        gzip.on('error', reject);
        tarStream.on('error', reject);
      });

      const res = await fetch(`${server.url}/api/data/upload-archive?target=workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip' },
        body: body as unknown as BodyInit,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        fileCount: number;
        rejectedEntryCount?: number;
      };
      expect(json.success).toBe(true);
      // The route must surface the rejection. Either our filter caught ".." or
      // tar's own link sanitization caught it — either path must increment the
      // counter so clients can detect "200 OK with silently-missing files".
      expect(json.rejectedEntryCount ?? 0).toBeGreaterThan(0);
      const ok = await fs.readFile(path.join(tempDataRoot, 'workspace', 'ok.txt'), 'utf8');
      expect(ok).toBe('legitimate');
      // Traversal target was NOT written into the parent of extractDir.
      const escaped = await fs
        .access(path.join(tempDataRoot, evilBasename))
        .then(() => true)
        .catch(() => false);
      expect(escaped).toBe(false);
    } finally {
      await fs.rm(evilFullPath, { force: true }).catch(() => {});
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      await server.close();
    }
  });

  // Stage 8 — explicit coverage for the `req.on('aborted')` path. The
  // malformed-gzip test above exercises the server-error cleanup branch;
  // this one exercises the client-disconnect branch of the same cleanup.
  it('cleans up partial workspace when the client aborts mid-stream', async () => {
    const server = await startServer();
    try {
      // Use a raw http.request so we can write some bytes and then destroy
      // the socket to reliably trigger `req.on('aborted')` on the server
      // side. Node's global fetch buffers the body in ways that make
      // mid-stream abort unreliable.
      const url = new URL(`${server.url}/api/data/upload-archive?target=workspace`);
      const clientReq = http.request({
        host: url.hostname,
        port: url.port,
        method: 'POST',
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/gzip', 'Transfer-Encoding': 'chunked' },
      });
      // Swallow the expected ECONNRESET on the client side when we destroy.
      const clientError = new Promise<void>((resolve) => {
        clientReq.on('error', () => resolve());
        clientReq.on('close', () => resolve());
      });

      // Write enough gzip-looking bytes to induce the server to kick off the
      // extraction pipeline (so the incomplete marker lands on disk). We
      // need to actually flush the write, so wait for the write callback.
      await new Promise<void>((resolve, reject) => {
        clientReq.write(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      // Give the server a tick to flush the marker and wire up the pipeline.
      await new Promise((r) => setTimeout(r, 100));
      clientReq.destroy();
      await clientError;

      // Poll briefly — server-side cleanup runs async after the abort
      // event fires. 2s is generous; real cleanup happens in <100ms.
      let cleaned = false;
      for (let i = 0; i < 40; i++) {
        const exists = await fs
          .access(path.join(tempDataRoot, 'workspace'))
          .then(() => true)
          .catch(() => false);
        if (!exists) {
          cleaned = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(cleaned).toBe(true);
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('POST /api/data/reconcile', () => {
  it("returns 'none' when workspace directory does not exist", async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.url}/api/data/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'workspace' }),
      });
      const json = (await res.json()) as { state: string };
      expect(json.state).toBe('none');
    } finally {
      await server.close();
    }
  });

  it("returns 'complete' when workspace has content and no marker", async () => {
    const workspaceDir = path.join(tempDataRoot, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'hello.txt'), 'world');
    const server = await startServer();
    try {
      const res = await fetch(`${server.url}/api/data/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'workspace' }),
      });
      const json = (await res.json()) as { state: string };
      expect(json.state).toBe('complete');
    } finally {
      await server.close();
    }
  });

  it("returns 'partial_extract' and wipes workspace when marker is present", async () => {
    const workspaceDir = path.join(tempDataRoot, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, '.extraction_incomplete'), 'ts');
    await fs.writeFile(path.join(workspaceDir, 'leftover.txt'), 'junk');
    const server = await startServer();
    try {
      const res = await fetch(`${server.url}/api/data/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'workspace' }),
      });
      const json = (await res.json()) as { state: string };
      expect(json.state).toBe('partial_extract');
      // Workspace was wiped.
      const still = await fs
        .access(workspaceDir)
        .then(() => true)
        .catch(() => false);
      expect(still).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("appdata target only removes the marker — does not wipe pre-existing data", async () => {
    // appdata extracts are merges; wiping would nuke user data. We just clear
    // the marker so subsequent reconciles return the sensible state.
    await fs.writeFile(path.join(tempDataRoot, '.extraction_incomplete'), 'ts');
    await fs.writeFile(path.join(tempDataRoot, 'important.json'), '{}');
    const server = await startServer();
    try {
      const res = await fetch(`${server.url}/api/data/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'appdata' }),
      });
      const json = (await res.json()) as { state: string };
      expect(json.state).toBe('partial_extract');
      // important.json survives.
      const survived = await fs
        .readFile(path.join(tempDataRoot, 'important.json'), 'utf8')
        .catch(() => null);
      expect(survived).toBe('{}');
      // Marker is gone.
      const markerStill = await fs
        .access(path.join(tempDataRoot, '.extraction_incomplete'))
        .then(() => true)
        .catch(() => false);
      expect(markerStill).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('rejects invalid target values', async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.url}/api/data/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'something-else' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
