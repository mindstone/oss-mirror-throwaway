---
description: "MCP integration architecture: server configuration, authentication, transport, and the connector catalog"
last_updated: "2026-06-11"
---

# MCP Architecture

How Rebel integrates MCP servers for tool extensibility—architecture, configuration, authentication, and the connector catalog.

## See Also

**Getting started:**
- [MCP_OVERVIEW](MCP_OVERVIEW.md) — **Territory hub**: routes to every MCP doc (development, OSS release, testing, security, MCP Apps)
- [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) — **Start here for MCP development**: workflow, decision tree, patterns
- [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md) — Super-MCP HTTP mode lifecycle, health checks, troubleshooting

**Related architecture:**
- [ARCHITECTURE_OVERVIEW](ARCHITECTURE_OVERVIEW.md) — High-level system architecture
- [ARCHITECTURE_IPC](ARCHITECTURE_IPC.md) — IPC contract system for MCP operations
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — App settings including `mcpConfigFile`
- [AUTHENTICATION](AUTHENTICATION.md) — App-level auth (intersects with connector OAuth)

**Deep dives:**
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md) — **STOP: Read before externalizing any OAuth connector.** Auth modes, security, per-provider capability matrix, token persistence, shared primitives
- [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md) — How MCP updates propagate to users (version bumps, new tools, caching edge cases)
- [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md) — OSS connector distribution: rebel-oss architecture, managed installs (releases: [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md))
- [../research/libraries/MCP_SDK_REFERENCE](../research/libraries/MCP_SDK_REFERENCE.md) — MCP protocol fundamentals, TypeScript SDK
- [KLAVIS_TO_BUNDLED_MCP_MIGRATION](KLAVIS_TO_BUNDLED_MCP_MIGRATION.md) — Migration guide for bundled local MCPs
- [MOVING_REBEL_BETWEEN_COMPUTERS](MOVING_REBEL_BETWEEN_COMPUTERS.md) — Resetting the MCP router after transferring Rebel to a new machine
- [MCP_UI_APPS](MCP_UI_APPS.md) — MCP Apps (interactive tool views) - experimental feature for rendering UI from tool results
- [MCP_APP_SUPER_MCP_SEAM](MCP_APP_SUPER_MCP_SEAM.md) — authoritative app-consumed Super-MCP seam table; typed counterpart is `src/core/rebelCore/superMcpContract.ts`

**Implementation references:**
- `src/main/services/mcpService.ts` — Config resolution, transport inference, router wiring
- `src/main/services/superMcpHttpManager.ts` — Super-MCP HTTP lifecycle
- `src/main/services/bundledMcpManager.ts` — Bundled MCP payload builders
- `resources/connector-catalog.json` — Static connector catalog
- `src/shared/types.ts` — `AppSettings`, `ConnectorCatalogEntry`, `McpServerConfigEntry`


## Principles and Key Decisions

1. **Single configuration pointer**: `AppSettings.mcpConfigFile` is the single source of truth. All MCP behavior flows from whatever JSON file this points to.

2. **Router-first, HTTP-only**: Super-MCP router is the default. Direct MCP attachment is a debug-only escape hatch (`MINDSTONE_FORCE_DIRECT_MCP` or Settings → Advanced (Support tab)).

3. **MCP-first extensibility**: Rebel doesn't hardcode tool lists—tools come from MCP servers. The app defers to whatever the config provides.

4. **Ecosystem compatibility**: The resolver understands Claude Desktop, Cursor, Factory CLI, and Super-MCP config formats so users can reuse existing configs.

5. **Provider distinction is operational**: Bundled vs Direct vs Community encodes real architectural differences (credential storage, trust boundaries, IPC patterns), not just UI labels.


## Architecture Overview

Rebel is an **MCP client** connecting to multiple MCP servers during agent turns:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Electron Main Process                        │
│                                                                 │
│  ┌──────────────────────┐    ┌────────────────────────────────┐│
│  │ Rebel Core           │───►│ Super-MCP HTTP Router          ││
│  │ (single HTTP entry)  │    │ localhost:3000+                ││
│  └──────────────────────┘    └────────────┬───────────────────┘│
│                                           │                     │
└───────────────────────────────────────────┼─────────────────────┘
                                            │ Fans out to:
          ┌─────────────────────────────────┼─────────────────────┐
          │                                 │                     │
          ▼                                 ▼                     ▼
