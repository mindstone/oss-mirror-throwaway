---
description: "High-level system architecture, process boundaries, and key data flows across Rebel's desktop and cloud layers"
last_updated: "2026-05-24"
---

### Introduction

Mindstone Rebel is a voice-first, agentic desktop app (Electron) and cloud service powered by Rebel Core, Rebel's in-process agent runtime, designed to work against a user-selected "core" workspace with deep MCP tool integration. The codebase uses a **ports-and-adapters architecture**: platform-agnostic business logic lives in `src/core/` with boundary interfaces, while `src/main/` (Electron) and `cloud-service/` (cloud) provide platform-specific implementations.  
This document describes the high-level system architecture, major components and data flows, and how voice, text, agent sessions, MCP servers, and workspace files fit together.


### See also

- [De-electronification tutorial](../tutorials/260220_cloud_refactoring_de_electronification.html) - How the codebase was restructured into `src/core/` (platform-agnostic) + boundary interfaces for dual Electron/cloud deployment
- [ARCHITECTURE_AGENT_TURN_EXECUTION.md](ARCHITECTURE_AGENT_TURN_EXECUTION.md) - Main-process agent turn orchestration: lifecycle, prompt assembly, model routing, MCP resolution, tool safety hooks, and event dispatch
- [ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md](ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md) - Context overflow detection, automatic compaction, summary generation, and retry logic with circuit breaker
- [ARCHITECTURE_IPC.md](ARCHITECTURE_IPC.md) - IPC contract system, domain-organized handlers, typed contracts, and validation scripts
- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) - Renderer state architecture, session engine internals, and data flow patterns
- [SETUP_DEVELOPMENT_ENVIRONMENT.md](SETUP_DEVELOPMENT_ENVIRONMENT.md) - Development environment prerequisites, configuration (core directory, MCP, voice), and "it actually runs" checks
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) - Agent session model, history persistence, and context-resume behavior
- [ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY.md](ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY.md) - How conversation context is preserved or lost across turns, restarts, edits, fallbacks, and compaction
- [ARCHITECTURE_MESSAGE_QUEUE.md](ARCHITECTURE_MESSAGE_QUEUE.md) - Message queue and interrupt-mode design for sending messages while an agent turn is running
- [ARCHITECTURE_DATA_STRUCTURES.md](ARCHITECTURE_DATA_STRUCTURES.md) - Core TypeScript types, electron-store schemas, and on-disk format reference
- [SYSTEM_PROMPT.md](SYSTEM_PROMPT.md) - How the composite system prompt is constructed (platform context, user instructions, runtime context)
- [MCP_IMPROVEMENT_WORKFLOW.md](MCP_IMPROVEMENT_WORKFLOW.md) - **Start here for MCP development**: workflow for creating/improving MCPs, decision tree for choosing the right path
- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) - MCP and Super-MCP architecture: configuration, discovery, mode selection, bundled vs direct, auth patterns, IPC contracts, and troubleshooting
- [APP_BRIDGE.md](APP_BRIDGE.md) - Rebel App Bridge: localhost HTTP+WS surface that pairs companion apps (browser extension, Office sidecar) with the agent runtime
- [LOGGING.md](LOGGING.md) - Structured logging architecture, log destinations, and how to use logs while debugging
- [MODEL_AND_PROVIDER_OVERVIEW.md](MODEL_AND_PROVIDER_OVERVIEW.md) - hub for the model / provider / billing / thinking territory: how a model is chosen, routed, authed, billed, and given a thinking budget
- [CONTEXT_AND_PROVIDER_HIERARCHY.md](CONTEXT_AND_PROVIDER_HIERARCHY.md) - React context tree structure, available contexts, and patterns for adding new contexts (NB: this is the *React* context tree, **not** LLM providers — see MODEL_AND_PROVIDER_OVERVIEW for those)
- [HOOK_CONVENTIONS.md](HOOK_CONVENTIONS.md) - Hook naming conventions, dependency patterns, side-effect isolation, and common pitfalls
- [INBOX_PANEL.md](INBOX_PANEL.md) - Inbox architecture, data model, UI, execution flow, and MCP tools
- [ENTITY_LAYER.md](ENTITY_LAYER.md) - Entity layer: structured people/company metadata, entity resolution, meeting participant integration, and MCP query tools
- [ONBOARDING_SETUP_WIZARD.md](ONBOARDING_SETUP_WIZARD.md) - Onboarding wizard architecture, steps, and technical wiring
- [THE_SPARK.md](THE_SPARK.md) - Attention system architecture and The Spark feature (shared with contextual dashboard)
- [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) - Cloud deployment: platform abstraction layer, cloud service, routing, migration, and local/cloud split
- [INBOUND_AUTHOR_POLICY_RUNBOOK.md](INBOUND_AUTHOR_POLICY_RUNBOOK.md) - Operator runbook for Slack inbound author policy logs, gate decisions, and recovery workflows
- [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md](ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md) - Analytics architecture, identity model, event APIs, and privacy
- `../../README.md` – Project overview, build/run commands, and top‑level directory layout
- `../../AGENTS.md` – Guidance for AI agents working on this repo; highlights key files and development workflows
- `./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` – Canonical reference for app settings, configuration surfaces, and environment variables
- `./PRODUCT_VISION_FEATURES.md` – High‑level product vision and planned features to keep architecture decisions aligned with UX goals
- `../research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md` – Archived reference for the removed Claude Agent SDK (historical — SDK was removed April 2026)
- `../research/libraries/LANCEDB_REFERENCE.md` – LanceDB vector database reference: semantic search implementation details and version constraints
- `../research/libraries/MCP_SDK_REFERENCE.md` – MCP SDK TypeScript reference: protocol fundamentals, transport mechanisms, and how Rebel uses MCP for tool integration
- `../research/libraries/ZUSTAND_REFERENCE.md` – Zustand state management reference: patterns and conventions used in Rebel's renderer state
- `./REBEL_CORE.md` – Rebel Core native agent runtime: intent, architecture, and code signposting
- `../plans/finished/251114_context_loss_analysis.md` – Root‑cause analysis of historical context loss when resuming sessions from history
- `../plans/finished/251114_context_loss_fix.md` – Implementation notes for the session‑resume / upstream session ID lifecycle
- `./SUPERMCP_OVERVIEW.md` – Design and behavior of Super‑MCP HTTP mode and race‑condition mitigation
- [BUILD_AND_RELEASE_OVERVIEW](./BUILD_AND_RELEASE_OVERVIEW.md) – Hub for build/release docs, including Node/npm/npx bundling
- `./VOICE_AND_AUDIO.md` – End‑to‑end voice and audio pipeline (STT/TTS, permissions, playback) and provider behavior
- `./UI_OVERVIEW.md` – Overview of the main UI layout, interaction flows (voice vs text, queue vs interrupt, permissions banners), and design principles
- `../plans/finished/251115_distribution_strategy_exploration.md` – Notarisation, MDM distribution, and Mac App Store–specific packaging and deployment details
- `./LIBRARY_AND_FILE_ACCESS.md` – Canonical reference for workspace selection, file trees, file operations, and file‑access permissions
- `../../src/main/index.ts` – Electron main process, agent orchestration, MCP integration, and IPC handlers
- `../../src/preload/index.ts` – Preload bridge exposing a typed `window.api` surface to the renderer
- `../../src/renderer/App.tsx` – React UI orchestration; delegates to extracted components (SessionSurfaceContent, MeetingCompanionManager, SafeModeOrchestrator, etc.)
- `../../src/main/services/mcpService.ts` – MCP configuration resolution and Super‑MCP router wiring
- `../../src/main/services/superMcpHttpManager.ts` – Lifecycle manager for Super‑MCP in HTTP mode
- `../../src/main/services/audioService.ts` – Speech‑to‑text (STT) and text‑to‑speech (TTS) provider integration
- `../../src/main/services/fileTreeService.ts` – Workspace file tree construction
- `../../src/shared/types.ts` – Shared types for settings, sessions, events, file nodes, and discovery results

