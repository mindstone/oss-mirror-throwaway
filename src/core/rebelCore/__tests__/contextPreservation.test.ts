import { describe, expect, it } from 'vitest';
import {
  PRESERVATION_CATEGORIES,
  formatPreservationInstructions,
  formatContextStateSummary,
} from '../contextPreservation';
import type { RebelCoreContextState } from '../taskState';

describe('contextPreservation', () => {
  describe('PRESERVATION_CATEGORIES', () => {
    it('has 6 categories', () => {
      expect(PRESERVATION_CATEGORIES).toHaveLength(6);
    });

    it('keys align with RebelCoreContextState fields', () => {
      const expectedKeys = [
        'taskContext',
        'keyDecisions',
        'artifacts',
        'constraints',
        'progressState',
        'recentContextSummary',
      ];
      const categoryKeys = PRESERVATION_CATEGORIES.map(c => c.key);
      expect(categoryKeys).toEqual(expectedKeys);
    });

    it('all categories have non-empty label and instruction', () => {
      for (const cat of PRESERVATION_CATEGORIES) {
        expect(cat.label.length).toBeGreaterThan(0);
        expect(cat.instruction.length).toBeGreaterThan(0);
      }
    });
  });

  describe('formatPreservationInstructions', () => {
    it('includes header and all 6 categories', () => {
      const result = formatPreservationInstructions();
      expect(result).toContain('you MUST preserve');
      expect(result).toContain('TASK CONTEXT');
      expect(result).toContain('KEY DECISIONS');
      expect(result).toContain('ARTIFACTS');
      expect(result).toContain('CONSTRAINTS');
      expect(result).toContain('PROGRESS STATE');
      expect(result).toContain('RECENT CONTEXT');
    });

    it('includes footer guidance', () => {
      const result = formatPreservationInstructions();
      expect(result).toContain('Prefer preserving specific details');
    });
  });

  describe('formatContextStateSummary', () => {
    const emptyState: RebelCoreContextState = {
      taskContext: { goals: '', constraints: '', requirements: '' },
      keyDecisions: [],
      artifacts: [],
      constraints: [],
      progressState: { accomplished: [], remaining: [], blockers: [], failedApproaches: [] },
      recentContextSummary: '',
    };

    it('returns empty string for empty state', () => {
      expect(formatContextStateSummary(emptyState)).toBe('');
    });

    it('formats task context when present', () => {
      const state: RebelCoreContextState = {
        ...emptyState,
        taskContext: { goals: 'Build a widget', constraints: 'Must be fast', requirements: '' },
      };
      const result = formatContextStateSummary(state);
      expect(result).toContain('## Task Context');
      expect(result).toContain('Build a widget');
      expect(result).toContain('Constraints: Must be fast');
    });

    it('formats key decisions', () => {
      const state: RebelCoreContextState = {
        ...emptyState,
        keyDecisions: [
          { choice: 'Use React', rationale: 'Team knows it', rejectedAlternatives: ['Vue', 'Svelte'] },
        ],
      };
      const result = formatContextStateSummary(state);
      expect(result).toContain('## Key Decisions');
      expect(result).toContain('Use React');
      expect(result).toContain('Team knows it');
      expect(result).toContain('rejected: Vue, Svelte');
    });

    it('formats artifacts', () => {
      const state: RebelCoreContextState = {
        ...emptyState,
        artifacts: [
          { pathOrUrl: 'src/main.ts', identifier: 'entry point' },
        ],
      };
      const result = formatContextStateSummary(state);
      expect(result).toContain('## Artifacts');
      expect(result).toContain('src/main.ts (entry point)');
    });

    it('formats constraints list', () => {
      const state: RebelCoreContextState = {
        ...emptyState,
        constraints: ['Budget: $5K', 'Deadline: Friday'],
      };
      const result = formatContextStateSummary(state);
      expect(result).toContain('## Constraints');
      expect(result).toContain('- Budget: $5K');
      expect(result).toContain('- Deadline: Friday');
    });

    it('formats progress state', () => {
      const state: RebelCoreContextState = {
        ...emptyState,
        progressState: {
          accomplished: ['Setup done'],
          remaining: ['Tests'],
          blockers: ['API down'],
          failedApproaches: ['Tried XML'],
        },
      };
      const result = formatContextStateSummary(state);
      expect(result).toContain('## Progress');
      expect(result).toContain('Done: Setup done');
      expect(result).toContain('Remaining: Tests');
      expect(result).toContain('Blockers: API down');
      expect(result).toContain('Failed: Tried XML');
    });

    it('formats recent context summary', () => {
      const state: RebelCoreContextState = {
        ...emptyState,
        recentContextSummary: 'Just finished the refactor',
      };
      const result = formatContextStateSummary(state);
      expect(result).toContain('## Recent Context');
      expect(result).toContain('Just finished the refactor');
    });

    it('handles partially populated state', () => {
      const state: RebelCoreContextState = {
        ...emptyState,
        taskContext: { goals: 'Fix bug', constraints: '', requirements: '' },
        recentContextSummary: 'Working on it',
      };
      const result = formatContextStateSummary(state);
      expect(result).toContain('## Task Context');
      expect(result).toContain('## Recent Context');
      expect(result).not.toContain('## Key Decisions');
      expect(result).not.toContain('## Artifacts');
    });
  });
});
