import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupPromptService, teardownPromptService } from './helpers/promptTestSetup';

// Mock the store module
const mockGetRecommendations = vi.fn();
const mockSetRecommendations = vi.fn();
const mockIsSuppressed = vi.fn();

vi.mock('../communityVideoRecsStore', () => ({
  getRecommendations: (...args: unknown[]) => mockGetRecommendations(...args),
  setRecommendations: (...args: unknown[]) => mockSetRecommendations(...args),
  isSuppressed: () => mockIsSuppressed(),
}));

// Import after mocks
import { refreshVideoRecommendations, shuffleArray } from '../communityVideoRecsService';
import type { VideoRecsServiceDeps } from '../communityVideoRecsService';
import type { CommunityVideo } from '../communityVideoRecsTypes';

// ─── Test Fixtures ──────────────────────────────────────────────────

function makeVideo(overrides?: Partial<CommunityVideo>): CommunityVideo {
  return {
    id: 'rec-1',
    headline: 'Building AI Workflows for Sales Teams',
    speakerName: 'Sarah Chen',
    eventName: 'AI Meetup London',
    eventCity: 'London',
    eventDate: '2026-03-15T18:00:00Z',
    url: 'https://www.dropbox.com/s/abc123/video.mp4',
    eventUrl: 'https://community.mindstone.com/events/ai-meetup-london',
    ...overrides,
  };
}

function makeVideoCatalog(count: number): CommunityVideo[] {
  return Array.from({ length: count }, (_, i) =>
    makeVideo({
      id: `rec-${i + 1}`,
      headline: `Talk ${i + 1}`,
      speakerName: `Speaker ${i + 1}`,
      eventDate: new Date(2026, 2, 15 - i).toISOString(),
    }),
  );
}

function makeDeps(overrides?: Partial<VideoRecsServiceDeps>): VideoRecsServiceDeps {
  return {
    fetchVideos: vi.fn().mockResolvedValue([
      makeVideo({ id: 'rec-1', headline: 'Talk A' }),
      makeVideo({ id: 'rec-2', headline: 'Talk B' }),
      makeVideo({ id: 'rec-3', headline: 'Talk C' }),
      makeVideo({ id: 'rec-4', headline: 'Talk D' }),
      makeVideo({ id: 'rec-5', headline: 'Talk E' }),
    ]),
    getSkillNames: vi.fn().mockReturnValue(['meeting prep', 'research']),
    getToolNames: vi.fn().mockReturnValue(['Gmail', 'Calendar']),
    getTaskTypes: vi.fn().mockReturnValue(['analysis', 'writing']),
    getUseCaseTitles: vi.fn().mockReturnValue(['Weekly report', 'Email triage']),
    callBts: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        picks: [
          { videoId: 'rec-1', relevanceHint: 'Matched to your sales work' },
          { videoId: 'rec-3', relevanceHint: 'You use meeting prep weekly' },
          { videoId: 'rec-5', relevanceHint: 'Related to your email triage' },
        ],
      }),
    }),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  setupPromptService();
  vi.restoreAllMocks();
  mockGetRecommendations.mockReturnValue([]);
  mockSetRecommendations.mockReset();
  mockIsSuppressed.mockReturnValue(false);
});

afterEach(() => {
  teardownPromptService();
});

