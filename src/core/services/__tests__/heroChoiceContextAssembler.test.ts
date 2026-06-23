import { describe, it, expect, vi } from 'vitest';

import {
  assembleHeroChoiceContext,
  estimateTokens,
  DEFAULT_TOKEN_BUDGET,
  SAFETY_MARGIN,
  type HeroChoiceContextDeps,
  type LoadedSession,
} from '../heroChoiceContextAssembler';

function makeDeps(overrides?: Partial<HeroChoiceContextDeps>): HeroChoiceContextDeps {
  return {
    listSessionSummaries: () => [],
    loadSession: async () => null,
    getPersonalGoals: async () => null,
    getSkillSummaries: async () => [],
    getUseCases: () => [],
    getUpcomingEvents: () => [],
    getPastCandidates: () => [],
    timeZone: 'UTC',
    ...overrides,
  };
}

function makeSession(id: string, title: string, messageCount: number, createdAt?: number): LoadedSession {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `Message ${i} content for session ${id}`,
  }));
  return {
    id,
    title,
    createdAt: createdAt ?? Date.now() - 3_600_000 * (10 - parseInt(id)),
    messages,
  };
}

describe('heroChoiceContextAssembler', () => {
  describe('estimateTokens', () => {
    it('estimates tokens as chars/4 with safety margin', () => {
      const text = 'a'.repeat(400);
      // 400 / 4 = 100, * 1.2 = 120
      expect(estimateTokens(text)).toBe(Math.ceil((400 / 4) * SAFETY_MARGIN));
    });

    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });
  });

  describe('empty state', () => {
    it('returns empty string when no data available', async () => {
      const context = await assembleHeroChoiceContext(makeDeps());
      expect(context).toBe('');
    });
  });

  describe('section inclusion', () => {
    it('includes goals section when goals are available', async () => {
      const deps = makeDeps({
        getPersonalGoals: async () => ({
          thisQuarter: [{ goal: 'Ship v2', why: 'Growth' }],
          status: 'on_track',
        }),
      });
      const context = await assembleHeroChoiceContext(deps);
      expect(context).toContain('## Your Goals (This Quarter)');
      expect(context).toContain('Ship v2');
      expect(context).toContain('Growth');
    });

    it('includes calendar section when events available', async () => {
      const deps = makeDeps({
        getUpcomingEvents: () => [
          { title: 'Standup', startTime: Date.now() + 3_600_000, attendees: ['Alice'] },
        ],
      });
      const context = await assembleHeroChoiceContext(deps);
      expect(context).toContain('## Your Calendar (Next 24 Hours)');
      expect(context).toContain('Standup');
      expect(context).toContain('Alice');
    });

    it('includes skills section when skills available', async () => {
      const deps = makeDeps({
        getSkillSummaries: async () => [
          { name: 'meeting-prep', description: 'Prepare for meetings', qualityScore: 85, band: 'gold' },
        ],
      });
      const context = await assembleHeroChoiceContext(deps);
      expect(context).toContain('## Your Skills');
      expect(context).toContain('meeting-prep');
      expect(context).toContain('quality: 85/100');
    });

    it('includes use cases section when use cases available', async () => {
      const deps = makeDeps({
        getUseCases: () => [
          { title: 'Email triage', description: 'Sort emails', prompt: 'do it', usageCount: 5, qualityRating: 90 },
        ],
      });
      const context = await assembleHeroChoiceContext(deps);
      expect(context).toContain('## Your Workflows (Use Cases)');
      expect(context).toContain('Email triage');
      expect(context).toContain('used 5 times');
    });

    it('includes past recommendations section', async () => {
      const deps = makeDeps({
        getPastCandidates: () => [
          {
            id: 'past-1',
            type: 'coaching',
            headline: 'Previous insight',
            body: 'body',
            actionLabel: 'act',
            actionPrompt: 'prompt',
            priority: 1,
          },
        ],
      });
      const context = await assembleHeroChoiceContext(deps);
      expect(context).toContain('## Past Recommendations');
      expect(context).toContain('[coaching] "Previous insight"');
    });
  });

  describe('session handling', () => {
    it('includes sessions newest first', async () => {
      const now = Date.now();
      const sessions = [
        makeSession('1', 'Older session', 4, now - 7_200_000),
        makeSession('2', 'Newer session', 4, now - 3_600_000),
      ];
      const deps = makeDeps({
        listSessionSummaries: () =>
          sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })),
        loadSession: async (id) => sessions.find((s) => s.id === id) ?? null,
      });

      const context = await assembleHeroChoiceContext(deps);
      expect(context).toContain('## Recent Sessions (Newest First)');
      const newerIdx = context.indexOf('Newer session');
      const olderIdx = context.indexOf('Older session');
      expect(newerIdx).toBeLessThan(olderIdx);
    });

    it('skips sessions with no messages', async () => {
      const sessions = [makeSession('1', 'Empty session', 0)];
      const deps = makeDeps({
        listSessionSummaries: () =>
          sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })),
        loadSession: async (id) => sessions.find((s) => s.id === id) ?? null,
      });

      const context = await assembleHeroChoiceContext(deps);
      expect(context).not.toContain('Empty session');
    });
  });

  describe('token budget enforcement', () => {
    it('drops oldest sessions when over budget', async () => {
      const now = Date.now();
      // Create sessions with enough text to exceed budget
      const bigMessage = 'x'.repeat(100_000); // ~25K tokens each
      const sessions: LoadedSession[] = [];
      for (let i = 0; i < 10; i++) {
        sessions.push({
          id: String(i),
          title: `Session ${i}`,
          createdAt: now - (10 - i) * 3_600_000, // older sessions have lower indices
          messages: [
            { role: 'user', text: bigMessage },
            { role: 'assistant', text: bigMessage },
          ],
        });
      }

      const deps = makeDeps({
        listSessionSummaries: () =>
          sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })),
        loadSession: async (id) => sessions.find((s) => s.id === id) ?? null,
      });

      const context = await assembleHeroChoiceContext(deps);
      const totalTokens = estimateTokens(context);
      expect(totalTokens).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);

      // Newest sessions should be included, oldest may be dropped
      expect(context).toContain('Session 9');
    });

    it('truncates a single huge session from the middle', async () => {
      const now = Date.now();
      const messages = Array.from({ length: 100 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        text: 'x'.repeat(10_000), // ~2500 tokens each message, 100 messages = ~250K tokens
      }));

      const sessions: LoadedSession[] = [{
        id: '1',
        title: 'Huge session',
        createdAt: now,
        messages,
      }];

      const deps = makeDeps({
        listSessionSummaries: () =>
          sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt })),
        loadSession: async (id) => sessions.find((s) => s.id === id) ?? null,
      });

      const context = await assembleHeroChoiceContext(deps);
      // Should contain the truncation marker
      expect(context).toContain('messages omitted');
    });
  });
});
