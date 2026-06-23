---
description: "Authoritative app-consumed Super-MCP seam table: meta-tools, REST routes, spawn contract, envelope contract, lifecycle, and cross-surface consumers."
last_updated: "2026-06-04"
---

# MCP App Super-MCP Seam

This is the human-readable inventory for every Super-MCP surface the Rebel app consumes. The machine-checkable counterpart is `src/core/rebelCore/superMcpContract.ts`; future conformance tests and startup capability checks should import that file rather than duplicating strings.

Keep this doc sparse and source-linked. The code remains the source of truth for implementation; this table names the seam, owner, consumers, and the regression history each row protects.

## Meta-Tools

| Surface | Producer | App consumer(s) | Postmortem / regression class |
| --- | --- | --- | --- |
| `list_tool_packages`, `list_tools`, `get_tool_details`, `use_tool`, `get_help`, `health_check_all`, `health_check`, `authenticate`, `restart_package`, `search_tools` | `super-mcp/src/server.ts:342-628` advertises tools; `super-mcp/src/server.ts:632-665` dispatches them | `src/main/services/mcpService.ts:692-700`, `:746-751`, `:949-960`, `:1003-1008`, `:1206-1217`, `:1484-1490`; Rebel Core tool calls route through `src/core/rebelCore/mcpClient.ts:899-1023` | Meta-tool drift, auth drift, and 260509 parallel `use_tool` result-drop class |
| Read-only retry subset: `list_tool_packages`, `list_tools`, `get_tool_details`, `search_tools`, `get_help`, `health_check`, `health_check_all` | Same meta-tool producer above | `src/core/rebelCore/mcpClient.ts:127-143`, `:963-1023` gates reconnect retry behavior | 260509 parallel `use_tool` result-drop; prevents retrying non-idempotent `use_tool`, `authenticate`, `restart_package` |
| `bulk_export` (loops a read-only downstream tool's pagination, streams NDJSON to `.rebel/exports/`, returns only a summary) | Advertised at `super-mcp/src/server.ts` (the meta-tool list, `name: "bulk_export"`); dispatched to `handleBulkExport` in `super-mcp/src/server.ts` `case "bulk_export"` | Contract constant `SUPER_MCP_META_TOOLS.BULK_EXPORT` in `src/core/rebelCore/superMcpContract.ts`; deliberately NOT in `SUPER_MCP_READ_ONLY_META_TOOLS`, so the reconnect gate in `src/core/rebelCore/mcpClient.ts:127-143`, `:963-1023` treats it as non-retryable (writes files + long-loops → a blind retry could double-write) | Submodule-pin-orphan regression class — `docs/postmortems/260603_supermcp_bulk_export_submodule_pin_orphan_postmortem.md` (this tool was silently lost when its super-mcp pin was dropped on a routine pointer re-align; re-landed and re-registered in v0.4.46) |

## REST Routes

| Surface | Producer | App consumer(s) | Postmortem / regression class |
| --- | --- | --- | --- |
| `GET /api/tools` | `super-mcp/src/server.ts:170-247` | Full-refresh tool index: `src/core/services/toolIndex/toolIndexService.ts:463-490`; cloud warmup: `cloud-service/src/services/cloudBootstrapWarmup.ts:437-443`; eval readiness: `evals/knowledge-work-bootstrap.ts:2158-2168`; eval search fallback: `evals/knowledge-work-bootstrap.ts:2881-2895`; headless readiness probe: `src/core/services/headlessRuntime.ts:395-402` | Tool-discovery drift, cloud/eval bootstrap skew |
| `GET /api/tools?packages=...` | `super-mcp/src/server.ts:170-180`; response at `super-mcp/src/server.ts:237-247` | Selective package refresh: `src/core/services/toolIndex/toolIndexService.ts:557-570`, `:1175-1194` | Tool-index cache-tier drift and stale package refresh |
| `GET /api/tools/config-hash` | `super-mcp/src/server.ts:100-118` | Cheap startup/config freshness check: `src/core/services/toolIndex/toolIndexService.ts:497-520`, `:1175-1194` | Version skew and slow full-refresh fallback |
| `GET /api/tools/manifest` | `super-mcp/src/server.ts:125-160` | Manifest fallback and package hash comparison: `src/core/services/toolIndex/toolIndexService.ts:527-550`, `:1175-1194` | Tool-index manifest/hash drift |
| `GET /api/skipped-servers` | `super-mcp/src/server.ts:256-257` | Startup skipped-server fetch: `src/core/services/superMcpHttpManager.ts:2764-2817` | Startup resilience/version-skew diagnostics from 260328-style failures |
| `GET /stats` | `super-mcp/src/server.ts:266-284` | Perf diagnostics fetch/cache/status matrix: `src/core/services/superMcpHttpManager.ts:2575-2712`; perf diagnostic reads lifecycle/cache via `src/main/services/perfDiagnosticService.ts:2174-2177` | 260423 secondary-process observability and restart attribution drift |

## Spawn Contract

| Surface | Producer | App consumer(s) | Postmortem / regression class |
| --- | --- | --- | --- |
| Launch source: env override, bundled CLI, npx fallback | `src/core/services/superMcpHttpManager.ts:128-178` | `src/core/services/superMcpHttpManager.ts:1715-1759` builds the final spawn command | Startup resilience and stale-binary/version-skew failures |
| Spawn argv: `--transport http --port <port> --config <path>` plus owner tags | `src/core/services/superMcpHttpManager.ts:1715-1759`; owner-tag flags from `src/core/services/superMcpOwnerTag.ts:1-30` | Orphan cleanup/owner registry in `src/core/services/superMcpHttpManager.ts:1702-1748`, `:1850-1858`, `:1916-1926` | 260429 orphan-collateral prevention |
| Spawn options: cwd, stdio log fd, detached/unref, test/headless attached mode | `src/core/services/superMcpHttpManager.ts:1773-1839`, `:1841-1848` | Process lifecycle and cleanup in `src/core/services/superMcpHttpManager.ts:2221-2299`; headless cleanup at `src/core/services/headlessRuntime.ts:444-448` | 251221 concurrent-start/orphan cleanup and E2E/headless orphan prevention |
| Spawn env: sanitized inherited env, branding env, `NODE_PATH`, explicit `REBEL_WORKSPACE_PATH`, E2E `SUPER_MCP_DATA_DIR`/`HOME`/`USERPROFILE` | Sanitizer at `src/core/services/superMcpHttpManager.ts:700-729`; child env at `src/core/services/superMcpHttpManager.ts:1808-1830` | Materialization/workspace propagation in Super-MCP `super-mcp/src/handlers/useTool.ts:1124-1133`; stdio client inheritance comments in `super-mcp/src/clients/stdioClient.ts:153-167` | Workspace env propagation bugs and materialization path safety |
| Dual bridge-state env: `MCP_HOST_BRIDGE_STATE` and legacy `MINDSTONE_REBEL_BRIDGE_STATE` | `src/main/services/bundledMcpManager.ts:214-250` | Bundled MCP payloads at `src/main/services/bundledMcpManager.ts:295-305`, `:317-326`; cloud/path rewrite mirror at `src/main/services/bundledMcpManager.ts:4308-4316` | 260506 bridge-env rename / package unavailable failures |

## Runtime And Configure Shapes

| Surface | Producer | App consumer(s) | Postmortem / regression class |
| --- | --- | --- | --- |
| Runtime HTTP config `{ type: 'http'; url: string } \| null` | `src/core/services/superMcpHttpManager.ts:2742-2754` | Router resolution/start path in `src/main/services/mcpService.ts:1880-1905`; turn routing receives `superMcpUrl` through `src/core/rebelCore/rebelCoreQuery.ts:768-796` | Prevents `{ port, token }` shape confusion and direct-MCP fallback drift |
| Manager configure shape: current public config includes `enabled`, `port`, `configPath`, `startupTimeoutMs`, `healthCheckIntervalMs`; Stage 1 contract also names the internal core subset `port`, `configPath`, `startupTimeoutMs` | Interface at `src/core/services/superMcpHttpManager.ts:369-375`; configure method at `src/core/services/superMcpHttpManager.ts:1264-1281`; internal call at `src/core/services/superMcpHttpManager.ts:1577-1585` | `startWithRetries` and `reconfigure` in `src/core/services/superMcpHttpManager.ts:1459-1510`, `:2826-2865`; cloud routes schedule restarts after config/auth changes at `cloud-service/src/routes/auth.ts:70-78`, `cloud-service/src/routes/mcp.ts:113-122` | 260328 startup resilience and 260427 restart-race class |

## `use_tool` Envelope

| Surface | Producer | App consumer(s) | Postmortem / regression class |
| --- | --- | --- | --- |
| Outer `use_tool` block: `content`, optional `structuredContent`, optional `isError`, `_meta.ui`, `_meta.superMcp`, `_meta.materialization` | Type/egress helper at `super-mcp/src/handlers/useTool.ts:160-319`; main success/materialization/safety-net paths at `super-mcp/src/handlers/useTool.ts:1120-1176`, `:1227-1373`; canonical doc `docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md:31-120` | `src/core/rebelCore/mcpClient.ts:380-527` filters `_meta` to `ui`, `superMcp`, `materialization`, preserves `structuredContent`, and treats missing `isError` as false | 260417 materialization non-text bypass, 260427 `isError` propagation, 260507 structuredContent/email prefill |
| `_meta.superMcp` telemetry: `packageId`, `toolId`, `durationMs`, optional `outputChars`, `truncated`, `resultId`, `dryRun`, `continuation`, `staged`, `normalisations`, `packageResolution`, `toolResolution` | `super-mcp/src/handlers/useTool.ts:182-198`, `:257-273`, `:750-803`, `:1068-1098`, `:1342-1373` | Structural consumers get this via `src/core/rebelCore/mcpClient.ts:521-527`; annotation retry cache still reads JSON-in-text via `src/core/rebelCore/mcpClient.ts:819-829` | Tool resolution/normalisation drift and retry attribution gaps |
| JSON-in-text compatibility parser | `src/core/rebelCore/superMcpEnvelope.ts:1-24`; model-facing envelope type `super-mcp/src/types.ts:192-214`; continuation variant `super-mcp/src/handlers/useTool.ts:86-118`; dry-run variant `super-mcp/src/handlers/useTool.ts:1068-1086`; staged bypass input `super-mcp/src/handlers/useTool.ts:750-771` | `src/main/services/mcpService.ts:1226-1240`; `src/main/services/documentPrefetchAdapter.ts:67-80`; `src/main/services/driveSkillHistoryService.ts:951-954`; `src/main/ipc/inboxHandlers.ts:128-136`; `src/main/ipc/bugReportHandlers.ts:191-205`; `src/main/services/agentMessageHandler.ts:1184-1206`; `src/core/rebelCore/mcpClient.ts:819-829` | Backward compatibility for stored/pre-contract envelopes and 260507 MCP App UI fallback path |

## Session Lifecycle

| Surface | Producer | App consumer(s) | Postmortem / regression class |
| --- | --- | --- | --- |
| Streamable HTTP session connect and fatal severance handling | `src/core/rebelCore/mcpClient.ts:181-254` | Agent runtime sessions in `src/core/rebelCore/rebelCoreQuery.ts:768-796`; turn pipeline passes `superMcpUrl` through routing context | 260509 parallel `use_tool` result-drop and mid-turn severance handling |
| Single-flight reconnect and retry policy | `src/core/rebelCore/mcpClient.ts:642-650`, `:690-750`, `:963-1023` | All MCP tool execution through `src/core/rebelCore/mcpClient.ts:899-1023` | Session-not-found recovery without retrying unsafe tools |
| Close order: `terminateSession()` before `client.close()` | `src/core/rebelCore/mcpClient.ts:1040-1058` | Per-turn cleanup from Rebel Core session lifecycle | Session leakage and stale HTTP session cleanup |

## Restart Reasons And Diagnostics

| Surface | Producer | App consumer(s) | Postmortem / regression class |
| --- | --- | --- | --- |
| `SuperMcpRestartReason`: `debounced-workspace-change`, `idle-restart`, `reconfigure`, `post-resume`, `circuit-breaker-reset` | Enum/doc at `src/core/services/superMcpHttpManager.ts:863-896`; assignment sites at `:1493-1498`, `:2386-2390`, `:2423-2428`, `:2450-2454`, `:2505-2509`, `:2847-2851`, `:2916-2924` | Exposed in `SuperMcpSubprocessInfo.lastRestartReason` at `src/core/services/superMcpHttpManager.ts:911-942`, returned at `:2529-2554`; perf diagnostics consume via `src/main/services/perfDiagnosticService.ts:2174-2177` | 260427 restart race and restart attribution drift |
| Diagnostic transition reasons: restart reasons plus `spawn-error`, `health-check-timeout`, `process-exit`, `circuit-breaker-active` | `src/core/services/diagnostics/manifest.ts:685-700`; manager emits via `src/core/services/superMcpHttpManager.ts:1132-1148`, `:1490`, `:1628`, `:2001-2014`, `:2295` | Diagnostic events ledger subscribers and support bundles | Startup/restart diagnostic ambiguity |

## Cross-Surface Consumers

| Surface | Producer | App consumer(s) | Postmortem / regression class |
| --- | --- | --- | --- |
| Dynamic Super-MCP manager imports in headless runtime | `src/core/services/headlessRuntime.ts:200-218`, `:254-260` | Startup and cleanup at `src/core/services/headlessRuntime.ts:381-402`, `:444-448` | Cross-surface drift that static import scans miss |
| Cloud bootstrap and warmup | `cloud-service/src/bootstrap.ts:499-505`, `:695-719`; `/api/tools` warmup at `cloud-service/src/services/cloudBootstrapWarmup.ts:437-443` | Cloud first-request/idle warmup and search-tool readiness | Cloud bootstrap/tool-index drift |
| Cloud auth/config restart scheduling and health | `cloud-service/src/routes/auth.ts:70-78`, `:105-107`; `cloud-service/src/routes/mcp.ts:113-122`; `cloud-service/src/health/checks.ts:468-475` | Cloud connector auth/config routes and health endpoint | Restart scheduling drift outside desktop |
| Eval bootstrap and search fallback | `evals/knowledge-work-bootstrap.ts:2158-2168`, `:2881-2895`, `:2960-2962` | Knowledge-work eval readiness, direct `/api/tools` fallback, connected-package cache invalidation | Eval false negatives/false positives when desktop-only tests pass |
| System health compatibility re-exports | `src/main/services/systemHealthService.ts:16-21`, `:221-230`, `:861-864` | Existing imports of `getDefaultSuperMcpPort`, `startSuperMcpWithRetries`, `SuperMcpStartResult` through system health | Compatibility-shim drift during future decomposition |
| Downstream MCP App UI / DTO path (envelope `_meta` + structuredContent flow onward) | `src/core/rebelCore/mcpClient.ts:380-527` (the filter) | `src/core/rebelCore/agentLoop.ts:890-903` → `src/core/rebelCore/agentMessageAdapter.ts:103-113` → `src/shared/contracts/agentEventManifest.ts:741-745`; cloud merge `src/core/services/cloudSessionMergeService.ts:1051-1058`; mobile render `mobile/src/components/TurnToolActivity.tsx` | Mobile/cloud-client DTO break from envelope/UI serialization change even when desktop module tests pass (Stage-1 review F3) |
| Eval direct `JSON.parse` of `use_tool` text (NOT via `parseUseToolEnvelopeJson`) | `super-mcp/src/handlers/useTool.ts` text envelope | `evals/knowledge-work-event-adapter.ts:495-525` | Eval-only compatibility surface for suffixed/truncated envelopes; breaks eval fidelity if envelope text shape changes (Stage-1 review F4) |

## See Also

- [SUPER_MCP_PASSTHROUGH_CONTRACT](SUPER_MCP_PASSTHROUGH_CONTRACT.md) - normative `use_tool` passthrough rules.
- [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md) - lifecycle and troubleshooting overview.
- `src/core/rebelCore/superMcpContract.ts` - typed constants and schemas for this seam.
- `docs/plans/260531_mcp-layer-decomposition/PLAN.md` - staged plan that introduced this seam-hardening work.
