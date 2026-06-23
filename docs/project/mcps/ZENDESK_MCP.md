---
description: "Bundled MCP server for Zendesk Support — ticket management, user lookup, views. API-token auth (subdomain + agent email + API token); OAuth path removed."
last_updated: "2026-06-07"
---

# Zendesk MCP

**Status**: Working via **API-token auth** (subdomain + agent email + API token). The OAuth path was **removed entirely** in June 2026 (commits `88585a7f7`, `019ed7814`) — resolved-by-removal rather than by obtaining a Global OAuth Client. Appendices A and B are retained as historical analysis of why OAuth was abandoned; they no longer describe current behaviour.

**Tool Count**: 20 tools (account management, tickets, comments, macros, users, organizations)

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) — General MCP configuration and discovery
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) — Development workflow for MCP improvements
- [SALESFORCE_MCP.md](./SALESFORCE_MCP.md) — Similar instance-specific OAuth constraint (user-provided credentials pattern)
- [260109_zendesk_mcp.md](../../plans/obsolete/260109_zendesk_mcp.md) — Original Zendesk MCP plan (API token auth)
- [260125_zendesk_oauth_migration.md](../../plans/partway/260125_zendesk_oauth_migration.md) — OAuth migration plan
- [260125_zendesk_mcp_auth_fix.md](../../plans/finished/260125_zendesk_mcp_auth_fix.md) — Auth credential-writing fix
- Source code: OSS npm package `@mindstone/mcp-server-zendesk` (run via `npx`; wired in `resources/connector-catalog.json` → `bundled-zendesk`)
- API-key account service: `src/main/services/zendeskApiKeyAccountService.ts` (current auth — validates credentials against the Zendesk API and writes `accounts.json`)
- IPC handlers: `src/main/ipc/zendeskHandlers.ts`
- User-facing setup help: [`rebel-system/help-for-humans/connectors/zendesk.md`](../../../rebel-system/help-for-humans/connectors/zendesk.md)
- ~~Auth service: `src/main/services/zendeskAuthService.ts`~~ — **deleted** (was the OAuth service)

### Zendesk Developer Documentation

