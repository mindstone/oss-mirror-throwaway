---
description: "Overview of Rebel's core shared data structures, persisted formats, and key type signposts."
last_updated: "2026-04-10"
---

# Data Structures and File Formats

Overview of the core data structures used by Mindstone Rebel, focusing on what each type represents and how it's used across process boundaries.

**Scope**: This doc describes the *shape and purpose* of key types. For *where data lives on disk*, see [ELECTRON_STORAGE_REFERENCE.md](./ELECTRON_STORAGE_REFERENCE.md).

## See also

- [ELECTRON_STORAGE_REFERENCE.md](./ELECTRON_STORAGE_REFERENCE.md) - File paths and directory layout in userData
- [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) - How these structures flow through main/preload/renderer
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](./ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) - Deep dive on session lifecycle
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - Settings schema details
- [MCP_ARCHITECTURE.md](./MCP_ARCHITECTURE.md) - MCP config file formats
- [VOICE_AND_AUDIO.md](./VOICE_AND_AUDIO.md) - Audio payloads and provider behavior
- [MIGRATIONS.md](./MIGRATIONS.md) - How persisted data evolves
- `src/shared/types.ts` - **Canonical source** for all shared types

---

## Principles

- **Signpost, don't duplicate**: Type definitions live in code. This doc explains purpose and relationships.
- **Source of truth**: `src/shared/types.ts` is canonical for types crossing process boundaries.
- **Three categories**: Persistent (electron-store), IPC payloads, and renderer-only helpers.

---

## Application Settings

**Source**: `src/shared/types.ts` → `AppSettings` interface  
**Persisted**: Yes, in `app-settings.json`  
**Store name**: `'app-settings'`

The main configuration object containing:
- **Core paths**: `coreDirectory`, `mcpConfigFile`
- **Provider settings**: `voice`, `claude` (API keys, models, modes)
- **Feature flags**: `experimental`, `memoryUpdateEnabled`, `indexingEnabled`
- **OAuth integrations**: `googleWorkspace`, `hubspot`, `salesforce`, `gamma`
- **Spaces config**: `spaces[]` with type, paths, and sharing settings
- **Safety settings**: `toolSafetyLevel`, `spaceSafetyLevels` (per-space memory safety), `trustedTools[]`
- **Personalization**: `personalizedUseCases[]`, `theme`, `companyName`
- **Onboarding state**: `onboardingCompleted`, `onboardingFirstCompletedAt`, `onboardingChecklist`

Sub-interfaces: `VoiceSettings`, `ClaudeSettings`, `DiagnosticsSettings`, `SpaceConfig`, `ExperimentalSettings`, etc.

**Key consumers**:
- Main process: `src/main/settingsStore.ts` loads/saves, `src/shared/utils/settingsUtils.ts` normalizes
- Renderer: Accessed via `settingsApi` from preload bridge
- IPC: `settings:get`, `settings:update` channels

---

## Agent Sessions and Events

**Source**: `src/shared/types/agent.ts` → `AgentSession`, `AgentEvent`, `AgentTurnMessage`  
**Persisted**: Yes, in `sessions/` directory (file-per-session architecture)  
**Implementation**: `src/main/services/incrementalSessionStore.ts`  
**Zod schemas**: `src/shared/ipc/schemas/agent.ts` — compile-time type alignment enforced by `zodTypeAlignment.test.ts`

Storage format:
- `sessions/index.json` - Lightweight index with `AgentSessionSummary` entries
- `sessions/<sessionId>.json` - Individual session files with full data

### AgentSession

Represents a conversation with:
- Identity: `id`, `title`, `createdAt`, `updatedAt`
- Messages: `messages[]` (flattened for display)
- Events by turn: `eventsByTurn` (raw events for replay/debugging)
- State: `activeTurnId`, `isBusy`, `lastError`, `isCorrupted`
- Context: `origin`, `automationId`, `automationRunId`
- Lifecycle: `resolvedAt`, `doneAt` (non-null = Done; renamed from `pinnedAt` with inverted polarity), `starredAt`, `deletedAt`
- Session overrides: `privateMode`, `sessionWorkingModel`, `sessionThinkingModel`, `sessionWorkingProfileId`, `sessionThinkingProfileId`, `sessionThinkingEffort`
- Resilience: `interruptedTurnId`, `draft`, `compactionBoundaries`, `toolDetailArchive`
- Side-effects by turn: `memoryUpdateStatusByTurn`, `timeSavedStatusByTurn`
- Meeting companion: `meetingCompanion` (meeting URL, bot, coach config)

### AgentEvent (discriminated union — 19 variants)

