---
description: "Reference for Electron userData storage — platform locations, store files, session/transcript directories, logs, MCP config, and caches"
last_updated: "2026-06-18"
---

# Electron Storage Reference

Comprehensive reference for all files and directories created by Mindstone Rebel in the Electron `userData` directory.

> **Authority note.** This doc is orientation, not the canonical store list — it can lag the code. For any decision that must be exhaustive (e.g. what to copy vs exclude when migrating between machines), the source of truth is the CI-enforced migration **classification SSOT** in `src/core/services/migration/migrationClassification.ts` (every `ALL_STORE_VERSIONS` key + live store call-site must carry a verdict, or `validate:migration-classification` fails). Treat this reference as a human-readable companion to that gate.

## See also

- [ARCHITECTURE_DATA_STRUCTURES.md](./ARCHITECTURE_DATA_STRUCTURES.md) - TypeScript type definitions for persisted structures
- [MIGRATIONS.md](./MIGRATIONS.md) - Migration patterns for evolving persisted data
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - AppSettings schema details
- [LOGGING.md](./LOGGING.md) - Logging architecture and log file details
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](./ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) - Session history format
- [AUTOMATIONS.md](./AUTOMATIONS.md) - Automation store details
- [INBOX_PANEL.md](./INBOX_PANEL.md) - Inbox store structure
- [MCP_ARCHITECTURE.md](./MCP_ARCHITECTURE.md) - MCP configuration file formats
- [rebel-system/help-for-humans/where-rebel-stores-things.md](../../rebel-system/help-for-humans/where-rebel-stores-things.md) - User-facing storage summary
- [MOVING_REBEL_BETWEEN_COMPUTERS.md](./MOVING_REBEL_BETWEEN_COMPUTERS.md) - Transferring Rebel data to a new machine, relocating the workspace

---

## Platform Locations

The `userData` directory is managed by Electron and varies by platform:

| Platform | Path |
|----------|------|
| **macOS** | `~/Library/Application Support/mindstone-rebel/` |
| **Windows** | `%APPDATA%\mindstone-rebel\` |
| **Linux** | `$XDG_CONFIG_HOME/mindstone-rebel/` or `~/.config/mindstone-rebel/` |

> **Dev mode note**: In development (`!app.isPackaged`), Electron uses `Electron` as the app name. The module `src/main/startup/ensureAppIdentity.ts` must be imported first to set the correct name before any electron-store initialization.

---

## Directory Structure Overview

```
mindstone-rebel/
├── app-settings.json           # Main application settings
├── sessions/                   # Session history (file-per-session)
│   ├── index.json              # Lightweight session index with summaries
│   └── <sessionId>.json        # Individual session files
├── agent-session-history.json  # Legacy (migrated to sessions/ on first load)
├── inbox.json                  # Task inbox
├── automations.json            # Automation definitions and runs
├── analytics-storage.json      # Anonymous analytics ID
├── auth-tokens.json            # Encrypted authentication tokens
├── time-saved.json             # Time tracking estimates
├── memory-history.json         # Memory space write history
├── spaces-synthesis.json       # Spaces synthesis cache
├── tool-usage.json             # MCP tool usage tracking
├── pending-tool-approvals.json # Tool + memory safety pending requests
├── session-coaching.json       # Coaching evaluation state
├── community-highlights.json   # Discourse community cache
├── rebel-system-version.json   # Bundled system version
├── cost-ledger.jsonl           # API cost tracking (JSONL)
├── transcripts/                # Full-fidelity JSONL conversation transcripts (14-day TTL)
│   └── <sessionId>.jsonl       # Per-session transcript with complete tool I/O
├── logs/
│   ├── mindstone-rebel.log     # Main rotating log file
│   └── sessions/               # Per-turn session logs
│       └── <sessionId>_<turnId>.log
├── mcp/
│   ├── super-mcp-router.json   # Default router config
│   ├── super-mcp-<port>.pid    # Super-MCP process ID (ephemeral)
│   ├── klavis.json             # Klavis connector config
│   └── rebel-inbox-bridge.json # Rebel bridge state
├── backups/                    # Migration backup files
├── models/
│   └── transformers/           # Embedding model cache
├── indices/
│   └── <workspace-hash>/       # LanceDB search indices
├── google-workspace-mcp/       # Google OAuth + credentials
├── microsoft-mcp/              # Microsoft OAuth + credentials
├── salesforce-mcp/             # Salesforce OAuth + credentials
├── hubspot-mcp/                # HubSpot OAuth + credentials
└── slack-mcp/                  # Slack OAuth + workspaces
```

> **Out of scope:** This doc covers files written by Mindstone Rebel. Electron/Chromium-managed caches (`GPUCache/`, `Crashpad/`, etc.) are not documented here.

---

## Core electron-store Files

All JSON files below are managed via `electron-store` with atomic writes and automatic JSON serialization.

### `app-settings.json`

**Store name:** `'app-settings'`  
**Source:** `src/main/settingsStore.ts`  
**Type:** `AppSettings`

Main application configuration including:
- `coreDirectory` - Workspace root path
- `voice` - Voice provider settings (API keys, model, TTS voice)
- `claude` - Claude API settings (key, model, permission mode)
- `diagnostics` - Debug breadcrumb settings
- `onboardingCompleted`, `onboardingFirstCompletedAt`
- Many more fields (see `src/shared/types.ts`)

**Migrations:** One-time startup migrations in `src/main/index.ts`

---

### `sessions/` directory (session history)

> **Reading a specific conversation**: For step-by-step retrieval from a `rebel://conversation/{id}` link, see [READ_REBEL_CONVERSATION.md](READ_REBEL_CONVERSATION.md).