**User-facing architecture (spaces & workspace model)**:
- `../../rebel-system/help-for-humans/spaces.md` – Spaces architecture and workspace organisation for end users
- `../../rebel-system/help-for-humans/how-rebel-is-built.md` – Simplified user-facing architecture overview
- `../../rebel-system/help-for-humans/mcp-connectors-tools-and-integrations.md` – External integrations and MCP from a user perspective


### Principles, key decisions

- **Voice‑enabled, agent‑centric UX**: The app is optimized for voice input and text output, with text input as a first‑class alternative.
- **Strict process separation**: Electron main, preload, and renderer follow clear boundaries: main handles OS integration, MCP/process management, and persistence; renderer owns UI state and workflows; preload exposes a minimal, typed IPC surface.  
- **Session continuity & history**: Agent sessions are durable (persisted to disk) and can be reliably resumed via persisted conversation history, compaction metadata, and task/context restoration.  
- **Event‑driven, queue‑based runs**: All agent work is modeled as “turns”, with a message queue and explicit interrupt support to avoid race conditions and keep UX responsive.  
- **MCP‑first extensibility**: Tooling is designed around MCP with support for both direct and Super‑MCP router modes; HTTP mode is preferred for concurrency‑safe operation.  
- **Production‑ready execution environment**: A full Node.js + npm + npx bundle is shipped so MCP servers (including those launched via `npx`) work in production without relying on a system Node installation.  
- **Defensive error handling**: Main process uses robust logging, guarded message processing, and explicit handling for known race‑condition patterns.  
- **Minimal duplication in docs**: This document signposts to more detailed feature‑specific docs instead of repeating their full content.


