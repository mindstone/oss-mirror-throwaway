---
description: "Mindstone Rebel startup and Safe Mode architecture — startup phases, recovery triggers, diagnostics, disabled services"
last_updated: "2026-06-20"
---

# App Startup

Overview of Mindstone Rebel's startup sequence and recovery mechanisms, including Safe Mode for troubleshooting startup failures.

## See Also

- [DIAGNOSTICS.md](./DIAGNOSTICS.md) - Health checks and diagnostic export for troubleshooting.
- [ERROR_MONITORING_AND_SENTRY.md](./ERROR_MONITORING_AND_SENTRY.md) - Error capture and Sentry integration.
- [ONBOARDING_SETUP_WIZARD.md](./ONBOARDING_SETUP_WIZARD.md) - First-run experience after startup.
- [AUTHENTICATION.md](./AUTHENTICATION.md) - Auth initialization during startup.
- [LOGGING.md](./LOGGING.md) - Structured logging including startup logs.
- [MCP_ARCHITECTURE.md](./MCP_ARCHITECTURE.md) - MCP server discovery and configuration.
- [SUPERMCP_OVERVIEW.md](./SUPERMCP_OVERVIEW.md) - Super-MCP HTTP server lifecycle.
- `rebel-system/help-for-humans/safe-mode.md` - **End-user documentation** on Safe Mode.
- `src/main/index.ts` - **Canonical source** for startup orchestration.
- `src/main/services/safeModeContext.ts` - Safe Mode context management.
- `src/renderer/components/SafeModeIndicator.tsx` - Safe Mode banner UI.
- `src/renderer/components/StartupRecoveryDialog.tsx` - Startup failure recovery dialog (Super-MCP issues).
- `src/renderer/components/EmergencyStartupRecovery.tsx` - Emergency recovery when settings fail to load.
- `src/main/ipc/appHandlers.ts` - Emergency IPC handlers (`registerEmergencyHandlers`).


## Startup Sequence

The main process startup is orchestrated in `src/main/index.ts` within the `app.on('ready')` handler. Key phases:

1. **Store initialization** - Electron-store setup and migrations
2. **Bundled MCP config** - Write bundled MCP server configurations
3. **Super-MCP HTTP launch** - Start the Super-MCP HTTP server (non-blocking)
4. **Window creation** - Create the main BrowserWindow
5. **IPC handler registration** - Register all IPC handlers

**Non-blocking Super-MCP**: Super-MCP startup is intentionally non-blocking to avoid delaying window creation. The renderer shows a loading state while Super-MCP initializes. If Super-MCP fails to start within 30 seconds, the StartupRecoveryDialog appears offering Safe Mode.

**Emergency Recovery**: If settings fail to load within 15 seconds (before the normal startup flow can even begin), the EmergencyStartupRecovery component appears. This uses fire-and-forget IPC to restart in Safe Mode, which works even when the main process event loop is partially blocked.

**Native startup dialogs are skipped in automated/headless contexts**: Startup-time native OS dialogs (the macOS app-relocation / duplicate-bundle `NSAlert`s) route through a single wrapper, `showStartupMessageBox()` (`src/main/startup/startupDialog.ts`), which no-ops when `isAutomatedOrHeadlessContext()` (`src/main/utils/testIsolation.ts`) is true. That helper builds on the headless-CLI SSOT `isHeadlessCli()` (`src/core/utils/headlessCli.ts`, re-exported from `testIsolation.ts`). A parent-less startup modal blocks the automated/E2E boot (the chronic-E2E launch-hang class), so this is enforced by construction: the `no-raw-startup-dialog` ESLint rule (`eslint-rules/no-raw-startup-dialog.js`) forbids raw `dialog.showMessageBox` in the startup surface, and `no-raw-headless-check` (`eslint-rules/no-raw-headless-check.js`) forbids re-inlining the headless check.

### Startup Milestones

Key startup events are logged for diagnostics:

| Milestone | Description |
|-----------|-------------|
| `app:ready` | Electron app ready event fired |
| `super-mcp:starting` | Super-MCP HTTP server launch initiated |
| `super-mcp:ready` | Super-MCP HTTP server healthy and ready |
| `super-mcp:failed` | Super-MCP startup failed after retries |
| `window:created` | Main BrowserWindow created |
| `ipc:registered` | All IPC handlers registered |

Find these in logs with: `grep "startup:" ~/Library/Application\ Support/mindstone-rebel/logs/*.log`


## Safe Mode

Safe Mode is a recovery mechanism that starts the app with MCP tools disabled, allowing users to troubleshoot startup failures with Rebel's help.

### What Triggers Safe Mode

| Trigger | Reason Code | Description |
|---------|-------------|-------------|
| CLI flag `--safe-mode` | `cli` | User or script explicitly requested Safe Mode |
| Startup timeout | `timeout` | Super-MCP didn't become healthy within 30 seconds |
| Startup failure | `failure` | Super-MCP crashed or failed to initialize, OR settings failed to load (emergency recovery) |
| User request | `user` | User clicked "Enter Safe Mode" in recovery dialog or Settings |

### Entering Safe Mode Manually

