import fm from 'front-matter';
import { z } from 'zod';
import type { OperatorFrontmatter, OperatorParseFailureCode } from '@shared/types/operators';

/**
 * Hard upper bounds — generous enough to never block legitimate copy, but
 * still defensive against pathological inputs that could bloat the
 * `<operators_available>` system-prompt block (capped K=10 in mcpService).
 */
const HARD_MAX_DESCRIPTION = 1000;
const HARD_MAX_CONSULT_WHEN = 1000;
const HARD_MAX_PROMPT = 10000;
const HARD_MAX_DISPLAY_NAME = 120;

/**
 * Soft thresholds — exceed these and the parser still accepts the Operator
 * but emits a non-blocking warning surfaced in the panel. Tuned so the
 * Stage 6 starters fit cleanly while flagging genuinely unwieldy copy.
 */
export const RECOMMENDED_DESCRIPTION_MAX = 200;
export const RECOMMENDED_CONSULT_WHEN_MAX = 300;
export const RECOMMENDED_CONSULTATION_PROMPT_MAX = 2000;
export const RECOMMENDED_LIVE_PROMPT_MAX = 2000;

// `kind` is intentionally a literal today, but the schema is shaped as a
// string-literal-union seam: future perspective-like data types can add their
// own discriminator values additively without colliding with Library Lens UI.
//
// Tolerant-by-design (Phase B refinement R1): missing `consult_when`,
// `live_prompt`, and `consultation_prompt` are NOT hard-rejected — they
// surface through `getOperatorFrontmatterWarnings(parsed, body)` so authors
// (and the agent during Personalise) can iterate on a flat file without the
// scanner silently dropping the persona to `failures[]`.
export const OperatorFrontmatterSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).max(HARD_MAX_DESCRIPTION),
  consult_when: z.string().trim().min(1).max(HARD_MAX_CONSULT_WHEN).optional(),
  kind: z.literal('operator'),
  roles: z.array(z.enum(['operator', 'live_meeting'])).nonempty().default(['operator']),
  proactive_interval_minutes: z.number().int().positive().max(60).optional(),
  use_cases: z.array(z.string()).optional(),
  live_prompt: z.string().trim().min(1).max(HARD_MAX_PROMPT).optional(),
  consultation_prompt: z.string().trim().min(1).max(HARD_MAX_PROMPT).optional(),
  display_name: z.string().trim().min(1).max(HARD_MAX_DISPLAY_NAME).optional(),
  // Reserved for future use; extension semantics are deliberately undefined in Stage 1.
  extends: z.string().trim().min(1).optional(),
});

const OperatorDocumentSchema = z.object({
  frontmatter: OperatorFrontmatterSchema,
  body: z.string(),
});

export type OperatorFrontmatterWarningField =
  | 'description'
  | 'consult_when'
  | 'consultation_prompt'
  | 'live_prompt';

export type OperatorFrontmatterWarningKind = 'length' | 'missing-required';

export interface OperatorFrontmatterWarning {
  field: OperatorFrontmatterWarningField;
  kind: OperatorFrontmatterWarningKind;
  length?: number;
  recommendedMax?: number;
  message: string;
}

export function getOperatorFrontmatterWarnings(
  frontmatter: OperatorFrontmatter,
  body: string = '',
): OperatorFrontmatterWarning[] {
  const warnings: OperatorFrontmatterWarning[] = [];
  if (frontmatter.description.length > RECOMMENDED_DESCRIPTION_MAX) {
    warnings.push({
      field: 'description',
      kind: 'length',
      length: frontmatter.description.length,
      recommendedMax: RECOMMENDED_DESCRIPTION_MAX,
      message: `description is ${frontmatter.description.length} chars (recommended ≤${RECOMMENDED_DESCRIPTION_MAX}). Tighter copy reads better in the panel and consumes less system-prompt budget.`,
    });
  }
  if (frontmatter.consult_when.length > RECOMMENDED_CONSULT_WHEN_MAX) {
    warnings.push({
      field: 'consult_when',
      kind: 'length',
      length: frontmatter.consult_when.length,
      recommendedMax: RECOMMENDED_CONSULT_WHEN_MAX,
      message: `consult_when is ${frontmatter.consult_when.length} chars (recommended ≤${RECOMMENDED_CONSULT_WHEN_MAX}). Trim the trigger list — the agent only reads the first phrase or two anyway.`,
    });
  }
  if (
    frontmatter.consultation_prompt &&
    frontmatter.consultation_prompt.length > RECOMMENDED_CONSULTATION_PROMPT_MAX
  ) {
    warnings.push({
      field: 'consultation_prompt',
      kind: 'length',
      length: frontmatter.consultation_prompt.length,
      recommendedMax: RECOMMENDED_CONSULTATION_PROMPT_MAX,
      message: `consultation_prompt is ${frontmatter.consultation_prompt.length} chars (recommended ≤${RECOMMENDED_CONSULTATION_PROMPT_MAX}). Keep consult prompts focused so the model can synthesize quickly.`,
    });
  }
  if (
    frontmatter.live_prompt &&
    frontmatter.live_prompt.length > RECOMMENDED_LIVE_PROMPT_MAX
  ) {
    warnings.push({
      field: 'live_prompt',
      kind: 'length',
      length: frontmatter.live_prompt.length,
      recommendedMax: RECOMMENDED_LIVE_PROMPT_MAX,
      message: `live_prompt is ${frontmatter.live_prompt.length} chars (recommended ≤${RECOMMENDED_LIVE_PROMPT_MAX}). Shorter coaching prompts reduce latency and repetition risk.`,
    });
  }
  if (frontmatter.roles.includes('operator') && !frontmatter.consult_when.trim()) {
    warnings.push({
      field: 'consult_when',
      kind: 'missing-required',
      message: "consult_when is missing for an operator-role persona. Add a short trigger phrase so the agent knows when to consult this Operator.",
    });
  }
  if (frontmatter.roles.includes('live_meeting') && !frontmatter.live_prompt?.trim()) {
    warnings.push({
      field: 'live_prompt',
      kind: 'missing-required',
      message: "live_prompt is missing for a live_meeting-role persona. Add coaching instructions or remove the live_meeting role.",
    });
  }
  if (
    frontmatter.roles.includes('operator')
    && body.trim().length === 0
    && !frontmatter.consultation_prompt?.trim()
  ) {
    warnings.push({
      field: 'consultation_prompt',
      kind: 'missing-required',
      message: "consultation_prompt is missing and the markdown body is empty. Consults will use a thin generic prompt until either is populated.",
    });
  }
  return warnings;
}

