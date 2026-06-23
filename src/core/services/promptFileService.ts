/**
 * Prompt File Service
 *
 * Loads externalized LLM prompts from markdown files with YAML frontmatter.
 * Prompts live in `rebel-system/prompts/` and are read at runtime.
 *
 * Key design decisions:
 * - Caches RAW template text (not rendered output) to avoid stale-cache bugs
 * - Nunjucks rendering happens per-call with provided variables
 * - `getRawPrompt()` for user-content variables (avoids template injection)
 * - Lazy access: always call inside functions, never at module scope
 * - Phase-specific error logging: read / parse / render failures
 *
 * @see docs/plans/260406_prompt_externalization.md
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import fm from 'front-matter';
import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import { sharedNunjucksEnv } from '@core/services/nunjucksConfig';
import { getSystemSettingsPath } from './systemSettingsSync';

const log = createScopedLogger({ service: 'promptFile' });

// =============================================================================
// Frontmatter Schema
// =============================================================================

export const PromptFrontmatterSchema = z.object({
  /** Human-readable description of what this prompt does */
  description: z.string().min(1, 'description is required'),
  /** Source service file that consumes this prompt */
  service: z.string().min(1, 'service is required'),
  /** Template variables expected by this prompt (empty array for static prompts) */
  variables: z.array(z.string()).default([]),
  /** Hint for which model tier this prompt targets */
  model_hint: z.string().optional(),
  /** Whether this prompt is critical for app safety/startup */
  critical: z.boolean().default(false),
});

export type PromptFrontmatter = z.infer<typeof PromptFrontmatterSchema>;

// =============================================================================
// Warm Outcome Types
// =============================================================================

/** A single prompt that failed to warm, with its criticality + error reason. */
export interface PromptWarmFailure {
  id: string;
  critical: boolean;
  error: string;
}

/**
 * Structured result of `warmAllPrompts()`.
 *
 * Additive return (the function still throws on critical failure for desktop
 * back-compat — see `warmAllPrompts()`). Callers that only care about the
 * throw contract can keep ignoring this value.
 */
export interface PromptWarmOutcome {
  warmed: number;
  failed: number;
  criticalFailed: number;
  failures: PromptWarmFailure[];
}

// =============================================================================
// Prompt Metadata & Registry
// =============================================================================

export interface PromptMetadata {
  /** File path relative to prompts root (e.g. 'conversation/title') */
  id: string;
  /** Expected Nunjucks/template variables */
  variables: string[];
  /** Whether startup failure should be fatal */
  critical: boolean;
  /** Source service file */
  service: string;
}

/**
 * Typed prompt IDs — compile-time typo detection.
 * Populated as prompts are externalized (Stage 2: core prompts).
 */
