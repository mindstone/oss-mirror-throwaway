---
description: "Mindstone Rebel-specific coding principles and repo conventions for architecture, IPC, UI, testing, and change management."
last_updated: "2026-06-12"
---

# Coding Principles — Mindstone Rebel

> **Read `coding-agent-instructions/principles/CODING_PRINCIPLES.md` for universal TypeScript/React coding principles.**
> This document extends the shared principles with Mindstone Rebel-specific patterns (IPC contracts, path aliases, UI components, logging).

Audience: Contributors to Mindstone Rebel (Electron + React + TypeScript)

Purpose: Set clear, pragmatic guidelines that match how this codebase already works (see `AGENTS.md`, IPC/state docs). Prefer smaller, readable changes over sweeping rewrites.

See also (single source of truth links):
- [coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md](../../coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md) — how to batch, stage, and write safe atomic commits
- [docs/project/GIT_RESOLVE_MERGE_CONFLICTS.md](GIT_RESOLVE_MERGE_CONFLICTS.md) — practical checklist for resolving merge conflicts
- [rebel-system/skills/coding/third-party-choosing-products-utilities-libraries/SKILL.md](../../rebel-system/skills/coding/third-party-choosing-products-utilities-libraries/SKILL.md) — criteria and process for selecting dependencies
- [rebel-system/skills/documentation/signposting-to-single-source-of-truth/SKILL.md](../../rebel-system/skills/documentation/signposting-to-single-source-of-truth/SKILL.md) — avoid duplication; link to canonical docs
- [rebel-system/skills/documentation/write-planning-doc/SKILL.md](../../rebel-system/skills/documentation/write-planning-doc/SKILL.md) — how we write planning docs and break work into stages
- [rebel-system/skills/documentation/write-help-evergreen-doc/SKILL.md](../../rebel-system/skills/documentation/write-help-evergreen-doc/SKILL.md) — how we write stable reference docs with cross-references
- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) — high-level architecture and data flows
- [ARCHITECTURE_IPC.md](ARCHITECTURE_IPC.md) — contract-first IPC with Zod and generated bridge
- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) — Zustand store, reducers, effect isolation
- [CONTEXT_AND_PROVIDER_HIERARCHY.md](CONTEXT_AND_PROVIDER_HIERARCHY.md) — React context tree and provider patterns
- [HOOK_CONVENTIONS.md](HOOK_CONVENTIONS.md) — hook naming, deps, side-effect isolation
- [LOGGING.md](LOGGING.md) — structured logging, turn-scoped logs, breadcrumbs
- [PACKAGED_DEPENDENCY_NOTES.md](PACKAGED_DEPENDENCY_NOTES.md) — packaging constraints; avoid runtime `require()`
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — canonical app settings and env vars
- [UI_OVERVIEW.md](UI_OVERVIEW.md) — UI flow and interaction patterns
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) — session model, persistence, context-resume
- [TESTING_E2E.md](TESTING_E2E.md) — Playwright Electron E2E setup and execution
- [DESIGN.md](DESIGN.md) — high-level visual/product design and asset wiring
- [BOUNDARY_REGISTRY.md](BOUNDARY_REGISTRY.md) — registry of cross-boundary contracts, `scripts/boundary-hints.ts` advisory script, and CI enforcement checks (forbidden terms, cloud channel parity, IPC handler parity — all in `validate:fast`); complements the `env-var-boundary-contract-drift` and `inherited-default-from-template` pattern-library entries in [`coding-agent-instructions/AGENTS-BASE.md`](../../coding-agent-instructions/AGENTS-BASE.md)

---

