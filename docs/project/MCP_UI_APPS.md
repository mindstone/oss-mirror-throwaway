---
description: "How Rebel renders interactive UI views from MCP tool results, including primary/inline presentation contract, trust strip, and Connected app permissions"
last_updated: "2026-05-11"
---

# MCP Apps (Interactive Tool Views)

How Rebel renders interactive UI views from MCP tool results.

> **Status**: Labs/Alpha - this feature is experimental and may change significantly.
> 
> **Important**: Do NOT document this in `help-for-humans/` until the feature is stable. It's too early for end-user documentation.

## See Also

- [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) - Overall MCP integration architecture
- [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md) - Super-MCP router (handles resource fetching)
- [MCP_APPS_BIDIRECTIONAL_TRUST_CONTRACT](MCP_APPS_BIDIRECTIONAL_TRUST_CONTRACT.md) - Trust model: which data MCP Apps can access, trust-boundary handshake, and Connected app permissions Settings panel
- [../research/MCP_UI_APPS_REFERENCE](../research/MCP_UI_APPS_REFERENCE.md) - Detailed MCP Apps specification research
- [TOOL_SAFETY](TOOL_SAFETY.md) - Tool safety evaluation (MCP Apps views are sandboxed)
- Planning doc: [260507 unified interactive UI architecture](../plans/260507_unified_interactive_ui_architecture.md) — `presentation: 'primary'`, `viewSummary`, `structuredFallback`, Safe view trust strip, three-scope model
- Planning doc: [260507 unified interactive UI architecture sequencing](../plans/260507_unified_interactive_ui_architecture_sequencing.md) — Phase A/B/C/D/E rollout

**Implementation references:**
- `src/shared/types/agent.ts` — `McpAppUiMeta` interface (`presentation`, `viewSummary`, `viewRoleLabel`, `structuredFallback`)
- `src/main/services/agentMessageHandler.ts` — Producer policy: three-method detection, `presentation` contract enforcement, Method 3 must NOT promote to `'primary'`
- `src/renderer/features/agent-session/components/McpAppView.tsx` - View renderer component
- `src/main/ipc/mcpAppsHandlers.ts` - IPC handler for resource fetching
- `scripts/test-mcp-apps-server/` - Test server for development


## What Are MCP Apps?

MCP Apps extend the MCP protocol to allow tools to return interactive HTML views alongside their text results. When a tool result includes UI metadata, Rebel renders it as an interactive iframe within the conversation.

**Example flow:**
1. User asks: "Show me the current time"
2. Agent calls `show_time` tool
3. Tool returns: `{ content: [...], _meta: { ui: { resourceUri: "ui://server/time.html" } } }`
4. Rebel detects `_meta.ui.resourceUri` and renders `McpAppView`
5. User sees an interactive clock widget inline with the conversation

### Primary Views (`presentation: 'primary'`)

Tools whose UI is the **primary output** of the turn (e.g., an editable email draft, a generated chart) can declare `presentation: 'primary'` in `_meta.ui`. This collapses the agent's prose to a one-line caption and renders the view as the message body.

When `presentation: 'primary'` is declared, `viewSummary` is **required** (schema-enforced). `viewSummary` provides:
- Mobile / accessibility fallback when the iframe cannot render
- Search index content (indexed only when `presentation: 'primary'`)
- Recovery surface text when the view fails to load

Primary views also carry a **trust strip** ("From Google Workspace · Safe view") above the view chrome. The strip identifies the MCP package and signals that the view runs sandboxed. The word "Safe" is used in user-facing copy; "Sandboxed" is reserved for code, logs, and diagnostics.

`structuredFallback` (optional) carries a typed plaintext payload (e.g., `{ kind: 'email-draft', payload: { to, cc, subject, body } }`) for recovery surfaces and mobile when the iframe cannot render — the user gets the actual draft content, not just a summary.

The `presentation: 'primary'` opt-in is producer-driven; Method 3 regex detection (`[View: ui://...]`) must NOT promote matched tools to `'primary'` — that path lacks sufficient provenance.

See [260507 unified interactive UI architecture plan](../plans/260507_unified_interactive_ui_architecture.md) § Phase A for full design rationale, IA decisions, and rollout phases.


## Feature Flag

MCP Apps is gated by an experimental feature flag:

**Location**: Settings → Connectors → Experimental Options → MCP Apps

**Setting path**: `settings.experimental.mcpAppsEnabled`

When disabled (default), the `_meta.ui` metadata is still extracted but no View is rendered.


## Architecture