export const PROMPT_IDS = {
  // Conversation
  CONVERSATION_COMPACTION: 'conversation/compaction',
  CONVERSATION_TITLE: 'conversation/title',
  CONVERSATION_AUTO_CONTINUE: 'conversation/auto-continue',
  CONVERSATION_SUMMARY: 'conversation/summary',

  // Intelligence
  INTELLIGENCE_HERO_CHOICE: 'intelligence/hero-choice',
  INTELLIGENCE_DAILY_SPARK: 'intelligence/daily-spark',
  INTELLIGENCE_NARRATIVE_ANALYSIS: 'intelligence/narrative-analysis',
  INTELLIGENCE_QUERY_GENERATION: 'intelligence/query-generation',
  INTELLIGENCE_MEETING_ANALYSIS: 'intelligence/meeting-analysis',
  INTELLIGENCE_CALENDAR_SYNC: 'intelligence/calendar-sync',
  INTELLIGENCE_MEMORY_UPDATE: 'intelligence/memory-update',
  INTELLIGENCE_COMMUNITY_VIDEO_RECS: 'intelligence/community-video-recs',
  INTELLIGENCE_WEEKLY_ASSESSMENT: 'intelligence/weekly-assessment',
  INTELLIGENCE_EVIDENCE_COLLECTION: 'intelligence/evidence-collection',

  // Agent
  AGENT_FORAGER: 'agent/forager',
  AGENT_TOOL_OUTPUT_CURATOR: 'agent/tool-output-curator',
  AGENT_CONTEXT_STATE_UPDATE: 'agent/context-state-update',
  AGENT_PLANNING_INSTRUCTIONS: 'agent/planning-instructions',

  // Utility
  UTILITY_WORKSPACE_MERGE: 'utility/workspace-merge',
  UTILITY_TRANSCRIPTION: 'utility/transcription',
  UTILITY_QUIP_STYLE: 'utility/quip-style',
  UTILITY_SPACES_SYNTHESIS: 'utility/spaces-synthesis',
  UTILITY_ONBOARDING_COACH: 'utility/onboarding-coach',
  UTILITY_BUG_REPORT_ANALYSIS: 'utility/bug-report-analysis',
  UTILITY_PLUGIN_MERGE: 'utility/plugin-merge',
  UTILITY_TRANSCRIPT_CLEANUP: 'utility/transcript-cleanup',
  UTILITY_MEETING_CONVERSATION_STATE: 'utility/meeting-conversation-state',
  UTILITY_ACTIVITY_SUMMARY: 'utility/activity-summary',

  // Safety
  SAFETY_DONE_EVALUATION: 'safety/done-evaluation',
  SAFETY_PUBLIC_BROADCAST: 'safety/public-broadcast',
  SAFETY_MIGRATION_PHASE1: 'safety/migration-phase1',
  SAFETY_MIGRATION_PHASE2: 'safety/migration-phase2',
  SAFETY_EVAL_SYSTEM: 'safety/eval-system',
  SAFETY_DENY_OPTIONS_SYSTEM: 'safety/deny-options-system',
  SAFETY_DENY_APPLY_SYSTEM: 'safety/deny-apply-system',
  SAFETY_CONSOLIDATION: 'safety/consolidation',
  SAFETY_MEMORY_CONTENT_SUMMARY: 'safety/memory-content-summary',
  SAFETY_USER_INTENT_CLASSIFIER: 'safety/user-intent-classifier',
} as const;

export type PromptId = string;

/**
 * Maps prompt IDs to metadata (expected variables, criticality, service).
 * Populated alongside PROMPT_IDS.
 */
