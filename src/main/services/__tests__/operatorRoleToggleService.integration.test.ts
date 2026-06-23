import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDirectoryEntry, WorkspaceFileSystem, WorkspacePathStat } from '@core/workspaceFileSystem';
import { createOperatorRegistry } from '@core/services/operatorRegistry';
import { scanOperators } from '@core/services/operatorScanner';
import { setLiveMeetingEnabled } from '../operatorRoleToggleService';

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

describe('operatorRoleToggleService — coach picker integration', () => {
  let tempRoot: string;
  let targetSpacePath: string;
  let workspaceFileSystem: RealWorkspaceFileSystem;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-role-toggle-integration-'));
    targetSpacePath = path.join(tempRoot, 'Chief-of-Staff');
    workspaceFileSystem = new RealWorkspaceFileSystem();
    await fs.mkdir(path.join(targetSpacePath, 'operators', 'brand-critic'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('toggling on adds the operator to the live_meeting roleFilter listing; toggling off removes it', async () => {
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
        'live_prompt: Coach the speaker on clarity.',
        '---',
        'Body',
        '',
      ].join('\n'),
      'utf8',
    );

    const registry = createOperatorRegistry(scanOperators);
    const liveBeforeEnable = await registry.listAvailableWithDiagnostics(
      [targetSpacePath],
      { roleFilter: 'live_meeting' },
    );
    expect(liveBeforeEnable.operators.map((operator) => operator.operatorSlug)).toEqual([]);

    const enableResult = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: true,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: () => registry.invalidate(),
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );
    expect(enableResult).toEqual({ success: true });

    const liveAfterEnable = await registry.listAvailableWithDiagnostics(
      [targetSpacePath],
      { roleFilter: 'live_meeting' },
    );
    expect(liveAfterEnable.operators.map((operator) => operator.operatorSlug)).toEqual(['brand-critic']);
    const enabledOperator = liveAfterEnable.operators[0];
    expect(enabledOperator?.roles).toEqual(['operator', 'live_meeting']);

    const disableResult = await setLiveMeetingEnabled(
      {
        operatorSlug: 'brand-critic',
        targetSpacePath,
        enabled: false,
      },
      {
        workspaceFileSystem,
        invalidateOperatorRegistry: () => registry.invalidate(),
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );
    expect(disableResult).toEqual({ success: true });

    const liveAfterDisable = await registry.listAvailableWithDiagnostics(
      [targetSpacePath],
      { roleFilter: 'live_meeting' },
    );
    expect(liveAfterDisable.operators.map((operator) => operator.operatorSlug)).toEqual([]);

    const operatorsAfterDisable = await registry.listAvailableWithDiagnostics(
      [targetSpacePath],
      { roleFilter: 'operator' },
    );
    expect(operatorsAfterDisable.operators.map((operator) => operator.operatorSlug)).toEqual(['brand-critic']);
  });
});
