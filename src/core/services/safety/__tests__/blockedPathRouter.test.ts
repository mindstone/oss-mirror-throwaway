import { describe, expect, it } from 'vitest';

import { assertNever } from '@shared/utils/assertNever';

import {
  classifyBlockedPathDisposition,
  type BlockedPathDisposition,
} from '../blockedPathRouter';

const completeDispositionMap = {
  fileWrite: true,
  failClosed: true,
  genericApproval: true,
  mcpStaging: true,
  hardDeny: true,
} satisfies Record<BlockedPathDisposition, true>;

function intentionallyMissingHardDeny(disposition: BlockedPathDisposition): string {
  switch (disposition) {
    case 'fileWrite':
    case 'failClosed':
    case 'genericApproval':
    case 'mcpStaging':
      return disposition;
    default:
      // @ts-expect-error hardDeny is deliberately unhandled to prove assertNever catches missing cases.
      return assertNever(disposition, 'BlockedPathDisposition test');
  }
}

describe('classifyBlockedPathDisposition', () => {
  it('classifies each disposition', () => {
    expect(
      classifyBlockedPathDisposition({
        isFileWriteTool: true,
        isFailClosed: false,
        hasGenericApprovalResult: false,
        canUseStagingPath: false,
      }),
    ).toBe('fileWrite');

    expect(
      classifyBlockedPathDisposition({
        isFileWriteTool: false,
        isFailClosed: true,
        hasGenericApprovalResult: false,
        canUseStagingPath: false,
      }),
    ).toBe('failClosed');

    expect(
      classifyBlockedPathDisposition({
        isFileWriteTool: false,
        isFailClosed: false,
        hasGenericApprovalResult: true,
        canUseStagingPath: false,
      }),
    ).toBe('genericApproval');

    expect(
      classifyBlockedPathDisposition({
        isFileWriteTool: false,
        isFailClosed: false,
        hasGenericApprovalResult: false,
        canUseStagingPath: true,
      }),
    ).toBe('mcpStaging');

    expect(
      classifyBlockedPathDisposition({
        isFileWriteTool: false,
        isFailClosed: false,
        hasGenericApprovalResult: false,
        canUseStagingPath: false,
      }),
    ).toBe('hardDeny');
  });

  it('preserves blocked-path precedence', () => {
    expect(
      classifyBlockedPathDisposition({
        isFileWriteTool: true,
        isFailClosed: true,
        hasGenericApprovalResult: true,
        canUseStagingPath: true,
      }),
    ).toBe('fileWrite');

    expect(
      classifyBlockedPathDisposition({
        isFileWriteTool: false,
        isFailClosed: true,
        hasGenericApprovalResult: true,
        canUseStagingPath: true,
      }),
    ).toBe('failClosed');

    expect(
      classifyBlockedPathDisposition({
        isFileWriteTool: false,
        isFailClosed: false,
        hasGenericApprovalResult: true,
        canUseStagingPath: true,
      }),
    ).toBe('genericApproval');

    expect(
      classifyBlockedPathDisposition({
        isFileWriteTool: false,
        isFailClosed: false,
        hasGenericApprovalResult: false,
        canUseStagingPath: true,
      }),
    ).toBe('mcpStaging');
  });

  it('keeps disposition handling compile-time exhaustive', () => {
    expect(Object.keys(completeDispositionMap).sort()).toEqual([
      'failClosed',
      'fileWrite',
      'genericApproval',
      'hardDeny',
      'mcpStaging',
    ]);
    expect(intentionallyMissingHardDeny('fileWrite')).toBe('fileWrite');
  });
});
