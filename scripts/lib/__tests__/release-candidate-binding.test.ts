import { describe, expect, it } from 'vitest';

import {
  bindCandidate,
  DEFAULT_BETA_GCS_MANIFEST_PATH,
  deriveBetaPublishedVersion,
  findDispatchedBetaRun,
  matchesBinding,
  type DispatchedBetaRun,
} from '../release-candidate-binding';
import type { ExecFn, ExecOpts, ExecResult } from '../../promote-preflight-facts';

// SAFETY: every test injects a mocked exec. No real git/gh/network is ever run.

const SHA = '428259cb83e22a32fdcc36bf538002f81fdd9fa8';
const OTHER_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER_REPO = 'mindstone/rebel-app';
const PUSH_TIME = '2026-06-21T12:00:00Z';

const PKG_AT_SHA = JSON.stringify({ name: 'mindstone-rebel', version: '0.4.49' });

type RecordingExec = ExecFn & { calls: string[]; callsWithOpts: Array<{ cmd: string; opts?: ExecOpts }> };
type GhRunListRow = {
  databaseId?: unknown;
  headSha?: unknown;
  event?: unknown;
  createdAt?: unknown;
  status?: unknown;
  conclusion?: unknown;
  displayTitle?: unknown;
};

function makeExec(rules: Array<[string, Partial<ExecResult>]>): RecordingExec {
  const calls: string[] = [];
  const callsWithOpts: Array<{ cmd: string; opts?: ExecOpts }> = [];
  const fn = ((cmd: string, opts?: ExecOpts): ExecResult => {
    calls.push(cmd);
    callsWithOpts.push({ cmd, opts });
    for (const [needle, result] of rules) {
      if (cmd.includes(needle)) {
        return { success: true, output: '', ...result };
      }
    }
    return { success: false, output: '', error: `unstubbed: ${cmd}`, exitCode: 1 };
  }) as RecordingExec;
  fn.calls = calls;
  fn.callsWithOpts = callsWithOpts;
  return fn;
}

function runRow(overrides: Partial<DispatchedBetaRun> = {}): DispatchedBetaRun {
  return {
    runId: 27803427419,
    databaseId: 27803427419,
    event: 'workflow_dispatch',
    branch: 'dev',
    headSha: SHA,
    createdAt: '2026-06-21T12:02:00Z',
    status: 'in_progress',
    conclusion: null,
    displayTitle: 'Release Build and Publish',
    ...overrides,
  };
}

function ghRunRow(overrides: GhRunListRow = {}): GhRunListRow {
  const { databaseId, headSha, event, createdAt, status, conclusion, displayTitle } = runRow();
  return {
    databaseId,
    headSha,
    event,
    createdAt,
    status,
    conclusion,
    displayTitle,
    ...overrides,
  };
}

function runList(rows: Array<DispatchedBetaRun | GhRunListRow>): string {
  return JSON.stringify(
    rows.map(({ databaseId, headSha, event, createdAt, status, conclusion, displayTitle }) => ({
      databaseId,
      headSha,
      event,
      createdAt,
      status,
      conclusion,
      displayTitle,
    }))
  );
}

function bindingRules(runListOutput = runList([runRow()])): Array<[string, Partial<ExecResult>]> {
  return [
    ['gh run list', { success: true, output: runListOutput }],
    [`git show ${SHA}:package.json`, { success: true, output: PKG_AT_SHA }],
    [`git rev-list --count ${SHA}`, { success: true, output: '4282' }],
  ];
}

function findAndBind(exec: ExecFn) {
  const found = findDispatchedBetaRun(
    { exec },
    { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: OWNER_REPO }
  );
  expect(found.kind).toBe('found');
  if (found.kind !== 'found') throw new Error('expected found');
  return bindCandidate({ exec }, { devHeadSha: SHA, releaseRun: found.run });
}

describe('deriveBetaPublishedVersion', () => {
  it('mirrors release.yml beta version concatenation', () => {
    expect(deriveBetaPublishedVersion('0.4.49', 4282)).toBe('0.4.494282');
    expect(deriveBetaPublishedVersion('0.4.0', 4282)).toBe('0.4.4282');
    expect(deriveBetaPublishedVersion('0.4.49-beta.1', 4282)).toBe('0.4.494282');
  });

  it('fails closed on versions that do not have a three-part numeric base', () => {
    expect(deriveBetaPublishedVersion('0.4', 4282)).toBeNull();
    expect(deriveBetaPublishedVersion('0.4.x', 4282)).toBeNull();
  });
});

