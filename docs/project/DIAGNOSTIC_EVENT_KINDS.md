---
description: "Canonical registry of diagnostic event kinds — what each kind means, when it's emitted, and where its schema lives"
last_updated: "2026-05-08"
---

# Diagnostic Event Kinds Registry

Canonical registry of every kind in the diagnostic events ledger. Use this when adding new
emit sites, debugging unexpected ledger pressure, or extending the discriminated union.

## See Also

- [DIAGNOSTICS.md](./DIAGNOSTICS.md) — overall diagnostics system, bundle formats, sanitization.
- [CLOUD_CONTINUITY_OBSERVABILITY.md](./CLOUD_CONTINUITY_OBSERVABILITY.md) — continuity breadcrumb family that mirrors into `continuity_transition`.
- `src/core/services/diagnosticEventsLedger.ts` — `DIAGNOSTIC_EVENT_KIND_LITERALS` (the sole source of truth for the closed enum) + Zod schemas for every kind.
- `src/core/services/diagnostics/manifest.ts` — discriminated-union TypeScript types and bucketing constants.
- `src/core/services/diagnostics/diagnosticEventDisplay.ts` — `assertNever`-bounded user-facing display strings.
- `scripts/check-diagnostic-event-kinds.ts` — Wave A reconciliation: asserts the four surfaces above stay in lockstep. Runs as part of `npm run validate:diagnostic-events`.

## Adding a New Kind

A new kind is a cross-cutting addition. Order:

1. Add the literal to `DIAGNOSTIC_EVENT_KIND_LITERALS` in `diagnosticEventsLedger.ts`.
2. Add the Zod schema in the same file (extend the discriminated-union schema).
3. Add the TypeScript variant interface in `manifest.ts` (extend `DiagnosticEventEntry`).
4. Add the display branch in `diagnosticEventDisplay.ts` (the exhaustiveness `assertNever` will fail to compile until you do).
5. Run `npx tsx scripts/check-diagnostic-event-kinds.ts` — must report all surfaces in lockstep.
6. Add an entry to the table below.
7. Wire emit sites; never use raw breadcrumbs (the `diagnostics/no-raw-continuity-breadcrumb` ESLint rule enforces this for the continuity family).

`assertNever` plus the reconciliation script make this a compile-time + script-time hard gate — you cannot land a half-wired kind.

## Registry

