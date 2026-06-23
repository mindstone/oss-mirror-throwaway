---
description: "HubSpot MCP sandbox testing guide — test account access, synced assets, safety rules, feature checklists"
last_updated: "2026-05-15"
---

# HubSpot Sandbox Testing

How to safely test HubSpot MCP features without touching production data.

**Canonical source for**: HubSpot test environment setup, sandbox details, testing workflows.

## See Also

- [HUBSPOT_MCP.md](./HUBSPOT_MCP.md) — Main HubSpot MCP documentation (tools, scopes, setup)
- [HUBSPOT_API_DEEP_DIVE.md](./HUBSPOT_API_DEEP_DIVE.md) — HubSpot API reference
- [260217_hubspot_mcp_new_features.md](../../plans/finished/260217_hubspot_mcp_new_features.md) — Plan for the 4 new features being developed against this sandbox


## Sandbox Account

| Field | Value |
|-------|-------|
| **Name** | Rebel MCP Sandbox |
| **Type** | Standard Sandbox (synced from production) |
| **Created** | 2026-02-17 |
| **Synced assets** | Contacts (up to 5K), pipelines, workflows, forms, segments |
| **Connected to Rebel** | Yes (via OAuth) |
| **Requires** | Enterprise subscription (Marketing, Sales, Service, Data, or Content Hub) |

### How to Access (Browser)

The sandbox is a separate HubSpot account. You access it by switching accounts in the HubSpot UI:

