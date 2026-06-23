import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDirectoryEntry, WorkspaceFileSystem, WorkspacePathStat } from '@core/workspaceFileSystem';
import { parseOperatorFrontmatterFromContent } from '@shared/schemas/operatorFrontmatter';
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

describe('operatorDisplayNameService', () => {
  let tempRoot: string;
  let targetSpacePath: string;
  let workspaceFileSystem: RealWorkspaceFileSystem;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-display-name-service-'));
    targetSpacePath = path.join(tempRoot, 'Chief-of-Staff');
    workspaceFileSystem = new RealWorkspaceFileSystem();

    await fs.mkdir(path.join(targetSpacePath, 'operators', 'brand-critic'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('updates display_name while preserving other frontmatter fields', async () => {
    const operatorPath = path.join(targetSpacePath, 'operators', 'brand-critic', 'OPERATOR.md');
    const originalContent = [
      '---',
      'name: Brand Critic',
      'description: Keeps the message honest.',
      'consult_when: When claims need pressure-testing.',
      'kind: operator',
      'roles: [operator]',
      'use_cases:',
      '  - Launch claims',
      'consultation_prompt: |',
      '  Keep answers concise.',
      '---',
      'Body text',
      '',
    ].join('\n');
    await fs.writeFile(operatorPath, originalContent, 'utf8');

    const result = await setOperatorDisplayName(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        displayName: 'Brand Critic — Enterprise',
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn() },
      },
    );

    expect(result).toEqual({ success: true });
    const updatedContent = await fs.readFile(operatorPath, 'utf8');
    const parsed = parseOperatorFrontmatterFromContent(updatedContent);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.frontmatter.name).toBe('Brand Critic');
    expect(parsed.frontmatter.description).toBe('Keeps the message honest.');
    expect(parsed.frontmatter.consult_when).toBe('When claims need pressure-testing.');
    expect(parsed.frontmatter.roles).toEqual(['operator']);
    expect(parsed.frontmatter.use_cases).toEqual(['Launch claims']);
    expect(parsed.frontmatter.consultation_prompt).toBe('Keep answers concise.');
    expect(parsed.frontmatter.display_name).toBe('Brand Critic — Enterprise');
  });

  it('removes display_name when input is null or empty', async () => {
    const operatorPath = path.join(targetSpacePath, 'operators', 'brand-critic', 'OPERATOR.md');
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        'display_name: Existing Label',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    const nullResult = await setOperatorDisplayName(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        displayName: null,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn() },
      },
    );
    expect(nullResult).toEqual({ success: true });

    const emptyResult = await setOperatorDisplayName(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        displayName: '   ',
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn() },
      },
    );
    expect(emptyResult).toEqual({ success: true });

    const updatedContent = await fs.readFile(operatorPath, 'utf8');
    const parsed = parseOperatorFrontmatterFromContent(updatedContent);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.frontmatter.display_name).toBeUndefined();
  });

  it('serialises arrays as YAML (block style), never as JSON.stringify output', async () => {
    const operatorPath = path.join(targetSpacePath, 'operators', 'brand-critic', 'OPERATOR.md');
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles:',
        '  - operator',
        'use_cases:',
        '  - Launch claims',
        '  - Pricing pages',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    await setOperatorDisplayName(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        displayName: 'Brand Critic — Enterprise',
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn() },
      },
    );

    const updated = await fs.readFile(operatorPath, 'utf8');
    expect(updated).not.toMatch(/use_cases\s*:\s*\[/u);
    expect(updated).not.toContain('"operator"');
    expect(updated).toMatch(/roles:\s*\n\s+- operator/u);
    expect(updated).toContain('use_cases:\n  - Launch claims');
  });

  it('enforces the 120-character display-name limit', async () => {
    const operatorPath = path.join(targetSpacePath, 'operators', 'brand-critic', 'OPERATOR.md');
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await setOperatorDisplayName(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        displayName: 'x'.repeat(121),
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn() },
      },
    );

    expect(result).toEqual({ success: false, errorCode: 'display_name_too_long' });
  });
});
