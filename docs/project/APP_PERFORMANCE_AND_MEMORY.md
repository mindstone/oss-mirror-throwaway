---
description: "Performance monitoring, memory management, and debugging for Electron main process"
last_updated: "2026-06-11"
---

# App Performance and Memory

This document covers performance monitoring, memory management, and debugging techniques for Mindstone Rebel's Electron main process.

---

## See also

- [PERF_DIAGNOSTIC_PLAYBOOK.md](./PERF_DIAGNOSTIC_PLAYBOOK.md) - Operator playbook for diagnosing CPU / memory / beach-ball / idle-churn symptoms: Sessions A-E, red-flag greps (Bash + PowerShell), and the `scripts/perf-acceptance-check.ts` AC1-AC5 harness. The periodic `Memory diagnostic` emission (5 min focused / 120 s blurred/minimized cadence, incl. `eventLoopDelay`, `superMcpLifecycle`, `superMcpChildStats`, `gpuLifecycle`) is the operator-facing signal described there.
- [LOGGING.md](./LOGGING.md) - Structured logging architecture; memory diagnostics are logged here
- [HEADLESS_CLI_ENTRYPOINT_REFERENCE.md](./HEADLESS_CLI_ENTRYPOINT_REFERENCE.md) - CLI profiling with `--profile` flag for TTFT and cache metrics
- [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) - High-level system architecture and process boundaries
- [DEBUGGING.md](./DEBUGGING.md) - Practical debugging workflows
- [DIAGNOSTICS.md](./DIAGNOSTICS.md) - System health checks and diagnostic bundle export
- [ELECTRON_STORAGE_REFERENCE.md](./ELECTRON_STORAGE_REFERENCE.md) - All persisted files in userData
- [AUTOMATIONS.md](./AUTOMATIONS.md) - Automation scheduler architecture
- [PROMPT_CACHING.md](./PROMPT_CACHING.md) - Claude prompt caching behavior and optimization
- `src/main/services/agentTurnRegistry.ts` - Turn registry with `getDiagnostics()` for memory inspection
- `src/main/services/automationScheduler.ts` - Automation state with diagnostic logging
- `src/main/index.ts` - Periodic memory diagnostic interval, main process event loop monitor
- `src/main/services/cpuProfilerService.ts` - V8 CPU profiler for main process (dev:perf only)
- `src/main/services/memoryProfilerService.ts` - V8 heap space + process memory profiler (dev:perf only)
- `src/core/services/memoryUpdateService.ts` - Memory update I/O capture for eval fixture mining (dev:perf only)
- `src/renderer/hooks/useDevPerformanceMonitor.ts` - Dev-only long task + input latency diagnostics (includes long task attribution)
- `src/main/ipc/utils/ipcLatencyTracker.ts` - IPC latency tracking with reservoir sampling (dev:perf only)
- `src/main/services/startupWaterfallService.ts` - Startup milestone waterfall (dev:perf only)
- `src/main/services/rendererProfilerService.ts` - Renderer CPU profiling via CDP (dev:perf only)
- `src/main/services/performanceTracingService.ts` - Content tracing with domain presets (dev:perf only)
- `src/main/services/perfSummaryService.ts` - Consolidated perf summary aggregation (dev:perf only)
- `docs/plans/260414_perf_optimization_from_profiling.md` - Profiling analysis findings + optimization plan (April 2026)
- [PERFORMANCE_TESTING.md](./PERFORMANCE_TESTING.md) - Automated perf regression tests (`test:e2e:perf`): IPC payload, memory leak, CDP metrics, timing signals
- [TESTING_E2E.md](./TESTING_E2E.md) - E2E test infrastructure (perf tests use same Playwright setup)
- [TESTING_AUTOMATION_OVERVIEW.md](./TESTING_AUTOMATION_OVERVIEW.md) - Test command reference including `test:e2e:perf`

---

## Principles

- **Measure before optimizing**: Use diagnostic logging to identify actual bottlenecks
- **Avoid unbounded growth**: Cap arrays, prune old data, don't store duplicates
- **Periodic readers scale with N**: any new periodic, timer-driven, or per-event reader of accumulated per-turn/per-session state must be assessed for derivation cost at large N, not just diff correctness (see Idle CPU Churn below)
- **Synchronous operations block UI**: electron-store writes are synchronous; large stores cause beach balls
- **Memory != disk size**: V8 object overhead can expand JSON 10-50x in memory

---

## Memory Diagnostic Logging

The app logs memory diagnostics at several points to help identify leaks and bloat.

### Periodic Memory Diagnostic (every 5 minutes)

Search logs for: `"Memory diagnostic"`

```json
{
  "heapUsedMB": 245,
  "heapTotalMB": 312,
  "externalMB": 45,
  "rssMB": 520,
  "totalCpuPercent": 45.2,
  "totalCpuPercentInstant": 118.4,
  "totalCpuPercentPeak": 122.0,
  "peakAtMs": 1749631837000,
  "peakTopProcesses": [
    { "label": "mainUI", "pid": 12346, "cpuPercent": 98.2 },
    { "label": "gpu", "pid": 12348, "cpuPercent": 21.4 }
  ],
  "topCpuProcess": { "label": "mainUI", "cpuPercent": 32.1 },
  "platform": "win32",
  "processes": [
    { "pid": 12345, "type": "Browser", "label": "main", "workingSetMB": 180, "cpuPercent": 5.2 },
    { "pid": 12346, "type": "Tab", "label": "mainUI", "workingSetMB": 320, "cpuPercent": 32.1 },
    { "pid": 12347, "type": "Tab", "label": "gpuWorker", "workingSetMB": 95, "cpuPercent": 2.5 },
    { "pid": 12348, "type": "GPU", "label": "gpu", "workingSetMB": 45, "cpuPercent": 5.4 }
  ],
  "registryActiveTurns": 0,
  "registryContextAccumulators": 0,
  "registryContextSizeKB": 0,
  "registryLargestContextKB": 0,
  "automationRunCount": 116,
  "automationStateSizeKB": 18432
}
```

**Three CPU readings — averaged vs short-window vs peak (FU-5):**

The diagnostic now emits **three** CPU views, because the interval-average alone
badly under-reports bursty core-pinning (it divides cpu-time by the long 5 min /
120 s wall window, averaging a 120%-peak idle hotspot down to single digits — this
is *why* the 260529 idle-CPU bug hid from telemetry):

- `totalCpuPercent` (+ per-process `cpuPercent`) — **interval-average** over the
  diagnostic cadence (5 min foreground / 120 s blurred). Smooths away bursts.
  Unchanged; existing consumers keep working.
- `totalCpuPercentInstant` (+ per-process `cpuPercentInstant`) — **short-window
  ("instant")** sample taken right before each emit: two `getAppMetrics()`
  snapshots ~1.5 s apart, CPU% from the `cumulativeCPUUsage` delta ÷ window. A
  process pinning a core reads ~100%+ here even when its 5 min average is low.
  `null` when the sample was unavailable (metrics read failed / no usable counter).
- `totalCpuPercentPeak` — **peak** total instant CPU% seen across a lightweight
  between-emit sampler (~every 12 s) folded with the pre-emit instant sample.
  Catches a sustained burst that *both* the average and a single instant reading
  could miss. `null` when no sample was captured this interval.
- `peakAtMs` + `peakTopProcesses` (June 2026) — **peak attribution**, captured at
  the same instant `totalCpuPercentPeak` was set. `peakAtMs` is the timestamp of
  that peak sample; `peakTopProcesses` is the top ≤3 processes by instant CPU% at
  that instant, each `{ label, pid, cpuPercent }`. This is what makes a post-ship
  idle-CPU burst check *attributive* (which process was hot at the worst instant)
  instead of detective — correlate `peakAtMs` against subsystem log lines
  (`file_neighbors.lazy_fill_*`, `file_vectors.write`, LanceDB optimize,
  embedding-worker activity) to name the burst. **Per-peak-sample, not continuous
  profiling**: it pinpoints the single worst captured instant, not a continuous
  trace — for function-level attribution still take a live V8 profile (below).
  Both `null` when no peak sample was captured this interval.

A single value summary: `totalCpuPercent` answers "what was the steady load?",
`totalCpuPercentInstant` answers "what is it doing right now?", and
`totalCpuPercentPeak` answers "what's the worst it hit between emits?".

**Sustained high idle CPU warning (FU-5):** when total CPU stays above ~40% of a
core across ≥3 consecutive peak samples **while idle** (`registryActiveTurns === 0`,
no active agent turn), the diagnostic emits a throttled (≤1 / 10 min) WARN log
line `"Sustained high idle CPU detected"` with the offending top process + peak /
instant numbers. This is the proactive alarm that makes the next idle-CPU
regression self-report instead of hiding behind the interval-average. It never
fires during an active turn (high CPU there is expected work).

**Process labels:**
- `main` - Electron main (Browser) process
- `mainUI` - Main renderer window
- `gpuWorker` - Hidden GPU embedding backend window
- `exportRenderer` - Hidden PDF export window (short-lived)
- `gpu` - Chromium GPU process
- `utility:PID` - Chromium utility processes
- `renderer:PID` / `hiddenRenderer:PID` - Other renderer processes