describe('refreshVideoRecommendations', () => {
  it('produces 3 valid recommendations on happy path', async () => {
    const deps = makeDeps();
    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(mockSetRecommendations).toHaveBeenCalledTimes(1);

    const [recs, timestamp] = mockSetRecommendations.mock.calls[0];
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({
      id: 'rec-1',
      headline: 'Talk A',
      relevanceHint: 'Matched to your sales work',
    });
    expect(recs[1]).toMatchObject({
      id: 'rec-3',
      headline: 'Talk C',
      relevanceHint: 'You use meeting prep weekly',
    });
    expect(recs[2]).toMatchObject({
      id: 'rec-5',
      headline: 'Talk E',
      relevanceHint: 'Related to your email triage',
    });
    expect(typeof timestamp).toBe('number');
    expect(timestamp).toBeGreaterThan(0);
  });

  it('short-circuits without fetching when suppressed', async () => {
    mockIsSuppressed.mockReturnValue(true);
    const deps = makeDeps();

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(deps.fetchVideos).not.toHaveBeenCalled();
    expect(deps.callBts).not.toHaveBeenCalled();
    expect(mockSetRecommendations).not.toHaveBeenCalled();
  });

  it('persists empty recommendations for empty video catalog', async () => {
    const deps = makeDeps({
      fetchVideos: vi.fn().mockResolvedValue([]),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(deps.callBts).not.toHaveBeenCalled();
    expect(mockSetRecommendations).toHaveBeenCalledWith([], expect.any(Number));
  });

  it('still produces recommendations with empty user profile (generic fallback)', async () => {
    const deps = makeDeps({
      getSkillNames: vi.fn().mockReturnValue([]),
      getToolNames: vi.fn().mockReturnValue([]),
      getTaskTypes: vi.fn().mockReturnValue([]),
      getUseCaseTitles: vi.fn().mockReturnValue([]),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(deps.callBts).toHaveBeenCalled();

    // Verify the prompt includes the empty profile fallback text
    const callArgs = (deps.callBts as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.userMessage).toContain(
      'No specific work profile available',
    );
  });

  it('logs error and preserves existing recommendations on malformed LLM JSON', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockResolvedValue({ content: 'not valid json {{{{' }),
    });

    const result = await refreshVideoRecommendations(deps);

    // Pipeline succeeds but no new recommendations stored (0 valid picks = no persist)
    expect(result.success).toBe(true);
    expect(mockSetRecommendations).not.toHaveBeenCalled();
  });

  it('filters out invalid videoIds from LLM response and persists valid ones', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          picks: [
            { videoId: 'rec-1', relevanceHint: 'Valid pick' },
            { videoId: 'nonexistent-id', relevanceHint: 'Invalid pick' },
            { videoId: 'rec-3', relevanceHint: 'Another valid pick' },
          ],
        }),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(mockSetRecommendations).toHaveBeenCalledTimes(1);

    const [recs] = mockSetRecommendations.mock.calls[0];
    expect(recs).toHaveLength(2);
    expect(recs[0].id).toBe('rec-1');
    expect(recs[1].id).toBe('rec-3');
  });

  it('truncates catalog to most recent 800 when exceeding cap', async () => {
    const videos = makeVideoCatalog(850);
    const deps = makeDeps({
      fetchVideos: vi.fn().mockResolvedValue(videos),
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          picks: [
            { videoId: 'rec-1', relevanceHint: 'Most recent' },
          ],
        }),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(deps.callBts).toHaveBeenCalled();

    // Verify the catalog sent to the LLM has 800 entries
    const callArgs = (deps.callBts as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const catalogMatch = callArgs.userMessage.match(/\((\d+) videos\)/);
    expect(catalogMatch).toBeTruthy();
    expect(parseInt(catalogMatch![1])).toBe(800);
  });

  it('preserves existing recommendations on pipeline failure', async () => {
    const deps = makeDeps({
      fetchVideos: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
    expect(mockSetRecommendations).not.toHaveBeenCalled();
  });

  it('preserves existing recommendations on BTS call failure', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(false);
    expect(result.error).toBe('LLM timeout');
    expect(mockSetRecommendations).not.toHaveBeenCalled();
  });

  it('calls BTS with correct category and structured output schema', async () => {
    const deps = makeDeps();
    await refreshVideoRecommendations(deps);

    expect(deps.callBts).toHaveBeenCalledTimes(1);
    const callArgs = (deps.callBts as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.category).toBe('video-recs');
    expect(callArgs.systemPrompt).toContain('recommendation engine');
    expect(callArgs.jsonSchema).toBeDefined();
    expect(callArgs.jsonSchema.properties.picks).toBeDefined();
  });

  it('caps recommendations at 3 even if LLM returns more', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          picks: [
            { videoId: 'rec-1', relevanceHint: 'Pick 1' },
            { videoId: 'rec-2', relevanceHint: 'Pick 2' },
            { videoId: 'rec-3', relevanceHint: 'Pick 3' },
            { videoId: 'rec-4', relevanceHint: 'Pick 4' },
            { videoId: 'rec-5', relevanceHint: 'Pick 5' },
          ],
        }),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    const [recs] = mockSetRecommendations.mock.calls[0];
    expect(recs).toHaveLength(3);
  });

  it('handles LLM response with missing picks field gracefully', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify({ unrelated: 'data' }),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    // No valid picks parsed → no persist
    expect(mockSetRecommendations).not.toHaveBeenCalled();
  });

  it('unwraps nested response where picks is inside a wrapper object', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          recommendations: {
            picks: [
              { videoId: 'rec-1', relevanceHint: 'Nested pick' },
            ],
          },
        }),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(mockSetRecommendations).toHaveBeenCalledTimes(1);
    const [recs] = mockSetRecommendations.mock.calls[0];
    expect(recs).toHaveLength(1);
    expect(recs[0].relevanceHint).toBe('Nested pick');
  });

  it('normalizes alternative field names (id/reason) via fallback', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          recommendations: [
            { id: 'rec-1', headline: 'AI workflows for sales', reason: 'Matches your sales work' },
            { id: 'rec-3', headline: 'Meeting prep mastery', reason: 'You use meeting prep weekly' },
          ],
        }),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(mockSetRecommendations).toHaveBeenCalledTimes(1);
    const [recs] = mockSetRecommendations.mock.calls[0];
    expect(recs).toHaveLength(2);
    expect(recs[0].id).toBe('rec-1');
    expect(recs[0].relevanceHint).toBe('Matches your sales work');
    expect(recs[1].id).toBe('rec-3');
    expect(recs[1].relevanceHint).toBe('You use meeting prep weekly');
  });

  it('normalizes snake_case field names (video_id/relevance_hint) via fallback', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          picks: [
            { video_id: 'rec-2', relevance_hint: 'Snake case pick' },
          ],
        }),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(mockSetRecommendations).toHaveBeenCalledTimes(1);
    const [recs] = mockSetRecommendations.mock.calls[0];
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('rec-2');
    expect(recs[0].relevanceHint).toBe('Snake case pick');
  });

  it('normalizes bare top-level array response', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify([
          { id: 'rec-1', headline: 'AI for sales', reason: 'Relevant to your sales focus' },
          { id: 'rec-4', headline: 'Meeting strategies', reason: 'Matches your meeting prep usage' },
        ]),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(mockSetRecommendations).toHaveBeenCalledTimes(1);
    const [recs] = mockSetRecommendations.mock.calls[0];
    expect(recs).toHaveLength(2);
    expect(recs[0].id).toBe('rec-1');
    expect(recs[0].relevanceHint).toBe('Relevant to your sales focus');
    expect(recs[1].id).toBe('rec-4');
    expect(recs[1].relevanceHint).toBe('Matches your meeting prep usage');
  });

  it('resolves videoIds with stripped article_ prefix', async () => {
    const deps = makeDeps({
      fetchVideos: vi.fn().mockResolvedValue([
        makeVideo({ id: 'article_ABC123', headline: 'Talk A' }),
        makeVideo({ id: 'article_DEF456', headline: 'Talk B' }),
      ]),
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          picks: [
            { videoId: 'ABC123', relevanceHint: 'Prefix was stripped' },
            { videoId: 'DEF456', relevanceHint: 'Also stripped' },
          ],
        }),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(mockSetRecommendations).toHaveBeenCalledTimes(1);
    const [recs] = mockSetRecommendations.mock.calls[0];
    expect(recs).toHaveLength(2);
    expect(recs[0].id).toBe('article_ABC123');
    expect(recs[1].id).toBe('article_DEF456');
  });

  it('normalizes top-level array named "results"', async () => {
    const deps = makeDeps({
      callBts: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          results: [
            { id: 'rec-5', description: 'Relevant to email triage' },
          ],
        }),
      }),
    });

    const result = await refreshVideoRecommendations(deps);

    expect(result.success).toBe(true);
    expect(mockSetRecommendations).toHaveBeenCalledTimes(1);
    const [recs] = mockSetRecommendations.mock.calls[0];
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('rec-5');
    expect(recs[0].relevanceHint).toBe('Relevant to email triage');
  });

  it('includes user profile signals in the LLM prompt', async () => {
    const deps = makeDeps();
    await refreshVideoRecommendations(deps);

    const callArgs = (deps.callBts as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.userMessage).toContain('meeting prep');
    expect(callArgs.userMessage).toContain('Gmail');
    expect(callArgs.userMessage).toContain('analysis');
    expect(callArgs.userMessage).toContain('Weekly report');
  });

  it('does not include URLs in the catalog sent to LLM', async () => {
    const deps = makeDeps();
    await refreshVideoRecommendations(deps);

    const callArgs = (deps.callBts as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.userMessage).not.toContain('dropbox.com');
    expect(callArgs.userMessage).not.toContain('.mp4');
  });
});

describe('shuffleArray', () => {
  it('returns array with same elements', () => {
    const original = [1, 2, 3, 4, 5];
    const shuffled = shuffleArray([...original]);
    expect(shuffled).toHaveLength(original.length);
    expect(shuffled.sort()).toEqual(original.sort());
  });

  it('returns empty array for empty input', () => {
    expect(shuffleArray([])).toEqual([]);
  });

  it('returns single-element array unchanged', () => {
    expect(shuffleArray([42])).toEqual([42]);
  });

  it('produces different orderings (probabilistic)', () => {
    // Run shuffle multiple times — at least one should differ from original
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let hasDifferentOrder = false;

    for (let i = 0; i < 10; i++) {
      const shuffled = shuffleArray([...original]);
      if (JSON.stringify(shuffled) !== JSON.stringify(original)) {
        hasDifferentOrder = true;
        break;
      }
    }

    expect(hasDifferentOrder).toBe(true);
  });
});