**Source:** `src/core/services/incrementalSessionStore.ts` (re-exported from `src/main/services/incrementalSessionStore.ts`)  
**Type:** Index is `SessionIndex`, individual files are `AgentSession`

File-per-session architecture for efficient incremental saves:

- **`sessions/index.json`** - Lightweight index (version 2) with `AgentSessionSummary` entries:
  - Session metadata (id, title, timestamps, origin, doneAt, starredAt, deletedAt) — `doneAt` non-null = Done (renamed from `pinnedAt`, inverted polarity)
  - Preview text snippets for sidebar display
  - Usage stats (costUsd, inputTokens, outputTokens, turnCount, messageCount)
  - Fingerprint for dirty tracking

- **`sessions/<sessionId>.json`** - Full session data:
  - Messages array with turn grouping
  - Events by turn for replay
  - Upstream Claude session ID for resume

- **`sessions-locks/index.lock`** — global index file lock (see `sessionFileLock.ts`); paired with in-process serialization below.

**Key features:**
- Incremental saves (only changed sessions are written)
- Lazy loading APIs (`listSessions()`, `getSession(id)`)
- Automatic orphan file recovery
- Automatic migration from legacy `agent-session-history.json`
- **Index-write serialization:** locked persistence paths acquire the global `index.lock` file lock *and* serialize same-process writers via `runWithGlobalIndexSerialized()` in `src/core/services/lockedSessionPersistence.ts`, so concurrent index reload-upserts cannot drop each other's writes. Slow-wait telemetry is emitted when the serializer queue stalls.
- **Session cap (`MAX_PERSISTED_SESSIONS` = 25 000, `src/core/constants.ts`):** before each index write, `evictIfNeeded()` in `incrementalSessionStore.ts` soft-deletes the oldest **Done** sessions (by `updatedAt`) when the index exceeds the cap. **Active** sessions (`doneAt == null`) are never evicted; if every excess session is still Active, the index may temporarily exceed the cap. Eviction moves session files to `sessions-deleted/` (soft-delete), not user Trash (`deletedAt`).

**Migration:** On first load, if legacy `agent-session-history.json` exists, sessions are migrated to `sessions/` directory and the legacy file is renamed to `.backup.json`.

---

### `agent-session-history.json` (legacy)

**Status:** Deprecated - automatically migrated to `sessions/` on first load

Previously stored all sessions in a single file. Now only exists as a backup after migration (`agent-session-history.backup.json`).

---

### `inbox.json`

**Store name:** `'inbox'`  
**Source:** `src/main/services/inboxStore.ts`  
**Type:** `InboxState` (versioned)

Task inbox with pending items and execution history:
- `version` - Schema version
- `items` - Pending inbox tasks
- `history` - Executed tasks with session links

**Migration:** Renamed from `task-queue.json` via `migrateTaskQueueToInbox()`

---

### `automations.json`

**Store name:** `'automations'`  
**Source:** `src/main/services/automationScheduler.ts`  
**Type:** `AutomationStoreState` (versioned)

Scheduled automation definitions and run history:
- `version` - Schema version
- `definitions` - Automation configs (schedule, file path, enabled)
- `runs` - Execution history (status, timestamps, session reference)
- `showAutomationSessions` - UI preference

**Version:** `AUTOMATION_STORE_VERSION` constant  
**Migrations:** Versioned via `migrateStore()` framework

---

### `auth-tokens.json`

**Store name:** `'auth-tokens'`  
**Source:** `src/main/services/authTokenStorage.ts`  
**Type:** `AuthTokenStore`

Encrypted authentication tokens using Electron's `safeStorage` API:
- `encryptedSessionToken` - Base64-encoded encrypted token
- `cachedUser` - Cached user profile (id, name, email, image)

**Encryption:** Uses OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)

---

### `analytics-storage.json`

**Store name:** `'analytics-storage'`  
**Source:** `src/main/analytics.ts`  
**Type:** `{ anonymousId: string }`

