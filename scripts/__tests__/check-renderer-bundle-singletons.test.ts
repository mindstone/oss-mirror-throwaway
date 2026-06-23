import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  bundleIsPresent,
  CliArgError,
  collectJsFiles,
  countDistinctPairs,
  isEnforceMode,
  parseCliArgs,
  readExpectedReactVersion,
  runCheck,
  scanBundleDirectory,
} from '../check-renderer-bundle-singletons';

// ---------------------------------------------------------------------------
// Helpers: fake fs adapters driven by in-memory file maps.
// ---------------------------------------------------------------------------

interface FakeFs {
  files: Record<string, string>;
}

function fakeReaddir(fakeFs: FakeFs): (p: string) => fs.Dirent[] {
  return (dir) => {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    const immediateChildren = new Map<string, { isDir: boolean }>();
    for (const full of Object.keys(fakeFs.files)) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      const firstSep = rest.indexOf(path.sep);
      if (firstSep === -1) {
        immediateChildren.set(rest, { isDir: false });
      } else {
        immediateChildren.set(rest.slice(0, firstSep), { isDir: true });
      }
    }
    return Array.from(immediateChildren.entries()).map(
      ([name, meta]) =>
        ({
          name,
          isDirectory: () => meta.isDir,
          isFile: () => !meta.isDir,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isSymbolicLink: () => false,
          isFIFO: () => false,
          isSocket: () => false,
          parentPath: dir,
          path: dir,
        }) as unknown as fs.Dirent,
    );
  };
}

function fakeReadFile(fakeFs: FakeFs): (p: string) => string {
  return (p) => {
    const v = fakeFs.files[p];
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  };
}

function fakeExists(fakeFs: FakeFs): (p: string) => boolean {
  return (p) => {
    if (fakeFs.files[p] !== undefined) return true;
    const prefix = p.endsWith(path.sep) ? p : p + path.sep;
    return Object.keys(fakeFs.files).some((f) => f.startsWith(prefix));
  };
}

// ---------------------------------------------------------------------------
// countDistinctPairs — unit-level behavior
// ---------------------------------------------------------------------------

