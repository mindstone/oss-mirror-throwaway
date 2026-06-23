import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDirectoryEntry, WorkspaceFileSystem, WorkspacePathStat } from '@core/workspaceFileSystem';
import { removeOperator } from '../operatorRemovalService';

class RealWorkspaceFileSystem implements WorkspaceFileSystem {
  private resolve(root: string, target: string): string {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, target);
    if (!resolved.startsWith(resolvedRoot)) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
  }

  async listDirectory(root: string, target: string): Promise<WorkspaceDirectoryEntry[]> {
    const entries = await fs.readdir(this.resolve(root, target), { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async realPath(root: string, target: string): Promise<string> {
    return fs.realpath(this.resolve(root, target));
  }

  async stat(root: string, target: string): Promise<WorkspacePathStat> {
    const stat = await fs.stat(this.resolve(root, target));
    return {
      isDirectory: stat.isDirectory(),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    };
  }

  async readFile(root: string, target: string): Promise<string> {
    return fs.readFile(this.resolve(root, target), 'utf8');
  }

  async writeFile(root: string, target: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.resolve(root, target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content);
  }

  async appendFile(root: string, target: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.resolve(root, target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.appendFile(resolved, content);
  }

  async renameFile(root: string, sourcePath: string, targetPath: string): Promise<void> {
    const source = this.resolve(root, sourcePath);
    const target = this.resolve(root, targetPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
  }

  async deleteFile(root: string, target: string): Promise<void> {
    await fs.rm(this.resolve(root, target), { force: true });
  }

  async exists(root: string, target: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(root, target));
      return true;
    } catch {
      return false;
    }
  }
}

describe('operatorRemovalService', () => {
  let tempRoot: string;
  let targetSpacePath: string;
  let workspaceFileSystem: RealWorkspaceFileSystem;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-removal-service-'));
    targetSpacePath = path.join(tempRoot, 'Chief-of-Staff');
    workspaceFileSystem = new RealWorkspaceFileSystem();

    await fs.mkdir(path.join(targetSpacePath, 'operators', 'brand-critic'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('deletes OPERATOR.md and the empty directory while preserving diary history', async () => {
    const operatorDir = path.join(targetSpacePath, 'operators', 'brand-critic');
    await fs.writeFile(path.join(operatorDir, 'diary.md'), 'entry');
    await fs.writeFile(path.join(operatorDir, 'OPERATOR.md'), 'operator');

    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await removeOperator(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger,
      },
    );

    expect(result).toEqual({ success: true });
    await expect(fs.readFile(path.join(operatorDir, 'diary.md'), 'utf8')).resolves.toBe('entry');
    await expect(fs.access(path.join(operatorDir, 'OPERATOR.md'))).rejects.toThrow();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorSlug: 'brand-critic',
        targetSpacePath: path.resolve(targetSpacePath),
      }),
      'operators:remove_succeeded',
    );
  });

  it('removes the Operator directory after file deletion when no other files remain', async () => {
    const operatorDir = path.join(targetSpacePath, 'operators', 'brand-critic');
    await fs.writeFile(path.join(operatorDir, 'OPERATOR.md'), 'operator');

    const result = await removeOperator(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: true });
    await expect(fs.access(operatorDir)).rejects.toThrow();
  });

  it('returns space_not_found for missing target spaces', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await removeOperator(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath: path.join(tempRoot, 'Missing-Space'),
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger,
      },
    );

    expect(result).toEqual({ success: false, errorCode: 'space_not_found' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorSlug: 'brand-critic',
        failedStep: 'preflight-space-check',
      }),
      'operators:remove_failed',
    );
  });

  it('returns operator_not_found when the OPERATOR.md is missing', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await removeOperator(
      {
        operatorSlug: 'missing-operator',
        targetSpacePath,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger,
      },
    );

    expect(result).toEqual({ success: false, errorCode: 'operator_not_found' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorSlug: 'missing-operator',
        failedStep: 'preflight-operator-check',
      }),
      'operators:remove_failed',
    );
  });
});
