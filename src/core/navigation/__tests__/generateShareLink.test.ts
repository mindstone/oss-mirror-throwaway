/**
 * Tests for `generateShareLink` — shareable URL construction, including
 * private-space handling and cloud launcher URL emission.
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage C.
 */

import { describe, expect, it } from 'vitest';

import type { SpaceResolver } from '../boundaries';
import { NullSpaceResolver } from '../boundaries';
import { generateShareLink } from '../generateShareLink';

function makeResolver(overrides: Partial<SpaceResolver> = {}): SpaceResolver {
  return { ...NullSpaceResolver, ...overrides };
}

describe('generateShareLink — conversation', () => {
  it('produces rebel:// URL', async () => {
    const result = await generateShareLink(
      { kind: 'conversation', sessionId: 'sess1' },
      { spaceResolver: NullSpaceResolver },
    );
    expect(result).toEqual({
      ok: true,
      rebel: 'rebel://conversation/sess1',
      preferred: 'conversation',
    });
  });

  it('includes https launcher when cloudBaseUrl is provided', async () => {
    const result = await generateShareLink(
      { kind: 'conversation', sessionId: 'sess1' },
      { spaceResolver: NullSpaceResolver, cloudBaseUrl: 'https://cloud.example.com' },
    );
    expect(result).toMatchObject({
      ok: true,
      rebel: 'rebel://conversation/sess1',
      https: 'https://cloud.example.com/app/open?u=rebel%3A%2F%2Fconversation%2Fsess1',
      preferred: 'conversation',
    });
  });

  it('strips trailing slashes from cloudBaseUrl', async () => {
    const result = await generateShareLink(
      { kind: 'conversation', sessionId: 'sess1' },
      { spaceResolver: NullSpaceResolver, cloudBaseUrl: 'https://cloud.example.com///' },
    );
    if (result.ok) {
      expect(result.https).toBe('https://cloud.example.com/app/open?u=rebel%3A%2F%2Fconversation%2Fsess1');
    } else {
      throw new Error('expected ok');
    }
  });

  it('omits https when cloudBaseUrl is absent', async () => {
    const result = await generateShareLink(
      { kind: 'conversation', sessionId: 'sess1' },
      { spaceResolver: NullSpaceResolver },
    );
    if (result.ok) {
      expect(result.https).toBeUndefined();
    } else {
      throw new Error('expected ok');
    }
  });
});

describe('generateShareLink — library file (absolute path)', () => {
  it('emits rebel://space/... when path resolves to a shareable space', async () => {
    const resolver = makeResolver({
      filePathToSpaceLink: async () => ({ spaceName: 'Exec', relativePath: 'memory/Q1.md' }),
    });
    const result = await generateShareLink(
      { kind: 'library-file', absolutePath: '/Users/me/core/Exec/memory/Q1.md' },
      { spaceResolver: resolver },
    );
    // The formatter URL-encodes the relative path (slashes become %2F) so the
    // URL survives round-tripping through URL.parse without splitting segments.
    expect(result).toEqual({
      ok: true,
      rebel: 'rebel://space/Exec/memory%2FQ1.md',
      preferred: 'space',
    });
  });

  it('emits folder form for library-folder resource', async () => {
    const resolver = makeResolver({
      filePathToSpaceLink: async () => ({ spaceName: 'Exec', relativePath: 'memory' }),
    });
    const result = await generateShareLink(
      { kind: 'library-folder', absolutePath: '/Users/me/core/Exec/memory' },
      { spaceResolver: resolver },
    );
    expect(result).toMatchObject({
      ok: true,
      rebel: 'rebel://space/Exec/memory?type=folder',
      preferred: 'space',
    });
  });

  it('returns ok:false when path is in a private / non-shareable space', async () => {
    // Resolver returns null for CoS or private-sharing spaces.
    const resolver = makeResolver({
      filePathToSpaceLink: async () => null,
    });
    const result = await generateShareLink(
      { kind: 'library-file', absolutePath: '/Users/me/core/chief-of-staff/notes.md' },
      { spaceResolver: resolver },
    );
    expect(result).toEqual({ ok: false, reason: 'private-space' });
  });
});

describe('generateShareLink — explicit space resources', () => {
  it('formats space-file directly (no reverse lookup needed)', async () => {
    const result = await generateShareLink(
      { kind: 'space-file', spaceName: 'Exec', relativePath: 'memory/Q1.md' },
      { spaceResolver: NullSpaceResolver },
    );
    expect(result).toMatchObject({
      ok: true,
      rebel: 'rebel://space/Exec/memory%2FQ1.md',
      preferred: 'space',
    });
  });

  it('formats space-folder with type=folder query param', async () => {
    const result = await generateShareLink(
      { kind: 'space-folder', spaceName: 'Exec', relativePath: 'memory' },
      { spaceResolver: NullSpaceResolver },
    );
    expect(result).toMatchObject({
      ok: true,
      rebel: 'rebel://space/Exec/memory?type=folder',
      preferred: 'space',
    });
  });
});

describe('generateShareLink — tasks', () => {
  it('formats bare rebel://tasks', async () => {
    const result = await generateShareLink(
      { kind: 'tasks' },
      { spaceResolver: NullSpaceResolver },
    );
    expect(result).toMatchObject({
      ok: true,
      rebel: 'rebel://tasks',
      preferred: 'tasks',
    });
  });

  it('formats focused rebel://tasks/{id}', async () => {
    const result = await generateShareLink(
      { kind: 'tasks', focusApprovalId: 'approval_abc' },
      { spaceResolver: NullSpaceResolver },
    );
    expect(result).toMatchObject({
      ok: true,
      rebel: 'rebel://tasks/approval_abc',
      preferred: 'tasks',
    });
  });
});

describe('generateShareLink — action', () => {
  it('formats action verb', async () => {
    const result = await generateShareLink(
      { kind: 'action', action: 'start-voice' },
      { spaceResolver: NullSpaceResolver },
    );
    expect(result).toMatchObject({
      ok: true,
      rebel: 'rebel://action/start-voice',
      preferred: 'action',
    });
  });

  it('preserves params', async () => {
    const result = await generateShareLink(
      { kind: 'action', action: 'start-meeting-recording', params: { source: 'widget' } },
      { spaceResolver: NullSpaceResolver },
    );
    if (result.ok) {
      expect(result.rebel).toContain('rebel://action/start-meeting-recording');
      expect(result.rebel).toContain('source=widget');
    } else {
      throw new Error('expected ok');
    }
  });
});
