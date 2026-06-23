import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';

 
vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({
    homePath: '/Users/testuser',
  })),
}));

import { canonicalizeConnectorPath } from '@core/utils/canonicalConnectorPath';

/**
 * Stage 2.B test inventory — covers the platform-aware canonicaliser per
 * `docs/plans/260426_foolproof_contribution_flow_stage2.md` § Test inventory.
 *
 * The canonicaliser uses `process.platform` directly (read on every call), so
 * we mutate the descriptor when a test wants a non-host platform. The
 * descriptor is restored in `afterEach` so accidental leakage doesn't break
 * other suites.
 */

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
    writable: true,
  });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
}

describe('canonicalizeConnectorPath', () => {
  beforeEach(() => {
    // Default to a non-existent path so existsSync returns false and the
    // realpath fallback path is exercised. Individual tests opt-in to
    // existsSync = true via real-fs symlink fixtures.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  });

  afterEach(() => {
    restorePlatform();
    vi.restoreAllMocks();
  });

  it('Windows backslash paths normalise to forward slashes + lowercase on win32', () => {
    setPlatform('win32');
    // Simulate Windows: nodePath on a posix host still understands forward
    // slashes after our backslash conversion. The canonicaliser doesn't rely
    // on win32 nodePath behaviour for absolute-resolution; it relies on
    // toPortablePath to strip backslashes and on .toLowerCase() for casing.
    // Use an absolute-looking path so path.resolve doesn't prepend cwd.
    const result = canonicalizeConnectorPath('C:\\Users\\dev\\mcp-servers\\Foo');
    // path.resolve on posix treats the input as a relative path (no
    // drive-letter awareness) so the cwd gets prefixed. To keep the assertion
    // platform-host-independent, only check the suffix shape (forward slashes
    // + lowercase + Windows-style case-insensitivity).
    expect(result).toMatch(/c:\\users\\dev\\mcp-servers\\foo$|c:\/users\/dev\/mcp-servers\/foo$/);
    // Either a portable suffix (host == win32) or backslash form (host == posix
    // but the function still applied .toLowerCase + toPortablePath after
    // path.resolve produced the cwd-prefixed form). Important: NO uppercase.
    expect(result).toBe(result.toLowerCase());
    expect(result.includes('\\')).toBe(false);
  });

  it('Linux preserves case and does NOT lowercase', () => {
    setPlatform('linux');
    const result = canonicalizeConnectorPath('/home/dev/mcp-servers/Foo');
    expect(result).toBe('/home/dev/mcp-servers/Foo');
  });

  it('macOS NFD path normalises to NFC and lowercases', () => {
    setPlatform('darwin');
    // 'café' as NFD: 'cafe' + COMBINING ACUTE ACCENT (U+0301)
    const nfdInput = '/Users/dev/mcp-servers/Cafe\u0301';
    // 'café' as NFC: precomposed (U+00E9)
    const nfcReference = '/users/dev/mcp-servers/caf\u00e9';
    const result = canonicalizeConnectorPath(nfdInput);
    expect(result).toBe(nfcReference);
    // And confirm the equivalent NFC input produces the same canonical key.
    const fromNfc = canonicalizeConnectorPath('/Users/dev/mcp-servers/Caf\u00e9');
    expect(fromNfc).toBe(nfcReference);
  });

  it('tilde-expansion uses platform homePath then lowercases on darwin', () => {
    setPlatform('darwin');
    const result = canonicalizeConnectorPath('~/mcp-servers/Foo');
    expect(result).toBe('/users/testuser/mcp-servers/foo');
  });

  it('non-existent paths skip realpath but still NFC + casing-normalise', () => {
    setPlatform('darwin');
    // existsSync mock returns false (set in beforeEach) — realpathSync MUST
    // not be called.
    const realpathSpy = vi.spyOn(fs, 'realpathSync');
    const result = canonicalizeConnectorPath('/Users/Dev/MCP-Servers/Cafe\u0301');
    expect(realpathSpy).not.toHaveBeenCalled();
    // NFC + lowercase still applied.
    expect(result).toBe('/users/dev/mcp-servers/caf\u00e9');
  });

  it('existing path goes through realpathSync (symlink resolution)', () => {
    setPlatform('darwin');
    // Restore real fs for this test — we want existsSync to return true so
    // the realpath path is exercised end-to-end.
    vi.restoreAllMocks();
    // Set up a real symlink in a temp dir.
    const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'canonical-link-'));
    const realDir = nodePath.join(tmpRoot, 'real-target');
    fs.mkdirSync(realDir);
    const linkPath = nodePath.join(tmpRoot, 'symlink');
    try {
      fs.symlinkSync(realDir, linkPath, 'dir');
    } catch {
      // Some hosts (e.g. Windows without admin) refuse symlink creation.
      // Skip the assertion on those — the realpath-fallback test above still
      // covers the no-symlink case.
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      return;
    }
    try {
      const result = canonicalizeConnectorPath(linkPath);
      // realpathSync(linkPath) resolves the leaf symlink AND any parent
      // symlinks (e.g. on macOS `/var/folders` → `/private/var/folders`).
      // Compute the expected canonical form using the same pipeline so the
      // assertion is host-agnostic.
      const expected = fs.realpathSync(linkPath).replace(/\\/g, '/').normalize('NFC').toLowerCase();
      expect(result).toBe(expected);
      // The leaf must point at `real-target`, never `symlink` — proves the
      // realpath actually fired.
      expect(result.endsWith('/real-target')).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('empty / null / undefined / whitespace input returns empty string', () => {
    expect(canonicalizeConnectorPath('')).toBe('');
    expect(canonicalizeConnectorPath(null)).toBe('');
    expect(canonicalizeConnectorPath(undefined)).toBe('');
    expect(canonicalizeConnectorPath('   ')).toBe('');
    expect(canonicalizeConnectorPath('\t\n')).toBe('');
  });

  it('idempotence: canonical(canonical(p)) === canonical(p) on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      setPlatform(platform);
      // Use absolute paths so path.resolve doesn't introduce cwd-dependent
      // drift across the two passes.
      const inputs = [
        '/Users/Dev/mcp-servers/Cafe\u0301',
        '/home/dev/mcp-servers/Foo',
        '/Users/dev/mcp-servers/cafe',
      ];
      for (const input of inputs) {
        const once = canonicalizeConnectorPath(input);
        const twice = canonicalizeConnectorPath(once);
        expect(twice).toBe(once);
      }
    }
  });
});