Users can proactively enter Safe Mode from **Settings → Advanced (Support tab) → Safe Mode**:
- Click "Enter Safe Mode" button
- Confirm in the dialog (app will restart)
- Useful for troubleshooting tool issues without waiting for startup failures

### What Safe Mode Disables

- **Super-MCP startup** - Skipped entirely
- **MCP tools** - All file tools, web search, integrations unavailable
- **Background MCP operations** - No tool discovery, no MCP health checks

### What Remains Available

- **Conversation** - Chat with Rebel (without tools)
- **Settings** - Full access including Connections, Diagnostics
- **Diagnostic bundle** - Download logs and health report for support

### Reason Tracking

Safe Mode tracks why it was triggered via `SafeModeContext`:

```typescript
interface SafeModeContext {
  isEnabled: boolean;
  reason?: 'cli' | 'timeout' | 'failure' | 'user';
  triggeredAt?: string;           // ISO timestamp
  sentryEventId?: string;         // For support correlation
  errorCategory?: SafeModeErrorCategory;
}
```

**Error categories** (derived from error codes, not raw messages for privacy):
- `port_conflict` - EADDRINUSE
- `config_parse` - JSON parse errors on mcp.json
- `network` - ECONNREFUSED, ETIMEDOUT
- `permission` - EACCES, EPERM
- `process_crash` - Non-zero exit, SIGTERM
- `unknown` - Fallback

The context is persisted via temp file (`userData/safe-mode-context.json`) before restart and read on startup. Files older than 5 minutes are treated as orphans and deleted.

### How the Agent Is Informed

When Safe Mode is active, the system prompt includes a `## Safe Mode Active` section (see `rebel-system/AGENTS.md`) containing:

- Why Safe Mode was triggered (reason code)
- Error category if available
- Sentry Event ID (user can share with support)
- List of what's disabled
- Common causes and troubleshooting guidance
- Honest statement of limitations (agent cannot inspect logs directly)

This allows Rebel to guide users through diagnosis without false promises.

### Safe Mode Banner

The `SafeModeIndicator` component shows:
- Reason-specific message (e.g., "Safe Mode — Started due to startup timeout")
- Tooltip with timestamp, error category, and Sentry ID
- **"Get troubleshooting tips"** button - Prefills composer with diagnostic prompt
- **"Exit & Restart"** button - Clears Safe Mode and relaunches normally

### Exiting Safe Mode

Users exit Safe Mode via:
- **"Exit & Restart"** button in the Safe Mode banner (top of window)
- **"Exit Safe Mode"** button in **Settings → Advanced (Support tab) → Safe Mode**

Both options:
1. Call `app:exit-safe-mode` IPC
2. Relaunch the app without `--safe-mode` flag
3. Resume normal startup sequence

If the underlying issue wasn't fixed, the user may end up back in Safe Mode.


## Startup Logging

Startup events use structured logging with consistent prefixes for easy filtering. See [LOGGING.md](./LOGGING.md) for full logging details.

**Filter startup logs:**
```bash
# Recent startup logs
grep -E "(startup:|super-mcp:)" ~/Library/Application\ Support/mindstone-rebel/logs/main-*.log | tail -50

# Safe Mode context logs
grep "safe-mode" ~/Library/Application\ Support/mindstone-rebel/logs/main-*.log
```


## Troubleshooting Startup Issues

### Port Conflict

**Symptom**: Error category `port_conflict`, logs show EADDRINUSE

**Cause**: Another process using Super-MCP's port

**Fix**:
1. Quit other apps that might run local servers (VS Code extensions, other dev tools)
2. Restart your computer to clear orphaned processes
3. Check Settings > Connections for conflicting MCP servers

### Corrupted MCP Configuration

**Symptom**: Error category `config_parse`

**Cause**: Invalid JSON in `mcp.json`

**Fix**:
1. Settings > Connections > Reset to defaults
2. Or manually delete `~/Library/Application Support/mindstone-rebel/mcp.json` and restart

### Network/Firewall Issues

**Symptom**: Error category `network`, logs show ECONNREFUSED or ETIMEDOUT

**Cause**: Firewall or VPN blocking localhost connections

**Fix**:
1. Check firewall settings allow Rebel to connect to localhost
2. Try disabling VPN temporarily
3. Check antivirus software isn't blocking local network access

### Orphaned Processes

**Symptom**: Repeated startup failures, error category `process_crash`

**Cause**: Previous crash left node/Super-MCP processes running

**Fix**:
1. Restart your computer (safest)
2. Or use system process manager to end orphaned Rebel-related processes

### Permission Issues

**Symptom**: Error category `permission`, logs show EACCES or EPERM

**Cause**: App doesn't have required file access

**Fix**:
1. Check Settings → Advanced (Support tab) for permission issues
2. Grant Rebel access to required directories in system settings
3. Ensure user data directory is writable


## Maintenance

When modifying startup:
- Preserve non-blocking Super-MCP pattern to avoid UI delays
- Ensure Safe Mode context is properly persisted before any relaunch
- Add structured logging for new startup phases
- Update this document for significant changes

When modifying Safe Mode:
- Keep error categories as a controlled enum (no raw error messages)
- Ensure context file TTL handling for orphan cleanup
- Update both `SafeModeIndicator.tsx` and `rebel-system/AGENTS.md` for user-facing changes
