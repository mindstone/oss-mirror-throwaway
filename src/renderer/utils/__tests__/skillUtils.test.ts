import { describe, expect, it } from 'vitest';
import { isSkillEntry } from '@renderer/utils/skillUtils';
import type { FlatFileEntry } from '@renderer/utils/librarySearch';

const makeEntry = (entry: Pick<FlatFileEntry, 'fullPath' | 'skillMeta'>): Pick<FlatFileEntry, 'fullPath' | 'skillMeta'> => entry;

describe('isSkillEntry', () => {
  it('treats canonical skill paths as skills', () => {
    expect(isSkillEntry(makeEntry({ fullPath: 'skills/daily-prep' }))).toBe(true);
    expect(isSkillEntry(makeEntry({ fullPath: 'rebel-system/skills/design/review' }))).toBe(true);
  });

  it('treats scanner metadata as skill evidence even outside canonical paths', () => {
    expect(isSkillEntry(makeEntry({
      fullPath: 'Shared/Team/Waterloo',
      skillMeta: { name: 'waterloo-meeting-prep' },
    }))).toBe(true);
  });

  it('does not treat ordinary files as skills', () => {
    expect(isSkillEntry(makeEntry({ fullPath: 'docs/waterloo-notes.md' }))).toBe(false);
  });
});
