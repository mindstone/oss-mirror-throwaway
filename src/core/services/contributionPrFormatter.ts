/**
 * Contribution PR Formatter (Stage 1)
 *
 * Near-pure-function module that produces a `PrMetadata` record (title +
 * body + submissionPath) for a connector contribution. The only I/O is
 * `fs/promises` in `inferConfigSummaryFromDisk`, which reads the
 * connector's `.env.example` to summarise required environment keys.
 *
 * Design intent:
 *   - Single source of truth for PR title/body shape across *both*
 *     transports (relay + GitHub fork). Stage 3 wires both callers
 *     through `composePrMetadata`, preserving byte-level parity of
 *     bodies for identical inputs (submissionPath is the only legit
 *     divergence, and even that is just substituted into the dispatcher
 *     log — not the body).
 *   - Fail-closed on missing submitter attribution. The whole reason
 *     this module exists is that live PR #18 silently dropped the
 *     submitter section; silent omission of the same bug would defeat
 *     the fix. Throws `ContributionPrFormatterValidationError`.
 *   - Discriminated `ConfigInferenceResult` so callers (formatter body
 *     assembler + Stage 3 dispatcher observability log) can narrow on
 *     `outcome` without stringly-typed mapping.
 *   - Sanitization parity with backend `sanitizePrBody`
 *     (`rebel-platform/server/schemas/contribution-relay-v1.ts:161-175`).
 *     Strips the `<script`, `<iframe`, `<object`, `<embed` tag openers
 *     (case-insensitive). Applied *once* to the final body before
 *     returning from `composePrMetadata`.
 *
 * @see docs/plans/260424_contribution_pr_template_revamp.md (Stage 1)
 * @see docs/contracts/contribution-relay-v1.md
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'contribution-pr-formatter' });

// ─── Constants ──────────────────────────────────────────────────────

/** Max PR title length (mirrors backend `contribution-relay-v1` schema cap). */
export const TITLE_MAX = 120;

/** Max PR body length (mirrors backend `contribution-relay-v1` schema cap). */
export const BODY_MAX = 4096;

/** Max Build Context appendix length before warning/truncation logic applies. */
export const MAX_APPENDIX_LEN = 256;

/** Max keys listed before truncation with an "...and N more" suffix. */
const CONFIG_KEY_PREVIEW_LIMIT = 10;

const BUILD_CONTEXT_HEADER = '**Build Context** (auto-generated provenance)';
const BUILD_CONTEXT_PREFIX = `---\n${BUILD_CONTEXT_HEADER}`;
const BUILD_CONTEXT_SEPARATOR = '\n\n';
const ELLIPSIS = '…';

/**
 * Mirrors `sanitizePrBody` in
 * `rebel-platform/server/schemas/contribution-relay-v1.ts:161-175`.
 * Strips the tag openers for `<script`, `<iframe`, `<object`, `<embed`
 * (case-insensitive, word-boundary).
 */
