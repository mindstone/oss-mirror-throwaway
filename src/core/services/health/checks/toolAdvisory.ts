/**
 * Tool Advisory Health Check
 *
 * ALWAYS returns `status: 'pass'`. Reads the last 10 minutes of
 * `tool_advisory` events from the diagnostic events ledger and populates
 * `details.advisoryKindCounts` for diagnostic-bundle observability.
 *
 * RATIONALE: Tool advisory events are INFORMATIONAL — they capture transient
 * tool-budget / consecutive-failure / advisory-evaluation outcomes that are
 * already handled by the agent loop. Surfacing them in the glow would train
 * users to ignore the indicator (Chief Designer call). They surface only via
 * Recent Activity (which renders directly from the ledger, not from this check).
 *
 * The check exists so a Sentry diagnostic-bundle export carries the kind/count
 * snapshot alongside other health-check details.
 */

import { createScopedLogger } from '@core/logger';
import {
  flushDiagnosticEventsLedger,
  getDiagnosticEventsLedgerReader,
} from '@core/services/diagnosticEventsLedger';
import {
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_EVENTS_BYTES,
} from '@core/services/diagnostics/manifest';
import type { CheckResult } from '../types';
import { defineSafeCheckDetails, safeKeyedCounts } from '../safeCheckDetails';

const log = createScopedLogger({ service: 'toolAdvisoryHealth' });

const WINDOW_MS = 10 * 60_000; // 10 min

export async function checkToolAdvisoryHealth(): Promise<CheckResult> {
  let advisoryKindCounts: Record<string, number> = {};

  try {
    await flushDiagnosticEventsLedger();
    const reader = getDiagnosticEventsLedgerReader();
    if (reader) {
      const nowMs = Date.now();
      const sinceMs = nowMs - WINDOW_MS;
      const events = await reader.readRecent({
        limit: MAX_DIAGNOSTIC_EVENTS,
        maxBytes: MAX_DIAGNOSTIC_EVENTS_BYTES,
      });

      for (const event of events) {
        if (event.kind === 'tool_advisory' && event.ts >= sinceMs && event.ts <= nowMs) {
          const advisoryKind = event.data.advisory ?? 'unknown';
          advisoryKindCounts[advisoryKind] = (advisoryKindCounts[advisoryKind] ?? 0) + 1;
        }
      }
    }
  } catch (error) {
    log.info({ err: error }, 'tool advisory ledger read failed; returning empty advisoryKindCounts');
    advisoryKindCounts = {};
  }

  const totalAdvisories = Object.values(advisoryKindCounts).reduce((a, b) => a + b, 0);

  return {
    id: 'toolAdvisoryHealth',
    name: 'Tool Advisories',
    status: 'pass',
    message: totalAdvisories > 0
      ? `${totalAdvisories} tool advisories in last 10min`
      : 'No tool advisories',
    details: defineSafeCheckDetails('toolAdvisoryHealth', {
      advisoryKindCounts: safeKeyedCounts(advisoryKindCounts),
    }),
  };
}