RudderStack anonymous identifier for telemetry:
- `anonymousId` - UUID generated on first run

---

### `time-saved.json`

**Store name:** `'time-saved'`  
**Source:** `src/main/services/timeSavedStore.ts`  
**Type:** `TimeSavedStoreState` (versioned)

Time savings estimates from agent sessions. Top-level keys: `version`, `entries`, `aggregates`, `acknowledgedMilestones`, `hasSeenFirstEstimate`, `dailyTotals`, `firstBigWinShown`, `firstWeekShown`.

See source file for full schema.

---

### `memory-history.json`

**Store name:** `'memory-history'`  
**Source:** `src/main/services/memoryHistoryStore.ts`  
**Type:** `MemoryHistoryStoreShape` (versioned)

Memory space write activity tracking. Top-level keys: `version`, `entries`, `lastPruned`, `backfillCompleted`.

See source file for full schema.

---

### `spaces-synthesis.json`

**Store name:** `'spaces-synthesis'`  
**Source:** `src/main/services/spacesSynthesisStore.ts`  
**Type:** `SpacesSynthesisStoreShape` (versioned)

Cached synthesis for memory spaces. Top-level keys: `version`, `synthesis` (single object or null with `focus` field).

See source file for full schema.

---

### `tool-usage.json`

**Store name:** `'tool-usage'`  
**Source:** `src/main/services/toolUsageStore.ts`  
**Type:** `ToolUsageStoreShape` (versioned)

MCP tool usage frequency for UI sorting. Top-level keys: `version`, `tools` (array of `ToolUsageRecord`), `lastUpdatedAt`.

See source file for full schema.

---

### `pending-tool-approvals.json`

**Store name:** `'pending-tool-approvals'`  
**Source:** `src/main/services/safety/pendingApprovalsStore.ts`  
**Type:** `PendingApprovalsStoreShape` (versioned)

Tool and memory safety approval requests that survive app restart. Top-level keys: `version`, `pendingApprovals`, `pendingMemoryApprovals`.

See source file for full schema.

---

### `session-coaching.json`

**Store name:** `'session-coaching'`  
**Source:** `src/main/services/sessionCoachingScheduler.ts`  
**Type:** `CoachingStoreState`

Coaching evaluation state. Top-level keys: `evaluations`, `evaluatedSessionIds`, `dailyCount`, `dailyCountDate`.

See source file for full schema.

---

### `community-highlights.json`

**Store name:** `'community-highlights'`  
**Source:** `src/main/services/communityHighlightsService.ts`  

Cached community highlights from Discourse. Data stored under key `communityHighlights` containing `highlights`, `lastFetchedAt`, `lastError`.

**Cache TTL:** 24 hours. See source file for full schema.

---

## Other Files

### `rebel-system-version.json`

**Source:** `src/main/services/systemSettingsSync.ts`