const SANITIZE_TAG_OPENER_PATTERN = /<(script|iframe|object|embed)\b/gi;

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Discriminated outcome of `inferConfigSummaryFromDisk`. The Stage 3
 * observability log surfaces `outcome` verbatim under
 * `configInferenceOutcome` — no caller-side mapping.
 *
 * - `parsed`:      `.env.example` exists with at least one parsable key;
 *                  `summary` is a comma-separated list (first 10 keys, then
 *                  `"...and N more"`).
 * - `none`:        File exists but only blank / comment lines (the user
 *                  has the file; it's just empty of keys). Distinct from
 *                  `missing` because absence and emptiness are different
 *                  honest signals.
 * - `missing`:     `ENOENT`, OR `localServerPath` empty/undefined. Both
 *                  fold into `missing` because the user-facing semantic
 *                  ("no config file to describe") is identical. The
 *                  empty-path branch additionally emits a structured
 *                  `warn` log for telemetry debugging.
 * - `read_error`:  Any other fs failure (permission denied, EISDIR,
 *                  decode errors). `errorCode` is populated from the
 *                  fs error when available. The formatter omits the
 *                  Configuration / docs section rather than guessing.
 */
export type ConfigInferenceResult =
  | { outcome: 'parsed'; summary: string }
  | { outcome: 'none' }
  | { outcome: 'missing' }
  | { outcome: 'read_error'; errorCode?: string };

export type BuildContext = {
  model: string;
  appVersion: string;
  sessionId: string;
  appWorkflow: 'software-engineer' | 'direct';
  taskSubagentTypes: string[];
  buildPlanShape: 'se-working-doc' | 'stub' | 'missing';
};

export type AppendixWarning =
  | { kind: 'body_truncated'; originalLen: number; truncatedTo: number }
  | {
      kind: 'appendix_field_truncated';
      field: 'taskSubagentTypes';
      originalCount: number;
      keptCount: number;
    }
  | {
      kind: 'appendix_omitted';
      reason: 'appendix_alone_exceeds_bodymax' | 'budget_exhausted_after_truncation';
      appendixLen: number;
    };

/**
 * Output shape returned by `composePrMetadata`. The `PrMetadata` record
 * structurally prevents future title/body divergence — both transports
 * receive the same object and destructure the fields they need.
 */
export type PrMetadata = {
  title: string;
  body: string;
  submissionPath: 'Rebel relay' | 'GitHub fork';
};

/**
 * Full input for `composePrMetadata`. The caller (Stage 3 dispatcher)
 * is responsible for setting `includeSubmitterInTitle` based on the
 * transport + attribution mode:
 *   - Relay + non-anonymous → `true`.
 *   - Own-fork (any mode)   → `false` (audit §5: own-fork titles are bare).
 *   - Anonymous             → `false` (no submitter to name).
 *
 * `validationEvidence` is always provided by the dispatcher — call
 * `buildValidationEvidence()` for the V1 default.
 *
 * `inferredSummary` is the auto-generated fallback (e.g. from the
 * connector's `package.json` description) used **only** when the user's
 * `summary` field is empty. The user form was removed in postmortem
 * 260424, so in practice every PR goes through this fallback unless the
 * agent populated `prBody` (in which case the agent_override branch
 * substitutes the body wholesale and this fallback is unused for that
 * sub-case). Whitespace-only values are treated as empty.
 */
export type ComposePrMetadataInput = {
  connectorName: string;
  attributionMode: 'rebel-name' | 'github' | 'anonymous';
  attributionName?: string;
  /** Gate for the "— submitted by <name>" title suffix; see type doc. */
  includeSubmitterInTitle: boolean;
  submissionPath: 'Rebel relay' | 'GitHub fork';
  summary?: string;
  /** Auto-generated summary fallback (read from `package.json` description on disk). */
  inferredSummary?: string;
  motivation?: string;
  reviewerNotes?: string;
  /** Structured outcome; body assembler narrows on `outcome` to decide emit-vs-omit. */
  configResult: ConfigInferenceResult;
  validationEvidence: string;
};

// ─── Error class ────────────────────────────────────────────────────

/**
 * Thrown by the formatter when the caller hands it malformed input
 * (missing attribution name on a non-anonymous flow, oversized output
 * past `TITLE_MAX` / `BODY_MAX`, etc.). Stage 3 dispatcher catches this
 * and maps it to a structured VALIDATION failure body before the
 * network request is attempted.
 */
export class ContributionPrFormatterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContributionPrFormatterValidationError';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

const isBlankOrComment = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
};

/**
 * Matches lines of the form `KEY=...` (optionally prefixed by `export `).
 * Key must match `[A-Z_][A-Z0-9_]*`.
 */
const ENV_KEY_PATTERN = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=/;

const parseEnvExampleKeys = (contents: string): string[] => {
  const keys: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (isBlankOrComment(line)) continue;
    const match = ENV_KEY_PATTERN.exec(line);
    if (match && match[1]) {
      keys.push(match[1]);
    }
  }
  return keys;
};

