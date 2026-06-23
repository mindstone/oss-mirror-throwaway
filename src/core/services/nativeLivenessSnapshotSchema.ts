/**
 * Shared Zod contract for the native-resource liveness snapshot captured at the
 * macOS quit-deadlock boundary (Stage 1 of
 * docs/plans/260622_pin-quit-deadlock-blocker/PLAN.md). Counts/bools only — no
 * user content. Each field is fail-open: `null` means "the accessor threw",
 * distinct from a real zero. The runtime producer is
 * `src/main/services/nativeLivenessSnapshot.ts` (`NativeLivenessSnapshot`).
 *
 * Lives in its own dependency-free module (pure Zod, no other imports) so BOTH
 * the diagnostic-events ledger (`diagnosticEventsLedger.ts`) and the Sentry
 * known-conditions registry (`@core/sentry/knownConditions`) can share the
 * SAME strict schema WITHOUT creating an import cycle — the ledger imports
 * `KNOWN_CONDITIONS` from knownConditions, so knownConditions importing the
 * schema directly from the ledger would cycle.
 */

import { z } from 'zod';

export const nativeLivenessSnapshotSchema = z
  .object({
    fseventsLiveInstances: z.number().nullable(),
    moonshineSessions: z.number().nullable(),
    superMcpPid: z.number().nullable(),
    superMcpRunning: z.boolean().nullable(),
    lancedbConnections: z
      .object({
        conversation: z.number().nullable(),
        file: z.number().nullable(),
        tool: z.number().nullable(),
      })
      .strict(),
    embedding: z
      .object({
        workerAlive: z.boolean().nullable(),
        gpuBackendAlive: z.boolean().nullable(),
        disposed: z.boolean().nullable(),
      })
      .strict(),
  })
  .strict();
