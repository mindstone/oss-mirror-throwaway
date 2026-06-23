---
description: "Electron auto-updater architecture, Pino logging pipeline, and update lifecycle"
last_updated: "2026-03-30"
---

# Auto-Update

How the auto-update system works in Mindstone Rebel, including architecture, troubleshooting, and known issues.

## See Also

**Project Documentation**
- [DISTRIBUTION.md](./DISTRIBUTION.md) - Update feed URLs, code signing, installation guidance
- [BUILD_AND_RELEASE_OVERVIEW.md](./BUILD_AND_RELEASE_OVERVIEW.md) - Release process overview
- [RELEASING.md](./RELEASING.md) - Step-by-step release runbook
- [CI_PIPELINE.md](./CI_PIPELINE.md) - How artifacts get published to GCS
- [PROD_INCIDENT_ROLLBACK.md](./PROD_INCIDENT_ROLLBACK.md) - Recovery when a bad build reaches stable; relies on the forward-only `allowDowngrade = false` behaviour and the `RELEASES.json` cache gotcha documented here
- [FREEZE_UPDATE_FEED.md](./FREEZE_UPDATE_FEED.md) - Step-by-step runbook to freeze the update feed at a previous good version (applies the cache-control gotcha + the two-feed model from this doc)
- [WINDOWS_SUPPORT.md](./WINDOWS_SUPPORT.md) - Windows-specific Squirrel handling and AV resilience

**Research Documentation (Squirrel vs NSIS Migration)**
- [260202_Squirrel_vs_NSIS_Windows_Installer_Deep_Dive.md](../research/260202_Squirrel_vs_NSIS_Windows_Installer_Deep_Dive.md) - **Comprehensive comparison and migration recommendation**
- [260127_Installer_Updater_Recommendation.md](../research/260127_Installer_Updater_Recommendation.md) - NSIS + electron-updater recommendation
- [260127_Bulletproof_Auto_Update_Analysis.md](../research/260127_Bulletproof_Auto_Update_Analysis.md) - Graceful shutdown patterns, race condition analysis
- [260116_Electron_Auto_Update_Best_Practices.md](../research/260116_Electron_Auto_Update_Best_Practices.md) - Comprehensive best practices guide
- [260116_Electron_Auto_Update_Libraries_Comparison.md](../research/260116_Electron_Auto_Update_Libraries_Comparison.md) - electron-updater vs update-electron-app comparison

**Planning Documents (Windows Squirrel Fixes)**
- [260127_Fix_Windows_Squirrel_Download_Quit.md](../plans/finished/260127_Fix_Windows_Squirrel_Download_Quit.md) - Removed watchdog, extended timeout to 5 min
- [260126_Fix_Windows_Squirrel_Background_Download_Quit.md](../plans/obsolete/260126_Fix_Windows_Squirrel_Background_Download_Quit.md) - Download state tracking
- [260126_Fix_Windows_Squirrel_Corruption.md](../plans/finished/260126_Fix_Windows_Squirrel_Corruption.md) - Fixed 5-second force-exit during extraction
- [260124_Bulletproof_Squirrel_Handler.md](../plans/partway/260124_Bulletproof_Squirrel_Handler.md) - Corruption detection, recovery mechanisms

**Source Code**
- `src/main/services/autoUpdateService.ts` - Main update service (check for updates, quitAndInstall)
- `src/main/services/linuxUpdateService.ts` - Linux notification-only update checker
- `src/main/services/updateNotificationState.ts` - Pending update state management
- `src/main/services/gracefulShutdown.ts` - Shutdown sequence with update-aware lock release
- `src/main/services/health/checks/updates.ts` - Health check for update configuration
- `src/renderer/components/UpdateAvailableToast.tsx` - Renderer UI for update notifications (macOS/Windows)
- `src/renderer/components/LinuxUpdateAvailableToast.tsx` - Linux-specific toast with download link
- `src/renderer/hooks/useIpcListeners.ts` - IPC subscription for update events

