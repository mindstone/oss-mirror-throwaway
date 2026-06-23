import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupPromptService, teardownPromptService } from './helpers/promptTestSetup';

vi.mock('../../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

const mockCallBehindTheScenes = vi.fn();
vi.mock('../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenes(...args),
  getEffectiveModelName: () => 'test-model',
}));

import { getPrompt, PROMPT_IDS } from '../promptFileService';
import {
  buildStructuredMemoryUpdateSummaryPrompt,
  inferVisibility,
  getStructuredMemoryUpdateSummary,
  MEMORY_UPDATE_SCHEMA,
  parseStructuredMemoryUpdateSummaryModelText,
} from '../memoryUpdateService';
import type { AppSettings } from '@shared/types';

const fakeSettings = { auth: { token: 'test' } } as unknown as AppSettings;

function makeLlmResponse(updates: Record<string, unknown>[]) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ updates }),
    }],
  };
}

describe('memoryUpdateService', () => {
  beforeEach(() => {
    setupPromptService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownPromptService();
  });

  describe('inferVisibility', () => {
    it('returns "private" for Chief-of-Staff paths', () => {
      expect(inferVisibility('Chief-of-Staff/memory/topics/priorities.md')).toBe('private');
    });

    it('returns "private" for personal paths', () => {
      expect(inferVisibility('personal/notes/ideas.md')).toBe('private');
    });

    it('returns "shared" for work paths', () => {
      expect(inferVisibility('work/Mindstone/Exec Team/memory/topics/roadmap.md')).toBe('shared');
    });

    it('returns "shared" for legacy team paths', () => {
      expect(inferVisibility('memory/teams/engineering/standup.md')).toBe('shared');
    });

    it('defaults to "private" for unknown paths', () => {
      expect(inferVisibility('some/unknown/path.md')).toBe('private');
    });
  });

  describe('getStructuredMemoryUpdateSummary – visibility override (REBEL-124 regression)', () => {
    it('sends the prompt-file prompt and exported schema to the BTS client', async () => {
      const memoryOutput = 'Updated work/Mindstone/Exec/memory/topics/roadmap.md';
      mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse([{
        entity: 'Mindstone',
        action: 'updated',
        summary: 'Updated roadmap',
        filePath: 'work/Mindstone/Exec/memory/topics/roadmap.md',
      }]));

      await getStructuredMemoryUpdateSummary(fakeSettings, memoryOutput);

      const expectedPrompt = `${getPrompt(PROMPT_IDS.INTELLIGENCE_MEMORY_UPDATE)}

Analyze this memory update output:

${memoryOutput}`;

      expect(buildStructuredMemoryUpdateSummaryPrompt(memoryOutput)).toBe(expectedPrompt);
      expect(mockCallBehindTheScenes).toHaveBeenCalledWith(
        fakeSettings,
        expect.objectContaining({
          messages: [{ role: 'user', content: expectedPrompt }],
          maxTokens: 512,
          outputFormat: {
            type: 'json_schema',
            schema: MEMORY_UPDATE_SCHEMA,
          },
          timeout: 10000,
        }),
        { category: 'memory' },
      );
    });

    it('uses the shared safe model-text parser for markdown fenced JSON', () => {
      const parsed = parseStructuredMemoryUpdateSummaryModelText(
        '```json\n{"updates":[{"entity":"Mindstone","action":"updated","summary":"Updated roadmap","filePath":"work/Mindstone/Exec/memory/topics/roadmap.md"}]}\n```',
      );

      expect(parsed?.updates).toHaveLength(1);
      expect(parsed?.updates[0]).toMatchObject({
        entity: 'Mindstone',
        action: 'updated',
        filePath: 'work/Mindstone/Exec/memory/topics/roadmap.md',
      });
    });

    it('returns null when the structured parser finds no updates', async () => {
      mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse([]));

      await expect(getStructuredMemoryUpdateSummary(fakeSettings, 'no changes')).resolves.toBeNull();
    });

    it('truncates summaries to the production 300 character limit', async () => {
      const longSummary = 'x'.repeat(350);
      mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse([{
        entity: 'Mindstone',
        action: 'updated',
        summary: longSummary,
        filePath: 'work/Mindstone/Exec Team/memory/topics/roadmap.md',
      }]));

      const result = await getStructuredMemoryUpdateSummary(fakeSettings, 'some memory output');

      expect(result?.[0].summary).toHaveLength(300);
    });

    it('sets visibility to "private" for Chief-of-Staff paths', async () => {
      mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse([{
        entity: 'Chief of Staff',
        action: 'updated',
        summary: 'Updated priorities',
        filePath: 'Chief-of-Staff/memory/topics/priorities.md',
      }]));

      const result = await getStructuredMemoryUpdateSummary(fakeSettings, 'some memory output');

      expect(result).toHaveLength(1);
      expect(result![0].visibility).toBe('private');
    });

    it('sets visibility to "shared" for work paths', async () => {
      mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse([{
        entity: 'Mindstone',
        action: 'updated',
        summary: 'Updated roadmap',
        filePath: 'work/Mindstone/Exec Team/memory/topics/roadmap.md',
      }]));

      const result = await getStructuredMemoryUpdateSummary(fakeSettings, 'some memory output');

      expect(result).toHaveLength(1);
      expect(result![0].visibility).toBe('shared');
    });

    it('defaults to "private" when LLM omits filePath', async () => {
      mockCallBehindTheScenes.mockResolvedValueOnce(makeLlmResponse([{
        entity: 'Unknown Space',
        action: 'created',
        summary: 'Created something',
        filePath: '', // empty/missing filePath
      }]));

      const result = await getStructuredMemoryUpdateSummary(fakeSettings, 'some memory output');

      expect(result).toHaveLength(1);
      expect(result![0].visibility).toBe('private');
    });
  });
});