**What to watch for:**
- `heapUsedMB` growing steadily over hours → memory leak in main process
- Any process `workingSetMB` growing steadily → memory leak in that process
- `totalCpuPercent` > 100% when idle → something is churning CPU (Windows issue indicator)
- `totalCpuPercentInstant` / `totalCpuPercentPeak` high while `totalCpuPercent` is low → **bursty** core-pinning the average is hiding (the 260529 idle-CPU signature). Trust the instant/peak readings, not the average. Then read `peakTopProcesses` (+ `peakAtMs`) to see *which* process was hot at the worst instant and when, and correlate that timestamp against subsystem log lines before profiling.
- A `"Sustained high idle CPU detected"` WARN line → the proactive idle-hotspot alarm fired; grep the surrounding `topProcess` / `totalCpuPercentPeak` and live-profile (see below).
- `topCpuProcess` consistently same process → identifies the culprit
- `platform: "win32"` with high CPU → filter logs to see Windows-specific patterns
- `registryContextAccumulators` > `registryActiveTurns` → contexts not being cleaned up after turns complete
- `registryContextSizeKB` large when idle → accumulated context not released
- `automationStateSizeKB` > 5000 → automation store bloat (see Known Issues)

### GPU Worker Idle Disposal

The GPU embedding worker (hidden BrowserWindow with WebGPU) disposes after idle timeout to release WindowServer/IOSurface allocations on macOS.

**Idle timeout:** 30 seconds on macOS (faster IOSurface release), 5 minutes on Windows/Linux.

**Disposal method:** `window.destroy()` (after dispose handshake with renderer). Uses `destroy()` instead of `close()` for immediate IOSurface release on macOS. The dispose handshake ensures WebGPU resources are cleaned up before the window is destroyed.

**Re-initialization:** Non-blocking. When the GPU is disposed and a new embedding request arrives, GPU re-init starts in the background while the request is immediately served by the pre-warmed CPU worker. Subsequent requests use GPU once re-init completes (typically 3-15s).

Search logs for: `"GPU backend idle timeout triggered"`

```bash
grep "GPU backend idle timeout triggered\|GPU embedding backend disposed" \
  ~/Library/Application\ Support/mindstone-rebel/logs/*.log | tail -10
```

**What to watch for:**
- "GPU backend idle timeout triggered" should appear after 30 sec (macOS) or 5 min (other) of inactivity
- Followed by "GPU embedding backend disposed"
- If these never appear, the timer may not be firing (check if background indexing is keeping it active)

The idle timer is **activity-based**, not focus-based. It fires after the timeout with no `generateEmbedding()` calls, regardless of whether the app is focused, blurred, or minimized.

### Threshold-Based Performance Logging

Search logs for: `"Slow store write"` or `"Slow process spawn"`

When operations exceed thresholds, they're logged immediately:
- **Store writes >100ms**: `Slow store write detected` with `durationMs` and `operation`
- **Process spawns >2000ms**: `Slow process spawn detected` with `durationMs` and `processName`

**Tracked operations** (fed into `perfAccumulator` for diagnostic bundle stats):
- `inbox.writeEntryFile` — inbox entry file writes
- `automation.persist` — automation store persist (sync, can cause beach balls)
- `session.upsertSync(N)` — session file batch writes (sync)
- `super-mcp` — Super-MCP process spawn

These help diagnose Windows performance issues where sync I/O or AV scanning causes delays.

**Diagnostic bundle integration**: The `manifest.json` includes `quickStats.perfStats` with cumulative counts and max durations since app start. This appears in the bundle README "Quick Status" section.

### Dev-Only Leak Detection

**Enabled automatically when running `npm run dev`** (i.e., when `app.isPackaged === false`).

Search logs for: `"MEMORY LEAK DETECTED"`

The leak detector tracks per-process memory over time and warns when it detects sustained growth:

```
⚠️ MEMORY LEAK DETECTED - Sustained growth in: mainUI
  mainUI: 320MB -> 450MB (+130MB, 65MB/hr)
```

**Detection criteria (all must be true):**
- Total growth > 100MB since first sample
- Growth rate > 50MB/hour
- 3+ consecutive increases at the end of the sample series

This filters out normal GC fluctuations and only alerts on genuine sustained leaks.

**Limitations:**
- Requires ~20 minutes of samples before leak detection activates
- Short-lived processes (like `exportRenderer`) may not be tracked if they close between samples

### Automation Store Load (on startup)

Search logs for: `"Automation store loaded - diagnostic metrics"`

```json
{
  "loadDurationMs": 234,
  "runCount": 116,
  "stateJsonSizeKB": 18432,
  "largestRunSizeKB": 968,
  "heapUsedMB": 180
}
```

**What to watch for:**
- `loadDurationMs` > 500 → slow startup, may cause initial beach ball
- `stateJsonSizeKB` > 10000 → store needs pruning or migration

### Slow Persist Detection

Search logs for: `"Slow automation store persist detected"`

Only logged when persist takes >100ms. Indicates main thread blocking (beach ball cause).

### Renderer Memory Diagnostic (every 5 minutes)

Search logs for: `"Renderer memory diagnostic"`

Logs cheap renderer-side counters and V8 heap usage every 5 minutes. **All work in this path is O(N) length sums or O(1) Map lookups — no recursive payload walks.** The expensive payload-aware byte attribution that previously ran here was moved behind `VITE_PERFORMANCE === 'true'` (dev:perf) in May 2026 after REBEL-5D5 Stage 1 + Stage 2 diagnostics showed every payload bucket reads ~0 KB even at multi-GB heap. The recursive walks were costing real user CPU and transient heap pressure every 5 minutes without yielding actionable signal. See `docs-private/investigations/260506_renderer_memory_leak.md`.

```json
{
  "heapUsedMB": 245,
  "heapTotalMB": 312,
  "heapLimitMB": 4096,
  "heapUsedDeltaMB": 7,
  "sampleIntervalMs": 300012,
  "currentSessionId": "abc123",
  "currentMessageCount": 12,
  "currentTurnCount": 6,
  "currentEventCount": 847,
  "maxEventsInTurn": 234,
  "estimatedEventsByTurnKB": 412,
  "imageDataUrlCacheEntries": 14,
  "imageDataUrlCacheKB": 2100,
  "bgEventBufferSessions": 0,
  "bgEventBufferTotal": 0,
  "pendingThinkingDeltasKeys": 0,
  "pendingEventsTurns": 0,
  "pendingEventsTotal": 0,
  "pendingEventsKB": 0,
  "turnSessionMapSize": 0,
  "turnStartTimesSize": 0,
  "sessionSummaryCount": 1832,
  "loadedSessionCount": 5,
  "loadedMessageCount": 89,
  "loadedTurnCount": 42,
  "loadedEventCount": 3421,
  "draftCount": 3,
  "diagBuildMs": 4
}
```

**What to watch for:**
- `heapUsedMB / heapLimitMB` approaching 1.0 → renderer near OOM
- `heapUsedDeltaMB` consistently positive across many ticks → slow leak that may not yet have crossed the 30-minute warning threshold
- `heapUsedDeltaMB` large but `sampleIntervalMs` ≫ 5 min → background-throttled timer or long sleep; growth rate is not what it looks like
- `sampleIntervalMs` < 4 min on the first dev tick under `dev:strict` (`VITE_REACT_STRICT_MODE=true`) → StrictMode double-mount of the effect (expected; plain `dev`/`dev:perf` no longer enable StrictMode)
- `currentEventCount` growing without bound → events not pruned after turns complete
- `sessionSummaryCount` very high (>2000) → session list metadata growth
- `loadedSessionCount` consistently at the LRU cap (10) → cache thrashing
- `bgEventBufferSessions` > 0 when idle → orphaned background event buffers
- `maxEventsInTurn` > 1000 → single turn with excessive events (potential large tool outputs)
- `pendingThinkingDeltasKeys` > 0 when idle → streaming buffers not cleared
- `pendingEventsTurns` / `pendingEventsTotal` / `pendingEventsKB` growing while `currentEventCount` is frozen → FOX-3518 within-session leak suspect: `pendingEventsRef` in `useAgentSessionEngine` is accumulating full `AgentEvent` objects for turns whose `sessionId` never resolved (background/foreign-session turns). Expected to be 0 when idle; non-zero values at rest confirm the leading hypothesis (see Decision Log in `docs/plans/260622_rebel-5d5-within-session-leak/PLAN.md`). `pendingEventsKB` is a capped-sample extrapolation (≤50 events/turn stringified).
- `turnSessionMapSize` / `turnStartTimesSize` climbing without bound → `turnSessionMapRef` / `turnStartTimesRef` in `useAgentSessionEngine` not being swept; both are companion suspects to `pendingEventsRef` (FOX-3518).
- `diagBuildMs` climbing into the tens of ms or higher → the cheap tier has accreted expensive work again; investigate before it becomes the next REBEL-5D5 amplifier

For per-field byte attribution (which payloads, which sessions, which state maps are holding KB), run `npm run dev:perf` and consult the matching `"Renderer leak diagnostics (dev:perf)"` log line.

#### Cross-correlating renderer JS heap with main-process working set

