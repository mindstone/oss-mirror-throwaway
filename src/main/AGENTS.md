---
description: "Rules and signposts for src/main/ — Electron main-process code that wires boundary interfaces and houses genuinely desktop-only services."
last_updated: "2026-05-14"
---

# src/main — Electron Main Process

`src/main/` is the **Electron-specific surface**. It does two things:

1. **Wires boundary interfaces** (`@core/platform`, `@core/storeFactory`, `@core/handlerRegistry`, `@core/broadcastService`, `@core/errorReporter`, `@core/tracking`) with their Electron implementations.
2. **Houses genuinely desktop-only services** that need Electron APIs and have no portable equivalent.

The high-level rule is: if it can live in `src/core/`, it should. Files here exist because they genuinely can't.

## Hard rules

- **Default to `src/core/`** for new business logic. Adding logic here that doesn't need Electron APIs is wrong by default.
- **Wire boundaries in `bootstrap.ts`** before `executeAgentTurn()` or any other core-call paths run. Boundary access before bootstrap is a bug.
- **IPC handlers go in `ipc/`** with Zod contracts in `src/shared/ipc/contracts.ts`. New channels must be registered there and pass `validate:ipc`.
- **Cloud-routable channels are declared in `src/shared/cloudChannelPolicies.ts`** — that file is the single source of truth for what crosses the cloud boundary.
- **Stores must use the lazy `getStore()` pattern** (`electron-store` instances are wrapped via `@core/storeFactory`, not constructed directly inside business logic).
- **Never log secrets** (API keys, tokens, OAuth code). Use the scoped loggers from `@core/logger`.

## What genuinely lives here

Things that need Electron APIs:

- `index.ts` — app startup, agent turn loop (`executeAgentTurn()`), window lifecycle. **Large by design; this is the central Electron coordinator and the coordination logic has to live somewhere.** Adding new logic here is wrong by default — push it into `src/core/` or a focused service.
- `bootstrap.ts` — wires the Electron implementations of every boundary interface and registers IPC handlers
- `ipc/` — IPC dispatcher (check here first for any channel)
- `services/` — desktop-only services: OAuth (interactive browser flow), voice (mic capture), screenshots, auto-updater, MCP server spawning, tool safety, Tray, file dialogs, etc. See [MAIN_SERVICES_OVERVIEW](../../docs/project/MAIN_SERVICES_OVERVIEW.md) for a one-line map of each service subdir.
- `settingsStore.ts` — settings persistence via `electron-store`
- `sentry.ts` — Sentry main-process integration
- `cli.ts` — CLI entry for local diagnostics

## See also

- Root [`AGENTS.md`](../../AGENTS.md) — repo-wide rules; especially "Core-first, desktop-first architecture" and the Code Entry Points list
- [`../core/AGENTS.md`](../core/AGENTS.md) — what `src/core/` is for and why it cannot import Electron
- [`docs/project/ARCHITECTURE_OVERVIEW.md`](../../docs/project/ARCHITECTURE_OVERVIEW.md) — system overview
- [`docs/project/ARCHITECTURE_IPC.md`](../../docs/project/ARCHITECTURE_IPC.md) — IPC contracts, dispatcher pattern, validation
- [`docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md`](../../docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md) — turn pipeline (`executeAgentTurn()`)
- [`docs/project/SAFETY_SYSTEM_OVERVIEW.md`](../../docs/project/SAFETY_SYSTEM_OVERVIEW.md) — tool safety service architecture
- [`docs/project/WINDOWS_SUPPORT.md`](../../docs/project/WINDOWS_SUPPORT.md) — platform-specific main-process gotchas
- `src/shared/ipc/contracts.ts` — IPC channel registry with Zod schemas
- `src/shared/cloudChannelPolicies.ts` — cloud-routable channel list
