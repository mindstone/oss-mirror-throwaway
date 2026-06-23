---
description: "Guide to retrieving Rebel conversation contents — session JSON, transcript JSONL, storage paths, historical SDK transcripts"
last_updated: "2026-04-14"
---

# Reading a Rebel Conversation

> **Historical note (April 2026):** The Claude Agent SDK was removed and with it the `upstreamSessionId` field and `~/.claude/` transcript correlation. Step 2 below is only relevant for sessions that ran before April 2026. New sessions use Rebel Core, which does not create `~/.claude/` transcripts. See `docs/plans/260406_fix_sdk_conversation_amnesia.md`.

How to retrieve the full contents of a conversation given a `rebel://conversation/{id}` link — from Rebel's own session storage.


## See Also

- [URL_PROTOCOL.md](URL_PROTOCOL.md) — `rebel://` URL scheme and `rebel://conversation/{id}` format
- [DIAGNOSE_ONE_OF_MY_CONVERSATIONS.md](DIAGNOSE_ONE_OF_MY_CONVERSATIONS.md) — full diagnostic workflow for investigating conversation issues
- [ELECTRON_STORAGE_REFERENCE.md](ELECTRON_STORAGE_REFERENCE.md) — complete Electron `userData` storage layout
- [CLAUDE_AGENT_SDK_REFERENCE.md](../research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md) — SDK session storage details (`~/.claude/` directory)
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) — session persistence architecture
- `rebel-system/scripts/claude_code_conversation_search.py` — Python CLI tool for searching/browsing `.claude` transcripts


## Quick Reference

```
rebel://conversation/{id}
  → <userData>/sessions/{id}.json           (Rebel session — messages, events, UI state)
  → <userData>/transcripts/{id}.jsonl       (Full-fidelity transcript — complete tool I/O, usage, subagents)
```


## Step 1: Rebel Session File

### ID-to-File Mapping

The `{id}` in `rebel://conversation/{id}` maps directly to a session file:

```
<userData>/sessions/{id}.json
```

### Platform Paths

| Platform | Session directory |
|----------|-----------------|
| **macOS** | `~/Library/Application Support/mindstone-rebel/sessions/` |
| **Windows** | `%APPDATA%\mindstone-rebel\sessions\` |
| **Linux** | `$XDG_CONFIG_HOME/mindstone-rebel/sessions/` or `~/.config/mindstone-rebel/sessions/` |

> See [ELECTRON_STORAGE_REFERENCE.md](ELECTRON_STORAGE_REFERENCE.md) for the canonical `userData` path reference. In dev mode, Electron may use a different app name — check `src/main/startup/ensureAppIdentity.ts`.

### Retrieval Commands

**macOS/Linux:**
```bash
# Read a session (replace {id} with the UUID from the rebel:// link)
cat ~/Library/Application\ Support/mindstone-rebel/sessions/{id}.json | python3 -m json.tool

# List all sessions
ls ~/Library/Application\ Support/mindstone-rebel/sessions/
```

**Windows (PowerShell):**
```powershell
Get-Content "$env:APPDATA\mindstone-rebel\sessions\{id}.json" | ConvertFrom-Json
```

### Session JSON Structure

Each `sessions/{id}.json` file contains a serialized `AgentSession` object. Key fields for conversation retrieval:

| Field | Description |
|-------|-------------|
| `id` | Session UUID (matches the URL) |
| `title` | Conversation title |
| `messages` | Array of `AgentTurnMessage` — the conversation transcript (role, text, turnId, createdAt) |
| `eventsByTurn` | Events per turn — tool calls, status updates, errors |
| `createdAt` / `updatedAt` | Timestamps (epoch ms) |
| `activeTurnId` / `isBusy` | Turn state |
| `lastError` | Last error message, if any |

Full type: `AgentSession` in `src/shared/types.ts`.

### Troubleshooting

- **File not found**: The session may have been deleted (`deletedAt` set), or you may be looking at a different `userData` directory (dev vs packaged, beta vs stable channel).
- **Index file**: `sessions/index.json` contains lightweight summaries of all sessions — useful for listing without reading each full file.


## Step 2: Transcript JSONL (Full-Fidelity)

For sessions running on Rebel Core (April 2026+), full-fidelity transcripts are written to:

```
<userData>/transcripts/{id}.jsonl
```

These capture pre-sanitization events with complete tool inputs/outputs, assistant messages, per-API-call usage, and subagent activity — data that is truncated in the session JSON files.

**Retrieval:**
```bash
# macOS/Linux — read the transcript for a conversation
cat ~/Library/Application\ Support/mindstone-rebel/transcripts/{id}.jsonl | python3 -m json.tool --no-ensure-ascii

