---
description: "Figma Desktop MCP connector reference — local HTTP server setup, verified read-only tools, rate limits, write-access limits"
last_updated: "2026-02-19"
---

# Figma MCP

**Status:** Active (Feb 2026)
**Catalog ID:** `figma-desktop`
**Provider:** Direct (official Figma Desktop MCP)
**Auth:** None (inherits Figma desktop app login)
**Transport:** Streamable HTTP at `http://127.0.0.1:3845/mcp`

## Overview

The Figma connector enables design-to-code workflows by connecting Rebel to Figma's design files via the official Figma Desktop MCP server. The server runs locally inside the Figma desktop app and exposes a Streamable HTTP endpoint. No API key or OAuth required -- it uses the desktop app's existing login session.

## Tools (Verified via `listTools`)

**Last verified:** 2026-02-19

The desktop MCP exposes **6 read-only tools** (verified by calling `listTools()` directly):

| Tool | Description | Type |
|------|-------------|------|
| `get_design_context` | Fetch structured design context (React + Tailwind by default) for selected frames. Supports selection-based and link-based prompting. | Read |
| `get_variable_defs` | Extract design variables and styles (colors, spacing, typography). | Read |
| `get_screenshot` | Take a screenshot of the current selection for layout fidelity reference. | Read |
| `get_metadata` | Return XML representation of selection with layer IDs, names, types, positions, sizes. Useful for large designs. | Read |
| `create_design_system_rules` | Generate a rules file for agents to produce code aligned with the design system. | Read |
| `get_figjam` | Return FigJam diagram metadata in XML format with screenshots. | Read |

### Tools Listed in Figma Docs but NOT Available on Desktop