```
Tool Result with _meta.ui
         │
         ▼
┌─────────────────────────────────────────┐
│ Main Process: agentMessageHandler.ts     │
│ - Extracts _meta.ui.resourceUri         │
│ - Attaches to AgentEvent                │
└────────────────┬────────────────────────┘
                 │ IPC: agent:event
                 ▼
┌─────────────────────────────────────────┐
│ Renderer: toolChips.ts                  │
│ - Passes mcpAppUiMeta through summary   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Renderer: TurnStepsInline.tsx           │
│ - Checks feature flag                   │
│ - Renders McpAppView when present       │
└────────────────┬────────────────────────┘
                 │ IPC: mcp:read-resource
                 ▼
┌─────────────────────────────────────────┐
│ Main Process: mcpAppsHandlers.ts        │
│ - Fetches HTML via Super-MCP            │
│ - Returns content to renderer           │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Renderer: McpAppView.tsx                │
│ - Creates blob: URL for HTML            │
│ - Renders in sandboxed iframe           │
│ - Handles postMessage communication     │
└─────────────────────────────────────────┘
```

### Trust Strip and Connected App Permissions

Every primary-rendered third-party view carries a **trust strip** above the view chrome: "From Google Workspace · Safe view". The strip identifies the originating MCP package and confirms the view runs sandboxed. "Safe view" is the user-facing term; "Sandboxed" is used only in code, logs, and diagnostics.

Users can view and revoke the permissions granted to each Connected app in **Settings → Connectors → Connected apps**. This panel shows which apps have access to which data categories and lets users manage trust. See [MCP_APPS_BIDIRECTIONAL_TRUST_CONTRACT](MCP_APPS_BIDIRECTIONAL_TRUST_CONTRACT.md) for the full trust model.

## Security Model

MCP Apps views run in a strict sandbox:

| Control | Value | Purpose |
|---------|-------|---------|
| `sandbox` | `allow-scripts` | Only JavaScript, no forms/navigation/popups |
| CSP | `default-src 'none'; script-src 'unsafe-inline' [resourceDomains]; ...` | Restrictive by default, MCP servers can declare allowed domains |
| Origin | `blob:` URL | Origin isolation from app |
| Frame navigation | Blocked | Cannot navigate away |

### CSP Domain Allowlists (MCP Apps spec compliance)

MCP servers can declare CSP domain allowlists via `_meta.ui.csp` in tool results:
- `resourceDomains` — allowed in `script-src`, `style-src`, `img-src`, `font-src`, `media-src`
- `connectDomains` — allowed in `connect-src` (fetch/XHR/WebSocket)
- `frameDomains` — allowed in `frame-src` (nested iframes)

**RebelCanvas HTML previews** (`rebel_canvas_html`) allowlist `cdnjs.cloudflare.com` and Google Fonts by default. Users can also add custom trusted domains via `trustedPreviewDomains` in settings.

**What Views CAN do:**
- Run inline JavaScript
- Apply inline CSS styles
- Load scripts/styles from server-declared `resourceDomains`
- Receive data via postMessage
- Display dynamic content

**What Views CANNOT do:**
- Make network requests unless server declares `connectDomains`
- Access parent window or cookies
- Submit forms or open popups
- Navigate to other URLs
- Access local storage
- Load scripts from arbitrary CDNs (only declared domains)


## Data Flow

### Tool Result → UI Metadata

Tool results include `_meta.ui`:

```json
{
  "content": [{ "type": "text", "text": "Current time: 10:30 AM" }],
  "_meta": {
    "ui": {
      "resourceUri": "ui://server-name/view.html",
      "visibility": ["app"],
      "csp": "...",
      "permissions": []
    }
  }
}
```

### McpAppUiMeta Interface

```typescript
interface McpAppUiMeta {
  resourceUri: string;           // Required: ui:// URI for the View
  presentation?: 'primary' | 'inline';  // 'primary' requires viewSummary; default 'inline'
  viewSummary?: string;          // Required when presentation is 'primary'; short plaintext summary
  viewRoleLabel?: string;        // Short noun phrase: "Editable draft", "Generated chart"
  structuredFallback?: McpAppStructuredFallback;  // Typed plaintext for recovery/mobile
  sourcePackageId?: string;      // MCP package instance ID that produced this result
  visibility?: ('model' | 'app')[];  // Who can see this
  csp?: string;                  // Custom CSP (server can specify)
  permissions?: string[];        // Future: request additional permissions
}
```

For the full discriminated-union shape of `McpAppStructuredFallback`, see `src/shared/types/agent.ts` (`McpAppUiMeta`). The contract: `presentation: 'primary'` requires `viewSummary` (Zod refinement at schema boundary).

### Resource Fetching

The `mcp:read-resource` IPC channel fetches View content:

```typescript
// Request
{ uri: 'ui://server-name/view.html' }

// Response
{
  contents: [{
    uri: 'ui://server-name/view.html',
    mimeType: 'text/html;profile=mcp-app',
    text: '<!DOCTYPE html>...'
  }]
}
```


