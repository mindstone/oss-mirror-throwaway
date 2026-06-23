/**
 * Safety Prompt Migration
 *
 * Reads existing safety data (userSafetyInstructions, toolSafetyLevel,
 * per-automation accessRules) and synthesizes an initial Safety Prompt
 * using a two-phase sequential distillation pipeline:
 *
 *   Phase 1: Per-automation distillation (parallel) — extracts universal
 *            vs scoped safety principles from each automation's access rules.
 *   Phase 2: Synthesis — merges all Phase 1 outputs + global settings into
 *            the final unified Safety Prompt.
 *
 * Uses LLM for synthesis with verbatim fallback on failure.
 * Idempotent — no-ops if migrationComplete is already true.
 */

import { createScopedLogger } from '@core/logger';
import { getSafetyEvaluationService } from '@core/safetyEvaluationService';
import { getRawPrompt, getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import {
  getSafetyPrompt,
  isMigrationComplete,
  setMigrationComplete,
  updateSafetyPrompt,
} from '@core/safetyPromptStore';

const log = createScopedLogger({ service: 'safetyPromptMigration' });

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum characters per automation's access rules before skipping LLM for that automation */
const SCALE_GUARD_MAX_CHARS = 32_000;

/** Timeout for Phase 1 per-automation LLM call (ms) */
const PHASE1_TIMEOUT_MS = 15_000;

/** Max tokens for Phase 1 LLM output */
const PHASE1_MAX_TOKENS = 1024;

/** Timeout for Phase 2 synthesis LLM call (ms) */
const MIGRATION_TIMEOUT_MS = 30_000;

/** Max tokens for Phase 2 migration LLM output */
const MIGRATION_MAX_TOKENS = 2048;

/** JSON schema for Phase 1 structured output — { universal: string[], scoped: string[] } */
const PHASE1_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    universal: { type: 'array', items: { type: 'string' } },
    scoped: { type: 'array', items: { type: 'string' } },
  },
  required: ['universal', 'scoped'],
  additionalProperties: false,
};

/** JSON schema for Phase 2 structured output — LLM returns { markdown: string } */
const MIGRATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    markdown: { type: 'string' },
  },
  required: ['markdown'],
  additionalProperties: false,
};

/** Meta-principles mapped from toolSafetyLevel */
const SAFETY_LEVEL_META_PRINCIPLES: Record<string, string> = {
  cautious:
    'I prefer to be asked before any action that sends data externally or modifies shared resources. When in doubt, ask rather than proceed.',
  permissive:
    "I'm experienced and prefer minimal interruption. Only ask for clearly dangerous or irreversible actions.",
  // balanced: no extra meta-principle — sensible defaults cover this
};

/**
 * Suspicious patterns that should not appear in a legitimate migration output.
 * If the LLM output matches any of these, we fall back to verbatim.
 * Mirrors the patterns from safetyPromptLogic.ts isSuspiciousUpdate().
 */