**External References**
- [Electron autoUpdater API](https://www.electronjs.org/docs/latest/api/auto-updater)
- [update-electron-app](https://github.com/electron/update-electron-app)
- [Squirrel.Mac](https://github.com/Squirrel/Squirrel.Mac) - macOS update mechanism


## Architecture Overview

### Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Update library | `update-electron-app` | Wraps Electron's built-in `autoUpdater` (macOS/Windows) |
| Linux updates | Custom service | Notification-only, user downloads manually |
| Update mechanism | Squirrel.Mac / Squirrel.Windows | Platform-specific binary patching |
| Update hosting | Google Cloud Storage | Static file hosting for manifests and binaries |
| UI layer | Custom React toast | User notification and action buttons |

**Note**: Electron's built-in `autoUpdater` does not support Linux. Linux uses a notification-only approach where users are prompted to download updates manually.

### Update Feed URLs

| Channel | URL |
|---------|-----|
| Stable | `https://storage.googleapis.com/mindstone-rebel/updates/{platform}/{arch}` |
| Beta | `https://storage.googleapis.com/mindstone-rebel/updates-beta/{platform}/{arch}` |

Channel detection uses the executable name (`Mindstone Rebel Beta.app` → beta channel).


## Update Flow

### 1. Automatic Check (every hour)

```
update-electron-app initializes
  → Sets feed URL based on channel
  → Checks for updates every hour
  → Downloads in background if available
  → Fires 'update-downloaded' event
```

### 2. User Notification

When an update is downloaded:

1. **Renderer available**: Send `update:downloaded` IPC to renderer → Show `UpdateAvailableToast`
2. **Renderer unavailable**: Show native `dialog.showMessageBox` as fallback

Toast buttons:
- **"Install & Relaunch"** → Calls `update:install-now` IPC
- **"On Next Launch"** → Dismisses toast; Squirrel applies on next app start

### 3. Install Sequence (`quitAndInstall`)

```typescript
// From safeQuitAndInstallMacOS() in autoUpdateService.ts (macOS)
1. Write install marker (markUpdateInstallRequested)
2. await closeNativeWatchersForUpdate()  // stop libraryBroadcaster + workspace
   // watcher + cloud token relay (bounded, 5s) so no live fsevents instance
   // reaches Node env teardown — see Known Issues below
3. markCleanExit()                        // update quits are clean exits
4. removeBeforeQuitHandlerForUpdate()     // ShipIt compatibility
5. Release single-instance lock (BEFORE quitAndInstall)
6. Spawn relaunch watchdog
7. Set quitting-for-update flag + autoUpdater.quitAndInstall()
   → Squirrel spawns new instance with updated binary
   → Old app receives quit signal
8. Tier-1 (3s app.quit) / tier-2 (8s app.exit) fallbacks if quit doesn't land
// On failure (quitAndInstall throws / install fails): watchers are restored
// via the cleanup's restore() closure and the clean-exit flag is re-armed.
```

**Critical timing**: The single-instance lock must be released BEFORE `quitAndInstall()` because Squirrel spawns the new instance synchronously before triggering the old app's quit sequence. The native watcher cleanup must be awaited BEFORE `removeBeforeQuitHandlerForUpdate()` — after that point the normal before-quit shutdown path is disarmed.


## Known Issues and Troubleshooting

### macOS: "did not shut down correctly" Dialog After an Update (fixed 2026-06-10)

**Symptom**: After "Install & Relaunch", the update applies, but on reopen macOS shows the "did not shut down correctly / reopen windows?" dialog. `

**Symptom**: User clicks "Install & Relaunch", window disappears, but app process stays alive. Update doesn't apply.

**Root cause**: On macOS, closing all windows does NOT quit the app (standard behavior). If `quitAndInstall()` closes windows but something prevents `app.quit()` from completing, the app stays alive in a headless state.

**Possible causes**:
1. Service cleanup taking longer than 5-second timeout
2. File handles or child processes (Super-MCP) not releasing
3. Single-instance lock race condition (fixed in 0.3.7+)

**Debugging**:
1. Check logs at `~/Library/Application Support/mindstone-rebel/logs/`
2. Look for `[UPDATE]` prefixed messages
3. Check if `Super-MCP HTTP server stopped` appears
4. Look for timeout warnings in graceful shutdown

### macOS: SIGABRT in fsevents on "Install & Relaunch" → "did not shut down correctly" dialog

**Symptom**: After clicking "Install & Relaunch" (or the native update dialog), the app crashes (SIGABRT) instead of quitting cleanly; on next launch macOS shows the "did not shut down correctly" / reopen-windows dialog. The persistent crash buffer (`clean-exit-flag.json` → `recentCrashes`) accumulates entries on update cycles.

**Root cause** (fixed 2026-06-10, see `docs-private/investigations/260610_auto_update_error_and_unclean_shutdown.md`): The macOS install path `safeQuitAndInstallMacOS()` removed the before-quit handler and called `quitAndInstall()` without closing the chokidar/fsevents file watchers. The live `fsevents.node` instances reached Node's environment teardown, where the N-API finalizer (`fse_instance_destroy → napi_release_threadsafe_function → uv_mutex_lock`) aborts. Regressed in commit `1cfae0b37` (2026-03-03), which dropped the `gracefulShutdownForUpdate()` call when reworking the relaunch watchdog. The Windows path was unaffected (it kept `gracefulShutdownServicesOnly()`).

**Fix**: `safeQuitAndInstallMacOS()` now awaits `closeNativeWatchersForUpdate()` (stops library broadcaster + workspace watcher + cloud token relay, bounded by a 5s timeout) before disarming the before-quit handler, and calls `markCleanExit()` on the main path. On a failed handoff it restores the watchers and re-arms the clean-exit flag. A `native_watcher_cleanup_timeout` diagnostic event is emitted if cleanup can't finish in time (the install then proceeds anyway — crash risk reverts to the pre-fix baseline, with loud telemetry).

**Secondary effect fixed**: previously `markCleanExit()` ran only in the 8s fallback, so *every* macOS update quit recorded a phantom unclean exit — inflating the crash buffer independent of any real crash.

**Resolved at the class level (2026-06-11)**: the crash recurred on the *normal* quit path with the above fix present — a native fsevents instance can leak below the watcher API (chokidar v3's refcounted instance pool), so awaited closes alone can never fully close the class. Every point-of-no-return exit (including this install sequence's tier-2 `app.exit` fallback) now routes through `immediateExitWithFseventsSweep()` (`src/main/services/finalExit.ts`), which force-stops any leaked fsevents instance at the final moment — a stopped instance provably cannot crash in env teardown. See `docs/plans/260611_fsevents-shutdown-crash/PLAN.md` (evidence: stress 0/30 SIGABRT vs 1/8 before; prod signature Sentry REBEL-1ES).

**The Electron 42 upgrade did NOT retire this — and the sweep is now PERMANENT (2026-06-13, FOX-3487)**: the original FOX-3487 plan assumed the Electron ≥41 (Node ≥24.14) TSFN lifetime fix (nodejs/node#55877) would make an unswept native TSFN teardown safe, retiring the sweep. The 260613 upgrade spike measured the opposite: with the sweep disabled on Electron 42 (Node 24.16), 48/48 leak-injected quits **deadlock** at the exact same finalizer site (`fse_instance_destroy → napi_release_threadsafe_function → __psynch_mutexwait`) — the Node 24 fix keeps the mutex alive, so instead of aborting, the finalizer blocks indefinitely during env teardown (stationary for a 600s probe). Consequences for this updater: (1) a deadlocked quit is **telemetry-blind** — no .ips, no Sentry crash event, a zombie process; (2) `update-electron-app`/Squirrel waits on old-PID exit (the macOS watchdog caps at 120s, §"Update Downloaded But Not Applied"), so a hung quit stalls the install for as long as the process hangs. The sweep (`fseventsLeakGuard` + `finalExit`) is therefore load-bearing forever on every Electron line; **do not retire it**. The post-upgrade leak canary is the *positive* sweep signal, not crash counts: the `fsevents-leak-sweep-stopped-instances` Sentry fingerprint + the `fsevents_leak_sweep` diagnostic-ledger kind (emitted when `sweptCount > 0`), plus the `fsevents-late-quit-mode-watch` >10s-after-quit warning for the residual blind spot. REBEL-1ES (the old SIGABRT signature) going to ~0 on 42 only proves the *signature* is gone — a nonzero sweep count is the real regression signal. Full evidence: `docs/plans/260613_electron42-upgrade/SPIKE_FINDINGS_REPORT.md` §3.

**Latency note**: typical quits are unchanged (sweep adds tens of ms; final-exit median ~70ms inside the existing ~3.2s graceful chain). The *pathological* worst case on the update tier-2 fallback is bounded at ~12.5s (8s tier-2 timer + 0.5s flush fallback + 2s sweep belt + 2s telemetry belt, not strictly additive — a sweep belt-timeout skips telemetry); reachable only if the sweep/flush hang during a failing update quit.

### Update Downloaded But Not Applied on Restart

**Symptom**: User quits and restarts, but same version loads.

**Possible causes**:
1. App process didn't fully quit (see above)
2. Squirrel's update cache was corrupted
3. Downloaded update signature mismatch

**Debugging**:
1. Verify app fully quit: `ps aux | grep -i mindstone`
2. Check Squirrel cache:
   - Stable: `~/Library/Caches/com.mindstone.rebel/ShipIt/`
   - Beta: `~/Library/Caches/com.mindstone.rebel.beta/ShipIt/`
3. Check Pino log output in `~/Library/Application Support/mindstone-rebel/logs/`

### Toast Shows "No Obvious Action"

**Symptom**: Toast appears but buttons don't work or aren't visible.

**Possible causes**:
1. CSS rendering issue
2. IPC handler not responding
3. Toast exiting animation interrupted view

**Debugging**:
1. Open DevTools (Cmd+Opt+I) and check console for `[Update]` logs
2. Verify `window.api.updateInstallNow` is defined

### Windows: Squirrel Path Encoding Error

**Symptom**: Auto-updates silently fail on Windows with certain usernames.

**Root cause**: Squirrel.Windows has issues with paths containing special characters or spaces.

**Error indicators**:
- Error code `4294967295`
- `ArgumentException` in logs

**Mitigation**: The app detects this error and notifies the user via the `update:error` IPC channel with code `SQUIRREL_PATH_ERROR`.

### Toast Doesn't Fire For Up To An Hour After A New Beta Publishes

**Symptom**: A new beta build is published successfully (DMG is downloadable from `rebel.mindstone.com`, `releases-beta/latest.json` reports the new version), but installed apps don't show the auto-update toast for up to an hour after publish. Manual "Check for updates" returns `update-not-available`. After ~1 hour, the toast suddenly appears.

**Root cause**: `Cache-Control` header drift between the two parallel "what's the latest version?" feeds. We have two sources of truth published in CI:

1. **`releases-beta/latest.json`** — used by `versionCheckService.ts` (the "you are several versions behind" banner). The CI uploads this with explicit `Cache-Control:no-cache,no-store,max-age=0,must-revalidate` on the DMG/manifest steps. Always fresh.
2. **`updates-beta/darwin/<arch>/RELEASES.json`** — the Squirrel.Mac feed read by `update-electron-app`. **This is what drives the toast.** The CI uploads this via plain `gsutil -m cp` with no cache-control flag (`.github/workflows/release.yml` lines ~1568-1574), so GCS applies its bucket default of `cache-control: public, max-age=3600`.

When a new beta is published, the Squirrel feed update can be cached for up to 1 hour by any HTTP cache between the user and GCS — including OS-level URL loaders Squirrel.Mac uses. Until that TTL expires, every update check sees the previous `currentRelease`, which (from the user's perspective) matches their installed version, so the response is "no update available".

**How to confirm this is what you're seeing**:

```bash
# 1. Compare what the two feeds report
curl -s https://storage.googleapis.com/mindstone-rebel/releases-beta/latest.json | jq -r '.version'
curl -s https://storage.googleapis.com/mindstone-rebel/updates-beta/darwin/arm64/RELEASES.json | jq -r '.currentRelease'

# 2. Check the cache-control on the Squirrel feed
curl -sI https://storage.googleapis.com/mindstone-rebel/updates-beta/darwin/arm64/RELEASES.json | grep -iE "cache-control|last-modified|x-goog-generation"

# 3. Compare lastCheckAt in the user's auto-update-state.json against
#    the file's last-modified time. If lastCheckAt is < (last-modified + 1h),
#    a stale cache is plausible.
```

If `releases-beta/latest.json` reports a newer version than `updates-beta/.../RELEASES.json` reports as `currentRelease`, the publish step itself failed (different bug — check the `Publish to Google Cloud Storage` job in the release workflow). If both feeds agree but the user's app still says no update, the cache hypothesis fits.

**Fix**: Add `-h "Cache-Control:no-cache,no-store,max-age=0,must-revalidate"` to the `gsutil -m cp` calls for `RELEASES.json` in `.github/workflows/release.yml` (matches the pattern already used for the DMG and connector-catalog uploads). One-line CI change, no app code change required.

**Why this matters**: The freshness mismatch between the two feeds also means the in-app "you're outdated" banner can fire while the auto-update toast stays silent for the same user during that 1-hour window — confusing UX. Treating both feeds with the same cache discipline keeps them in sync.

### Diagnostics Shows Zero Auto-Update Entries

**Symptom**: The diagnostics bundle has no auto-update log entries, making it impossible to tell if updates are checking at all.

**Explanation**: Main-process logs rotate on a 15-minute window. If the user reports the issue long after the update failure, those logs are gone.

**What to check instead**:
1. **`auto-update-state.json`** in the diagnostics bundle — this is the persistent state store and survives restarts. Check `lastCheckAt`, `lastCheckResult`, and `initSucceeded`.
2. **`health.json`** → `autoUpdateHealth` entry — shows whether the updater initialized and any recent errors.
3. If `initSucceeded` is `false` or `null`, the updater never started — check Sentry for `area:auto-update, component:dynamic-import` errors.
4. If `lastCheckAt` is `null`, no update check has ever completed in this installation.

### macOS: App Quits But Doesn't Relaunch

**Symptom**: User clicks "Install & Relaunch", app quits completely, but never restarts. User has to manually reopen the app.

**Root cause**: Known Squirrel.Mac bug (Squirrel/Squirrel.Mac#269) where ShipIt successfully applies the update but fails to spawn the new instance. The `NSWorkspace.openURL()` call fails silently in some scenarios:
- System under memory pressure
- App bundle permissions changed during update
- FileVault-related timing issues on some Macs

**Current mitigation**: ShipIt is solely responsible for launching the updated app after installation. We intentionally do NOT call `app.relaunch()` — an earlier version used it as a fallback, but it caused a race condition where the old app restarted before ShipIt finished copying files, triggering cache corruption ("file doesn't exist" errors in ShipIt_stderr.log).

Instead, `safeQuitAndInstallMacOS()` spawns a **detached relaunch watchdog** (`spawnRelaunchWatchdog()` / `buildWatchdogScript()`) that:

1. Waits for the old Electron PID to exit (cap 120s).
2. Waits for the `ShipIt` daemon to finish its work (polls `pgrep -x ShipIt`, cap 90s). This adapts to big bundles instead of guessing a fixed grace period.
3. Sleeps 3s to let LaunchServices register the new binary.
4. Checks if the new app is running via `pgrep -f <exePath>`, filtering out the watchdog shell's own PID via `$$`. **We cannot use `pgrep -x <appName>`** — Darwin's kernel `p_comm` truncates process names to ~16 chars, so `pgrep -x 'Mindstone Rebel Beta'` (20 chars) never matches.
5. If the app isn't running, launches the bundle via `open`.
6. Writes a JSON telemetry file to `<userData>/auto-update-watchdog-telemetry.json` so the next launch can record what happened.

The next app launch calls `consumeWatchdogTelemetryOnStartup()` early in `initAutoUpdater()`, which reads the file, persists the outcome into `auto-update-state.json` (`watchdogLastRanAt`, `watchdogOldPidWaitSec`, `watchdogShipItWaitSec`, `watchdogAppAlreadyRunning`, `watchdogOpenFired`), then deletes it.

See: `docs/plans/finished/260131_auto_update_shipit_cache_corruption.md`, `docs/plans/finished/260129_auto_update_relaunch_failure.md`, `docs-private/investigations/260223_auto_update_relaunch_regression.md`

**If this still occurs**: Check ShipIt logs at `~/Library/Caches/com.mindstone.rebel.ShipIt/` (or `.rebel.beta.ShipIt/` for beta). The persistent state store (`auto-update-state.json` in the diagnostics bundle) now includes watchdog telemetry — look for the `watchdog*` fields to see whether the watchdog ran, how long ShipIt took, and whether `open` had to fire.


## State Management

### In-Memory State (`updateNotificationState.ts`)

```typescript
pendingDownloadedUpdate: {
  updateKey: string;       // "beta:darwin:arm64:0.3.7"
  versionLabel: string;    // "0.3.7"
  downloadedAt: number;    // timestamp
  downloadUrl?: string;    // Linux only: URL for manual download
}
```

**Important**: This state is NOT persisted. If the app crashes or force-quits, the state is lost. The "On Next Launch" option relies on Squirrel's internal cache, not this state.

### Persistent State Store (`autoUpdateStateStore.ts`)

A separate persistent store captures the latest update lifecycle state for diagnostics. Unlike in-memory state, this survives restarts and is included in the diagnostics bundle as `auto-update-state.json`.

See the [Observability → Persistent State Store](#persistent-state-store-auto-update-statejson) section for field details.

**Source**: `src/main/services/autoUpdateStateStore.ts`

### Acknowledgment Tracking

To prevent toast spam:
- `acknowledgedUpdateKeys` tracks which updates the user has dismissed
- Cleared when a new `updateKey` is set (different version)
- Checked before showing toast to renderer


## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `check-for-updates` | R→M | Manual update check from Settings |
| `update:downloaded` | M→R | Notify renderer of downloaded update |
| `update:get-pending-downloaded` | R→M | Pull pending update state on startup |
| `update:acknowledge` | R→M | Mark update key as acknowledged |
| `update:acknowledge-toast` | R→M | Legacy: mark toast as acknowledged (backward compat) |
| `update:install-now` | R→M | Trigger quitAndInstall |
| `update:install-failed` | M→R | Notify renderer if install failed |
| `update:not-available` | M→R | No update available (for UI feedback) |
| `update:error` | M→R | Error occurred (e.g., Squirrel path issue) |

**Note**: In development mode and headless CLI mode (`--headless-cli`), `check-for-updates` returns a stub response indicating updates are disabled.


## Observability

All auto-update activity is instrumented for post-hoc diagnosis, even when the 15-minute log window has expired.

### Logging

All updater logs flow through the canonical pino pipeline (replaced `electron-log` with a pino-backed adapter). This means update lifecycle events appear in:
- The diagnostics bundle main-process logs
- Sentry log attachments (when errors are captured)
- The 15-minute log window available via `logExportService`

Library-originated logs from `update-electron-app` are prefixed with `[updater-lib]` and tagged `{ source: 'update-electron-app' }` to distinguish them from our own update logs.

### Persistent State Store (`auto-update-state.json`)

A persistent JSON file in `userData` captures the latest update lifecycle state. It survives app restarts, making it the primary diagnostic data source when users report issues after the log window has passed.

**Location**: `~/Library/Application Support/mindstone-rebel/auto-update-state.json` (macOS) or equivalent `userData` path on Windows.

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `lastCheckAt` | `number \| null` | Timestamp of the most recent update check |
| `lastCheckResult` | `'available' \| 'not-available' \| 'error' \| null` | Result of the most recent check |
| `lastCheckUrl` | `string \| null` | Feed URL used for the most recent check |
| `lastErrorAt` | `number \| null` | Timestamp of the most recent error |
| `lastErrorMessage` | `string \| null` | Error message (truncated to 500 chars) |
| `lastDownloadedVersion` | `string \| null` | Version string of the last successfully downloaded update |
| `lastDownloadedAt` | `number \| null` | Timestamp of the last successful download |
| `initSucceeded` | `boolean \| null` | Whether the auto-updater initialized successfully |
| `appVersionAtLastEvent` | `string \| null` | App version when the last event was recorded |
| `watchdogLastRanAt` | `number \| null` | macOS only. Timestamp (ms) when the relaunch watchdog last completed its poll + open sequence. Populated on the launch AFTER an "Install & Relaunch". |
| `watchdogOldPidWaitSec` | `number \| null` | macOS only. Seconds the watchdog waited for the old Electron PID to exit (0–120). |
| `watchdogShipItWaitSec` | `number \| null` | macOS only. Seconds the watchdog waited for the ShipIt daemon to exit (0–90). High values indicate slow-disk / AV interference. |
| `watchdogAppAlreadyRunning` | `boolean \| null` | macOS only. Whether the new app was already running (i.e. ShipIt successfully relaunched it) when the watchdog checked. |
| `watchdogOpenFired` | `boolean \| null` | macOS only. Whether the watchdog's `open <bundlePath>` call succeeded. Approximates "the watchdog rescued the relaunch", but note: if ShipIt aborted pre-copy, `open` may have relaunched the OLD bundle; a small race also exists between the pgrep check and `open`. |

**Source**: `src/main/services/autoUpdateStateStore.ts`

### Sentry Instrumentation

Sentry captures are limited to actionable failures (per the decision matrix in `ERROR_MONITORING_AND_SENTRY.md`):

| Event | Capture | Cooldown |
|-------|---------|----------|
| Dynamic import failure (init) | `captureMainException` | 1 hour (persistent, via electron-store) |
| `safeQuitAndInstall()` failure | `captureMainException` | None (rare, high severity) |
| Repeated autoUpdater errors | `captureMainException` | 1 hour (in-memory) |
| `update-not-available`, normal lifecycle | Not captured | — |
| Lock contention, Squirrel path errors | Not captured (logged only) | — |

The persistent cooldown for init failures uses a separate `auto-update-init-cooldown` electron-store to prevent flood from crash loops.

### Health Check

The `autoUpdateHealth` health check (`src/main/services/health/checks/updates.ts`) reads the persistent state store and reports:
- **pass**: Auto-updater initialized, no recent errors
- **warn**: Init failed, or error within the last hour
- **skip**: Development mode (auto-updates disabled)

The full `runtimeState` object is included in the health check `details` for diagnostic visibility.

### Diagnosing "Updates Aren't Working"

1. **Request a diagnostics bundle** from the user (Settings → Export Diagnostics)
2. **Check `auto-update-state.json`** in the bundle — this is the primary data source and survives restarts
3. **Check `health.json`** for the `autoUpdateHealth` entry — shows current status and any warnings
4. **Review main-process logs** for `[auto-update]` and `[updater-lib]` entries
5. **Check Sentry** for recent `area:auto-update` errors with the user's anonymous ID


## Testing Auto-Updates

### Local Testing

Auto-updates only work in packaged builds. For local testing:

1. Build a packaged app: `npm run make`
2. Install the built app
3. Create a higher version build
4. Upload to test GCS bucket
5. Point `updateBaseUrl` to test bucket

### Quick Testing with REBEL_TEST_UPDATE_YAML (Windows)

For faster iteration on update metadata parsing (without CI builds), use the `REBEL_TEST_UPDATE_YAML` environment variable. This intercepts YAML metadata requests while allowing real installer downloads.

**PowerShell:**
```powershell
# Set the test YAML (use backtick for newlines in PowerShell)
$env:REBEL_TEST_UPDATE_YAML = "version: 0.3.999``nfiles:``n  - url: MindstoneRebelBeta-Setup-0.3.999.exe``n    sha512: abc123``n    size: 100``npath: MindstoneRebelBeta-Setup-0.3.999.exe``nsha512: abc123``nreleaseDate: '2026-01-31T00:00:00.000Z'"

# Launch the packaged app
& "C:\Users\$env:USERNAME\AppData\Local\Programs\mindstone-rebel\Mindstone Rebel Beta.exe"
```

**Simulate "no update available":**
```powershell
$env:REBEL_TEST_UPDATE_YAML = "SKIP"
& "C:\Users\$env:USERNAME\AppData\Local\Programs\mindstone-rebel\Mindstone Rebel Beta.exe"
```

**What it does:**
- Intercepts requests for `beta.yml` or `latest.yml`
- Returns the provided YAML content instead of fetching from GCS
- Actual installer downloads still go to the real server
- Logs `[UPDATE-WIN] TEST MODE:` messages for visibility

**Limitations:**
- Only works on Windows (electron-updater path)
- Must be a packaged build (not dev mode)
- Won't test actual installer download/verification (only metadata parsing)

### Manual Version Check

```bash
# Check what version is live on stable
curl -s https://storage.googleapis.com/mindstone-rebel/updates/darwin/arm64/RELEASES.json | jq .

# Check what version is live on beta
curl -s https://storage.googleapis.com/mindstone-rebel/updates-beta/darwin/arm64/RELEASES.json | jq .
```


## Future Improvements

Potential enhancements identified from research and bug reports:

1. **Persist pending update state** - Store to electron-store so "On Next Launch" survives force-quit
2. **Add explicit app.quit() after quitAndInstall()** - Belt-and-suspenders for macOS
3. **Extend shutdown timeout** - 5 seconds may be too short for service cleanup
4. **Force quit fallback** - If graceful shutdown times out during update, call `app.exit(0)` immediately
5. **Migrate to electron-updater** - Better Linux support, differential updates, more control (see research docs)

### Strategic Direction: NSIS Migration

> **Important**: As of Feb 2026, we are evaluating migrating Windows from Squirrel.Windows to NSIS.
> See [260202_Squirrel_vs_NSIS_Windows_Installer_Deep_Dive.md](../research/260202_Squirrel_vs_NSIS_Windows_Installer_Deep_Dive.md) for full analysis.

**Why migrate?**
- Squirrel.Windows is unmaintained (last release 2020, officially abandoned since 2019)
- Persistent reliability issues: corruption during quit, race conditions, path encoding bugs
- Multiple defensive fixes in Jan 2026 (see planning docs above) add complexity

**Proposed approach (Harry's hybrid):**
- Keep Electron Forge for packaging (preserves complex `forge.config.cjs`)
- Use electron-builder ONLY to create NSIS installer on Forge-packaged app
- Use `electron-updater` for Windows auto-updates
- Optionally migrate macOS to `electron-updater` for unified codepath

**Status:** Under evaluation. See research doc for full recommendation.


## Maintenance

When modifying auto-update code:

1. Test on all platforms (macOS Intel, macOS ARM, Windows)
2. Test both "Install Now" and "On Next Launch" flows
3. Verify single-instance lock behavior with multiple windows
4. Check graceful shutdown completes within timeout
5. Test fallback to native dialog when renderer is unavailable
