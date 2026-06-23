---
description: "Bundled Email IMAP/SMTP MCP reference — iCloud, Yahoo, and custom presets, credential flow, architecture, lifecycle"
last_updated: "2026-05-01"
---

# Email IMAP/SMTP MCP

| Field | Value |
|-------|-------|
| **Type** | Bundled (local stdio) |
| **Provider** | Generic (preset-based) |
| **Transport** | stdio |
| **Auth** | App-specific passwords for iCloud/Yahoo, standard credentials for custom (env vars) |
| **Catalog Entries** | `bundled-icloud-mail`, `bundled-yahoo-mail`, `bundled-custom-email` |
| **Server Name** | `EmailImap` |
| **Status** | Active |

## See Also

- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) — Development workflow for MCP improvements
- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) — General MCP setup, discovery, and troubleshooting
- Planning document: `docs/plans/260326_generic_imap_smtp_email_mcp.md`
- User-facing docs: `rebel-system/help-for-humans/connectors/email.md`

## Overview

A single MCP server (`EmailImap`) provides email access via standard IMAP/SMTP protocols. Three connector catalog entries share this server:

| Catalog Entry | Name | Provider Preset | Use Case |
|--------------|------|-----------------|----------|
| `bundled-icloud-mail` | iCloud Mail | `icloud` | Apple iCloud email accounts |
| `bundled-yahoo-mail` | Yahoo Mail | `yahoo` | Yahoo/Ymail/Rocketmail accounts |
| `bundled-custom-email` | Custom Email (IMAP/SMTP) | `custom` | Any IMAP/SMTP provider (Fastmail, ProtonMail, corporate, etc.) |

Users search "iCloud", "Yahoo", or "IMAP" in Settings → Connectors and find the appropriate entry. Each entry has provider-specific setup instructions and links.

## Architecture

### Multi-Catalog-Entry Design

One shared MCP server (`resources/mcp/email-imap/`) with three user-facing catalog entries. The selected catalog entry determines which preset to use via the `EMAIL_IMAP_PROVIDER` env var.

**Why not one generic entry:** Users search "iCloud" or "Yahoo", not "Generic IMAP". Each entry has tailored setup instructions, password generation links, and field labels. The custom entry uses different setupFields (IMAP/SMTP host + port) from the preset entries (password only).

**How provider routing works:**
1. User clicks "iCloud Mail" (or Yahoo, or Custom) in Settings → Connectors
2. UI passes `catalogId: "bundled-icloud-mail"` to the `settings:mcp-add-bundled-server` IPC handler
3. Handler calls `buildPayloadFromCatalog()` which looks up the catalog entry
4. `buildPayloadFromCatalog()` injects `EMAIL_IMAP_PROVIDER` based on catalog entry ID
5. For custom: maps IMAP/SMTP host and port from setupFields to env vars
6. MCP server reads env vars on startup and connects to the appropriate servers

### Source Structure

```
resources/mcp/email-imap/
├── package.json
├── tsconfig.json
├── test-mcp.test.ts                    # 26 GreenMail integration tests
├── test-fixtures/greenmail-helper.ts   # Test seeding/cleanup
└── src/
    ├── index.ts          # MCP server entry point (stdio, tool dispatch, configure)
    ├── types.ts           # ProviderPreset interface
    ├── presets.ts          # iCloud + Yahoo presets, domain matching
    ├── imap-client.ts      # ImapFlow wrapper (connect-on-demand, UIDVALIDITY, SIGTERM)
    ├── smtp-client.ts      # Nodemailer transport wrapper
    └── tools/
        └── index.ts        # All 8 tool handlers + initClients/cleanupClients
```

### Credential Flow

```
UI (email + password + catalogId)
  → IPC: settings:mcp-add-bundled-server
    → settingsHandlers.ts: buildPayloadFromCatalog(catalogEntry, { email, setupFields })
      → bundledMcpManager.ts: buildBundledMcpPayload("EmailImap", { email, credentials })
        → env vars: EMAIL_IMAP_EMAIL, EMAIL_IMAP_PASSWORD, EMAIL_IMAP_PROVIDER
          (+ EMAIL_IMAP_IMAP_HOST, etc. for custom)
        → super-mcp-router.json
          → MCP server reads env vars → initClients()
```

**Key detail — email mapping:** The email comes from `accountIdentity: "email"` (rendered automatically by the UI), not from setupFields. It flows through `options.email` in `buildBundledMcpPayload`, which maps it to any `credentialEnvVar` ending in `_EMAIL`.

### Connection Lifecycle

