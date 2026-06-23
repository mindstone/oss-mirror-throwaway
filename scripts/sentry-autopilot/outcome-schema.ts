import path from 'node:path';

import { z } from 'zod';

import { validateGitCommitExists } from '../lib/validate-git-commit.js';
import type { AutopilotConfig } from './config.ts';

const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const BRANCH_RE = /^autopilot\/[A-Za-z0-9._-]+$/;

// `plan_file` must be either the legacy literal `'plan.md'` (transitional, for
// in-flight sessions) OR a CE2-native plan path of the form `docs/plans/<slug>/PLAN.md`.
// Bounded to defend against absolute paths, traversal segments, and unbounded length —
// this value is later joined into filesystem paths by the verifier and reporter.
const PLAN_FILE_RE = /^docs\/plans\/[A-Za-z0-9._-]+\/PLAN\.md$/;
const planFileSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !path.isAbsolute(p), { message: 'plan_file must be a relative path' })
  .refine((p) => !p.split('/').includes('..'), { message: 'plan_file must not contain `..` segments' })
  .refine((p) => p === 'plan.md' || PLAN_FILE_RE.test(p), {
    message: 'plan_file must be either "plan.md" (transitional) or "docs/plans/<slug>/PLAN.md"',
  });

// Shared base — NOT exported, only spread into each branch
const baseFields = {
  sentry_id: z.string().min(1).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  // CE2 bug-diagnosis-specialist root-cause confidence in the closed interval [0, 1].
  // Required when CE2 `bug_mode: true` is engaged (per
  // coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2_AUTONOMOUS.md §
  // `diagnosis_confidence`); optional on every other path so the schema stays
  // permissive across CHIEF_BUGFIXER and pre-bug-mode CE2 runs. Distinct from the
  // typed integer `confidence` field (0-100) which scores the overall outcome.
  diagnosis_confidence: z.number().min(0).max(1).optional(),
  is_bug: z.boolean().optional(),
  root_cause: z.string().max(4000).optional(),
  plan_summary: z.string().max(4000).optional(),
  diagnosis: z.string().max(8000).optional(),
  files_changed: z.array(z.string()).max(50).optional(),
  shadow_would_commit: z.boolean().optional(),
};

export const AutoCommittedOutcome = z.object({
  outcome: z.literal('auto_committed'),
  ...baseFields,
  commit_hash: z.string().regex(COMMIT_SHA_RE),
  plan_file: planFileSchema.optional(),
  pr_url: z.string().url().optional(),
  branch_name: z.string().regex(BRANCH_RE).optional(),
}).catchall(z.unknown());

export const PlanCreatedOutcome = z.object({
  outcome: z.literal('plan_created'),
  ...baseFields,
  plan_file: planFileSchema,
  reason: z.string().max(2000).optional(),
}).catchall(z.unknown());

export const EscalatedOutcome = z.object({
  outcome: z.literal('escalated'),
  ...baseFields,
  reason: z.string().max(2000),
}).catchall(z.unknown());

export const NotABugOutcome = z.object({
  outcome: z.literal('not_a_bug'),
  ...baseFields,
  reason: z.string().max(2000).optional(),
}).catchall(z.unknown());

export const FailureKind = z.enum([
  'parse_failure',
  'supervisor_failure',
  'bugfixer_failure',
  'reporter_failure',
  'verification_failure',
]);
export type FailureKind = z.infer<typeof FailureKind>;

export const FailedOutcome = z.object({
  outcome: z.literal('failed'),
  ...baseFields,
  failure_kind: FailureKind.optional(),
  original_outcome: z.string().optional().nullable(),
  error: z.string().max(8000),
  exit_code: z.number().int().optional(),
  reason: z.string().max(2000).optional(),
}).catchall(z.unknown());

// This schema is also the output contract for autonomous CHIEF_ENGINEER2 runs — see
// coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2_AUTONOMOUS.md (§3).
// Keep this file the single source of truth for the outcome shape.
export const OutcomeSchema = z.discriminatedUnion('outcome', [
  AutoCommittedOutcome,
  PlanCreatedOutcome,
  EscalatedOutcome,
  NotABugOutcome,
  FailedOutcome,
]);

export type Outcome = z.infer<typeof OutcomeSchema>;

/**
 * Parse and validate an outcome payload against the discriminated-union schema.
 *
 * Outcome shape policy
 * --------------------
 * Each branch is `.catchall(z.unknown())`: the schema enforces typed
 * invariants on known fields (discriminator, commit hash format, branch
 * name, plan_file literal, length caps, failure_kind enum) but accepts and
 * preserves additional provenance/context keys emitted by the bug-fixer
 * agent (`originating_commit`, `debuggers_consulted`, `review_mode`, etc.).
 *
 * Rationale: the bug-fixer's emitted provenance set is large and prompt-driven,
 * and is not a stable contract. Strict rejection causes false-positive parse
 * failures (see canary report 2026-05-19, plan
 * docs/plans/260520_sentry_autopilot_stage_5_5_schema_passthrough.md).
 *
 * To promote a high-value provenance field to the typed surface, add it
 * as `.optional()` on the relevant branch — the type narrows from
 * `unknown` to the typed variant without breaking existing callers.
 *
 * For `auto_committed` outcomes, validates that `commit_hash` resolves to an
 * actual commit in the repository at `config.repoRoot` via `git cat-file -e`.
 *
 * `skipCommitValidation` is a canary-only escape hatch used by
 * `scripts/sentry-autopilot/canary/offline-replay.ts` when replaying
 * historical outcomes whose original commits may no longer exist in the local
 * checkout. Production callers MUST NOT pass this flag — the production
 * `AutopilotConfig` type intentionally does not include it, so the default
 * behavior is preserved when `session-manager.ts` passes its config unchanged.
 */
export function parseOutcome(
  input: unknown,
  config: Pick<AutopilotConfig, 'repoRoot'> & { skipCommitValidation?: boolean },
): Outcome {
  let parsed: Outcome;
  try {
    parsed = OutcomeSchema.parse(input);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid outcome payload: ${details}`, { cause: input });
  }

  if (parsed.outcome === 'auto_committed' && !config.skipCommitValidation) {
    validateGitCommitExists(config.repoRoot, parsed.commit_hash);
  }

  return parsed;
}
