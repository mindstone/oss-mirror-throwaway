import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDirectoryEntry, WorkspaceFileSystem, WorkspacePathStat } from '@core/workspaceFileSystem';
import { parseOperatorFrontmatterFromContent } from '@shared/schemas/operatorFrontmatter';
import { setLiveMeetingEnabled } from '../operatorRoleToggleService';
import { _resetOperatorFileMutationLockForTests } from '../operatorFileMutationLock';

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

describe('operatorRoleToggleService', () => {
  let tempRoot: string;
  let targetSpacePath: string;
  let workspaceFileSystem: RealWorkspaceFileSystem;
  let operatorPath: string;

  beforeEach(async () => {
    _resetOperatorFileMutationLockForTests();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-role-toggle-service-'));
    targetSpacePath = path.join(tempRoot, 'Chief-of-Staff');
    workspaceFileSystem = new RealWorkspaceFileSystem();

    await fs.mkdir(path.join(targetSpacePath, 'operators', 'brand-critic'), { recursive: true });
    operatorPath = path.join(targetSpacePath, 'operators', 'brand-critic', 'OPERATOR.md');
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('enables live_meeting when live_prompt is present and roles is single-role operator', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        'live_prompt: Coach the speaker on clarity.',
        'consultation_prompt: |',
        '  Keep answers concise.',
        'display_name: Brand Critic — Enterprise',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );
    const invalidate = vi.fn();

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: invalidate,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: true });
    expect(invalidate).toHaveBeenCalledTimes(1);

    const updated = await fs.readFile(operatorPath, 'utf8');
    const parsed = parseOperatorFrontmatterFromContent(updated);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.frontmatter.roles).toEqual(['operator', 'live_meeting']);
    expect(parsed.frontmatter.name).toBe('Brand Critic');
    expect(parsed.frontmatter.description).toBe('Keeps the message honest.');
    expect(parsed.frontmatter.consult_when).toBe('When claims need pressure-testing.');
    expect(parsed.frontmatter.live_prompt).toBe('Coach the speaker on clarity.');
    expect(parsed.frontmatter.consultation_prompt).toBe('Keep answers concise.');
    expect(parsed.frontmatter.display_name).toBe('Brand Critic — Enterprise');
    expect(parsed.body.trim()).toBe('Body text');
  });

  it('blocks enable when live_prompt is missing', async () => {
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
    const invalidate = vi.fn();
    const originalContent = await fs.readFile(operatorPath, 'utf8');

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: invalidate,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: false, errorCode: 'live_prompt_missing' });
    expect(invalidate).not.toHaveBeenCalled();
    await expect(fs.readFile(operatorPath, 'utf8')).resolves.toBe(originalContent);
  });

  it('blocks enable when live_prompt is whitespace-only', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        'live_prompt: "   "',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: false, errorCode: 'live_prompt_missing' });
  });

  it('is idempotent when enabling and live_meeting is already present', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator, live_meeting]',
        'live_prompt: Coach the speaker.',
        '---',
        'Body',
        '',
      ].join('\n'),
      'utf8',
    );
    const invalidate = vi.fn();
    const originalContent = await fs.readFile(operatorPath, 'utf8');

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: invalidate,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: true });
    expect(invalidate).not.toHaveBeenCalled();
    await expect(fs.readFile(operatorPath, 'utf8')).resolves.toBe(originalContent);
  });

  it('blocks disable when live_meeting is the only role', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'kind: operator',
        'roles: [live_meeting]',
        'live_prompt: Coach the speaker.',
        '---',
        'Body',
        '',
      ].join('\n'),
      'utf8',
    );
    const invalidate = vi.fn();
    const originalContent = await fs.readFile(operatorPath, 'utf8');

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: false,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: invalidate,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: false, errorCode: 'roles_would_be_empty' });
    expect(invalidate).not.toHaveBeenCalled();
    await expect(fs.readFile(operatorPath, 'utf8')).resolves.toBe(originalContent);
  });

  it('disables live_meeting on a dual-role Operator and preserves the operator role', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator, live_meeting]',
        'live_prompt: Coach the speaker.',
        'consultation_prompt: |',
        '  Keep answers concise.',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );
    const invalidate = vi.fn();

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: false,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: invalidate,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: true });
    expect(invalidate).toHaveBeenCalledTimes(1);

    const updated = await fs.readFile(operatorPath, 'utf8');
    const parsed = parseOperatorFrontmatterFromContent(updated);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.frontmatter.roles).toEqual(['operator']);
    expect(parsed.frontmatter.consult_when).toBe('When claims need pressure-testing.');
    expect(parsed.frontmatter.live_prompt).toBe('Coach the speaker.');
    expect(parsed.frontmatter.consultation_prompt).toBe('Keep answers concise.');
    expect(parsed.body.trim()).toBe('Body text');
  });

  it('is idempotent when disabling and live_meeting is not present', async () => {
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
    const invalidate = vi.fn();
    const originalContent = await fs.readFile(operatorPath, 'utf8');

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: false,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: invalidate,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: true });
    expect(invalidate).not.toHaveBeenCalled();
    await expect(fs.readFile(operatorPath, 'utf8')).resolves.toBe(originalContent);
  });

  it('returns operator_not_found when OPERATOR.md is missing', async () => {
    const invalidate = vi.fn();

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'missing-operator',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: invalidate,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: false, errorCode: 'operator_not_found' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('returns write_failed when the underlying writeFile throws', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        'live_prompt: Coach the speaker.',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    const failingFileSystem: WorkspaceFileSystem = {
      ...workspaceFileSystem,
      writeFile: vi.fn(async () => {
        throw new Error('disk full');
      }),
      exists: workspaceFileSystem.exists.bind(workspaceFileSystem),
      readFile: workspaceFileSystem.readFile.bind(workspaceFileSystem),
      listDirectory: workspaceFileSystem.listDirectory.bind(workspaceFileSystem),
      realPath: workspaceFileSystem.realPath.bind(workspaceFileSystem),
      stat: workspaceFileSystem.stat.bind(workspaceFileSystem),
      deleteFile: workspaceFileSystem.deleteFile.bind(workspaceFileSystem),
    };
    const invalidate = vi.fn();

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem: failingFileSystem,
        invalidateOperatorRegistry: invalidate,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: false, errorCode: 'write_failed' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('preserves arbitrary frontmatter fields not touched by the toggle', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        'live_prompt: Coach the speaker.',
        'use_cases:',
        '  - Launch claims',
        '  - Pricing pages',
        'proactive_interval_minutes: 3',
        'display_name: Brand Critic — Enterprise',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: true });
    const updated = await fs.readFile(operatorPath, 'utf8');
    const parsed = parseOperatorFrontmatterFromContent(updated);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.frontmatter.use_cases).toEqual(['Launch claims', 'Pricing pages']);
    expect(parsed.frontmatter.proactive_interval_minutes).toBe(3);
    expect(parsed.frontmatter.display_name).toBe('Brand Critic — Enterprise');
    expect(parsed.frontmatter.roles).toEqual(['operator', 'live_meeting']);
  });

  it('treats a missing roles field as the schema default [operator] when toggling on', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'live_prompt: Coach the speaker.',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: true });
    const updated = await fs.readFile(operatorPath, 'utf8');
    const parsed = parseOperatorFrontmatterFromContent(updated);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.frontmatter.roles).toEqual(['operator', 'live_meeting']);
  });

  it('preserves block-style YAML arrays through a round-trip toggle (no inline JSON output)', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        'live_prompt: Coach the speaker.',
        'use_cases:',
        '  - Launch claims',
        '  - Pricing pages',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: true });
    const updated = await fs.readFile(operatorPath, 'utf8');
    expect(updated).not.toMatch(/use_cases\s*:\s*\[/u);
    expect(updated).toContain('use_cases:\n  - Launch claims');
    expect(updated).toContain('  - Pricing pages');
  });

  it('serialises arrays as YAML, never as JSON.stringify output', async () => {
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
        'live_prompt: Coach the speaker.',
        'use_cases:',
        '  - Launch claims',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    const updated = await fs.readFile(operatorPath, 'utf8');
    expect(updated).not.toContain('roles: ["operator"');
    expect(updated).not.toContain('"live_meeting"');
    expect(updated).toMatch(/roles:\s*\n\s+- operator\s*\n\s+- live_meeting/u);
  });

  it('serialises concurrent toggle calls safely (no lost data)', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        'live_prompt: Coach the speaker.',
        '---',
        'Body text',
        '',
      ].join('\n'),
      'utf8',
    );

    const invalidate = vi.fn();
    const sharedLogger = { info: vi.fn(), warn: vi.fn() };

    const [first, second] = await Promise.all([
      setLiveMeetingEnabled(
        { operatorSlug: 'brand-critic', targetSpacePath, enabled: true },
        { workspaceFileSystem, invalidateOperatorRegistry: invalidate, logger: sharedLogger },
      ),
      setLiveMeetingEnabled(
        { operatorSlug: 'brand-critic', targetSpacePath, enabled: false },
        { workspaceFileSystem, invalidateOperatorRegistry: invalidate, logger: sharedLogger },
      ),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(2);

    const finalContent = await fs.readFile(operatorPath, 'utf8');
    const parsed = parseOperatorFrontmatterFromContent(finalContent);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.frontmatter.roles).toEqual(['operator']);
  });

  it('refuses to mutate a bundled operator file', async () => {
    const bundledSpace = path.join(tempRoot, 'rebel-system');
    await fs.mkdir(path.join(bundledSpace, 'operators', 'brand-critic'), { recursive: true });
    const bundledOperatorPath = path.join(bundledSpace, 'operators', 'brand-critic', 'OPERATOR.md');
    await fs.writeFile(
      bundledOperatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Bundled.',
        'consult_when: Bundled.',
        'kind: operator',
        'roles: [operator]',
        'live_prompt: Coach.',
        '---',
        'Body',
        '',
      ].join('\n'),
      'utf8',
    );
    const original = await fs.readFile(bundledOperatorPath, 'utf8');

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath: bundledSpace,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(result).toEqual({ success: false, errorCode: 'operator_not_found' });
    await expect(fs.readFile(bundledOperatorPath, 'utf8')).resolves.toBe(original);
  });

  it('returns success when the registry invalidation callback throws', async () => {
    await fs.writeFile(
      operatorPath,
      [
        '---',
        'name: Brand Critic',
        'description: Keeps the message honest.',
        'consult_when: When claims need pressure-testing.',
        'kind: operator',
        'roles: [operator]',
        'live_prompt: Coach the speaker.',
        '---',
        'Body',
        '',
      ].join('\n'),
      'utf8',
    );
    const invalidate = vi.fn(() => { throw new Error('cache offline'); });
    const warn = vi.fn();

    const result = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: invalidate,
        logger: { info: vi.fn(), warn },
      },
    );

    expect(result).toEqual({ success: true });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'cache offline' }),
      'operators:role_toggle_invalidate_failed',
    );
  });
});
