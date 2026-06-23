---
description: "Notion vendor-hosted MCP connector — OAuth setup, page/database tools, plan restrictions, usage tips, rate limits"
last_updated: "2026-01-16"
---

# Notion MCP

Notion integration for Rebel uses Notion's official vendor-hosted MCP server. This means the MCP implementation is maintained by Notion, not Mindstone.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup and troubleshooting
- [Notion MCP Documentation](https://developers.notion.com/docs/mcp) - Official Notion docs
- [Notion MCP Supported Tools](https://developers.notion.com/docs/mcp-supported-tools) - Tool reference

## How It Works

Unlike bundled MCPs (like Google Workspace), Notion hosts their own MCP server:

```
User → Rebel → Super-MCP → Notion MCP (https://mcp.notion.com/mcp) → Notion API
```

**What this means:**
- Tools and capabilities are maintained by Notion
- OAuth is handled by Notion's server
- We cannot fix bugs or add features to the MCP itself
- Tool behavior may change with Notion's releases

## Setup

1. Open **Settings → Connectors**
2. Click **+ Add** next to Notion
3. Complete OAuth in the browser popup
4. Notion tools appear automatically after connection

**Connection time:** After adding Notion, Super-MCP restarts (~30-60 seconds) before tools become available.

## Available Tools

| Tool | Description | Plan Requirements |
|------|-------------|-------------------|
| `notion-search` | Search workspace and connected tools | Full capability requires **Notion AI plan** |
| `notion-fetch` | Retrieve page/database by URL | - |
| `notion-create-pages` | Create new pages | - |
| `notion-update-page` | Update page properties/content | - |
| `notion-move-pages` | Move pages to new parent | - |
| `notion-duplicate-page` | Duplicate pages (async) | - |
| `notion-create-database` | Create new database | - |
| `notion-update-database` | Update database properties | - |
| `notion-query-data-sources` | Query across multiple data sources | **Enterprise plan only** |
| `notion-create-comment` | Add page-level comment | - |
| `notion-get-comments` | List page comments | - |
| `notion-get-teams` | List teamspaces | - |
| `notion-get-users` | List workspace users | - |
| `notion-get-user` | Get user by ID | - |
| `notion-get-self` | Get bot user info | - |

**Note:** Some tools have plan restrictions:
- `notion-search` with full workspace + connected tools search requires a **Notion AI subscription**
- `notion-query-data-sources` requires **Notion Enterprise plan**

For the latest tool list, check [Notion's official documentation](https://developers.notion.com/docs/mcp-supported-tools).

## Usage Tips

**Searching for content:**
- "Search for meeting notes from last week" - Uses `notion-search`
- "Find all pages about budget approval" - Full search (requires Notion AI)
- Note: Without Notion AI plan, search is limited to your Notion workspace only (no Slack/Drive)

**Fetching pages:**
- "What's in this page: https://notion.so/..." - Uses `notion-fetch` with URL
- Always provide the full Notion page URL for best results

**Creating content:**
- "Create a project kickoff page under Projects folder"
- "Add a new task to the Engineering database"

**Updating content:**
- "Change the status of this task to Complete"
- "Add a risks section to the project plan"

**Best practices:**
- Use `notion-search` to find pages first, then `notion-fetch` for details
- Keep page updates small and focused
- Be aware of rate limits on rapid queries

## Rate Limits

Notion's MCP has specific rate limits:

| Type | Limit |
|------|-------|
| General requests | 180 per minute |
| Search requests | 30 per minute |

**What happens when rate limited:**
- You'll see an error message about too many requests
- Wait a few minutes before retrying
- Sequential operations naturally stay under limits

**Best practices:**
- Avoid rapid-fire searches
- Use specific queries instead of broad searches
- Let Rebel handle pagination naturally

## Troubleshooting

### Connection Issues

#### OAuth Popup Doesn't Open
- Check browser popup blocker settings
- Try a different browser
- Ensure you're logged into Notion in your browser

#### OAuth Completes But No Tools Appear
- Wait 30-60 seconds for Super-MCP restart
- Check Settings → Connectors to verify "Connected" status
- Try disconnecting and reconnecting

#### Intermittent Connection Drops

Some users report the Notion connection randomly dropping, causing tools to disappear from the settings UI.

**Workaround:**
1. Open Settings → Connectors
2. Disconnect Notion
3. Wait a few seconds
4. Reconnect via OAuth

If this happens frequently, it may be related to your network or Notion's service stability.

### Tool-Specific Issues

#### Search Returns Empty Results
- Without Notion AI plan: Search is limited to Notion workspace only
- Verify the content exists and you have access
- Try more specific search terms

#### "Permission Denied" Errors
- The OAuth grants access based on your Notion permissions
- Verify you have access to the page/database in Notion's web app
- Check if the page is in a private space you don't have access to

#### Enterprise-Only Tools Don't Work
- `notion-query-data-sources` requires Notion Enterprise plan
- Contact your Notion admin about plan features

### Rate Limit Errors
- Wait a few minutes before retrying
- Reduce query frequency
- Use more specific searches instead of broad queries

## Vendor MCP Considerations

Since this is a vendor-hosted MCP:

| Aspect | Implication |
|--------|-------------|
| Bug fixes | Report to Notion, not Mindstone |
| Feature requests | Request via Notion's feedback channel |
| Availability | Depends on Notion's service uptime |
| Tool changes | May change with Notion releases |

If you encounter issues with Notion's MCP behavior (not connection issues), check [Notion's status page](https://status.notion.com/) or contact Notion support.

## Advanced: Local MCP Server (Unsupported)

For advanced users who need:
- More control over tools (21 tools vs 15 in hosted)
- No Notion AI subscription requirement for search
- Privacy (data stays local)
- Custom API token instead of OAuth

Notion maintains an [open-source MCP server](https://github.com/makenotion/notion-mcp-server) that can be run locally.

**Important caveats:**
- **Not officially supported by Mindstone** - You're on your own for troubleshooting
- **Being deprioritized by Notion** - May be sunset in the future
- **Requires manual setup** - You'll need to configure a custom MCP server in Super-MCP

### Manual Setup (Advanced)

1. Create a Notion integration at https://www.notion.so/profile/integrations
2. Copy your integration token (starts with `ntn_`)
3. Grant the integration access to your pages/databases
4. Add to your Super-MCP config manually:

```json
{
  "mcpServers": {
    "notionLocal": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "NOTION_TOKEN": "ntn_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

**Security note:** Your integration token grants access to all pages/databases you've shared with it. Use a least-privilege approach - only share what's necessary.

This is an **unsupported** configuration. If you encounter issues, refer to the [open-source repo](https://github.com/makenotion/notion-mcp-server) or Notion's documentation.
