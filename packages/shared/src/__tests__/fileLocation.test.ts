import { describe, expect, it } from 'vitest';
import {
  FileLocationSchema,
  OutsideCategorySchema,
  describeFileLocation,
  fileLocationFromSkillTarget,
  legacyMissingLocation,
  type FileLocation,
} from '../fileLocation';

type SharedSkillTarget = Parameters<typeof fileLocationFromSkillTarget>[0];

describe('FileLocationSchema', () => {
  it('accepts an in-space variant with all fields populated', () => {
    const parsed = FileLocationSchema.parse({
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/workflows/demo/SKILL.md',
      workspaceRelativePath: 'General/skills/workflows/demo/SKILL.md',
      fileName: 'SKILL.md',
      absolutePath: '/tmp/workspace/General/skills/workflows/demo/SKILL.md',
    });
    expect(parsed.kind).toBe('in-space');
  });

  it('accepts an outside-workspace variant with all fields populated', () => {
    const parsed = FileLocationSchema.parse({
      kind: 'outside-workspace',
      absolutePath: '/tmp/outside/demo.md',
      fileName: 'demo.md',
      outsideCategory: 'outside',
    });
    expect(parsed.kind).toBe('outside-workspace');
  });

  it('accepts a legacy-missing-location variant with all fields populated', () => {
    const parsed = FileLocationSchema.parse({
      kind: 'legacy-missing-location',
      fileName: 'demo.md',
      spaceName: 'General',
      legacyPath: 'General/skills/demo.md',
    });
    expect(parsed.kind).toBe('legacy-missing-location');
  });

  it('rejects in-space with empty spaceName', () => {
    expect(() => FileLocationSchema.parse({
      kind: 'in-space',
      spaceName: '',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/demo.md',
      workspaceRelativePath: 'General/skills/demo.md',
      fileName: 'demo.md',
    })).toThrow();
  });

  it('rejects outside-workspace with empty absolutePath', () => {
    expect(() => FileLocationSchema.parse({
      kind: 'outside-workspace',
      absolutePath: '',
      fileName: 'demo.md',
    })).toThrow();
  });

  it('rejects in-space with empty fileName', () => {
    expect(() => FileLocationSchema.parse({
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/demo.md',
      workspaceRelativePath: 'General/skills/demo.md',
      fileName: '',
    })).toThrow();
  });

  it('rejects outside-workspace with empty fileName', () => {
    expect(() => FileLocationSchema.parse({
      kind: 'outside-workspace',
      absolutePath: '/tmp/outside/demo.md',
      fileName: '',
    })).toThrow();
  });

  it('rejects legacy-missing-location with empty fileName', () => {
    expect(() => FileLocationSchema.parse({
      kind: 'legacy-missing-location',
      fileName: '',
    })).toThrow();
  });

  it('rejects unknown kind', () => {
    const result = FileLocationSchema.safeParse({
      kind: 'unknown-kind' as any,
      fileName: 'demo.md',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing kind discriminator', () => {
    const result = FileLocationSchema.safeParse({
      fileName: 'demo.md',
      spaceName: 'General',
    });
    expect(result.success).toBe(false);
  });
});

describe('describeFileLocation', () => {
  it('describes in-space variant', () => {
    const location: FileLocation = {
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/workflows/demo/SKILL.md',
      workspaceRelativePath: 'General/skills/workflows/demo/SKILL.md',
      fileName: 'SKILL.md',
      absolutePath: '/tmp/workspace/General/skills/workflows/demo/SKILL.md',
    };

    expect(describeFileLocation(location)).toEqual({
      label: 'General / skills/workflows/demo/SKILL.md',
      shortLabel: 'General / SKILL.md',
      tooltip: '/tmp/workspace/General/skills/workflows/demo/SKILL.md',
      fileName: 'SKILL.md',
      degraded: false,
    });
  });

  it.each([
    {
      category: 'temp',
      expectedLabel: 'Temporary folder — file.md',
      expectedShortLabel: 'Temporary folder — file.md',
    },
    {
      category: 'system',
      expectedLabel: 'System files — file.md',
      expectedShortLabel: 'System files — file.md',
    },
    {
      category: 'inbox',
      expectedLabel: 'Actions — file.md',
      expectedShortLabel: 'Actions — file.md',
    },
    {
      category: 'mcp_servers',
      expectedLabel: 'MCP Servers — file.md',
      expectedShortLabel: 'MCP Servers — file.md',
    },
    {
      category: 'outside',
      expectedLabel: 'Outside workspace — parent / file.md',
      expectedShortLabel: 'Outside workspace — file.md',
    },
    {
      category: 'workspace_root',
      expectedLabel: 'Outside workspace — parent / file.md',
      expectedShortLabel: 'Outside workspace — file.md',
    },
    {
      category: 'unknown',
      expectedLabel: 'Outside workspace — parent / file.md',
      expectedShortLabel: 'Outside workspace — file.md',
    },
  ] as const)('describes outside-workspace with category=$category', ({ category, expectedLabel, expectedShortLabel }) => {
    const outsideCategory = OutsideCategorySchema.parse(category);
    const location: FileLocation = {
      kind: 'outside-workspace',
      absolutePath: '/tmp/root/parent/file.md',
      fileName: 'file.md',
      outsideCategory,
    };
    expect(describeFileLocation(location)).toEqual({
      label: expectedLabel,
      shortLabel: expectedShortLabel,
      tooltip: '/tmp/root/parent/file.md',
      fileName: 'file.md',
      degraded: false,
    });
  });

  it('describes legacy-missing-location as degraded', () => {
    const location: FileLocation = {
      kind: 'legacy-missing-location',
      fileName: 'SKILL.md',
      spaceName: 'General',
      legacyPath: 'General/skills/workflows/demo/SKILL.md',
    };

    expect(describeFileLocation(location)).toEqual({
      label: 'General / SKILL.md',
      shortLabel: 'General / SKILL.md',
      tooltip: 'File location missing — degraded display',
      fileName: 'SKILL.md',
      degraded: true,
    });
  });

  it('uses absolutePath as tooltip when provided on in-space', () => {
    const location: FileLocation = {
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/workflows/very/deep/path/to/my/SKILL.md',
      workspaceRelativePath: 'General/skills/workflows/very/deep/path/to/my/SKILL.md',
      fileName: 'SKILL.md',
      absolutePath: '/tmp/workspace/General/skills/workflows/very/deep/path/to/my/SKILL.md',
    };

    expect(describeFileLocation(location).tooltip).toBe('/tmp/workspace/General/skills/workflows/very/deep/path/to/my/SKILL.md');
  });

  it('uses workspaceRelativePath as tooltip when absolutePath is missing on in-space', () => {
    const location: FileLocation = {
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/workflows/very/deep/path/to/my/SKILL.md',
      workspaceRelativePath: 'General/skills/workflows/very/deep/path/to/my/SKILL.md',
      fileName: 'SKILL.md',
    };

    expect(describeFileLocation(location).tooltip).toBe('General/skills/workflows/very/deep/path/to/my/SKILL.md');
  });

  it.each([
    {
      absolutePath: '/foo.md',
      fileName: 'foo.md',
      expectedLabel: 'Outside workspace — foo.md',
    },
    {
      absolutePath: '/',
      fileName: 'root.md',
      expectedLabel: 'Outside workspace — root.md',
    },
    {
      absolutePath: '/C:/foo.md',
      fileName: 'foo.md',
      expectedLabel: 'Outside workspace — foo.md',
    },
  ])('drops the parent segment for root-level outside paths ($absolutePath)', ({ absolutePath, fileName, expectedLabel }) => {
    const location: FileLocation = {
      kind: 'outside-workspace',
      absolutePath,
      fileName,
      outsideCategory: 'outside',
    };

    expect(describeFileLocation(location)).toMatchObject({
      label: expectedLabel,
      shortLabel: 'Outside workspace — foo.md'.replace('foo.md', fileName),
      fileName,
      degraded: false,
    });
  });
});

describe('fileLocationFromSkillTarget', () => {
  it('projects an in-space skill target', () => {
    const target = {
      absolutePath: '/tmp/workspace/General/skills/workflows/demo/SKILL.md',
      relativePath: 'General/skills/workflows/demo/SKILL.md',
      sharing: 'restricted',
      spaceName: 'General',
      spacePath: 'General',
      spaceAbsolutePath: '/tmp/workspace/General',
      shape: 'file',
    } as SharedSkillTarget;

    expect(fileLocationFromSkillTarget(target)).toEqual({
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/workflows/demo/SKILL.md',
      workspaceRelativePath: 'General/skills/workflows/demo/SKILL.md',
      fileName: 'SKILL.md',
      absolutePath: '/tmp/workspace/General/skills/workflows/demo/SKILL.md',
    });
  });

  it('projects an outside-workspace skill target when no in-space data is available', () => {
    const target = {
      absolutePath: '/tmp/external/skill.md',
      relativePath: '',
      sharing: 'restricted',
      spaceName: '',
      spacePath: '',
      spaceAbsolutePath: '/tmp/external',
      shape: 'file',
    } as SharedSkillTarget;

    expect(fileLocationFromSkillTarget(target)).toEqual({
      kind: 'outside-workspace',
      absolutePath: '/tmp/external/skill.md',
      fileName: 'skill.md',
    });
  });

  it('falls back to legacy-missing-location for partial target data', () => {
    const target = {
      absolutePath: '',
      relativePath: 'General/skills/workflows/demo/SKILL.md',
      sharing: 'restricted',
      spaceName: 'General',
      spacePath: '',
      spaceAbsolutePath: '/tmp/workspace/General',
      shape: 'file',
    } as SharedSkillTarget;

    expect(fileLocationFromSkillTarget(target)).toEqual({
      kind: 'legacy-missing-location',
      fileName: 'SKILL.md',
      spaceName: 'General',
      legacyPath: 'General/skills/workflows/demo/SKILL.md',
    });
  });

  it('projects folder-shaped targets using the folder basename', () => {
    const target = {
      absolutePath: '/tmp/workspace/General/skills/workflows/demo',
      relativePath: 'General/skills/workflows/demo',
      sharing: 'restricted',
      spaceName: 'General',
      spacePath: 'General',
      spaceAbsolutePath: '/tmp/workspace/General',
      shape: 'folder',
    } as SharedSkillTarget;

    expect(fileLocationFromSkillTarget(target)).toEqual({
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/workflows/demo',
      workspaceRelativePath: 'General/skills/workflows/demo',
      fileName: 'demo',
      absolutePath: '/tmp/workspace/General/skills/workflows/demo',
    });
  });

  it.each([
    'General/..',
    'General/../escape.md',
    'General\\..\\escape.md',
  ])('treats escaping skill target paths as non in-space (%s)', (relativePath) => {
    const target = {
      absolutePath: '/tmp/external/escape.md',
      relativePath,
      sharing: 'restricted',
      spaceName: 'General',
      spacePath: 'General',
      spaceAbsolutePath: '/tmp/workspace/General',
      shape: 'file',
    } as SharedSkillTarget;

    expect(fileLocationFromSkillTarget(target)).toEqual({
      kind: 'outside-workspace',
      absolutePath: '/tmp/external/escape.md',
      fileName: 'escape.md',
    });
  });
});

describe('legacyMissingLocation', () => {
  it('uses fileName first', () => {
    expect(legacyMissingLocation({ fileName: 'A.md' }).fileName).toBe('A.md');
  });

  it('falls back to basename(legacyPath)', () => {
    expect(legacyMissingLocation({ legacyPath: '/x/y/B.md' }).fileName).toBe('B.md');
  });

  it('falls back to spaceName', () => {
    expect(legacyMissingLocation({ spaceName: 'General' }).fileName).toBe('General');
  });

  it('falls back to "Unknown file" when all inputs are missing', () => {
    expect(legacyMissingLocation({}).fileName).toBe('Unknown file');
  });

  it('treats whitespace-only fileName as empty and cascades', () => {
    expect(legacyMissingLocation({ fileName: '   ', legacyPath: '/x/y/C.md' }).fileName).toBe('C.md');
  });
});