describe('countDistinctPairs', () => {
  it('counts same identifier in a single file as ONE pair', () => {
    const text = `a.version="19.2.4";a.version="19.2.4";a.version="19.2.4";`;
    const pairs = countDistinctPairs(
      '/bundle/a.js',
      text,
      /([A-Za-z_$][A-Za-z0-9_$]*)\.version\s*=\s*['"](\d+\.\d+\.\d+)['"]/g,
    );
    expect(pairs).toEqual([{ file: '/bundle/a.js', identifier: 'a' }]);
  });

  it('counts same identifier across two files as TWO pairs', () => {
    const regex = /([A-Za-z_$][A-Za-z0-9_$]*)\.version\s*=\s*['"](\d+\.\d+\.\d+)['"]/g;
    const a = countDistinctPairs('/bundle/a.js', `cp.version="19.2.4";`, regex);
    const b = countDistinctPairs('/bundle/b.js', `cp.version="19.2.4";`, regex);
    expect([...a, ...b]).toEqual([
      { file: '/bundle/a.js', identifier: 'cp' },
      { file: '/bundle/b.js', identifier: 'cp' },
    ]);
  });

  it('applies the filter callback to reject non-matching versions', () => {
    const regex = /([A-Za-z_$][A-Za-z0-9_$]*)\.version\s*=\s*['"](\d+\.\d+\.\d+)['"]/g;
    const text = `foo.version="1.2.3";bar.version="19.2.4";`;
    const pairs = countDistinctPairs(
      '/bundle/x.js',
      text,
      regex,
      (m) => m[2] === '19.2.4',
    );
    expect(pairs).toEqual([{ file: '/bundle/x.js', identifier: 'bar' }]);
  });

  it('ignores `.version=` assignments to non-numeric strings', () => {
    const regex = /([A-Za-z_$][A-Za-z0-9_$]*)\.version\s*=\s*['"](\d+\.\d+\.\d+)['"]/g;
    const text = `obj.version="foo";other.version="19.2.4";`;
    const pairs = countDistinctPairs(
      '/bundle/x.js',
      text,
      regex,
      (m) => m[2] === '19.2.4',
    );
    expect(pairs).toEqual([{ file: '/bundle/x.js', identifier: 'other' }]);
  });
});

// ---------------------------------------------------------------------------
// scanBundleDirectory — integration with fake fs
// ---------------------------------------------------------------------------

describe('scanBundleDirectory', () => {
  const BUNDLE = '/bundle/assets';

  function mkBundle(entries: Record<string, string>): FakeFs {
    const files: Record<string, string> = {};
    for (const [rel, content] of Object.entries(entries)) {
      files[path.join(BUNDLE, rel)] = content;
    }
    return { files };
  }

  it('returns 3 distinct version pairs and 1 useState pair on a post-fix bundle shape', () => {
    const fakeFs = mkBundle({
      'index.js': `
        cp.version="19.2.4";
        Hi.version="19.2.4";Hi.useState=function(a){return a};
        MR.version="19.2.4";
      `,
      'vendor.js': `unrelated.version="1.0.0";`,
    });
    const result = scanBundleDirectory(BUNDLE, '19.2.4', {
      readFile: fakeReadFile(fakeFs),
      readdir: fakeReaddir(fakeFs),
      exists: fakeExists(fakeFs),
    });
    expect(result.versionPairs).toHaveLength(3);
    expect(result.useStatePairs).toHaveLength(1);
    expect(result.scannedFiles).toHaveLength(2);
  });

  it('detects a cross-file collision as a duplicate React (2 pairs for identifier `cp`)', () => {
    const fakeFs = mkBundle({
      'main.js': `cp.version="19.2.4";cp.useState=function(){}`,
      'chunk.js': `cp.version="19.2.4";cp.useState=function(){}`,
    });
    const result = scanBundleDirectory(BUNDLE, '19.2.4', {
      readFile: fakeReadFile(fakeFs),
      readdir: fakeReaddir(fakeFs),
      exists: fakeExists(fakeFs),
    });
    expect(result.versionPairs).toHaveLength(2);
    expect(result.useStatePairs).toHaveLength(2);
  });

  it('ignores React versions that do not match the expected version', () => {
    const fakeFs = mkBundle({
      'index.js': `cp.version="18.3.1";Hi.version="19.2.4";`,
    });
    const result = scanBundleDirectory(BUNDLE, '19.2.4', {
      readFile: fakeReadFile(fakeFs),
      readdir: fakeReaddir(fakeFs),
      exists: fakeExists(fakeFs),
    });
    expect(result.versionPairs).toEqual([
      { file: path.join(BUNDLE, 'index.js'), identifier: 'Hi' },
    ]);
  });

  it('throws a helpful error if the bundle directory does not exist', () => {
    const fakeFs = mkBundle({});
    expect(() =>
      scanBundleDirectory('/nonexistent', '19.2.4', {
        readFile: fakeReadFile(fakeFs),
        readdir: fakeReaddir(fakeFs),
        exists: fakeExists(fakeFs),
      }),
    ).toThrow(/Renderer bundle directory not found/);
  });

  it('fails fast if the bundle directory exists but has no JS files (never soft-pass)', () => {
    // exists() returns true (dir-like), but there are no .js/.mjs/.cjs
    // files — could happen if a refactor breaks the bundle output path.
    const exists = () => true;
    const readdir = () => [] as fs.Dirent[];
    expect(() =>
      scanBundleDirectory('/bundle/empty', '19.2.4', {
        readFile: () => '',
        readdir,
        exists,
      }),
    ).toThrow(/contains no JS files/);
  });

  it('walks nested subdirectories', () => {
    const fakeFs = mkBundle({
      'outer.js': `cp.version="19.2.4";`,
      [`nested${path.sep}inner.js`]: `Hi.version="19.2.4";`,
    });
    const result = scanBundleDirectory(BUNDLE, '19.2.4', {
      readFile: fakeReadFile(fakeFs),
      readdir: fakeReaddir(fakeFs),
      exists: fakeExists(fakeFs),
    });
    expect(result.versionPairs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// readExpectedReactVersion
// ---------------------------------------------------------------------------

describe('readExpectedReactVersion', () => {
  it('returns the version string from node_modules/react/package.json', () => {
    const files: Record<string, string> = {
      [path.join('/repo', 'node_modules', 'react', 'package.json')]: JSON.stringify({
        version: '19.2.4',
      }),
    };
    const version = readExpectedReactVersion(
      '/repo',
      (p) => files[p] ?? (() => { throw new Error('ENOENT'); })(),
      (p) => p in files,
    );
    expect(version).toBe('19.2.4');
  });

  it('throws with `npm ci` hint when node_modules/react/package.json is missing', () => {
    expect(() =>
      readExpectedReactVersion(
        '/repo',
        () => { throw new Error('should not be read'); },
        () => false,
      ),
    ).toThrow(/run `npm ci` first/i);
  });
});

// ---------------------------------------------------------------------------
// runCheck — violation/pass decision logic
// ---------------------------------------------------------------------------

describe('runCheck', () => {
  const BUNDLE = '/bundle/assets';

  function mkBundle(entries: Record<string, string>): FakeFs {
    const files: Record<string, string> = {};
    for (const [rel, content] of Object.entries(entries)) {
      files[path.join(BUNDLE, rel)] = content;
    }
    return { files };
  }

  it('OK on a post-fix bundle (3 version objects, 1 useState)', () => {
    const fakeFs = mkBundle({
      'index.js': `
        cp.version="19.2.4";
        Hi.version="19.2.4";Hi.useState=function(){};
        MR.version="19.2.4";
      `,
    });
    const outcome = runCheck({
      bundleDir: BUNDLE,
      expectedReactVersion: '19.2.4',
      scanOptions: {
        readFile: fakeReadFile(fakeFs),
        readdir: fakeReaddir(fakeFs),
        exists: fakeExists(fakeFs),
      },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.violations).toEqual([]);
    expect(outcome.summary).toContain('3 version object(s)');
    expect(outcome.summary).toContain('1 useState dispatcher(s)');
  });

  it('FAIL on 4 distinct version pairs', () => {
    const fakeFs = mkBundle({
      'a.js': `cp.version="19.2.4";Hi.version="19.2.4";`,
      'b.js': `MR.version="19.2.4";extra.version="19.2.4";`,
    });
    const outcome = runCheck({
      bundleDir: BUNDLE,
      expectedReactVersion: '19.2.4',
      scanOptions: {
        readFile: fakeReadFile(fakeFs),
        readdir: fakeReaddir(fakeFs),
        exists: fakeExists(fakeFs),
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.violations[0]).toMatch(/Found 4 React-family/);
    expect(outcome.violations[0]).toContain('extra in');
  });

  it('FAIL on 2 useState dispatchers', () => {
    const fakeFs = mkBundle({
      'a.js': `cp.useState=function(){};`,
      'b.js': `Hi.useState=function(){};`,
    });
    const outcome = runCheck({
      bundleDir: BUNDLE,
      expectedReactVersion: '19.2.4',
      scanOptions: {
        readFile: fakeReadFile(fakeFs),
        readdir: fakeReaddir(fakeFs),
        exists: fakeExists(fakeFs),
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.violations[0]).toMatch(/Found 2 .*?dispatchers/);
  });

  it('honours custom thresholds (--max-version-objects 2)', () => {
    const fakeFs = mkBundle({
      'index.js': `cp.version="19.2.4";Hi.version="19.2.4";MR.version="19.2.4";`,
    });
    const outcome = runCheck({
      bundleDir: BUNDLE,
      expectedReactVersion: '19.2.4',
      maxVersionObjects: 2,
      scanOptions: {
        readFile: fakeReadFile(fakeFs),
        readdir: fakeReaddir(fakeFs),
        exists: fakeExists(fakeFs),
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.violations[0]).toMatch(/Found 3 .*?expected ≤ 2/u);
  });
});

// ---------------------------------------------------------------------------
// collectJsFiles — extension filter behavior
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parseCliArgs — strict arg parsing rejects silent-failure shapes
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('parses a complete arg set correctly', () => {
    const args = parseCliArgs([
      '--bundle-dir',
      '/some/path',
      '--max-version-objects',
      '4',
      '--max-usestate',
      '2',
    ]);
    expect(args.bundleDir).toBe('/some/path');
    expect(args.maxVersionObjects).toBe(4);
    expect(args.maxUseStateDispatchers).toBe(2);
  });

  it('rejects --max-usestate with a non-integer value (no silent NaN)', () => {
    expect(() => parseCliArgs(['--max-usestate', 'nope'])).toThrowError(CliArgError);
    expect(() => parseCliArgs(['--max-usestate', 'nope'])).toThrow(
      /must be a non-negative integer/i,
    );
  });

  it('rejects --max-version-objects with a negative value', () => {
    expect(() => parseCliArgs(['--max-version-objects', '-1'])).toThrowError(CliArgError);
  });

  it('rejects --bundle-dir with no value', () => {
    expect(() => parseCliArgs(['--bundle-dir'])).toThrowError(CliArgError);
    expect(() => parseCliArgs(['--bundle-dir'])).toThrow(/requires a value/);
  });

  it('rejects --bundle-dir immediately followed by another flag (prevents arg-swallowing)', () => {
    expect(() =>
      parseCliArgs(['--bundle-dir', '--max-usestate', '1']),
    ).toThrowError(CliArgError);
  });

  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--wat'])).toThrowError(CliArgError);
    expect(() => parseCliArgs(['--wat'])).toThrow(/Unknown flag/);
  });

  it('recognises --help without treating it as a violation', () => {
    const args = parseCliArgs(['--help']);
    expect(args.helpRequested).toBe(true);
  });

  it('parses --enforce', () => {
    expect(parseCliArgs(['--enforce']).enforce).toBe(true);
    expect(parseCliArgs([]).enforce).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isEnforceMode — flag OR env promotes to blocking
// ---------------------------------------------------------------------------

describe('isEnforceMode', () => {
  it('is off by default (no flag, no env)', () => {
    expect(isEnforceMode({}, {})).toBe(false);
  });

  it('is on with the --enforce flag', () => {
    expect(isEnforceMode({ enforce: true }, {})).toBe(true);
  });

  it('is on with RENDERER_BUNDLE_SINGLETONS_ENFORCE=1 / true', () => {
    expect(isEnforceMode({}, { RENDERER_BUNDLE_SINGLETONS_ENFORCE: '1' })).toBe(true);
    expect(isEnforceMode({}, { RENDERER_BUNDLE_SINGLETONS_ENFORCE: 'true' })).toBe(true);
  });

  it('is off for other env values', () => {
    expect(isEnforceMode({}, { RENDERER_BUNDLE_SINGLETONS_ENFORCE: '0' })).toBe(false);
    expect(isEnforceMode({}, { RENDERER_BUNDLE_SINGLETONS_ENFORCE: 'no' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bundleIsPresent — skip-when-no-bundle decision
// ---------------------------------------------------------------------------

describe('bundleIsPresent', () => {
  const BUNDLE = '/bundle/assets';

  function mkBundle(entries: Record<string, string>): FakeFs {
    const files: Record<string, string> = {};
    for (const [rel, content] of Object.entries(entries)) {
      files[path.join(BUNDLE, rel)] = content;
    }
    return { files };
  }

  it('returns false when the dir does not exist (normal local/validate:fast state)', () => {
    const fakeFs = mkBundle({});
    expect(bundleIsPresent(BUNDLE, fakeExists(fakeFs), fakeReaddir(fakeFs))).toBe(false);
  });

  it('returns false when the dir exists but has no JS files', () => {
    const exists = () => true;
    const readdir = () => [] as fs.Dirent[];
    expect(bundleIsPresent(BUNDLE, exists, readdir)).toBe(false);
  });

  it('returns true when the dir has at least one JS file', () => {
    const fakeFs = mkBundle({ 'index.js': 'cp.version="19.2.4";' });
    expect(bundleIsPresent(BUNDLE, fakeExists(fakeFs), fakeReaddir(fakeFs))).toBe(true);
  });
});

describe('collectJsFiles', () => {
  it('only collects .js/.mjs/.cjs files and skips others', () => {
    const BUNDLE = '/bundle';
    const files: Record<string, string> = {
      [path.join(BUNDLE, 'a.js')]: '',
      [path.join(BUNDLE, 'b.mjs')]: '',
      [path.join(BUNDLE, 'c.cjs')]: '',
      [path.join(BUNDLE, 'd.css')]: '',
      [path.join(BUNDLE, 'e.map')]: '',
      [path.join(BUNDLE, 'f.json')]: '',
    };
    const result = collectJsFiles(BUNDLE, fakeReaddir({ files }));
    expect(result.map((p) => path.basename(p)).sort()).toEqual(['a.js', 'b.mjs', 'c.cjs']);
  });
});
