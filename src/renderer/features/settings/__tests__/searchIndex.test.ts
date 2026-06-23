import { describe, it, expect } from 'vitest';
import { filterSettingsSearchIndex, SETTINGS_SEARCH_INDEX } from '../searchIndex';
import { resolveSettingsNavigation } from '@shared/navigation/settingsNavigationContract';

/** Helper: extract just the labels from search results for readable assertions. */
const labelsFor = (query: string): string[] =>
  filterSettingsSearchIndex(query).map((r) => r.label);

/** Helper: get the first result label (or undefined). */
const firstLabel = (query: string): string | undefined =>
  filterSettingsSearchIndex(query)[0]?.label;

/** Helper: get the first result object (or undefined). */
const firstResult = (query: string) =>
  filterSettingsSearchIndex(query)[0];

/** Helper: mirror the result-preview keyword lookup used by SettingsSearch. */
const previewFor = (query: string): string | undefined => {
  const result = firstResult(query);
  if (!result) return undefined;
  const normalized = query.toLowerCase();
  return result.label.toLowerCase().includes(normalized)
    ? undefined
    : result.keywords.find((kw) => kw.toLowerCase().includes(normalized));
};

describe('filterSettingsSearchIndex', () => {
  // -----------------------------------------------------------------------
  // Basic matching
  // -----------------------------------------------------------------------

  it('returns empty for empty query', () => {
    expect(filterSettingsSearchIndex('')).toEqual([]);
    expect(filterSettingsSearchIndex('   ')).toEqual([]);
  });

  it('returns empty for nonsense query', () => {
    expect(filterSettingsSearchIndex('xyzzyplugh')).toEqual([]);
  });

  it('is case-insensitive', () => {
    const lower = labelsFor('theme');
    const upper = labelsFor('THEME');
    const mixed = labelsFor('Theme');
    expect(lower).toEqual(upper);
    expect(lower).toEqual(mixed);
    expect(lower.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Ranking: exact label > prefix > substring > exact keyword > keyword substring
  // -----------------------------------------------------------------------

  describe('ranking tiers', () => {
    it('ranks exact label match first', () => {
      // "Theme" is an exact label; other results contain "theme" as substring/keyword
      expect(firstLabel('theme')).toBe('Theme');
    });

    it('ranks label prefix above label substring', () => {
      // "Safe" matches "Safe Mode" (prefix) and various safety entries (substring/keyword)
      const results = labelsFor('safe');
      const safeModeIdx = results.indexOf('Safe Mode');
      // Safe Mode should appear before entries where "safe" is only in keywords
      expect(safeModeIdx).toBeGreaterThanOrEqual(0);
      expect(safeModeIdx).toBeLessThan(3);
    });

    it('ranks label matches above keyword-only matches', () => {
      // "voice" is in several labels AND keywords — label matches should come first
      const results = labelsFor('voice');
      const labelMatches = results.filter((l) => l.toLowerCase().includes('voice'));
      const keywordOnlyMatches = results.filter((l) => !l.toLowerCase().includes('voice'));
      // All label matches should appear before all keyword-only matches
      if (keywordOnlyMatches.length > 0) {
        const lastLabelIdx = results.lastIndexOf(labelMatches[labelMatches.length - 1]);
        const firstKeywordIdx = results.indexOf(keywordOnlyMatches[0]);
        expect(lastLabelIdx).toBeLessThan(firstKeywordIdx);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Realistic user searches (progressive typing / natural queries)
  // -----------------------------------------------------------------------

  describe('realistic searches', () => {
    it('"notif" finds notifications (partial typing)', () => {
      const results = labelsFor('notif');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((l) => l.includes('Notification'))).toBe(true);
    });

    it('"dark" finds theme settings', () => {
      expect(labelsFor('dark')).toContain('Theme');
    });

    it('"font" finds font size', () => {
      expect(labelsFor('font')).toContain('Font size');
    });

    it('"text too small" finds font size via keyword', () => {
      expect(labelsFor('text too small')).toContain('Font size');
    });

    it('"api key" finds provider key settings', () => {
      const results = labelsFor('api key');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((l) => l.includes('API key') || l.includes('Authentication'))).toBe(true);
    });

    it('"plug" finds plugin entries (partial typing)', () => {
      const results = labelsFor('plug');
      expect(results.some((l) => l.toLowerCase().includes('plugin'))).toBe(true);
    });

    it('"mcp" finds connector settings', () => {
      const results = labelsFor('mcp');
      expect(results.length).toBeGreaterThan(0);
    });

    it('"shortcut" finds hotkey settings', () => {
      expect(labelsFor('shortcut')).toContain('Global voice activation hotkey');
    });

    it('"dev mode" finds developer mode toggle', () => {
      expect(labelsFor('dev mode')).toContain('Developer mode');
    });

    it('"privacy" finds privacy & data section', () => {
      expect(labelsFor('privacy')).toContain('Privacy & Data');
    });

    it('"compact" finds UI density', () => {
      expect(labelsFor('compact')).toContain('UI density');
    });

    it('"accent" finds accent color', () => {
      expect(labelsFor('accent')).toContain('Accent color');
    });

    it('"update" finds app updates', () => {
      expect(labelsFor('update')).toContain('App updates');
    });

    it('"sign out" finds sign out', () => {
      expect(labelsFor('sign out')).toContain('Sign out');
    });

    it('"cloud" finds cloud continuity', () => {
      const results = labelsFor('cloud');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((l) => l.toLowerCase().includes('cloud'))).toBe(true);
    });

    it('finds messaging channel entries from natural queries', () => {
      expect(labelsFor('slack mentions')).toContain('Slack listener');
      expect(labelsFor('connect slack')).toContain('Connect Slack');
      expect(labelsFor('telegram')).toContain('Telegram (coming soon)');
      expect(labelsFor('whatsapp')).toContain('WhatsApp (coming soon)');
      expect(labelsFor('microsoft teams')).toContain('Microsoft Teams (coming soon)');
    });

    it('"meeting" finds meeting-related settings', () => {
      const results = labelsFor('meeting');
      expect(results.length).toBeGreaterThan(0);
    });

    it('"stream" finds streaming toggle', () => {
      expect(labelsFor('stream')).toContain('Stream responses as they generate');
    });

    it('returns renamed model role labels for direct searches', () => {
      expect(firstLabel('main work')).toBe('Main work');
      expect(firstLabel('working model')).toBe('Main work');
      expect(firstLabel('planner')).toBe('Planner');
      expect(firstLabel('deep thinking')).toBe('Planner');
      expect(firstLabel('thinking model')).toBe('Planner');
      expect(firstLabel('behind the scenes')).toBe('Behind the Scenes');
      expect(firstLabel('smart model picking')).toBe('Smart model picking');
      expect(firstLabel('included in smart picking')).toBe('Included in Smart picking');
    });

    it('surfaces rename annotations for old model-team search terms', () => {
      const aliases = [
        {
          query: 'adaptive routing',
          label: 'Smart model picking',
          preview: 'Adaptive routing has been renamed to Smart model picking.',
        },
        {
          query: 'routing eligible',
          label: 'Included in Smart picking',
          preview: "'Routing eligible' is now 'Included in Smart picking.'",
        },
        {
          query: 'background tasks',
          label: 'Behind the Scenes',
          preview: 'Background tasks is now Behind the Scenes.',
        },
        {
          query: 'deep thinking',
          label: 'Planner',
          preview: 'Deep thinking is now Planner.',
        },
        {
          query: 'recovery',
          label: 'Main work long-conversation fallback',
          preview: 'Recovery folds into Main work — set a fallback for long conversations.',
        },
        {
          query: 'long conversations',
          label: 'Main work long-conversation fallback',
          preview: 'Recovery folds into Main work — set a fallback for long conversations.',
        },
      ];

      expect(aliases.map(({ query }) => ({
        query,
        label: firstLabel(query),
        preview: previewFor(query),
      }))).toEqual(aliases);
    });
  });

  // -----------------------------------------------------------------------
  // Destination correctness (catches wrong-destination regressions)
  // -----------------------------------------------------------------------

  describe('search index → destination correctness', () => {
    const EXPECTED_DESTINATION: Record<string, string> = {
      agents: 'agent_voice',
      voice: 'agent_voice',
      tools: 'connectors',
      meetings: 'meetings',
      spaces: 'workspace',
      cloud: 'workspace',
      safety: 'privacy_safety',
      account: 'account_preferences',
      usage: 'usage',
      diagnostics: 'advanced',
      plugins: 'advanced',
      developer: 'advanced',
    };

    const SYSTEM_SECTION_DESTINATION: Record<string, string> = {
      coreDirectory: 'workspace',
      scratchpad: 'workspace',
      appearance: 'account_preferences',
      notifications: 'account_preferences',
      suggestions: 'account_preferences',
      powerPerformance: 'account_preferences',
      advancedOperations: 'advanced',
      localInference: 'advanced',
      focus: 'advanced',
      contextCompaction: 'advanced',
      preventSleep: 'advanced',
      adaptiveRouting: 'workspace',
    };

    it('every search entry with a section resolves to its correct destination', () => {
      const entriesWithSection = SETTINGS_SEARCH_INDEX.filter((e) => e.section);
      expect(entriesWithSection.length).toBeGreaterThan(0);

      const failures: string[] = [];
      for (const entry of entriesWithSection) {
        const resolved = resolveSettingsNavigation({ tab: entry.tab, section: entry.section });
        const expected = entry.tab === 'system'
          ? SYSTEM_SECTION_DESTINATION[entry.section!]
          : EXPECTED_DESTINATION[entry.tab];
        if (!expected) {
          failures.push(
            `${entry.tab}/${entry.section} (${entry.label}): no expected destination mapped — update SYSTEM_SECTION_DESTINATION or EXPECTED_DESTINATION`,
          );
        } else if (resolved.destination !== expected) {
          failures.push(
            `${entry.tab}/${entry.section} (${entry.label}): resolved to '${resolved.destination}', expected '${expected}'`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('single character "s" returns results without crashing', () => {
      const results = filterSettingsSearchIndex('s');
      expect(results.length).toBeGreaterThan(0);
    });

    it('very long query returns empty (no match)', () => {
      expect(filterSettingsSearchIndex('this is an extremely long search query that will not match anything')).toEqual([]);
    });

    it('query with leading/trailing whitespace is trimmed', () => {
      expect(labelsFor('  theme  ')).toEqual(labelsFor('theme'));
    });
  });
});