export const PROMPT_REGISTRY: Map<string, PromptMetadata> = new Map([
  // Conversation
  [PROMPT_IDS.CONVERSATION_COMPACTION, { id: PROMPT_IDS.CONVERSATION_COMPACTION, variables: [], critical: false, service: 'src/core/services/compactionService.ts' }],
  [PROMPT_IDS.CONVERSATION_TITLE, { id: PROMPT_IDS.CONVERSATION_TITLE, variables: [], critical: false, service: 'src/core/services/conversationTitleService.ts' }],
  [PROMPT_IDS.CONVERSATION_AUTO_CONTINUE, { id: PROMPT_IDS.CONVERSATION_AUTO_CONTINUE, variables: [], critical: false, service: 'src/core/services/autoContinueHook.ts' }],
  [PROMPT_IDS.CONVERSATION_SUMMARY, { id: PROMPT_IDS.CONVERSATION_SUMMARY, variables: [], critical: false, service: 'src/core/services/conversationSummaryService.ts' }],

  // Intelligence
  [PROMPT_IDS.INTELLIGENCE_HERO_CHOICE, { id: PROMPT_IDS.INTELLIGENCE_HERO_CHOICE, variables: [], critical: false, service: 'src/core/services/heroChoiceService.ts' }],
  [PROMPT_IDS.INTELLIGENCE_DAILY_SPARK, { id: PROMPT_IDS.INTELLIGENCE_DAILY_SPARK, variables: [], critical: false, service: 'src/core/services/dailySparkService.ts' }],
  [PROMPT_IDS.INTELLIGENCE_NARRATIVE_ANALYSIS, { id: PROMPT_IDS.INTELLIGENCE_NARRATIVE_ANALYSIS, variables: [], critical: false, service: 'src/core/services/narrativeAnalysisService.ts' }],
  [PROMPT_IDS.INTELLIGENCE_QUERY_GENERATION, { id: PROMPT_IDS.INTELLIGENCE_QUERY_GENERATION, variables: [], critical: false, service: 'src/core/services/queryGenerationService.ts' }],
  [PROMPT_IDS.INTELLIGENCE_MEETING_ANALYSIS, { id: PROMPT_IDS.INTELLIGENCE_MEETING_ANALYSIS, variables: [], critical: false, service: 'src/core/services/meetingAnalysisPrompt.ts' }],
  [PROMPT_IDS.INTELLIGENCE_CALENDAR_SYNC, { id: PROMPT_IDS.INTELLIGENCE_CALENDAR_SYNC, variables: [], critical: false, service: 'src/core/services/calendarSyncService.ts' }],
  [PROMPT_IDS.INTELLIGENCE_MEMORY_UPDATE, { id: PROMPT_IDS.INTELLIGENCE_MEMORY_UPDATE, variables: [], critical: false, service: 'src/core/services/memoryUpdateService.ts' }],
  [PROMPT_IDS.INTELLIGENCE_COMMUNITY_VIDEO_RECS, { id: PROMPT_IDS.INTELLIGENCE_COMMUNITY_VIDEO_RECS, variables: [], critical: false, service: 'src/core/services/communityVideoRecsService.ts' }],
  [PROMPT_IDS.INTELLIGENCE_WEEKLY_ASSESSMENT, { id: PROMPT_IDS.INTELLIGENCE_WEEKLY_ASSESSMENT, variables: ['sessions'], critical: false, service: 'src/core/services/weeklyAssessmentService.ts' }],
  [PROMPT_IDS.INTELLIGENCE_EVIDENCE_COLLECTION, { id: PROMPT_IDS.INTELLIGENCE_EVIDENCE_COLLECTION, variables: ['transcript', 'tools_used'], critical: false, service: 'src/core/services/evidenceCollectionService.ts' }],

  // Agent
  [PROMPT_IDS.AGENT_FORAGER, { id: PROMPT_IDS.AGENT_FORAGER, variables: [], critical: false, service: 'src/core/rebelCore/foragerPrompt.ts' }],
  [PROMPT_IDS.AGENT_TOOL_OUTPUT_CURATOR, { id: PROMPT_IDS.AGENT_TOOL_OUTPUT_CURATOR, variables: [], critical: false, service: 'src/core/rebelCore/toolOutputCurator.ts' }],
  [PROMPT_IDS.AGENT_CONTEXT_STATE_UPDATE, { id: PROMPT_IDS.AGENT_CONTEXT_STATE_UPDATE, variables: ['categories'], critical: false, service: 'src/core/rebelCore/contextStateUpdate.ts' }],
  [PROMPT_IDS.AGENT_PLANNING_INSTRUCTIONS, { id: PROMPT_IDS.AGENT_PLANNING_INSTRUCTIONS, variables: [], critical: false, service: 'src/core/rebelCore/planningMode.ts' }],

  // Utility
  [PROMPT_IDS.UTILITY_WORKSPACE_MERGE, { id: PROMPT_IDS.UTILITY_WORKSPACE_MERGE, variables: [], critical: false, service: 'src/core/services/workspaceConflictResolver.ts' }],
  [PROMPT_IDS.UTILITY_TRANSCRIPTION, { id: PROMPT_IDS.UTILITY_TRANSCRIPTION, variables: [], critical: false, service: 'src/core/services/audioService.ts' }],
  [PROMPT_IDS.UTILITY_QUIP_STYLE, { id: PROMPT_IDS.UTILITY_QUIP_STYLE, variables: ['quips_per_request'], critical: false, service: 'src/core/services/quipGeneratorService.ts' }],
  [PROMPT_IDS.UTILITY_SPACES_SYNTHESIS, { id: PROMPT_IDS.UTILITY_SPACES_SYNTHESIS, variables: ['focus'], critical: false, service: 'src/main/services/spacesSynthesisService.ts' }],
  [PROMPT_IDS.UTILITY_ONBOARDING_COACH, { id: PROMPT_IDS.UTILITY_ONBOARDING_COACH, variables: [], critical: false, service: 'src/main/services/onboardingCoachPrompt.ts' }],
  [PROMPT_IDS.UTILITY_BUG_REPORT_ANALYSIS, { id: PROMPT_IDS.UTILITY_BUG_REPORT_ANALYSIS, variables: [], critical: false, service: 'src/main/services/bugReportAnalysisService.ts' }],
  [PROMPT_IDS.UTILITY_PLUGIN_MERGE, { id: PROMPT_IDS.UTILITY_PLUGIN_MERGE, variables: [], critical: false, service: 'src/main/services/pluginConflictService.ts' }],
  [PROMPT_IDS.UTILITY_TRANSCRIPT_CLEANUP, { id: PROMPT_IDS.UTILITY_TRANSCRIPT_CLEANUP, variables: [], critical: false, service: 'src/main/services/meetingBot/transcriptStorage.ts' }],
  [PROMPT_IDS.UTILITY_MEETING_CONVERSATION_STATE, { id: PROMPT_IDS.UTILITY_MEETING_CONVERSATION_STATE, variables: [], critical: false, service: 'src/main/services/meetingBot/conversationStateService.ts' }],
  [PROMPT_IDS.UTILITY_ACTIVITY_SUMMARY, { id: PROMPT_IDS.UTILITY_ACTIVITY_SUMMARY, variables: [], critical: false, service: 'src/core/services/activitySummaryService.ts' }],

  // Safety
  [PROMPT_IDS.SAFETY_DONE_EVALUATION, { id: PROMPT_IDS.SAFETY_DONE_EVALUATION, variables: ['user_message', 'response_text'], critical: true, service: 'src/core/services/doneSafetyService.ts' }],
  [PROMPT_IDS.SAFETY_PUBLIC_BROADCAST, { id: PROMPT_IDS.SAFETY_PUBLIC_BROADCAST, variables: ['REPLY_CONTENT', 'SURFACE_KIND', 'INBOUND_TRIGGER_DESCRIPTION', 'AUDIENCE_VISIBILITY_STATEMENT'], critical: true, service: 'src/main/services/inboundTriggers/publicBroadcastSafetyHook.ts' }],
  [PROMPT_IDS.SAFETY_MIGRATION_PHASE1, { id: PROMPT_IDS.SAFETY_MIGRATION_PHASE1, variables: ['name', 'description'], critical: true, service: 'src/core/safetyPromptMigration.ts' }],
  [PROMPT_IDS.SAFETY_MIGRATION_PHASE2, { id: PROMPT_IDS.SAFETY_MIGRATION_PHASE2, variables: [], critical: true, service: 'src/core/safetyPromptMigration.ts' }],
  [PROMPT_IDS.SAFETY_EVAL_SYSTEM, { id: PROMPT_IDS.SAFETY_EVAL_SYSTEM, variables: [], critical: true, service: 'src/core/safetyPromptLogic.ts' }],
  [PROMPT_IDS.SAFETY_DENY_OPTIONS_SYSTEM, { id: PROMPT_IDS.SAFETY_DENY_OPTIONS_SYSTEM, variables: [], critical: true, service: 'src/core/safetyPromptLogic.ts' }],
  [PROMPT_IDS.SAFETY_DENY_APPLY_SYSTEM, { id: PROMPT_IDS.SAFETY_DENY_APPLY_SYSTEM, variables: [], critical: true, service: 'src/core/safetyPromptLogic.ts' }],
  [PROMPT_IDS.SAFETY_CONSOLIDATION, { id: PROMPT_IDS.SAFETY_CONSOLIDATION, variables: [], critical: false, service: 'src/core/safetyPromptLogic.ts' }],
  [PROMPT_IDS.SAFETY_MEMORY_CONTENT_SUMMARY, { id: PROMPT_IDS.SAFETY_MEMORY_CONTENT_SUMMARY, variables: [], critical: false, service: 'src/main/services/safety/memoryWriteHook.ts' }],
  [PROMPT_IDS.SAFETY_USER_INTENT_CLASSIFIER, { id: PROMPT_IDS.SAFETY_USER_INTENT_CLASSIFIER, variables: [], critical: false, service: 'src/core/services/safety/userIntentExtractor.ts' }],
]);

