---
description: "Workflow for researching, implementing, testing, and documenting MCP connector changes"
last_updated: "2026-06-11"
---

# MCP Connector Workflow

When and why to build MCPs, what order to do it in, and the policies/checklists that govern the process. For **how** to implement, see [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md). For how changes **propagate to users**, see [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md). When proposing MCP boundary changes, consult [BOUNDARY_REGISTRY](BOUNDARY_REGISTRY.md) first — the hints script (`scripts/boundary-hints.ts`) flags known-risky surfaces and requires Spec Reader review during CHIEF_ENGINEER Phase 2.

---

## Where Topics Live

Territory routing (the full doc map + "I want to…" table) lives in **[MCP_OVERVIEW](MCP_OVERVIEW.md)** — go there to find the canonical doc for any MCP topic (architecture, OSS distribution & release, testing, security reviews, MCP Apps, per-connector docs).

**This doc** owns the **workflow** (when, why, how to sequence MCP work) and **critical policies** (things you must get right). For implementation details, follow the signposts via the hub. Two non-doc references not in the hub: library/tool selection ([`third-party-choosing` skill](../../rebel-system/skills/coding/third-party-choosing-products-utilities-libraries/SKILL.md)) and the official MCP spec ([modelcontextprotocol.io/specification](https://modelcontextprotocol.io/specification)).

> **Landing rule for `mcp-servers/`** (2026-06-11): code changes land code-only (PR or direct push); version bumps/releases land **only** via `npm run mcp:release` — never bundle a version bump into a PR. See [MCP_OSS_RELEASE_AGENT_DRIVEN](MCP_OSS_RELEASE_AGENT_DRIVEN.md).

---

## Quick Start: Choose Your Path

### What do you want to do?

**A. Add a connector to the catalog (1-click setup for users)**
- Edit `resources/connector-catalog.json`
- Include a `tools` array with `{ name, description }` for each tool the connector exposes. For bundled/community MCPs, run `npx tsx scripts/harvest-mcp-tools.ts --mode=bundled --write` to auto-populate. For direct/OAuth MCPs, add tools manually from vendor docs.
- See [MCP_ARCHITECTURE → Connector Catalog](MCP_ARCHITECTURE.md#connector-catalog) for field reference and description guidelines

**B. Build or improve a bundled MCP server**
- Code lives in `resources/mcp/<mcp-name>/`
- Start with [Phase 1: Research](#phase-1-research) below

**C. Understand how MCPs work in Rebel**
- [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) -- runtime config, connector UI, auth, discovery

**D. Debug Super-MCP / HTTP mode issues**
- [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md) -- lifecycle, health checks, troubleshooting

### Common Tasks

| Task | Files to Touch | Reference |
|------|----------------|-----------|
| Add new connector to catalog | `connector-catalog.json` | [MCP_ARCHITECTURE → Connector Catalog](MCP_ARCHITECTURE.md#connector-catalog) |
| Add OAuth to bundled MCP | `resources/mcp/<name>/`, auth service | [MCP_ARCHITECTURE → Authentication Patterns](MCP_ARCHITECTURE.md#authentication-patterns) |
| Change connector auth, token refresh, or reconnect behavior | auth service, MCP token provider, health/reconnect UI | [MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE](MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE.md) |
| Add multi-account support | Instance naming pattern | [MCP_ARCHITECTURE → Multi-Instance Support](MCP_ARCHITECTURE.md#multi-instance-support) |
| Write catalog metadata | `connector-catalog.json` | [MCP_ARCHITECTURE → Writing Good Descriptions](MCP_ARCHITECTURE.md#writing-good-descriptions) |
| Rename/consolidate MCPs | `connector-catalog.json`, `bundledMcpManager.ts` | [Keep Catalog in Sync](#critical-keep-catalog-in-sync) |
| Fix Super-MCP startup | Check logs, port conflicts | [SUPERMCP_OVERVIEW → Troubleshooting](SUPERMCP_OVERVIEW.md#troubleshooting) |
| Update user-facing docs | `rebel-system/help-for-humans/connectors/` | [HELP_FOR_HUMANS_DOCUMENTATION](HELP_FOR_HUMANS_DOCUMENTATION.md) |
| Build/rebuild bundled MCPs | Run build script | [BUILDING → Bundled MCP Servers](BUILDING.md#bundled-mcp-servers) |

---

## Workflow Overview

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Research  │ → │ Analysis │ → │  Review  │ → │Implement │ → │ Testing  │ → │   Docs   │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

### When to Use This Workflow

- **New integrations** -- adding Notion, Linear, Jira, etc.
- **Improving existing MCPs** -- poor UX, missing features, API best practices evolved
- **Building internal tooling MCPs** -- diagnostics, testing

---

## MCP Authentication Patterns

When researching or creating an MCP, one of the first decisions is the authentication model. Rebel supports four patterns -- choose based on what the service provides:

| Pattern | Auth Flow | Credential Storage | Examples |
|---------|-----------|-------------------|----------|
| **OAuth2 via Deep Link** | Cloudflare Worker redirects to app deep link | `userData/mcp/{provider}/` | Slack, Microsoft 365, Salesforce |
| **OAuth2 via Localhost Callback** | Temporary localhost server receives callback | `userData/mcp/{provider}/` | Google Workspace, HubSpot |
| **API Key / Static Token** | User enters key in setup form | MCP config env vars (in router JSON) | Fathom, Gamma, Kling, ElevenLabs, Humaans |
| **Bearer Token Bridge** | Internal bridge, no user auth needed | Auto-generated per session | RebelInbox, RebelMeetings, RebelSearch, etc. |

**Decision guide:**
- Service offers OAuth? → Use OAuth (deep link if vendor supports redirect to custom scheme, localhost callback otherwise)
- Service offers API keys only? → Use API Key pattern with `setupFields` in catalog and `credentialEnvVars` in `BUNDLED_MCP_CATALOG`
- Internal Rebel MCP? → Use Bearer Token Bridge

For implementation details (dynamic ports, token renewal, revocation), see [MCP_ARCHITECTURE → Authentication Patterns](MCP_ARCHITECTURE.md#authentication-patterns).

> **Externalizing an OAuth connector to npm?** STOP and read [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md) first. It covers auth mode architecture, per-provider capability differences, localhost callback security hardening, token persistence, and per-connector effort estimates.
>
> **Changing token refresh or reconnect behavior?** STOP and read [MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE](MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE.md). Rebel has multiple refresh mechanisms; treating them as interchangeable is a common source of connector auth regressions.

---

## Phase 1: Research

### 1.0 Check for Existing MCPs First

Before creating a new MCP, verify we don't already have one:

```bash
grep -i "<service-name>" resources/connector-catalog.json
ls resources/mcp/
grep -i "<service-name>" src/main/services/bundledMcpManager.ts
```

If one exists, consider improving it (skip to [Phase 2](#phase-2-analysis)). If a Klavis entry exists, you may still want a bundled/direct version -- see [Keep Both Entries](#important-keep-both-klavis-and-directbundled-entries).

### 1.1 API Best Practices

Use a researcher subagent to find:
- Official API documentation (rate limits, quotas, error handling, auth)
- Response format options (metadata vs full, field masks)
- **Always verify against official docs** -- don't assume based on naming patterns

### 1.2 Reference Implementation Research

Find high-quality open-source implementations. **Check license first** (prefer MIT, Apache 2.0, BSD, ISC).

Search order:
1. Official vendor MCPs (check if the service has one)
2. [Google MCP Toolbox](https://github.com/googleapis/genai-toolbox) for database/analytics
3. [Anthropic MCP examples](https://github.com/anthropics/anthropic-cookbook)
4. Community implementations (GitHub stars, recent activity)
5. Compare against [Klavis MCPs](https://github.com/Klavis-AI/klavis/tree/main/mcp_servers) for tricks we might have missed

Quality standards: per [`third-party-choosing` skill](../../rebel-system/skills/coding/third-party-choosing-products-utilities-libraries/SKILL.md).

### 1.3 Tool & Package Design

For tool naming, descriptions, error patterns, and response format guidance, see:
- [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents) -- Anthropic's official guide
- [`build-custom-mcp-server` skill](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md) -- comprehensive implementation guide
- [`mcp_best_practices.md`](../../rebel-system/skills/coding/build-custom-mcp-server/references/mcp_best_practices.md) -- naming, pagination, error handling

**Key principles** (details in the docs above):
- Design for agent workflows, not API wrappers
- Flat parameters over nested; unambiguous names
- Examples in descriptions; actionable error messages
- WORKFLOW / RELATED TOOLS / COMMON MISTAKES sections in tool descriptions
- **Zero-parameter tools:** be explicit in validation/help text — e.g. “This tool takes no arguments. Call it with `{}`.” This prevents argument hallucinations and aligns with Super-MCP error guidance.
- See the migrated OSS packages in `mindstone/mcp-servers` (for example `connectors/slack/` and `connectors/google-workspace/`) for reference implementations.

### 1.4 Package Naming (Critical for Super-MCP)

With Super-MCP's progressive disclosure, the package description is the primary signal for tool selection. Keep brand names for package IDs, put functional verbs in descriptions. Update both `bundledMcpManager.ts` and `connector-catalog.json` descriptions when adding tools.

---

## Phase 2: Analysis

### 2.1 Current Implementation Audit

Review: tool schemas (`tools/definitions.ts`), handler implementations, service layer, response sizes.

### 2.2 Gap Analysis

| Area | Current | Best Practice | Gap |
|------|---------|---------------|-----|
| Response size | ? | <10KB typical | ? |
| Default format | ? | metadata/minimal | ? |
| Tool calls needed | ? | 1 for simple query | ? |

### 2.3 Priority Matrix

```
        High Value
            │
   P1       │      P0
  (Later)   │   (Do First)
            │
 ───────────┼───────────── Easy
            │
   P3       │      P2
  (Maybe)   │   (Quick Win)
            │
        Low Value
```

### 2.4 Create Planning Doc

Create `docs/plans/YYMMDD_<mcp>_improvements.md` with research findings, gap analysis, staged plan, and risks.

---

## Phase 3: Review

For complex/risky changes, launch parallel reviewers:

```
Task(reviewer-gpt5.5-high, "Review MCP improvement plan...")
Task(reviewer-gemini3.1-pro, "Review MCP improvement plan...")
Task(reviewer-opus4.7-thinking, "Review MCP improvement plan...")
```

**Focus areas**: Correctness (API best practices), completeness (edge cases), breaking changes, security (token handling, data exposure), UX (LLM-friendly interface).

---

## Phase 4: Implementation

### 4.1 Staged Implementation

Implement P0 changes first, build-verify after each stage, test in app, iterate.

### 4.2 Code Patterns

For implementation patterns, follow these in order:
1. [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) -- **Start here.** SDK construction (`McpServer` + Zod), module architecture, error handling, security baseline, distribution, migration sequencing
2. [`build-custom-mcp-server` skill](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md) -- TypeScript starter template
3. [`mcp_best_practices.md`](../../rebel-system/skills/coding/build-custom-mcp-server/references/mcp_best_practices.md) -- Tool naming, pagination, response formats

One recurring schema pattern: tool fields accepting agent-supplied dates or times use `z.preprocess` coercion accepting both epoch milliseconds and ISO 8601 strings, with empty-string and non-finite-number guards — models half-guess date formats.

### 4.3 Build and Test

**Before building:** Register the MCP in `scripts/mcp-config.json` by adding its name to the `bundledMcps` array. The build script only bundles MCPs listed here -- without this, the MCP won't get a `resources/mcp-generated/<name>/server.cjs` artifact, and mock tests using `resolveServerScript()` will fail in CI.

```bash
node scripts/build-bundled-mcps.mjs        # Rebuild all bundled MCPs
node scripts/build-bundled-mcps.mjs --force # Force rebuild (skip cache)
cd resources/mcp/<mcp-name> && npm run build  # Single MCP (tsc only, dev)
npm run dev                                # Test in app
```

For build infrastructure details (esbuild bundling, content-hash caching, mcp-config.json), see [BUILDING → Bundled MCP Servers](BUILDING.md#bundled-mcp-servers).

> **Dev Mode Gotcha:** If you previously ran a packaged/Beta build, MCP paths in `super-mcp-router.json` may point to `/Applications/...` instead of your dev `resources/mcp/` directory. Fix: disconnect and reconnect the affected MCP in Settings → Connectors.

---

## Phase 5: Testing

Every new or improved MCP **must** have tests. Choose the best approach based on the MCP's API surface, then add tests before marking the work complete.

### 5.0 Choose the Right Test Strategy

**Prefer mock tests whenever the API is mockable** -- they run without API keys, are deterministic, and can run in CI.

| MCP characteristic | Best test type | Why | Example |
|--------------------|---------------|-----|---------|
| REST API with clear request/response | **Mock API tests** (preferred) | Deterministic, no keys needed, CI-safe, tests real tool logic | Humaans, HubSpot, Zendesk |
| SDK/client-based API (e.g., Graph SDK) | **Mock client unit tests** | Mock the SDK client, test tool functions directly | Microsoft Teams |
| OAuth-based with complex auth flow | **Mock API tests** with temp config dir | Set up fake credentials/token files, mock the API endpoints | HubSpot |
| Simple API-key MCP, few tools | **Mock API tests** (or declarative integration if mocking is impractical) | Fast to write, good coverage | Fathom, TalentLMS |
| Service with no clear REST surface to mock | **Declarative integration tests** (fallback) | Skips without keys, but tests real behavior when available | Legacy pattern |

**Decision flow:**
1. Can you intercept the API's HTTP calls with `createMcpTestClientWithMockApi()`? → **Use mock API tests** (spawns the real MCP server but intercepts HTTP traffic)
2. Does the MCP use an SDK client you can mock with `vi.mock()`? → **Use mock client unit tests** (import tool functions directly, mock the client)
3. Neither is practical? → **Use declarative integration tests** via `runMcpIntegrationSuite()` as a fallback (requires real API keys to run)

### 5.1 Mock API Tests (Preferred for REST APIs)

Use `createMcpTestClientWithMockApi()` from the shared harness. This spawns the real MCP server process and intercepts its outbound HTTP calls, so you test the full tool → handler → API pipeline with deterministic mock data.

Create `resources/mcp/<name>/test-mcp.test.ts`:

```typescript
import {
  createMcpTestClientWithMockApi,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
  type MockRequest,
} from '../../../scripts/mcp-test-harness';

const mockItems = [
  { id: '1', name: 'Item One' },
  { id: '2', name: 'Item Two' },
];

describe('my-mcp - mock tests', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    const result = await createMcpTestClientWithMockApi({
      name: 'my-mcp',
      serverScript: resolveServerScript('my-mcp'),
      interceptDomains: ['api.example.com'],
      routes: [
        { method: 'GET', path: '/api/items', handler: { body: { data: mockItems } } },
        { method: 'GET', path: '/api/items/1', handler: { body: mockItems[0] } },
        { method: 'GET', path: '/api/items/invalid', handler: { status: 404, body: { error: 'Not found' } } },
      ],
      env: { MY_API_KEY: 'mock-test-key' },
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  it('list_items returns items', async () => {
    const result = await client.callToolJson<{ data: Array<{ id: string }> }>('list_items', {});
    expect(result.data).toHaveLength(2);
  });

  it('get_item with invalid ID returns error', async () => {
    const result = await client.callToolJson<{ ok: boolean }>('get_item', { id: 'invalid' });
    expect(result.ok).toBe(false);
  });
});
```

**What to test with mocks:**
- Correct response shaping (fields mapped, formatted, filtered)
- Pagination logic (limit/offset passed correctly)
- Error handling (404s, auth failures, malformed responses)
- Input validation (missing required params)
- Edge cases (empty lists, null fields, missing optional data)
- Request construction (verify correct headers, query params via `mockApi.requestLog`)

See `resources/mcp/humaans/test-mcp.test.ts` and `resources/mcp/hubspot/test-mcp.test.ts` for real examples.

### 5.2 Mock Client Unit Tests (For SDK-Based MCPs)

When the MCP uses a vendor SDK (e.g., Microsoft Graph Client), mock the SDK client and test tool functions directly. This is faster than full-server mock tests and catches logic bugs in the tool handlers.

```typescript
import { vi, describe, it, expect } from 'vitest';

vi.mock('vendor-sdk', () => ({ /* mock SDK exports */ }));

const { listItems, getItem } = await import('./src/tools/items.js');

function createMockClient(options = {}) {
  return {
    api: vi.fn().mockReturnThis(),
    get: vi.fn().mockResolvedValue(options.getResponse ?? {}),
    post: vi.fn().mockResolvedValue(options.postResponse ?? {}),
  };
}

describe('my-mcp tools', () => {
  it('listItems returns formatted results', async () => {
    const client = createMockClient({ getResponse: { value: [{ id: '1' }] } });
    const result = await listItems(client, {});
    // assert response shape
  });
});
```

See `resources/mcp/microsoft-teams/test-mcp.test.ts` for a full example.

### 5.3 Declarative Integration Tests (Fallback)

Use only when mock tests are impractical. These tests skip automatically when the required API key env var is not set, so CI stays clean.

```typescript
import { runMcpIntegrationSuite } from '../../../scripts/mcp-test-harness';

runMcpIntegrationSuite({
  name: 'my-mcp',
  envKey: 'MY_MCP_API_KEY',
  expectedTools: ['list_items', 'get_item'],
  unconfiguredTool: 'list_items',
  toolTests: [
    { tool: 'list_items', args: { limit: 2 }, expectOk: true, expectFields: ['ok', 'data'] },
    { tool: 'get_item', args: { id: 'invalid' }, expectOk: false },
  ],
});
```

### 5.4 Testing with Real API Keys (Dev Workflow)

During development, you can test MCPs against real services using API keys already stored by the Electron app. The `super-mcp-router.json` file contains all configured MCP env vars (including API keys and tokens):

```bash
# Location of router config with credentials
~/Library/Application Support/mindstone-rebel/mcp/super-mcp-router.json
```

**To run with a real key:** Extract the key from the router JSON and pass as env var:

```bash
export FATHOM_API_KEY=$(python3 -c "import json; d=json.load(open('$HOME/Library/Application Support/mindstone-rebel/mcp/super-mcp-router.json')); print([v['env']['FATHOM_API_KEY'] for k,v in d['mcpServers'].items() if 'FATHOM_API_KEY' in v.get('env',{})][0])")
npx vitest run resources/mcp/fathom/test-mcp.test.ts
```

### 5.5 Interactive Debugging

For interactive debugging: `npx @modelcontextprotocol/inspector node build/index.js`

Use the MCP SDK directly for ad-hoc verification:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['build/index.js'] });
const client = new Client({ name: 'test', version: '1.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const result = await client.callTool({ name: 'tool_name', arguments: { query: 'test' } });
await client.close();
```

For the full testing guide (smoke tests, declarative integration tests, health checks, debugging failures), see [MCP_TESTING](MCP_TESTING.md).

---

## Phase 6: Documentation

1. **Create/update MCP doc** -- `docs/project/mcps/<MCP_NAME>.md` (architecture, tool reference, setup, troubleshooting)
2. **Create/update user-facing doc** -- `rebel-system/help-for-humans/connectors/<mcp-name>.md` (per [HELP_FOR_HUMANS_DOCUMENTATION](HELP_FOR_HUMANS_DOCUMENTATION.md))
3. **Update planning doc** -- mark stages complete, add learnings
4. **Check skills** -- grep `rebel-system/skills/` for references to this MCP; update if tool names or workflows changed
5. **Update connector catalog** -- ensure `connector-catalog.json` descriptions reflect new capabilities
6. **Update tool catalog** -- Run `npx tsx scripts/harvest-mcp-tools.ts --mode=bundled --write` (for bundled MCPs) or manually populate `tools` in `connector-catalog.json` (for direct/community MCPs). See [tool validation workflow](../../.github/workflows/mcp-catalog-tool-validation.yml).

---

## Critical Policies

These policies must be followed. They exist here (not elsewhere) because they're workflow-specific concerns that don't fit neatly into a single architecture doc.

### Critical: Keep Catalog in Sync

When renaming, consolidating, or removing bundled MCPs, update `resources/connector-catalog.json` in the same PR. Out-of-sync catalog causes confusing UI states.

**Checklist for MCP rename/consolidation:**
- [ ] Add new catalog entry with matching `id` (must match `catalogId` in `BUNDLED_SERVER_TO_CATALOG_ID`)
- [ ] Delete old catalog entries
- [ ] Update `bundledMcpManager.ts` payload builders
- [ ] Update `mcpConfigManager.ts` `BUNDLED_SERVER_TO_CATALOG_ID` mapping (keep old mappings for migration)
- [ ] Update `bundledMcps` in `scripts/mcp-config.json`

**Checklist for adding a new bundled MCP:**
- [ ] Create source in `resources/mcp/<name>/` with `package.json`, `tsconfig.json`, and `src/`
- [ ] Add MCP name to `bundledMcps` in `scripts/mcp-config.json` (required for CI builds and `resolveServerScript()` in tests)
- [ ] Add catalog entry in `connector-catalog.json`
- [ ] Add payload builder and catalog ID mapping in `bundledMcpManager.ts`
- [ ] Verify build: `node scripts/build-bundled-mcps.mjs` produces `resources/mcp-generated/<name>/server.cjs`
- [ ] Add mock API tests in `resources/mcp/<name>/test-mcp.test.ts` (see [Phase 5](#phase-5-testing))
- [ ] Add ToolAnnotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) to all tools — see [MCP_ARCHITECTURE § ToolAnnotations](MCP_ARCHITECTURE.md#toolannotations)
- [ ] Populate `tools` array in `connector-catalog.json` (run `npx tsx scripts/harvest-mcp-tools.ts --mode=bundled --write` or add manually)

**Checklist for adding a NEW internal MCP:**
- [ ] Add server name to `INTERNAL_MCP_SERVER_NAMES` in `bundledMcpManager.ts`
- [ ] Add catalog entry with `isInternal: true` in `connector-catalog.json`
- [ ] Add payload builder function in `bundledMcpManager.ts`
- [ ] Register at startup in `src/main/index.ts` via `upsertMcpServersBatch()`
- [ ] Add MCP name to `bundledMcps` in `scripts/mcp-config.json`
- [ ] Populate `tools` array in `connector-catalog.json`

### Important: Keep Both Klavis AND Direct/Bundled Entries

When adding a direct or bundled MCP for a service that already has a Klavis entry, keep both. Use different IDs:
- Bundled local: `bundled-<service>` with name `"<Service> (Local)"`
- Direct vendor: `<service>-direct` with name `"<Service> (Direct)"`

See `KLAVIS_TO_BUNDLED_MCP_MIGRATION.md` for the full pattern.

### Version Pinning for NPX MCPs

All third-party MCPs invoked via `npx` must use pinned versions, not `@latest` or implicit latest.

**Why:** Breaking changes, supply chain attacks, non-reproducible builds, debugging difficulty.

**How:** Use `"args": ["-y", "@package/name@1.2.3"]` in `connector-catalog.json`.

**Checklist:**
- [ ] Version pinned in args
- [ ] Version documented in MCP doc
- [ ] setupInstructions use same pinned version
- [ ] On every pin bump, smoke-test the new pin by invoking at least one tool from the connector — catalog schema validation checks shape, not runtime behavior

### Bundled MCPs with File-Based Credentials

Some bundled MCPs read credentials from a file (e.g., `accounts.json`), not environment variables. If you add `setupFields` to such an MCP, you must also write a helper in `bundledMcpManager.ts` to save credentials to the file before starting the MCP. See `saveZendeskCredentials()` for the pattern and `docs/plans/finished/260125_zendesk_mcp_auth_fix.md` for a case study.

### Critical: OSS Connector Security

> For OSS-specific technical standards (host validation patterns, error sanitization, credential abstraction), see [MCP_SERVER_STANDARD § OSS Readiness](MCP_SERVER_STANDARD.md#oss-readiness). For the pre-PR contribution checklist, see the [`contribute-connector` reference](../../rebel-system/skills/coding/build-custom-mcp-server/references/contribute-connector.md#oss-security-review).

When publishing MCP connectors as open-source packages, the following policies are **mandatory**. These were derived from a security audit of 17 externalized connectors and address systemic risks around credential leakage, brand exposure, and supply chain integrity.

#### A. Internal Reference Stripping

ALL open-source connector code must be free of internal references:

- **Prohibited terms** in source, tests, and docs: `Mindstone`, `Rebel`, `nspr`, internal domains, internal service endpoints
- **Allowed exceptions**: LICENSE file (Mindstone Engineering as licensor), `package.json` author/scope fields
- **Error messages** must be host-neutral — e.g., _"Reconnect this connector in your MCP host's settings"_ NOT _"Reconnect in Mindstone settings"_
- **User-Agent strings** must use neutral connector names — e.g., `mcp-server-zendesk/0.2.0` NOT `rebel-app/1.0 (Zendesk-MCP)`
- **No internal environment variables** (e.g., `REBEL_WORKSPACE_PATH`) in OSS code

#### B. Bridge Pattern Prohibition

The following must **never** exist in open-source connector code:

- `MINDSTONE_REBEL_BRIDGE_STATE` environment variable
- `bridge.ts` files or bridge-related modules
- Localhost bridge calls (`http://127.0.0.1:${port}/bundled/...`)

Bridge functionality is host-specific plumbing that belongs in the Rebel app, not in standalone connectors. The `_template` in `mcp-servers` must not include bridge scaffolding.

#### C. Host/Domain Validation

Connectors that accept user-supplied hostnames or subdomains **must** validate them against a service-specific allowlist or strict pattern before sending credentials:

- **Freshdesk**: enforce `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` for subdomain
- **Workday**: enforce `*.workday.com` pattern
- **General rule**: any connector accepting a hostname/subdomain input must prevent credential exfiltration to attacker-controlled hosts

The `mcp-servers` template should include a shared hostname validation utility.

#### D. License and Documentation Requirements

Every connector published to npm must include:

- **LICENSE file** with the full FSL-1.1-MIT text (not just a reference in `package.json`)
- **README.md** with: what it does, setup instructions, tool reference, auth requirements, and security disclosures
- **Repo-level SECURITY.md** with vulnerability disclosure process and security contact
- **CLA or DCO** for contributor IP protection (especially important under FSL-1.1-MIT)

#### E. Pre-Publish Security Checklist

Before any connector is published to npm:

- [ ] No internal references (grep for `mindstone`, `rebel`, `nspr` — excluding LICENSE and `package.json` author fields)
- [ ] No bridge pattern code (no `bridge.ts`, no `MINDSTONE_REBEL_BRIDGE_STATE`, no localhost bridge calls)
- [ ] No branded User-Agent strings
- [ ] No internal environment variables
- [ ] Host/domain inputs validated against service-specific patterns
- [ ] LICENSE file present with full FSL-1.1-MIT text
- [ ] README.md present with security disclosures
- [ ] Error messages are host-neutral
- [ ] `npm audit` clean (no Critical/High vulnerabilities)
- [ ] No hardcoded secrets anywhere in source or test fixtures
- [ ] Test fixture mock keys don't resemble real credential patterns (avoid `sk_`, `key_` prefixes)
- [ ] `server.json` present and `mcp-publisher validate` passes — registry namespace is `io.github.mindstone/mcp-server-<connector>` and `mcpName` in `package.json` matches it. Bridge-only env vars excluded from `environmentVariables[]`. See [MCP_SERVER_STANDARD § Registry Submission](MCP_SERVER_STANDARD.md#registry-submission-serverjson).

#### F. Supply Chain Security

- **npm publishing** should use OIDC trusted publishing (not long-lived `NPM_TOKEN`) when available
- Publish with **provenance/attestations**
- Run **Dependabot or Renovate** for automated dependency updates
- Include `npm audit` in CI pipeline

### Critical: Error Observability for MCP Operations

**Every user-visible MCP failure must report to both Sentry and PostHog.** Without this, errors are invisible to engineering -- users see failures but we have zero remote telemetry.

**When to add error reporting:**
- Any `catch` block where the error results in a user-visible failure (auth failure, tool listing broken, config errors, connection failures)
- Any `catch` block that returns a degraded result the user might notice (e.g., `{ success: false }`, `{ health: 'unknown' }`)
- Any new IPC handler for MCP operations that catches and returns errors

**When NOT to add error reporting:**
- Cleanup errors (e.g., `client.close()` failures)
- Expected fallbacks (e.g., file-not-found when checking optional config)
- Transient health check failures (PostHog only, no Sentry -- these are too noisy)

**How to report:** Use the `reportMcpError()` helper in `src/main/services/mcpService.ts`:

```typescript
reportMcpError(error, 'oauth_authenticate', {
  serverId,              // Optional: PII-stripped automatically via getSafeServerName
  level: 'warning',      // Optional: defaults to 'error'
  extra: { configPath }, // Optional: additional context (no PII)
});
```

**Rules:**
- Use `getSafeServerName(serverId)` for Sentry tags -- never send raw multi-instance server IDs (they contain email slugs)
- Truncate error messages to 200 chars for PostHog
- Always wrap reporting calls in try/catch so telemetry failures never alter error-handling behavior
- Use consistent `mcp_operation` values: `oauth_authenticate`, `stdio_authenticate`, `list_tools`, `health_check`, `config_read`, `config_parse`, `super_mcp_restart`, `describe_config`, `resource_fetch`

**Reference:** See `src/main/services/__tests__/mcpService.errorReporting.test.ts` for the test patterns.

---

## Integrating Third-Party MCPs

Not all MCPs need to be built from scratch. Use the right integration pattern:

| Scenario | Pattern | Example |
|----------|---------|---------|
| Vendor hosts their own MCP endpoint | Direct MCP in catalog | Notion, Linear, Asana |
| Good npm package exists | Community MCP in catalog | ElevenLabs, Metabase |
| Needs deep app integration | Bundled MCP in `resources/mcp/` | App Bridge, Office add-in |
| Should be enabled by default | Startup-bundled payload | Discourse community forum |
| Needs browser extension or user URL | Setup-required pattern | Browser MCP, Framer |

For connector catalog fields, schema, and setup patterns (setupFields, setupUrl, setupInstructions), see [MCP_ARCHITECTURE → Connector Catalog](MCP_ARCHITECTURE.md#connector-catalog).

For authentication patterns (OAuth callback, dynamic ports, token storage/renewal/revocation), see [MCP_ARCHITECTURE → Authentication Patterns](MCP_ARCHITECTURE.md#authentication-patterns).

For Python MCPs using `uvx`, see [PYTHON_RUNTIME](PYTHON_RUNTIME.md).

**Evaluating community MCPs:** Use a researcher subagent to scan for malicious code and verify permissive licensing. Prefer Node over Python (Python requires users to install it separately). Per [`third-party-choosing` skill](../../rebel-system/skills/coding/third-party-choosing-products-utilities-libraries/SKILL.md).

> **STOP — Run a full security review before shipping any non-official community/direct MCP** (and on every pinned-version bump). Follow [MCP_SECURITY_REVIEW](MCP_SECURITY_REVIEW.md): multi-model parallel audit (telemetry, HTTP/auth/SSRF, external CVE/GHSA research, structural map) → Codex consolidation → Opus final adjudication → catalog hardening + CI guards. The first worked example is [the n8n-mcp review](../research/260513_n8n_community_mcp_security_review.md), which surfaced a default-on telemetry channel sending business-context strings to a third-party Supabase project — exactly the failure mode this review catches.

**Checklist for adding a third-party MCP:**
- [ ] Add to `connector-catalog.json` with appropriate provider type
- [ ] Include `verifiedSource` (GitHub repo or official docs)
- [ ] Pin version if using npx (see [Version Pinning](#version-pinning-for-npx-mcps))
- [ ] Set `runtime: 'python'` if using uvx
- [ ] Test connection flow end-to-end
- [ ] Populate `tools` array in `connector-catalog.json` (run harvest script for community MCPs, or add manually for direct/OAuth MCPs)
- [ ] Create `docs/project/mcps/<MCP_NAME>.md` with Status row
- [ ] **Run the [MCP_SECURITY_REVIEW](MCP_SECURITY_REVIEW.md) workflow** and write the review under `docs/research/<YYMMDD>_<connector_id>_security_review.md`. Link it from the connector doc.
- [ ] **Run the catalog schema-and-invariant gate** (`npx tsx scripts/check-connector-catalog-schema.ts`, also in `validate:fast`) to confirm the entry satisfies the full Zod schema + the `rebel-oss` invariants (transport=stdio, command=npx, non-empty `verifiedSource`, non-empty `tools[]`, maturity in the allow-list). See [MCP_OSS_CONNECTORS § Step 1.5](MCP_OSS_CONNECTORS.md#step-15-schema-and-invariant-gate). When *tightening* a catalog schema rule, grep the catalog for entries that would fail the new rule under any plausible provider value — not only their current value — and retroactively fix or document exemptions.

---

## MCP Quality Checklist

Before completing MCP work:

**Server implementation** (details in [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md#7-pre-merge-checklist)):
- [ ] Passes the [MCP_SERVER_STANDARD pre-merge checklist](MCP_SERVER_STANDARD.md#7-pre-merge-checklist) (SDK, annotations, errors, security, packaging)

**Testing:**
- [ ] Mock API tests (preferred) or mock client unit tests; declarative integration tests as fallback. See [Phase 5](#phase-5-testing).
- [ ] **Timezone handling**: Tools returning time data include user's IANA timezone and/or format in user's timezone. No hardcoded UTC for user-facing output. See [TIMEZONE_AND_DATE_HANDLING_IN_MCPS](TIMEZONE_AND_DATE_HANDLING_IN_MCPS.md)

**Tool design:**
- [ ] Clear descriptions with examples, smart defaults, <10KB default responses, pagination for large sets

**Naming conventions:**
- [ ] All top-level parameter names are snake_case (see [MCP_SERVER_STANDARD § Parameter Naming](MCP_SERVER_STANDARD.md#parameter--tool-naming-standard))
- [ ] Same concept uses the same canonical name across all tools in this MCP
- [ ] Tool descriptions and examples use snake_case param names (not camelCase)
- [ ] If renaming existing params: backwards-compatible aliases preserved in handler/normaliser

**Rebel integration:**
- [ ] Error observability: user-visible failures report to Sentry + PostHog (see [Error Observability Policy](#critical-error-observability-for-mcp-operations))
- [ ] Auth/token lifecycle changes satisfy [MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE](MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE.md): token owner identified, refresh failures classified, reconnect path verified
- [ ] Catalog sync: `connector-catalog.json` and `bundledMcpManager.ts` descriptions match
- [ ] Tool catalog: `tools` array in `connector-catalog.json` populated and up to date
- [ ] Documentation: per-MCP doc in `docs/project/mcps/`, user-facing doc in `rebel-system/help-for-humans/connectors/`

**Non-official 3rd-party MCPs (community / direct) only:**
- [ ] Security review run per [MCP_SECURITY_REVIEW](MCP_SECURITY_REVIEW.md); doc under `docs/research/<YYMMDD>_<connector_id>_security_review.md`
- [ ] Catalog hardening (telemetry-off env, HTTPS hints, transport pin) applied
- [ ] CI guards added for the review's locked invariants



For module layout patterns (small vs large MCPs), see [MCP_SERVER_STANDARD § Module Architecture](MCP_SERVER_STANDARD.md#2-module-architecture).
