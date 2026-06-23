---
description: "Framer MCP connector reference — marketplace plugin setup, WebSocket tunnel architecture, design automation tools"
last_updated: "2026-05-15"
---

# Framer MCP

Design automation MCP for Framer websites. Edit text, styles, components, and export React code via AI. Uses the official MCP plugin from the [Framer Marketplace](https://www.framer.com/marketplace/plugins/mcp/).


## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Framer Developer Docs](https://www.framer.com/developers/) - Framer API reference


## Overview

| Attribute | Value |
|-----------|-------|
| **Provider** | Plugin-based (WebSocket tunnel) |
| **Transport** | HTTP (via Cloudflare Worker) |
| **MCP Server** | `mcp.unframer.co` |
| **License** | Proprietary (free plugin) |
| **Auth** | Framer user ID (auto-generated) |
| **Requires Setup** | Yes - Framer plugin |
| **Status** | UI supported (Dec 2024) - needs user testing |


## Prerequisites

Before using Framer MCP, users must:

1. **Have a Framer account** with an active project
2. **Install the MCP plugin** from [Framer Marketplace](https://www.framer.com/marketplace/plugins/mcp/) (free)
3. **Open the plugin** in their Framer project
4. **Copy their MCP URL** from the plugin (unique per user)


## How It Works

```
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│  Framer Plugin  │ ←── │  WebSocket Tunnel   │ ←── │   MCP Client    │
│  (runs in app)  │     │  (mcp.unframer.co)  │     │  (Claude/Rebel) │
└─────────────────┘     └─────────────────────┘     └─────────────────┘
```

1. **Framer Plugin** runs inside the Framer app, handles API calls and maintains WebSocket connection
2. **MCP Server** is a Cloudflare Worker implementing the MCP protocol at `mcp.unframer.co`
3. **WebSocket Tunnel** provides bidirectional connection using the user's Framer User ID as identifier

Only one plugin instance can connect per user. Multiple MCP clients can connect simultaneously to the same plugin. All requests have a 5-second timeout.


## Tools

| Tool | Description |
|------|-------------|
| **Project Structure** | Get XML representation of pages, components, code files |
| **Node Selection** | Read and manipulate currently selected elements |
| **XML Updates** | Modify node attributes, text content, and structure |
| **Color Styles** | Create, update, and apply project color styles |
| **Text Styles** | Manage typography styles with full property control |
| **Font Search** | Find and apply fonts from Framer's font library |
| **Node Operations** | Duplicate, delete, or zoom to specific nodes |
| **React Export** | Convert Framer components to React code (uses unframer CLI) |
| **Code Files** | Create, read, update TypeScript/React code components |
| **Component Insertion** | Add components to canvas with proper positioning |


## Setup Instructions

### In Mindstone Rebel (Recommended)

1. Go to **Settings → Connectors**
2. Search for "Framer" and click on the card
3. Click **"Set up"** - this opens the Framer plugin page
4. Install the free MCP plugin from the Framer Marketplace
5. Open the plugin in your Framer project
6. Copy your unique MCP URL from the plugin
7. Return to Rebel and paste the URL into the input field
8. Click **"Connect"**

### Manual Setup (Alternative)

#### Step 1: Install Plugin

1. Open your Framer project
2. Go to [Framer Marketplace > MCP Plugin](https://www.framer.com/marketplace/plugins/mcp/)
3. Click "Open in Framer" to install
4. The plugin window will open showing your MCP URL

#### Step 2: Copy MCP URL

The plugin displays a URL like:
```
https://mcp.unframer.co/<your-user-id>?secret=<optional-secret>
```

**Important**: Keep this URL private - it provides access to your Framer projects.

#### Step 3: Add to MCP Configuration

**For Mindstone Rebel**: Add to your Super-MCP config (`~/.mindstone/router.json`):
```json
{
  "mcpServers": {
    "framer": {
      "transport": "http",
      "type": "http",
      "url": "https://mcp.unframer.co/<your-user-id>?secret=<your-secret>"
    }
  }
}
```

**For Claude Desktop**: Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "framer": {
      "url": "https://mcp.unframer.co/<your-user-id>"
    }
  }
}
```

**For Cursor IDE**: Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "framer-mcp": {
      "url": "https://mcp.unframer.co/<your-user-id>"
    }
  }
}
```

### Step 4: Keep Plugin Open

The MCP connection only works while the Framer plugin is open. You can minimize the plugin window to save space (click collapse button in bottom right).


## Usage Examples

**Rewrite landing page copy:**
```
Rewrite the hero section headline to be more compelling for SaaS buyers
```

**Update color scheme:**
```
Create a new color style called "Brand Primary" with value #4F46E5 and apply it to all buttons
```

**Export component to React:**
```
Export the "Hero" component as production-ready React code
```

**Create code component:**
```
Create a new code component called "AnimatedCounter" that counts up to a target number
```

**Bulk style updates:**
```
Update all heading text styles to use Inter font with 1.2 line height
```


## Use Cases

- **Landing page optimization**: Research keywords → update headings with SEO content
- **Design system updates**: Create consistent color palette → apply across all components
- **Component development**: Build custom React components → insert into Framer
- **Content migration**: Export Framer components as production React code
- **Accessibility audits**: Verify text styles meet guidelines → fix non-compliant elements
- **A/B test setup**: Duplicate pages → modify copy/styles for variant testing


## Security Considerations

- **Never share your MCP URL** - it contains your user ID and optional secret
- Connection is tied to your Framer user account
- All operations require explicit approval in your MCP client
- Plugin only has access to the currently open project
- 5-second timeout on all requests for reliability


## Troubleshooting

### "Connection failed" errors
- Ensure the Framer MCP plugin is open in your Framer project
- Check that your MCP URL is correct (no typos)
- Try refreshing the plugin in Framer

### Plugin keeps disconnecting
- The plugin closes previous connections when re-opened
- Only one plugin instance per user can be connected
- Keep the Framer project open while using MCP

### Tools not responding
- All requests have a 5-second timeout
- For complex operations, try breaking into smaller requests
- Check if Framer is responding (try simple UI actions)

### React Export not working
- React Export integrates with the [Framer React Export plugin](https://www.framer.com/marketplace/plugins/react-export/)
- May require subscription for full functionality
- Check unframer CLI is accessible


## Limitations

- **Plugin must be open**: Connection only works while Framer plugin is running
- **Single project**: Only the currently open project is accessible
- **User-specific URL**: Each user needs their own MCP URL (can't share config)
- **Framer API limits**: Subject to Framer's Plugin API capabilities


## References

- [Framer MCP Plugin](https://www.framer.com/marketplace/plugins/mcp/)
- [Framer Developer Docs](https://www.framer.com/developers/)
- [Framer API Reference](https://www.framer.com/developers/reference)
- [Unframer CLI](https://github.com/remorses/unframer) (for React export)
- [Planning Doc](../../plans/finished/251224_framer_mcp_improvements.md)
