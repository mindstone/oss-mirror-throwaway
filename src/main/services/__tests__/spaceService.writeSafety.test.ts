import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FRONTMATTER_REPAIR_TMP_SUFFIX } from '@core/services/frontmatterRepair';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WriteOutsideWorkspaceError } from '../spaceWriteSafety';
import { updateSpaceFrontmatter } from '../spaceService';

let scratchRoot: string;
let workspaceRoot: string;
let realScratchRoot: string;
let previousResourcesPath: string | undefined;

const writeSafetyOptions = () => ({
  platform: 'darwin' as const,
  homedir: path.join(realScratchRoot, 'home'),
});

async function makeSpace(spacePath: string, readme = true): Promise<void> {
  await fs.mkdir(spacePath, { recursive: true });
  if (readme) {
    await fs.writeFile(
      path.join(spacePath, 'README.md'),
      '---\nrebel_space_description: Original\n---\n\n# Original\n',
      'utf8',
    );
  }
}

beforeEach(async () => {
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-space-service-write-safety-'));
  realScratchRoot = await fs.realpath(scratchRoot);
  workspaceRoot = path.join(realScratchRoot, 'workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });

  previousResourcesPath = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', {
    value: '',
    configurable: true,
  });
});

afterEach(async () => {
  Object.defineProperty(process, 'resourcesPath', {
    value: previousResourcesPath,
    configurable: true,
  });
  await fs.rm(scratchRoot, { recursive: true, force: true });
});

describe('spaceService write-safety boundary', () => {
  it('rejects a write whose realpath escapes the workspace', async () => {
    const externalSpace = path.join(realScratchRoot, 'external-space');
    await makeSpace(externalSpace);

    await expect(
      updateSpaceFrontmatter(
        externalSpace,
        { rebel_space_description: 'Blocked' },
        { workspaceRoot, writeSafetyOptions: writeSafetyOptions() },
      ),
    ).rejects.toMatchObject({
      name: 'WriteOutsideWorkspaceError',
      reason: 'escapes-workspace-and-not-under-home',
    });
  });

  it('rejects a write whose realpath lands under process.resourcesPath', async () => {
    const fakeResources = path.join(realScratchRoot, 'Fake.app', 'Contents', 'Resources');
    const bundledSpace = path.join(fakeResources, 'rebel-system');
    await makeSpace(bundledSpace);
    const rogueLink = path.join(workspaceRoot, 'rebel-system');
    await fs.symlink(bundledSpace, rogueLink);

    Object.defineProperty(process, 'resourcesPath', {
      value: fakeResources,
      configurable: true,
    });

    await expect(
      updateSpaceFrontmatter(
        rogueLink,
        { rebel_space_description: 'Blocked' },
        { workspaceRoot, writeSafetyOptions: writeSafetyOptions() },
      ),
    ).rejects.toMatchObject({
      name: 'WriteOutsideWorkspaceError',
      reason: 'under-resources-path',
    });
  });

  it('rejects when a symlink target resolves outside the workspace', async () => {
    const externalSpace = path.join(realScratchRoot, 'outside-target');
    await makeSpace(externalSpace);
    const symlinkedSpace = path.join(workspaceRoot, 'LinkedOutside');
    await fs.symlink(externalSpace, symlinkedSpace);

    await expect(
      updateSpaceFrontmatter(
        symlinkedSpace,
        { rebel_space_description: 'Blocked' },
        { workspaceRoot, writeSafetyOptions: writeSafetyOptions() },
      ),
    ).rejects.toBeInstanceOf(WriteOutsideWorkspaceError);
  });

  it('accepts a legitimate workspace-inside write', async () => {
    const spacePath = path.join(workspaceRoot, 'Inside');
    await makeSpace(spacePath);

    const result = await updateSpaceFrontmatter(
      spacePath,
      { rebel_space_description: 'Updated safely' },
      { workspaceRoot, writeSafetyOptions: writeSafetyOptions() },
    );

    expect(result).toEqual({ success: true });
    const content = await fs.readFile(path.join(spacePath, 'README.md'), 'utf8');
    expect(content).toContain('rebel_space_description: Updated safely');
    expect(content).toContain('# Original');
  });

  it('does not corrupt README.md when the atomic temp write fails', async () => {
    const spacePath = path.join(workspaceRoot, 'Atomic');
    await makeSpace(spacePath);
    const readmePath = path.join(spacePath, 'README.md');
    const original = await fs.readFile(readmePath, 'utf8');

    await fs.mkdir(`${readmePath}${FRONTMATTER_REPAIR_TMP_SUFFIX}`);

    const result = await updateSpaceFrontmatter(
      spacePath,
      { rebel_space_description: 'Should not land' },
      { workspaceRoot, writeSafetyOptions: writeSafetyOptions() },
    );

    expect(result.success).toBe(false);
    const after = await fs.readFile(readmePath, 'utf8');
    expect(after).toBe(original);
  });
});
