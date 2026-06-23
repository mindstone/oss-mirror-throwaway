---
description: "Signposts for cloud continuity observability across desktop, cloud-service, and mobile"
last_updated: "2026-05-10"
---

# Cloud Continuity Observability

Quick signpost doc for where continuity diagnostics and observability signals live across surfaces.


## See Also

- [DIAGNOSTICS.md](./DIAGNOSTICS.md) - Diagnostic bundle formats and export entry points.
- [LOGGING.md](./LOGGING.md) - Structured logging architecture and log sinks.
- [ERROR_MONITORING_AND_SENTRY.md](./ERROR_MONITORING_AND_SENTRY.md) - Sentry integration and breadcrumb strategy.
- [CLOUD_ARCHITECTURE.md](./CLOUD_ARCHITECTURE.md) - Cloud-service runtime and deployment model.
- [`260509_session_event_delta_sync.md`](../plans/260509_session_event_delta_sync.md) - Delta-sync rollout plan, invariants, and monitoring expectations.


## Continuity Signal Sources

### Mobile continuity breadcrumbs

- `cloud-client/src/observability/continuityEvents.ts` - canonical continuity event contract + allowlisted fields.
- `mobile/src/utils/continuityBreadcrumbs.ts` - Sentry breadcrumb/escalation sink for continuity families.
- `mobile/src/utils/mobileDiagnostics.ts` - queue + continuity snapshots included in bug-report diagnostics payload.

### Desktop continuity diagnostics

- `src/main/services/cloud/cloudOutbox.ts` - desktop outbox state and retry metadata.
- `src/main/services/cloud/cloudWorkspaceSync.ts` - workspace sync state (`_getLastSyncAt`, `_getLastPushedManifest`).
- `src/main/services/cloud/cloudContinuityMetadata.ts` - continuity state map + tombstone sync timestamps.
- `src/main/services/logExportService.ts` - structured ZIP export, now with `continuity/*.json`.
- `src/main/services/bugReportDiagnosticService.ts` - deterministic bug diagnostics payload continuity section.

### Cloud-service continuity diagnostics

- `src/core/services/continuity/outboxStallMonitor.ts` - per-device outbox stall snapshots (cross-surface; consumed by cloud and desktop).
- `cloud-service/src/routes/continuity.ts` - catch-up endpoints + per-device catch-up history.
- `cloud-service/src/routes/diagnostics.ts` - `/api/diagnostics/self` payload builder + size/rate limiting.
- `cloud-service/src/routes/feedback.ts` + `cloud-service/src/sentryFeedback.ts` - `serverContext` intake + Sentry attachment.


## Diagnostic Surfaces

### Desktop ZIP export

`generateDiagnosticZipBundle()` now includes:

- `continuity/outbox-state.json`
- `continuity/workspace-sync-history.json`
- `continuity/state-machine-transitions.json`
- `continuity/payload-histogram.json` — 24h desktop cloud payload histogram (`payloadBytesP50`, `payloadBytesP95`, `payloadBytesMax`, `windowStart`, `windowEnd`, `sampleCount`) for verifying delta-sync payload size reduction.

Test coverage: `src/main/services/__tests__/logExportService.continuity.test.ts` and `src/main/services/__tests__/logExportService.payloadHistogram.test.ts`.

### Mobile structured diagnostics + share payload

- `mobile/src/utils/diagnosticBundle.ts` builds the structured payload and ZIP.
- `mobile/src/utils/diagnosticExport.ts` exposes ZIP-first share payload with markdown fallback.
- `mobile/app/(tabs)/help.tsx` uses this for “Share diagnostics”.

Test coverage: `mobile/src/__tests__/diagnosticBundle.test.ts`.

### Cloud self diagnostics endpoint

- `GET /api/diagnostics/self` (authenticated, per-device 1/min, ~100KB cap)
- client helper: `cloud-client/src/cloudClient.ts#getSelfDiagnostics()`
- mobile bug-report UI toggle: `help.tsx` “Include server context”

Test coverage: `cloud-service/src/__tests__/diagnosticsRoute.test.ts`.


## Delta-Sync Breadcrumbs

`session-delta-push` is the continuity family for the desktop delta-push hot path.

Subtypes:

- `applied`
- `needs-reconcile`
- `needs-bootstrap`
- `capability-missing-fallback`
- `drift-detected`
- `bootstrap-fallback`
- `metadata-patch-applied`

Allowed breadcrumb fields are deliberately small and PII-safe: `sessionIdHash`, `appliedCount`, `serverSeq`, `cloudUpdatedAt`, `baseSeq`, `payloadBytes`, and `gzipBytes`.

Mobile escalation policy:

- `needs-reconcile` → warning, throttled with cooldown key `delta-push-needs-reconcile` (1/hour/device).
- `drift-detected` → warning, throttled with cooldown key `delta-push-drift-detected` (1/hour/device).
- Other delta-push subtypes are breadcrumb-only.

Cloud-service additionally logs `delta_push_response_size` for `POST /api/sessions/:id/events` responses with the sanitized route `/api/sessions/:id/events`.


## Deep-Link Assisted Bug Reports

- Parser/formatter support: `src/shared/navigation/urlParser.ts`
- Shared target shape: `src/shared/navigation/types.ts`
- Core action mapping: `src/core/navigation/resolveLink.ts`
- Desktop dialog prefill plumbing: `src/renderer/App.tsx`, `src/renderer/components/BugReportDialog/BugReportDialog.tsx`
- Mobile deep-link routing: `mobile/app/+native-intent.ts`, `mobile/app/conversation/[id].tsx`, `mobile/app/(tabs)/help.tsx`

Query flag: `attachContinuityDiagnostics=1`.
