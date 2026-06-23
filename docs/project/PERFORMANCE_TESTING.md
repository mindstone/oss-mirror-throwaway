---
description: "Automated performance regression detection: deterministic CI gates and warn-only timing signals"
last_updated: "2026-03-29"
---

# Performance Testing

Automated E2E tests that catch performance regressions before they ship. These are separate from the manual `dev:perf` profiling tools documented in [APP_PERFORMANCE_AND_MEMORY.md](./APP_PERFORMANCE_AND_MEMORY.md).

---

## See also

- [APP_PERFORMANCE_AND_MEMORY.md](./APP_PERFORMANCE_AND_MEMORY.md) -- Manual profiling (`dev:perf`), memory diagnostics, known issues, debugging
- [TESTING_E2E.md](./TESTING_E2E.md) -- Playwright E2E infrastructure (perf tests use the same setup)
- [TESTING_AUTOMATION_OVERVIEW.md](./TESTING_AUTOMATION_OVERVIEW.md) -- Test command reference and decision matrix
- `docs/plans/260328_perf_regression_tests.md` -- Full planning doc with design rationale
- `docs-private/investigations/260328_electron_perf_metrics_strategy.md` -- Metric determinism analysis and threshold strategy
- `src/main/ipc/utils/ipcPayloadGuard.ts` -- Payload size estimation module
- `src/main/ipc/utils/ElectronHandlerRegistry.ts` -- IPC instrumentation integration point
- `tests/e2e/perf-test-utils.ts` -- Shared perf test helpers (CDP, long tasks, startup timing)

---

## Design Philosophy: Deterministic vs Timing Metrics

> **Intent-critical decision**: Deterministic metrics block PRs; timing metrics warn only. Do NOT reverse this without understanding the flakiness implications.

Performance metrics fall into two categories with fundamentally different reliability:

| | Deterministic (block PRs) | Timing-based (warn only) |
|---|---|---|
| **What it measures** | "Did the code do the right thing?" | "How fast did it do it?" |
| **Examples** | IPC payload bytes, LayoutCount, memory after GC | Startup time, long task duration |
| **CI noise** | ~0% variance | 30-50% variance |
| **Can gate merges?** | Yes, safely | No -- causes flakiness and gets disabled |

This distinction comes from extensive multi-model research (GPT-5.5, Gemini 3.1 Pro, Opus 4.6) and aligns with how VS Code, Slack, and Chromium handle perf testing. Deterministic metrics measure whether the code does the right thing (structural); timing metrics measure how fast it does it (environmental). The former is safe to gate on; the latter is not on shared CI hardware.

---

## Running

```bash
# Build the app first (required for all E2E)
npm run package

# Run perf tests only (single worker, isolated from regular E2E)
npm run test:e2e:perf

# Regular E2E tests are unaffected (perf tests excluded via testIgnore)
npm run test:e2e
```

---

## Test Categories

### IPC Payload Size Guards (blocking)

Detects oversized IPC messages that would cause serialization bottlenecks. IPC serialization in Electron blocks both sender and receiver threads synchronously.

- **Warn**: >64KB per message
- **Fail**: >256KB per message
- **Spec**: `tests/e2e/perf-ipc-payload.spec.ts`
- **Implementation**: `ipcPayloadGuard.ts` instruments `ElectronHandlerRegistry.register()`, gated behind `REBEL_E2E_PERF_MODE=1`
- **Known gap**: ~30+ IPC handlers using direct `ipcMain.handle()` bypass the registry and are not instrumented. Migration to the registry is tracked as tech debt.

### Memory Leak Detection (blocking)

Loops a core navigation journey 5 times with forced garbage collection, then asserts heap growth stays below threshold.

- **Fail**: >10MB heap growth after 5 iterations
- **Spec**: `tests/e2e/perf-memory-leak.spec.ts`
- **Requires**: `--js-flags=--expose-gc` (passed automatically by `launchForPerfTest`)
- **Measures**: Main process heap only (`process.memoryUsage().heapUsed`); renderer heap logged for info
- **Warm-up**: Runs the journey once before measuring to flush JIT compilation artifacts

### CDP Structural Metrics (observation-only, will become blocking)

Uses Chrome DevTools Protocol to measure `LayoutCount` and `RecalcStyleCount` per UI action. These are structural counts (not timing) and are deterministic.

- **Spec**: `tests/e2e/perf-cdp-structural.spec.ts`
- **Status**: Observation-only until baselines are established
- **Observed baselines (March 2026)**: New chat: Layout=3-4, Settings: Layout=24-26, Connectors: Layout=4-13, Automations: Layout=6
- **Next step**: Set budgets at 2x observed values once data is stable across runs

### Startup Time (warn-only)

Measures time from app launch to UI interactive. Logged for trending but never blocks.

- **Spec**: `tests/e2e/perf-timing-signals.spec.ts`
- **Warn**: >3s local, >6s CI
- **Output**: `[PERF-STARTUP] ${ms}ms`

