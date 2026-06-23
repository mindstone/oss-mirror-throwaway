/**
 * Tests for `resolveLink` — parser + space resolution → NavigationAction.
 *
 * Uses in-memory SpaceResolver stubs; no Electron / IPC / filesystem deps.
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage C.
 */

import { describe, expect, it } from 'vitest';

import type { SpaceResolver } from '../boundaries';
import { NullSpaceResolver } from '../boundaries';
import { resolveLink } from '../resolveLink';

function makeResolver(overrides: Partial<SpaceResolver> = {}): SpaceResolver {
  return { ...NullSpaceResolver, ...overrides };
}

describe('resolveLink — non-space targets', () => {
  it('maps rebel://home to open-home', async () => {
    const action = await resolveLink('rebel://home', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-home' });
  });

  it('maps rebel://conversation/{id} to open-session', async () => {
    const action = await resolveLink('rebel://conversation/abc123', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-session', sessionId: 'abc123' });
  });

  it('maps bare rebel://sessions to open-session-surface', async () => {
    const action = await resolveLink('rebel://sessions', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-session-surface' });
  });

  it('maps rebel://chat/from-dashboard token links to open-seeded-chat', async () => {
    const action = await resolveLink('rebel://chat/from-dashboard?token=abc123', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-seeded-chat', token: 'abc123' });
  });

  it('rejects dashboard chat links without a token', async () => {
    const action = await resolveLink('rebel://chat/from-dashboard', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toMatchObject({ kind: 'error', code: 'invalid-url' });
  });

  it('maps rebel://settings/{tab}#{section} to open-settings', async () => {
    const action = await resolveLink('rebel://settings/agents#voiceAudio', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-settings', tab: 'agents', section: 'voiceAudio' });
  });

  it('maps rebel://library/{path} to open-library-file', async () => {
    const action = await resolveLink('rebel://library/docs/intro.md', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-library-file', relativePath: 'docs/intro.md' });
  });

  it('maps rebel://library/{folder}?type=folder to open-library-folder', async () => {
    const action = await resolveLink('rebel://library/docs?type=folder', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-library-folder', relativePath: 'docs' });
  });

  it('maps bare rebel://library to open-library-root', async () => {
    const action = await resolveLink('rebel://library', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-library-root' });
  });

  it('maps rebel://tasks to open-tasks (no focus)', async () => {
    const action = await resolveLink('rebel://tasks', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-tasks', focusApprovalId: undefined });
  });

  it('maps rebel://tasks/{id} to open-tasks with focusApprovalId', async () => {
    const action = await resolveLink('rebel://tasks/approval_abc', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-tasks', focusApprovalId: 'approval_abc' });
  });

  it('maps rebel://insights/{turnId} to open-insights', async () => {
    const action = await resolveLink('rebel://insights/turn_xyz', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-insights', turnId: 'turn_xyz' });
  });

  it('maps rebel://action/{verb} to invoke-action', async () => {
    const action = await resolveLink('rebel://action/start-voice', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'invoke-action', action: 'start-voice', params: undefined });
  });

  it('preserves legacy three-slash action URLs', async () => {
    const action = await resolveLink('rebel:///start-voice', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'invoke-action', action: 'start-voice', params: undefined });
  });

  it('maps rebel://automations to open-automations', async () => {
    const action = await resolveLink('rebel://automations', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-automations', automationId: undefined });
  });

  it('maps rebel://usecases/{id} to open-usecases', async () => {
    const action = await resolveLink('rebel://usecases/uc1', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-usecases', useCaseId: 'uc1' });
  });

  it('maps rebel://team/{roleId} to open-team', async () => {
    const action = await resolveLink('rebel://team/coach', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-team', roleId: 'coach' });
  });

  it('maps rebel://focus to open-focus', async () => {
    const action = await resolveLink('rebel://focus', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toEqual({ kind: 'open-focus', lens: undefined });
  });

  it('accepts a pre-parsed NavigationTarget', async () => {
    const action = await resolveLink(
      { type: 'sessions', sessionId: 'sess1' },
      { spaceResolver: NullSpaceResolver },
    );
    expect(action).toEqual({ kind: 'open-session', sessionId: 'sess1' });
  });
});

describe('resolveLink — space targets', () => {
  it('returns open-library-file on successful space file resolution', async () => {
    const resolver = makeResolver({
      resolveSpaceLink: async () => ({ ok: true, workspaceRelativePath: 'Exec/memory/Q1.md' }),
    });
    const action = await resolveLink('rebel://space/Exec/memory/Q1.md', {
      spaceResolver: resolver,
    });
    expect(action).toEqual({ kind: 'open-library-file', relativePath: 'Exec/memory/Q1.md' });
  });

  it('returns open-library-folder on successful space folder resolution', async () => {
    const resolver = makeResolver({
      resolveSpaceLink: async () => ({ ok: true, workspaceRelativePath: 'Exec/memory' }),
    });
    const action = await resolveLink('rebel://space/Exec/memory?type=folder', {
      spaceResolver: resolver,
    });
    expect(action).toEqual({ kind: 'open-library-folder', relativePath: 'Exec/memory' });
  });

  it('returns open-library-folder for bare space root', async () => {
    const resolver = makeResolver({
      resolveSpaceLink: async () => ({ ok: true, workspaceRelativePath: 'Exec' }),
    });
    const action = await resolveLink('rebel://space/Exec', {
      spaceResolver: resolver,
    });
    expect(action).toEqual({ kind: 'open-library-folder', relativePath: 'Exec' });
  });

  it('surfaces space-not-found as typed error action', async () => {
    const resolver = makeResolver({
      resolveSpaceLink: async () => ({ ok: false, error: 'space-not-found' }),
    });
    const action = await resolveLink('rebel://space/Missing/a.md', {
      spaceResolver: resolver,
    });
    expect(action).toMatchObject({ kind: 'error', code: 'space-not-found' });
    if (action.kind === 'error') {
      expect(action.source).toBe('rebel://space/Missing/a.md');
    }
  });

  it('surfaces file-not-found as typed error action', async () => {
    const resolver = makeResolver({
      resolveSpaceLink: async () => ({ ok: false, error: 'file-not-found' }),
    });
    const action = await resolveLink('rebel://space/Exec/absent.md', {
      spaceResolver: resolver,
    });
    expect(action).toMatchObject({ kind: 'error', code: 'file-not-found' });
  });

  it('surfaces path-invalid as typed error action', async () => {
    const resolver = makeResolver({
      resolveSpaceLink: async () => ({ ok: false, error: 'path-invalid' }),
    });
    const action = await resolveLink('rebel://space/Exec/weird', {
      spaceResolver: resolver,
    });
    expect(action).toMatchObject({ kind: 'error', code: 'path-invalid' });
  });

  it('wraps resolver exceptions as resolver-failed', async () => {
    const resolver = makeResolver({
      resolveSpaceLink: async () => {
        throw new Error('network down');
      },
    });
    const action = await resolveLink('rebel://space/Exec/a.md', {
      spaceResolver: resolver,
    });
    expect(action).toMatchObject({ kind: 'error', code: 'resolver-failed', message: 'network down' });
  });
});

describe('resolveLink — invalid input', () => {
  it('returns invalid-url error when parser fails', async () => {
    const action = await resolveLink('not-a-url', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toMatchObject({ kind: 'error', code: 'invalid-url' });
    if (action.kind === 'error') {
      expect(action.source).toBe('not-a-url');
    }
  });

  it('returns invalid-url when scheme is wrong', async () => {
    const action = await resolveLink('https://example.com/foo', {
      spaceResolver: NullSpaceResolver,
    });
    expect(action).toMatchObject({ kind: 'error', code: 'invalid-url' });
  });
});