Tracks the bundled rebel-system version:
```json
{
  "version": "1.2.3",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

Used for version mismatch detection in health checks.

---

### `cost-ledger.jsonl`

**Source:** `src/main/services/costLedgerService.ts`  
**Format:** JSON Lines (newline-delimited JSON)

Append-only ledger of API usage costs:
```jsonl
{"timestamp":1732272000000,"sessionId":"sess_1","turnId":"turn_1","costUsd":0.0023,"inputTokens":1024,"outputTokens":256}
{"timestamp":1732272100000,"sessionId":"sess_1","turnId":"turn_2","costUsd":0.0015,"inputTokens":512,"outputTokens":128}
```

---

## Directories

### `logs/`

**Source:** `src/core/logger.ts`

- `mindstone-rebel.log` - Main process rotating log (default 5MB max)
- `sessions/<sessionId>_<turnId>.log` - Per-turn detailed logs

Log format: JSON (pino) with timestamps, levels, and structured context.

---

### `transcripts/`

**Source:** `src/core/services/transcriptService.ts`  
**Format:** JSON Lines (newline-delimited JSON), one file per session

Full-fidelity conversation transcripts capturing pre-sanitization events from Rebel Core agent turns:

- `<sessionId>.jsonl` — Per-session transcript with complete tool inputs/outputs, assistant messages, usage stats, and subagent activity
- Schema-versioned (`v: 1`) with `TranscriptEntry` envelope containing `TranscriptEvent` discriminated union (`core` | `error` | `synthetic`)
- Append-only, fire-and-forget writes (never blocks agent turns)
- **14-day TTL** — old transcripts are cleaned up at app startup via `cleanupOldTranscripts()`

Unlike session JSON files (which truncate tool content for renderer consumption), transcripts preserve full un-truncated data for diagnostics. See `docs/plans/260413_rebel_core_transcript_logging.md` for design decisions.

---

### `mcp/`

**Source:** `src/main/services/bundledMcpManager.ts`, `src/main/ipc/settingsHandlers.ts`, `src/main/services/superMcpHttpManager.ts`

MCP configuration managed by the app:

- `super-mcp-router.json` - Default Super-MCP router config (created on first run)
- `super-mcp-router.json.<timestamp>.bak` - Backup before config changes
- `super-mcp-<port>.pid` - Super-MCP process ID file (ephemeral, for orphan cleanup)
- `klavis.json` - Klavis connector configuration
- `rebel-inbox-bridge.json` - Bridge state for Rebel-as-MCP-server:
  ```json
  { "port": 3456, "token": "auth-token" }
  ```

---

### `backups/`

**Source:** `src/core/utils/storeMigration.ts`

Automatic backups created before destructive migrations:
- Filename format: `<store-name>_v<version>_<timestamp>.json`
- Created by versioned store migration framework

---

### `models/transformers/`

**Source:** `src/main/services/embeddingService.ts`

Cached transformer models for local embeddings (semantic search):
- ONNX model files
- Tokenizer configuration

---

### `indices/<workspace-hash>/`

**Source:** `src/main/services/fileIndexService/index.ts`

LanceDB vector indices for semantic search:
- `index_metadata.json` - Index version and file counts
- LanceDB `.lance` files

The `<workspace-hash>` is a truncated SHA-256 of the workspace path.

---

### `config/`

**Source:** `src/main/runtimeConfig.ts`

- `app-config.json` - Runtime configuration overrides (analytics keys, feature flags)

---

### OAuth Connector Directories

Each OAuth connector has its own subdirectory with account metadata and encrypted credentials:

#### `google-workspace-mcp/`
**Source:** `src/main/services/googleWorkspaceAuthService.ts`, `googleWorkspaceConfigService.ts`
- `accounts.json` - Connected Google account list
- `credentials/` - Per-account token files

#### `microsoft-mcp/`
**Source:** `src/main/services/microsoftAuthService.ts`
- `accounts.json` - Connected Microsoft account list
- `credentials/<accountId>.token.json` - Per-account tokens
- `tokens.json` - Legacy token storage (migrated)

#### `salesforce-mcp/`
**Source:** `src/main/services/salesforceAuthService.ts`, `salesforceConfigService.ts`
- `accounts.json` - Connected Salesforce account list
- `credentials/<accountId>.token.json` - Per-account tokens

#### `hubspot-mcp/`
**Source:** `src/main/services/hubspotAuthService.ts`, `hubspotConfigService.ts`
- `accounts.json` - Connected HubSpot account list
- `credentials/<accountId>.token.json` - Per-account tokens

#### `slack-mcp/`
**Source:** `src/main/services/slackAuthService.ts`
- `config.json` - Slack MCP configuration
- `workspaces/<teamId>.json` - Per-workspace tokens

---

## Versioned Store Migration

Stores using the versioned migration framework (`src/core/utils/storeMigration.ts`):

| Store | Version Constant | Source |
|-------|------------------|--------|
| `sessions/index.json` | `INDEX_VERSION` (v2) | `src/main/services/incrementalSessionStore.ts` |
| `automations` | `AUTOMATION_STORE_VERSION` | `src/main/constants.ts` |
| `inbox` | Inline version | `src/main/services/inboxStore.ts` |
| `memory-history` | `MEMORY_HISTORY_STORE_VERSION` | `src/main/services/memoryHistoryStore.ts` |
| `tool-usage` | `TOOL_USAGE_STORE_VERSION` | `src/main/services/toolUsageStore.ts` |
| `time-saved` | Inline version | `src/main/services/timeSavedStore.ts` |
| `spaces-synthesis` | `SYNTHESIS_STORE_VERSION` | `src/main/services/spacesSynthesisStore.ts` |

Migration features:
- Forward-only: Never modifies data from newer app versions
- Automatic backups before destructive operations
- Version tracking per store

**Global store version gate:** At startup, a global check (`scripts/check-store-versions.ts`, `src/core/constants.ts` `ALL_STORE_VERSIONS`) compares the running app's expected store versions against what's on disk. If a mismatch is detected (e.g. data written by a newer app version), the app enters read-only mode with a banner rather than risking silent corruption. CI enforces that `ALL_STORE_VERSIONS` stays in sync via `npm run validate:fast`.

---

## Cleanup and Reset

To fully reset app state, delete the entire `userData` directory. Individual stores can be reset by deleting their JSON files.

**Diagnostic export:** The app can export logs and settings via `src/main/services/logExportService.ts` for troubleshooting.

---

## Maintenance Notes

When adding new stores:
1. Document the store name, source file, and type here
2. Add versioning if the schema may evolve
3. Consider migration needs for existing users
4. Update the directory structure diagram

When modifying existing stores:
1. Increment version if using versioned migration
2. Add migration function for the new version
3. Update type definitions and this doc
