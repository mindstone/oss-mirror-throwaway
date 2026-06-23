---
description: "Rules and signposts for cloud-service/ — the Node.js HTTP server that reuses src/core/ business logic for cloud and mobile."
last_updated: "2026-05-14"
---

# cloud-service — Cloud HTTP Server

`cloud-service/` is a **standalone Node.js HTTP server** that reuses the platform-agnostic business logic from `src/core/` and serves it to mobile (via `cloud-client`) and any future web surface. It is **not** a separate codebase — it is a thin surface that wires Node.js implementations of the boundary interfaces and routes HTTP to the same handler functions Electron's IPC dispatches to.

## Hard rules

- **Reuse, don't reinvent.** Business logic lives in `src/core/`. Cloud-only logic in `cloud-service/src/` is limited to: HTTP routing, auth, server lifecycle, cloud-specific boundary implementations, and operational concerns (health checks, cloud event broadcaster, self-update scheduler).
- **Boundary interfaces wired in `bootstrap.ts`** — the Node.js equivalents of what `src/main/bootstrap.ts` does for Electron. Same handler functions get registered against the same channel names.
- **Cross-surface parity is a real check, not a vibe.** When a feature touches auth, provider routing, or anything desktop-connected, walk [`CROSS_SURFACE_PARITY_CHECKLIST`](../docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md). The default answer is to sync the underlying data (e.g., via `CLOUD_CHANNEL_POLICIES` dual-write), not to disable the feature on cloud/mobile.
- **Cloud-routable IPC channels are declared in `src/shared/cloudChannelPolicies.ts`** — the single source of truth. Don't ship an HTTP route that exposes an IPC channel without going through this policy. Genuinely cloud-only HTTP routes (auth, file uploads, health, etc.) live in `src/routes/` and don't need a policy entry.
- **Never log secrets** (API keys, tokens, OAuth code). Use the scoped loggers from `@core/logger`.

## Deployment

For code-only changes, build locally and `sftp` the bundle. **Do not** use `fly deploy` — that path is reserved for infrastructure changes. See [`CLOUD_ARCHITECTURE § Deployment`](../docs/project/CLOUD_ARCHITECTURE.md#deployment).

Runtime: Fly.io (`fly.toml`). Build: `build.mjs` produces a single bundled artifact + `runtimeExternals.json`.

## Key entry points

- `src/bootstrap.ts` — wires boundary interfaces with cloud implementations; registers handlers
- `src/server.ts` — HTTP router (routes to same handler functions as Electron IPC)
- `src/entry.ts` — process entry; starts the watchdog and bootstrap
- `src/preBootstrapWatchdog.ts` — pre-bootstrap health/diagnostic
- `src/routes/` — HTTP route handlers (auth, file uploads, etc. — anything that isn't already an IPC channel)
- `src/services/` — cloud-only service implementations; e.g. [`mcp/`](src/services/mcp/) (cloud MCP process spawner + bundled-registration bridge) and [`scheduler/`](src/services/scheduler/) (cloud automation scheduler)
- `src/cloudEventBroadcaster.ts` — server-sent events to mobile clients

## See also

- Root [`AGENTS.md`](../AGENTS.md) — repo-wide rules; especially "Core-first, desktop-first architecture" and "Cross-surface parity check"
- [`../src/core/AGENTS.md`](../src/core/AGENTS.md) — where the business logic actually lives
- [`docs/project/CLOUD_ARCHITECTURE.md`](../docs/project/CLOUD_ARCHITECTURE.md) — full cloud architecture, deployment, ops
- [`docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md`](../docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md) — required check before merging cross-surface features
- [`docs/tutorials/260220_cloud_refactoring_de_electronification.html`](../docs/tutorials/260220_cloud_refactoring_de_electronification.html) — rationale and history of the boundary-interface split
- `src/shared/cloudChannelPolicies.ts` — cloud-routable channel registry
- `src/shared/ipc/contracts.ts` — Zod contracts shared with Electron IPC
