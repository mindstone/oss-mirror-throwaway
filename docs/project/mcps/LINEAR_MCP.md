---
description: "Linear vendor-hosted MCP connector — OAuth setup, issue/project tools, rate limits, usage tips, troubleshooting"
last_updated: "2026-01-16"
---

# Linear MCP

Linear integration for Rebel uses Linear's official vendor-hosted MCP server. This means the MCP implementation is maintained by Linear, not Mindstone.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup and troubleshooting
- [Linear MCP Documentation](https://linear.app/docs/mcp) - Official Linear docs
- [Linear API Rate Limiting](https://linear.app/developers/rate-limiting) - API limits and best practices

## How It Works

Unlike bundled MCPs (like Google Workspace), Linear hosts their own MCP server:

```
User → Rebel → Super-MCP → Linear MCP (https://mcp.linear.app/mcp) → Linear API
```

**What this means:**
- Tools and capabilities are maintained by Linear
- OAuth is handled by Linear's server
- We cannot fix bugs or add features to the MCP itself
- Tool behavior may change with Linear's releases

## Setup

1. Open **Settings → Connectors**
2. Click **+ Add** next to Linear
3. Complete OAuth in the browser popup
4. Linear tools appear automatically after connection

**Connection time:** After adding Linear, Super-MCP restarts (~30-60 seconds) before tools become available.

## Available Tools

Linear's MCP provides tools for:
- **Issues**: Search, create, update, change status, assign
- **Projects**: View and manage projects
- **Comments**: Add comments to issues
- **Teams**: View team information

For the current tool list, check [Linear's MCP documentation](https://linear.app/docs/mcp) or use the MCP tool discovery in your conversation.

## Usage Tips

**Searching for issues:**
- "Show my open issues" - Lists your assigned, open issues
- "Find issues about login bug" - Searches issue titles/descriptions
- "What's in the current sprint?" - Shows cycle issues

**Creating issues:**
- "Create an issue for fixing the login button in the Web team"
- Rebel will use appropriate team, status, and labels based on context

**Updating issues:**
- "Move FE-123 to In Progress"
- "Assign BE-456 to Sarah"
- "Add a comment to UI-789 saying we need more details"

## Rate Limits

Linear's API has usage limits (see [official docs](https://linear.app/developers/rate-limiting) for current values):
- Authenticated requests are rate-limited per hour
- Rebel handles rate limit errors gracefully with retry

**Best practices:**
- Avoid rapid-fire queries (e.g., polling for updates)
- Use specific searches instead of fetching all issues

## Troubleshooting

### OAuth Popup Doesn't Open
- Check browser popup blocker settings
- Try a different browser
- Ensure you're logged into Linear in your browser

### OAuth Completes But No Tools Appear
- Wait 30-60 seconds for Super-MCP restart
- Check Settings → Connectors to verify "Connected" status
- Try disconnecting and reconnecting

### "Internal Server Error" During Connection
Per [Linear's FAQ](https://linear.app/docs/mcp#faq):
```bash
rm -rf ~/.mcp-auth
```
Then retry the connection.

### Rate Limit Errors
- Wait a few minutes before retrying
- Reduce query frequency
- Use more specific searches

### Tools Work But Return Empty Results
- Verify you have access to the requested team/project in Linear
- Check that issues exist matching your query
- Ensure your Linear account has appropriate permissions

## Vendor MCP Considerations

Since this is a vendor-hosted MCP:

| Aspect | Implication |
|--------|-------------|
| Bug fixes | Report to Linear, not Mindstone |
| Feature requests | Request via Linear's feedback channel |
| Availability | Depends on Linear's service uptime |
| Tool changes | May change with Linear releases |

If you encounter issues with Linear's MCP behavior (not connection issues), check Linear's status page or contact Linear support.

## API Key Alternative

Linear's official MCP also supports API key authentication via Bearer token. This is an advanced configuration for users who:
- Cannot use OAuth (e.g., enterprise SSO restrictions)
- Want to use a restricted read-only API key

To use an API key, you would need to configure a custom MCP server in Super-MCP's config. Contact Mindstone support if you need this setup.
