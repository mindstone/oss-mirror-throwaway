import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock sonner (required by pluginApiFactory)
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

// Mock session store
vi.mock('@renderer/features/agent-session/store/sessionStore', () => ({
  getSessionStoreState: () => ({
    sessionSummaries: [],
    togglePinSession: vi.fn(),
    toggleStarSession: vi.fn(),
    renameSession: vi.fn(),
  }),
  subscribeToSessionStore: vi.fn(),
}));

// Mock plugin permissions
const mockCheckPermission = vi.fn();
vi.mock('../pluginPermissions', () => ({
  checkPermission: (...args: unknown[]) => mockCheckPermission(...args),
  createPermissionGuard: (pluginId: string, permission: string) => {
    if (!mockCheckPermission(pluginId, permission)) {
      throw new Error(`Plugin "${pluginId}" is not authorized for "${permission}".`);
    }
  },
}));

const mockWriteSkill = vi.fn();
type MockPluginsApi = {
  writeSkill?: typeof mockWriteSkill;
};

type MockWindow = Window & typeof globalThis & {
  pluginsApi?: MockPluginsApi;
};

const mockWindow: MockWindow = {
  ...(globalThis.window ?? {}),
  pluginsApi: {
    ...(globalThis.window?.pluginsApi ?? {}),
    writeSkill: mockWriteSkill,
  },
} as unknown as MockWindow;

Object.defineProperty(globalThis, 'window', {
  value: mockWindow,
  configurable: true,
  writable: true,
});

import { _createSkillsApi, _resetSkillWriteRateLimiter } from '../pluginApiFactory';

describe('Plugin Skill Write API', () => {
  beforeEach(() => {
    mockCheckPermission.mockReset();
    mockWriteSkill.mockReset();
    _resetSkillWriteRateLimiter();
  });

  it('calls IPC with pluginId and trimmed relativePath', async () => {
    mockCheckPermission.mockReturnValue(true);
    mockWriteSkill.mockResolvedValue({ ok: true });

    const skills = _createSkillsApi('test-plugin');
    const result = await skills.write({
      relativePath: '  Chief-of-Staff/skills/daily-prep.md  ',
      content: '# Daily Prep',
      baseContentHash: 'a'.repeat(64),
    });

    expect(mockWriteSkill).toHaveBeenCalledWith({
      pluginId: 'test-plugin',
      relativePath: 'Chief-of-Staff/skills/daily-prep.md',
      content: '# Daily Prep',
      baseContentHash: 'a'.repeat(64),
    });
    expect(result).toEqual({ ok: true });
  });

  it('throws when skills:write permission is missing', async () => {
    mockCheckPermission.mockReturnValue(false);

    const skills = _createSkillsApi('no-write-plugin');
    await expect(skills.write({
      relativePath: 'Chief-of-Staff/skills/daily-prep.md',
      content: '# Daily Prep',
    })).rejects.toThrow('not authorized for "skills:write"');
  });

  it('returns validation error when relativePath is empty', async () => {
    mockCheckPermission.mockReturnValue(true);

    const skills = _createSkillsApi('test-plugin');
    const result = await skills.write({
      relativePath: '   ',
      content: '# Daily Prep',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('relativePath is required');
    expect(mockWriteSkill).not.toHaveBeenCalled();
  });

  it('enforces 5 writes/minute per plugin', async () => {
    mockCheckPermission.mockReturnValue(true);
    mockWriteSkill.mockResolvedValue({ ok: true });

    const skills = _createSkillsApi('test-plugin');

    for (let i = 0; i < 5; i += 1) {
      await skills.write({
        relativePath: `Chief-of-Staff/skills/skill-${i}.md`,
        content: '# Skill',
      });
    }

    const limitedResult = await skills.write({
      relativePath: 'Chief-of-Staff/skills/skill-6.md',
      content: '# Skill',
    });

    expect(mockWriteSkill).toHaveBeenCalledTimes(5);
    expect(limitedResult.ok).toBe(false);
    expect(limitedResult.error).toContain('Rate limit exceeded');
  });

  it('returns conflict payload from IPC', async () => {
    mockCheckPermission.mockReturnValue(true);
    mockWriteSkill.mockResolvedValue({
      ok: false,
      conflict: true,
      currentHash: 'b'.repeat(64),
    });

    const skills = _createSkillsApi('test-plugin');
    const result = await skills.write({
      relativePath: 'Chief-of-Staff/skills/daily-prep.md',
      content: '# Updated',
      baseContentHash: 'a'.repeat(64),
    });

    expect(result).toEqual({
      ok: false,
      conflict: true,
      currentHash: 'b'.repeat(64),
    });
  });

  it('returns error payload when IPC throws', async () => {
    mockCheckPermission.mockReturnValue(true);
    mockWriteSkill.mockRejectedValue(new Error('Disk write failed'));

    const skills = _createSkillsApi('test-plugin');
    const result = await skills.write({
      relativePath: 'Chief-of-Staff/skills/daily-prep.md',
      content: '# Updated',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Disk write failed',
    });
  });
});
