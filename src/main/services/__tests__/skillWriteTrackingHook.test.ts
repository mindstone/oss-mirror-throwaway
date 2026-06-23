import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { createSkillWriteTrackingHook } from '../skillWriteTrackingHook';
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

describe('skillWriteTrackingHook', () => {
  let workspaceDir: string;
  let sharedSpaceDir: string;
  let sharedSkillPath: string;
  let hook: ReturnType<typeof createSkillWriteTrackingHook>;

  beforeEach(async () => {
    sharedSkillMutationService.clearTrackedHashes();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-write-tracking-'));
    sharedSpaceDir = path.join(workspaceDir, 'team-space');
    sharedSkillPath = path.join(sharedSpaceDir, 'skills', 'operations', 'demo-skill', 'SKILL.md');

    await fs.mkdir(path.dirname(sharedSkillPath), { recursive: true });
    await fs.writeFile(sharedSkillPath, '---\ndescription: Demo\n---\n\nContent\n', 'utf8');
    await fs.writeFile(path.join(sharedSpaceDir, 'README.md'), '# Team Space', 'utf8');

    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: workspaceDir,
      spaces: [],
    } as unknown as AppSettings);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      makeMockSpace({ absolutePath: sharedSpaceDir, sharing: 'restricted' }),
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue({ sharing: 'restricted' } as any);
    vi.mocked(spaceService.getSpaceDisplayName).mockImplementation(
      (space: DisplayableSpace) => space.displayName ?? space.name,
    );

    hook = createSkillWriteTrackingHook({ coreDirectory: workspaceDir });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('ignores non-file-write tools', async () => {
    const result = await hook({
      tool_name: 'Read',
      tool_input: { file_path: sharedSkillPath },
    });
    expect(result).toEqual({});
  });

  it('ignores calls with no tool_input', async () => {
    const result = await hook({
      tool_name: 'Write',
      tool_input: undefined,
    });
    expect(result).toEqual({});
  });

  it('ignores calls without a recognisable file path', async () => {
    const result = await hook({
      tool_name: 'Write',
      tool_input: { content: 'hello' },
    });
    expect(result).toEqual({});
  });

  it('clears pending write on tool error', async () => {
    const clearSpy = vi.spyOn(sharedSkillMutationService, 'clearPendingManagedWrite');
    await hook({
      tool_name: 'Write',
      tool_input: { file_path: sharedSkillPath, content: 'new' },
      tool_output: { isError: true },
    });
    expect(clearSpy).toHaveBeenCalledWith(sharedSkillPath, workspaceDir);
  });

  it('ignores non-shared-skill paths', async () => {
    const privatePath = path.join(workspaceDir, 'notes', 'todo.md');
    await fs.mkdir(path.dirname(privatePath), { recursive: true });
    await fs.writeFile(privatePath, 'todo\n', 'utf8');

    const recordSpy = vi.spyOn(sharedSkillMutationService, 'recordSuccessfulManagedWrite');
    await hook({
      tool_name: 'Write',
      tool_input: { file_path: privatePath, content: 'updated' },
    });
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('reads disk content and calls recordSuccessfulManagedWrite on success', async () => {
    const diskContent = '---\ndescription: Updated\n---\n\nDisk state\n';
    await fs.writeFile(sharedSkillPath, diskContent, 'utf8');

    const recordSpy = vi.spyOn(sharedSkillMutationService, 'recordSuccessfulManagedWrite');
    await hook({
      tool_name: 'Write',
      tool_input: { file_path: sharedSkillPath, content: 'whatever tool thinks' },
    });
    expect(recordSpy).toHaveBeenCalledWith(sharedSkillPath, diskContent, workspaceDir);
  });

  it('skips tracking when disk read fails after write', async () => {
    const missingPath = path.join(sharedSpaceDir, 'skills', 'operations', 'ghost', 'SKILL.md');
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      makeMockSpace({ absolutePath: sharedSpaceDir, sharing: 'restricted' }),
    ]);

    const recordSpy = vi.spyOn(sharedSkillMutationService, 'recordSuccessfulManagedWrite');
    await hook({
      tool_name: 'Write',
      tool_input: { file_path: missingPath, content: 'something' },
    });
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('supports alternative file path keys (path, filePath)', async () => {
    const diskContent = await fs.readFile(sharedSkillPath, 'utf8');
    const recordSpy = vi.spyOn(sharedSkillMutationService, 'recordSuccessfulManagedWrite');

    await hook({
      tool_name: 'Write',
      tool_input: { path: sharedSkillPath, content: 'alt key' },
    });
    expect(recordSpy).toHaveBeenCalledWith(sharedSkillPath, diskContent, workspaceDir);

    recordSpy.mockClear();
    await hook({
      tool_name: 'Write',
      tool_input: { filePath: sharedSkillPath, content: 'alt key 2' },
    });
    expect(recordSpy).toHaveBeenCalledWith(sharedSkillPath, diskContent, workspaceDir);
  });
});
