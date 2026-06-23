---
description: "Logging architecture, Pino configuration, and session log retention for Mindstone Rebel"
last_updated: "2026-05-11"
---

### Introduction

Mindstone Rebel uses structured logging in the main process and a lightweight logging bridge from the renderer to help diagnose issues in development and production without leaking sensitive data.  
This document is the canonical reference for how logging works, where logs are written, how to configure verbosity, and how to use logs effectively when debugging.


### See also

- [DEBUGGING.md](./DEBUGGING.md) – Practical debugging workflows for developers and AI agents; quick-start commands and common scenarios.
- [APP_PERFORMANCE_AND_MEMORY.md](./APP_PERFORMANCE_AND_MEMORY.md) – Memory diagnostics, OOM debugging, and performance monitoring via logs.
- [ERROR_MONITORING_AND_SENTRY.md](./ERROR_MONITORING_AND_SENTRY.md) – Sentry error monitoring; recent logs are attached to Sentry events for debugging context.
- [DIAGNOSTICS.md](./DIAGNOSTICS.md) – System health checks and diagnostic bundle export; uses logs as part of the diagnostic bundle.
- `./ARCHITECTURE_OVERVIEW.md` – High‑level architecture; see especially the notes on main vs renderer responsibilities and error handling.
- `./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` – Canonical list of environment variables, including logging‑related flags.
- `./SETUP_DEVELOPMENT_ENVIRONMENT.md` – How to run the app locally and enable more verbose logging while developing.
- [DISTRIBUTION](./DISTRIBUTION.md) – Distribution details; useful when debugging MCP/tool issues that appear only in production.
- `./PACKAGED_DEPENDENCY_NOTES.md` – How Vite/Forge packaging treats dependencies; helpful when debugging module loading errors in production.
- `./SUPERMCP_OVERVIEW.md` – Super‑MCP HTTP mode design and race‑condition detection; points to key log messages for concurrency issues.
- [DIAGNOSTICS.md § Continuity breadcrumbs](./DIAGNOSTICS.md#continuity-breadcrumbs) – Mobile and cloud-client observability for continuity operations (merges, outbox, catch-up, state transitions, conflicts). Cloud-client's tag logger forwards `warn`/`error` entries to Sentry via the `setLogErrorReporter(...)` bridge.
- `../../cloud-client/src/utils/logger.ts` – Tag-based logger shared by cloud-client/mobile; `setLogErrorReporter()` enables the breadcrumb bridge.
- `../../cloud-client/src/observability/continuityEvents.ts` – `ContinuityTransitionEvent` contract and SAFE_KEYS allowlist.
- `../../mobile/src/utils/continuityBreadcrumbs.ts` – Mobile dispatcher that emits breadcrumbs and throttled escalations.
- `../../src/core/logger.ts` – Pino‑based logging implementation (platform‑agnostic).
- `../../src/main/index.ts` – Main‑process usage of scoped loggers for agent turns, MCP mode selection, Super‑MCP HTTP lifecycle, permissions, and workspace operations.
- `../../src/preload/index.ts` – Preload bridge for renderer logging and unhandled error propagation to the main logger.


### Principles, key decisions

- **Single structured log pipeline**: All logs (main and renderer) ultimately flow through a single Pino logger in the main process so production diagnostics live in one place.  
- **Safe by default**: Logs are structured and redact sensitive fields (API keys) by default; environment configuration can increase verbosity but should not leak credentials.  
- **Environment‑driven verbosity**: Log level is controlled via an environment variable so development, CI, and production can tune verbosity without code changes.  
- **Production‑oriented file logging**: Packaged apps write rolling log files under the Electron `userData` directory so issues can be investigated on end‑user machines.  
- **Scoped context for long‑running work**: Long‑running operations such as agent turns use scoped loggers with stable identifiers (turn/session IDs) to keep related events easy to follow.


### Logging architecture

#### Main process logger

The main process owns the canonical logger, implemented in `src/core/logger.ts`:

- **Library**: Uses `pino` with `pino-roll` for log rotation.  
- **Log level**:  
  - Resolved as `process.env['MINDSTONE_LOG_LEVEL'] ?? (NODE_ENV === 'development' ? 'debug' : 'info')`.  
  - In practice, most docs refer to `LOG_LEVEL`; see the environment‑variable section below for how to align these in your local environment.  
- **Log metadata (`base`)**:
  - `pid` – Node process ID.  
  - `appVersion` – Electron app version (when available).  
  - `component: 'main'` – Identifies the main process as the source.  
- **Redaction**:
  - Redacts and removes the following paths from log output:
    - `context.apiKey`  
    - `context.voiceApiKey`  
  - Keep API keys and other secrets under `context.*` when logging so redaction applies.
- **Timestamps**:
  - Uses `isoTime` from `pino.stdTimeFunctions` for human‑readable ISO 8601 timestamps.

Log file handling:

- Logs are written to a `logs` directory under Electron `userData`:
  - macOS: `~/Library/Application Support/mindstone-rebel/logs/`
  - Windows: `%APPDATA%\mindstone-rebel\logs\`
  - Linux: `~/.config/mindstone-rebel/logs/`
  - In development it typically resolves under the repo's dev profile `userData` directory.
- The main log file name is `mindstone-rebel.log`.  
- Rotation is handled by `pino-roll` with:
  - Daily rotation.  
  - `DEFAULT_MAX_FILE_SIZE = '10m'`.  
  - Gzip compression of old files.  
- If the rolling transport cannot be initialized, the logger falls back to a standard Pino destination and emits a warning.

Key helpers exported from `logger.ts`:

- `logger` – Shared root logger for main‑process code.  
- `createScopedLogger(bindings)` – Creates a child logger with additional `bindings` (e.g. `{ turnId, rendererSessionId }`).  
- `logAtLevel(level, message, context?)` – Convenience helper for generic logging at a runtime‑determined level.  
- `getLogDirectory()` / `getLogFilePath()` – Utility functions returning the resolved log directory and file path.


#### Renderer and preload logging

The renderer does not write files directly; instead it sends structured log events to the main process over IPC:

- `window.api.logEvent(payload: RendererLogPayload)` (from `src/preload/index.ts`) sends a `log:event` IPC message.  
- The main process listens on `ipcMain.on('log:event', ...)` and:
  - Creates a scoped logger:  
    - Always includes `channel: 'renderer-ipc'`.  
    - Adds `source` (e.g. `'renderer'` or `'preload'`) when provided.  
    - Includes `turnId` and `sessionId` if present.  
  - Merges `context`, `breadcrumbs`, and `timestamp` into the log context.  
  - Optionally includes any structured `error` object.  
  - Logs at the requested level using the same Pino logger as the rest of the main process.

The preload script also subscribes to global error events and forwards them into this pipeline:

- `window.addEventListener('error', ...)` – Captures unhandled renderer errors and logs them as `level: 'error'` with stack, filename, and line/column metadata.  
- `window.addEventListener('unhandledrejection', ...)` – Captures unhandled promise rejections, logging either the `Error` details or a JSON‑stringified representation of the rejection reason.

This design keeps renderer code free of log‑file concerns while ensuring that critical front‑end failures are visible in the same logs as main‑process events.


#### Renderer console capture

In addition to explicit `logEvent()` calls, the main process automatically captures `console.*` output from the renderer via Electron's `webContents.on('console-message')` API:

- **Always captured**: `console.warn` and `console.error` are always written to logs (useful for crash debugging and AI agent analysis).
- **Development (`!app.isPackaged`)**: All console levels (`log`, `debug`, `warn`, `error`) are always captured. This gives AI coding agents full renderer visibility via log files without needing DevTools access.
- **Production (`app.isPackaged`)**: `console.log` and `console.debug` are only captured when diagnostics mode is active (to avoid excessive log noise).
- **Log channel**: All captured console messages are tagged with `channel: 'renderer-console'` and include `source` (file path) and `line` number metadata.

This is particularly useful for AI coding agents that need visibility into renderer-side state without access to browser DevTools. The logs appear in the same files as other main-process logs:
- Development: `~/Library/Application Support/mindstone-rebel/logs/`
- Production: Same location, with rotation

To enable verbose console capture in production (including `console.log`), activate diagnostics mode in the app settings or via the diagnostics bundle export flow.

**Note**: Chromium-level warnings (deprecation notices, CSP violations, etc.) are also captured through this mechanism.


#### Scoped logging for agent turns and MCP

Agent execution is one of the most log‑heavy flows in the app, and it uses scoped loggers for traceability:

- Each agent turn gets a dedicated scoped logger via `createScopedLogger` with bindings such as:
  - `turnId` – Unique ID per turn.  
  - `rendererSessionId` – Renderer session identifier.  
- The main process logs:
  - Turn lifecycle events (`'Agent turn requested'`, `'Starting agent turn'`, `'Agent turn iterator completed'`, `'Agent turn aborted by user'`, etc.).  
  - MCP configuration and mode selection (`mcpMode`, `upstreamServerCount`, resolved MCP config path).  
  - Super‑MCP HTTP mode startup and health checks (including port and state).  
  - Race‑condition detection for “Stream closed” errors, with additional context:
    - `activeConcurrentTurns`  
    - `mcpMode` (`'http'` or `'stdio'`)  
    - GitHub issue references for known SDK bugs.  
- Tool usage is logged via tool events collected from `SDKMessage` content, including tool names, stages (`'start'`/`'end'`), and summarized details.

These scoped logs are essential when debugging MCP behavior, Super‑MCP HTTP mode, and concurrent agent turns; see `SUPERMCP_OVERVIEW.md` for concrete examples of the most important messages.


### Configuration and environment variables

#### Log level

Log level is driven by environment variables at process start:

- **Effective level in code**:  
  - `process.env['MINDSTONE_LOG_LEVEL']` if set.  
  - Otherwise: `'debug'` when `NODE_ENV === 'development'`, or `'info'` for other environments.  
- **Common usage pattern**:
  - Most docs and examples refer to `LOG_LEVEL` for readability.  
  - To keep behavior consistent, either:
    - Set **both** variables, or  
    - Prefer `MINDSTONE_LOG_LEVEL` in your shell and treat `LOG_LEVEL` as a shorthand in documentation.

Examples:

```bash
# Typical development setup (verbose logs)
export MINDSTONE_LOG_LEVEL=debug

# Alternative: if your existing tooling sets LOG_LEVEL, mirror it
export LOG_LEVEL=debug
export MINDSTONE_LOG_LEVEL="$LOG_LEVEL"
```

Recommended levels:

- `debug` – For day‑to‑day development and when debugging complex flows (MCP, Super‑MCP HTTP mode, audio).  
- `info` – For normal production use; records key lifecycle events without overwhelming log volume.  
- `warn` / `error` – For highly constrained environments where only problems should be recorded.


#### Log locations

Log output depends on how the app is run:

- **Development (`npm run dev`)**:
  - Logs are written both to the console (via Electron/Node stdio) and to the Pino destination file under the development `userData` path.  
  - File location is typically inside the Electron dev profile directory; on macOS this is still under `~/Library/Application Support/mindstone-rebel/` but may be namespaced by the dev environment.

- **Packaged apps (macOS)**:
  - Logs are always written to:
    - `~/Library/Application Support/mindstone-rebel/logs/mindstone-rebel.log` (with rotated/archived files alongside).  
  - This directory is the primary place to look when collecting logs from a user machine.

Use the `getLogDirectory()` and `getLogFilePath()` helpers from `logger.ts` if you need to surface log locations in future UI or tooling.


### Using logging when developing and debugging

#### When and how to log

Follow these guidelines when adding or updating log statements:

- **Use structured context**:
  - Prefer `logger.info({ path, errorCode }, 'Failed to read workspace file')` over string concatenation.  
  - Use stable identifiers (`turnId`, `sessionId`, `workspace`, `configPath`) so related log lines can be grouped.
- **Log at appropriate levels**:
  - `trace` – Very noisy, fine‑grained details (e.g. individual SDK message types, raw tool payload lengths).  
  - `debug` – Helpful internal state changes, branches, and one‑off diagnostics.  
  - `info` – High‑level lifecycle events and successful operations (turn start/end, HTTP server ready, file/folder created).  
  - `warn` – Suspicious but recoverable situations (e.g. missing optional config, attempts to stop a non‑existent turn, access‑denied checks).  
  - `error` – Failures that impact the current operation (file I/O failures, HTTP failures, unexpected exceptions).  
  - `fatal` – Process‑level failures (uncaught exceptions, unhandled rejections) that may terminate the app.
- **Avoid sensitive data**:
  - Never log raw API keys, access tokens, or user secrets.  
  - When debugging requests, log lengths, IDs, or sanitized summaries instead of full payloads.


#### Typical debugging workflows

- **Memory leaks / OOM issues**:
  - Search for `"Memory diagnostic"` to see per-process memory breakdown every 5 minutes.
  - In dev mode, search for `"MEMORY LEAK DETECTED"` for automatic leak warnings.
  - See [APP_PERFORMANCE_AND_MEMORY.md](./APP_PERFORMANCE_AND_MEMORY.md) for detailed interpretation and thresholds.

- **Agent/MCP issues**:
  - Enable debug logging via `MINDSTONE_LOG_LEVEL=debug`.  
  - Reproduce the issue, then inspect logs for:
    - MCP mode (`'http'` vs `'stdio'`).  
    - Super‑MCP HTTP startup messages and any errors.  
    - `RACE CONDITION` messages or “Stream closed” errors.  
  - See `SUPERMCP_OVERVIEW.md` for a checklist of relevant messages and remediation steps.

- **Super‑MCP process issues**:
  - Super‑MCP is spawned as a detached child process with `stdio: 'ignore'` — its stdout/stderr are **not** captured in Electron's logs. Instead, Super‑MCP has its own internal logging.
  - **Startup failures**: If Super‑MCP fails to start, Electron logs will show:
    - `"Super-MCP HTTP server process exited"` with `code` and `signal`.
    - `"Super-MCP HTTP server process error"` with error details (e.g., `EBADF`, `ENOENT`).
    - `"Super-MCP HTTP server failed to start within Xms"` from the health check timeout.
  - **MCP server validation errors** (e.g., misconfigured servers): Fetched after startup via Super-MCP's `GET /api/skipped-servers` HTTP endpoint (see `fetchSkippedServers()` in `superMcpHttpManager.ts`). Skipped servers are logged at info level, surfaced in health checks, and shown as renderer toasts. To debug validation errors directly, run Super-MCP standalone in a terminal (`node super-mcp/dist/cli.js --transport http --port 3200 --config <config-path>`) to see its stderr.
  - **Process lifecycle**: Search for `"Stopping Super-MCP"`, `"Super-MCP restarted successfully after system resume"`, or `"Found orphaned Super-MCP process"` to trace lifecycle events.

- **Workspace/file issues**:
  - Look for `Failed to read workspace file`, `Failed to write workspace file`, or `Failed to delete workspace item` entries.  
  - Check the associated `path`, `errorCode`, and `errorMessage` fields to distinguish permissions problems from path‑resolution or validation errors.

- **Voice/audio issues**:
  - For STT/TTS errors, search for:
    - `Voice transcription IPC handler error`  
    - `TTS stream error`  
    - `Voice TTS IPC handler error`  
  - Combine these with provider settings and network logs to narrow down API‑ vs app‑level problems.

- **Agent turn performance / TTFT**:
  - Use the CLI profiling feature for precise timing measurements:
    ```bash
    npm run cli -- run -p "Hello" --profile
    ```
  - Search logs for `"Super-MCP HTTP server ready"` to check MCP startup time.
  - Search for `"Agent turn produced result"` which includes `usage` and `totalCostUsd`.
  - See [APP_PERFORMANCE_AND_MEMORY.md](./APP_PERFORMANCE_AND_MEMORY.md#cli-profiling-for-agent-turns) for profiling details.

- **Renderer/React issues**:
  - Inspect logs for:
    - `Unhandled renderer error` (from the `error` event listener).  
    - `Unhandled promise rejection` from renderer promises.  
  - These entries will include stack traces and file/line metadata to help locate the failing code in the renderer.


### Test isolation and logging

When running E2E tests with isolated userData (via `REBEL_TEST_USER_DATA_DIR`), there is a known limitation:

**If import ordering breaks in `src/main/index.ts`**, the logger may write log files to the real userData directory before the test isolation assertion fails. This happens because `logger.ts` calls `app.getPath('userData')` at module evaluation time, so if it's imported before `ensureTestUserData.ts`, it gets the real path.

**Why this is acceptable for v1:**
- Logs are not sensitive user data—settings, conversation history, and authentication tokens are the protected data
- The test WILL still fail with a clear error message from `assertTestIsolationIfRequired()` in `settingsStore.ts`
- The mandatory temp directory requirement prevents any *settings* from being written to non-temp paths

**If you see logs in real userData during test failures:**
1. Check import ordering in `src/main/index.ts`—`ensureTestUserData` must come before any module that imports `./logger`
2. The logs themselves are harmless; focus on fixing the import ordering
3. See `TESTING_E2E.md` for the full test isolation documentation


### Troubleshooting logging itself

If you suspect logging is not working as expected:

- **No log files appear**:
  - Verify that the app is writing to the expected `userData` directory:
    - On macOS, check `~/Library/Application Support/mindstone-rebel/logs/`.  
  - Ensure the process has write permissions to that directory.  
  - In development, confirm that `logger.info(...)` calls are visible in the terminal.

- **Log level doesn’t seem to change**:
  - Confirm which environment variables are set for the Electron main process:
    - `MINDSTONE_LOG_LEVEL` takes precedence over `NODE_ENV`.  
  - Remember that environment variables are read at process startup; restart `npm run dev` or the packaged app after changing them.  
  - In ambiguous setups, log the effective level once at startup by adding a temporary `logger.info({ level: process.env['MINDSTONE_LOG_LEVEL'] }, 'Effective log level')` and then removing it once verified.

- **Too much log noise in production**:
  - Ensure production environments do **not** set `MINDSTONE_LOG_LEVEL=debug`.  
  - Prefer `info` or `warn` in production unless actively investigating a bug.  
  - If you need short‑term debug logs in production, plan to reset the level once the investigation is complete.


### String redaction for UI and error display

In addition to log-level redaction, the codebase provides utilities for redacting sensitive data from strings that may be displayed to users or sent to error monitoring.

**Canonical source**: `src/shared/utils/sentryRedaction.ts`

Key exports:
- `redactSensitiveString(content: string)` – Redacts API keys, emails, home directory paths, bearer tokens, and sensitive URL parameters from a string. Use this when displaying error messages that might contain secrets (e.g., API validation errors, connection failures).
- `redactObjectDeep(obj: unknown)` – Recursively redacts sensitive fields from objects. Used by Sentry event processing and diagnostic bundle exports.

**When to use `redactSensitiveString()`**:
- Error messages displayed in UI (toasts, inline errors, error boundaries)
- API validation feedback (e.g., "Invalid API key" messages)
- Connection/network error messages that might echo back credentials
- Any user-visible string that could contain secrets from external services

**Example usage**:
```typescript
import { redactSensitiveString } from '@shared/utils/sentryRedaction';

try {
  await validateApiKey(key);
} catch (error) {
  const message = error instanceof Error 
    ? redactSensitiveString(error.message) 
    : 'Validation failed';
  setErrorMessage(message);
}
```

**What gets redacted**:
- API keys: Anthropic (`sk-ant-*`), OpenAI (`sk-*`), Groq (`gsk_*`), Google (`AIza*`), ElevenLabs (`xi-*`)
- Home directory paths: `/Users/name/...` → `~/...`
- Email addresses → `***@***.***`
- Bearer tokens
- Sensitive URL parameters (tokens, secrets, credentials)

**Related utilities**:
- `src/renderer/features/agent-session/utils/toolChips.ts` has `sanitizeCommandForDisplay()` – a display-specific sanitizer for shell commands that strips env vars and redacts secrets while preserving command structure. Keep its API key patterns in sync with `sentryRedaction.ts`.
- `src/main/utils/logRedaction.ts` – main-process specific redaction for log exports.


### Transcript JSONL (full-fidelity conversation transcripts)

In addition to structured Pino logs and session JSON files, Rebel Core writes **full-fidelity JSONL transcripts** to `{userData}/transcripts/{sessionId}.jsonl`. These capture pre-sanitization events (complete tool inputs/outputs, assistant messages, usage per API call, subagent activity) that are truncated or omitted from session JSON and Pino logs.

Transcripts are append-only, fire-and-forget (never block agent turns), and retained for 14 days (cleanup at app startup). They complement session logs and the cost ledger as a third diagnostic data source for conversation investigation.

**When to use transcripts vs other sources:**

| Data source | Content | Best for |
|-------------|---------|----------|
| Session logs (`logs/sessions/`) | Structured operational logs (Pino) | Runtime debugging, MCP issues, performance |
| Session JSON (`sessions/`) | Conversation messages + events (truncated) | UI state, conversation replay, metadata |
| **Transcript JSONL** (`transcripts/`) | Full pre-sanitization events | Deep conversation investigation, full tool I/O |
| Cost ledger (`cost-ledger.jsonl`) | Per-turn API costs | Usage tracking, billing |

See `src/core/services/transcriptService.ts` for implementation and `docs/plans/260413_rebel_core_transcript_logging.md` for design decisions.


### Session log retention

Session logs (per-turn `.log` files under the `sessions/` subdirectory of the log directory) are bounded by three limits, enforced by `cleanupSessionLogs()` in `src/core/logger.ts`:

| Limit | Default | Description |
|-------|---------|-------------|
| **Age** | 14 days | Files older than `retentionDays` are deleted |
| **Count** | 200 files | Oldest files beyond `maxFiles` are deleted |
| **Size** | 250 MB | Oldest files are deleted until total size is under `maxBytes` |

Cleanup runs automatically and includes a 60-second grace floor — files younger than 60 seconds are never deleted regardless of limits. All three bounds are applied in order (age → count → size), with oldest files removed first.

See `src/core/logger.ts` (`SESSION_LOG_DEFAULTS`, `cleanupSessionLogs()`) for implementation and `src/core/__tests__/cleanupSessionLogs.test.ts` for test coverage.


### Maintenance

- When adding new subsystems or long‑running workflows, use `createScopedLogger` with stable identifiers so future debugging remains tractable.  
- If you introduce new environment variables that affect logging (e.g. additional redaction settings, alternate destinations), update this document and `SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` together.  
- Keep references in `ARCHITECTURE_OVERVIEW.md`, `SETUP_DEVELOPMENT_ENVIRONMENT.md`, and `SUPERMCP_OVERVIEW.md` pointing here for logging behavior rather than duplicating details.  
- Periodically review log volume and structure in production to ensure logs remain actionable without being excessively noisy or storing unnecessary data.
- When adding new API key patterns to `sentryRedaction.ts`, also update `toolChips.ts` to keep display redaction in sync.



