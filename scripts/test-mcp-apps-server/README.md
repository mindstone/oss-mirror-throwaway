# Test MCP Apps Server

A minimal MCP server for testing MCP Apps support in Mindstone Rebel.

## Quick Start

```bash
# 1. Install dependencies
cd scripts/test-mcp-apps-server
npm install

# 2. Add to your MCP config
#    Edit ~/.factory/mcp.json or your project's .factory/mcp.json:

{
  "mcpServers": {
    "test-mcp-apps": {
      "command": "node",
      "args": ["/path/to/rebel-app/scripts/test-mcp-apps-server/server.js"]
    }
  }
}

# 3. Enable MCP Apps in Rebel
#    Settings > Connectors > Experimental Options > MCP Apps (interactive tool views)

# 4. Test it
#    Ask Rebel: "Use the show_time tool to display the current time"
```

## Tools

### show_time
Displays the current time with a live-updating interactive view.

**Example prompts:**
- "Use show_time to display the current time"
- "Show me the time in Europe/London timezone"

### show_chart
Renders a bar chart visualization.

**Example prompts:**
- "Use show_chart to create a chart titled 'Sales' with data: Q1=100, Q2=150, Q3=120, Q4=200"

## How It Works

1. When a tool is called, it returns `_meta.ui.resourceUri` in the result
2. Rebel detects this and renders the McpAppView component
3. McpAppView fetches the HTML from the `ui://` URI via the `resources/read` handler
4. The HTML is rendered in a sandboxed iframe with:
   - `sandbox="allow-scripts"` (no network, forms, etc.)
   - Strict CSP headers
   - Origin isolation via blob: URLs

## Customizing

Edit `server.js` to add new tools or modify the HTML views. The server uses:
- `@modelcontextprotocol/sdk` for MCP protocol handling
- `StdioServerTransport` for communication with Rebel

## Troubleshooting

**MCP Apps not rendering:**
1. Check that the feature flag is enabled in Settings
2. Verify the server is connected (Settings > Connectors shows it)
3. Check console for errors (Cmd+Option+I in Rebel)

**Server not connecting:**
1. Verify the path in your MCP config is correct
2. Try running `node server.js` directly to check for errors
3. Check that `@modelcontextprotocol/sdk` is installed
