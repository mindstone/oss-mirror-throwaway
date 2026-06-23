---
description: "Entity layer architecture for people and companies — topic-file frontmatter, metadata indexing, resolution, meeting integration, and MCP tools"
last_updated: "2026-06-07"
---

### Introduction

The entity layer gives Rebel structured knowledge about **real-world people and companies** that exist across spaces, meetings, and conversations. Rather than building a separate data model, entities are regular topic files with standardized YAML frontmatter and a lightweight metadata index — extending the existing memory system rather than replacing it.

This document describes the entity architecture, frontmatter schema, resolution mechanisms, meeting participant integration, and the agent-facing query tools.


### See also

- [`docs/plans/partway/260307_entity_layer_architecture.md`](../plans/partway/260307_entity_layer_architecture.md) — Original planning doc with design rationale, market research, and review history
- [`src/main/services/entityMetadataStore.ts`](../../src/main/services/entityMetadataStore.ts) — Entity metadata store: Zod schemas, indexing, search, resolution, derived interaction tracking
- [`rebel-system/skills/memory/memory-update/SKILL.md`](../../rebel-system/skills/memory/memory-update/SKILL.md) — Memory update skill that creates entity frontmatter when writing about people/companies
- [`src/main/services/fileIndexService/index.ts`](../../src/main/services/fileIndexService/index.ts) — File indexer that hooks entity detection into the workspace scan
- [`src/main/services/fileWatcherService.ts`](../../src/main/services/fileWatcherService.ts) — File watcher lifecycle: entity deletion, stale cleanup, rebuild on empty store, workspace-switch clear
- [`src/main/services/bundledInboxBridge.ts`](../../src/main/services/bundledInboxBridge.ts) — Bridge HTTP endpoints (`/entities/search`, `/entities/resolve`)
- [`resources/mcp/rebel-search-and-conversations/server.cjs`](../../resources/mcp/rebel-search-and-conversations/server.cjs) — MCP tools: `rebel_entities_search`, `rebel_entities_resolve`
- [`src/main/services/directCalendarSync.ts`](../../src/main/services/directCalendarSync.ts) — Calendar sync that extracts `participantEmails` from Google/Microsoft events
- [`src/main/services/meetingHistoryStore.ts`](../../src/main/services/meetingHistoryStore.ts) — Meeting history with `participantEmails` for interaction tracking
- [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) — High-level system architecture


### Conceptual model

| Concept | What it is | Example | Storage |
|---------|-----------|---------|---------|
| **Space** | Container with visibility rules | `Chief-of-Staff/`, `work/Mindstone/Exec/` | Folder + `README.md` frontmatter |
| **Memory** | Knowledge in spaces (sources + topics) | `topics/Sarah-Chen.md`, `sources/260307/meeting.md` | Markdown files |
| **Entity** | Real-world thing that exists across spaces | Sarah Chen (person), Acme Corp (company) | Topic file with entity frontmatter + metadata index |

An entity **is** a topic file — it just has standardized YAML frontmatter that enables structural queries. The file body contains rich topic content (notes, context, timestamps) exactly as the memory update skill produces.


### Key decisions

- **Entities are topic files, not a separate data model.** A person entity is `topics/people/Sarah-Chen.md` with `entity_type: person` in its frontmatter. No new file formats or storage paradigms.
- **Email is the canonical identifier.** At personal scale, email uniquely identifies a person. Name matching is fuzzy; email matching is exact.
- **`last_interaction` is derived, not persisted.** Computed on demand from meeting history to avoid file churn, race conditions, and git noise.
- **`participantEmails` is additive.** Added as an optional field alongside the existing `participants: string[]` — no type changes, fully backward compatible.
- **CRM enrichment explicitly deferred.** HubSpot/Salesforce sync is a separate project; the entity layer focuses on identity and structured queries.
- **Cross-space identity via frontmatter.** If Sarah Chen has topic files in two spaces, both with `emails: [[external-email]]`, the entity index resolves them as the same person automatically.

### Entity-layer companies vs. space organisation grouping

The entity layer tracks **real-world companies** as topic entities — `entity_type: company` with `canonical_name`, `domain`, and `aliases`. These are the companies that appear in your memory, meetings, and conversations.

**Space organisation grouping** (see [SPACES.md](./SPACES.md) § Organisation Grouping) is a separate, unrelated concept. A space's `organisation_name` frontmatter field is a **grouping tag** (e.g., `"Mindstone"`, `"Acme Corp"`) that tells Rebel which company or client a space belongs to for prompt grouping and UI surfacing. It has no relationship to the entity layer — the entity metadata store does not read `organisation_name`, and the space grouping code does not read entity frontmatter.

