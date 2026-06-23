import { describe, expect, it } from 'vitest';

import type { ValidateWorkspaceAccessResponse } from '@shared/ipc/channels/health';
import {
  workspaceAccessStateFromErrno,
  workspaceAccessStateFromResponse,
} from '../workspaceAccessState';

describe('workspaceAccessStateFromResponse', () => {
  it('maps an accessible response to accessible state', () => {
    expect(workspaceAccessStateFromResponse({ accessible: true })).toMatchObject({
      status: 'accessible',
    });
  });

  it('carries accessible response fields', () => {
    expect(
      workspaceAccessStateFromResponse({
        accessible: true,
        resolvedPath: '/tmp/workspace',
        created: true,
      }),
    ).toEqual({
      status: 'accessible',
      resolvedPath: '/tmp/workspace',
      created: true,
    });
  });

  it.each([
    ['EACCES' as const],
    ['EPERM' as const],
  ])('maps %s to denied state and carries the narrowed code', (code) => {
    const state = workspaceAccessStateFromResponse({
      accessible: false,
      code,
      error: 'permission denied',
      resolvedPath: '/tmp/workspace',
    });

    expect(state).toEqual({
      status: 'denied',
      code,
      error: 'permission denied',
      resolvedPath: '/tmp/workspace',
    });

    if (state.status === 'denied') {
      const deniedCode: 'EACCES' | 'EPERM' = state.code;
      expect(deniedCode).toBe(code);
    }
  });

  it.each([
    [{ accessible: false, code: 'ENOENT' }, 'ENOENT'],
    [{ accessible: false, code: 'HANDLER_ERROR' }, 'HANDLER_ERROR'],
    [{ accessible: false, code: 'EBUSY' }, 'EBUSY'],
    [{ accessible: false }, undefined],
  ] satisfies Array<[ValidateWorkspaceAccessResponse, string | undefined]>)(
    'maps non-accessible response code %s to invalid state',
    (response, expectedCode) => {
      expect(workspaceAccessStateFromResponse(response)).toMatchObject({
        status: 'invalid',
        code: expectedCode,
      });
    },
  );
});

describe('workspaceAccessStateFromErrno', () => {
  it.each([
    ['EACCES' as const],
    ['EPERM' as const],
  ])('maps startup errno %s to denied and carries the narrowed code', (code) => {
    const state = workspaceAccessStateFromErrno(code);

    expect(state).toEqual({ status: 'denied', code });

    if (state.status === 'denied') {
      const deniedCode: 'EACCES' | 'EPERM' = state.code;
      expect(deniedCode).toBe(code);
    }
  });

  it.each([
    ['ENOENT', 'ENOENT'],
    ['EBUSY', 'EBUSY'],
    [undefined, undefined],
  ] satisfies Array<[string | undefined, string | undefined]>)(
    'maps startup errno %s to missing',
    (code, expectedCode) => {
      expect(workspaceAccessStateFromErrno(code)).toEqual({
        status: 'missing',
        code: expectedCode,
      });
    },
  );
});