### High‑level architecture

At a high level, Mindstone Rebel consists of five code layers and external systems:

- **Core Layer** (`src/core/`)  
  - **Platform-agnostic business logic** with zero imports from `electron`.  
  - Defines 6 boundary interfaces (ports-and-adapters pattern): `PlatformConfig`, `StoreFactory`, `HandlerRegistry`, `BroadcastService`, `ErrorReporter`, `Tracker`. Each platform wires its own implementations at bootstrap.  
  - `PlatformConfig.capabilities` (`SurfaceCapabilities`) is the typed feature manifest for host-surface conditional logic — feature code reads `getPlatformConfig().capabilities.<flag>` (e.g. `appBridgeServer`, `officeSidecar`, `localFilesystemAccess`, `localSubprocessSpawn`) instead of comparing `platformConfig.surface !== 'desktop'`. Defaults are derived from the surface via `defaultCapabilities(surface)`; explicit `setPlatformConfig({ capabilities })` overrides for tests. Cross-surface coupling drift is ratcheted by `scripts/check-cross-surface-imports.ts` (12 known `@main/*` import sites in `cloud-service/**` allowlisted, May 2026; wired into `validate:fast`). See `BOUNDARY_REGISTRY.md` entry `cross-surface-coupling`.
  - `HandlerInvokeContext` (in `@core/handlerRegistry`) is the neutral IPC-handler context type used by cloud-shared handlers in place of Electron's `IpcMainInvokeEvent`. Aliased as `HandlerInvokeEvent = HandlerInvokeContext | null` because the cloud router (`cloud-service/src/routes/ipc.ts:363`) invokes handlers with a literal `null` event; handlers null-guard via `event?.sender?.id ?? 'cloud-process'`.
  - Contains the structured logger, constants, data paths, and ~16 extracted services (prompt templates, connector catalog, concurrency limiter, tool alias cache, etc.).  
  - `src/core/services/inboundAuthorGates/` provides transport-agnostic inbound author admission gates (Slack first) used by cloud webhook routing; operational guidance: [INBOUND_AUTHOR_POLICY_RUNBOOK.md](INBOUND_AUTHOR_POLICY_RUNBOOK.md).  
  - Uses `@core` path alias. New services and utilities should go here by default.  
  - See [de-electronification tutorial](../tutorials/260220_cloud_refactoring_de_electronification.html) for full details on the boundary interfaces and migration.

- **Electron Main Process** (`src/main/index.ts`)  
  - Manages the application lifecycle, windows, and IPC.  
  - **Wires core boundary interfaces** at startup (`src/main/bootstrap.ts` + `src/main/index.ts`): `PlatformConfig` from Electron `app` API, `StoreFactory` wrapping `electron-store`, `ElectronHandlerRegistry` wrapping `ipcMain.handle()`, `BroadcastService` via `BrowserWindow`, `ErrorReporter` via Sentry.  
  - Orchestrates Rebel Core agent turns (`queryWithRuntime()` → `rebelCoreQuery()`) and MCP tool calls.  
  - Hosts genuinely desktop-only services: OAuth flows, voice recording, screenshots, auto-updater, system tray.  
  - Persists settings and session history via `@core/storeFactory` (backed by `electron-store`).

