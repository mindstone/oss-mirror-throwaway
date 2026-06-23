import { describe, expect, it } from 'vitest';
import { buildPublishAllToast } from '../../utils/buildPublishAllToast';

describe('buildPublishAllToast', () => {
  it('returns null when all succeed (no conflicts, no errors)', () => {
    expect(buildPublishAllToast({ published: 5, conflicts: 0, errors: 0 })).toBeNull();
  });

  it('returns warning toast when some conflicts and some published', () => {
    const toast = buildPublishAllToast({ published: 3, conflicts: 2, errors: 0 });
    expect(toast).not.toBeNull();
    expect(toast!.title).toBe('Saved 3 files');
    expect(toast!.description).toContain('2 had conflicts');
    expect(toast!.variant).toBe('warning');
  });

  it('uses singular "file" when exactly 1 published', () => {
    const toast = buildPublishAllToast({ published: 1, conflicts: 1, errors: 0 });
    expect(toast!.title).toBe('Saved 1 file');
  });

  it('returns warning toast when all files had conflicts', () => {
    const toast = buildPublishAllToast({ published: 0, conflicts: 4, errors: 0 });
    expect(toast).not.toBeNull();
    expect(toast!.title).toBe('All files had conflicts');
    expect(toast!.description).toContain('Review them individually to resolve');
    expect(toast!.variant).toBe('warning');
  });

  it('returns error toast when only errors', () => {
    const toast = buildPublishAllToast({ published: 0, conflicts: 0, errors: 3 });
    expect(toast).not.toBeNull();
    expect(toast!.title).toBe('Failed to save files');
    expect(toast!.description).toContain('3 failed to save');
    expect(toast!.variant).toBe('error');
  });

  it('returns error toast with joined description for mixed conflicts and errors', () => {
    const toast = buildPublishAllToast({ published: 2, conflicts: 1, errors: 1 });
    expect(toast).not.toBeNull();
    expect(toast!.title).toBe('Saved 2 files');
    expect(toast!.description).toContain('1 had conflicts');
    expect(toast!.description).toContain('1 failed to save');
    expect(toast!.variant).toBe('error');
  });

  it('returns error toast when all conflicts plus errors (no published)', () => {
    const toast = buildPublishAllToast({ published: 0, conflicts: 2, errors: 1 });
    expect(toast).not.toBeNull();
    expect(toast!.title).toBe('All files had conflicts');
    expect(toast!.description).toContain('Review them individually to resolve');
    expect(toast!.description).toContain('1 failed to save');
    expect(toast!.variant).toBe('error');
  });
});
