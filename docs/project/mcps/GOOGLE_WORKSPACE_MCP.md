---
description: "Google Workspace MCP connector — Gmail, Calendar, Drive, Docs, Slides, Sheets, Contacts tools and host-routed OAuth"
last_updated: "2026-05-19"
---

# Google Workspace MCP

The Google Workspace MCP provides Gmail, Calendar, Drive, Docs, Slides, Sheets, and Contacts integration for Rebel. It is now distributed as the OSS package `@mindstone/mcp-server-google-workspace@0.1.0`; Rebel still owns the host-routed OAuth setup during onboarding.

## See Also

- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Development workflow for MCP improvements
- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup, discovery, and troubleshooting
- [ONBOARDING_SETUP_WIZARD.md](../ONBOARDING_SETUP_WIZARD.md) - OAuth connector setup during onboarding
- [KLAVIS_TO_BUNDLED_MCP_MIGRATION.md](../KLAVIS_TO_BUNDLED_MCP_MIGRATION.md) - Migration from Klavis MCPs
- [260517_google_workspace_mcp_vs_google_official.md](../../research/260517_google_workspace_mcp_vs_google_official.md) - Side-by-side comparison vs Google's official hosted MCPs and the Gemini Workspace Extension (coverage matrix, strengths, gaps, strategic next steps)
- Source code: `mindstone/mcp-servers` → `connectors/google-workspace/` (`@mindstone/mcp-server-google-workspace`)

## Architecture

```
connectors/google-workspace/
├── src/
│   ├── tools/
│   │   ├── definitions.ts      # Tool schemas (what LLM sees)
│   │   ├── server.ts           # MCP server + request routing
│   │   ├── gmail-handlers.ts   # Gmail tool implementations
│   │   ├── calendar-handlers.ts
│   │   ├── drive-handlers.ts
│   │   ├── docs-handlers.ts
│   │   ├── slides-handlers.ts
│   │   ├── sheets-handlers.ts
│   │   └── contacts-handlers.ts
│   ├── modules/
│   │   ├── gmail/services/     # Gmail API wrappers
│   │   ├── calendar/           # Calendar API wrappers
│   │   ├── drive/              # Drive API wrappers
│   │   ├── docs/               # Docs API wrappers
│   │   ├── slides/             # Slides API wrappers
│   │   ├── sheets/             # Sheets API wrappers
│   │   └── contacts/           # People API wrappers
│   └── utils/
│       └── account-manager.ts  # OAuth token management
└── build/                      # Compiled JS (gitignored)
```

## Gmail Tools

### search_workspace_emails
Search emails with Gmail query syntax.