┌─────────────────┐               ┌─────────────────┐   ┌─────────────────┐
│ Bundled MCPs    │               │ Direct MCPs     │   │ Community MCPs  │
│ (stdio child    │               │ (vendor HTTP    │   │ (npx stdio)     │
│ processes)      │               │ endpoints)      │   │                 │
└─────────────────┘               └─────────────────┘   └─────────────────┘
```


## Provider Types

The UI branches on `provider` because each type has fundamentally different operational semantics:

| Provider | Code Location | Execution | Credentials | Trust Boundary |
|----------|---------------|-----------|-------------|----------------|
| **bundled** | Ships in `/resources/mcp/` | Local stdio process | `userData/` (varies by connector) | OS user account |
| **rebel-oss** | npm (`@mindstone-engineering/*`) | Managed install → `node <path>` (npx fallback) | Config env vars + `userData/` | OS user account + Mindstone-authored |
| **direct** | Vendor-hosted | Remote HTTP/SSE | Vendor's OAuth server | Network + vendor |
| **community** | npm/uvx packages | Local via npx/uvx | Config env vars | Package author |

**Canonical type definition**: `src/shared/types.ts` → `ConnectorProvider = 'direct' | 'community' | 'bundled'`

> **rebel-oss deep dive**: See [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md) for the full managed install lifecycle, startup migration chain, cross-surface handling, and performance benchmarks.

### Why This Matters

- **Bundled**: Rebel is the OAuth client, credentials stored locally (paths vary: `google-workspace-mcp/`, `microsoft-mcp/`, `mcp/slack/`, etc.)
- **Direct**: Vendor is the OAuth client, authentication handled via Super-MCP's OAuth flow
- **Community**: User must trust the package author; Python MCPs require user's Python installation


## Connection Transports

| Transport | Description | Use Case |
|-----------|-------------|----------|
| **stdio** | Spawn local process, stdin/stdout | Bundled MCPs, community MCPs |
| **StreamableHTTP** | Sessionful HTTP with `Mcp-Session-Id` tracking; supports per-session server isolation and idle session GC | Super-MCP router (default) |
| **HTTP** | Stateless request/response | Some direct connectors |
| **SSE** | Server-Sent Events streaming | Some direct MCP servers |

**Super-MCP default transport**: StreamableHTTP with per-session `Server` + `StreamableHTTPServerTransport` pairs. Each MCP client (agent turn, health check, inbox sync) gets its own isolated session tracked by `Mcp-Session-Id` header. Idle sessions are reaped after 30 minutes. Clients must call `transport.terminateSession()` before `client.close()` for clean session teardown. See [SUPERMCP_OVERVIEW.md](SUPERMCP_OVERVIEW.md) for lifecycle details and the [StreamableHTTP planning doc](../plans/260326_rebel_core_super_mcp_streamable_http_fix.md) for design rationale.

**Tool output handling**: Super-MCP uses a dual-threshold system: `MATERIALIZATION_THRESHOLD_CHARS` (default **20K chars**) triggers auto-materialization to `{workspace}/.rebel/tool-outputs/`; `DEFAULT_MAX_OUTPUT_CHARS` (default **100K chars**) triggers truncation + `result_id`/`output_offset` continuation as fallback. Explicit `max_output_chars` overrides both; `null` disables both. See [SUPERMCP_OVERVIEW.md § Tool Output Truncation and Continuation](SUPERMCP_OVERVIEW.md#tool-output-truncation-and-continuation) for full behavior and response fields.

**Transport inference** (in `mcpService.ts`):
1. Explicit `type`/`transport` in config → uses that
2. Has `command` → stdio
3. Has `url` → HTTP (with SSE fallback probe if ambiguous)


## ToolAnnotations

MCP servers can declare behavioral hints on each tool via [ToolAnnotations](https://modelcontextprotocol.io/specification#tool-annotations) from the MCP spec. These are optional boolean fields:

| Annotation | Meaning | Default (per spec) |
|------------|---------|---------------------|
| `readOnlyHint` | Tool does not modify external state | `false` |
| `destructiveHint` | Tool may permanently destroy data | `true` |
| `idempotentHint` | Repeated calls with same args are safe | `false` |
| `openWorldHint` | Tool interacts with entities beyond its closed domain | `true` |

**Data flow:** MCP server → Super-MCP (`ToolInfo.annotations`) → Rebel Core (`McpToolDefinition.annotations`) → Settings UI (read-only/destructive badges) + reconnect retry gating.

**Annotations are advisory, not authoritative for security.** The tool safety service (`toolSafetyService.ts`) handles allow/block decisions independently. Annotations inform reconnect retry safety and UI display only.

**All bundled MCPs must include ToolAnnotations** on every tool. Verify with `npx tsx scripts/harvest-mcp-tools.ts --mode=bundled --verify-annotations`. See [MCP_IMPROVEMENT_WORKFLOW](MCP_IMPROVEMENT_WORKFLOW.md) checklists and [`build-custom-mcp-server` skill](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md) for implementation guidance.


## Configuration

### User-Facing: Connectors UI

Most users configure MCPs via **Settings → Connectors**:
- Browse catalog of 50+ integrations
- One-click OAuth flows for bundled/direct MCPs
- Multi-account support via instance naming

### Advanced: mcpConfigFile

For power users, `Settings → Advanced (Support tab) → MCP config file` allows direct JSON editing.

**Supported config shapes** (resolver auto-detects):
- Plain object: `{ "serverName": { command, args, env } }`
- Array: `{ "mcp_servers": [{ name, command, args }] }`
- Wrapper keys: `mcpServers`, `mcp_servers`, `servers`, `superServers`, `upstreamServers`, `mcp`

**Path resolution**:
- Absolute paths used as-is
- Relative paths resolved against `coreDirectory`


## Authentication Patterns

### 1a. OAuth2 via Deep Link (Cloudflare Worker)

**Used by**: Slack, Microsoft 365, Salesforce

1. Main process opens system browser (`shell.openExternal()`)
2. User authenticates with provider
3. Provider redirects to `rebel-auth.mindstone.com/{provider}/callback`
4. Deep link returns to app: `mindstone://{provider}/callback?code=...`
5. Tokens stored in `userData/mcp/{provider}/`

### 1b. OAuth2 via Localhost Callback

**Used by**: Google Workspace, HubSpot

1. Auth service starts temporary localhost server on dynamic port (Google) or fixed ports 8081-8084 (HubSpot, due to OAuth app registration constraint)
2. User authenticates in system browser
3. Provider redirects to `http://127.0.0.1:{port}/callback`
4. Localhost server receives code, exchanges for tokens
5. Tokens stored in connector-specific directory (e.g., `google-workspace-mcp/`)

**On disconnect**: Best-effort token revocation with provider before deleting local files.

**Key files**: `src/main/services/*AuthService.ts`, `src/main/services/oauthCredentials.ts`

### 2. API Key / Static Token

**Used by**: ElevenLabs, OpenAI Image, Gamma, Fathom, Kling

User enters key in setup form → stored in MCP config env vars.

### 3. Bearer Token Bridge (Internal)

**Used by**: Split Rebel MCPs (RebelInbox, RebelMeetings, RebelSearchAndConversations, RebelAutomations, RebelSpaces, RebelSettings, RebelMcpConnectors, RebelPlugins), RebelDiagnostics, plus a handful of OSS bridges that call back into Rebel for OAuth (Slack, Microsoft365Mail, Microsoft365SharePoint).

- Ephemeral bearer token generated at runtime (`randomBytes(32).toString('hex')`)
- Bridge state (port + token) written to `userData/mcp/rebel-inbox-bridge.json`
- Path passed to MCP child processes via env vars on every spawn

**Key files**: `src/main/services/bundledInboxBridge.ts` (HTTP server), `src/main/services/bundledMcpManager.ts` (state file + spawn payloads)

#### Cross-Process Env-Var Contract

The bridge-state path is a **cross-process contract** between the host and every bundled child script — the host owns the writer side, the bundled `resources/mcp/rebel-*/server.cjs` and `resources/mcp-generated/{slack,microsoft-mail,microsoft-sharepoint}/server.cjs` files own the reader side. The contract is asymmetric: writer ⊇ readers. A reader requesting a key the writer does not emit silently returns `undefined`, the bridge call no-ops, and super-mcp surfaces `-33004 PACKAGE_UNAVAILABLE`.

**Writer side** — `bridgeStateEnv()` in `bundledMcpManager.ts` returns the canonical env-var dictionary that every bridge-needing payload spreads into its `env`. As of May 2026 it dual-writes both keys:

- `MCP_HOST_BRIDGE_STATE` — current preferred name (introduced May 2026)
- `MINDSTONE_REBEL_BRIDGE_STATE` — legacy name retained until every bundled reader migrates

Both keys point at the same path. The dual-write is transitional: it exists so that renaming the host-side identifier doesn't break readers that still ship the old name. The retirement checklist (which readers to update before collapsing back to a single key) lives in the JSDoc above `bridgeStateEnv()`.

**Reader side** — every bundled child script reads the path at startup, e.g.:

```js
const statePath = process.env.MINDSTONE_REBEL_BRIDGE_STATE;
```

After migration, readers should prefer the new key with the legacy as fallback during the transition window:

```js
const statePath = process.env.MCP_HOST_BRIDGE_STATE ?? process.env.MINDSTONE_REBEL_BRIDGE_STATE;
```

**Defenses against rename drift**:

- `scripts/check-bridge-state-readers.ts` — CI gate (in `validate:fast`) that parses `bridgeStateEnv()` and every bundled reader, and fails if any reader requests a key the writer doesn't emit.
- `src/main/services/__tests__/bundledMcpSpawnContract.test.ts` — per-MCP integration test that builds the spawn payload, reads the target script, and asserts the payload sets every key the script reads.
- The retirement-checklist JSDoc on `bridgeStateEnv()` lists every reader that must be updated before the legacy key can be retired.

**Postmortem**: `docs-private/postmortems/260506_mcp_bridge_state_env_var_rename_incomplete_postmortem.md` captures the May-2026 incident where the writer was renamed without updating readers — the canonical example of the failure mode this contract guards against.

**Note (v0.3.26+)**: Internal tools are split across 8 domain-specific MCPs for better LLM tool discovery. Legacy `RebelInternal` entries are migrated automatically on startup. Internal MCPs are auto-loaded and removal-protected (cannot be removed via UI or config).


## Multi-Instance Support

MCPs supporting multiple accounts use **one instance per account**:

**Instance naming** (see `src/shared/utils/mcpInstanceUtils.ts`):
- **Email-based**: `{MCPName}-{email-slug}` (e.g., `GoogleWorkspace-greg-work-com`) — used by Google, HubSpot, Salesforce, Fathom
- **Workspace-based**: `{MCPName}-{workspace-slug}` (e.g., `Slack-mindstone`) — used by Slack

**Credential storage**: Varies by connector. Some use per-instance directories, others store multiple accounts in a shared `accounts.json` + `credentials/` structure.

**Exception**: Microsoft 365 uses fixed server names (`Microsoft365Mail`, `Microsoft365Calendar`) with internal multi-account support via `MS_CONFIG_DIR`.


## Disabling Connectors

Users can **disable** a connector without disconnecting it. This preserves the connector's configuration and credentials while temporarily excluding it from agent sessions.

**How it works:**
- The router config stores disabled server IDs in a `disabledServers: string[]` array
- Super-MCP filters out disabled servers during initialization — their tools are not available to agents
- Disabled connectors remain visible in the Settings UI (dimmed) so users can re-enable them
- Disabling/enabling triggers a brief Super-MCP restart (~2-3 seconds)

**Config field:** `disabledServers` in the router config (see [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md) for details)

### Per-Instance Disable (Multi-Account Connectors)

For multi-account connectors, users can disable individual accounts while keeping others active. This is useful when you want to:
- Pause a work account during personal time
- Temporarily exclude a secondary account without disconnecting
- Debug issues with a specific account

**Supported patterns:**

| Pattern | Per-Instance Disable? | UI Component |
|---------|----------------------|--------------|
| Direct OAuth (Slack, Notion, Linear) | Yes | `AccountInstancesList` |
| Bundled API-key (Fathom, Zendesk) | Yes | `AccountInstancesList` |
| Bundled Google OAuth | Yes | `McpAccountsExtension` |
| Bundled HubSpot OAuth | No (connector-level only) | `McpAccountsExtension` |
| Bundled Microsoft OAuth | No (connector-level only) | N/A |

**Why some connectors don't support per-instance disable:**
- **HubSpot**: Uses a single MCP server with accounts stored in `accounts.json`, not separate server instances
- **Microsoft**: Uses per-service servers (Mail, Calendar) rather than per-email instances

**UI behavior:**
- When per-instance toggles are shown, the header-level toggle is hidden (prevents duplicate controls)
- Disabled instances show: dimmed row, Pause icon, "Disabled" badge
- Toggle buttons show loading state and are mutually exclusive with disconnect
- Google Workspace accounts whose OAuth refresh token has died show a "Sign-in expired" row state with a targeted Reconnect action (re-auths exactly that email via `google-workspace:start-auth { targetEmail }`). The state rides `McpServerPreview.needsReconnect`, overlaid from `oauthRefreshFailureStore` by `describeMcpConfiguration`; disabled wins over expired in the row treatment

**Implementation:** See `ExpandedConnectionCard.tsx` → `handleToggleInstanceEnabled()` and `McpAccountsExtension.tsx` → `handleToggle()`

**User guide:** [disabling-connectors](../../rebel-system/help-for-humans/connectors/disabling-connectors.md)


## Connector Catalog

The catalog (`resources/connector-catalog.json`) provides metadata for the Add Connection UI.

### Key Fields

The full interface is in `src/shared/types.ts` → `ConnectorCatalogEntry`. Key fields:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | `string` | Unique identifier |
| `name` | `string` | Display name |
| `description` | `string` | <150 chars, verbs + capabilities |
| `category` | `ConnectorCategory` | communication, productivity, development, etc. |
| `provider` | `'direct' \| 'community' \| 'bundled'` | Provider type |
| `mcpConfig?` | `ConnectorMcpConfig` | MCP server config (for direct/community) |
| `bundledConfig?` | `BundledMcpConfig` | Bundled MCP config (for bundled) |
| `setupUrl?` | `string` | Direct link to credential page |
| `setupUrlBehavior?` | `'button' \| 'auto-open' \| 'reference'` | How to present setupUrl |
| `setupInstructions?` | `string` | Newline-separated steps |
| `setupFields?` | `SetupField[]` | Credentials to collect (form rendering source of truth when present) |
| `accountIdentity?` | `IdentityKind` (`'email' \| 'workspace' \| 'subdomain' \| 'domain' \| 'tenant' \| 'none'`) | Instance discriminator + agent identity prompt + bridge param name. See "Orthogonality" below. |
| `runtime?` | `'node' \| 'python'` | Required local runtime |
| `hidden?` | `boolean` | Hide from Available list |
| `isInternal?` | `boolean` | Auto-configured, always-on (RebelInbox, etc.) |
| `tools?` | `Array<{ name, description? }>` | Static tool manifests for pre-connect visibility. Populated via `scripts/harvest-mcp-tools.ts` or manually. |

### Writing Good Descriptions

**Pattern**: `[Verbs/capabilities]. [Key objects]. [Optional: user-intent phrase]`

**Good**: "Search messages, read channels/threads, post messages, list users. Team messaging history."

**Bad**: "Team messaging and channels" (no verbs, doesn't say what you can DO)

### Writing Setup Instructions

- **Actionable**: Each step is something the user does
- **Specific**: Include exact UI paths in the provider's dashboard
- **Complete**: Include prerequisites and notes

```
1. Click 'Open Fathom' below to go to API Access section
2. Click 'Add +' → 'Generate API Key'
3. Copy the key immediately - it won't be shown again
4. Paste the key here