| Kind | Family | Severity | Emit Trigger | Closed enums in `data` | Notes |
|---|---|---|---|---|---|
| `cooldown_enter` | quota | warning | Quota cooldown begins for a provider | `provider`, `cause` | Stage 1a baseline. |
| `cooldown_exit` | quota | info | Quota cooldown ends | `provider` | Stage 1a baseline. |
| `tool_advisory` | tools | info | Per-tool failure pattern crosses a threshold (rate, consecutive failures) | `category`, `severity` | Aggregated; per-call detail is in logs. |
| `known_condition` | meta | info \| warning | `captureKnownCondition()` fires a fingerprinted condition (one place; tagged in Sentry) | `level`, `key` | Single chokepoint for fingerprint + Sentry tag. |
| `tool_call_error` | tools | warning | Individual tool invocation failed | `errorCategory` | Capped at 200 per `runAgentLoop` invocation; above that, rely on `tool_advisory`. See `MAX_TOOL_CALL_ERROR_EMITS_PER_TURN`. |
| `mcp_transition` | mcp | info \| warning | MCP server lifecycle transition (registered/gated/failed/unhealthy) | `transition`, `code` | Source: `coreStartup.ts` and per-server health checks. |
| `auth_event` | auth | info \| warning | Auth state change (login, refresh, expiry, logout) | `event`, `provider` | Never logs the token; only the event kind. |
| `streaming_invariant` | runtime | error | A streaming-invariant violation was caught (sequence gap, dup ack, etc.) | `invariant` | These should be near-zero; non-zero counts indicate runtime correctness drift. |
| `abort_event` | runtime | warning | A turn was aborted | `reason`, `durationBucketMs` | Bucketed duration, no raw timing. |
| `watchdog_judge_decision` | runtime | info \| warning | LLM judge extended a turn beyond default cap (or judge call failed and we fail-open extended) | `decision`, `cause` | See `260508_watchdog_llm_judge_extension.md`. |
| `approval_stuck` | approvals | warning | A pending tool/memory approval has aged past a bucket boundary | `approvalKind`, `ageBucketMinutes` | Emitted at most once per `(approvalId, bucket)` transition. |
| `health_check_timing` | health | info \| warning | A health check ran slow (> 500ms) or timed out | `durationBucketMs`, `status`, `timedOut?` | Closed bucket enum: 500/1000/5000/30000ms. Never emits when fast. |
| `provider_reachability_change` | network | info \| warning | HEAD-only reachability probe transitioned status for a provider | `provider`, `status`, `errorCode?` | 30s TTL cache; `no-auto-loop-provider-probe` ESLint rule enforces no auto-poll. |
| `embedding_index_health` | indexes | info \| warning | Embedding/semantic/tool-index transitioned state (ready ↔ unready, fresh ↔ stale) | `component`, `transition`, `ageBucketHours?` | Emit-on-transition only — never emits on poll-while-stable. |
| `worker_stats_pre_turn` | runtime | info | Pre-turn worker stats snapshot at turn start | (free-form numeric — bounded by struct) | One per turn. Tracks spawn/restart/crash counts since app start. **Persistence: in-memory only — restart resets counters.** Tracked under `I-worker-persist`. |
| `auto_update_state_change` | updater | info \| warning | Auto-updater transitioned check/install state | `transition`, `platform`, `errorCategory?` | Emit-on-transition; multi-platform. |
| `settings_drift_observation` | config | info \| warning | Settings differ across surfaces (desktop vs cloud vs mobile) for a watched field | `field`, `surfaceA`, `surfaceB`, `diffKind`, `eventState?` | **Emit-on-transition gating** (60s fingerprint window) — does NOT fire on every settings:get. `eventState='resolved'` indicates drift cleared. |
| `cost_outcome_resolution` | cost | info | Late resolution of a cost-ledger row's `outcome` (when not known at append time) | `outcome.kind` (closed enum) | Joined to ledger by `costEntryId` (UUID v4). Lag bound: `MAX_OUTCOME_RESOLUTION_LAG_MS = 60_000`. Append-only — ledger row never updated in place. |
| `cost_outcome_resolution_lost` | cost | warning | Cost row rotated past `.jsonl.old` before resolution arrived | `lagMs`, `rotationStraddled` | Emitted by `costLedgerService.ts` rotation-aware reader. Renders as `legacy_unknown` in waterfall. |
| `cost_outcome_resolution_unmatched` | cost | warning | Resolution event arrived but no ledger row matches its `costEntryId` | `outcome.kind` | Indicates dropped/corrupted ledger row OR producer/consumer drift. Resolution preserved as orphaned in waterfall. |
| `continuity_transition` | continuity | info \| warning \| error | Cloud-continuity state machine, outbox, merge, or conflict transition (mirror of mobile/cloud-client breadcrumb family) | `family`, `message`, `reason?`, `level?` | Adapter is `toDiagnosticContinuityTransition()` in `src/shared/diagnostics/continuityTransition.ts`. Direct desktop emits + `cloudSessionMergeService` + cloud-service `routes/sessions.ts` sink. ESLint rule `no-raw-continuity-breadcrumb` blocks raw breadcrumbs at known emit sites. |

## Volume & Capacity

- Global cap: `MAX_DIAGNOSTIC_EVENTS = 5_000` events per ledger file. One rotated `.old` companion → ~1.2 MB on disk.
- Per-kind cap: `MAX_EVENTS_PER_KIND` (when implemented — see `I-per-kind-cap-implementation`) prevents one chatty kind from evicting all other signal.
- Continuity is the highest-volume kind and gets a higher per-kind cap (`continuity_transition` = 2_000) when the per-kind ceiling is in place.
- Cap engagement is itself observable via `events_per_kind_cap_engaged` warning event (when implemented).

## Severity Conventions

| Severity | Meaning | Example |
|---|---|---|
| `info` | Normal-operation telemetry — useful in aggregate, not actionable individually | `cooldown_exit`, `mcp_transition` (registered) |
| `warning` | Degraded behavior; does not break the user but should be reviewed if persistent | `tool_advisory`, `provider_reachability_change` (unreachable) |
| `error` | Invariant violation that indicates a bug or runtime correctness drift | `streaming_invariant`, `continuity_transition` with `invariant-violation` |

Severity is encoded into the rendered display string in `diagnosticEventDisplay.ts` — there is no explicit `severity` field on the event itself.

## PII Conventions

- No raw user content, secrets, paths, or full provider error messages in any `data` field.
- Hashes use FNV-1a (short) for identifiers that should be correlatable but not reversible.
- Continuity breadcrumb family enforces this via `CONTINUITY_SAFE_KEYS` allowlist (defence-in-depth on top of the typed union).
- See [DIAGNOSTICS.md § Sanitization](./DIAGNOSTICS.md#diagnostic-bundle-sanitization) for redaction passes applied during bundle export.

## Why Have a Registry?

Three independent surfaces need to stay aligned per kind: the closed enum, the Zod schema, the TypeScript variant, and the display branch. The reconciliation script enforces structural lockstep, but **what each kind means** is human knowledge. This registry makes that knowledge explicit so:

- New emit sites pick the right kind (or recognize they need a new one).
- Reviewers can spot misuse (e.g., emitting `tool_advisory` for an event that should be `streaming_invariant`).
- Bundle readers and downstream tooling can build mental models without spelunking five files.