## Core philosophy
- **Optimize for clarity and maintainability.** Code should be easy to read, reason about, and debug.
- **Surgical changes.** Get things working in a simple way first (bearing the end-goal in mind with your architecture), and then add complexity gradually afterwards.
- **Root-cause fixes over bandaids.** Prefer clean, simple, general, robust solutions that address underlying issues rather than narrow workarounds that mask symptoms.
- **Simplicity is a prerequisite for reliability** (Hickey/Dijkstra). Prefer *un-entangled* designs — each construct owning one concern, not braided together with others that could stand alone (separate state from identity from value, *what* from *how*, policy from control flow). For any non-trivial architecture decision, first read [Simplicity in Software](../../coding-agent-instructions/docs/research/260614_Simplicity_In_Software_Deep_Dive.md).
- **Consistency over invention.** Match existing patterns and directory conventions.
- **Flag problems or a better way to do things to the user** if you see them.
- **If in doubt, ask the user**.

## Architecture and boundaries
- **Core-first architecture:** New business logic and services go in `src/core/` by default. This layer has **zero imports from `electron`** and uses boundary interfaces (`PlatformConfig`, `StoreFactory`, `HandlerRegistry`, `BroadcastService`, `ErrorReporter`, `Tracker`). Only put code in `src/main/` if it genuinely needs Electron APIs (OAuth, voice, screenshots, auto-updater, system tray). See [de-electronification tutorial](../tutorials/260220_cloud_refactoring_de_electronification.html).
- **Boundary interfaces:** Use `@core/platform` (not `app.getPath()`), `@core/storeFactory` (not `electron-store`), `@core/broadcastService` (not `BrowserWindow.webContents.send()`), `@core/errorReporter` (not direct Sentry imports), `@core/handlerRegistry` (not `ipcMain.handle()`). Each platform wires its implementations at bootstrap.
- **Verify cross-boundary contracts:** When code in one process (renderer, main, core) constructs an identifier, format, or payload that another process consumes, verify the format matches the consumer's expectations. Grep for the consuming function and confirm the contract — type signatures alone may not catch format mismatches (e.g., compound `"packageId/toolId"` vs bare `"toolId"`). Cross-boundary bugs are invisible in single-side diffs and survive type checks. When an OSS package owns reading shared on-disk state, host writers encode the OSS reader contract (schema, ordering, sanitizers) and round-trip through the actual OSS reader in tests.
- **Shared-code bundling discipline:** Code moved into `src/shared` (or cross-surface core) gets its transitive *runtime* imports inspected against renderer, cloud, and mobile consumers — not only Node-based unit tests. Avoid bundling-hostile libraries (e.g. jsdom) in cross-surface logic; prefer isomorphic alternatives. `@rebel/shared` subpath barrels are runtime-target-typed — a React-free runtime subpath must not re-export hooks (hooks live at `<subpath>/react`). Strictly separate library exports from CLI execution entrypoints so bundlers can't inline self-running top-level blocks. Under ESM, module-body initialization can't outrun the module's own static imports — wire bootstrap side effects through a leaf module imported by the true entrypoint.
- **Lazy store pattern:** All stores must use lazy `getStore()` initialization because `setStoreFactory()` runs at bootstrap time, but module-level code runs at import time (which may be earlier).
- **Process separation:** Keep Electron main concerns (lifecycle, FS, automation, MCP orchestration) out of the renderer. UI stays in renderer.
- **Contract-first IPC:** Every IPC channel **must** have a Zod contract in `src/shared/ipc/channels/*.ts` before registering a handler. The parity validator (`scripts/check-ipc-handler-parity.ts`) enforces this in CI — handlers without contracts are a **blocking error**. Follow the 6-step checklist in [ARCHITECTURE_IPC.md § Adding a New IPC Channel](ARCHITECTURE_IPC.md#adding-a-new-ipc-channel). Validate with:
  - `npm run validate:ipc` (or `npm run validate:fast`)
- **Domain modules:** Organize IPC handlers by domain (`src/main/ipc/*Handlers.ts`) and feature state in renderer (`src/renderer/features/*`).

## TypeScript and types
- `strict: true` (enforced). Avoid `any`. Prefer discriminated unions and exact object shapes.
- Treat `src/shared/types.ts` as canonical for cross-process types.
- Validate external boundaries (IPC, IO, user input) with Zod. Never assume untrusted data is valid.
- Avoid unsafe casts; prefer narrowing and type guards.
- `as AgentEvent` casts are lint-blocked in production code; keep AgentEvent fixture construction in `src/shared/contracts/*` or tests until `buildAgentEvent.<type>` factories replace legacy construction.
- **An optional field whose `undefined` default is itself a plausible value is a latent bug source.** Prefer chokepoint resolution, a required field that forces suppliers to be enumerated, or a discriminated absent-vs-present type, so the missing case can't silently collapse into a deliberate value.
- **Path aliases:** Use `@core/*`, `@renderer/*`, `@shared/*`, `@main/*`, `@preload/*` instead of deep relative imports (`../../../`). Aliases are configured in `tsconfig.*.json` and build configs (vite, vitest, esbuild).

## Error handling and recovery (user-facing)
- **Graceful UX first.** Prefer to surface issues via inline errors or toasts and recover where possible; isolate failures to a surface rather than crashing the app.
- **Error boundaries:** Wrap surfaces with `SurfaceErrorBoundary`; keep the app-level Sentry error boundary fallback to enable quick reload and copyable diagnostics.
- **Renderer handling:** Route user-visible messages through `showToast`/inline states; avoid blocking modals for recoverable issues.
- **Main → renderer mapping:** Convert low-level errors into friendly events (e.g., context overflow dispatches `context_overflow` instead of a hard failure).
- **Cancellation:** Use `AbortController` and support `agent:stop-turn` so users can interrupt long operations.
- **Invariants and logging:** Use lightweight invariant checks; log at boundaries with structured context; never swallow errors.
- **Intentional catches must be observable.** On critical paths, every intentional catch either rethrows, surfaces a degraded observable state, or routes through the intentional-swallow helper with operation + reason metadata (best-effort cleanup included). When catching `fs.*` errors, narrow on `error.code` — a bare catch without errno narrowing is a silent-failure red flag. Defensive hardening must audit consumers for fail-open defaults (`?? true`, empty catches, legacy-compat fallbacks) that silently negate the gate; atomic-write helpers carry a caller matrix stating whether each caller treats write failure as fatal, warned, retried, or explicitly silent.
- **Soften/suppress opt-IN from a positive signal, never via a deny-list.** A gate of the form `condition && !flaggedException` (suppress unless a producer marked itself exempt) FAILS OPEN for every producer that doesn't set the flag — and you usually can't enumerate them all. Require a *positive* confirmed signal (the value must positively be the case you're handling), or remove the softening entirely once analysis shows the surviving cases are exactly the ones that must NOT be softened. (260619 offline blame-suppression: a deny-list covering only the admission terminals would have softened genuine missing-credential errors from the route/recovery producers while offline, hiding the real "add a key / switch model" fix; the softening was removed once every remaining `connection-not-configured` was shown to be genuine config.)
- **A diagnostic that exists but fires only late is a design smell.** When a classifier/probe already exists but only runs at a terminal/timeout, ask whether it should run at the earliest cheap decision point instead of building something new. (260619 fail-fast-offline: `diagnoseTimeout` existed but only fired at the 5-min watchdog; running the same probe early on the first network-class throw turned a ~32-min hang into a ~2s honest offline terminal.)
- **One layer owns the user-visible verdict.** For automation/MCP/agent-event flows, identify the layer that owns the final success/failure verdict and verify every upstream failure signal reaches it before persistence or notification — improving a humanizer or mapping layer does not discharge consumer-side routing (separate obligations). Wrong-class-loud is also a bug: when a routing layer throws typed errors for intentional graceful degradation, catch sites must discriminate degradation from genuine failure. Paths that reduce attachment/media fidelity emit a structured log and surface a UI-visible flag or hard limit; time/schedule computations over user data fail closed rather than silently defaulting when required fields are missing.
- **Adding a new Sentry capture for a known structured error or known-condition fingerprint** -> Use `captureKnownCondition()` from `src/core/sentry/captureKnownCondition.ts`; do NOT call `captureException` directly with `tags.condition: '<KnownCondition>'`. The literal-class and tag-based ESLint selectors enforce this; the Layer-2 runtime guard catches variable-driven cases. See [ERROR_MONITORING_AND_SENTRY.md](ERROR_MONITORING_AND_SENTRY.md#lint-guards) (Known Condition Registry → Lint guards section).

## Async, concurrency, and cancellation
- Use `AbortController` for cancellable operations (e.g., agent turns). Respect abort signals in long-running tasks.
- Avoid race conditions by guarding state transitions; prefer single-writer patterns for shared resources.
- Don’t leak promises; await or intentionally detach (with comment rationale).
- **Guard against stale state across awaits.** Use a generation/epoch counter as the standard primitive for controller-style objects that must survive async recoveries and reject stale callbacks. Never mutate a value used for classification or branching before the branch reads it — snapshot inputs into locals first. Read-modify-write paths on settings/stores fetch fresh state immediately before writing; a prior read is not assumed current.
- **Fixed-beat background passes must converge.** Schedulers, watchers, and per-sync cycles must not swallow errors and retry identically forever — require bounded backoff with terminal-vs-transient classification, or a change gate, so persistently failing or no-op inputs do less work each beat. Scanners reading user- or cloud-synced directories use timeout-armed per-file isolation, not unbounded serial reads.
- **Fire-and-forget OS daemons need a delivered post-condition.** When integrating with ShipIt/NSIS/Squirrel/system services, enumerate the target post-condition, the next-launch detection mechanism, and the user-visible recovery path — process liveness is not a substitute.
- For concurrent Super-MCP subprocesses, preserve the owner-tag, owner-registry, and port-baseline lease contracts in [SUPER_MCP_LIFECYCLE.md](SUPER_MCP_LIFECYCLE.md); cleanup must fail closed unless ownership is proven killable.

## React and state management
- Prefer **functional components** and hooks.
- Keep state minimal; derive with `useMemo`/pure helpers. Avoid storing derived/computable values.
- Side-effects in `useEffect` only; one effect per concern; keep dependency arrays correct and narrow.
- Debounced or `setTimeout` callbacks in hooks that must read live state: sync the latest value into a ref via `useEffect` and read the ref inside the callback — exhaustive-deps alone doesn't protect against event-handler closures capturing pre-setState values.
- **Zustand** for agent-session domain state (selectors to minimize re-renders). Keep reducers pure; isolate effects in subscribers/hooks.
- Avoid prop drilling for cross-cutting concerns; use context providers (see `CONTEXT_AND_PROVIDER_HIERARCHY.md`).

## UI, styling, and components
- Use shared UI library: `@renderer/components/ui` (Button, Dialog, Input, Tabs, Card, Badge, Toast, Tooltip).
- Do not add styles to `deprecated.css`. Prefer composition over custom one-offs.
- Keep components small and focused; prefer composition and clear props over deep inheritance or magic flags.

## Analytics and tracking
New user-facing features **must** include analytics instrumentation. There is no autocapture — PostHog receives events exclusively through RudderStack, and every trackable interaction requires an explicit call.

**Definition of done for analytics:**
- [ ] Key user interactions (tab views, button clicks, feature usage) have `tracking.*` calls in the renderer (see `src/renderer/src/tracking.ts`)
- [ ] Main-process events use `trackMainEvent` (see `src/main/analytics.ts`)
- [ ] Events follow the "Object Action" naming pattern (e.g., `Action Item Archived`, `Automation Run Completed`)
- [ ] New event categories extend the `tracking` object in `tracking.ts` — keep event semantics centralized
- [ ] [ANALYTICS_DATA_DICTIONARY.md](./ANALYTICS_DATA_DICTIONARY.md) is updated with the new events, properties, and business value
- [ ] Events verified in PostHog during dev testing (`window.api.getAnalyticsStatus()` returns `healthy`)

See [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md](./ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md) for the full architecture, event APIs, and naming conventions.

## IPC usage guidelines
- Use the generated, domain-scoped APIs (`window.libraryApi`, `window.settingsApi`, etc.). The legacy `window.api` is deprecated and instrumented with telemetry to track remaining usage.
- Every new channel must have:
  - Zod request/response schemas
  - A domain handler
  - Updated generated bridge and validation passing
- Never pass unserializable objects across IPC. Keep payloads small and typed.
- For long-running IPC calls whose results must outlive the caller's UI lifecycle, put the durability boundary on the store-owning side (main process); the renderer reacts to ready notifications rather than owning persistence in callbacks that may never run after unmount.

## Logging and observability
- Use structured logging utilities (`src/core/logger.ts`). Create turn-scoped loggers for agent operations.
- Log intent and outcomes (start/finish/error), not raw payloads. Never log secrets. Mind logger argument order (`[object Object]` output means it's wrong); when malformed logs delayed a diagnosis, the fix includes a hygiene sweep of neighbouring call sites with the same misuse.
- Use breadcrumbs for important user-visible actions to aid diagnosis.

## Performance
- Minimize unnecessary re-renders: selector-based subscriptions, stable callbacks (`useCallback`), and memoization where it buys clarity.
- Avoid storing large blobs in React state; keep heavy data off the critical path.
- Batch state updates when possible; debounce IO where appropriate.

## File I/O policy
- graceful-fs is installed at boot in every Node process — **do not add per-store retries** for the same problem. Use `src/core/utils/emfileRetry.ts` helpers instead.
- If you do add a retry, use `withRetryOnEmfile` (default `maxAttempts: 3` for `node:fs/promises` and `*Sync` callers; `maxAttempts: 1` for callback-style fs ops that graceful-fs queues — to avoid stacking with its 60s hard-coded queue timeout).
- Sync paths are NOT covered by graceful-fs — use `withSingleSyncRetryOnEmfile` for known sync EMFILE sites only, under explicit Sentry evidence.
- LanceDB-adjacent code uses `enfileState` (cooldown), not retry — see `src/main/utils/enfileState.ts`.
- Native modules (sherpa-onnx, win-ca, fsevents, ffmpeg/ffprobe spawns) are NOT covered by graceful-fs. Treat their fs errors as bugs to investigate, not retry candidates.
- New disk-backed renderer-readable stores (and hot main-process reads) inherit the cached-store + EMFILE backoff pattern above — review the underlying storage getter's EMFILE/ENFILE behavior, not only the TypeScript surface API.

### Recursive directory traversal — use `safeWalkDirectory`

- **Recursive directory walks must use `safeWalkDirectory`** from `@core/utils/safeWalkDirectory`. The primitive enforces depth, path-length, and entries caps; deduplicates realpath cycles; classifies skipped subtrees as `'permission'` or `'unreadable'`; and surfaces aggregate truncation through `SafeWalkResult.truncatedReasons`. Raw recursive `fs.readdir` / `fs.readdirSync` / `fs.opendir` walking is not allowed in new code — see REBEL-555 ENAMETOOLONG cluster (a self-nested workspace produced 100+ Sentry issues from one user before the primitive existed).
- **Cloud-mount symlink subtrees are skipped by default** (`skipCloudSymlinkTargets`, default on) — incidental directory symlinks into Google Drive / iCloud / OneDrive / etc. are not descended because FUSE I/O can hang the walk; backup/snapshot and cloud-sync collectors opt out with `skipCloudSymlinkTargets: false`. See [LIBRARY_SCAN_AND_CLOUD_WORKSPACES.md](LIBRARY_SCAN_AND_CLOUD_WORKSPACES.md).
- **Manifest-derived destructive operations must gate on completeness.** Any code that builds a manifest from a walk and then derives "this set is missing, therefore delete it / re-push it / repair it" MUST check `isSafeWalkComplete(result)` (or the equivalent envelope `complete` field) before issuing the destructive op. A truncated walk is not proof of absence. See `cloudWorkspaceSync.executeSyncCore` for the pattern: `LocalManifestResult { manifest, complete, reasons }` + fail-closed gating around `getDeletedFiles`, `getCloudMissingFiles`, the cloud-missing → push merge, and the TOCTOU fresh-manifest check.
- **The bounded-walker ratchet enforces this.** `scripts/check-bounded-walker-recursion.ts` runs in `validate:fast` and fails if a new file introduces raw recursive `fs.readdir` patterns. Existing legacy walkers carry `// bounded-walker-pending: <reason>` annotations and are tracked against a monotonically-decreasing baseline in `docs/project/CODE_HEALTH_STATUS.md`. To migrate one, replace the recursion with `safeWalkDirectory` and remove the annotation; the baseline check accepts the lowered count.
- **`// bounded-walker-exempt: <reason>`** is for genuinely-bounded recursive walkers that don't fit `safeWalkDirectory`'s contract (e.g., per-directory truncation with prioritization, as in `fileTreeService.buildFileTree`). Use sparingly — exempt baseline is also tracked.

### Intent & Design Rationale: bounded-walker completeness propagation

The **REBEL-555 cluster** (ENAMETOOLONG + partial-walk → silent destructive-op trigger) recurred because per-callsite hygiene isn't sufficient — `4d8981cd2` fixed one walker; `0.4.35` shipped with a different walker from the same recurrence class. The problem class requires structural closure.

Three structural moves eliminate the class:
1. **Primitive evolution** — `safeWalkDirectory` now surfaces `'permission'` and `'unreadable'` truncation reasons so callers can no longer treat silent skips as "complete."
2. **Typed envelope completeness propagation** — manifest-building APIs return `{ manifest, walk: SafeWalkResult }` envelopes; `isSafeWalkComplete(result)` centralizes the completeness gate.
3. **Ratchet lint rule** — `scripts/check-bounded-walker-recursion.ts` prevents new raw recursive walkers from shipping and monotonically reduces the legacy annotation count.

**Fail-closed rule:** A truncated walk MUST freeze destructive ops (deletion, cloud-missing repair, conflict-filter bypass, TOCTOU retry). Best-effort proceed is not acceptable — partial results are not proof of absence, and proceeding silently on a truncated manifest has caused real cloud-side data loss events.

**Keystone gate:** `cloudWorkspaceSync.executeSyncCore` checks `complete === true` before issuing any destructive operation. The ratchet is `scripts/check-bounded-walker-recursion.ts`. Full context and Post-Deploy Watch criterion: [`docs/plans/260503_s9_bounded_walker_resource_budget.md`](../plans/260503_s9_bounded_walker_resource_budget.md).

See:
- `docs/plans/260428_graceful_fs_emfile_fix.md` (graceful-fs background)
- `docs/plans/260503_s9_bounded_walker_resource_budget.md` (this primitive + ratchet)
- `src/core/utils/safeWalkDirectory.ts` (the primitive itself; the JSDoc describes every guard and the truncation contract)

## Persistence and reconciliation
- **Subset-based deletion or reconciliation must be proven against the full authoritative set** — an incomplete delta can orphan valid records. Reconciliation functions document whether their input is full truth or a delta, and callers honor that contract (companion to the fail-closed truncated-walk rule above).
- **Sticky persistent-state mutations are allow-listed, not deny-listed:** gate them on an allow-list of triggering inputs; the default for ambiguous inputs is no mutation. Trust-coupled identity tuples (fields that together describe one entity — by/id/email) are written atomically, all-or-nothing, via a single setter or value object — never as independent per-field assignments.

## Testing and validation
- Prefer tests around pure reducers/utilities and critical IPC contracts.
- Useful commands:
  - `npm run validate:fast` (lint + IPC validation + store versions + MCP bundles + circular deps + TS error ratchet + husky pre-push fast-tier check + integration-test provider-gate check — **static checks only, does NOT run unit tests**)
  - `npm run verify:agent` (validate:fast + knip-health + unit tests — **use this for full pre-push verification**)
  - `npm run test` / `test:watch` (unit)
  - `npm run test:e2e` (Playwright)
  - `npm run replay:session-trace <trace.json>` (store-level regression check)
- *Note (2026-05-15):* The prior ESLint `'warn'` guard against `vi.mock` / `vi.doMock` was demoted to `'off'` because its CLI noise floor (~2,230 warnings) outweighed its observed bug-prevention signal (~0/quarter); agents should still prefer dependency injection or `@internal` exports over module-level mocking (see `docs/plans/260515_eslint_warning_floor_and_ratchet.md`).
- **Deploy-beta pre-push safety:** The `.husky/pre-push` hook automatically runs `vitest related` on changed source files (including files merged in from other agents) when `[deploy-beta]` is in outgoing commits. This catches stale test mocks from concurrent agent merges before CI does. See `docs-private/postmortems/260410_recurring_ci_test_mock_staleness_postmortem.md`.
- Keep tests readable and focused on behavior, not implementation details.
- **Test production code, don't reimplement it.** Tests that duplicate production logic inline (e.g., reimplementing a message-parsing loop) pass even when the real code regresses. Import and call the actual function under test. Extract small, testable helpers from production code if the function is hard to call directly. Mock external dependencies (network, DB, OS APIs) as needed for isolation, but don't mock or reimplement the code under test itself. Reserve "contract tests" for genuine boundary validation (SDK message shapes, external API contracts) where you're testing the *shape*, not the *behavior*.
- **Behavioral correctness > type correctness.** Types prevent one class of bugs; behavioral contract tests prevent another. When refactoring code that transforms data across abstraction boundaries (Options/Params/Config objects, event unions, message adapters), add assertions that the *output behavior* is preserved — not just that the code compiles. Code that type-checks can still silently drop fields, change defaults, or alter runtime semantics. This is our #1 review failure mode: `behavioral_semantic_gap` — code compiles, types check, behavior is wrong. Red-flag pattern: changing an abstraction boundary without a test proving fields and semantics survive the transformation.
- **On user-facing failure surfaces, assert the rendered outcome, not an internal classification token.** A test that pins the same internal literal the code emits (e.g. asserting `errorKindOverride === 'auth'`) validates the implementation against itself — it can never fail when that token is wrong, which makes it anti-protective. Drive the seam to the user-observable result: the rendered toast/overlay/banner copy, asserted on the surface that is actually mounted after the action (hook-state assertions miss a banner wired to a surface that unmounts). Motivating cases: never-connected provider shown "provider rejected your credentials" for 40 days (`docs-private/postmortems/260608_disconnected_provider_rejected_credentials_toast_17dde9d_postmortem.md`); teardown failure banner asserted via hook state only (`docs-private/postmortems/260610_cloud_teardown_failure_surface_honesty_postmortem.md`).
- **Every suppression filter, guard, or degraded fallback needs a positive-match test against a realistic payload — proven non-vacuous via a forced RED.** A filter with no test proving it *fires* is indistinguishable from one that never matches (a Sentry noise filter checked the wrong field and matched nothing for 106 days — `docs-private/postmortems/260606_rebel184_cie2e_sentry_filter_postmortem.md`). When adding such a test, temporarily neuter the guard (or feed the pre-fix payload) and confirm the test goes red before trusting the green.
- **Mocks must mirror the production contract they stand in for.** When mocking a factory or accumulator whose production form augments and returns its input, the mock must do the same — returning `undefined` silently disables downstream assertions on the return value. Catch-and-recover branches get tests for both the target error class (recovery fires) and non-target classes (rethrow/propagate).
- **Multi-event race paths must be tested with the adversarial ordering.** When a code path handles a race between multiple events for the same entity (ordering, supersede, dedup, upgrade-in-place), its tests **MUST** reproduce the adversarial multi-event ordering — not only the single-event happy path. Replay the competing events through the *real* reducer/handler in **both** orderings and assert the end state, including the case where the "wrong" event arrives first. A single-event test passes while the race silently breaks. Motivating case: the F3 transient-error dual-emit, where the renderer's supersede/stamp logic was correct in isolation but the dual-emit ordering went untested (`docs-private/postmortems/260529_transient_error_stamp_dead_for_dual_emit_postmortem.md`).

## Dependencies
- Favor stable, well-documented libraries. Avoid niche packages unless justified. Verify an external SDK's env-var / default-path / cache assumptions against the library's own API or source — not conventions from a related ecosystem.
- Electron packaging constraints: avoid runtime `require()` for bundled dependencies; follow `docs/project/PACKAGED_DEPENDENCY_NOTES.md`. Exception: `src/core/lazyElectron.ts` uses runtime `require('electron')` specifically for genuinely desktop-only code paths that the cloud service never executes. Before adding a new main-process runtime dependency, check for native or transitive native deps (fsevents, chokidar, better-sqlite3, …), externalize in `vite.main.config.mjs` as needed, and smoke-launch the packaged app.
- Keep bundle size reasonable; prefer tree-shakeable modules and lazy-loading when practical.

## Tooling and formatting
- Type-check with `npm run lint` (tsc `--noEmit`).
- Use Prettier (JSON formatted via `.prettierrc.json`) and Stylelint for CSS (`npm run lint:css`).
- Match existing formatting; avoid unrelated reformatting in functional edits.

## Git and change management
- Keep commits atomic and well-titled. Group related edits; avoid mixing refactors with functional changes.
- **Machine-consumed files are code-grade, however prose-like the edit looks.** Files read by validators, catalogues, status readers, or other automated pipelines (server manifests, STATUS files, generated-index inputs) get the same pre-land validation and guarded landing path as source code.
- Use `npm ci` for installs to preserve lockfile integrity (avoid `npm install` unless necessary).
- Default to `--force-with-lease` only on personal branches when needed; never force-push shared branches.

## Documentation norms
- Update or create docs under `docs/project/` when introducing patterns or architecture changes.
- Prefer short, high-signal docs with links to canonical sources (IPC, state management, system architecture).
- Follow existing naming/date conventions for plans and conversations.

## Security and privacy
- Treat API keys and user data as sensitive. Never log secrets or commit credentials.
- Respect OS permissions and user intent (microphone, file access). Degrade gracefully if unavailable.
- Be deliberate about MCP usage; fail loudly if required MCP is unavailable.
- **Markdown is untrusted input.** Every `react-markdown` surface that renders anchors or images is an XSS trust boundary. Route all scheme-safety through the shared SSOT (`@rebel/shared` → `classifyMarkdownUrl` / `findBlockedUrlScheme` / `createGuardedUrlTransform`); guard **both** `a` and `img` (twin-guard rule); never hand-roll a local `javascript:`/`blob:`/`file:` predicate. New surfaces must be added to the CI ledger. Full rules: [`MARKDOWN_URL_GUARD.md`](./MARKDOWN_URL_GUARD.md).

## Browser localStorage

- **Ephemeral UI state only**: sidebar widths, dismissed banners, filter preferences, view mode toggles.
- **Never** store user-created content, PII, or data that would be problematic to lose on cache clear.
- If data needs to survive a cache clear or app reinstall, use the main-process settings store or persist to disk (e.g., Space file storage).
- Cautionary example: plugin archives were stored in localStorage and would vanish silently on cache clear. Now stored as an `archivedAt` field in the plugin's manifest.json on disk.

## Comments and naming
- Comment only for non-obvious rationale, invariants, and edge cases. Don’t narrate the code.
- Use descriptive names (no 1–2 letter identifiers). Prefer early returns and shallow control flow.
- Avoid magic numbers; extract well-named constants where it improves clarity.

---

References:
- Internal: `AGENTS.md`, `ARCHITECTURE_IPC.md`, `ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md`, `PACKAGED_DEPENDENCY_NOTES.md`, `LOGGING.md`
- Inspiration: [Coding Principles (gjdutils)](https://raw.githubusercontent.com/gregdetre/gjdutils/main/docs/instructions/CODING_PRINCIPLES.md)

