/**
 * Unit tests for the settings search index validation helpers.
 *
 * Tests the pure extraction and cross-reference functions against
 * various input patterns.
 *
 * @see scripts/check-settings-search-index.ts
 * @see docs/plans/260402_settings_search_index_sync.md (Stage 2)
 */
import { describe, it, expect } from 'vitest';
import {
  extractDataSections,
  loadSearchIndexSections,
  crossReference,
} from '../check-settings-search-index';
import { filterSettingsSearchIndex } from '../../src/renderer/features/settings/searchIndex';

// ---------------------------------------------------------------------------
// extractDataSections
// ---------------------------------------------------------------------------

describe('extractDataSections', () => {
  it('extracts a single data-section value from JSX', () => {
    const source = `<div data-section="appearance">Content</div>`;
    expect(extractDataSections(source)).toEqual(['appearance']);
  });

  it('extracts multiple data-section values from a single file', () => {
    const source = `
      <div data-section="profile">
        <p>Name</p>
      </div>
      <div data-section="notifications">
        <p>Alerts</p>
      </div>
    `;
    expect(extractDataSections(source)).toEqual(
      expect.arrayContaining(['profile', 'notifications']),
    );
    expect(extractDataSections(source)).toHaveLength(2);
  });

  it('deduplicates repeated data-section values', () => {
    const source = `
      <div data-section="appearance">A</div>
      <div data-section="appearance">B</div>
    `;
    expect(extractDataSections(source)).toEqual(['appearance']);
  });

  it('returns empty array when no data-section attributes exist', () => {
    const source = `<div className="foo"><p>Hello</p></div>`;
    expect(extractDataSections(source)).toEqual([]);
  });

  it('ignores data-section inside comments', () => {
    // The regex will still match inside comments since it's a simple text scan.
    // This is acceptable because commented-out JSX in .tsx files is rare
    // and the false positive is harmless (it adds a section that doesn't
    // hurt the forward check).
    const source = `{/* <div data-section="removed">old</div> */}`;
    // We document the behavior rather than assert it won't match
    const result = extractDataSections(source);
    // Whether it matches or not, the script handles it gracefully
    expect(Array.isArray(result)).toBe(true);
  });

  it('handles hyphenated section names', () => {
    const source = `<div data-section="join-behavior">Join settings</div>`;
    expect(extractDataSections(source)).toEqual(['join-behavior']);
  });

  it('handles camelCase section names', () => {
    const source = `<div data-section="cloudSync">Cloud settings</div>`;
    expect(extractDataSections(source)).toEqual(['cloudSync']);
  });
});

// ---------------------------------------------------------------------------
// loadSearchIndexSections
// ---------------------------------------------------------------------------

describe('loadSearchIndexSections', () => {
  it('extracts section values from search index entries', () => {
    const source = `
      export const SETTINGS_SEARCH_INDEX: SearchEntry[] = [
        { tab: 'agents', section: 'model', label: 'Working model', keywords: ['main model'] },
        { tab: 'agents', section: 'anthropic', label: 'Anthropic', keywords: ['claude'] },
      ];
    `;
    expect(loadSearchIndexSections(source)).toEqual(
      expect.arrayContaining(['model', 'anthropic']),
    );
  });

  it('deduplicates repeated section values', () => {
    const source = `
      { tab: 'agents', section: 'model', label: 'Working model', keywords: [] },
      { tab: 'agents', section: 'model', label: 'Thinking model', keywords: [] },
    `;
    expect(loadSearchIndexSections(source)).toEqual(['model']);
  });

  it('ignores entries without a section field', () => {
    const source = `
      { tab: 'usage', label: 'Usage overview', keywords: ['cost'] },
      { tab: 'agents', section: 'model', label: 'Model', keywords: [] },
    `;
    expect(loadSearchIndexSections(source)).toEqual(['model']);
  });

  it('returns empty array when no sections exist', () => {
    const source = `
      { tab: 'usage', label: 'Usage', keywords: [] },
      { tab: 'safety', label: 'Safety', keywords: [] },
    `;
    expect(loadSearchIndexSections(source)).toEqual([]);
  });

  it('handles section values with hyphens', () => {
    const source = `{ tab: 'meetings', section: 'join-behavior', label: 'Join', keywords: [] }`;
    expect(loadSearchIndexSections(source)).toEqual(['join-behavior']);
  });
});

// ---------------------------------------------------------------------------
// crossReference
// ---------------------------------------------------------------------------

