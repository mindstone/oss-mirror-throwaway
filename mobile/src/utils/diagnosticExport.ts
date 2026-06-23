/**
 * Mobile diagnostic export utilities.
 *
 * Produces structured ZIP bundles when possible and keeps markdown fallback
 * output for share targets that reject file attachments.
 */

import { prepareMobileDiagnosticSharePayload } from './diagnosticBundle';

export interface DiagnosticSharePayload {
  zipUri: string | null;
  zipFilename: string | null;
  markdownFallback: string;
}

/**
 * Generate a human-readable markdown diagnostic report.
 *
 * Never throws — always returns fallback markdown text.
 */
export async function generateDiagnosticReport(): Promise<string> {
  const payload = await prepareMobileDiagnosticSharePayload();
  return payload.markdownFallback;
}

/**
 * Prepare a diagnostics payload for sharing.
 *
 * - `zipUri`/`zipFilename` are present when ZIP generation succeeded.
 * - `markdownFallback` is always present and should be used when file sharing
 *   is unavailable or rejected by the target app.
 */
export async function prepareDiagnosticSharePayload(): Promise<DiagnosticSharePayload> {
  const payload = await prepareMobileDiagnosticSharePayload();
  return {
    zipUri: payload.zipUri,
    zipFilename: payload.zipFilename,
    markdownFallback: payload.markdownFallback,
  };
}