describe('findDispatchedBetaRun', () => {
  it('finds exactly one workflow_dispatch release.yml run for the captured dev HEAD after the push', () => {
    const exec = makeExec(bindingRules());

    const result = findDispatchedBetaRun(
      { exec },
      { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: OWNER_REPO }
    );

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('expected found');
    expect(result.run).toMatchObject({
      runId: 27803427419,
      databaseId: 27803427419,
      event: 'workflow_dispatch',
      branch: 'dev',
      headSha: SHA,
      createdAt: '2026-06-21T12:02:00Z',
    });
    expect(exec.calls[0]).toBe(
      `gh run list --repo ${OWNER_REPO} --workflow release.yml --branch dev --limit 50 --json databaseId,headSha,event,createdAt,status,conclusion,displayTitle`
    );
  });

  it('skips push-event rows even when they match the captured dev HEAD', () => {
    const exec = makeExec(
      bindingRules(
        runList([
          ghRunRow({ databaseId: 27803427418, event: 'push' }),
          runRow({ databaseId: 27803427419, runId: 27803427419 }),
        ])
      )
    );

    const result = findDispatchedBetaRun(
      { exec },
      { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: OWNER_REPO }
    );

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('expected found');
    expect(result.run.databaseId).toBe(27803427419);
    expect(result.run.event).toBe('workflow_dispatch');
  });

  it('returns not-found-yet when no dispatched run exists in the post-push window', () => {
    const exec = makeExec(bindingRules(runList([runRow({ createdAt: '2026-06-21T11:59:59Z' })])));

    const result = findDispatchedBetaRun(
      { exec },
      { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: OWNER_REPO }
    );

    expect(result).toMatchObject({ kind: 'not-found-yet' });
  });

  it('blocks when gh run list exits non-zero', () => {
    const exec = makeExec([['gh run list', { success: false, output: '', error: 'nope', exitCode: 1 }]]);

    const result = findDispatchedBetaRun(
      { exec },
      { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: OWNER_REPO }
    );

    expect(result).toMatchObject({ kind: 'blocked', reason: 'gh-run-list-failed' });
  });

  it('blocks when gh run list returns invalid JSON', () => {
    const exec = makeExec(bindingRules('not json'));

    const result = findDispatchedBetaRun(
      { exec },
      { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: OWNER_REPO }
    );

    expect(result).toMatchObject({ kind: 'blocked', reason: 'gh-run-list-json' });
  });

  it('blocks when gh run list returns top-level non-array JSON', () => {
    const exec = makeExec(bindingRules(JSON.stringify({ databaseId: 27803427419 })));

    const result = findDispatchedBetaRun(
      { exec },
      { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: OWNER_REPO }
    );

    expect(result).toMatchObject({ kind: 'blocked', reason: 'gh-run-list-shape' });
  });

  it('blocks the whole gh run list call when a workflow_dispatch row is malformed', () => {
    const exec = makeExec(
      bindingRules(
        runList([
          runRow({ databaseId: 27803427419, runId: 27803427419 }),
          ghRunRow({ databaseId: 27803427420, headSha: 'not-a-canonical-sha' }),
        ])
      )
    );

    const result = findDispatchedBetaRun(
      { exec },
      { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: OWNER_REPO }
    );

    expect(result).toMatchObject({ kind: 'blocked', reason: 'gh-run-list-row-shape' });
  });

  it('blocks when more than one dispatched run matches the captured candidate', () => {
    const exec = makeExec(
      bindingRules(
        runList([
          runRow({ databaseId: 27803427419, runId: 27803427419 }),
          runRow({ databaseId: 27803427420, runId: 27803427420, createdAt: '2026-06-21T12:03:00Z' }),
        ])
      )
    );

    const result = findDispatchedBetaRun(
      { exec },
      { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: OWNER_REPO }
    );

    expect(result).toMatchObject({ kind: 'blocked', reason: 'ambiguous-dispatched-run' });
  });

  it.each([
    [
      'invalid-head-sha',
      { capturedHeadSha: 'not-a-sha', pushTimeIso: PUSH_TIME, repo: OWNER_REPO },
    ],
    [
      'invalid-repo',
      { capturedHeadSha: SHA, pushTimeIso: PUSH_TIME, repo: 'mindstone/rebel-app;echo-nope' },
    ],
    [
      'invalid-push-time',
      { capturedHeadSha: SHA, pushTimeIso: 'not-a-date', repo: OWNER_REPO },
    ],
  ])('blocks before I/O on invalid input: %s', (reason, opts) => {
    const exec = makeExec(bindingRules());

    const result = findDispatchedBetaRun({ exec }, opts);

    expect(result).toMatchObject({ kind: 'blocked', reason });
    expect(exec.calls).toEqual([]);
  });
});

