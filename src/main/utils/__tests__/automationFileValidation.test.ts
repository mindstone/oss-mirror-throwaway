import { describe, it, expect, vi } from 'vitest';
import type { Stats } from 'node:fs';
import type { ValidationDeps } from '../automationFileValidation';

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

 
vi.mock('../../services/systemSettingsSync', () => ({
  getSystemSettingsPath: vi.fn(),
}));
 
vi.mock('../systemUtils', () => ({
  resolveLibraryPath: vi.fn(),
  isPathInsideLexical: vi.fn(),
}));

import { validateAutomationFilePath } from '../automationFileValidation';

const CORE_DIR = '/workspace';

/** Helper: create a mock stat result */
const fileStat = (): Stats => ({ isFile: () => true, isDirectory: () => false }) as unknown as Stats;
const dirStat = (): Stats => ({ isFile: () => false, isDirectory: () => true }) as unknown as Stats;

/** Helper: build test deps */
function makeDeps(overrides: Partial<ValidationDeps> = {}): ValidationDeps {
  return {
    resolveLibraryPath: vi.fn().mockReturnValue({ root: CORE_DIR, resolved: '/workspace/test.md' }),
    isPathInsideLexical: vi.fn().mockReturnValue(true),
    getSystemSettingsPath: vi.fn().mockReturnValue('/mock/system-settings'),
    stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
    ...overrides,
  } as ValidationDeps;
}

describe('validateAutomationFilePath', () => {
  it('passes for an existing file', async () => {
    const deps = makeDeps({
      resolveLibraryPath: vi.fn().mockReturnValue({
        root: CORE_DIR,
        resolved: '/workspace/skills/my-skill.md',
      }),
      stat: vi.fn().mockResolvedValue(fileStat()),
    });

    await expect(
      validateAutomationFilePath('skills/my-skill.md', CORE_DIR, deps)
    ).resolves.toBeUndefined();
  });

  it('passes for a directory containing SKILL.md', async () => {
    const mockStat = vi.fn()
      .mockResolvedValueOnce(dirStat())   // directory itself
      .mockResolvedValueOnce(fileStat()); // SKILL.md inside
    const deps = makeDeps({
      resolveLibraryPath: vi.fn().mockReturnValue({
        root: CORE_DIR,
        resolved: '/workspace/skills/my-skill',
      }),
      stat: mockStat as unknown as typeof import('node:fs/promises').stat,
    });

    await expect(
      validateAutomationFilePath('skills/my-skill', CORE_DIR, deps)
    ).resolves.toBeUndefined();
  });

  it('throws for a non-existent file', async () => {
    const deps = makeDeps({
      resolveLibraryPath: vi.fn().mockReturnValue({
        root: CORE_DIR,
        resolved: '/workspace/skills/missing.md',
      }),
      stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
    });

    await expect(
      validateAutomationFilePath('skills/missing.md', CORE_DIR, deps)
    ).rejects.toThrow('could not be found');
  });

  it('throws for a directory without SKILL.md', async () => {
    const mockStat = vi.fn()
      .mockResolvedValueOnce(dirStat())            // directory exists
      .mockRejectedValueOnce(new Error('ENOENT')); // no SKILL.md
    const deps = makeDeps({
      resolveLibraryPath: vi.fn().mockReturnValue({
        root: CORE_DIR,
        resolved: '/workspace/skills/empty-dir',
      }),
      stat: mockStat as unknown as typeof import('node:fs/promises').stat,
    });

    await expect(
      validateAutomationFilePath('skills/empty-dir', CORE_DIR, deps)
    ).rejects.toThrow('directory without a SKILL.md');
  });

  it('passes for rebel-system/ path resolved via fallback', async () => {
    const mockStat = vi.fn()
      .mockRejectedValueOnce(new Error('ENOENT'))  // primary path not found
      .mockResolvedValueOnce(fileStat());           // fallback found
    const deps = makeDeps({
      resolveLibraryPath: vi.fn().mockReturnValue({
        root: CORE_DIR,
        resolved: '/workspace/rebel-system/skills/daily-brief/SKILL.md',
      }),
      stat: mockStat as unknown as typeof import('node:fs/promises').stat,
    });

    await expect(
      validateAutomationFilePath('rebel-system/skills/daily-brief/SKILL.md', CORE_DIR, deps)
    ).resolves.toBeUndefined();
  });

  it('passes for rebel-system/ directory fallback with SKILL.md', async () => {
    const mockStat = vi.fn()
      .mockRejectedValueOnce(new Error('ENOENT'))  // primary path not found
      .mockResolvedValueOnce(dirStat())             // fallback is a directory
      .mockResolvedValueOnce(fileStat());           // fallback SKILL.md exists
    const deps = makeDeps({
      resolveLibraryPath: vi.fn().mockReturnValue({
        root: CORE_DIR,
        resolved: '/workspace/rebel-system/skills/daily-brief',
      }),
      stat: mockStat as unknown as typeof import('node:fs/promises').stat,
    });

    await expect(
      validateAutomationFilePath('rebel-system/skills/daily-brief', CORE_DIR, deps)
    ).resolves.toBeUndefined();
  });

  it('throws for rebel-system/ path that escapes system settings', async () => {
    const deps = makeDeps({
      resolveLibraryPath: vi.fn().mockReturnValue({
        root: CORE_DIR,
        resolved: '/workspace/rebel-system/../../etc/passwd',
      }),
      stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
      isPathInsideLexical: vi.fn().mockReturnValue(false),
    });

    await expect(
      validateAutomationFilePath('rebel-system/../../etc/passwd', CORE_DIR, deps)
    ).rejects.toThrow('escapes system settings');
  });

  it('throws when resolveLibraryPath throws (path outside workspace)', async () => {
    const deps = makeDeps({
      resolveLibraryPath: vi.fn().mockImplementation(() => {
        throw new Error('Access to paths outside the workspace directory is not permitted.');
      }),
    });

    await expect(
      validateAutomationFilePath('/etc/passwd', CORE_DIR, deps)
    ).rejects.toThrow('outside the workspace');
  });
});
