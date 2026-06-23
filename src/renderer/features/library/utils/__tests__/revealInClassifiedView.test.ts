import { describe, expect, it } from 'vitest';
import { getRevealClassification } from '../revealInClassifiedView';

describe('getRevealClassification', () => {
  it('routes skill files to Skills reveal target', () => {
    const result = getRevealClassification({
      path: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
      relativePath: 'Chief-of-Staff/skills/meeting-prep/SKILL.md',
    });

    expect(result).toEqual({
      filter: 'skills',
      label: 'Show in Skills',
      lens: { filter: 'skills', view: 'folders' },
    });
  });

  it('routes memory files to Memory reveal target', () => {
    const result = getRevealClassification({
      path: '/workspace/Chief-of-Staff/memory/weekly.md',
      relativePath: 'Chief-of-Staff/memory/weekly.md',
    });

    expect(result).toEqual({
      filter: 'memory',
      label: 'Show in Memory',
      lens: { filter: 'memory', view: 'folders' },
    });
  });

  it('routes plain files in known spaces to Spaces reveal target', () => {
    const result = getRevealClassification(
      {
        path: '/workspace/work/Acme/General/roadmap.md',
        relativePath: 'work/Acme/General/roadmap.md',
      },
      ['/workspace/work/Acme/General'],
    );

    expect(result).toEqual({
      filter: 'spaces',
      label: 'Show in Spaces',
      lens: { filter: 'spaces', view: 'folders' },
    });
  });

  it('falls back to folder tree reveal for unclassified files', () => {
    const result = getRevealClassification({
      path: '/workspace/notes.md',
      relativePath: 'notes.md',
    });

    expect(result).toEqual({
      filter: 'everything',
      label: 'Show in Folders',
      lens: { filter: 'everything', view: 'folders' },
    });
  });
});