Note: Only your meetings are accessible. Rate limit: 60 req/min.
```

### Orthogonality: `accountIdentity` vs `setupFields`

`accountIdentity` and `setupFields` solve different problems and are designed to be **structurally orthogonal**:

- **`accountIdentity`** is the *instance discriminator*. It tells the system what concept makes an instance of this connector unique (email, workspace, subdomain, etc.). It governs grouping (`useUnifiedConnections`), bridge parameter naming (`getIdentityParamName`), agent-facing identity prompts (`rebel-mcp-connectors/server.cjs`), and registry-driven UI display for direct-identity input paths (`getIdentityFieldDisplay` in `src/shared/identityKinds.ts`).
- **`setupFields`** is the *credential collection schema*. It owns env/header injection (via `envVar`/`headerKey`) and form rendering (via `SetupFieldsForm.tsx`) when present.

**Convention — setupFields wins on id collision.** When `setupFields[].id === accountIdentity`, the setupField owns rendering; the registry display defaults in `identityKinds.ts` apply only when no setupFields entry of matching id exists. This applies today to: `bundled-freshdesk` (`domain`), `bundled-workday` (`tenant`), `bamboohr` (`subdomain`). Email/workspace deliberately do NOT use this collision pattern — the 'email' identity is rendered by the parent setup form, not by a `setupFields[].id === 'email'` entry (see [`260326_generic_imap_smtp_email_mcp.md`](../plans/260326_generic_imap_smtp_email_mcp.md): *"do NOT duplicate email in setupFields"*).

This convention is mechanically enforced by `src/shared/__tests__/connectorCatalog.test.ts` — any future catalog entry that puts `accountIdentity === 'email'` (or `'workspace'`) AND a setupFields entry with matching id will fail CI.

History: `setupFields` was introduced 2025-12-24 (commit `e761c36`) for multi-field credential collection. `accountIdentity` was introduced 2026-01-05 (`41b5e04`, `a4493bd`) for instance disambiguation. The orthogonality is explicit in original design intent; see `docs/plans/260526_account-identity-registry/` and `docs/plans/260527_account-identity-followups/` for the planning thread that codified the rule.


## Bundled MCP Server Bridge

Bundled MCPs run as child processes and cannot directly access Electron APIs. An HTTP bridge provides secure communication:

| Server | Tools | Purpose |
|--------|-------|---------|
| `RebelInbox` | `rebel_inbox_status`, `rebel_inbox_ready`, `rebel_inbox_add`, `rebel_inbox_add_many`, `rebel_inbox_update`, `rebel_inbox_remove`, `rebel_inbox_list`, `rebel_inbox_query`, `rebel_inbox_stats`, `rebel_inbox_bulk`, `rebel_inbox_get` | Inbox/task queue management |
| `RebelMeetings` | `rebel_meetings_sync`, `rebel_meetings_today`, `rebel_meetings_save_prep`, `rebel_meetings_find_prep`, `rebel_meetings_history`, `rebel_meetings_missed`, `rebel_meetings_schedule_bot`, `rebel_meetings_live_transcript` | Meeting transcripts and recordings |
| `RebelSearchAndConversations` | `rebel_search_files`, `rebel_search_sources`, `rebel_entities_search`, `rebel_entities_resolve`, `rebel_conversations_list`, `rebel_conversations_search`, `rebel_conversations_get_summary`, `rebel_conversations_export_full`, `rebel_conversations_send_message`, `rebel_conversations_start` | Semantic file search, source search, conversation management |
| `RebelAutomations` | `rebel_automations_list`, `rebel_automations_create`, `rebel_automations_update`, `rebel_automations_delete`, `rebel_automations_run`, `rebel_automations_toggle`, `rebel_automations_list_tool_grants`, `rebel_automations_add_tool_grant`, `rebel_automations_remove_tool_grant`, `rebel_list_models` | Scheduled workflow management |
| `RebelSpaces` | `rebel_spaces_list`, `rebel_spaces_create`, `rebel_spaces_get_config`, `rebel_spaces_update_config` | Memory spaces: list, create, configure |
| `RebelSettings` | `rebel_internal_get_environment`, `rebel_settings_get`, `rebel_settings_update`, `rebel_vocabulary_get`, `rebel_vocabulary_update`, `rebel_usecases_list`, `rebel_usecases_add`, `rebel_user_identity_set`, `rebel_safety_prompt_get`, `rebel_safety_prompt_update`, `rebel_auth_set_claude_max_token` | App settings, environment info, use cases |
| `RebelMcpConnectors` | `rebel_mcp_list_servers`, `rebel_mcp_add_server`, `rebel_mcp_remove_server`, `rebel_mcp_validate_config`, `rebel_mcp_restart`, `rebel_mcp_disable_tool`, `rebel_mcp_authenticate`, `rebel_mcp_search_connectors`, `rebel_mcp_get_connector` | MCP server configuration |
| `RebelDiagnostics` | `rebel_diagnostics_check`, `rebel_diagnostics_quick`, `rebel_diagnostics_export`, `rebel_diagnostics_recent_events`, `rebel_diagnostics_recent_logs`, `rebel_diagnostics_log_file_paths` | System health, recent diagnostic events, raw log tail |

> **Stage 1c (2026)**: Three new read-side tools added — `rebel_diagnostics_recent_events` (markdown summary of last K events per kind), `rebel_diagnostics_recent_logs` (raw pass-through tail; explicit LLM-provider warning in description), and `rebel_diagnostics_log_file_paths` (metadata-only listing for follow-up full-file reads). Total tool count: **6**. Smoke assertion: `scripts/test-mcp-health.js` → `expectedMinTools: 6`. Drift test: `resources/mcp/rebel-diagnostics/__tests__/server-drift.test.ts` asserts `TOOL_NAMES` and `TOOL_DESCRIPTIONS` parity between `server.mjs` and `server.cjs`. See [DIAGNOSTICS.md](./DIAGNOSTICS.md#stage-1c--read-side-mcp-surfaces-2026) for full surface documentation.
| `RebelCanvas` | `rebel_canvas_chart`, `rebel_canvas_table`, `rebel_canvas_options`, `rebel_canvas_html` | Interactive visualizations |
| `RebelPlugins` | `rebel_plugins_create`, `rebel_plugins_list`, `rebel_plugins_get_source`, `rebel_plugins_delete`, `rebel_plugins_open`, `rebel_plugins_fork`, `rebel_plugins_archive`, `rebel_plugins_restore`, `rebel_plugins_copy_to_space`, `rebel_plugins_move_to_space` | Plugin management |

**Note**: These replaced the monolithic `RebelInternal` in v0.3.26. Legacy configs are migrated automatically.

**Security model**:
- Localhost-only (`127.0.0.1`)
- Bearer token auth (64-char random token)
- Process isolation

**Key endpoints** (via bridge):
- `/inbox/*` — Inbox CRUD
- `/diagnostics/*` — Health checks
- `/mcp/*` — Server config operations
- `/bundled/*/start-auth` — OAuth flows

**Key file**: `src/main/services/bundledInboxBridge.ts`


## UI Component Architecture

| Component | Responsibility |
|-----------|----------------|
| `UnifiedConnectionsPanel.tsx` | Connector marketplace, install states |
| `ExpandedConnectionCard.tsx` | Per-connector detail, setup forms |
| `McpAccountsExtension.tsx` | Multi-account management (Google, HubSpot) |
| `AccountInstancesList` | Generic multi-instance list (direct, API-key, other OAuth) |
| `AddConnectionModal.tsx` | Custom MCP server entry |
| `useUnifiedConnections.ts` | State management, catalog + instance merging |

### Preventing Duplicate Account UI

Multi-instance connectors must show only one account management UI. Use stable `catalogEntry.id` for exclusion checks, not server names (which vary with multi-instance naming like `"GoogleWorkspace-user_email_com"`):

```typescript
// CORRECT: Stable catalog ID
!['bundled-google', 'bundled-hubspot'].includes(catalogEntry?.id || '')
```

### Per-Instance Disable/Enable Toggle

Multi-account connectors support per-instance disable via `connection.instances`. Use `mcpToggleServerEnabled({ serverId: serverName })` to toggle. For connectors without per-instance MCP servers (HubSpot, Microsoft), set `canToggle: false` to hide per-row toggle buttons. When per-instance toggles are shown, hide the header toggle to avoid duplicate controls.

**Key files:** `ExpandedConnectionCard.tsx`, `McpAccountsExtension.tsx`, `AccountInstancesList`


## Troubleshooting

**"Unable to read MCP config file"**: Check path exists and app has permissions.

**"Not valid JSON"**: Ensure pure JSON (no comments, no trailing commas).

**"No server definitions"**: Add servers at top level or under wrapper keys (`mcpServers`, etc.).

**Tools don't run / race conditions**: Verify Super-MCP is running (Settings → Advanced (Support tab) shows `superMcpHttpRunning: true`).

**"X tool(s) couldn't load"**: Invalid entries are skipped. Check Diagnostics for details. Common causes: missing `command` for stdio, invalid `url` for HTTP.

**Connect-failure toasts (Settings UI)**: When a user clicks **Connect** on a connector card and the Settings IPC handler in `src/main/ipc/settingsHandlers.ts` rejects, `UnifiedConnectionsPanel.tsx` surfaces a toast titled `"<Connector name> connection failed"` whose description is the IPC error message. This applies to **all** bundled `authType` values (not just OAuth — the OAuth-only gate was removed in FOX-3264, May 2026). When adding a new bundled connector or a new failure path in the IPC handler, **the user-facing copy you throw IS the user-facing error** — phrase it as actionable guidance (e.g., `"Add an OpenAI API key in Settings → Provider Keys before connecting Image Generation."`), not as an internal/technical message. See `docs-private/postmortems/260506_FOX-3264_openai_image_generation_catalog_registry_split_brain_postmortem.md` for the original silent-failure incident this contract closed.


## Maintenance

When changing MCP-related code (`mcpService.ts`, `superMcpHttpManager.ts`, settings UI), update this doc as part of the same change.