const summariseKeys = (keys: readonly string[]): string => {
  if (keys.length <= CONFIG_KEY_PREVIEW_LIMIT) {
    return keys.join(', ');
  }
  const previewed = keys.slice(0, CONFIG_KEY_PREVIEW_LIMIT).join(', ');
  const remaining = keys.length - CONFIG_KEY_PREVIEW_LIMIT;
  return `${previewed}, ...and ${remaining} more`;
};

const requireAttributionName = (
  attributionName: string | undefined,
  where: 'title' | 'body',
): string => {
  const trimmed = (attributionName ?? '').trim();
  if (trimmed === '') {
    throw new ContributionPrFormatterValidationError(
      `Missing attributionName for non-anonymous ${where} (fail-closed to prevent silent submitter drop).`,
    );
  }
  return trimmed;
};

const normalizeBuildContextText = (value: string | undefined): string => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? 'unknown' : trimmed;
};

const normalizeTaskSubagentTypes = (taskSubagentTypes: readonly string[] | undefined): string[] => {
  const cleaned = (taskSubagentTypes ?? [])
    .map((value) => value.trim())
    .filter((value) => value !== '');
  return Array.from(new Set(cleaned)).sort((a, b) => a.localeCompare(b));
};

const renderBuildContextAppendix = (ctx: BuildContext, taskSubagentsValue: string): string => {
  const appWorkflow = ctx.appWorkflow === 'software-engineer' ? 'software-engineer' : 'direct';
  const buildPlanShape = ctx.buildPlanShape ?? 'missing';
  return [
    '---',
    BUILD_CONTEXT_HEADER,
    '',
    `- App-Workflow: ${appWorkflow}`,
    `- App-Version: ${normalizeBuildContextText(ctx.appVersion)}`,
    `- Model: ${normalizeBuildContextText(ctx.model)}`,
    `- Session-ID: ${normalizeBuildContextText(ctx.sessionId)}`,
    `- Task-Subagents: ${taskSubagentsValue}`,
    `- Build-Plan-Shape: ${buildPlanShape}`,
  ].join('\n');
};

const truncateWithEllipsis = (value: string, maxLength: number): string => {
  if (maxLength <= 0) return '';
  if (value.length <= maxLength) return value;
  if (maxLength === 1) return ELLIPSIS;
  return `${value.slice(0, maxLength - 1)}${ELLIPSIS}`;
};

const buildAppendixWithinLength = (
  ctx: BuildContext,
  maxAppendixLen: number,
): { appendix: string; warning?: AppendixWarning } => {
  const subagentTypes = normalizeTaskSubagentTypes(ctx.taskSubagentTypes);
  const fullSubagentValue =
    subagentTypes.length > 0 ? subagentTypes.join(', ') : 'unknown';
  const fullAppendix = renderBuildContextAppendix(ctx, fullSubagentValue);
  if (fullAppendix.length <= maxAppendixLen || subagentTypes.length === 0) {
    return { appendix: fullAppendix };
  }

  for (let keptCount = subagentTypes.length - 1; keptCount >= 0; keptCount -= 1) {
    const truncatedValue = keptCount === 0
      ? ELLIPSIS
      : `${subagentTypes.slice(0, keptCount).join(', ')}, ${ELLIPSIS}`;
    const candidate = renderBuildContextAppendix(ctx, truncatedValue);
    if (candidate.length <= maxAppendixLen) {
      return {
        appendix: candidate,
        warning: {
          kind: 'appendix_field_truncated',
          field: 'taskSubagentTypes',
          originalCount: subagentTypes.length,
          keptCount,
        },
      };
    }
  }

  return {
    appendix: renderBuildContextAppendix(ctx, ELLIPSIS),
    warning: {
      kind: 'appendix_field_truncated',
      field: 'taskSubagentTypes',
      originalCount: subagentTypes.length,
      keptCount: 0,
    },
  };
};

function sanitizeBuildContextFromBody(body: string): string {
  const markerIndex = body.lastIndexOf(`${BUILD_CONTEXT_SEPARATOR}${BUILD_CONTEXT_PREFIX}`);
  if (markerIndex < 0) {
    return body;
  }
  return body.slice(0, markerIndex);
}

