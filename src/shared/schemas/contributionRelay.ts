/**
 * Contribution Relay v1 — HTTP Contract Schemas
 *
 * Canonical Zod schemas shared between the Rebel desktop app and the
 * Mindstone `cloud-service` relay endpoints (see
 * `docs/contracts/contribution-relay-v1.md`).
 *
 * This is the **single source of truth** for request/response shapes.
 * Backend and desktop must both conform to these types. Breaking
 * changes require a new version (bump URL path to `/v2/`).
 *
 * Relay is only used for non-GitHub attribution modes; the D7 direct
 * fork/push path stays unchanged for `attributionMode === 'github'`.
 *
 * @see docs/plans/260420_oss_mcp_backend_relay.md
 * @see docs/contracts/contribution-relay-v1.md
 */

import { z } from 'zod';
import { isDenylistedFilename } from '@shared/utils/contributionSensitiveFiles';

// ─── URL path (for clients that need to construct URLs) ─────────────

export const CONTRIBUTION_RELAY_API_VERSION = 'v1' as const;
export const CONTRIBUTION_RELAY_SUBMIT_PATH =
  `/api/contribution/${CONTRIBUTION_RELAY_API_VERSION}/submit` as const;
export function contributionRelayStatusPath(relayContributionId: string): string {
  return `/api/contribution/${CONTRIBUTION_RELAY_API_VERSION}/${encodeURIComponent(relayContributionId)}/status`;
}

// ─── Shared primitives ──────────────────────────────────────────────

/**
 * `attributionMode` accepted by the relay. `'github'` is intentionally
 * excluded — github-attributed contributions use the D7 direct path and
 * must never hit the relay.
 */
export const RelayAttributionModeSchema = z.enum(['rebel-name', 'anonymous']);
export type RelayAttributionMode = z.infer<typeof RelayAttributionModeSchema>;

/** Connector name pattern (mirrors npm-like slugs). */
export const CONNECTOR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const CONNECTOR_NAME_MAX = 64;

/**
 * Attribution-name rules (Stage 6.1 M2) — mirror of the backend contract at
 * `server/schemas/contribution-relay-v1.ts` (rebel-platform). Unicode letters
 * and digits plus space, dot, underscore, hyphen; 1–80 chars; must include
 * at least one letter or digit (rejects names like " . _ " or "---").
 *
 * Exported so UI surfaces (AccountTab, picker validation) can pre-check the
 * same rules the schema enforces at submit time — without these, users with
 * names like "O'Brien" or "Smith, Jr." only discover the rejection at the
 * end of the submit flow.
 */
export const ATTRIBUTION_NAME_MAX = 80;
export const ATTRIBUTION_NAME_CHAR_PATTERN = /^[\p{L}\p{N} ._-]+$/u;
export const ATTRIBUTION_NAME_LETTER_DIGIT_PATTERN = /[\p{L}\p{N}]/u;

/**
 * Human-readable validator for an attribution name. Returns `null` when the
 * name is acceptable (including empty — callers that require presence should
 * check separately), or a user-facing error string when it isn't. UI copy is
 * brand-voice neutral ("Names can only contain…") rather than technical
 * ("regex failed"). Intentionally permissive about surrounding whitespace —
 * the schema trims before sending, so "Alex  " is validated as "Alex".
 */
export function validateAttributionName(rawName: string): string | null {
  const name = rawName.trim();
  if (name.length === 0) {
    // Empty is "no name entered" — callers decide whether that's an error.
    return null;
  }
  if (name.length > ATTRIBUTION_NAME_MAX) {
    return `Names can be at most ${ATTRIBUTION_NAME_MAX} characters.`;
  }
  if (!ATTRIBUTION_NAME_CHAR_PATTERN.test(name)) {
    return "Names can only use letters, digits, spaces, and the characters . _ - (no apostrophes, commas, or parentheses).";
  }
  if (!ATTRIBUTION_NAME_LETTER_DIGIT_PATTERN.test(name)) {
    return 'Names must include at least one letter or digit.';
  }
  return null;
}

/**
 * Path rules:
 *  - No absolute paths (must not start with `/` or a drive letter).
 *  - No `..` segments.
 *  - No `.github/` targeting.
 *  - Must be under `connectors/<connectorName>/`.
 *
 * Connector-name match is enforced at the object level (refine) because
 * the schema can't see sibling fields.
 */
const ContributionFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p), {
      message: 'File path must be relative (no absolute paths).',
    })
    .refine((p) => !p.split(/[\\/]/).includes('..'), {
      message: 'File path must not contain "..".',
    })
    .refine((p) => !p.startsWith('.github/') && !p.startsWith('.github\\'), {
      message: 'File path must not target .github/.',
    })
    // Sensitive-file denylist (mirror of rebel-platform's `isDenylistedExtension`).
    // Belt-and-braces: the reader already pre-filters these, but any future
    // code path that constructs `files[]` by hand still gets caught here
    // before the POST reaches the backend. Message string mirrors the
    // backend's verbatim to keep parity tests + audit logs consistent.
    .refine(
      (p) => {
        const basename = p.split(/[\\/]/).pop() ?? p;
        return !isDenylistedFilename(basename);
      },
      { message: 'file path targets a denylisted extension' },
    ),
  /** UTF-8 text only. Binary or null-byte content is rejected. */
  content: z
    .string()
    .max(256 * 1024, 'File content exceeds 256KB per-file limit.')
    .refine((c) => !c.includes('\u0000'), {
      message: 'File content must not contain null bytes (binary content is not supported).',
    }),
});
export type ContributionFile = z.infer<typeof ContributionFileSchema>;

// ─── POST /submit ───────────────────────────────────────────────────

/** Total payload-size cap (sum of file contents). Server re-enforces this. */
export const RELAY_SUBMIT_TOTAL_BYTES_MAX = 2 * 1024 * 1024;
/** Max number of files per submission. */
export const RELAY_SUBMIT_MAX_FILES = 50;

export const RelaySubmitRequestSchema = z
  .object({
    /**
     * Desktop store contribution id. Used by the backend for idempotency:
     * repeat submits with the same id + same user return the existing PR.
     */
    clientContributionId: z.string().min(1).max(128),
    /** Connector slug; must match the leading path segment of every file. */
    connectorName: z
      .string()
      .min(1)
      .max(CONNECTOR_NAME_MAX)
      .regex(CONNECTOR_NAME_PATTERN, {
        message:
          'connectorName must be lowercase alphanumeric with hyphens (no leading hyphen).',
      }),
    attributionMode: RelayAttributionModeSchema,
    /**
     * Display name for `rebel-name` mode. Ignored when `anonymous`.
     * Plain text — backend escapes for markdown before inclusion in PR body.
     *
     * Regex mirrors the backend exactly (`server/schemas/contribution-relay-v1.ts`):
     * `/^[\p{L}\p{N} ._-]{1,80}$/u`. Unicode letters/digits plus space, dot,
     * underscore, hyphen — no apostrophes, commas, or parens. Must contain at
     * least one letter or digit (prevents names like " . ." from passing).
     */
    attributionName: z
      .string()
      .min(1)
      .max(ATTRIBUTION_NAME_MAX)
      .regex(ATTRIBUTION_NAME_CHAR_PATTERN, {
        message:
          'attributionName may only contain letters, digits, spaces, dots, underscores, or hyphens.',
      })
      .refine((name) => ATTRIBUTION_NAME_LETTER_DIGIT_PATTERN.test(name), {
        message: 'attributionName must contain at least one letter or digit.',
      })
      .optional(),
    prTitle: z.string().min(1).max(120),
    prBody: z.string().max(4096),
    files: z
      .array(ContributionFileSchema)
      .min(1, 'At least one file is required.')
      .max(RELAY_SUBMIT_MAX_FILES, `At most ${RELAY_SUBMIT_MAX_FILES} files per submission.`),
  })
  .superRefine((value, ctx) => {
    if (value.attributionMode === 'rebel-name' && !value.attributionName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attributionName'],
        message: 'attributionName is required when attributionMode is "rebel-name".',
      });
    }

    const allowedPrefix = `connectors/${value.connectorName}/`;
    for (let i = 0; i < value.files.length; i += 1) {
      const file = value.files[i];
      if (!file.path.startsWith(allowedPrefix)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', i, 'path'],
          message: `File path must begin with "${allowedPrefix}".`,
        });
      }
    }

    const totalBytes = value.files.reduce(
      (sum, file) => sum + Buffer.byteLength(file.content, 'utf8'),
      0,
    );
    if (totalBytes > RELAY_SUBMIT_TOTAL_BYTES_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: `Total payload size (${totalBytes} bytes) exceeds ${RELAY_SUBMIT_TOTAL_BYTES_MAX} bytes.`,
      });
    }
  });
export type RelaySubmitRequest = z.infer<typeof RelaySubmitRequestSchema>;

// ─── Error shape ────────────────────────────────────────────────────

export const RelayErrorCodeSchema = z.enum([
  'VALIDATION',
  'RATE_LIMIT',
  'GITHUB_API',
  'DUPLICATE',
  'UNAUTHORIZED',
  'NOT_FOUND',
  /**
   * Desktop-only synthesis (not emitted by the backend): produced by
   * the desktop relay extension when local fetch aborts/times out before
   * any relay HTTP response is received.
   */
  'TIMEOUT',
  'INTERNAL',
  /**
   * HTTP 404 from `GET /status` when the submission was accepted but the PR
   * has not been created yet (still in flight). Desktop must back off and
   * poll again rather than surfacing this as a terminal error.
   */
  'IN_FLIGHT',
]);
export type RelayErrorCode = z.infer<typeof RelayErrorCodeSchema>;

