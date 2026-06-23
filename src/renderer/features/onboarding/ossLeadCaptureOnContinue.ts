/**
 * Decide + fire the OSS lead-capture egress when the user clicks Continue from
 * the api onboarding step.
 *
 * Extracted as a pure-ish helper (no React) so the FIRE-AND-FORGET invariant is
 * directly unit-testable without mounting the whole wizard. The helper returns
 * synchronously and NEVER awaits the egress: a hung or failing
 * `captureOssLead` cannot block, delay, or fail onboarding.
 *
 * Gating: OSS-only; skipped entirely when no email is present (the endpoint
 * requires email). Only valid values reach the draft (ApiStep validates before
 * writing via updateDraft), and appVersion/platform are sourced in the main
 * handler — not here. See docs/plans/260623_oss-identity-ask-lead-capture/PLAN.md.
 */

import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export interface OssLeadCaptureApi {
  captureOssLead(input: { firstName?: string; email: string }): Promise<void>;
}

export interface OssLeadCaptureDraft {
  userFirstName?: string | null;
  userEmail?: string | null;
}

/**
 * Fire the egress if appropriate. Returns synchronously; the egress promise (if
 * any) is intentionally not awaited or returned.
 */
export function fireOssLeadCaptureOnContinue(args: {
  isOss: boolean;
  draft: OssLeadCaptureDraft | null | undefined;
  api: OssLeadCaptureApi | undefined;
}): void {
  const { isOss, draft, api } = args;
  if (!isOss || !api) {
    return;
  }
  const email = draft?.userEmail?.trim();
  if (!email) {
    // Name-only / empty — the endpoint requires an email, so do not POST.
    return;
  }
  // Fire-and-forget: not awaited. captureOssLead resolves to void and the main
  // handler returns immediately (the fetch is detached there), so this cannot
  // block. Guard the promise defensively so a rejection never surfaces as an
  // unhandled rejection.
  void Promise.resolve(
    api.captureOssLead({
      firstName: draft?.userFirstName?.trim() || undefined,
      email,
    }),
  ).catch((error: unknown) => {
    // Best-effort; the main handler already logs failures observably. Record
    // the renderer-side swallow at low severity so it is never fully silent.
    ignoreBestEffortCleanup(error, {
      operation: 'onboarding.fireOssLeadCaptureOnContinue',
      reason: 'fire-and-forget-lead-egress-failures-logged-in-main',
    });
  });
}
