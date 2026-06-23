---
description: "Windows-specific Electron GPU and rendering performance tracker — implemented optimisations, deferred flags, file-watching risks"
last_updated: "2026-05-15"
---

# Windows GPU & Rendering Performance

> **Status**: Tracking document for Windows-specific GPU/rendering optimizations  
> **Created**: 2026-02-03  
> **Related**: [WINDOWS_SUPPORT.md](./WINDOWS_SUPPORT.md), [NSIS Investigation](../plans/finished/260203_nsis_investigation.md) (installer size, startup time root causes)

## Overview

This document tracks GPU and rendering configuration recommendations for improving Electron app performance on Windows, and our implementation decisions for each.

## Current Electron Version

**Electron 39.2.4** - Well above the 27+ threshold required for the DWM opacity fix (which resolved 16-18% unnecessary DWM GPU usage during video playback).

## Recommendations Tracker

### ✅ Already Implemented

| Feature | Location | Notes |
|---------|----------|-------|
| Anti-throttling switches | `src/main/index.ts` | `disable-renderer-backgrounding`, `disable-background-timer-throttling` (Windows only) |
| Crash handling | `src/main/index.ts` | `render-process-gone`, `child-process-gone` events |
| GPU worker recovery | `src/main/services/gpuEmbeddingBackend.ts` | Handles `render-process-gone` for GPU worker, triggers recovery |
| GPU idle disposal sync | `src/main/services/embeddingService.ts` | Disposal callback, lazy re-init, mutex guard for GPU backend lifecycle (2026-02-05) |
| Electron 27+ DWM fix | `package.json` | Using Electron 39.2.4 |
| GPU crash logging | `src/main/index.ts` | Enhanced `child-process-gone` to log "GPU process crashed" when `type === 'GPU'` (2026-02-03) |
| SHA-256 code signing | `.github/workflows/release.yml` | Azure Trusted Signing with `file-digest: SHA256`, `timestamp-digest: SHA256` |
| Azure Trusted Signing | `electron-builder.cjs` | Using Azure Trusted Signing (~$10/month vs $300-500/year EV) for SmartScreen trust |
| Sign all executables | `.github/workflows/release.yml` | App, ripgrep, bundled Node.js, NSIS installer all signed |
| AV warmup service | `src/main/services/systemHealthService.ts` | `warmupAVSensitiveExecutables()` reads executables during startup to trigger Defender scans early |
| GPU info diagnostics | `src/main/index.ts` | `app.getGPUInfo('complete')` logged at startup for hardware debugging (2026-02-03) |
| Listener leak detection | `src/main/index.ts` | `process.on('warning')` handler logs `MaxListenersExceededWarning` events (2026-02-03) |
| Tool index race conditions fix | `src/main/services/toolIndexService.ts` | Fixed race conditions and connection leaks in tool index operations (2026-02-04) |
| Deferred tool index refresh | `src/main/services/toolIndexService.ts` | Defer tool index refresh 120s on startup to reduce initial load (2026-02-04) |
| Squirrel MAX_PATH fix | `forge.config.cjs` | Strip `dist-test` dirs to avoid Squirrel MAX_PATH (260 char) failures on Windows (2026-02-04) |
| MCP bundling optimization | `scripts/build-bundled-mcps.mjs` | Bundle 13 MCPs with esbuild, exclude unused MCPs (~77MB savings) (2026-02-04) |
| Strip rebel-system dev files | `forge.config.cjs` | Exclude node_modules, cli, scripts from rebel-system (~40MB savings) (2026-02-05) |
| Embedding worker diagnostics | `src/main/workers/embeddingWorker.ts` | Added CPU/memory logging every 50 batches for debugging (2026-02-04) |

### ⏳ Under Consideration

| Feature | Recommendation | Risk | Decision | Notes |
|---------|---------------|------|----------|-------|
| `use-angle=d3d11` | Consider | Medium | **Wait for user reports** | Forces D3D11 via ANGLE. Only implement if users report software rendering fallback issues. Could bypass Chromium's GPU blocklist. |
| `enable-gpu-rasterization` | Consider | Medium | **Not recommended** | Has 2024/2025 bug reports about graphical glitches on RTX 4000 series. Risk outweighs benefit. |
| `enable-zero-copy` | Consider | Medium | **Wait for user reports** | Reduces memory copies but depends on driver support. Only implement if profiling shows memory bandwidth issues. |
| Disable `CalculateNativeWinOcclusion` | Conditional | Medium | **Wait for user reports** | Fixes window-switching lag but increases power consumption (hidden windows keep rendering). Only implement if users report multi-monitor lag. |

### 🔮 Consider Later (Background Throttling & Idle CPU)

These recommendations came from a 2026-02-03 research investigation into Windows performance best practices.

| Feature | Recommendation | Risk | Decision | Notes |
|---------|---------------|------|----------|-------|
| Global CSS animation pause | **Implement** | Low | ✅ **Implemented** | `body.app-hidden` class toggled on `visibilitychange`, pauses all animations including pseudo-elements (aurora). See `src/renderer/App.tsx` and `src/renderer/styles/index.css`. |
| Main process visibility throttling | **Implement** | Low | ✅ **Implemented** | Created `src/main/services/visibilityAwareScheduler.ts` with `createPausableInterval()` and `createThrottledInterval()` APIs. Uses `minimize`/`restore` + `focus`/`blur` events. |
| Migrate non-critical intervals | **Implement** | Low | ✅ **Implemented** | Migrated memory diagnostics, stale embedding checks, and session coaching to pause when hidden. Calendar/meeting intervals intentionally kept active. |
| Convert raw `setInterval` to visibility-aware | Consider | Low | **Consider Later** | Several renderer polls use raw `setInterval` without visibility gating. Should audit and convert remaining calls to `useVisibilityAwareInterval`. Lower priority since main intervals are more impactful. |
| Re-enable `backgroundThrottling: true` for GPU worker | Consider | Medium | **Consider Later** | Currently disabled for WebGPU reliability. With existing Phase 1 `setThrottling()` logic, may be safe to enable. Requires Windows WebGPU testing before implementation. |
| Battery-aware background throttling | **Implement** | Low | ✅ **Implemented** | Extended `visibilityAwareScheduler.ts` with battery state detection via `powerMonitor`. Added `createBatteryThrottledInterval()` API. Calendar sync (15→30min) and external provider polling (30→60min) now throttle on battery. See `docs/plans/finished/260203_battery_power_management.md`. |

### 🔮 Consider Later (File Watching / Chokidar)

These recommendations came from a 2026-02-04 research investigation into Chokidar performance on Windows. See also: `docs/plans/partway/260121_workspace_edge_cases.md`.

| Feature | Recommendation | Risk | Decision | Notes |
|---------|---------------|------|----------|-------|
| Replace Chokidar with `@parcel/watcher` | **Not yet** | High | **Needs telemetry first** | Claimed 5-10x improvement, but internal investigation found no direct evidence Chokidar is the root cause of Windows issues. LanceDB I/O contention was more likely. @parcel/watcher is NOT a drop-in replacement (missing `awaitWriteFinish`, `ready`, `ignoreInitial:false`, `depth`). Would require significant refactoring. |
| Symlink/junction telemetry | **Implement** | None | ✅ **Implemented** | Added telemetry to detect workspace symlinks that could cause "explosion" (watching huge external trees). Logs symlink count, targets, cloud storage detection. See `fileWatcherService.ts` and `workspaceWatcherService.ts`. |
| Memory telemetry (before/after watcher) | **Implement** | None | ✅ **Implemented** | Added heap/RSS delta logging when watchers start to measure Chokidar memory impact. Warns if >100MB growth. Fires once per app session. |
| Warn on large directory count | **Implement** | None | ✅ **Implemented** | Warns if watching >5000 directories (potential symlink explosion). |
| Disable `followSymlinks` on Windows | Consider | Medium | **Needs data** | Would prevent junction explosion but could break users who intentionally symlink spaces. Wait for telemetry data before deciding. |
| Symlink depth limit | Consider | Low | **Needs data** | Stop following symlinks after 1-2 hops. Less disruptive than full disable. Wait for telemetry data. |

**Research findings (2026-02-04)**:

External evidence confirms Chokidar CAN cause issues on Windows:
- GitHub issue #1162: ~100k files → 1GB RAM + 50% CPU (with polling)
- GitHub issue #228: 40k files → 400MB+ memory
- GitHub issue #1282: CPU spikes even with ignored directories

However, our internal investigation found:
1. Current config uses `usePolling: false` (avoids the worst mode)
2. Main documented Windows perf issue was **LanceDB I/O contention**, not file watching
3. No Sentry reports attributing CPU/memory to Chokidar

The **one credible risk** is junction/symlink explosion: `followSymlinks: true` + junction to huge tree (e.g., entire Google Drive) = Chokidar watches everything.

**Files involved**:
- `src/main/services/fileWatcherService.ts` - Semantic search indexing watcher
- `src/main/services/workspaceWatcherService.ts` - UI refresh watcher
- `super-mcp/src/configWatcher.ts` - Config hot-reload (low risk, watches specific files)

### ❌ Not Implementing

| Feature | Reason |
|---------|--------|
| `app.getGPUFeatureStatus()` | **Deprecated/removed** in modern Electron. We use `app.getGPUInfo('complete')` instead (see ✅ above) |
| `gpu-process-crashed` event | **Removed in Electron 29**. GPU crashes are captured by `child-process-gone` with `type === 'GPU'` (which we now log specifically) |
| `sandbox: true` on renderers | Worth considering for **security hardening**, but not a perf win. Currently disabled (`sandbox: false`) due to preload/IPC complexity. Would require audit of preload scripts. |
| Local STT sync isolation | `recognizer.decode()` in `localSttService.ts` may block main process, but this is a low-usage code path. Only optimize if users report responsiveness issues on Windows during voice input. |

## Detailed Analysis

### 1. GPU Acceleration Switches

```javascript
app.commandLine.appendSwitch('use-angle', 'd3d11');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
```

**Claimed benefit**: Prevents silent fallback to software rendering, 20-40% CPU savings.

**Reality check**:
- These are legitimate Chromium switches
- `use-angle=d3d11` forces Direct3D 11 (often the default anyway, but makes it explicit)
- `enable-gpu-rasterization` offloads painting to GPU
- `enable-zero-copy` reduces CPU↔GPU memory copying

**Risks**:
- Can bypass Chromium's internal GPU blocklist
- `enable-gpu-rasterization` has 2024/2025 bug reports about graphical glitches on RTX 4000 series
- May cause crashes on older or buggy graphics drivers

**Recommendation**: If implementing, consider:
- Adding a "Safe Mode" that disables these switches
- Telemetry to detect GPU-related crashes
- User-facing setting to disable hardware acceleration

### 2. Windows Native Occlusion Detection

```javascript
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
```

**Claimed benefit**: Fixes stuttering/lag when switching windows, especially on multi-monitor setups.

**Reality check**:
- This is a known workaround for a real Chromium/Windows issue
- The native occlusion API tells Chromium when windows are covered, but the calculation causes overhead
- Disabling forces windows to keep rendering even when hidden

**Trade-off**: Smoothness vs. power efficiency. Hidden windows continue rendering.

**Recommendation**: Only implement if users report window-switching lag. Could be behind a setting.

### 3. GPU Process Crash Handler

```javascript
// DEPRECATED - removed in Electron 29
app.on('gpu-process-crashed', (event, killed) => { ... });

// CORRECT APPROACH - use child-process-gone with type check
app.on('child-process-gone', (_event, details) => {
  const isGpuProcess = details?.type === 'GPU';
  logger.error({ ... }, isGpuProcess ? 'GPU process crashed' : 'Child process terminated');
});
```

**Claimed benefit**: Prevents silent degradation to software rendering after GPU crash.

**Reality check**:
- The `gpu-process-crashed` event was **removed in Electron 29**
- GPU crashes are now captured by `child-process-gone` with `details.type === 'GPU'`
- We already had `child-process-gone` handling; we enhanced it to log GPU crashes specifically

**Status**: ✅ **Implemented** (2026-02-03) - Enhanced `child-process-gone` handler to differentiate GPU crashes in logs.

### 4. GPU Compositing Status Check (DEPRECATED)

```javascript
// DON'T USE - DEPRECATED
const gpuStatus = app.getGPUFeatureStatus();

// USE INSTEAD (if needed)
const gpuInfo = await app.getGPUInfo('complete');
```

**Status**: The `getGPUFeatureStatus()` API was deprecated around Electron 4-5 and removed.

**Alternative**: Use `app.getGPUInfo('complete')` for diagnostic data about GPU capabilities.

**Recommendation**: Not implementing the original suggestion. If we need GPU diagnostics, use the modern API.

## Implementation Plan

### Phase 1: Safe Improvements (No Risk)
- [x] ~~Add `gpu-process-crashed` event handler~~ → Enhanced `child-process-gone` to log GPU crashes specifically (2026-02-03)

### Phase 2: Conditional Improvements (User-Report Driven)

**Do not implement proactively.** These optimizations have trade-offs and should only be added if users report specific issues:

- [ ] GPU acceleration switches (`use-angle`, `enable-zero-copy`) - Only if users report software rendering fallback
- [ ] Disable `CalculateNativeWinOcclusion` - Only if users report window-switching lag on multi-monitor setups
- [ ] `enable-gpu-rasterization` - **Not recommended** due to reported glitches on RTX 4000 series