> **Schema Design:** This tool follows [Anthropic's tool design best practices](https://www.anthropic.com/engineering/writing-tools-for-agents) with flat parameters that match LLM expectations.

**Simple Examples:**
```json
{ "query": "from:alice subject:meeting" }
{ "from": "[external-email]", "max_results": 20 }
{ "query": "has:attachment newer_than:7d", "isUnread": true }
```

**Parameters (Flat - Preferred, snake_case per MCP convention):**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | No | - | Account email (optional if single account) |
| query | string | No | - | Gmail search query (e.g., "from:alice subject:meeting has:attachment") |
| max_results | number | No | 10 | Results to return (max 100) |
| from | string/array | No | - | Filter by sender(s) |
| to | string/array | No | - | Filter by recipient(s) |
| subject | string | No | - | Filter by subject |
| after | string | No | - | Emails after date (YYYY-MM-DD) |
| before | string | No | - | Emails before date (YYYY-MM-DD) |
| hasAttachment | boolean | No | - | Filter emails with attachments |
| isUnread | boolean | No | - | Filter by read/unread status |
| labels | array | No | - | Filter by labels (INBOX, SENT, IMPORTANT) |
| page_token | string | No | - | Pagination token from previous response |
| includeBody | boolean | No | false | Include full email body |
| return_json | boolean | No | false | Return JSON instead of formatted text |

**Legacy Parameters (Backwards Compatible):**
The `search` and `options` nested objects are still supported for backwards compatibility but flat parameters are preferred:
- `search.content` → use `query` instead
- `search.from/to/subject` → use flat `from`/`to`/`subject` instead
- `options.max_results` → use flat `max_results` instead
- `max_results` (camelCase) → use `max_results` (snake_case per MCP convention)

**Gmail Query Syntax:**
- `from:alice` - From sender
- `to:bob` - To recipient
- `subject:meeting` - Subject contains
- `has:attachment` - Has attachments
- `is:unread` - Unread emails
- `newer_than:7d` - Last 7 days
- `after:2024-01-01` - After date
- `label:important` - Has label

### get_workspace_email_thread
Fetch full conversation thread by thread ID.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | No | - | Account email (optional if single account) |
| threadId | string | Yes | - | Thread ID from search results |
| maxMessages | number | No | 50 | Max messages to return |
| includeBody | boolean | No | true | Include message bodies |
| return_json | boolean | No | false | Return JSON instead of formatted text |

### send_workspace_email
Send email or reply to existing message.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | No | - | Account email (optional if single account) |
| to | string[] | Yes | - | Array of recipient email addresses |
| subject | string | Yes | - | Email subject |
| body | string | Yes | - | Email body content |
| isHtml | boolean | No | false | Set true only if body contains HTML tags |
| cc | string[] | No | - | Array of CC recipient email addresses |
| bcc | string[] | No | - | Array of BCC recipient email addresses |
| replyToMessageId | string | No | - | Message ID to reply to (auto-threads) |
| attachments | array | No | - | Attachments: `[{ id, name, mimeType, size, content }]` (content is base64-encoded, 25MB limit) |

**Reply behavior:** When `replyToMessageId` is provided, the handler automatically:
1. Fetches the original message's RFC headers
2. Sets `threadId` to keep in same conversation
3. Sets `In-Reply-To` and `References` headers for proper threading

### manage_workspace_draft
Manage Gmail drafts with CRUD operations, sending, and attachment support.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | No | - | Account email (optional if single account) |
| action | string | Yes | - | Operation: `create`, `read`, `update`, `delete`, `send` |
| draftId | string | No | - | Draft ID (required for read/update/delete/send) |
| data | object | No | - | Draft content (required for create/update, see below) |

**Data object (for create/update):**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| to | string[] | Yes | Array of recipient email addresses |
| subject | string | Yes | Email subject |
| body | string | Yes | Email body content |
| isHtml | boolean | No | Set true only if body contains HTML tags (default: false) |
| cc | string[] | No | CC recipients |
| bcc | string[] | No | BCC recipients |
| replyToMessageId | string | No | Message ID to reply to (auto-sets threading headers) |
| attachments | array | No | `[{ id, name, mimeType, size, content }]` (content is base64-encoded, 25MB limit) |
| threadId | string | No | Advanced: explicit thread ID (overrides auto-resolved value) |
| inReplyTo | string | No | Advanced: explicit In-Reply-To header |
| references | string[] | No | Advanced: explicit References header chain |

**Reply threading:** When `replyToMessageId` is provided, the handler automatically resolves threading headers (`threadId`, `In-Reply-To`, `References`). Explicit threading fields override auto-resolved values. If the referenced message cannot be found, the draft is created without threading rather than failing.

## Calendar Tools

### list_workspace_calendars
List all calendars you have access to (your own + shared calendars).

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | No | - | Account email (optional if single account) |

**Response fields:**
| Field | Type | Description |
|-------|------|-------------|
| id | string | Calendar ID - use with `calendarId` parameter in other tools |
| summary | string | Calendar display name |
| primary | boolean | True if this is your main calendar |
| accessRole | string | Your access level: owner, writer, reader, or freeBusyReader |
| canViewEvents | boolean | True if you can see event details (false = free/busy only) |

**Example:**
```json
{ "email": "user@example.com" }
```

**Note:** If `canViewEvents` is false for a calendar, use `find_free_slots` instead - you can only see busy times, not event details.

### find_free_slots
Check availability for yourself and/or others using the Google Calendar Freebusy API.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | No | - | Account email (optional if single account) |
| attendees | string[] | No | - | Email addresses of people to check availability for |
| time_min | string | No | now | Start of time range (ISO date string) |
| time_max | string | No | +7 days | End of time range (ISO date string) |
| minSlotDurationMinutes | number | No | 30 | Minimum duration for free slots |

**Example - Check mutual availability:**
```json
{ "attendees": ["alice@example.com", "bob@example.com"] }
```

**Note:** This returns busy/free time blocks only - no event titles or details. Use this when you only need to know when someone is available, or when you only have `freeBusyReader` access to their calendar.

### list_workspace_calendar_events
List calendar events with optional filtering.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | No | - | Account email (optional if single account) |
| calendarId | string | No | 'primary' | Calendar ID from `list_workspace_calendars` - use to read shared calendars |
| query | string | No | - | Text search within events |
| max_results | number | No | 25 | Maximum events to return (max 50) |
| time_min | string | No | now | Start of time range (ISO date string) |
| time_max | string | No | +14 days | End of time range (ISO date string) |
| return_json | boolean | No | false | Return JSON instead of formatted text |

**Example - Read shared calendar:**
```json
{ "calendarId": "penny@example.com", "time_min": "2026-01-13T00:00:00Z" }
```

**Note:** To read a shared calendar, first call `list_workspace_calendars` to find the calendar ID and verify `canViewEvents` is true. If you only have `freeBusyReader` access, use `find_free_slots` instead.

### get_workspace_calendar_event
Get a single calendar event by ID.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | No | - | Account email (optional if single account) |
| eventId | string | Yes | - | Event ID from list results |
| calendarId | string | No | 'primary' | Calendar ID - use to get events from shared calendars |

### create_workspace_calendar_event
Create a new calendar event.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | No | - | Account email |
| summary | string | Yes | - | Event title |
| start | object | Yes | - | Start time: `{ dateTime, timeZone }` for timed events OR `{ date }` for all-day |
| end | object | Yes | - | End time: `{ dateTime, timeZone }` for timed events OR `{ date }` for all-day (exclusive) |
| description | string | No | - | Event description |
| location | string | No | - | Event location (e.g., "Conference Room A") |
| calendarId | string | No | 'primary' | Calendar ID from `list_workspace_calendars` - use to create on shared calendars |
| attendees | object[] | No | - | List of `{ email: string }` objects |
| recurrence | string[] | No | - | RRULE strings (e.g., `["RRULE:FREQ=WEEKLY;COUNT=10"]`) |
| reminders | object | No | - | Custom reminders: `{ useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] }` |

**Examples:**

Timed meeting with location:
```json
{
  "summary": "Team Meeting",
  "location": "Conference Room A",
  "start": { "dateTime": "2026-01-15T09:00:00-06:00", "timeZone": "America/Chicago" },
  "end": { "dateTime": "2026-01-15T10:00:00-06:00", "timeZone": "America/Chicago" },
  "attendees": [{ "email": "alice@example.com" }]
}
```

All-day event (note: end date is exclusive - single day on Jan 15 needs end of Jan 16):
```json
{
  "summary": "Company Holiday",
  "start": { "date": "2026-01-15" },
  "end": { "date": "2026-01-16" }
}
```

Create on shared calendar:
```json
{
  "summary": "Team Event",
  "calendarId": "[external-email]",
  "start": { "dateTime": "2026-01-15T14:00:00Z" },
  "end": { "dateTime": "2026-01-15T15:00:00Z" }
}
```

**Notes:**
- To create on a shared calendar, you need `writer` access. Use `list_workspace_calendars` to check your access level.
- To check attendee availability first, use `find_free_slots`.

### manage_workspace_calendar_event
Manage event responses (accept, decline, tentative) and updates.

### delete_workspace_calendar_event
Delete a calendar event (from your primary calendar only).

## Drive Tools

### search_drive_files
Search files in Google Drive.

### download_drive_file
Download file contents by file ID. For Google Docs/Sheets/Slides, set `mime_type` for export format.

## Docs Tools

### read_workspace_document
Read content from a Google Docs document.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| document_id | string | Yes | - | Google Docs document ID |
| max_chars | number | No | 50000 | Maximum characters to return |
| return_json | boolean | No | false | Return raw API JSON instead of formatted text |

### create_workspace_document
Create a new Google Docs document.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| title | string | Yes | - | Document title |
| content | string | No | - | Initial content |

### append_to_workspace_document
Append text to the end of a document.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| document_id | string | Yes | - | Document ID |
| text | string | Yes | - | Text to append |

### replace_workspace_document
Replace entire document content (use with caution).

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| document_id | string | Yes | - | Document ID |
| content | string | Yes | - | New content |

### find_and_replace_workspace_document
Find and replace text throughout a document.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| document_id | string | Yes | - | Document ID |
| find_text | string | Yes | - | Text to find |
| replace_text | string | Yes | - | Replacement text |
| match_case | boolean | No | false | Case-sensitive matching |

### extract_workspace_document_id
Extract document ID from a Google Docs URL.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| input | string | Yes | Google Docs URL or document ID |

### list_workspace_document_tabs
List tabs in a document (returns single "default" tab until googleapis upgrade).

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| document_id | string | Yes | - | Document ID |
| include_word_count | boolean | No | false | Include word count |

## Slides Tools

### read_workspace_presentation
Read content from a Google Slides presentation.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| presentation_id | string | Yes | - | Google Slides presentation ID |
| max_chars | number | No | 50000 | Maximum characters to return |
| include_notes | boolean | No | false | Include speaker notes |
| return_json | boolean | No | false | Return raw API JSON instead of formatted text |

### create_workspace_presentation
Create a new Google Slides presentation.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| title | string | Yes | - | Presentation title |

### list_workspace_presentation_slides
List all slides in a presentation with metadata.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| presentation_id | string | Yes | - | Presentation ID |
| include_notes | boolean | No | false | Include speaker notes |

### get_workspace_slide
Get content from a specific slide by index.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| presentation_id | string | Yes | - | Presentation ID |
| slide_index | number | No | 0 | Slide index (0-based) |
| max_chars | number | No | 50000 | Maximum characters |
| return_json | boolean | No | false | Return raw JSON |

### extract_workspace_presentation_id
Extract presentation ID from a Google Slides URL.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| input | string | Yes | Google Slides URL or presentation ID |

### batch_update_workspace_presentation
Apply multiple updates to a Google Slides presentation in a single atomic operation.

This is the primary tool for modifying presentations. All requests are applied atomically - if any request fails, none are applied.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| presentation_id | string | Yes | - | Presentation ID or URL |
| requests | object[] | Yes | - | Array of update request objects |
| write_control | object | No | - | Optimistic concurrency control |
| return_json | boolean | No | false | Return raw API response |

**Common request types:**
- `createSlide`: Add new slides
- `deleteObject`: Remove slides or elements
- `replaceAllText`: Find and replace text (template-friendly)
- `insertText`: Add text to shapes
- `updateTextStyle`: Format text (bold, color, font)
- `createShape`: Add shapes
- `createTable`: Add tables
- `createImage`: Insert images by URL

**Example - Replace placeholders:**
```json
{
  "email": "user@example.com",
  "presentation_id": "1ABC123xyz",
  "requests": [
    { "replaceAllText": { "containsText": { "text": "{{name}}" }, "replaceText": "John Doe" } },
    { "replaceAllText": { "containsText": { "text": "{{date}}" }, "replaceText": "2025-01-15" } }
  ]
}
```

**Reference:** [Google Slides API batchUpdate](https://developers.google.com/slides/api/reference/rest/v1/presentations/batchUpdate)

### get_workspace_slide_thumbnail
Generate a thumbnail image URL for a specific slide.

Returns a temporary URL to a PNG image of the slide. **The URL expires after 30 minutes.**

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| presentation_id | string | Yes | - | Presentation ID or URL |
| slide_id | string | Yes | - | Slide object ID (use the returned `slideId` value from list_workspace_presentation_slides) |
| thumbnail_size | string | No | 'MEDIUM' | 'SMALL' (200px), 'MEDIUM' (800px), or 'LARGE' (1600px) |

**Example:**
```json
{
  "email": "user@example.com",
  "presentation_id": "1ABC123xyz",
  "slide_id": "g12345",
  "thumbnail_size": "LARGE"
}
```

## Sheets Tools

### Phase 1 Hardening (Sheets)

Phase 1 introduces structural guardrails and read-shaping for the existing Sheets tools:

- `value_view` (optional, read tools): choose `formatted`, `shaped`, `formula`, or `unformatted`; `shaped` exposes formulas alongside values and adds header/type inference.
- `anchor_mode` (optional, read tools): controls large/unbounded read handling (`auto`, `always`, `never`) with anchor envelopes for safer summarization.
- `continuation_token` (optional, read tools): resumes the middle slice from a prior anchor envelope.
- `overwrite_formulas` (optional, write tools): explicit opt-in for formula-overwriting writes where applicable.

Intentional default-behavior change: `update_workspace_spreadsheet_values` and `batch_update_workspace_spreadsheet_values` now refuse formula-overwriting writes unless `overwrite_formulas: true` is provided. This is **best-effort** only; concurrent edits during the call can still race because Sheets has no transactional write API.

Additional Phase 1 improvements:
- A1 normalization now auto-quotes sheet names with spaces (for example `'My Sheet'!A1:B10`).
- Formula guard refusal payloads include machine-readable `error_code` values: `formula_overwrite_refused` and `formula_safety_unverifiable`.

Planning reference: `docs/plans/260514_google_sheets_mcp_phase1_hardening.md`  
Roadmap: Phase 2 (new opinionated Sheets tools), Phase 3 (SDK `instructions` support), Phase 4 (Sheets eval harness).

### read_workspace_spreadsheet
Read metadata and optionally values from a Google Sheets spreadsheet.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Google Sheets spreadsheet ID |
| range | string | No | - | A1 notation range to read (e.g., "Sheet1!A1:D10") |
| max_rows | number | No | 1000 | Maximum rows to return |
| max_cols | number | No | 26 | Maximum columns to return |
| return_json | boolean | No | false | Return raw API JSON instead of formatted text |
| value_view | string | No | 'formatted' | `formatted`, `shaped`, `formula`, or `unformatted` |
| anchor_mode | string | No | 'auto' | `auto`, `always`, or `never` for large/unbounded reads |
| continuation_token | string | No | - | Opaque token from a previous anchor envelope |

### read_workspace_spreadsheet_values
Read values from a specific range in a spreadsheet.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| range | string | Yes | - | A1 notation range (e.g., "Sheet1!A1:D10") |
| major_dimension | string | No | 'ROWS' | 'ROWS' or 'COLUMNS' |
| return_json | boolean | No | false | Return raw ValueRange JSON |
| value_view | string | No | 'formatted' | `formatted`, `shaped`, `formula`, or `unformatted` |
| anchor_mode | string | No | 'auto' | `auto`, `always`, or `never` for large/unbounded reads |
| continuation_token | string | No | - | Opaque token from a previous anchor envelope |

### create_workspace_spreadsheet
Create a new Google Sheets spreadsheet.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| title | string | Yes | - | Spreadsheet title |
| sheetTitles | string[] | No | - | Optional names for initial sheets |

### append_to_workspace_spreadsheet
Append rows of data to a spreadsheet (after existing data).

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| range | string | Yes | - | A1 notation range for where to append |
| values | array[][] | Yes | - | 2D array of values to append |
| value_input_option | string | No | 'USER_ENTERED' | 'RAW' or 'USER_ENTERED' |
| overwrite_formulas | boolean | No | false | Suppresses append fill-down warning pre-check when true |

### update_workspace_spreadsheet_values
Update values in a specific range (overwrites existing data).

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| range | string | Yes | - | A1 notation range to update |
| values | array[][] | Yes | - | 2D array of values to write |
| value_input_option | string | No | 'USER_ENTERED' | 'RAW' or 'USER_ENTERED' |
| overwrite_formulas | boolean | No | false | Required to intentionally overwrite existing formulas |

### clear_workspace_spreadsheet_values
Clear values from a range (preserves formatting).

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| range | string | Yes | - | A1 notation range to clear |

### list_workspace_spreadsheet_sheets
List all sheets (tabs) in a spreadsheet.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |

### add_workspace_spreadsheet_sheet
Add a new sheet (tab) to an existing spreadsheet.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| title | string | Yes | - | Name for the new sheet |
| row_count | number | No | 1000 | Initial row count |
| column_count | number | No | 26 | Initial column count |

### delete_workspace_spreadsheet_sheet
Delete a sheet (tab) from a spreadsheet.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| sheet_id | number | Yes | - | Numeric sheet ID (use the returned `sheetId` value from list_workspace_spreadsheet_sheets) |

### extract_workspace_spreadsheet_id
Extract spreadsheet ID from a Google Sheets URL.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| input | string | Yes | Google Sheets URL or spreadsheet ID |

### batch_read_workspace_spreadsheet_values
Read values from multiple ranges in a single API call. More efficient than multiple read_workspace_spreadsheet_values calls - uses 1 API request instead of N.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| ranges | string[] | Yes | - | Array of A1 notation ranges |
| major_dimension | string | No | 'ROWS' | 'ROWS' or 'COLUMNS' |
| return_json | boolean | No | false | Return raw JSON instead of formatted text |
| value_view | string | No | 'formatted' | `formatted`, `shaped`, `formula`, or `unformatted` |
| anchor_mode | string | No | 'auto' | `auto`, `always`, or `never` for large/unbounded reads |
| continuation_token | string | No | - | Opaque token from a previous anchor envelope (batch continuation not supported) |

**Example:**
```json
{ "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "ranges": ["Sheet1!A1:D10", "Sheet2!A1:B5"] }
```

### batch_update_workspace_spreadsheet_values
Update values in multiple ranges in a single API call. All updates are applied atomically.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| data | object[] | Yes | - | Array of {range, values} objects |
| value_input_option | string | No | 'USER_ENTERED' | 'RAW' or 'USER_ENTERED' |
| overwrite_formulas | boolean | No | false | Required to intentionally overwrite existing formulas |

**Example:**
```json
{ 
  "email": "user@example.com", 
  "spreadsheet_id": "1ABC123xyz", 
  "data": [
    { "range": "Sheet1!A1:B2", "values": [["Name", "Score"], ["Alice", 95]] },
    { "range": "Sheet2!A1:B1", "values": [["Summary", "Total"]] }
  ]
}
```

### find_and_replace_workspace_spreadsheet
Find and replace text throughout a spreadsheet or specific sheet. Supports regex, case-sensitive matching, and formula search.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| find | string | Yes | - | Text to find (or regex if search_by_regex is true) |
| replacement | string | Yes | - | Replacement text |
| sheet_id | number | No | - | Numeric sheet ID (omit for all sheets) |
| match_case | boolean | No | false | Case-sensitive matching |
| match_entire_cell | boolean | No | false | Only match if entire cell equals find text |
| search_by_regex | boolean | No | false | Treat find as regex pattern |
| include_formulas | boolean | No | false | Search within formula text |

**Example:**
```json
{ "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "find": "TODO", "replacement": "DONE", "match_case": true }
```

### format_workspace_spreadsheet_cells
Apply formatting (bold, colors, borders) to a range of cells. Uses 0-based row/column indices with exclusive end indices.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| spreadsheet_id | string | Yes | - | Spreadsheet ID |
| sheet_id | number | Yes | - | Numeric sheet ID |
| start_row_index | number | Yes | - | Starting row (0-based, inclusive) |
| end_row_index | number | Yes | - | Ending row (0-based, exclusive) |
| start_column_index | number | Yes | - | Starting column (0-based, inclusive) |
| end_column_index | number | Yes | - | Ending column (0-based, exclusive) |
| bold | boolean | No | - | Apply bold formatting |
| italic | boolean | No | - | Apply italic formatting |
| underline | boolean | No | - | Apply underline formatting |
| strikethrough | boolean | No | - | Apply strikethrough formatting |
| font_size | number | No | - | Font size in points |
| text_color | object | No | - | RGB color {red, green, blue} (0.0-1.0) |
| background_color | object | No | - | RGB color {red, green, blue} (0.0-1.0) |
| border_style | string | No | - | NONE, DOTTED, DASHED, SOLID, SOLID_MEDIUM, SOLID_THICK, DOUBLE |
| border_color | object | No | - | RGB color {red, green, blue} (0.0-1.0) |

**Example (make header row bold with background color):**
```json
{ 
  "email": "user@example.com", 
  "spreadsheet_id": "1ABC123xyz", 
  "sheet_id": 0, 
  "start_row_index": 0, 
  "end_row_index": 1, 
  "start_column_index": 0, 
  "end_column_index": 5, 
  "bold": true, 
  "background_color": { "red": 0.9, "green": 0.95, "blue": 1.0 }
}
```

**Index conversion from A1 notation:**
- Row 1 = start_row_index: 0, end_row_index: 1
- Column A = start_column_index: 0, end_column_index: 1
- Range A1:D10 = start_row_index: 0, end_row_index: 10, start_column_index: 0, end_column_index: 4

## Contacts Tools

### search_workspace_contacts
Search contacts by name, email, or organization using People API.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| email | string | Yes | - | Account email |
| query | string | Yes | - | Search query (name, email, or organization) |
| max_results | number | No | 10 | Max results to return (max 30) |
| return_json | boolean | No | false | Return JSON instead of formatted text |

**Best practices implemented:**
- **Warmup request**: Per Google's recommendation, sends an empty query first to refresh server-side cache, improving search accuracy for recently added contacts
- **Optimized field mask**: Only requests `names,emailAddresses,phoneNumbers,organizations` to minimize response size

### get_workspace_contacts
List all contacts (for bulk retrieval, not search).

## Response Format

By default, tools return **human-readable text** optimized for LLM presentation:

```
Recent emails (3):
1. Dec 24, 09:14 — Ada Lovelace <ada@example.com>
   Subject: Budget sign-off
   "Can you approve the final numbers by end of day?"
   [id: 18a2b3c, thread: 18a2b3c, UNREAD]

2. Dec 24, 08:02 — Stripe <[external-email]>
   Subject: Dispute update
   "We've received additional evidence for case #12345..."
   [id: 18a1d4e, thread: 18a1d4e]
```

Set `return_json: true` for structured JSON output (useful for programmatic processing).

## OAuth Setup

Google Workspace OAuth is configured during onboarding:

1. User clicks "Connect Google" in Settings > Connectors
2. OAuth consent screen opens in browser
3. User grants requested scopes
4. Tokens stored in `~/.rebel/accounts.json` (encrypted)

**Required scopes:**
- `gmail.readonly` - Read emails
- `gmail.send` - Send emails
- `gmail.modify` - Labels, drafts
- `calendar.readonly` - Read calendar
- `calendar.events` - Create/modify events
- `drive.readonly` - Read files
- `documents` - Full access to Google Docs
- `documents.readonly` - Read-only access to Google Docs
- `presentations` - Full access to Google Slides
- `presentations.readonly` - Read-only access to Google Slides
- `spreadsheets` - Full access to Google Sheets
- `spreadsheets.readonly` - Read-only access to Google Sheets
- `contacts.readonly` - Read contacts

## Troubleshooting

### "No accounts found"
User hasn't connected a Google account. Direct to Settings > Connectors.

### "Token expired" / 401 errors
OAuth token needs refresh. Usually auto-handled; if persistent, reconnect account.

### Large response sizes
If responses are too large (>50KB), check:
1. `options.format` defaults to 'metadata' (not 'full')
2. `options.includeBody` defaults to false
3. `options.max_results` is reasonable (default 10)

### Missing contacts in search
People API can be slow on first query. The handler sends a warmup request, but results may still be incomplete for large address books.

## Development

### Building
```bash
cd connectors/google-workspace
npm install
npm run build
```

### Testing locally
The MCP runs via Super-MCP in HTTP mode. To test:
1. Run `npm run dev` in main project
2. Connect a Google account
3. Use Rebel to interact with Gmail/Calendar

### Adding new tools
1. Add schema to `tools/definitions.ts`
2. Add handler to appropriate `*-handlers.ts`
3. Register in `tools/server.ts` switch statement
4. Run `npm run build`

## Known Limitations

- **Rate limits:** Google APIs have per-user quotas. Heavy use may hit limits.
- **Attachments:** Sending/drafting with attachments requires base64-encoded content (25MB limit). The agent can attach files sourced from Drive or other emails, but not arbitrary local files.
- **Shared calendars:** You can read events and create events on shared calendars (use `list_workspace_calendars` to discover them and check access level, then use `calendarId` parameter). Update and delete operations are still restricted to your primary calendar.
- **Google Workspace vs personal Gmail:** Some features may differ by account type.

## Feature Flags

### Tasks and Forms (ENABLE_GOOGLE_TASKS_FORMS)

Google Tasks and Forms APIs are implemented but **disabled by default** via the `ENABLE_GOOGLE_TASKS_FORMS` environment variable.

**Why disabled?** These features require additional OAuth scopes that must be:
1. Added to the Google Cloud Console OAuth consent screen
2. Potentially verified by Google (which requires video recordings, justification, etc.)

Without proper configuration, requesting these scopes would break OAuth for all users.

**To enable:**
```bash
ENABLE_GOOGLE_TASKS_FORMS=true
```

**When enabled, adds these tools:**
- Tasks: `list_task_lists`, `list_tasks`, `create_task`, `update_task`, `complete_task`, `delete_task`
- Forms (read-only): `list_forms`, `get_form`, `list_form_responses`, `get_form_response`

**When enabled, requests these additional scopes:**
- `tasks` - Full access to Google Tasks
- `tasks.readonly` - Read-only access to Google Tasks
- `forms.body.readonly` - Read-only access to Google Forms structure
- `forms.responses.readonly` - Read-only access to Google Forms responses

**After enabling:** Existing users must disconnect and reconnect their Google account to grant the new scopes.

---

## Appendix: Adding New OAuth Scopes

> **Warning:** Adding new OAuth scopes is a non-trivial process that requires Google Cloud Console configuration and potentially Google verification. Budget time accordingly.

### When You Need New Scopes

If you're adding functionality that requires access to a new Google API (e.g., Tasks, Forms, Keep, Chat), you'll need to:

1. **Enable the API** in Google Cloud Console
2. **Add the scopes** to the OAuth consent screen
3. **Potentially undergo Google verification** (for sensitive/restricted scopes)

### Step-by-Step Process

#### 1. Enable the API (can be done via CLI)

```bash
# Set your project
gcloud config set project YOUR_PROJECT_ID

# Enable the API(s)
gcloud services enable tasks.googleapis.com forms.googleapis.com

# Verify
gcloud services list --enabled --filter='config.name:(tasks forms)'
```

#### 2. Add Scopes to OAuth Consent Screen (must use web UI)

There is **no CLI command** for this step - it must be done through the Google Cloud Console.

1. Go to: https://console.cloud.google.com/auth/scopes?project=YOUR_PROJECT_ID
2. Click **"Add or Remove Scopes"**
3. Search for and add the required scopes (e.g., `https://www.googleapis.com/auth/tasks`)
4. Click **Update**, then **Save**

#### 3. Google Verification (if required)

For sensitive or restricted scopes, Google requires verification before the app can be used by external users. This may involve:

- **Justification** for why each scope is needed
- **Privacy policy** review
- **Video recording** demonstrating how the app uses the data
- **Security assessment** (for restricted scopes)

Verification can take **days to weeks**. See: https://support.google.com/cloud/answer/9110914

### Deploying Before Verification

If you need to ship code before Google verification is complete, use a **feature flag**:

```typescript
// In service-initializer.ts
export const MY_FEATURE_ENABLED = process.env.ENABLE_MY_FEATURE === 'true';

// Conditionally register scopes
if (MY_FEATURE_ENABLED) {
  registerMyFeatureScopes();
}

// In definitions/index.ts
export const allTools = [
  ...baselineTools,
  ...(MY_FEATURE_ENABLED ? myFeatureTools : []),
];
```

This prevents the new scopes from being requested during OAuth until you're ready.

### Google Cloud Project

The OAuth credentials for Google Workspace are embedded in `src/main/services/oauthCredentials.ts`. The Google Cloud project number is `273128639320` (visible in the OAuth client ID prefix).

To manage this project, you need Owner or Editor permissions. Contact a team member with access if you don't have it.

---

## Appendix: Sheets MCP — Future Improvements (idea backlog)

Captured 2026-05-13 from a research pass: in-repo audit + GPT-5.5 subagent review + Gemini-3.1-Pro web research on Google's recent MCP/CLI releases. **This is an idea backlog, not a plan.** Prompted by user feedback that Sheets felt thin — specifically that "write a formula" and "fill down" weren't first-class.

Source-of-truth code:
- `connectors/google-workspace/src/tools/definitions/sheets.ts` in `mindstone/mcp-servers` — agent-facing schemas
- `connectors/google-workspace/src/modules/sheets/service.ts` in `mindstone/mcp-servers` — `googleapis` wrappers

### Phase 1 status reconciliation (2026-05-14)

- **DONE (Phase 1):** Read shaping and safety controls shipped on existing read tools (`value_view`, `anchor_mode`, `continuation_token`).
- **DONE (Phase 1):** Formula-overwrite guard shipped for update/batch-update (`overwrite_formulas` opt-in required to overwrite formulas).
- **DONE (Phase 1):** Actionable Sheets error rewriting and machine-readable refusal `error_code` values (`formula_overwrite_refused`, `formula_safety_unverifiable`).
- **DONE (Phase 1):** A1 normalization auto-quotes sheet names with spaces.
- **FUTURE (Phases 2-4):** Dedicated formula/autofill/sort/named-range tools, SDK `instructions` rollout, and Sheets eval harness remain roadmap items.

### Current Sheets-gap diagnosis

- **Write a formula:** Partial. `update_workspace_spreadsheet_values`, `append_to_workspace_spreadsheet`, and `batch_update_workspace_spreadsheet_values` accept formulas when `value_input_option: USER_ENTERED` (our default). No dedicated tool. Observed agent failure modes: forgetting the leading `=`, accidentally passing `RAW`, writing N copies of a formula instead of using a relative-range copy, and no array-formula affordance.
- **Fill down:** Not supported. Sheets v4 `batchUpdate` exposes `autoFillRequest` and `copyPaste` requests — neither is wired up in our service today. Today the agent has to manually generate one cell write per row.

### Proposed tool additions

#### P0 (must-have)

| Tool | Purpose | Sheets v4 mechanism |
|------|---------|---------------------|
| `write_workspace_spreadsheet_formula` | Single-cell formula, defaults `USER_ENTERED`, can auto-prepend `=` | `spreadsheets.values.update` |
| `write_workspace_spreadsheet_array_formula` | One spill/array formula instead of N copies | `spreadsheets.values.update` |
| `autofill_workspace_spreadsheet_range` | Modes: `copy_formula`, `detect_series`, `copy_all`; accepts A1 source/destination | `batchUpdate.autoFill` + `copyPaste`/`PASTE_FORMULA` |
| `sort_workspace_spreadsheet_range` | Multi-column sort with header flag | `SortRangeRequest` |

Example schema sketches:

```jsonc
// write_workspace_spreadsheet_formula
{ "spreadsheet_id": "id", "cell": "Sheet1!B2", "formula": "SUM(A2:A10)" }

// autofill_workspace_spreadsheet_range
{
  "spreadsheet_id": "id",
  "source_range": "Sheet1!B2",
  "destination_range": "Sheet1!B2:B100",
  "mode": "copy_formula"
}
```

#### P1 (high value)

- **Number formatting** (currency / percent / date) — `repeatCell.userEnteredFormat.numberFormat`
- **Resize / auto-resize dimensions** — `autoResizeDimensions` / `updateDimensionProperties`
- **Freeze rows or columns** — `updateSheetProperties.gridProperties.frozenRowCount`
- **Insert / delete rows or columns** — `insertDimension` / `deleteDimension`
- **Dropdown / data validation** — `repeatCell.dataValidation`
- **Conditional formatting** — `addConditionalFormatRule`
- **Generic `copy_range`** — paste-type-aware `copyPaste`
- **`manage_sheet`** (rename / duplicate / reorder / tab colour) — `updateSheetProperties` + `duplicateSheet`

#### P2 (nice-to-have)

Hide/show dimensions (`updateDimensionProperties.hiddenByUser`); merge / unmerge (`mergeCells`/`unmergeCells`); basic filters and filter views (`setBasicFilter` / `addFilterView`); protected ranges (`addProtectedRange`); charts (`addChart` / `updateChartSpec`); pivot tables (`updateCells` with `pivotTable` anchor); banding (`addBanding`); named ranges (`addNamedRange`); notes (`updateCells.note`); dimension grouping (`addDimensionGroup`); recalc settings (`updateSpreadsheetProperties`).

### UX / schema improvements to existing tools

- **A1 notation everywhere.** Centralise an `A1 ↔ GridRange` resolver and stop forcing numeric `sheet_id` on `format_workspace_spreadsheet_cells`, `delete_workspace_spreadsheet_sheet`, `find_and_replace_workspace_spreadsheet`. Numeric IDs are agent-hostile; let callers pass a sheet title or an A1 range with the sheet name embedded.
- **`format_workspace_spreadsheet_cells`** should accept hex colours (`#RRGGBB`) and A1 ranges, not only float RGB and 0-based indices.
- **`preview: true` on destructive tools** (`clear`, `delete_sheet`, `find_and_replace`) — report affected count/range without applying.
- **DONE (Phase 1) — Better error messages.** Raw Google range/index failures now flow through actionable rewrites.
- **DONE (Phase 1) — Document `RAW` honestly.** Write-tool descriptions now state that RAW stores formulas as literal text.
- **Human aliases.** `write_formula`, `fill_down`, `sort_sheet`, `freeze_header`, `format_numbers` — additive, non-breaking, and much easier for an LLM to find.

### Scope / auth

All P0/P1/P2 additions fit within the existing `https://www.googleapis.com/auth/spreadsheets` scope. No OAuth consent screen changes, no Google verification, no user-side reconnection required.

### External landscape (research leads — verify before acting)

Per Gemini-3.1-Pro research on 2026-05-13. Treat as leads, not facts.

- **`google/mcp`** — reportedly launched late 2025 with official Workspace MCP servers (Docs, Sheets, Slides, Calendar, Gmail). Verify directly at https://github.com/google/mcp before basing roadmap decisions on it.
- **`gemini-cli-extensions/workspace`** — official Gemini CLI Workspace plugin; reportedly upgraded from `spreadsheets.readonly` to full `spreadsheets` scope in Q1 2026 with create/append/update. Their tool schemas are worth mirroring for parity.
- **Apps Script as MCP backend** — Google's 2026 codelabs push wrapping complex Sheets operations (charts, pivots) in Apps Script and exposing the Apps Script itself as an MCP tool, rather than fighting `batchUpdate` JSON shapes. Plausible escape hatch for the P2 chart/pivot work.
- **Community references worth scanning** — `ajaysmb/gsheets-mcp` (auto-formatting abstractions), `eagleisbatman/docugen` (templating), `akchro/google-sheets-mcp` (FastMCP reference implementation).

### Recommended next steps

1. **Verify the external claims above** (small) — concrete URL fetches against `google/mcp` and the Gemini CLI workspace extension.
2. **Plan and ship the P0 four** (medium) — formula, array-formula, autofill, sort. Big agent-UX win, all within the current scope.
3. **Refactor `sheet_id`-only tools to also accept A1 / sheet titles** (small) — single shared resolver removes a recurring class of agent failure.
4. **Decide on Apps Script backend for charts/pivots before doing them natively** (no code yet) — could save us a large chunk of brittle work.

### Sources

- Sheets v4 batchUpdate request reference: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request
- Anthropic tool-design guidance (already cited in our MCP README): https://www.anthropic.com/engineering/writing-tools-for-agents
- OSS package code: `connectors/google-workspace/src/modules/sheets/service.ts`, `connectors/google-workspace/src/tools/definitions/sheets.ts` in `mindstone/mcp-servers`
