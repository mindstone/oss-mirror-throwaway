import { describe, it, expect } from 'vitest';
import type { AppSettings } from '@shared/types';
import { checkSpaceSharingConfig } from '../spaces';

/**
 * Direct tests for checkSpaceSharingConfig — FOX-3072 coverage.
 *
 * Historically this check was only exercised transitively through the
 * systemHealthService mocks, which meant a "sharing missing" bug could
 * slip through. These tests pin the pass/fail boundary condition directly
 * against the pre-fix and post-fix states of the Chief-of-Staff space
 * sharing configuration.
 */

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: '/workspace',
    spaces: [],
    ...overrides,
  } as AppSettings;
}

describe('checkSpaceSharingConfig', () => {
  it('skips when no tracked spaces are configured', async () => {
    const result = await checkSpaceSharingConfig(makeSettings({ spaces: [] }));
    expect(result.status).toBe('skip');
    expect(result.message).toBe('No tracked spaces configured');
  });

  // --- FAIL cases ----------------------------------------------------------

  it('FOX-3072 pre-fix state: CoS with missing sharing field → FAIL', async () => {
    const result = await checkSpaceSharingConfig(
      makeSettings({
        spaces: [
          {
            name: 'Chief of Staff',
            path: 'Chief-of-Staff',
            type: 'chief-of-staff',
            isSymlink: false,
            // sharing: undefined — this is the FOX-3072 bug state
            description: 'Router',
            createdAt: Date.now(),
          } as any,
        ],
      })
    );
    expect(result.status).toBe('fail');
    expect(result.details?.missingSharing).toContain('Chief-of-Staff');
    expect(result.remediation).toContain('sharing level');
  });

  it('fails when any space has missing sharing field', async () => {
    const result = await checkSpaceSharingConfig(
      makeSettings({
        spaces: [
          {
            name: 'Personal',
            path: 'Personal',
            type: 'personal',
            isSymlink: false,
            sharing: 'private',
            createdAt: Date.now(),
          } as any,
          {
            name: 'Client',
            path: 'work/Client',
            type: 'project',
            isSymlink: false,
            createdAt: Date.now(),
          } as any,
        ],
      })
    );
    expect(result.status).toBe('fail');
    expect(result.details?.missingSharing).toContain('work/Client');
  });

  it('fails when sharing has an unknown value', async () => {
    const result = await checkSpaceSharingConfig(
      makeSettings({
        spaces: [
          {
            name: 'Weird',
            path: 'weird',
            type: 'personal',
            isSymlink: false,
            sharing: 'super-secret' as any,
            createdAt: Date.now(),
          } as any,
        ],
      })
    );
    expect(result.status).toBe('fail');
    const invalid = result.details?.invalidSharing as Array<{ path: string; sharing: string }>;
    expect(invalid).toEqual([{ path: 'weird', sharing: 'super-secret' }]);
  });

  // --- WARN cases ----------------------------------------------------------

  it('warns on legacy "team" sharing value', async () => {
    const result = await checkSpaceSharingConfig(
      makeSettings({
        spaces: [
          {
            name: 'Team',
            path: 'team-space',
            type: 'project',
            isSymlink: false,
            sharing: 'team' as any, // Legacy value
            createdAt: Date.now(),
          } as any,
        ],
      })
    );
    expect(result.status).toBe('warn');
    expect(result.details?.legacyTeam).toContain('team-space');
  });

  // --- PASS cases ----------------------------------------------------------

  it('FOX-3072 post-fix state: CoS with sharing: "private" → PASS', async () => {
    const result = await checkSpaceSharingConfig(
      makeSettings({
        spaces: [
          {
            name: 'Chief of Staff',
            path: 'Chief-of-Staff',
            type: 'chief-of-staff',
            isSymlink: false,
            sharing: 'private',
            description: 'Router',
            createdAt: Date.now(),
          } as any,
        ],
      })
    );
    expect(result.status).toBe('pass');
    expect(result.details?.totalSpaces).toBe(1);
    const breakdown = result.details?.breakdown as Record<string, number>;
    expect(breakdown.private).toBe(1);
  });

  it('passes with mixed valid sharing levels', async () => {
    const result = await checkSpaceSharingConfig(
      makeSettings({
        spaces: [
          { name: 'CoS', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, sharing: 'private', createdAt: Date.now() } as any,
          { name: 'Team', path: 'team-x', type: 'project', isSymlink: false, sharing: 'restricted', createdAt: Date.now() } as any,
          { name: 'Eng', path: 'engineering', type: 'project', isSymlink: false, sharing: 'company-wide', createdAt: Date.now() } as any,
          { name: 'Blog', path: 'blog', type: 'project', isSymlink: false, sharing: 'public', createdAt: Date.now() } as any,
        ],
      })
    );
    expect(result.status).toBe('pass');
    const breakdown = result.details?.breakdown as Record<string, number>;
    expect(breakdown.private).toBe(1);
    expect(breakdown.restricted).toBe(1);
    expect(breakdown.companyWide).toBe(1);
    expect(breakdown.public).toBe(1);
  });
});
