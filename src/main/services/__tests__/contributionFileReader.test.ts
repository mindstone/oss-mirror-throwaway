/**
 * Tests for contributionFileReader.ts
 *
 * Exercises the extracted pure-function variant of the file-tree walker
 * previously inline in `contributionHandlers.ts`. Covers:
 *   - Happy path (valid dir under $HOME returns the expected file list)
 *   - Tilde expansion (`~/...` resolves to the mocked home dir)
 *   - Path-traversal rejection (paths outside $HOME throw OUTSIDE_HOME)
 *   - Missing path (NOT_FOUND)
 *   - Not-a-directory (NOT_A_DIRECTORY)
 *   - Empty directory (NO_FILES_FOUND)
 *   - Ignore patterns (node_modules / .git / dist are skipped)
 *   - Size cap (files > 1 MB are silently skipped)
 *   - Symlink safety (root escape + child symlink rejection)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Mock os.homedir so we can sandbox tests to a temp dir ─────────

let mockHomeDir = '';

 
vi.mock('node:os', async () => {
  const actual = (await vi.importActual('node:os')) as typeof import('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => mockHomeDir,
    },
    homedir: () => mockHomeDir,
  };
});

// Import after mocks
import {
  readConnectorFilesForSubmission,
  ContributionFileReadError,
} from '../contributionFileReader';

// ─── Fixtures ───────────────────────────────────────────────────────

const CONNECTOR_NAME = 'my-connector';

function mkTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'contribution-file-reader-'));
}

function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function canCreateSymlinks(): boolean {
  const probeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'contribution-file-reader-symlink-probe-'),
  );
  const targetDir = path.join(probeRoot, 'target');
  const linkDir = path.join(probeRoot, 'link');
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    fs.symlinkSync(targetDir, linkDir, 'dir');
    fs.unlinkSync(linkDir);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

const symlinkAwareIt =
  process.platform === 'win32' && !canCreateSymlinks() ? it.skip : it;

// ─── Tests ──────────────────────────────────────────────────────────

describe('readConnectorFilesForSubmission', () => {
  let homeDir: string;
  let connectorDir: string;

  beforeEach(() => {
    homeDir = mkTempHome();
    mockHomeDir = homeDir;
    connectorDir = path.join(homeDir, 'mcp-servers', CONNECTOR_NAME);
    fs.mkdirSync(connectorDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('returns the full file tree under connectors/<connectorName>/ (happy path)', async () => {
    writeFiles(connectorDir, {
      'package.json': '{"name":"my-connector"}',
      'src/index.ts': 'export const x = 1;',
      'README.md': '# my-connector',
    });

    const result = await readConnectorFilesForSubmission(connectorDir, CONNECTOR_NAME);

    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'connectors/my-connector/README.md',
      'connectors/my-connector/package.json',
      'connectors/my-connector/src/index.ts',
    ]);

    const pkg = result.files.find((f) => f.path.endsWith('package.json'));
    expect(pkg?.content).toBe('{"name":"my-connector"}');
    expect(result.skippedDenylisted).toEqual([]);
  });

  it('expands leading ~/ to the (mocked) home directory', async () => {
    writeFiles(connectorDir, {
      'src/index.ts': 'x',
    });

    // `mcp-servers/<connector>` is the canonical agent location.
    const relativeToHome = '~/mcp-servers/' + CONNECTOR_NAME;
    const result = await readConnectorFilesForSubmission(relativeToHome, CONNECTOR_NAME);

    expect(result.files.map((f) => f.path)).toEqual([
      'connectors/my-connector/src/index.ts',
    ]);
    expect(result.skippedDenylisted).toEqual([]);
  });

  it('rejects a path that resolves outside the home directory', async () => {
    // /tmp is outside our mocked $HOME (homeDir is under os.tmpdir()).
    // Use a completely different root.
    await expect(
      readConnectorFilesForSubmission('/some/other/path', CONNECTOR_NAME),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ContributionFileReadError && error.code === 'OUTSIDE_HOME'
      );
    });
  });

  it('rejects a missing directory with NOT_FOUND', async () => {
    const missing = path.join(homeDir, 'does-not-exist');
    await expect(
      readConnectorFilesForSubmission(missing, CONNECTOR_NAME),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ContributionFileReadError && error.code === 'NOT_FOUND'
      );
    });
  });

  it('rejects a file-instead-of-dir path with NOT_A_DIRECTORY', async () => {
    const filePath = path.join(homeDir, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'hello');
    await expect(
      readConnectorFilesForSubmission(filePath, CONNECTOR_NAME),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ContributionFileReadError &&
        error.code === 'NOT_A_DIRECTORY'
      );
    });
  });

  it('rejects an empty directory with NO_FILES_FOUND', async () => {
    const emptyDir = path.join(homeDir, 'empty-connector');
    fs.mkdirSync(emptyDir);
    await expect(
      readConnectorFilesForSubmission(emptyDir, CONNECTOR_NAME),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ContributionFileReadError &&
        error.code === 'NO_FILES_FOUND'
      );
    });
  });

  it('skips node_modules, .git, .DS_Store, and dist directories', async () => {
    writeFiles(connectorDir, {
      'src/index.ts': 'x',
      'node_modules/some-pkg/index.js': 'junk',
      '.git/HEAD': 'ref: refs/heads/main',
      'dist/bundle.js': 'built',
      '.DS_Store/ignore': 'mac',
    });

    const result = await readConnectorFilesForSubmission(connectorDir, CONNECTOR_NAME);

    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual(['connectors/my-connector/src/index.ts']);
    expect(result.skippedDenylisted).toEqual([]);
  });

  it('skips backend-denylisted files (.env*, .pem, etc.) and reports them', async () => {
    // 260423 regression: the relay backend denylists `.env*` files, so the
    // desktop reader must pre-filter them and surface the list to the caller
    // (see docs-private/investigations/260423_contribution_relay_400_validation.md).
    writeFiles(connectorDir, {
      'src/index.ts': 'export const x = 1;',
      'package.json': '{"name":"my-connector"}',
      '.env': 'SECRET=value',
      '.env.example': 'API_KEY=replace-me',
      'certs/server.key': 'BEGIN KEY',
      'certs/cert.pem': 'BEGIN CERT',
    });

    const result = await readConnectorFilesForSubmission(connectorDir, CONNECTOR_NAME);

    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'connectors/my-connector/package.json',
      'connectors/my-connector/src/index.ts',
    ]);
    expect(result.skippedDenylisted.sort()).toEqual(
      ['.env', '.env.example', 'cert.pem', 'server.key'].sort(),
    );
  });

  it('skips files over the per-file size cap (1 MB) without failing the submission', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 'a');
    writeFiles(connectorDir, {
      'src/index.ts': 'x',
      'assets/huge.bin': big,
    });

    const result = await readConnectorFilesForSubmission(connectorDir, CONNECTOR_NAME);

    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('connectors/my-connector/src/index.ts');
    expect(paths).not.toContain('connectors/my-connector/assets/huge.bin');
    expect(result.skippedDenylisted).toEqual([]);
  });

  symlinkAwareIt('rejects root that is a symlink to outside $HOME', async () => {
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'contribution-file-reader-outside-'),
    );
    try {
      writeFiles(outsideRoot, {
        'src/index.ts': 'x',
      });
      const symlinkPath = path.join(homeDir, 'outside-link');
      fs.symlinkSync(outsideRoot, symlinkPath, 'dir');

      await expect(
        readConnectorFilesForSubmission(symlinkPath, CONNECTOR_NAME),
      ).rejects.toSatisfy((error: unknown) => {
        return (
          error instanceof ContributionFileReadError &&
          error.code === 'OUTSIDE_HOME'
        );
      });
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  symlinkAwareIt('accepts a root symlink when its canonical target stays within $HOME', async () => {
    const inHomeTargetDir = path.join(homeDir, 'real-connector');
    fs.mkdirSync(inHomeTargetDir, { recursive: true });
    writeFiles(inHomeTargetDir, {
      'src/index.ts': 'export const accepted = true;',
    });
    const symlinkPath = path.join(homeDir, 'connector-link');
    fs.symlinkSync(inHomeTargetDir, symlinkPath, 'dir');

    // Security property is 'canonical path within $HOME', not 'path is not a symlink'.
    // In-home symlinks are allowed; only symlinks that escape $HOME are rejected.
    const result = await readConnectorFilesForSubmission(symlinkPath, CONNECTOR_NAME);

    expect(result.files).toEqual([
      {
        path: 'connectors/my-connector/src/index.ts',
        content: 'export const accepted = true;',
      },
    ]);
    expect(result.skippedDenylisted).toEqual([]);
  });

  symlinkAwareIt('rejects child symlink (file)', async () => {
    const targetFile = path.join(homeDir, 'external-target.ts');
    fs.writeFileSync(targetFile, 'export const x = 1;');
    writeFiles(connectorDir, {
      'src/index.ts': 'x',
    });
    const linkedFile = path.join(connectorDir, 'src', 'linked.ts');
    fs.symlinkSync(targetFile, linkedFile, 'file');

    await expect(
      readConnectorFilesForSubmission(connectorDir, CONNECTOR_NAME),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ContributionFileReadError &&
        error.code === 'SYMLINK_REJECTED'
      );
    });
  });

  symlinkAwareIt('rejects child symlink (dir)', async () => {
    const targetDir = path.join(homeDir, 'external-dir');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'outside.ts'), 'x');
    writeFiles(connectorDir, {
      'src/index.ts': 'x',
    });
    const linkedDir = path.join(connectorDir, 'linked-dir');
    fs.symlinkSync(targetDir, linkedDir, 'dir');

    await expect(
      readConnectorFilesForSubmission(connectorDir, CONNECTOR_NAME),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ContributionFileReadError &&
        error.code === 'SYMLINK_REJECTED'
      );
    });
  });
});
