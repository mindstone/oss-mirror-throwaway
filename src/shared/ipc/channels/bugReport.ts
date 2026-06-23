import { z } from 'zod';
import { DiagnosticSectionsSchema } from '@shared/diagnostics/diagnosticBundleSections';
import { defineInvokeChannel } from '../schemas';

const BugReportUrgencySchema = z.enum(['low', 'medium', 'high', 'critical']);

// FOLD-IN-4 (Phase 7, GPT F5): enforce per-field byte caps at the IPC contract —
// the trust boundary — not just in the renderer dialog. The outbox only has
// aggregate retention caps, so an unbounded `description`/`screenshotBase64` could
// otherwise reach disk. Bounds match the renderer's existing limits:
//   - description ≤ 5000 chars (BugReportDialog `MAX_DESCRIPTION_LENGTH`)
//   - screenshot ≤ ~5MB of base64 (a 5MB image encodes to ~6.7MB base64; we cap
//     the base64 string at 7MB so a legitimate 5MB screenshot is not rejected).
const MAX_DESCRIPTION_CHARS = 5000;
const MAX_FREEFORM_CHARS = 5000;
const MAX_SCREENSHOT_BASE64_BYTES = 7_000_000;

const SubmitBugRequestSchema = z.object({
  description: z.string().min(1).max(MAX_DESCRIPTION_CHARS),
  stepsToReproduce: z.string().max(MAX_FREEFORM_CHARS).optional(),
  expectedBehavior: z.string().max(MAX_FREEFORM_CHARS).optional(),
  urgency: BugReportUrgencySchema,
  screenshotBase64: z.string().max(MAX_SCREENSHOT_BASE64_BYTES).optional(),
  screenshotMimeType: z.string().max(100).optional(),
  includeEnrichedDiagnostics: z.boolean().optional(),
  attachContinuityDiagnostics: z.boolean().optional(),
  diagnosticSections: DiagnosticSectionsSchema.optional(),
  conversationId: z.string().optional(),
});

const SubmitBugResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('submitted'),
    sentryEventId: z.string(),
  }),
  z.object({
    outcome: z.literal('accepted'),
  }),
  z.object({
    outcome: z.literal('failed'),
    error: z.string(),
  }),
]);

const SubmitFeedbackRequestSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  feedbackType: z.enum(['improvement']),
});

const SubmitFeedbackResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('submitted'),
    discourseTopicUrl: z.string(),
  }),
  z.object({
    outcome: z.literal('fallback'),
    fallbackUrl: z.string(),
  }),
  z.object({
    outcome: z.literal('failed'),
    error: z.string(),
  }),
]);

export const bugReportChannels = {
  'bug-report:submit-bug': defineInvokeChannel({
    channel: 'bug-report:submit-bug',
    request: SubmitBugRequestSchema,
    response: SubmitBugResponseSchema,
    description: 'Submit a user bug report to Sentry for automatic triage',
  }),

  'bug-report:submit-feedback': defineInvokeChannel({
    channel: 'bug-report:submit-feedback',
    request: SubmitFeedbackRequestSchema,
    response: SubmitFeedbackResponseSchema,
    description: 'Submit user feedback to Rebels Community (Discourse)',
  }),
} as const;
