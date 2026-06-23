---
description: "Rules and signposts for cloud-client/ (@rebel/cloud-client) — the platform-neutral client library (API client, stores, hooks, transport) shared by the desktop renderer, mobile, and web-companion."
last_updated: "2026-06-07"
---

# cloud-client — Shared Client Library (`@rebel/cloud-client`)

`@rebel/cloud-client` is the **platform-neutral client layer**: the cloud HTTP/WebSocket API client (`cloudClient.ts`), Zustand stores, React hooks, transport adapters, offline queue, and the DTO types they exchange. The desktop renderer, mobile (React Native), and web-companion all consume it, so logic placed here works on every client surface without duplication.

It is a sibling to `src/core/` (which is platform-agnostic *business* logic): core is the source of truth for agent/runtime logic; cloud-client is the source of truth for *talking to the cloud and holding client-side session state*.

## Hard rules

- **No `electron` or `electron-store` imports.** This library runs in React Native and a browser. Anything Electron-specific stays in the desktop adapter (`src/renderer/`), not here.
- **No `react-native` imports.** Keep it RN-*safe*, not RN-*specific*. `react`, `react-dom`, and `zustand` are **peerDependencies** — consumers provide them; don't pull a second copy in.
- **Reach platform capabilities through injected adapters, never globals.** No direct `window.*`, `localStorage`, or `AsyncStorage`. Persistence goes through the registry in `src/persistence/` and token storage through the `TokenStorage` interface (`src/auth/types.ts`); each surface injects its concrete impl at bootstrap.
- **IPC-shaped calls go through `ApprovalTransport`** (`src/transport/approvalTransport.ts`), not `window.*` directly. Desktop wraps `window.safetyPromptApi` / `window.settingsApi` / `window.safetyPromptSubscriptions` (the last for `onUpdated` push events); mobile wraps `cloudClient.ipcCall(...)`. Hooks depend on the interface so they run unchanged on both.
- **Keep the cloud surface narrow — it must not leak secrets.** The settings transport exposes only specific slice methods (e.g. `setSpaceSafetyLevel`, `addTrustedTool`) — never add full-settings `getAll`/`updateAll` or expose `AppSettings` over the cloud transport, which would leak `providerKeys` / `claude.apiKey`. See the design rules at the top of `approvalTransport.ts`.
- **Don't casually couple to `@shared/ipc/*`** (a desktop-only alias). Approval/transport DTOs are defined locally here on purpose — mirror the Zod-inferred shapes rather than importing them (see `approvalTransport.ts`). The one sanctioned exception is `cloudClient.ts`, which imports channel *contract types* (`IpcChannelName`, `IpcRequestOf`, `IpcResponseOf`) from `@shared/ipc/contracts`.

## What lives here

- `cloudClient.ts` — the HTTP/WebSocket API client and its typed errors (`CloudClientError`, `SessionNeedsReconcileError`, …)
- `stores/` — Zustand stores (session, approval, inbox, staged files, conflict)
- `hooks/` — cross-surface React hooks (e.g. `useEventChannel`)
- `transport/` — platform-neutral IPC-call interfaces + per-surface adapters
- `auth/`, `persistence/`, `offlineQueue/` — injectable client infrastructure
- `selectors/`, `types/` — derived state + DTOs

## See also

- Root [`AGENTS.md`](../AGENTS.md) — repo-wide rules; "Core-first, desktop-first architecture"
- [`src/core/AGENTS.md`](../src/core/AGENTS.md) — the platform-agnostic *business-logic* boundary (its sibling)
- [`mobile/AGENTS.md`](../mobile/AGENTS.md) — the main RN consumer of this library
- [`packages/shared/AGENTS.md`](../packages/shared/AGENTS.md) — lower-level pure utilities this layer builds on
- [`docs/project/APPROVAL_SYSTEM.md`](../docs/project/APPROVAL_SYSTEM.md) — the approval/transport architecture much of this directory implements
- [`docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md`](../docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md) — walk this whenever a change here affects more than one surface
- [`docs/project/ARCHITECTURE_OVERVIEW.md`](../docs/project/ARCHITECTURE_OVERVIEW.md) — system overview
- [`docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`](../docs/plans/260416_centralize_approval_and_diff_viewing_ux.md) — origin + rationale of the transport-adapter pattern
