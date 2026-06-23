---
description: "Community n8n MCP connector for workflow authoring — API-key setup, node validation, templates, telemetry safety review"
last_updated: "2026-05-13"
---

# n8n (Community) MCP

Community-built n8n MCP from Romuald Czlonkowski. Optimised for **authoring and editing** n8n workflows — deep node knowledge, multi-level validation, and a 2,300+ template library.

| Property | Value |
|----------|-------|
| **Status** | NEW — added May 2026, untested in Rebel |
| **Type** | Community MCP (npx, stdio) |
| **Catalog ID** | `n8n-community` |
| **Maintainer** | Romuald Czlonkowski |
| **Source** | https://github.com/czlonkowski/n8n-mcp |
| **npm Package** | [`n8n-mcp`](https://www.npmjs.com/package/n8n-mcp) (pinned to `2.51.3` in catalog) |
| **License** | MIT |
| **Auth** | n8n API key (no OAuth) |
| **Tools** | 22 (7 documentation/validation + 15 workflow management) |
| **Security review** | [`docs/research/260513_n8n_community_mcp_security_review.md`](../../research/260513_n8n_community_mcp_security_review.md) — verdict **RESTRICT** (keep with telemetry-off env + HTTPS warning) |
| **Sister entry** | [`n8n` (Official)](../../../resources/connector-catalog.json) — see comparison below |

---

## Why Two n8n MCPs?

n8n has two distinct MCP options and they cover different jobs. Keep both in the catalog so users can pick the one that matches their workflow.

| Aspect | n8n (Official) | n8n (Community) |
|--------|----------------|-----------------|
| **Source** | n8n team, hosted inside your n8n instance | [czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp) |
| **Transport** | HTTP (`https://<your-domain>/mcp-server/http`) | stdio (`npx n8n-mcp`) |
| **Auth** | OAuth via your n8n instance | n8n API key (Settings → n8n API) |
| **n8n version required** | Recent — April 2026+ (must ship built-in MCP server) | Anything with the n8n API enabled (0.183+) |
| **Where the MCP runs** | Your n8n server | Your machine (local Node.js + npx) |
| **Strength** | Running, testing, and managing existing workflows; honours user permissions; integrated with n8n's own auth model | Authoring new workflows; deep node knowledge; large template library; multi-level validation before deploying |
| **Best for** | "Run my Slack-notification workflow with this input" / "Publish workflow X" / "List recent executions" | "Build me a new workflow that watches Gmail and posts to Slack" / "Validate this node config before deploying" / "Find a template for webhook → CRM" |
| **Tools** | 25 (workflow run/test/publish, data tables, projects/folders) | 22 (node search/validate, templates, workflow CRUD, audit, autofix, credential management) |
| **Notable absent capabilities** | Node validation, template library, deep node docs, partial diff updates | Data tables management, projects/folders, test pin-data preparation |

**Rule of thumb:**
- **Building** workflows from scratch, or doing serious editing → **Community**
- **Operating** existing workflows from inside Rebel → **Official**
- Many users will want both connected.

---

## Telemetry — disabled by default in Rebel (important)

The upstream `n8n-mcp` package ships with **anonymous usage telemetry on by default**. The catalog entry sets `N8N_MCP_TELEMETRY_DISABLED=true` in `mcpConfig.env` to turn it off. Do not remove that env var without re-running the security review.

**Why we disable it:**

- **Telemetry is on by default upstream** unless `N8N_MCP_TELEMETRY_DISABLED=true` (or `TELEMETRY_DISABLED` / `DISABLE_TELEMETRY`) is set in the environment before first run. Source: `src/telemetry/config-manager.ts:185,244-261`.
- **What gets sent:** workflow node names (verbatim — n8n node names typically encode business context like "HR - PIP Notifications" or "M&A Pipeline"), workflow structure, node types, the `userIntent` string on every `n8n_update_partial_workflow` call (which the upstream tool description explicitly coaches the LLM to populate with descriptive text like _"Add error handling for API failures"_), tool usage counts, and error categories. Credentials and most URLs are stripped by sanitisers.
- **Two structural gaps in upstream's sanitiser compound the leak:**
  - The strict-Zod allow-list added by the 2.51.3 fix (GHSA-f3rg-xqjj-cj9w) **only guards `telemetry_workflows`** — the larger `workflow_mutations` write path inserts raw JSONB with no allow-list.
  - `IntentSanitizer.truncate()` is defined but **never called**, and the `intent` Zod schema has no `.max(...)`. A multi-KB intent string is stored verbatim (post-PII regex pass).
- **Where it goes:** a Supabase project the upstream maintainer controls (`https://ydyufsohxdfpopqbubwk.supabase.co`), authenticated by an anon JWT shipped in the npm package. The maintainer's `PRIVACY.md` says the role is write-only via RLS; we have no public-record way to verify that.
- **The user is never warned in Rebel** because our stdio wrapper silently redirects upstream's "Anonymous Usage Statistics" first-run banner to stderr (otherwise it would corrupt the JSON-RPC stream). So default-on telemetry would happen invisibly.

Full evidence and severity analysis: [`docs/research/260513_n8n_community_mcp_security_review.md`](../../research/260513_n8n_community_mcp_security_review.md). The HIGH-severity finding (H1) is exactly this issue.

If a future version bump removes or renames the telemetry env vars, the security review must be re-run before merging the bump.

---

## Setup

### Prerequisites

- **n8n instance** (Cloud, self-hosted, or community edition) on version 0.183+ with the n8n API enabled.
- **Node.js 18+** on your machine — `npx` will fetch the `n8n-mcp` package on first run.
- An **n8n API key** from your account.

### Step 1: Generate an n8n API Key

API keys are scoped to your individual n8n account and inherit your permissions.

1. **Open n8n** in your browser (e.g., `https://<your-tenant>.app.n8n.cloud` for n8n Cloud, or your self-hosted URL).
2. Click your **avatar / initials** (bottom-left).
3. Go to **Settings** → **n8n API**.
4. Click **Create an API key**.
5. Give it a descriptive label (e.g., `Rebel MCP`).
6. **Copy the key immediately** — n8n only shows it once.
7. Store it securely (password manager).

Format: long opaque string, no fixed prefix (the project does not document a `n8n_api_` prefix; treat it as opaque).

**Official docs**: [n8n API Authentication](https://docs.n8n.io/api/authentication/)

### Step 2: Add the Connection in Rebel

1. Go to **Settings** → **Connectors**.
2. Find **n8n (Community)** and click **+ Add**.
3. Fill in:
   - **n8n Base URL**: your n8n root URL, e.g. `https://your-tenant.app.n8n.cloud` (Cloud) or `https://n8n.your-company.com` (self-hosted). Include `https://`, no trailing slash.
   - **n8n API Key**: the key from Step 1.
4. Click **Set up with Rebel**.

The MCP launches locally via `npx -y n8n-mcp@2.51.3` with `MCP_MODE=stdio` and your credentials injected as env vars (`N8N_API_URL`, `N8N_API_KEY`).

### Local n8n (self-hosted on the same machine)

If `N8N_API_URL` points at `localhost` / `127.0.0.1` / `host.docker.internal`, this MCP's default SSRF gate will block requests. The upstream config knob is `WEBHOOK_SECURITY_MODE=moderate`. We do **not** currently expose this knob through the catalog — if you need it, the cleanest fix is to add it to the catalog's `setupFields` as an optional select. File an issue rather than hacking the JSON locally.

---

## Tools

### Documentation & Validation (work without an API key, but our catalog requires it anyway for the full 22-tool surface)

| Tool | Description |
|------|-------------|
| `tools_documentation` | Get docs for any tool in this MCP. Start here. |
| `search_nodes` | Full-text search across 1,650+ n8n nodes (820 core + 830 community). |
| `get_node` | Property listing / docs / property search / version comparison for a single node. |
| `validate_node` | Validate a single node config (modes: `minimal`, `full` with profiles `minimal`/`runtime`/`ai-friendly`/`strict`). |
| `validate_workflow` | Validate a whole workflow JSON (connections, expressions, AI agent setup). |
| `search_templates` | Search 2,300+ workflow templates (modes: `keyword`, `by_nodes`, `by_task`, `by_metadata`). |
| `get_template` | Retrieve a template's nodes / structure / full JSON. |

### Workflow Management (requires `N8N_API_URL` + `N8N_API_KEY`)

| Tool | Description |
|------|-------------|
| `n8n_create_workflow` | Create a workflow on your instance. |
| `n8n_get_workflow` | Fetch a workflow (modes: `full`, `details`, `structure`, `minimal`). |
| `n8n_update_full_workflow` | Replace a workflow entirely. |
| `n8n_update_partial_workflow` | Token-efficient diff update (batch many ops in one call). |
| `n8n_delete_workflow` | Delete a workflow. |
| `n8n_list_workflows` | List with filters & pagination. |
| `n8n_validate_workflow` | Validate a deployed workflow by ID. |
| `n8n_autofix_workflow` | Auto-fix common errors in an existing workflow. |
| `n8n_workflow_versions` | List / view / roll back versions. |
| `n8n_deploy_template` | Deploy a template from n8n.io with auto-fix. |
| `n8n_test_workflow` | Trigger a test execution. |
| `n8n_executions` | List / get / delete executions. |
| `n8n_manage_credentials` | List / get / create / update / delete / get schema for credentials. |
| `n8n_audit_instance` | Security audit (built-in n8n audit + deep workflow scan). |
| `n8n_health_check` | Check API connectivity and feature availability. |

---

## Usage Examples

### Build a workflow from scratch

> "Build me a workflow that watches a Gmail label for new messages, summarises them with GPT, and posts the summary to Slack."

The MCP will: search templates → search nodes → validate node configs → call `n8n_create_workflow` → validate the deployed workflow.

### Use a template

> "Find a template for webhook → HubSpot contact creation, and deploy it to my instance."

The MCP will: `search_templates({ searchMode: 'by_task', task: 'webhook_processing' })` → `get_template` → `n8n_deploy_template`.

### Iterate on an existing workflow

> "Add error handling to my 'Daily Sales Report' workflow and re-validate it."

The MCP will: `n8n_list_workflows` → `n8n_get_workflow` → `n8n_update_partial_workflow` → `n8n_validate_workflow`.

### Security review

> "Audit my n8n instance for risky workflows."

The MCP will: `n8n_audit_instance`.

---

## Troubleshooting

### "Authentication failed" / 401

- API key wrong, expired, or revoked — generate a new one in **Settings → n8n API → Create an API key**.
- The key inherits your account permissions; check you actually have access to the workflows you're trying to read.

### "Cannot connect to n8n at <url>"

- URL is wrong (typo, trailing slash, missing `https://`).
- For self-hosted: the n8n server may not be reachable from your machine (VPN, firewall).
- For Cloud: confirm your workspace subdomain (e.g., `<tenant>.app.n8n.cloud`).

### Tools list returns only the 7 documentation tools

- `N8N_API_URL` or `N8N_API_KEY` env var didn't reach the MCP. Disconnect and reconnect the connector.
- Some n8n editions disable the API by default — enable it in Settings → n8n API.

### `npx` first run is slow

- The package ships with a pre-built database of n8n nodes (~280MB). First run downloads + extracts it; subsequent runs are fast. This is normal.

### Local n8n: "blocked by SSRF gate"

- `N8N_API_URL` points at loopback. The catalog doesn't currently expose `WEBHOOK_SECURITY_MODE=moderate`; see "Local n8n" note above.

### Stdout protocol errors / JSON parsing failures

- `MCP_MODE=stdio`, `LOG_LEVEL=error`, and `DISABLE_CONSOLE_OUTPUT=true` are set by the catalog precisely to prevent this. If you see these, the env vars aren't being passed — re-add the connector.

---

## References

**This MCP:**
- [czlonkowski/n8n-mcp on GitHub](https://github.com/czlonkowski/n8n-mcp) — source, releases, issues
- [`n8n-mcp` on npm](https://www.npmjs.com/package/n8n-mcp) — version history
- [Self-hosting guide](https://github.com/czlonkowski/n8n-mcp/blob/main/docs/SELF_HOSTING.md) — npx / Docker / Railway options (the catalog uses the npx path)
- [Hosted dashboard](https://dashboard.n8n-mcp.com) — upstream maintainer's hosted version (we run local npx instead, but useful for ad-hoc trials)

**n8n itself:**
- [n8n API Authentication](https://docs.n8n.io/api/authentication/)
- [n8n REST API reference](https://docs.n8n.io/api/api-reference/)
- [n8n Cloud](https://app.n8n.cloud/) / [n8n self-hosted docs](https://docs.n8n.io/hosting/)

**Internal:**
- [Security review (2026-05-13)](../../research/260513_n8n_community_mcp_security_review.md) — multi-model audit; verdict RESTRICT, top risk is upstream's default-on telemetry
- [MCP_SECURITY_REVIEW](../MCP_SECURITY_REVIEW.md) — the workflow that produced the review (re-run on every version bump)
- [MCP_IMPROVEMENT_WORKFLOW](../MCP_IMPROVEMENT_WORKFLOW.md) — the workflow this entry was added under
- [MCP_ARCHITECTURE → Connector Catalog](../MCP_ARCHITECTURE.md#connector-catalog) — catalog schema
- Sister entry: `n8n (Official)` in `resources/connector-catalog.json` (id `n8n`)
