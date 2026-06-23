---
description: "Conversation @-mentions architecture — autocomplete filters, rebel:// links, transcript attachment resolution, rendering limits"
last_updated: "2026-05-15"
---

# Conversation Mentions

Users can reference previous conversations in the composer using `@-mention` syntax. This provides context from past sessions when asking the agent for help, without manually copy-pasting transcripts.

## See Also

- [SEARCH.md](SEARCH.md) — Overview of all search systems (fuzzy autocomplete, semantic, full-text)
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) — Session model and history persistence
- [URL_PROTOCOL.md](URL_PROTOCOL.md) — The `rebel://` URL scheme used for conversation links
- [docs/plans/finished/251219_conversation_references.md](../plans/finished/251219_conversation_references.md) — Original planning doc with staged implementation
- `src/renderer/features/mentions/` — Types, hooks, and search implementation
- `src/renderer/features/composer/hooks/useMentionAutocomplete.ts` — Unified autocomplete handling


## How It Works

1. User types `@` in the composer to trigger autocomplete
2. Conversation titles appear alongside workspace files in a unified dropdown
3. Selecting a conversation inserts `@[Title](rebel://conversation/{id})`
4. On send, referenced conversations are resolved to text attachments
5. Agent receives the transcript as a `TextFileAttachmentPayload`


## Autocomplete Behavior

### Type Filtering

The autocomplete popover supports filtering results by type:

**Prefix Syntax** (keyboard-efficient):
- `@skill:` or `@s:` — Shows only skill folders
- `@memory:` or `@mem:` or `@m:` — Shows only memory files
- `@conversation:` or `@conv:` or `@c:` — Shows only past conversations
- `@` (no prefix) — Shows all results (unified view)

**Filter Tabs** (discoverable):
- Four tabs at the top of the popover: **All**, **Skills**, **Memory**, **Conversations**
- Click a tab to filter results to that type
- Tabs are disabled when an explicit prefix is typed (prefix takes precedence)

**Interaction**:
- Typing a prefix (e.g., `@skill:`) auto-selects the corresponding tab and disables others
- Removing the prefix reverts to the previously selected tab
- Filter selection resets to "All" when the popover closes

### Unified Results

The autocomplete popover shows both files and conversations in a single list:
- **Files**: Shown with file/folder icons, paths from workspace
- **Skills**: Shown with wand icon, skill name from frontmatter
- **Memory**: Files within any `memory/` folder, shown with standard file icons
- **Conversations**: Shown with message icon, relative timestamp ("2h ago")

For short queries (< 2 chars), results are limited to 4 conversations + 4 files. Longer queries show up to 200 file results sorted by relevance (see `MAX_MENTION_FILE_RESULTS` in `useWorkspaceMentions.ts`).

### Current Session Exclusion

The current conversation is **excluded** from autocomplete results. Self-referencing provides no value since the agent already has full context of the current session.

### Search Scope

Conversation search is **title-only** (not full-text message search). This is intentional:
- Faster for the autocomplete UX
- Users typically remember conversations by name, not message content
- Full-text search would require more complex ranking/snippets

Automation-originated sessions are included but marked with a visual indicator.


## Token Format

When a conversation is selected, it's inserted as a Markdown link:

```
@[Conversation Title](rebel://conversation/abc123-def456)
```

**Title sanitization**: Special characters (`]`, `)`, newlines) are escaped to prevent malformed Markdown.


## Context Resolution

When a message is sent, `rebel://conversation/{id}` URLs are extracted and resolved:

1. Find the referenced session by ID
2. Format as Markdown transcript:
   - Title and timestamp header
   - Last 10 user/assistant messages (skips tool results)
   - Truncated at ~2000 characters
3. Create `TextFileAttachmentPayload` with `name: "<title>.md"`

The agent receives this as a text attachment, same as file mentions.


## Rendering in Messages

In `MessageMarkdown.tsx`, `rebel://conversation/{id}` links render as clickable pills:
- Clicking navigates to that conversation in history
- Draft guard warns about unsaved work before navigation
- Missing sessions show a toast error (session may have been deleted)


## Key Files

| File | Purpose |
|------|---------|
| `src/renderer/features/mentions/types.ts` | `UnifiedMentionResult` union, `MentionFilterType`, `parseMentionQuery()` |
| `src/renderer/features/mentions/hooks/useConversationMentions.ts` | Search, extraction, attachment preparation |
| `src/renderer/features/composer/hooks/useMentionAutocomplete.ts` | Mention trigger detection, filter state, autocomplete logic |
| `src/renderer/features/composer/components/MentionPopover.tsx` | Autocomplete UI with filter tabs and result styling |
| `src/renderer/components/MessageMarkdown.tsx` | Renders `rebel://` links as clickable pills |
| `src/renderer/utils/conversationSearch.tsx` | Fuse.js-based title search |
| `src/renderer/utils/librarySearch.tsx` | Fuse.js-based file/directory search |
| `evals/benchmarks/search-quality.ts` | NDCG-based search quality benchmark |
| `scripts/fixtures/search-benchmark-data.json` | Test queries and expected results |


## Limitations

- **Title-only search**: No full-text message search (by design for v1)
- **No message-level linking**: References entire conversations, not individual messages
- **Local IDs**: Conversation IDs are local; links don't work across devices
- **Truncated context**: Long conversations are truncated to last 10 messages / 2000 chars


## Future Work

See `docs/plans/finished/251219_conversation_references.md` for the full roadmap:

- ~~**v2**: Type prefix filtering (`@conv:`, `@file:`) to filter mention results~~ **(Implemented)**
- **v3**: Copy link to clipboard, drag-drop from sidebar
- **v3.5**: Keyboard shortcuts for filter tab switching (deferred due to Ctrl+Arrow OS conflicts)
- **v4**: Agent-initiated conversation search (MCP tool or RAG integration)
- **Message-level deep linking**: `rebel://conversation/{id}/message/{msgId}`