The `company` entity in the entity layer **does NOT own spaces**. Per the entity layer invariants, a company entity file (`topics/companies/Acme-Corp.md`) is a topic file about Acme; it does not confer membership, permissions, or grouping on any space. A space can have `organisation_name: "Acme Corp"` without any entity-layer topic file about Acme, and vice versa. The two systems are independent.


### Architecture

#### Entity metadata store

`entityMetadataStore.ts` follows the `sourceMetadataStore.ts` pattern exactly:

- **Lazy store**: `getStore()` creates the `electron-store` instance on first access (`entity-metadata` store name)
- **Workspace-aware**: `initForWorkspace()` clears entries when the workspace changes or the store version mismatches
- **Versioned**: `ENTITY_METADATA_STORE_VERSION = 1`
- **Normalized fields**: emails are lowercased and deduplicated; aliases are trimmed and deduplicated

The store shape:

```typescript
interface EntityMetadataStoreShape {
  version: number;
  workspacePath: string | null;
  entries: Record<string, EntityMetadataEntry>;  // keyed by absolute file path
}
```

Each `EntityMetadataEntry` contains: `filePath`, `relativePath`, `entityType`, `canonicalName`, `emails[]`, `company?`, `role?`, `domain?`, `aliases[]`, `spacePath`, `indexedAt`, `mtime`.

#### Zod schemas

Entity frontmatter uses a Zod discriminated union on `entity_type`:

- **`PersonEntityFrontmatterSchema`**: `entity_type: 'person'`, `canonical_name` (required), `emails[]` (optional), `company?`, `role?`, `aliases[]?`
- **`CompanyEntityFrontmatterSchema`**: `entity_type: 'company'`, `canonical_name` (required), `domain?`, `aliases[]?`
- **`EntityFrontmatterSchema`**: discriminated union of the above two schemas

#### File detection

Entity detection is content-based (not path-based like sources):

1. **Fast path**: `content.substring(0, 2048).includes('entity_type:')` — rejects non-entity files without YAML parsing
2. **Full parse**: `front-matter` library parses YAML, then Zod validates against `EntityFrontmatterSchema`

This runs for every markdown file during indexing. The fast-path string check avoids YAML parsing overhead for the vast majority of files.

#### File watcher lifecycle

Entity indexing hooks into the existing file watcher infrastructure:

| Hook point | File | What happens |
|-----------|------|-------------|
| **Indexing** | `fileIndexService.ts` | After reading file content, calls `isEntityFile(content)` → `indexEntity()` if entity, or `removeEntity()` if previously indexed but frontmatter removed |
| **Deletion** | `fileWatcherService.ts` | On file delete, calls `entityMetadataStore.removeEntity(filePath)` |
| **Stale cleanup** | `fileWatcherService.ts` | During stale entry reconciliation, removes entity entries for case-mismatched or deleted files |
| **Startup rebuild** | `fileWatcherService.ts` | If skip-rescan is active but `entityMetadataStore.isEmpty()`, rebuilds from already-indexed paths via `rebuildEntityMetadata()` |
| **Workspace init** | `fileWatcherService.ts` | Calls `entityMetadataStore.initForWorkspace()` to clear entries on workspace switch or version mismatch |

#### Bridge endpoints

`bundledInboxBridge.ts` exposes two HTTP endpoints for MCP tools:

- **`POST /entities/search`** — Maps `query` → `name` in `searchEntities()`. Supports `email`, `company`, `entityType`, `noInteractionSince`, `limit` (capped at 50).
- **`POST /entities/resolve`** — Accepts `email` or `name` (email takes priority). Returns `{ found, entity }`.

#### MCP tools

Two tools in the `RebelSearchAndConversations` MCP server (`resources/mcp/rebel-search-and-conversations/server.cjs`):

- **`rebel_entities_search`** — Search/filter entities by name, email, company, type, and `noInteractionSince`. Returns matching entities with total count.
- **`rebel_entities_resolve`** — Resolve a specific person/company by email (exact match) or name (fuzzy match). Returns the single best match.


### Entity frontmatter schema

#### Person

