---
description: Architecture for shared-skill history using Google Drive revisions, plus attribution, restore/fork flows, and change notifications.
last_updated: "2026-04-21"
---

# Skill Versioning & Collaboration

Shared skills in Rebel use Google Drive's native revision history as the source of truth. Rebel still preserves contributor attribution on writes and supports in-app history browsing, diff preview, restore, and fork-to-private-copy flows through the existing `skill-history:*` IPC/UI.


## Intent & Design Decisions

**Problem:** Shared skills are editable by multiple collaborators (humans and the Rebel agent). Without version history, a bad edit — especially an agent-authored one — can silently overwrite good content with no recovery path.

**Approach:** Drive-native history architecture. The version panel resolves a shared skill's Drive `file_id`, reads revisions through Google Workspace MCP (`list_file_revisions`, `download_file_revision`), and maps results into the existing `SkillHistoryPanel` payload contract. Restore writes still flow through `sharedSkillMutationService.writeManagedSkillFile()` so Rebel metadata/auditing stay consistent.

**Key design decisions a future agent must preserve:**
- Google Drive revisions are the only history source of truth (no local snapshot mirror)
- Eligibility is intentionally scoped to shared skills on `google_drive` storage provider
- `restore` always writes through `sharedSkillMutationService` (never raw `fs.writeFile`)
- `skill-history:*` channel names and payload schema stay stable for renderer compatibility
- Missing/unsupported Drive linkage fails explicitly with `drive-history-unavailable:*`
- Startup migration removes deprecated `<space>/.rebel/history` directories once


## See Also

- [MEMORY_SAFETY.md](MEMORY_SAFETY.md) — Safety evaluation for memory writes (shared skills route through this)
- [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) — Broader safety system architecture
- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) — Overall system architecture


## Architecture Overview

```
User opens Skill History panel
    │
    ▼
driveSkillHistoryService
    │
    ├── resolve shared-skill target + google_drive gate
    ├── resolve Google account + Drive file_id (search_drive_files)
    ├── list_file_revisions / download_file_revision
    └── map to existing SkillHistory* IPC payloads

Restore action
    │
    ▼
sharedSkillMutationService.writeManagedSkillFile()
    ├── Content-hash conflict check (optimistic locking)
    ├── Safety evaluation (memoryWriteHook)
    ├── Writes restored content with collaboration metadata
    └── Emits skill_restored analytics
```

### History Storage

History data is stored in Google Drive revisions for the skill file itself. Rebel does not maintain `.rebel/history/skills` snapshots anymore.


## Key Code Paths

### Main process services

| File | Purpose |
|------|---------|
| [`src/main/services/sharedSkillMutationService.ts`](../../src/main/services/sharedSkillMutationService.ts) | **Central write pipeline** for shared skills — conflict detection, observer notifications, content-hash tracking |
| [`src/main/services/driveSkillHistoryService.ts`](../../src/main/services/driveSkillHistoryService.ts) | **Drive history service** — account + `file_id` resolution, revision listing/download, restore/fork orchestration |
| [`src/core/services/driveHistoryMigration.ts`](../../src/core/services/driveHistoryMigration.ts) | **One-shot cleanup** — removes deprecated `<space>/.rebel/history` directories and records completion marker |
| [`src/main/services/skillChangeNotificationService.ts`](../../src/main/services/skillChangeNotificationService.ts) | **Change notifications** — inbox notifications for team members when shared skills change |
| [`src/main/services/skillWriteTrackingHook.ts`](../../src/main/services/skillWriteTrackingHook.ts) | **Write tracking hook** — connects agent-authored writes to the managed mutation pipeline |
| [`src/main/services/skillAttributionRepairService.ts`](../../src/main/services/skillAttributionRepairService.ts) | **Attribution repair** — backfills contributor metadata for skills missing attribution |
| [`src/main/services/safety/memoryWriteHook.ts`](../../src/main/services/safety/memoryWriteHook.ts) | Memory write safety evaluation (shared skills route through this) |

### IPC channels

| File | Purpose |
|------|---------|
| [`src/shared/ipc/channels/skillHistory.ts`](../../src/shared/ipc/channels/skillHistory.ts) | Zod-validated IPC channel definitions: `skill-history:get-versions`, `skill-history:get-snapshot`, `skill-history:restore`, `skill-history:fork` |
| [`src/main/ipc/libraryHandlers.ts`](../../src/main/ipc/libraryHandlers.ts) | IPC handler registration for `skill-history:*` channels (wires IPC to the version history service) |
| [`src/preload/index.ts`](../../src/preload/index.ts) | Preload bridge exposing `window.skillHistoryApi` to the renderer |

