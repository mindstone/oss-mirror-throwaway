---
description: "Rebel-specific dependency blockers, version constraints, and Dependabot alert patterns. The general upgrade process, risk tiers, audit commands, and cheap-vs-frontier model dispatch live in coding-agent-instructions."
last_updated: "2026-06-17"
---

# Dependency Upgrades & Dependabot (Rebel-specific)

This doc holds **Rebel's** version blockers, transitive-alert patterns, and repo-specific audit surfaces — the facts the general process tells you to look up here.

> **General process lives in the shared instructions.** Risk tiers, bake-time policy ("newest ≠ safest"), the audit commands, `overrides` policy, spike-before-bump, and cheap-vs-frontier model dispatch: [DEPENDENCY_UPGRADES_AND_DEPENDABOT (general, cross-repo)](../../coding-agent-instructions/docs/DEPENDENCY_UPGRADES_AND_DEPENDABOT.md). What follows is Rebel-specific only.


## See Also

- [DEPENDENCY_UPGRADES_AND_DEPENDABOT (general, cross-repo)](../../coding-agent-instructions/docs/DEPENDENCY_UPGRADES_AND_DEPENDABOT.md) — the reusable upgrade process (tiers, bake-time, audit commands, model dispatch) that this repo's blockers slot into.
- [PACKAGED_DEPENDENCY_NOTES.md](PACKAGED_DEPENDENCY_NOTES.md) — **critical for Electron upgrades**: native module packaging, `app.asar.unpacked`, platform-specific binaries, testing packaged builds. This doc covers *how* deps get loaded at runtime; ours covers *when/why* to upgrade.
- [BUILDING.md](BUILDING.md) — build tooling, `electron-builder` config, CI pipeline
- [CODING_PRINCIPLES.md](CODING_PRINCIPLES.md) — general engineering principles including dependency management
- [260203_WINDOWS_ELECTRON_PERFORMANCE.md](260203_WINDOWS_ELECTRON_PERFORMANCE.md) — native module loading on Windows, `sherpa-onnx-node` specifics
- `package.json` — dependency declarations, npm `overrides` section
- `electron-builder.cjs` — Electron packaging config (`buildDependenciesFromSource: false`, `npmRebuild: false`)
- `.github/workflows/release.yml` — CI/CD pipeline that builds for macOS (arm64 + x64) and Windows


## Rebel-specific audit surfaces

