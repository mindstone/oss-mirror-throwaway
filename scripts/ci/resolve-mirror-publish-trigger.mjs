// Resolves whether an OSS mirror publish should run, and the effective `mode` +
// `destination`, from the triggering GitHub event. Single source of truth for the
// gate that `.github/workflows/mirror-publish.yml` consumes via `$GITHUB_OUTPUT`.
//
// SAFETY-CRITICAL (#1 correctness property): a non-sanctioned trigger — above all
// an UNMARKED `dev` push — MUST resolve to `shouldRun: false`. This gate fails
// CLOSED: it never defaults to publishing. A marked push targets the *production*
// mirror, so the marker check is an exact, case-sensitive bracketed token. See
// docs/project/OSS_MIRROR_RUNBOOK.md ("Workflow Trigger Map") and
// docs/plans/260610_oss-mirror-process/OSS_MIRROR_LONG_TERM_PLAN.md §2.6.
//
// Pure Node, zero dependencies — runs in CI via plain `node` (no `npm ci`).
// Tested by scripts/__tests__/resolve-mirror-publish-trigger.test.ts.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Opt-in publish marker — the EXACT, case-sensitive binding gate. Same shape as
// release.yml's `[deploy-cli]` / `[deploy-beta]`, but intentionally STRICTER than the
// workflow's `contains()` prefilter (Actions `contains()` is case-insensitive): a
// production publish must be a deliberate literal `[publish-oss]`, and a wrong-case
// near-miss safely no-ops (fail-closed) rather than publishing.
export const PUBLISH_OSS_MARKER = '[publish-oss]';

const VALID_MODES = new Set(['dry-run', 'publish']);
const VALID_DESTINATIONS = new Set(['production', 'throwaway']);

/**
 * @param {{ eventName?: string, headCommitMessage?: string, dispatchMode?: string, dispatchDestination?: string }} input
 * @returns {{ shouldRun: boolean, mode: string, destination: string, reason?: string, error?: string }}
 *   `error` set ⇒ a genuinely invalid/unexpected trigger: fail closed AND loud (job should exit non-zero).
 *   `reason` set (no `error`) ⇒ a benign outcome (run, or a clean unmarked-push skip).
 */
export function resolveMirrorPublishTrigger(input = {}) {
  const { eventName, headCommitMessage, dispatchMode, dispatchDestination } = input;

  if (eventName === 'workflow_dispatch') {
    // Manual control path: honour the operator's inputs, but validate them so an
    // impossible combination fails loudly rather than silently mis-targeting.
    const mode = String(dispatchMode ?? '').trim();
    const destination = String(dispatchDestination ?? '').trim();
    if (!VALID_MODES.has(mode)) {
      return failClosed(`workflow_dispatch mode must be one of [${[...VALID_MODES].join(', ')}]; got "${mode}"`);
    }
    if (!VALID_DESTINATIONS.has(destination)) {
      return failClosed(`workflow_dispatch destination must be one of [${[...VALID_DESTINATIONS].join(', ')}]; got "${destination}"`);
    }
    if (mode === 'dry-run' && destination !== 'throwaway') {
      return failClosed('dry-run mode must target the throwaway destination');
    }
    return { shouldRun: true, mode, destination, reason: `workflow_dispatch (${mode} -> ${destination})` };
  }

  if (eventName === 'push') {
    // Opt-in automatic path: a `dev` push publishes to the production mirror ONLY
    // when the head commit is deliberately marked. Everything else is a clean
    // no-op (skip, not a failed run). `String(... ?? '')` keeps `contains` null-safe
    // for events without a head commit (e.g. branch deletion).
    const message = String(headCommitMessage ?? '');
    if (message.includes(PUBLISH_OSS_MARKER)) {
      return { shouldRun: true, mode: 'publish', destination: 'production', reason: `marked push - found ${PUBLISH_OSS_MARKER}` };
    }
    return { shouldRun: false, mode: '', destination: '', reason: `unmarked push - no ${PUBLISH_OSS_MARKER} marker; skipping (clean no-op)` };
  }

  // Any other trigger is unexpected (the workflow declares only workflow_dispatch
  // and push): fail closed.
  return failClosed(`unsupported event "${String(eventName ?? '')}"`);
}

function failClosed(error) {
  return { shouldRun: false, mode: '', destination: '', error };
}

function main() {
  const result = resolveMirrorPublishTrigger({
    eventName: process.env.GITHUB_EVENT_NAME,
    headCommitMessage: process.env.HEAD_COMMIT_MESSAGE,
    dispatchMode: process.env.DISPATCH_MODE,
    dispatchDestination: process.env.DISPATCH_DESTINATION,
  });

  // Emit outputs even on the error path (should_run=false) so any consumer that
  // somehow reads them sees the fail-closed value.
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(
      outputPath,
      `should_run=${result.shouldRun}\nmode=${result.mode}\ndestination=${result.destination}\n`,
    );
  }

  if (result.error) {
    console.error(`::error::mirror-publish trigger rejected - ${result.error}`);
    process.exit(1);
  }
  console.log(
    result.shouldRun
      ? `::notice::mirror publish WILL run - ${result.reason}`
      : `::notice::mirror publish skipped - ${result.reason}`,
  );
}

// Execute only when invoked directly (`node resolve-mirror-publish-trigger.mjs`),
// never when imported by the test suite.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main();
}
