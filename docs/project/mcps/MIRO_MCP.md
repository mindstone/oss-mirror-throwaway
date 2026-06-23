---
description: "Miro vendor-hosted MCP connector — OAuth setup, diagram and code-generation use cases, enterprise access, troubleshooting"
last_updated: "2026-01-16"
---

# Miro MCP

Miro integration for Rebel uses Miro's official vendor-hosted MCP server. This means the MCP implementation is maintained by Miro, not Mindstone.

## Status

| Aspect | Value |
|--------|-------|
| Provider | Vendor-hosted (Miro) |
| Release Stage | **Beta** |
| Added | December 2024 |
| Tested | UNTESTED - needs validation |

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup and troubleshooting
- [Miro MCP Documentation](https://developers.miro.com/docs/miro-mcp) - Official Miro docs
- [Miro MCP Admin Guide](https://help.miro.com/hc/en-us/articles/31625761037202-Miro-MCP-Server-admin-guide) - Enterprise setup

## How It Works

Miro hosts their own MCP server:

```
User → Rebel → Super-MCP → Miro MCP (https://mcp.miro.com/) → Miro API
```

**What this means:**
- Tools and capabilities are maintained by Miro
- OAuth 2.1 is handled by Miro's server
- We cannot fix bugs or add features to the MCP itself
- Tool behavior may change with Miro's releases

## Setup

### Standard Users

1. Open **Settings → Connectors**
2. Click **+ Add** next to Miro
3. Complete OAuth in the browser popup
4. Miro tools appear automatically after connection

**Connection time:** After adding Miro, Super-MCP restarts (~30-60 seconds) before tools become available.

### Enterprise Users

If your organization uses Miro Enterprise:

1. **Admin must enable MCP first** - See [Miro MCP Admin Guide](https://help.miro.com/hc/en-us/articles/31625761037202-Miro-MCP-Server-admin-guide)
2. Once enabled by admin, follow standard setup above

## Current Use Cases

Miro's MCP beta currently supports two primary use cases:

### 1. Generate Diagrams

Create visual diagrams on Miro boards from:
- Code repositories
- Text descriptions
- GitHub URLs
- Product requirement documents (PRDs)

**Example prompts:**
- "Create a flowchart on Miro showing the user signup process"
- "Visualize this architecture on my Miro board"
- "Turn this PRD into a diagram"

### 2. Generate Code

Transform Miro board content into code:
- Convert PRDs into working code
- Transform diagrams into application structure
- Use prototypes as implementation guides

**Example prompts:**
- "Generate code based on the diagram on my Miro board"
- "Turn this Miro wireframe into React components"

**Note:** More use cases are planned. Provide feedback via [Miro's feedback form](https://q2oeb0jrhgi.typeform.com/to/YATmJPVx).

## Troubleshooting

### OAuth Popup Doesn't Open
- Check browser popup blocker settings
- Try a different browser
- Ensure you're logged into Miro in your browser

### "Access Denied" or Permission Errors
- **Enterprise users**: Contact your Miro admin to enable MCP for your organization
- Verify you have access to the requested boards

### OAuth Completes But No Tools Appear
- Wait 30-60 seconds for Super-MCP restart
- Check Settings → Connectors to verify "Connected" status
- Try disconnecting and reconnecting

### Rate Limit Errors
- Miro uses standard API rate limits
- Wait a few minutes before retrying
- Reduce query frequency

## Vendor MCP Considerations

Since this is a vendor-hosted MCP:

| Aspect | Implication |
|--------|-------------|
| Bug fixes | Report to Miro, not Mindstone |
| Feature requests | Use [Miro's feedback form](https://q2oeb0jrhgi.typeform.com/to/YATmJPVx) |
| Availability | Depends on Miro's service uptime |
| Tool changes | May change with Miro releases |
| Beta limitations | Feature set may evolve |

## Community Alternative

For users who need more control or different features, a community MCP exists:

- **Package:** `@llmindset/mcp-miro` ([GitHub](https://github.com/evalstate/mcp-miro))
- **License:** Apache-2.0
- **Features:** Board manipulation, sticky notes, shapes, bulk operations
- **Auth:** Requires manual API token setup

This is not the default integration but can be configured manually if needed.