### Renderer UI

| File | Purpose |
|------|---------|
| [`src/renderer/features/library/components/SkillHistoryPanel.tsx`](../../src/renderer/features/library/components/SkillHistoryPanel.tsx) | **Version history dialog** — full-screen panel with version list, diff viewer, preview, restore/fork actions |
| [`src/renderer/features/library/components/SkillHistoryRow.tsx`](../../src/renderer/features/library/components/SkillHistoryRow.tsx) | Individual version row in the history sidebar (timestamp, actor, summary, action buttons) |
| [`src/renderer/features/library/components/SkillCard.tsx`](../../src/renderer/features/library/components/SkillCard.tsx) | Skill card in the Library — provides entry point to version history |
| [`src/renderer/features/library/utils/skillAttribution.ts`](../../src/renderer/features/library/utils/skillAttribution.ts) | Display-name resolution for skill actors (handles "You" vs name vs email fallback) |
| [`src/renderer/features/document-editor/components/UnifiedDocumentEditor.tsx`](../../src/renderer/features/document-editor/components/UnifiedDocumentEditor.tsx) | Document editor — integrates SkillHistoryPanel for in-editor version history access |

### Tests

| File | Purpose |
|------|---------|
| [`src/main/services/__tests__/driveSkillHistoryService.test.ts`](../../src/main/services/__tests__/driveSkillHistoryService.test.ts) | Drive revision mapping, restore-through-managed-write, account/file resolution behavior |
| [`src/core/services/__tests__/driveHistoryMigration.test.ts`](../../src/core/services/__tests__/driveHistoryMigration.test.ts) | Migration marker/idempotency and `.rebel/history` cleanup behavior |
| [`src/main/services/__tests__/sharedSkillMutationService.test.ts`](../../src/main/services/__tests__/sharedSkillMutationService.test.ts) | Managed write pipeline, conflict detection, observer notifications |
| [`src/main/services/__tests__/skillChangeNotificationService.test.ts`](../../src/main/services/__tests__/skillChangeNotificationService.test.ts) | Change notification delivery |
| [`src/main/services/__tests__/skillWriteTrackingHook.test.ts`](../../src/main/services/__tests__/skillWriteTrackingHook.test.ts) | Agent write tracking integration |
| [`src/renderer/features/library/utils/skillAttribution.test.ts`](../../src/renderer/features/library/utils/skillAttribution.test.ts) | Actor label resolution logic |


## Core Flows

### Revision Listing & Preview

1. Renderer calls `skill-history:get-versions`
2. `driveSkillHistoryService` classifies the path as a shared skill and confirms `google_drive` backing
3. Service resolves account + Drive `file_id` using MCP config + `search_drive_files`
4. Service calls `list_file_revisions`, maps revisions to `SkillHistoryVersionSummary`
5. Renderer calls `skill-history:get-snapshot` with `snapshotId` (Drive revision id), service fetches bytes with `download_file_revision`

### Restore

1. User selects a version in `SkillHistoryPanel` and confirms restore
2. Renderer calls `skill-history:restore` IPC
3. Service loads the snapshot body, then calls `sharedSkillMutationService.writeManagedSkillFile()` with `restoreLineage` context
4. The write overwrites with restored Drive revision bytes and applies standard collaboration metadata
5. Analytics event `skill_restored` is tracked

### Fork to Library

1. User clicks "Save as new skill" in `SkillHistoryPanel` and provides a name
2. Renderer calls `skill-history:fork` IPC
3. Service loads the snapshot body, resolves the Chief-of-Staff space root, writes a new skill file
4. Analytics event `skill_forked` is tracked


## Types

Key interfaces exported from `driveSkillHistoryService.ts`:

- `SkillHistoryVersionSummary` — list-view metadata (snapshotId, timestamp, actor, summary, content hash)
- `SkillHistorySnapshotPayload` — full snapshot with body content for preview/restore

Key interfaces from `sharedSkillMutationService.ts`:

- `SharedSkillTarget` — resolved skill location (absolute path, relative path, sharing level, shape)
- `SharedSkillActor` — `{ kind: 'human' | 'agent'; user: AuthUser | null }`
- `ManagedSharedSkillWriteEvent` — fired after each managed write (target, previous content, next content, actor)
