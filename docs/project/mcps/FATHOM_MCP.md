---
description: "Fathom MCP connector reference — Klavis and bundled local options, API key setup, transcript tools, verification status"
last_updated: "2026-01-16"
---

# Fathom MCP

Meeting transcripts, AI summaries, and action items from Fathom AI.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Fathom API Documentation](https://developers.fathom.ai/) - Official API reference


## Overview

Fathom is available via **two connector options**:

| Option | ID | Auth | Best For |
|--------|-----|------|----------|
| **Fathom** | `fathom` | Klavis-managed | Most users - click to connect |
| **Fathom (Local)** | `bundled-fathom` | API key | Privacy-focused - runs locally |

| Attribute | Klavis | Local (Bundled) |
|-----------|--------|-----------------|
| **Provider** | Klavis gateway | Bundled MCP |
| **Auth** | Browser sign-in via Klavis | API key (manual) |
| **Data flow** | Via Klavis servers | Local only |
| **Setup** | One-click | Get API key from Fathom |
| **Status** | **UNTESTED** - Klavis verification unvalidated | Verified |


## Connector Catalog Entries

### Fathom (Klavis) - Recommended for most users

> **Note**: The `klavisVerification` fields (`FATHOM_MEETINGS`, `list_meetings`) are based on Klavis naming patterns but have not been validated against Klavis. May need adjustment after testing.

```json
{
  "id": "fathom",
  "name": "Fathom",
  "description": "Meeting transcripts, AI summaries, and action items from recorded calls",
  "category": "productivity",
  "provider": "klavis",
  "klavisServerName": "fathom",
  "klavisVerification": {
    "category": "FATHOM_MEETINGS",
    "action": "list_meetings",
    "args": { "per_page": 1 }
  },
  "icon": "video"
}
```

### Fathom (Local) - For privacy-focused users

```json
{
  "id": "bundled-fathom",
  "name": "Fathom (Local)",
  "description": "Meeting notes and transcripts. List/filter meetings, get AI summaries, search transcript content, find action items. Runs locally.",
  "category": "productivity",
  "provider": "bundled",
  "bundledConfig": {
    "authType": "api-key",
    "settingsKey": "fathom.enabled",
    "serverName": "Fathom"
  },
  "icon": "video",
  "verified": true,
  "verifiedSource": "https://developers.fathom.ai/"
}
```

> **Note**: API key is configured via Settings → Connectors → Fathom (Local) → "Set up" button.


## Tools

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `list_fathom_meetings` | List meetings with server-side filtering (teams, recorders, attendee domains, date range) | "Show my meetings from last week" |
| `get_fathom_meeting` | Get full meeting details including AI summary and action items | "Get the summary from yesterday's team standup" |
| `get_fathom_transcript` | Get meeting transcript with search, pagination, and format options | "Search for 'budget' in yesterday's call" |
| `list_fathom_teams` | Retrieve all accessible teams (name and creation date) | "What teams do I have access to?" |
| `list_fathom_team_members` | Retrieve team members for a specific team | "Who is on the Sales team?" |

### Transcript Tool Options

The `get_fathom_transcript` tool has several options to manage large transcripts efficiently:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `format` | Output format: `"text"` (human-readable) or `"json"` (full metadata) | `"text"` |
| `searchQuery` | Case-insensitive search - returns matching entries plus 2 lines of context | - |
| `maxEntries` | Limit number of entries returned | - |
| `startEntry` | Skip first N entries (for pagination) | 0 |

**Text format example output:**
```
Transcript: 3 matches for "budget" (showing 9 entries with context, 458 total in transcript)

[00:05:32] Alice Johnson: Let's revisit the budget allocations.
[00:05:45] Bob Smith: The Q4 budget looks tight.
...
```

### Server-Side Filters for Meetings

Fathom's API does **not** provide keyword search for meeting titles. Use these filters:
- `teams`: Filter by team names
- `recordedBy`: Filter by recorder email addresses
- `calendarInviteesDomains`: Filter by attendee email domains (e.g., find all meetings with "acme.com")
- `meetingType`: 'internal' or 'external'
- `createdAfter`/`createdBefore`: Date range filters (ISO format)

For transcript content search, use `get_fathom_transcript` with the `searchQuery` parameter.


## Usage Examples

**List meetings with filters:**
```
Show my Fathom meetings from the last 7 days with external attendees
```

**Find meetings by attendee domain:**
```
List my meetings with anyone from acme.com
```

**Get meeting summary:**
```
Get the AI summary from my meeting with the product team yesterday
```

**Search transcript for specific content:**
```
Search for "action items" in yesterday's client call transcript
```

**Get full transcript (for short meetings):**
```
Get the full transcript from my client call on Monday
```

**Paginate through a long transcript:**
```
Get the first 50 entries from my meeting transcript, then get entries 50-100
```


## Setup Flow

### Option 1: Fathom (Klavis) - Recommended

1. Click **"+ Add"** in Settings → Connectors
2. Select **Fathom**
3. Complete Klavis connection flow in browser
4. Tools available immediately

> Klavis handles authentication with Fathom on your behalf.

### Option 2: Fathom (Local) - For privacy-focused users

**Prerequisites:**
- **Fathom account** with API access

**Get your API key:**
1. Go to [Fathom API Access settings](https://fathom.video/customize#api-access-header)
2. Click **"Add +"** in the API Access section
3. Choose **"Generate API Key"** (not "Create Public App")
4. Name your key (e.g., "Mindstone Rebel")
5. Click the **"Copy to clipboard"** button on the right-hand side

**Configure in Rebel:**
1. Go to **Settings → Connectors** → Find **Fathom (Local)**
2. Click **"Set up"** to open the configuration form
3. Paste your API key into the password field
4. Click **Connect** - Rebel will save and activate the connection


## Technical Details (Local/Bundled Version)

- **Type**: Bundled MCP (maintained by Mindstone)
- **Transport**: stdio (runs as subprocess)
- **Server script**: `resources/mcp/fathom/build/index.js`
- **Environment Variables**:
  - `FATHOM_API_KEY` (required) - Your Fathom API key
- **Rate Limits**: 60 API calls per minute (Fathom API limit)
- **SDK**: Uses official `fathom-typescript` SDK v0.0.37


## API Key Access

Your Fathom API key provides access to:
- Meetings you have recorded
- Meetings shared to your team
- Team information you have access to

API keys are user-level and cannot access meetings you don't own or have shared access to.


## Known Limitations

### Klavis Version
- Data flows through Klavis servers (not local-only)
- Depends on Klavis availability

### Local (Bundled) Version
- Requires manual API key setup

### Both Versions
- **No server-side meeting search**: Fathom API does not provide keyword search for meeting titles - use filters (teams, domains, dates) with `list_fathom_meetings`
- **Client-side transcript search**: Use `get_fathom_transcript` with `searchQuery` to search within transcript content
- **Read-only**: Cannot create meetings, edit transcripts, or manage webhooks
- **Rate limits**: 60 requests per minute (Fathom API limit)


## Troubleshooting

### Klavis Version

**Connection flow completes but not connected:**
1. Check Klavis status and try reconnecting
2. Ensure you completed the full sign-in flow
3. Try disconnecting and reconnecting in Settings → Connectors

### Local (Bundled) Version

**"Invalid API key" or "Fathom not connected":**
1. Verify your API key at [Fathom API Access](https://fathom.video/customize#api-access-header)
2. Regenerate the key if needed
3. Ensure no extra whitespace when pasting the key
4. Click "Configure with Rebel" in Settings → Connectors → Fathom (Local) and paste the key again

**"Rate limited by Fathom API":**
- Wait 1 minute before retrying
- Fathom limits API requests to 60 calls per minute

### Both Versions

**"No meetings found":**
- Check that you have recorded meetings in Fathom
- Verify your account has access to the meetings
- Try: "List my Fathom meetings"


## Comparison with Alternatives

| Service | Options | Notes |
|---------|---------|-------|
| **Fathom** (this doc) | Klavis or Bundled (Local) | Dual-entry pattern |
| **Otter.ai** | Direct (vendor) | [Official MCP](OTTER_MCP.md) |
| **Fireflies** | Direct (vendor) or Klavis | Dual-entry pattern |


## Common Use Cases

- **Meeting filtering**: Find past meetings by team, attendee domain, or date range
- **Summary retrieval**: Get AI-generated summaries without watching recordings
- **Transcript analysis**: Extract quotes, decisions, or action items from transcripts
- **Team coordination**: List team members and their meeting activity


## References

- [Fathom API Documentation](https://developers.fathom.ai/)
- [Fathom API Quickstart](https://developers.fathom.ai/quickstart)
- [Fathom Website](https://fathom.video/)
