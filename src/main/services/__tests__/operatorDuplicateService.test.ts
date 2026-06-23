import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDirectoryEntry, WorkspaceFileSystem, WorkspacePathStat } from '@core/workspaceFileSystem';
import { parseOperatorFrontmatterFromContent } from '@shared/schemas/operatorFrontmatter';
import { duplicateOperator } from '../operatorDuplicateService';

class RealWorkspaceFileSystem implements WorkspaceFileSystem {
  private resolve(root: string, target: string): string {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, target);
    if (!resolved.startsWith(resolvedRoot)) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
  }

  async listDirectory(root: string, target = '.'): Promise<WorkspaceDirectoryEntry[]> {
    const resolved = this.resolve(root, target);
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    } catch {
      return [];
    }
  }

  async realPath(root: string, target: string): Promise<string> {
    return fs.realpath(this.resolve(root, target));
  }

  async stat(root: string, target: string): Promise<WorkspacePathStat> {
    const stat = await fs.stat(this.resolve(root, target));
    return { isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  }

  async readFile(root: string, target: string): Promise<string> {
    return fs.readFile(this.resolve(root, target), 'utf-8');
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

  async renameFile(root: string, source: string, target: string): Promise<void> {
    await fs.rename(this.resolve(root, source), this.resolve(root, target));
  }

  async deleteFile(root: string, target: string): Promise<void> {
    const resolved = this.resolve(root, target);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        await fs.rmdir(resolved);
        return;
      }
    } catch {
      // fall through to file removal
    }
    await fs.rm(resolved, { force: true });
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

const SOURCE_OPERATOR_CONTENT = `---
name: Customer Voice
description: Speaks for the user.
consult_when: When customer perspective matters.
kind: operator
roles:
  - operator
display_name: Customer Voice
---
Body of the operator persona.
`;

let tempRoot: string;
let workspaceFileSystem: RealWorkspaceFileSystem;
let invalidateOperatorRegistry: ReturnType<typeof vi.fn> & (() => void);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

async function seedSourceOperator(slug = 'customer-voice'): Promise<void> {
  await workspaceFileSystem.writeFile(tempRoot, path.join('operators', slug, 'OPERATOR.md'), SOURCE_OPERATOR_CONTENT);
}

describe('operatorDuplicateService', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-duplicate-'));
    workspaceFileSystem = new RealWorkspaceFileSystem();
    invalidateOperatorRegistry = vi.fn() as ReturnType<typeof vi.fn> & (() => void);
    logger.info.mockReset();
    logger.warn.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('creates a new slug derived from the new display name and copies OPERATOR.md', async () => {
    await seedSourceOperator();

    const result = await duplicateOperator(
      {
        sourceSlug: 'customer-voice',
        sourceSpacePath: tempRoot,
        newDisplayName: 'Customer Voice ACME',
      },
      { workspaceFileSystem, invalidateOperatorRegistry, logger },
    );

    expect(result).toEqual({ success: true, newSlug: 'customer-voice-acme' });
    const newContent = await fs.readFile(path.join(tempRoot, 'operators', 'customer-voice-acme', 'OPERATOR.md'), 'utf-8');
    const parsedNew = parseOperatorFrontmatterFromContent(newContent);
    expect(parsedNew.success).toBe(true);
    if (parsedNew.success) {
      expect(parsedNew.frontmatter.display_name).toBe('Customer Voice ACME');
    }
    expect(newContent).toContain('Body of the operator persona.');
    expect(invalidateOperatorRegistry).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSlug: 'customer-voice', newSlug: 'customer-voice-acme' }),
      'operators:duplicate_succeeded',
    );
  });

  it('auto-suffixes the slug when the derived slug already exists', async () => {
    await seedSourceOperator();
    await workspaceFileSystem.writeFile(tempRoot, path.join('operators', 'customer-voice-acme', 'OPERATOR.md'), SOURCE_OPERATOR_CONTENT);

    const result = await duplicateOperator(
      {
        sourceSlug: 'customer-voice',
        sourceSpacePath: tempRoot,
        newDisplayName: 'Customer Voice ACME',
      },
      { workspaceFileSystem, invalidateOperatorRegistry, logger },
    );

    expect(result).toEqual({ success: true, newSlug: 'customer-voice-acme-2' });
  });

  it('returns slug_collision_unresolvable when all numeric suffixes through 99 are taken', async () => {
    await seedSourceOperator();
    const baseSlug = 'customer-voice-acme';
    await workspaceFileSystem.writeFile(tempRoot, path.join('operators', baseSlug, 'OPERATOR.md'), SOURCE_OPERATOR_CONTENT);
    for (let i = 2; i <= 99; i += 1) {
      await workspaceFileSystem.writeFile(tempRoot, path.join('operators', `${baseSlug}-${i}`, 'OPERATOR.md'), SOURCE_OPERATOR_CONTENT);
    }

    const result = await duplicateOperator(
      {
        sourceSlug: 'customer-voice',
        sourceSpacePath: tempRoot,
        newDisplayName: 'Customer Voice ACME',
      },
      { workspaceFileSystem, invalidateOperatorRegistry, logger },
    );

    expect(result).toEqual({ success: false, errorCode: 'slug_collision_unresolvable' });
  });

  it('returns display_name_too_long when the new display name exceeds 120 characters', async () => {
    await seedSourceOperator();
    const result = await duplicateOperator(
      {
        sourceSlug: 'customer-voice',
        sourceSpacePath: tempRoot,
        newDisplayName: 'x'.repeat(121),
      },
      { workspaceFileSystem, invalidateOperatorRegistry, logger },
    );

    expect(result).toEqual({ success: false, errorCode: 'display_name_too_long' });
  });

  it('returns source_not_found when the source operator does not exist', async () => {
    const result = await duplicateOperator(
      {
        sourceSlug: 'missing-operator',
        sourceSpacePath: tempRoot,
        newDisplayName: 'New Name',
      },
      { workspaceFileSystem, invalidateOperatorRegistry, logger },
    );

    expect(result).toEqual({ success: false, errorCode: 'source_not_found' });
  });

  it('preserves all frontmatter fields except display_name', async () => {
    const richSourceContent = `---
name: Customer Voice
description: Voice of the customer.
consult_when: When pricing changes.
kind: operator
roles:
  - operator
  - live_meeting
proactive_interval_minutes: 5
use_cases:
  - Discovery calls
  - Renewals
display_name: Customer Voice
---
Persona body.
`;
    await workspaceFileSystem.writeFile(tempRoot, path.join('operators', 'customer-voice', 'OPERATOR.md'), richSourceContent);

    const result = await duplicateOperator(
      {
        sourceSlug: 'customer-voice',
        sourceSpacePath: tempRoot,
        newDisplayName: 'Voice ACME',
      },
      { workspaceFileSystem, invalidateOperatorRegistry, logger },
    );

    expect(result).toEqual({ success: true, newSlug: 'voice-acme' });
    const newContent = await fs.readFile(path.join(tempRoot, 'operators', 'voice-acme', 'OPERATOR.md'), 'utf-8');
    const parsedNew = parseOperatorFrontmatterFromContent(newContent);
    expect(parsedNew.success).toBe(true);
    if (parsedNew.success) {
      expect(parsedNew.frontmatter.name).toBe('Customer Voice');
      expect(parsedNew.frontmatter.description).toBe('Voice of the customer.');
      expect(parsedNew.frontmatter.proactive_interval_minutes).toBe(5);
      expect(parsedNew.frontmatter.use_cases).toEqual(['Discovery calls', 'Renewals']);
      expect(parsedNew.frontmatter.display_name).toBe('Voice ACME');
      expect(parsedNew.frontmatter.roles).toEqual(['operator', 'live_meeting']);
    }
  });

  it('serialises arrays as YAML (block style), never as JSON.stringify output', async () => {
    const richSourceContent = `---
name: Customer Voice
description: Voice of the customer.
consult_when: When pricing changes.
kind: operator
roles:
  - operator
  - live_meeting
use_cases:
  - Discovery calls
  - Renewals
---
Persona body.
`;
    await workspaceFileSystem.writeFile(tempRoot, path.join('operators', 'customer-voice', 'OPERATOR.md'), richSourceContent);

    const result = await duplicateOperator(
      {
        sourceSlug: 'customer-voice',
        sourceSpacePath: tempRoot,
        newDisplayName: 'Voice ACME',
      },
      { workspaceFileSystem, invalidateOperatorRegistry, logger },
    );

    expect(result).toEqual({ success: true, newSlug: 'voice-acme' });
    const newContent = await fs.readFile(path.join(tempRoot, 'operators', 'voice-acme', 'OPERATOR.md'), 'utf-8');
    expect(newContent).not.toMatch(/roles\s*:\s*\[/u);
    expect(newContent).not.toMatch(/use_cases\s*:\s*\[/u);
    expect(newContent).not.toContain('"operator"');
    expect(newContent).toMatch(/roles:\s*\n\s+- operator\s*\n\s+- live_meeting/u);
    expect(newContent).toContain('use_cases:\n  - Discovery calls');
  });

  it('rolls back the partial write when the file write fails mid-copy', async () => {
    await seedSourceOperator();
    const deleteFileSpy = vi.fn(async () => undefined);
    const failingFs: WorkspaceFileSystem = {
      listDirectory: workspaceFileSystem.listDirectory.bind(workspaceFileSystem),
      realPath: workspaceFileSystem.realPath.bind(workspaceFileSystem),
      stat: workspaceFileSystem.stat.bind(workspaceFileSystem),
      readFile: workspaceFileSystem.readFile.bind(workspaceFileSystem),
      appendFile: workspaceFileSystem.appendFile.bind(workspaceFileSystem),
      renameFile: workspaceFileSystem.renameFile.bind(workspaceFileSystem),
      exists: workspaceFileSystem.exists.bind(workspaceFileSystem),
      writeFile: vi.fn(async () => {
        throw new Error('disk write failed');
      }),
      deleteFile: deleteFileSpy,
    };

    const result = await duplicateOperator(
      {
        sourceSlug: 'customer-voice',
        sourceSpacePath: tempRoot,
        newDisplayName: 'Customer Voice ACME',
      },
      { workspaceFileSystem: failingFs, invalidateOperatorRegistry, logger },
    );

    expect(result).toEqual({ success: false, errorCode: 'copy_failed' });
    expect(deleteFileSpy).toHaveBeenCalled();
    expect(invalidateOperatorRegistry).not.toHaveBeenCalled();
  });

  it('removes a target file and empty directory created before a mid-copy write failure', async () => {
    await seedSourceOperator();
    const realWriteFile = workspaceFileSystem.writeFile.bind(workspaceFileSystem);
    const targetDirectory = path.join(tempRoot, 'operators', 'customer-voice-acme');
    const targetFile = path.join(targetDirectory, 'OPERATOR.md');
    const failingFs: WorkspaceFileSystem = {
      listDirectory: workspaceFileSystem.listDirectory.bind(workspaceFileSystem),
      realPath: workspaceFileSystem.realPath.bind(workspaceFileSystem),
      stat: workspaceFileSystem.stat.bind(workspaceFileSystem),
      readFile: workspaceFileSystem.readFile.bind(workspaceFileSystem),
      appendFile: workspaceFileSystem.appendFile.bind(workspaceFileSystem),
      renameFile: workspaceFileSystem.renameFile.bind(workspaceFileSystem),
      exists: workspaceFileSystem.exists.bind(workspaceFileSystem),
      deleteFile: workspaceFileSystem.deleteFile.bind(workspaceFileSystem),
      writeFile: vi.fn(async (root, target, content) => {
        await realWriteFile(root, target, content);
        throw new Error('disk write failed after partial write');
      }),
    };

    const result = await duplicateOperator(
      {
        sourceSlug: 'customer-voice',
        sourceSpacePath: tempRoot,
        newDisplayName: 'Customer Voice ACME',
      },
      { workspaceFileSystem: failingFs, invalidateOperatorRegistry, logger },
    );

    expect(result).toEqual({ success: false, errorCode: 'copy_failed' });
    await expect(fs.access(targetFile)).rejects.toThrow();
    await expect(fs.access(targetDirectory)).rejects.toThrow();
    expect(invalidateOperatorRegistry).not.toHaveBeenCalled();
  });
});