// =============================================================================
// Module State
// =============================================================================

let promptsRootPath: string | null = null;
const templateCache = new Map<string, string>();
const metadataCache = new Map<string, PromptFrontmatter>();

/**
 * Records the outcome of the most recent `warmAllPrompts()` run, scoped to
 * critical prompts. `null` until warm has run at least once.
 *
 * This is the seam the cloud `/api/health` detailed readiness check reads
 * (`getCriticalPromptWarmStatus()` → `checkCriticalPrompts()`): it is recorded
 * INSIDE `warmAllPrompts()` BEFORE its existing throw, so even though the cloud
 * bootstrap guard swallows that throw (deliberately non-fatal), the health
 * check still observes which critical prompts are unavailable. See the
 * design brief at docs/plans/260618_cloud-health-critical-prompt/.
 */
let lastCriticalPromptWarm: { ranAt: number; failedCriticalIds: string[] } | null = null;

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configure the prompt file service with the root path to the prompts directory.
 *
 * This is an explicit override + warm trigger: calling it during bootstrap pins
 * the prompts root and lets `warmAllPrompts()` pre-read files. It is no longer
 * *required* — if a prompt read happens before this runs (cross-surface race or
 * a surface that never wires it, e.g. cloud), `ensureConfigured()` lazily resolves
 * the same default root (`getSystemSettingsPath()/prompts`). An explicit call here
 * still wins over the lazy default.
 *
 * @param rootPath - Absolute path to the prompts directory (e.g. `rebel-system/prompts/`)
 */
