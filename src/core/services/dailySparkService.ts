/**
 * Daily Spark Service
 *
 * Generates a weekly 7-spark Daily Spark batch via a single LLM call.
 * Re-uses the hero-choice context assembler for user context, then issues a
 * Daily-Spark-specific prompt with strict JSON schema enforcement and a
 * deterministic post-validator (format constraints + gentle-tone substitutions).
 *
 * NO-LOG RULE: This file must never log spark `body` or `captionOverride`
 * content. Format names, ids, counts, timing, and errors are fine —
 * spark text is not.
 *
 * @see docs/plans/260512_daily_spark.md
 */

import { randomUUID } from 'node:crypto';
import type { AppSettings } from '@shared/types';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';
import { createScopedLogger } from '@core/logger';
import { callWithModelAuthAware, CodexDisconnectedBtsError } from './behindTheScenesClient';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { assembleHeroChoiceContext, type HeroChoiceContextDeps } from './heroChoiceContextAssembler';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import {
  DAILY_SPARK_FORMATS,
  FORMAT_HARD_CAPS,
  GENTLE_TONE_BANNED_FORMATS,
  GENTLE_TONE_SUBSTITUTIONS,
  MAX_SPARKS_PER_FORMAT,
  SPARKS_PER_WEEK,
  type DailySpark,
  type DailySparkFormat,
  type DailySparkLayout,
  type DailySparkToneGauge,
  type DailySparkWeeklyBatch,
  type FormatFeedbackCounts,
} from '@core/dailySparkTypes';

const log = createScopedLogger({ service: 'dailySparkService' });

const DAILY_SPARK_TIMEOUT_MS = 60_000;
const DAILY_SPARK_CONTEXT_BUDGET = 120_000;

/** Version tag recorded on every generated batch — bump when the prompt or shape changes. */
export const DAILY_SPARK_PROMPT_VERSION = 'v1.2';

const VALID_FORMATS = new Set<string>(DAILY_SPARK_FORMATS);
const VALID_LAYOUTS = new Set<string>(['poem', 'single', 'structured']);
const VALID_TONES = new Set<string>(['normal', 'gentle', 'silent']);

