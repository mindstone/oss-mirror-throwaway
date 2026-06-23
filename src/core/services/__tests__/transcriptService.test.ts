import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetAssetStoreForTesting, setAssetStore } from '@core/assetStore';
import type { AssetStore } from '@core/assetStore';

// Mock getDataPath so we can control the directory per test
let mockDataPath = '';
 
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => mockDataPath,
}));

import {
  appendTranscriptEntry,
  cleanupOldTranscripts,
  createSeqCounter,
  ensureTranscriptDir,
  getTranscriptPath,
  sanitizeFilename,
  serializeError,
  type TranscriptEntry,
} from '../transcriptService';

function createMockAssetStore(): AssetStore {
  return {
    writeAsset: vi.fn(async ({ assetId, mimeType, bytes }) => ({
      ref: { assetId, mimeType, byteSize: bytes.byteLength },
    })),
    writeThumbnail: vi.fn(async () => undefined),
    generateThumbnail: vi.fn(async () => ({
      bytes: Buffer.from('thumb'),
      mimeType: 'image/png' as const,
    })),
    readAsset: vi.fn(async () => ({ reason: 'not-found' as const })),
    hasAsset: vi.fn(async () => ({ has: false })),
    listSessionAssets: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    moveSessionAssetsToDeleted: vi.fn(async () => undefined),
    restoreSessionAssetsFromDeleted: vi.fn(async () => undefined),
  };
}

/**
 * Helper: read all JSONL lines from a transcript file.
 * Returns parsed TranscriptEntry objects, skipping malformed lines.
 */
function readTranscriptEntries(filePath: string): TranscriptEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TranscriptEntry => entry !== null);
}

/**
 * Helper: wait for fs.appendFile callbacks to flush.
 * appendFile is async (callback-based), so we need a short delay.
 */
