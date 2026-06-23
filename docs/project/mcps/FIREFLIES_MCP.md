---
description: "Fireflies MCP connector reference — Klavis and direct provider options, OAuth setup, transcript tools, catalog entries"
last_updated: "2026-01-16"
---

# Fireflies MCP

Meeting transcripts and AI-powered insights from Fireflies.ai.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [KLAVIS_TO_BUNDLED_MCP_MIGRATION.md](../KLAVIS_TO_BUNDLED_MCP_MIGRATION.md) - Migration patterns
- [Official Documentation](https://guide.fireflies.ai/articles/8272956938-learn-about-the-fireflies-mcp-connectors-for-chatgpt-claude) - Fireflies MCP guide


## Overview

Fireflies is available via **two providers** (following the Slack pattern):

| Entry | Provider | Description |
|-------|----------|-------------|
| `fireflies` | Klavis | Via Klavis gateway (existing users) |
| `fireflies-direct` | Direct | Native OAuth with Fireflies (recommended for new users) |

### Direct MCP Details

| Attribute | Value |
|-----------|-------|
| **Provider** | Direct (vendor-hosted) |
| **Transport** | HTTP |
| **Endpoint** | `https://api.fireflies.ai/mcp` |
| **Auth** | OAuth 2.0 (Google or Microsoft) |
| **Plan Required** | Fireflies account |
| **Status** | **UNTESTED** - added Dec 2024, needs user validation |


## Connector Catalog Entries

### Klavis Entry (existing)
```json
{
  "id": "fireflies",
  "name": "Fireflies",
  "description": "Meeting transcripts and notes",
  "category": "productivity",
  "provider": "klavis",
  "klavisServerName": "fireflies",
  "icon": "mic",
  "popular": false
}
```

### Direct Entry (new)
```json
{
  "id": "fireflies-direct",
  "name": "Fireflies (Direct)",
  "description": "Meeting transcripts, summaries, and AI-powered insights. Connects directly to Fireflies - no Klavis gateway.",
  "category": "productivity",
  "provider": "direct",
  "mcpConfig": {
    "transport": "http",
    "type": "http",
    "url": "https://api.fireflies.ai/mcp",
    "oauth": true
  },
  "icon": "mic",
  "popular": false,
  "verified": true,
  "verifiedSource": "https://guide.fireflies.ai/articles/8272956938-learn-about-the-fireflies-mcp-connectors-for-chatgpt-claude"
}
```


## Tools (Direct MCP)

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `get_user` | Returns your user profile info | "What's my Fireflies account info?" |
| `get_transcript` | Retrieve full transcript by transcriptId | "Get the transcript from meeting ID abc123" |
| `get_transcripts` | Search past transcripts with filters | "Find all sales calls from last week" |


## Usage Examples

**Sales analysis:**
```
What were the main objections in this week's sales calls?
```

**Product feedback:**
```
Create a summary of all product feedback from user interviews this month
```

**Meeting search:**
```
Find meetings where we discussed the product roadmap
```

**Cross-meeting insights:**
```
Compare the objections mentioned in calls with Enterprise prospects versus SMB prospects this quarter
```


## Setup Flow

### For Users (Direct MCP)

1. Click **"+ Add"** in Settings → Connectors
2. Select **Fireflies (Direct)**
3. Complete OAuth flow in browser (sign in with Google or Microsoft)
4. Tools become available immediately

### Klavis Option

Existing users with Klavis configured can continue using `fireflies` (Klavis) entry. Both options work - the direct version avoids the Klavis gateway hop.


## Technical Details

- **Endpoint**: `https://api.fireflies.ai/mcp`
- **Transport**: HTTP with OAuth 2.0
- **OAuth Providers**: Google, Microsoft
- **Data Access**: User's own meetings and transcripts


## Data Privacy Notice

**Important**: Fireflies' Zero-Day Retention (ZDR) policy applies only to data processed within Fireflies' core services. When using the MCP connector:

- Data exchanged through MCP is processed under the AI tool's terms of service
- ZDR does not apply to data once it leaves the Fireflies environment
- Each platform manages its own data retention and model training policies


## Troubleshooting

### "OAuth configured but not connected"
1. **Re-authenticate**: Settings → Connectors → Disconnect → Reconnect
2. **Try different OAuth provider**: If Google fails, try Microsoft or vice versa
3. **Check Fireflies account**: Ensure transcripts exist in your account

### "No transcripts found" errors
- Ensure your Fireflies account has processed meetings with transcripts
- Check date range filters in your query
- Verify meetings were recorded and transcribed by Fireflies

### Tools not appearing
- Restart Rebel after connecting
- Check that Fireflies appears as "Connected" in Settings → Connectors


## Comparison with Alternatives

| Service | MCP Available | Notes |
|---------|---------------|-------|
| **Fireflies** | Yes (this doc) | Klavis + Direct options |
| **Otter.ai** | Yes | [OTTER_MCP.md](OTTER_MCP.md) |
| **MeetGeek** | Community MCP | [GitHub](https://github.com/meetgeekai/meetgeek-mcp-server) |
| **Fathom** | Community MCP | Available in connector catalog |


## Common Use Cases

- Analyzing sales call objections and patterns
- Extracting feature requests from user interviews
- Generating meeting summaries and action items
- Tracking decisions across multiple meetings
- Customer feedback analysis and sentiment trends


## References

- [Fireflies MCP Guide](https://guide.fireflies.ai/articles/8272956938-learn-about-the-fireflies-mcp-connectors-for-chatgpt-claude)
- [Fireflies API Docs](https://docs.fireflies.ai/getting-started/introduction)
- [Fireflies Blog: MCP Server](https://fireflies.ai/blog/fireflies-mcp-server)
- [Fireflies.ai Website](https://fireflies.ai/)
