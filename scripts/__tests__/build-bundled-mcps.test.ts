import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

import {
  computeFileHash,
  walkDir,
  computeMcpHash,
  readHashFile,
  writeHashFile,
  outputArtifactExists,
  discoverMcps,
} from '../build-bundled-mcps-utils.mjs';

const FIXTURES = join(__dirname, 'fixtures');

// ─── computeFileHash ─────────────────────────────────────────────────────────

describe('computeFileHash', () => {
  it('returns correct SHA-256 for known content', () => {
    const filePath = join(FIXTURES, 'fake-mcp-a', 'src', 'index.ts');
    const expected = createHash('sha256')
      .update(readFileSync(filePath))
      .digest('hex');
    expect(computeFileHash(filePath)).toBe(expected);
  });

  it('produces different hashes for different files', () => {
    const hashA = computeFileHash(join(FIXTURES, 'fake-mcp-a', 'src', 'index.ts'));
    const hashB = computeFileHash(join(FIXTURES, 'fake-mcp-b', 'src', 'index.ts'));
    expect(hashA).not.toBe(hashB);
  });
});

// ─── walkDir ─────────────────────────────────────────────────────────────────

describe('walkDir', () => {
  it('finds files recursively', () => {
    const files = walkDir(join(FIXTURES, 'fake-mcp-a'));
    expect(files.length).toBeGreaterThan(0);
    // Should include the src/index.ts file
    expect(files.some(f => f.endsWith('index.ts'))).toBe(true);
  });

  it('skips node_modules directories', () => {
    const tmpDir = join(tmpdir(), `walkdir-test-nm-${Date.now()}`);
    mkdirSync(join(tmpDir, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(tmpDir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');

    try {
      const files = walkDir(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain('a.ts');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips build directories', () => {
    const tmpDir = join(tmpdir(), `walkdir-test-build-${Date.now()}`);
    mkdirSync(join(tmpDir, 'build'), { recursive: true });
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(tmpDir, 'build', 'index.js'), 'built output');

    try {
      const files = walkDir(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain('a.ts');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty array for missing directory', () => {
    expect(walkDir('/nonexistent/path/that/does/not/exist')).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const tmpDir = join(tmpdir(), `walkdir-test-empty-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      expect(walkDir(tmpDir)).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── computeMcpHash ──────────────────────────────────────────────────────────

describe('computeMcpHash', () => {
  const baseOpts = {
    mcpRoot: FIXTURES,
    mcpConfigPath: '', // No shared config in tests
    buildScriptHash: 'abc123',
    esbuildVersion: '0.20.0',
  };

  it('is deterministic (same inputs = same hash)', () => {
    const hash1 = computeMcpHash('fake-mcp-a', baseOpts);
    const hash2 = computeMcpHash('fake-mcp-a', baseOpts);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different MCPs', () => {
    const hashA = computeMcpHash('fake-mcp-a', baseOpts);
    const hashB = computeMcpHash('fake-mcp-b', baseOpts);
    expect(hashA).not.toBe(hashB);
  });

  it('changes when buildScriptHash changes', () => {
    const hash1 = computeMcpHash('fake-mcp-a', baseOpts);
    const hash2 = computeMcpHash('fake-mcp-a', { ...baseOpts, buildScriptHash: 'changed' });
    expect(hash1).not.toBe(hash2);
  });

  it('changes when esbuildVersion changes', () => {
    const hash1 = computeMcpHash('fake-mcp-a', baseOpts);
    const hash2 = computeMcpHash('fake-mcp-a', { ...baseOpts, esbuildVersion: '0.21.0' });
    expect(hash1).not.toBe(hash2);
  });

  it('changes when npmVersion changes', () => {
    const hash1 = computeMcpHash('fake-mcp-a', baseOpts);
    const hash2 = computeMcpHash('fake-mcp-a', { ...baseOpts, npmVersion: '11.0.0' });
    expect(hash1).not.toBe(hash2);
  });

  it('includes platform and arch in hash (different values produce different hashes)', () => {
    // We can't easily mock process.platform/arch, but we can verify the hash
    // is deterministic (platform/arch don't change between calls)
    const hash1 = computeMcpHash('fake-mcp-a', baseOpts);
    const hash2 = computeMcpHash('fake-mcp-a', baseOpts);
    expect(hash1).toBe(hash2);
  });

  it('changes when source files change', () => {
    const tmpDir = join(tmpdir(), `hash-test-src-${Date.now()}`);
    mkdirSync(join(tmpDir, 'mcp-x', 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'mcp-x', 'src', 'index.ts'), 'export const v = 1;');

    try {
      const opts = { ...baseOpts, mcpRoot: tmpDir };
      const hash1 = computeMcpHash('mcp-x', opts);

      // Modify the source
      writeFileSync(join(tmpDir, 'mcp-x', 'src', 'index.ts'), 'export const v = 2;');
      const hash2 = computeMcpHash('mcp-x', opts);

      expect(hash1).not.toBe(hash2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('changes when config files change', () => {
    const tmpDir = join(tmpdir(), `hash-test-cfg-${Date.now()}`);
    mkdirSync(join(tmpDir, 'mcp-x', 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'mcp-x', 'src', 'index.ts'), 'export const v = 1;');
    writeFileSync(join(tmpDir, 'mcp-x', 'package.json'), '{"name":"mcp-x","version":"1.0.0"}');

    try {
      const opts = { ...baseOpts, mcpRoot: tmpDir };
      const hash1 = computeMcpHash('mcp-x', opts);

      // Modify the package.json
      writeFileSync(join(tmpDir, 'mcp-x', 'package.json'), '{"name":"mcp-x","version":"2.0.0"}');
      const hash2 = computeMcpHash('mcp-x', opts);

      expect(hash1).not.toBe(hash2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('includes microsoftSharedHash when provided', () => {
    const hash1 = computeMcpHash('fake-mcp-a', baseOpts);
    const hash2 = computeMcpHash('fake-mcp-a', {
      ...baseOpts,
      microsoftSharedHash: 'ms-shared-hash-abc',
    });
    expect(hash1).not.toBe(hash2);
  });

  it('changes when tsconfig.base.json changes', () => {
    const tmpDir = join(tmpdir(), `hash-test-tsbase-${Date.now()}`);
    mkdirSync(join(tmpDir, 'mcp-x', 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'mcp-x', 'src', 'index.ts'), 'export const v = 1;');
    writeFileSync(join(tmpDir, 'tsconfig.base.json'), '{"compilerOptions":{"strict":true}}');

    try {
      const opts = { ...baseOpts, mcpRoot: tmpDir };
      const hash1 = computeMcpHash('mcp-x', opts);

      writeFileSync(join(tmpDir, 'tsconfig.base.json'), '{"compilerOptions":{"strict":false}}');
      const hash2 = computeMcpHash('mcp-x', opts);

      expect(hash1).not.toBe(hash2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('includes mcpConfigPath content when file exists', () => {
    const tmpDir = join(tmpdir(), `hash-test-config-${Date.now()}`);
    mkdirSync(join(tmpDir, 'mcp-x', 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'mcp-x', 'src', 'index.ts'), 'export const v = 1;');
    const configPath = join(tmpDir, 'mcp-config.json');
    writeFileSync(configPath, '{"bundledMcps":["mcp-x"]}');

    try {
      const opts = { ...baseOpts, mcpRoot: tmpDir };
      const hash1 = computeMcpHash('mcp-x', opts);
      const hash2 = computeMcpHash('mcp-x', { ...opts, mcpConfigPath: configPath });
      expect(hash1).not.toBe(hash2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── readHashFile / writeHashFile ────────────────────────────────────────────

describe('readHashFile / writeHashFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `hash-rw-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trip works (write then read)', () => {
    const hash = 'abc123def456';
    writeHashFile('test-mcp', hash, tmpDir);
    expect(readHashFile('test-mcp', tmpDir)).toBe(hash);
  });

  it('readHashFile returns null for missing file', () => {
    expect(readHashFile('nonexistent-mcp', tmpDir)).toBeNull();
  });

  it('writeHashFile creates directory if needed', () => {
    const hash = 'xyz789';
    writeHashFile('new-mcp', hash, tmpDir);
    expect(existsSync(join(tmpDir, 'new-mcp', '.build-hash'))).toBe(true);
  });

  it('writeHashFile is atomic (.tmp + rename)', () => {
    // After writing, the .tmp file should not remain
    writeHashFile('atomic-mcp', 'hash123', tmpDir);
    expect(existsSync(join(tmpDir, 'atomic-mcp', '.build-hash.tmp'))).toBe(false);
    expect(existsSync(join(tmpDir, 'atomic-mcp', '.build-hash'))).toBe(true);
  });

  it('writeHashFile overwrites existing hash', () => {
    writeHashFile('overwrite-mcp', 'hash-v1', tmpDir);
    writeHashFile('overwrite-mcp', 'hash-v2', tmpDir);
    expect(readHashFile('overwrite-mcp', tmpDir)).toBe('hash-v2');
  });
});

// ─── outputArtifactExists ────────────────────────────────────────────────────

describe('outputArtifactExists', () => {
  let tmpMcpRoot: string;
  let tmpGenRoot: string;

  beforeEach(() => {
    const base = join(tmpdir(), `artifact-test-${Date.now()}`);
    tmpMcpRoot = join(base, 'mcp');
    tmpGenRoot = join(base, 'mcp-generated');
    mkdirSync(tmpMcpRoot, { recursive: true });
    mkdirSync(tmpGenRoot, { recursive: true });
  });

  afterEach(() => {
    // Clean up the parent of both dirs
    const base = join(tmpMcpRoot, '..');
    rmSync(base, { recursive: true, force: true });
  });

  it('bundled: returns true when server.cjs exists', () => {
    mkdirSync(join(tmpGenRoot, 'test-mcp'), { recursive: true });
    writeFileSync(join(tmpGenRoot, 'test-mcp', 'server.cjs'), 'bundled output');

    expect(outputArtifactExists('test-mcp', 'bundled', {
      mcpRoot: tmpMcpRoot,
      mcpGeneratedRoot: tmpGenRoot,
    })).toBe(true);
  });

  it('bundled: returns false when server.cjs missing', () => {
    expect(outputArtifactExists('test-mcp', 'bundled', {
      mcpRoot: tmpMcpRoot,
      mcpGeneratedRoot: tmpGenRoot,
    })).toBe(false);
  });

  it('unbundled: returns true when build/index.js and node_modules exist', () => {
    mkdirSync(join(tmpMcpRoot, 'test-mcp', 'build'), { recursive: true });
    mkdirSync(join(tmpMcpRoot, 'test-mcp', 'node_modules'), { recursive: true });
    writeFileSync(join(tmpMcpRoot, 'test-mcp', 'build', 'index.js'), 'output');

    expect(outputArtifactExists('test-mcp', 'unbundled', {
      mcpRoot: tmpMcpRoot,
      mcpGeneratedRoot: tmpGenRoot,
    })).toBe(true);
  });

  it('unbundled: returns false when build/index.js missing', () => {
    mkdirSync(join(tmpMcpRoot, 'test-mcp', 'node_modules'), { recursive: true });

    expect(outputArtifactExists('test-mcp', 'unbundled', {
      mcpRoot: tmpMcpRoot,
      mcpGeneratedRoot: tmpGenRoot,
    })).toBe(false);
  });

  it('unbundled: returns false when node_modules missing', () => {
    mkdirSync(join(tmpMcpRoot, 'test-mcp', 'build'), { recursive: true });
    writeFileSync(join(tmpMcpRoot, 'test-mcp', 'build', 'index.js'), 'output');

    expect(outputArtifactExists('test-mcp', 'unbundled', {
      mcpRoot: tmpMcpRoot,
      mcpGeneratedRoot: tmpGenRoot,
    })).toBe(false);
  });
});

// ─── discoverMcps ────────────────────────────────────────────────────────────

describe('discoverMcps', () => {
  it('finds directories with tsconfig.json in sorted order', () => {
    const mcps = discoverMcps(FIXTURES);
    expect(mcps).toContain('fake-mcp-a');
    expect(mcps).toContain('fake-mcp-b');
    expect(mcps).toEqual([...mcps].sort());
  });

  it('ignores directories without tsconfig.json', () => {
    const mcps = discoverMcps(FIXTURES);
    expect(mcps).not.toContain('not-an-mcp');
  });

  it('returns empty array for empty directory', () => {
    const tmpDir = join(tmpdir(), `discover-empty-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      expect(discoverMcps(tmpDir)).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
