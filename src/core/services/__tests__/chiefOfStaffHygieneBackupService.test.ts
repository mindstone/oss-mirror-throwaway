import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHIEF_OF_STAFF_HYGIENE_BACKUP_SCHEMA_VERSION,
  CHIEF_OF_STAFF_HYGIENE_STATE_DIR,
  createChiefOfStaffHygieneBackup,
  clearChiefOfStaffHygieneNeededMarker,
  getChiefOfStaffHygieneStateDirectory,
  markChiefOfStaffHygieneNeeded,
  readChiefOfStaffHygieneNeededMarker,
  type ChiefOfStaffHygieneRunManifest,
} from '../chiefOfStaffHygieneBackupService';
import { createReadmeHash } from '../chiefOfStaffHygieneEligibilityService';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

describe('chiefOfStaffHygieneBackupService', () => {
  let tmpDir: string;
  let coreDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-hygiene-backup-'));
    coreDir = path.join(tmpDir, 'library');
    await fs.mkdir(coreDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a non-indexed README backup and manifest without changing the README', async () => {
    const readmePath = path.join(coreDir, 'Chief-of-Staff', 'README.md');
    const readmeContent = '# Chief of Staff\n\n## Reference\nImportant detail.\n';
    await writeFile(readmePath, readmeContent);

    const result = await createChiefOfStaffHygieneBackup(coreDir, readmePath, {
      runId: 'run-1',
      now: new Date('2026-05-19T10:00:00.000Z'),
    });

    expect(result.runDirectory).toBe(
      path.join(coreDir, CHIEF_OF_STAFF_HYGIENE_STATE_DIR, 'runs', 'run-1'),
    );
    expect(result.backupPath).toBe(path.join(result.runDirectory, 'README.md.before'));
    expect(result.manifestPath).toBe(path.join(result.runDirectory, 'manifest.json'));
    expect(await fs.readFile(result.backupPath, 'utf8')).toBe(readmeContent);
    await expect(fs.readFile(readmePath, 'utf8')).resolves.toBe(readmeContent);

    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8')) as ChiefOfStaffHygieneRunManifest;
    expect(manifest).toEqual({
      schemaVersion: CHIEF_OF_STAFF_HYGIENE_BACKUP_SCHEMA_VERSION,
      runId: 'run-1',
      createdAt: '2026-05-19T10:00:00.000Z',
      originalReadmePath: 'Chief-of-Staff/README.md',
      readmeBackupPath: '.rebel/chief-of-staff-hygiene/runs/run-1/README.md.before',
      beforeHash: createReadmeHash(readmeContent),
      beforeBytes: Buffer.byteLength(readmeContent, 'utf8'),
      filesCreated: [],
      filesRewritten: [],
      sectionsMoved: [],
      skippedRiskyItems: [],
      failures: [],
    });
  });

  it('sanitizes run ids before using them as directory names', async () => {
    const readmePath = path.join(coreDir, 'Chief-of-Staff', 'README.md');
    await writeFile(readmePath, '# Chief of Staff\n');

    const result = await createChiefOfStaffHygieneBackup(coreDir, readmePath, {
      runId: '../bad/run',
    });

    expect(result.manifest.runId).toBe('../bad/run');
    expect(result.runDirectory).toBe(
      path.join(coreDir, CHIEF_OF_STAFF_HYGIENE_STATE_DIR, 'runs', '..-bad-run'),
    );
  });

  it('does not allow dot-only run ids to collapse the per-run directory', async () => {
    const readmePath = path.join(coreDir, 'Chief-of-Staff', 'README.md');
    await writeFile(readmePath, '# Chief of Staff\n');

    const result = await createChiefOfStaffHygieneBackup(coreDir, readmePath, {
      runId: '..',
    });

    const runDirectoryName = path.basename(result.runDirectory);
    expect(runDirectoryName).toMatch(/^run-/);
    expect(result.runDirectory).toContain(path.join(CHIEF_OF_STAFF_HYGIENE_STATE_DIR, 'runs'));
    expect(result.runDirectory).not.toBe(path.join(coreDir, CHIEF_OF_STAFF_HYGIENE_STATE_DIR));
  });

  it('rejects targets outside the workspace or non-README files', async () => {
    const outsideReadme = path.join(tmpDir, 'outside', 'README.md');
    const nonReadme = path.join(coreDir, 'Chief-of-Staff', 'notes.md');
    await writeFile(outsideReadme, '# Outside\n');
    await writeFile(nonReadme, 'notes');

    await expect(createChiefOfStaffHygieneBackup(coreDir, outsideReadme)).rejects.toThrow(
      'must stay inside the workspace',
    );
    await expect(createChiefOfStaffHygieneBackup(coreDir, nonReadme)).rejects.toThrow(
      'must be a README.md file',
    );
  });

  it('rejects README backup targets that traverse symlinks', async () => {
    const outsideDir = path.join(tmpDir, 'outside-chief');
    await writeFile(path.join(outsideDir, 'README.md'), '# Outside\n');
    const linkedDir = path.join(coreDir, 'Chief-of-Staff');
    try {
      await fs.symlink(outsideDir, linkedDir, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }

    await expect(createChiefOfStaffHygieneBackup(coreDir, path.join(linkedDir, 'README.md'))).rejects.toThrow(
      'must not traverse symlinks',
    );
  });

  it('exposes the hidden state directory used for backups and manifests', () => {
    expect(getChiefOfStaffHygieneStateDirectory(coreDir)).toBe(
      path.join(coreDir, '.rebel', 'chief-of-staff-hygiene'),
    );
  });

  it('records and clears lightweight needed markers outside indexed memory', async () => {
    await markChiefOfStaffHygieneNeeded(coreDir, {
      createdAt: '2026-05-19T10:00:00.000Z',
      reason: 'chief_of_staff_readme_memory_write',
      readmePath: 'Chief-of-Staff/README.md',
    });

    await expect(readChiefOfStaffHygieneNeededMarker(coreDir)).resolves.toEqual({
      createdAt: '2026-05-19T10:00:00.000Z',
      reason: 'chief_of_staff_readme_memory_write',
      readmePath: 'Chief-of-Staff/README.md',
    });

    await clearChiefOfStaffHygieneNeededMarker(coreDir);
    await expect(readChiefOfStaffHygieneNeededMarker(coreDir)).resolves.toBeNull();
  });

});
