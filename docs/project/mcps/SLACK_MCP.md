---
description: "Slack OSS MCP connector (@mindstone/mcp-server-slack) — OAuth bridge auth, local token storage, search/read/write tools, file attachments, scope verification"
last_updated: "2026-06-12"
---

# Slack MCP

| Field | Value |
|-------|-------|
| **Type** | OSS connector (`provider: rebel-oss`), runs locally |
| **Package** | [`@mindstone/mcp-server-slack`](https://www.npmjs.com/package/@mindstone/mcp-server-slack) (npm; source in the `mcp-servers` submodule) |
| **Transport** | stdio |
| **Auth** | OAuth via Bridge pattern |
| **Status** | Migrated to OSS package (2026); pinned in `resources/connector-catalog.json` (`bundled-slack`) |

> **Architecture note (2026-06):** This connector is **no longer the legacy single-file bundle** under `resources/mcp/slack/` (that path now holds only legacy source — it is not what ships). The shipping connector is the OSS npm package `@mindstone/mcp-server-slack`, whose source lives in the `mcp-servers` submodule at `mcp-servers/connectors/slack/` (multi-file: `src/tools/*.ts`, `src/helpers.ts`, `src/untrusted-content.ts`). Rebel installs the catalog-pinned version via `npx`. Version bumps/releases go through the agent-driven flow — see [MCP_OSS_RELEASE_AGENT_DRIVEN](../MCP_OSS_RELEASE_AGENT_DRIVEN.md). Several sections below (single-file architecture, the `MINDSTONE_REBEL_BRIDGE_STATE` env var — now `MCP_HOST_BRIDGE_STATE`, the development steps) predate the OSS migration and are retained for context but should be read against the connector source as the source of truth.

## See Also

- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Development workflow for MCP improvements
- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup, discovery, and troubleshooting
- [ONBOARDING_SETUP_WIZARD.md](../ONBOARDING_SETUP_WIZARD.md) - OAuth connector setup during onboarding
- [KLAVIS_TO_BUNDLED_MCP_MIGRATION.md](../KLAVIS_TO_BUNDLED_MCP_MIGRATION.md) - Migration from Klavis MCPs
- [MCP_OSS_RELEASE_AGENT_DRIVEN.md](../MCP_OSS_RELEASE_AGENT_DRIVEN.md) - The sanctioned version-bump/release flow for this connector
- Source code (canonical): `mcp-servers/connectors/slack/src/` (the OSS package). The legacy single-file source under `resources/mcp/slack/` is no longer what ships.

### Official Slack API Documentation

- **[Slack OAuth Scopes Reference](https://api.slack.com/scopes)** - Authoritative list of all valid scopes with supported token types (Bot vs User)
- **[Slack API Methods](https://api.slack.com/methods)** - API method documentation with required scopes
- **[OAuth 2.0 Installation](https://api.slack.com/authentication/oauth-v2)** - OAuth flow documentation

> **IMPORTANT:** Always verify scope validity against the official Slack documentation before adding or modifying OAuth scopes. Requesting invalid scopes (e.g., bot-only scopes as user scopes, or non-existent scopes) causes the entire OAuth flow to fail with `invalid_scope`.
>
> **Scope verification checklist:** When researching scopes, always check the **"Supported token types"** field on each scope's page (e.g., [api.slack.com/scopes/channels:manage](https://api.slack.com/scopes/channels:manage)). Many scopes are **bot-only** (e.g., `channels:manage`, `groups:manage`) even though they appear in general scope lists. Web search results and AI summaries often omit this distinction.

## Overview

The Slack MCP provides full Slack workspace integration for Rebel, enabling message search, channel management, posting messages, thread replies, reactions, and user lookups. It's a **bundled MCP** that runs locally, ensuring data stays on the user's machine and providing reliable, low-latency access.

This MCP replaced the previous Klavis gateway version to provide:
- **Privacy**: Tokens stored locally, no data sent through third-party gateways
- **Reliability**: Direct API calls without gateway dependencies
- **Full control**: Custom error handling and rate limit management

## Architecture

```
resources/mcp/slack/
├── src/
│   └── index.ts          # All tools, handlers, and MCP server
├── package.json
└── build/                # Compiled JS (gitignored)
```

The Slack MCP uses a single-file architecture (like other simpler bundled MCPs) with:
- `@slack/web-api` for all Slack API interactions
- `@modelcontextprotocol/sdk` for MCP server implementation
- Bridge pattern for OAuth flow integration with the main app

## Authentication

### OAuth Flow

The Slack MCP uses OAuth 2.0 with the Mindstone Rebel Bridge pattern:

1. User clicks "Connect Slack" in Settings → Connectors
2. MCP calls `bridgeRequest('/bundled/slack/start-auth')`
3. Bridge opens browser for Slack OAuth consent
4. User authorizes the app with required scopes
5. Callback receives tokens and stores them locally
6. Workspace info saved to `config.json`

### Token Types

The MCP uses **two token types**:

| Token | Variable | Purpose |
|-------|----------|---------|
| Bot Token | `SLACK_BOT_TOKEN` | Read operations fallback, user lookups |
| User Token | `SLACK_USER_TOKEN` | Required for writes and search; preferred for reads |

**Read operations**: The MCP prefers the user token (`slackReader = slackUser || slack`), enabling reading **any public channel** without requiring bot membership. Falls back to bot token for reads if user token unavailable.

**Write operations**: `post_slack_message`, `reply_to_slack_thread`, and `add_slack_reaction` **require** the user token. Messages appear from your Slack account and are editable by you. If the user token is unavailable or lacks required scopes, the operation fails with a clear error directing you to reconnect Slack.

**Search**: `search_slack_messages` **requires** the user token with `search:read` scope. If unavailable, search returns an error suggesting `get_slack_channel_history` as an alternative.

**Re-authentication**: If Slack operations fail with permission errors, reconnect Slack via Settings → Integrations to grant the required scopes (`chat:write`, `reactions:write`, `search:read`).

### Token Storage

Tokens are stored in the directory specified by `SLACK_CONFIG_PATH` environment variable:

```
~/.mcp/slack/
├── config.json                    # Workspace metadata (teamId, teamName, authedAt)
└── workspaces/<teamId>.json       # Bot and user tokens for each workspace
```

**Note:** Tokens are stored as JSON files. Future improvement: migrate to Electron's safeStorage API for encrypted storage.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (xoxb-xxx) for API calls |
| `SLACK_USER_TOKEN` | No | User token for search operations |
| `SLACK_CONFIG_PATH` | Yes | Path to config directory |
| `MINDSTONE_REBEL_BRIDGE_STATE` | Yes* | Path to bridge state file (*for OAuth flow) |

## Tools Reference

### Authentication & Account Management

#### `authenticate_slack_workspace`
Connect a Slack workspace via OAuth.

**Parameters:** None

**Example response:**
```json
{
  "ok": true,
  "message": "Successfully connected to Slack workspace: Acme Corp",
  "teamName": "Acme Corp"
}
```

#### `list_slack_workspaces`
**Call this first** before any other Slack operation to verify connection status.

**Parameters:** None

**Example response:**
```json
{
  "ok": true,
  "connected": true,
  "searchEnabled": true,
  "workspaces": [{
    "teamId": "T1234567890",
    "teamName": "Acme Corp",
    "connectedAt": "2024-12-15T10:30:00Z"
  }],
  "currentWorkspace": { "team": "Acme Corp", "user": "rebel-bot" },
  "message": "Connected to Slack workspace: Acme Corp. Ready for Slack operations."
}
```

### Message Operations

#### `search_slack_messages`
Search messages across all channels. **Requires user token with `search:read` scope.**

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| query | string | Yes | - | Search query (supports Slack modifiers) |
| count | number | No | 20 | Results per page (max 100) |
| sort | string | No | 'score' | 'score' (relevance) or 'timestamp' (recency) |
| sort_dir | string | No | 'desc' | Sort direction: 'asc' (oldest first) or 'desc' (newest first) |
| page | number | No | 1 | Page number for pagination |
| to_me | boolean | No | false | If true, auto-prepends `to:@<username>` to find messages mentioning you |
| response_format | string | No | 'detailed' | 'concise' (ts, channel, user, text) or 'detailed' (adds datetime, permalink) |

**Search modifiers:**
- `from:@username` - Messages from a specific user
- `in:#channel` - Messages in a specific channel
- `before:2024-01-01` / `after:2024-01-01` - Date filters
- `has:link` / `has:reaction` - Content filters

**Example:**
```json
{
  "query": "project update from:@alice in:#general after:2024-01-01"
}
```

#### `get_slack_saved_messages`
Get messages you've saved for later in Slack. **Requires user token with `search:read` scope.**

Uses Slack's search with `is:saved` modifier since Slack deprecated the direct "Later" APIs in 2023.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| query | string | No | - | Additional search filters (is:saved is auto-applied) |
| count | number | No | 20 | Results per page (max 100) |
| sort | string | No | 'timestamp' | 'score' (relevance) or 'timestamp' (recency) |
| sort_dir | string | No | 'desc' | Sort direction |
| page | number | No | 1 | Page number for pagination |
| response_format | string | No | 'detailed' | 'concise' (ts, datetime, channel, user, text) or 'detailed' (adds permalink) |

**Example:**
```json
{
  "query": "in:#general from:@alice"
}
```

**Example response:**
```json
{
  "ok": true,
  "messages": [
    {
      "ts": "1704067200.123456",
      "datetime": "2024-01-01T00:00:00.123Z",
      "channel": { "id": "C123", "name": "general" },
      "user": "U456",
      "text": "Important message saved for later",
      "permalink": "https://workspace.slack.com/archives/C123/p1704067200123456"
    }
  ],
  "total": 1,
  "page": 1,
  "pageCount": 1
}
```

**Notes:**
- Messages always include both `ts` (Slack timestamp) and `datetime` (ISO 8601)
- The `is:saved` modifier is automatically applied; avoid including it in your query
- Results may not perfectly match the Slack UI's "Later" list due to API limitations

#### `get_slack_channel_history`
Get recent messages from a channel.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID or #channel-name |
| limit | number | No | 20 | Max messages to return |
| cursor | string | No | - | Pagination cursor |
| response_format | string | No | 'detailed' | 'concise' (ts, user, text, thread_ts) or 'detailed' (adds datetime, reply_count, files[]) |

**Channel input formats:**
- Channel ID: `C1234567890`
- Channel name: `#general`
- Slack rich format: `<#C1234567890|general>`

**Attachments:** In `detailed` format, messages with attachments include a `files[]` array, each `{ id, name, mimetype, size }`. Pass `files[].id` to `download_slack_file`. (Omitted in `concise` format.) The file `name` is attacker-controlled and is returned inside an `<untrusted-content>` envelope.

#### `get_slack_message_by_link`
Retrieve a message from its Slack permalink URL. Works with both regular messages and thread replies.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| url | string | Yes | - | Slack message permalink URL |
| include_thread | boolean | No | true | For thread messages, include surrounding thread context |

**Supported URL formats:**
- Standard permalink: `https://workspace.slack.com/archives/C123/p1234567890123456`
- Thread permalink: `https://workspace.slack.com/archives/C123/p1234567890123456?thread_ts=1234567890.123456`
- App URL: `https://app.slack.com/client/T123/C123/p1234567890123456`

**Example request:**
```json
{
  "url": "https://acme.slack.com/archives/C0123456789/p1704067200123456"
}
```

**Example response (non-thread):**
```json
{
  "ok": true,
  "url": "https://acme.slack.com/archives/C0123456789/p1704067200123456",
  "channel": "C0123456789",
  "is_thread_reply": false,
  "message": {
    "ts": "1704067200.123456",
    "user": "U0123456789",
    "text": "Hello world!",
    "files": [
      { "id": "F0B9H50NZGD", "name": "<untrusted-content source=\"slack:file-name\">diagram.png</untrusted-content>", "mimetype": "image/png", "size": 147000 }
    ]
  },
  "thread_ts": null,
  "reply_count": 0
}
```

**Attachments:** Messages (and each `thread_context` item) include a `files[]` array when the underlying Slack message has attachments — each `{ id, name, mimetype, size }`. Pass `files[].id` to `download_slack_file`. Omitted when the message has no files. The file `name` is attacker-controlled and is wrapped in an `<untrusted-content>` envelope. When the linked message is a thread **parent**, the response carries `reply_count` (not the replies themselves); call `get_slack_thread_replies` with the parent `ts` to read them.

**Example response (thread reply with context):**
```json
{
  "ok": true,
  "url": "https://acme.slack.com/archives/C0123456789/p1704067260123456?thread_ts=1704067200.123456",
  "channel": "C0123456789",
  "is_thread_reply": true,
  "thread_ts": "1704067200.123456",
  "message": {
    "ts": "1704067260.123456",
    "user": "U9876543210",
    "text": "This is a reply!"
  },
  "thread_context": [
    { "ts": "1704067200.123456", "user": "U0123456789", "text": "Hello world!" },
    { "ts": "1704067260.123456", "user": "U9876543210", "text": "This is a reply!" }
  ]
}
```

**Notes:**
- Bot must be a member of the channel (or it's a public channel and user token is available)
- For large threads, only the first ~500 messages are searched (5 pages × 100 messages)

#### `post_slack_message`
Post a message to a channel as yourself. Messages are visible immediately.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID or #channel-name |
| text | string | Yes | - | Message text (supports Slack markdown) |

**Requires user authorization**: Messages appear from your Slack account and are editable by you. If user token is unavailable, the operation fails with guidance to reconnect Slack.

**Slack markdown:**
- `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``
- Links: `<https://example.com|Link text>`
- Mentions: `<@U1234567890>` or `<!channel>`

#### `reply_to_slack_thread`
Reply to an existing message thread as yourself.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID or #channel-name |
| thread_ts | string | Yes | - | Parent message timestamp |
| text | string | Yes | - | Reply text |

**Requires user authorization**: Replies appear from your Slack account and are editable by you.

#### `get_slack_thread_replies`
Get all replies in a message thread.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID or #channel-name |
| ts | string | Yes | - | Parent message timestamp |
| limit | number | No | 20 | Max replies to return |
| cursor | string | No | - | Pagination cursor |

**Attachments:** Each reply includes a `files[]` array when it has attachments — `{ id, name, mimetype, size }`; pass `files[].id` to `download_slack_file`. Omitted when a reply has no files. The file `name` is wrapped in an `<untrusted-content>` envelope.

#### `add_slack_reaction`
Add an emoji reaction to a message as yourself.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID or #channel-name |
| timestamp | string | Yes | - | Message timestamp |
| name | string | Yes | - | Emoji name (without colons) |

**Requires user authorization**: Reactions appear from your Slack account.

**Common reactions:** `thumbsup`, `thumbsdown`, `heart`, `eyes`, `white_check_mark`, `x`

#### `get_slack_unread_messages`
Get unread messages in a channel based on your personal read cursor.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID or #channel-name |
| limit | number | No | 50 | Max messages to return (max 100) |
| includePrivate | boolean | No | false | Allow access to private channels/DMs |

**Notes:**
- Uses your personal read cursor from Slack (not bot's)
- For private channels/DMs, set `includePrivate: true`
- Falls back to recent messages if unread tracking unavailable

**Example response:**
```json
{
  "ok": true,
  "channel": "C1234567890",
  "channelName": "general",
  "unreadCount": 5,
  "messages": [...],
  "lastRead": "1704067200.123456",
  "hasMore": false
}
```

#### `mark_slack_channel_as_read`
Mark messages in a channel as read up to a specific timestamp.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID (C... or D...) or #channel-name |
| ts | string | Yes | - | Timestamp to mark as read up to (from message `ts` field) |
| includePrivate | boolean | No | false | Allow marking private channels/DMs |

**Notes:**
- Requires user authorization (updates YOUR read position, not bot's)
- For DMs, use `open_slack_dm` to get the channel ID first
- For private channels/DMs, set `includePrivate: true`

**Example:**
```json
{
  "channel": "#general",
  "ts": "1704067200.123456",
  "includePrivate": false
}
```

**Example response:**
```json
{
  "ok": true,
  "message": "Marked channel as read up to 1704067200.123456",
  "channel": "C1234567890",
  "markedAt": "1704067200.123456"
}
```

### File Operations

#### `download_slack_file`
Download a file attachment from Slack by its file ID or permalink URL.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| file_id | string | No* | - | Slack file ID (e.g., F1234567890). Found in message `files` array. |
| file_url | string | No* | - | Slack file permalink URL. Alternative to file_id - extracts the F... ID automatically. |
| max_size_mb | number | No | 10 | Maximum file size in MB to download (max: 50) |

*Either `file_id` or `file_url` is required.

**Example request:**
```json
{
  "file_id": "F0123456789"
}
```

**Example response (binary file):**
```json
{
  "ok": true,
  "file": {
    "id": "F0123456789",
    "name": "screenshot.png",
    "mimetype": "image/png",
    "filetype": "png",
    "size": 12345,
    "created": 1704067200,
    "permalink": "https://workspace.slack.com/files/U123/F0123456789/screenshot.png"
  },
  "content": "iVBORw0KGgoAAAANSUhEUgAA...",
  "encoding": "base64",
  "size_bytes": 12345
}
```

**Example response (text file):**
```json
{
  "ok": true,
  "file": {
    "id": "F0123456789",
    "name": "notes.txt",
    "mimetype": "text/plain",
    "filetype": "txt",
    "size": 256,
    "created": 1704067200,
    "permalink": "https://workspace.slack.com/files/U123/F0123456789/notes.txt"
  },
  "content": "Meeting notes from today...",
  "encoding": "utf-8",
  "size_bytes": 256
}
```

**Notes:**
- **Finding file IDs**: Use `get_slack_channel_history` with `response_format: 'detailed'` - messages with attachments include a `files` array containing `id`, `name`, `mimetype`, and `size` for each file.
- **Binary vs text**: Binary files (images, PDFs, etc.) are returned as base64-encoded content. Text files (txt, json, md, csv, etc.) are returned as UTF-8 plain text.
- **Size limits**: Default 10MB limit prevents timeout/memory issues. Increase `max_size_mb` up to 50 for larger files.
- **External files**: Files from external services (Google Drive, Dropbox) cannot be downloaded directly - the tool will return an error with a hint.
- **Requires `files:read` scope**: If you see "Missing required Slack permissions" error, reconnect Slack in Settings → Integrations to grant the new scope.

### Channel Operations

#### `invite_user_to_channel`
Add one or more users to a Slack channel. Supports bulk onboarding.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID or #channel-name |
| users | string | Yes | - | User ID(s) - single or comma-separated (max 1000) |
| force | boolean | No | true | Continue inviting valid users even if some fail |

**Example:**
```json
{
  "channel": "#onboarding",
  "users": "U123,U456,U789"
}
```

**Notes:**
- Use `lookup_user_by_email` first to resolve emails to user IDs
- When `force=true`, partial failures are returned in `partial_failures` field
- You must be a member of the channel to invite others
- Requires `channels:manage` (public) or `groups:manage` (private) scope

#### `create_slack_channel`
Create a new public or private Slack channel.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | string | Yes | - | Channel name (auto-lowercased) |
| is_private | boolean | No | false | Create as private channel |

**Example:**
```json
{
  "name": "project-alpha",
  "is_private": false
}
```

**Notes:**
- Names can only contain lowercase letters, numbers, hyphens, and underscores
- Max ~80 characters
- Archived channels also reserve their names (`name_taken` error)
- Requires `channels:manage` (public) or `groups:manage` (private) scope

#### `list_slack_channels`
List all channels the bot has access to.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| limit | number | No | 100 | Max channels to return |
| types | string | No | 'public_channel' | Channel types (comma-separated) |
| cursor | string | No | - | Pagination cursor |
| channel_name | string | No | - | Filter channels by name (case-insensitive partial match, current page only) |
| response_format | string | No | 'detailed' | 'concise' (id, name) or 'detailed' (adds is_private, num_members, topic, purpose) |

**Channel types:** `public_channel`, `private_channel`, `mpim`, `im`

### User Operations

#### `lookup_user_by_email`
Find a Slack user by their email address. Essential for bulk onboarding from spreadsheets.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Email address to look up |

**Example:**
```json
{
  "email": "[external-email]"
}
```

**Example response:**
```json
{
  "ok": true,
  "user": {
    "id": "U0123456789",
    "name": "alice",
    "real_name": "Alice Smith",
    "display_name": "Alice",
    "email": "[external-email]"
  }
}
```

**Notes:**
- Returns `users_not_found` for deactivated users
- Requires `users:read.email` scope (may require admin approval in some workspaces)

**WORKFLOW - Bulk onboarding:**
1. For each email in your list, call `lookup_user_by_email`
2. Collect the user IDs from successful lookups
3. Call `invite_user_to_channel` with comma-separated user IDs

#### `list_slack_users`
List all users in the workspace.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| limit | number | No | 100 | Max users to return |
| cursor | string | No | - | Pagination cursor |
| name | string | No | - | Filter users by name, display_name, or real_name (case-insensitive partial match, current page only) |
| response_format | string | No | 'detailed' | 'concise' (id, name, display_name) or 'detailed' (adds real_name, email, is_admin) |

Returns active (non-bot, non-deleted) users with ID, name, display name, email, and admin status.

#### `get_slack_user_profile`
Get detailed profile for a specific user.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| user | string | Yes | - | User ID or @username |

**User input formats:**
- User ID: `U1234567890`
- Username: `@john`
- Slack rich format: `<@U1234567890>`

#### `open_slack_dm`
Open or get the DM channel with a user by username or user ID.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| user | string | Yes | - | Username (@john), display name, real name, or user ID |

**Notes:**
- Use this to get a DM channel ID before reading/sending DM messages
- Does NOT send a notification to the other user
- Creates the DM conversation if it doesn't exist
- Requires user authorization

**User input formats:**
- Username: `@john.doe` or `john.doe`
- Display name: `John D.`
- Real name: `John Doe`
- User ID: `U1234567890`
- Slack rich format: `<@U1234567890>` or `<@U1234567890|john>`

**Example:**
```json
{
  "user": "@john.doe"
}
```

**Example response:**
```json
{
  "ok": true,
  "channelId": "D0123456789",
  "userId": "U1234567890",
  "isNew": false,
  "message": "Existing DM channel: D0123456789"
}
```

**Workflow for reading DM messages:**
1. Call `open_slack_dm` with the user's name/ID
2. Use the returned `channelId` with `get_slack_unread_messages` (set `includePrivate: true`)
3. Optionally call `mark_slack_channel_as_read` with the same channel ID

### Automation Operations

#### `schedule_slack_message`
Schedule a message to be posted at a future time.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID or #channel-name |
| text | string | Yes | - | Message text |
| post_at | number | Yes | - | Unix timestamp IN SECONDS (not ms) |

**Example:**
```json
{
  "channel": "#announcements",
  "text": "Good morning team!",
  "post_at": 1704110400
}
```

**Notes:**
- `post_at` must be in **seconds** (not milliseconds) - common mistake!
- Max 30 scheduled messages per channel per 5 minutes
- Max 120 days in the future
- Requires `chat:write` scope (already included)

#### `add_slack_bookmark`
Add a bookmark link to a channel's header.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| channel | string | Yes | - | Channel ID |
| title | string | Yes | - | Bookmark title |
| link | string | Yes | - | URL to bookmark |
| emoji | string | No | - | Optional emoji for the bookmark |

**Example:**
```json
{
  "channel": "C0123456789",
  "title": "Project Wiki",
  "link": "https://wiki.company.com/project-alpha",
  "emoji": ":book:"
}
```

**Notes:**
- Max 100 bookmarks per channel
- Requires `bookmarks:write` scope

#### `add_slack_reminder` [EXPERIMENTAL]
Create a reminder for yourself. **Note: Slack's reminders API is on a deprecation path and may become unreliable.**

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| text | string | Yes | - | Reminder text |
| time | string | Yes | - | When to remind (Unix timestamp or natural language) |

**Example:**
```json
{
  "text": "Follow up with client",
  "time": "in 2 hours"
}
```

**Notes:**
- Slack changed reminders behavior in March 2023 ("Save it for Later" rollout)
- May return `method_deprecated` in the future
- Requires `reminders:write` scope

## Rate Limiting

### Current Rate Limit Tiers

Slack API methods are assigned to tiers with different request limits:

| Tier | Limit | Example Methods |
|------|-------|-----------------|
| Tier 1 | 1+ req/min | (varies) |
| Tier 2 | 20+ req/min | `search.messages` |
| Tier 3 | 50+ req/min | `conversations.history`, `conversations.replies` |
| Tier 4 | 100+ req/min | (varies) |

### CRITICAL: May 2025 Policy Change for Non-Marketplace Apps

As of **May 29, 2025**, Slack introduced severe rate limit reductions for commercially distributed apps that are NOT in the Slack App Directory (Marketplace):

| API Method | Marketplace Apps | Non-Marketplace Commercial |
|------------|------------------|---------------------------|
| `conversations.history` | Tier 3 (50+/min, 1000 msgs) | **Tier 1 (1/min, 15 msgs)** |
| `conversations.replies` | Tier 3 (50+/min, 1000 msgs) | **Tier 1 (1/min, 15 msgs)** |
| `search.messages` | Tier 2 (20+/min) | Tier 2 (unchanged) |

**Timeline:**
- New apps/new installs: Affected NOW (May 29, 2025)
- Existing installs: Affected **March 3, 2026**

**Exemptions** (keep Tier 3 limits):
- Apps approved for **Slack App Directory** (Marketplace)
- **Internal customer-built apps** (users create their own Slack app)

**Impact**: Without Marketplace approval, users are limited to **15 messages per minute** when reading channel history - essentially unusable for real productivity workflows.

**Sources:**
- [Slack Rate Limits Documentation](https://docs.slack.dev/apis/web-api/rate-limits/)
- [May 2025 Policy Changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps)

### Error Handling

The MCP implements intelligent rate limit handling:

```typescript
// When Slack returns rate limit error
{
  "ok": false,
  "error": "Rate limited by Slack API",
  "retryAfter": 30,
  "resolution": "Please wait 30 seconds before retrying. Slack limits API requests to prevent abuse."
}
```

Rate limits are detected via:
- Error code `slack_webapi_rate_limited`
- Response `error: 'ratelimited'`

The `retryAfter` field (when available) indicates seconds to wait.

## Slack App Directory (Marketplace) Submission

### Why Submit to Marketplace?

1. **Higher rate limits** - Preserve Tier 3 limits for `conversations.history` and `conversations.replies`
2. **User trust** - Verified badge, security compliance info visible to users
3. **Discoverability** - Users can find and install from Slack's app directory
4. **Enterprise compatibility** - Some workspaces only allow Marketplace-approved apps

### Submission Requirements

Per [Slack Marketplace Guidelines](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements):

1. **Minimum 5 active workspace installations** (in last 28 days)
2. **Security review** by Slack's team (automated scans + manual vulnerability testing)
3. **Compliance** with App Developer Policy & Marketplace Agreement
4. **Manual review** - Slack staff install and test the app, review listing info, audit data access
5. **Listing assets** - App icon, description, screenshots, Privacy Policy URL, Terms of Service URL

### Review Timeline

**Official guidance**: Plan for **"several weeks"** - review cannot be expedited. Actual estimated turnaround shown on submission page in app settings.

**Developer experiences**: 1-3 weeks typical; simple apps sometimes <1 week; complex apps or those with security feedback may take longer.

**Iteration risk**: If feedback is provided, must address and resubmit. Config changes after approval require re-review.

**Estimate for Rebel's Slack MCP**: ~2-4 weeks assuming no major feedback (relatively simple OAuth integration).

### Apps NOT Accepted

- Apps that export/backup message data as primary purpose
- Apps lacking functionality within Slack
- Apps that replicate Slack client features
- Apps that share sensitive personal information
- Apps requesting excessive permissions

### Current Status

**TODO**: Check [api.slack.com/apps](https://api.slack.com/apps) for:
- Current app submission status
- Whether review has been initiated
- Any pending feedback from Slack

### Alternative: User-Configured Apps

If Marketplace approval is delayed, users can create their own Slack app:
1. User creates app at api.slack.com/apps
2. User provides their own Client ID/Secret
3. App is classified as "internal customer-built" (exempt from rate limits)

This requires more user setup but sidesteps commercial distribution limits.

## Known Limitations

1. **CRITICAL: Rate limits for non-Marketplace apps**: As of May 2025, Slack severely restricts `conversations.history` and `conversations.replies` to 1 request/min with 15 messages max for commercially distributed apps not in the Slack App Directory. See [Rate Limiting](#critical-may-2025-policy-change-for-non-marketplace-apps) section for details and mitigation options.

2. **Search requires user token**: The `search_slack_messages` tool requires OAuth with the `search:read` scope, which grants a user token. If only a bot token is available, search will fail with a helpful error suggesting `get_slack_channel_history` as an alternative.

3. **Channel access**: The bot can only access channels it has been invited to or public channels. Private channel access requires explicit invitation.

4. **Rate limits**: Heavy use may hit Slack's API rate limits. The MCP handles this gracefully with retry guidance.

5. **Workspace scope**: Tools operate within a single connected workspace. Multi-workspace support requires connecting each workspace separately.

6. **Message history limits**: Free Slack workspaces have 90-day message history limits. The MCP can only access messages within Slack's retention policy.

7. **File downloads require `files:read` scope**: The `download_slack_file` tool requires the `files:read` OAuth scope. Users who connected Slack before this feature was added will need to reconnect Slack (Settings → Integrations) to grant the new scope.

8. **No write API for "Save for Later"**: Slack deprecated the `stars.*` APIs in 2023 and has not shipped a replacement write API. The `get_slack_saved_messages` tool can **read** saved items (via `search.messages` with `is:saved`), but there is no way to programmatically save a message to "Later." The old `stars.add` still accepts calls but no longer affects the UI.

## Troubleshooting

### "Slack not connected" Error
**Cause:** No valid bot token available.
**Solution:** Call `list_slack_workspaces` to check connection status. If not connected, direct user to Settings → Connectors to connect Slack.

### Search Returns Error
**Cause:** User token not available (requires `search:read` scope).
**Solution:** User may need to reconnect Slack to grant search permissions. Alternatively, use `get_slack_channel_history` to read messages from specific channels.

### "Channel not found" Error
**Cause:** Invalid channel name or bot not in channel.
**Solution:**
1. Use `list_slack_channels` to see available channels
2. Verify channel name spelling (case-insensitive)
3. For private channels, ensure bot has been invited

### "User not found" Error
**Cause:** Invalid username or user ID.
**Solution:** Use `list_slack_users` to find valid user IDs.

### Rate Limit Errors
**Cause:** Too many API requests in short period.
**Solution:** Wait for `retryAfter` seconds (shown in error), then retry.

### Token Expired / Invalid
**Cause:** OAuth token has been revoked or expired.
**Solution:** Reconnect Slack workspace in Settings → Connectors.

### "Missing required Slack permissions" Error
**Cause:** New tools (like `mark_slack_channel_as_read` or `open_slack_dm`) require OAuth scopes that weren't included when the user originally connected Slack.
**Solution:** Re-authenticate Slack in Settings → Integrations → Slack to grant the new permissions. This happens automatically when Slack is reconnected.

## Development

### Building
```bash
cd resources/mcp/slack
npm install
npm run build
```

### Testing Locally
1. Run `npm run dev` in main project
2. Connect a Slack workspace via Settings → Connectors
3. Use Rebel to interact with Slack

### Adding New Tools
1. Add tool schema to `tools` array in `index.ts`
2. Add handler case in `handleToolCall()` switch statement
3. Run `npm run build`