### Long Task Count (warn-only)

Injects `PerformanceObserver` for `longtask` entries, counts tasks >150ms during navigation flows. Logged for trending but never blocks.

- **Spec**: `tests/e2e/perf-timing-signals.spec.ts`
- **Output**: `[PERF-LONGTASKS] ${count} tasks > 150ms`
- **Threshold at 150ms** (not 50ms) to filter Playwright-induced interaction noise

---

## CI Integration

Perf tests run automatically in CI as part of the `test-e2e` job in `release.yml` (macOS arm64 only). They run after the regular E2E tests, using the same packaged app artifact.

- **Workflow**: `.github/workflows/release.yml` > `test-e2e` job
- **Trigger**: Every push to `main`, or beta deploy via `[deploy-beta]` flag on `dev`
- **Non-blocking**: The job has `continue-on-error: true` and is not in the publish job's `needs` chain. Failures are visible in the workflow run but don't gate releases.
- **Perf step runs even if E2E fails**: Uses `if: !cancelled()` so you get perf data regardless of E2E test outcomes.
- **Artifacts**: Test results and Playwright reports are uploaded as `playwright-report-macos` (7-day retention).

### Promoting to blocking

Once tests prove stable over 2-4 weeks of CI runs:
1. Remove `continue-on-error: true` from the `test-e2e` job
2. Add `test-e2e` to the publish job's `needs` array
3. The deterministic tests (IPC payload, memory leak) are safe to gate on
4. The timing signals (startup, long tasks) should remain warn-only regardless

### Windows E2E

Windows E2E is not yet re-enabled. Will be added separately once macOS proves stable. See the commented-out Windows matrix entries in the git history for the original configuration.

---

## Key Files

| File | Purpose |
|------|---------|
| `tests/e2e/perf-test-utils.ts` | Shared helpers: `launchForPerfTest`, CDP session, long task observer, startup timing |
| `tests/e2e/perf-ipc-payload.spec.ts` | IPC payload size gate |
| `tests/e2e/perf-memory-leak.spec.ts` | Memory leak detection |
| `tests/e2e/perf-cdp-structural.spec.ts` | CDP structural metrics observation |
| `tests/e2e/perf-timing-signals.spec.ts` | Startup time + long task count signals |
| `src/main/ipc/utils/ipcPayloadGuard.ts` | Payload size estimation + violation tracking |
| `src/main/ipc/utils/ElectronHandlerRegistry.ts` | IPC instrumentation integration point |
| `playwright.config.ts` | `perf` project configuration (testMatch, testIgnore) |

---

## Threshold Maintenance

Initial thresholds are intentionally generous (no baseline data existed before March 2026). After 2-4 weeks of data collection:

1. Review structured log output (`[PERF-STARTUP]`, `[PERF-LONGTASKS]`, `[PERF-CDP]`)
2. Tighten IPC payload thresholds if typical payloads are well below 64KB
3. Tighten memory leak threshold based on observed variance
4. Set CDP structural budgets at 2x observed values
5. Consider promoting the CDP test from observation-only to blocking

### Bootstrapping new thresholds

Run the tests 5-10 times and record values. Set thresholds at 2-3x the observed p95 for blocking gates. For warn-only signals, set advisory thresholds at p99 of baseline runs.

---

## Relationship to dev:perf

| | `npm run dev:perf` | `npm run test:e2e:perf` |
|---|---|---|
| **When** | Manual, during development | Automated, on demand / nightly |
| **What** | CPU profiler, memory profiler, React Profiler, long tasks, input lag | IPC payload gates, memory leak, CDP metrics, startup time |
| **Catches regressions?** | Only if you notice | Yes, systematically |
| **Helps debug?** | Yes (flame charts, heap snapshots) | No (just tells you something broke) |

Typical workflow: `test:e2e:perf` tells you something got worse, then `dev:perf` tells you why.

---

## Gotchas

- **Stale packaged app**: Perf tests run against the packaged build (`npm run package`). If you modify `ElectronHandlerRegistry.ts` or other main-process code and don't rebuild, the IPC payload test will fail because instrumentation isn't present in the binary.
- **GPU metrics in CI**: Headless CI uses SwiftShader (software rendering). Frame rate and GPU metrics are meaningless in CI. This is why frame jank detection is explicitly NOT implemented.
- **`--expose-gc` flag**: The memory leak test requires `--js-flags=--expose-gc` to make `global.gc()` available. This is handled automatically by `launchForPerfTest` but means the test verifies GC availability before proceeding.
- **PerformanceObserver for longtask**: May not be supported in all Electron/Chromium builds. The helper includes a try/catch guard to gracefully degrade.
- **Single worker**: Perf tests always run with `workers: 1` (enforced via `E2E_WORKERS=1` in the npm script) to prevent cross-test interference from skewing measurements.
