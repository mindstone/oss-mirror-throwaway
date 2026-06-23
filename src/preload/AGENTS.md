---
description: "Rules and signposts for src/preload/ — the Electron context-isolation security boundary that bridges main and renderer via contextBridge."
last_updated: "2026-06-07"
---

# src/preload — Context-Isolation Security Boundary

`src/preload/` is the **only** bridge between the Electron main process and the renderer. It runs in an isolated context that *can* touch `electron` APIs but is sealed off from renderer code by `contextIsolation: true` (`src/main/index.ts`). It exposes a small, typed surface to the renderer via `contextBridge` — and nothing else. This is a **trust boundary**: renderer input is untrusted.

## Hard rules

- **Never weaken context isolation.** `contextIsolation` stays `true` and `nodeIntegration` `false` (`src/main/index.ts`). Never expose the raw `electron` module, a raw `ipcRenderer`, or Node primitives to the renderer — that hands a renderer (or injected page content) arbitrary main-process power.
- **Cross the boundary only through `contextBridge.exposeInMainWorld(...)`.** The renderer gets typed *domain APIs* (`settingsApi`, `libraryApi`, …), never a generic IPC escape hatch.
- **Channels must be contract-backed.** Register request/response shapes in `src/shared/ipc/contracts.ts`; `validate:fast` enforces this via `validate:ipc` (schemas + duplicate-name checks) and `validate:ipc-handler-parity` (handler coverage, with explicit exceptions for emergency / test / one-way paths). The generated bridge forwards typed requests via `ipcRenderer.invoke`/`sendSync` — don't add ad-hoc untyped IPC calls outside the contract system.
- **Gate test/dev-only surfaces.** `window.e2eApi` is exposed only under `--e2e-test-mode`; `window.__rebelDev` only when `NODE_ENV === 'development'`. Never expose these unconditionally — they can clear sessions / inject events.
- **Don't import from `src/main/`.** The preload is a separate context; depend on `src/shared/` contracts only. (`electron` itself *is* available here — that's the point of preload — the rule is about not leaking it onward.)
## What lives here

- `index.ts` — preload entry: Sentry IPC bootstrap, builds + exposes every domain API, plus the gated `e2eApi` / `__rebelDev` / `emergencyApi`
- `ipcBridgeBuilder.ts` — the generic `makeDomainApi()` factory + `channelToMethodName()`, which derives method names kebab→camel (e.g. `agent:stop-turn` → `agentApi.stopTurn`); don't hand-maintain method maps
- `ipcBridge.ts` — instantiates the concrete domain APIs from the contracts
- `*SubscriptionFactory.ts` — push-event subscription wiring exposed to the renderer

> `window.api` (the legacy flat API) is retained for back-compat — prefer the domain APIs (`settingsApi`, `libraryApi`, …) for new code.

## See also

- Root [`AGENTS.md`](../../AGENTS.md) — repo-wide rules; the "Contract-first IPC with Zod" and Code Entry Points sections
- [`../main/AGENTS.md`](../main/AGENTS.md) — the main process that registers the IPC handlers these APIs call
- [`../renderer/AGENTS.md`](../renderer/AGENTS.md) — the consumer of the exposed `window.*` APIs
- [`../shared/ipc/contracts.ts`](../shared/ipc/contracts.ts) — the Zod channel registry every exposed method must have an entry in
- [`docs/project/ARCHITECTURE_IPC.md`](../../docs/project/ARCHITECTURE_IPC.md) — IPC contract system, dispatcher pattern, "Adding a new channel"
