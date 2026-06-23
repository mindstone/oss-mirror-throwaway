/**
 * Community Video Recommendations Service
 *
 * Orchestrates the video recommendations pipeline: fetch videos, build user profile,
 * LLM-rank videos, and persist top 3 picks. All external I/O is injected via deps
 * for testability, following the communityEventsService DI pattern.
 *
 * Security: Only sanitized, coarse-label profile data is sent to the LLM —
 * no raw prompts, session IDs, or reasoning detail.
 *
 * @see docs/plans/260404_spark_community_video_recommendations.md
 */

import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import type { CommunityVideo, VideoRecommendation } from './communityVideoRecsTypes';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import {
  getRecommendations,
  setRecommendations,
  isSuppressed,
} from './communityVideoRecsStore';

const log = createScopedLogger({ service: 'communityVideoRecsService' });

/** Growth safeguard: max videos to include in LLM prompt. */
const MAX_CATALOG_SIZE = 800;

// ─── Dependency Injection ───────────────────────────────────────────

export interface VideoRecsServiceDeps {
  fetchVideos: () => Promise<CommunityVideo[]>;
  getSkillNames: () => string[];
  getToolNames: () => string[];
  getTaskTypes: (limit: number) => string[];
  getUseCaseTitles: () => string[];
  callBts: (params: {
    category: string;
    systemPrompt: string;
    userMessage: string;
    jsonSchema?: object;
  }) => Promise<{ content: string }>;
}

// ─── LLM Response Schema ────────────────────────────────────────────

const VideoPickSchema = z.object({
  videoId: z.string(),
  relevanceHint: z.string(),
});

const LlmResponseSchema = z.object({
  picks: z.array(VideoPickSchema),
});

// ─── Structured Output JSON Schema (for BTS outputFormat) ───────────

const VIDEO_RECS_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    picks: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          videoId: { type: 'string' as const },
          relevanceHint: { type: 'string' as const },
        },
        required: ['videoId', 'relevanceHint'],
      },
    },
  },
  required: ['picks'],
};

// ─── LLM Prompts ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a recommendation engine. Given a user's work profile and a catalog of community talk videos, select the 3 most relevant videos. For each, provide a brief one-sentence relevance hint explaining why it matches the user. Prioritize: (1) topic relevance to user's actual work, (2) recency of the video, (3) diversity of recommendations (avoid picking 3 similar topics). Respond with JSON only.`;

// ─── Main Entry Point ───────────────────────────────────────────────

export interface VideoRecsResult {
  success: boolean;
  error?: string;
}

/**
 * Run the full video recommendations pipeline.
 *
 * Pipeline: suppress check → fetch videos → build profile → LLM rank → persist
 * Atomic persistence: only replaces store after full pipeline success.
 * On any error: logs warning, preserves existing recommendations.
 */
