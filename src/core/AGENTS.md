---
description: "Rules and signposts for src/core/ — platform-agnostic business logic and boundary interfaces consumed by desktop, cloud, and mobile."
last_updated: "2026-05-14"
---

# src/core — Platform-Agnostic Core

`src/core/` is the **source of truth for business logic** that has to work on all three surfaces: desktop (Electron), cloud (Node.js HTTP server), and mobile (React Native).

This is where new services, utilities, and feature evolutions go by default. Surface-specific code (Electron APIs, RN APIs, HTTP routing) is wired in via boundary interfaces from `src/main/`, `cloud-service/`, and `mobile/`.

## Hard rules

- **No static `electron` imports.** No `import { app, BrowserWindow, ... } from 'electron'`. Prefer boundary interfaces. The narrow exception is `src/core/lazyElectron.ts`, which uses a computed module name to bypass esbuild so it works on cloud; don't add new lazy-electron call sites without an explicit reason.
- **Zero imports from `electron-store`.** Use `getStore()` from `@core/storeFactory` via the lazy pattern.
- **Zero imports from `react-native`.** This directory must be RN-safe.
- **Stores use the lazy `getStore()` pattern** — never instantiate stores at module load. See `src/core/store.ts` and `src/core/storeFactory.ts`.
- **Use `@core/...` path aliases** for intra-core imports. Code outside `src/core/` also imports via `@core/...`.
- **Never log secrets.** Use structured logging via `createScopedLogger()` / `createTurnSessionLogger()` from `@core/logger`.

## Boundary interfaces

When you need a platform capability, depend on the interface, not the implementation. Each surface wires the concrete implementation at bootstrap.

- `@core/platform` — `PlatformConfig` (paths, app version, etc.); replaces `app.getPath()`, `app.getVersion()`
- `@core/storeFactory` — `StoreFactory`; replaces `electron-store`
- `@core/handlerRegistry` — `HandlerRegistry`; replaces `ipcMain.handle()`
- `@core/broadcastService` — `BroadcastService`; replaces `BrowserWindow.webContents.send()`
- `@core/errorReporter` — `ErrorReporter`; replaces direct Sentry imports
- `@core/tracking` — analytics; replaces direct Rudderstack imports

If a new surface-specific capability is needed and a boundary interface doesn't exist yet, add one here first, then wire it in each consuming surface as applicable (`src/main/bootstrap.ts` for Electron, `cloud-service/src/bootstrap.ts` for cloud; mobile typically consumes via `cloud-client` rather than wiring directly).

## See also

- Root [`AGENTS.md`](../../AGENTS.md) — repo-wide rules, especially "Core-first, desktop-first architecture" and the Code Entry Points list
- [`docs/project/REBEL_CORE.md`](../../docs/project/REBEL_CORE.md) — runtime architecture
- [`docs/project/MODEL_AND_PROVIDER_OVERVIEW.md`](../../docs/project/MODEL_AND_PROVIDER_OVERVIEW.md) — hub for model / provider / billing / thinking (routing, settings resolution, proxy auth boundary, roles & fallback — much of which lives in `rebelCore/`)
- [`docs/project/ARCHITECTURE_OVERVIEW.md`](../../docs/project/ARCHITECTURE_OVERVIEW.md) — system overview
- [`docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md`](../../docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md) — agent turn pipeline (much of which lives in `rebelCore/`)
- [`docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md`](../../docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md) — the checklist you must walk when a feature touches multiple surfaces
- [De-electronification tutorial](../../docs/tutorials/260220_cloud_refactoring_de_electronification.html) — the rationale and history of the boundary-interface pattern
- `rebelCore/` — the in-process agent runtime (turn executor, tool routing, MCP integration); see its files for the agent-loop entry points
- `services/` — domain services consumed by all surfaces; see [CORE_SERVICES_OVERVIEW](../../docs/project/CORE_SERVICES_OVERVIEW.md) for a one-line map of each service subdir
- `safetyPromptLogic.ts` — pure helpers for safety-prompt evaluation; large surface; see [SAFETY_SYSTEM_OVERVIEW](../../docs/project/SAFETY_SYSTEM_OVERVIEW.md) for the system around it
- `constants.ts` — also contains `ALL_STORE_VERSIONS`; update when bumping a store version
- [`types/`](types/) — cross-surface turn contracts: headless-turn options, turn policy, content-resolution reasons
- [`devDiag/`](devDiag/) — developer auth diagnostics (e.g. `anthropicAuthDiag.ts`)

## When something doesn't belong here

If the logic genuinely requires Electron (`safeStorage`, `BrowserWindow`, `Tray`, OAuth interactive flow, `auto-updater`, screen capture, microphone) or React Native, it lives in `src/main/` or `mobile/` respectively — never in `src/core/`. The test: would this file compile and run unchanged inside a Node.js HTTP server?
