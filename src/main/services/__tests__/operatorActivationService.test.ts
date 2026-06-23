import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFileSystem, WorkspaceDirectoryEntry, WorkspacePathStat } from '@core/workspaceFileSystem';
import { activateOperator } from '../operatorActivationService';
import { setOperatorDisplayName } from '../operatorDisplayNameService';

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

describe('operatorActivationService', () => {
  let tempRoot: string;
  let sourceSpacePath: string;
  let targetSpacePath: string;
  let secondaryTargetSpacePath: string;
  let workspaceFileSystem: RealWorkspaceFileSystem;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-activation-service-'));
    sourceSpacePath = path.join(tempRoot, 'rebel-system');
    targetSpacePath = path.join(tempRoot, 'Chief-of-Staff');
    secondaryTargetSpacePath = path.join(tempRoot, 'Launch');
    workspaceFileSystem = new RealWorkspaceFileSystem();

    await fs.mkdir(path.join(sourceSpacePath, 'operators', 'brand-critic'), { recursive: true });
    await fs.mkdir(targetSpacePath, { recursive: true });
    await fs.mkdir(secondaryTargetSpacePath, { recursive: true });
    await fs.writeFile(
      path.join(sourceSpacePath, 'operators', 'brand-critic', 'OPERATOR.md'),
      '---\nname: Brand Critic\nkind: operator\nroles: [operator]\nconsult_when: stress test\n---\nBody\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('returns already_activated with existingOperatorPath when activating the same slug in the same Space', async () => {
    const existingOperatorPath = path.join(targetSpacePath, 'operators', 'brand-critic', 'OPERATOR.md');
    await fs.mkdir(path.dirname(existingOperatorPath), { recursive: true });
    await fs.writeFile(existingOperatorPath, 'existing', 'utf8');

    const result = await activateOperator({
      operatorSlug: 'brand-critic',
      sourceSpacePath,
      targetSpacePath,
    }, {
      workspaceFileSystem,
      invalidateOperatorRegistry: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({
      success: false,
      errorCode: 'already_activated',
      existingOperatorPath,
    });
  });

  it('allows activating the same slug into different Spaces', async () => {
    const firstResult = await activateOperator({
      operatorSlug: 'brand-critic',
      sourceSpacePath,
      targetSpacePath,
    }, {
      workspaceFileSystem,
      invalidateOperatorRegistry: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(firstResult).toEqual({
      success: true,
      activatedPath: path.join(targetSpacePath, 'operators', 'brand-critic'),
    });

    const secondResult = await activateOperator({
      operatorSlug: 'brand-critic',
      sourceSpacePath,
      targetSpacePath: secondaryTargetSpacePath,
    }, {
      workspaceFileSystem,
      invalidateOperatorRegistry: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(secondResult).toEqual({
      success: true,
      activatedPath: path.join(secondaryTargetSpacePath, 'operators', 'brand-critic'),
    });
  });

  it('keeps slug identity source-derived even after display_name changes', async () => {
    const activationResult = await activateOperator({
      operatorSlug: 'brand-critic',
      sourceSpacePath,
      targetSpacePath,
    }, {
      workspaceFileSystem,
      invalidateOperatorRegistry: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(activationResult.success).toBe(true);

    const renameResult = await setOperatorDisplayName({
      operatorSlug: 'brand-critic',
      targetSpacePath,
      displayName: 'Brand Critic — Enterprise',
    }, {
      workspaceFileSystem,
      invalidateOperatorRegistry: vi.fn(),
      logger: { info: vi.fn() },
    });
    expect(renameResult).toEqual({ success: true });

    const reactivationResult = await activateOperator({
      operatorSlug: 'brand-critic',
      sourceSpacePath,
      targetSpacePath,
    }, {
      workspaceFileSystem,
      invalidateOperatorRegistry: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(reactivationResult).toEqual({
      success: false,
      errorCode: 'already_activated',
      existingOperatorPath: path.join(targetSpacePath, 'operators', 'brand-critic', 'OPERATOR.md'),
    });
  });

  it('returns source_not_found when source OPERATOR.md is missing', async () => {
    const result = await activateOperator({
      operatorSlug: 'does-not-exist',
      sourceSpacePath,
      targetSpacePath,
    }, {
      workspaceFileSystem,
      invalidateOperatorRegistry: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ success: false, errorCode: 'source_not_found' });
  });

  it('returns target_not_writable when the target Space is not a directory', async () => {
    const missingTarget = path.join(tempRoot, 'missing-space');
    const result = await activateOperator({
      operatorSlug: 'brand-critic',
      sourceSpacePath,
      targetSpacePath: missingTarget,
    }, {
      workspaceFileSystem,
      invalidateOperatorRegistry: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toEqual({ success: false, errorCode: 'target_not_writable' });
  });
});