- **[Using OAuth authentication with your application](https://support.zendesk.com/hc/en-us/articles/4408845965210)** — How to register an OAuth client and implement the auth code flow
- **[Set up a global OAuth client](https://developer.zendesk.com/documentation/marketplace/building-a-marketplace-app/set-up-a-global-oauth-client/)** — How to request a global client that works across all Zendesk instances
- **[Managing global OAuth clients and app associations](https://developer.zendesk.com/documentation/apps/app-developer-guide/managing-global-oauth-clients-and-app-associations/)** — Claiming and associating global clients in the Marketplace portal
- **[Getting a trial or sponsored account for development](https://developer.zendesk.com/documentation/api-basics/getting-started/getting-a-trial-or-sponsored-account-for-development/)** — How to get a free `d3v-` developer account
- **[Enhanced security guidelines for third-party apps (Aug 2025)](https://support.zendesk.com/hc/en-us/articles/9590471542170)** — Zendesk now requires global OAuth clients for all public integrations
- **[Managing API token access](https://support.zendesk.com/hc/en-us/articles/4408889192858)** — API token auth (alternative to OAuth)


## Overview

The Zendesk MCP provides access to Zendesk Support for ticket management, user lookup, and view execution. It is shipped as a catalog **bundled** connector (`bundled-zendesk`) but its server is the open-source npm package **`@mindstone/mcp-server-zendesk`**, launched on demand via `npx` rather than from a local `resources/mcp/` tree. See the `bundled-zendesk` entry in `resources/connector-catalog.json` for the exact pinned version and command.


## Tools

### Account Management

| Tool | Description |
|------|-------------|
| `list_zendesk_accounts` | List connected Zendesk accounts with auth status |
| `remove_zendesk_account` | Disconnect a Zendesk account |

### Tickets

| Tool | Description |
|------|-------------|
| `search_zendesk_tickets` | Search tickets using Zendesk query syntax |
| `get_zendesk_ticket` | Get a single ticket (optionally with comments) |
| `create_zendesk_ticket` | Create a new ticket |
| `update_zendesk_ticket` | Update ticket status/fields or add comment |

### Users

| Tool | Description |
|------|-------------|
| `search_zendesk_users` | Search users by name, email, or query |
| `get_zendesk_user` | Get a user profile by ID |

### Comments

| Tool | Description |
|------|-------------|
| `list_zendesk_ticket_comments` | List comments on a ticket |
| `add_zendesk_ticket_comment` | Add a comment to a ticket |

### Views & Groups

| Tool | Description |
|------|-------------|
| `list_zendesk_views` | List available ticket views |
| `list_zendesk_groups` | List agent groups |
| `list_zendesk_ticket_fields` | List ticket fields (for custom field IDs) |

### Organizations

| Tool | Description |
|------|-------------|
| `list_zendesk_organizations` | List organizations |


## Authentication

### Current State (API-token auth — the only path)

OAuth was removed entirely in June 2026; **API-token auth is now the sole authentication mechanism**. Implemented in `src/main/services/zendeskApiKeyAccountService.ts`:

- User provides: **subdomain**, **agent email**, **API token** (created in the Zendesk Admin Center → Apps and Integrations → APIs → Zendesk API → Add API token)
- `addZendeskApiKeyAccount()` validates the credentials by calling `GET /api/v2/users/me.json` with `Authorization: Basic base64({email}/token:{api_token})` before persisting — a 401 surfaces an "Invalid credentials" error
- Stored in `accounts.json` under `{userData}/mcp/zendesk/` (account list + per-account credentials)
- Works for any Zendesk instance with no external OAuth-client registration

This is the auth model the user-facing help doc ([`rebel-system/help-for-humans/connectors/zendesk.md`](../../../rebel-system/help-for-humans/connectors/zendesk.md)) describes.

### History: the brief OAuth era (Jan–Jun 2026)

The Zendesk MCP shipped with API-token auth (`09eaa0f2`, Jan 2026), was migrated to OAuth (`85059f8d`, Jan 2026), and then the OAuth path was **removed and replaced by API-token auth** (`88585a7f7`, `019ed7814`, Jun 2026). The OAuth removal deleted `zendeskAuthService.ts`, dropped the `zendesk:start-auth` / `zendesk:cancel-auth` IPC channels, removed the OAuth setup branch from the connections UI, dropped the `'zendeskApi'` value from the `authApi` union and connector-catalog Zod enum, and removed the dead `resolveZendeskCredentials()` / `EMBEDDED_CREDENTIALS.zendesk` surfaces from `oauthCredentials.ts`. Appendices A and B below explain *why* OAuth never worked and was abandoned.


## Architecture Notes

### Key Difference from Other OAuth Providers

Most OAuth providers (Google, HubSpot, Slack) have a **single central authorization server**. You register your app once and the `client_id` works for all users. Zendesk's authorization endpoint is **instance-specific** (`{subdomain}.zendesk.com`), so each instance has its own registry of OAuth clients.

| Provider | Auth Endpoint | Client Scope |
|----------|--------------|--------------|
| Google | `accounts.google.com` (central) | Global — register once |
| HubSpot | `app.hubspot.com` (central) | Global — register once |
| Slack | `slack.com` (central) | Global — register once |
| **Zendesk** | `{subdomain}.zendesk.com` (per-instance) | **Instance-specific by default** |
| Salesforce | `{instance}.salesforce.com` (per-org) | **Org-specific** (Connected App) |

Zendesk and Salesforce share this constraint. The codebase already handles Salesforce correctly by requiring user-provided credentials.

### Credential Resolution

There is no OAuth-client resolution anymore. `resolveZendeskCredentials()` and the `EMBEDDED_CREDENTIALS.zendesk` entry were removed from `oauthCredentials.ts` (`019ed7814`). Each account simply carries its own subdomain + agent email + API token, supplied directly by the user.

### Credential Storage

- Accounts + API tokens: `{userData}/mcp/zendesk/accounts.json` (written with mode `0600`)
- Each entry: `{ subdomain, email, apiToken, authenticatedAt }`
- The MCP server reads `accounts.json` and authenticates each request with `Authorization: Basic base64({email}/token:{api_token})` — no token-refresh flow (API tokens don't expire)
- `removeZendeskAccount()` also unlinks any legacy `credentials/{subdomain}.token.json` left over from the OAuth era
- Hot-reload: accounts are reloaded from disk on every tool call (no restart needed)


---

## Appendix A: OAuth "No such client" Error

### The Problem

When a user clicks "Set up" for Zendesk in Settings > Connectors, the app opens:

```
https://{subdomain}.zendesk.com/oauth/authorizations/new?client_id=rebel&redirect_uri=https://rebel-auth.mindstone.com/zendesk/callback&scope=read+write&response_type=code
```

Zendesk responds: **"Invalid Authorization Request — No such client"**

### Root Cause

Zendesk OAuth clients are **instance-specific by default**. An OAuth client created on `d3v-mindstone.zendesk.com` does not exist on `mindstone-53236.zendesk.com` or any other customer's instance. The `client_id=rebel` was either:
- Created only on a specific Zendesk instance (not the one being tested), or
- Never registered on any instance (placeholder value)

This is fundamentally different from Google/HubSpot/Slack where a single app registration works for all users.

### Zendesk OAuth Client Types

| Type | Scope | How to Create |
|------|-------|---------------|
| **Local** | Works only on the single instance where it was created | Admin Center > Apps & Integrations > APIs > OAuth clients |
| **Global** | Works across **all** Zendesk instances | Must be requested from Zendesk via the Marketplace developer portal |

### How to Get a Global OAuth Client

Per [Zendesk developer documentation](https://developer.zendesk.com/documentation/marketplace/building-a-marketplace-app/set-up-a-global-oauth-client/):

1. **Get a sponsored developer account** (free)
   - Sign up for a [14-day trial](https://www.zendesk.com/register/free-trial/) with a `d3v-` subdomain prefix (e.g., `d3v-mindstone.zendesk.com`)
   - Submit a [Sponsored Account Request Form](https://forms.gle/NDkrqK9xkZrnWoyk9) to convert it to a permanent free dev account
   - Ref: [Getting a trial or sponsored account](https://developer.zendesk.com/documentation/api-basics/getting-started/getting-a-trial-or-sponsored-account-for-development/)

2. **Create a local OAuth client** on your `d3v-` account
   - Go to Admin Center > Apps & Integrations > APIs > OAuth clients
   - **Critical**: The Unique Identifier MUST start with `zdg-` (e.g., `zdg-rebel`)
   - Fill out all fields including optional ones
   - Set redirect URL to `https://rebel-auth.mindstone.com/zendesk/callback`

3. **Submit a Global OAuth Request**
   - Sign in to the [Zendesk Marketplace developer portal](https://developer.zendesk.com)
   - Navigate to Organization > Global OAuth Request tab
   - Complete the request form (subdomain must be your `d3v-` account)
   - Ref: [Set up a global OAuth client](https://developer.zendesk.com/documentation/marketplace/building-a-marketplace-app/set-up-a-global-oauth-client/)

4. **Wait for approval**
   - Zendesk reviews the request (may take days/weeks)
   - If approved, the local client is "promoted" to global
   - If rejected, you can still use a local client for internal use

5. **Claim and associate** in the Marketplace portal
   - After approval, claim the global client in Organization > Global OAuth
   - Associate it with your Marketplace app listing (if applicable)
   - Ref: [Managing global OAuth clients](https://developer.zendesk.com/documentation/apps/app-developer-guide/managing-global-oauth-clients-and-app-associations/)

6. **Update the codebase**
   - Change `EMBEDDED_CREDENTIALS.zendesk.clientId` from `rebel` to `zdg-rebel` (or whatever the approved identifier is)
   - Update `EMBEDDED_CREDENTIALS.zendesk.clientSecret` to the new secret

### Important: Zendesk Security Policy Change (Aug 2025)

As of [August 2025](https://support.zendesk.com/hc/en-us/articles/9590471542170), Zendesk requires:
- All public integrations must use a **Global OAuth Client**
- Each API call must include custom headers (integration name, org ID, Marketplace app ID)
- **Starting January 31, 2026**: all global OAuth clients must support the refresh token flow
- Third-party apps **cannot use customer API credentials** for authentication

This policy change means the Global OAuth Client path is not just recommended but will eventually be **required** for multi-customer integrations.

### Resolution Options (Ranked)

#### Option 1: Hybrid Approach (Recommended)

Implement API token auth as an immediate fallback while pursuing the Global OAuth Client in parallel.

**Short-term (unblock now):**
- Re-add API token auth support (subdomain + email + API token)
- This is what Zapier uses for Zendesk integration
- Can coexist with OAuth — when the global client is ready, OAuth becomes the primary path
- Add a `settingsKey: 'zendesk'` to `resolveZendeskCredentials()` so users could alternatively provide their own local OAuth client credentials

**Long-term (best UX):**
- Apply for Global OAuth Client via the Marketplace developer portal
- Once approved, embed the `zdg-*` credentials and users get one-click OAuth

#### Option 2: Global OAuth Client Only

Skip the interim fix and wait for Global OAuth Client approval.
- **Pro**: Cleanest end-state
- **Con**: Zendesk integration is completely broken until approval comes through (unknown timeline)

#### Option 3: Per-Instance OAuth (Salesforce Pattern)

Require each customer to create their own OAuth client on their Zendesk instance.
- **Pro**: Works immediately, no Zendesk approval needed
- **Con**: Terrible UX for non-developer users — requires Zendesk admin access and knowledge of OAuth client setup

### History

| Date | Commit | Author | Change |
|------|--------|--------|--------|
| 2026-01-10 | `09eaa0f2` | Team Member | Original Zendesk MCP with API token auth |
| 2026-01-25 | `85059f8d` | Team Member | Migrated from API token to OAuth |
| 2026-01-25 | `a2f2a11f` | Team Member | Added OAuth migration planning docs |
| 2026-02-05 | `6506100f` | Team Member | Fixed subdomain validation order |
| 2026-02-06 | — | — | OAuth "No such client" error discovered during testing |
| 2026-06-06 | `88585a7f7` | Team Member | Removed Zendesk OAuth service, deep-link route, and OAuth IPC channels; added `zendeskApiKeyAccountService.ts` (API-token auth) |
| 2026-06-06 | `019ed7814` | Team Member | Dropped dead OAuth surfaces (`'zendeskApi'` enum, `resolveZendeskCredentials()`, embedded creds); rewrote the user-facing help doc to the API-token flow |

The OAuth migration planning doc (`260125_zendesk_oauth_migration.md`) notes under "Global OAuth Clients":
> Zendesk supports "Global OAuth Clients" (registered via Partner Portal) that work across ALL Zendesk subdomains. This is the preferred approach [...] If we cannot get a Global OAuth Client, fallback is per-tenant OAuth (like Salesforce).

The global client was never obtained before shipping the OAuth change, which is why it fails.


---

## Appendix B: Local vs Global Auth — Decision to Revert to API Token

### Background

After the OAuth "No such client" error was discovered (Feb 6, 2026), three approaches were evaluated:

1. **Hybrid** — Re-add API token auth alongside OAuth, maintain both code paths
2. **Revert to API token only** — Drop OAuth, use API token auth until Global OAuth Client is obtained
3. **Wait for Global OAuth Client** — Leave integration broken until Zendesk approves

### Why the original API token auth never worked

The API token auth mechanism itself (Basic auth with `{email}/token:{api_token}`) was sound. However, there was a **plumbing bug**: the UI collected subdomain/email/api_token credentials, but the IPC handler (`settings:mcp-add-bundled-server`) never wrote them to the `accounts.json` file the MCP server reads from. Users would enter credentials, everything would look fine, but the MCP would start with an empty accounts file.

This was documented in [260125_zendesk_mcp_auth_fix.md](../../plans/finished/260125_zendesk_mcp_auth_fix.md) with a planned `saveZendeskCredentials()` fix, but the OAuth migration superseded it before the fix shipped.

### Why Liam switched to OAuth instead of fixing the bug

From the OAuth migration planning doc and Slack discussion (Feb 6 #coding thread):

1. **User request** — The planning doc states: *"User explicitly requested OAuth, and OAuth is more secure/modern"*
2. **Better UX** — No need for users to generate API tokens in Zendesk's Admin Center
3. **More secure** — Scoped permissions, user-bound tokens, audit trail

ToS compliance was **not cited as a motivation** at the time, though it is a relevant concern (see below).

### Terms of Service considerations

Zendesk's Developer Terms (updated August 2025) prohibit third-party developers from using customer API tokens for distributed integrations. However:

- This policy targets **Zendesk Marketplace apps**, not desktop tools using API tokens
- API token auth is an **explicit Zendesk feature** designed for external tool access
- Rebel is a desktop app, not a Marketplace-listed integration
- The risk for early customer onboarding is low-to-nonexistent

When Rebel scales to broader distribution, Global OAuth Client compliance becomes more important.

### Resolution: removed OAuth, reverted to API-token auth (Jun 2026)

After triple-review (GPT-5.2, Opus 4.6, Gemini 3.1 Pro), the reviewers converged on:

- **Don't build the hybrid** — Maintaining two auth methods adds branching in every auth-touching code path (MCP auth headers, token refresh, account status, UI setup flow) for uncertain near-term benefit
- **Revert to API token auth** — Ships immediately, zero external dependencies, follows existing Fathom/Gamma patterns, single code path, perfectly reversible
- **Pursue Global OAuth Client in parallel** — start the Marketplace registration process if/when broader distribution makes it worthwhile, then switch cleanly to OAuth when approved

This shipped in June 2026 as part of the OSS auth-removal effort (`88585a7f7`, `019ed7814`): the OAuth surfaces were deleted outright and replaced by `zendeskApiKeyAccountService.ts`. See [260208_zendesk_revert_to_api_token_auth.md](../../plans/finished/260208_zendesk_revert_to_api_token_auth.md) for the original implementation plan.
