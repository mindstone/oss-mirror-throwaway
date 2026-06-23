import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionOutcome } from '../session-manager.ts';
import { trySnapshotPlanFile } from '../session-manager.ts';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-plan-snapshot-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeOutcome(planFile: string | undefined): SessionOutcome {
  return {
    outcome: 'plan_created',
    sentry_id: 'SENTRY-SNAP',
    confidence: 80,
    plan_file: planFile,
  };
}

describe('trySnapshotPlanFile', () => {
  it('snapshots a CE2-native plan_file from the worktree to <artifactDir>/plan.md', () => {
    const worktreePath = createTempDir();
    const artifactDir = createTempDir();
    const slug = '260605_my-fix';
    const planRelPath = `docs/plans/${slug}/PLAN.md`;
    const planAbsPath = path.join(worktreePath, planRelPath);
    fs.mkdirSync(path.dirname(planAbsPath), { recursive: true });
    fs.writeFileSync(planAbsPath, '# CE2-native plan\n\nSome content.\n');

    trySnapshotPlanFile(makeOutcome(planRelPath), worktreePath, artifactDir);

    const snapshot = path.join(artifactDir, 'plan.md');
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(fs.readFileSync(snapshot, 'utf8')).toBe('# CE2-native plan\n\nSome content.\n');
  });

  it('snapshots the legacy plan.md shape when the worktree contains it', () => {
    const worktreePath = createTempDir();
    const artifactDir = createTempDir();
    fs.writeFileSync(path.join(worktreePath, 'plan.md'), '# legacy plan\n');

    trySnapshotPlanFile(makeOutcome('plan.md'), worktreePath, artifactDir);

    expect(fs.readFileSync(path.join(artifactDir, 'plan.md'), 'utf8')).toBe('# legacy plan\n');
  });

  it('no-ops when the source file does not exist in the worktree', () => {
    const worktreePath = createTempDir();
    const artifactDir = createTempDir();

    trySnapshotPlanFile(makeOutcome('docs/plans/missing/PLAN.md'), worktreePath, artifactDir);

    expect(fs.existsSync(path.join(artifactDir, 'plan.md'))).toBe(false);
  });

  it('does not overwrite an existing artifact-dir plan.md when the source is missing', () => {
    const worktreePath = createTempDir();
    const artifactDir = createTempDir();
    fs.writeFileSync(path.join(artifactDir, 'plan.md'), '# previous\n');

    trySnapshotPlanFile(makeOutcome('docs/plans/missing/PLAN.md'), worktreePath, artifactDir);

    expect(fs.readFileSync(path.join(artifactDir, 'plan.md'), 'utf8')).toBe('# previous\n');
  });

  it('no-ops when plan_file is absent on the outcome', () => {
    const worktreePath = createTempDir();
    const artifactDir = createTempDir();

    trySnapshotPlanFile(makeOutcome(undefined), worktreePath, artifactDir);

    expect(fs.existsSync(path.join(artifactDir, 'plan.md'))).toBe(false);
  });

  it('no-ops when plan_file is an absolute path', () => {
    const worktreePath = createTempDir();
    const artifactDir = createTempDir();
    const absolutePlan = path.join(createTempDir(), 'PLAN.md');
    fs.writeFileSync(absolutePlan, '# absolute\n');

    trySnapshotPlanFile(makeOutcome(absolutePlan), worktreePath, artifactDir);

    expect(fs.existsSync(path.join(artifactDir, 'plan.md'))).toBe(false);
  });

  it('no-ops when worktreePath is empty', () => {
    const artifactDir = createTempDir();

    trySnapshotPlanFile(makeOutcome('docs/plans/x/PLAN.md'), '', artifactDir);

    expect(fs.existsSync(path.join(artifactDir, 'plan.md'))).toBe(false);
  });

  it('creates the artifact dir if it does not yet exist', () => {
    const worktreePath = createTempDir();
    const stateDir = createTempDir();
    const artifactDir = path.join(stateDir, 'artifacts', 'NEW-SENTRY-ID');
    expect(fs.existsSync(artifactDir)).toBe(false);
    fs.mkdirSync(path.join(worktreePath, 'docs', 'plans', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'docs', 'plans', 'foo', 'PLAN.md'), 'fresh\n');

    trySnapshotPlanFile(makeOutcome('docs/plans/foo/PLAN.md'), worktreePath, artifactDir);

    expect(fs.readFileSync(path.join(artifactDir, 'plan.md'), 'utf8')).toBe('fresh\n');
  });
});
