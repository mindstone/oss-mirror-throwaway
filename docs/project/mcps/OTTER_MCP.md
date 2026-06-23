---
description: "Otter.ai MCP connector — meeting transcript search/fetch tools, OAuth setup, catalog entry, scopes, validation status"
last_updated: "2026-01-16"
---

# Otter.ai MCP

Meeting transcripts and conversation search via Otter.ai's official MCP server.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Official Documentation](https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server) - Otter MCP help article


## Overview

| Attribute | Value |
|-----------|-------|
| **Provider** | Direct (vendor-hosted) |
| **Transport** | HTTP |
| **Endpoint** | `https://mcp.otter.ai/mcp` |
| **Auth** | OAuth 2.0 |
| **Plan Required** | Otter account (Enterprise for some features) |
| **Status** | **UNTESTED** - added Dec 2024, needs user validation |


## Connector Catalog Entry

```json
{
  "id": "otter",
  "name": "Otter.ai",
  "description": "Meeting transcripts, summaries, and conversation search",
  "category": "productivity",
  "provider": "direct",
  "mcpConfig": {
    "transport": "http",
    "type": "http",
    "url": "https://mcp.otter.ai/mcp",
    "oauth": true
  },
  "icon": "mic",
  "popular": false,
  "verified": true,
  "verifiedSource": "https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server"
}
```


## Tools

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `search` | Search meetings by keyword, date, or participant | "Which meetings related to product improvement did I attend in Q2?" |
| `fetch` | Get full transcript of a specific meeting | "Summarize the presentation https://otter.ai/u/..." |
| `get_user_info` | Get current user's name and email | "What is my Otter email address?" |


## Usage Examples

**Search meetings:**
```
Search my Otter meetings from last week about the product roadmap
```

**Fetch a specific transcript:**
```
Get the full transcript from my standup meeting yesterday
```

**Analyze across meetings:**
```
What were the key decisions from all leadership meetings this month?
```

**Generate content from meetings:**
```
Create action items from my meeting with the engineering team
```


## Setup Flow

### For Users

1. Click **"+ Add"** in Settings → Connectors
2. Select **Otter.ai**
3. Complete OAuth flow in browser (sign in to Otter)
4. Tools become available immediately

### OAuth Scopes

Otter MCP uses granular permissions:
- Read access to your meetings and transcripts
- Search across your conversation history
- Access meetings shared with you in your workspace


## Technical Details

- **Endpoint**: `https://mcp.otter.ai/mcp`
- **Transport**: HTTP with OAuth 2.0
- **Data Access**: All meetings you've captured + meetings shared with you
- **Security**: OAuth-authenticated, granular permissions per tool


## Known Limitations

### Enterprise Features
Some Otter features require Enterprise plan:
- Workspace-wide meeting access
- Admin connector enablement (for Claude/ChatGPT integrations)

### Supported Platforms
- Claude (web)
- ChatGPT (web, beta)
- Cursor
- Mindstone Rebel

### Not Supported
- Google Gemini (no MCP support yet)
- ChatGPT desktop app (use web version)


## Troubleshooting

### "OAuth configured but not connected"
1. **Check Otter subscription**: Some features require Enterprise
2. **Re-authenticate**: Settings → Connectors → Disconnect → Reconnect
3. **Admin enablement**: For Claude/ChatGPT, workspace admin must enable Otter first

### "Meeting not found" errors
- Ensure the meeting is shared with you (if from another user)
- Check that the meeting URL is correct
- Verify the meeting exists in your Otter account

### Tools not appearing
- Restart Super-MCP after connecting
- Check that Otter appears as "Connected" in Settings → Connectors


## Comparison with Alternatives

| Service | MCP Available | Notes |
|---------|---------------|-------|
| **Otter.ai** | Yes (this doc) | Native MCP, OAuth |
| **Fireflies** | Direct (vendor) | Available in connector catalog |
| **Fathom** | Community MCP | [FATHOM_MCP.md](FATHOM_MCP.md) - API key auth |
| **MeetGeek** | Community MCP | [GitHub](https://github.com/meetgeekai/meetgeek-mcp-server) |


## Common Use Cases

- Cross-meeting insights and pattern analysis
- Automated meeting summaries and action items
- Content generation from discussion transcripts
- Historical meeting search and retrieval
- Preparation briefs from past meetings


## References

- [Otter MCP Help Article](https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server)
- [Otter for Enterprise MCP Announcement](https://otter.ai/blog/otter-for-enterprise-connect-ai-to-ai-with-otters-mcp)
- [Otter.ai Website](https://otter.ai/)