export async function refreshVideoRecommendations(
  deps: VideoRecsServiceDeps,
): Promise<VideoRecsResult> {
  // 1. Check if suppressed
  if (isSuppressed()) {
    log.info('Video recommendations suppressed, skipping');
    return { success: true };
  }

  try {
    // 2. Fetch videos from GraphQL
    log.info('Fetching community videos for recommendation pipeline');
    const allVideos = await deps.fetchVideos();

    // 3. If no videos, persist empty recommendations and return
    if (allVideos.length === 0) {
      log.info('No community videos available, persisting empty recommendations');
      setRecommendations([], Date.now());
      return { success: true };
    }

    // 4. Growth safeguard: if > 800 videos, truncate to most recent 800 by eventDate
    let catalog = allVideos;
    if (catalog.length > MAX_CATALOG_SIZE) {
      log.info(
        { total: catalog.length, cap: MAX_CATALOG_SIZE },
        'Video catalog exceeds cap, truncating to most recent',
      );
      catalog = [...catalog]
        .sort((a, b) => new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime())
        .slice(0, MAX_CATALOG_SIZE);
    }

    // 5. Shuffle catalog order randomly to mitigate positional bias
    catalog = shuffleArray([...catalog]);

    // 6. Build sanitized user profile summary
    const profileSummary = buildProfileSummary(deps);

    // 7. Build user message with profile + catalog
    const catalogJson = catalog.map((v) => ({
      id: v.id,
      headline: v.headline,
      speakerName: v.speakerName,
      eventCity: v.eventCity,
      eventDate: v.eventDate,
    }));

    const userMessage = `## User Work Profile\n${profileSummary}\n\n## Video Catalog (${catalog.length} videos)\n${JSON.stringify(catalogJson)}`;

    // 8. Call BTS with category 'video-recs'
    log.info({ catalogSize: catalog.length }, 'Calling LLM for video ranking');
    const response = await deps.callBts({
      category: 'video-recs',
      systemPrompt: getPrompt(PROMPT_IDS.INTELLIGENCE_COMMUNITY_VIDEO_RECS),
      userMessage,
      jsonSchema: VIDEO_RECS_JSON_SCHEMA,
    });

    // 9. Parse and validate response
    const recommendations = parseAndValidateResponse(response.content, catalog);

    // 10. Atomic persist: only if we got at least 1 valid pick
    if (recommendations.length > 0) {
      setRecommendations(recommendations, Date.now());
      log.info({ recCount: recommendations.length }, 'Video recommendations generated successfully');
    } else {
      log.warn('LLM returned no valid recommendations, preserving existing');
    }

    return { success: true };
  } catch (error) {
    // On any error: log structured warning, preserve existing recommendations
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Video recommendation pipeline failed, preserving existing recommendations',
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────

/**
 * Build a sanitized user profile summary from coarse labels only.
 * SECURITY: Never includes raw prompts, session IDs, or reasoning detail.
 */
function buildProfileSummary(deps: VideoRecsServiceDeps): string {
  const skills = deps.getSkillNames();
  const tools = deps.getToolNames();
  const taskTypes = deps.getTaskTypes(10);
  const useCases = deps.getUseCaseTitles();

  const hasAnySignals =
    skills.length > 0 || tools.length > 0 || taskTypes.length > 0 || useCases.length > 0;

  if (!hasAnySignals) {
    return 'No specific work profile available — recommend the most popular/impressive recent talks across diverse topics.';
  }

  const parts: string[] = [];
  if (skills.length > 0) parts.push(`Frequent skills: ${skills.join(', ')}`);
  if (tools.length > 0) parts.push(`Frequent tools: ${tools.join(', ')}`);
  if (taskTypes.length > 0) parts.push(`Recent task types: ${taskTypes.join(', ')}`);
  if (useCases.length > 0) parts.push(`Use cases: ${useCases.join(', ')}`);

  return parts.join('\n');
}

/**
 * Normalize a single pick object from the LLM response.
 * Some models return { id, headline, reason } instead of { videoId, relevanceHint }.
 * Maps common alternative field names to the canonical schema.
 */
function normalizePick(raw: Record<string, unknown>): { videoId: string; relevanceHint: string } | null {
  const videoId = (raw.videoId ?? raw.video_id ?? raw.id) as string | undefined;
  const relevanceHint = (raw.relevanceHint ?? raw.relevance_hint ?? raw.reason ?? raw.headline ?? raw.description) as string | undefined;
  if (typeof videoId !== 'string' || !videoId) return null;
  return { videoId, relevanceHint: typeof relevanceHint === 'string' ? relevanceHint : '' };
}

/**
 * Extract a picks array from the parsed LLM response.
 * Handles: bare top-level array, { picks: [...] }, { recommendations: [...] },
 * { results: [...] }, and nested wrappers like { recommendations: { picks: [...] } }.
 */
function extractPicksArray(parsed: unknown): unknown[] | null {
  // Bare top-level array: [{id, headline}, ...]
  if (Array.isArray(parsed)) return parsed;

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // Direct top-level array fields
  for (const key of ['picks', 'recommendations', 'results', 'videos']) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }

  // Nested: { wrapper: { picks: [...] } } or { wrapper: [...] }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const inner = value as Record<string, unknown>;
      for (const innerKey of ['picks', 'recommendations', 'results', 'videos']) {
        if (Array.isArray(inner[innerKey])) return inner[innerKey] as unknown[];
      }
    }
  }

  return null;
}