describe('bindCandidate', () => {
  it('binds the dispatched run, source package version, derived beta version, and GCS manifest path', () => {
    const exec = makeExec(bindingRules());

    const result = findAndBind(exec);

    expect(result.kind).toBe('bound');
    if (result.kind !== 'bound') throw new Error('expected bound');
    expect(result.binding).toMatchObject({
      devHeadSha: SHA,
      sourcePackageVersion: '0.4.49',
      betaPublishedVersion: '0.4.494282',
      gcsManifestPath: DEFAULT_BETA_GCS_MANIFEST_PATH,
    });
    expect(result.binding.sourcePackageVersion).not.toBe(result.binding.betaPublishedVersion);
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect(Object.isFrozen(result.binding.releaseRun)).toBe(true);
  });

  it('blocks when the dispatched run head SHA drifts from the captured dev HEAD', () => {
    const exec = makeExec(bindingRules());

    const result = bindCandidate({ exec }, { devHeadSha: SHA, releaseRun: runRow({ headSha: OTHER_SHA }) });

    expect(result).toMatchObject({ kind: 'blocked', reason: 'head-sha-drift' });
  });

  it('blocks when the captured dev HEAD is malformed', () => {
    const exec = makeExec(bindingRules());

    const result = bindCandidate({ exec }, { devHeadSha: 'not-a-sha', releaseRun: runRow() });

    expect(result).toMatchObject({ kind: 'blocked', reason: 'invalid-head-sha' });
    expect(exec.calls).toEqual([]);
  });

  it('blocks when the release run is not the dispatched dev workflow run', () => {
    const exec = makeExec(bindingRules());
    const wrongRun = { ...runRow(), event: 'push' } as unknown as DispatchedBetaRun;

    const result = bindCandidate({ exec }, { devHeadSha: SHA, releaseRun: wrongRun });

    expect(result).toMatchObject({ kind: 'blocked', reason: 'wrong-release-run' });
    expect(exec.calls).toEqual([]);
  });

  it('blocks when the source package version cannot be read', () => {
    const exec = makeExec([[`git show ${SHA}:package.json`, { success: false }]]);

    const result = bindCandidate({ exec }, { devHeadSha: SHA, releaseRun: runRow() });

    expect(result).toMatchObject({ kind: 'blocked', reason: 'source-version-unavailable' });
  });

  it('blocks when the commit count cannot be read', () => {
    const exec = makeExec([
      [`git show ${SHA}:package.json`, { success: true, output: PKG_AT_SHA }],
      [`git rev-list --count ${SHA}`, { success: false }],
    ]);

    const result = bindCandidate({ exec }, { devHeadSha: SHA, releaseRun: runRow() });

    expect(result).toMatchObject({ kind: 'blocked', reason: 'commit-count-unavailable' });
  });

  it('blocks when the derived beta version cannot be computed', () => {
    const exec = makeExec([
      [`git show ${SHA}:package.json`, { success: true, output: JSON.stringify({ version: '0.4.x' }) }],
      [`git rev-list --count ${SHA}`, { success: true, output: '4282' }],
    ]);

    const result = bindCandidate({ exec }, { devHeadSha: SHA, releaseRun: runRow() });

    expect(result).toMatchObject({ kind: 'blocked', reason: 'beta-version-unavailable' });
  });
});

describe('matchesBinding', () => {
  it('matches observed candidate identity fields against the frozen binding', () => {
    const exec = makeExec(bindingRules());
    const result = findAndBind(exec);
    if (result.kind !== 'bound') throw new Error('expected bound');

    expect(
      matchesBinding(result.binding, {
        devHeadSha: SHA,
        runId: 27803427419,
        headSha: SHA,
        sourcePackageVersion: '0.4.49',
        betaPublishedVersion: '0.4.494282',
        gcsManifestVersion: '0.4.494282',
      })
    ).toEqual({ kind: 'match' });
  });

  it('blocks on head SHA drift', () => {
    const exec = makeExec(bindingRules());
    const result = findAndBind(exec);
    if (result.kind !== 'bound') throw new Error('expected bound');

    expect(matchesBinding(result.binding, { headSha: OTHER_SHA })).toMatchObject({
      kind: 'blocked',
      field: 'headSha',
      expected: SHA,
      observed: OTHER_SHA,
    });
  });

  it('blocks when latest.json reports a different beta version than the binding', () => {
    const exec = makeExec(bindingRules());
    const result = findAndBind(exec);
    if (result.kind !== 'bound') throw new Error('expected bound');

    expect(matchesBinding(result.binding, { gcsManifestVersion: '0.4.498888' })).toMatchObject({
      kind: 'blocked',
      field: 'gcsManifestVersion',
      expected: '0.4.494282',
      observed: '0.4.498888',
    });
  });

  it('blocks fail-closed when no observed candidate identity field is provided', () => {
    const exec = makeExec(bindingRules());
    const result = findAndBind(exec);
    if (result.kind !== 'bound') throw new Error('expected bound');

    expect(matchesBinding(result.binding, {})).toMatchObject({
      kind: 'blocked',
      reason: 'no-observed-fields',
    });
  });
});
