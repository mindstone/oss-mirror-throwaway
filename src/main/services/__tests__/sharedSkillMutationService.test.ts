import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { sharedSkillMutationService } from '../sharedSkillMutationService';
import * as spaceService from '../spaceService';
import * as settingsStore from '@core/services/settingsStore';

vi.mock('../spaceService');
vi.mock('@core/services/settingsStore');

type MockScannedSpace = Awaited<ReturnType<typeof spaceService.scanSpaces>>[number];
type DisplayableSpace = { name: string; displayName?: string };

function makeMockSpace(overrides: Partial<MockScannedSpace>): MockScannedSpace {
  return {
    name: 'Team Space',
    path: 'team-space',
    absolutePath: '/tmp/team-space',
    type: 'team',
    isSymlink: false,
    hasReadme: true,
    ...overrides,
  } as MockScannedSpace;
}

describe('sharedSkillMutationService', () => {
  let workspaceDir: string;
  let sharedSpaceDir: string;

  beforeEach(async () => {
    sharedSkillMutationService.clearTrackedHashes();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-skill-mutation-'));
    sharedSpaceDir = path.join(workspaceDir, 'team-space');
    await fs.mkdir(path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill'), { recursive: true });
    await fs.writeFile(path.join(sharedSpaceDir, 'README.md'), '# Team Space', 'utf8');

    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: workspaceDir,
      spaces: [],
    } as unknown as AppSettings);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      makeMockSpace({
        absolutePath: sharedSpaceDir,
        sharing: 'restricted',
      }),
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue({
      rebel_space_description: 'Team Space',
      sharing: 'restricted',
    });
    vi.mocked(spaceService.getSpaceDisplayName).mockImplementation((space: DisplayableSpace) => space.displayName ?? space.name);
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it('classifies non-private main skill files as shared', async () => {
    const target = await sharedSkillMutationService.classifySharedSkillPath(
      path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md'),
      workspaceDir,
    );

    expect(target).toEqual(expect.objectContaining({
      relativePath: 'team-space/skills/operations/demo-skill/SKILL.md',
      sharing: 'restricted',
      shape: 'folder',
      spacePath: 'team-space',
    }));
  });

  it('classifies top-level and nested file-based skills as shared', async () => {
    const topLevelPath = path.join(sharedSpaceDir, 'skills', 'quick-note.md');
    const nestedPath = path.join(sharedSpaceDir, 'skills', 'operations', 'playbooks', 'follow-up.md');
    await fs.mkdir(path.dirname(nestedPath), { recursive: true });
    await fs.writeFile(topLevelPath, '---\ndescription: Top level\n---\n', 'utf8');
    await fs.writeFile(nestedPath, '---\ndescription: Nested\n---\n', 'utf8');

    const topLevelTarget = await sharedSkillMutationService.classifySharedSkillPath(topLevelPath, workspaceDir);
    const nestedTarget = await sharedSkillMutationService.classifySharedSkillPath(nestedPath, workspaceDir);

    expect(topLevelTarget).toEqual(expect.objectContaining({
      relativePath: 'team-space/skills/quick-note.md',
      shape: 'file',
    }));
    expect(nestedTarget).toEqual(expect.objectContaining({
      relativePath: 'team-space/skills/operations/playbooks/follow-up.md',
      shape: 'file',
    }));
  });

  it('ignores example files and private spaces', async () => {
    const exampleTarget = await sharedSkillMutationService.classifySharedSkillPath(
      path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'examples', 'good.md'),
      workspaceDir,
    );
    expect(exampleTarget).toBeNull();

    vi.mocked(spaceService.scanSpaces).mockResolvedValueOnce([
      makeMockSpace({
        name: 'Private Space',
        absolutePath: sharedSpaceDir,
        sharing: 'private',
      }),
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValueOnce({
      rebel_space_description: 'Private Space',
      sharing: 'private',
    });

    const privateTarget = await sharedSkillMutationService.classifySharedSkillPath(
      path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md'),
      workspaceDir,
    );
    expect(privateTarget).toBeNull();
  });

  it('ignores support markdown files inside folder-based skills', async () => {
    await fs.writeFile(
      path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md'),
      '---\ndescription: Folder skill\n---\n',
      'utf8',
    );
    const supportDocPath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'notes.md');
    await fs.writeFile(supportDocPath, '# Internal notes', 'utf8');

    const target = await sharedSkillMutationService.classifySharedSkillPath(supportDocPath, workspaceDir);

    expect(target).toBeNull();
  });

  it('classifies source-path writes for symlink-backed shared spaces', async () => {
    const providerSpaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-skill-provider-'));
    const providerSkillPath = path.join(providerSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.mkdir(path.dirname(providerSkillPath), { recursive: true });
    await fs.writeFile(providerSkillPath, '---\ndescription: Provider skill\n---\n', 'utf8');

    vi.mocked(spaceService.scanSpaces).mockResolvedValueOnce([
      makeMockSpace({
        path: 'team-space',
        absolutePath: sharedSpaceDir,
        isSymlink: true,
        sourcePath: providerSpaceDir,
        sharing: 'restricted',
      }),
    ]);

    const target = await sharedSkillMutationService.classifySharedSkillPath(providerSkillPath, workspaceDir);

    expect(target).toEqual(expect.objectContaining({
      relativePath: 'team-space/skills/operations/demo-skill/SKILL.md',
      shape: 'folder',
    }));

    await fs.rm(providerSpaceDir, { recursive: true, force: true });
  });

  it('stamps collaboration metadata for library writes', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    const result = await sharedSkillMutationService.writeManagedSkillFile(
      filePath,
      `---
description: Demo skill
---

Hello world
`,
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: 'user-123',
          name: 'Anna Maria',
          email: 'anna@example.com',
          image: null,
        },
      },
    );

    expect(result && 'conflict' in result ? result.conflict : false).toBe(false);

    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toContain('author: "Anna Maria"');
    expect(written).toContain('author_id: "user-123"');
    expect(written).toContain('author_email: "anna@example.com"');
    expect(written).toContain('last_modified_by: "Anna Maria"');
    expect(written).toContain('last_modified_by_id: "user-123"');
    expect(written).toContain('last_modified_by_email: "anna@example.com"');
    expect(written).toContain('contributors:');
    expect(written).toContain('- "user-123"');
  });

  it('does not claim authorship when editing an existing shared skill with missing author fields', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.writeFile(
      filePath,
      `---
description: Demo skill
---

Legacy shared skill
`,
      'utf8',
    );

    const result = await sharedSkillMutationService.writeManagedSkillFile(
      filePath,
      `---
description: Demo skill
---

Legacy shared skill updated
`,
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: 'user-123',
          name: 'Anna Maria',
          email: 'anna@example.com',
          image: null,
        },
      },
    );

    expect(result && 'conflict' in result ? result.conflict : false).toBe(false);

    const written = await fs.readFile(filePath, 'utf8');
    expect(written).not.toContain('author:');
    expect(written).not.toContain('author_id:');
    expect(written).not.toContain('author_email:');
    expect(written).toContain('last_modified_by: "Anna Maria"');
    expect(written).toContain('last_modified_by_id: "user-123"');
  });

  it('clears stale responsible-human identity when a human write has incomplete identity', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.writeFile(
      filePath,
      `---
description: Demo skill
last_responsible_human_by: "Alice"
last_responsible_human_id: "alice"
last_responsible_human_email: "alice@example.com"
---

Legacy shared skill
`,
      'utf8',
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      filePath,
      `---
description: Demo skill
---

Legacy shared skill updated
`,
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: 'user-123',
          name: 'Anna Maria',
          email: '',
          image: null,
        },
      },
    );

    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toContain('last_modified_by: "Anna Maria"');
    expect(written).toContain('last_modified_by_id: "user-123"');
    expect(written).not.toContain('last_modified_by_email: "alice@example.com"');
    expect(written).not.toContain('last_responsible_human_by:');
    expect(written).not.toContain('last_responsible_human_id:');
    expect(written).not.toContain('last_responsible_human_email:');
  });

  it('clears stale responsible-human identity when a human write is missing id', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.writeFile(
      filePath,
      `---
description: Demo skill
last_responsible_human_by: "Alice"
last_responsible_human_id: "alice"
last_responsible_human_email: "alice@example.com"
---

Legacy shared skill
`,
      'utf8',
    );

    await sharedSkillMutationService.writeManagedSkillFile(
      filePath,
      `---
description: Demo skill
---

Legacy shared skill updated
`,
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: '',
          name: 'Anna Maria',
          email: 'anna@example.com',
          image: null,
        },
      },
    );

    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toContain('last_modified_by: "Anna Maria"');
    expect(written).not.toContain('last_modified_by_id: "alice"');
    expect(written).toContain('last_modified_by_email: "anna@example.com"');
    expect(written).not.toContain('last_responsible_human_by:');
    expect(written).not.toContain('last_responsible_human_id:');
    expect(written).not.toContain('last_responsible_human_email:');
  });

  it('returns a protection checkpoint context for non-author shared skills', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.writeFile(
      filePath,
      `---
description: Demo skill
author: "Anna Maria"
author_id: "user-123"
author_email: "anna@example.com"
last_modified_by: "Rebel"
last_modified_by_id: "rebel"
---

Shared skill body
`,
      'utf8',
    );

    const result = await sharedSkillMutationService.getNonAuthorSharedSkillProtectionContext(
      filePath,
      workspaceDir,
      {
        id: 'user-456',
        name: 'Liam',
        email: 'liam@example.com',
        image: null,
      },
    );

    expect(result).toEqual(expect.objectContaining({
      authorLabel: 'Anna',
      skillName: 'demo-skill',
      approvalIdentifier: 'shared-skill:team-space/skills/operations/demo-skill/skill.md',
    }));
  });

  it('skips protection checkpoints for the current author', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.writeFile(
      filePath,
      `---
description: Demo skill
author: "Anna Maria"
author_id: "user-123"
last_modified_by: "Anna Maria"
last_modified_by_id: "user-123"
---

Shared skill body
`,
      'utf8',
    );

    const result = await sharedSkillMutationService.getNonAuthorSharedSkillProtectionContext(
      filePath,
      workspaceDir,
      {
        id: 'user-123',
        name: 'Anna Maria',
        email: 'anna@example.com',
        image: null,
      },
    );

    expect(result).toBeNull();
  });

  it('normalizes agent edits into full-file managed writes', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.writeFile(
      filePath,
      `---
description: Demo skill
author: "Anna Maria"
author_id: "user-123"
---

Hello world
`,
      'utf8',
    );

    const result = await sharedSkillMutationService.prepareManagedToolInput(
      'Edit',
      {
        file_path: filePath,
        old_string: 'Hello world',
        new_string: 'Updated content',
      },
      workspaceDir,
      {
        kind: 'agent',
        user: {
          id: 'user-456',
          name: 'Liam',
          email: 'liam@example.com',
          image: null,
        },
      },
    );

    expect(result && 'updatedInput' in result).toBe(true);
    if (!result || !('updatedInput' in result)) {
      return;
    }

    expect(result.updatedInput.old_string).toContain('description: Demo skill');
    expect(result.updatedInput.new_string).toContain('last_modified_by: "Rebel"');
    expect(result.updatedInput.new_string).toContain('last_modified_by_id: "rebel"');
    expect(result.updatedInput.new_string).toContain('last_modified_context: "from Liam\'s input"');
    expect(result.updatedInput.new_string).toContain('contributors:');
    expect(result.updatedInput.new_string).toContain('- "user-456"');
  });

  it('supports str_replace_editor for shared skill edits', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.writeFile(
      filePath,
      `---
description: Demo skill
author: "Anna Maria"
author_id: "user-123"
---

Hello world
`,
      'utf8',
    );

    const result = await sharedSkillMutationService.prepareManagedToolInput(
      'str_replace_editor',
      {
        path: filePath,
        old_str: 'Hello world',
        new_str: 'Updated with alias tool',
      },
      workspaceDir,
      {
        kind: 'agent',
        user: {
          id: 'user-456',
          name: 'Liam',
          email: 'liam@example.com',
          image: null,
        },
      },
    );

    expect(result && 'updatedInput' in result).toBe(true);
    if (!result || !('updatedInput' in result)) {
      return;
    }

    expect(result.updatedInput.old_str).toContain('description: Demo skill');
    expect(result.updatedInput.new_str).toContain('last_modified_by: "Rebel"');
    expect(result.updatedInput.new_str).toContain('last_modified_context: "from Liam\'s input"');
  });

  it('supports change_all edits for shared skills', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.writeFile(
      filePath,
      `---
description: Demo skill
author: "Anna Maria"
author_id: "user-123"
---

Repeat me
Repeat me
`,
      'utf8',
    );

    const result = await sharedSkillMutationService.prepareManagedToolInput(
      'Edit',
      {
        file_path: filePath,
        old_string: 'Repeat me',
        new_string: 'Updated',
        change_all: true,
      },
      workspaceDir,
      {
        kind: 'agent',
        user: {
          id: 'user-456',
          name: 'Liam',
          email: 'liam@example.com',
          image: null,
        },
      },
    );

    expect(result && 'updatedInput' in result).toBe(true);
    if (!result || !('updatedInput' in result)) {
      return;
    }

    expect(result.updatedInput.new_string).toContain('Updated\nUpdated');
  });

  it('returns a conflict when the file changed after the last managed write', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');

    const initialWrite = await sharedSkillMutationService.writeManagedSkillFile(
      filePath,
      `---
description: Demo skill
---

Version one
`,
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: 'user-123',
          name: 'Anna Maria',
          email: 'anna@example.com',
          image: null,
        },
      },
    );
    expect(initialWrite && 'conflict' in initialWrite ? initialWrite.conflict : false).toBe(false);

    await fs.writeFile(
      filePath,
      `---
description: Demo skill
---

Externally modified
`,
      'utf8',
    );

    const conflictingWrite = await sharedSkillMutationService.writeManagedSkillFile(
      filePath,
      `---
description: Demo skill
---

Version two
`,
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: 'user-123',
          name: 'Anna Maria',
          email: 'anna@example.com',
          image: null,
        },
      },
    );

    expect(conflictingWrite).toEqual(expect.objectContaining({
      conflict: true,
      path: filePath,
      currentHash: expect.any(String),
    }));
  });

  it('auto-resolves tracked hash drift for agent tool edits instead of blocking', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.writeFile(filePath, '---\ndescription: Demo skill\n---\n\nOriginal\n', 'utf8');
    await sharedSkillMutationService.writeManagedSkillFile(
      filePath,
      '---\ndescription: Demo skill\n---\n\nOriginal\n',
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: 'user-123',
          name: 'Anna Maria',
          email: 'anna@example.com',
          image: null,
        },
      },
    );

    await fs.writeFile(filePath, '---\ndescription: Demo skill\n---\n\nExternally modified\n', 'utf8');

    const result = await sharedSkillMutationService.prepareManagedToolInput(
      'Edit',
      {
        file_path: filePath,
        old_string: 'Externally modified',
        new_string: 'Agent change',
      },
      workspaceDir,
      {
        kind: 'agent',
        user: {
          id: 'user-456',
          name: 'Liam',
          email: 'liam@example.com',
          image: null,
        },
      },
    );

    expect(result).not.toBeNull();
    expect(result && 'denyReason' in result).toBe(false);
    expect(result && 'updatedInput' in result).toBe(true);
    if (result && 'updatedInput' in result) {
      expect(result.updatedInput.new_string).toContain('Agent change');
    }
  });

  it('tracks hashes by canonical workspace-relative skill identity across source and workspace paths', async () => {
    const providerSpaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-skill-provider-conflict-'));
    const workspaceSkillPath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    const providerSkillPath = path.join(providerSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    await fs.mkdir(path.dirname(providerSkillPath), { recursive: true });
    await fs.writeFile(providerSkillPath, '---\ndescription: Provider skill\n---\n\nOriginal\n', 'utf8');

    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      makeMockSpace({
        path: 'team-space',
        absolutePath: sharedSpaceDir,
        isSymlink: true,
        sourcePath: providerSpaceDir,
        sharing: 'restricted',
      }),
    ]);

    await sharedSkillMutationService.writeManagedSkillFile(
      providerSkillPath,
      '---\ndescription: Provider skill\n---\n\nOriginal\n',
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: 'user-123',
          name: 'Anna Maria',
          email: 'anna@example.com',
          image: null,
        },
      },
    );

    await fs.writeFile(workspaceSkillPath, '---\ndescription: Provider skill\n---\n\nExternally modified\n', 'utf8');

    const result = await sharedSkillMutationService.writeManagedSkillFile(
      workspaceSkillPath,
      '---\ndescription: Provider skill\n---\n\nWorkspace update\n',
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: 'user-123',
          name: 'Anna Maria',
          email: 'anna@example.com',
          image: null,
        },
      },
    );

    expect(result).toEqual(expect.objectContaining({
      conflict: true,
      path: workspaceSkillPath,
    }));

    await fs.rm(providerSpaceDir, { recursive: true, force: true });
  });

  it('does not fail the primary write when a managed write observer throws', async () => {
    const filePath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');
    const unsubscribe = sharedSkillMutationService.addManagedWriteObserver(async () => {
      throw new Error('observer failed');
    });

    const result = await sharedSkillMutationService.writeManagedSkillFile(
      filePath,
      '---\ndescription: Demo skill\n---\n\nObserver-safe write\n',
      workspaceDir,
      {
        kind: 'human',
        user: {
          id: 'user-123',
          name: 'Anna Maria',
          email: 'anna@example.com',
          image: null,
        },
      },
    );

    unsubscribe();

    expect(result && 'conflict' in result ? result.conflict : false).toBe(false);
    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toContain('Observer-safe write');
  });
});