```yaml
---
entity_type: person
canonical_name: Sarah Chen
emails:
  - [external-email]
  - [external-email]
company: Acme Corp
role: VP Engineering
aliases:
  - S. Chen
  - Sarah
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `entity_type` | Yes | Always `person` |
| `canonical_name` | Yes | Primary display name |
| `emails` | No | Email addresses (primary resolution key) |
| `company` | No | Company affiliation |
| `role` | No | Job title / role |
| `aliases` | No | Alternative names for fuzzy matching |

#### Company

```yaml
---
entity_type: company
canonical_name: Acme Corp
domain: acme.com
aliases:
  - Acme
  - Acme Corporation
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `entity_type` | Yes | Always `company` |
| `canonical_name` | Yes | Primary display name |
| `domain` | No | Company website domain |
| `aliases` | No | Alternative names for fuzzy matching |

#### What stays in the file body (not frontmatter)

Personal notes, relationship context, conversation history, detailed meeting notes, project involvement — anything the AI should reason about rather than query structurally.

#### Filename conventions

- People: `topics/people/Name.md` (e.g., `topics/people/Sarah-Chen.md`)
- Companies: `topics/companies/Name.md` (e.g., `topics/companies/Acme-Corp.md`)

Sub-folders are for organization only — the `entity_type` frontmatter is what identifies entity files.


### Entity resolution

#### Email-based exact match (primary)

`resolveByEmail(email)` normalizes the email to lowercase and finds entities with an exact email match. This is the most reliable resolution path.

#### Fuzzy name matching

`resolveByName(name)` tries three strategies in order:

1. **Exact canonical name match** (case-insensitive)
2. **Exact alias match** (case-insensitive)
3. **Fuzzy match** via `matchesParticipant()` against canonical name and aliases

The `matchesParticipant()` function supports substring matching and email-local-part matching (e.g., matching "sarah" against `[external-email]`).

#### Cross-space identity

If `Chief-of-Staff/memory/topics/people/Sarah-Chen.md` and `work/Mindstone/General/memory/topics/people/Sarah-Chen.md` both have `emails: [[external-email]]`, the entity index resolves them as the same person. No explicit cross-references required.

#### Search filters

`searchEntities()` supports filtering by:

- `name` — fuzzy match against `canonicalName` and `aliases`
- `email` — fuzzy match against `emails`
- `company` — fuzzy match against `company` (for persons) or `canonicalName`/`aliases` (for companies)
- `entityType` — `'person'` or `'company'`
- `noInteractionSince` — ISO date; filters to entities whose most recent meeting interaction is before this date (person entities only)
- `limit` — max results (default 20, capped at 50)


### Meeting participant resolution

#### `participantEmails` field

`CachedMeeting` and `MeetingHistoryEntry` include an optional `participantEmails: string[]` field (lowercased email addresses from calendar providers). This is additive — the existing `participants: string[]` (display names) remains unchanged for backward compatibility.

- **Google Calendar**: extracts `attendees[].email` for accepted, non-self attendees
- **Microsoft Graph**: extracts `attendees[].emailAddress.address`, explicitly excluding the user's own email

`participantEmails` propagates through `reconcileCalendarMeetings()` in the meeting history store on both create and update paths.

#### Derived `last_interaction`

`deriveLastInteraction(email)` queries `meetingHistoryStore` for the most recent meeting where `participantEmails` includes the given email. Returns the meeting's `startTime` as an ISO date string, or `undefined` if no match.

This is computed on demand, not persisted — avoiding file churn and stale data.

#### `noInteractionSince` filter

The `searchEntities()` function supports a `noInteractionSince` filter that enables queries like "who haven't I talked to in 30 days?". It builds an email→lastMeetingTime map once per query invocation (avoiding O(entities × meetings) per-entity scans), then filters to person entities whose most recent meeting interaction precedes the cutoff date. Person entities with no known email or no meeting matches are included (they've never interacted in known history).

#### Known limitation

Meeting history retains approximately 30 days / 500 entries. Interactions older than that window are not discoverable by `deriveLastInteraction()` or the `noInteractionSince` filter.


### Memory update skill

The memory update skill (`rebel-system/skills/memory/memory-update/SKILL.md`) is the primary writer of entity frontmatter. When creating or updating a topic file about a specific person or company, the skill adds structured frontmatter:

- `entity_type` and `canonical_name` are always required
- `emails`, `role`, `company` are only added when explicitly known (stated by user or from a source) — never guessed
- Existing frontmatter is preserved on updates; only new/changed fields are added
- Not every topic file about a person needs entity frontmatter — only files representing a distinct real-world person or company the user interacts with
