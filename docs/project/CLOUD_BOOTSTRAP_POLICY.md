---
description: "Policy + CI gate that keeps cloud-service bootstrap lazy by default. Codifies what may run at boot vs what must defer to first request, so Stage A1/A2 wins of the 2026-05-27 OOM bugfix do not silently regress."
last_updated: "2026-06-18"
---

# Cloud Bootstrap Policy

Cloud-service is a **subset of desktop, not a superset**. It runs the same handler functions on a much smaller machine — typically `shared-cpu-4x:4096MB` — and shares its RAM with super-mcp child processes, the embedding pipeline, the tool-index, and inbound HTTP traffic. Anything that loads eagerly at boot eats from that budget.

This document codifies what is allowed at boot, what must defer, and the AST-based CI gate that enforces both.

## Why this exists

Bugfix `27bb5fec7` ([2026-05-27 OOM postmortem](../../docs-private/postmortems/260527_cloud_oom_warmup_4gb_postmortem.md)) recovered ~600 MB of anon-rss and 3.5 minutes of boot time by:

- Removing the eager `cloudEmbeddingGenerator.warmup()` call from cloud bootstrap (pipeline now lazy-on-first-call).
- Serialising the previously parallel `/api/tools` warmup + `initializeToolIndex() + refreshToolIndex()` flow.
- Switching Transformers.js to `{ dtype: 'q8' }` for v3 compatibility (model went from fp32 ~532 MB working set to q8 ~133 MB).
- Stripping `NODE_OPTIONS` from MCP child-process env so the parent's heap ceiling does not propagate to ~20 children.

Stage A1 ([Plan 260527](../plans/260527_cloud_capacity_optimisation_and_pressure_surfacing.md)) deferred the warmup itself to first request / idle window via `cloudBootstrapWarmup.ts`. Stage A2 hardened the lazification with a Slack-inbound cold-boot integration test.

Stage A3 (this doc) is the **guard-rail**: a CI gate that prevents future agents — human or AI — from re-eagerifying any of those paths in 6 months and silently re-introducing the same incident class.

## Cloud bootstrap principles

1. **Lazy-by-default at boot.** Anything that takes >2 s or loads >100 MB must be deferred to first real request, idle window, or schedule trigger. Heavy work happens **on demand**, not at startup.
2. **No imports from `src/main/`.** `@main/*` is Electron-only. Cloud must consume the equivalent boundary interface (`@core/*`). Currently-allowlisted exceptions live in `scripts/check-cross-surface-imports.ts` and represent deferred migrations to lift functionality into `@core/`.
3. **Use boundary interfaces.** `@core/storeFactory`, `@core/handlerRegistry`, `@core/processSpawner`, `@core/embeddingGenerator`, `@core/scheduler`, `@core/broadcastService`, `@core/errorReporter`, `@core/tracking`. Cloud-specific implementations live in `cloud-service/src/services/*Cloud*.ts` and are wired via the `set*Factory` calls at the top of `bootstrap.ts`.
4. **Observable lifecycles for deferred work.** Every deferred warmup/init step must surface its state (`not_scheduled | scheduled | running | succeeded | failed`) via Sentry breadcrumbs, scoped logger, and `/api/health?detailed=true`. "Silent failure is a bug." See `cloudBootstrapWarmup.ts`'s state machine + watchdog.
5. **Hard-fail guards use volume / own-machine semantics, not provider machine counts.** During rollout, the provider's started-machine count is not a reliable single-writer source of truth; bootstrap hard-fail guards must key on volume or own-machine identity instead.

### Why "lazy-by-default"

The 2026-05-27 incident saw three workloads peak simultaneously after warmup completed: super-mcp spawn fanout + tool-text embedding + LanceDB Arrow buffer construction. The plan that introduced those stages (`docs/plans/260523_supermcp_search_tools_cold_load_cloud.md`) accepted "+80 MB and 2-5 s warm on first embedding" — but it analysed each workload in isolation, not their cold-boot superposition on a 4 GB cgroup.

