import { describe, it, expect } from 'vitest';
import {
  semverCompare,
  planExtraction,
  readManifest,
  readExtractionState,
  writeExtractionState,
  computeExtensionSourceHash,
  EXTRACTION_STATE_FILENAME,
  type ExtractionState,
} from '../extensionFolder';

const STATE_V1 = (overrides: Partial<ExtractionState> = {}): ExtractionState => ({
  schemaVersion: 1,
  sourceHash: 'a'.repeat(64),
  sourceManifestVersion: '1.0.0',
  extractedAt: 1_700_000_000_000,
  ...overrides,
});

describe('extensionFolder', () => {
  describe('EXTRACTION_STATE_FILENAME', () => {
    it('is a stable, dot-prefixed filename', () => {
      // Renaming this breaks every deployed user's marker. Don't do it
      // without a plan for the re-extract wave it will trigger.
      expect(EXTRACTION_STATE_FILENAME).toBe('.rebel-extraction-state.json');
    });
  });

  describe('semverCompare', () => {
    it('handles basic versions', () => {
      expect(semverCompare('1.0.0', '1.0.0')).toBe(0);
      expect(semverCompare('1.0.1', '1.0.0')).toBe(1);
      expect(semverCompare('1.0.0', '1.0.1')).toBe(-1);
    });
    it('handles patch only / different lengths', () => {
      expect(semverCompare('1.0', '1.0.0')).toBe(0);
      expect(semverCompare('1', '1.0.0')).toBe(0);
      expect(semverCompare('2', '1.9.9')).toBe(1);
    });
    it('ignores prerelease tags', () => {
      expect(semverCompare('1.0.0-beta', '1.0.0')).toBe(0);
      expect(semverCompare('1.0.0-rc.1', '1.0.0-alpha.2')).toBe(0);
    });
    it('handles invalid strings gracefully', () => {
      expect(semverCompare('invalid', '1.0.0')).toBe(-1);
      expect(semverCompare('invalid', 'invalid')).toBe(0);
    });
  });

  describe('planExtraction', () => {
    const newManifest = { version: '1.0.0' };
    const newSourceHash = 'b'.repeat(64);

    it('writes if target missing', () => {
      const res = planExtraction({
        sourceDir: '/src',
        targetDir: '/tgt',
        existingManifest: null,
        newManifest,
        existingState: null,
        newSourceHash,
      });
      expect(res).toEqual({ action: 'write', reason: 'target-missing' });
    });

    it('writes if target manifest exists but state marker is missing (pre-v1 install)', () => {
      const res = planExtraction({
        sourceDir: '/src',
        targetDir: '/tgt',
        existingManifest: { version: '1.0.0' },
        newManifest,
        existingState: null,
        newSourceHash,
      });
      expect(res).toEqual({ action: 'write', reason: 'state-missing' });
    });

    it('writes if content hash differs — the core bug-fix path', () => {
      const res = planExtraction({
        sourceDir: '/src',
        targetDir: '/tgt',
        existingManifest: { version: '1.0.0' },
        newManifest,
        existingState: STATE_V1({ sourceHash: 'a'.repeat(64), sourceManifestVersion: '1.0.0' }),
        newSourceHash, // 'b'.repeat(64)
      });
      expect(res).toEqual({ action: 'write', reason: 'content-hash-mismatch' });
    });

    it('skips if hash matches and manifest version matches', () => {
      const matching = 'c'.repeat(64);
      const res = planExtraction({
        sourceDir: '/src',
        targetDir: '/tgt',
        existingManifest: { version: '1.0.0' },
        newManifest,
        existingState: STATE_V1({ sourceHash: matching, sourceManifestVersion: '1.0.0' }),
        newSourceHash: matching,
      });
      expect(res).toEqual({ action: 'skip', reason: 'target-matches' });
    });

    it('refuses to downgrade: same hash but target version newer → skip', () => {
      const matching = 'd'.repeat(64);
      const res = planExtraction({
        sourceDir: '/src',
        targetDir: '/tgt',
        existingManifest: { version: '2.0.0' },
        newManifest: { version: '1.0.0' },
        existingState: STATE_V1({ sourceHash: matching, sourceManifestVersion: '2.0.0' }),
        newSourceHash: matching,
      });
      expect(res).toEqual({ action: 'skip', reason: 'target-newer' });
    });

    it('writes if hash matches but source version is newer (anomalous; reconcile)', () => {
      const matching = 'e'.repeat(64);
      const res = planExtraction({
        sourceDir: '/src',
        targetDir: '/tgt',
        existingManifest: { version: '1.0.0' },
        newManifest: { version: '1.0.1' },
        existingState: STATE_V1({ sourceHash: matching, sourceManifestVersion: '1.0.0' }),
        newSourceHash: matching,
      });
      expect(res).toEqual({ action: 'write', reason: 'version-mismatch-on-same-hash' });
    });
  });

  describe('readManifest', () => {
    it('parses valid manifest', async () => {
      const res = await readManifest(async () => '{"version":"1.2.3"}', '/man.json');
      expect(res).toEqual({ version: '1.2.3' });
    });
    it('returns null on ENOENT', async () => {
      const res = await readManifest(async () => {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }, '/man.json');
      expect(res).toBeNull();
    });
    it('returns null on malformed JSON', async () => {
      const res = await readManifest(async () => '{bad}', '/man.json');
      expect(res).toBeNull();
    });
  });

  describe('readExtractionState', () => {
    it('parses a valid v1 marker', async () => {
      const state = STATE_V1({ sourceHash: 'f'.repeat(64) });
      const res = await readExtractionState(
        async () => JSON.stringify(state),
        '/state.json',
      );
      expect(res).toEqual(state);
    });

    it('returns null on missing file', async () => {
      const res = await readExtractionState(async () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }, '/state.json');
      expect(res).toBeNull();
    });

    it('returns null on malformed JSON (tolerant reader, forces re-extract)', async () => {
      const res = await readExtractionState(async () => '{oops', '/state.json');
      expect(res).toBeNull();
    });

    it('returns null on wrong schema version (future-self compatibility)', async () => {
      const res = await readExtractionState(
        async () => JSON.stringify({ ...STATE_V1(), schemaVersion: 2 }),
        '/state.json',
      );
      expect(res).toBeNull();
    });

    it('returns null on missing required field', async () => {
      const res = await readExtractionState(
        async () => JSON.stringify({ schemaVersion: 1, sourceHash: 'abc', extractedAt: 1 }),
        '/state.json',
      );
      expect(res).toBeNull();
    });

    it('returns null on invalid hash length (not 64 hex chars)', async () => {
      const res = await readExtractionState(
        async () => JSON.stringify(STATE_V1({ sourceHash: 'tooshort' })),
        '/state.json',
      );
      expect(res).toBeNull();
    });
  });

  describe('writeExtractionState', () => {
    it('writes valid JSON with trailing newline', async () => {
      let wrote = '';
      const state = STATE_V1({ sourceHash: 'c'.repeat(64) });
      await writeExtractionState(
        async (_p, content) => {
          wrote = content;
        },
        '/state.json',
        state,
      );
      expect(wrote.endsWith('\n')).toBe(true);
      expect(JSON.parse(wrote)).toEqual(state);
    });
  });

  describe('computeExtensionSourceHash', () => {
    function makeWalker(tree: Record<string, string | Record<string, string>>) {
      // Convert a nested object tree into a mocked readdir/readFile pair.
      const files = new Map<string, Buffer>();
      function collect(node: Record<string, string | Record<string, string>>, prefix: string): void {
        for (const [name, value] of Object.entries(node)) {
          const full = prefix ? `${prefix}/${name}` : name;
          if (typeof value === 'string') {
            files.set(full, Buffer.from(value));
          } else {
            collect(value, full);
          }
        }
      }
      collect(tree, '');
      return {
        readdir: async (p: string) => {
          // Convert abs path back to rel key space.
          const rel = p === '/root' ? '' : p.replace(/^\/root\/?/, '');
          const prefix = rel ? `${rel}/` : '';
          const children = new Map<string, 'file' | 'dir'>();
          for (const key of files.keys()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const head = rest.split('/')[0];
            const isNested = rest.includes('/');
            if (!children.has(head)) {
              children.set(head, isNested ? 'dir' : 'file');
            }
          }
          return Array.from(children.entries()).map(([name, kind]) => ({
            name,
            isDirectory: () => kind === 'dir',
            isFile: () => kind === 'file',
          }));
        },
        readFile: async (p: string) => {
          const rel = p.replace(/^\/root\//, '');
          const found = files.get(rel);
          if (!found) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return found;
        },
        pathJoin: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      };
    }

    it('produces the same hash for the same content', async () => {
      const d = makeWalker({ 'manifest.json': '{"v":1}', 'bg.js': 'console.log(1)' });
      const a = await computeExtensionSourceHash('/root', d);
      const b = await computeExtensionSourceHash('/root', d);
      expect(a).toHaveLength(64);
      expect(a).toBe(b);
    });

    it('produces a different hash when any file content changes', async () => {
      const before = await computeExtensionSourceHash('/root', makeWalker({
        'manifest.json': '{"v":1}',
        'bg.js': 'console.log(1)',
      }));
      const after = await computeExtensionSourceHash('/root', makeWalker({
        'manifest.json': '{"v":1}',
        'bg.js': 'console.log(2)', // same version, different code — THE bug-fix case
      }));
      expect(before).not.toBe(after);
    });

    it('ignores .DS_Store / Thumbs.db / .git / *.swp noise', async () => {
      const clean = await computeExtensionSourceHash('/root', makeWalker({
        'manifest.json': '{"v":1}',
      }));
      const noisy = await computeExtensionSourceHash('/root', makeWalker({
        'manifest.json': '{"v":1}',
        '.DS_Store': 'mac-noise',
        'Thumbs.db': 'win-noise',
        'notes.swp': 'editor-swap',
      }));
      expect(clean).toBe(noisy);
    });

    it('is independent of readdir enumeration order', async () => {
      // Same tree, different order of keys in the mock. The sort inside
      // computeExtensionSourceHash should neutralize the difference.
      const a = await computeExtensionSourceHash('/root', makeWalker({
        'a.js': '1',
        'b.js': '2',
        'c.js': '3',
      }));
      const b = await computeExtensionSourceHash('/root', makeWalker({
        'c.js': '3',
        'a.js': '1',
        'b.js': '2',
      }));
      expect(a).toBe(b);
    });

    it('produces a different hash when a file is added', async () => {
      const one = await computeExtensionSourceHash('/root', makeWalker({ 'a.js': '1' }));
      const two = await computeExtensionSourceHash('/root', makeWalker({ 'a.js': '1', 'b.js': '2' }));
      expect(one).not.toBe(two);
    });

    it('handles nested directories deterministically', async () => {
      const a = await computeExtensionSourceHash('/root', makeWalker({
        'manifest.json': '{"v":1}',
        'sub': { 'inner.js': 'x' },
      }));
      const b = await computeExtensionSourceHash('/root', makeWalker({
        'sub': { 'inner.js': 'x' },
        'manifest.json': '{"v":1}',
      }));
      expect(a).toBe(b);
    });
  });
});
