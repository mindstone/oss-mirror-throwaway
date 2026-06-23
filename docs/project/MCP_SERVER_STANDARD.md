---
description: "Technical standards for building and migrating MCP servers — SDK patterns, module architecture, error handling, security, distribution, and the mandatory pre-publish security review for OSS connectors"
last_updated: "2026-05-01"
---

# MCP Server Standard

**How** to build and migrate MCP servers -- SDK patterns, module architecture, error handling, security, packaging, and migration sequencing. For **when/why/what order** (process), see [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md). For how changes **propagate to users**, see [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md). For boundary-drift protection during MCP changes, see [BOUNDARY_REGISTRY](BOUNDARY_REGISTRY.md).

Derived from the Zendesk connector migration (SDK ^1.0.0 → ^1.26.0, 2,982-line monolith → 12 modules) and validated against the official MCP Filesystem reference server.

## See Also

- [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) -- 6-phase workflow, policies, checklists
- [MCP_UPDATE_PROPAGATION](MCP_UPDATE_PROPAGATION.md) -- Caching, version reconciliation, propagation to users
- [MCP_SDK_REFERENCE](../research/libraries/MCP_SDK_REFERENCE.md) -- Protocol fundamentals, transport mechanisms
- [mcp_best_practices](../../rebel-system/skills/coding/build-custom-mcp-server/references/mcp_best_practices.md) -- Tool naming, descriptions, pagination, response formats
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md) -- **STOP: Read before externalizing any OAuth connector.** Auth modes, security requirements, per-provider capability matrix, cache invalidation, token persistence
- [MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE](MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE.md) -- **STOP: Read before changing connector auth, token refresh, reconnect handling, or token health checks.** Covers token ownership, refresh classes, failure handling, and per-connector risk notes
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) -- **STOP: Mandatory pre-publish security review** for every `rebel-oss` connector (OAuth or not). Required before first publish AND every catalog version bump. Defines reviewers, artifacts, blocking conditions, and sign-off record

---

## 1. SDK Construction Standard

### Use McpServer + registerTool + Zod

All new MCP servers and migrations **must** use the high-level `McpServer` class with `registerTool()` and Zod schemas. The low-level `Server` + `setRequestHandler()` pattern is legacy.

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'my-mcp-server', version: '0.2.0' });