export function configurePromptFileService(rootPath: string): void {
  promptsRootPath = rootPath;

  if (!existsSync(rootPath)) {
    log.warn(
      { path: rootPath },
      'Prompts directory does not exist — prompt files will not be available until created',
    );
  } else {
    log.info({ path: rootPath }, 'Prompt file service configured');
  }
}

// =============================================================================
// Pure Helpers (exported for testability)
// =============================================================================

/**
 * Parse a raw prompt file into frontmatter + body.
 * Normalises CRLF to LF before parsing.
 *
 * @throws {Error} if frontmatter is missing or invalid per Zod schema
 */
export function parsePromptFile(raw: string): { frontmatter: PromptFrontmatter; body: string } {
  // CRLF normalization
  const normalized = raw.replace(/\r\n/g, '\n');

  const parsed = fm<Record<string, unknown>>(normalized);

  const result = PromptFrontmatterSchema.safeParse(parsed.attributes);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid frontmatter: ${issues}`);
  }

  const body = parsed.body.trim();
  if (body.length === 0) {
    throw new Error('Prompt body is empty (only frontmatter found)');
  }

  return { frontmatter: result.data, body };
}

/**
 * Render a prompt template body with Nunjucks variables.
 *
 * @throws {Error} on undefined variables or template syntax errors
 */
export function renderPromptTemplate(
  body: string,
  variables: Record<string, unknown> = {},
): string {
  return sharedNunjucksEnv.renderString(body, variables);
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Ensure the prompts root is resolved before a read.
 *
 * Fast path: an explicit `configurePromptFileService()` call wins and returns
 * immediately. Otherwise — to make the "read before configure" state
 * unrepresentable across surfaces (desktop init-order race; cloud never wires it
 * at all; REBEL-63K) — lazily resolve the SAME default desktop bootstrap uses
 * (`getSystemSettingsPath()/prompts`, byte-identical to coreStartup §4b) and
 * memoize it. The resolved root is `rebel-system/prompts`, which exists as a dev
 * submodule, a bundled prod resource, and `/app/rebel-system/prompts` on cloud.
 *
 * Fails loud (throws) if the resolved default directory does not exist — that is a
 * genuine packaging/deploy problem (prompts not shipped), not a state we should
 * silently paper over with wrong/missing prompts.
 *
 * @throws {Error} if no explicit root is set and the default prompts directory is absent.
 */
function ensureConfigured(): void {
  if (promptsRootPath !== null) {
    return;
  }

  const fallbackRoot = path.join(getSystemSettingsPath(), 'prompts');
  if (!existsSync(fallbackRoot)) {
    throw new Error(
      `promptFileService: default prompts directory not found at '${fallbackRoot}' — ` +
        'the rebel-system/prompts directory may not have been shipped with this build. ' +
        'Call configurePromptFileService() during bootstrap or fix the deploy.',
    );
  }

  // Memoize so we never re-resolve per call.
  promptsRootPath = fallbackRoot;
  log.warn(
    { path: fallbackRoot },
    'Prompt file service read before explicit configuration — auto-resolved default prompts root',
  );
}

export function resolvePromptPath(promptId: string): string {
  ensureConfigured();
  return path.join(promptsRootPath as string, `${promptId}.md`);
}

/**
 * Read, parse, and cache a prompt file. Returns the raw template body.
 */
function loadPrompt(promptId: string): string {
  // Return cached template if available
  const cached = templateCache.get(promptId);
  if (cached !== undefined) {
    return cached;
  }

  const filePath = resolvePromptPath(promptId);

  // Phase: read
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log.error(
      { promptId, path: filePath, phase: 'read', code },
      'Failed to read prompt file',
    );
    throw new Error(`Failed to read prompt file '${promptId}': ${code === 'ENOENT' ? 'file not found' : (err as Error).message}`);
  }

  // Phase: parse
  let frontmatter: PromptFrontmatter;
  let body: string;
  try {
    const result = parsePromptFile(raw);
    frontmatter = result.frontmatter;
    body = result.body;
  } catch (err) {
    log.error(
      { promptId, path: filePath, phase: 'parse', err: (err as Error).message },
      'Failed to parse prompt file',
    );
    throw new Error(`Failed to parse prompt file '${promptId}': ${(err as Error).message}`);
  }

  // Cache raw template and metadata
  templateCache.set(promptId, body);
  metadataCache.set(promptId, frontmatter);

  return body;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get a rendered prompt by ID.
 * Reads the file (or cache), strips frontmatter, caches the RAW template,
 * then renders Nunjucks variables on each call.
 *
 * @param promptId - Prompt identifier (maps to file path relative to prompts root)
 * @param variables - Nunjucks template variables to substitute
 * @returns Rendered prompt string
 * @throws {Error} on missing file, invalid template, or undefined variables
 */
export function getPrompt(promptId: PromptId, variables?: Record<string, unknown>): string {
  ensureConfigured();

  const body = loadPrompt(promptId);

  // Phase: render
  try {
    return renderPromptTemplate(body, variables);
  } catch (err) {
    const meta = PROMPT_REGISTRY.get(promptId);
    log.error(
      {
        promptId,
        phase: 'render',
        critical: meta?.critical ?? false,
        err: (err as Error).message,
      },
      'Failed to render prompt template',
    );
    throw new Error(`Failed to render prompt '${promptId}': ${(err as Error).message}`);
  }
}

/**
 * Get the raw (unrendered) template body for a prompt.
 * Use this for prompts with user-generated content where Nunjucks
 * rendering would be unsafe (e.g. user content containing `{{ }}`).
 * The caller does `getRawPrompt(id).replace('{{placeholder}}', value)`.
 *
 * @param promptId - Prompt identifier
 * @returns Raw template string (frontmatter stripped)
 */
export function getRawPrompt(promptId: PromptId): string {
  ensureConfigured();
  return loadPrompt(promptId);
}

/**
 * Get parsed frontmatter metadata for a prompt.
 *
 * @param promptId - Prompt identifier
 * @returns Parsed and validated frontmatter
 */
export function getPromptMetadata(promptId: PromptId): PromptFrontmatter {
  ensureConfigured();

  // Load if not cached
  const cached = metadataCache.get(promptId);
  if (cached) return cached;

  // Loading the prompt will populate metadataCache
  loadPrompt(promptId);

  const meta = metadataCache.get(promptId);
  if (!meta) {
    throw new Error(`Metadata not available for prompt '${promptId}' after loading`);
  }
  return meta;
}

/**
 * Pre-read all registered prompts at startup.
 *
 * Critical prompts cause a fatal error on failure (the throw below is kept
 * BYTE-IDENTICAL for desktop back-compat — `coreStartup.ts §4b` and the cloud
 * `bootstrap.ts` guard both await this in a try/catch and depend on the throw).
 * Non-critical prompts log a warning and continue.
 *
 * Returns a structured {@link PromptWarmOutcome} (additive — existing callers
 * ignore the return). The critical-prompt status is ALSO recorded at module
 * level (`getCriticalPromptWarmStatus()`) BEFORE the throw, so the cloud
 * `/api/health` detailed readiness check can name unavailable critical prompts
 * even when the bootstrap guard swallows the throw.
 */
export async function warmAllPrompts(): Promise<PromptWarmOutcome> {
  if (PROMPT_REGISTRY.size === 0) {
    log.debug('No prompts registered in PROMPT_REGISTRY — skipping warmup');
    lastCriticalPromptWarm = { ranAt: Date.now(), failedCriticalIds: [] };
    return { warmed: 0, failed: 0, criticalFailed: 0, failures: [] };
  }

  ensureConfigured();

  const results = { loaded: 0, failed: 0, critical_failed: 0 };
  const failures: PromptWarmFailure[] = [];

  for (const [promptId, meta] of PROMPT_REGISTRY) {
    try {
      loadPrompt(promptId);
      results.loaded++;
    } catch (err) {
      results.failed++;
      const message = (err as Error).message;
      failures.push({ id: promptId, critical: meta.critical, error: message });
      if (meta.critical) {
        results.critical_failed++;
        log.error(
          { promptId, critical: true, err: message },
          'Failed to warm critical prompt — this may cause startup failure',
        );
      } else {
        log.warn(
          { promptId, critical: false, err: message },
          'Failed to warm non-critical prompt — feature may be degraded',
        );
      }
    }
  }

  log.info(
    { total: PROMPT_REGISTRY.size, ...results },
    'Prompt warmup complete',
  );

  // Record the critical-prompt warm status BEFORE the throw, so the cloud
  // health check observes the unavailable ids even though the bootstrap guard
  // catches and discards the thrown error (deliberately non-fatal).
  const failedCriticalIds = failures.filter((f) => f.critical).map((f) => f.id);
  lastCriticalPromptWarm = { ranAt: Date.now(), failedCriticalIds };

  const outcome: PromptWarmOutcome = {
    warmed: results.loaded,
    failed: results.failed,
    criticalFailed: results.critical_failed,
    failures,
  };

  if (results.critical_failed > 0) {
    throw new Error(
      `${results.critical_failed} critical prompt(s) failed to load during warmup`,
    );
  }

  return outcome;
}

/**
 * Invalidate cached prompt template(s).
 * Primarily for dev mode — forces re-read from disk on next access.
 *
 * @param promptId - Specific prompt to invalidate, or omit to clear all
 */
export function invalidatePromptCache(promptId?: PromptId): void {
  if (promptId) {
    templateCache.delete(promptId);
    metadataCache.delete(promptId);
    log.debug({ promptId }, 'Invalidated prompt cache');
  } else {
    templateCache.clear();
    metadataCache.clear();
    log.debug('Invalidated all prompt caches');
  }
}

/**
 * Get the configured prompts root path (for health checks).
 * Returns null if not configured.
 */
export function getPromptsRootPath(): string | null {
  return promptsRootPath;
}

/**
 * Get list of all registered prompt IDs (for health checks).
 */
export function getRegisteredPromptIds(): string[] {
  return Array.from(PROMPT_REGISTRY.keys());
}

/**
 * Critical-prompt warm status for readiness/health checks.
 *
 * Returns the outcome of the most recent `warmAllPrompts()` run, scoped to
 * critical prompts:
 * - `ok: true` when warm has run and every critical prompt loaded.
 * - `ok: false` + `failedCriticalIds` when warm ran but one or more critical
 *   prompts could not be loaded.
 * - `hasRun: false` when warm has not run yet (the health check treats this as
 *   "skip", not a failure).
 *
 * Consumed by the cloud `/api/health?detailed=true` readiness check
 * (`checkCriticalPrompts()` in cloud-service/src/health/checks.ts). It is
 * non-gating: the detailed endpoint always returns HTTP 200, and the basic
 * (Fly/Docker/CI/provisioning) endpoint never reads this.
 */
export function getCriticalPromptWarmStatus(): {
  hasRun: boolean;
  ok: boolean;
  failedCriticalIds: string[];
} {
  if (lastCriticalPromptWarm === null) {
    return { hasRun: false, ok: false, failedCriticalIds: [] };
  }
  return {
    hasRun: true,
    ok: lastCriticalPromptWarm.failedCriticalIds.length === 0,
    // Clone so a consumer can't mutate the stored health state by accident.
    failedCriticalIds: [...lastCriticalPromptWarm.failedCriticalIds],
  };
}

// =============================================================================
// Test Helpers (not for production use)
// =============================================================================

/**
 * Reset module state — only for use in tests.
 * @internal
 */
export function _resetForTesting(): void {
  promptsRootPath = null;
  templateCache.clear();
  metadataCache.clear();
  lastCriticalPromptWarm = null;
}
