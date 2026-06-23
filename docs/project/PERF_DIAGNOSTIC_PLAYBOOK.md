---
description: "Operational playbook for Rebel performance diagnostics — process telemetry, memory logs, measurement sessions, red-flag greps"
last_updated: "2026-05-27"
---

# Perf Diagnostic Playbook

> **When to use this**: you want to diagnose CPU / memory / beach-ball / idle-churn symptoms in Rebel's main + secondary processes (renderer, GPU, utility, MCP, super-mcp, workers) in foreground or background.
>
> **Canonical spec**: [docs/plans/260423_secondary_process_cpu_observability.md](../plans/260423_secondary_process_cpu_observability.md). This playbook operationalises that plan's Stage 5 deliverable: the 20-minute measurement recipe + the AC1–AC5 acceptance harness.

## What's always-on

Since Stages 1, 2, 4a, 4b of the 260423 plan landed, Rebel ships with an always-on periodic diagnostic that writes a structured `Memory diagnostic` log entry every **5 minutes** when focused and **every 120 s** when blurred or minimised. The old blur-pauses-the-timer gap (> 20 min of silence after a single blur) is closed.

Each `Memory diagnostic` entry carries:

| Field                 | Stage | What's in it                                                                                         |
|-----------------------|-------|------------------------------------------------------------------------------------------------------|
| `blurState`           | 1     | `'focused'` \| `'blurred'` \| `'minimized'` — drives cadence choice                                  |
| `processes[]`         | 1     | Per-process CPU / RSS rollup; includes a `type: 'subprocess'` synth row for super-mcp (Stage 4a)     |
| `eventLoopDelay`      | 2     | `{ p50, p95, p99, max, mean, windowDurationMs }` or `{ status: 'unavailable' }` — core service       |
| `gpuLifecycle`        | 1     | GPU process crash / restart counters                                                                  |
| `superMcpLifecycle`   | 4a    | `{ pid, uptime, startCount, restartCount, circuitBreakerActive, ... }` or `null` if not running      |
| `superMcpChildStats`  | 4b    | Status `'ok' \| 'error' \| 'timeout' \| 'unsupported' \| 'stale' \| 'unavailable'` + cached `/stats` |
| _(deferred)_ renderer long-tasks | 3 | Stage 3 prod path is killswitched pending security refinement — dev mode console only                 |

### Counter schema (Stage 5 structural guardrail)

High-churn counters now use an explicit windowed shape so they cannot be misread as "5-minute rates" when they are actually process-lifetime totals:

```json
{
  "rate5m": 12,
  "cumulative": 47
}
```

- `rate5m`: rolling count observed in the last 5 minutes.
- `cumulative`: total count since process start.

This applies to `settingsNormalization` (`calls`, `writes`), `scanSpacesCounters` (including `requests`, `cacheHits`, `coalescedHits`), `scanSpacePluginsCounters` (`requests` and peers), and renderer `imageDataUrlCacheEvictions`.

## Log locations

| OS       | Path                                                                            |
|----------|---------------------------------------------------------------------------------|
| macOS    | `~/Library/Application Support/mindstone-rebel/logs/mindstone-rebel.log`        |
| Linux    | `~/.config/mindstone-rebel/logs/mindstone-rebel.log`                            |
| Windows  | `%APPDATA%\mindstone-rebel\logs\mindstone-rebel.log`                            |

Renderer `console.warn` / `console.error` are captured to the same file with `[Renderer]` prefix. The log rotates at 5 MB via `pino-roll`; the current file is always `mindstone-rebel.log` and rolled history lives alongside (typically `mindstone-rebel.log.1`, `.2`, ...). The acceptance harness (`scripts/perf-acceptance-check.ts`) auto-glob-aggregates `mindstone-rebel.log*` in the logs directory when run without `--log` so rotated lines still count — but an ad-hoc `grep` against just the current file may miss older samples.

## Sessions A–E: the 20-minute measurement recipe

Run against a **packaged** build (not `npm run dev`) for realistic numbers. Each session is roughly 20 minutes (A, B, D, E) or 10 minutes (C).

