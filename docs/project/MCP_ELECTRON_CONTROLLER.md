---
description: "rebel-electron MCP server setup — CDP-based Electron control, Factory registration, connection checks, and troubleshooting"
last_updated: "2026-02-04"
---

# MCP rebel-electron Server Setup

Instructions for registering and connecting the `rebel-electron` MCP server, which enables AI agents to control the Mindstone Rebel Electron app via Chrome DevTools Protocol (CDP).

**Why a custom MCP server?** The official `@playwright/mcp` does not support Electron apps. Our custom server (`resources/mcp/electron-debug/server.mjs`) fills this gap by spawning Electron with CDP enabled and exposing testing tools.

---

## Registration

Add the following to your MCP config (e.g., `~/.factory/mcp.json` for Factory, or your editor's equivalent):

```json
{
  "mcpServers": {
    "rebel-electron": {
      "type": "stdio",
      "command": "node",
      "args": ["<REPO_PATH>/resources/mcp/electron-debug/server.mjs"]
    }
  }
}
```

Replace `<REPO_PATH>` with the absolute path to this repository.

---

## Verify Connection (Factory)

Before using the MCP tools, confirm `rebel-electron` is connected:

1. Open `/mcp`
2. Find `rebel-electron` and ensure its status is **Connected**
3. Confirm tools like `spawn_dev_server`, `get_page_state`, `click_button`, `fill_input` are visible

---

## Troubleshooting Connection Issues

If the server shows **Disconnected**:

| Cause | Solution |
|-------|----------|
| Missing `type: "stdio"` in config | Add `"type": "stdio"` to the server entry |
| Factory cannot spawn `node` (nvm/PATH issues) | Set `command` to an absolute node path (e.g., `/usr/local/bin/node` or `~/.nvm/versions/node/v20.x.x/bin/node`) |
| Config file not found | Check config location: `~/.factory/mcp.json` (user) or `.factory/mcp.json` (project) |

---

## See Also

- [AGENT_UI_TESTING.md](AGENT_UI_TESTING.md) — Router for choosing Electron app verification paths, including this MCP server
- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) — MCP configuration details
- Server source: `resources/mcp/electron-debug/server.mjs`