const SUSPICIOUS_PATTERNS: ReadonlyArray<RegExp> = [
  /allow\s+all/i,
  /ignore\s+(all\s+)?restrictions/i,
  /disable\s+safety/i,
  /bypass\s+(all\s+)?rules/i,
  /no\s+restrictions/i,
  /unrestricted\s+access/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MigrationInput {
  userSafetyInstructions?: string;
  toolSafetyLevel?: string;
  automationAccessRules: Array<{
    automationName: string;
    automationDescription?: string;
    accessRules: string;
    accessRulesStatus?: string;
  }>;
}

interface Phase1Result {
  automationName: string;
  universal: string[];
  scoped: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Per-Automation Distillation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Phase 1 system prompt for a single automation.
 * Uses getRawPrompt + String.replace because automation names are user-provided content.
 */
const PHASE1_SYSTEM_PROMPT_TEMPLATE = (name: string, description: string): string =>
  getRawPrompt(PROMPT_IDS.SAFETY_MIGRATION_PHASE1)
    .replace('{NAME}', name)
    .replace('{DESCRIPTION}', description);

/**
 * Build the Phase 1 user message for a single automation's distillation.
 * Returns the raw access rules text — automation context is in the system prompt.
 * Exported for testing.
 */
export function buildPhase1Prompt(accessRules: string): string {
  return accessRules;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Synthesis
// ─────────────────────────────────────────────────────────────────────────────

const PHASE2_SYSTEM_PROMPT = `You are creating a unified Safety Principles document for a user.
This document governs ALL actions the AI assistant takes on the user's behalf:
tool calls, memory writes, file operations, and communications — in both
automated workflows AND interactive conversations. It is NOT specific to
automations.

You are given:
- Universal principles (apply everywhere)
- Scoped principles grouped by automation purpose (apply only in that context)
- The user's global safety preferences

Produce a clean Markdown document with:
1. A "Universal Principles" section. The intro line MUST say these principles
   apply to "all actions — tool calls, memory writes, and communications — in
   both automated workflows and interactive conversations."
   Always include: "When uncertain whether an action is appropriate, ask for
   confirmation before proceeding." and "Never share passwords, API keys, or
   other credentials."
2. Optionally, domain-specific sections for scoped principles that don't
   generalize well. Use domain categories (e.g., "Communication & Messaging")
   rather than automation names as section headers.

Rules:
- Do NOT use the phrase "access rules" anywhere.
- Do NOT include specific channel names, directory paths, CLI commands, or
  service names — use general categories instead.
- Keep principles actionable: an LLM evaluating a tool call should be able to
  decide allow/block based on each principle.
- Deduplicate: if multiple automations share the same universal principle, include
  it once.

CRITICAL — Scope preservation:
- Do NOT lift scoped principles into universal bans. A restriction that applies
  to one automation's external messaging must NOT become a universal "never send
  messages" ban.
- Do NOT create universal "read-only" or "never modify" rules. Many legitimate
  actions involve writing (saving files, updating memory, sending messages,
  creating calendar reminders). The correct principle is "confirm before
  modifying or sending" for a cautious user, not "never modify."
- If a principle would contradict an explicitly allowed action in a domain
  section, it is too broad. Narrow it or move it to the relevant domain section.
- You may downgrade a purported universal principle to scoped if it is clearly
  automation-specific. For example, "only use independent third-party sources"
  is a content-curation preference, not a universal safety principle.
- When one section says "do not X without authorization" and another section
  explicitly permits X in a specific context, add "unless explicitly permitted
  by domain-specific principles below" to the restrictive rule, or remove the
  contradiction.

CRITICAL — Interactive usability:
- The user will ask the assistant to do things in conversation: send messages,
  write files, update memory, search email. Universal principles must NOT block
  actions the user explicitly requests. Use "confirm before" rather than "never"
  for actions the user might legitimately ask for.
- "Protect sensitive content" means do not share it with THIRD PARTIES or log
  it externally — not that the assistant cannot show information to the user.
- Avoid the phrase "automation's purpose" in domain sections — use neutral
  phrasing like "the task's purpose" or "the declared scope" so principles
  read naturally in both automated and interactive contexts.

CRITICAL — Memory writes:
- This document governs memory writes (saving information to the user's knowledge
  base). Principles about memory should distinguish between personal memory
  (generally allowed) and shared/team memory (requires more caution).
- Updating existing memory entries is a normal operation (e.g., adding citations,
  enriching metadata). Do NOT prohibit memory updates universally.

Return JSON: { "markdown": "..." }`;

/**
 * Build the Phase 2 user message from global preferences and Phase 1 results.
 * Exported for testing.
 */
export function buildPhase2UserMessage(
  input: MigrationInput,
  phase1Results: Phase1Result[],
): string {
  const sections: string[] = [];

  // Global safety preferences
  sections.push('## Global Safety Preferences\n');
  if (input.toolSafetyLevel && SAFETY_LEVEL_META_PRINCIPLES[input.toolSafetyLevel]) {
    sections.push(`Safety level: ${SAFETY_LEVEL_META_PRINCIPLES[input.toolSafetyLevel]}`);
  }
  if (input.userSafetyInstructions?.trim()) {
    sections.push(`User instructions: ${input.userSafetyInstructions.trim()}`);
  }

  // Per-automation Phase 1 results
  for (const result of phase1Results) {
    sections.push(
      `### ${result.automationName}\nUniversal: ${JSON.stringify(result.universal)}\nScoped: ${JSON.stringify(result.scoped)}`,
    );
  }

  return sections.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Verbatim fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build verbatim fallback Safety Prompt (no LLM call).
 * Used when LLM fails, returns suspicious output, or content exceeds scale guard.
 */
export function buildVerbatimFallback(input: MigrationInput): string {
  const parts: string[] = [
    '# Safety Principles\n\n_Migrated from previous settings — review recommended._\n',
  ];

  if (input.toolSafetyLevel && SAFETY_LEVEL_META_PRINCIPLES[input.toolSafetyLevel]) {
    parts.push(`## General\n- ${SAFETY_LEVEL_META_PRINCIPLES[input.toolSafetyLevel]}`);
  }

  parts.push('- Never share passwords, API keys, or other credentials.');
  parts.push('- Confirm before sending messages to external parties or public channels.\n');

  if (input.userSafetyInstructions?.trim()) {
    parts.push(`## Custom Rules\n${input.userSafetyInstructions.trim()}\n`);
  }

  for (const rule of input.automationAccessRules) {
    parts.push(`## Principles from "${rule.automationName}"\n${rule.accessRules}\n`);
  }

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if LLM migration output contains suspicious patterns.
 * Mirrors isSuspiciousUpdate() from safetyPromptLogic.ts.
 */
function isSuspiciousMigrationOutput(text: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(text));
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the migration: read legacy data, synthesize Safety Prompt via two-phase
 * distillation pipeline, write to store.
 * Idempotent — no-ops if migrationComplete is already true.
 */
export async function runSafetyPromptMigration(input: MigrationInput): Promise<void> {
  if (isMigrationComplete()) {
    log.info('Migration already complete, skipping');
    return;
  }

  const hasLegacyData =
    !!input.userSafetyInstructions?.trim() ||
    !!input.toolSafetyLevel ||
    input.automationAccessRules.length > 0;

  if (!hasLegacyData) {
    log.info('No legacy safety data found, setting defaults and completing migration');
    setMigrationComplete(true);
    return;
  }

  // ── Phase 1: Per-automation distillation ────────────────────────────────
  const automationsWithRules = input.automationAccessRules.filter(
    (a) => a.accessRules?.trim(),
  );

  const phase1Results: Phase1Result[] = [];

  if (automationsWithRules.length > 0) {
    const service = getSafetyEvaluationService();

    const phase1Promises = automationsWithRules.map(async (automation) => {
      // Per-automation scale guard
      if (automation.accessRules.length > SCALE_GUARD_MAX_CHARS) {
        log.warn(
          {
            automationName: automation.automationName,
            contentLength: automation.accessRules.length,
            maxChars: SCALE_GUARD_MAX_CHARS,
          },
          'Automation access rules exceed scale guard — skipping Phase 1 LLM for this automation',
        );
        return null;
      }

      const description = automation.automationDescription || '(no description available)';

      const response = await service.callLlm({
        system: PHASE1_SYSTEM_PROMPT_TEMPLATE(automation.automationName, description),
        userMessage: buildPhase1Prompt(automation.accessRules),
        maxTokens: PHASE1_MAX_TOKENS,
        outputSchema: PHASE1_OUTPUT_SCHEMA,
        timeout: PHASE1_TIMEOUT_MS,
      });

      const parsed = parsePhase1Response(response.text);
      if (!parsed) {
        throw new Error(
          `Failed to parse Phase 1 response for automation "${automation.automationName}"`,
        );
      }

      // Check each principle for suspicious patterns
      const allPrinciples = [...parsed.universal, ...parsed.scoped];
      if (allPrinciples.some((p) => isSuspiciousMigrationOutput(p))) {
        log.warn(
          { automationName: automation.automationName },
          'Phase 1 output contains suspicious patterns — excluding this automation',
        );
        return null;
      }

      return {
        automationName: automation.automationName,
        universal: parsed.universal,
        scoped: parsed.scoped,
      } satisfies Phase1Result;
    });

    const settled = await Promise.allSettled(phase1Promises);

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value !== null) {
        phase1Results.push(result.value);
      } else if (result.status === 'rejected') {
        log.warn({ err: result.reason }, 'Phase 1 distillation failed for an automation');
      }
    }
  }

  // If ALL Phase 1 calls failed (or none ran), and we have automation rules,
  // use verbatim fallback without Phase 2.
  if (automationsWithRules.length > 0 && phase1Results.length === 0) {
    log.warn('All Phase 1 distillations failed — using verbatim fallback');
    const fallback = buildVerbatimFallback(input);
    updateSafetyPrompt(fallback, 'migration');
    setMigrationComplete(true);
    return;
  }

  // ── Phase 2: Synthesis ──────────────────────────────────────────────────
  // Phase 2 runs if we have any successful Phase 1 results OR global preferences
  // (toolSafetyLevel / userSafetyInstructions) to synthesize.
  const hasGlobalPrefs =
    !!input.userSafetyInstructions?.trim() ||
    (!!input.toolSafetyLevel && !!SAFETY_LEVEL_META_PRINCIPLES[input.toolSafetyLevel]);

  if (phase1Results.length === 0 && !hasGlobalPrefs) {
    // Nothing to synthesize
    log.info('No Phase 1 results and no global preferences — setting defaults');
    setMigrationComplete(true);
    return;
  }

  try {
    const service = getSafetyEvaluationService();
    const userMessage = buildPhase2UserMessage(input, phase1Results);

    // Phase 2 scale guard: if combined input is too large, use verbatim fallback
    if (userMessage.length > SCALE_GUARD_MAX_CHARS) {
      log.warn(
        { contentLength: userMessage.length, maxChars: SCALE_GUARD_MAX_CHARS },
        'Phase 2 input exceeds scale guard — using verbatim fallback',
      );
      const fallback = buildVerbatimFallback(input);
      updateSafetyPrompt(fallback, 'migration');
      setMigrationComplete(true);
      return;
    }

    const response = await service.callLlm({
      system: getPrompt(PROMPT_IDS.SAFETY_MIGRATION_PHASE2),
      userMessage,
      maxTokens: MIGRATION_MAX_TOKENS,
      outputSchema: MIGRATION_OUTPUT_SCHEMA,
      timeout: MIGRATION_TIMEOUT_MS,
    });

    const parsed = parseJsonResponse(response.text);
    if (!parsed) {
      throw new Error('Failed to parse Phase 2 LLM response as JSON');
    }

    // Validate: reject suspicious output from the LLM
    if (isSuspiciousMigrationOutput(parsed)) {
      log.warn('Phase 2 output contains suspicious patterns — using verbatim fallback');
      const fallback = buildVerbatimFallback(input);
      updateSafetyPrompt(fallback, 'migration');
      setMigrationComplete(true);
      return;
    }

    updateSafetyPrompt(parsed, 'migration');
    log.info('Migration complete — two-phase distillation succeeded');
  } catch (err) {
    log.warn({ err }, 'Phase 2 synthesis failed — using verbatim fallback');
    const fallback = buildVerbatimFallback(input);
    updateSafetyPrompt(fallback, 'migration');
  }

  setMigrationComplete(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse Phase 1 LLM response text as JSON and extract universal/scoped arrays.
 * Returns the parsed result, or null if parsing fails.
 */
function parsePhase1Response(text: string): { universal: string[]; scoped: string[] } | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(json.universal) && Array.isArray(json.scoped)) {
      return {
        universal: json.universal.filter((s): s is string => typeof s === 'string'),
        scoped: json.scoped.filter((s): s is string => typeof s === 'string'),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse LLM response text as JSON and extract the markdown field.
 * Returns the markdown string, or null if parsing fails.
 */
function parseJsonResponse(text: string): string | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (typeof json.markdown === 'string' && json.markdown.trim()) {
      return json.markdown.trim();
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-migration patches
// ─────────────────────────────────────────────────────────────────────────────

const READ_ONLY_PRINCIPLE = '- Reading, querying, and fetching data from connected services is allowed — the user has authorized access by connecting the service.';

/**
 * One-time patch to add read-only data access principle to existing safety prompts.
 *
 * Detects existing prompts that have a "Data sharing" or "Data access" section
 * but lack a read-only access principle. Adds the principle to make the safety
 * prompt correctly allow read-only operations (queries, fetches, searches) from
 * connected services without triggering approval.
 *
 * Idempotent — no-ops if the principle is already present.
 * Only runs after the initial migration is complete.
 */
export function applyReadOnlyAccessPatch(): void {
  if (!isMigrationComplete()) {
    return;
  }

  const currentPrompt = getSafetyPrompt();

  // Already has the read-only principle — skip
  if (currentPrompt.includes('Reading, querying, and fetching data from connected services is allowed')) {
    return;
  }

  // Find a Data sharing or Data access section to insert the principle
  const dataSectionPattern = /^(##\s+Data\s+(?:sharing|access\s*&?\s*sharing))\s*$/m;
  const match = dataSectionPattern.exec(currentPrompt);

  if (match) {
    // Insert the read-only principle as the first bullet after the section heading
    const insertPos = match.index + match[0].length;
    const before = currentPrompt.slice(0, insertPos);
    const after = currentPrompt.slice(insertPos);
    const updated = before + '\n' + READ_ONLY_PRINCIPLE + after;

    // Also update the section heading to "Data access & sharing" if it's just "Data sharing"
    const finalPrompt = updated.replace(/^(##\s+)Data\s+sharing\s*$/m, '$1Data access & sharing');

    updateSafetyPrompt(finalPrompt, 'system');
    log.info('Applied read-only data access patch to existing safety prompt');
    return;
  }

  // No data section found — try to insert before the first section or at the end
  const firstSectionMatch = /^##\s+/m.exec(currentPrompt);
  if (firstSectionMatch) {
    const insertPos = firstSectionMatch.index;
    const before = currentPrompt.slice(0, insertPos);
    const after = currentPrompt.slice(insertPos);
    const updated = before + '## Data access\n' + READ_ONLY_PRINCIPLE + '\n\n' + after;
    updateSafetyPrompt(updated, 'system');
    log.info('Applied read-only data access patch (new section) to existing safety prompt');
    return;
  }

  // Append at end as fallback
  const updated = currentPrompt.trimEnd() + '\n\n## Data access\n' + READ_ONLY_PRINCIPLE + '\n';
  updateSafetyPrompt(updated, 'system');
  log.info('Applied read-only data access patch (appended) to existing safety prompt');
}

// ─────────────────────────────────────────────────────────────────────────────
// Destructive-changes wording patch (FOX-3237)
// ─────────────────────────────────────────────────────────────────────────────

const OLD_DESTRUCTIVE_LINE = 'Destructive changes (delete, overwrite) require explicit confirmation.';
const NEW_DESTRUCTIVE_LINE = 'Destructive changes (delete, overwrite) require explicit confirmation, except where the rules below expressly permit it.';

/**
 * One-time patch to add escape clause to the destructive-changes line in
 * existing safety prompts.
 *
 * The old wording ("require explicit confirmation") triggers the evaluator's
 * APPROVAL-REQUIRED language detection, which can return block even when a
 * user-added allow rule explicitly permits the action. Adding "except where
 * the rules below expressly permit it" gives the evaluator a clear textual
 * signal that specific allow rules downstream should take priority, aligning
 * with the EXPLICIT PERMISSION PRIORITY rule in the eval system prompt.
 *
 * Without the allow rule the destructive line still triggers APPROVAL-REQUIRED,
 * preserving the safety gate.
 *
 * Idempotent — no-ops if the old line is not present.
 * See FOX-3237.
 */
export function applyDestructiveWordingPatch(): void {
  const currentPrompt = getSafetyPrompt();

  if (!currentPrompt.includes(OLD_DESTRUCTIVE_LINE)) {
    return;
  }

  const updated = currentPrompt.replace(OLD_DESTRUCTIVE_LINE, NEW_DESTRUCTIVE_LINE);
  updateSafetyPrompt(updated, 'system');
  log.info('Applied destructive-changes wording patch to existing safety prompt (FOX-3237)');
}
