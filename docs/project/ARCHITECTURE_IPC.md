---
description: Contract-first IPC architecture — Zod schemas, HandlerRegistry, code generation, cloud channel routing
last_updated: "2026-06-10"
---

# IPC Architecture

This document describes the IPC (Inter-Process Communication) architecture used in Mindstone Rebel for communication between the Electron main process and renderer process, and how it extends to the cloud service.

## Overview

Rebel uses a **contract-first, typed IPC system**. Every channel is defined once with Zod schemas, then consumed across all layers:

1. **Contracts** define request/response shapes → `src/shared/ipc/channels/*.ts`
2. **Runtime bridge builder** creates typed domain APIs from contracts → `src/preload/ipcBridge.ts` + `src/preload/ipcBridgeBuilder.ts`
3. **Handlers** implement business logic behind `registerHandler()` → `src/main/ipc/*Handlers.ts`
4. **HandlerRegistry** abstracts transport — `ipcMain.handle()` on desktop, plain `Map` on cloud
5. **Cloud policies** control which channels forward to the cloud service → `src/shared/cloudChannelPolicies.ts`

Key properties:
- **Type safety**: Zod schemas give both compile-time and runtime validation
- **Single source of truth**: All channels live in `src/shared/ipc/channels/`
- **Platform-agnostic handlers**: The same `register*Handlers()` functions work in Electron and cloud
- **No codegen step**: Domain APIs are derived from contracts at build time via TypeScript mapped types

## See Also

- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) — high-level system architecture, major components, data flows
- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) — renderer state architecture, session engine internals
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) — agent session model, history persistence
- [ARCHITECTURE_MESSAGE_QUEUE.md](ARCHITECTURE_MESSAGE_QUEUE.md) — message queue and interrupt-mode design
- [LOGGING.md](LOGGING.md) — structured logging architecture, log destinations

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RENDERER PROCESS                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   React Components                                                          │
│       │                                                                     │
│       ├── window.libraryApi.listFiles()       // Domain API (preferred)    │
│       ├── window.settingsApi.get()             // Domain API (preferred)    │
│       └── window.api.listWorkspaceFiles()      // Legacy flat API           │
│                                                                             │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ ipcRenderer.invoke()
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PRELOAD SCRIPT                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   src/preload/index.ts                                                      │
│       ├── Imports domain APIs from generated/ipcBridge.ts                   │
│       ├── Exposes 50+ domain APIs via contextBridge.exposeInMainWorld()     │
│       └── Maintains legacy `api` object for backward compatibility          │
│                                                                             │
│   src/preload/ipcBridgeBuilder.ts   (pure-type runtime builder)              │
│       ├── makeDomainApi() factory: derives typed wrappers from contracts     │
│       │   via TypeScript mapped types — no codegen or Zod introspection     │
│       └── Kebab-to-camelCase method names, IpcRequestOf/IpcResponseOf types │
│                                                                             │
│   src/preload/ipcBridge.ts                                                  │
│       ├── Instantiates domain APIs (libraryApi, settingsApi, …) via builder │
│       └── Re-exports types; legacy compat layer for window.api              │
│                                                                             │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ IPC channel (e.g. 'demo:enter')
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               MAIN PROCESS                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   HandlerRegistry (src/core/handlerRegistry.ts)                             │
│       │  interface: register(channel, handler) / remove(channel) / get()    │
│       │                                                                     │
│       ├─ ElectronHandlerRegistry  (src/main/ipc/utils/)                     │
│       │    wraps ipcMain.handle() + cloudRouter dual-write/routing          │
│       │                                                                     │
│       └─ MapHandlerRegistry       (cloud-service/src/)                      │
│            plain Map — cloud IS the destination, no routing needed           │
│                                                                             │
│   registerHandler()  (src/main/ipc/utils/registerHandler.ts)                │
│       delegates to getHandlerRegistry().register()                          │
│                                                                             │
│   src/main/ipc/*Handlers.ts  (60+ handler modules)                          │
│       each exports register*Handlers(deps) using registerHandler()          │
│                                                                             │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SHARED CONTRACTS                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   src/shared/ipc/channels/*.ts   (55+ domain files)                         │
│       Zod schemas for every channel's request + response                    │
│                                                                             │
│   src/shared/ipc/contracts.ts                                               │
│       ipcContract — authoritative registry used by code generator           │
│       allChannels — flat map for quick lookup                               │
│       IpcRequestOf<T> / IpcResponseOf<T> type utilities                     │
│                                                                             │
│   src/shared/cloudChannelPolicies.ts                                        │
│       CLOUD_CHANNEL_POLICIES — which channels dual-write to cloud           │
│       Derived: CLOUD_ROUTABLE_CHANNELS, DUAL_WRITE_CHANNELS,               │
│                CLOUD_IPC_ALLOWLIST                                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/shared/ipc/channels/*.ts` | Channel definitions with Zod schemas (one file per domain) |
| `src/shared/ipc/contracts.ts` | Contract registry (`ipcContract`), flat map (`allChannels`), type utilities |
| `src/shared/ipc/schemas/common.ts` | `defineInvokeChannel()` helper and shared schemas |
| `src/shared/ipc/schemas/utils/` | Schema helper utilities — e.g. `observingSafeParse` (safe-parse with observability hooks) |
| `src/shared/cloudChannelPolicies.ts` | Cloud routing policies (dual-write, transport type) |
| `src/core/handlerRegistry.ts` | Platform-agnostic `HandlerRegistry` interface |
| `src/main/ipc/utils/registerHandler.ts` | `registerHandler()` — delegates to `getHandlerRegistry()` |
| `src/main/ipc/utils/ElectronHandlerRegistry.ts` | Electron impl — wraps `ipcMain.handle()` with cloud routing |
| `src/main/ipc/index.ts` | Barrel export of all `register*Handlers()` functions |
| `src/main/ipc/*Handlers.ts` | Handler implementations (60+ modules) |
| `src/preload/ipcBridgeBuilder.ts` | Generic `makeDomainApi()` factory + TypeScript mapped types |
| `src/preload/ipcBridge.ts` | Domain API instantiations, type exports, legacy compat layer |
| `src/preload/index.ts` | Preload script — exposes domain APIs + legacy `api` via `contextBridge` |
| `cloud-service/src/mapHandlerRegistry.ts` | Cloud impl — plain `Map`, no Electron dependency |
| `scripts/validate-ipc.ts` | Validates contract schemas and checks for duplicate channels |

## Handler Domain Inventory

All handler modules in `src/main/ipc/`. Each exports a `register*Handlers(deps)` function.

| Handler File | Domain | Description |
|-------------|--------|-------------|
| `libraryHandlers.ts` | library | File system operations, spaces, symlinks, skills |
| `settingsHandlers.ts` | settings | App settings, MCP configuration, file dialogs |
| `appHandlers.ts` | app | Shell operations (open path, open URL, reveal in file manager) |
| `exportHandlers.ts` | export | PDF export, file save dialogs |
| `voiceHandlers.ts` | voice | Audio transcription, text-to-speech |
| `agentHandlers.ts` | agent | Agent turn execution and cancellation |
| `permissionsHandlers.ts` | permissions | OS permissions (microphone, file access) |
| `sessionsHandlers.ts` | sessions | Agent session persistence and restoration |
| `inboxHandlers.ts` | inbox | Inbox/tasks management, execution, archiving |
| `automationsHandlers.ts` | automations | Scheduled automation CRUD |
| `demoHandlers.ts` | demo | Demo mode entry/exit/status |
| `dashboardHandlers.ts` | dashboard | Contextual attention suggestions |
| `systemPromptHandlers.ts` | systemPrompt | System prompt preview |
| `searchHandlers.ts` | search | Full-text search across workspace |
| `systemHandlers.ts` | system | System diagnostics and health |
| `miscHandlers.ts` | misc | Analytics, Sentry, conversation titles, onboarding |
| `authHandlers.ts` | auth | Authentication and OAuth flows |
| `memoryHandlers.ts` | memory | Memory store operations |
| `scratchpadHandlers.ts` | scratchpad | Scratchpad document management |
| `googleWorkspaceHandlers.ts` | googleWorkspace | Google Workspace integration (Drive, Gmail) |
| `slackHandlers.ts` | slack | Slack integration |
| `hubspotHandlers.ts` | hubspot | HubSpot CRM integration |
| `discourseHandlers.ts` | discourse | Discourse integration |
| `githubHandlers.ts` | github | GitHub OAuth and integration |
| `salesforceHandlers.ts` | salesforce | Salesforce integration |
| `microsoftHandlers.ts` | microsoft | Microsoft 365 integration |
| `todoistHandlers.ts` | todoist | Todoist integration |
| `codexHandlers.ts` | codex | Codex operations |
| `claudeMaxHandlers.ts` | claudeMax | Claude Max subscription |
| `usageHandlers.ts` | usage | Usage tracking and time-saved metrics |
| `communityHandlers.ts` | community | Community features and highlights |
| `safetyHandlers.ts` | safety | Tool safety evaluation |
| `safetyPromptHandlers.ts` | safetyPrompt | Safety prompt CRUD |
| `safetyActivityLogHandlers.ts` | safetyActivityLog | Safety activity logging |
| `skillsHandlers.ts` | skills | Skill scanning and metadata |
| `feedbackHandlers.ts` | feedback | User feedback submission |
| `pluginHandlers.ts` | plugins | Plugin lifecycle and management |
| `bugReportHandlers.ts` | bugReport | Bug report creation and submission |
| `fileConversationHandlers.ts` | fileConversation | File-linked conversations |
| `userTasksHandlers.ts` | userTasks | User task management |
| `useCaseLibraryHandlers.ts` | useCaseLibrary | Use case library browsing |
| `calendarHandlers.ts` | calendar | Calendar integration |
| `errorRecoveryHandlers.ts` | errorRecovery | Error recovery flows |
| `meetingBotHandlers.ts` | meetingBot | Meeting bot management |
| `localSttHandlers.ts` | localStt | Local speech-to-text |
| `physicalRecordingHandlers.ts` | physicalRecording | Physical recording device management |
| `quickCaptureHandlers.ts` | quickCapture | Quick capture hotkey and workflow |
| `plaudHandlers.ts` | plaud | Plaud device integration |
| `mcpAppsHandlers.ts` | mcpApps | MCP app discovery and management |
| `versionHandlers.ts` | version | App version info |
| `cloudHandlers.ts` | cloud | Cloud provisioning, migration, sync |
| `inboundTriggerHandlers.ts` | inboundTriggers | Inbound trigger management |
| `systemImprovementHandlers.ts` | systemImprovement | System improvement suggestions |
| `heroChoiceHandlers.ts` | heroChoice | Hero/persona choice |
| `cloudIpcHandlers.ts` | *(barrel)* | Re-exports cloud-safe handlers for cloud-service |

Additionally, `src/main/ipc/plugins/` contains sub-modules for plugin lifecycle and write operations.

## Contract Domains

The `ipcContract` object in `src/shared/ipc/contracts.ts` groups channels by domain. Most domains map to a dedicated channel file in `src/shared/ipc/channels/`, though a few are defined inline in `contracts.ts` (e.g., `github`) or share a channel file (e.g., `quickCapture` channels live in `physicalRecording.ts`):

```
agent, app, auth, automations, bugReport, calendar, claudeMax, cloud,
cloudContinuity, codex, community, dashboard, demo, discourse, errorRecovery,
export, feedback, fileConversation, github, googleWorkspace, heroChoice,
hubspot, inboundTriggers, inbox, library, localStt, mcpApps, meetingBot,
memory, microsoft, misc, permissions, physicalRecording, plaud, plugins,
quickCapture, safety, safetyActivityLog, safetyPrompt, scratchpad, search,
sessions, settings, skillHistory, skills, slack, systemHealth, systemImprovement,
systemPrompt, todoist, usage, useCaseLibrary, userTasks, version, voice
```

## Adding a New IPC Channel

### 1. Define the contract

Create or update a channel file in `src/shared/ipc/channels/`:

```typescript
// src/shared/ipc/channels/myDomain.ts
import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

export const myDomainChannels = {
  'mydomain:my-action': defineInvokeChannel({
    channel: 'mydomain:my-action',
    request: z.object({ id: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Performs my action',
  }),
} as const;
```

Add the domain to `src/shared/ipc/channels/index.ts` (re-export) and to the `ipcContract` object in `src/shared/ipc/contracts.ts`.

### 2. Implement the handler

Create a handler file using `registerHandler()` (which delegates to `HandlerRegistry`):

```typescript
// src/main/ipc/myDomainHandlers.ts
import { registerHandler } from './utils/registerHandler';

export interface MyDomainDeps {
  // Inject dependencies rather than importing global state
}

export function registerMyDomainHandlers(deps: MyDomainDeps): void {
  registerHandler('mydomain:my-action', async (_event, request) => {
    // Implementation
    return { success: true };
  });
}
```

**Important**: Always use `registerHandler()` from `./utils/registerHandler`, never `ipcMain.handle()` directly. This ensures the handler works in both Electron and cloud contexts. (Note: some older handler files still use `ipcMain.handle()` directly -- this is tech debt being migrated.)

### 3. Register in main process

Export from `src/main/ipc/index.ts` and call the registration function from `src/main/index.ts`:

```typescript
registerMyDomainHandlers({ /* deps */ });
```

### 4. Add domain API to bridge (if new domain)

Add to `src/preload/ipcBridge.ts`:

```typescript
export const myDomainApi = makeDomainApi(ipcContract.myDomain);
export type MyDomainApi = typeof myDomainApi;
```

### 5. Expose in preload (if new domain)

For a new domain, add to `src/preload/index.ts`:

```typescript
import { myDomainApi } from './ipcBridge';
contextBridge.exposeInMainWorld('myDomainApi', myDomainApi);
```

### 6. Use in renderer

```typescript
const result = await window.myDomainApi.myAction({ id: '123' });
```

### Channel design guardrails

Recurring review questions for new or changed channels:

- **Discriminated-union payloads:** each variant's mandatory fields are enforced in the Zod schema at the contract boundary, not left to handler-side checks.
- **Bounded responses:** can the response grow without bound with project lifetime, user history, or persisted state? Say where the bound is enforced.
- **Typed domain API, not `window.api`:** renderer changes that add IPC calls must verify the method exists on the typed domain API exposed through preload — the raw `window.api` surface is deprecated.
- **`ipcRenderer.sendSync` from preload:** any such channel must register in the earliest main-process initialization block, with a cross-reference comment at the registration site pointing at the preload consumer.
- **Busy-window awaits:** a network-bound `await` inside a renderer-blocking busy window must be timeout-bounded with a `finally`-guaranteed reset, and every kill/forget control needs a network-free path that always succeeds.
- **Local-clear is not remote-success:** never treat a local success flag as proof that a remote or billing-bearing operation landed. Require positive remote confirmation (or positive re-discovery) before hiding a recovery or billing affordance, and surface persistent-failure warnings on the post-action UI surface.

## HandlerRegistry Pattern

The `HandlerRegistry` interface (`src/core/handlerRegistry.ts`) decouples handler registration from the transport layer:

```typescript
interface HandlerRegistry {
  register(channel: string, handler: IpcHandler): void;
  remove(channel: string): void;
  get(channel: string): IpcHandler | undefined;
}
```

Two implementations exist:

- **`ElectronHandlerRegistry`** (`src/main/ipc/utils/ElectronHandlerRegistry.ts`) — wraps `ipcMain.handle()` with cloud router logic (dual-write forwarding, cloud routing with local fallback)
- **`MapHandlerRegistry`** (`cloud-service/src/mapHandlerRegistry.ts`) — plain `Map` for the cloud service where no routing is needed

The registry is initialized at startup via `setHandlerRegistry()` and accessed via `getHandlerRegistry()`. All handler files use `registerHandler()` which delegates to the active registry.

## Cloud Channel Routing

`src/shared/cloudChannelPolicies.ts` defines which IPC channels interact with the cloud service:

- **Dual-write channels**: Run locally AND forward to cloud to keep cloud state in sync (e.g., `settings:update`, `inbox:add`, `automations:upsert`)
- **Transport types**: `'rest'` (dedicated HTTP route), `'ipc'` (generic `/api/ipc/:channel` endpoint), `'ws'` (WebSocket)
- **Local-only**: Channels not in the policy table run exclusively on the desktop

The `ElectronHandlerRegistry` reads these policies at runtime. On failure for non-agent channels, it falls back to local execution so the app remains usable.

Derived sets (`CLOUD_ROUTABLE_CHANNELS`, `DUAL_WRITE_CHANNELS`, `CLOUD_IPC_ALLOWLIST`) are computed from the single policy table — no hand-maintained duplicates.

## Push-Based Events

For main→renderer push events (not request/response), handlers use `BrowserWindow.webContents.send()` and the preload exposes `ipcRenderer.on` listeners. These are defined inline in `src/preload/index.ts` (e.g., `cloudApi.onMigrationProgress`, `safetyActivityLogSubscriptions.onSafetyActivityLogUpdated`).

Push events are defined inline in `src/preload/index.ts`, not derived from contracts.

## Validation

| Command | What it checks |
|---------|---------------|
| `npm run validate:ipc` | Validates contract schemas and checks for duplicate channel names |
| `npm run validate:ipc-handler-parity` | Every contract channel has a handler; every handler has a contract (**blocking error** for both directions) |
| `npm run validate:ipc-schema-strictness` | Ratchet on `z.any()` / `z.unknown()` usage in channel schemas |
| `npm run validate:fast` | Lint + all IPC validations + store versions + MCP bundles + more |

No code generation step is needed — domain APIs are derived from contracts at build time via the runtime builder.

### Enforcement

The parity validator (`scripts/check-ipc-handler-parity.ts`) treats handlers without contracts as a **blocking error** — not a warning. This means:

- You cannot register a handler via `registerHandler()` without first defining a contract in `src/shared/ipc/channels/*.ts`
- The only exception is the 3 fire-and-forget emergency channels (`app:emergency-*`) which intentionally bypass contracts for crash resilience
- `validate:fast` (run in CI and locally) will fail if contract/handler parity is broken

## Contract-Parse Seam (dev/test regression guard)

A dev/test-gated **contract-parse seam** (landed 260609–260610) enforces request/response IPC contracts *at the runtime chokepoints, by construction* — so a channel whose payload drifts from its Zod contract throws during the test suite, instead of relying on each handler to remember to validate. There are two seams, both fed by **one** shared gate.

**The shared gate — `isContractEnforcementOn()`** (`src/shared/ipc/contractEnforcement.ts`). Lives in `@shared` (pure `process.env`, no main/electron deps) so the invoke seam, the broadcast sink-seam, and the cloud-ingress parse all share **one** SSOT gate — the fail-safe-OFF property can't drift between the three parse points. It is **fail-safe-OFF and kill-by-construction**: it returns `true` only under `NODE_ENV==='test'`, or under `NODE_ENV==='development'` *with* an explicit `REBEL_CONTRACT_ENFORCE=1`/`true` opt-in. It requires a **positive** dev/test signal, never `!== 'production'` — packaged Electron leaves `NODE_ENV` unset, so a "not-production" gate would let `REBEL_CONTRACT_ENFORCE` flip enforcement ON in packaged prod. That makes prod enforcement *unrepresentable here* and closes the prod-enforce backdoor.

1. **Invoke seam** — at the `registerHandler` chokepoint. `wrapHandlerWithContractParse(channel, handler)` (`src/main/ipc/utils/registerContractHandler.ts`) wraps every handler registered through the single `registerHandler()` chokepoint (`src/main/ipc/utils/registerHandler.ts`) so that — only when the gate is on — it runs `channelDef.request.parse(args[0])` BEFORE the real body and `channelDef.response.parse(result)` AFTER it. When enforcement is off it returns the **same handler reference** (true no-op; zero per-invocation cost in prod). Channels absent from `allChannels` (sync/bypass/e2e) are returned unwrapped. The body is **never** skipped here. Because the gate is on under `NODE_ENV==='test'`, every handler invoked through `registerHandler` across the whole suite gets contract-parsed by construction. Supporting machinery:
   - **`EXECUTE_SAFE` allowlist** (in `registerContractHandler.ts`): a safe-by-construction read-only allowlist (currently `inbox:load`, `feedback:conversation-get`, `library:stat-file`) consumed by the harness DRIVER to decide which channels run their REAL body (genuine response-contract coverage) vs are stubbed (sample-and-parse). Allowlist-not-denylist: an unlisted channel is stubbed (safe), never side-effecting.
   - **Round-trip harness + channel enumeration + coverage guard**: the harness boots the 23 cloud-safe registrars, enumerates the registered invoke channels, and a **fail-loud coverage guard** (`coverageGuard.ts` + `harnessExemptions.ts`) fails if a cloud-safe channel becomes uncovered (pinned counts; the gap can't silently grow).
   - **`validate:fast` ratchet** against raw bypasses: `scripts/check-no-raw-ipc-invoke.ts` (wired into `validate:fast`) freezes the count of raw `ipcRenderer.invoke(...)` sites in `src/preload/**` that bypass the typed `makeDomainApi` bridge — those sites are `any`-typed and NOT covered by the seam, so the ratchet stops new ones being added.

2. **Broadcast / event seam** — for the one-way main→renderer push path. A **sink-seam** at `setBroadcastService`: `wrapBroadcastWithContractParse(service)` (`src/core/broadcastContractSeam.ts`) wraps the `BroadcastService.sendToAllWindows` chokepoint so that — only when the gate is on — each emit on a channel in `BROADCAST_SCHEMAS` is `schema.parse`d (validation only; the ORIGINAL args are forwarded, never Zod's key-stripped output). Plus a **cloud-ingress parse** at `dispatchToRenderer` (`src/main/services/cloud/cloudEventChannel.ts`), the single point where `as`-cast HTTP/WS JSON enters the broadcast bus — the actual analog of the 260405 memory-approval broadcast crash class. Honest scope: ~57 tests `vi.mock` the broadcast service so the sink-seam fires only for a few integration tests + dev (a guard against a *future* bypassing emitter); the cloud-ingress parse covers the cloud-replay surface separately.

**HONEST SCOPE — this is a dev/CI regression guard, NOT production enforcement.** Production-enforcement (the deferred "shape B") needs its own audit: Zod default-strips unknown keys and `.refine`/`.min` may reject real-world payloads, so an accidental prod-enforce would be a user-visible regression, plus a per-call parse perf cost on the hot IPC path. The seam ships gated OFF in packaged prod by construction.

**Signpost — full coverage split, the EXECUTE_SAFE extension recipe, and the "what it does NOT catch" detail live in the harness README:** [`src/main/ipc/__tests__/harness/README.md`](../../src/main/ipc/__tests__/harness/README.md). Canonical plan: `docs/plans/260609_ipc-inprocess-contract-harness/PLAN.md`.

## Using IPC APIs from Renderer Code

**Preferred — domain-specific APIs:**

```typescript
const files = await window.libraryApi.listFiles(request);
const settings = await window.settingsApi.get();
const status = await window.demoApi.status();
```

**Legacy — flat API (backward compatibility):**

```typescript
const files = await window.api.listWorkspaceFiles();
```

New code should always use the domain APIs. The legacy `window.api` object is preserved for existing code.