- IMAP: Connect-on-demand via `getConnection()`, reuse for subsequent calls
- `getMailboxLock()` serializes operations (prevents interleaved mailbox selection)
- UIDVALIDITY tracked per mailbox — if it changes, returns error: "Mailbox was reorganized, please re-search"
- SIGTERM/SIGINT handlers close connections cleanly
- SMTP: Connect-on-demand transport, reuse after creation

## Tools

| Tool | Purpose | Protocol |
|------|---------|----------|
| `email_list_mailboxes` | List folders with counts | IMAP LIST + STATUS |
| `email_search_messages` | Search by query/sender/unread | IMAP SEARCH + FETCH (envelope) by UID |
| `email_get_message` | Full message content | IMAP BODYSTRUCTURE + selective part download |
| `email_send` | Send email, reply threading | SMTP via nodemailer |
| `email_save_draft` | Save draft to Drafts folder | IMAP APPEND with `\Draft` flag (MailComposer) |
| `email_move_messages` | Move by UID list | IMAP MOVE (COPY+DELETE fallback) |
| `email_set_flags` | Mark read/unread, flag | IMAP STORE +/-FLAGS |
| `email_get_mailbox_status` | Quick triage: counts + subjects | IMAP STATUS + optional SEARCH/FETCH |
| `configure_email_imap` | Runtime credential config | Bridge call → validate → restart |

**Important — `email_get_message`:** Uses BODYSTRUCTURE + selective MIME part download. Does NOT use `simpleParser()` on full RFC822 (which would cause OOM on large attachments). Attachment metadata (filename, type, size) is returned without downloading content.

## Provider Presets

```typescript
// presets.ts
icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 }
yahoo:  { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 }
custom: reads from env vars (EMAIL_IMAP_IMAP_HOST, EMAIL_IMAP_IMAP_PORT, EMAIL_IMAP_SMTP_HOST, EMAIL_IMAP_SMTP_PORT)
```

## Adding a New Provider Preset

To add a new preset (e.g., Fastmail):

1. Add the preset to `resources/mcp/email-imap/src/presets.ts`
2. Add a catalog entry to `resources/connector-catalog.json` with `bundledConfig.serverName: "EmailImap"`
3. Update the provider mapping in `bundledMcpManager.ts` (`buildPayloadFromCatalog`, EmailImap block)
4. Update the help-for-humans doc: `rebel-system/help-for-humans/connectors/email.md`
5. Rebuild: `node scripts/build-bundled-mcps.mjs`

## Key Code Locations

- **MCP server source:** `resources/mcp/email-imap/src/`
- **Catalog entries:** `resources/connector-catalog.json` (search `bundled-icloud-mail`, `bundled-yahoo-mail`, `bundled-custom-email`)
- **BUNDLED_MCP_CATALOG entry:** `src/main/services/bundledMcpManager.ts` (search `EmailImap`)
- **Provider injection:** `src/main/services/bundledMcpManager.ts` → `buildPayloadFromCatalog()` (search `EMAIL_IMAP_PROVIDER`)
- **Bridge endpoint:** `src/main/services/bundledInboxBridge.ts` (search `/bundled/email-imap/configure`)
- **Multi-instance support:** `src/shared/utils/mcpInstanceUtils.ts` (search `EmailImap` in `EMAIL_INSTANCE_CONNECTOR_TYPES`)
- **Bundle config:** `scripts/mcp-config.json` (search `email-imap`)
- **Integration tests:** `resources/mcp/email-imap/test-mcp.test.ts` (26 tests, GreenMail Docker)

## Testing

### GreenMail Integration Tests

```bash
# Start GreenMail (Docker)
docker run -d --name greenmail -p 3025:3025 -p 3143:3143 -p 8080:8080 \
  -e "GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled -Dgreenmail.users.login=email" \
  greenmail/standalone:2.1.8

# Run tests
npx vitest run resources/mcp/email-imap/test-mcp.test.ts
```

Tests skip automatically if GreenMail isn't running. All 8 tools + error cases are covered.

## Troubleshooting

- **Empty EMAIL_IMAP_EMAIL:** The email comes from `accountIdentity`, not setupFields. If empty, check `buildBundledMcpPayload`'s `_EMAIL` suffix mapping.
- **Empty EMAIL_IMAP_PROVIDER:** Must be injected by `buildPayloadFromCatalog` based on catalog entry ID. Check the EmailImap block in that function.
- **Connection timeouts:** iCloud uses TLS on port 993. Yahoo uses TLS on 465 for SMTP. Ensure `imapTls` and `smtpSecure` match.
