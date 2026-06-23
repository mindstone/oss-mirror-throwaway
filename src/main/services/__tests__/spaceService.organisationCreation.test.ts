import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSpace, updateSpaceFrontmatter } from '../spaceService';

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-space-organisation-create-'));
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('space organisation frontmatter writes', () => {
  it('writes organisation_name when creating a space with organisation', async () => {
    const space = await createSpace(workspaceDir, {
      name: 'Project',
      type: 'project',
      location: 'workspace',
      targetPath: 'work/Acme/Project',
      description: 'Project notes',
      organisation: 'Acme',
      createSubfolders: false,
    });

    const readme = await fs.readFile(path.join(space.absolutePath, 'README.md'), 'utf8');
    expect(readme).toContain('organisation_name: Acme');
    expect(space.organisationName).toBe('Acme');
  });

  it('updates organisation_name via the UI frontmatter writer', async () => {
    const space = await createSpace(workspaceDir, {
      name: 'Project',
      type: 'project',
      location: 'workspace',
      targetPath: 'work/Mindstone/Project',
      description: 'Project notes',
      organisation: 'Mindstone',
      createSubfolders: false,
    });

    const result = await updateSpaceFrontmatter(space.absolutePath, {
      organisation_name: 'Acme',
    }, { workspaceRoot: workspaceDir });

    expect(result).toEqual({ success: true });
    const readme = await fs.readFile(path.join(space.absolutePath, 'README.md'), 'utf8');
    expect(readme).toContain('organisation_name: Acme');
  });
});