- **Cloud Service** (`cloud-service/src/`)  
  - Standalone Node.js HTTP server that reuses all core business logic.  
  - **Wires core boundary interfaces** at startup (`cloud-service/src/bootstrap.ts`): `PlatformConfig` from env vars, `StoreFactory` using JSON files, `MapHandlerRegistry` (plain `Map`), `cloudEventBroadcaster`, console/Sentry Node error reporter.  
  - Exposes REST API routes (`cloud-service/src/routes/`) that invoke the same handler functions as Electron IPC, just over HTTP.  
  - CI: `.github/workflows/cloud-ci.yml` builds and validates on PRs touching cloud paths.

- **Preload Script** (`src/preload/index.ts`)  
  - Runs in the renderer's isolated context and exposes a typed `window.api` bridge.  
  - Provides IPC methods for settings, sessions, agent turns, workspace operations, voice (STT/TTS), permissions, logging, and session-resume helpers.  
  - Relays unhandled errors and promise rejections from the renderer back to the main process logger.

- **Renderer (React UI)** (`src/renderer/App.tsx` and extracted components)  
  - App.tsx is the top-level orchestration file; heavy subsystems have been extracted to focused components (e.g. `SessionSurfaceContent`, `MeetingCompanionManager`, `OnboardingCoachOrchestrator`, `SafeModeOrchestrator`).  
  - Tracks UI-level agent session state (`messages`, `eventsByTurn`, `activeTurnId`, `isBusy`, `lastError`).  
  - Talks exclusively via `window.api` to invoke main process capabilities.

- **Shared Types & Utilities** (`src/shared`)  
  - Defines core contracts (`AppSettings`, `AgentSession`, `AgentEvent`, `FileNode`, MCP discovery types, etc.) used across processes.  
  - `cloudChannelPolicies.ts` — single source of truth for which IPC channels route to cloud, support dual-write, or stay local-only.  
  - Provides normalization utilities for settings and model selection.

- **External Systems**  
  - **Rebel Core** (`src/core/rebelCore/`) for running agent turns, tool loops, subagents, provider-specific model clients, and SDK-compatible event adaptation.  
  - **ModelClient abstraction** (`src/core/rebelCore/modelClient.ts`, `src/core/rebelCore/clientFactory.ts`) for Rebel Core model calls across Anthropic and OpenAI-compatible providers.  
  - **MCP servers** configured via local config files; all MCP traffic is routed through the Super-MCP HTTP layer by default (direct mode is a debug escape hatch only).  
  - **OpenAI and ElevenLabs APIs** for speech-to-text and text-to-speech.  
  - The user's **workspace filesystem**, accessed via IPC and constrained by a configured `coreDirectory` and permissions.


### Process boundaries and IPC

In this document, “IPC surface” refers to the public, typed set of methods and events exposed across the Electron process boundary (primarily the `window.api` bridge that wraps IPC).

**Main process responsibilities**

- Application lifecycle (`app.on('ready' | 'before-quit' | 'activate' | 'window-all-closed')`).  
- Creation and management of the single `BrowserWindow`.  
- Initializing and normalizing settings (`AppSettings`) via `@core/storeFactory` (backed by `electron-store`).  
- Managing persistent agent session history with schema versioning and migration.  
- Enforcing a global store version gate at startup to prevent cross-version data corruption (see `scripts/check-store-versions.ts` and `src/core/constants.ts` `ALL_STORE_VERSIONS`). When a mismatch is detected the app enters read-only mode.  
- Running agent turns (`executeAgentTurn`) via Rebel Core (`queryWithRuntime()` → `rebelCoreQuery()`) and routing `SDKMessage`-compatible events to the renderer.  
- Attaching MCP servers (direct or via Super‑MCP router) based on settings and environment.  
- Owning STT/TTS calls and streaming audio back to the renderer.  
- File tree, file read/write, and workspace item creation/rename/delete operations.  
- Permission checks for microphone and filesystem access.  
- Logging for both main and renderer through structured log events.

