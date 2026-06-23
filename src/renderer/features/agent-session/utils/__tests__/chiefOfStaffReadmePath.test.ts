import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import { resolveChiefOfStaffReadmePath } from '../chiefOfStaffReadmePath';

type Settings = Pick<AppSettings, 'coreDirectory' | 'spaces'>;

function settings(overrides: Partial<Settings>): Settings {
  return { coreDirectory: '/Users/jane/Rebel', spaces: [], ...overrides };
}

describe('resolveChiefOfStaffReadmePath (260622 Stage 4)', () => {
  it('returns null when no workspace folder is set', () => {
    expect(resolveChiefOfStaffReadmePath(settings({ coreDirectory: undefined as never }))).toBeNull();
    expect(resolveChiefOfStaffReadmePath(settings({ coreDirectory: '   ' }))).toBeNull();
    expect(resolveChiefOfStaffReadmePath(null)).toBeNull();
  });

  it('falls back to the canonical Chief-of-Staff join when there is no chief-of-staff space entry', () => {
    expect(resolveChiefOfStaffReadmePath(settings({ spaces: [] }))).toBe(
      '/Users/jane/Rebel/Chief-of-Staff/README.md',
    );
  });

  it('prefers the chief-of-staff space entry on-disk path (case/symlink variant)', () => {
    const result = resolveChiefOfStaffReadmePath(
      settings({
        spaces: [
          { name: 'cos', path: 'chief-of-staff', type: 'chief-of-staff', isSymlink: true, createdAt: 0 } as never,
        ],
      }),
    );
    expect(result).toBe('/Users/jane/Rebel/chief-of-staff/README.md');
  });

  it('uses backslash separators for a Windows workspace path', () => {
    const result = resolveChiefOfStaffReadmePath({
      coreDirectory: 'C:\\Users\\jane\\Rebel',
      spaces: [],
    });
    expect(result).toBe('C:\\Users\\jane\\Rebel\\Chief-of-Staff\\README.md');
  });

  it('strips a trailing separator from the workspace path', () => {
    expect(resolveChiefOfStaffReadmePath(settings({ coreDirectory: '/Users/jane/Rebel/' }))).toBe(
      '/Users/jane/Rebel/Chief-of-Staff/README.md',
    );
  });
});