### Session A — idle foreground (20 min)

1. Launch the packaged app. Sign in if needed. Open the normal work surface.
2. Do nothing. Keep the app focused. No mouse, no keyboard.
3. After 20 minutes, tail the log and expect ≥ 4 `Memory diagnostic` lines at the 5-minute cadence with `blurState: 'focused'`.

Target: baseline idle CPU / memory for a focused app.

### Session B — idle background (20 min)

1. Launch the app. Focus another app so Rebel blurs.
2. Optionally also minimize. Leave for 20 minutes.
3. Expect ≥ 8 `Memory diagnostic` lines at the 120 s cadence with `blurState: 'blurred'` or `'minimized'`.

**This is the session that previously failed** (single blur → 22 min silence). If this session produces a gap > 180 s between samples, Stage 1 has regressed — AC1 failure.

### Session C — active conversation (10 min)

1. Launch the app, start a conversation that exercises tools (MCP calls, embeddings, sub-agents).
2. Note the start wall-time.
3. Expect `superMcpChildStats.status: 'ok'` with populated `children[]` showing `spawn_count`, `reap_count`, `idle_ms` progressing.

### Session D — MCP-disabled control (20 min)

1. Set `REBEL_DISABLE_MCP=1` (or disable via settings), launch, idle foreground.
2. `superMcpLifecycle` should be `null` or `isRunning: false`; `superMcpChildStats.status` should be `'unavailable'`.
3. The `processes[]` synth row labelled `super-mcp` should drop off (or no longer appear).

### Session E — watcher-quiet control (20 min)

1. Close all Obsidian vaults / file-watcher-heavy surfaces. Launch, idle foreground.
2. Compare main-process RSS growth vs Session A.

## Red-flag greps

Recipes below are given in both **macOS / Linux** (Bash + `grep`/`jq`) and **Windows** (PowerShell + `Select-String`) form. `$LOG` is the log path (see table above); on PowerShell use `$LOG = "$env:APPDATA\mindstone-rebel\logs\mindstone-rebel.log"`. `jq` is optional; a portable `ripgrep` fallback is given where it matters.

### 1) Any Memory diagnostic lines at all (sanity check)

```bash
# Bash
grep '"msg":"Memory diagnostic"' "$LOG" | wc -l
```

```powershell
# PowerShell
(Select-String -Path $LOG -Pattern '"msg":"Memory diagnostic"').Count
```

### 2) Event-loop lag over 100 ms p95

```bash
# Bash — precise
grep '"msg":"Memory diagnostic"' "$LOG" | jq -c '.eventLoopDelay.p95 | select(. > 100)'

# Portable — any 3-digit+ p95 (approximation, no jq required)
rg --pcre2 '"p95":\d{3,}' "$LOG"
```

```powershell
# PowerShell — approximation via regex
Select-String -Path $LOG -Pattern '"p95":\d{3,}'
```

### 3) Super-mcp circuit-breaker activation

```bash
grep '"msg":"Memory diagnostic"' "$LOG" | jq -c '.superMcpLifecycle | select(.circuitBreakerActive == true)'
```

```powershell
Select-String -Path $LOG -Pattern '"circuitBreakerActive":true'
```

### 4) Super-mcp stats flapping (status transitions)

```bash
grep -E 'super-mcp /stats: (status degraded|status recovered|degraded status changed)' "$LOG"
```

```powershell
Select-String -Path $LOG -Pattern 'super-mcp /stats: (status degraded|status recovered|degraded status changed)'
```

### 5) GPU process flap (blur/focus cycling)

```bash
# Bash — precise
grep '"msg":"Memory diagnostic"' "$LOG" | jq -c '.gpuLifecycle | select(.blurDisposalCount > 0 or .focusWarmUpCount > 0)'

# Portable
rg '"blurDisposalCount":[1-9]|"focusWarmUpCount":[1-9]' "$LOG"
```

```powershell
Select-String -Path $LOG -Pattern '"blurDisposalCount":[1-9]|"focusWarmUpCount":[1-9]'
```

### 6) Memory leak warnings

```bash
grep 'MEMORY LEAK DETECTED' "$LOG"
```