**Preload responsibilities**

- Wrap Electron `ipcRenderer` calls in a typed, ergonomic `api` surface:
  - Settings: `getSettings`, `updateSettings`, file pickers.  
  - Sessions: `loadAgentSessions`, `saveAgentSessions`.  
  - Agent turns: `startAgentTurn`, `stopTurn`, `onAgentEvent`.  
  - Voice: `transcribeAudio`, `textToSpeech`, `onTtsChunk`.  
  - Workspace: `listWorkspaceFiles`, `readWorkspaceFile`, `writeWorkspaceFile`, create/rename/delete nodes.  
  - Permissions: microphone and file‑access helpers.  
  - Logging: `logEvent`.
- Relay uncaught renderer errors and unhandled promise rejections as structured log events.

**Renderer responsibilities**

- Maintain UI and conversation state, render the main conversational view, sidebars (history and workspace), and settings dialogs.  
- Call `window.api` to interact with agent turns, workspace operations, voice services, and permissions.  
- Listen to `onAgentEvent` and update the current conversation snapshot accordingly.  
- Manage message queue and interrupt behavior on top of the underlying agent turn IPC.


### Agent sessions, events, and history

**Core data structures**

- `AgentSession` (`src/shared/types.ts`):
  - `messages`: flattened conversation messages (user, assistant, result).  
  - `eventsByTurn`: raw event streams keyed by `turnId`.  
  - `activeTurnId`, `isBusy`, `lastError`: session‑level execution state.  
  - Timestamps for creation and last update.

- `AgentEvent`:
  - `turn_started` – emitted at the beginning of a new agent turn with turn metadata.  
  - `status` – lifecycle/status messages (including context compaction notices and race‑condition warnings).  
  - `assistant` – assistant content chunks.  
  - `result` – final result text and usage metrics (tokens, cost).  
  - `tool` – human‑readable tool usage hints derived from SDK `tool_use` / `tool_result`.  
  - `error` – terminal errors.

**Event flow**

1. Renderer calls `startAgentTurn` via preload with a `prompt`, `sessionId`, and optional `resetConversation`.  
2. Main process generates a `turnId`, stores a mapping to the renderer session, and starts `executeAgentTurn`.  
3. `executeAgentTurn` assembles prompt/context from persisted session history when needed and calls `queryWithRuntime()` → `rebelCoreQuery()`.  
4. Rebel Core streams SDK‑compatible `SDKMessage` shapes via `agentMessageAdapter`, and `handleSdkMessage`:
   - Extracts tool hints and dispatches `tool` events.  
   - Emits `status`, `assistant`, and `result` events via `agent:event` IPC.  
5. Renderer’s `onAgentEvent` handler uses `updateConversationWithEvent` to:
   - Append assistant messages and results to `messages`.  
   - Maintain `eventsByTurn`, `activeTurnId`, `isBusy`, and `lastError`.  
6. Session snapshots (for history) are periodically persisted via `saveAgentSessions`; on load, they are restored into UI state.

**Context continuity**

- See `../plans/finished/251114_context_loss_analysis.md` and `../plans/finished/251114_context_loss_fix.md` for historical context.  
- Session continuity comes from persisted conversation history, disk-based history injection, compaction metadata, and task/context restoration.
- Safety rails: if history injection or restoration fails, conversations fall back gracefully to a fresh session context.

**Conversation titling**

- The renderer captures the first exchange of a run as a `ConversationTitleTranscriptEntry[]` and calls `window.api.generateConversationTitle` once a transcript is available.  
- `ipcMain.handle('conversation:generate-title')` delegates to `generateConversationTitle` (`src/core/services/conversationTitleService.ts`), which performs a short behind-the-scenes call via auth-aware BTS routing (`callBehindTheScenesWithAuth()`, 15 s timeout) — the router picks the appropriate provider based on the user’s credentials — constrained to 2–5 words, strips labels/code fences, and enforces a 48-character ceiling before persisting the name.  
- Missing API keys, timeouts, or invalid outputs resolve to `null`, so the UI gracefully keeps the prior title without blocking history updates.


### Message queue and interrupt behavior

The renderer implements a message queue on top of the agent‑turn IPC to support sending messages while a run is active:

