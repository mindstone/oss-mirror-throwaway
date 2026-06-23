import { describe, expect, it } from 'vitest';
import type { SkillsScanResult } from '../../../hooks/useSkillsIndex';
import { skillIndexToCardEntries } from './skillIndexToCardEntries';

const SKILL_INDEX_FIXTURE: SkillsScanResult = {
  totalCount: 2,
  groups: [
    {
      source: 'rebel-system',
      label: 'Rebel system',
      type: 'platform',
      categories: {
        writing: [
          {
            name: 'summarize-notes',
            relativePath: 'rebel-system/skills/writing/summarize-notes/SKILL.md',
            absolutePath: '/workspace/rebel-system/skills/writing/summarize-notes/SKILL.md',
            category: 'writing',
            hasFrontmatter: true,
            frontmatter: {
              description: 'Turn notes into concise summaries',
              use_cases: ['meetings', 'research'],
            },
            usageCount: 12,
            lastUsedAt: 1716500000000,
          },
        ],
      },
      count: 1,
      isBuiltIn: true,
    },
    {
      source: 'Chief-of-Staff',
      label: 'Chief-of-Staff',
      type: 'space',
      categories: {
        planning: [
          {
            name: 'weekly-planning',
            relativePath: 'Chief-of-Staff/skills/planning/weekly-planning/SKILL.md',
            absolutePath: '/workspace/Chief-of-Staff/skills/planning/weekly-planning/SKILL.md',
            category: 'planning',
            hasFrontmatter: true,
            frontmatter: {
              description: 'Plan the next week',
              use_cases: ['planning'],
            },
          },
        ],
      },
      count: 1,
      sharing: 'private',
      storageProvider: 'local',
    },
  ],
};

describe('skillIndexToCardEntries', () => {
  it('maps skill index groups to typed card entries', () => {
    const entries = skillIndexToCardEntries(SKILL_INDEX_FIXTURE);
    expect(entries).toHaveLength(2);

    const builtInEntry = entries.find((entry) => entry.name === 'summarize-notes');
    expect(builtInEntry).toMatchObject({
      kind: 'skill',
      source: 'built-in',
      skillSource: 'platform',
      commandShortcut: '@`rebel-system/skills/writing/summarize-notes/SKILL.md`',
      lastUsedAt: 1716500000000,
      usageCount: 12,
    });
    expect(builtInEntry?.tags).toEqual(['writing', 'meetings', 'research']);

    const userEntry = entries.find((entry) => entry.name === 'weekly-planning');
    expect(userEntry).toMatchObject({
      kind: 'skill',
      source: 'user',
      skillSource: 'space',
      sharing: 'private',
      storageProvider: 'local',
    });
  });

  it('returns an empty list when no skill index is provided', () => {
    expect(skillIndexToCardEntries(null)).toEqual([]);
    expect(skillIndexToCardEntries(undefined)).toEqual([]);
  });
});
