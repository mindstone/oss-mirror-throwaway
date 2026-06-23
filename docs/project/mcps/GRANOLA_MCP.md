---
description: "Granola official MCP connector — OAuth setup, meeting note tools, plan limits, migration history, troubleshooting"
last_updated: "2026-05-19"
---

# Granola MCP

| Field | Value |
|-------|-------|
| **Type** | Direct (vendor-hosted) |
| **Provider** | Granola |
| **Transport** | Streamable HTTP |
| **Auth** | OAuth 2.0 (browser-based, Dynamic Client Registration) |
| **URL** | `https://mcp.granola.ai/mcp` |
| **Status** | Active - Migrated to official MCP Feb 2026 |

## See Also

- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Development workflow for MCP improvements
- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup, discovery, and troubleshooting
- [Granola MCP docs](https://docs.granola.ai/help-center/sharing/integrations/mcp) - Official Granola documentation
- Planning document: `docs/plans/finished/260120_granola_mcp.md` (original bundled version)
- Migration document: `docs/plans/partway/260225_granola_official_mcp_migration.md`
- **Local-reader OSS revival — cancelled:** `docs/plans/260519_granola_local_oss_migration.md` (Phase A1 audit found Granola's local data is now OS-keychain-encrypted SQLite — read that doc before considering a similar revival)

## Overview

The Granola connector uses Granola's official MCP server, hosted at `https://mcp.granola.ai/mcp`. Users authenticate via browser OAuth (no API key or client secret needed -- uses Dynamic Client Registration).

### History

Originally (Jan 2026), we built a bundled MCP that read from Granola's local plain-JSON cache file (`cache-v3.json`). When Granola released their official MCP (Feb 4, 2026), we migrated to it to reduce maintenance burden and stay in sync with their features.

The bundled source was removed in May 2026. A short-lived attempt to publish it as an OSS `granola-local` connector was cancelled at the Phase A1 schema-drift audit: Granola has moved their local data to an encrypted SQLite store (`granola.db` SQLCipher + `storage.dek` Electron `safeStorage`), so a plain-JSON reader no longer works and a decrypting reader would mean reverse-engineering a vendor's encrypted store. See `docs/plans/260519_granola_local_oss_migration.md` for the full audit and "when to re-evaluate" criteria.

## Tools (Vendor-Provided)

| Tool | Description |
|------|-------------|
| `query_granola_meetings` | Natural language chat with your meeting notes |
| `list_meetings` | Browse meetings with ID, title, date, attendees |
| `get_meetings` | Search meeting content including enhanced notes |
| `get_meeting_transcript` | Raw transcript access (paid plans only) |

## Plan Limitations

- **Free plan**: Can only query notes from the last 30 days
- **Transcripts**: Require a paid Granola plan
- **Rate limits**: ~100 requests per minute

## Troubleshooting

- **Auth issues**: Disconnect and reconnect in Settings → Connectors
- **Missing notes**: Only notes where you are the owner are accessible
- **Enterprise**: Admins must enable MCP access in Granola Security Settings