function waitForFlush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('transcriptService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    mockDataPath = tmpDir;
  });

  afterEach(() => {
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    resetAssetStoreForTesting();
  });

  // -------------------------------------------------------------------------
  // sanitizeFilename
  // -------------------------------------------------------------------------

  describe('sanitizeFilename', () => {
    it('passes through a simple alphanumeric string', () => {
      expect(sanitizeFilename('abc-123')).toBe('abc-123');
    });

    it('replaces forward slashes with hyphens', () => {
      expect(sanitizeFilename('a/b/c')).toBe('a-b-c');
    });

    it('replaces backslashes with hyphens', () => {
      expect(sanitizeFilename('a\\b\\c')).toBe('a-b-c');
    });

    it('neutralizes path traversal', () => {
      expect(sanitizeFilename('../../../etc/passwd')).toBe('etc-passwd');
    });

    it('replaces dots in session-like IDs', () => {
      expect(sanitizeFilename('session.id.with.dots')).toBe('session-id-with-dots');
    });

    it('replaces special characters with hyphens', () => {
      expect(sanitizeFilename('hello world!@#$%^&*()')).toBe('hello-world');
    });

    it('preserves hyphens', () => {
      expect(sanitizeFilename('abc-def-ghi')).toBe('abc-def-ghi');
    });

    it('returns "unnamed" for entirely invalid input', () => {
      expect(sanitizeFilename('....//')).toBe('unnamed');
    });

    it('handles UUID-like session IDs', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(sanitizeFilename(uuid)).toBe(uuid);
    });

    it('prefixes Windows reserved device names', () => {
      expect(sanitizeFilename('CON')).toBe('_CON');
      expect(sanitizeFilename('NUL')).toBe('_NUL');
      expect(sanitizeFilename('com1')).toBe('_com1');
      expect(sanitizeFilename('LPT3')).toBe('_LPT3');
    });

    it('handles prefixed session IDs with special chars', () => {
      // underscore → hyphen, consecutive hyphens collapsed
      expect(sanitizeFilename('automation-daily_check--abc-123')).toBe('automation-daily-check-abc-123');
    });
  });

  // -------------------------------------------------------------------------
  // serializeError
  // -------------------------------------------------------------------------

  describe('serializeError', () => {
    it('extracts message and stack from an Error object', () => {
      const err = new Error('something broke');
      const result = serializeError(err);

      expect(result.kind).toBe('error');
      expect(result).toHaveProperty('message', 'something broke');
      expect(result).toHaveProperty('stack');
      expect((result as { stack?: string }).stack).toContain('something broke');
    });

    it('handles a string error', () => {
      const result = serializeError('string error');
      expect(result).toEqual({ kind: 'error', message: 'string error' });
    });

    it('handles a number error', () => {
      const result = serializeError(42);
      expect(result).toEqual({ kind: 'error', message: '42' });
    });

    it('handles null', () => {
      const result = serializeError(null);
      expect(result).toEqual({ kind: 'error', message: 'null' });
    });

    it('handles undefined', () => {
      const result = serializeError(undefined);
      expect(result).toEqual({ kind: 'error', message: 'undefined' });
    });

    it('produces valid JSON (unlike raw Error)', () => {
      const err = new Error('test');
      const serialized = serializeError(err);
      const json = JSON.stringify(serialized);
      const parsed = JSON.parse(json);
      expect(parsed.message).toBe('test');
      expect(parsed.kind).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // createSeqCounter
  // -------------------------------------------------------------------------

  describe('createSeqCounter', () => {
    it('starts at 0', () => {
      const counter = createSeqCounter();
      expect(counter.next()).toBe(0);
    });

    it('produces monotonically increasing values', () => {
      const counter = createSeqCounter();
      const values = Array.from({ length: 10 }, () => counter.next());
      expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('works when shared across multiple callers', () => {
      const counter = createSeqCounter();
      const results: number[] = [];

      // Simulate two "callers" interleaving
      results.push(counter.next()); // caller A
      results.push(counter.next()); // caller B
      results.push(counter.next()); // caller A
      results.push(counter.next()); // caller B

      expect(results).toEqual([0, 1, 2, 3]);
    });

    it('independent counters do not share state', () => {
      const counterA = createSeqCounter();
      const counterB = createSeqCounter();

      expect(counterA.next()).toBe(0);
      expect(counterA.next()).toBe(1);
      expect(counterB.next()).toBe(0);
      expect(counterB.next()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getTranscriptPath
  // -------------------------------------------------------------------------

  describe('getTranscriptPath', () => {
    it('returns a path under the transcripts directory', () => {
      const result = getTranscriptPath('session-123');
      expect(result).toBe(path.join(tmpDir, 'transcripts', 'session-123.jsonl'));
    });

    it('sanitizes the session ID in the path', () => {
      const result = getTranscriptPath('../../../etc/passwd');
      expect(result).toBe(path.join(tmpDir, 'transcripts', 'etc-passwd.jsonl'));
    });
  });

  // -------------------------------------------------------------------------
  // ensureTranscriptDir
  // -------------------------------------------------------------------------

  describe('ensureTranscriptDir', () => {
    it('creates the transcripts directory', () => {
      const dir = path.join(tmpDir, 'transcripts');
      expect(fs.existsSync(dir)).toBe(false);

      ensureTranscriptDir();

      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    });

    it('is idempotent (calling twice does not throw)', () => {
      ensureTranscriptDir();
      expect(() => ensureTranscriptDir()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // appendTranscriptEntry — write + read back
  // -------------------------------------------------------------------------

  describe('appendTranscriptEntry', () => {
    beforeEach(() => {
      ensureTranscriptDir();
    });

    it('writes a core event and reads it back', async () => {
      const entry: TranscriptEntry = {
        v: 1,
        ts: Date.now(),
        sid: 'session-core-test',
        tid: 'turn-1',
        seq: 0,
        depth: 0,
        ns: 'main',
        event: {
          kind: 'core',
          event: { type: 'status', message: 'Planning...' },
        },
      };

      appendTranscriptEntry(entry);
      await waitForFlush();

      const filePath = getTranscriptPath('session-core-test');
      const entries = readTranscriptEntries(filePath);
      expect(entries).toHaveLength(1);
      expect(entries[0].event.kind).toBe('core');
      expect(entries[0].sid).toBe('session-core-test');
      expect(entries[0].tid).toBe('turn-1');
      expect(entries[0].seq).toBe(0);
    });

    it('writes an error event and reads it back', async () => {
      const entry: TranscriptEntry = {
        v: 1,
        ts: Date.now(),
        sid: 'session-error-test',
        tid: 'turn-1',
        seq: 1,
        depth: 0,
        ns: 'main',
        event: serializeError(new Error('something failed')),
      };

      appendTranscriptEntry(entry);
      await waitForFlush();

      const entries = readTranscriptEntries(getTranscriptPath('session-error-test'));
      expect(entries).toHaveLength(1);
      expect(entries[0].event.kind).toBe('error');
      const errorEvent = entries[0].event as { kind: 'error'; message: string; stack?: string };
      expect(errorEvent.message).toBe('something failed');
      expect(errorEvent.stack).toBeDefined();
    });

    it('writes a synthetic event and reads it back', async () => {
      const entry: TranscriptEntry = {
        v: 1,
        ts: Date.now(),
        sid: 'session-synthetic-test',
        tid: 'turn-1',
        seq: 2,
        depth: 0,
        ns: 'main',
        event: {
          kind: 'synthetic',
          tag: 'turn-start',
          data: { model: 'claude-sonnet-4-20250514', planMode: 'auto' },
        },
      };

      appendTranscriptEntry(entry);
      await waitForFlush();

      const entries = readTranscriptEntries(getTranscriptPath('session-synthetic-test'));
      expect(entries).toHaveLength(1);
      expect(entries[0].event.kind).toBe('synthetic');
      const syntheticEvent = entries[0].event as { kind: 'synthetic'; tag: string; data: unknown };
      expect(syntheticEvent.tag).toBe('turn-start');
      expect(syntheticEvent.data).toEqual({ model: 'claude-sonnet-4-20250514', planMode: 'auto' });
    });

    it('writes all 3 event kinds to the same file', async () => {
      const sid = 'session-multi-kind';
      const counter = createSeqCounter();

      appendTranscriptEntry({
        v: 1, ts: Date.now(), sid, tid: 'turn-1', seq: counter.next(),
        depth: 0, ns: 'main',
        event: { kind: 'core', event: { type: 'status', message: 'Starting...' } },
      });

      appendTranscriptEntry({
        v: 1, ts: Date.now(), sid, tid: 'turn-1', seq: counter.next(),
        depth: 0, ns: 'main',
        event: serializeError(new Error('oops')),
      });

      appendTranscriptEntry({
        v: 1, ts: Date.now(), sid, tid: 'turn-1', seq: counter.next(),
        depth: 0, ns: 'main',
        event: { kind: 'synthetic', tag: 'direct-answer', data: { answer: 'Yes' } },
      });

      await waitForFlush();

      const entries = readTranscriptEntries(getTranscriptPath(sid));
      expect(entries).toHaveLength(3);
      // Async appends may arrive in any order; check by seq (assigned synchronously)
      const sorted = [...entries].sort((a, b) => a.seq - b.seq);
      expect(sorted[0].event.kind).toBe('core');
      expect(sorted[1].event.kind).toBe('error');
      expect(sorted[2].event.kind).toBe('synthetic');
      // Verify all 3 seq values are present
      expect(new Set(entries.map((e) => e.seq))).toEqual(new Set([0, 1, 2]));
    });

    it('does not throw when the path is invalid (fail-open)', async () => {
      // Use a sessionId that sanitizes to empty string → path will be odd
      // but appendTranscriptEntry should not throw
      const entry: TranscriptEntry = {
        v: 1,
        ts: Date.now(),
        sid: '', // empty session ID
        tid: 'turn-1',
        seq: 0,
        depth: 0,
        ns: 'main',
        event: { kind: 'synthetic', tag: 'test', data: null },
      };

      // This should not throw
      expect(() => appendTranscriptEntry(entry)).not.toThrow();
      await waitForFlush();
    });

    it('does not throw when the transcripts directory does not exist (fail-open)', async () => {
      // Remove the transcripts directory
      const dir = path.join(tmpDir, 'transcripts');
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
      }

      const entry: TranscriptEntry = {
        v: 1,
        ts: Date.now(),
        sid: 'no-dir-session',
        tid: 'turn-1',
        seq: 0,
        depth: 0,
        ns: 'main',
        event: { kind: 'synthetic', tag: 'test', data: null },
      };

      // Should not throw even though directory doesn't exist
      expect(() => appendTranscriptEntry(entry)).not.toThrow();
      await waitForFlush();
    });

    it('handles concurrent appends without corruption', async () => {
      const sid = 'session-concurrent';
      const counter = createSeqCounter();
      const count = 50;

      // Fire off many appends concurrently
      for (let i = 0; i < count; i++) {
        appendTranscriptEntry({
          v: 1,
          ts: Date.now(),
          sid,
          tid: 'turn-1',
          seq: counter.next(),
          depth: 0,
          ns: 'main',
          event: { kind: 'core', event: { type: 'status', message: `Event ${i}` } },
        });
      }

      // Wait for all writes to flush
      await waitForFlush(500);

      const entries = readTranscriptEntries(getTranscriptPath(sid));
      expect(entries).toHaveLength(count);

      // Each line should be valid JSON (no corruption from interleaving)
      const seqs = entries.map((e) => e.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i));
    });

    it('produces valid JSONL (each line is valid JSON)', async () => {
      const sid = 'session-jsonl';

      appendTranscriptEntry({
        v: 1, ts: Date.now(), sid, tid: 'turn-1', seq: 0,
        depth: 0, ns: 'main',
        event: { kind: 'core', event: { type: 'status', message: 'Line 1' } },
      });
      appendTranscriptEntry({
        v: 1, ts: Date.now(), sid, tid: 'turn-1', seq: 1,
        depth: 0, ns: 'main',
        event: { kind: 'core', event: { type: 'status', message: 'Line 2' } },
      });

      await waitForFlush();

      const filePath = getTranscriptPath(sid);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('preserves full tool content without truncation', async () => {
      const sid = 'session-full';
      const largeOutput = 'x'.repeat(50_000); // 50KB, larger than MAX_DETAIL_LENGTH

      appendTranscriptEntry({
        v: 1, ts: Date.now(), sid, tid: 'turn-1', seq: 0,
        depth: 0, ns: 'main',
        event: {
          kind: 'core',
          event: { type: 'tool_use:result', toolUseId: 'tu-1', output: largeOutput, isError: false },
        },
      });

      await waitForFlush();

      const entries = readTranscriptEntries(getTranscriptPath(sid));
      expect(entries).toHaveLength(1);
      const coreEvent = entries[0].event as { kind: 'core'; event: { type: string; output: string } };
      expect(coreEvent.event.output).toHaveLength(50_000);
    });

    it('persists tool_use:result entries with imageRef and strips inline imageContent base64', async () => {
      const sid = 'session-image-ref-only';
      const inlineBase64 = Buffer.from('image-bytes').toString('base64');
      setAssetStore(createMockAssetStore());

      appendTranscriptEntry({
        v: 1,
        ts: Date.now(),
        sid,
        tid: 'turn-1',
        seq: 3,
        depth: 0,
        ns: 'main',
        event: {
          kind: 'core',
          event: {
            type: 'tool_use:result',
            toolUseId: 'tu-1',
            output: 'ok',
            isError: false,
            imageContent: [
              {
                type: 'image',
                data: inlineBase64,
                mimeType: 'image/png',
              },
            ],
          },
        },
      });

      await waitForFlush();

      const transcriptPath = getTranscriptPath(sid);
      const fileContents = fs.readFileSync(transcriptPath, 'utf8');
      expect(fileContents.includes(inlineBase64)).toBe(false);

      const entries = readTranscriptEntries(transcriptPath);
      expect(entries).toHaveLength(1);
      const event = entries[0]?.event;
      expect(event?.kind).toBe('core');
      if (event?.kind === 'core' && event.event.type === 'tool_use:result') {
        expect(event.event.imageContent).toBeUndefined();
        expect(event.event.imageRef).toEqual([
          {
            assetId: 'turn-1-3-0',
            mimeType: 'image/png',
            byteSize: Buffer.from(inlineBase64, 'base64').byteLength,
            thumbnailAssetId: 'turn-1-3-0_thumb',
            uploadStatus: 'pending',
          },
        ]);
      }
    });

    it('preserves fallback imageContent with a null positional imageRef when materialization fails', async () => {
      const sid = 'session-image-fallback';
      const inlineBase64 = Buffer.from('image-bytes').toString('base64');
      const assetStore = createMockAssetStore() as AssetStore & {
        writeAsset: ReturnType<typeof vi.fn>;
      };
      assetStore.writeAsset.mockRejectedValue({ code: 'storage-full' });
      setAssetStore(assetStore);

      appendTranscriptEntry({
        v: 1,
        ts: Date.now(),
        sid,
        tid: 'turn-1',
        seq: 9,
        depth: 0,
        ns: 'main',
        event: {
          kind: 'core',
          event: {
            type: 'tool_use:result',
            toolUseId: 'tu-1',
            output: 'ok',
            isError: false,
            imageContent: [
              {
                type: 'image',
                data: inlineBase64,
                mimeType: 'image/png',
              },
            ],
          },
        },
      });

      await waitForFlush();

      const transcriptPath = getTranscriptPath(sid);
      const fileContents = fs.readFileSync(transcriptPath, 'utf8');
      expect(fileContents.includes(inlineBase64)).toBe(true);

      const entries = readTranscriptEntries(transcriptPath);
      expect(entries).toHaveLength(1);
      const event = entries[0]?.event;
      expect(event?.kind).toBe('core');
      if (event?.kind === 'core' && event.event.type === 'tool_use:result') {
        expect(event.event.imageRef).toEqual([null]);
        expect(event.event.imageContent).toEqual([
          {
            type: 'image',
            data: inlineBase64,
            mimeType: 'image/png',
          },
        ]);
      }
    });

    it('records subagent events with depth and namespace', async () => {
      const sid = 'session-subagent';
      const counter = createSeqCounter();

      // Main agent event
      appendTranscriptEntry({
        v: 1, ts: Date.now(), sid, tid: 'turn-1', seq: counter.next(),
        depth: 0, ns: 'main',
        event: { kind: 'core', event: { type: 'status', message: 'Main' } },
      });

      // Subagent event
      appendTranscriptEntry({
        v: 1, ts: Date.now(), sid, tid: 'turn-1', seq: counter.next(),
        depth: 1, ns: 'main/Forager',
        event: { kind: 'core', event: { type: 'status', message: 'Subagent' } },
      });

      await waitForFlush();

      const entries = readTranscriptEntries(getTranscriptPath(sid));
      expect(entries).toHaveLength(2);

      // fs.appendFile ordering is not guaranteed for concurrent calls,
      // so find entries by depth rather than relying on file order
      const mainEntry = entries.find((e) => e.depth === 0);
      const subEntry = entries.find((e) => e.depth === 1);
      expect(mainEntry).toBeDefined();
      expect(mainEntry!.ns).toBe('main');
      expect(subEntry).toBeDefined();
      expect(subEntry!.ns).toBe('main/Forager');
    });
  });

  // -------------------------------------------------------------------------
  // cleanupOldTranscripts
  // -------------------------------------------------------------------------

  describe('cleanupOldTranscripts', () => {
    const transcriptsDir = () => path.join(tmpDir, 'transcripts');

    beforeEach(() => {
      ensureTranscriptDir();
    });

    /**
     * Helper: create a .jsonl file in the transcripts dir with a given mtime.
     */
    function createFileWithAge(name: string, ageDays: number): string {
      const filePath = path.join(transcriptsDir(), name);
      fs.writeFileSync(filePath, '{"v":1}\n', 'utf8');
      const pastTime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
      fs.utimesSync(filePath, pastTime, pastTime);
      return filePath;
    }

    it('deletes old .jsonl files', async () => {
      const oldFile = createFileWithAge('old-session.jsonl', 30);
      const recentFile = createFileWithAge('recent-session.jsonl', 3);

      const result = await cleanupOldTranscripts();

      expect(result.deleted).toBe(1);
      expect(result.errors).toBe(0);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(recentFile)).toBe(true);
    });

    it('preserves recent .jsonl files', async () => {
      const file1 = createFileWithAge('session-a.jsonl', 5);
      const file2 = createFileWithAge('session-b.jsonl', 13);

      const result = await cleanupOldTranscripts();

      expect(result.deleted).toBe(0);
      expect(result.errors).toBe(0);
      expect(fs.existsSync(file1)).toBe(true);
      expect(fs.existsSync(file2)).toBe(true);
    });

    it('supports a custom maxAgeDays', async () => {
      const file3d = createFileWithAge('session-3d.jsonl', 3);
      const file1d = createFileWithAge('session-1d.jsonl', 1);

      const result = await cleanupOldTranscripts(2);

      expect(result.deleted).toBe(1);
      expect(result.errors).toBe(0);
      expect(fs.existsSync(file3d)).toBe(false);
      expect(fs.existsSync(file1d)).toBe(true);
    });

    it('returns { deleted: 0, errors: 0 } when the directory does not exist', async () => {
      // Remove the transcripts directory entirely
      fs.rmSync(transcriptsDir(), { recursive: true });

      const result = await cleanupOldTranscripts();

      expect(result).toEqual({ deleted: 0, errors: 0 });
    });

    it('returns { deleted: 0, errors: 0 } for an empty directory', async () => {
      // transcriptsDir exists but is empty (from beforeEach)
      const result = await cleanupOldTranscripts();

      expect(result).toEqual({ deleted: 0, errors: 0 });
    });

    it('only deletes .jsonl files (ignores other files)', async () => {
      createFileWithAge('old-session.jsonl', 20);
      const txtFile = path.join(transcriptsDir(), 'notes.txt');
      fs.writeFileSync(txtFile, 'keep me', 'utf8');
      const pastTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      fs.utimesSync(txtFile, pastTime, pastTime);

      const result = await cleanupOldTranscripts();

      expect(result.deleted).toBe(1);
      expect(result.errors).toBe(0);
      expect(fs.existsSync(txtFile)).toBe(true);
    });

    it('continues cleanup when individual file deletion fails', async () => {
      const oldFile = createFileWithAge('session-1.jsonl', 20);
      const brokenSymlink = path.join(transcriptsDir(), 'broken-session.jsonl');
      fs.symlinkSync(path.join(tmpDir, 'missing-target.jsonl'), brokenSymlink);

      const result = await cleanupOldTranscripts();

      expect(result.deleted).toBe(1);
      expect(result.errors).toBe(1);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.lstatSync(brokenSymlink).isSymbolicLink()).toBe(true);
    });

    it('handles a mix of old and recent files correctly', async () => {
      createFileWithAge('very-old.jsonl', 100);
      createFileWithAge('old.jsonl', 15);
      createFileWithAge('almost-old.jsonl', 13); // within TTL, preserved
      createFileWithAge('recent.jsonl', 7);
      createFileWithAge('brand-new.jsonl', 0);

      const result = await cleanupOldTranscripts();

      // very-old (100d) and old (15d) deleted; almost-old (13d), recent (7d), brand-new (0d) preserved
      expect(result.deleted).toBe(2);
      expect(result.errors).toBe(0);
      expect(fs.existsSync(path.join(transcriptsDir(), 'recent.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(transcriptsDir(), 'brand-new.jsonl'))).toBe(true);
    });
  });
});