/**
 * Individual zod validation issue as surfaced by the backend on a
 * VALIDATION error envelope. Shape mirrors Zod's flattened issue form:
 *
 * ```
 * { path: ["files", 5, "path"], message: "file path targets a denylisted extension" }
 * ```
 *
 * Exported so tests + future UI surfaces can narrow structured access to
 * the full issue list (e.g. presenting all issues rather than only the
 * first one). `passthrough()` so backends that add extra fields (`code`,
 * `fatal`, `expected`, etc.) don't trip parse.
 *
 * @see docs-private/investigations/260423_contribution_relay_400_validation.md
 * @see docs/contracts/contribution-relay-v1.md (VALIDATION error shape)
 */
export const RelayValidationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .passthrough();
export type RelayValidationIssue = z.infer<typeof RelayValidationIssueSchema>;

const RelayErrorBodySchema = z.object({
  code: RelayErrorCodeSchema,
  message: z.string(),
  /**
   * Shape is code-dependent:
   *  - `VALIDATION` → `Array<RelayValidationIssue>` (zod issue list).
   *  - `DUPLICATE` → `Record<string, unknown>` carrying the existing PR
   *    metadata (`relayContributionId`, `prUrl`, `prNumber`).
   *  - Other codes → absent or free-form record.
   *
   * The union below accepts both shapes so consumers calling
   * `RelaySubmitErrorSchema.parse(body)` don't reject a legitimate
   * backend response. Narrow at the use site (see
   * `extractFirstValidationIssue` / duplicate handling in the private
   * relay transport) — the pre-2026-04-23
   * version forced every shape through `z.record(...)` and silently
   * corrupted the VALIDATION array shape.
   *
   * @see docs-private/investigations/260423_contribution_relay_400_validation.md
   */
  details: z
    .union([
      z.array(RelayValidationIssueSchema),
      z.record(z.string(), z.unknown()),
    ])
    .optional(),
});
export type RelayErrorBody = z.infer<typeof RelayErrorBodySchema>;

// ─── POST /submit response ──────────────────────────────────────────

/**
 * Payload inside the wrapped submit-success envelope. Mirrors the backend's
 * `data` object verbatim (`server/schemas/contribution-relay-v1.ts`).
 *
 * `branchName` is intentionally NOT on the wire — the backend comment calls
 * it "an internal implementation detail". Derive `contrib/<relayContributionId>`
 * client-side if ever needed.
 */
export const RelaySubmitSuccessDataSchema = z.object({
  relayContributionId: z.string().min(1),
  prUrl: z.string().url(),
  prNumber: z.number().int().positive(),
  /**
   * Client-synthesised flag: set by the relay service when a 409 DUPLICATE
   * response is coerced into an idempotent success. Backend never sets this;
   * it passes through `safeParse` because Zod strips unknown keys on strict
   * envelopes but we declare it explicitly so callers can branch on it.
   */
  duplicate: z.boolean().optional(),
});
export type RelaySubmitSuccessData = z.infer<typeof RelaySubmitSuccessDataSchema>;

export const RelaySubmitSuccessSchema = z.object({
  success: z.literal(true),
  data: RelaySubmitSuccessDataSchema,
  /**
   * Backend request id for correlation with server logs. Always populated on
   * live backend responses; optional here so the schema remains tolerant of
   * older fixtures.
   */
  requestId: z.string().optional(),
});

export const RelaySubmitErrorSchema = z.object({
  success: z.literal(false),
  error: RelayErrorBodySchema,
  requestId: z.string().optional(),
});

export const RelaySubmitResponseSchema = z.discriminatedUnion('success', [
  RelaySubmitSuccessSchema,
  RelaySubmitErrorSchema,
]);
export type RelaySubmitResponse = z.infer<typeof RelaySubmitResponseSchema>;

// ─── GET /:id/status response ───────────────────────────────────────

/**
 * Matches the PR status shape consumed by contribution status refresh.
 * Both paths feed the same `contributionStateMapping` layer, so the shape
 * must match exactly.
 *
 * Backend also returns a `mergeable: boolean | null` field; we don't
 * consume it today so we leave it undeclared (Zod's default behaviour
 * is to strip unknown keys on plain `z.object`).
 */
export const RelayPRStatusSchema = z.object({
  prState: z.enum(['open', 'closed']),
  merged: z.boolean(),
  htmlUrl: z.string().url(),
  reviews: z.array(
    z.object({
      state: z.string(),
      user: z.string(),
      body: z.string(),
    }),
  ),
  checkRuns: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
});
export type RelayPRStatus = z.infer<typeof RelayPRStatusSchema>;

export const RelayStatusSuccessSchema = z.object({
  success: z.literal(true),
  data: RelayPRStatusSchema,
  requestId: z.string().optional(),
});

export const RelayStatusErrorSchema = z.object({
  success: z.literal(false),
  error: RelayErrorBodySchema,
  requestId: z.string().optional(),
});

export const RelayStatusResponseSchema = z.discriminatedUnion('success', [
  RelayStatusSuccessSchema,
  RelayStatusErrorSchema,
]);
export type RelayStatusResponse = z.infer<typeof RelayStatusResponseSchema>;