server.registerTool(
  'search_items',
  {
    description: 'Search items by query...',
    inputSchema: {
      query: z.string().describe('Search query'),
      limit: z.number().optional().describe('Max results (default: 20)'),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await doSearch(args.query, args.limit);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);
```

**Why Zod over raw JSON Schema:**
- Type-safe argument destructuring in callbacks (no `args as Record<string, unknown>`)
- `.describe()` on each field replaces the separate `description` in JSON Schema
- SDK handles Zod-to-JSON-Schema conversion for the wire protocol
- Consistent with the official reference servers

### Tool Annotations Required on All Tools

Every tool must declare annotations. Use this mapping:

| Tool behaviour | readOnlyHint | destructiveHint |
|---|---|---|
| Read-only (GET, search, list, export) | `true` | omit |
| Creates new resources (POST) | `false` | `false` |
| Mutates/deletes existing resources (PUT, DELETE) | `false` | `true` |

Optional but recommended: `idempotentHint: true` for PUT operations that are truly idempotent, `openWorldHint: true` for tools that interact with external APIs.

---

## Parameter & Tool Naming Standard

This section is Rebel's Section 1b house style for names exposed to models. It is aligned with Anthropic guidance to use unambiguous, service-prefixed tool names. Anthropic does not mandate a specific casing, but their examples are heavily snake_case and that is the prevailing MCP ecosystem convention, so Rebel standardises on snake_case for tool names and all top-level input parameters.

### Tool names

- Use snake_case.
- Service prefix is required.
- Use `{service}_{action}_{resource}` when naming tools.
- Keep names specific enough to stand alone in a multi-MCP tool list.

### Top-level parameter names

- All top-level input parameters must be snake_case.
- Use one canonical name per concept across tools within the same MCP.
- Descriptions, examples, and error/help text must use the canonical snake_case parameter names.

### Canonical concept names

| Concept | Canonical name | Notes |
|---|---|---|
| Max results | `limit` | Use for maximum results. Do not alternate between `count`, `maxResults`, `max_results`, or `maxMessages` for the same concept. |
| Pagination token | `page_token` / `cursor` | Use whichever the upstream API already uses, then keep it consistent within that MCP. |
| JSON toggle | `return_json` | Boolean that switches between JSON and markdown output. |
| Resource identifiers | `message_id`, `thread_id`, `event_id`, `file_id`, `document_id`, `spreadsheet_id`, `presentation_id`, `form_id`, `recording_id` | Always use snake_case `{thing}_id` names. |

### Exceptions

- Nested objects that intentionally mirror an upstream API structure may keep upstream casing inside the nested object, for example `start.dateTime` or `options.pageSize`.
- Slack timestamp parameters `ts`, `thread_ts`, and `timestamp` are deliberately named per FOX-2595 anti-hallucination work. Do not standardise them to a different house-style name.
- Response field names are not covered by this standard. This section applies to tool input parameters only.

### Backwards compatibility when renaming params

- When a parameter is renamed, the MCP handler must accept both the legacy name and the new canonical snake_case name.
- If the MCP performs validation before the handler runs (for example Google Workspace), add a boundary normaliser that rewrites legacy names before validation.
- If both old and new names are supplied, the snake_case name wins.

### New tool naming review

Before shipping a new MCP tool, verify:

- [ ] All top-level parameters are snake_case
- [ ] Repeated concepts use the canonical names from the table above
- [ ] Descriptions and examples use snake_case parameter names

---

## 2. Module Architecture

### When to Split

Split any MCP server exceeding ~500 lines of source. Below that, a single file is fine.

### Standard Module Layout

```
src/
├── types.ts          # Interfaces, constants, ZendeskError, assertValidSubdomain()
├── auth.ts           # Mutable state (accounts), loadAccounts(), getAccount(), token refresh
├── client.ts         # API fetch wrapper, retry logic, pagination helpers, noAccountError()
├── formatters.ts     # Response formatting functions
├── bridge.ts         # Host bridge communication (if applicable)
├── utils.ts          # resolveTempOutputPath(), withErrorHandling()
├── tools/
│   ├── index.ts      # Re-exports all registration functions
│   ├── accounts.ts   # registerAccountTools(server)
│   ├── tickets.ts    # registerTicketTools(server)
│   ├── users.ts      # registerUserTools(server)
│   ├── comments.ts   # registerCommentTools(server)
│   ├── discovery.ts  # registerDiscoveryTools(server)
│   └── macros.ts     # registerMacroTools(server)
├── server.ts         # createServer(): creates McpServer, registers all tools
└── index.ts          # Entrypoint: shebang, import server, connect transport, start
```

### Dependency Layering (Acyclic)

```
types.ts  ←  no imports
   ↑
auth.ts   ←  imports types
   ↑
client.ts ←  imports types, auth
   ↑
bridge.ts ←  imports types, auth
   ↑
formatters.ts ← imports types
   ↑
utils.ts  ←  imports types (and SDK types for CallToolResult)
   ↑
tools/*   ←  imports from all the above (leaf nodes)
   ↑
server.ts ←  imports tools/*
   ↑
index.ts  ←  imports server
```

**Rules:**
- Tool modules are leaf nodes -- they import from shared modules but never from each other
- Never import from `tools/*` into `auth.ts`, `client.ts`, or other shared modules
- Use direct imports, not dependency injection -- matches the reference server pattern and is simpler

### Mutable State Encapsulation

State that changes at runtime (e.g., authenticated accounts, cached tokens) must be owned by a single module and exposed through accessor/mutator functions:

```typescript
// auth.ts — OWNS the state
let accounts: Map<string, Account> = new Map();

export function getAccount(subdomain?: string): Account | undefined { ... }
export function removeAccount(subdomain: string): void { ... }
export function loadAccounts(): void { ... }
```

Tool modules call `getAccount()` -- they never touch the Map directly.

---

## 3. Error Handling

### withErrorHandling Wrapper

Every `registerTool` callback should be wrapped with a shared error handler that:
1. Catches exceptions and converts them to MCP-compatible responses
2. Preserves the structured error format: `{ ok: false, error, code, resolution }`
3. Prevents unhandled exceptions from crashing the server process

```typescript
// utils.ts
export function withErrorHandling<T>(
  fn: (args: T, extra: unknown) => Promise<string>
): (args: T, extra: unknown) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      const result = await fn(args, extra);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      if (error instanceof ServiceError) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: error.message,
              code: error.code,
              resolution: error.resolution,
            }),
          }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(error) }) }],
      };
    }
  };
}
```

### Error Sanitisation

- **Log full error** (stack traces, response bodies) to `stderr` for debugging
- **Return sanitised message** to the LLM -- never leak API keys, internal URLs, or raw error bodies
- Use domain-specific error classes (e.g., `ZendeskError`) with `code` + `resolution` fields for actionable guidance

---

## 4. Security Baseline

### File Permissions

| What | Permission | Why |
|---|---|---|
| Credential files (tokens, accounts.json) | `0o600` | Owner read/write only |
| Credential directories | `0o700` | Owner access only |
| Temp export files | `0o600` | Prevent other users reading exported data |

**Why this matters:** Without explicit `mode`, Node.js `fs.writeFile` inherits the process umask (typically `0o644` = world-readable). On shared workstations or compromised machines, any local process can read OAuth refresh tokens and gain persistent access to the user's accounts (Gmail, Calendar, HubSpot CRM, etc.). This is a real attack vector, not theoretical.

**Enforcement:** Every `fs.writeFile` / `fs.writeFileSync` call that writes credentials, tokens, or account configuration MUST include `{ mode: 0o600 }`. Every `fs.mkdir` that creates a credential directory MUST include `{ mode: 0o700 }`. This applies on all platforms -- the mode is silently ignored on Windows (which uses ACLs), so the parameter is always safe to include.

**Important:** The `mode` parameter in `fs.writeFile` only applies when creating a NEW file. If the file already exists (e.g., from a previous version without this fix), the old permissions are preserved. You MUST call `fs.chmod` after every credential write to fix existing files:

```typescript
// CORRECT — credential file with restrictive permissions + chmod for existing files
await fs.writeFile(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
await fs.chmod(tokenPath, 0o600);
await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });

// WRONG — inherits umask, typically 0o644 (world-readable)
await fs.writeFile(tokenPath, JSON.stringify(tokenData, null, 2));
await fs.mkdir(credentialsDir, { recursive: true });

// ALSO WRONG — mode only applies on creation, existing files stay 0o644
await fs.writeFile(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
// Missing chmod — existing files not fixed!
```

**Atomic writes for crash safety:** Token files should use write-to-temp + rename to prevent corruption if the process crashes mid-write. A crash during a non-atomic write can corrupt the token file, forcing the user to re-authenticate:

```typescript
async function writeCredentialFile(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, data, { mode: 0o600 });
  await fs.rename(tmpPath, filePath); // atomic on same volume
}
```

> **Vendored helper + equivalence gate.** The canonical implementation lives in `src/core/utils/atomicCredentialWrite.ts` (host) and is vendored byte-for-byte (modulo import paths + a `// vendored from` header) into each OSS connector's `mcp-servers/connectors/google-workspace/src/utils/atomicCredentialWrite.ts`. `npm run validate:atomic-helper-equivalence` (`scripts/check-atomic-helper-equivalence.ts`, run in `validate:fast`) discovers every vendored copy via the `mcp-servers` submodule and fails if any drifts or if the submodule path rots; CI sets `REQUIRE_MCP_OSS_EQUIVALENCE=1` to make a missing submodule a hard fail rather than a skip. **When this helper must change, edit the host copy and re-vendor to all OSS copies in the same change — never hand-edit a single OSS copy independently** (that is exactly the drift the gate blocks).

### Input Validation

- **Subdomain/tenant validation:** Regex-check user-supplied identifiers before using them in URLs. Example: `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i`
- **Path traversal prevention:** Confine file writes to a safe directory (e.g., `os.tmpdir()`):
  ```typescript
  function resolveTempOutputPath(outputPath: string): string {
    const resolved = path.resolve(outputPath);
    if (!resolved.startsWith(path.resolve(os.tmpdir()))) {
      throw new Error('output_path must be within the temp directory');
    }
    return resolved;
  }
  ```
- **Request timeouts:** Always set `AbortSignal.timeout()` on outbound requests. Default: 30 seconds.

### Auth Header Abstraction

Never expose tokens or API keys in tool responses. Wrap credentials in a `getAuthHeader(account)` function so tool modules never handle raw secrets. For Rebel-level auth flow decisions (OAuth vs API key vs bridge), see [MCP_CONNECTOR_WORKFLOW § Authentication Patterns](MCP_CONNECTOR_WORKFLOW.md#mcp-authentication-patterns).

### OAuth Callback Server Hardening

MCP servers with OAuth callback servers (standalone/direct mode) MUST implement these security controls:

| Requirement | Implementation |
|------------|---------------|
| **Bind to loopback only** | `server.listen(port, '127.0.0.1', ...)` — never bind to all interfaces |
| **CSRF state parameter** | Generate `crypto.randomBytes(32).toString('hex')`, include in auth URL, validate on callback |
| **XSS prevention** | `escapeHtml()` for HTML contexts, `JSON.stringify()` for inline JS contexts |
| **Content-Type validation** | Reject `/complete-auth` POSTs without `application/json` Content-Type |
| **Security headers** | All responses: `Cache-Control: no-store`, `Referrer-Policy: no-referrer` |
| **Origin check** | Verify Origin header is localhost/127.0.0.1 or absent on POST endpoints |

State validation pattern: validate (check existence) on GET callback, consume (check + delete) on POST `/complete-auth` before processing the auth code. See `docs/plans/260409_oauth_callback_hardening.md` for the full design rationale and `super-mcp/src/auth/callbackServer.ts` for the reference implementation.

---

## 5. Packaging & Distribution

### ESM-Only + npx

All new MCP servers use ESM output with `tsc`, targeting npx as primary distribution:

```json
{
  "name": "@scope/mcp-server-service",
  "version": "0.2.0",
  "type": "module",
  "bin": { "mcp-server-service": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc && shx chmod +x dist/index.js",
    "prepare": "npm run build",
    "watch": "tsc --watch",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22",
    "shx": "^0.3.4",
    "typescript": "^5.8.2"
  },
  "engines": { "node": ">=18" }
}
```

### Shebang Preservation

The entrypoint (`src/index.ts`) must start with `#!/usr/bin/env node`. TypeScript 5.5+ preserves shebangs in compiled output. Verify after build:

```bash
head -1 dist/index.js  # Should show: #!/usr/bin/env node
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Host Configuration Examples

```json
// npx (once published)
{ "command": "npx", "args": ["-y", "@scope/mcp-server-service@0.2.0"] }

// Local development
{ "command": "node", "args": ["/path/to/dist/index.js"] }
```

### Registry Submission (server.json)

Every OSS connector ships a `server.json` registry manifest alongside `package.json` so it can be discovered through the [official MCP Registry](https://registry.modelcontextprotocol.io). The `_template/` connector in `mcp-servers` carries a working `server.json` with placeholders — new connectors inherit it automatically. CI enforces correctness via `.github/workflows/server-json-check.yml`.

**Required fields and constraints:**

| Field | Rule |
|---|---|
| `$schema` | Pin to `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` |
| `name` | Reverse-DNS: `io.github.mindstone/mcp-server-<connector>` (uses GitHub OIDC namespace) |
| `version` and `packages[0].version` | Both must equal `package.json.version` exactly |
| `packages[0].identifier` | Must equal `package.json.name` (e.g. `@mindstone-engineering/mcp-server-<connector>`) |
| `packages[0].environmentVariables[]` | Declare every required and optional env var the connector reads, with `isRequired` + `isSecret` flags. **Exclude bridge-only env vars** (`MCP_HOST_BRIDGE_STATE`, `MINDSTONE_REBEL_BRIDGE_STATE`) — those are Rebel-internal plumbing, not user inputs |
| `_meta.io.modelcontextprotocol.registry/publisher-provided.com.mindstone.rebel` | `{ catalogId, provider }` for round-trip identity with the Rebel app's `connector-catalog.json` |

**Companion field in `package.json`:**

```json
{
  "name": "@mindstone-engineering/mcp-server-service",
  "version": "0.2.0",
  "mcpName": "io.github.mindstone/mcp-server-service",
  ...
}
```

`mcpName` MUST equal `server.json.name`. The registry reads it from the published npm metadata to verify ownership. If you forget it, `mcp-publisher publish` fails ownership verification — but only against the **already-published** npm version, so always add `mcpName` BEFORE bumping and publishing the npm version, never after.

**Validation:**

```bash
brew install mcp-publisher  # one-time install (Linux: download from GitHub releases)
cd connectors/<name>
mcp-publisher validate server.json
```

CI runs the same `validate` plus cross-file consistency on every PR. See [server.json best practice spec](https://modelcontextprotocol.io/registry/generic-server-json) for the full schema reference.

**Backfill for existing connectors:** generate `server.json` by hand using the pattern above (Gamma is the worked example; see `mcp-servers/connectors/gamma/server.json`). Bump `mcpName` into `package.json` at the same time. Both ship together in the next routine version bump — do not republish a previous npm version just to add `mcpName`.

**Publishing to the live registry:** is automated via [`scripts/publish-mcp-to-registry.sh`](../../scripts/publish-mcp-to-registry.sh) (per-connector) and [`scripts/publish-mcp-to-registry-bulk.sh`](../../scripts/publish-mcp-to-registry-bulk.sh) (backfill / drift correction). Both wrap `mcp-publisher` with the preflight checks (`validate`, `npm view ... mcpName`, deprecated-check) and idempotency handling. Canonical usage and recovery flows live in [MCP_OSS_PACKAGE_MANUAL_UPDATE.md Phase F step 29](MCP_OSS_PACKAGE_MANUAL_UPDATE.md#phase-f--publish-to-npm-wave-lead-only). Do not call `mcp-publisher publish` by hand — the scripts encode the gates that protect against partial / mismatched / deprecated registrations.

---

## 6. Migration Sequencing

When upgrading an existing MCP server, follow this order to ensure each stage compiles independently:

### Stage 0: Upgrade SDK + Install Dependencies
Upgrade `@modelcontextprotocol/sdk` and add `zod` in `package.json`. Run `npm install`. Do NOT change code yet.

**Why first:** Stages 1-3 import `McpServer` and `zod` which don't exist in the old SDK. Without this, intermediate stages fail to compile.

### Stage 1: Extract Modules
Split the monolith into `types.ts`, `auth.ts`, `client.ts`, `formatters.ts`, `bridge.ts`, `utils.ts`. Update the original `index.ts` to import from these modules.

### Stage 2: Create Tool Registration Files
Convert each tool from raw JSON Schema + switch/case to `registerTool()` + Zod + `withErrorHandling()`. Group by domain (tickets, users, comments, etc.).

### Stage 3: Create Server + Entrypoint
`server.ts` creates `McpServer` and calls all registration functions. `index.ts` becomes a thin entrypoint.

### Stage 4: Update Build Pipeline
Change `outDir` to `dist`, add `bin`/`files`/`prepare` fields, delete old build scripts (esbuild, etc.).

### Stage 5: Documentation + LICENSE
Update README, add LICENSE, update host config examples.

### Stage 6: Verify
Clean build, shebang check, tool count verification, real API smoke test.

### Compile Gate Rule
After each stage, the project must compile with `npm run build`. If it doesn't, the staging order is wrong.

---

## 7. Pre-Merge Checklist

Before completing any MCP server work:

- [ ] Uses `McpServer` + `registerTool()` + Zod (not legacy `Server`)
- [ ] All tools have `annotations` (readOnlyHint and destructiveHint at minimum)
- [ ] Error responses follow `{ ok: false, error, code, resolution }` via `withErrorHandling()`
- [ ] Credential files written with explicit `{ mode: 0o600 }` — never rely on umask
- [ ] Credential directories created with explicit `{ mode: 0o700 }`
- [ ] Token writes use atomic pattern (write-to-temp + rename) for crash safety
- [ ] Auth/token lifecycle changes follow [MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE](MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE.md): token owner, refresh mechanism, failure classification, concurrency, and reconnect path are documented and tested
- [ ] No secrets, tokens, or internal URLs in tool responses
- [ ] No token values or refresh tokens in log output (stderr)
- [ ] Input validation on user-supplied identifiers (subdomain, paths, IDs)
- [ ] Request timeouts set on all outbound HTTP calls
- [ ] ESM-only output with `bin` field and shebang preserved
- [ ] `npm run build` succeeds from clean state
- [ ] All tool names match the original (zero breaking changes for existing consumers)
- [ ] Smoke test: `node dist/index.js` starts and responds to `initialize` + `tools/list`

### OSS readiness (for connectors published to npm)
- [ ] **Mandatory Pre-Publish Security Review completed with a validating Release Gate block** per [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) — review record committed to `docs-private/reports/security-reviews/<yyMMdd>_<connector>_<version>.md` with agent-authored findings, a cross-family adversarial pass (verdict `UPHELD` or `UPHELD-WITH-ADDENDA`), all blocking conditions cleared, and `Release-Authorized-By` recorded. This applies to first publish AND every catalog version bump.
- [ ] No internal references in source/test code (run the grep check below)
- [ ] No bridge pattern code (`bridge.ts`, `MINDSTONE_REBEL_BRIDGE_STATE`, localhost bridge calls)
- [ ] Error messages and resolution hints are host-neutral
- [ ] User-Agent strings use connector name, not host app branding
- [ ] Host/domain inputs validated before credential transmission (see Host/Domain Validation above)
- [ ] LICENSE file present with full license text
- [ ] README.md present with setup, tool reference, and security disclosures
- [ ] Mock credentials in tests do not resemble real key patterns (avoid `sk_`, `key_real_`, etc.)
- [ ] No internal environment variables (e.g., REBEL_WORKSPACE_PATH, MINDSTONE_REBEL_BRIDGE_STATE)
- [ ] `npm audit` clean — no Critical or High vulnerabilities
- [ ] No hardcoded secrets anywhere in source or test fixtures
- [ ] **`server.json` present** alongside `package.json` and validates clean via `mcp-publisher validate server.json` (see [Registry Submission](#registry-submission-serverjson) above) — bridge-only env vars must be excluded
- [ ] **`mcpName` field in `package.json`** equals `server.json.name` exactly (registry uses it to verify namespace ownership against the live npm metadata)

## OSS Readiness

> **STOP — Mandatory Pre-Publish Security Review.** The technical requirements below are the *substance* a reviewer verifies; they are not a self-attestation gate. Before any `rebel-oss` connector is published to npm or pinned in `resources/connector-catalog.json` — first publish AND every version bump — the full pre-publish security review per [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES § 13 Mandatory Pre-Publish Security Review](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md#13-mandatory-pre-publish-security-review) MUST complete with a validating Release Gate block. § 13 defines the AI-only review model (agent-authored review + mandatory cross-family adversarial pass + `Release-Authorized-By` authorization), required artifacts (threat model, callback-server tests, permission audit, atomic-write evidence, internal-reference scan, secrets scan, `npm audit`, SBOM, full reviewer findings), blocking conditions, and the sign-off record format. The OSS-readiness rules in this section and in [MCP_CONNECTOR_WORKFLOW § Critical: OSS Connector Security](MCP_CONNECTOR_WORKFLOW.md#critical-oss-connector-security) are inputs to that review, not substitutes for it.

### Host/Domain Validation Patterns

When a connector accepts user-supplied hostnames or subdomains that will be used in URL construction:

- MUST validate against a strict pattern before interpolating into URLs
- MUST validate before sending any credentials to the constructed URL
- Subdomain pattern example: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` (rejects slashes, `@`, `?`, etc.)
- Full hostname pattern: allowlist of known vendor domains (e.g. `*.workday.com`, `*.freshdesk.com`)

```typescript
// utils.ts — shared hostname validation
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

export function validateSubdomain(input: string, serviceName: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!SUBDOMAIN_PATTERN.test(trimmed)) {
    throw new ServiceError(
      'INVALID_SUBDOMAIN',
      `Invalid ${serviceName} subdomain: must contain only letters, numbers, and hyphens`,
      `Check your ${serviceName} subdomain and try again`
    );
  }
  return trimmed;
}

export function validateServiceHost(host: string, allowedPattern: RegExp, serviceName: string): string {
  const trimmed = host.trim().toLowerCase();
  if (!allowedPattern.test(trimmed)) {
    throw new ServiceError(
      'INVALID_HOST',
      `Invalid ${serviceName} host: must match ${allowedPattern}`,
      `Verify the ${serviceName} hostname and try again`
    );
  }
  return trimmed;
}
```

**Why this matters:** Without validation, attackers can craft hostnames that redirect API requests (with credentials in `Authorization` headers) to attacker-controlled servers.

### Internal Reference Stripping (OSS connectors)

Connectors published as open-source packages must not contain internal references:

| What to check | Allowed | Not allowed |
|---|---|---|
| Error messages | "Reconnect in your MCP host's settings" | "Reconnect in Mindstone Settings > Integrations" |
| User-Agent | "mcp-server-zendesk/0.2.0" | "rebel-app/1.0 (Zendesk-MCP)" |
| Environment variables | Service-specific (`ZENDESK_API_TOKEN`) | `REBEL_WORKSPACE_PATH`, `MINDSTONE_REBEL_BRIDGE_STATE` |
| Bridge code | Not present | `src/bridge.ts`, localhost bridge calls |
| Package metadata | `@mindstone-engineering` scope (intentional) | Internal repo URLs if not public |

Pre-publish grep check:

```bash
# Run from connector root — should return zero matches (excluding LICENSE, package.json author/scope)
rg -i 'mindstone|rebel|nspr' --glob '!LICENSE' --glob '!package.json' --glob '!node_modules' src/ test/
```

### Error Message Neutrality

All user-facing error messages and resolution hints must be host-neutral:

- Do NOT reference specific app names ("Mindstone", "Rebel", "Claude Desktop")
- Use generic MCP host language: "your MCP host", "the host application", "your connector settings"
- Example: `resolution: "Reconnect this connector in your MCP host's settings"`

### Workspace Path Propagation (OSS connectors)

OSS connectors that need a filesystem workspace (e.g. to save generated files under the user's workspace rather than the packaged app bundle) should read `process.env.MCP_WORKSPACE_PATH`. Do **not** read `REBEL_WORKSPACE_PATH` — that is an internal host-specific name and is excluded by the OSS readiness check.

Propagation contract on the Rebel host:

- `super-mcp`'s stdio router (`super-mcp/src/clients/stdioClient.ts` `connect()`) is the authoritative source of `MCP_WORKSPACE_PATH` on the subprocess boundary **when the host supplies a workspace**. It reads the workspace from its own parent env (accepting either `REBEL_WORKSPACE_PATH` or `MCP_WORKSPACE_PATH` for migration transparency) and exports it as `MCP_WORKSPACE_PATH` only to each spawned OSS connector.
- If the host has no workspace available (both parent env vars unset or empty), the router does not inject anything, and a catalog-supplied `MCP_WORKSPACE_PATH` (rare) would pass through unchanged. This is the degraded-but-observable state — the `workspace: 'unset'` INFO log flags it.
- If the host has a workspace AND a connector-catalog entry also sets `MCP_WORKSPACE_PATH`, the router value wins (router-over-catalog), with an observable warn log when the two differ.
- Rebel-branded bundled connectors that set `REBEL_WORKSPACE_PATH` in their catalog env continue to receive it unchanged — the router does not touch that key. OSS connectors must not rely on that behavior.
- If no workspace is available (both parent env vars unset or empty), the router propagates nothing; connectors should fall back to their documented default (typically a per-connector temp dir), not to the bundled `.app` directory.

Connectors should treat `MCP_WORKSPACE_PATH` as advisory input, always validated before use (absolute path, directory exists, writable) — never interpolated directly into filesystem operations without sanitization.

---

## Appendix: Connector Migration Status

| Connector | Auth Type | SDK Version | McpServer | Naming (snake_case) | Status |
|---|---|---|---|---|---|
| **Zendesk** | API token | ^1.26.0 | Yes | Yes | **Migrated** |
| Freshdesk | API key | ^1.0.0 | No | Not audited | Pending |
| **Fathom** | API key | ^1.0.0 | No | **Yes (FOX-3025)** | SDK pending |
| PandaDoc | API key | ^1.0.0 | No | Not audited | Pending |
| **Slack** | OAuth | ^1.0.0 | No | **Yes (FOX-3025)** | SDK pending |
| HubSpot | OAuth | ^1.0.0 | No | Not audited | Pending |
| **Google Workspace** | OAuth | ^0.7.0 | No | **Yes (FOX-3025)** | SDK pending |
| Microsoft 365 (5 MCPs) | OAuth | ^1.0.0 | No | Not audited | Blocked (microsoft-shared dep) |
| Salesforce | OAuth | ^1.0.0 | No | Not audited | Pending |

**Naming column:** Indicates whether the connector's parameters follow the [Parameter & Tool Naming Standard](#parameter--tool-naming-standard). Connectors marked "Yes (FOX-3025)" have been audited and standardised with backwards-compatible camelCase aliases. Google Workspace uses a boundary normaliser (`param-normalizer.ts`) that converts legacy names before type-guard validation. Future SDK migrations should include a naming audit as part of the migration checklist.

**Migration order:** API-key connectors first (simplest), then OAuth connectors, Microsoft 365 last (requires publishing microsoft-shared as npm package first). For OAuth connector migration principles (auth modes, security hardening, per-provider rules), see [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md).

---

## Maintenance

Update this doc when:
- SDK patterns change (new `registerTool` API, new annotation types)
- New security requirements emerge
- Distribution patterns evolve (e.g., if we adopt a different bundler)
- A connector migration reveals new patterns worth encoding