Streamed from main to renderer during turns:
- `turn_started` - Turn lifecycle start signal. Emitted by `executeAgentTurn()` immediately after `setRendererSession()`, before any model/MCP work. Lets the renderer set `isBusy`/`activeTurnId` for ALL turns generically (including server-started continuations). Compaction policy: `drop`. See `docs/plans/260409_turn_started_event_broadcast.md`.
- `status` - Progress messages ("Thinking...", "Using tool...")
- `assistant` - Partial response text (streaming)
- `assistant_delta` - Incremental text delta (streaming)
- `thinking_delta` - Thinking/reasoning text delta
- `tool` - Tool invocation with `stage: 'start' | 'end'`, optional `imageContent` and `mcpAppUiMeta`
- `result` - Final response with `usage` (tokens, cost, `contextUtilization`), `toolMetrics`, `subAgentMetrics`, `fallbacks`
- `error` - Turn failure with `errorKind`, `rateLimitMeta`, `provider`
- `context_overflow` - Overflow detected with `originalPrompt`
- `compaction_started` - Recovery begins with `depth`, `sessionId`
- `compaction_summary_ready` - Summary generated
- `compaction_retrying` - About to retry
- `compaction_completed` - Recovery succeeded
- `compaction_failed` - Recovery failed with `error`, `depth`
- `turn_superseded` - Turn replaced by newer turn
- `user_message` - Injected system message (e.g., proactive coaching)
- `warning` - Non-blocking inline warning (e.g., MCP tools unavailable)
- `user_question` - Structured questions from agent (AskUserQuestion tool)
- `user_question_answered` - User's answers to structured questions

### AgentTurnMessage

Collapsed representation for UI:
- `id`, `turnId`, `role` ('user' | 'assistant' | 'result')
- `text`, `usage`, `createdAt`
- `attachments[]` (metadata only, not content)

### AgentTurnRequest (IPC payload)

Sent from renderer to start a turn:
- `prompt`, `sessionId`
- `resetConversation` (for context overflow recovery)
- `attachments[]` (includes file content)
- `imageAttachments[]`, `documentAttachments[]`

**See**: [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](./ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) for lifecycle details.

---

## Workspace and Files

**Source**: `src/shared/types.ts` → `FileNode`, `AgentAttachmentMeta`, `AgentAttachmentPayload`

### FileNode

Tree structure returned by `library:list-files`:
```ts
{ name: string; path: string; kind: 'file' | 'directory'; children?: FileNode[] }
```

### Attachments

- `AgentAttachmentMeta` - File reference (id, name, path, relativePath, size)
- `AgentAttachmentPayload` - Meta + `content` (base64 or text)
- `ImageAttachmentPayload` - Image with `base64Data`, `mediaType`
- `DocumentAttachmentPayload` - PDF/Office docs with extracted text

**Renderer helpers** (not persisted):
- `FlatFileEntry` - Flattened tree for fuzzy search (`src/renderer/utils/librarySearch.tsx`)
- `FileOperation` - Derived from tool events (`src/renderer/utils/fileOperations.ts`)

**See**: [LIBRARY_AND_FILE_ACCESS.md](./LIBRARY_AND_FILE_ACCESS.md) for path safety rules.

---

## MCP Configuration

**Source**: `src/shared/types.ts` → `McpConfigSummary`, `McpServerPreview`, `DiscoveredMcpConfig`

### Discovery types

- `DiscoveredMcpConfig` - Found config file with path, source, serverCount, validity

### Runtime types

- `McpConfigSummary` - Active config state: `status`, `mode`, `servers[]`, `router`
- `McpServerPreview` - Server entry: `name`, `transport`, `command`, `url`, `envKeys`
- `McpServerUpsertPayload` - For adding/editing servers via UI
- `McpConfigMutationResult` - Result with updated summary and backup path

### Connector types

- `ConnectorCatalogEntry` - Catalog entry for available connectors
- `KlavisVerificationConfig` - OAuth verification config
- `BundledMcpConfig` - Config for bundled MCP servers (inbox bridge, diagnostics)

**See**: [MCP_ARCHITECTURE.md](./MCP_ARCHITECTURE.md) for file formats, [SUPERMCP_OVERVIEW.md](./SUPERMCP_OVERVIEW.md) for HTTP mode.

---

## Inbox and Automations

### Inbox

**Source**: `src/shared/types.ts` → `InboxState`, `InboxItem`, `InboxHistoryEntry`  
**Persisted**: Yes, in `inbox.json`

- `InboxItem` - Task with `title`, `text`, `references[]`, `source`, `actions[]`
- `InboxHistoryEntry` - Executed item with `executedAt`, `sessionId`, `mode`
- `InboxState` - Versioned store with `items[]` and `history[]`

### Automations

