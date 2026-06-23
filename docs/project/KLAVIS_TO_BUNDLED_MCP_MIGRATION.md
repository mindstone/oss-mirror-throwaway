---
description: "Completed Klavis-to-bundled-MCP migration reference — startup cleanup, connector reconnection, tool mapping, and credential storage"
last_updated: "2026-05-24"
---

# Klavis Migration (Complete)

This document describes the completed migration from Klavis (third-party MCP gateway) to Rebel's bundled, locally-running MCP servers.

**Status: COMPLETE** — Klavis has been fully removed. The app automatically cleans up any remaining Klavis configurations on startup.

## See Also

- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) - Canonical reference for MCP configuration, Super-MCP router, and connector catalog
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - AppSettings schema including `googleWorkspace`, `slack`, `microsoft` settings
- `rebel-system/help-for-humans/klavis-migration.md` - User-facing migration guide


## Overview

**Current State:** Klavis has been fully removed from Rebel. The app runs a slimmed automatic cleanup migration on every startup that:

1. **Archives `klavis.json`** from `userData/mcp/` (renamed to `klavis.json.deprecated_yyMMdd_HHmm`).
2. **Strips Klavis entries** from `super-mcp-router.json` and `claude_desktop_config.json`, and migrates any non-Klavis user-defined servers into the router config so they keep working.
3. **Fixes up `mcpConfigFile` pointers** in `AppSettings` if they pointed at the now-archived Klavis config.

The migration is idempotent, never throws (the top-level catch keeps Rebel booting even on partial-write failure), and exposes no in-app banner — the user-facing migration UI was removed. Memory-file deprecation notices and the `klavisMigrationPending` flag that previously fed the banner have also been removed; persisted settings still carrying the legacy flag are stripped on next normalisation, with `dismissedAnnouncements['klavis-migration']: true` preserved if the user had already dismissed.

**User action required:** Users must reconnect their services via Settings → Connectors using the built-in connectors.

See: `src/main/startup/klavisMigration.ts` for implementation details and `src/main/startup/__tests__/klavisMigration.test.ts` for the locked behavioural contract.


## Why Migrate?

| Aspect | Klavis | Bundled MCPs |
|--------|--------|--------------|
| **Data flow** | Through Klavis servers | Local only - never leaves your device |
| **Account required** | Yes (Klavis account) | No - direct OAuth with Google/Slack/Microsoft |
| **Latency** | Extra network hop | Direct API calls |
| **Offline capability** | Requires Klavis availability | Works with cached tokens |
| **Connectors** | 12+ via Klavis gateway | Google, Slack, Microsoft, HubSpot (more coming) |


## What's Available as Bundled MCPs

| Service | Bundled MCP | Replaces Klavis |
|---------|-------------|-----------------|
| Gmail, Calendar, Drive, Contacts | `GoogleWorkspace` | gmail, google-calendar, google-drive |
| Slack | `Slack` | slack |
| Outlook Mail | `Microsoft365Mail` | outlook-mail |
| Outlook Calendar | `Microsoft365Calendar` | outlook-calendar |
| OneDrive | `Microsoft365Files` | onedrive |
| Teams | `Microsoft365Teams` | microsoft-teams |
| HubSpot | `HubSpot` | hubspot |

For services not covered by bundled connectors, users can add community or custom MCP servers via Settings → Connectors.


## User Migration Flow

Migration is automatic on startup; the in-app banner has been removed. Users reconnect services on demand:

1. Open **Settings** → **Connectors**
2. Find the service tile (Gmail, Slack, Microsoft 365, etc.)
3. Click the tile to expand it
4. Click **"Set up with Rebel"**
5. Complete OAuth in the browser that opens


## Tool Name Mapping

If you have automations or prompts referencing Klavis tool names, update them:

| Klavis Tool | Bundled Equivalent |
|-------------|-------------------|
| `gmail_read_email` | `search_workspace_emails` |
| `gmail_send_email` | `send_workspace_email` |
| `gmail_search` | `search_workspace_emails` |
| `google_calendar_get_events` | `list_workspace_calendar_events` |
| `google_calendar_create_event` | `create_workspace_calendar_event` |
| `slack_user_list_channels` | `list_slack_channels` |
| `slack_post_message` | `post_slack_message` |
| `slack_read_channel` | `get_slack_channel_history` |
| `outlook_mail_read_email` | `list_emails` |
| `outlook_mail_send_email` | `send_email` |
| `outlook_calendar_get_events` | `list_calendar_events` |


## Where Credentials Are Stored

Bundled MCPs store OAuth tokens locally:

| Service | Token Location |
|---------|---------------|
| Google Workspace | `~/Library/Application Support/mindstone-rebel/mcp/google-workspace/` |
| Slack | `~/Library/Application Support/mindstone-rebel/slack-mcp/` |
| Microsoft 365 | `~/Library/Application Support/mindstone-rebel/microsoft-mcp/` |
| HubSpot | `~/Library/Application Support/mindstone-rebel/hubspot-mcp/` |


## Troubleshooting

### Tools not appearing after migration

Go to Settings → Connectors and verify each service shows as "Connected". If a service shows an error, click the tile and re-authenticate.

### Slack/Microsoft tools appear but authentication fails

The MCP servers are registered but tokens haven't been obtained. Go to Settings → Connectors, click the tile, and click "Set up with Rebel" to trigger OAuth.


## Implementation References

- `src/main/startup/klavisMigration.ts` - Startup cleanup migration (slimmed)
- `src/main/startup/__tests__/klavisMigration.test.ts` - Locked behavioural contract for the migration
- `src/main/services/bundledMcpManager.ts` - Bundled MCP registration and payload builders
- `src/main/services/googleWorkspaceAuthService.ts` - Google OAuth flow
- `src/main/services/slackAuthService.ts` - Slack OAuth flow
- `src/main/services/microsoftAuthService.ts` - Microsoft OAuth flow
- `resources/connector-catalog.json` - Connector catalog with available services
