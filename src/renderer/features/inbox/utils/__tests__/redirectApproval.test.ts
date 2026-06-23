import { describe, expect, it, vi } from 'vitest';
import type { PendingApprovalItem } from '@renderer/features/inbox/hooks/usePendingApprovals';
import type { StagedFileItem } from '@renderer/features/inbox/hooks/useStagedFiles';
import { redirectApprovalWithInstruction, type RedirectTarget } from '../redirectApproval';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApproval(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    id: 'tool:approval-1',
    type: 'tool',
    title: 'Approval',
    description: 'Approval description',
    timestamp: 1,
    sessionId: 'session-1',
    ...overrides,
  };
}

function makeStagedFile(overrides: Partial<StagedFileItem> = {}): StagedFileItem {
  return {
    id: 'staged-file-1',
    realPath: '/tmp/file.md',
    spaceName: 'Personal',
    spacePath: 'personal',
    sessionId: 'session-1',
    baseHash: 'hash',
    summary: 'summary',
    stagedAt: 1,
    sensitivity: 'high',
    fileName: 'file.md',
    sessionTitle: 'Session',
    ...overrides,
  };
}

type DenyResult = { ok: boolean; reason?: string };

function createDeps() {
  return {
    denyApproval: vi.fn(async (_approval: PendingApprovalItem): Promise<DenyResult> => ({ ok: true })),
    denyMemoryApprovalWithoutFeedback: vi.fn(async (_approval: PendingApprovalItem): Promise<DenyResult> => ({ ok: true })),
    keepStagedFilePrivate: vi.fn(async (_id: string): Promise<DenyResult> => ({ ok: true })),
    sendMessageToSession: vi.fn(async (_sessionId: string, _message: string) => {}),
  };
}

type MockDeps = ReturnType<typeof createDeps>;

function expectNoDepsCalled(deps: MockDeps): void {
  expect(deps.denyApproval).not.toHaveBeenCalled();
  expect(deps.denyMemoryApprovalWithoutFeedback).not.toHaveBeenCalled();
  expect(deps.keepStagedFilePrivate).not.toHaveBeenCalled();
  expect(deps.sendMessageToSession).not.toHaveBeenCalled();
}