## Creating MCP Apps-Compatible Tools

### Minimal Server Example

See `scripts/test-mcp-apps-server/` for a complete example.

Key patterns:
1. Return `_meta.ui.resourceUri` in tool results
2. Handle `resources/read` requests for `ui://` URIs
3. Return HTML with `mimeType: 'text/html;profile=mcp-app'`

### View HTML Guidelines

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    /* Inline styles only - no external CSS */
    body { font-family: system-ui; padding: 16px; }
    /* Support dark mode */
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #f0f0f0; }
    }
  </style>
</head>
<body>
  <div id="content">Loading...</div>
  <script>
    // Inline scripts only
    // Can use postMessage to communicate with host
    window.addEventListener('message', (e) => {
      if (e.data.type === 'tool-result') {
        // Handle tool result data
      }
    });
  </script>
</body>
</html>
```


## Testing

### Enable the Feature

1. Open Settings (Cmd+,)
2. Go to Connectors tab
3. Scroll to "Experimental Options"
4. Enable "MCP Apps (interactive tool views)"

### Use the Test Server

```bash
cd scripts/test-mcp-apps-server
npm install
```

Add to your MCP config:
```json
{
  "mcpServers": {
    "test-mcp-apps": {
      "command": "node",
      "args": ["/path/to/scripts/test-mcp-apps-server/server.js"]
    }
  }
}
```

Test prompts:
- "Use show_time to display the current time"
- "Use show_chart to create a chart with Q1=100, Q2=150, Q3=200"


## Troubleshooting

**Views not rendering:**
1. Verify feature flag is enabled
2. Check that the tool result has `_meta.ui.resourceUri`
3. Look for errors in devtools console (Cmd+Option+I)

**Resource fetch failing:**
1. Verify the MCP server implements `resources/read`
2. Check Super-MCP is running (Settings → Diagnostics)
3. Confirm the URI scheme is `ui://`

**Blank iframe:**
1. Check CSP isn't blocking content
2. Verify HTML is valid
3. Look for JavaScript errors in iframe


## Implementation Notes

### Why blob: URLs?

We use blob: URLs instead of custom protocols because:
- Electron's `protocol.registerSchemesAsPrivileged` must be called before app ready
- Custom protocols require significant security configuration
- blob: URLs provide origin isolation naturally

### Why Extract from Tool Results?

The MCP Apps spec links UI to tools via tool definitions (`tools/list`), but we extract from tool results because:
- Allows dynamic UI based on execution context
- Works with tools that don't declare UI upfront
- Simpler implementation for MVP

### Future Enhancements

- [ ] Larger Views in work surface (not just inline)
- [ ] postMessage API for host ↔ View communication
- [ ] Permission escalation (network access for trusted servers)
- [ ] View persistence across conversation reload


## Blessed CDN Libraries

The `rebel_canvas_html` tool allows AI-generated HTML to load JavaScript libraries from `cdnjs.cloudflare.com`. We maintain a curated list of **blessed libraries** with pinned versions.

**Canonical source:** `resources/mcp/rebel-canvas/server.cjs` — the `rebel_canvas_html` tool description lists exact CDN URLs. The auto-fix prompt in `src/renderer/App.tsx` also references these versions.

**Current blessed libraries (pinned 2026-03-27):**

| Library | Version | Use Case |
|---------|---------|----------|
| Chart.js | 4.4.1 | Charts, dashboards, KPIs |
| Mermaid | 11.4.0 | Flowcharts, org charts, Gantt, sequence diagrams |
| D3.js | 7.9.0 | Advanced custom visualizations |
| Leaflet | 1.9.4 | Interactive maps (requires tile.openstreetmap.org in CSP) |

**Updating versions:** Check `curl -I <cdnjs-url>` returns HTTP 200 (cdnjs lags behind npm). Update the URL in both `server.cjs` (tool description) and `App.tsx` (auto-fix prompt). Note: `resources/` is excluded from eslint.

**CSP note:** Leaflet needs `tile.openstreetmap.org` in `resourceDomains` for map tiles. This also grants script/style permission to that domain (no separate `img-only` CSP support). The security risk is negligible — the server only serves PNG tiles.

**Folder mode caveat:** The `folderPath` preview mode uses `rebel-preview://` protocol which doesn't support external CDN scripts. The blessed libraries work only in inline HTML and file modes.


## Maintenance

When changing MCP Apps code, update this doc. Key files to watch:
- `McpAppView.tsx` - rendering and security
- `mcpAppsHandlers.ts` - resource fetching
- `agentMessageHandler.ts` - metadata extraction
- `TurnStepsInline.tsx` - integration point