export type OperatorFrontmatterParseSuccess = {
  success: true;
  frontmatter: OperatorFrontmatter;
  body: string;
};

export type OperatorFrontmatterParseFailure = {
  success: false;
  errorCode: OperatorParseFailureCode;
  message: string;
};

export type OperatorFrontmatterParseResult =
  | OperatorFrontmatterParseSuccess
  | OperatorFrontmatterParseFailure;

function classifyZodFailure(error: z.ZodError): OperatorFrontmatterParseFailure {
  const firstIssue = error.issues[0];
  const issuePath = firstIssue?.path ?? [];
  const pathTail = issuePath.length > 0
    ? String(issuePath[issuePath.length - 1])
    : undefined;
  if (pathTail === 'kind') {
    return {
      success: false,
      errorCode: 'wrong-kind',
      message: firstIssue.message,
    };
  }
  if (pathTail === 'name') {
    return {
      success: false,
      errorCode: 'missing-name',
      message: firstIssue.message,
    };
  }
  return {
    success: false,
    errorCode: 'invalid-frontmatter',
    message: firstIssue?.message ?? 'Invalid Operator frontmatter',
  };
}

export function parseOperatorFrontmatterFromContent(content: string): OperatorFrontmatterParseResult {
  if (content.trim().length === 0) {
    return {
      success: false,
      errorCode: 'unsynced-stub',
      message: 'OPERATOR.md is empty; it may be a cloud-sync stub.',
    };
  }

  try {
    const parsed = fm<Record<string, unknown>>(content);
    const attributes = parsed.attributes;

    if (!attributes || Object.keys(attributes).length === 0) {
      return {
        success: false,
        errorCode: 'unsynced-stub',
        message: 'OPERATOR.md has empty frontmatter; it may be a cloud-sync stub.',
      };
    }

    const body = parsed.body.trim();
    const result = OperatorDocumentSchema.safeParse({
      frontmatter: attributes,
      body,
    });
    if (!result.success) {
      return classifyZodFailure(result.error);
    }

    const frontmatter: OperatorFrontmatter = {
      name: result.data.frontmatter.name,
      description: result.data.frontmatter.description,
      consult_when: result.data.frontmatter.consult_when ?? '',
      kind: result.data.frontmatter.kind,
      roles: result.data.frontmatter.roles,
      ...(result.data.frontmatter.proactive_interval_minutes !== undefined
        ? { proactive_interval_minutes: result.data.frontmatter.proactive_interval_minutes }
        : {}),
      ...(result.data.frontmatter.use_cases ? { use_cases: result.data.frontmatter.use_cases } : {}),
      ...(result.data.frontmatter.live_prompt ? { live_prompt: result.data.frontmatter.live_prompt } : {}),
      ...(result.data.frontmatter.consultation_prompt
        ? { consultation_prompt: result.data.frontmatter.consultation_prompt }
        : {}),
      ...(result.data.frontmatter.display_name ? { display_name: result.data.frontmatter.display_name } : {}),
      ...(result.data.frontmatter.extends ? { extends: result.data.frontmatter.extends } : {}),
    };

    return {
      success: true,
      frontmatter,
      body,
    };
  } catch (error) {
    return {
      success: false,
      errorCode: 'malformed-frontmatter',
      message: error instanceof Error ? error.message : 'Malformed Operator frontmatter',
    };
  }
}
