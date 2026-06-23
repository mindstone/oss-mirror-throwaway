import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import {
  markChiefOfStaffHygieneNeeded,
  readChiefOfStaffHygieneNeededMarker,
} from '../chiefOfStaffHygieneBackupService';
import {
  resolveChiefOfStaffReadmePath,
  runChiefOfStaffHygieneCheck,
} from '../chiefOfStaffHygieneRunnerService';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: null,
    spaces: [],
    ...overrides,
  } as AppSettings;
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

describe('chiefOfStaffHygieneRunnerService', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-hygiene-runner-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves the configured Chief-of-Staff README from settings', async () => {
    const readmePath = path.join(tmpDir, 'Private Brain', 'README.md');
    await writeFile(readmePath, '# Chief of Staff\n');

    const resolved = await resolveChiefOfStaffReadmePath(
      tmpDir,
      makeSettings({
        spaces: [
          {
            name: 'Private Brain',
            path: 'Private Brain',
            type: 'chief-of-staff',
            isSymlink: false,
            createdAt: 0,
          },
        ],
      }),
    );

    expect(resolved).toBe(readmePath);
  });

  it('falls back to the conventional Chief-of-Staff directory', async () => {
    const readmePath = path.join(tmpDir, 'Chief-of-Staff', 'README.md');
    await writeFile(readmePath, '# Chief of Staff\n');

    await expect(resolveChiefOfStaffReadmePath(tmpDir, makeSettings())).resolves.toBe(readmePath);
  });

  it('rejects configured Chief-of-Staff paths outside the workspace before reading', async () => {
    const outsideReadmePath = path.join(tmpDir, 'Outside', 'README.md');
    await writeFile(outsideReadmePath, '# Outside\n');
    await expect(resolveChiefOfStaffReadmePath(
      path.join(tmpDir, 'workspace'),
      makeSettings({
        spaces: [
          {
            name: 'Chief-of-Staff',
            path: '../Outside',
            type: 'chief-of-staff',
            isSymlink: false,
            createdAt: 0,
          },
        ],
      }),
    )).resolves.toBeNull();
  });

  it('skips configured symlink Chief-of-Staff spaces until the rewrite policy is defined', async () => {
    const readmePath = path.join(tmpDir, 'Linked Chief', 'README.md');
    await writeFile(readmePath, '# Chief of Staff\n');

    await expect(resolveChiefOfStaffReadmePath(
      tmpDir,
      makeSettings({
        spaces: [
          {
            name: 'Linked Chief',
            path: 'Linked Chief',
            type: 'chief-of-staff',
            isSymlink: true,
            createdAt: 0,
          },
        ],
      }),
    )).resolves.toBeNull();
  });

  it('skips configured Chief-of-Staff paths that are symlinks on disk even with stale metadata', async () => {
    const outsideDir = path.join(tmpDir, 'outside-configured-chief');
    await writeFile(path.join(outsideDir, 'README.md'), '# Outside Chief\n');
    const configuredPath = path.join(tmpDir, 'Configured Chief');
    try {
      await fs.symlink(outsideDir, configuredPath, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }

    await expect(resolveChiefOfStaffReadmePath(
      tmpDir,
      makeSettings({
        spaces: [
          {
            name: 'Configured Chief',
            path: 'Configured Chief',
            type: 'chief-of-staff',
            isSymlink: false,
            createdAt: 0,
          },
        ],
      }),
    )).resolves.toBeNull();
  });

  it('skips conventional Chief-of-Staff symlink directories until the rewrite policy is defined', async () => {
    const outsideDir = path.join(tmpDir, 'outside-chief');
    await writeFile(path.join(outsideDir, 'README.md'), '# Outside Chief\n');
    await fs.mkdir(tmpDir, { recursive: true });
    try {
      await fs.symlink(outsideDir, path.join(tmpDir, 'Chief-of-Staff'), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }

    await expect(resolveChiefOfStaffReadmePath(tmpDir, makeSettings())).resolves.toBeNull();
  });

  it('skips conventional Chief-of-Staff symlink README files until the rewrite policy is defined', async () => {
    const outsideReadme = path.join(tmpDir, 'outside-readme.md');
    await writeFile(outsideReadme, '# Outside Chief\n');
    const chiefDir = path.join(tmpDir, 'Chief-of-Staff');
    await fs.mkdir(chiefDir, { recursive: true });
    try {
      await fs.symlink(outsideReadme, path.join(chiefDir, 'README.md'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }

    await expect(resolveChiefOfStaffReadmePath(tmpDir, makeSettings())).resolves.toBeNull();
  });

  it('returns a no-op result for a healthy README without modifying it', async () => {
    const readmePath = path.join(tmpDir, 'Chief-of-Staff', 'README.md');
    const readme = `# Chief of Staff

## Profile
Stable context.
`;
    await writeFile(readmePath, readme);

    const result = await runChiefOfStaffHygieneCheck(tmpDir, makeSettings());

    expect(result.skippedReason).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.eligibility?.eligible).toBe(false);
    expect(result.eligibility?.noOpReason).toBe('healthy');
    expect(result.rewrite).toBeNull();
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toBe(readme);
  });

  it('rewrites automatic-safe sections when README health thresholds fire', async () => {
    const readmePath = path.join(tmpDir, 'Chief-of-Staff', 'README.md');
    await writeFile(readmePath, `# Chief of Staff

## Reference
${'Long detailed note. '.repeat(800)}
`);

    const result = await runChiefOfStaffHygieneCheck(tmpDir, makeSettings());

    expect(result.readmePath).toBe(readmePath);
    expect(result.eligibility?.eligible).toBe(true);
    expect(result.eligibility?.triggerReasons).toContain('readme_size_exceeded');
    expect(result.rewrite?.changed).toBe(true);
    expect(result.rewrite?.afterBytes).toEqual(expect.any(Number));
    expect(result.rewrite?.sectionsMoved).toEqual([
      expect.objectContaining({ heading: 'Reference' }),
    ]);
    expect(result.errors).toEqual([]);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain(
      'See `memory/topics/auto-hygiene/reference.md` for the detailed Reference notes.',
    );
  });

  it('clears post-write markers after the next safe rewrite', async () => {
    const readmePath = path.join(tmpDir, 'Chief-of-Staff', 'README.md');
    await writeFile(readmePath, `# Chief of Staff

## Reference
${'First long detailed note. '.repeat(800)}
`);

    const first = await runChiefOfStaffHygieneCheck(tmpDir, makeSettings(), {
      now: new Date('2026-05-19T10:00:00.000Z'),
    });
    expect(first.rewrite?.changed).toBe(true);

    await writeFile(readmePath, `# Chief of Staff

## Reference
${'Second long detailed note. '.repeat(800)}
`);
    await markChiefOfStaffHygieneNeeded(tmpDir, {
      createdAt: '2026-05-20T10:00:00.000Z',
      reason: 'chief_of_staff_readme_memory_write',
      readmePath: 'Chief-of-Staff/README.md',
    });

    const nextRun = await runChiefOfStaffHygieneCheck(tmpDir, makeSettings(), {
      now: new Date('2026-05-20T10:00:00.000Z'),
    });
    expect(nextRun.eligibility?.eligible).toBe(true);
    expect(nextRun.rewrite?.changed).toBe(true);
    await expect(readChiefOfStaffHygieneNeededMarker(tmpDir)).resolves.toBeNull();
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toContain(
      'See `memory/topics/auto-hygiene/reference',
    );
  });

  it('skips when no workspace or Chief-of-Staff README is available', async () => {
    await expect(runChiefOfStaffHygieneCheck(null, makeSettings())).resolves.toMatchObject({
      readmePath: null,
      eligibility: null,
      rewrite: null,
      skippedReason: 'workspace_not_configured',
      errors: [],
    });

    await expect(runChiefOfStaffHygieneCheck(tmpDir, makeSettings())).resolves.toMatchObject({
      readmePath: null,
      eligibility: null,
      rewrite: null,
      skippedReason: 'chief_of_staff_not_found',
      errors: [],
    });
  });
});