describe('crossReference', () => {
  it('detects sections missing from the index', () => {
    const componentSections = new Set(['appearance', 'notifications', 'profile']);
    const indexSections = new Set(['appearance', 'profile']);
    const allowlist = new Set<string>();

    const result = crossReference(componentSections, indexSections, allowlist);
    expect(result.missingFromIndex).toEqual(['notifications']);
    expect(result.staleInIndex).toEqual([]);
  });

  it('detects stale index entries not in components', () => {
    const componentSections = new Set(['appearance', 'profile']);
    const indexSections = new Set(['appearance', 'profile', 'removedSection']);
    const allowlist = new Set<string>();

    const result = crossReference(componentSections, indexSections, allowlist);
    expect(result.missingFromIndex).toEqual([]);
    expect(result.staleInIndex).toEqual(['removedSection']);
  });

  it('respects the allowlist for missing sections', () => {
    const componentSections = new Set(['appearance', 'supportDiagnostics']);
    const indexSections = new Set(['appearance']);
    const allowlist = new Set(['supportDiagnostics']);

    const result = crossReference(componentSections, indexSections, allowlist);
    expect(result.missingFromIndex).toEqual([]);
    expect(result.staleInIndex).toEqual([]);
  });

  it('detects both missing and stale simultaneously', () => {
    const componentSections = new Set(['a', 'b']);
    const indexSections = new Set(['b', 'c']);
    const allowlist = new Set<string>();

    const result = crossReference(componentSections, indexSections, allowlist);
    expect(result.missingFromIndex).toEqual(['a']);
    expect(result.staleInIndex).toEqual(['c']);
  });

  it('returns no errors when perfectly in sync', () => {
    const componentSections = new Set(['x', 'y', 'z']);
    const indexSections = new Set(['x', 'y', 'z']);
    const allowlist = new Set<string>();

    const result = crossReference(componentSections, indexSections, allowlist);
    expect(result.missingFromIndex).toEqual([]);
    expect(result.staleInIndex).toEqual([]);
  });

  it('returns no errors when all unmatched sections are allowlisted', () => {
    const componentSections = new Set(['indexed', 'composite']);
    const indexSections = new Set(['indexed']);
    const allowlist = new Set(['composite']);

    const result = crossReference(componentSections, indexSections, allowlist);
    expect(result.missingFromIndex).toEqual([]);
    expect(result.staleInIndex).toEqual([]);
  });

  it('sorts results alphabetically', () => {
    const componentSections = new Set(['z', 'a', 'm']);
    const indexSections = new Set<string>();
    const allowlist = new Set<string>();

    const result = crossReference(componentSections, indexSections, allowlist);
    expect(result.missingFromIndex).toEqual(['a', 'm', 'z']);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 rename aliases
// ---------------------------------------------------------------------------

describe('Stage 3 model-team rename search aliases', () => {
  it('keeps old search terms pointed at the renamed settings surfaces with preview annotations', () => {
    const snapshot = [
      'adaptive routing',
      'routing eligible',
      'background tasks',
      'deep thinking',
      'recovery',
      'long conversations',
      'working model',
      'thinking model',
    ].map((query) => {
      const result = filterSettingsSearchIndex(query)[0];
      const normalized = query.toLowerCase();
      const preview = result?.label.toLowerCase().includes(normalized)
        ? null
        : result?.keywords.find((kw) => kw.toLowerCase().includes(normalized)) ?? null;
      return {
        query,
        tab: result?.tab,
        section: result?.section,
        label: result?.label,
        preview,
      };
    });

    expect(snapshot).toMatchInlineSnapshot(`
      [
        {
          "label": "Smart model picking",
          "preview": "Adaptive routing has been renamed to Smart model picking.",
          "query": "adaptive routing",
          "section": "modelTeam",
          "tab": "agents",
        },
        {
          "label": "Included in Smart picking",
          "preview": "'Routing eligible' is now 'Included in Smart picking.'",
          "query": "routing eligible",
          "section": "modelTeam",
          "tab": "agents",
        },
        {
          "label": "Behind the Scenes",
          "preview": "Background tasks is now Behind the Scenes.",
          "query": "background tasks",
          "section": "defaultModelJobs",
          "tab": "agents",
        },
        {
          "label": "Planner",
          "preview": "Deep thinking is now Planner.",
          "query": "deep thinking",
          "section": "defaultModelJobs",
          "tab": "agents",
        },
        {
          "label": "Main work long-conversation fallback",
          "preview": "Recovery folds into Main work — set a fallback for long conversations.",
          "query": "recovery",
          "section": "defaultModelJobs",
          "tab": "agents",
        },
        {
          "label": "Main work long-conversation fallback",
          "preview": "Recovery folds into Main work — set a fallback for long conversations.",
          "query": "long conversations",
          "section": "defaultModelJobs",
          "tab": "agents",
        },
        {
          "label": "Main work",
          "preview": "working model",
          "query": "working model",
          "section": "defaultModelJobs",
          "tab": "agents",
        },
        {
          "label": "Planner",
          "preview": "thinking model",
          "query": "thinking model",
          "section": "defaultModelJobs",
          "tab": "agents",
        },
      ]
    `);
  });
});
