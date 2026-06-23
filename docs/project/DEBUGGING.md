---
description: "Practical debugging guide for Mindstone Rebel — log locations, verbose logging, dev-vs-packaged traces, and AI-agent workflows"
last_updated: 2026-06-11
---

# Debugging

Practical debugging workflows for developers and AI agents working on Mindstone Rebel.

## See Also

- [LOGGING.md](./LOGGING.md) — **Canonical source** for log architecture, file locations, log levels, and configuration. Includes renderer console capture details.
- [ERROR_MONITORING_AND_SENTRY.md](./ERROR_MONITORING_AND_SENTRY.md) — Sentry error monitoring: startup captures, tagging conventions, how to add new captures.
- [SENTRY_TRIAGE.md](./SENTRY_TRIAGE.md) — Operational process for triaging Sentry issues.
- [DIAGNOSTICS.md](./DIAGNOSTICS.md) — System health checks and diagnostic bundle export for troubleshooting.
- [ELECTRON_STORAGE_REFERENCE.md](./ELECTRON_STORAGE_REFERENCE.md) — Complete reference for all Electron userData files (sessions, settings, MCP config).
- [REBEL_CORE.md](./REBEL_CORE.md) — Rebel Core agent runtime architecture; includes transcript JSONL logging for debugging agent turns.
- [SETUP_DEVELOPMENT_ENVIRONMENT.md](./SETUP_DEVELOPMENT_ENVIRONMENT.md) — Dev prerequisites and environment setup.
- [TESTING_E2E.md](./TESTING_E2E.md) — Playwright E2E testing; useful for debugging UI issues.
- [SUPERMCP_OVERVIEW.md](./SUPERMCP_OVERVIEW.md) — MCP debugging, race condition detection, and concurrency issues.
- [APP_PERFORMANCE_AND_MEMORY.md](./APP_PERFORMANCE_AND_MEMORY.md) — Performance profiling, `[PERF]` logging, `perfAccumulator`, and the dev-only typing-lag monitor (`useDevPerformanceMonitor`).
- [PERF_DIAGNOSTIC_PLAYBOOK.md](./PERF_DIAGNOSTIC_PLAYBOOK.md) — **Start here** when investigating CPU / memory / beach-ball / idle-churn symptoms. Sessions A-E recipe, red-flag greps (Bash + PowerShell), and the `scripts/perf-acceptance-check.ts` AC1-AC5 harness. Always-on 5 min / 120 s `Memory diagnostic` cadence is the primary signal.
- `src/core/logger.ts` — Pino-based logging implementation (platform-agnostic).
- `src/main/sentry.ts` — Main process Sentry initialization and capture functions.
- `src/main/index.ts` — Main process entry; includes renderer console capture setup.
- [CLAUDE_AGENT_SDK_REFERENCE.md](../research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md#sdk-session-storage-the-claude-directory) — *(Historical)* SDK `.claude` storage and transcript correlation (SDK removed April 2026).


## Quick Start

### Log File Locations

| Environment | Location |
|-------------|----------|
| Development | `~/Library/Application Support/mindstone-rebel/logs/` |
| Production (macOS) | `~/Library/Application Support/mindstone-rebel/logs/` |
| Production (Windows) | `%APPDATA%\mindstone-rebel\logs\` |
| Production (Linux) | `~/.config/mindstone-rebel/logs/` |

Main log file: `mindstone-rebel.log` (with daily rotation and gzip compression of old files).

### Enable Verbose Logging

```bash
# Development - set before running npm run dev
export MINDSTONE_LOG_LEVEL=debug

# Or per-run
MINDSTONE_LOG_LEVEL=debug npm run dev
```

### Quick Log Inspection

**Important:** Due to `pino-roll` log rotation, the most recent logs may NOT be in `mindstone-rebel.log`. Check numbered files (`.1.log`, `.2.log`, etc.) which contain newer entries.

```bash
# Step 1: Find the most recently modified log file
ls -lt ~/Library/Application\ Support/mindstone-rebel/logs/*.log | head -5

# Step 2: Tail the most recent file (check ls output for filename)
tail -f ~/Library/Application\ Support/mindstone-rebel/logs/mindstone-rebel.log

# Search ALL log files for recent entries (last 15 min)
grep -h "$(date -u +%Y-%m-%dT%H)" ~/Library/Application\ Support/mindstone-rebel/logs/*.log | tail -50

# Search for errors across all log files
grep -i error ~/Library/Application\ Support/mindstone-rebel/logs/*.log

# Search for renderer console output
grep "renderer-console" ~/Library/Application\ Support/mindstone-rebel/logs/*.log
```

### Distinguishing Dev vs Packaged App Logs

Both dev (`npm run dev`) and packaged apps write to the same log directory. To identify which is which:

| Field | Dev Build | Packaged App |
|-------|-----------|--------------|
| `source` path | `file:///Users/.../rebel-app/out/...` | `/Applications/Mindstone Rebel.app/...` |
| `appVersion` | Current dev version | Release version (e.g., `0.4.28`) |

```bash
# Find dev build logs (look for /out/ in source paths)
grep -l "rebel-app/out/" ~/Library/Application\ Support/mindstone-rebel/logs/*.log

# Filter to only dev logs in a specific file
grep "rebel-app/out/" ~/Library/Application\ Support/mindstone-rebel/logs/mindstone-rebel.3.log
```


## Debugging for AI Agents

AI coding agents (Factory Droid, Cursor, etc.) can debug Mindstone Rebel by reading log files directly. The logging system captures:

### What's Available in Logs

| Source | Always Captured | Dev Mode Only | Diagnostics-Only |
|--------|-----------------|---------------|------------------|
| Main process logs | All levels based on `MINDSTONE_LOG_LEVEL` | — | — |
| Renderer `console.warn`/`console.error` | Yes | — | — |
| Renderer `console.log`/`console.debug` | — | Yes | Yes |
| Unhandled errors/rejections | Yes | — | — |
| Chromium warnings (CSP, deprecations) | Yes | — | — |

### Identifying Renderer Console Output

Renderer console messages are tagged with `channel: 'renderer-console'` in the logs:

```json
{"level":30,"time":"2025-01-15T10:30:45.123Z","channel":"renderer-console","source":"webpack://mindstone-rebel/./src/renderer/App.tsx","line":42,"msg":"[Renderer] Component mounted"}
```

### Enabling Full Console Capture

In **dev mode** (`npm run dev`), all renderer console levels (`log`, `debug`, `warn`, `error`) are captured automatically in log files — no diagnostics mode needed. This is useful for AI agents reading log files without DevTools access.

In **production builds**, `console.log` and `console.debug` require diagnostics mode:

1. **Via app settings**: Enable diagnostics mode (Settings → Advanced (Support tab) → Debug Breadcrumbs)
2. **Programmatically**: The diagnostics mode is time-limited and auto-expires

When diagnostics mode is active, verbose renderer console output flows to the same log files.

### Rebel Core Transcripts and Turn Debugging

Rebel Core is the current agent runtime. To debug agent turns:

1. **Structured log files** — Agent turn events are logged with `turnId` and `sessionId` fields. Filter with:
   ```bash
   grep "turnId" ~/Library/Application\ Support/mindstone-rebel/logs/*.log | tail -20
   ```
2. **Turn event flow** — Look for `turn_started`, `assistant`, `tool`, `result`, and `error` event types in logs.
3. **BTS (Behind-the-Scenes) calls** — Lightweight model calls (title generation, summaries) use `callBehindTheScenesWithAuth()` and log under the `conversationTitle`, `behindTheScenes`, or `contextCompaction` service scopes.

For full Rebel Core architecture and debugging, see [REBEL_CORE.md](./REBEL_CORE.md).


## Common Debugging Scenarios

### Unclean Shutdown Detection

On startup, the app checks if the previous session exited cleanly. If not, it captures recent logs and reports to Sentry with message "Unclean shutdown detected from previous session". This uses a 1-hour cooldown to avoid flood. See `src/main/services/crashRecoveryService.ts` for implementation.

### IPC Handler Presence Invariant

After `resolveIpcHandlersReady()` fires (`src/main/index.ts`), the app runs `assertHandlerPresence()` (`src/main/ipc/handlerPresenceInvariant.ts`) to verify every required invoke channel in `allChannels` has a registered handler.

- **Dev / CI** (`!app.isPackaged` or `isCiEnvironment()`): `fail-hard` mode — startup aborts with an `InvariantViolationError` listing the missing channels.
- **Packaged production**: `production-degrade` mode — emits a single batched Sentry event (`area=ipc-handler-presence`) with a `missingChannels[]` extra and stable fingerprint; no synthetic handler is installed (Electron's "No handler registered" rejection is the intended renderer-side surface).
- **Emergency local bypass**: `REBEL_HANDLER_PRESENCE_INVARIANT_DISABLED=1` short-circuits the assertion entirely. Use only for emergency local debugging; CI still enforces.
- **Sync channels** (`ipcMain.on`-backed: `sessions:save-sync`, `folders:save-sync`) are intentionally excluded — the registry is invoke-only.
- **Bypass policy & audit trail**: see `docs/plans/260522_compile-time-reliability/stage4-channel-audit.md` for the full list of `bypass: true` overrides with file:line provenance, and `src/shared/ipc/channelMetadata.ts` for the override map.

### "Sign in failed. Please try again." in dev

Usually **not** an auth bug. The most common cause is the global store version gate (`userData was last used by a newer app version (epoch check) — read-only mode`), which silently blocks `saveSessionToken()` so the next `fetchUserInfo()` reads a stale token and the server rejects it. Grep the log for `read-only mode` / `fetchUserInfo caught exception`. Full diagnosis and fix: [GIT_WORKTREES § Troubleshooting](./GIT_WORKTREES.md#troubleshooting).

### Agent/MCP Issues

**Quick health check (for AI agents):**
```bash
npm run test:mcp           # Test all bundled MCPs
```

This spawns the MCP server and calls `listTools` to verify it works. Use this to verify fixes before asking users to restart the app. See [MCP_TESTING.md § Legacy Health Check](./MCP_TESTING.md#legacy-health-check-level-1-details) for details.

**Debug logging:**
1. Enable debug logging: `MINDSTONE_LOG_LEVEL=debug`
2. Look for these log patterns:
   - `mcpMode` — Shows whether `'http'` or `'stdio'` mode is active
   - `Super-MCP HTTP` — Startup, port allocation, health checks
   - `RACE CONDITION` — Concurrent turn issues (see `SUPERMCP_OVERVIEW.md`)
   - `Stream closed` — SDK connection issues

```bash
grep -E "(mcpMode|Super-MCP|RACE CONDITION|Stream closed)" logs/mindstone-rebel.log
```

### Renderer/React Issues

1. Check for unhandled errors:
```bash
grep -E "(Unhandled renderer error|Unhandled promise rejection)" logs/mindstone-rebel.log
```

2. Check renderer console warnings/errors:
```bash
grep "renderer-console" logs/mindstone-rebel.log | grep -E '"level":(40|50)'
```

### Workspace/File Issues

Look for file operation failures:
```bash
grep -E "(Failed to read|Failed to write|Failed to delete)" logs/mindstone-rebel.log
```

### EMFILE / EBADF / fd pressure

When process spawning or file operations start failing under descriptor pressure, check the production-on fd telemetry first:

```bash
# Baseline fd telemetry emitted on every perf tick (5 min focused / 120 s blurred)
grep "perf.fd_snapshot" logs/mindstone-rebel.log | tail -50

# Threshold crossings (50/75 elevated ledger-only, 90 critical warning)
grep "fd pressure" logs/mindstone-rebel.log | tail -50
```

Interpretation quick guide:
- **Cross-site spawn `EBADF`/`EMFILE` (Bash, rg, pidusage all failing at once) means parent-process fd pathology** — check the fd count AND the highest fd number BEFORE reaching for stdio/spawn-option changes. On macOS, `posix_spawn` fails `EBADF` once fd *numbers* exceed `OPEN_MAX` (10,240) even when the rlimit is raised, so a raised limit does not save you and `stdio: 'ignore'` cannot help (the pipe fds themselves get high numbers).
- On the `perf.fd_snapshot` log line the fields are flat `openFdCount` / `maxFdNumber`; on the `Memory diagnostic` payload they are nested under `fdSnapshot.*`. Both track raw descriptor pressure on darwin/linux (win32 reports `unsupported`).
- Elevated 50%/75% bands are captured as `fd_pressure_elevated` ledger-only (never reaches Sentry issue-stream by construction).
- Critical 90% is `fd_pressure_critical` warning issue-stream telemetry.
- Breadcrumb category `perf.fd_snapshot` is emitted each tick so later crash/spawn failures carry recent fd context.

Worked example: the 2026-06-11 SearchFiles fd-leak outage — ~19k leaked fds from a readline-stream leak killed every spawn until restart, and the prior symptom-level fix (REBEL-66M, `stdio: 'ignore'`) could not help because fd numbers, not pipe inheritance, were the problem. Full chain: `docs-private/postmortems/260611_searchfiles_fd_leak_ebadf_postmortem.md`. Gauge implementation: `docs/plans/260611_sentry-fd-detection-followups/PLAN.md` (FD-3 / FD-4).

### Voice/Audio Issues

```bash
grep -E "(Voice transcription|TTS stream error|Voice TTS)" logs/mindstone-rebel.log
```


## Development Tools

### Electron DevTools

In development mode, DevTools opens automatically in detached mode. For packaged builds:
- DevTools are not available by default (security)
- Use diagnostic bundle export for log access

### Browser DevTools Alternatives

Since AI agents can't interact with browser DevTools directly, use:

1. **Log files** — Primary debugging source (see above)
2. **Diagnostic bundle** — Export via Help → Download Diagnostics
3. **IPC logging** — Renderer code can use `window.api.logEvent()` for structured logging

### Runtime Config Debugging

```typescript
// In renderer - check runtime config
console.log(window.electronEnv.runtimeConfig);

// Reload runtime config
await window.electronEnv.reloadRuntimeConfig();
```

### Session Replay Debugging

For store-level regression testing:
```bash
npm run replay:session-trace <trace.json>
```


## Structured Logging Best Practices

When adding debug logging:

```typescript
// Good - structured context
logger.info({ turnId, sessionId, toolName }, 'Tool execution started');

// Bad - string concatenation
logger.info(`Tool ${toolName} started for turn ${turnId}`);
```

Use stable identifiers (`turnId`, `sessionId`, `workspace`) so related log lines can be correlated.


## Troubleshooting Logging Itself

See [LOGGING.md § Troubleshooting](./LOGGING.md#troubleshooting-logging-itself) for:
- No log files appearing
- Log level not changing
- Too much log noise


## Historical: Claude SDK Transcripts

> **Note:** The Claude Agent SDK was removed in April 2026. The `~/.claude/` transcripts are only available for sessions that ran before the removal. New sessions use Rebel Core, which does not create `~/.claude/` transcripts. The `upstreamSessionId` field and related correlation mechanisms have been removed from the codebase. See `docs/plans/260406_fix_sdk_conversation_amnesia.md` for historical context and [CLAUDE_AGENT_SDK_REFERENCE.md](../research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md#sdk-session-storage-the-claude-directory) for the archived SDK storage reference.


## Maintenance

When adding new debugging capabilities:
- Update this document with new search patterns or techniques
- Keep [LOGGING.md](./LOGGING.md) as the canonical source for log architecture
- Add cross-references from related feature docs
