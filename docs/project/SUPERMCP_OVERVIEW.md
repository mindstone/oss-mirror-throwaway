---
description: "Super-MCP HTTP mode architecture — local router ownership, session isolation, lifecycle, cache refresh, and troubleshooting"
last_updated: 2026-06-18
---

# Super-MCP Overview

## Introduction

Super-MCP is a local MCP router that aggregates multiple MCP servers into a single unified interface. Mindstone Rebel uses Super-MCP in HTTP transport mode by default to enable concurrent-safe tool usage across multiple agent sessions, avoiding race conditions inherent in stdio transport.

**Ownership:** Mindstone owns and maintains the open-source Super-MCP library (included as a Git submodule at `super-mcp/`). We can modify the submodule code directly when Rebel requires changes. While we aim to keep Super-MCP generally usable outside Rebel, Rebel's needs take priority—discuss with the team if a change might reduce external usability.

This document explains how Super-MCP HTTP mode works, its architecture, configuration, and troubleshooting.


## See Also

- [MCP_OVERVIEW](MCP_OVERVIEW.md) - **MCP territory hub**: architecture, connector workflow, OSS release, testing, MCP Apps
- [MCP_IMPROVEMENT_WORKFLOW](MCP_IMPROVEMENT_WORKFLOW.md) - **Start here for MCP development**: workflow, decision tree, implementation patterns
- [mcp-connectors-tools-and-integrations.md](../../rebel-system/help-for-humans/mcp-connectors-tools-and-integrations.md) - User-facing MCP overview and connector setup guide
- [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) - Internal MCP architecture: bundled vs direct, auth patterns, IPC contracts, and when Super-MCP is used vs direct mode
- [SUPER_MCP_LIFECYCLE](SUPER_MCP_LIFECYCLE.md) - Subprocess lifecycle, owner identity, orphan cleanup, and concurrency contracts
- [SUPER_MCP_EDITING](SUPER_MCP_EDITING.md) - How to edit, build, version, and ship a change to the super-mcp submodule
- [SYSTEM_ARCHITECTURE](ARCHITECTURE_OVERVIEW.md) - High-level system architecture and MCP integration
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - Environment variables including `SUPER_MCP_HTTP_PORT` and `MINDSTONE_FORCE_DIRECT_MCP` (plus legacy toggles like `SUPER_MCP_USE_HTTP`)
- [BUILDING](BUILDING.md) - Node/npm/npx bundling for MCP tooling in production
- [LOGGING](LOGGING.md) - Log locations and debugging guidance

### Implementation plan

- [`../plans/finished/251129b_super_mcp_http_mode_implementation.md`](../plans/finished/251129b_super_mcp_http_mode_implementation.md) - Detailed implementation plan with architecture diagrams, testing checklist, migration guide, and troubleshooting reference

### Code references

| File | Key functions | Purpose |
|------|---------------|---------|
| `src/core/services/superMcpHttpManager.ts` | `SuperMcpHttpManager.start()`, `checkHealth()`, `findAvailablePort()` | Lifecycle manager: spawns, health-checks, and stops the HTTP server (canonical source; `src/main/services/superMcpHttpManager.ts` is a re-export shim) |
| `src/main/services/mcpService.ts` | `resolveSuperMcpRouterEntry()` | Decides HTTP vs stdio mode, returns MCP config entry |
| `src/main/index.ts` | `startSuperMcpWithRetries('app-ready')` call site | Configures and starts HTTP server on `app.on('ready')` |
| `src/main/services/agentMessageHandler.ts` | Tool event handling | Detects concurrent MCP tool calls (the `RACE CONDITION DETECTED` warning itself is emitted from `turnPipeline/agentTurnExecute.ts`) |
| `src/main/index.ts` | App shutdown block | Stops HTTP server gracefully on quit |
| `super-mcp/src/server.ts` | `createMcpServer()`, `registerHandlers()`, session map, GC | Per-session Server+Transport factory, request routing, idle session cleanup |
| `src/core/rebelCore/mcpClient.ts` | `createMcpSession()`, `close()` | Rebel Core MCP client with proper `terminateSession()` cleanup |
| `src/core/rebelCore/rebelCoreQuery.ts` | MCP setup block | Emits `warning` event when MCP tools unavailable |
| `src/shared/utils/conversationState.ts` | `updateConversationWithEvent()` | Handles `warning` event with synthetic turnId (receipt pattern) |