const normalizeFingerprintValue = (value: unknown, key?: string): unknown => {
  if (typeof value === 'string' && key === 'prBody') {
    return sanitizeBuildContextFromBody(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeFingerprintValue(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const currentKey of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      normalized[currentKey] = normalizeFingerprintValue(record[currentKey], currentKey);
    }
    return normalized;
  }
  return value;
};

// ─── Public API ─────────────────────────────────────────────────────

export function formatBuildContextAppendix(ctx: BuildContext): string {
  const taskSubagentTypes = normalizeTaskSubagentTypes(ctx.taskSubagentTypes);
  const taskSubagentsValue =
    taskSubagentTypes.length > 0 ? taskSubagentTypes.join(', ') : 'unknown';
  return renderBuildContextAppendix(ctx, taskSubagentsValue);
}

export function appendBuildContextAppendix(
  body: string,
  ctx: BuildContext,
  opts: { bodyMax: number; maxAppendixLen: number },
): { body: string; warnings: AppendixWarning[] } {
  const warnings: AppendixWarning[] = [];
  const bodyMax = Number.isFinite(opts.bodyMax) ? Math.max(0, Math.floor(opts.bodyMax)) : BODY_MAX;
  const maxAppendixLen = Number.isFinite(opts.maxAppendixLen)
    ? Math.max(0, Math.floor(opts.maxAppendixLen))
    : MAX_APPENDIX_LEN;

  const { appendix, warning } = buildAppendixWithinLength(ctx, maxAppendixLen);
  if (warning) {
    warnings.push(warning);
  }

  const originalBody = body;
  const reservedBodyCap = Math.max(0, bodyMax - BUILD_CONTEXT_SEPARATOR.length - maxAppendixLen);
  const truncatedBody = truncateWithEllipsis(originalBody, reservedBodyCap);
  if (truncatedBody.length < originalBody.length) {
    warnings.push({
      kind: 'body_truncated',
      originalLen: originalBody.length,
      truncatedTo: truncatedBody.length,
    });
  }

  const appendedBody = `${truncatedBody}${BUILD_CONTEXT_SEPARATOR}${appendix}`;
  if (appendedBody.length <= bodyMax) {
    return { body: appendedBody, warnings };
  }

  const appendixTotalLen = appendix.length + BUILD_CONTEXT_SEPARATOR.length;
  warnings.push({
    kind: 'appendix_omitted',
    reason: appendixTotalLen > bodyMax
      ? 'appendix_alone_exceeds_bodymax'
      : 'budget_exhausted_after_truncation',
    appendixLen: appendix.length,
  });
  return { body: truncateWithEllipsis(truncatedBody, bodyMax), warnings };
}

export function classifyBuildPlanShape(content: string): 'se-working-doc' | 'stub' | 'missing' {
  const trimmed = content.trim();
  if (trimmed === '') {
    return 'missing';
  }

  const frontmatterMatch = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!frontmatterMatch) {
    return 'stub';
  }

  const frontmatter = frontmatterMatch[1] ?? '';
  const hasWorkflow = /^workflow:\s*software-engineer\s*$/m.test(frontmatter);
  const hasModelsBlock = /^models:\s*$/m.test(frontmatter);
  const hasModelEntries = ['orchestrator', 'planner', 'implementer', 'reviewer']
    .every((field) => new RegExp(`^\\s{2,}${field}:\\s*.+$`, 'm').test(frontmatter));

  const bodyAfterFrontmatter = trimmed.slice(frontmatterMatch[0].length);
  const hasReviewHistorySection = /^##\s+Review History\b/m.test(bodyAfterFrontmatter);

  return hasWorkflow && hasModelsBlock && hasModelEntries && hasReviewHistorySection
    ? 'se-working-doc'
    : 'stub';
}

export function computePayloadFingerprintExcludingAppendix(
  payload: Record<string, unknown>,
): string {
  const normalizedPayload = normalizeFingerprintValue(payload);
  return createHash('sha256')
    .update(JSON.stringify(normalizedPayload))
    .digest('hex');
}