# Each line is a TranscriptEntry with schema version, timestamps, turn/session IDs, depth, namespace, and event payload
```

**Retention:** 14-day TTL — transcripts older than 14 days are automatically cleaned up at app startup. If you need a transcript for diagnostic purposes, retrieve it promptly.

See `src/core/services/transcriptService.ts` for the `TranscriptEntry` schema and `docs/plans/260413_rebel_core_transcript_logging.md` for design decisions.


## Step 3: Claude SDK Transcript (`~/.claude/`) — Historical Only

> **Note:** The Claude Agent SDK was removed in April 2026. The `~/.claude/` transcripts below are only available for sessions that ran before the removal. New sessions use Rebel Core, which does not create `~/.claude/` transcripts. The `upstreamSessionId` field has been removed from the codebase.

For pre-April-2026 sessions, the Claude Agent SDK wrote its own copy of the conversation in JSONL format with richer data than Rebel stores (thinking blocks, raw API responses, tool I/O, timing). If you have historical sessions with `upstreamSessionId` values in their JSON files, you can use those to locate SDK transcripts.

### Locating the JSONL File

SDK transcripts live at:
```
~/.claude/projects/{encoded-workspace}/{upstreamSessionId}.jsonl
```

Workspace paths are encoded by replacing `/` with `-` (e.g., `/Users/alice/dev/project` → `-Users-alice-dev-project`). This encoding is lossy — dashes in folder names are indistinguishable from path separators.

**Find the file (recommended — avoids encoding guesswork):**
```bash
# Search all workspaces for the session
find ~/.claude/projects -name "{upstreamSessionId}.jsonl" 2>/dev/null
```

### Reading the Transcript

**Using the Python search tool (recommended):**
```bash
# Show full conversation transcript
python3 rebel-system/scripts/claude_code_conversation_search.py show {upstreamSessionId}

# List recent conversations
python3 rebel-system/scripts/claude_code_conversation_search.py list --limit 20

# Search by keyword across all conversations
python3 rebel-system/scripts/claude_code_conversation_search.py search "keyword"

# List workspaces
python3 rebel-system/scripts/claude_code_conversation_search.py workspaces
```

**Manual reading:**
```bash
# Each line is a JSON object with type, timestamp, message fields
cat ~/.claude/projects/*/{upstreamSessionId}.jsonl | python3 -m json.tool --no-ensure-ascii
```

### JSONL Line Format

Each line is a JSON object. Common `type` values:

| Type | Contents |
|------|----------|
| `user` | User message — `message.content` (string or structured list) |
| `assistant` | Assistant response — `message.content` (text blocks + tool_use blocks), `message.model` |
| `system` | System events — includes `system.init` with `session_id` |

### Troubleshooting

- **File not found**: Try searching all workspaces (`find ~/.claude/projects -name "*.jsonl" -newer /tmp/ref`). The workspace encoding may not match your expectation.
- **Missing `upstreamSessionId`**: Use the Python search tool to search by keyword or browse recent sessions by time.


## What Each Store Contains

| Data | Rebel Session JSON | Transcript JSONL | Claude SDK JSONL (historical) |
|------|-------------------|-----------------|------|
| User/assistant messages | Yes (text only) | Yes (full structured content) | Yes (full structured content) |
| Tool calls & results | Yes (in `eventsByTurn`, truncated) | Yes (full, un-truncated) | Yes (as `tool_use`/`tool_result` blocks) |
| Thinking blocks | No | No | Yes |
| Raw API responses | No | No | Yes |
| Timing / token usage | Partial (per-turn summary) | Yes (per-API-call usage) | Yes (per-message) |
| Subagent activity | Partial (forwarded events) | Yes (with depth/namespace) | N/A |
| UI state (pins, stars, draft) | Yes | No | No |
| Cost tracking | Via `cost-ledger.jsonl` | Via usage in events | Via usage stats in messages |
| Session title | Yes | No | No (use first user message) |

**When to use which:**
- **Rebel session JSON**: For conversation content, UI state, session metadata — the "what happened" view.
- **Transcript JSONL**: For deep debugging of current conversations — full tool I/O, subagent events, and per-API-call usage that session JSON truncates. Available for sessions within the 14-day retention window.
- **Claude SDK JSONL** (historical only): For pre-April-2026 sessions — thinking blocks, raw API data. No longer generated.


## Privacy Warning

Session files and SDK transcripts contain the full conversation content, which may include PII, API keys in error messages, or sensitive business context. Treat them as sensitive data — do not paste into tickets, commit to repos, or share without redacting. Use `redactSensitiveString()` from `src/shared/utils/sentryRedaction.ts` for programmatic redaction.


## Maintenance

Update this doc when:
- Session storage format changes (new fields, directory layout)
- The mapping between Rebel session IDs and Claude SDK session IDs changes
- New retrieval tools or commands are added