/**
 * Parse LLM response, validate against Zod schema with fallback normalization,
 * verify videoIds exist in catalog, and build VideoRecommendation[] enriched
 * with relevanceHint.
 *
 * Two-phase parsing:
 * 1. Try strict Zod validation (ideal — model followed the schema exactly).
 * 2. Fallback: extract any array of pick-like objects and normalize field names.
 *    This handles models that use { id, reason } instead of { videoId, relevanceHint }.
 */
function parseAndValidateResponse(
  content: string,
  catalog: CommunityVideo[],
): VideoRecommendation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    log.warn(
      { contentLength: content.length, contentPreview: content.slice(0, 200) },
      'Failed to parse LLM response as JSON',
    );
    return [];
  }

  // Phase 1: Strict Zod validation — try top-level first, then unwrap common nesting
  let result = LlmResponseSchema.safeParse(parsed);
  if (!result.success && parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const value of Object.values(obj)) {
      const nested = LlmResponseSchema.safeParse(value);
      if (nested.success) {
        result = nested;
        break;
      }
    }
  }

  // Build lookup map for catalog
  const catalogMap = new Map(catalog.map((v) => [v.id, v]));

  if (result.success) {
    return buildRecommendations(result.data.picks, catalogMap);
  }

  // Phase 2: Fallback — extract array and normalize field names
  log.info('Strict Zod validation failed, attempting fallback normalization');
  const rawPicks = extractPicksArray(parsed);
  if (!rawPicks || rawPicks.length === 0) {
    log.warn(
      { contentPreview: content.slice(0, 200) },
      'LLM response has no recognizable picks array after fallback',
    );
    return [];
  }

  const normalizedPicks: Array<{ videoId: string; relevanceHint: string }> = [];
  for (const item of rawPicks) {
    if (item && typeof item === 'object') {
      const normalized = normalizePick(item as Record<string, unknown>);
      if (normalized) normalizedPicks.push(normalized);
    }
  }

  if (normalizedPicks.length === 0) {
    log.warn(
      { contentPreview: content.slice(0, 200) },
      'LLM response items could not be normalized to valid picks',
    );
    return [];
  }

  log.info({ normalizedCount: normalizedPicks.length }, 'Fallback normalization produced picks');
  return buildRecommendations(normalizedPicks, catalogMap);
}

/**
 * Build VideoRecommendation[] from validated picks, filtering to catalog entries.
 * Caps at 3 recommendations.
 *
 * Tolerates LLM stripping common ID prefixes (e.g. "article_") by trying
 * both the raw ID and common prefix variants during catalog lookup.
 */
function buildRecommendations(
  picks: Array<{ videoId: string; relevanceHint: string }>,
  catalogMap: Map<string, CommunityVideo>,
): VideoRecommendation[] {
  const recommendations: VideoRecommendation[] = [];
  for (const pick of picks) {
    const video = catalogMap.get(pick.videoId)
      ?? catalogMap.get(`article_${pick.videoId}`);
    if (!video) {
      log.warn({ videoId: pick.videoId }, 'LLM returned videoId not found in catalog, skipping');
      continue;
    }
    recommendations.push({
      ...video,
      relevanceHint: pick.relevanceHint,
    });
  }
  return recommendations.slice(0, 3);
}

/**
 * Fisher-Yates shuffle to randomize array order.
 * Mitigates LLM positional bias ("lost in the middle" effect).
 */
export function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Get current recommendations from the store (for card data assembly).
 * Re-exported for convenience from the store.
 */
export { getRecommendations, isSuppressed };
