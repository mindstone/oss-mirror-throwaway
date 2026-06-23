---
description: "Shared Browser Tab MCP (community package, formerly Browser MCP) — uses the official Browser MCP Chrome extension to share the user's existing tab with Rebel"
last_updated: "2026-05-11"
status: "active"
---

# Shared Browser Tab (formerly Browser MCP)

Browser automation MCP for web navigation, scraping, form filling, and screenshot capture. Uses the official Browser MCP from [browsermcp.io](https://browsermcp.io/). **This is the community `browser-mcp` connector** — distinct from the separate `bundled-browser-automation` (rebel-oss) connector documented under "Browser Automation" in [MCP_OSS_CONNECTORS.md](../MCP_OSS_CONNECTORS.md).

> **Renamed**: This connector was renamed from "Browser MCP" to "Shared Browser Tab" to clarify its purpose — it shares the user's existing Chrome tab with Rebel, unlike Browser Automation which runs its own headless browser. The catalog ID remains `browser-mcp` for backward compatibility.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Official Documentation](https://docs.browsermcp.io/) - Browser MCP docs


## Overview

| Attribute | Value |
|-----------|-------|
| **Provider** | Community (npm package) |
| **Transport** | stdio |
| **Package** | `@browsermcp/mcp` |
| **License** | Apache-2.0 |
| **Auth** | None (local browser) |
| **Requires Setup** | Yes - Chrome extension |
| **Status** | Tested (Dec 2024) |


## Prerequisites

Before using Browser MCP, users must:

1. **Install the Chrome extension**: [Browser MCP - Chrome Web Store](https://chromewebstore.google.com/detail/browser-mcp-automate-your/bjfgambnhccakkhmkepdoekmckoijdlc)
2. **Connect a browser tab**: Open the extension and click "Connect" on the tab you want to automate


## Connector Catalog Entry

```json
{
  "id": "browser-mcp",
  "name": "Browser MCP",
  "description": "Browser automation for navigation, scraping, and form filling. Only use when explicitly instructed by the user or skill. Requires Chrome extension.",
  "category": "productivity",
  "provider": "community",
  "mcpConfig": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@browsermcp/mcp@latest"]
  },
  "icon": "globe",
  "popular": false,
  "verified": true,
  "verifiedSource": "https://browsermcp.io/"
}
```


## Tools

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_go_back` | Go back to the previous page |
| `browser_go_forward` | Go forward to the next page |
| `browser_snapshot` | Capture accessibility snapshot (get element refs) |
| `browser_click` | Click an element |
| `browser_type` | Type into an element |
| `browser_hover` | Hover over an element |
| `browser_drag` | Drag and drop between elements |
| `browser_select_option` | Select dropdown option(s) |
| `browser_press_key` | Press a keyboard key |
| `browser_wait` | Wait for a specified time |
| `browser_screenshot` | Screenshot current page |
| `browser_get_console_logs` | Get browser console logs |


## Usage Examples

**Navigate and search:**
```
Go to google.com and search for "Mindstone Rebel"
```

**Fill a form:**
```
Go to the contact page at example.com and fill out the name field with "John Doe"
```

**Take a screenshot:**
```
Navigate to dashboard.example.com and take a screenshot
```

**Scrape data:**
```
Go to linkedin.com/in/username and extract the profile summary
```


## How It Works

1. **MCP Server**: Runs locally via `npx @browsermcp/mcp@latest`
2. **Chrome Extension**: Connects to the MCP server via WebSocket on port 9009
3. **Tab Control**: Extension provides access to the currently connected browser tab
4. **Element Refs**: Use `browser_snapshot` to get element references, then use those refs in click/type/etc operations


## Technical Details

- **WebSocket Port**: 9009 (fixed, may conflict with other services)
- **Connection**: Extension ↔ MCP server via local WebSocket
- **Session State**: Uses your logged-in browser session (cookies, auth persist)


## Security Considerations

- **Browser Access**: Full access to connected browser tab (can see logged-in sessions)
- **Credential Exposure**: Can interact with authenticated sites (LinkedIn, banking, etc.)
- **Local Only**: Extension and server communicate only on localhost
- **User Consent**: User must manually connect each tab


## Troubleshooting

### "No connected tab" errors
- Open the Browser MCP Chrome extension
- Click "Connect" on the tab you want to automate
- Try the command again

### Port 9009 in use
- The MCP server binds to port 9009
- If another service uses this port, Browser MCP will fail to start
- Close conflicting services or restart your machine

### Extension not connecting
- Ensure Chrome is running
- Reinstall the extension from Chrome Web Store
- Check if other extensions are blocking WebSocket connections


## Common Use Cases

- Web scraping and data extraction
- Form filling and automation
- LinkedIn Sales Navigator workflows
- Automated testing and QA
- Screenshot capture for documentation


## References

- [Browser MCP Website](https://browsermcp.io/)
- [Documentation](https://docs.browsermcp.io/)
- [Chrome Extension](https://chromewebstore.google.com/detail/browser-mcp-automate-your/bjfgambnhccakkhmkepdoekmckoijdlc)
- [GitHub](https://github.com/browsermcp/mcp)
- [npm Package](https://www.npmjs.com/package/@browsermcp/mcp)