### Phase 3: Diagnostics
- [x] Add `app.getGPUInfo()` call at startup for telemetry (to understand user hardware distribution) - **Implemented** (2026-02-03)
- [x] Add listener leak detection via `MaxListenersExceededWarning` handler - **Implemented** (2026-02-03)

## References

- [Electron Command Line Switches](https://www.electronjs.org/docs/latest/api/command-line-switches)
- [Chromium GPU Blocklist](https://chromium.googlesource.com/chromium/src/+/main/gpu/config/software_rendering_list.json)
- [Electron app.getGPUInfo()](https://www.electronjs.org/docs/latest/api/app#appgetgpuinfoinfoType)
- Related issue: DWM opacity fix in Electron 27+

---

## IPC Performance Best Practices

> **Status**: Audited 2026-02-03  
> **Source**: External research on Electron Windows performance

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| Avoid `ipcRenderer.sendSync()` | **Partially compliant** | **Keep current usage** | Two legitimate exceptions exist (see below) |
| Remove IPC listeners on cleanup | **Compliant** | No action | All subscription APIs return proper cleanup functions |
| Keep preload "thin" | **Compliant** | No action | Preload has minimal work; Sentry IPC + config bootstrap are acceptable |
| Use MessagePort for high-frequency data | **Not implemented** | **Defer** | Current IPC sufficient; optimize if profiling shows issues |
| Use `contextBridge.exposeInMainWorld()` | **Compliant** | No action | `contextIsolation: true`, proper exposure pattern |

### Detailed Findings

#### 1. `sendSync` Usage (Intentionally Kept)

Two `sendSync` calls exist and are **intentionally kept**:

**`sessions:save-sync`** - Used in `beforeunload` handler
- **Why sync?** Async `invoke()` won't complete before the window closes - the Promise is abandoned mid-flight
- **Location**: `src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts` (beforeunload handler)
- **Risk if removed**: Session data loss on window close, especially in dev mode with HMR
- **Decision**: **Keep** - Critical for data integrity

**`runtime-config:sync`** - Used at preload module load  
- **Why sync?** Bootstraps runtime config before renderer initializes
- **Mitigation**: Main process pre-warms the cache, so the sync call reads from memory (fast)
- **Location**: `src/preload/index.ts`
- **Decision**: **Keep** - One-time startup cost, already optimized

#### 2. IPC Listener Cleanup (Compliant)

All subscription-style APIs (`onXxx`) return cleanup functions that properly remove listeners:
```typescript
onTtsChunk: (callback) => {
  const listener = (_, chunk) => callback(chunk);
  ipcRenderer.on('voice:tts-chunk', listener);
  return () => void ipcRenderer.removeListener('voice:tts-chunk', listener);  // ✓ Proper cleanup
},
```

**`notification:clicked` special case**: This listener is registered at module load and intentionally kept alive for the renderer lifetime. It uses closure-based buffering to capture clicks that arrive before the React subscriber registers. The returned "cleanup" nulls the subscriber but keeps the underlying listener - this is **intentional design**, not a leak. Listener count is always exactly 1.

#### 3. Preload Script Weight (Acceptable)

The preload script (`src/preload/index.ts`) performs minimal work at module load:
- Sentry IPC bridge setup (lightweight, no external requires)
- Sync runtime config fetch (pre-warmed cache, fast)
- E2E diagnostic logging (dev-only)

No heavy Node modules (`fs`, `child_process`, etc.) are required at module load. Most imports are `import type` which erase at build time.

#### 4. MessagePort for High-Frequency Data (Deferred)

Current high-frequency streams use standard IPC events:
- `agent:event` - Agent turn events with deltas
- `voice:tts-chunk` - TTS audio streaming

**Decision**: **Defer** implementation of MessagePort/MessageChannel. The current IPC pattern is working well. Only optimize if:
- Profiling shows IPC as a bottleneck
- Users report audio streaming issues
- Main process CPU is high during agent turns

---

---

## Memory Leak Prevention Best Practices

> **Status**: Audited 2026-02-03  
> **Source**: External research on Electron Windows performance (long-running apps)

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| No event listener leaks | ✅ **Compliant** | No action | Preload uses "return unsubscribe" pattern; React hooks clean up in `useEffect`; main process uses `.off()` before `.on()` |
| `mainWindow = null` on closed | ✅ **Compliant** | No action | Implemented in `src/main/index.ts:1419-1421` |
| `app.getAppMetrics()` monitoring | ✅ **Compliant** | No action | Used for periodic memory diagnostics + Sentry watchdog payloads |
| No large objects in closures | ✅ **Compliant** | No action | IPC handlers use `registerHandler.ts` with handler removal; bounded histories with `MAX_MEMORY_HISTORY` |
| `webContents.on('destroyed')` cleanup | ⚠️ **Not explicitly used** | No action | Not needed - code avoids retaining webContents references; uses `isDestroyed()` checks instead |

### Detailed Findings

#### 1. Event Listener Leak Prevention (Compliant)

**Why it matters**: In Electron, apps run for hours/days without page refresh. A component adding `ipcRenderer.on()` without cleanup will leak listeners on every re-mount. After 50 re-renders, you have 50 duplicate listeners.

**What we do**:

- **Preload "subscribe returns unsubscribe" pattern**:
  ```typescript
  // src/preload/index.ts
  onInboxUpdate: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('inbox:update', listener);
    return () => void ipcRenderer.removeListener('inbox:update', listener);  // ✓
  },
  ```

- **React `useEffect` cleanup**:
  ```typescript
  // src/renderer/hooks/useIpcListeners.ts, useAuth.ts, usePendingApprovals.ts
  useEffect(() => {
    const unsubscribe = window.api.onSomeEvent((data) => { ... });
    return () => unsubscribe();  // ✓ Proper cleanup
  }, []);
  ```

- **Main process duplicate prevention**:
  ```typescript
  // src/main/services/gpuEmbeddingBackend.ts:166-168
  ipcMain.off(channel, handler);  // Remove old first
  ipcMain.on(channel, handler);   // Then add new
  ```

- **Explicit shutdown cleanup**:
  ```typescript
  // src/main/services/userEngagementService.ts:155
  shutdownUserEngagementService() {
    ipcMain.removeAllListeners('user:activity-ping');
    // ... stop timers
  }
  ```

#### 2. mainWindow Reference Cleanup (Compliant)

**Why it matters**: BrowserWindow objects hold ~30-80MB of resources. If your variable continues pointing to a closed window, those resources can't be garbage collected.

**What we do**:
```typescript
// src/main/index.ts:386
let mainWindow: BrowserWindow | null = null;

// src/main/index.ts:1419-1421
mainWindow.on('closed', () => {
  mainWindow = null;  // ✓ Break reference chain
});
```

**Additional safeguards**:
- Guard sends: `if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.webContents.send(...) }`
- Dynamic windows (export, GPU worker) also clean up references on close

#### 3. app.getAppMetrics() Usage (Compliant)

**Why it matters**: Windows Task Manager shows multiple `electron.exe` processes but doesn't tell you which is main, renderer, or utility. `getAppMetrics()` provides per-process CPU/memory breakdown.

**What we do**:
- **Periodic diagnostics**: `src/main/index.ts:2783` logs per-process metrics with leak trend analysis in dev
- **Watchdog integration**: `src/main/services/agentTurnExecutor.ts:1668` attaches metrics to Sentry warning payloads

#### 4. Large Object Retention in Closures (Compliant)

**Why it matters**: IPC handlers capture their enclosing scope. If that scope holds large buffers, they're retained forever.

**What we do**:
- **Handler re-registration utility**: `src/main/ipc/utils/registerHandler.ts` calls `ipcMain.removeHandler(channel)` before `ipcMain.handle()` to prevent duplicates during hot reload
- **Bounded histories**: Memory diagnostic history uses `MAX_MEMORY_HISTORY` with shifting to prevent unbounded growth
- **Request cleanup**: `gpuEmbeddingBackend.ts` explicitly clears pending requests and temp listeners in `dispose()`

#### 5. webContents.on('destroyed') Cleanup (Not Needed)

**Why it matters**: If you store `webContents` references in Maps/Sets, you need to remove them when destroyed.

**What we do**: We avoid this pattern entirely:
- Use `BrowserWindow.getAllWindows()` on demand instead of caching
- Check `win.isDestroyed()` / `win.webContents.isDestroyed()` before use
- Null window references on `'closed'` event

**Recommendation**: If we ever introduce Maps keyed by WebContents, add `webContents.once('destroyed', ...)` to clean entries.

### Minor Concerns (Low Priority)

1. **`src/preload/index.ts` notification listener**: The `ipcRenderer.on('notification:clicked')` at module load has no removal function. However, it's intentionally kept for the renderer lifetime (one listener per window, not a leak).

2. **`userEngagementService.ts` powerMonitor listeners**: Removes IPC listeners on shutdown but not `powerMonitor.on()` listeners. Fine since the service is initialized once per app lifetime.

### Verdict

The codebase has **mature, well-implemented memory leak prevention patterns**. The main risk areas (IPC listeners, child processes, window references) are all properly handled with:
- Cleanup functions returned from subscriptions
- Disposal tracking via `isDisposed` flags
- Graceful shutdown service (`src/main/services/gracefulShutdown.ts`)
- Null/destroy checks before accessing windows

**No urgent changes needed.**

---

---

## ASAR Packaging & Build Configuration

> **Status**: Audited 2026-02-03  
> **Source**: External research on Electron Windows performance (startup time, installer size)

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| ASAR packaging enabled | ✅ **Implemented** | No action | `forge.config.cjs` uses `asar: { unpack: ... }` |
| Native modules selectively unpacked | ✅ **Implemented** | No action | Sophisticated handling in `packageAfterCopy` hook |
| Dev dependencies excluded | ✅ **Implemented** | No action | Extensive `stripUnnecessaryFiles()` function |
| Unused locales pruned | ❌ **Not implementing** | **Decided against** | ~40MB savings not worth degraded UX for non-English OS users (context menus, dev tools would show English instead of system language) |

### Why ASAR Matters for Windows

1. **Windows Defender scan reduction**: ASAR bundles files into a single archive. Defender scans one file instead of thousands of `.js` files, dramatically reducing startup time on fresh installs.

2. **MAX_PATH (260-char) avoidance**: Files inside ASAR use virtual paths that don't count toward Windows path limits. This prevents mysterious "file not found" errors with deeply nested `node_modules`.

3. **Faster file reading**: ASAR uses indexed sequential access, which is faster than random access to many individual files (especially on HDDs).

### Detailed Findings

#### 1. ASAR Packaging (Implemented)

**Location**: `forge.config.cjs`

```javascript
packagerConfig: {
  asar: {
    unpack: "{**/workers/**,**/gpu-worker/**,**/node_modules/@lancedb/**}",
  },
}
```

ASAR is enabled via Electron Forge/electron-packager with selective unpacking for workers and LanceDB.

#### 2. Native Module Unpacking (Thoroughly Implemented)

The project goes **beyond** simple `asar.unpack` patterns. In the `packageAfterCopy` hook, native modules are explicitly copied to `app.asar.unpacked/node_modules/`:

| Module | Purpose | Why Unpacked |
|--------|---------|--------------|
| `@lancedb/lancedb` | Vector database | Native `.node` bindings |
| `onnxruntime-node` | ML runtime | Native bindings + platform-specific stripping |
| `@huggingface/transformers` | ML models | ONNX dependencies |
| `@stoprocent/noble` | BLE (Limitless Pendant) | Native bindings |
| `sherpa-onnx-node` | Local STT (Windows) | Native bindings |
| `sherpa-onnx-win-x64` | STT library | Windows-specific native library |
| `@recallai/desktop-sdk` | Meeting detection | Native components |
| `sharp` | Image processing | Native bindings |
| `apache-arrow` | LanceDB dependency | Native bindings |

**Why not just `asarUnpack: "**/*.node"`?** See `docs/project/PACKAGED_DEPENDENCY_NOTES.md` - native modules often need their entire package structure, not just the `.node` file, for runtime module resolution to work.

**Platform-specific stripping**: The build also removes opposite-architecture binaries (e.g., macOS ONNX when building for Windows) to reduce size and avoid codesigning issues.

#### 3. Dev Dependencies & File Exclusion (Extensively Implemented)

**Location**: `forge.config.cjs` `stripUnnecessaryFiles()` function

The build removes from production bundles:

| Category | Patterns Removed |
|----------|------------------|
| **TypeScript** | `.d.ts`, `.d.ts.map`, `.d.cts`, `.d.mts`, `.ts`, `.tsx`, `.cts`, `.mts`, `.tsbuildinfo` |
| **Source maps** | `.js.map`, `.cjs.map`, `.mjs.map` |
| **Documentation** | `README*`, `CHANGELOG*`, `LICENSE*`, `*.md` |
| **Test directories** | `test/`, `tests/`, `__tests__/`, `__mocks__/`, `fixtures/`, `__snapshots__/` |
| **Example directories** | `example/`, `examples/`, `demo/` |
| **CI directories** | `.github/`, `.circleci/`, `.gitlab/` |
| **Build configs** | `.eslint*`, `.prettier*`, `tsconfig*.json`, `gruntfile*`, `gulpfile*` |
| **Build artifacts** | `coverage/`, `bench/`, `build/Release/obj/` (MSBuild intermediates) |

This is applied to:
- `app.asar.unpacked/node_modules`
- `super-mcp/node_modules`

Additionally, sub-bundles are built with `npm ci --omit=dev` to exclude dev dependencies at install time.

#### 4. Locale Pruning (Decided Against - 2026-02-04)

**What it is**: Electron includes ~220 Chromium locale files (~43MB on macOS, ~17MB on Windows). Pruning to English-only could save ~40MB.

**Investigation findings** (2026-02-04):
- Locale files control Chromium's built-in UI strings: context menus ("Copy", "Paste"), dev tools, browser dialogs
- Chromium safely falls back to English if a locale is missing (no crash risk)
- Implementation would be straightforward via `packageAfterCopy` hook

**Why decided against**:
1. **UX degradation for non-English OS users**: A French user on French Windows would see English context menus instead of "Copier", "Coller" - an inconsistent experience
2. **Marginal benefit**: ~40MB savings is modest compared to total app size
3. **Global user base**: Knowledge workers use many system languages even if app content is English

**Conclusion**: The UX tradeoff isn't worth the size savings. Keep all Chromium locales.

### Build Size Diagnostics

The build includes `logLongestPaths()` to identify files approaching MAX_PATH limits, helping catch potential Windows path issues before release.

### References

- `docs/project/PACKAGED_DEPENDENCY_NOTES.md` - Canonical explanation of native module unpacking strategy
- `docs/project/BUILDING.md` - Build scripts and outputs
- `forge.config.cjs` - Primary build configuration with `stripUnnecessaryFiles()` implementation

---

---

## Code Signing & Windows Defender

> **Status**: Audited 2026-02-03  
> **Source**: External research on Electron Windows performance (startup time, SmartScreen trust)  
> **Related**: [WINDOWS_CODESIGNING.md](./WINDOWS_CODESIGNING.md), [WINDOWS_ANTIVIRUS_AND_TRUST.md](./WINDOWS_ANTIVIRUS_AND_TRUST.md)

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| SHA-256 code signing | ✅ **Implemented** | No action | Azure Trusted Signing with `/fd SHA256` and `/td SHA256` |
| EV cert or Azure Trusted Signing | ✅ **Implemented** | No action | Using Azure Trusted Signing (~$10/month, similar trust to EV) |
| Sign all executables | ✅ **Implemented** | No action | App, ripgrep, bundled Node.js, NSIS installer all signed |
| AV warmup to reduce scan delays | ✅ **Implemented** | No action | `warmupAVSensitiveExecutables()` in `systemHealthService.ts` |

### Why This Matters

1. **Windows Defender scan delays**: Electron issue [#29868](https://github.com/electron/electron/issues/29868) documents 1-10+ second startup delays from Defender real-time scanning. Unsigned executables trigger full scans; code signing reduces scan intensity for known publishers.

2. **SmartScreen reputation**: Standard OV certificates require "reputation building" over weeks/months before SmartScreen warnings disappear. EV certificates and Azure Trusted Signing skip this delay (though neither guarantees zero warnings in all cases).

3. **Multiple executables**: Electron apps ship with multiple executables (main, renderer helpers, utility processes). Each unsigned file pays the full scan penalty.

### Detailed Findings

#### 1. SHA-256 Code Signing (Implemented)

**Location**: `.github/workflows/release.yml`, `electron-builder.cjs`

```yaml
# CI signing configuration
file-digest: SHA256
timestamp-rfc3161: http://timestamp.acs.microsoft.com
timestamp-digest: SHA256
```

**What we sign**:
- `Mindstone Rebel.exe` - Main application
- `rg.exe` - Ripgrep (bundled tool)
- `node.exe` - Bundled Node.js runtime
- `*-Setup-*.exe` - NSIS installer

**Why SHA-256?** Windows Defender and SmartScreen have better trust signals for SHA-256 signatures. SHA-1 is deprecated and only needed for Windows 7 (EOL).

#### 2. Azure Trusted Signing (Implemented)

**Location**: `electron-builder.cjs` (`azureSignOptions`), `docs/project/WINDOWS_CODESIGNING.md`

We use Azure Trusted Signing instead of traditional EV certificates:

| Aspect | Azure Trusted Signing | Traditional EV |
|--------|----------------------|----------------|
| **Cost** | ~$10/month | $300-500/year |
| **Setup** | Azure portal + CLI | Hardware token + CA verification |
| **SmartScreen trust** | Similar reputation benefits | Similar reputation benefits |
| **CI integration** | Native Azure action | Requires token driver in CI |

**Note**: Neither EV nor Azure Trusted Signing guarantees zero SmartScreen warnings. Trust is reputation-based and depends on download volume, but both significantly improve odds vs. standard OV certificates.

#### 3. All Executables Signed (Implemented)

**Location**: `.github/workflows/release.yml`

The CI pipeline explicitly signs:
1. **Package app** → `electron-forge package`
2. **Sign app executable** → Azure Trusted Signing action
3. **Sign ripgrep binary** → Explicit `rg.exe` signing for AV hardening
4. **Create NSIS installer** → `electron-builder --prepackaged`
5. **Sign installer** → Azure Trusted Signing action
6. **Regenerate SHA512 hash** → Updates `latest.yml`/`beta.yml` after signing

**Why sign ripgrep?** Third-party binaries bundled with the app also trigger Defender scans. Signing them with our certificate establishes trust.

#### 4. AV Warmup Service (Implemented)

**Location**: `src/main/services/systemHealthService.ts`

```typescript
warmupAVSensitiveExecutables()
```

**What it does**: During startup, reads bundled executables (ripgrep, Node.js, Git) to trigger on-access AV scans before they're needed. This shifts the scan penalty to startup (during splash screen) rather than mid-task.

**Targets**:
- Ripgrep (`rg.exe`)
- Bundled Node.js (`node.exe`)
- Git bash and Git exe (if present)

**Implementation notes**:
- Uses file read (threadpool) instead of spawn to avoid blocking main thread
- Version-based marker to skip redundant warmups on subsequent launches
- Complements code signing (signing reduces scan time; warmup shifts remaining time to startup)

### References

- [Electron Issue #29868](https://github.com/electron/electron/issues/29868) - Defender scan delays
- [Microsoft Defender Performance Troubleshooting](https://learn.microsoft.com/en-us/defender-endpoint/troubleshoot-performance-issues)
- [SmartScreen Best Practices](https://textslashplain.com/2024/11/15/best-practices-for-smartscreen-apprep/)
- [Azure Trusted Signing](https://azure.microsoft.com/en-us/products/artifact-signing)
- `docs/project/WINDOWS_CODESIGNING.md` - Single source of truth for signing configuration
- `docs/project/WINDOWS_ANTIVIRUS_AND_TRUST.md` - Signposting to AV-related planning docs

---

---

## Module Loading & Startup Performance

> **Status**: Audited 2026-02-03  
> **Source**: External research on Electron Windows performance (cold start optimization)  
> **Related**: [docs/plans/finished/260203_windows_startup_performance_optimizations.md](../plans/finished/260203_windows_startup_performance_optimizations.md)

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| Code bundled with Vite/esbuild | ✅ **Implemented** | No action | Electron Forge + Vite bundles main/preload/renderer; ASAR enabled |
| Heavy modules lazy-loaded | ✅ **Implemented** | No action | `mammoth`, `xlsx`, `unpdf` converted to dynamic imports (2026-02-03) |
| Route-based code splitting | ⚠️ **Partial** | **Consider later** | No React Router; feature-based lazy loading could be added |
| V8 code caching enabled | ✅ **Implemented** | No action | `enableCompileCache()` in bootstrap.ts (2026-02-03) |
| Source maps excluded from prod | ✅ **Implemented** | No action | Main/preload/renderer delete after Sentry upload; workers skip in prod (2026-02-03) |

### Why This Matters for Windows

Module loading is **significantly slower on Windows** than macOS due to:
1. **NTFS file operations** are slower than APFS
2. **Windows Defender** may scan each file as it's read
3. **Thousands of node_modules files** means thousands of filesystem reads without bundling

Teams have reported startup improvements from ~10 seconds to ~3 seconds just from proper bundling.

### Detailed Findings

#### 1. Code Bundling (Implemented)

**Location**: `forge.config.cjs`, `vite.*.config.mjs`, `scripts/build-worker.mjs`

The app uses Electron Forge with Vite plugin for bundling:
- **Main process**: Bundled with Vite, most deps inlined, native modules externalized
- **Preload**: Bundled with Vite
- **Renderer**: Bundled with Vite, code-split chunks for lazy loading
- **Workers**: Bundled with esbuild (separate build script)
- **ASAR**: Enabled with selective unpacking for native modules

#### 2. Heavy Module Lazy Loading (Implemented - 2026-02-03)

**Location**: `src/renderer/features/composer/hooks/useFileAttachments.ts`

**Before**: ~1.7MB of document processing libraries loaded at renderer startup
```typescript
import mammoth from 'mammoth';      // ~300KB
import * as XLSX from 'xlsx';       // ~1.2MB
import { extractText } from 'unpdf'; // ~200KB
```

**After**: Libraries loaded only when user attaches a file
```typescript
const extractTextFromWord = async (arrayBuffer: ArrayBuffer) => {
  const mammoth = await import('mammoth');
  // ...
};
```

**Impact**: ~100-300ms reduction in renderer initialization time

#### 3. Route-Based Code Splitting (Partial)

The app doesn't use React Router (single-page Electron app), so traditional route-based splitting doesn't apply. However, feature-based lazy loading is used in some places:
- `AtlasCanvas` - 3D visualization lazy-loaded via `React.lazy()`
- `ink-mde` - Markdown editor dynamically imported when mounted

**Opportunity**: Could add lazy loading for major features (Settings, Library, Inbox panels) that aren't visible at startup. Deferred as lower priority.

#### 4. V8 Code Caching (Implemented - 2026-02-03)

**Location**: `src/main/bootstrap.ts`

```typescript
const { enableCompileCache, constants } = require('node:module');
const result = enableCompileCache();
if (result.status === constants.compileCacheStatus.ENABLED) {
  console.log('[bootstrap] V8 compile cache enabled:', result.directory);
}
```

**What it does**: Persists V8 compiled bytecode to disk, skipping parse/compile on subsequent launches.

**Implementation notes**:
- Uses Node.js 22.8.0+ built-in API (Electron 39 bundles Node 22.21.1)
- Placed after userData setup, before bulk module loading
- Uses synchronous `require()` to avoid top-level await
- Checks `compileCacheStatus` constants for type-safe status handling
- Silent failure for older Node versions

**Impact**: ~50-200ms faster subsequent launches (most benefit on Windows)

#### 5. Source Maps in Production (Implemented - 2026-02-03)

**Location**: `vite.*.config.mjs`, `scripts/build-worker.mjs`, `forge.config.cjs`

| Bundle | Sourcemap Handling |
|--------|-------------------|
| Main process | Generated when Sentry auth present, deleted after upload |
| Preload | Generated when Sentry auth present, deleted after upload |
| Renderer | Generated when Sentry auth present, deleted after upload |
| Workers | Skipped in production/CI (no Sentry integration) |

**Additional safety net**: `forge.config.cjs` filters `.map` files when copying workers to `app.asar.unpacked/`.

**Impact**: ~4.5MB smaller packaged app (worker sourcemaps were previously shipping)

### References

- [Electron Docs: Performance](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Node.js module.enableCompileCache()](https://nodejs.org/api/module.html#moduleenablecompilecachecachedir)
- `docs/plans/finished/260203_windows_startup_performance_optimizations.md` - Full implementation plan

---

---

## Power Management (Battery Optimization)

> **Status**: Implemented 2026-02-03  
> **Source**: External research on Electron Windows performance (laptop battery life)  
> **Related**: [docs/plans/finished/260203_battery_power_management.md](../plans/finished/260203_battery_power_management.md)

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| Handle `powerMonitor` events | ✅ **Implemented** | No action | `on-battery`, `on-ac`, `suspend`, `resume` all handled |
| Adapt behavior on battery | ✅ **Implemented** | No action | Background polling throttled 2x slower on battery |
| Initialize battery state at startup | ✅ **Implemented** | No action | Uses `powerMonitor.isOnBatteryPower()` before any services start |

### Why This Matters for Windows Laptops

Windows laptops make up a large portion of enterprise deployments. When a user unplugs their laptop, they expect battery life measured in hours - but a misbehaving background app can cut that in half.

**Key insight**: Each CPU wake-up prevents the CPU from entering deeper C-states where power consumption drops by 10-100x. A well-optimized background app should minimize wake-ups when idle on battery.

### Detailed Findings

#### 1. powerMonitor Event Handling (Implemented)

**Location**: `src/main/services/visibilityAwareScheduler.ts`, `src/main/index.ts`

| Event | Handler | Purpose |
|-------|---------|---------|
| `on-battery` | `initBatteryScheduler()` | Reschedule battery-throttled intervals at slower rate |
| `on-ac` | `initBatteryScheduler()` | Reschedule battery-throttled intervals at normal rate |
| `suspend` | `index.ts` | Pause automation scheduler, save state |
| `resume` | `index.ts` | Resume automation scheduler, recover Super-MCP |

**Implementation**: Battery state is managed centrally in `visibilityAwareScheduler.ts` via `initBatteryScheduler()`. This initializes from `powerMonitor.isOnBatteryPower()` at startup and registers event handlers.

#### 2. Battery-Aware Polling (Implemented)

**Location**: `src/main/services/visibilityAwareScheduler.ts`

New API: `createBatteryThrottledInterval(callback, normalMs, batteryMs)`

**Migrated services**:

| Service | Normal Interval | Battery Interval | Rationale |
|---------|----------------|------------------|-----------|
| Calendar sync | 15 min | 30 min | Less urgent when conserving power |
| External provider polling | 30 min | 60 min | Background transcript import can wait |

**Not throttled (critical)**:
- Auth heartbeat (1 min) - session validity
- Meeting bot polling (5 min) - active meeting features
- User engagement heartbeat - has own activity checks

**Design decisions**:
- **No catch-up tick on battery→AC**: Unlike visibility throttling, battery transitions don't need immediate data refresh
- **Battery throttling applies in headless mode**: Automations on a laptop should still conserve battery
- **Visibility-pausable services don't need battery handling**: They pause entirely when hidden

#### 3. Startup Initialization (Implemented)

**Location**: `src/main/index.ts` (early in `app.on('ready')`)

```typescript
// Initialize battery-aware scheduler early, before any services start
// This must happen before getMeetingBotService() which starts battery-throttled intervals
initBatteryScheduler();
```

**Why early?** Services like `getMeetingBotService()` start battery-throttled intervals during initialization. If battery state isn't initialized first, intervals would use AC rate even when starting on battery.

### What Was Removed (Dead Code)

The old battery handling in `index.ts` was never actually consumed:
- `backgroundWorkThrottled` flag - set but never read
- `setBackgroundWorkThrottle()` function - called but flag unused
- `shouldDeferBackgroundWork()` function - passed to handlers but interface didn't use it
- `powerMonitor.on('on-battery'/'on-ac')` handlers - now in scheduler

### References

- [Electron powerMonitor API](https://www.electronjs.org/docs/latest/api/power-monitor)
- `docs/plans/finished/260203_battery_power_management.md` - Full implementation plan with triple-review feedback

---

---

## ONNX Runtime Thread Configuration

> **Status**: Investigated 2026-02-04  
> **Source**: External research on ONNX Runtime performance (memory leaks, thread configuration)  
> **Related**: `docs/plans/finished/260124_windows_embedding_thread_limit.md`

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| Session reuse (no create/destroy cycles) | ✅ **Implemented** | No action | Pipeline created once in `initPipeline()` and reused for all requests |
| Tensor disposal after inference | ✅ **Implemented** | No action | `result.dispose?.()` called after each embedding (REBEL-KK) |
| Thread limiting via `OMP_NUM_THREADS` | ✅ **Implemented** | No action | Set to 4 on Windows before worker spawn |
| `executionMode: 'sequential'` | ❌ **Not implementing** | N/A | Already the ONNX Runtime default - would be a no-op |
| `interOpNumThreads: 1` | ❌ **Not implementing** | N/A | Wrong lever - doesn't affect CPU spikes (see analysis below) |
| `intraOpNumThreads` via session_options | ❌ **Not implementing** | N/A | May be ignored by OpenMP-enabled builds (current `OMP_NUM_THREADS` approach is correct) |
| `enableCpuMemArena: false` | ❌ **Not implementing** | N/A | Only relevant for create/destroy cycles; sessions are long-lived |

### External Recommendation (Not Adopted)

An external researcher suggested:
```typescript
session_options: {
  executionMode: 'sequential',
  interOpNumThreads: 1,
}
```

Plus concerns about:
- Memory leaks from session create/destroy cycles (325MB → 994MB)
- `enableCpuMemArena` causing 5.7GB memory usage for a 2MB model

### Investigation Findings (2026-02-04)

**Dual-researcher investigation + triple-review** concluded the recommendations don't apply to this codebase:

#### 1. Memory Leak Concerns: NOT APPLICABLE

Sessions are created **once** and reused for the process lifetime:
- `embeddingWorker.ts:79-82`: `embeddingPipeline = await pipeline(...)` called only in `initPipeline()`
- Tensor disposal already implemented: `result.dispose?.()` at lines 93 and 105
- The reported memory leak only occurs with repeated session create/destroy - we don't do that

#### 2. `executionMode: 'sequential'`: ALREADY THE DEFAULT

ONNX Runtime documentation confirms sequential is the default execution mode. Explicitly setting it would be a no-op.

#### 3. `interOpNumThreads`: WRONG LEVER

- `interOpNumThreads` controls parallelism **across** operators (running different graph nodes simultaneously)
- BGE transformer models have **sequential** layer dependencies (attention → feed-forward → attention → ...)
- The 95%+ CPU spikes are caused by **intra-op** threading (threads **within** MatMul, attention ops)
- The correct lever is `intraOpNumThreads` (or `OMP_NUM_THREADS` env var)

#### 4. `intraOpNumThreads` Session Option: RISKY REPLACEMENT

Triple-review identified a critical issue:

> **ONNX Runtime with OpenMP** (common for `onnxruntime-node`) **ignores `intraOpNumThreads` session option**. Thread control must be via `OMP_NUM_THREADS` environment variable.

The current `OMP_NUM_THREADS=4` approach in `embeddingService.ts:202-204` is:
- The **documented official mechanism** for OpenMP-enabled ONNX builds
- Already working in production
- Lower risk than untested session options

#### 5. `enableCpuMemArena`: NOT A CONCERN

The reported 5.7GB issue relates to create/destroy cycles with arena enabled. Since sessions are long-lived and reused, the default arena behavior is appropriate.

### Current Implementation (Correct)

**Location**: `src/main/services/embeddingService.ts`

```typescript
// On Windows, limit ONNX Runtime threads to prevent 95%+ CPU usage during indexing
const WINDOWS_ONNX_THREAD_LIMIT = 4;

// In worker spawn:
const workerEnv: NodeJS.ProcessEnv =
  process.platform === 'win32' && !process.env.OMP_NUM_THREADS
    ? { ...process.env, OMP_NUM_THREADS: String(WINDOWS_ONNX_THREAD_LIMIT) }
    : process.env;
```

This is the correct approach because:
1. `OMP_NUM_THREADS` is read by OpenMP at process initialization
2. It controls **intra-op** parallelism (the actual heavy compute)
3. It's Windows-only (macOS/Linux handle thread scheduling better)

### Diagnostic Logging (Already Present)

**Location**: `src/main/workers/embeddingWorker.ts`

Memory monitoring logs every 50 batches:
```typescript
console.log(
  `[embeddingWorker] batch ${batchCount}: heapUsed=${...}MB, external=${...}MB, rss=${...}MB`
);
```

The `external` field captures native/ONNX memory outside the V8 heap - critical for detecting ONNX memory issues.

### Future Diagnostic Enhancement

If ONNX memory issues are suspected, add this logging at pipeline initialization:
```typescript
console.log(`[embeddingWorker] init: OMP_NUM_THREADS=${process.env.OMP_NUM_THREADS ?? 'unset'}`);
```

This would confirm the thread limit is actually applied to the worker process.

### References

- [ONNX Runtime Threading Documentation](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)
- `docs/plans/finished/260124_windows_embedding_thread_limit.md` - Original Windows thread limiting investigation
- `docs/plans/finished/260201_rebel_kk_oom_fix.md` - OOM investigation showing tensor disposal fix

---

## Windows Defender Exclusions for File I/O Performance

> **Status**: Investigated 2026-02-04  
> **Source**: External research on Windows Defender impact on Node.js/Electron file I/O  
> **Related**: [WINDOWS_ANTIVIRUS_AND_TRUST.md](./WINDOWS_ANTIVIRUS_AND_TRUST.md), `rebel-system/help-for-humans/windows-security-and-antivirus.md`

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| Document Defender exclusion instructions | ✅ **Already implemented** | No action | User guide exists for 7+ AV products |
| Enterprise IT allowlisting docs | ✅ **Already implemented** | No action | Documented in help-for-humans |
| Programmatic Defender exclusions | ❌ **Not implementing** | N/A | Requires admin, blocked in enterprise, security concern |
| CI pipeline Defender exclusions | ✅ **Already implemented** | No action | Build performance optimization |
| AV warmup service | ✅ **Already implemented** | No action | Pre-scans executables at startup |
| File locking resilience | ✅ **Already implemented** | No action | Retry logic for AV-locked files |
| Recommend Dev Drive (Windows 11) | ⏳ **Consider** | **Add to docs** | Power user recommendation for async scanning |

### External Recommendation (Evaluated)

An external researcher suggested:
- Process exclusions for Electron executable
- Folder exclusions for app data directory (where LanceDB lives)
- Extension exclusions for `.lance` and `.parquet` files
- Recommend Windows 11 "Dev Drive" with Defender Performance Mode

### Evidence Validation (2026-02-04)

**The performance impact is real and well-documented:**

1. **Microsoft Windows-Dev-Performance repo**: Node.js runs ~4x slower on Windows vs Ubuntu (258s vs 65s in GitHub Actions). Root cause tied to filesystem + Defender behaviors.

2. **npm install benchmarks**: ~275% slowdown reported (15 min vs 4 min with Defender on/off) for workloads with many small files.

3. **Electron issue #29868**: Multi-second startup delays from Defender real-time scanning, resolved by disabling RTP or adding exclusions.

4. **Mechanism**: Defender's minifilter driver intercepts file I/O, scanning inline on open/write. Node.js workloads (many small files) are worst-case.

### Our Workload (Matches "Worst Case" Pattern)

rebel-app's indexing and database operations match the high-impact patterns:

| Component | I/O Pattern | Impact |
|-----------|-------------|--------|
| File indexing | `fs.readFile` across many workspace files | Scan-on-read |
| LanceDB writes | `table.add()` creates versioned artifacts | Scan-on-write |
| LanceDB optimize | Compaction creates/rewrites many files | Burst of scans |
| Embedding model cache | Large ONNX file reads | One-time first-run |

**Paths affected**:
- `userData/indices/**/lancedb` - Vector database storage
- `userData/models/transformers` - Embedding model cache

### Investigation Findings (2026-02-04)

**Dual-researcher investigation** found the recommendation is **already comprehensively addressed** via documentation:

#### 1. User-Facing Documentation (Already Exists)

**Location**: `rebel-system/help-for-humans/windows-security-and-antivirus.md`

Includes step-by-step exclusion instructions for:
- Windows Defender (consumer)
- Microsoft Defender for Endpoint (enterprise)
- Norton, McAfee, Bitdefender, Kaspersky, Avast, AVG

#### 2. Enterprise IT Documentation (Already Exists)

Allowlisting guidance for IT administrators deploying to managed Windows devices.

#### 3. Why NOT Programmatic Exclusions

| Concern | Reality |
|---------|---------|
| **Requires admin** | Most users don't run Electron apps as admin |
| **Enterprise blocked** | IT policies typically prevent apps from modifying AV config |
| **Security risk** | Apps modifying their own AV exclusions is a malware pattern |
| **Industry practice** | VS Code, Slack, Discord all use documentation-only approach |

#### 4. Existing Mitigations (Beyond Documentation)

| Feature | Location | Purpose |
|---------|----------|---------|
| AV warmup | `systemHealthService.ts` | Pre-scans executables at startup to shift delay to splash screen |
| File retry logic | Various services | Handles temporary AV locks with exponential backoff |
| Watchdog timers | Turn executor | Detects AV-related delays and logs diagnostics |
| CI Defender exclusions | GitHub Actions | Build/test performance |

### Recommended Addition: Dev Drive Documentation

Windows 11's Dev Drive feature runs Defender in "Performance Mode" (async scanning) which provides most of the benefit without security tradeoffs:

> **Consider adding to user docs**: "For best performance on Windows 11, consider placing your workspaces on a Dev Drive, which uses async Defender scanning."

**Why async is better than exclusions**:
- Still scans files (security maintained)
- Defers scan to after `open()` completes (performance improved)
- Microsoft's recommended approach for developer workloads

### References

- [Microsoft Windows-Dev-Performance Issue #17](https://github.com/microsoft/Windows-Dev-Performance/issues/17)
- [Electron Issue #29868](https://github.com/electron/electron/issues/29868) - Defender scan delays
- [Microsoft Defender Performance Mode](https://learn.microsoft.com/en-us/defender-endpoint/microsoft-defender-endpoint-antivirus-performance-mode)
- [Windows Dev Drive](https://learn.microsoft.com/en-us/windows/dev-drive/)
- `rebel-system/help-for-humans/windows-security-and-antivirus.md` - User-facing exclusion guide

---

## LanceDB Batch Write Performance

> **Status**: Investigated 2026-02-04  
> **Source**: External research on LanceDB write patterns and NTFS performance  
> **Related**: `docs/project/SEMANTIC_SEARCH.md`, `docs/research/260204_lancedb_windows_perf_analysis.md`

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| Batch writes (~10K records) | ❌ **Not implementing** | **Too complex** | Would require crash recovery, query consistency, delete handling |
| Periodic `table.optimize()` | ✅ **Implemented** | No action | Compacts fragments every ~500 writes (file index) or ~50 writes (conversation index) |
| Diagnostic timing for writes | ✅ **Implemented** | No action | `embeddingMs` + `writeMs` logged per file (2026-02-04) |
| exFAT detection/warning | ⏳ **Consider** | **Low priority** | LanceDB fails on exFAT; could warn at startup |
| NTFS atime disable docs | ⏳ **Consider** | **Low priority** | Power user optimization |

### External Recommendation (Evaluated)

An external researcher suggested:
> "LanceDB's own documentation explicitly warns that inserting records one at a time creates a new data fragment per insert, leading to suboptimal performance. Since your indexer processes files sequentially and writes after each one, you're creating potentially thousands of tiny fragments. The fix is to buffer embeddings in memory and flush in batches of ~10K records."

### Investigation Findings (2026-02-04)

**Dual-researcher investigation** confirmed the issue exists but is **partially mitigated**:

#### Current Write Patterns

| Service | Write Pattern | Issue? |
|---------|--------------|--------|
| **File indexing** | `table.add(records)` per file | ⚠️ Often 1-row for small files |
| **Conversation indexing** | `table.add([record])` per session | ⚠️ Always 1-row |
| **Tool indexing** | `createTable(TABLE_NAME, records)` bulk | ✅ Properly batched |

**Code locations**:
- File index: `src/main/services/fileIndexService/index.ts` - `indexFileInternal()` writes per-file
- Conversation index: `src/main/services/conversationIndexService.ts` - writes per-session
- Tool index: `src/main/services/toolIndexService.ts` - bulk rebuild (correct pattern)

#### Existing Mitigations

The codebase already addresses fragment accumulation via periodic compaction:

```typescript
// fileIndexService.ts - triggers after ~500 writes
const OPTIMIZE_AFTER_WRITES = 500;
const OPTIMIZE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Calls table.optimize() which compacts fragments
```

This doesn't prevent the initial write overhead but prevents unbounded fragment growth.

#### Why NOT Full Batching

Implementing ~10K record batching would require significant complexity:

| Concern | Complexity |
|---------|------------|
| **Memory pressure** | ~60MB+ RAM for 10K embedding vectors |
| **Crash recovery** | Un-flushed files appear indexed but aren't in DB |
| **Query consistency** | Files in buffer aren't searchable until flush |
| **Delete handling** | User deletes file still in write buffer |
| **Workspace switching** | Must flush buffer on workspace change |
| **Shutdown handling** | Must flush on app quit |

**Risk assessment**: The existing `optimize()` calls handle 80% of the problem. Full batching adds significant state management complexity for diminishing returns.

### Diagnostic Timing (Implemented 2026-02-04)

To determine if LanceDB writes are actually the bottleneck (vs embedding generation), added granular timing:

**Location**: `src/main/services/fileIndexService/index.ts`

```typescript
const embeddingStartMs = Date.now();
const embeddings = await generateEmbeddings(chunks);
const embeddingMs = Date.now() - embeddingStartMs;

const writeStartMs = Date.now();
await currentIndex.table.add(records);
const writeMs = Date.now() - writeStartMs;

logger.debug({ filePath, chunks, embeddingMs, writeMs }, 'Indexed file');
```

**Log output example**:
```
{ filePath: "notes/todo.md", chunks: 1, embeddingMs: 45, writeMs: 12 }
```

**To analyze on Windows**:
```powershell
Select-String "Indexed file" "$env:APPDATA\mindstone-rebel\logs\*.log" | Select-Object -Last 100
```

### Potential Future Optimizations

If diagnostic data shows writes are the dominant bottleneck:

1. **Micro-batching**: Buffer 10-50 files before flush (smaller than 10K, simpler state)
2. **Write coalescing**: Debounce rapid file changes before indexing
3. **Background write queue**: Decouple indexing from file watcher with async queue

### References

- [LanceDB Performance Tips](https://lancedb.github.io/lancedb/guides/performance/)
- `docs/project/SEMANTIC_SEARCH.md` - Hybrid search architecture
- `src/main/services/fileIndexService/index.ts` - File indexing implementation

---

## Sequential 20ms Delay / Worker Pool Recommendation

> **Status**: Investigated 2026-02-04  
> **Source**: External research on file indexing throughput optimization  
> **Related**: `src/main/services/fileWatcherService.ts`, `src/main/services/embeddingService.ts`

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| Replace `setTimeout(20)` with `setImmediate()` | ❌ **Not implementing** | N/A | Marginal benefit (~10%), risk to UI responsiveness |
| Piscina worker pool (2-4 workers) | ❌ **Not implementing** | N/A | Conflicts with single-writer pattern; LanceDB not thread-safe |
| `UV_THREADPOOL_SIZE` = core count | ❌ **Not implementing** | N/A | Doesn't affect embedding worker or LanceDB; wrong lever |
| Batch ~50 files per yield | ❌ **Not implementing** | N/A | Already batch embeddings per-file; LanceDB serialization is the constraint |

### External Recommendation (Not Adopted)

An external researcher suggested:
> "Your current approach of processing one file at a time with 20ms delays between files is only using ~5-10% of available CPU. With 10,000 files, the delays alone add 200 seconds of pure waiting. The research suggests using a Piscina worker pool (2-4 workers depending on core count), processing files in batches of ~50, and using setImmediate() instead of setTimeout(20) to yield between batches. setImmediate runs after the I/O poll phase, so the main thread stays responsive to user input, but you're not artificially idling. Benchmarks show this can take you from ~50 files/sec to 800-2000+ files/sec. You'd also want to set UV_THREADPOOL_SIZE to your CPU core count as the very first line of your entry point — the default of 4 is too small for I/O-heavy workloads."

### Investigation Findings (2026-02-04)

**Dual-researcher investigation** concluded the claim is **misleading** and the suggested fixes are **inappropriate** for this architecture:

#### 1. The 20ms Delay is NOT the Bottleneck

The claim's math (`10,000 files × 20ms = 200s waiting`) is correct in isolation, but ignores the dominant costs:

| Operation | Typical Duration | Percentage of Per-File Time |
|-----------|-----------------|----------------------------|
| File stat + read | 1-10ms | ~5-10% |
| Text chunking | <1ms | ~1% |
| **Embedding generation** | **30-100ms per chunk** | **~50-70%** |
| **LanceDB write** | **50-700ms** (Windows) | **~20-40%** |
| Inter-file delay | 20ms | ~10-20% |

For a single-chunk file with 100ms embedding + 100ms write, the 20ms delay is only ~10% of total time. For multi-chunk files, it's even less.

#### 2. Sequential Processing is Intentional (Not a Bug)

The codebase explicitly documents why sequential processing was chosen:

```typescript
// fileWatcherService.ts - DESIGN NOTE:
// The queue processes files SEQUENTIALLY (one at a time), not in parallel.
// This is intentional for two reasons:
// 1. The Worker Thread doing embeddings is the actual bottleneck, not the queue.
//    Running multiple files "in parallel" just means more waiting in the worker queue.
// 2. Sequential processing avoids same-file race conditions.
```

And in `fileIndexService.ts`:

```typescript
// SINGLE-WRITER PATTERN: Serialize all LanceDB mutations to prevent corruption
// LanceDB write operations (add, delete, update, dropTable, optimize) are not
// thread-safe when called concurrently.
```

#### 3. Why Each Suggested Fix Doesn't Apply

| Suggestion | Why It Doesn't Help |
|------------|---------------------|
| **Piscina worker pool** | LanceDB writes are serialized via `withWriteLock()`. Adding file-processing parallelism would just queue up writes in the lock. Removing the lock risks index corruption. |
| **setImmediate vs setTimeout** | Would save ~200s on 10,000 files, but at risk of UI responsiveness. The 20ms delay also acts as a throttle to prevent CPU saturation. Marginal benefit for non-trivial risk. |
| **UV_THREADPOOL_SIZE** | Affects libuv I/O (fs, dns), not: Worker threads (embedding runs in `utilityProcess`), ONNX threads (controlled by `OMP_NUM_THREADS`), or LanceDB (uses its own threading). |
| **Batch 50 files per yield** | Embeddings are already batched per-file. Batching files wouldn't help because the LanceDB single-writer constraint serializes everything anyway. |

#### 4. The Real Bottlenecks

Based on this and prior investigations (see LanceDB Batch Write section above), the actual Windows performance issues are:

1. **LanceDB write fragmentation** - Each file creates a separate data fragment
2. **Windows Defender scanning** - Each file I/O triggers AV checks
3. **Embedding generation latency** - ONNX CPU inference is inherently slow
4. **NTFS performance characteristics** - Many small writes are slower than macOS

The 20ms delay is overhead, but it's not the cause of slow indexing.

#### 5. What the 20ms Delay Actually Does

```typescript
// fileWatcherService.ts
const INTER_FILE_DELAY_MS = 20; // Yield to event loop between files

// After each file:
await delay(INTER_FILE_DELAY_MS, signal);

// Plus a longer GC pause every 50 files:
const GC_INTERVAL = 50;
const GC_PAUSE_MS = 100;
```

**Purpose**:
1. **Event loop yielding** - Allows IPC messages, UI updates to process between files
2. **Throttling** - Prevents CPU saturation on low-end machines
3. **Responsiveness** - User interactions remain responsive during background indexing

### Conclusion

**The 20ms delay is a red herring.** The real Windows performance work should focus on:
1. LanceDB batch writes (see section above)
2. Windows Defender exclusion documentation (already implemented)
3. Further investigation of NTFS/fragmentation impact

### Code Locations

| File | Relevant Code |
|------|---------------|
| `src/main/services/fileWatcherService.ts` | `INTER_FILE_DELAY_MS = 20`, queue processing loop, design note comments |
| `src/main/services/fileIndexService/index.ts` | `withWriteLock()`, `indexFileInternal()`, single-writer pattern comments |
| `src/main/services/embeddingService.ts` | `WINDOWS_ONNX_THREAD_LIMIT = 4`, `OMP_NUM_THREADS` setting, `utilityProcess` worker |
| `src/main/workers/embeddingWorker.ts` | Priority queue system, batch processing |

---

## App Bundle Size Optimization

> **Status**: Investigated 2026-02-04  
> **Source**: Dual-researcher analysis of 1.1GB macOS app bundle  
> **Related**: `forge.config.cjs`, `scripts/bundle-node.mjs`, `scripts/bundle-git.mjs`, `scripts/build-bundled-mcps.mjs`

### Summary

The packaged macOS app is **1.1GB**, which is larger than expected for an Electron app. A typical Electron app is ~150-200MB; ours has significant additional payload.

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| Bundle MCP servers as single files | ✅ **Implemented** | No action | 13 MCPs bundled with esbuild; MCP dir reduced from 623MB to 77MB (88% reduction) |
| Remove node-bundle headers | ✅ **Implemented** | No action | `include/`, `share/doc`, `share/man` stripped in `forge.config.cjs` `packageAfterCopy` (~53MB saved) |
| Strip rebel-system/node_modules | ✅ **Implemented** | No action | Excluded via `REBEL_SYSTEM_EXCLUDE` in forge.config.cjs (~40MB saved) |
| Fix Notion MCP TypeScript leak | ⏳ **Consider** | **Easy win** | Dev dependency in production (~19MB) |
| Use system git on macOS | ⏳ **Consider** | **Behavior change** | Would save ~156MB but changes user experience |
| Lazy-load MCPs on demand | ⏳ **Consider** | **Complex** | Download connectors when user enables them |
| Make AI/native deps optional | ⏳ **Consider** | **Complex** | LanceDB (93MB), ONNX (31MB), HuggingFace (34MB) |

### Bundle Breakdown (1.1GB macOS arm64)

| Component | Size | Notes |
|-----------|------|-------|
| **Electron Framework** | 283MB | Baseline Chromium + Node.js (expected) |
| **MCP servers** | ~77MB | 13 MCPs bundled as single `server.cjs` files; 4 remain unbundled (browser-automation, discourse, notion, microsoft-shared) |
| **Native modules** | 208MB | LanceDB (93MB), ONNX (31MB), HuggingFace (34MB), sharp (17MB) |
| **git-bundle** | 156MB | Bundled git including .NET runtime for Git Credential Manager |
| **node-bundle** | 118MB | Node.js binary (104MB) + npm/npx (14MB) |
| **rebel-system** | 55MB | Includes 41MB node_modules (likely unnecessary) |
| **app.asar** | 54MB | Bundled application code |
| **claude-agent-sdk** | 27MB | Agent SDK + ripgrep |
| **super-mcp** | 15MB | MCP router |
| **fluidaudiocli** | 8.5MB | Local STT binary |

### Why Node.js is Bundled Separately from Electron

Electron includes Node.js in its core (~253MB Electron Framework), but we bundle an additional standalone Node.js (~118MB) because:

1. **MCP servers require `npx`** - Many MCPs are spawned via `npx @modelcontextprotocol/server-xxx`
2. **External process spawning** - Electron's embedded Node can't be invoked as a standalone `node` executable for child processes
3. **Stdio transport** - MCP stdio protocol requires spawning separate processes

**Potential optimization**: If MCPs were restructured to run in-process (using Electron's Node directly via IPC), the 118MB node-bundle could potentially be eliminated. This would be a significant architectural change.

### Key Inefficiencies Identified

#### 1. MCP Dependency Duplication - ✅ FIXED

~~Each bundled MCP server has its own `node_modules/` with duplicated dependencies.~~

**Fixed (2026-02-04)**: 13 MCPs now bundled as single `server.cjs` files using esbuild. MCP directory reduced from **623MB to 77MB** (88% reduction, ~546MB saved).

**Bundled MCPs**: fathom, gamma, kling, granola, zendesk, hubspot, salesforce, slack, microsoft-mail, microsoft-calendar, microsoft-files, microsoft-teams, google-workspace

**Not bundled** (native dependencies or external packages):
- `browser-automation` (32MB) - playwright-core has native bindings
- `notion` (30MB) - external @notionhq package
- `discourse` (9MB) - external @discourse/mcp package  
- `microsoft-shared` (2.4MB) - dependency for Microsoft MCPs

See: `docs/plans/finished/260203_nsis_build_size_fix.md` for implementation details, `scripts/build-bundled-mcps.mjs` for bundling logic.

#### 1b. Unbundled MCPs - Cannot Optimize Further

Four MCPs remain unbundled (~73MB total) due to technical constraints:

| MCP | Size | Why Not Bundled | Potential Future Fix |
|-----|------|-----------------|---------------------|
| **browser-automation** | 32MB | `playwright-core` requires `chromium-bidi` package which has native bindings (`BidiMapper`, `CdpConnection`) that esbuild cannot resolve. Bundling produces a broken `server.cjs` that crashes on import. | Playwright team would need to publish a bundler-friendly version, or we'd need to ship playwright-core as an external alongside the bundle. |
| **notion** | 30MB | Uses external `@notionhq/client` package. This is an install-only MCP - we don't build it, just `npm ci`. The package structure doesn't have a single entry point suitable for bundling. | Could fork and restructure, but maintenance burden is high. |
| **discourse** | 9MB | Uses external `@discourse/mcp` package from Discourse team. Same issue as Notion - external package we don't control. | Wait for upstream to publish bundled version, or vendor the package. |
| **microsoft-shared** | 2.4MB | Dependency package used by Microsoft MCPs during build. Not a standalone MCP server - has no `server.cjs` entry point. | N/A - this is a build dependency, not a runtime MCP. Could potentially be removed after bundling if Microsoft MCPs don't need it at runtime (needs verification). |

**Impact**: These 4 unbundled MCPs account for **4,794 of 4,821 files** (99.4%) in the packaged MCP directory. The 13 bundled MCPs contribute only 27 files total (13 `server.cjs` files + 14 directories).

**Recommendation**: Accept current state. The 77MB total is acceptable, and further optimization would require:
- Upstream package changes (playwright, notion, discourse)
- Forking and maintaining external packages
- Significant architectural changes

The biggest wins have been captured. Remaining optimizations have poor effort/reward ratios.

#### 2. node-bundle Headers - ✅ ALREADY STRIPPED

~~`resources/node-bundle/include/node/` contains C++ headers for native addon compilation - not needed at runtime.~~

**Already fixed**: The `forge.config.cjs` `packageAfterCopy` hook strips these directories during packaging:
- `include/` - C/C++ headers (V8, Node, OpenSSL)
- `share/doc`, `share/man`, `share/systemtap` - Documentation
- `lib/node_modules/npm/docs`, `lib/node_modules/npm/man` - npm docs

See `nodeBundleDirsToRemove` array in `forge.config.cjs` (lines ~450-470). The cleanup happens at package time, so `resources/node-bundle/` in dev still has the files, but packaged builds do not.

#### 3. rebel-system Ships node_modules (~41MB)

The `rebel-system/` submodule includes its own `node_modules/`, but only the text content (skills, help files) is needed at runtime.

**Fix**: Update `forge.config.cjs` to exclude `rebel-system/node_modules/` when copying to the bundle.

#### 4. Notion MCP Ships TypeScript (~19MB)

The Notion MCP has `typescript` in its runtime dependencies - this is a build tool that leaked to production.

**Fix**: Move `typescript` to devDependencies and rebuild with `npm ci --omit=dev`.

#### 5. git-bundle Includes .NET Runtime (~150MB of 156MB)

The bundled git includes Git Credential Manager which requires the .NET runtime:
- `System.Private.CoreLib.dll`: 14MB
- `libSkiaSharp.dylib`: 14MB
- `libcoreclr.dylib`: 6.2MB
- Various Avalonia UI + .NET assemblies

**Options**:
- **Use system git on macOS** - Most macOS users have git via Xcode Command Line Tools (~156MB savings)
- **Build minimal git without GCM** - Requires custom dugite-native build (complex)
- **Keep current** - Ensures consistent git behavior across all users

### Potential Savings Summary

| Optimization | Savings | Effort | Risk |
|--------------|---------|--------|------|
| Bundle MCPs as single files | **~546MB** | High | Low - ✅ **DONE** |
| Remove node-bundle headers | ~53MB | Low | None |
| Strip rebel-system/node_modules | ~40MB | Low | Low - ✅ **DONE** |
| Fix Notion MCP TypeScript | ~19MB | Low | None |
| Use system git (macOS) | ~156MB | Medium | Medium (behavior change) |
| Remove node-bundle entirely | ~118MB | Very High | High (architectural change) |
| Make LanceDB/ONNX optional | ~150MB | Very High | High (feature degradation) |

**Conservative estimate**: ~200-250MB savings from easy/medium effort changes.
**Aggressive estimate**: ~400-500MB savings if system git is acceptable on macOS.

### References

- `forge.config.cjs` - Build configuration with `stripUnnecessaryFiles()` and extraResources copying
- `scripts/bundle-node.mjs` - Node.js bundling script
- `scripts/bundle-git.mjs` - Git bundling script
- `scripts/build-bundled-mcps.mjs` - MCP server build script
- `docs/project/PACKAGED_DEPENDENCY_NOTES.md` - Native module unpacking strategy

---

---

## Native Module Platform Stripping on Windows

> **Status**: Investigated 2026-02-04  
> **Source**: Dual-researcher analysis of Windows build size (1.34GB installed vs 507MB stable)  
> **Related**: [NSIS Investigation](../plans/finished/260203_nsis_investigation.md)

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| onnxruntime-node platform stripping | ✅ **Already implemented** | No action | Strips darwin/linux on Windows builds |
| onnxruntime-node **architecture** stripping | ❌ **Not implemented** | **Defer** | Would save ~34MB but low priority vs MCP bloat |
| @lancedb platform stripping | ❌ **Not needed** | No action | npm only installs matching platform package |
| sharp/@img platform stripping | ❌ **Not needed** | No action | npm only installs matching platform package |

### Investigation Findings (2026-02-04)

**Dual-researcher investigation** evaluated whether adding Windows platform/architecture stripping would significantly reduce installed app size.

#### What's Already Stripped (Working)

**Location**: `forge.config.cjs` lines 1036-1050

```javascript
// Strip unused platform binaries to reduce bundle size (~140MB savings)
const onnxBinDir = path.join(onnxDest, "bin", "napi-v3");
const allPlatforms = ["darwin", "linux", "win32"];
const unusedPlatforms = allPlatforms.filter((p) => p !== platform);
for (const unusedPlatform of unusedPlatforms) {
  // ... deletes darwin/ and linux/ dirs on Windows builds
}
```

This correctly removes ~141MB (darwin: 65MB + linux: 76MB) on Windows builds.

#### What's NOT Stripped (Potential Improvement)

**onnxruntime-node architecture stripping** (macOS-only currently):

```javascript
// forge.config.cjs lines 1052-1064
if (platform === "darwin") {
  const oppositeArch = arch === "arm64" ? "x64" : "arm64";
  // ... removes opposite architecture
}
// NO equivalent for Windows!
```

On Windows x64 builds, both `win32/x64/` (33MB) and `win32/arm64/` (34MB) are included. Only x64 is needed.

**Estimated savings**: ~34MB

#### Why We're NOT Implementing This Now

| Factor | Assessment |
|--------|------------|
| **Size impact** | ~34MB savings (only ~2.5% of 1.34GB installed size) |
| **Risk** | Low - similar pattern exists for macOS, good error handling |
| **Priority** | Low - MCP node_modules bloat (623MB) is the real problem |
| **Test coverage** | Medium risk - Windows E2E tests are disabled in CI |

**Recommendation**: Focus effort on MCP bundling optimization (potential ~590MB savings) rather than arch stripping (~34MB savings).

#### @lancedb and sharp/@img: No Action Needed

Both modules use npm's optional dependencies with `os`/`cpu` constraints:

```json
// @lancedb/lancedb-win32-x64-msvc/package.json
{ "os": ["win32"], "cpu": ["x64"] }
```

npm only installs the platform-appropriate package, so there's nothing to strip. This was confirmed by checking that only `@lancedb/lancedb-darwin-arm64` is present on macOS dev machines (no cross-platform packages).

### If Implementing Later

Should the arch stripping become a priority, here's the recommended implementation:

```javascript
// Add after existing platform stripping (line ~1064 in forge.config.cjs)
if (platform === "win32") {
  const oppositeArch = arch === "x64" ? "arm64" : "x64";
  const oppositeArchDir = path.join(onnxBinDir, "win32", oppositeArch);
  if (fs.existsSync(oppositeArchDir)) {
    console.log(`[packageAfterCopy] Removing opposite-arch onnxruntime: win32/${oppositeArch}`);
    await deleteDir(oppositeArchDir);
  }
}
```

**Safeguards** (from researcher recommendations):
1. Add post-strip verification that needed arch exists
2. Add verbose logging of what's being stripped
3. Test manually on Windows before release (no E2E coverage)
4. Consider adding `REBEL_SKIP_NATIVE_STRIP=1` escape hatch for debugging

### References

- `forge.config.cjs` - Platform stripping logic (lines 1036-1064)
- `docs/plans/finished/260203_nsis_investigation.md` - Full size analysis
- `node_modules/onnxruntime-node/bin/napi-v3/` - Binary locations

---

---

## App Size Reduction Investigation (2026-02-05)

> **Status**: In Progress (rebel-system stripping ✅ implemented, other optimizations under investigation)  
> **Goal**: Reduce installed app size from ~970MB (macOS) / ~1.25GB (Windows) to closer to 500-600MB

### Current Size Breakdown (macOS arm64 packaged)

| Component | Size | Notes |
|-----------|------|-------|
| Electron Framework | ~280MB | Baseline - cannot reduce |
| Native modules (app.asar.unpacked) | 192MB | LanceDB (80M), ONNX (31M), HuggingFace (32M), sharp (16M), etc. |
| git-bundle | 148MB | Bundled Git + .NET runtime for Git Credential Manager |
| node-bundle | 118MB | Bundled Node.js runtime for MCP spawning |
| MCP servers | 72MB | ✅ Already optimized (was 623MB before bundling) |
| rebel-system | 54MB | Contains 40MB node_modules that shouldn't ship |
| app.asar | 54MB | Application code |
| claude-agent-sdk | 25MB | SDK + ripgrep |
| super-mcp | 14MB | MCP router |
| **Total** | ~970MB | |

### Optimization Opportunities to Explore

#### 1. Strip rebel-system/node_modules (~40MB savings)

**Status**: ✅ **Implemented** (2026-02-05)

**Implementation**: Added `REBEL_SYSTEM_EXCLUDE` set in `forge.config.cjs` `packageAfterCopy` hook that excludes 7 directories/files from the rebel-system copy:
- `node_modules/` - Build dependencies not needed at runtime
- `cli/` - Development CLI tools
- `scripts/` - Development scripts
- `.git/`, `.github/` - Git metadata
- `package.json`, `package-lock.json` - npm metadata

**Investigation findings** (verified via codebase grep):
- ✅ No runtime code `require()`s from rebel-system/node_modules
- ✅ scripts/ and cli/ are development-only tools (not used at runtime)
- ✅ Only text files needed: `skills/`, `help-for-humans/`, `templates/`, `AGENTS.md`

**Expected savings**: ~40MB (74% reduction in rebel-system size from 54MB to ~14MB)

**Planning doc**: [`docs/plans/finished/260205_strip_rebel_system_node_modules.md`](../plans/finished/260205_strip_rebel_system_node_modules.md)

---

#### 2. Use System Git on macOS (~148MB savings)

**Status**: ❌ **Not Pursuing** (2026-02-05)

**Decision**: Not implementing. While technically feasible (~148MB savings on macOS), this optimization is **macOS-only** and doesn't address our primary concern: **Windows performance**. The effort/complexity is better spent on Windows-specific optimizations.

**Investigation findings** (dual-researcher analysis 2026-02-05):

**Technical feasibility**: ✅ Confirmed
- `setupGitEnvironment()` in `src/main/utils/systemUtils.ts` already supports "no bundled git" - falls back to PATH
- Implementation would be a packaging change in `forge.config.cjs`

**Key risks identified**:
1. **Xcode CLT install prompt** - `/usr/bin/git` is a shim that triggers OS modal if CLT not installed. Confusing UX if triggered unexpectedly.
2. **Auth without GCM** - Bundled Git Credential Manager provides OAuth for GitHub/GitLab. Without it, users need SSH keys or PATs for private repos.
3. **Version variability** - System git versions vary; older macOS may have old git lacking modern features.

**Recommended approach (if revisited later)**:
- Detect git properly: check for CLT via `/Library/Developer/CommandLineTools/usr/bin/git` or `xcode-select -p` before using `/usr/bin/git`
- Prefer Homebrew git over shim if available
- Set `GIT_TERMINAL_PROMPT=0` to prevent credential prompt hangs
- Graceful degradation if git unavailable

**Why not pursuing now**:
- **macOS-only** - Windows still requires bundled git (no system git equivalent)
- **Primary focus is Windows performance** - This document tracks Windows optimizations
- **Medium complexity** - Needs CLT detection, auth story, version compatibility testing
- **User experience risk** - CLT install prompt could confuse non-developer users

---

#### 3. Eliminate Separate node-bundle (~118MB savings)

**Status**: ❌ **Not Pursuing** (ELECTRON_RUN_AS_NODE attempt reverted 2026-02-05)

**Current state**: We bundle a standalone Node.js distribution (~118MB) even though Electron already includes Node.js.

**Why node-bundle exists**:
1. MCP servers are spawned as separate processes via `npx` or direct `node` execution
2. Electron's Node.js cannot be invoked as a standalone `node` executable
3. Super-MCP router runs as a child process

**The core issue**: `child_process.spawn('node', [...])` won't find Electron's embedded Node.

---

**ELECTRON_RUN_AS_NODE Implementation Attempt (2026-02-05)**

**Approach**: Use Electron's `ELECTRON_RUN_AS_NODE=1` environment variable to make the Electron binary act as a Node.js executable, eliminating the need for a separate bundled Node.js.

**Implementation completed**:
1. Created `electronAsNode.ts` utilities for rewriting node/npx commands to use Electron binary
2. Updated Super-MCP spawning to use Electron binary with `ELECTRON_RUN_AS_NODE=1`
3. Updated MCP stdio client to intercept and rewrite spawn commands at runtime
4. Created `bundle-npm-tools.js` script to extract npm from Node.js distribution (12MB vs 118MB full Node)
5. Updated forge.config.cjs to package npm-tools instead of node-bundle
6. Updated CI workflows, health checks, Windows Firewall warmup

**Build results**: 
- ✅ Local package built successfully (652MB, down from ~756MB = 104MB savings)
- ✅ npm-tools bundle verified (12MB with node shims for shebang resolution)
- ✅ All 23 MCPs loaded successfully using Electron binary
- ✅ 520 tools available from 30 MCP packages

**Critical issues discovered during testing**:

1. **macOS Dock Bouncing**: Spawning the `.app` binary (e.g., `/Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel`) triggers macOS LaunchServices, causing 2-3 terminal/Exec windows to "bounce" in the Dock during startup. Each of ~20 MCP spawns was treated as a potential app launch.

2. **Process count visibility**: The optimization didn't increase process count (22 MCP processes was consistent with before), but the Dock bounce effect made the existing eager MCP loading behavior visible and annoying.

**Root cause analysis** (dual-researcher investigation):
- macOS LaunchServices monitors process creation events
- When a `.app` bundle binary is spawned (even with `ELECTRON_RUN_AS_NODE=1`), macOS treats it as an application launch attempt
- The `ELECTRON_RUN_AS_NODE` flag runs correctly as Node, but the visual Dock animation happens first
- Potential fix (not implemented): Use Electron Helper binary instead of main app binary (has `LSUIElement: true` to suppress Dock activity), but adds complexity

**Decision: Revert**

The UX degradation (Dock bouncing) outweighs the ~104MB size savings:
- User-visible issue that would generate support tickets
- Complex to fix properly (would require Helper binary usage + testing across platforms)
- The ~104MB savings represents only ~10% of installed app size
- Risk of undiscovered platform-specific issues

**All changes reverted** (2026-02-05):
- Deleted `src/main/utils/electronAsNode.ts (path removed — verify)`
- Deleted `super-mcp/src/utils/electronAsNode.ts`
- Deleted `scripts/bundle-npm-tools.js (path removed — verify)`
- Restored `scripts/bundle-node.mjs`
- Reverted all modified files to original state

**Planning doc**: `docs/plans/260205_node_bundle_electron_run_as_node.md` (no longer present in the repo — the reverted approach is documented inline in this file).

---

**Remaining options** (all lower priority now):

**Option B: Use bundled MCPs directly (no spawn)**
- Since MCPs are now bundled as `server.cjs`, could potentially `require()` them directly
- Would need to restructure MCP communication (stdio → IPC)
- Significant architectural change
- **Risk**: High - major refactor

**Option C: Minimal Node bundle**
- Strip npm/npx from the bundle (only ship `node` binary)
- Most MCPs now bundled and don't need npm
- Savings: ~14MB (npm portion)
- **Risk**: Low - straightforward stripping, but marginal benefit

**Conclusion**: The node-bundle is staying at 118MB for now. Future optimization would require either:
- Restructuring MCP communication to avoid spawning entirely (high effort)
- Finding a way to suppress Dock activity when spawning Electron binary (platform-specific complexity)

---

#### 4. Minimize git-bundle Requirements

**Status**: ❌ **Not Pursuing - MinGit Rejected** (2026-02-05)

**Current state**: git-bundle includes Git Credential Manager (GCM) which brings .NET runtime.

**git-bundle breakdown**:
- Git core binaries: ~20-30MB
- Git Credential Manager: ~15MB
- .NET runtime (for GCM): ~100MB+
- MSYS2 environment (Windows): ~10-20MB

**Why GCM is included**:
- Provides OAuth-based authentication for GitHub/GitLab
- Without GCM, users would need SSH keys or personal access tokens
- Better UX for "it just works" git operations

---

**Investigation: MinGit as PortableGit Replacement (2026-02-05)**

**Hypothesis**: Replace PortableGit (~148MB) with MinGit (~50-80MB) to save ~100MB on Windows.

**Dual-researcher analysis** identified that MinGit excludes Perl, Tcl/Tk, Python, Git GUI, gitk, Git SVN, and documentation - none of which Rebel uses directly.

**Dual-reviewer verification** flagged critical assumptions that needed Windows testing:
- Does MinGit include `bash.exe`? (Required by Claude Agent SDK)
- Does MinGit include `cygpath.exe`? (Required by Claude Agent SDK for path conversion)
- Does MinGit include MSYS2 utilities (ls, cat, grep)?

**Windows testing result (2026-02-05)**:
- ✅ Downloaded MinGit-2.47.1-64-bit.zip from git-for-windows releases
- ❌ **`usr/bin/bash.exe` does NOT exist** in MinGit
- ❌ **`cygpath.exe` does NOT exist** in MinGit
- ℹ️ Only config files present: `etc/bash.bashrc`, `etc/bash_profile`

**Why this is a blocker**:
- Claude Agent SDK **requires** `bash.exe` - it sets `CLAUDE_CODE_GIT_BASH_PATH` and exits if bash isn't found
- SDK uses `cygpath -u` and `cygpath -w` for Windows/Unix path conversion
- MinGit is designed for **minimal git-only operations** without a shell environment

**Conclusion**: **MinGit is NOT viable** for Rebel. The Claude Agent SDK's hard dependency on bash.exe makes MinGit unsuitable regardless of git functionality.

---

**Remaining options** (all lower priority now):

**Option A: Build dugite-native without GCM**
- Requires custom build of dugite-native
- Saves ~115MB+ but removes OAuth git auth
- High effort, medium risk

**Option B: Strip more from PortableGit**
- We already strip Perl/Python executables, GUI tools, docs
- Could potentially remove more MSYS2 components we don't use
- Low-medium effort, needs careful testing

**Option C: Accept current size** ✅ **Current decision**
- GCM provides significant UX value
- 148MB is acceptable tradeoff for "git just works"
- Focus effort on other optimizations (node-bundle, MCPs)

---

#### 5. Bundle Remaining MCPs (notion, discourse, browser-automation, microsoft-shared)

**Status**: ✅ **Completed** (2026-02-05)

**Original state**: 4 MCPs remained unbundled and shipped with full `node_modules/`:
- `browser-automation` (29MB) - playwright-core native deps
- `notion` (29MB) - @notionhq/client package
- `discourse` (9MB) - @discourse/mcp package
- `microsoft-shared` (2.4MB) - build-time dependency

**Investigation findings** (dual-researcher analysis 2026-02-05):

| MCP | Size | Verdict | Rationale |
|-----|------|---------|-----------|
| **notion** | ~51MB | ✅ **Excluded** | Unused - Rebel uses remote Notion MCP via @notionhq instead of bundled server. No runtime code references it. |
| **microsoft-shared** | ~5MB | ✅ **Excluded** | Build-time only - provides shared utilities during MS MCP bundling. Not needed at runtime (verified via grep). |
| **discourse** | ~22MB | ✅ **Bundled** | Pure JavaScript, no native deps. Successfully bundled as `server.cjs` (384KB). |
| **browser-automation** | 29MB | ⏸️ **Kept unbundled** | playwright-core complexity too high. Bundling would require extensive external dependencies. Low ROI vs risk. |

**Implementation** (2026-02-05):
1. Added `EXCLUDED_MCPS` set to `forge.config.cjs` containing `notion` and `microsoft-shared`
2. Added exclusion check in MCP copying loop (Step 7c) with logging
3. Added `bundleDiscourse()` function to `scripts/build-bundled-mcps.mjs`
4. Added 'discourse' to `BUNDLED_MCPS` array in `forge.config.cjs`
5. Updated `resolveDiscourseServerScript()` in `bundledMcpManager.ts` to return bundled `server.cjs` path
6. Updated `validate-mcp-bundles.ts` to include discourse with required `--site` args

**Verified in packaged app**:
- ✅ notion directory not present (excluded)
- ✅ microsoft-shared directory not present (excluded)
- ✅ discourse contains only `server.cjs` (384KB, no node_modules)
- ✅ Microsoft MCPs (calendar, mail, files, teams) work correctly at runtime
- ✅ Discourse MCP works correctly at runtime

**Total savings**: ~77MB
- notion exclusion: ~51MB
- microsoft-shared exclusion: ~5MB
- discourse bundling: ~22MB (node_modules eliminated)

**Planning doc**: [`docs/plans/finished/260205_mcp_size_optimization.md`](../plans/finished/260205_mcp_size_optimization.md)

---

### Investigation Priority

| Optimization | Savings | Effort | Risk | Priority |
|--------------|---------|--------|------|----------|
| Strip rebel-system/node_modules | ~40MB | Low | Low | ✅ **DONE** |
| Bundle remaining MCPs | ~77MB | Medium | Low-Medium | ✅ **DONE** |
| Use system git on macOS | ~148MB | Medium | Medium | ❌ **Not Pursuing** (macOS-only, doesn't help Windows) |
| Minimize git-bundle (MinGit) | ~100MB | Low | N/A | ❌ **Not Viable** (MinGit lacks bash.exe required by Claude Agent SDK) |
| Eliminate/minimize node-bundle | ~14-118MB | Medium-High | Medium-High | **2 - Investigate** |
| Custom git build (no GCM) | ~115MB | High | Medium | **3 - Consider Later** (requires custom dugite-native build) |

### Next Steps

1. **Start with rebel-system/node_modules** - Low risk, clear win
2. **Test system git on macOS** - Check if Claude Agent SDK works with `/usr/bin/git`
3. **Test ELECTRON_RUN_AS_NODE** - See if this can replace node-bundle
4. **Analyze MCP dependencies** - Determine if browser-automation can be partially bundled

---

## GPU Slow Performance Auto-Disable

> **Status**: Implemented 2026-02-05  
> **Source**: Windows diagnostic analysis showing 300-750x slower GPU embeddings on integrated graphics  
> **Related**: `src/main/services/embeddingService.ts`, `src/main/services/gpuEmbeddingBackend.ts`

### Summary

| Practice | Status | Decision | Notes |
|----------|--------|----------|-------|
| Timing-based slow GPU detection | ✅ **Implemented** | N/A | Auto-disable GPU after 3 consecutive slow batches (>5s) |
| Switch to CPU when GPU is slow | ✅ **Implemented** | N/A | CPU embeddings are faster on weak integrated graphics |
| Failure-based auto-disable (existing) | ✅ **Already existed** | N/A | Keeps existing 5-failure threshold for errors/crashes |

### Problem Discovered

Windows diagnostic logs from user machines showed:
- GPU embeddings taking **30-40 seconds** per batch of 16 chunks
- Expected healthy latency: **5-15ms** per batch on GPU, **30-100ms** on CPU
- Result: GPU is **300-750x slower** than expected on weak integrated graphics (Intel UHD, AMD Vega)

The existing code had a **15s timeout** on GPU requests. When timeout fired:
1. CPU fallback started (correct)
2. But GPU worker **continued processing** in background (problem)
3. Result: **Duplicate work** - both GPU and CPU computed same embeddings

### Investigation (Dual-Reviewer Analysis)

Two reviewers evaluated multiple approaches:

| Approach | Verdict | Reasoning |
|----------|---------|-----------|
| **Longer timeout (90s)** | ❌ Rejected | Makes UX worse - users wait 37s for slow GPU when CPU could do it in 100ms. Also undermines auto-disable protection. |
| **Throw on timeout** | ❌ Rejected | Would skip many files on slow hardware. Complex error handling. |
| **Dispose GPU on timeout** | ❌ Rejected | GPU disposal takes 10-15s. Re-initialization expensive. |
| **Timing-based auto-disable** | ✅ Adopted | Detect slow GPU, disable it, use faster CPU. Simple, effective. |

### Solution Implemented

Added timing-based slow GPU detection to `embeddingService.ts`:

```typescript
// GPU slow performance tracking - auto-disable GPU if consistently slow
const GPU_SLOW_THRESHOLD_MS = 5000; // 5s - batch taking this long is "slow" (expected: 5-15ms)
const GPU_SLOW_COUNT_THRESHOLD = 3; // Auto-disable after this many consecutive slow batches
let consecutiveSlowGpuBatches = 0;
```

**How it works:**
1. Time each GPU embedding request
2. If batch takes >5s (or scaled threshold for larger batches), count as "slow"
3. After 3 consecutive slow batches, auto-disable GPU and switch to CPU
4. Log warning so issue is visible in diagnostics

**Why 5s threshold?**
- Healthy GPU: 5-15ms per batch → well under threshold
- Healthy CPU: 30-100ms per batch → also well under threshold  
- Slow iGPU: 30-40s per batch → immediately flagged as slow

**Scaling for batch size:**
- Larger batches naturally take longer
- Threshold scales: `GPU_SLOW_THRESHOLD_MS * Math.max(1, batchSize / 4)`
- Batch of 4: 5s threshold
- Batch of 16: 20s threshold (still catches 37s batches)

### Benefits

1. **No duplicate work** - GPU is disabled, not racing with CPU
2. **Fast indexing** - CPU completes embeddings in ~100ms instead of GPU's 37s
3. **Automatic** - No user intervention required
4. **Preserves fast GPUs** - Users with good GPUs still benefit from GPU acceleration
5. **Clear logging** - `GPU backend auto-disabled due to slow performance` message explains what happened

### Files Changed

- `src/main/services/embeddingService.ts`:
  - Added `GPU_SLOW_THRESHOLD_MS` and `GPU_SLOW_COUNT_THRESHOLD` constants
  - Added `consecutiveSlowGpuBatches` tracking variable
  - Added timing to `generateEmbedding()` and `generateEmbeddings()`
  - Added `autoDisableGpuDueToSlowness()` helper function
  - Refactored `autoDisableGpuDueToFailures()` for consistency

### References

- Previous issue: `docs/plans/finished/260124_windows_embedding_thread_limit.md` - Windows ONNX thread limiting
- Related: `docs/plans/finished/260201_rebel_kk_oom_fix.md` - OOM investigation

---

## Changelog

| Date | Change |
|------|--------|
| 2026-02-05 | Added App Size Reduction Investigation section with 5 optimization opportunities to explore |
| 2026-02-03 | Initial document created from research findings |
| 2026-02-03 | Implemented GPU crash logging via enhanced `child-process-gone` handler (note: `gpu-process-crashed` API was removed in Electron 29) |
| 2026-02-03 | Added recommendation comments: wait for user reports before implementing GPU switches and occlusion disable; `enable-gpu-rasterization` not recommended due to RTX 4000 glitches |
| 2026-02-03 | Added IPC Performance Best Practices section after audit; decided to keep `sendSync` for legitimate use cases; confirmed listener cleanup is proper |
| 2026-02-03 | Added Memory Leak Prevention Best Practices section after dual-researcher audit; all 5 practices compliant or not needed |
| 2026-02-03 | Added ASAR Packaging & Build Configuration section after dual-researcher audit; all high-priority practices already implemented; locale pruning deferred as low priority |
| 2026-02-03 | Added Code Signing & Windows Defender section after dual-researcher audit; all 4 practices already implemented (SHA-256 signing, Azure Trusted Signing, sign all executables, AV warmup) |
| 2026-02-03 | Implemented Windows idle CPU optimizations: CSS animation pause when hidden (`body.app-hidden` class), visibility-aware scheduler for main process (`visibilityAwareScheduler.ts`), migrated 3 non-critical intervals. See `docs/plans/finished/260203_windows_idle_cpu_optimizations.md` for full details. |
| 2026-02-03 | Added Module Loading & Startup Performance section. Implemented: lazy loading for document libraries (`mammoth`/`xlsx`/`unpdf`), conditional worker sourcemaps (skip in prod/CI), V8 code caching (`enableCompileCache()`). See `docs/plans/finished/260203_windows_startup_performance_optimizations.md` for full details. |
| 2026-02-03 | Added GPU info diagnostics at startup via `app.getGPUInfo('complete')` - logs GPU device info for Windows debugging |
| 2026-02-03 | Added listener leak detection via `process.on('warning')` handler for `MaxListenersExceededWarning` events |
| 2026-02-03 | Documented decisions to NOT implement: `sandbox: true` (security not perf, needs audit), local STT sync isolation (low-usage path, wait for reports) |
| 2026-02-03 | Implemented battery-aware power management: `initBatteryScheduler()` + `createBatteryThrottledInterval()` in `visibilityAwareScheduler.ts`. Migrated calendar sync (15→30min on battery) and external provider polling (30→60min on battery). Cleaned up unused `backgroundWorkThrottled` flag. See `docs/plans/finished/260203_battery_power_management.md`. |
| 2026-02-04 | Added File Watching / Chokidar section after dual-researcher investigation. **Decision**: NOT replacing Chokidar with `@parcel/watcher` yet - no direct evidence it's the root cause (LanceDB I/O contention more likely), and @parcel/watcher is not a drop-in replacement. **Implemented**: Symlink telemetry (count, targets, cloud storage detection), memory telemetry (before/after heap delta), and warning for >5000 watched directories. See `fileWatcherService.ts` and `workspaceWatcherService.ts`. |
| 2026-02-04 | Added ONNX Runtime Thread Configuration section after dual-researcher + triple-review investigation. **Decision**: NOT adopting external recommendation (`executionMode: 'sequential'`, `interOpNumThreads: 1`, `enableCpuMemArena: false`). Analysis found: (1) `executionMode: 'sequential'` is already the default, (2) `interOpNumThreads` is the wrong lever for CPU spikes (need `intraOpNumThreads`), (3) current `OMP_NUM_THREADS=4` approach is correct for OpenMP-enabled ONNX builds, (4) memory concerns don't apply since sessions are long-lived. Added diagnostic logging for `OMP_NUM_THREADS` at worker init. |
| 2026-02-04 | Added Windows Defender Exclusions section after dual-researcher investigation. **Finding**: The performance impact is real (~4x slowdown documented by Microsoft), but **already comprehensively addressed** via user documentation (`windows-security-and-antivirus.md`), enterprise IT guides, AV warmup service, file retry logic, and watchdog timers. **Decision**: NOT implementing programmatic exclusions (requires admin, blocked in enterprise, security concern, not industry practice). **Consider**: Adding Dev Drive recommendation to docs for Windows 11 power users. |
| 2026-02-04 | Added LanceDB Batch Write Performance section after dual-researcher investigation. **Finding**: Codebase matches the "many small inserts" anti-pattern (per-file writes, often 1-row for small files). **Mitigations already exist**: `table.optimize()` called every ~500 writes to compact fragments. **Decision**: NOT implementing full batching (~10K records) due to high complexity (crash recovery, query consistency, delete handling). **Implemented**: Diagnostic timing (`embeddingMs`, `writeMs`) in `fileIndexService.ts` to measure actual bottleneck before optimizing further. |
| 2026-02-04 | Added Sequential 20ms Delay / Worker Pool section after dual-researcher investigation. **Claim**: "20ms inter-file delay + sequential processing = 5-10% CPU utilization; use Piscina worker pool + setImmediate + UV_THREADPOOL_SIZE for 16x throughput." **Finding**: Claim is misleading. The 20ms delay is ~10-20% of per-file processing time; the real bottlenecks are embedding generation (30-100ms/chunk) and LanceDB writes (50-700ms on Windows). Sequential processing is intentional (prevents index corruption, documented in code). **Decision**: NOT implementing Piscina pool (conflicts with single-writer pattern), setImmediate swap (marginal benefit, risk to UI responsiveness), or UV_THREADPOOL_SIZE change (doesn't affect embedding worker). The real Windows performance work should focus on LanceDB batch writes per existing research. |
| 2026-02-04 | Added App Bundle Size Optimization section documenting 1.1GB macOS bundle analysis, contributors, and reduction opportunities (~300-400MB potential savings). |
| 2026-02-04 | Added Native Module Platform Stripping section after dual-researcher investigation. **Finding**: onnxruntime-node platform stripping already works on Windows; architecture stripping (removing win32/arm64 on x64 builds) is missing but would only save ~34MB. **Decision**: NOT implementing now - low priority vs MCP bundling (623MB bloat). @lancedb and sharp don't need stripping (npm installs only matching platform). Documented implementation approach for future reference. |
| 2026-02-04 | Updated "Remove node-bundle headers" from ⏳ Consider to ✅ Implemented. **Finding via triple-review**: The cleanup already exists in `forge.config.cjs` `packageAfterCopy` hook via `nodeBundleDirsToRemove` array (~lines 450-470). Strips `include/`, `share/doc`, `share/man`, `share/systemtap`, and npm docs/man at package time. No new code needed. |
| 2026-02-05 | **Implemented** "Strip rebel-system/node_modules" optimization. Added `REBEL_SYSTEM_EXCLUDE` set in `forge.config.cjs` `packageAfterCopy` hook excluding 7 dev-only items (node_modules, cli, scripts, .git, .github, package.json, package-lock.json). Investigation confirmed no runtime code requires these. ~40MB savings (74% reduction in rebel-system). See `docs/plans/finished/260205_strip_rebel_system_node_modules.md`. |
| 2026-02-05 | **Decision**: NOT pursuing "Use system git on macOS" optimization. Dual-researcher investigation confirmed technical feasibility (~148MB savings) but decided against because: (1) macOS-only - doesn't help Windows performance which is our primary focus, (2) UX risks with Xcode CLT install prompt, (3) auth complexity without bundled GCM. Documented findings and recommended approach if revisited later. |
| 2026-02-05 | **Implemented** GPU slow performance auto-disable. Dual-reviewer investigation found slow Windows GPU embeddings (30-40s vs expected 5-15ms) caused duplicate work when timeout triggered CPU fallback. Solution: Track batch timing, auto-disable GPU after 3 consecutive slow batches (>5s), switch to faster CPU. See "GPU Slow Performance Auto-Disable" section. |
| 2026-02-05 | **Rejected** MinGit as PortableGit replacement. Dual-researcher investigation suggested MinGit could save ~100MB by excluding Perl/Tcl/Python. Dual-reviewer verification flagged bash.exe as critical dependency. **Windows testing confirmed**: MinGit does NOT include `bash.exe` or `cygpath.exe`, which are hard requirements for Claude Agent SDK. MinGit is NOT viable for Rebel. |
| 2026-02-05 | **Implemented** "Bundle remaining MCPs" optimization. Dual-researcher investigation found: notion unused (~51MB, excluded), microsoft-shared build-time only (~5MB, excluded), discourse bundleable (~22MB, bundled as 384KB server.cjs). Browser-automation kept unbundled (playwright-core complexity). Added `EXCLUDED_MCPS` to forge.config.cjs, `bundleDiscourse()` to build-bundled-mcps.mjs, updated bundledMcpManager.ts resolver. **Total savings: ~77MB**. Runtime tested all MCPs successfully. See `docs/plans/finished/260205_mcp_size_optimization.md`. |
| 2026-02-05 | **Fixed** GPU backend lifecycle synchronization with embeddingService. Dual-researcher investigation found GPU backend auto-disposes after 5 minutes idle but didn't notify embeddingService, causing repeated "GPU backend not initialized" errors. **Solution**: Added disposal callback mechanism, instance-bound handlers (prevents stale callback issues), `isReady()` check before routing, lazy GPU re-initialization on demand, and mutex guard for concurrent re-init. Triple-reviewed (GPT-5.2, Gemini 3.1 Pro, Opus 4.5). See `gpuEmbeddingBackend.ts` and `embeddingService.ts`. |
| 2026-02-05 | **Reverted** ELECTRON_RUN_AS_NODE optimization attempt. Full implementation was completed (electronAsNode.ts utilities, Super-MCP spawning, npm-tools bundle, CI updates) with 104MB savings. **Reverted because**: spawning Electron `.app` binary triggers macOS LaunchServices causing visible Dock bouncing (2-3 terminal windows) during startup - unacceptable UX. Root cause: macOS treats `.app` binary spawns as app launches regardless of `ELECTRON_RUN_AS_NODE` flag. All changes rolled back, keeping original 118MB node-bundle. The original planning doc (`docs/plans/260205_node_bundle_electron_run_as_node.md`) is no longer in the repo; the design and revert rationale are captured inline in this file. |
| 2026-02-04 | **Fixed** tool index race conditions and connection leaks in `toolIndexService.ts`. Prevents concurrent index operations from corrupting the database. |
| 2026-02-04 | **Implemented** deferred tool index refresh - delays 120s on startup to reduce initial load contention with other startup tasks. |
| 2026-02-04 | **Fixed** Squirrel MAX_PATH failures on Windows by stripping `dist-test` directories from packaged app in `forge.config.cjs`. Windows has 260-character path limit. |
| 2026-02-04 | **Added** embedding worker CPU/memory diagnostics logging every 50 batches in `embeddingWorker.ts` for debugging performance issues. |
