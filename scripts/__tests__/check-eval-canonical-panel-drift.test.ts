import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeCurrentPolicyState,
  runEvalCanonicalPanelDriftCheck,
  writePolicyBaseline,
} from '../check-eval-canonical-panel-drift';

let tmpDir: string;
let baselinePath: string;

describe('check-eval-canonical-panel-drift', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-eval-canonical-panel-drift-'));
    baselinePath = path.join(tmpDir, '.policy-baseline.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns exit 0 when baseline matches current policy signature + version', () => {
    const current = computeCurrentPolicyState();
    writePolicyBaseline(baselinePath, current, new Date('2026-05-15T00:00:00.000Z'));

    const result = runEvalCanonicalPanelDriftCheck({ baselinePath });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('matches');
  });

  it('returns exit 1 with remediation message when baseline signature drifts', () => {
    const current = computeCurrentPolicyState();
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify({
        policySignature: `${current.policySignature}-drifted`,
        policyVersion: current.policyVersion,
        lastUpdated: '2026-05-15T00:00:00.000Z',
      }, null, 2)}\n`,
      'utf8',
    );

    const result = runEvalCanonicalPanelDriftCheck({ baselinePath });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('Canonical judge panel or ADEQUACY_POLICY_VERSION has changed');
    expect(result.message).toContain('REQUIRED ACTION before merging');
    expect(result.message).toContain('npm run eval:remediate-inadequate report');
    expect(result.message).toContain('check-eval-canonical-panel-drift.ts --update-baseline');
  });

  it('supports --update-baseline behavior and rewrites the baseline file', () => {
    const now = new Date('2026-05-15T12:34:56.000Z');
    const current = computeCurrentPolicyState();
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify({
        policySignature: 'stale-signature',
        policyVersion: 999,
        lastUpdated: '2020-01-01T00:00:00.000Z',
      }, null, 2)}\n`,
      'utf8',
    );

    const update = runEvalCanonicalPanelDriftCheck({
      baselinePath,
      updateBaseline: true,
      now,
    });
    const saved = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      policySignature: string;
      policyVersion: number;
      lastUpdated: string;
    };

    expect(update.exitCode).toBe(0);
    expect(saved.policySignature).toBe(current.policySignature);
    expect(saved.policyVersion).toBe(current.policyVersion);
    expect(saved.lastUpdated).toBe(now.toISOString());

    const verify = runEvalCanonicalPanelDriftCheck({ baselinePath });
    expect(verify.exitCode).toBe(0);
  });
});
