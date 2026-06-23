---
description: "Microsoft 365 MCPs (Outlook Mail, Calendar, OneDrive, Teams, SharePoint) — five separate rebel-oss MCP packages sharing OAuth authentication"
last_updated: "2026-05-22"
status: active
---

# Microsoft 365 MCP

The Microsoft 365 MCPs provide Outlook Mail, Calendar, OneDrive (Files), Teams, and SharePoint integration for Rebel. Five separate `rebel-oss` MCP packages share authentication and require OAuth setup. A separate **Office** connector (`bundled-office`, `provider: "rebel-oss"`) handles Word/Excel/PowerPoint via `@mindstone/mcp-server-office@0.2.0`.

> **v0.4.41 migration:** The five Microsoft 365 services now use `provider: "rebel-oss"` catalog entries. Bundled-manager fallback paths were removed, but per-account instance migration is preserved across desktop and cloud.

| | |
|---|---|
| **Status** | Active — migrated to `rebel-oss` in v0.4.41 |
| **Provider** | `rebel-oss` (Mail, Calendar, Files, Teams, SharePoint — five separate npm packages) |
| **Auth** | OAuth 2.0 with PKCE |
| **API** | Microsoft Graph API v1.0 |

## See Also

- [MCP_OSS_CONNECTORS.md](../MCP_OSS_CONNECTORS.md) — OSS connector architecture and migration batch
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Development workflow for MCP improvements
- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup, discovery, and troubleshooting
- [ONBOARDING_SETUP_WIZARD.md](../ONBOARDING_SETUP_WIZARD.md) - OAuth connector setup during onboarding
- [GOOGLE_WORKSPACE_MCP.md](GOOGLE_WORKSPACE_MCP.md) - Similar multi-service MCP pattern
- Host catalog: `resources/connector-catalog.json` (`bundled-microsoft-*`, `bundled-office`)
- OSS packages: `@mindstone/mcp-server-microsoft-{mail,calendar,files,teams,sharepoint}@0.1.1`; `@mindstone/mcp-server-office@0.2.0`

## Architecture

Unlike Google Workspace (single MCP), Microsoft 365 is split into **five separate MCP packages** that share authentication:

```
resources/connector-catalog.json
├── bundled-microsoft-mail        → @mindstone/mcp-server-microsoft-mail@0.1.1
├── bundled-microsoft-calendar    → @mindstone/mcp-server-microsoft-calendar@0.1.1
├── bundled-microsoft-files       → @mindstone/mcp-server-microsoft-files@0.1.1
├── bundled-microsoft-teams       → @mindstone/mcp-server-microsoft-teams@0.1.1
├── bundled-microsoft-sharepoint  → @mindstone/mcp-server-microsoft-sharepoint@0.1.1
└── bundled-office                → @mindstone/mcp-server-office@0.2.0 (Word/Excel/PowerPoint)
```

**Why five MCPs instead of one?**
- **Modular loading**: Services can be enabled/disabled independently
- **Cleaner Super-MCP package descriptions**: Each package has focused capabilities
- **Error isolation**: Issues in one service don't affect others

