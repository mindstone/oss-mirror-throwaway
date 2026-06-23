import type { SessionType } from '@core/services/promptTemplateService';

/**
 * Per-turn behavioural policy derived once at admission and passed through the turn pipeline.
 *
 * @todo v2 candidate: regroup into `{ enrichment, watchdog, concurrency, prompt, analytics }` substructures for clearer ownership boundaries.
 */
export interface TurnPolicy {
  // ===== Pre-turn enrichment =====
  prefetchUrls: boolean;
  semanticContext: 'sync' | 'async' | 'off';
  autoInjectPastConversations: boolean;

  // ===== Watchdog =====
  watchdogHardCeilingMs: number | null;
  watchdogAbortsDuringApprovalWait: boolean;

  // ===== Concurrency =====
  lane: 'foreground' | 'background';

  // ===== Self-awareness for the model =====
  /**
   * Passed to `resolveSystemPrompt()` as the `sessionType` parameter; lands in
   * `env.sessionType` in the rendered Nunjucks template (field name preserved for back-compat).
   */
  promptSessionMode: SessionType;

  // ===== Analytics =====
  origin: 'manual' | 'automation';
}
