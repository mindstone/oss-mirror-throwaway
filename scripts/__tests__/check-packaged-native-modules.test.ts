/**
 * Tests for the packaged *.node allowlist inventory
 * (scripts/check-packaged-native-modules.ts — PLAN.md 260611_fsevents-shutdown-crash
 * Stage 3c). Pure-core tests lock owner attribution + allowlist semantics; one temp-dir
 * test locks the Resources-tree scan (mirroring check-packaged-super-mcp-bundle.test.ts).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkNativeInventory,
  collectNativeFiles,
  discoverResourcesDirs,
  isAllowlisted,
  isCiContext,
  owningPackageOf,
} from '../check-packaged-native-modules';

describe('owningPackageOf', () => {
  it('attributes files to the package after the LAST node_modules segment', () => {
    expect(owningPackageOf('app.asar.unpacked/node_modules/fsevents/fsevents.node')).toBe('fsevents');
    expect(
      owningPackageOf('super-mcp/node_modules/keytar/build/Release/keytar.node'),
    ).toBe('keytar');
    expect(
      owningPackageOf('mcp/replit-ssh/node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node'),
    ).toBe('ssh2');
  });

  it('handles scoped packages (two segments)', () => {
    expect(
      owningPackageOf('app.asar.unpacked/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node'),
    ).toBe('@lancedb/lancedb-darwin-arm64');
    expect(
      owningPackageOf(
        'app.asar.unpacked/node_modules/@stoprocent/noble/prebuilds/darwin-x64+arm64/@stoprocent+noble.node',
      ),
    ).toBe('@stoprocent/noble');
  });

  it('marks files outside node_modules as non-package (loud by default)', () => {
    expect(owningPackageOf('workers/embedding.node')).toBe('(non-package) workers/embedding.node');
  });
});

describe('isAllowlisted', () => {
  it('matches exact names and *-prefix families, rejects unknowns', () => {
    expect(isAllowlisted('fsevents')).toBe(true);
    expect(isAllowlisted('@lancedb/lancedb-darwin-arm64')).toBe(true);
    expect(isAllowlisted('@lancedb/lancedb-win32-x64-msvc')).toBe(true);
    expect(isAllowlisted('@img/sharp-linux-x64')).toBe(true);
    expect(isAllowlisted('evil-native')).toBe(false);
    expect(isAllowlisted('@lancedb-fake/other')).toBe(false);
  });

  it('allowlists the Windows sherpa-onnx native library (forge step 5d, win32 only)', () => {
    expect(isAllowlisted('sherpa-onnx-win-x64')).toBe(true);
  });

  it('enforces the path pin for fsevents (stage-3 review F1): name match alone is not enough', () => {
    expect(isAllowlisted('fsevents', 'app.asar.unpacked/node_modules/fsevents/fsevents.node')).toBe(true);
    expect(isAllowlisted('fsevents', 'mcp/foo/node_modules/fsevents/fsevents.node')).toBe(false);
    expect(isAllowlisted('fsevents', 'super-mcp/node_modules/fsevents/fsevents.node')).toBe(false);
    // Non-pinned owners are unaffected by the path argument.
    expect(isAllowlisted('keytar', 'anywhere/node_modules/keytar/build/Release/keytar.node')).toBe(true);
  });
});

describe('checkNativeInventory', () => {
  it('passes the real darwin-arm64 inventory shape (discovered 2026-06-11)', () => {
    const result = checkNativeInventory([
      'app.asar.unpacked/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
      'app.asar.unpacked/node_modules/@lancedb/lancedb-darwin-arm64/lancedb.darwin-arm64.node',
      'app.asar.unpacked/node_modules/@stoprocent/bluetooth-hci-socket/build/Release/bluetooth_hci_socket.node',
      'app.asar.unpacked/node_modules/@stoprocent/noble/prebuilds/darwin-x64+arm64/@stoprocent+noble.node',
      'app.asar.unpacked/node_modules/fsevents/fsevents.node',
      'app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node',
      'mcp/replit-ssh/node_modules/cpu-features/build/Release/cpufeatures.node',
      'mcp/replit-ssh/node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node',
      'super-mcp/node_modules/keytar/build/Release/keytar.node',
    ]);
    expect([...result.unlisted.keys()]).toEqual([]);
    expect(result.scannedNativeFileCount).toBe(9);
  });

  it('REDs a new unlisted native module and groups its files', () => {
    const result = checkNativeInventory([
      'app.asar.unpacked/node_modules/fsevents/fsevents.node',
      'app.asar.unpacked/node_modules/evil-native/build/a.node',
      'app.asar.unpacked/node_modules/evil-native/build/b.node',
    ]);
    expect([...result.unlisted.keys()]).toEqual(['evil-native']);
    expect(result.unlisted.get('evil-native')).toHaveLength(2);
  });

  it('REDs a loose .node file outside any node_modules', () => {
    const result = checkNativeInventory(['workers/embedding.node']);
    expect([...result.unlisted.keys()]).toEqual(['(non-package) workers/embedding.node']);
  });

  it('reports platform-unmatched allowlist patterns as informational, not failures', () => {
    const result = checkNativeInventory(['app.asar.unpacked/node_modules/fsevents/fsevents.node']);
    expect([...result.unlisted.keys()]).toEqual([]);
    expect(result.unusedAllowlistPatterns).toContain('keytar');
    expect(result.unusedAllowlistPatterns).not.toContain('fsevents');
  });

  it('REDs a second fsevents copy outside the pinned app-watcher path (stage-3 review F1)', () => {
    const result = checkNativeInventory([
      'app.asar.unpacked/node_modules/fsevents/fsevents.node', // the wrapper-patched copy: OK
      'mcp/foo/node_modules/fsevents/fsevents.node', // second copy outside the module cache: RED
    ]);
    expect([...result.unlisted.keys()]).toEqual(['fsevents (copy outside its pinned path)']);
    expect(result.unlisted.get('fsevents (copy outside its pinned path)')).toEqual([
      'mcp/foo/node_modules/fsevents/fsevents.node',
    ]);
  });

  it('REDs a relocated fsevents even when the pinned copy is absent (rogue copy is never a match)', () => {
    const result = checkNativeInventory(['super-mcp/node_modules/fsevents/fsevents.node']);
    expect([...result.unlisted.keys()]).toEqual(['fsevents (copy outside its pinned path)']);
    // The rogue copy must not count as "fsevents matched" for the info report either.
    expect(result.unusedAllowlistPatterns).toContain('fsevents');
  });
});

describe('Resources-tree scan', () => {
  let tmpDir: string | null = null;
  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('discovers Resources dirs and collects only *.node files (posix-relative)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-inv-test-'));
    const resources = path.join(tmpDir, 'Foo.app', 'Contents', 'Resources');
    fs.mkdirSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'fsevents'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'fsevents', 'fsevents.node'), '');
    fs.writeFileSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'fsevents', 'fsevents.js'), '');

    const dirs = discoverResourcesDirs(tmpDir);
    expect(dirs).toEqual([resources]);
    expect(collectNativeFiles(resources)).toEqual(['app.asar.unpacked/node_modules/fsevents/fsevents.node']);
  });

  it('finds no Resources dirs in an empty/unpackaged tree (CLI skip path)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-inv-test-'));
    fs.mkdirSync(path.join(tmpDir, 'main'), { recursive: true });
    expect(discoverResourcesDirs(tmpDir)).toEqual([]);
  });

  it('discovers a Windows lowercase `resources` tree under <App>-win32-x64 (the spike SKIP bug)', () => {
    // Windows packaged apps lay out as out/<App>-win32-x64/resources/... — lowercase.
    // The original capital-only `Resources` match skipped this entire tree, so the
    // Windows native inventory never ran (ci_run_27377676963_attempt1.log:4487).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-inv-test-'));
    const resources = path.join(tmpDir, 'Foo-win32-x64', 'resources');
    fs.mkdirSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'),
      '',
    );

    const dirs = discoverResourcesDirs(tmpDir);
    expect(dirs).toEqual([resources]);
    expect(collectNativeFiles(resources)).toEqual([
      'app.asar.unpacked/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node',
    ]);
  });

  it('GREEN end-to-end on a Windows tree: the sherpa-onnx native is allowlisted, not RED', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-inv-test-'));
    const resources = path.join(tmpDir, 'Foo-win32-x64', 'resources');
    fs.mkdirSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node'),
      '',
    );
    // Same composition the CLI main() runs: discover → collect → check.
    const dirs = discoverResourcesDirs(tmpDir);
    expect(dirs).toEqual([resources]);
    const result = checkNativeInventory(collectNativeFiles(resources));
    expect([...result.unlisted.keys()]).toEqual([]);
    expect(result.scannedNativeFileCount).toBe(1);
  });

  it('RED end-to-end: a nested mcp/foo fsevents copy in a fixture Resources tree fails the guard (stage-3 review F1)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-inv-test-'));
    const resources = path.join(tmpDir, 'Foo.app', 'Contents', 'Resources');
    // The legitimate wrapper-patched copy…
    fs.mkdirSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'fsevents'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'app.asar.unpacked', 'node_modules', 'fsevents', 'fsevents.node'), '');
    // …and a second copy packaged under an MCP server tree (outside the module cache).
    fs.mkdirSync(path.join(resources, 'mcp', 'foo', 'node_modules', 'fsevents'), { recursive: true });
    fs.writeFileSync(path.join(resources, 'mcp', 'foo', 'node_modules', 'fsevents', 'fsevents.node'), '');

    // Same composition the CLI main() runs: discover → collect → check.
    const dirs = discoverResourcesDirs(tmpDir);
    expect(dirs).toEqual([resources]);
    const result = checkNativeInventory(collectNativeFiles(resources));
    expect([...result.unlisted.keys()]).toEqual(['fsevents (copy outside its pinned path)']);
    expect(result.unlisted.get('fsevents (copy outside its pinned path)')).toEqual([
      'mcp/foo/node_modules/fsevents/fsevents.node',
    ]);
  });
});

describe('isCiContext (no-tree is a FAIL in CI, a benign SKIP locally)', () => {
  it('is true under GitHub Actions or generic CI', () => {
    expect(isCiContext({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCiContext({ CI: 'true' })).toBe(true);
  });

  it('is false locally (no CI env)', () => {
    expect(isCiContext({})).toBe(false);
    expect(isCiContext({ GITHUB_ACTIONS: 'false', CI: 'false' })).toBe(false);
  });
});
