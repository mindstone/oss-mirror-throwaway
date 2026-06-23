---
description: "Gong MCP connector for sales call intelligence — auth, catalog entry, transcript tools, usage examples, limitations"
last_updated: "2026-02-18"
---

# Gong MCP

Sales call intelligence: recordings, transcripts, summaries, and user analytics from Gong.io.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Gong API Documentation](https://gong.app.gong.io/settings/api/documentation) - Official API reference


## Overview

| Attribute | Value |
|-----------|-------|
| **ID** | `gong` |
| **Provider** | Community (`gongio-mcp`) |
| **Version** | `1.4.1` (pinned) |
| **Auth** | API key (Access Key + Secret via HTTP Basic Auth) |
| **Status** | Added Feb 2026 |
| **Maturity** | Beta |

Gong is a revenue intelligence platform used for sales call transcription and analysis. This connector uses the community-maintained `gongio-mcp` package by Justin Beckwith.


## Connector Catalog Entry

```json
{
  "id": "gong",
  "name": "Gong",
  "description": "Sales call intelligence: list calls, get transcripts and summaries, search recordings, list users.",
  "category": "sales",
  "provider": "community",
  "mcpConfig": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "gongio-mcp@1.4.1"]
  },
  "icon": "phone",
  "popular": false,
  "verified": false,
  "verifiedSource": "https://github.com/JustinBeckwith/gongio-mcp",
  "requiresSetup": true,
  "setupUrl": "https://app.gong.io/company/api",
  "setupUrlBehavior": "button",
  "setupFields": [
    { "id": "accessKey", "label": "Access Key", "type": "text", "envVar": "GONG_ACCESS_KEY" },
    { "id": "accessKeySecret", "label": "Access Key Secret", "type": "password", "envVar": "GONG_ACCESS_KEY_SECRET" }
  ],
  "accountIdentity": "workspace",
  "maturity": "beta"
}
```


## Tools

The MCP provides 5 tools:

| Tool | Description |
|------|-------------|
| `list_calls` | List calls with optional date filtering and pagination |
| `get_call_summary` | AI-generated summary with key points, topics, and action items for a specific call |
| `get_call_transcript` | Full timestamped transcript with speaker attribution |
| `list_users` | List all users in the Gong workspace |
| `search_calls` | Search calls by date range, host, call IDs, or workspace |


## Usage Examples

**List recent calls:**
```
Show my Gong calls from last week
```

**Get a transcript:**
```
Get the transcript from my call with Acme
```

**Search by participant:**
```
Find calls where Sarah presented the demo
```

**Team activity:**
```
Who on the sales team had the most calls this month?
```


## Setup

**Prerequisites:**
- Gong Enterprise plan with API access enabled
- Technical Administrator role in Gong

**Get your API credentials:**
1. Go to [Gong API settings](https://app.gong.io/company/api)
2. Click **Get API credentials**
3. Copy the **Access Key** and **Access Key Secret**

**Configure in Rebel:**
1. Go to **Settings → Connectors**
2. Find **Gong** and click **Set up**
3. Paste the Access Key and Access Key Secret
4. Click **Connect**


## Technical Details

- **Type**: Community MCP (third-party)
- **Transport**: stdio (runs via npx)
- **Package**: `gongio-mcp@1.4.1`
- **License**: MIT
- **Author**: Justin Beckwith (former Google Cloud PM, maintainer of `googleapis` Node.js client)
- **Repository**: https://github.com/JustinBeckwith/gongio-mcp
- **Environment Variables**:
  - `GONG_ACCESS_KEY` (required) - Gong API Access Key
  - `GONG_ACCESS_KEY_SECRET` (required) - Gong API Access Key Secret
- **Auth mechanism**: HTTP Basic Auth (Access Key as username, Secret as password)


## Security Notes

- **API key scope**: Gong API credentials grant read access to all calls, transcripts, and users in the workspace
- **Read-only**: All 5 tools are read-only (no write/delete operations)
- **HTTPS enforced**: All API calls use HTTPS to `api.gong.io`
- **Version pinned**: Package version pinned to `1.4.1` to mitigate supply chain risk
- **Reputable author**: Justin Beckwith is a well-known developer (194+ npm packages, former Google Cloud PM)

**Code review notes (Feb 2026):** Source code reviewed before adoption. Clean TypeScript implementation, credentials handled via environment variables only (not logged or exposed). No suspicious patterns found.


## Known Limitations

- **Enterprise only**: Gong API access requires an Enterprise plan
- **Read-only**: No ability to create, update, or delete data in Gong
- **Community maintained**: Not an official Gong MCP -- may lag behind API changes
- **No real-time data**: Transcripts and summaries are available after Gong processes the call recording


## Troubleshooting

**"Missing required environment variables" error:**
1. Verify both Access Key and Access Key Secret are entered in Settings → Connectors
2. Disconnect and reconnect the Gong connector

**"401 Unauthorized" or authentication errors:**
1. Verify your API credentials at [Gong API settings](https://app.gong.io/company/api)
2. Regenerate credentials if needed
3. Ensure the Technical Administrator role is assigned to your account

**No calls returned:**
- Check that calls exist in the specified date range
- Verify your Gong account has access to the relevant workspace


## Alternatives

| Service | Type | Notes |
|---------|------|-------|
| **Gong** (this doc) | Community MCP | Local, version-pinned, read-only |
| **Fathom** | Bundled MCP | [FATHOM_MCP.md](FATHOM_MCP.md) - meeting transcripts |
| **Granola** | Bundled MCP | [GRANOLA_MCP.md](GRANOLA_MCP.md) - local meeting notes |
| **Fireflies** | Direct MCP | [FIREFLIES_MCP.md](FIREFLIES_MCP.md) - meeting transcripts via OAuth |


## References

- [Gong API Documentation](https://gong.app.gong.io/settings/api/documentation)
- [gongio-mcp GitHub Repository](https://github.com/JustinBeckwith/gongio-mcp)
- [gongio-mcp on npm](https://www.npmjs.com/package/gongio-mcp)