const DAILY_SPARK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    toneGauge: { type: 'string', enum: ['normal', 'gentle', 'silent'] },
    weekStartIso: { type: 'string' },
    sparks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dayIso: { type: 'string' },
          format: { type: 'string', enum: [...DAILY_SPARK_FORMATS] },
          layout: { type: 'string', enum: ['poem', 'single', 'structured'] },
          body: { type: 'string' },
          captionOverride: { type: 'string' },
        },
        required: ['dayIso', 'format', 'layout', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['toneGauge', 'sparks'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Raw LLM response shape
// ---------------------------------------------------------------------------

interface RawSpark {
  dayIso?: string;
  format?: string;
  layout?: string;
  body?: string;
  captionOverride?: string;
}

interface RawDailySparkResponse {
  toneGauge?: string;
  weekStartIso?: string;
  sparks?: RawSpark[];
}

// ---------------------------------------------------------------------------
// Inputs to the service
// ---------------------------------------------------------------------------

export interface DailySparkServiceDeps extends HeroChoiceContextDeps {
  getFormatFeedback: () => FormatFeedbackCounts;
}

export interface DailySparkServiceInputs {
  weekStartIso: string;
  isFirstAppearance: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Violation =
  | 'wrong_count'
  | 'consecutive_format'
  | 'format_cap_exceeded'
  | 'gentle_banned_format'
  | 'invalid_format'
  | 'invalid_layout'
  | 'empty_body';

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
  sparks: DailySpark[];
}

interface CoercedSpark {
  dayIso: string;
  format: DailySparkFormat;
  layout: DailySparkLayout;
  body: string;
  captionOverride?: string;
}

function coerceSpark(raw: RawSpark): CoercedSpark | null {
  if (
    typeof raw.dayIso !== 'string' ||
    typeof raw.format !== 'string' ||
    typeof raw.layout !== 'string' ||
    typeof raw.body !== 'string'
  ) {
    return null;
  }
  if (!VALID_FORMATS.has(raw.format)) return null;
  if (!VALID_LAYOUTS.has(raw.layout)) return null;
  if (raw.body.trim().length === 0) return null;
  const captionOverride =
    typeof raw.captionOverride === 'string' && raw.captionOverride.trim().length > 0
      ? raw.captionOverride.trim()
      : undefined;
  return {
    dayIso: raw.dayIso,
    format: raw.format as DailySparkFormat,
    layout: raw.layout as DailySparkLayout,
    body: raw.body,
    captionOverride,
  };
}

/**
 * Apply gentle-tone substitutions to a sequence of sparks. Returns a new
 * array — never mutates the input.
 */
export function applyGentleToneSubstitutions(sparks: CoercedSpark[]): CoercedSpark[] {
  return sparks.map((s) => {
    if (!GENTLE_TONE_BANNED_FORMATS.has(s.format)) return s;
    const replacement = GENTLE_TONE_SUBSTITUTIONS[s.format];
    return { ...s, format: replacement };
  });
}

/**
 * Run all deterministic constraints over the spark list.
 *
 * Exported so tests and the eval harness can exercise the validator directly.
 */
export function validateDailySparkBatch(
  raw: RawSpark[] | undefined,
  toneGauge: DailySparkToneGauge,
  weekStartIso: string,
): ValidationResult {
  const violations: Violation[] = [];
  const items: CoercedSpark[] = [];

  if (toneGauge === 'silent') {
    if (Array.isArray(raw) && raw.length > 0) {
      violations.push('wrong_count');
    }
    return { ok: violations.length === 0, violations, sparks: [] };
  }

  if (!Array.isArray(raw) || raw.length !== SPARKS_PER_WEEK) {
    violations.push('wrong_count');
  }

  for (const r of raw ?? []) {
    const coerced = coerceSpark(r);
    if (!coerced) {
      if (r.format !== undefined && !VALID_FORMATS.has(r.format)) {
        violations.push('invalid_format');
      } else if (r.layout !== undefined && !VALID_LAYOUTS.has(r.layout)) {
        violations.push('invalid_layout');
      } else if (typeof r.body !== 'string' || r.body.trim().length === 0) {
        violations.push('empty_body');
      } else {
        violations.push('invalid_format');
      }
      continue;
    }
    items.push(coerced);
  }

  // Gentle-tone substitution happens before consecutive/cap checks so the
  // final batch we emit doesn't contain banned formats.
  let normalised = items;
  if (toneGauge === 'gentle') {
    normalised = applyGentleToneSubstitutions(items);
    // If the LLM emitted banned formats, count as a violation so we retry
    // (the substitution still happens, but the prompt should be reminded).
    if (items.some((s) => GENTLE_TONE_BANNED_FORMATS.has(s.format))) {
      violations.push('gentle_banned_format');
    }
  }

  for (let i = 1; i < normalised.length; i++) {
    if (normalised[i].format === normalised[i - 1].format) {
      violations.push('consecutive_format');
      break;
    }
  }

  const formatCounts = new Map<DailySparkFormat, number>();
  for (const s of normalised) {
    formatCounts.set(s.format, (formatCounts.get(s.format) ?? 0) + 1);
  }
  for (const [format, count] of formatCounts) {
    const hardCap = FORMAT_HARD_CAPS[format] ?? MAX_SPARKS_PER_FORMAT;
    if (count > hardCap) {
      violations.push('format_cap_exceeded');
      break;
    }
  }

  const sparks: DailySpark[] = normalised.map((s) => ({
    id: randomUUID(),
    weekStartIso,
    dayIso: s.dayIso,
    format: s.format,
    layout: s.layout,
    body: s.body,
    ...(s.captionOverride ? { captionOverride: s.captionOverride } : {}),
  }));

  return { ok: violations.length === 0, violations, sparks };
}

// ---------------------------------------------------------------------------
// User-message construction
// ---------------------------------------------------------------------------

function formatFeedbackBlock(counts: FormatFeedbackCounts): string {
  const entries = Object.entries(counts)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort(([, a], [, b]) => (b as number) - (a as number));
  if (entries.length === 0) return '';
  const lines = entries.map(([format, count]) => `- ${format} (${count} time${count === 1 ? '' : 's'})`);
  return [
    'The user has expressed "less like this" feedback on the following formats:',
    ...lines,
    'Avoid these formats this week unless you have a strong reason.',
  ].join('\n');
}

function buildUserMessage(
  context: string,
  inputs: DailySparkServiceInputs,
  formatFeedback: FormatFeedbackCounts,
  tz: string,
  retryReason?: string,
): string {
  const feedbackBlock = formatFeedbackBlock(formatFeedback);
  const lines = [
    'Here is the context for this user.',
    '',
    context.trim(),
    '',
    '## Daily Spark Generation Inputs',
    `- weekStartIso: ${inputs.weekStartIso}`,
    `- timeZone: ${tz}`,
    `- isFirstAppearance: ${inputs.isFirstAppearance ? 'true' : 'false'}`,
  ];
  if (feedbackBlock) {
    lines.push('', '## User Format Feedback', feedbackBlock);
  }
  if (retryReason) {
    lines.push(
      '',
      `## Retry Notice`,
      `Previous output violated constraint: ${retryReason}. Produce a corrected batch that respects all format and constraint rules.`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** @internal Exported for testing. */
export function resolveDailySparkModel(settings: AppSettings): string {
  return resolveBtsModel(settings, 'hero-choice');
}

// ---------------------------------------------------------------------------
// Main service function
// ---------------------------------------------------------------------------

/**
 * Generate a Daily Spark weekly batch.
 *
 * Returns null on:
 * - empty context
 * - LLM/BTS failures (after retry-once-on-violation)
 * - validation failures after retry
 *
 * Throws `CodexDisconnectedBtsError` so the caller can surface the auth issue.
 */
export async function generateDailySparkBatch(
  deps: DailySparkServiceDeps,
  settings: AppSettings,
  inputs: DailySparkServiceInputs,
): Promise<DailySparkWeeklyBatch | null> {
  try {
    const model = resolveDailySparkModel(settings).replace(/\[1m\]$/i, '');
    const context = await assembleHeroChoiceContext(deps, DAILY_SPARK_CONTEXT_BUDGET);

    if (!context || context.trim().length === 0) {
      log.info('No context available for daily spark generation — skipping');
      return null;
    }

    const formatFeedback = deps.getFormatFeedback();
    const tz = deps.timeZone;

    log.info(
      {
        model,
        weekStartIso: inputs.weekStartIso,
        isFirstAppearance: inputs.isFirstAppearance,
        formatFeedback,
      },
      'Starting daily spark generation',
    );

    const callOnce = async (retryReason?: string) => {
      const userMessage = buildUserMessage(context, inputs, formatFeedback, tz, retryReason);
      const response = await callWithModelAuthAware(
        settings,
        model,
        {
          codexConnectivity: resolveCodexConnectivity(),
          system: getPrompt(PROMPT_IDS.INTELLIGENCE_DAILY_SPARK),
          messages: [{ role: 'user', content: userMessage }],
          maxTokens: 2048,
          outputFormat: { type: 'json_schema', schema: DAILY_SPARK_JSON_SCHEMA },
          timeout: DAILY_SPARK_TIMEOUT_MS,
        },
        { category: 'hero-choice' },
      );

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock?.text) {
        log.warn('Empty response from daily spark generation');
        return { parsed: null as RawDailySparkResponse | null, modelUsed: response.model ?? model };
      }

      const parsed = safeJsonParseFromModelText<RawDailySparkResponse>(
        textBlock.text,
        'dailySpark.generate',
        log,
      );
      return { parsed, modelUsed: response.model ?? model };
    };

    let first = await callOnce();
    if (!first.parsed) return null;

    let toneGauge = (first.parsed.toneGauge ?? 'normal') as DailySparkToneGauge;
    if (!VALID_TONES.has(toneGauge)) {
      log.warn({ toneGauge }, 'Invalid toneGauge from model — defaulting to normal');
      toneGauge = 'normal';
    }

    let validation = validateDailySparkBatch(
      first.parsed.sparks,
      toneGauge,
      inputs.weekStartIso,
    );
    let modelUsed = first.modelUsed;

    if (!validation.ok) {
      log.warn(
        { violations: validation.violations, toneGauge },
        'Daily spark validation failed — retrying once',
      );
      const second = await callOnce(validation.violations[0]);
      if (!second.parsed) return null;

      const retryTone = (second.parsed.toneGauge ?? 'normal') as DailySparkToneGauge;
      const retryToneNormalised = VALID_TONES.has(retryTone) ? retryTone : 'normal';
      const retryValidation = validateDailySparkBatch(
        second.parsed.sparks,
        retryToneNormalised,
        inputs.weekStartIso,
      );

      if (!retryValidation.ok) {
        log.warn(
          { violations: retryValidation.violations, toneGauge: retryToneNormalised },
          'Daily spark validation failed after retry — returning null',
        );
        return null;
      }

      first = second;
      toneGauge = retryToneNormalised;
      validation = retryValidation;
      modelUsed = second.modelUsed;
    }

    const batch: DailySparkWeeklyBatch = {
      weekStartIso: inputs.weekStartIso,
      generatedAt: Date.now(),
      toneGauge,
      sparks: validation.sparks,
      sourceModel: modelUsed,
      promptVersion: DAILY_SPARK_PROMPT_VERSION,
      isFirstAppearanceWeek: inputs.isFirstAppearance,
    };

    log.info(
      {
        weekStartIso: batch.weekStartIso,
        toneGauge: batch.toneGauge,
        sparkCount: batch.sparks.length,
        sourceModel: batch.sourceModel,
        promptVersion: batch.promptVersion,
        formats: batch.sparks.map((s) => s.format),
      },
      'Daily spark batch generated',
    );

    return batch;
  } catch (error) {
    if (error instanceof CodexDisconnectedBtsError) {
      log.error(
        { reason: 'codex-profile-bts-blocked', caller: 'dailySpark' },
        'Daily spark BTS blocked',
      );
      throw error;
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error({ error: errMsg }, 'Daily spark generation failed');
    return null;
  }
}