Lazy-by-default trades one user's first request paying ~5–15 s of warm-up cost for *every* user getting a healthy cloud that doesn't OOM-cycle. The first-request slowdown is observable (Sentry breadcrumb, structured log, `/api/health?detailed=true`) and bounded (super-mcp's BM25 fallback handles the cold path under the existing search-tools mutex).

## What's allowed at boot vs deferred

### Allowed at boot

- Loading env config + bootstrap timestamp.
- Wiring boundary interface factories (`set*Factory`).
- Starting the HTTP server + registering routes.
- Lightweight handler registration via `getHandlerRegistry().register(...)`.
- Settings hydration + small one-shot migrations (`learned-limits`, catalog-env scrub).
- Submitting `cloudBootstrapWarmup.configure({...})` and arming the idle timer + watchdog.
- Starting the cloud automation scheduler, self-update scheduler, and hygiene scheduler (small fixed-cost startup; their per-cycle work is gated by their own schedules).
- IPC dispatch wiring (Map-backed `HandlerRegistry`).

### Must defer (lazy-on-first-call)

- **Tool-index warmup.** Owned by `cloud-service/src/services/cloudBootstrapWarmup.ts`. Triggers on first non-health HTTP request or 60 s idle window, whichever fires first. Watchdog captures Sentry warning if state is still `not_scheduled` at T+65 s.
- **Embedding-pipeline initialization.** `cloud-service/src/services/cloudEmbeddingGenerator.ts::initializePipeline()` is called only when `generateEmbeddings()` is first invoked — i.e. by a real `search_tools` call or memory-system query. The `@huggingface/transformers` import is dynamic and inside that method body for the same reason.
- **Super-MCP `/api/tools` warmup.** Now part of the same deferred sequence; runs once after first request.
- **Large catalog reads (LanceDB scans, model downloads).** Behind their own lazy entry points; never eager at boot.

## Tuning levers (env vars)

Cloud bootstrap exposes a small set of env-var overrides for ops escape hatches and dev experimentation. **Default OFF unless noted.** Deviating from defaults must be justified in the same change that flips them.

| Env var | Default | Effect |
|---------|---------|--------|
| `REBEL_CLOUD_WARMUP_EAGER` | `0` (lazy) | When set to `1`, `cloudBootstrapWarmup` fires the warmup sequence immediately after bootstrap completes instead of waiting for first request / idle. **Reserved for emergency rollback** of Stage A1's deferral. Reintroduces the boot-path warmup cost — only useful if a regression is suspected and the user wants the pre-A1 behaviour temporarily. |
| `REBEL_CLOUD_EMBEDDING_IDLE_EVICT_MIN` | `0` (disabled) | Positive integer enables an idle-eviction poller that disposes the in-process embedding pipeline after this many minutes without an embedding call. Next call pays a one-time ~2–5 s reload from local Docker cache (no network). Default off until pressure telemetry (Stage B of [Plan 260527](../plans/260527_cloud_capacity_optimisation_and_pressure_surfacing.md)) shows the memory-vs-latency trade-off is worth it across cohorts. |
| `REBEL_SUPPRESS_WARMUP_WATCHDOG` | `0` | Suppresses the Sentry capture from `cloudBootstrapWarmup`'s "still not_scheduled at T+65 s" watchdog. Used in CI / test envs where warmup is intentionally never scheduled. Structured breadcrumb + log line still emit. Implicitly suppressed when `NODE_ENV=test`. |
| `REBEL_FORCE_EMBEDDING_WARMUP` | `0` | Allows `CloudEmbeddingGenerator.warmup()` to actually load the pipeline in `NODE_ENV=test` envs (which otherwise short-circuit). Used by integration tests that want a real model loaded. |

These levers are part of the policy: changing their defaults is a code change that must update this doc + the relevant test surface in the same PR.

## The CI gate

`scripts/check-cloud-bootstrap-policy.ts` enforces the policy. It runs as part of `npm run validate:fast` (after `validate:cross-surface-imports`) and is wired via `npm run validate:cloud-bootstrap-policy`.

### What it catches

The gate is **AST-based** (TypeScript Compiler API). A regex would miss multi-line dynamic imports, identifier-aliased bindings, and string-template specifiers — exactly the surface area where regressions typically slip back in.

| Check | Where | Fails on |
|-------|-------|----------|
| Forbidden CALL pattern | `cloud-service/src/bootstrap.ts` only | `<x>.warmup(...)`, `initializeToolIndex(...)`, `refreshToolIndex(...)`, `refreshToolIndexFromCatalogData(...)` — these belong inside `cloudBootstrapWarmup.runWarmupSequence()`, not the boot path. |
| Forbidden STATIC import | bootstrap.ts + every transitively-reachable cloud module | `import x from '@huggingface/transformers'` — the ML runtime must only be imported lazily inside a method body. Type-only imports (`import type { … } from '…'`) and pure type-only re-exports are erased at runtime and exempt. |
| Forbidden DYNAMIC import | `cloud-service/src/bootstrap.ts` only | `await import('@huggingface/transformers')` — the boot path must not even synchronously dynamic-import heavy ML libs. Both single-quote/double-quote string literals and no-substitution template literals (backticks) are caught. Lazy method bodies in other reachable modules (`cloudEmbeddingGenerator.ts::initializePipeline()`) are exempt because they fire only on first call. |
| Cross-surface drift in bootstrap.ts | `cloud-service/src/bootstrap.ts` only | Static or dynamic `@main/*` imports not in `scripts/check-cross-surface-imports.ts` ALLOWLIST. The AST check catches multi-line dynamic imports the existing single-line regex would miss. |
| Unguarded pre-init singleton accessor | `bootstrap()` function body only | A **bare-identifier** call to `getSystemSettingsPath`, `getDataPath`, `getAppRoot`, `getAppVersion`, or `getPlatformConfig` that is **not** inside a **real** `try`/`catch` guard. A "real guard" is a `try` with a `catch` clause whose body does **not** unconditionally re-throw — a catch-less `try`/`finally` and a rethrowing `catch (e) { throw e }` are **not** guards (the throw still escapes). These accessors read `getPlatformConfig()` at call time and throw `PlatformConfig not initialized` when unwired. In production server.ts wires PlatformConfig (via `./platformInit`) before `bootstrap()` runs; the cloud bootstrap **test harnesses run `bootstrap()` unwired by design** (`vi.resetModules()` → fresh `@core/platform`), so an eager call throws and breaks the harnesses — exactly the reverted REBEL-63K Stage 3. The fix is the analytics-init guard posture (`try { … } catch { bootstrapLog.error(…) }`). **Function-scoped, not file-scoped**: accessor calls in module-scope lazy closures or in other named functions are not flagged. |

The gate runs in two phases:

1. **Bootstrap entry phase** — full policy: call patterns, static + dynamic imports, cross-surface drift.
2. **Reachable-modules phase** — static-import-only sweep across every module reachable via `import` from bootstrap.ts. Dynamic imports / call patterns / `@main` checks / pre-init accessor checks are deferred to the bootstrap-entry phase + `scripts/check-cross-surface-imports.ts` to avoid double-firing. Type-only imports (`import type`, `export type`, and per-specifier `import { type … }` / `export { type … }` where every named binding is type-only) are skipped — they are erased by the TS compiler and cannot trigger eager loads.

### Why the pre-init singleton-accessor rule (the `cloud_bootstrap_singleton_init_asymmetry` family)

Three incidents share one morphology — `bootstrap()` touches a PlatformConfig-backed singleton before (or in a context where) it's initialized: [260220 cloud PlatformConfig lazy-init], [260311 cloud bootstrap ESM settings recursion], and [REBEL-63K (the never-wired cloud prompt-config)](../../docs-private/postmortems/260618_promptfile-service-not-configured_postmortem.md). The REBEL-63K **fix attempt** (Stage 3) re-tripped it: an eager `path.join(getSystemSettingsPath(), 'prompts')` in `bootstrap()` threw `PlatformConfig not initialized` in the 34 cloud bootstrap tests that run `bootstrap()` unwired, and had to be reverted. **Shipped fix (2026-06):** no eager `getSystemSettingsPath()` in `bootstrap()` — `promptFileService.ts` resolves the default prompts root **on demand** via `ensureConfigured()` (`getSystemSettingsPath()/prompts` at first read), with cloud prompt-config parity wired at the surface that owns it; the pre-init accessor gate in `scripts/check-cloud-bootstrap-policy.ts` blocks regressions. A prior recommendation named `cloud-bootstrap-smoke-parity` (the 8/9-drained cluster in [Plan 260612](../plans/260612_recs-ci-build-gates/PLAN.md)) called for exactly this guard; it had never been implemented. This rule is that missing member.

The rule is **static AST, not a boot smoke test**: a smoke test would have to mock bootstrap's ~30-interface dependency graph and is exactly the `bootstrap.headlessRuntime.test.ts` regression-guard pattern that already exists (runtime layer). The static rule is ~30 LOC on the existing gate, runs sub-second in `validate:fast`, and its "must be inside a real `try`/`catch` guard" predicate is exact and self-documenting. It is **function-scoped to `bootstrap()`** so it does not flag the two pre-existing benign `getDataPath()` calls in `bootstrap.ts` (one in a module-scope `tokenRootResolver` closure that fires at runtime, one in the IPC-handler registration function — neither is in `bootstrap()`'s lexical body).