describe('redirectApprovalWithInstruction', () => {
  it('tool approval calls denyApproval then sends trimmed instruction and returns success', async () => {
    const sessionId = 'tool-session';
    const approval = makeApproval({ type: 'tool', sessionId });
    const deps = createDeps();

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: '  use the other workspace  ',
      deps,
    });

    expect(result).toEqual({ ok: true, sessionId });
    expect(deps.denyApproval).toHaveBeenCalledTimes(1);
    expect(deps.denyApproval).toHaveBeenCalledWith(approval);
    expect(deps.sendMessageToSession).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageToSession).toHaveBeenCalledWith(sessionId, 'use the other workspace');
    expect(deps.denyApproval.mock.invocationCallOrder[0]).toBeLessThan(
      deps.sendMessageToSession.mock.invocationCallOrder[0],
    );
  });

  it('staged-tool approval follows denyApproval path and does not call memory/staged-file deny deps', async () => {
    const sessionId = 'staged-tool-session';
    const approval = makeApproval({ type: 'staged-tool', sessionId });
    const deps = createDeps();

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: 'run this instead',
      deps,
    });

    expect(result).toEqual({ ok: true, sessionId });
    expect(deps.denyApproval).toHaveBeenCalledTimes(1);
    expect(deps.denyMemoryApprovalWithoutFeedback).not.toHaveBeenCalled();
    expect(deps.keepStagedFilePrivate).not.toHaveBeenCalled();
    expect(deps.sendMessageToSession).toHaveBeenCalledWith(sessionId, 'run this instead');
  });

  it('memory approval uses denyMemoryApprovalWithoutFeedback and never calls denyApproval', async () => {
    const sessionId = 'memory-session';
    const approval = makeApproval({ type: 'memory', sessionId });
    const deps = createDeps();

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: 'save this in a different space',
      deps,
    });

    expect(result).toEqual({ ok: true, sessionId });
    expect(deps.denyMemoryApprovalWithoutFeedback).toHaveBeenCalledTimes(1);
    expect(deps.denyMemoryApprovalWithoutFeedback).toHaveBeenCalledWith(approval);
    expect(deps.denyApproval).not.toHaveBeenCalled();
    expect(deps.keepStagedFilePrivate).not.toHaveBeenCalled();
    expect(deps.sendMessageToSession).toHaveBeenCalledWith(sessionId, 'save this in a different space');
  });

  it('staged-file target uses keepStagedFilePrivate then sends and does not call approval deny deps', async () => {
    const sessionId = 'staged-file-session';
    const stagedFile = makeStagedFile({ id: 'staged-file-123', sessionId });
    const deps = createDeps();

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'staged-file', stagedFile },
      instruction: 'publish this elsewhere',
      deps,
    });

    expect(result).toEqual({ ok: true, sessionId });
    expect(deps.keepStagedFilePrivate).toHaveBeenCalledTimes(1);
    expect(deps.keepStagedFilePrivate).toHaveBeenCalledWith('staged-file-123');
    expect(deps.denyApproval).not.toHaveBeenCalled();
    expect(deps.denyMemoryApprovalWithoutFeedback).not.toHaveBeenCalled();
    expect(deps.sendMessageToSession).toHaveBeenCalledWith(sessionId, 'publish this elsewhere');
  });

  it('does not call sendMessageToSession before deny resolves', async () => {
    const sessionId = 'sequencing-session';
    const approval = makeApproval({ type: 'tool', sessionId });
    const deps = createDeps();
    const denyDeferred = createDeferred<{ ok: boolean; reason?: string }>();

    deps.denyApproval.mockImplementationOnce(() => denyDeferred.promise);

    const resultPromise = redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: 'wait for deny first',
      deps,
    });

    await Promise.resolve();
    expect(deps.sendMessageToSession).not.toHaveBeenCalled();

    denyDeferred.resolve({ ok: true });
    const result = await resultPromise;

    expect(result).toEqual({ ok: true, sessionId });
    expect(deps.sendMessageToSession).toHaveBeenCalledTimes(1);
  });

  it('does not call sendMessageToSession when deny promise rejects', async () => {
    const approval = makeApproval({ type: 'tool', sessionId: 'deny-reject-session' });
    const deps = createDeps();
    const denyDeferred = createDeferred<{ ok: boolean; reason?: string }>();

    deps.denyApproval.mockImplementationOnce(() => denyDeferred.promise);

    const resultPromise = redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: 'this should not send',
      deps,
    });

    denyDeferred.reject(new Error('deny rejected'));
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, stage: 'deny', reason: 'deny rejected' });
    expect(deps.sendMessageToSession).not.toHaveBeenCalled();
  });

  it('returns deny failure when deny returns ok false with reason', async () => {
    const approval = makeApproval({ type: 'tool', sessionId: 'deny-false-session' });
    const deps = createDeps();

    deps.denyApproval.mockResolvedValueOnce({ ok: false, reason: 'nope' });

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: 'another instruction',
      deps,
    });

    expect(result).toEqual({ ok: false, stage: 'deny', reason: 'nope' });
    expect(deps.sendMessageToSession).not.toHaveBeenCalled();
  });

  it('returns deny failure with error message when deny throws', async () => {
    const stagedFile = makeStagedFile({ id: 'staged-file-deny-throw', sessionId: 'staged-deny-session' });
    const deps = createDeps();

    deps.keepStagedFilePrivate.mockRejectedValueOnce(new Error('keep-private failed'));

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'staged-file', stagedFile },
      instruction: 'redirect this file',
      deps,
    });

    expect(result).toEqual({ ok: false, stage: 'deny', reason: 'keep-private failed' });
    expect(deps.sendMessageToSession).not.toHaveBeenCalled();
  });

  it('returns send failure with sessionId when send throws after successful deny', async () => {
    const sessionId = 'send-failure-session';
    const approval = makeApproval({ type: 'tool', sessionId });
    const deps = createDeps();

    deps.sendMessageToSession.mockRejectedValueOnce(new Error('send failed'));

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: 'send me',
      deps,
    });

    expect(result).toEqual({ ok: false, stage: 'send', sessionId, error: 'send failed' });
    expect(deps.denyApproval).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageToSession).toHaveBeenCalledTimes(1);
  });

  it('extracts message from non-Error throw with a message property', async () => {
    const approval = makeApproval({ type: 'tool', sessionId: 'non-error-throw-session' });
    const deps = createDeps();

    deps.denyApproval.mockImplementationOnce(async () => {
      const plainObjectError: unknown = { message: 'plain-object error' };
      throw plainObjectError;
    });

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: 'redirect',
      deps,
    });

    expect(result).toEqual({ ok: false, stage: 'deny', reason: 'plain-object error' });
  });

  it('uses generic fallback reason when deny returns ok:false without a reason', async () => {
    const approval = makeApproval({ type: 'tool', sessionId: 'no-reason-session' });
    const deps = createDeps();

    deps.denyApproval.mockResolvedValueOnce({ ok: false });

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: 'redirect',
      deps,
    });

    expect(result).toEqual({ ok: false, stage: 'deny', reason: 'Deny failed' });
    expect(deps.sendMessageToSession).not.toHaveBeenCalled();
  });

  it('returns precondition empty-instruction for whitespace-only input and calls no deps', async () => {
    const approval = makeApproval({ type: 'tool', sessionId: 'empty-whitespace-session' });
    const deps = createDeps();

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: '   \n\t  ',
      deps,
    });

    expect(result).toEqual({ ok: false, stage: 'precondition', reason: 'empty-instruction' });
    expectNoDepsCalled(deps);
  });

  it('returns precondition empty-instruction for empty string and calls no deps', async () => {
    const approval = makeApproval({ type: 'memory', sessionId: 'empty-session' });
    const deps = createDeps();

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: '',
      deps,
    });

    expect(result).toEqual({ ok: false, stage: 'precondition', reason: 'empty-instruction' });
    expectNoDepsCalled(deps);
  });

  it('returns precondition over-length for instruction longer than default max', async () => {
    const approval = makeApproval({ type: 'tool', sessionId: 'length-session' });
    const deps = createDeps();

    const result = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval },
      instruction: 'a'.repeat(4001),
      deps,
    });

    expect(result).toEqual({ ok: false, stage: 'precondition', reason: 'over-length' });
    expectNoDepsCalled(deps);
  });

  it('returns precondition missing-session for approval and staged-file targets without sessionId', async () => {
    const approvalDeps = createDeps();
    const approvalResult = await redirectApprovalWithInstruction({
      target: { kind: 'approval', approval: makeApproval({ sessionId: null }) },
      instruction: 'approval missing session',
      deps: approvalDeps,
    });

    const stagedFileDeps = createDeps();
    const stagedFileResult = await redirectApprovalWithInstruction({
      target: {
        kind: 'staged-file',
        stagedFile: makeStagedFile({ sessionId: null as unknown as string }),
      },
      instruction: 'staged file missing session',
      deps: stagedFileDeps,
    });

    expect(approvalResult).toEqual({ ok: false, stage: 'precondition', reason: 'missing-session' });
    expect(stagedFileResult).toEqual({ ok: false, stage: 'precondition', reason: 'missing-session' });
    expectNoDepsCalled(approvalDeps);
    expectNoDepsCalled(stagedFileDeps);
  });

  it('calls exactly one deny dependency across all target-kind and approval-type combinations', async () => {
    type DenyDepKey = 'denyApproval' | 'denyMemoryApprovalWithoutFeedback' | 'keepStagedFilePrivate';
    const approvalTypes: PendingApprovalItem['type'][] = ['tool', 'staged-tool', 'memory'];
    const cases: Array<{ label: string; target: RedirectTarget; expectedDep: DenyDepKey; sessionId: string }> = [
      ...approvalTypes.map((type) => ({
        label: `approval:${type}`,
        target: {
          kind: 'approval',
          approval: makeApproval({ id: `approval-${type}`, type, sessionId: `session-${type}` }),
        } as RedirectTarget,
        expectedDep: (type === 'memory' ? 'denyMemoryApprovalWithoutFeedback' : 'denyApproval') as DenyDepKey,
        sessionId: `session-${type}`,
      })),
      ...approvalTypes.map((type) => ({
        label: `staged-file:${type}`,
        target: {
          kind: 'staged-file',
          stagedFile: makeStagedFile({ id: `staged-file-${type}`, sessionId: `staged-session-${type}` }),
        } as RedirectTarget,
        expectedDep: 'keepStagedFilePrivate' as const,
        sessionId: `staged-session-${type}`,
      })),
    ];

    for (const testCase of cases) {
      const deps = createDeps();
      const result = await redirectApprovalWithInstruction({
        target: testCase.target,
        instruction: `route-${testCase.label}`,
        deps,
      });

      expect(result).toEqual({ ok: true, sessionId: testCase.sessionId });

      const denyCounts = {
        denyApproval: deps.denyApproval.mock.calls.length,
        denyMemoryApprovalWithoutFeedback: deps.denyMemoryApprovalWithoutFeedback.mock.calls.length,
        keepStagedFilePrivate: deps.keepStagedFilePrivate.mock.calls.length,
      };

      expect(
        denyCounts.denyApproval +
        denyCounts.denyMemoryApprovalWithoutFeedback +
        denyCounts.keepStagedFilePrivate,
      ).toBe(1);
      expect(denyCounts[testCase.expectedDep]).toBe(1);
      expect(deps.sendMessageToSession).toHaveBeenCalledTimes(1);
    }
  });
});