**Source**: `src/shared/types.ts` → `AutomationStoreState`, `AutomationDefinition`, `AutomationRun`  
**Persisted**: Yes, in `automations.json`

- `AutomationDefinition` - Config with `schedule`, `filePath`, `enabled`, `runOnLaunch`
- `AutomationSchedule` - Union: hourly, daily, every_n_days, weekly, monthly
- `AutomationRun` - Execution record with `status`, `trigger`, `sessionId`, `error`

**See**: [AUTOMATIONS.md](./AUTOMATIONS.md), [INBOX_PANEL.md](./INBOX_PANEL.md).

---

## Memory and Learning

### Memory updates

**Source**: `src/shared/types.ts` → `MemoryUpdateStatus`, `MemoryHistoryEntry`, `MemorySpaceStats`  
**Persisted**: `memory-history.json`

Tracks writes to memory spaces:
- `MemoryHistoryEntry` - Path, timestamp, operation type, content preview
- `MemorySpaceStats` - Per-space aggregates

### Time saved

**Source**: `src/shared/types.ts` → `TimeSavedEstimate`, `TimeSavedAggregates`  
**Persisted**: `time-saved.json`

Estimates of time saved per session:
- `TimeSavedEstimate` - Minutes, confidence, task type, rationale
- Aggregates: weekly totals, trends, milestones

### Session coaching

**Source**: `src/shared/types.ts` → `SessionCoachingEvaluation`, `SessionCoachingInsight`  
**Persisted**: `session-coaching.json`

AI-generated insights from completed sessions:
- Categories: `workflow_optimization`, `skill_building`, etc.
- State tracking: `pending`, `shown`, `acted`, `dismissed`

---

## Voice and Audio

**Source**: `src/shared/types.ts` → `VoiceTranscriptionPayload`, `TtsWithTimestampsResponse`

### STT (Speech-to-Text)

- `VoiceTranscriptionPayload` - `audio: ArrayBuffer`, `mimeType: string`
- Returns plain text transcription

### TTS (Text-to-Speech)

- `TtsWithTimestampsResponse` - Audio buffer with `alignments[]` for word timing
- `TtsAlignment` - Word timing: `word`, `startMs`, `endMs`

**See**: [VOICE_AND_AUDIO.md](./VOICE_AND_AUDIO.md) for provider details.

---

## Logging and Diagnostics

**Source**: `src/shared/types.ts` → `RendererLogPayload`, `BreadcrumbEntry`, `LogLevel`

Structured logging from renderer to main:
- `LogLevel` - 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
- `RendererLogPayload` - Message with context, error details, breadcrumbs, turn/session IDs
- `BreadcrumbEntry` - Timestamped event for debugging

**See**: [LOGGING.md](./LOGGING.md) for architecture, [DIAGNOSTICS.md](./DIAGNOSTICS.md) for health checks.

---

## IPC Contracts

**Source**: `src/shared/ipc/contracts.ts`

All IPC channels are defined with Zod schemas for type-safe communication:
- 64+ channels across domains (agent, settings, workspace, mcp, voice, etc.)
- Request/response types generated to `src/preload/generated/ipcBridge.ts`

**Commands**:
- `npm run validate:ipc` - Validate contract schemas and check for duplicates

**See**: [ARCHITECTURE_IPC.md](./ARCHITECTURE_IPC.md) for details.

---

## Example: Simplified JSON Structures

### Session history entry

```json
{
  "id": "sess_2025_01_01",
  "title": "Code review",
  "messages": [
    { "id": "m1", "turnId": "t1", "role": "user", "text": "Review this PR" },
    { "id": "m2", "turnId": "t1", "role": "assistant", "text": "I'll analyze..." }
  ],
  "eventsByTurn": { "t1": [/* AgentEvent[] */] },
}
```

### Inbox item

```json
{
  "id": "inbox_1",
  "title": "Follow up on meeting",
  "text": "Send summary to team",
  "references": [{ "kind": "workspace", "path": "notes/meeting.md" }],
  "addedAt": 1732271000000
}
```

### Automation definition

```json
{
  "id": "auto_daily",
  "name": "Daily standup",
  "schedule": { "type": "weekly", "daysOfWeek": [1,2,3,4,5], "time": "09:00" },
  "filePath": "automations/standup.md",
  "enabled": true
}
```

---

## Maintenance Guidelines

1. **Don't duplicate types here** - Link to `src/shared/types.ts` as the source of truth
2. **Update when adding domains** - New stores or major type groups should get a section
3. **Keep examples minimal** - Show structure, not every field
4. **Cross-reference** - Link to feature docs for behavioral details
5. **Run `npm run validate:ipc`** after changing IPC contracts to verify schemas