A `try` only counts as a guard when it has a `catch` clause whose body does **not** unconditionally re-throw. A catch-less `try`/`finally` and a rethrowing `catch (e) { throw e }` (or `catch { throw new Error(…) }`) let the accessor's throw escape unchanged — they are fatal-equivalent and are **flagged**. An outer real guard wrapping an inner rethrowing try still counts (the walk keeps ascending).

#### Known limitations of the pre-init accessor rule (out of scope)

The rule covers the **realistic accidental regression**: a bare-identifier accessor call copy-pasted into `bootstrap()` (exactly the reverted REBEL-63K Stage 3 shape). Forms that would require dataflow / symbol resolution are deliberately **not** detected — closing them is over-engineering for a ~30-LOC guard:

- ✅ `getSystemSettingsPath()` unguarded in `bootstrap()` — caught.
- ✅ `try { getSystemSettingsPath() } catch (e) { throw e }` (rethrowing catch) — caught.
- ✅ `try { getSystemSettingsPath() } finally { … }` (catch-less) — caught.
- ❌ `dataPaths.getDataPath()` (namespace / property call) — not caught (rule inspects bare identifiers only; a regression test pins this current behaviour).
- ❌ `const g = getPlatformConfig; g()` (aliased binding) — not caught (needs symbol resolution).
- ❌ accessor called from a nested named helper that `bootstrap()` invokes — not caught (function-scoped to `bootstrap()`'s lexical body by design).
- ❌ a `catch` that re-throws only conditionally (inside an `if`/loop) — conservatively treated as a real guard (no reachability analysis).

The accessor's throw is loud at runtime regardless (it breaks every cloud bootstrap test harness), so an undetected exotic form surfaces fast in CI even though the static gate doesn't pre-empt it.

### Known limitations (out of scope)

The gate covers the realistic accidental-introduction case — someone copy-pastes `await import('@huggingface/transformers')` (or its backtick equivalent) into bootstrap.ts. Adversarial bypasses that require dataflow / symbolic analysis are deliberately out of scope:

- ✅ `import('@huggingface/transformers')` — caught.
- ✅ `` import(`@huggingface/transformers`) `` — caught (no-substitution template literal).
- ❌ `` import(`@hugging${'face'}/transformers`) `` — not caught (template literal with substitution).
- ❌ `import(varName)` — not caught (identifier — would require dataflow).
- ❌ `import('@hugging' + 'face/transformers')` — not caught (string concatenation).

Closing these would require dataflow / symbolic analysis (e.g. const-folding, `ts-morph` symbol resolution, or full type-checker integration). The cost-to-benefit ratio is poor: the gate's job is to make accidental regressions impossible, not to block every adversarial path. If you find yourself reaching for one of the forms above to bypass the gate, the right fix is to redesign the bootstrap step to defer the load via `cloudBootstrapWarmup` instead.

### Modes

```bash
# Default: gate. Exits non-zero on any violation.
npm run validate:cloud-bootstrap-policy

# Print the bootstrap reachability graph (project-internal modules + a top-25
# of unresolved external specifiers). Use for human review when triaging which
# modules belong in scope.
npx tsx scripts/check-cloud-bootstrap-policy.ts --list
```

### How to extend the gate

When you add a new bootstrap path that tomorrow's agents shouldn't re-eagerify:

1. **Justify it in this doc** under "Allowed at boot" or "Must defer".
2. **Add a forbidden pattern** to `DEFAULT_POLICY` in `scripts/check-cloud-bootstrap-policy.ts` (`forbiddenBootstrapCalls`, `forbiddenStaticImports`, or `forbiddenDynamicImports`).
3. **Add a regression test** in `scripts/__tests__/check-cloud-bootstrap-policy.test.ts` covering the new pattern.
4. **Run a sanity check**: temporarily inject the violation into `cloud-service/src/bootstrap.ts`, run `npm run validate:cloud-bootstrap-policy`, confirm it fails with the expected error, revert.

## Adding a new bootstrap step

Before adding any new `await ...` to bootstrap.ts, ask:

1. **Does it load >100 MB or take >2 s?** If yes, it must defer. Schedule via `cloudBootstrapWarmup` or your own lazy entry point.
2. **Does it import from `src/main/`?** If yes, prefer lifting the logic into `@core/*` first. If genuinely unavoidable (e.g. desktop-only OS hooks), add the (file, specifier) pair to the cross-surface allowlist with a clear deferred-migration reason.
3. **Is it observable?** Every long-running deferred step needs a state machine + watchdog + breadcrumb. See `cloudBootstrapWarmup.ts` for the canonical pattern.
4. **Does it have a regression test?** A unit test that asserts the new step doesn't fire on bootstrap by default — and an integration test that asserts the lazy path completes correctly under realistic load.
5. **Is the CI gate updated?** If you added a new pattern that should be policed, add it to `DEFAULT_POLICY` + a regression test in the same change.

## Cross-references

- [2026-05-27 OOM postmortem](../../docs-private/postmortems/260527_cloud_oom_warmup_4gb_postmortem.md) — the bug class this policy prevents.
- [Plan 260527](../plans/260527_cloud_capacity_optimisation_and_pressure_surfacing.md) — Stages A1, A2, A3, A4 + B/C/D/E pressure surfacing.
- [Plan 260523](../plans/260523_supermcp_search_tools_cold_load_cloud.md) — super-mcp `/api/tools` warmup + tool-index init history.
- [`scripts/check-cloud-bootstrap-policy.ts`](../../scripts/check-cloud-bootstrap-policy.ts) — the gate itself.
- [`scripts/check-cross-surface-imports.ts`](../../scripts/check-cross-surface-imports.ts) — sibling AST gate for `@main/*` imports across all of `cloud-service/**` and `mobile/**`.
- [`cloud-service/src/services/cloudBootstrapWarmup.ts`](../../cloud-service/src/services/cloudBootstrapWarmup.ts) — the deferred-warmup state machine.
- [`cloud-service/src/services/cloudEmbeddingGenerator.ts`](../../cloud-service/src/services/cloudEmbeddingGenerator.ts) — the canonical lazy-`@huggingface/transformers` pattern + idle-eviction toggle.
- [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) — full cloud architecture, deployment, ops.
- [CROSS_SURFACE_PARITY_CHECKLIST.md](CROSS_SURFACE_PARITY_CHECKLIST.md) — required check before merging cross-surface features.
