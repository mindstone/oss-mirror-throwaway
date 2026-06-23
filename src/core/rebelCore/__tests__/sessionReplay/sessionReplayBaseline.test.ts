/**
 * Session Replay Baseline Tests
 *
 * Loads extracted session fixtures and validates that:
 * 1. Fixture data is well-formed and complete
 * 2. Behavioral metrics can be extracted and compared
 * 3. Baselines are established for future comparison
 *
 * No API calls — these are offline tests that validate the fixture data itself.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

interface TurnMetrics {
  totalToolCalls: number;
  failedToolCalls: number;
  toolSuccessRate: number;
  toolUsageByCategory: Record<string, number>;
  mcpServerUsage: Record<string, number>;
  filesAccessed: string[];
  subAgentsUsed: boolean;
  subAgentCount: number;
  todoWriteCount: number;
  askUserCount: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  responseTextLength: number;
  totalToolOutputChars: number;
}

interface SessionFixture {
  sessionId: string;
  title: string;
  metadata: {
    originalModel: string;
    totalTurns: number;
    totalToolCalls: number;
    origin: string;
  };
  turns: Array<{
    turnId: string;
    userPrompt: string;
    metrics: TurnMetrics;
    toolCalls: Array<{
      toolName: string;
      input: Record<string, unknown>;
      succeeded: boolean;
    }>;
  }>;
}

function loadFixtures(): SessionFixture[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.fixture.json'));
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf-8')));
}

function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (const key of allKeys) {
    const va = a[key] ?? 0;
    const vb = b[key] ?? 0;
    dotProduct += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 1;
  return intersection.size / union.size;
}

const fixtures = loadFixtures();
const hasFixtures = fixtures.length > 0;

describe.skipIf(!hasFixtures)('Session Replay Baselines', () => {
  it('should have extracted at least 5 fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  for (const fixture of fixtures) {
    describe(`Session: ${fixture.title}`, () => {
      it('has valid metadata', () => {
        expect(fixture.sessionId).toBeTruthy();
        expect(fixture.title).toBeTruthy();
        expect(fixture.metadata.totalTurns).toBeGreaterThan(0);
        expect(fixture.metadata.totalToolCalls).toBeGreaterThanOrEqual(0);
        expect(fixture.metadata.origin).toBeTruthy();
      });

      it('has turns with user prompts', () => {
        expect(fixture.turns.length).toBe(fixture.metadata.totalTurns);
        const turnsWithPrompts = fixture.turns.filter((t) => t.userPrompt.length > 0);
        expect(turnsWithPrompts.length).toBeGreaterThan(0);
      });

      it('has consistent tool metrics', () => {
        let totalTools = 0;
        for (const turn of fixture.turns) {
          totalTools += turn.metrics.totalToolCalls;
          expect(turn.metrics.toolSuccessRate).toBeGreaterThanOrEqual(0);
          expect(turn.metrics.toolSuccessRate).toBeLessThanOrEqual(1);

          const categorySum = Object.values(turn.metrics.toolUsageByCategory).reduce(
            (a, b) => a + b,
            0,
          );
          expect(categorySum).toBe(turn.metrics.totalToolCalls);
        }
        expect(totalTools).toBe(fixture.metadata.totalToolCalls);
      });

      it('has high tool success rate (>= 90%)', () => {
        const totalTools = fixture.turns.reduce((s, t) => s + t.metrics.totalToolCalls, 0);
        const failedTools = fixture.turns.reduce((s, t) => s + t.metrics.failedToolCalls, 0);
        if (totalTools > 0) {
          const successRate = (totalTools - failedTools) / totalTools;
          expect(successRate).toBeGreaterThanOrEqual(0.9);
        }
      });

      it('tool call sequence matches metrics', () => {
        for (const turn of fixture.turns) {
          expect(turn.toolCalls.length).toBe(turn.metrics.totalToolCalls);
        }
      });
    });
  }

  describe('Cross-session metrics', () => {
    it('sessions cover diverse tool categories', () => {
      const allCategories = new Set<string>();
      for (const fixture of fixtures) {
        for (const turn of fixture.turns) {
          for (const cat of Object.keys(turn.metrics.toolUsageByCategory)) {
            allCategories.add(cat);
          }
        }
      }
      // Should have at least 4 different categories across all sessions
      expect(allCategories.size).toBeGreaterThanOrEqual(4);
    });

    it('sessions cover different complexity levels', () => {
      const toolCounts = fixtures.map((f) => f.metadata.totalToolCalls);
      const min = Math.min(...toolCounts);
      const max = Math.max(...toolCounts);
      // Should have at least 5x range between simplest and most complex
      expect(max / Math.max(min, 1)).toBeGreaterThanOrEqual(5);
    });

    it('utility: cosine similarity works', () => {
      const a = { filesystem: 10, web: 5, mcp: 3 };
      const b = { filesystem: 8, web: 6, mcp: 2 };
      const sim = cosineSimilarity(a, b);
      expect(sim).toBeGreaterThan(0.95);

      const c = { filesystem: 0, web: 10, mcp: 0 };
      const simDifferent = cosineSimilarity(a, c);
      expect(simDifferent).toBeLessThan(0.8);
    });

    it('utility: jaccard similarity works', () => {
      const a = ['file1.ts', 'file2.ts', 'file3.ts'];
      const b = ['file1.ts', 'file2.ts', 'file4.ts'];
      const sim = jaccardSimilarity(a, b);
      expect(sim).toBe(0.5); // 2 overlap / 4 total

      const exact = jaccardSimilarity(a, a);
      expect(exact).toBe(1);
    });
  });
});