### External references

**Super-MCP Router:**
- [Super-MCP on npm](https://www.npmjs.com/package/super-mcp-router) - Official package
- [Super-MCP on GitHub](https://github.com/mindstone/Super-MCP) - Source code and documentation


## Principles and key decisions

- **HTTP mode is always used**: Super-MCP runs over HTTP in Rebel (no stdio transport in the main application) to eliminate stdio race conditions. Direct MCP mode is reserved for debugging via Diagnostics → “Force direct MCP” or the `MINDSTONE_FORCE_DIRECT_MCP` environment variable.
- **Single HTTP server per app instance**: One Super-MCP HTTP server is spawned at app startup and shared across all agent sessions.
- **Per-session Server+Transport isolation**: Each MCP client (agent turn, health check, inbox sync, etc.) gets its own `Server` + `StreamableHTTPServerTransport` pair. Sessions are tracked by `Mcp-Session-Id` header. Idle sessions are reaped after 30 minutes by a GC interval. This prevents concurrent clients from interfering with each other (e.g., a health check killing an active agent turn). See [planning doc](../plans/260326_rebel_core_super_mcp_streamable_http_fix.md) for design rationale.
- **Proper session cleanup**: MCP clients must call `transport.terminateSession()` before `client.close()` to send a DELETE request that cleans up the server-side session immediately. Without this, sessions linger until GC reaps them.
- **MCP warning banner**: When Rebel Core cannot connect to Super-MCP, an inline amber warning banner appears in the conversation UI (non-blocking, the turn continues without tools). This uses the `warning` event type with a synthetic turnId to avoid message lifecycle issues. Duplicate warnings with the same text are suppressed.
- **TCP-based health checks**: The server uses TCP socket connection tests (not HTTP requests) to verify readiness, avoiding protocol mismatches.
- **Process tree kill on shutdown**: The HTTP server is stopped using process-tree kill (`taskkill /t /f` on Windows; process-group SIGKILL on Unix) to ensure all child processes are terminated. No SIGTERM-first approach—immediate forceful termination for reliability.
- **Orphan process cleanup**: PID files (`super-mcp-{port}.pid`) track spawned processes per port. On startup, any orphaned process from a previous crash is detected and killed before spawning a new server.
- **Port release polling**: After stopping Super-MCP, the manager polls until the port is actually released (up to 5s) rather than using fixed delays, handling variable OS cleanup times.
- **Concurrency guards**: `start()` is idempotent—concurrent callers wait for the same in-progress startup rather than racing to spawn multiple processes.
- **Health check coalescing**: Concurrent health checks share a single TCP probe. Recent healthy state (within 30s) short-circuits probes entirely.
- **Startup errors propagate**: `startWithRetries()` returns the real per-attempt failures through `SuperMcpStartResult` -- including a privacy-safe `failureCategory` (`SafeModeErrorCategory` zod SSOT in `shared/ipc/schemas/common.ts`: `process_crash`, `health_timeout`, `spawn_missing_executable`, `missing_bundle`, `fs_exhaustion`, `port_conflict`, ...) and an `attemptSummary` (attempt/phase/category, sent to Sentry as tags/extras). The renderer receives category + counts only (never spawn-log text); Safe Mode guidance copy is keyed off the category (exhaustive map, `safeModeCategoryGuidance.ts`). Headless/eval bootstrap surfaces failures via `HeadlessRuntime.superMcpStartupError`. NOTE (Sentry triage): the downstream "router not running" capture is fingerprint-pinned (`['super-mcp','router-not-running']`) since 260610 -- a deliberate one-time rebaseline of the old REBEL-S2/15F copy-keyed groups.
- **Race condition monitoring**: The app actively monitors for concurrent MCP tool calls and logs warnings when potential race conditions are detected.
- **Bundled-first launch; packaged never falls back to npm** (REBEL-61X): `resolveSuperMcpLaunchSpec` resolves the runtime in order — explicit `REBEL_SUPER_MCP_BIN` → **bundled** `super-mcp/dist/cli.js` (desktop `resourcesPath`, cloud `appRoot`) → `npx super-mcp-router@<pin>`. The `npx` fallback is **dev-only**: in a *packaged* build a missing bundle throws `MissingBundledSuperMcpError` (non-retryable → Safe Mode) instead of silently fetching from the registry. The pinned version is a **single source of truth** generated from `super-mcp/package.json` (`superMcpVersion.generated.ts`, env `REBEL_SUPER_MCP_PINNED_VERSION` overrides). `super-mcp-router` auto-publishes to npm on **stable** releases only — see [`SUPER_MCP_EDITING.md` § Step 3](SUPER_MCP_EDITING.md#step-3--versioning--npm-publish-automatic-you-dont-run-npm-publish).


## The problem: stdio race conditions

When multiple agent sessions use MCP tools concurrently via stdio transport, "Stream closed" errors occur due to race conditions in the transport layer. Rebel Core uses HTTP transport natively (see below), which avoids them. Over stdio this manifests as:

- Random tool call failures during concurrent turns
- "Stream closed" error messages in logs
- Unreliable behavior when using the message queue or interrupt mode

The root cause: stdio transport maintains shared stream state that becomes corrupted when multiple tool calls interleave.


## The solution: HTTP transport

Super-MCP's HTTP transport mode:

- Uses **stateful MCP sessions** — each client gets its own `Server` + `Transport` pair, isolated from other clients
- Supports unlimited concurrent agent sessions via per-session routing by `Mcp-Session-Id` header
- Provides better protocol design for concurrency
- Enables easier debugging with standard HTTP tools
- Provides meta-tools (`list_tool_packages`, `list_tools`, `get_tool_details`, `use_tool`, `get_help`, `authenticate`, `health_check_all`, `health_check`, `restart_package`)
- **Note:** Rebel intercepts `search_tools` calls via a PreToolUse hook and routes them to LanceDB hybrid search (FTS + vector + RRF) for better relevance. Super-MCP's BM25 `search_tools` serves as fallback (when index isn't ready) and for standalone clients like Claude Desktop. Both paths return **lite results** (name, description, relevance score — no schemas). The agent must call `get_tool_details` to hydrate schemas before using tools. See [TOOL_AWARENESS](TOOL_AWARENESS.md#runtime-interception-pretooluse-hook).
- Exposes `GET /api/tools/config-hash` and `GET /api/tools/manifest` endpoints for selective tool refresh. The config-hash endpoint returns a cheap SHA-256 digest of package registry config, enabling Rebel to skip LanceDB re-embedding when tools haven't changed between startups. See `super-mcp/src/server.ts` for both endpoints.
- Uses progressive disclosure for tool discovery: `list_tools` supports `detail: "lite" | "full"` for lighter browse-vs-hydrate responses, and `get_tool_details` provides the exact per-tool schemas when the model is ready to call a tool
- Keeps parameter hints out of lightweight `list_tools` browsing responses; schema details and parameter-level guidance now live in `get_tool_details`
- Exposes `GET /api/skipped-servers` endpoint for startup diagnostics (shows which servers failed validation and why)
- Caches tool schemas to reduce overhead on repeated calls

### `use_tool` argument auto-repair (super-mcp 2.6.0+)

When a model calls `use_tool` with slightly malformed arguments (wrong key casing, stringified JSON where an object was expected, loose type mismatches), the router **repairs from the tool's JSON Schema** before validation/send instead of failing the call outright. super-mcp **2.6.0** added schema-driven repair in `super-mcp/src/handlers/useTool.ts`, wired through `canonicalKeyNormalize` + `coerceArgsToSchema` in `super-mcp/src/utils/normalizeInput.ts` (the hand-maintained `paramAliasMap` casing aliases were retired in favour of schema-driven key normalization). Breadcrumbs are logged so upstream model bugs stay visible.

On the Rebel side, success-based schema hydration and an **enforcing** gate live in `src/main/services/schemaGateHook.ts`: **enforcing by default (since 2026-06-19)** — it denies unhydrated `use_tool` calls (no-op for a model that hydrates first, as the tool descriptions instruct); set `REBEL_ENFORCE_SCHEMA_GATE=0` for telemetry-only, or `REBEL_SKIP_SCHEMA_GATE=1` to disable the hook entirely (the router repair and the app gate are complementary — repair fixes arg shape at send time; the gate ensures the model hydrated schemas before calling). See [use_tool arg-validation research](../research/260615_mcp_use_tool_schema_salience_and_arg_validation.md) and [SUPER_MCP_EDITING § versioning](SUPER_MCP_EDITING.md#step-3--versioning--npm-publish-automatic-you-dont-run-npm-publish) (router-side repair changes need a super-mcp version bump).

Each MCP client creates a stateful session via the `initialize` JSON-RPC call, then uses that session for all subsequent requests. Sessions are cleaned up via DELETE (sent by `transport.terminateSession()`) or reaped after 30 minutes of inactivity.


## Architecture

### Component flow

```
┌─────────────────────────────────────────┐
│         Electron Main Process           │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │   Agent Session 1 (turnId: A)    │  │
│  └────────────┬─────────────────────┘  │
│               │                         │
│  ┌────────────▼─────────────────────┐  │
│  │   Agent Session 2 (turnId: B)    │  │
│  └────────────┬─────────────────────┘  │
│               │                         │
│  ┌────────────▼─────────────────────┐  │
│  │    Rebel Core (rebelCoreQuery()) │  │
│  │    - HTTP mode: per-session      │  │
│  │      Server+Transport isolation  │  │
│  └────────────┬─────────────────────┘  │
│               │                         │
└───────────────┼─────────────────────────┘
                │
    ┌───────────▼──────────┐
    │ Super-MCP HTTP Server│
    │ (localhost:3000/mcp) │
    └───────────┬──────────┘
                │
    ┌───────────▼───────────┐
    │   Individual MCP      │
    │   Servers (tools)     │
    │   - filesystem        │
    │   - github            │
    │   - etc.              │
    └───────────────────────┘
```

### Request flow (HTTP mode)

```
Session 1: initialize → gets Mcp-Session-Id: "abc"
Session 2: initialize → gets Mcp-Session-Id: "xyz"

Session 1: Tool Call A (header: Mcp-Session-Id: abc)
  ↓ Routed to Session 1's Server+Transport
Tool A execution
  ↓ Response
Session 1: Success

Session 2: Tool Call B (header: Mcp-Session-Id: xyz)
  ↓ Routed to Session 2's Server+Transport (independent)
Tool B execution
  ↓ Response
Session 2: Success

Per-session isolation! No interference between clients!
```


## Startup lifecycle

On `app.on('ready')`, the main process calls `startSuperMcpWithRetries()` which delegates to `superMcpHttpManager.startWithRetries()`:

1. **Finds an available port** starting from the preferred port (dev: 3200, beta: 3100, prod: 3000), trying up to 25 candidates via `findAvailablePort()`
2. **Configures the HTTP manager** with port, config path, and timeouts
3. **Spawns Super-MCP** using the bundled CLI from the `super-mcp/` submodule:
   - **Production**: Uses bundled Node runtime (`resources/node-bundle/`) to run `super-mcp/dist/cli.js`
   - **Development**: Uses system Node to run the submodule directly
4. **Polls for readiness** using TCP socket connection tests to `127.0.0.1` (30-second timeout, 200ms interval)
5. **Marks server as running** once health check passes
6. **Logs success** with port, URL, and startup time
7. **On failure**: retries up to 4 times with delays `[0, 5, 10, 20]` seconds, reselecting the port each time

The spawned process runs detached (Unix) with stdout/stderr captured to `{userData}/logs/super-mcp-spawn.log` via inherited file descriptors. This preserves `detached: true` + `unref()` process lifecycle while making startup failures diagnosable.

Startup failures now preserve structured diagnostics instead of collapsing to generic “router unavailable” copy. `SuperMcpStartResult` includes `attemptErrors[]` (attempt number, phase, and message) plus `lastError` / `lastErrorObj`; `HeadlessRuntime` exposes `superMcpStartupError` with those attempt errors, `portBase`, and `portRange` when no `superMcpUrl` is available. Keep this path intact for evals and knowledge-work fatal messages — it is the operator breadcrumb for real startup failures.

### Circuit breaker

After all 4 retry attempts are exhausted, a **120-second circuit breaker** engages (`CIRCUIT_BREAKER_COOLDOWN_MS`). During the cooldown:
- Subsequent calls to `startWithRetries()` throw `CircuitBreakerError` immediately instead of blocking for 30+ seconds
- Sentry capture is suppressed (the original failure was already captured)
- This prevents the per-turn Sentry event amplification that caused REBEL-S2 (15k events from 346 users)

The breaker resets on: successful startup, cooldown expiry, `reconfigure()`, `ensureRunningAfterResume()`, or user-initiated restart with `force: true`.

### Lazy recovery

If Super-MCP crashes during operation, the next agent turn triggers lazy recovery via `resolveSuperMcpRouterEntry()` in `mcpService.ts`. This also uses `startWithRetries()` with the full retry loop and circuit breaker. **Do not use raw `start()` for recovery** -- it lacks port reselection, retry, and the circuit breaker.

### Important: all startup/recovery paths must use `startWithRetries()`

| Caller | File | Context |
|--------|------|---------|
| App startup | `index.ts` | `startSuperMcpWithRetries('app-ready')` |
| Preflight (first-run) | `systemHealthService.ts` | `startSuperMcpWithRetries('preflight')` |
| Lazy recovery (per-turn) | `mcpService.ts` | `superMcpHttpManager.startWithRetries('lazy-recovery')` |
| Config change | `mcpService.ts` | `superMcpHttpManager.startWithRetries('config-change', { force: true })` |
| Manual restart (IPC) | `settingsHandlers.ts` | `startSuperMcpWithRetries('ipc-restart', { force: true })` |
| Headless CLI | `index.ts` | `startSuperMcpWithRetries('headless-cli')` |

> **Note**: The `npx super-mcp-router@latest` pattern is NOT used in Rebel. Rebel owns and maintains Super-MCP as a Git submodule, ensuring version consistency and enabling direct modifications when needed.


## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPER_MCP_HTTP_PORT` | `3000` | Preferred HTTP server port (actual default depends on build channel; see `getDefaultSuperMcpPort()` in `superMcpHttpManager.ts`) |
| `MINDSTONE_FORCE_DIRECT_MCP` | (unset) | Debug-only: when set to a truthy, non-`false`, non-`0` string, forces direct MCP mode and bypasses Super-MCP entirely |
| `SUPER_MCP_ROUTER_CLI` | (auto-detected, legacy) | Optional hint for environments that launch Super-MCP manually; the built-in HTTP manager does not read this in normal operation |
| `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` | `300000` | Stream-close timeout in ms (default 5 min); guards against "Stream closed" errors during parallel turns. Set automatically by the app. |
| `EVAL_TURN_TIMEOUT_MIN` | (eval harness default) | Overrides the per-turn timeout budget for knowledge-work eval runs, useful for slower local-model / Super-MCP startup combinations |

Desktop and eval CI jobs are split so Super-MCP/eval bootstrap failures can surface in the right lane without blocking unrelated desktop validation diagnostics.

### Config fields

The router config file supports these fields for server management:

| Field | Type | Description |
|-------|------|-------------|
| `disabledServers` | `string[]` | Server IDs to disable. Disabled servers are excluded from tool routing but preserved in config. Used by "Disable" feature in Settings UI. |

### No code changes required

HTTP mode uses the same MCP configuration file as stdio mode. The only difference is the transport layer - your tool definitions remain unchanged.


## Race condition detection

The implementation actively monitors for race conditions:

### During tool execution

When an MCP tool call starts while other turns are active:

```
INFO: MCP tool call with concurrent agent turns detected - monitoring for race conditions
  toolName: mcp__some_tool
  activeConcurrentTurns: 2
  mcpMode: http
```

### On "Stream closed" errors

If a race condition error occurs:

```
ERROR: RACE CONDITION DETECTED: Stream closed error
  isStreamClosedError: true
  activeConcurrentTurns: 2
  mcpMode: stdio
```

The renderer receives a status warning suggesting enabling HTTP mode when race conditions are observed in stdio mode.


## Performance characteristics

| Aspect | stdio | HTTP |
|--------|-------|------|
| Startup time | Instant | 1-3 seconds (health check) |
| Tool call latency | ~50-100ms | ~60-120ms (+10-20ms overhead) |
| Concurrent safety | Race conditions | Fully safe |
| Reliability | Degrades under load | Consistent |


## Troubleshooting

### HTTP server won't start

**Symptoms:**
```
ERROR: Super-MCP HTTP server failed to start within 30000ms (13 attempts)
```

**Solutions:**
1. Check the spawn log for child process output: `{userData}/logs/super-mcp-spawn.log`
2. Check if port is in use: `lsof -i :3000` (the app auto-selects a free port, but port exhaustion is possible)
3. Verify MCP config file is valid JSON
4. On Windows: check if firewall/AV is blocking the bundled `node.exe` in `resources/node-bundle/`

### HTTP server not running when router mode is enabled

**Symptoms:**

- MCP tools fail with errors such as “Super-MCP HTTP server is not running” when `resolveMcpServers()` is called.
- System Health reports `mcpMode: 'super-mcp'` but `superMcpHttpRunning: false`.

**Cause:** Super-MCP router mode is enabled (the default when an MCP config file is present) but the HTTP server failed to start or crashed. After all retry attempts fail, the circuit breaker engages for 120 seconds -- during this window, recovery attempts fast-fail instead of blocking.

**Solutions:**
1. Check `{userData}/logs/super-mcp-spawn.log` for child process output explaining the failure.
2. Go to Settings > Advanced and click "Restart Super-MCP" (the Support/Diagnostics tab; visible without developer mode since 260610 -- bypasses the circuit breaker with `force: true`).
3. Check the MCP config file path is correct in Settings.
4. Review app logs for `startWithRetries` and `circuit breaker` messages.
5. If you intentionally need direct MCP for debugging, enable Diagnostics → **Force direct MCP** or set `MINDSTONE_FORCE_DIRECT_MCP`, but remember this bypasses Super-MCP entirely.

### Port conflicts

**Symptoms:**
```
ERROR: Super-MCP HTTP server process error
  error: "EADDRINUSE: address already in use"
```

**Solutions:**
1. Find process using port: `lsof -i :3000`
2. Kill process: `kill -9 <PID>`
3. Or use different port: `export SUPER_MCP_HTTP_PORT=3001`

Note: The app will automatically try the next port (3001, 3002, etc.) if the preferred port is unavailable.

### Still seeing race conditions in HTTP mode

If "Stream closed" errors occur even with HTTP mode enabled:

1. **Verify HTTP mode is active**: Look for `Using Super-MCP HTTP mode (concurrent-safe)` in logs
2. **Check for mixed mode**: Ensure all MCP servers go through Super-MCP, not direct connections
3. **Increase stream timeout**: `export CLAUDE_CODE_STREAM_CLOSE_TIMEOUT=600000` (10 minutes)
4. **Review individual MCP server logs**: The issue may be in an upstream server

For more detailed troubleshooting, see the [implementation plan](../plans/finished/251129b_super_mcp_http_mode_implementation.md#troubleshooting).


## Disabling HTTP mode

Rebel’s main application always talks to Super-MCP over HTTP; there is no supported stdio transport path for the router itself. The only alternative is to **bypass Super-MCP entirely** and attach MCP servers directly in “direct mode”:

- Use Diagnostics → **Force direct MCP** in the Settings UI, or  
- Set `MINDSTONE_FORCE_DIRECT_MCP` to a truthy, non-`false`, non-`0` string in the environment.

Direct mode is intended for debugging and escape-hatch scenarios only. For normal operation and safe concurrency, prefer the default router-first, HTTP-only setup described in `MCP_ARCHITECTURE.md`.


## Tool Output Truncation and Continuation

Super-MCP uses a **dual-threshold** system for oversized tool output: materialization at a lower threshold for faster model access, and truncation/continuation at a higher threshold as fallback.

> **Cross-reference:** Built-in `Bash` follows the same materialisation pattern (same threshold, same `.rebel/tool-outputs/` dir, same atomic-write + 20MB cap) via `src/core/utils/builtinToolMaterialization.ts`. See [CONTEXT_MANAGEMENT § Layer 5](CONTEXT_MANAGEMENT.md#layer-5-tool-output-materialization) and `docs/plans/260501_bash_materialisation_and_large_data_prompt_guidance.md` for the built-in path. Super-MCP and the built-in `Bash` materialiser intentionally duplicate the small amount of FS-write logic to keep boundary clean (Super-MCP runs as a child process; built-in tools run in-process). The duplication is documented as accepted in both planning docs.

### Dual-threshold design

| Threshold | Constant | Default | Purpose |
|-----------|----------|---------|---------|
| Materialization | `MATERIALIZATION_THRESHOLD_CHARS` | **20,000 chars** | Write full output to file; return metadata + preview |
| Truncation / continuation | `DEFAULT_MAX_OUTPUT_CHARS` | **100,000 chars** | Truncate inline output; provide `result_id` for continuation |

- Output > 20K chars → materialization attempted first
- Output > 100K chars (or materialization unavailable) → truncation + continuation fallback
- **Per-call override**: Pass `max_output_chars: <value>` in `use_tool` args — overrides both thresholds
- **Unlimited**: Pass `max_output_chars: null` to disable both materialization and truncation (use with caution — may cause context overflow)

### Primary path: auto-materialization (>20K chars)

When tool output exceeds `MATERIALIZATION_THRESHOLD_CHARS` (default: **20,000 chars**), Super-MCP first attempts to save the full output to:

`{workspace}/.rebel/tool-outputs/`

On success, the response includes:

- `file_path` (workspace-relative path, e.g. `.rebel/tool-outputs/260402_1430_pkg_tool_a1b2c3.json`)
- `size_chars`
- `estimated_tokens`
- `preview` (~2KB)
- `preview_truncated` (boolean)

The response message tells the agent to use:
- **Read** (with `offset`/`limit` for targeted sections)
- **Grep** (to search for specific content)

### Fallback path: truncation + continuation

If materialization cannot be used (no workspace, write failure, or output above the 20MB materialization cap), Super-MCP falls back to truncation + continuation. A post-serialization safety net catches remaining oversized outputs (e.g., non-text content like audio or embedded resources) and replaces them with a compact placeholder + continuation.

Continuation retrieval uses `result_id` + `output_offset` in a follow-up `use_tool` call:

```json
{
  "package_id": "_", "tool_id": "_", "args": {},
  "result_id": "abc-123",
  "output_offset": 20000
}
```

### Inner content-block truncation

For tool results containing multiple content blocks (e.g., arrays of text items), truncation is applied **per-block** — each text block is measured against the remaining character budget. Blocks that exceed the budget are trimmed; blocks that no longer fit are dropped entirely.

### Controlling the limits

- **Materialization threshold**: 20,000 characters (`MATERIALIZATION_THRESHOLD_CHARS` in `super-mcp/src/handlers/useTool.ts`).
- **Truncation/continuation threshold**: 100,000 characters (`DEFAULT_MAX_OUTPUT_CHARS` in `super-mcp/src/handlers/useTool.ts`).
- **Per-call override**: Pass `max_output_chars: 50000` (or another value) in `use_tool` args — overrides both thresholds.
- **Unlimited**: Pass `max_output_chars: null` to disable both truncation and materialization (use with caution — may cause context overflow).
- A separate **large output warning** (no truncation) appears at 150,000 characters, suggesting the model retry with `max_output_chars`.

### Key code

| File | Purpose |
|------|---------|
| `super-mcp/src/handlers/materializeOutput.ts` | Primary materialization path (`.rebel/tool-outputs` write + response metadata) |
| `super-mcp/src/handlers/useTool.ts` | Materialization trigger, truncation logic, continuation cache, `handleContinuation()` |


## Limitations

### Current limitations

- **Single HTTP server per app**: One spawned process per Mindstone Rebel instance
- **Startup delay**: 1-3 second health check on app start
- **HTTP overhead**: Slightly higher latency than stdio (~10-20ms per call)

### Planned improvements

- Auto port selection with smarter conflict resolution
- Faster startup detection
- WebSocket option for bi-directional streaming
- Multi-instance load balancing


## Log locations

- **Development**: Console output plus log files under Electron `userData` directory
- **Production**: `~/Library/Application Support/mindstone-rebel/logs/`
- **Spawn diagnostics**: `{userData}/logs/super-mcp-spawn.log` — child process stdout/stderr, truncated on each new spawn

For complete logging documentation, see [LOGGING.md](LOGGING.md).

### Key log messages

| Message | Source | Meaning |
|---------|--------|---------|
| `Super-MCP HTTP server configured` | `superMcpHttpManager.ts` | Configuration loaded |
| `Starting Super-MCP HTTP server` | `superMcpHttpManager.ts` | Spawn initiated |
| `Super-MCP HTTP server health check passed` | `superMcpHttpManager.ts` | Ready to accept requests |
| `Super-MCP HTTP server started successfully` | `superMcpHttpManager.ts` | Fully operational |
| `Super-MCP startup circuit breaker active` | `superMcpHttpManager.ts` | Cooldown blocking retry |
| `Circuit breaker reset` | `superMcpHttpManager.ts` | Breaker cleared (manual/config/resume) |
| `Super-MCP lazy recovery successful` | `mcpService.ts` | Per-turn recovery worked |
| `Super-MCP lazy recovery blocked by circuit breaker` | `mcpService.ts` | Breaker fast-failed a turn |
| `Using Super-MCP HTTP mode (concurrent-safe)` | `mcpService.ts` | MCP resolution using HTTP |
| `MCP tool call with concurrent agent turns detected` | `agentMessageHandler.ts` | Concurrent tool usage happening |
| `RACE CONDITION DETECTED` | `turnPipeline/agentTurnExecute.ts` | Stream closed error occurred |


## Intent & Design Rationale

**Problem:** Super-MCP startup failures (REBEL-SG: 191 events, 143 users) cascaded into a 15k-event Sentry storm (REBEL-S2: 346 users) because every agent turn retried a doomed 30-second startup. 84% Windows.

**Approach:** Triage + observability. Circuit breaker prevents amplification, retry extraction provides self-healing with port reselection, FD-based diagnostics capture child process output for root cause analysis. The actual root cause of why the child can't bind its port on Windows is still TBD -- this change collects the diagnostic data needed to find it.

**Rejected:**
- `stdio: 'pipe'` for diagnostics — breaks `detached: true` + `unref()` process lifecycle. File descriptors are inherited at fork and independent after.
- Circuit breaker on raw `start()` — breaks the 4-attempt retry loop inside `startWithRetries()`. Breaker must wrap the entire retry sequence.
- Keeping retry logic in `systemHealthService.ts` — creates circular dependency with `mcpService.ts`. Moving to `SuperMcpHttpManager` eliminates the cycle.
- `onRetry` callback for Windows warmup — over-abstracted for a single consumer.

**Constraints a future agent must preserve:**
- All startup/recovery paths must go through `startWithRetries()`, never raw `start()`.
- The circuit breaker prevents Sentry event storms. Do not remove it.
- `stdio` uses file descriptors, not pipes. Do not change to `'pipe'`.
- User-initiated restarts must use `force: true` to bypass the circuit breaker.
- The spawn log is truncated on each spawn (`'w'` mode) — do not change to append mode.

**References:** `docs/plans/260327_supermcp_startup_reliability.md`, Sentry REBEL-SG / REBEL-S2.

## Maintenance

- When changing `superMcpHttpManager.ts` or the HTTP-related startup logic in `index.ts`, update this document as part of the same change.
- During periodic documentation housekeeping, verify that environment variables and behavior described here still match the implementation.