These tools appear in [Figma's official docs](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) but are **not exposed** by the desktop server:

| Tool | Availability | Notes |
|------|-------------|-------|
| `get_code_connect_map` | Not on desktop | Listed in docs but not returned by `listTools()` |
| `add_code_connect_map` | Remote only | Write: adds node-to-code mappings |
| `generate_figma_design` | Remote + Claude Code only | Write: sends UI as design layers to Figma files |
| `generate_diagram` | Remote only | Write: generates FigJam diagrams from Mermaid syntax |
| `whoami` | Remote only | User identity, plans, seat types |
| `get_code_connect_suggestions` | Not on desktop | Suggest component mappings |
| `send_code_connect_mappings` | Not on desktop | Confirm Code Connect mappings |

**No write tools are available on the desktop MCP.** All write capabilities require either the remote MCP server (restricted to approved clients) or a community plugin-based approach (see [Write Access](#write-access-via-community-mcp) below).

## Setup

Users connect in Settings > Connectors:

1. Download and open the **Figma desktop app**
2. Open a Figma Design file and switch to **Dev Mode** (Shift+D)
3. In the inspect panel, click **Enable desktop MCP server**
4. In Rebel, find "Figma (Desktop)" and click Connect

The Figma desktop app must remain running with Dev Mode active for the connection to work.

## Requirements

- **Figma desktop app** -- must be running with Dev Mode enabled
- **Paid Figma plan** -- Dev or Full seat required (Starter plan limited to 6 tool calls/month)
- **No API key needed** -- authentication is handled by the desktop app's login session

## Rate Limits

| Plan | Limit |
|------|-------|
| Starter plan / View / Collab seats | 6 tool calls/month |
| Dev or Full seats (Professional, Organization, Enterprise) | Per-minute, matching Figma REST API Tier 1 limits |

## Previous Limitation: `tools/list` (Now Fixed)

**Status:** FIXED as of 2026-02-19

The `tools/list` bug that previously caused `listTools()` to hang indefinitely has been resolved by Figma. The desktop MCP server now responds correctly to `tools/list` requests, returning all 6 tools.

### History

Previously, the server advertised `tools: { listChanged: true }` in its capabilities but never responded to `tools/list`, causing Super-MCP to mark the package as `status: "error"`. A passthrough workaround in `super-mcp/src/handlers/useTool.ts` forwarded `callTool` directly to the upstream server when the catalog was degraded. This workaround is now moot but remains as a general-purpose safety net for any future MCP server with similar issues.

### Verification

```bash
cd super-mcp && node -e "
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
(async () => {
  const c = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3845/mcp')));
  try {
    const r = await c.listTools(undefined, { timeout: 5000 });
    console.log('Tools:', r.tools?.map(t => t.name));
  } catch (e) { console.log('Still broken:', e.message); }
  process.exit(0);
})();
"
```

## Architecture

The connector is a `direct` provider with a hardcoded localhost URL:

```json
{
  "id": "figma-desktop",
  "provider": "direct",
  "mcpConfig": {
    "transport": "http",
    "type": "http",
    "url": "http://127.0.0.1:3845/mcp"
  }
}
```

Unlike remote direct connectors (Notion, Linear), the Figma Desktop MCP runs locally. If the desktop app is not running or Dev Mode is not active, the connection attempt will fail.

## Remote MCP Server (Not Yet Available)

Figma also operates a remote MCP server at `https://mcp.figma.com/mcp` that works without the desktop app. However, it is **restricted to pre-approved clients only** and is not currently accessible to Rebel.

### Approved Clients (as of Feb 2026)

VS Code, Cursor, Claude Code, Claude Desktop, Windsurf, Replit, Codex by OpenAI, Google Gemini CLI, Android Studio, Kiro, Amazon Q, Warp, Zed, Atlassian Studio, ServiceNow Build Agent.

Full list: https://www.figma.com/mcp-catalog/

### Why It's Blocked

The remote server requires OAuth with a special `mcp:connect` scope. This scope is not available to third-party OAuth apps:

- Attempting to request `mcp:connect` returns `400 Invalid scopes for app`
- Figma has not published a public application form or beta program for access
- Forum posts asking about third-party access remain unanswered by Figma staff
- The MCP spec's Dynamic Client Registration (DCR) is supported in theory, but Figma's implementation rejects unrecognized clients at the authorization level

### Additional Tools on Remote (vs Desktop)

The remote server provides tools not available on desktop, including write tools:

| Tool | Description | Type |
|------|-------------|------|
| `generate_figma_design` | Send UI as design layers to new/existing Figma files or clipboard | Write (Claude Code only) |
| `generate_diagram` | Generate FigJam diagrams from Mermaid syntax | Write |
| `add_code_connect_map` | Add Figma node to code component mappings | Write |
| `whoami` | Authenticated user identity, plans, seat types | Read |
| `get_code_connect_map` | Retrieve node-to-code component mappings | Read |
| `get_code_connect_suggestions` | Suggest component mappings | Read |
| `send_code_connect_mappings` | Confirm Code Connect mappings | Read |

### Rate Limits (Remote)

| Seat | Starter | Professional | Organization | Enterprise |
|------|---------|-------------|-------------|-----------|
| View, Collab | 6/month | 6/month | 6/month | 6/month |
| Dev, Full | -- | 10/min, 200/day | 15/min, 200/day | 20/min, 600/day |

### Path to Access

1. **Waitlist form** -- Figma has a waitlist for third-party MCP clients: https://form.asana.com/?k=kBG-ejRQTdY8x_H6a4vM3Q&d=10497086658021
2. **Direct outreach to Figma** -- Contact their developer relations / partnerships team to request `mcp:connect` scope access. This is likely a business/partnership decision, not a technical process.
3. **Monitor Figma developer forum** -- Watch for any announcements about opening up third-party access: https://forum.figma.com
4. **Monitor Figma developer docs** -- Remote server docs: https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/

### If/When Access Is Granted

When Figma approves Rebel as a client, add a new `figma-remote` catalog entry:

```json
{
  "id": "figma-remote",
  "name": "Figma",
  "provider": "direct",
  "mcpConfig": {
    "transport": "http",
    "type": "http",
    "url": "https://mcp.figma.com/mcp",
    "oauth": true
  }
}
```

At that point, consider making the remote entry the default (popular, primary name) and renaming the desktop entry to "Figma (Desktop)" as a fallback for offline use or selection-based prompting (which is desktop-only).

## Write Access via Community MCP

The official Figma MCP (both desktop and remote) provides **no design write tools** accessible to Rebel. The only path to programmatic write access to Figma design nodes is via the **Figma Plugin API**, which runs inside Figma's sandbox.

### Why Write Requires a Plugin

The Figma Plugin API is the only interface with read/write access to design nodes (create/modify/delete shapes, text, frames, styles, etc.). It runs in a sandboxed main thread inside the Figma desktop app. The sandbox has no browser APIs -- network access (fetch, WebSocket) is only available through a plugin UI `<iframe>`, which communicates with the sandbox via `postMessage`. There is no headless/API-only mode.

```
┌──────────────────────────────────────────────────────┐
│                  Figma Desktop App                    │
│  ┌────────────────────┐     ┌──────────────────────┐ │
│  │  Main Thread        │     │  iframe (Plugin UI)  │ │
│  │  (Plugin Sandbox)   │◄───►│  (Browser APIs)      │ │
│  │  - figma.create*()  │ msg │  - WebSocket         │ │
│  │  - node.fills = []  │pass │  - Fetch             │ │
│  │  - NO browser APIs  │     │  - NO figma.* access │ │
│  └────────────────────┘     └──────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

The Figma REST API has extremely limited write operations (comments, webhooks only) -- no programmatic design node creation or modification.

### Community MCP Options for Write Access

#### cursor-talk-to-figma-mcp (Recommended for Write)

| Attribute | Value |
|-----------|-------|
| Repository | https://github.com/grab/cursor-talk-to-figma-mcp |
| License | MIT |
| Stars | 6.3k |
| Maintainer | Sonny Lazuardi / Grab |
| Last commit | Jan 2026 |
| Transport | stdio (MCP server) + WebSocket (relay + plugin bridge) |

**Architecture:**

```
MCP Client (Rebel)
    │ stdio
    ▼
MCP Server (server.ts, 3100 LOC)
    │ WebSocket
    ▼
WebSocket Relay (socket.ts, 180 LOC)
    │ WebSocket
    ▼
Figma Plugin UI (iframe, WebSocket client)
    │ postMessage
    ▼
Figma Plugin Main Thread (code.js, 4000 LOC)
    │ Figma Plugin API
    ▼
Figma Document (full read/write)
```

**Write tools (25+):**

| Category | Tools |
|----------|-------|
| Creating elements | `create_rectangle`, `create_frame`, `create_text` |
| Modifying content | `set_text_content`, `set_multiple_text_contents`, `scan_text_nodes` |
| Styling | `set_fill_color`, `set_stroke_color`, `set_corner_radius` |
| Layout | `move_node`, `resize_node`, `set_layout_mode`, `set_padding`, `set_axis_align`, `set_layout_sizing`, `set_item_spacing` |
| Organization | `delete_node`, `delete_multiple_nodes`, `clone_node` |
| Components | `create_component_instance`, `get_instance_overrides`, `set_instance_overrides` |
| Annotations | `set_annotation`, `set_multiple_annotations` |
| Navigation | `set_focus`, `set_selections` |
| Prototyping | `get_reactions`, `set_default_connector`, `create_connections` |
| Export | `export_node_as_image` |

**Read tools:**

`get_document_info`, `get_selection`, `read_my_design`, `get_node_info`, `get_nodes_info`, `get_styles`, `get_local_components`, `get_annotations`, `scan_nodes_by_types`

**Dependency:** Requires Bun runtime (MCP server + WebSocket relay are Bun-native).

#### Framelink / Figma-Context-MCP (Read Only)

| Attribute | Value |
|-----------|-------|
| Repository | https://github.com/GLips/Figma-Context-MCP |
| License | MIT |
| Auth | Personal Access Token (PAT) |
| Capabilities | Read-only (fetch file data, simplified layout/styling for AI) |

Previously used by Rebel (catalog ID `figma-local`, version 0.6.4 pinned). Removed in favor of the official Desktop MCP.

### Proposal: Custom Figma Write MCP for Rebel

To add write access without depending on the community package or Bun, the recommended approach is to build a **bundled MCP** that ports the cursor-talk-to-figma-mcp architecture to Node.js.

#### Proposed Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Rebel (Electron Main)                      │
│  ┌──────────┐   ┌───────────────┐   ┌──────────────────────┐│
│  │ Agent SDK │──►│ Super-MCP     │──►│ figma-write MCP      ││
│  │           │   │ (HTTP router) │   │ (bundled, stdio)     ││
│  └──────────┘   └───────────────┘   └──────────┬───────────┘│
│                                                  │            │
│                                     ┌────────────▼──────────┐│
│                                     │ WebSocket Relay       ││
│                                     │ (Node.js, ws package) ││
│                                     │ localhost:3055        ││
│                                     └────────────┬──────────┘│
└──────────────────────────────────────────────────┼───────────┘
                                                   │ WebSocket
                                    ┌──────────────▼──────────┐
                                    │ Figma Desktop App       │
                                    │ ┌─────────┐ ┌────────┐ │
                                    │ │Plugin UI │►│code.js │ │
                                    │ │(iframe)  │ │(sandbox│ │
                                    │ │WebSocket │ │figma.*)│ │
                                    │ └─────────┘ └────────┘ │
                                    └─────────────────────────┘
```

#### What to Build vs Reuse

| Component | Action | Effort | Notes |
|-----------|--------|--------|-------|
| MCP Server | Fork + port to Node.js | Medium | Remove Bun dep, use `ws` package (already in Rebel deps). ~3100 LOC. |
| WebSocket Relay | Port from Bun | Low | Replace `Bun.serve` with `ws`. ~180 LOC. Embed in MCP process. |
| Figma Plugin | Fork + rebrand | Low | `code.js` + `ui.html`. Publish as "Rebel Figma Plugin" to Figma Community. |
| Catalog entry | New | Low | `connector-catalog.json` entry for `figma-write` |
| Setup flow | New | Medium | Auto-start relay on connect, guide user to install plugin |

#### Key Design Decisions

1. **WebSocket relay embedded in MCP process** -- keep it self-contained like other bundled MCPs (relay is only 180 LOC).
2. **Publish our own Figma plugin** -- maintain control, keep protocol compatibility with the original.
3. **Tool scope** -- ship ~30 core tools, skip `execute_code` (arbitrary code execution risk).
4. **Coexistence** -- keep existing `figma-desktop` (read-only, official, no plugin needed) alongside new `figma-write` (read+write, requires plugin).

#### User Experience

1. Settings > Connectors > "Figma (Write)" -- setup instructions link to install the Rebel Figma Plugin
2. Click Connect -- Rebel auto-starts WebSocket relay + MCP server
3. Open Figma, run the plugin, it auto-connects to `ws://localhost:3055`
4. Agent has full read+write access via 30+ MCP tools

#### Risks

| Risk | Mitigation |
|------|------------|
| Figma changes Plugin API | Plugin API is stable (v1, 66+ updates). Broad community dependency. |
| Unauthenticated localhost WebSocket | Same model as official Figma Desktop MCP (`127.0.0.1:3845`). Localhost-only. |
| Plugin must stay running in Figma | Unavoidable platform constraint. Clear user messaging + health check. |
| Maintenance of forked code | ~7100 LOC total. Protocol is simple JSON over WebSocket, low churn expected. |
| Tool safety (write tools modify designs) | Rebel's tool safety service evaluates each call. Write tools require user approval by default. |

#### Effort Estimate

| Phase | Work | Est. |
|-------|------|------|
| Port MCP server to Node.js + embed relay | Remove Bun, use `ws` | 1-2 days |
| Fork + rebrand Figma plugin | Minimal changes to `code.js` + `ui.html` | 0.5 day |
| Catalog entry + setup flow | `connector-catalog.json`, `bundledMcpManager.ts` | 0.5 day |
| Testing + polish | End-to-end testing, error handling | 1 day |
| Publish plugin to Figma Community | Account setup, review process | 1-2 days (async) |
| Documentation | Update this doc, user-facing docs | 0.5 day |
| **Total** | | **~4-5 days** |

## Previous: Community MCP (Removed)

Prior to Feb 2026, we used the community `figma-developer-mcp` package (Framelink, catalog ID `figma-local`) with Personal Access Token auth. This was removed in favor of the official Desktop MCP, which provides richer capabilities (Code Connect, variables, metadata, FigJam support) without requiring token management.

## References

- [Figma MCP Server Guide (GitHub)](https://github.com/figma/mcp-server-guide)
- [Figma MCP Catalog](https://www.figma.com/mcp-catalog/)
- [Figma MCP Tools & Prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [Figma MCP Plans, Access & Permissions](https://developers.figma.com/docs/figma-mcp-server/plans-access-and-permissions/)
- [Desktop Server Installation](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)
- [Remote Server Installation](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
- [Remote Server Waitlist](https://form.asana.com/?k=kBG-ejRQTdY8x_H6a4vM3Q&d=10497086658021)
- [Figma Plugin API: How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/)
- [Figma Plugin API Reference](https://developers.figma.com/docs/plugins/api/api-reference/)
- [cursor-talk-to-figma-mcp (Write MCP)](https://github.com/grab/cursor-talk-to-figma-mcp)
- [Framelink / Figma-Context-MCP (Read MCP)](https://github.com/GLips/Figma-Context-MCP)
- [Figma MCP Guide](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)
- Linear: FOX-2495
