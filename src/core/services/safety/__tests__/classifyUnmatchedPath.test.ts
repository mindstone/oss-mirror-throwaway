import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatformConfig } from '@core/platform';
import { classifyUnmatchedPath } from '../classifyUnmatchedPath';

/**
 * Unit coverage for the shared unmatched-path classifier — the single source of
 * truth consumed by both the memory-write auto-approve gate (which injects a
 * realpath containment predicate) and the file-location display resolver
 * (lexical-only). See classifyUnmatchedPath.ts.
 */

const USER_DATA = '/Users/test-user-data';
const HOME = '/Users/test-home';
const CORE = '/Users/test/workspace';

function installPlatform(): void {
  setPlatformConfig({
    userDataPath: USER_DATA,
    appPath: '/tmp/test-app',
    tempPath: '/tmp/test-temp',
    logsPath: '/tmp/test-logs',
    homePath: HOME,
    documentsPath: '/tmp/test-documents',
    desktopPath: '/tmp/test-desktop',
    appDataPath: '/tmp/test-appData',
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 36 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface: 'desktop',
    isOss: false,
  });
}

describe('classifyUnmatchedPath — precedence ladder (lexical-only default)', () => {
  beforeEach(installPlatform);

  it('classifies OS temp dirs as temp', () => {
    expect(classifyUnmatchedPath('/tmp/scratch.txt', CORE).classification).toBe('temp');
    expect(classifyUnmatchedPath('/private/tmp/x', CORE).classification).toBe('temp');
    expect(classifyUnmatchedPath('/var/folders/ab/cd/T/x', CORE).classification).toBe('temp');
  });

  it('classifies rebel-system as system', () => {
    expect(
      classifyUnmatchedPath(`${CORE}/rebel-system/skills/x.md`, CORE).classification,
    ).toBe('system');
    expect(classifyUnmatchedPath('rebel-system/x.md', CORE).classification).toBe('system');
  });

  it('classifies the userData inbox as inbox', () => {
    const r = classifyUnmatchedPath(`${USER_DATA}/inbox/item.json`, CORE);
    expect(r.classification).toBe('inbox');
    expect(r.displayLabel).toBe('Actions');
  });

  it('classifies ~/mcp-servers as mcp_servers (absolute and tilde forms)', () => {
    expect(
      classifyUnmatchedPath(`${HOME}/mcp-servers/foo/index.ts`, CORE).classification,
    ).toBe('mcp_servers');
    expect(classifyUnmatchedPath('~/mcp-servers/foo/index.ts', CORE).classification).toBe(
      'mcp_servers',
    );
  });

  it('classifies an unrelated absolute path as outside', () => {
    expect(classifyUnmatchedPath('/some/random/file.txt', CORE).classification).toBe('outside');
  });

  it('classifies a path under core but not in a space as workspace_root', () => {
    expect(classifyUnmatchedPath(`${CORE}/loose-file.md`, CORE).classification).toBe(
      'workspace_root',
    );
  });

  it('classifies a relative path with no core as unknown', () => {
    expect(classifyUnmatchedPath('notes/todo.md', undefined).classification).toBe('unknown');
  });

  it('does not auto-classify a traversal spelling that escapes the inbox (normalize-before-match)', () => {
    // `<userData>/inbox/../trusted-tools/x` resolves OUTSIDE inbox — must NOT be
    // classified inbox even on the lexical-only path.
    const r = classifyUnmatchedPath(`${USER_DATA}/inbox/../trusted-tools/secret.json`, CORE);
    expect(r.classification).not.toBe('inbox');
    expect(r.classification).toBe('outside');
  });
});

describe('classifyUnmatchedPath — injected containment predicate', () => {
  beforeEach(installPlatform);

  it('falls through auto-approvable branches when isContained returns false', () => {
    const denyAll = vi.fn().mockReturnValue(false);
    // Temp lexically matches but the symlink gate rejects → not temp.
    expect(
      classifyUnmatchedPath('/tmp/scratch.txt', CORE, { isContained: denyAll }).classification,
    ).toBe('outside');
    // Inbox lexically matches but the symlink gate rejects → not inbox.
    expect(
      classifyUnmatchedPath(`${USER_DATA}/inbox/item.json`, CORE, { isContained: denyAll })
        .classification,
    ).toBe('outside');
    expect(denyAll).toHaveBeenCalled();
  });

  it('keeps the branch when isContained returns true', () => {
    const allow = vi.fn().mockReturnValue(true);
    expect(
      classifyUnmatchedPath('/tmp/scratch.txt', CORE, { isContained: allow }).classification,
    ).toBe('temp');
  });

  it('passes RAW child + parent to the predicate (so it can realpath itself)', () => {
    const spy = vi.fn().mockReturnValue(true);
    classifyUnmatchedPath(`${USER_DATA}/inbox/item.json`, CORE, { isContained: spy });
    expect(spy).toHaveBeenCalledWith(
      `${USER_DATA}/inbox/item.json`,
      `${USER_DATA}/inbox`,
    );
  });

  it('gates the mcp_servers branch too (deny → not mcp_servers)', () => {
    const denyAll = vi.fn().mockReturnValue(false);
    // Absolute mcp-servers path lexically matches but the symlink gate rejects.
    expect(
      classifyUnmatchedPath(`${HOME}/mcp-servers/foo/index.ts`, CORE, { isContained: denyAll })
        .classification,
    ).toBe('outside');
    expect(denyAll).toHaveBeenCalled();
  });

  it('passes the TILDE-EXPANDED child (not the raw ~ form) to the predicate for mcp_servers', () => {
    const spy = vi.fn().mockReturnValue(true);
    classifyUnmatchedPath('~/mcp-servers/foo/index.ts', CORE, { isContained: spy });
    // The predicate must receive the expanded path so its realpath resolves a real
    // location — passing the literal `~/…` would never resolve.
    expect(spy).toHaveBeenCalledWith(`${HOME}/mcp-servers/foo/index.ts`, `${HOME}/mcp-servers`);
  });

  it('system classification is unaffected by the predicate (not an auto-approve containment branch)', () => {
    const denyAll = vi.fn().mockReturnValue(false);
    expect(
      classifyUnmatchedPath('rebel-system/x.md', CORE, { isContained: denyAll }).classification,
    ).toBe('system');
  });
});