- **Queue state** (managed by `useMessageQueue` hook, invoked from `App.tsx`):  
  - Maintains a FIFO queue of pending messages (ID, text, timestamp, mode).  
  - Tracks whether queue processing is currently active.  

- **Core queue functions** (see `../project/ARCHITECTURE_MESSAGE_QUEUE.md`):  
  - `handleUserMessage` – entry point from the UI, decides whether to send immediately, queue, or interrupt.  
  - `processMessage` – sends a single message as an agent turn while preserving the renderer session ID.  
  - `processNextInQueue` – picks the next message after a run completes.  

- **Modes**:
  - **Queue mode** (default while busy): message is appended to the queue; processed once the current turn finishes.  
  - **Interrupt mode**: stops the current turn (via `stopTurn` IPC) and places the new message at the front of the queue.  

- **Reactivity**:
  - A `useEffect` hook watches `isBusy` and triggers `processNextInQueue` when the agent becomes idle.  
  - Status and result events from main always determine when a turn is considered complete.

This queue is purely a renderer concern; the main process sees each queued message as a normal agent turn with a shared `sessionId`, relying on persisted conversation history for context continuity.


### Actions and history surface

Actions (formerly "Inbox") collects actionable items from connected tools (email, calendar, Slack/Teams, Linear, etc.) for user review and agent-assisted execution. Items can be added manually or via MCP tools, executed with context, and tracked in a bounded history.

For architecture, data model, UI, and MCP tools, see [INBOX_PANEL.md](./INBOX_PANEL.md). For user-facing guidance, see `../../rebel-system/help-for-humans/actions.md`.


### Entity layer (people and companies)

The entity layer provides structured knowledge about real-world people and companies across the user's workspace. Entities are regular topic files with standardized YAML frontmatter (`entity_type`, `canonical_name`, `emails`, etc.) and a lightweight metadata index (`entityMetadataStore.ts`) that enables structural queries like "all people at Acme" or "who haven't I talked to in 30 days?". The store follows the `sourceMetadataStore` pattern — lazy store, file watcher hooks, workspace-aware initialization. Entity resolution supports email-based exact match and fuzzy name matching. Meeting participant emails (`participantEmails`) from calendar sync enable derived interaction tracking.

For the full entity architecture, frontmatter schema, resolution mechanisms, and MCP tools, see [ENTITY_LAYER.md](./ENTITY_LAYER.md).


### Plugin extension system

Rebel supports user-facing plugins — React TSX components that add custom tabs to the app shell. Plugins render as full main-pane surfaces (via `FlowPanelsShell`), using the same surface system as built-in tabs like Library and Settings. Plugins are primarily AI-generated via the `rebel_plugins_create` MCP tool: the agent sends TSX source to the renderer via IPC, where it's compiled (Sucrase), validated (AST checks), loaded (`new Function()`), and rendered in the React tree. Plugins import from a curated API (`@rebel/plugin-api` for data hooks, `@rebel/plugin-ui` for themed components) resolved via a global module registry. Plugin state persists across restarts via electron-store.

Currently in trusted mode (no sandboxing). Iframe isolation planned for third-party plugin support.

For the full plugin architecture, file structure, API surface, security model, and future stages, see [PLUGINS_OVERVIEW](./PLUGINS_OVERVIEW.md) and its sub-docs ([API Reference](./PLUGINS_API_REFERENCE.md), [Security](./PLUGINS_SECURITY.md), [Architecture](./PLUGINS_ARCHITECTURE.md)). For design decisions and review history, see [the planning doc](../plans/260322_plugin_extension_system.md).


### Contextual dashboard and attention surfaces

> **Note**: This feature is fully implemented but currently dormant (the trigger to show it is not wired up). The infrastructure works but users do not see it automatically.

The contextual dashboard ("ContextualReveal") displays personalized attention cards pulled from connected tools, each with a pre-built prompt the user can launch. It shares attention-suggestion plumbing with The Spark feature.

For the attention system architecture and The Spark, see [THE_SPARK.md](./THE_SPARK.md). The remaining attention plumbing is signposted from `src/main/ipc/dashboardHandlers.ts` and the renderer's `src/renderer/features/usecases/` surface.


