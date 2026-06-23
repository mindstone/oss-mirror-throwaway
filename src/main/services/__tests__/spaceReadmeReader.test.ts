import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '../spaceService';

const mockResolveSpaceByName = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('../spaceService', () => ({
  resolveSpaceByName: mockResolveSpaceByName,
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => ({
    warn: mockWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

const { readSpaceReadmesForRole } = await import('../spaceReadmeReader');

describe('readSpaceReadmesForRole', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-space-readme-reader-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves space names to paths before reading README context', async () => {
    const spaceDir = path.join(tempDir, 'Executive-Ops');
    await fs.mkdir(spaceDir, { recursive: true });
    await fs.writeFile(path.join(spaceDir, 'README.md'), '# Executive Ops\n\nTriage priorities.', 'utf-8');

    mockResolveSpaceByName.mockResolvedValueOnce({
      absolutePath: spaceDir,
      name: 'Executive Ops',
    } as SpaceInfo);

    const result = await readSpaceReadmesForRole(['Executive Ops'], '/workspace');

    expect(mockResolveSpaceByName).toHaveBeenCalledWith('Executive Ops', '/workspace');
    expect(result).toEqual([
      {
        name: 'Executive Ops',
        readme: '# Executive Ops\n\nTriage priorities.',
      },
    ]);
  });

  it('truncates README bodies to 2000 characters', async () => {
    const spaceDir = path.join(tempDir, 'Research');
    const longReadme = 'A'.repeat(2500);
    await fs.mkdir(spaceDir, { recursive: true });
    await fs.writeFile(path.join(spaceDir, 'README.md'), longReadme, 'utf-8');

    mockResolveSpaceByName.mockResolvedValueOnce({
      absolutePath: spaceDir,
      name: 'Research',
    } as SpaceInfo);

    const result = await readSpaceReadmesForRole(['Research'], '/workspace');

    expect(result).toHaveLength(1);
    expect(result[0]?.readme).toHaveLength(2000);
    expect(result[0]?.readme).toBe(longReadme.slice(0, 2000));
  });

  it('falls back to AGENTS.md when README.md is missing', async () => {
    const spaceDir = path.join(tempDir, 'Legacy-Space');
    await fs.mkdir(spaceDir, { recursive: true });
    await fs.writeFile(path.join(spaceDir, 'AGENTS.md'), '# Legacy Space\n\nStill informative.', 'utf-8');

    mockResolveSpaceByName.mockResolvedValueOnce({
      absolutePath: spaceDir,
      name: 'Legacy Space',
    } as SpaceInfo);

    const result = await readSpaceReadmesForRole(['Legacy Space'], '/workspace');

    expect(result).toEqual([
      {
        name: 'Legacy Space',
        readme: '# Legacy Space\n\nStill informative.',
      },
    ]);
  });

  it('returns an empty array when no spaces are assigned', async () => {
    const result = await readSpaceReadmesForRole([], '/workspace');

    expect(result).toEqual([]);
    expect(mockResolveSpaceByName).not.toHaveBeenCalled();
  });

  it('returns an empty array when a space cannot be resolved', async () => {
    mockResolveSpaceByName.mockResolvedValueOnce(null);

    const result = await readSpaceReadmesForRole(['Missing Space'], '/workspace');

    expect(result).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      { coreDirectory: '/workspace', spaceName: 'Missing Space' },
      'Role space could not be resolved for README context',
    );
  });
});