/**
 * Pure string transform that mirrors the backend's `sanitizePrBody`
 * exactly (see `rebel-platform/server/schemas/contribution-relay-v1.ts:161-175`,
 * `DANGEROUS_TAG_REGEX = /<(script|iframe|object|embed)\b/gi` +
 * `raw.replace(DANGEROUS_TAG_REGEX, "")`). Byte-identical behaviour:
 * strips the matched tag opener entirely (replacement string is the
 * empty string). The relay path then passes through backend
 * `sanitizePrBody` as a no-op (desktop output contains no further
 * matches), so both transports produce byte-identical PR bodies.
 *
 * Stage 1 keeps this a pure transform — mutation-observability logging
 * is owned by the Stage 3 dispatcher, which holds `contributionId` +
 * `submissionPath` context.
 */
export function sanitizeForGitHub(body: string): string {
  return body.replace(SANITIZE_TAG_OPENER_PATTERN, '');
}

/**
 * V1 validation evidence copy.
 *
 * **Do NOT upgrade this copy to claim `Build: ✓ / Lint: ✓ / Tests: ✓`.**
 * The Stage 3 readiness predicate
 * (`src/core/services/contributionObservationService.ts`) fires on
 * lightweight durable timestamps (build-detected + test-pass OR
 * server-registered + agent-asserted ready); none of them captures a
 * real CI build/lint/test run. Claiming otherwise would overclaim the
 * evidence we actually have.
 */
export function buildValidationEvidence(): string {
  return [
    '- Pre-submit checks passed in Rebel (readiness signal confirmed).',
    '- See commit history in the PR for test evidence.',
  ].join('\n');
}

/**
 * Returns `true` iff the user has engaged with the PR form — at least
 * one of `summary`, `motivation`, `reviewerNotes` is a non-empty string
 * after `.trim()`. Used by the Stage 3 dispatcher to pick the precedence
 * branch (user-form wins over agent-override which wins over the
 * formatter default).
 *
 * Centralising this predicate in the formatter keeps the
 * "engaged?"-rule in a single unit-testable place and prevents relay
 * and own-fork paths from drifting.
 */
export function hasUserPrFormContent(input: {
  summary?: string;
  motivation?: string;
  reviewerNotes?: string;
}): boolean {
  const fields = [input.summary, input.motivation, input.reviewerNotes];
  return fields.some((f) => typeof f === 'string' && f.trim() !== '');
}

/**
 * Reads `path.join(localServerPath, '.env.example')` and returns a
 * structured `ConfigInferenceResult`. See type doc for the four
 * outcomes and their meanings.
 */
export async function inferConfigSummaryFromDisk(
  localServerPath: string | undefined,
): Promise<ConfigInferenceResult> {
  if (!localServerPath || localServerPath.trim() === '') {
    log.warn(
      { localServerPath },
      'inferConfigSummaryFromDisk: empty localServerPath',
    );
    return { outcome: 'missing' };
  }

  const envExamplePath = path.join(localServerPath, '.env.example');
  let contents: string;
  try {
    contents = await readFile(envExamplePath, 'utf8');
  } catch (err) {
    const errorCode = (err as NodeJS.ErrnoException)?.code;
    if (errorCode === 'ENOENT') {
      // Expected case: connector has no `.env.example`. No warn — the
      // Configuration / docs section simply gets omitted.
      return { outcome: 'missing' };
    }
    log.warn(
      { localServerPath, errorCode },
      'inferConfigSummaryFromDisk: fs error',
    );
    return errorCode ? { outcome: 'read_error', errorCode } : { outcome: 'read_error' };
  }

  const keys = parseEnvExampleKeys(contents);
  if (keys.length === 0) {
    return { outcome: 'none' };
  }
  return { outcome: 'parsed', summary: summariseKeys(keys) };
}

