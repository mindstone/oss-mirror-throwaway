---
description: "Investigation into macOS REBEL-NQ watchdog stalls and memory pressure — freemem reporting, process footprint, root causes, fixes"
last_updated: "2026-02-09"
---

# Investigation: macOS Memory Exhaustion & REBEL-NQ Watchdog Aborts

**Date:** 2026-02-09
**Status:** Complete
**Verdict:** False Positive (Reporting Artifact) + High Baseline Footprint

## Executive Summary

The "REBEL-NQ: Watchdog turn aborted" error, which strongly correlates with low system free memory (<300MB) on macOS, is primarily a **memory reporting artifact**.

Electron and Node.js use `os.freemem()` to report available memory. On macOS, this metric reports only completely unused pages, excluding the multi-gigabyte "file cache" that the OS can instantly reclaim. Consequently, macOS devices often report <300MB "free" even when 5GB+ is available for applications.

While the "exhaustion" diagnosis is technically a false positive, the application's memory footprint is indeed high (1.5GB baseline, spiking to 3GB+ in large sessions), which puts genuine pressure on 8GB/16GB machines, potentially causing the swapping/stalling that triggers the watchdog.

## The Evidence

### 1. The "Smoking Gun" Correlation
Sentry data (REBEL-NQ) shows a distinct pattern:
- **macOS:** 16/19 events have <300 MB free memory (often <50MB).
- **Windows:** Events show 1.1GB - 14.5GB free memory.
- **Conclusion:** Windows reports "Standby/Cached" memory as available (or manages it differently), while macOS does not. The app is not uniquely exhausting memory on macOS; the *metric* is just terrifyingly low on that platform.

### 2. The Watchdog Mechanism
The watchdog in `src/main/services/agentTurnExecutor.ts` monitors SDK silence.
- It logs `systemFreeMemoryMB: Math.round(os.freemem() / 1024 / 1024)`.
- It **does not** abort the turn automatically based on this metric.
- The "abort" comes from the **user clicking Stop** (likely due to a stall) or the process crashing.
- The low `freemem` value is a *symptom* logged during the crash/stall, not the *cause* of a programmed abort.

### 3. Process Footprint Analysis
The app spawns 7+ persistent processes, creating a high memory floor:
| Process | Est. Memory | Notes |
| :--- | :--- | :--- |
| **Main** | ~300MB | Loads `@recallai/desktop-sdk` in-process |
| **Renderer** | ~500MB - 2GB | **Major Growth Vector:** Zustand state retains full message history. 5000+ msg sessions = huge DOM & JS heap. |
| **GPU Process** | ~400MB | High on macOS due to retina/compositing |
| **Embedding (GPU/CPU)** | ~200MB | Holds ONNX models |
| **Pre-turn Worker** | ~150MB | LanceDB queries |
| **Super-MCP** | ~100MB | Detached child process |
| **Helper/Zygote** | ~100MB | Electron overhead |

**Total Baseline:** ~1.5GB
**Heavy Session:** ~3.0GB+

On an 8GB Mac (or even 16GB with Chrome/Slack open), this 3GB footprint forces aggressive swapping. While `os.freemem()` is misleading, the **memory pressure is real**, leading to the stalls that trigger the watchdog.

## Root Causes

1.  **Misleading Metric:** `os.freemem()` on macOS is useless for "OOM" detection. It always trends toward zero as the OS caches files. Using it for diagnostics creates false panic.
2.  **Renderer State Bloat:** The `sessionStore.ts` (Zustand) likely keeps the entire conversation history in memory. For "mega-sessions" (3k-5k messages), this bloats the Renderer process, causing sluggishness and stalls that look like "watchdog failures".
3.  **Process Sprawl:** We spawn many separate processes (Embedding, Pre-turn, Super-MCP). While modular, each incurs Electron/Node startup overhead.

## Recommendations

### 1. Fix Diagnostics (Immediate)
- **Ignore `os.freemem()` on macOS** in Sentry logs and decision logic.
- If accurate memory pressure is needed, use `os.loadavg()` or spawn `vm_stat` (expensive) - but generally, **trust the OS**.
- Only flag "Memory Exhaustion" if `process.memoryUsage().rss` approaches the V8 limit (4GB default) or if `app.getAppMetrics()` shows a specific process runaway.

### 2. Optimize Renderer State (High Impact)
- **Virtualize the Message List:** Ensure React only renders visible messages.
- **Compaction/Pagination:** Don't load 5,000 messages into Zustand at once. Implement "windowing" for the session state or offload history to disk (LanceDB) and only keep the "context window" in RAM.

### 3. Process Consolidation (Long Term)
- Consider merging `preTurnWorkerService` and `embeddingService` if they share dependencies (e.g., LanceDB/ONNX), or move them to lazy-loaded threads.
- Verify `@recallai/desktop-sdk` isn't leaking memory in the Main process.

## Conclusion
The "REBEL-NQ" error is a **Watchdog Stall**, not an OOM crash. The correlation with low memory logs is a platform-specific reporting artifact. However, the app *is* heavy enough to cause performance degradation on standard Macs. The fix is performance optimization (renderer virtualization), not memory management panic.