### Onboarding, permissions, and audio intro flows

The onboarding wizard guides new users through workspace selection and MCP configuration. Permission surfaces handle microphone and file-access requests with "open System Settings" affordances.

For detailed onboarding architecture, wizard steps, and technical wiring, see [ONBOARDING_SETUP_WIZARD.md](./ONBOARDING_SETUP_WIZARD.md). For testing/reset procedures, see [RESET_ONBOARDING.md](./RESET_ONBOARDING.md).


### MCP integration and Super‑MCP HTTP mode

**MCP configuration resolution**

- `mcpService.ts` is responsible for:
  - Discovering candidate MCP config files (`scanForMcpConfigs`) in well‑known locations (Claude, Cursor, Super‑MCP, project‑local).  
  - Resolving the configured MCP JSON file path from `AppSettings.mcpConfigFile`.  
  - Parsing many possible MCP configuration shapes and normalizing them into standardized `mcpServers` entries.  
  - Dynamically deciding whether to use:
    - **Super‑MCP mode** – attach a single HTTP-based Super‑MCP router server (the default when an MCP config file is present); or  
    - **Direct mode** – attach each MCP server directly to the runtime (debug/escape‑hatch only via Diagnostics → “Force direct MCP” or `MINDSTONE_FORCE_DIRECT_MCP`).

**Super‑MCP router resolution**

- When `shouldUseSuperMcpRouter` returns `true`, `resolveMcpServers`:
  - Uses `resolveSuperMcpRouterEntry` to attach a single HTTP router entry backed by `superMcpHttpManager.getHttpConfig()` (`{ type: 'http', url }`).  
  - The router HTTP server is configured and started by `systemHealthService.startSuperMcpWithRetries()`, which selects a port, spawns the bundled Super‑MCP CLI, and performs TCP health checks before marking it ready.

**HTTP mode architecture**

- See `../project/SUPERMCP_OVERVIEW.md` for full details.  
- Key points:
  - Super‑MCP is always used over HTTP in Rebel; there is no stdio transport path for the router itself. An optional `SUPER_MCP_HTTP_PORT` hint and `getDefaultSuperMcpPort()` control the preferred port range by build channel.  
  - On `app.on('ready')`, the main process:
    - Configures `superMcpHttpManager` with a port, config path, startup timeout, and health‑check interval.  
    - Starts the Super‑MCP HTTP server via the bundled `super-mcp` CLI (see `superMcpHttpManager.ts` for spawning details).  
    - Polls via TCP to confirm readiness before marking the server as running.  
  - `resolveMcpServers` then uses the HTTP router entry so all MCP tools share a single HTTP endpoint instead of an stdio pipe. Direct MCP mode is available only when explicitly forced (see `MCP_ARCHITECTURE.md` for the selection rules).

**Race‑condition detection and mitigation**

- When processing SDK messages in `handleSdkMessage` and in the agent‑turn loop:
  - MCP tool usage is monitored for concurrency via the `activeTurnControllers` map.  
  - “Stream closed” errors are detected and logged with additional context (active turns, MCP mode, GitHub issue reference).  
  - Renderer receives a `status` warning when potential race conditions are observed, with pointers to relevant troubleshooting docs.  
- Using the Super‑MCP HTTP router (the default) plus an extended `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` is the primary mitigation for concurrent MCP usage.


### Audio pipeline (speech recognition and text-to-speech)

The voice pipeline handles speech-to-text (STT) and text-to-speech (TTS) through configurable providers (OpenAI Whisper, ElevenLabs Scribe for STT; OpenAI TTS, ElevenLabs for TTS). The main process owns provider calls; the renderer streams audio via IPC.

For the complete voice architecture, provider details, permissions, and troubleshooting, see [VOICE_AND_AUDIO.md](./VOICE_AND_AUDIO.md). For local STT using Parakeet or Moonshine, see [VOICE_AND_AUDIO_LOCAL.md](./VOICE_AND_AUDIO_LOCAL.md).


### Workspace integration and file operations

Mindstone Rebel can treat a user‑selected directory as the “core workspace” for the agent:

- **Configuration**
  - `AppSettings.coreDirectory` is selected via a directory picker (`settings:choose-directory`).  
  - Most workspace operations require this to be set; otherwise handlers throw descriptive errors back to the renderer.