```powershell
Select-String -Path $LOG -Pattern 'MEMORY LEAK DETECTED'
```

### Log-string contract

Grep patterns above rely on stable log message strings that the code emits verbatim. **Keep the canonical list aligned** — if a runtime log message changes in code, update the grep pattern here too. Current contract:

| Pattern                                                                   | Source of truth                                                                                            |
|---------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| `"msg":"Memory diagnostic"`                                               | `src/main/services/perfDiagnosticService.ts` (the `log.info(..., 'Memory diagnostic')` emission)           |
| `super-mcp /stats: status degraded \| status recovered \| degraded ...`   | `src/core/services/superMcpHttpManager.ts` (status-transition logging)                                     |
| `MEMORY LEAK DETECTED`                                                    | `src/main/services/perfDiagnosticService.ts` (the `warn`-level sustained-growth detector)                  |

If a future refactor renames or rephrases any of these, update this file alongside the code change.

## Platform-specific caveats

- **macOS**: `app.getAppMetrics()` CPU is sampled per-Electron-process, not per-thread; `super-mcp` child processes appear via the Stage 4a synth row, not as native rows. Idle-busy macOS processes often show 0.0–0.3% CPU even when active.
- **Windows**: log path uses `%APPDATA%`, and a restart of super-mcp can briefly hold the old PID visible while Windows reclaims handles. The `namedPidRegistry` has a 24 h stale prune (Stage 4a) to defend against missed `exited` events.
- **Linux**: CPU accounting is per-thread-bucket rolled into the process; expect slightly higher numbers than macOS for equivalent workloads.

## Running the acceptance harness

```bash
npx tsx scripts/perf-acceptance-check.ts --log "$HOME/Library/Application Support/mindstone-rebel/logs/mindstone-rebel.log"
```

See `scripts/perf-acceptance-check.ts` for flags. It parses the log tail and asserts **AC1–AC5** as defined in the planning doc. AC3 (renderer long-task attribution) reports as **SKIPPED** — the Stage 3 production path is killswitched pending a security refinement cycle (see the `getProdPerfMonitorEnabled()` JSDoc in `src/main/runtimeConfig.ts`).

Exit 0 on all pass / skip; exit 1 on any fail. Safe to run locally, in CI, or against a QA build.

## Related

- [`docs/plans/260423_secondary_process_cpu_observability.md`](../plans/260423_secondary_process_cpu_observability.md) — canonical plan + AC1-AC5 definitions + Stage 3 killswitch rationale
- [`docs/project/APP_PERFORMANCE_AND_MEMORY.md`](APP_PERFORMANCE_AND_MEMORY.md) — general perf + memory notes
- [`docs/project/DEBUGGING.md`](DEBUGGING.md) — log-tailing workflow

## Code entry points

- [`src/main/services/perfDiagnosticService.ts`](../../src/main/services/perfDiagnosticService.ts) — the periodic tick + `Memory diagnostic` emission site; DI seams for `getSuperMcpLifecycle` + `getSuperMcpStats`.
- [`src/core/services/eventLoopLagService.ts`](../../src/core/services/eventLoopLagService.ts) — Stage 2 monitor backing `eventLoopDelay`.
- [`src/core/services/superMcpHttpManager.ts`](../../src/core/services/superMcpHttpManager.ts) — Stage 4a lifecycle + Stage 4b `fetchStats()` cache + status-transition logging.
- [`src/main/services/superMcpTelemetryAdapter.ts`](../../src/main/services/superMcpTelemetryAdapter.ts) — Stage 4a named-PID registration bridge (main-side, keeps `src/core/` electron-free).
- [`src/main/services/ramTelemetryService.ts`](../../src/main/services/ramTelemetryService.ts) — process labelling + named-PID registry with 24 h stale prune.
- [`super-mcp/src/server.ts`](../../super-mcp/src/server.ts) — Stage 4b `GET /stats` route (submodule).
- [`src/main/runtimeConfig.ts`](../../src/main/runtimeConfig.ts) — `getProdPerfMonitorEnabled()` (Stage 3 killswitch + re-enable checklist).