The renderer V8 heap (`heapUsedMB`, every 5 min) and the main-process per-process working set (`workingSetMB` for `label: "mainUI"`, see [Main Process Memory Snapshot](#main-process-memory-snapshot-every-5-minutes) above) measure different things — V8-counted JS retention vs OS-reported resident memory including native, DOM, WebGL, and IPC structures. A divergence between them (renderer heap flat, mainUI working set climbing) is the textbook REBEL-5D5 signature and the strongest evidence that the leak is *outside* the JS object graph.

When pairing records:

- **Cadence mismatch**: renderer cadence is fixed at 5 min always; main-process cadence is **5 min when focused, 120 s when blurred / minimised** (see `MEMORY_LOG_INTERVAL_MS` and `MEMORY_LOG_BACKGROUND_INTERVAL_MS` in `src/main/services/perfDiagnosticService.ts`). Don't pair by index — pair by nearest timestamp within a ~2-min tolerance.
- **Pair both prod and dev:perf records to the same mainUI row** when investigating: the renderer `Renderer memory diagnostic` log carries V8 heap, the dev:perf `Renderer leak diagnostics (dev:perf)` log carries per-bucket KB, and the main-process `Memory tracking sample` log carries the OS-counted total. All three at the same wall-clock minute is one complete picture.
- **The strongest signal is the gap**: if mainUI `workingSetMB` − renderer `heapUsedMB` is large and growing, the leak is in native or DOM territory, not JS. That's the point at which the next investment is a real heap snapshot (see below), not another counter.

#### Renderer heap snapshot helper (dev-gated)

The REBEL-5D5 investigation's conclusion ("stop instrumenting, take a heap snapshot at next reproduction") still stands, and the capture helper now exists in `src/main/services/rendererHeapSnapshotService.ts`. It uses Electron's built-in `webContents.takeHeapSnapshot(filePath)` rather than CDP chunk plumbing, writes snapshots under `userData/heap-snapshots/`, pairs each `.heapsnapshot` with a `.meta.json` sidecar containing the nearest renderer working-set reading from `app.getAppMetrics()`, guards disk space, and rotates to the newest four snapshot pairs.

Capture is intentionally dev-gated: launch with `REBEL_PERF_MODE=1`, then invoke `system:heap-snapshot-capture` through the typed preload API (`window.systemHealthApi.heapSnapshotCapture({ trigger: 'manual', label })`) or an IPC-capable harness. Snapshot files stay local and are not part of diagnostics exports; treat them as sensitive because they can contain conversation content and other renderer-resident strings.

### Renderer Leak Diagnostics (Dev Perf Mode)

Requires `npm run dev:perf` (`VITE_PERFORMANCE=true`). Logs alongside the standard renderer memory diagnostic every 5 minutes.

Search logs for: `"Renderer leak diagnostics (dev:perf)"`

This block carries the full payload-aware byte attribution — the depth-64 recursive walks over `currentSessionEvents`, `backgroundEventBuffers`, and the LRU-cached `loadedSessions` (incl. `imageContent`, `toolResult`, `mcpAppUiMeta` payload bytes), plus the `sessionSummaries` and Zustand state-map byte walks. **This is the only place the full byte breakdown is paid for.** It is intentionally hidden from production because Stage 1 + Stage 2 of the REBEL-5D5 investigation showed every bucket reads ~0 KB even at 2.5 GB heap.

```json
{
  "heapUsedMB": 120,
  "heapLimitMB": 4096,
  "heapUsedDeltaMB": 7,
  "sampleIntervalMs": 300012,
  "csEventsTurns": 12,
  "csEventsTotal": 847,
  "csEventsKB": 4200,
  "csImageContentKB": 0,
  "csToolResultKB": 0,
  "csMcpAppUiMetaKB": 0,
  "csMessagesKB": 18,
  "csAttachmentTextsKB": 0,
  "csThinkingTextKB": 0,
  "loadedSessionCount": 5,
  "loadedSessionsDetail": [
    { "id": "abc12345", "msgCount": 8, "turnCount": 4, "toolArchiveKeys": 22 }
  ],
  "loadedMessagesKB": 84,
  "loadedAttachmentTextsKB": 0,
  "loadedEventDetailKB": 1240,
  "loadedImageContentKB": 0,
  "loadedToolResultKB": 0,
  "loadedMcpAppUiMetaKB": 0,
  "toolArchiveTotalEntries": 124,
  "toolArchiveTotalKB": 612,
  "coachingCacheSize": 15,
  "eligibilityCacheSize": 8,
  "imageDataUrlCacheEntries": 14,
  "imageDataUrlCacheKB": 2100,
  "bgBufferSessions": 0,
  "bgBufferTotal": 0,
  "bgBufferKB": 0,
  "bgBufferPayloadKB": 0,
  "autoDoneEntries": 45,
  "draftEntries": 3,
  "memoryStatusEntries": 6,
  "timeSavedStatusEntries": 4,
  "autoDoneKB": 1,
  "draftsKB": 4,
  "memoryStatusKB": 1,
  "timeSavedStatusKB": 1,
  "sessionSummaryCount": 1832,
  "sessionSummariesKB": 412,
  "pendingThinkingDeltas": 0,
  "pendingThinkingDeltasKB": 0,
  "domNodeCount": 4128,
  "diagBuildMs": 38
}
```

**What to watch for (ranked by suspected impact):**
- `csEventsKB` growing steadily → `currentSessionEvents` Map accumulating (top suspect — unbounded for active session, only cleared on session switch)
- `loadedSessionsDetail[].toolArchiveKeys` very high → `toolDetailArchive` retaining full tool I/O in LRU cache
- `coachingCacheSize` / `eligibilityCacheSize` growing → module-level Maps never pruned
- `bgBufferSessions` > 0 when idle → orphaned background event buffers
- `autoDoneEntries` growing → unbounded `Record` in Zustand, never pruned
- `imageDataUrlCacheKB` large → base64 data URL cache count-bounded but byte-unbounded (REBEL-5D5)
- `diagBuildMs` here minus the paired prod-record `diagBuildMs` is the cost of this dev:perf-only block — use it as the budget gate when deciding whether a new dev:perf-only counter could be safely promoted to the prod tier (rule of thumb: anything that pushes the prod-tier `diagBuildMs` above ~10 ms is too expensive for every-user, every-5-min telemetry)

**REBEL-5D5 caveat (May 2026):** every payload-byte field above read ~0 KB at multi-GB heap during two reproductions. The investigation now points away from JS-counted retention toward React fibers, IPC listener accumulation, vendor SDK queues, or native/DOM/WebGL retention — i.e. things only a heap snapshot can distinguish. See `docs-private/investigations/260506_renderer_memory_leak.md` § "Stop instrumenting. Take a heap snapshot at next reproduction."

**Key source files:**
- `src/renderer/features/agent-session/store/sessionStore.ts` — `getCheapLeakCounters()` (prod), `getLeakDiagnostics()` (dev:perf), `currentSessionEvents` Map, `backgroundEventBuffers`, `loadedSessions` LRU
- `src/renderer/features/agent-session/hooks/useSessionCoaching.ts` — `coachingBySession` Map, `getCoachingCacheSize()`
- `src/renderer/features/agent-session/hooks/useCommunityShare.ts` — `eligibilityBySession` Map, `getEligibilityCacheSize()`

### App Startup Marker

Search logs for: `"App process started"`

Each app launch logs:
```json
{
  "pid": 12345,
  "version": "0.3.5",
  "isPackaged": false,
  "platform": "darwin",
  "arch": "arm64"
}
```

Use this to correlate memory diagnostics across restarts when debugging leaks.

---

## Known Issues and Mitigations

### Idle CPU Churn — stateless re-derivation loops (June 2026 — FIXED)

**Issue**: A live diagnosis of the installed beta found the main process doing
unbounded background work at idle (~6k log lines/hr; `totalCpuPercentPeak` 189%/375%
multi-core bursts while `registryActiveTurns === 0`). Root cause was one class —
background passes that recompute everything from scratch on a fixed beat with no
memory of failure or of "nothing changed".

**Fix** (commits 414f8fa09..7c96eba57): killed five instances by construction —
cloud-pull failure memo + terminal/transient classification + pre-download
preflight (a never-converging 33-file retry storm from two dangling Drive
symlinks), oversized-push memo (stops the per-cycle second workspace walk),
`checkStaleEmbeddings` summary-level count gate (no full 622MB corpus parse at
idle), `time-saved-repair` prefilter + scan-once (launch parses ≤1, was up to 13),
and a `file_neighbors` mutationVersion checkpoint + deterministic-failure memo +
trigger coalescing. The "Preserving legacy … status entries" warn flood was demoted
to debug + per-process deduped. Also shipped `peakAtMs`/`peakTopProcesses` peak
attribution (see "Three CPU readings" above) for falsifiable post-ship burst checks.
Full intent, evidence, per-stage design, and verification: `docs/plans/260611_perf-idle-churn/PLAN.md`.

### Automation Store Bloat (January 2026)

**Issue**: `automations.json` stores full `eventsByTurn`, `messages`, and `session` data for each automation run. This data is already stored separately in `sessions/<sessionId>.json`, making it redundant.

**Impact**: 
- 19MB store file for 116 runs
- Loaded synchronously at startup
- Persisted synchronously on every automation event
- Causes beach balls and contributes to OOM

**Mitigation plan**: See `docs/plans/finished/260106_automation_oom_fix.md`
- Migration to strip redundant fields from existing runs
- Stop persisting `eventsByTurn`/`messages`/`session` going forward
- Expected reduction: 99%+ (19MB → ~100KB)

### Settings Write-on-Read (March 2026 — FIXED)

**Issue**: `getSettings()` called `ensureNormalizedSettings()` on every invocation.
`normalizeSettings()` always returned a new object (spread operator), so the reference
comparison `normalized !== current` always passed, triggering a synchronous electron-store
write (including `fsyncSync`) on every call.

The IPC wrapper called `getSettings()` twice per invoke for cloud routing checks, and
idle renderer polls (voice pending-audio every 15s, meeting status every 30s) kept the
path hot -- resulting in ~8 pointless disk writes per minute during idle.

**Fix** (commit TBD):
- Changed `ensureNormalizedSettings` to use `fast-deep-equal` instead of reference comparison
- Cached cloud-mode-active flag in `cloudRouter` so `isDualWrite`/`shouldRouteToCloud` skip `getSettings()` entirely
- Gated voice pending-audio 15s poll to only run when pending files exist

**Root cause timeline**: `normalizeSettings` always returned new objects since Nov 2025;
reference comparison added Nov 2025; IPC wrapper doubled calls Feb 2026; always-on 15s poll Mar 2026.
Previously identified in `docs/plans/finished/260113_onboarding_reset_investigation.md` but not fixed.

### Session Loading Memory Pressure (March 2026 — FIXED)

**Issue**: Multiple code paths loaded ALL session files from disk via `loadAgentSessions()` when they only needed lightweight metadata. With ~1800 sessions totaling ~297MB on disk (expanding significantly in V8 memory), this caused:
- IPC handlers (usage, system, community) loading full sessions for 2-4 metadata fields
- Conversation index backfill closure retaining full session array for 3+ minutes
- `lastKnownSessions` global retaining all sessions indefinitely for stale check
- UsageTab renderer loading full sessions over IPC for pre-computed usage stats

**Fix**:
- IPC handlers switched to `listSessions()` (zero-I/O in-memory index) or `getSession(id)` (single file)
- Backfill closure loads sessions fresh when it runs, not at scheduling time
- `lastKnownSessions` removed; stale check uses `listSessions()` + on-demand `getSession()`
- UsageTab switched from `sessions:load` to `sessions:list` with pre-computed `summary.usage` stats
- Also fixed pre-existing bug where `lastKnownSessions` was overwritten by single-session saves

**Key files**: `src/main/ipc/usageHandlers.ts`, `systemHandlers.ts`, `communityHandlers.ts`, `src/main/services/conversationIndexService.ts`, `src/renderer/features/settings/components/tabs/UsageTab.tsx`

### Renderer Memory Leak — REBEL-5D5 (March 2026 — ROOT CAUSE FOUND + FIXED June 2026)

**Issue**: The mainUI renderer process showed sustained memory growth during extended use.
First detected March 3 2026 (v0.4.13) at 459 MB/hr; observed through v0.4.46 at 50-253 MB/hr.

**RESOLVED (June 2026)**: root cause was the un-keyed `ConversationPane` TanStack virtualizer —
its `elementsCache` accumulated never-repeating message-UUID keys across session switches,
retaining detached DOM + fibers + framer-motion internals. Fixed by keying the pane on
`currentSessionId` (remount per session; commit `7625757b7`). Diagnosed via the new dev-gated
renderer heap-snapshot helper + memlab retainer diffs + a two-arm runtime probe (full trail:
`docs/plans/260611_rebel-5d5-renderer-leak/PLAN.md`, incl. the post-ship acceptance criterion —
heap slope < 30 MB/hr over a ≥2h active window). **Known residual**: within-a-single-session
cache growth (bounded by session length) remains a tracked follow-up. The history below is
retained for the investigation-methodology lessons (JS byte-attribution measured ~0% because
the retention lived in library caches/detached trees; heap snapshots were decisive).

**Suspected sources** (identified via multi-model code analysis, March 2026):

1. **`currentSessionEvents` Map** (HIGHEST) — Module-level `Map<string, AgentEvent[]>` at `sessionStore.ts:460`. Holds ALL events for the currently-viewed session. Unbounded while the session is active; only cleared on session switch/reset. Long sessions with many tool calls accumulate indefinitely.
2. **`toolDetailArchive`** in `loadedSessions` LRU cache — `cacheSession()` extracts full tool input/output detail strings into `toolDetailArchive` for each cached session. 10 cached sessions with heavy tool use can retain significant memory.
3. **`coachingBySession` / `eligibilityBySession`** — Module-level Maps in `useSessionCoaching.ts:15` and `useCommunityShare.ts:17`. Accumulate one entry per session that receives a coaching evaluation or share eligibility check. Never pruned during normal operation.
4. **`autoDoneBySessionId`** — `Record<string, boolean>` in Zustand state. Grows for every session with auto-done toggled, never cleaned up.

**Stage 1 + Stage 2 result (May 2026)**: Both rounds of byte-attribution instrumentation returned negative — every JS-counted bucket (active-session events, loaded sessions, image cache, sessionSummaries, state maps, toolDetailArchive, DOM count) reads ~0 KB even when the renderer heap is at 2.5 GB. The dominant retainer is now suspected to live outside any structure we can enumerate from JS: React fibers, IPC listener accumulation, vendor SDK buffers (Sentry/PostHog), or native/DOM/WebGL retention. See `docs-private/investigations/260506_renderer_memory_leak.md`.

**Telemetry tier (May 2026)**: The expensive payload-aware byte attribution has been **moved out of the production "Renderer memory diagnostic" log** and now only runs under `VITE_PERFORMANCE === 'true'` (dev:perf). The recursive depth-64 walks over all events + 10 LRU-cached sessions every 5 minutes were costing real users CPU + transient heap pressure without yielding actionable signal. Production retains cheap counters + heap MB + the growth-detection warning, plus three tick-over-tick deltas: `heapUsedDeltaMB`, `sampleIntervalMs`, and `diagBuildMs` (self-instrumentation guarding against future cheap-tier regressions). See "Renderer Memory Diagnostic" and "Renderer Leak Diagnostics" sections above.

**Diagnostics**: Run `npm run dev:perf` and search logs for `"Renderer leak diagnostics (dev:perf)"` to track all suspected sources simultaneously. See "Renderer Leak Diagnostics" section above. For pairing the renderer heap signal against the main-process working set (the most informative cross-correlation for this leak class), see the "Cross-correlating renderer JS heap with main-process working set" subsection.

**Next step (per investigation)**: Stop adding JS-side instrumentation. Take renderer heap snapshots at the next reproduction using the dev-gated helper (see "Renderer heap snapshot helper" above), compare two or more captures around 10 minutes apart, and identify constructor-level retainers. If the heap snapshots do not account for the paired mainUI working-set growth, treat that as evidence for native/DOM/off-heap retention rather than adding another JS counter.

### Agent Turn Registry Accumulation

**Issue**: `agentTurnRegistry` accumulates `ConversationStateShape` per turn in `turnContextAccumulators`. These should be cleaned up when turns complete via `cleanupTurn()`.

**Symptoms**: `registryContextAccumulators` count stays high when no turns are active.

**Debugging**: Check if `cleanupTurn()` is being called on all code paths (success, error, abort).

---

## Debugging Memory Issues

### Quick Log Analysis

```bash
# Find memory diagnostics
grep "Memory diagnostic" ~/Library/Application\ Support/mindstone-rebel/logs/*.log | tail -20

# Find slow persists (beach ball indicators)
grep "Slow automation store persist" ~/Library/Application\ Support/mindstone-rebel/logs/*.log

# Check automation store size at startup
grep "Automation store loaded" ~/Library/Application\ Support/mindstone-rebel/logs/*.log | tail -5
```

### Inspecting Store Files

```bash
# Check file sizes
ls -lhS ~/Library/Application\ Support/mindstone-rebel/*.json | head -10

# Analyze automations.json structure
cat ~/Library/Application\ Support/mindstone-rebel/automations.json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Runs: {len(d.get(\"runs\",[]))}')"
```

### V8 Heap Snapshot (Advanced)

For deep memory analysis, use Chrome DevTools connected to the main process:
1. Start app with `--inspect` flag
2. Open `chrome://inspect` in Chrome
3. Take heap snapshot and analyze retained objects

---

## High-Signal Alarm Lines (grep these — they fire into log files, not at anyone)

The app self-reports its two worst perf failure modes, but only as log lines — historically these fired for months unread (the renderer-growth alarm fired in 12 of 14 qualifying runs before REBEL-5D5 was diagnosed). Grep them whenever investigating perf, and as part of the weekly review:

```bash
# Renderer memory leak alarm — sustained recent growth, GC-robust, throttled (App.tsx)
grep "Renderer memory leak suspected" ~/Library/Application\ Support/mindstone-rebel/logs/*.log

# Sustained idle-CPU alarm (≥3 consecutive >40% peak samples while no turn is active; perfDiagnosticService)
grep "Sustained high idle CPU detected" ~/Library/Application\ Support/mindstone-rebel/logs/*.log
```

**What the renderer-leak alarm means now** (criteria tightened 2026-06-14 — pure predicate `detectSustainedHeapGrowth` in `src/renderer/utils/rendererLeakDetection.ts`, unit-tested in `__tests__/rendererLeakDetection.test.ts`). The pre-fix version compared the two endpoints of the retained sample window and fired on `growthMB > 50 && rate > 30`, which made it noisy: a single one-time heap step-up that then plateaued kept re-firing every tick (54 firings in one v0.4.47 week, the vast majority redundant), and an untrusted wall-span (background-throttle / sleep gaps inflating a 12-sample window to hours) fabricated rate spikes. The alarm now fires only on a **genuine sustained leak**:

- **Newest contiguous segment only** — the window is split wherever an inter-sample gap exceeds 2× the nominal interval (sleep/throttle), and all math runs over the newest contiguous segment, so a post-sleep snapshot can't fabricate a rate.
- **Shape (GC-robust)** — requires a **positive least-squares slope over the latter half of the segment**. This rejects step-then-plateau (≈0 latter-half slope) by construction while tolerating a single V8 GC dip that a "N consecutive increases" check would wrongly reject.
- **Magnitude** — fires when the segment endpoint rate **> 30 MB/hr OR** `growthMB ≥ 45`. The old strict `> 50` floor silently missed an exact ~50 MB/hr leak that only accrues ~48 MB inside the ≤55-min window; the rate path closes that blind spot.
- **Minimum 6 contiguous samples** before any firing.
- **Throttle** — at most one WARN per **30 min**, resetting (immediate re-fire allowed) when current heap drops **≥ 20 MB** below the last-fired level (so a distinct second leak after a GC / session-end isn't hidden). The cheap `Renderer memory diagnostic` INFO line stays **unthrottled** — raw heap is observable every tick even when the WARN is silent.
- New `context` fields `slopeMBPerHr` and `segmentSampleCount` are emitted alongside the existing keys (`growthMB`, `growthRateMBPerHour`, `oldestHeapMB`, `newestHeapMB`, `sampleCount`, …, all preserved for downstream greps).

This makes the REBEL-5D5 post-ship acceptance criterion ("zero renderer growth warnings" over a ≥2h soak; `docs/plans/260611_rebel-5d5-renderer-leak/PLAN.md`) enforceable against a precise alarm rather than a noisy one.

Either line appearing more than once in a week of logs is a real finding: open a diagnosis run (for memory, the Soak Check below has the snapshot + memlab path). Deliberately NOT routed to Sentry for now — a searchable, documented grep beats another alert stream until the sink policy settles.

## Renderer Leak Soak Check (scripted, ~60–90 min, agent-runnable)

The reproduction recipe that diagnosed REBEL-5D5, generalized into a recurring health check. It catches **any** unbounded renderer retention (app maps, library caches, detached DOM) by testing the symptom — heap slope under representative drive — rather than any specific mechanism. Run it weekly (see [WEEKLY_AUTOMATED_REVIEW](WEEKLY_AUTOMATED_REVIEW.md)) or after changes to conversation rendering, virtualization, animation, or session lifecycle.

1. **Launch isolated**: fresh profile + guest mode, from a worktree or checkout of the code under test:
   `REBEL_USER_DATA=$(mktemp -d)/rebel-soak DISABLE_ANALYTICS=1 npm run dev:perf`
   (`dev:perf` is now the recommended command for soak checks — it enables all measurement instrumentation and heap-snapshot IPC without React StrictMode contamination. StrictMode has been decoupled onto `npm run dev:strict` (`VITE_REACT_STRICT_MODE=true`) which should **not** be used for memory/leak snapshots. Set a free `ELECTRON_RENDERER_PORT` in `.env.local` if the default is busy). Drive via the MCP harness / run-app skill.
2. **Drive representative activity ~60–90 min**: short agent turns on a cheap model (key from `evals/configs/.local/keys.env`), spread across ~10 sessions with frequent switching, drawer opens, transcript scrolling. Sample `performance.memory.usedJSHeapSize` + the renderer row of `app.getAppMetrics()` every ~10 min.
3. **Pass/fail**: heap slope **< 30 MB/hr** over the driven window (REBEL-5D5 baseline band was 50–253) and heap visibly steps down after session switches. Single-session-marathon growth ≥ 50 MB/hr sustained → the tracked within-session virtualizer residual (see `docs/plans/260611_rebel-5d5-renderer-leak/PLAN.md` Stage 5).
4. **On fail**: capture T0/T1 snapshots via the dev-gated helper (IPC `system:heap-snapshot-capture`; `rendererHeapSnapshotService.ts`), then diff:
   `node --expose-gc --max-old-space-size=32768 <memlab-cli>/bin/memlab.js find-leaks --baseline <T0> --target <T1> ...`
   (**plain `npx memlab` OOMs** — its shebang pins a 4GB heap; snapshots run ~2.7× live heap, budget disk for ~3GB/pair). Classify clusters **against what's possible in a packaged build** before believing them — the largest REBEL-5D5 dev cluster was a Fast Refresh artifact.

Worked example + full trail: `docs/plans/260611_rebel-5d5-renderer-leak/` (repro, two-arm verification, analysis reports).

## Live Profiling a Packaged / Production Build (Gold-Standard)

This is the highest-signal way to diagnose "high CPU when idle" — and it works on the **exact shipping binary** with **no dev rebuild and no `dev:perf` instrumentation**. It is how the May 2026 idle-CPU root cause (see worked example below) was found in one session, rather than guessed. Use this whenever you have a reproduction running (yours or a user's), before reaching for hypotheses.

The principle: **attach the real V8 inspector to the live process and read function-level evidence, instead of reasoning from code.** The app's own periodic `Memory diagnostic` / `perf-summary` `totalCpuPercent` is a 2–5-min **average** and badly under-reports bursty work (observed: app reported `totalCpuPercent` 5–14% while the OS showed 57–122%). Don't trust the *average* as the CPU signal — profile. (FU-5 added `totalCpuPercentInstant` / `totalCpuPercentPeak` short-window readings + a `"Sustained high idle CPU detected"` warning so the regression now self-reports; those are trustworthy as a *trigger to profile*, but the V8 profile is still the gold-standard for attribution to a function.)

### One-time prerequisite: confirm inspector fuses

A packaged build can only be inspected if its Electron fuses allow it:

```bash
npx @electron/fuses read --app "/path/to/Mindstone Rebel.app" | grep -iE "inspect|RunAsNode"
# need: EnableNodeCliInspectArguments Enabled, RunAsNode Enabled
```

(Our current builds ship with these enabled.)

### Step 1 — find the hot process, confirm it's actually hot

```bash
ps aux | grep "[M]indstone Rebel.app/Contents/MacOS/Mindstone Rebel"   # note the main (Browser) PID
top -l 2 -pid <pid> -stats pid,cpu,th,state | tail -2                  # instantaneous; ps %CPU is a decaying avg
```

A very high **thread count** on the main process (e.g. 100+) is itself a clue — it surfaces native thread pools (LanceDB `tokio-runtime-worker` / `lance-cpu`, `libuv-worker`, V8 background).

### Step 2 — native / thread view with `sample` (zero setup, survives stripped symbols)

```bash
sample <main-pid> 10 -file /tmp/rebel_sample.txt
```

The Electron Framework is stripped, so `sample` maps app addresses to **bogus nearest-export names** (you'll see nonsense like `rust_png$cxxbridge1$...` for unrelated code — ignore the names). What **is** reliable: **thread names** and **kernel frames**. Use them to localize to a subsystem and to tell on-CPU from parked:

- Parked/idle leaves: `mach_msg2_trap`, `__psynch_cvwait`, `kevent`, `__workq_kernreturn` → that thread costs ~nothing.
- Real main-thread work shows as `__CFRUNLOOP_IS_CALLING_OUT_TO_A_SOURCE0_PERFORM_FUNCTION__` → V8 (a CFRunLoop Source0 firing repeatedly = a wakeup/IPC/timer storm dispatched into JS).
- Thread roster tells you which subsystem owns the busy threads (`tokio`/`lance-cpu` = LanceDB vector work, `fse_run_loop (in fsevents.node)` = file watching, etc.).

### Step 3 — JS-level CPU profile via the V8 inspector (the decisive step)

```bash
kill -USR1 <main-pid>                                  # opens the inspector
lsof -nP -p <main-pid> | grep 9229                     # confirm it's listening
curl -s http://127.0.0.1:9229/json/list                # grab the webSocketDebuggerUrl
```

Then capture a profile with `chrome-remote-interface` (already a dependency — **run the script from the repo root so `node_modules` resolves**):

```js
// _cpuprof.js  →  node _cpuprof.js   (run from repo root)
const CDP = require('chrome-remote-interface');
(async () => {
  const c = await CDP({ port: 9229 });
  await c.Profiler.enable();
  await c.Profiler.setSamplingInterval({ interval: 100 }); // microseconds
  await c.Profiler.start();
  await new Promise(r => setTimeout(r, 15000));            // sample 15s
  const { profile } = await c.Profiler.stop();
  await c.close();
  require('fs').writeFileSync('/tmp/rebel.cpuprofile', JSON.stringify(profile));
  // self-time per function
  const agg = new Map(); let tot = 0;
  for (const n of profile.nodes) { const h = n.hitCount||0; tot += h;
    const cf = n.callFrame; const k = `${cf.functionName||'(anon)'}  ${cf.url}:${cf.lineNumber+1}`;
    agg.set(k, (agg.get(k)||0)+h); }
  for (const [k,v] of [...agg].sort((a,b)=>b[1]-a[1]).slice(0,30))
    console.log(`${(v/tot*100).toFixed(1)}%  ${k}`);
})();
```

`/tmp/rebel.cpuprofile` also loads directly in Chrome DevTools → Performance → "Load profile…". For caller attribution (not just self-time), walk the node tree up from hot leaves (`lstat`/`readdir`/etc.) to the nearest named app frames.

### Step 4 — de-minify the production bundle frames

Profiles of a packaged build point into minified `app.asar/.vite/build/index-*.js`. Resolve a frame to real code:

```bash
ASAR="/path/to/Mindstone Rebel.app/Contents/Resources/app.asar"
npx asar extract-file "$ASAR" ".vite/build/index-XXXX.js"   # writes ./index-XXXX.js
```

The profile's `callFrame` carries `lineNumber` + `columnNumber`. Minified lines are tens of thousands of chars wide — **slice the exact column** (e.g. in Python: `open(f).read().split('\n')[line-1][col-1-80 : col-1+600]`) to read the surrounding identifiers and nearby **string literals** (file paths, log messages like `"file_neighbors.invalidate"`) that reveal the real function. Then `rg` those literals in `src/` to land on the TypeScript source. (No sourcemaps ship in the asar.)

### Running a spike / controlled reproduction

- **Profile the real thing:** build your branch (`npm run package`) and `open` the `.app` against the real userData so it hits real workspace data; capture a **BEFORE baseline** (profile + key log rates such as the `file_neighbors.invalidate`/min rate) so the AFTER is a true comparison, not a vibe.
- **UI-driven spikes / hidden test window:** use [`.factory/commands/test-ui.md`](../../.factory/commands/test-ui.md) (Factory Droid) or the Claude Code `/run` skill at [`.claude/skills/run-app/SKILL.md`](../../.claude/skills/run-app/SKILL.md) — these launch the app under CDP in an offscreen window with guest mode + onboarding bypass, for clicking around and reproducing UI-triggered hot paths.
- **Micro-spike a single function:** when the profile fingers one function, a tiny node script that calls the old vs new implementation on real inputs while counting syscalls (spy on `fs.readdirSync`/`lstatSync`) proves the per-call cost change without launching the whole app.

### Worked example (May 2026 — REBEL idle-CPU)

Live inspector profile of the idle packaged main process: **`lstat` 15% + `readdir` 8.6%** of a core, continuously, while "idle." De-minified the hot stack to `tryConvertToWorkspacePath` (`src/core/utils/systemUtils.ts`) doing an **O(workspace-size) recursive tree walk per file** to convert absolute→workspace-relative paths, driven by a **never-converging lazy-fill loop** over 321 files with all-NaN chunk embeddings (the `failed===0` checkpoint never advanced). None of this was visible in the app's self-reported `totalCpuPercent`. Full trail: `docs/plans/260529_perf-idle-fs-walk/`.

---

## React Profiler Diagnostics (Dev Perf Mode)

When running `npm run dev:perf`, key React components are instrumented with the React Profiler API to track render performance. To avoid subscribing every profiled surface to `AppContext`, profiler hits are emitted as renderer `console.warn` lines and captured by the main log bridge with the `[Renderer]` prefix.

### Enabling and Viewing

Profiler logs require `npm run dev:perf` (sets `VITE_PERFORMANCE=true`).

Search logs for: `[SWITCH-PERF-REACT]`

```bash
# Find slow renders (actualDuration in logs)
grep '\[SWITCH-PERF-REACT\]' ~/Library/Application\ Support/mindstone-rebel/logs/*.log | tail -50

# Example line:
# [Renderer] [SWITCH-PERF-REACT] id=ConversationPane phase=update actualMs=23.4 baseMs=45.7 renderCount=142 startMs=12345.7 commitMs=12369.1
```

### Log Format

```text
[Renderer] [SWITCH-PERF-REACT] id=ConversationPane phase=update actualMs=23.4 baseMs=45.7 renderCount=142 startMs=12345.7 commitMs=12369.1
```

### Instrumented Components

| Component | Why Instrumented |
|-----------|------------------|
| `ConversationPane` | Message list rendering (highest re-render frequency) |
| `AgentSessionSidebar` | Session history with search (400+ items) |
| `InteractionStrip` | Input handling, voice controls |
| `SettingsSurface` | Complex settings forms |
| `InsightsDrawer` | Insights panel rendering |
| `HomepagePanel` | Homepage content |
| `UseCasesPanel` | Use cases listing |
| `InboxPanel` | Inbox items rendering |
| `AutomationsPanel` | Automations listing |
| `LibraryDrawer` | Library content panel |

### Interpretation Guide

- **`actualDuration`** - Time React spent rendering (ms). Renders >16ms may cause dropped frames (60fps budget).
- **`baseDuration`** - Estimated time without memoization. If `baseDuration ≈ actualDuration`, memoization isn't helping. If `baseDuration >> actualDuration`, memoization is effective.
- **`renderCount`** - Total renders since app start. High count with low duration indicates "render thrash" (many fast renders).
- **`phase`** - `mount` (first render), `update` (re-render), `nested-update` (re-render during another render).
- **StrictMode note**: React StrictMode double-invokes renders and produces paired `mount` events. This only applies under `npm run dev:strict` (`VITE_REACT_STRICT_MODE=true`) — **not** under plain `dev` or `dev:perf`. Do not use `dev:strict` when running leak/memory snapshots.

### Diagnostic Workflow for AI Agents

1. **Find slow renders**: Grep for `[SWITCH-PERF-REACT]`, sort by `actualMs`
2. **Check for render thrash**: Look for components with high `renderCount` but normal `actualDuration` (e.g., 1000+ renders at <5ms each = CPU burn)
3. **Identify memoization opportunities**: If `actualDuration ≈ baseDuration`, the component may benefit from `React.memo()`
4. **Drill deeper**: If a slow component is identified, consider adding a temporary `useWhyDidYouUpdate` hook to that component to see which props are changing

### Thresholds and Rate Limiting

- **Threshold**: Only renders with `actualDuration > 16ms` are logged (60fps frame budget)
- **Rate limit**: Max 10 logs per component per 10 seconds to prevent log flood
- **No production impact**: Requires `VITE_PERFORMANCE=true` (opt-in via `npm run dev:perf`) - see `src/renderer/components/DevProfiler.tsx` line 66

### Adding Instrumentation

See `src/renderer/components/DevProfiler.tsx` for implementation and usage examples.

---

## Dev Performance Monitor (Dev Mode)

Automatically active when running `npm run dev` (gated by `import.meta.env.DEV` in renderer, `!app.isPackaged` in main process). Zero production cost — Vite tree-shakes the renderer code entirely; main process code is skipped via the `isPackaged` check.

**Two tiers of instrumentation:**
- **Always-on (dev mode):** `useDevPerformanceMonitor` — Long task + input latency monitoring. Active whenever `import.meta.env.DEV` is true (any `npm run dev` variant).
- **Opt-in (dev:perf):** DevProfiler, React Profiler, wdyr, session switch/IPC timings, **main process V8 CPU profiler**, **memory update I/O capture**, **heap-snapshot IPC** — require `npm run dev:perf` (`VITE_PERFORMANCE=true REBEL_PERF_MODE=1 CAPTURE_MEMORY_UPDATES=1`). `dev:perf` is **heap-snapshot-safe** — React StrictMode is not enabled, so fiber/listener retention is not artificially doubled. This is the recommended command for leak soak checks and FOX-3518-class repros.

**`dev:perf` vs `dev:perf:validate`:** `dev:perf` is a **measurement baseline** — pure observability, no behavior changes. Use it when you want to diagnose current app behavior without contaminating the signal. `dev:perf:validate` composes `dev:perf` + forward-looking-default behavioral flags (currently `REBEL_INDEXER_PAUSE_ON_BLUR=1`) — use it when you want to validate a fix that lives behind an opt-in flag. Kill switches (`REBEL_DISABLE_LAZY_CPU_WARMUP=1`, `REBEL_DISABLE_PLUGIN_COALESCE=1`, etc.) are deliberately never bundled into either script; they stay explicit so no one accidentally profiles a reversion.

**`dev:strict` (`VITE_REACT_STRICT_MODE=true`):** Enables React StrictMode (double-mount, double-effect) for render-correctness debugging. Deliberately separate from `dev:perf` — use it to catch missing effect cleanup or side-effect idempotency issues, but **never for memory/leak work** (StrictMode contaminates fiber/DOM/listener retention counts).

### What It Measures

| Layer | Where | What | Threshold |
|-------|-------|------|-----------|
| **1. Long Task Observer** | Renderer | Any main-thread task detected by `PerformanceObserver('longtask')` | >50ms |
| **2. Input Event Latency** | Renderer | Time from hardware keydown (`event.timeStamp`) to next `requestAnimationFrame` | >100ms |
| **3. Event Loop Monitor** | Main process | `setInterval` + `setImmediate` delta (detects main process blocking that delays IPC) | >100ms |

### Output

**Renderer** (browser console): Aggregated every 10 seconds into a single `console.warn` line:

```
[PERF] | LongTasks: 3x (p50=120ms p95=450ms max=1200ms) | InputLag(>100ms): 5x (p50=180ms p95=900ms max=1400ms)
```

- No output if the window had no threshold-exceeding events (quiet when healthy).

**Main process** (terminal / log file): Per-event warnings when event loop is blocked:

```
[PERF] Main process event loop blocked  lagMs=350
```

### Interpreting Results

- **LongTasks present, InputLag absent** → Main thread is busy but not during typing (background work).
- **Both LongTasks and InputLag present** → Main thread blocking during user interaction. Correlate timestamps with React Profiler logs to identify which component render is causing it.
- **Only main process event loop blocked** → IPC responses are delayed. Health checks, MCP operations, or sync I/O in the main process is the bottleneck. Renderer inputs feel laggy because IPC round-trips are queued.
- **InputLag with p95 >500ms** → User is experiencing severe typing lag. The p50/p95/max breakdown shows whether it's consistent or intermittent.

### Diagnostic Workflow

1. Run `npm run dev`, open any text input, type rapidly for ~30 seconds
2. Check browser console for `[PERF]` lines
3. Check terminal output for `[PERF] Main process event loop blocked`
4. If renderer long tasks are the culprit, enable the React Profiler (`VITE_PERFORMANCE=true npm run dev`) to identify which component
5. If main process event loop is blocked, check for sync I/O, health checks, or MCP operations running at the time

### Implementation

- Renderer: `src/renderer/hooks/useDevPerformanceMonitor.ts` — mounted in `src/renderer/main.tsx`
- Main process: Event loop monitor in `src/main/index.ts` (search for `Event Loop Monitor`)

---

## Main Process CPU Profiler (Dev Perf Mode)

Automatic V8 CPU profiling of the main process to diagnose background CPU usage with **function-level attribution**. Captures profiles during idle periods and produces both Chrome DevTools-compatible `.cpuprofile` files and machine-readable summaries.

### Enabling

Requires `npm run dev:perf` (sets `REBEL_PERF_MODE=1`). Zero production cost -- never loaded outside dev:perf.

### How It Works

- Every 5 minutes, checks if the app is idle (0 active agent turns for 60+ seconds)
- If idle, captures a 15-second V8 CPU profile using the `node:inspector` module
- Writes raw `.cpuprofile` (loadable in Chrome DevTools Performance tab)
- Writes `.summary.json` with top functions ranked by self-time
- Logs a structured event with key findings
- Rotates old profiles (keeps max 20)

### Output Location

```
~/Library/Application Support/mindstone-rebel/cpu-profiles/
  cpu-2026-03-25T15-30-00-000Z.cpuprofile    # raw V8 profile
  cpu-2026-03-25T15-30-00-000Z.summary.json  # AI-readable summary
```

### Viewing Profiles

**In Chrome DevTools:**
1. Open Chrome → DevTools → Performance tab
2. Click "Load profile..." and select a `.cpuprofile` file
3. Use the flame chart to identify hot functions

**Machine-readable summaries:**

```bash
# View latest summary
cat ~/Library/Application\ Support/mindstone-rebel/cpu-profiles/*.summary.json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Active: {d[\"appCpuPercent\"]}% | Idle: {d[\"idlePercent\"]}% | GC: {d[\"gcPercent\"]}%'); [print(f'  {f[\"selfTimePercent\"]:5.1f}%  {f[\"functionName\"]}  ({f[\"url\"]}:{f[\"lineNumber\"]})') for f in d['topFunctions'][:10]]"
```

Search logs for: `"profilerChannel":"main-cpu"`

### Summary JSON Format

```json
{
  "timestamp": "2026-03-25T15:30:15.000Z",
  "durationMs": 15000,
  "totalSamples": 15000,
  "idlePercent": 85.2,
  "gcPercent": 1.3,
  "appCpuPercent": 13.5,
  "topFunctions": [
    {
      "functionName": "JSON.stringify",
      "url": "",
      "lineNumber": -1,
      "selfTimeUs": 450000,
      "selfTimePercent": 3.0,
      "sampleCount": 450
    }
  ],
  "topStacks": [
    {
      "selfTimeUs": 450000,
      "stack": ["JSON.stringify", "commitState (automationScheduler.ts:1107)", "..."]
    }
  ]
}
```

### What to Watch For

- **`appCpuPercent` > 20% during idle** -- main process is doing significant work with no active turns
- **`gcPercent` > 10%** -- V8 garbage collection pressure, likely from large objects or frequent allocations
- **Repeated function in topFunctions** -- that function is a persistent CPU consumer
- **`(idle)` < 80%** -- main process is rarely idle, something is keeping it busy

### Implementation

- Service: `src/main/services/cpuProfilerService.ts`
- Integration: `src/main/index.ts` (search for `CPU Profiler`)
- Gate: `!app.isPackaged && process.env.REBEL_PERF_MODE === '1'`

---

## Main Process Memory Profiler (Dev Perf Mode)

Periodic V8 heap space breakdowns and process memory metrics. Complements the CPU profiler for memory-focused diagnosis.

### Enabling

Same as CPU profiler: `npm run dev:perf` (sets `REBEL_PERF_MODE=1`).

### How It Works

- Every 5 minutes, captures a memory snapshot
- Writes `.memory.json` files with V8 heap space breakdown, heap statistics, process memory, and session count
- Logs a structured event with key metrics
- Rotates old snapshots (keeps max 20)

### Output Location

```
~/Library/Application Support/mindstone-rebel/memory-profiles/
  mem-2026-03-25T15-30-00-000Z.memory.json
```

Search logs for: `"profilerChannel":"main-memory"`

### What It Captures

- **V8 heap spaces:** new_space, old_space, code_space, large_object_space sizes (used/available/committed)
- **V8 heap statistics:** total heap, malloced memory, external memory, native/detached context counts
- **Process memory:** RSS, heapUsed, heapTotal, external, arrayBuffers
- **Session count:** number of sessions in the in-memory index

### What to Watch For

- **`old_space` growing steadily** -- long-lived objects accumulating (potential leak)
- **`numberOfDetachedContexts` > 0** -- detached DOM contexts not being GC'd
- **`external` or `arrayBuffers` growing** -- native memory pressure (e.g., from WebGPU buffers)
- **Session count mismatched with expected** -- index may be stale or corrupted

### Implementation

- Service: `src/main/services/memoryProfilerService.ts`
- Integration: `src/main/index.ts` (search for `Memory Profiler`)
- Gate: `!app.isPackaged && process.env.REBEL_PERF_MODE === '1'`

---

## Memory Update I/O Capture (Dev Perf Mode)

Captures full memory update inputs and outputs to a JSONL file for eval fixture mining and cost analysis. Part of the memory cost optimization work — see `docs/plans/260414_memory_notes_cost_optimization.md`.

### Enabling

Included in `npm run dev:perf` (sets `CAPTURE_MEMORY_UPDATES=1`). Can also be enabled standalone: `CAPTURE_MEMORY_UPDATES=1 npm run dev`.

### Output Location

```
~/Library/Application Support/mindstone-rebel/memory-update-captures.jsonl
```

One JSON line per memory update turn, appended on completion (success, error, or unhandled rejection).

### What It Captures

| Field | Description |
|-------|-------------|
| `ts` | Unix timestamp (ms) |
| `turnId`, `originalTurnId`, `originalSessionId` | Turn context (session IDs hashed) |
| `prompt` | Full memory update prompt sent to the model |
| `resultText` | Model response text |
| `entityUpdates` | Parsed entity updates (if any) |
| `toolCalls` | Tool call log (detail truncated to 2000 chars) |
| `model` | Model used for this update |
| `costUsd`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens` | Cost and token usage |
| `durationMs` | Wall-clock duration |
| `error` | Error message (if failed) |

### Viewing Captures

```bash
# Count captures
wc -l ~/Library/Application\ Support/mindstone-rebel/memory-update-captures.jsonl

# View latest capture (pretty-printed)
tail -1 ~/Library/Application\ Support/mindstone-rebel/memory-update-captures.jsonl | python3 -m json.tool

# Check cost distribution
cat ~/Library/Application\ Support/mindstone-rebel/memory-update-captures.jsonl | \
  python3 -c "import json,sys; lines=[json.loads(l) for l in sys.stdin]; costs=[l.get('costUsd',0) or 0 for l in lines]; print(f'Captures: {len(lines)} | Total cost: \${sum(costs):.4f} | Avg: \${sum(costs)/len(costs):.6f}')" 2>/dev/null
```

### Notes

- **No rotation or size cap** — the file grows unboundedly. Delete manually when done mining fixtures.
- **Privacy**: Session IDs are hashed via `hashSessionId()`. Prompts and responses contain user content — treat the file as sensitive.
- **Performance**: Fire-and-forget `fs.appendFile` (same pattern as `costLedgerService`). No measurable impact on turn latency.
- **Implementation**: `src/core/services/memoryUpdateService.ts` — search for `isCaptureEnabled`.
- **Related eval harness**: `evals/memory-update-quality.ts` (quality eval), `evals/memory-update-ab.ts` (cost/quality A/B comparison).

---

## CLI Profiling for Agent Turns

The headless CLI includes a `--profile` flag for measuring agent turn performance:

```bash
# Basic profiling
npm run cli -- run -p "Hello" --profile

# JSON output for programmatic analysis
npm run cli -- run -p "Hello" --profile --json
```

**Metrics reported:**
- **TTFT (Time to First Token)** - Latency until first assistant response
- **Total duration** - Full turn execution time
- **Cache hit ratio** - Prompt caching effectiveness (0-100%)
- **Token counts** - Input, output, cache_create, cache_read

**Example output:**
```
[profile] TTFT: 4763ms | Total: 10124ms | Cache hit: 100.0%
[profile] First event: 8ms | In: 3 | Out: 181
[profile] Model: claude-sonnet-4-5[1m]
```

**Use cases:**
- Measure cold vs warm cache performance (run twice in succession)
- Profile MCP tool latency (Super-MCP starts automatically in CLI mode)
- Detect system prompt bloat (higher TTFT indicates larger prompts)
- A/B test prompt changes for latency impact

See [HEADLESS_CLI_ENTRYPOINT_REFERENCE.md](./HEADLESS_CLI_ENTRYPOINT_REFERENCE.md) for full documentation.

---

## Performance Best Practices

### Typing Performance (Composer Input)

The composer input must remain responsive during typing. Key optimizations:

- **Draft sync is debounced**: Draft text syncs to the session store 1 second AFTER typing stops (not during). This prevents sidebar re-renders from blocking the input. See `DRAFT_SYNC_DEBOUNCE_MS` in `ComposerWithState.tsx`.
- **Sidebar uses deferred values**: The sidebar's draft subscription uses `useDeferredValue` to allow updates to lag behind typing without blocking.
- **Why this matters**: The sidebar renders 400+ session items. Without debouncing, every draft update triggers a full sidebar reconciliation (300-500ms), blocking the main thread and causing visible typing lag.

If typing feels laggy, check:
1. Is `DRAFT_SYNC_DEBOUNCE_MS` set appropriately (default: 1000ms)?
2. Are there other stores/effects triggering on every keystroke?
3. Is the sidebar virtualized or memoized appropriately?

### For electron-store Usage

- Keep store data small (<1MB ideally)
- Don't store data that's already persisted elsewhere
- Consider file-per-record patterns for large collections (like `sessions/`)
- Use `{ persist: false }` for frequent in-memory-only updates

### For Long-Running Sessions

- Clean up turn state after completion (`agentTurnRegistry.cleanupTurn()`)
- Truncate large tool outputs before accumulating (`sanitizeEventForMainAccumulation()`)
- Cap history arrays with reasonable limits

### For IPC and Broadcasts

- Don't broadcast full state objects frequently
- Use diffs or minimal payloads for progress updates
- Debounce rapid state changes

---

## Profiling Analysis Workflow

Step-by-step guide for running a profiling session and interpreting results.

### Running a Profiling Session

```bash
# Start the app with all profiling instrumentation enabled
npm run dev:perf

# For CPU worker idle disposal testing, also set:
REBEL_CPU_IDLE_DISPOSAL=1 npm run dev:perf
```

Exercise the app normally for **30+ minutes** to accumulate meaningful data. Key activities: browse sessions, run agent turns, switch between sessions, use search, leave idle for 10+ minutes.

### Where to Find Each Data Source

| Data Source | Log Search Pattern | Files |
|-------------|-------------------|-------|
| **IPC latency** | `profilerChannel.*ipc-latency` | Logs every 5 min |
| **Memory diagnostics** | `Memory diagnostic` | Logs every 5 min |
| **Renderer leak diagnostics** | `Renderer leak diagnostics` | Logs every 5 min (dev:perf) |
| **CPU profiles** | `profilerChannel.*main-cpu` | `~/Library/Application Support/mindstone-rebel/cpu-profiles/` |
| **Memory profiles** | `profilerChannel.*main-memory` | `~/Library/Application Support/mindstone-rebel/memory-profiles/` |
| **Startup waterfall** | `profilerChannel.*startup-waterfall` | Logs (10s after window created) |
| **React profiler** | `profilerChannel.*react-profiler` | Logs (renders >16ms) |
| **Library watcher events** | `profilerChannel.*library-watcher` | Logs (dev:perf, tree-affecting events only) |
| **Long tasks** | `[PERF]` in renderer console | Browser console, every 10s |
| **Process breakdown** | `Process breakdown` in logs | Logs every 5 min |

### What to Look For

**Memory growth:**
- Any process `workingSetMB` growing steadily → memory leak in that process
- Process labels now include service names (e.g., `embedding-worker:48467`) for utility processes
- `mainUI` growth with high `toolArchiveKeys` → tool detail archive retention (bounded since April 2026)
- `utility` process >500MB when idle for 30+ min → CPU embedding worker without idle disposal

**IPC bottlenecks:**
- Highest-volume channels (calls per 5 min) — look for N+1 patterns
- Highest-latency channels (p95 > 100ms) — potential blocking operations
- `library:read-file` at 100+ calls/5min idle → library refresh cascade (fixed via bulk scan-skills in April 2026)

**Idle waste:**
- Long tasks present when app is idle → unnecessary periodic work
- Long task attribution (added April 2026) shows `source=type(label)` to identify culprit
- `system:health-check` at 580ms+ p95 → health check polling overhead

**Startup:**
- Startup waterfall shows elapsed/delta per milestone
- `window-created` milestone >5s → investigate pre-window blocking work

### Repeating This Analysis

1. Clear old profiling data: `rm -rf ~/Library/Application\ Support/mindstone-rebel/{cpu-profiles,memory-profiles,renderer-profiles,perf-summaries}/*`
2. Start fresh: `npm run dev:perf`
3. Baseline: note initial memory per process from first `Memory diagnostic` log
4. Exercise: use app normally for 30+ min
5. Compare: check memory growth, IPC volumes, long task frequency
6. Export: copy log file for offline analysis

For detailed evidence from the April 2026 profiling investigation, see `docs/plans/260414_perf_optimization_from_profiling.md`.

---

## Known Performance Issues (April 2026)

Issues identified through profiling analysis (see `docs/plans/260414_perf_optimization_from_profiling.md` for full evidence).

### CPU Embedding Worker — No Idle Disposal (FIXED)
**Issue:** The CPU embedding worker (`utilityProcess.fork` with `serviceName: 'Embedding Worker'`) grew to 1GB+ and was never reclaimed, even after 30+ minutes idle. Unlike the GPU worker, it had no idle timeout.

**Fix (commit TBD):** Added idle disposal following the GPU worker pattern — 5-minute timeout, dispose handshake, on-demand re-init. Gated behind `REBEL_CPU_IDLE_DISPOSAL=1` env var until validated. Key files: `src/main/services/embeddingService.ts`.

### Library Refresh N+1 IPC Cascade (FIXED)
**Issue:** Each library refresh triggered `library:list-files` (1 call) + `library:read-file` (N calls, one per SKILL.md) — 150+ IPC calls per refresh. With cloud sync and watcher events, this happened 3-9 times per 5 minutes while idle, producing 450-1,350 unnecessary IPC calls.

**Fix (commit TBD):** Replaced N individual reads with `library:scan-skills` bulk IPC (2 parallel calls total). Added 500ms trailing debounce on renderer-side refresh. Key files: `src/renderer/features/library/hooks/useLibraryIndex.ts`, `src/renderer/hooks/useIpcListeners.ts`.

### Renderer toolDetailArchive Unbounded Growth (FIXED)
**Issue:** `toolDetailArchive` in cached sessions stored raw tool I/O strings with no caps. One session had 149 archive keys with potentially large JSON strings, contributing to the renderer growing from 311MB to 848MB.

**Fix (commit TBD):** Added per-session cap (50 entries) and per-value size cap (10KB with truncation marker). Key files: `src/renderer/features/agent-session/store/sessionStore.ts`.

### Conversation-Shape O(n²) Rebuild on Long Turns (May 2026 — FIXED)
**Issue:** `LazyContextAccumulator.getConversationShape()` rebuilt `ConversationStateShape` by replaying
the entire per-turn event array from scratch, and the shared reducer copies the growing
`eventsByTurn[turnId]` array on every folded event — so one rebuild was **O(n²)**. `appendEvent`
invalidated the cache every event, and **periodic checkpointing calls `getConversationShape()` every 15s**
(`turnCheckpointService.ts`, `DEFAULT_CHECKPOINT_INTERVAL_MS`), so each tick paid a fresh cold rebuild.
On a 22-minute automation accumulating ~45,000 events this was a multi-second **synchronous main-thread
block every ~15–20s → macOS beachball + queued-keystroke "catch-up"** (input flushes once the block ends).

**How it was found:** live V8 CPU profile of the running packaged main process (the gold-standard
playbook above) — `getConversationShape` 19.6% + the reducer 12.3% self-time = ~85% of non-idle
main-thread JS, while the app's own `totalCpuPercent` average under-reported it. Logs showed the
`Periodic checkpoint` cadence stretched to ~17–22s (the extra time = the block).

**Fix:** `getConversationShape()` made O(n) — feeds the reducer `eventsByTurn: {}` on non-terminal fold
steps (the terminal-busy guard's `terminatedTurnIds` Set is the equivalent O(1) fallback) and injects the
exact prior prefix only on `result`/`error` steps (the only steps whose message *content* depends on
event history — `mergeResultMessage`/`mergeErrorMessage`). Byte-identical to the old full replay (guarded
by a parity-vs-`replayFromScratch` test). `appendEvent` and the shared reducer are unchanged. Key file:
`src/core/services/lazyContextAccumulator.ts`. Plan: `docs/plans/260531_perf-accumulator-shape-on/`.

**Deferred:** the same turn streamed ~45k `stream_event` deltas (vs 37 messages) — reducing accumulated
delta volume (main + renderer memory, IPC) is a separate follow-up; the O(n) rebuild already removes the
beachball regardless of event count.

### Remaining Investigations
- **Renderer memory growth beyond toolDetailArchive** — `currentSessionEvents` (unbounded while session active), coaching/eligibility caches (never pruned). See `docs/plans/260414_perf_optimization_from_profiling.md` Stage 8 (deferred).
- **Health check polling cost** — `system:health-check` at 580-880ms p95 every 5 minutes while idle. See Stage 9 (deferred).
- **Idle long tasks** — 1-3 per 10 seconds even when idle. Long task attribution (added April 2026) helps identify culprits.

---

## Automated Performance Regression Tests

See [PERFORMANCE_TESTING.md](./PERFORMANCE_TESTING.md) for the full reference on automated perf regression tests (`npm run test:e2e:perf`): IPC payload guards, memory leak detection, CDP structural metrics, startup timing, and CI integration guidance.

**Quick summary**: Deterministic metrics (IPC payload size, memory after GC, layout counts) block PRs safely. Timing metrics (startup time, long tasks) warn but never block -- CI variance makes timing gates unreliable. See the linked doc for the relationship between `dev:perf` (manual debugging) and `test:e2e:perf` (automated gates).

## Performance Investigation Playbook

- Enable the main-process perf investigation signals with `REBEL_PERF_MODE=1` (or just run `npm run dev:perf`, which already sets it). This turns on startup waterfall marks plus the periodic counter summaries.
- Planned kill switches for the coalescing stages are `REBEL_DISABLE_PLUGIN_COALESCE=1` and `REBEL_DISABLE_SPACES_COALESCE=1`. They are documented here as flag contracts from `docs/plans/260420_perf_observability_and_low_risk_wins.md`; Stages 4 and 5 will wire them up when those changes land.

### Reading `HotPathCounters`

The periodic `profilerChannel: 'perf-summary'` record includes `HotPathCounters` objects for the hot fan-in points. Read them as:

- `requests`: total calls into the public entrypoint
- `hits`: served from cache / fast path
- `misses`: cold misses that needed the expensive path
- `inflightJoins`: callers that piggybacked an already-running fetch
- `underlyingFetches`: actual expensive executions
- `fetchErrors`: underlying failures
- `maxConcurrentInflight`: peak simultaneous expensive executions seen in the session

Before a coalescing fix lands, the signal to watch is usually `maxConcurrentInflight` being greater than `1`. After the fix, the target is `maxConcurrentInflight = 1` with `inflightJoins > 0`.

### Reading the startup waterfall

Search logs for `profilerChannel: 'startup-waterfall'`. The record is a milestone timeline captured from the main process, with elapsed and delta timings between named startup steps. Use it to find large opaque gaps first; only chase startup work that shows up as a dominant contiguous segment.

### Reading the periodic perf summary

Search logs for `profilerChannel: 'perf-summary'` (the message text is still `Memory diagnostic`). That record combines:

- process memory / CPU snapshots
- `settingsNormalization` call + write counts
- hot-path counter snapshots for plugin identity and space scans

This is the quickest way to answer “is the app idle, or quietly doing something expensive every few seconds?”

### Related plan and follow-ups

- Full plan, acceptance criteria, and deferred backlog: `docs/plans/260420_perf_observability_and_low_risk_wins.md`
- Synthetic flurry helper: `scripts/perf-flurry.ts (path removed — verify)` — **TBD** (no checked-in script yet)

---

## Maintenance

When adding new persistent stores or in-memory caches:
1. Add size tracking to the periodic memory diagnostic
2. Implement cleanup/pruning for bounded growth
3. Document expected size ranges in this doc
4. Consider file-per-record patterns for collections that grow unboundedly