- **File tree building** (`fileTreeService.ts`)
  - `buildFileTree(root, directory, depth, includeHidden, visited)` builds a pruned tree of `FileNode`s:  
    - Respects `MAX_FILE_DEPTH` and `MAX_CHILDREN_PER_DIRECTORY`.  
    - Skips hidden files (unless `includeHidden` is `true`) and `node_modules`.  
    - Guards against symlink cycles via a `visited` set and realpath checks.  
  - Exposed via `library:list-files` IPC and surfaced in the UI’s workspace sidebar.

- **File operations**
  - `library:read-file` – read a single file’s text contents.  
  - `library:write-file` – write updated content, returning updated `mtime`.  
  - `library:create-file` / `library:create-folder` – create new nodes under a parent path or workspace root.  
  - `library:rename-item` – rename files/folders with checks to prevent collisions and path escapes.  
  - `library:delete-item` – delete files or recursively delete folders.  
  - All operations enforce that targets live under the resolved `coreDirectory` root.

For detailed behavior, safety rules, and permission handling, see `./LIBRARY_AND_FILE_ACCESS.md`.

These capabilities allow the agent to coordinate with the user as they browse and edit workspace files, while the MCP layer provides additional tool‑side capabilities (e.g., Git, HTTP, external systems).


### Settings, persistence, and environment

For a complete reference to settings, configuration surfaces, and environment variables, see `./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md`.  
This section summarizes how those pieces fit into the overall architecture:

- **App settings**: Persisted via `@core/storeFactory` (backed by `electron-store` on desktop, JSON files in cloud) under `app-settings` and normalized at startup to migrate schemas, provide sensible defaults, and keep provider/model settings coherent across runs.  
- **Session history**: Stored in a separate `electron-store` (`agent-session-history`) with explicit versioning and bounded size; see `./ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md` for the full model and lifecycle.  
- **Actions** (formerly Inbox): The Actions feature lives in its own `electron-store` (`inbox`), which keeps pending `InboxItem`s plus a capped `history` array so executions and provenance survive app restarts.  
- **Runtime config & analytics identity**: `config/app-config.json` is generated at runtime by `scripts/generate-runtime-config.mjs` from `config/app-config.template.json` (with environment-variable overrides feeding `runtimeConfig.ts`), while the lightweight `analytics-storage` store remembers the anonymous Rudderstack ID used for telemetry.  
- **Execution environment**: In development the app uses system Node, while production builds ship a bundled Node/npm/npx runtime so MCP servers and Super‑MCP work without requiring a system Node; see [BUILDING](./BUILDING.md) for details.


### Analytics and runtime configuration

Analytics uses RudderStack for behavioral events (main and renderer) with a stable anonymous ID persisted in `analytics-storage`. Runtime configuration is loaded from the generated `config/app-config.json` (produced by `scripts/generate-runtime-config.mjs` from `config/app-config.template.json`) plus environment overrides.

For the complete analytics architecture, identity model, event APIs, and troubleshooting, see [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md](./ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md). For error telemetry, see [ERROR_MONITORING_AND_SENTRY.md](./ERROR_MONITORING_AND_SENTRY.md).


### Distribution and platforms

- Distribution details are in [DISTRIBUTION](./DISTRIBUTION.md). Key points:
  - Builds target macOS using `electron-builder` (`npm run dist` / `npm run package`).  
  - A DMG is produced for installation; app is Developer ID‑signed but not notarized due to upstream native dependencies.  
  - Windows is supported; Linux is in beta.  
  - Build outputs:
    - `dist/` – compiled/app code.  
    - `out/` – intermediate electron‑vite artifacts.  
    - `release/` – distributable artifacts.


### Appendix

- **Key environment variables** – See `./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md#environment-variables` for the canonical list and explanations.  

- **Helpful mental model**
  - Think of the renderer as owning **“what the user sees and intends”** (messages, queue, history),  
    the main process as **“the executor and gatekeeper”** (turn orchestration, MCP/tool usage, filesystem, permissions),  
    and Super‑MCP + external APIs as **“the extended set of tools”** the agent can call into.  
  - Shared types define the contract between these layers, and environment variables and settings decide which integrations are active at runtime.