All five Microsoft Graph packages share the same authentication via the host-side `microsoftApi` orchestrator and the `microsoft-mcp/` token store, so connecting once enables Mail, Calendar, Files, and Teams. SharePoint requires additional permissions via incremental consent (see [SharePoint Tools](#sharepoint-tools) below).

The host still builds per-account Super-MCP entries (`Microsoft365Mail-<email-slug>`, `Microsoft365Calendar-<email-slug>`, etc.) from `src/main/services/bundledMcpManager.ts`, but those entries now spawn the catalog-pinned npm packages instead of bundled `resources/mcp/microsoft-*` scripts. Cloud migration rewrites managed-install paths back to npx form while preserving the same account identity and token directory.

## OAuth Setup

Microsoft 365 OAuth is configured during onboarding or via Settings > Connectors.

### OAuth Flow

1. User clicks "Connect Microsoft" in Settings > Connectors (any of the 5 Microsoft services)
2. System browser opens Microsoft OAuth consent page
3. User signs in and grants permissions
4. Cloudflare redirects to `mindstone://microsoft/callback` with authorization code
5. App exchanges code for tokens using PKCE
6. Tokens stored in `~/.rebel/microsoft-mcp/credentials/<email>.token.json`
7. All five MCPs become available immediately (SharePoint tools require additional consent — see below)

### Required Scopes

**Base scopes** (requested during initial Microsoft connection):

```
offline_access       # Required for refresh tokens
User.Read            # Get user profile/email
Mail.Read            # Read emails
Mail.Send            # Send emails
Mail.ReadWrite       # Drafts, delete, move
Calendars.ReadWrite  # Full calendar access
Files.ReadWrite      # OneDrive access
Chat.Read            # Read Teams chats
Chat.ReadWrite       # Send Teams messages
Presence.Read        # Teams presence status
```

**SharePoint scopes** (requested via incremental consent when user enables SharePoint):

```
Sites.Read.All       # Read all SharePoint site collections
Sites.ReadWrite.All  # Write to SharePoint sites (future use)
Notes.Read.All       # Read OneNote notebooks
Notes.ReadWrite.All  # Write to OneNote notebooks (future use)
```

> **Admin consent required**: `Sites.*` and `Notes.*` scopes require administrator approval in most enterprise tenants. Users in managed organizations will see an "admin approval required" prompt and must contact their IT administrator. These scopes are not requested during the initial Microsoft connection — they are requested separately via incremental consent when the user enables SharePoint.

### Token Storage

```
~/.rebel/microsoft-mcp/
├── accounts.json              # Account metadata (email, displayName)
└── credentials/
    └── <sanitized-email>.token.json  # Per-account tokens
```

Tokens are automatically refreshed by the MCP when expired (5-minute buffer).

---

## Mail Tools

Server name: `Microsoft365Mail`

### authenticate_microsoft_account

Connect a Microsoft 365 account. Opens browser for OAuth.

**Parameters:** None

**When to call:**
- Other Microsoft tools return authentication errors
- User asks to connect Microsoft 365

### list_emails

List emails from inbox or a specific folder.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| folder | string | No | Inbox | Folder name or ID |
| top | number | No | 25 | Number of emails (max 100) |
| filter | string | No | - | OData filter (e.g., `isRead eq false`) |

**Example filters:**
- `isRead eq false` - Unread only
- `hasAttachments eq true` - With attachments
- `importance eq 'high'` - High importance

### get_email

Get full email content including body.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Email message ID |

### send_email

Send a new email message.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| to | string[] | Yes | - | Recipient email addresses |
| subject | string | Yes | - | Email subject |
| body | string | Yes | - | Email body (HTML supported) |
| cc | string[] | No | - | CC recipients |
| importance | string | No | normal | low, normal, or high |

### search_emails

Search emails using Microsoft Search query syntax.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| query | string | Yes | - | Search query |
| top | number | No | 25 | Max results |

**Example queries:**
- `from:john subject:meeting`
- `hasAttachment:true`
- `received:today`

### reply_to_email

Reply to an email message.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | - | Original message ID |
| body | string | Yes | - | Reply body (HTML supported) |
| replyAll | boolean | No | false | Reply to all recipients |

### forward_email

Forward an email to other recipients.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Message ID to forward |
| to | string[] | Yes | Recipients to forward to |
| comment | string | No | Optional comment to add |

### delete_email

Delete or move an email to trash.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | - | Message ID |
| permanent | boolean | No | false | Permanently delete vs move to Deleted Items |

### list_folders

List mail folders (Inbox, Sent, Drafts, etc.).

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| includeHidden | boolean | No | false | Include hidden folders |

### move_email

Move an email to a different folder.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Message ID |
| destinationFolder | string | Yes | Destination folder name or ID |

### create_draft

Create a draft email (saved but not sent).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| to | string[] | No | Recipients |
| subject | string | Yes | Subject |
| body | string | Yes | Body (HTML supported) |
| cc | string[] | No | CC recipients |

---

## Calendar Tools

Server name: `Microsoft365Calendar`

### list_events

List calendar events within a date range.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| startDateTime | string | No | now | Start date/time (ISO format) |
| endDateTime | string | No | +7 days | End date/time (ISO format) |
| calendarId | string | No | primary | Calendar ID |
| top | number | No | 50 | Max events to return |

### get_event

Get detailed information about a specific event.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Event ID |

### create_event

Create a new calendar event.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| subject | string | Yes | - | Event title |
| start | string | Yes | - | Start date/time (ISO format) |
| end | string | Yes | - | End date/time (ISO format) |
| location | string | No | - | Event location |
| body | string | No | - | Description (HTML supported) |
| attendees | string[] | No | - | Attendee emails |
| isOnlineMeeting | boolean | No | false | Create Teams meeting link |
| isAllDay | boolean | No | false | All-day event |

**Example:**
```json
{
  "subject": "Project Review",
  "start": "2025-01-15T14:00:00",
  "end": "2025-01-15T15:00:00",
  "attendees": ["[external-email]", "[external-email]"],
  "isOnlineMeeting": true
}
```

### update_event

Update an existing calendar event.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Event ID |
| subject | string | No | New title |
| start | string | No | New start time |
| end | string | No | New end time |
| location | string | No | New location |
| body | string | No | New description |

### delete_event

Delete a calendar event.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | - | Event ID |
| notifyAttendees | boolean | No | true | Send cancellation to attendees |

### respond_to_event

Accept, decline, or tentatively accept an event invitation.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | - | Event ID |
| response | string | Yes | - | accept, decline, or tentative |
| comment | string | No | - | Response message |
| sendResponse | boolean | No | true | Send response to organizer |

### get_free_busy

Check availability/free-busy status for users.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| emails | string[] | Yes | Email addresses to check |
| startDateTime | string | Yes | Start of time range (ISO) |
| endDateTime | string | Yes | End of time range (ISO) |

### list_calendars

List all calendars the user has access to.

**Parameters:** None

---

## Files Tools (OneDrive)

Server name: `Microsoft365Files`

### list_files

List files and folders in OneDrive.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| path | string | No | root | Folder path (e.g., `/Documents`) or item ID |
| top | number | No | 50 | Max items to return |

### get_file

Get metadata for a specific file or folder.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| path | string | Yes | File path or item ID |

### download_file

Get a download URL for a file (valid for short period).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| path | string | Yes | File path or item ID |

### search_files

Search for files in OneDrive by name or content.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| query | string | Yes | - | Search query |
| top | number | No | 25 | Max results |

### read_text_file

Read the contents of a text file directly.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| path | string | Yes | - | File path or ID |
| maxSize | number | No | 100KB | Max bytes to read |

### upload_file

Upload a file to OneDrive (text content only, max 4MB).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| path | string | Yes | Destination path including filename |
| content | string | Yes | File content (text) |

### create_folder

Create a new folder in OneDrive.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| path | string | Yes | Full path for new folder |

### delete_file

Delete a file or folder from OneDrive.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| path | string | Yes | File/folder path or item ID |

### move_file

Move a file or folder to a new location.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| sourcePath | string | Yes | Current file/folder path or ID |
| destinationPath | string | Yes | New parent folder path |
| newName | string | No | Optional new name |

### copy_file

Copy a file or folder to a new location.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| sourcePath | string | Yes | Current file/folder path or ID |
| destinationPath | string | Yes | Destination folder path |
| newName | string | No | Optional new name |

### get_recent

Get recently accessed files.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| top | number | No | 25 | Max items |

### get_shared

Get files shared with you by others.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| top | number | No | 25 | Max items |

### share_file

Create a sharing link for a file or folder.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| path | string | Yes | - | File/folder path or ID |
| type | string | No | view | view or edit |
| scope | string | No | organization | anonymous or organization |

---

## Teams Tools

Server name: `Microsoft365Teams`

### list_chats

List your recent Teams chats (1:1 and group chats).

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| top | number | No | 25 | Max chats to return |

### get_chat

Get details about a specific chat.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| chatId | string | Yes | Chat ID |

### list_chat_messages

Get recent messages from a chat.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| chatId | string | Yes | - | Chat ID |
| top | number | No | 50 | Max messages |

### send_chat_message

Send a message to a chat.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| chatId | string | Yes | Chat ID |
| content | string | Yes | Message content (HTML supported) |

### list_teams

List Teams you are a member of.

**Parameters:** None

### list_channels

List channels in a Team.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| teamId | string | Yes | Team ID |

### get_presence

Get your current presence status (available, busy, away, etc.).

**Parameters:** None

---

## SharePoint Tools

Server name: `Microsoft365SharePoint`

SharePoint tools provide read-only access to SharePoint sites and document libraries. Unlike the other Microsoft MCPs, SharePoint requires **incremental consent** — users must explicitly grant SharePoint permissions via the `authenticate_sharepoint` tool after their initial Microsoft connection.

> **Admin consent required**: In most enterprise tenants, SharePoint scopes (`Sites.Read.All`) require administrator approval. Users will be guided to contact their IT admin if consent is denied.

### authenticate_sharepoint

Request SharePoint permissions via incremental consent. Opens browser for the user (or admin) to approve additional scopes.

**Parameters:** None

**When to call:**
- Other SharePoint tools return "SharePoint permissions not granted"
- User asks to access SharePoint sites or document libraries

### list_sharepoint_sites

Search or list SharePoint sites the user has access to.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| query | string | No | - | Search query to filter sites |
| top | number | No | 25 | Max sites to return |

### get_sharepoint_site

Get details about a specific SharePoint site.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| siteId | string | Yes | Site ID or hostname path (e.g., `contoso.sharepoint.com:/sites/team`) |

### list_site_document_libraries

List document libraries in a SharePoint site.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| siteId | string | Yes | SharePoint site ID |

### list_library_files

List files and folders in a SharePoint document library.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| driveId | string | Yes | - | Document library (drive) ID |
| path | string | No | root | Folder path within the library (e.g., "General/Reports") |
| top | number | No | 50 | Max items to return |

### get_library_file

Get metadata for a specific file in a document library.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| driveId | string | Yes | Document library (drive) ID |
| itemId | string | Yes | File item ID |

### download_library_file

Get a download URL for a file in a document library (valid for short period).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| driveId | string | Yes | Document library (drive) ID |
| itemId | string | Yes | File item ID |

### search_library_files

Search for files within a SharePoint document library.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| driveId | string | Yes | - | Document library (drive) ID |
| query | string | Yes | - | Search query |
| top | number | No | 25 | Max results |

### read_library_text_file

Read the contents of a text file directly from a document library.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| driveId | string | Yes | - | Document library (drive) ID |
| itemId | string | Yes | - | File item ID |
| maxSize | number | No | 100KB | Max bytes to read |

**Supported text file types:** `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.css`, `.js`, `.ts`, `.py`, `.yml`, `.yaml`, `.log`, `.cfg`, `.ini`, `.env`, `.sh`, `.bat`, `.ps1`, `.sql`, `.r`, `.swift`

---

## Response Format

All tools return JSON responses by default. Example email list response:

```json
{
  "emails": [
    {
      "id": "AAMkAGI2...",
      "subject": "Project Update",
      "from": { "emailAddress": { "address": "[external-email]", "name": "Alice" } },
      "receivedDateTime": "2025-01-10T09:14:32Z",
      "bodyPreview": "Hi, here's the latest update on..."
    }
  ],
  "count": 25
}
```

---

## Troubleshooting

### "No Microsoft token found" / Authentication errors

User hasn't connected a Microsoft account. Direct to Settings > Connectors and click any Microsoft service to start OAuth.

### "Token expired and refresh failed"

Refresh token is invalid (user may have revoked access). User needs to reconnect:
1. Settings > Connectors
2. Remove the Microsoft account
3. Reconnect via OAuth

### Teams operations return 403 / Authorization errors

Some Teams operations require admin consent in enterprise tenants. The error message will include this note. Contact the IT admin to grant application permissions.

### "Some features may differ by account type"

Personal Microsoft accounts (outlook.com, hotmail.com) may have limited access compared to Microsoft 365 work/school accounts. For example:
- Teams may not be available on personal accounts
- Some calendar features require Exchange Online

### SharePoint admin consent required

When users see "admin approval required" or "AADSTS65001" errors when connecting SharePoint:

1. SharePoint scopes (`Sites.Read.All`) require administrator approval in most enterprise tenants
2. The user should contact their IT administrator and request consent for the Mindstone Rebel app
3. The admin can grant tenant-wide consent in Azure Portal > Enterprise Applications > Mindstone Rebel > Permissions
4. Once admin consent is granted, the user can retry by calling `authenticate_sharepoint` again
5. Personal Microsoft accounts (outlook.com, hotmail.com) may not have access to SharePoint at all

### SharePoint scope missing after auth

When SharePoint tools return "SharePoint permissions not granted" even after completing the consent flow:

1. The consent may have been denied or cancelled — ask the user to try `authenticate_sharepoint` again
2. Check that the user approved **all** requested permissions in the Microsoft consent dialog (not just some)
3. The Azure app registration may not include `Sites.Read.All` as a delegated permission — this is a configuration prerequisite
4. If the user's organization recently changed consent policies, previously-granted scopes may have been revoked
5. As a last resort, remove and reconnect the entire Microsoft account from Settings > Connectors

### Calendar events not syncing

Check that the calendar permissions were granted during OAuth. If issues persist, remove and reconnect the account.

### OneDrive file operations fail

Verify the path syntax:
- Paths start with `/` (e.g., `/Documents/report.docx`)
- Use forward slashes, not backslashes
- File IDs can be used instead of paths

---

## Development

### Building

The Microsoft 365 connectors now build and publish from the `mindstone/mcp-servers` repo. Rebel consumes exact catalog pins; update them via [MCP_OSS_PACKAGE_MANUAL_UPDATE.md](../MCP_OSS_PACKAGE_MANUAL_UPDATE.md) rather than rebuilding `resources/mcp/microsoft-*` locally.

```bash
# Current catalog pins
@mindstone/mcp-server-microsoft-mail@0.1.1
@mindstone/mcp-server-microsoft-calendar@0.1.1
@mindstone/mcp-server-microsoft-files@0.1.1
@mindstone/mcp-server-microsoft-teams@0.1.1
@mindstone/mcp-server-microsoft-sharepoint@0.1.1
```

### Testing locally

The MCPs run via Super-MCP in stdio mode. To test:
1. Run `npm run dev` in main project
2. Connect a Microsoft account via Settings > Connectors
3. Use Rebel to interact with mail/calendar/files/teams/sharepoint
4. For pre-publish package smoke tests, use the catalog-driven runner described in [MCP_BUNDLED_TO_OSS_MIGRATION.md](../MCP_BUNDLED_TO_OSS_MIGRATION.md#c51-the-catalog-driven-runner--scriptstest-oss-connectorsts)

### Environment variables

Set by the Microsoft `rebel-oss` payload builder in `bundledMcpManager.ts`:

| Variable | Description |
|----------|-------------|
| `MS_CONFIG_DIR` | Path to `~/.rebel/microsoft-mcp/` |
| `MS_CLIENT_ID` | Microsoft OAuth client ID |
| `MS_MCP_PACKAGE_ID` | Per-account instance ID used by the package and host logs |
| `MS_ACCOUNT_EMAIL` | Connected account email for per-account instances |
| `LOG_MODE` | `strict` for host-safe package logging |

### Adding new tools

1. Update the appropriate package in `mindstone/mcp-servers`
2. Run package tests plus the catalog-driven live/smoke checks required by [MCP_BUNDLED_TO_OSS_MIGRATION.md](../MCP_BUNDLED_TO_OSS_MIGRATION.md)
3. Publish the package and bump the exact semver in `resources/connector-catalog.json`
4. Verify reconnect/migration still preserves per-account instances across desktop and cloud

---

## Known Limitations

- **Rate limits**: Microsoft Graph API has per-user quotas. Heavy use may hit limits.
- **Teams channel messages**: Reading/posting to channel messages (vs chats) requires additional permissions not currently requested.
- **Binary file uploads**: `upload_file` only supports text content. Binary files must use the download URL pattern.
- **Personal vs Work accounts**: Some features (Teams, advanced calendar) may not be available on personal Microsoft accounts.
- **SharePoint is read-only**: SharePoint tools support browsing, searching, and reading files from document libraries. Write operations (upload, create, delete) are not currently available. Use OneDrive for file uploads and edits.
- **SharePoint requires admin consent**: In most enterprise tenants, SharePoint scopes require IT administrator approval before users can access SharePoint sites through Rebel.