1. Go to [app.hubspot.com](https://app.hubspot.com) and log in with your normal credentials
2. Click your **account name** in the top-right corner of the navigation bar
3. In the dropdown, you'll see your production account and the **Rebel MCP Sandbox** listed under it
4. Click **Rebel MCP Sandbox** to switch into it
5. The page reloads and you're now in the sandbox -- the top bar will show the sandbox name and a visual indicator (banner or different color) confirming you're not in production

**Alternative route**: From the production account, go to **Settings → Account Management → Sandboxes** to view, manage, or delete sandboxes.

**Tip**: Bookmark `https://app.hubspot.com/contacts/<sandbox-hub-id>` for direct access (replace `<sandbox-hub-id>` with the sandbox's Hub ID, visible in the URL after switching).


## What's in the Sandbox

Since we synced everything from production, the sandbox contains:

- **Custom properties** — All custom fields on contacts, companies, deals, tickets (matching production schema)
- **Pipelines** — All deal and ticket pipelines with stages
- **Workflows** — All workflows (structure and configuration, but some actions may be flagged as incompatible)
- **Forms** — All forms except blog comment forms
- **Segments/Lists** — Active segments with property filters (contacts within segments don't transfer)
- **Contacts** — Up to 5,000 recently updated contacts plus associated companies, deals, tickets

### What's NOT in the Sandbox

- **Dashboards and reports** — Must be created manually if needed
- **Marketing emails** — Content assets beyond automated emails
- **Additional contacts** — Contact sync is one-time only; can't re-sync later
- **Record IDs** — All IDs differ from production. Do not hardcode IDs from one environment in the other


## Testing Checklist for New Features

Use this sandbox for the four features in the [new features plan](../../plans/finished/260217_hubspot_mcp_new_features.md):

### 1. Attach Docs to Deal/Ticket (Already Implemented)

- [ ] Upload a test file via `attach_file_to_record` to a sandbox deal
- [ ] Verify note appears on the deal with the attachment
- [ ] Test with a ticket as well
- [ ] Confirm the file shows up in HubSpot File Manager

### 2. Association Labels (e.g., "Contract Signatory")

**Setup** (do this once in the sandbox):
1. Go to sandbox → **Settings → Objects → Contacts → Associations**
2. Create a custom association label: "Contract Signatory" (contact → deal)
3. Note the `associationTypeId` (needed for API calls)

**Testing**:
- [ ] `list_hubspot_association_labels` returns the custom label with correct typeId
- [ ] `create_hubspot_labeled_association` successfully links a contact to a deal with the label
- [ ] Verify in HubSpot UI that the association shows the label
- [ ] Test with `HUBSPOT_DEFINED` labels (e.g., "Primary Contact") as well

### 3. Workflow Interrogation

The sandbox already has production workflows synced. Test against those:

- [ ] `list_hubspot_workflows` returns all synced workflows
- [ ] `get_hubspot_workflow` returns full structure for a specific workflow
- [ ] Ask Rebel to analyze a workflow and identify potential issues
- [ ] Verify no write operations are performed (read-only)

**Note**: Some workflow actions may be flagged as incompatible in the sandbox. This is expected and useful for testing -- Rebel should be able to identify these.

### 4. Dashboards/Reports

No API exists for this (see plan doc). No testing needed. Rebel can query CRM data directly for analysis.


## Connecting Rebel to the Sandbox

The sandbox appears as a separate HubSpot account in Rebel. You can have both production and sandbox connected simultaneously.

### First-Time Setup

1. Open Rebel → **Settings** (gear icon) → **Connectors**
2. Find **HubSpot** in the connector list
3. If HubSpot is already connected (to production), click **"Add another account"** to add the sandbox alongside it. If not connected at all, click **"Connect"**
4. Your browser opens to the HubSpot OAuth consent screen
5. **Critical step**: At the top of the OAuth screen, HubSpot shows an account selector. Click it and choose **"Rebel MCP Sandbox"** -- do NOT select your production account
6. Review the permissions and click **"Allow"**
7. The browser shows a success page. Return to Rebel
8. The sandbox now appears as a separate account under HubSpot in Settings, identified by the email used to connect and the sandbox Hub ID

### How Rebel Knows Which Account to Use

When you have multiple HubSpot accounts connected (production + sandbox), Rebel's HubSpot tools use the **first connected account by default**. To target the sandbox specifically:

- In your prompt to Rebel, specify which account: *"Using the Rebel MCP Sandbox HubSpot account, search for contacts at Test Corp"*
- Or use the `list_hubspot_accounts` tool to see all connected accounts and their Hub IDs, then reference the sandbox by email or Hub ID

### Reconnecting

If the sandbox connection expires or breaks:

1. In Rebel → **Settings → Connectors → HubSpot**
2. Find the sandbox account and click **Disconnect**
3. Follow the first-time setup steps above to reconnect

### Permissions Required

The user connecting must have **App Marketplace Access** permission in the sandbox (or be a Super Admin). This is the same requirement as production -- see [HUBSPOT_MCP.md](./HUBSPOT_MCP.md#hubspot-user-permission) for details. Sandbox accounts inherit user permissions from production, so if you have the permission in production you likely have it in the sandbox too.


## Safety Rules

1. **Never test destructive operations against production** — always switch to the sandbox first
2. **Check which account is connected** before running write operations (create, update, delete)
3. **IDs are different** between sandbox and production — never copy IDs between environments
4. **Contact sync is one-time** — if you need fresh production data, you'll need to create a new sandbox
5. **Workflows may behave differently** — some actions won't fire in the sandbox (e.g., emails to real addresses are blocked)


## Refreshing the Sandbox

If the sandbox becomes stale or corrupted:

1. Go to production → **Settings → Sandboxes**
2. Delete the existing sandbox
3. Create a new one and re-sync assets
4. Reconnect Rebel to the new sandbox via OAuth

**Note**: HubSpot Enterprise accounts can have a limited number of sandboxes. Check your account limits before creating a new one.


## Adding Test Data

For test data beyond what was synced from production, you can:

**Via Rebel (connected to sandbox)**:
- Create test contacts, companies, deals using existing HubSpot tools
- Use `create_hubspot_note` to add test notes with associations

**Via HubSpot UI (in sandbox)**:
- Create custom association labels (Settings → Objects → Associations)
- Create test workflows (Automation → Workflows)
- Create test forms (Marketing → Forms)
- Build test dashboards/reports (Reports → Dashboards)

**Via API prompts to Rebel**:
```
Connect to the Rebel MCP Sandbox HubSpot account and create:
- 5 test contacts at "Test Corp" with different job titles
- 1 test deal "Sandbox Test Deal" in the first pipeline stage
- Associate the contacts to the deal
```