/**
 * Reads `path.join(localServerPath, 'package.json')` and returns the
 * `description` field (trimmed) when present and non-empty. Returns
 * `undefined` for ENOENT, missing/empty/non-string `description`,
 * empty `localServerPath`, JSON parse errors, and any other fs error
 * (with a structured `warn` log for the non-ENOENT cases so we keep
 * silent failures observable per project policy).
 *
 * The inferred summary is wired into the `## Summary` section as a
 * fallback when the user's `summary` is empty (the user form was
 * removed in postmortem 260424, so every formatter_default PR now
 * benefits from this fallback). The agent populates the connector's
 * `package.json` description during the build conversation, so this
 * is a high-signal source.
 *
 * Sanitization is NOT applied here — `composePrMetadata` runs the
 * single sanitization pass on the fully-assembled body, so any
 * adversarial tags in the description are stripped uniformly with
 * the rest of the body.
 */
export async function inferSummaryFromDisk(
  localServerPath: string | undefined,
): Promise<string | undefined> {
  if (!localServerPath || localServerPath.trim() === '') {
    log.warn(
      { localServerPath },
      'inferSummaryFromDisk: empty localServerPath',
    );
    return undefined;
  }

  const packageJsonPath = path.join(localServerPath, 'package.json');
  let contents: string;
  try {
    contents = await readFile(packageJsonPath, 'utf8');
  } catch (err) {
    const errorCode = (err as NodeJS.ErrnoException)?.code;
    if (errorCode === 'ENOENT') {
      // Expected case: connector has no `package.json`. No warn — the
      // Summary fallback simply isn't emitted.
      return undefined;
    }
    log.warn(
      { localServerPath, errorCode },
      'inferSummaryFromDisk: fs error',
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    log.warn(
      { localServerPath, err: err instanceof Error ? err.message : String(err) },
      'inferSummaryFromDisk: package.json JSON parse failed',
    );
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const description = (parsed as Record<string, unknown>).description;
  if (typeof description !== 'string') {
    return undefined;
  }
  const trimmed = description.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Pure, exported-for-isolated-unit-test. Returns the formatter-generated
 * PR title.
 *
 * Shape: `feat(connector): add <connectorName>` with an optional
 * `— submitted by <attributionName>` suffix.
 *
 * Suffix is omitted when:
 *   - `attributionMode === 'anonymous'` (no submitter to name), OR
 *   - `includeSubmitterInTitle === false` (e.g. own-fork per audit §5), OR
 *   - appending the suffix would push past `TITLE_MAX` (120).
 *
 * **Fail-closed**: when `includeSubmitterInTitle === true` AND
 * `attributionMode` is `'rebel-name'` or `'github'` AND `attributionName`
 * is absent/empty/whitespace-only, **throws**
 * `ContributionPrFormatterValidationError`. Silent omission would mask
 * the same bug the module exists to fix (live PR #18 regression).
 */
export function formatContributionPrTitle(input: {
  connectorName: string;
  attributionName: string | undefined;
  attributionMode: 'rebel-name' | 'github' | 'anonymous';
  includeSubmitterInTitle: boolean;
}): string {
  const { connectorName, attributionName, attributionMode, includeSubmitterInTitle } = input;
  const bare = `feat(connector): add ${connectorName}`;

  if (attributionMode === 'anonymous' || !includeSubmitterInTitle) {
    return bare;
  }

  // Non-anonymous AND includeSubmitterInTitle === true → require a name.
  const submitter = requireAttributionName(attributionName, 'title');
  const withSuffix = `${bare} — submitted by ${submitter}`;

  if (withSuffix.length > TITLE_MAX) {
    log.info(
      {
        connectorNameLength: connectorName.length,
        attributionNameLength: submitter.length,
        suffixDropped: true,
      },
      'formatContributionPrTitle: suffix dropped due to TITLE_MAX overflow',
    );
    return bare;
  }
  return withSuffix;
}

/**
 * Pure, exported-for-isolated-unit-test. Returns the formatter-generated
 * PR body. Section layout:
 *
 *   ## Summary                              ← omit when empty after trim
 *   ## Submitter                            ← omit when anonymous
 *   ## Why this connector is useful         ← omit when empty after trim
 *   ## Validation                           ← always present
 *   ## Configuration / docs                 ← emit when outcome ∈ {parsed, none}; omit otherwise
 *   ## Breaking changes / reviewer notes    ← emit only when reviewerNotes non-empty after trim
 *
 * **Fail-closed**: when `attributionMode` is `'rebel-name'` or
 * `'github'` and `attributionName` is absent/empty/whitespace-only,
 * **throws** `ContributionPrFormatterValidationError`.
 *
 * Sanitization is NOT applied here — `composePrMetadata` owns the
 * single sanitization pass on the fully-assembled body so the rule
 * stays in one place and adversarial content cannot sneak past section
 * boundaries.
 */
export function formatContributionPrBody(input: ComposePrMetadataInput): string {
  const sections: string[] = [];

  // Summary precedence: explicit user `summary` (form-derived, dormant
  // since postmortem 260424) wins; otherwise fall back to
  // `inferredSummary` (e.g. `package.json` description). Both are
  // whitespace-trimmed; whitespace-only values are treated as empty so
  // a stray space in storage cannot suppress the auto-fallback.
  const summaryTrimmed = (input.summary ?? '').trim();
  const inferredTrimmed = (input.inferredSummary ?? '').trim();
  const effectiveSummary = summaryTrimmed !== '' ? summaryTrimmed : inferredTrimmed;
  if (effectiveSummary !== '') {
    sections.push(`## Summary\n${effectiveSummary}`);
  }

  if (input.attributionMode !== 'anonymous') {
    const submitter = requireAttributionName(input.attributionName, 'body');
    sections.push(`## Submitter\n${submitter}`);
  }

  const motivationTrimmed = (input.motivation ?? '').trim();
  if (motivationTrimmed !== '') {
    sections.push(`## Why this connector is useful\n${motivationTrimmed}`);
  }

  // Validation is always emitted; the dispatcher guarantees validationEvidence.
  sections.push(`## Validation\n${input.validationEvidence}`);

  // Configuration / docs — narrow on outcome.
  switch (input.configResult.outcome) {
    case 'parsed':
      sections.push(`## Configuration / docs\n${input.configResult.summary}`);
      break;
    case 'none':
      sections.push('## Configuration / docs\nNone');
      break;
    case 'missing':
    case 'read_error':
      // Silence is more honest than guessing — absence of / inability to
      // read `.env.example` is distinct from "no env vars required".
      break;
  }

  const reviewerNotesTrimmed = (input.reviewerNotes ?? '').trim();
  if (reviewerNotesTrimmed !== '') {
    sections.push(`## Breaking changes / reviewer notes\n${reviewerNotesTrimmed}`);
  }

  return sections.join('\n\n');
}

/**
 * Single entry point for assembling a `PrMetadata` record.
 *
 * Steps:
 *   1. Build title via `formatContributionPrTitle`.
 *   2. Build body via `formatContributionPrBody`.
 *   3. Apply `sanitizeForGitHub` to the final body (single pass).
 *   4. Assert `title.length <= TITLE_MAX` AND `body.length <= BODY_MAX`;
 *      throw `ContributionPrFormatterValidationError` otherwise so the
 *      caller maps it to a structured VALIDATION error before the
 *      network request is attempted.
 */
export function composePrMetadata(input: ComposePrMetadataInput): PrMetadata {
  const title = formatContributionPrTitle({
    connectorName: input.connectorName,
    attributionName: input.attributionName,
    attributionMode: input.attributionMode,
    includeSubmitterInTitle: input.includeSubmitterInTitle,
  });
  const rawBody = formatContributionPrBody(input);
  const body = sanitizeForGitHub(rawBody);

  if (title.length > TITLE_MAX) {
    throw new ContributionPrFormatterValidationError(
      `PR title exceeds TITLE_MAX (${TITLE_MAX}); actual ${title.length}.`,
    );
  }
  if (body.length > BODY_MAX) {
    throw new ContributionPrFormatterValidationError(
      `PR body exceeds BODY_MAX (${BODY_MAX}); actual ${body.length}.`,
    );
  }

  return { title, body, submissionPath: input.submissionPath };
}