The general audit commands (the `gh api` alert query, `npm outdated`, `npm ls`) live in the [cross-repo doc](../../coding-agent-instructions/docs/DEPENDENCY_UPGRADES_AND_DEPENDABOT.md#process-how-to-run-a-dependency-audit). In Rebel, also run them against the surfaces that carry their own lockfile and the root audit misses:

- **Submodules / sub-packages**: `cd cloud-service && npm outdated`, `cd super-mcp && npm outdated`, and the `mobile/` lockfile.
- **MCP resource lockfiles**: the ~33 `package-lock.json` files under `resources/mcp/*/` are disconnected from the root dependency tree and need separate `npm audit fix` runs.

For native modules specifically, any Electron major version bump changes the Node.js ABI and requires validating all native modules on all platforms — see [PACKAGED_DEPENDENCY_NOTES.md § Native Modules](PACKAGED_DEPENDENCY_NOTES.md#native-modules-lancedb-etc) for the full inventory (5 modules), the prebuilt binary model (`npmRebuild: false`), and packaging mechanics.

(Risk tiers, bake-time policy, and cheap-vs-frontier model dispatch: see the [general doc](../../coding-agent-instructions/docs/DEPENDENCY_UPGRADES_AND_DEPENDABOT.md).)


## Known Blockers & Version Constraints

### chokidar: Pinned to 3.6.0

**Do not upgrade to v4 or v5.** Three active blockers (as of 2026-03-28):

1. **Glob removal**: v4 removed built-in glob support. `cloudTokenRelay.ts` directly watches globbed paths (`*.json`, `*.token.json`). Would require code changes.
2. **nunjucks peer conflict**: `nunjucks` requires `chokidar ^3.3.0`. Upgrading root to v4/v5 reintroduces dependency resolution errors. (Original downgrade commit: `cf830a93d`, 2025-12-16.)
3. **New-file detection bug in Electron**: chokidar GitHub issue #1361 reports missed `add` events in Electron apps after upgrading from v3 to v4. This directly affects `workspaceWatcherService.ts` which relies on `add` events for file indexing.

**History**: Originally added as `^5.0.0` in commit `b3f47ba7d` (2025-12-15), then immediately downgraded to `^3.6.0` in `cf830a93d` (2025-12-16). Planning doc `docs/plans/obsolete/251215b_workspace_file_watching.md` documents the decision.

**Security note**: chokidar v3 pulls in `picomatch@2.3.1` (Dependabot HIGH alert). Cannot safely override picomatch to v4 — it's a major version jump with behavioral changes in glob matching that would likely break chokidar's file matching.

### Electron: Upgraded to 42.4.x (Node 24.16, shipped 2026-06-13)

**Shipped (FOX-3487, 2026-06-13).** Desktop moved from Electron 39.8.6 (EOL 2026-05-05, no security patches) straight to **`^42.4.0`** (Chromium 148 + Node **24.16.0**), skipping the previously-planned 41.x interim. The upgrade was de-risked by a full measurement spike before the bump — packaged build + boot on macOS arm64/Intel x64 and Windows x64, the full unit tier (42,283 tests) and local E2E fleet under Node 24, fsevents shutdown path, and a cloud `node:24-slim` canary (which ships the exact v24.16.0 Electron bundles). See `docs/plans/260613_electron42-upgrade/` (PLAN + `SPIKE_FINDINGS_REPORT.md`).

The Node 22 → 24 jump landed with it; the deprecation/removal surface was measured benign (one DEP0040 punycode warning class, zero first-party consumers of removed APIs). N-API ABI stability meant prebuilt natives loaded without recompilation. The one carried-over Windows footgun: `better-sqlite3` lacks a Node-20 win32-x64 prebuild, so CI runs Windows `npm ci` on **Node 22** for the install step only (see [CI_PIPELINE](CI_PIPELINE.md) / [CI_WORKFLOW_GOTCHAS](CI_WORKFLOW_GOTCHAS.md)).

**The fsevents-leak sweep/guard machinery is now permanent, not a bridge.** FOX-3487 originally planned to retire the sweep after the upgrade (on the theory that the Node 24 TSFN lifetime fix made an unswept leaked fsevents instance harmless). The spike inverted that premise: on Electron ≥41 an unswept leak converts the old quit-time SIGABRT into an **indefinite, telemetry-blind quit deadlock** at the same finalizer site (deterministic across 48/48 leak-injected quits). So the sweep stays — see [AUTO_UPDATE.md](AUTO_UPDATE.md) and `src/main/services/fseventsLeakGuard.ts`.

**When upgrading further** (43+): dedicated branch with full packaged-app testing on macOS + Windows; validate LanceDB load/search, local STT (`sherpa-onnx-node`, historically fragile on Windows — see `docs/plans/260317_fox2829_windows_local_stt_investigation.md`), embedding paths, filesystem watching, TLS connections, and streaming operations. Watch the same Node-major risk classes (OpenSSL ≥3.5 prohibiting RSA < 2048 / RC4 — test TLS incl. `win-ca`; `url.parse()` deprecation; thrown stream `pipe()` errors; `AsyncLocalStorage` context-frame default) and the Wayland `globalShortcut` regression (#49806) relevant to `voiceHotkeyService.ts`.

### Vite: Blocked on electron-vite

**Cannot upgrade to Vite 8** until `electron-vite` releases Vite 8 support. GitHub issue `electron-vite#894` (opened 2026-03-12, no timeline). Vite 8 replaces esbuild+Rollup with Rolldown (Rust-based bundler) — significant architectural change.

### Claude Agent SDK: Effort Default Bug (Historical — SDK Removed)

> **Note:** The Claude Agent SDK was removed in April 2026. This section is preserved as historical reference only.

**Issue #214**: Starting from v0.2.68+, a feature flag silently changed the `effort` default from "high" to "medium". This severely degraded agentic tool use. Rebel Core now sets `effort` explicitly in all API calls, avoiding this class of bug.

### Sentry Version Alignment

The repo uses npm `overrides` to force Sentry package alignment. When upgrading `@sentry/electron`, check which Sentry JS SDK version it declares internally and match `@sentry/core`, `@sentry/react`, `@sentry/node` to that version. Example: `@sentry/electron@7.10.0` is built against Sentry JS `10.42.0` — so target 10.42.0, not the latest 10.46.0.

### LanceDB / Apache Arrow: Pinned to 0.22.3 (Intel Mac constraint)

**Do not upgrade past 0.22.3** while Intel Mac (`darwin-x64`) support is required.

**Intel Mac binary timeline** (verified via npm registry, 2026-03-29):
- **0.22.3** (Nov 2025): Last version with a working `@lancedb/lancedb-darwin-x64` binary on npm.
- **0.23.0** (Dec 2025): **Trap** — lists `darwin-x64` in optionalDependencies but the binary was **never published** (CI job removed in PR #2836). Would silently fail on Intel Macs.
- **0.24.1** (Jan 2026): All macOS binaries removed (even ARM).
- **0.26.2+** (Feb 2026): ARM Mac restored, Intel Mac permanently dropped.

**Benefits we're missing by staying on 0.22.3:**
- Hybrid search pre-filtering fix (0.27.1) — improves correctness of filtered search results (e.g., search by file type/path)
- Parallel inserts for local tables (0.27.0) — faster indexing/reindexing
- napi-rs v2→v3 upgrade (0.27.0) — modernized native bindings
- FTS improvements and better error messages

**On-disk format is backward-compatible** — upgrading would not require manual reindexing. The project's `indexHealthService.ts` auto-detects and auto-recovers from format incompatibilities.

**When to revisit**: If Intel Mac support is dropped in the future, upgrade to latest LanceDB at that time to pick up the hybrid search fix and performance improvements. The API surface (`connect`, `openTable`, `Index.fts`, `MultiMatchQuery`, `RRFReranker`) appears stable across versions.

### ESLint 10

Upgrade from 9.x is low-risk because the project already uses flat config (`eslint.config.mjs`). Key considerations:

- **`eslint-plugin-react`**: Does NOT declare ESLint 10 support (peerDep only covers `^9.7`). However, the project only uses one active rule from it (`react/jsx-uses-vars`). ESLint 10 now tracks JSX references natively, making this rule redundant. **Cleanest migration: drop `eslint-plugin-react` entirely.**
- **`eslint-plugin-react-hooks`**: Stable version `7.0.1` doesn't declare ESLint 10 peer support, but its internals already use v10-safe fallback APIs (`context.sourceCode ?? context.getSourceCode()`). Works at runtime with `--legacy-peer-deps`.
- **`eslint:recommended` new rules** (`no-unassigned-vars`, `no-useless-assignment`, `preserve-caught-error`): Not applicable — this project does not apply `eslint.configs.recommended` (the `@eslint/js` import exists but is unused).
- **No `eslint-env` comments** found in `src/`.

### TypeScript 6

Upgrade from 5.9 is low-risk because the project's tsconfig files already explicitly set most affected defaults. Key considerations:

- **`types` defaults to `[]`**: Not a problem — already explicitly set (`["node", "electron"]` and `["node", "vite/client"]`).
- **`strict`, `module`, `target`**: All already explicitly set.
- **`baseUrl` deprecated** (`TS5101`): Currently set to `"."` in tsconfig.base.json. Must be removed (path aliases use `paths` which works without `baseUrl`).
- **`rootDir` defaults to `.`**: Currently implicit. May need explicit setting if build output changes.
- **Side-effect CSS imports**: ~30 instances of `import './styles.css'` exist. Not affected because `@types/vite/client` provides type declarations for CSS modules.
- **`electron.vite.config.ts`**: Has 2 type errors (`TS2769`) under TS6 due to `defineConfig` overload strictness. Minor fix needed.
- **`packages/shared/src`**: Needs adding to `include` arrays (`TS6307` for implicitly imported files).

### framer-motion → motion

Version 12 renames the npm package from `framer-motion` to `motion`. No API changes for React — purely a mechanical find/replace of imports from `"framer-motion"` to `"motion/react"`.

### lucide-react 1.0 — BLOCKED

Version 1.0.1+ removed all brand icons (Github, Gitlab, Figma, Trello, Twitter, etc.) for legal reasons. **This project uses 4 brand icons** in the connector catalog UI, so the upgrade was reverted to 0.563.0. See [PACKAGED_DEPENDENCY_NOTES.md § Version-Pinned Dependencies](PACKAGED_DEPENDENCY_NOTES.md#version-pinned-dependencies-brand-icon-constraint) for the full constraint and future upgrade path.


## Dependabot Alert Patterns

Common transitive vulnerability patterns in this repo:

| Alert Package | Root Cause | Resolution |
|---------------|-----------|------------|
| `path-to-regexp` | `@modelcontextprotocol/sdk` → `express@5.2.1` → `router` → `path-to-regexp` | npm override (safe patch bump) |
| `picomatch` | `chokidar@3.6.0` → `picomatch@2.3.1` | **Cannot override** — major version jump. Accept as known risk while on chokidar v3. |
| `dompurify` | `@m2d/remark-docx` → `mermaid` → `dompurify` | npm override (safe patch bump) |
| `yaml` | Transitive in main + mobile lockfiles | npm override |
| `brace-expansion` | Mobile lockfile only | Mobile `npm ci` / override |


## npm Overrides (this repo)

The general `overrides` policy (same-major only, never across majors, verify `npm ci` resolves) is in the [cross-repo doc § Overrides](../../coding-agent-instructions/docs/DEPENDENCY_UPGRADES_AND_DEPENDABOT.md#overrides-transitive-security--alignment). Rebel-specific usage of the `overrides` section in `package.json`:

- **Sentry version alignment** — forces all nested Sentry packages to the same version (see § Sentry Version Alignment above for which version to target).
- **Security patches** — forces vulnerable transitive deps to patched versions (see the alert-patterns table above; e.g. picomatch 2→4 is **not** overridable — a major jump).
- The MCP resource lockfiles (`resources/mcp/*/package-lock.json`) are **not affected** by root overrides — fix them at their own level.


## Maintenance Cadence

See the [cross-repo doc § Maintenance Cadence](../../coding-agent-instructions/docs/DEPENDENCY_UPGRADES_AND_DEPENDABOT.md#maintenance-cadence) for when to run a full audit (alerts accumulating, a critical dep static 6+ weeks, a runtime EOL approaching). The routine Dependabot-queue drain is a step in [WEEKLY_AUTOMATED_REVIEW](WEEKLY_AUTOMATED_REVIEW.md).
