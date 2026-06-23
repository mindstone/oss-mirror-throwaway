---
description: "Process for reviewing and testing open-source MCP connector PRs submitted to mindstone/mcp-servers"
last_updated: "2026-04-28"
---

# Open-Source MCP Connector PR Review & Testing

How Mindstone staff review and test community-contributed MCP connector PRs on the [mindstone/mcp-servers](https://github.com/mindstone/mcp-servers) repository. Covers reviewer mindset, code review standards, local testing, API key handling, contributor identity, and the path from merged PR to Rebel catalog entry.

**Scope:** This document covers **Node.js / npx connectors** submitted through Rebel's in-app contribution flow. For Python/uvx connectors, see [PYTHON_RUNTIME](PYTHON_RUNTIME.md). For OAuth connector review, additionally consult [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md).

## See Also

- [MCP_CONNECTOR_CONTRIBUTION_FLOW](MCP_CONNECTOR_CONTRIBUTION_FLOW.md) -- **Contributor-side** pipeline inside Rebel (agent state reporting, store, fork + Git Data API upload, status polling, post-publish catalog swap). Read this first to understand what the PR you're reviewing came from.
- [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) -- 6-phase workflow for building/improving connectors; includes **Critical: OSS Connector Security** checklist (the canonical security review standard)
- [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) -- SDK patterns, tool naming, annotations, module architecture
- [MCP_TESTING](MCP_TESTING.md) -- Test harness, smoke tests, integration tests for bundled MCPs (incl. the legacy health-check script)
- [MCP_ARCHITECTURE](MCP_ARCHITECTURE.md) -- Runtime config, connector catalog, auth patterns, provider types
- [MCP_UPDATE_LIFECYCLE](MCP_UPDATE_LIFECYCLE.md) -- How version bumps and new tools propagate to users
- [TOOL_SAFETY](TOOL_SAFETY.md) -- How Rebel evaluates tool safety annotations at runtime
- [`build-custom-mcp-server` skill](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md) -- The skill Rebel uses to build connectors (defines the structure PRs follow)
- [`contribute-connector`](../../rebel-system/skills/coding/build-custom-mcp-server/references/contribute-connector.md) -- Contributor-side submission guide (what contributors are told to include)
- [`mcp_best_practices`](../../rebel-system/skills/coding/build-custom-mcp-server/references/mcp_best_practices.md) -- Tool naming, descriptions, pagination, response format standards


## Context

Rebel's in-app contribution flow lets users build MCP connectors and submit them as PRs to `mindstone/mcp-servers`. The flow is:

1. User asks Rebel to build a connector (triggers [`build-custom-mcp-server` skill](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md))
2. Rebel writes source to `~/mcp-servers/<connector-name>/`, builds, and tests locally
3. User clicks "Add to the community" in the MCPBuildCard UI
4. GitHub-attributed contribution submission is disabled in OSS-scrubbed builds; no dedicated contribution OAuth flow opens.
5. **We review and test the PR** (this document)
6. After merge, the connector becomes available via `npx` and can be added to the Rebel catalog

### What PRs look like

Each PR adds a `connectors/<name>/` directory with:
- `src/index.ts` -- MCP server entry point (McpServer + registerTool + Zod)
- `src/logger.ts` -- Sanitized logger (template from the build skill)
- `package.json`, `tsconfig.json`, `package-lock.json`
- `dist/` -- Pre-built JavaScript (should NOT be present; see review checklist)
- `__tests__/` -- Schema validation tests
- `.env.example` -- Documents required credentials (or states none needed)
- `README.md` -- Setup instructions, tool documentation


## Security Posture: Adversarial Review

**Read this before anything else. It governs how every section below is meant to be used.**

You are reviewing code from someone you do not know. Treat them as **potentially malicious, potentially incompetent, or both, until proven otherwise.** Good faith is not the default — it has to be earned. A merge into `mindstone/mcp-servers` puts code on a path to running on every Rebel user's machine, with whatever credentials they hand it. The blast radius of a bad merge is "every Rebel user who installs this connector," not "this PR."

### The Mindset

- **You cannot complete this review.** You can only fail to find problems. A clean review means you didn't find anything *yet* — not that the PR is safe.
- **Checklists give false comfort.** Every technical check on this page is a tool for gathering evidence, not a gate that confers safety when ticked. A bad actor will tick every box you give them. Read the code with the assumption that someone is trying to slip something past you, then go looking for it.
- **Trust your instinct.** If something feels off — pacing, scope creep, an unusual dependency, a strange git history, a commit cadence that doesn't match the contributor's stated context, an over-eager PR description — that is signal. Escalate to a second reviewer or reject. "I can't articulate why" is a sufficient reason to slow down.
- **Open-source code is publicly visible.** Anything sloppy here becomes a vulnerability anyone can exploit. The bar for OSS is higher than for internal code, not lower.

### Open-Ended Detection Prompts

Use these to drive the review. Don't tick them off — *answer them*. If you find yourself reading for keywords rather than thinking about the code, stop and start over.

- **If I wanted to backdoor this codebase via this PR, where would I hide it?** Look there first. Common hiding places: build scripts, postinstall hooks, transitive dependencies, "utility" modules, error-handling paths that exfiltrate context, plausibly-named helpers, environment-variable parsing, anything that touches the network.
- **What does this PR do that doesn't strictly need to be done to deliver the stated feature?** Why is the extra work there? Unnecessary network calls, unexpected file system access, surprising dependencies, suspiciously broad input handling — all warrant explanation.
- **Are any dependencies suspicious in their *names*?** Typosquatting (a near-miss spelling of a popular package), dependency confusion (a public package matching the name of an internal one), package names that don't match what the README claims to use, packages with very low download counts being pulled into a connector that should only need standard SDKs. Spot-check every dependency against npm — does it have a reasonable history, maintainership, and source repo?
- **Is the proposed package name itself a typosquat?** Connectors publish under `@mindstone-engineering/mcp-server-<name>`. Reject names designed to be confused with other connectors, popular packages, or other vendors' products.
- **If the contributor is competent but careless** — what would they have got wrong? (Common: shell injection via string concatenation, unbounded child-process timeouts, credential leakage in error responses, missing scheme/host validation on user-supplied URLs.)
- **If the contributor is hostile** — what would they have got *right* (to disarm me) and what would they have got *wrong* because they had to? Polished READMEs and good test coverage are easy to fake. Subtle privilege escalations, exfiltration paths, and supply-chain hooks are harder to fake without leaving traces.
- **Does the code match the description?** Does the description match what the tools actually do? Mismatch is a strong signal.
- **Does anything feel off?** Pacing, scope, dependencies, git history, commit timing, contributor's prior public history, the way the PR is written. Trust the feeling.
- **What happens if I'm wrong about this being safe?** If you can't answer "the worst case is acceptable," you haven't reviewed enough yet.

### Hard Rules

- **Any "feels wrong" signal you cannot articulate away → second reviewer or reject.** Do not merge on momentum.
- **Any contributor whose identity cannot be verified → default reject.** See [Contributor Identity & IP](#contributor-identity--ip) below.
- **Any unexplained behaviour, dependency, or scope expansion → request changes with a specific question.** "Why is this here?" is a complete review comment. The contributor explains, or the PR doesn't merge.
- **When in doubt, reject.** A rejected PR can be re-opened. A merged backdoor cannot be unmerged from users' machines.


## Evidence Gathering (formerly: Code Review Checklist)

The tables below are **tools for gathering evidence under the mindset above** — not a sequence to step through and tick. Read them with the prompts in [Security Posture](#security-posture-adversarial-review) actively in mind. A clean table does not mean the PR is safe; it means you didn't find anything *in these specific places*. Always also read the code without the table in front of you, because the table only catches what's already been seen before. Novel attacks, by definition, are not on this list.

Review against [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) and the standards below.

> **OSS Security baseline:** Run through the full **Critical: OSS Connector Security** checklist in [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) — it is the canonical technical-checks reference and covers internal-reference stripping, bridge-pattern prohibition, host/domain validation, LICENSE file, `npm audit`, and test-fixture hygiene. The tables below supplement (not replace) that list with reviewer-specific items, all under the adversarial framing above.

### Critical (block merge)

| Check | What to look for | Reference |
|-------|-----------------|-----------|
| **Security: no secrets in code** | No hardcoded API keys, tokens, or credentials anywhere in source, dist, or test files. No fake keys that resemble real ones (e.g., `sk_live_...`) in test fixtures | -- |
| **Security: no shell injection** | `spawn()` uses `{ shell: false }` and argv arrays, never string concatenation. Example: `spawn("cmd", [arg1, arg2])` is safe; `spawn("cmd " + userInput, { shell: true })` is not | [MCP_SERVER_STANDARD § Security](MCP_SERVER_STANDARD.md) |
| **Security: command injection via args** | Tool arguments passed to `spawn()` or `exec()` must be sanitized or used as array elements only | -- |
| **Security: no SSRF surface** | Base URLs must come from env vars or constants, never from tool input parameters. Tools accepting user-provided URLs must validate scheme and host | [`contribute-connector`](../../rebel-system/skills/coding/build-custom-mcp-server/references/contribute-connector.md) |
| **Security: no credential leakage in responses** | Error messages must not echo API keys, auth headers, or request bodies back to the model | -- |
| **Security: internal reference scan** | `grep -ri 'mindstone\|rebel\|nspr' src/ __tests__/` -- no internal references should appear in OSS code | [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) |
| **Tool annotations accuracy** | `readOnlyHint`, `destructiveHint` must reflect actual behavior. A tool that can delete data must not have `destructiveHint: false` | [MCP_SERVER_STANDARD § Tool Annotations](MCP_SERVER_STANDARD.md) |
| **No dist/ committed** | Build artifacts should not be in the PR. `.gitignore` should exclude `dist/` and the CI/user should build from source | -- |
| **License compatibility** | Dependencies must be MIT, Apache 2.0, BSD, or ISC compatible. Check nested deps with `npx license-checker --summary` | -- |
| **No malicious install scripts** | Review `package.json` `"scripts"` section for `preinstall`, `postinstall`, `prepare` hooks before running `npm install` | -- |

### Important (request changes)

| Check | What to look for | Reference |
|-------|-----------------|-----------|
| **SDK construction** | Uses `McpServer` + `registerTool()` + Zod schemas (not legacy `Server` + `setRequestHandler`) | [MCP_SERVER_STANDARD § SDK Construction](MCP_SERVER_STANDARD.md) |
| **Tool naming** | `{service}_{action}_{resource}` snake_case pattern | [MCP_SERVER_STANDARD § Parameter & Tool Naming](MCP_SERVER_STANDARD.md) |
| **Error handling** | Tools return `{ isError: true, content: [...] }` on failure, not thrown exceptions. Unconfigured credentials return a helpful error, not a crash | [MCP_TESTING](MCP_TESTING.md) |
| **Tests test real code** | Tests import from source (not re-create schemas inline). Schema-only tests are insufficient; at minimum test the actual Zod schemas used in the server | -- |
| **Logger sanitization** | Connector uses the template sanitizing logger (`src/logger.ts`), not raw `console.log` or unsanitized `pino`. Debug-level logging must not include request bodies or credentials | -- |
| **No unnecessary dependencies** | Check `package.json` for bloat. MCP servers should be lean. Run `npm audit` -- no Critical/High vulnerabilities | -- |
| **Env var documentation** | `.env.example` accurately lists all required and optional env vars with descriptions | -- |
| **Process timeout** | Spawned child processes (if any) must have timeouts to prevent indefinite hangs | -- |
| **HTTPS for API calls** | All outbound HTTP requests must use HTTPS, not plaintext HTTP | -- |

### Nice-to-have (suggest, don't block)

| Check | What to look for |
|-------|-----------------|
| Tool descriptions include examples, caveats, and related tool references |
| `idempotentHint` and `openWorldHint` annotations set where appropriate |
| Response format follows `{ok: boolean, data: ...}` pattern for consistency |
| README includes Rebel-specific setup instructions (command, args format) |
| `docs/build-plan.md` included with research notes and approach reasoning |


## Contributor Identity & IP

Code review tells you whether the *code* is safe. This section tells you whether the *contributor* should be trusted to merge code into a repo whose output runs on Rebel users' machines.

### Identity Verification

Before approving any merge, the reviewer must answer "yes" to all of these — using judgment, not a tickbox:

- **Is the GitHub account real?** Look at: account age, prior public commit history, prior PRs (to this repo or others), any organisation membership, whether the email on commits is GitHub-verified. Brand-new accounts with no prior activity who happen to land a polished MCP connector PR are a coordinated-attack pattern. Treat with extreme caution.
- **Does the commit history make sense?** Sudden bursts of activity, commits at unusual hours, multiple co-located accounts converging on similar PRs, history that looks AI-generated or automated — all warrant a closer look and probably a question to the contributor.
- **Does the contributor exist beyond this PR?** A real human (or accountable team) with a public footprint is a much smaller risk than a one-shot pseudonym. Concrete acceptable signals (any one is a positive; none is a negative): established multi-year GitHub activity with a coherent project trail, verified affiliation with a known organisation (employer, OSS project, university), a recognisable identity in the broader OSS or security community, prior interaction with our team or the maintainer, a personal site / blog / professional profile that matches the GitHub identity.
- **Are there unresolved red flags?** Throwaway-style usernames, mismatched names across commits, unverified email addresses, claims in the PR description that don't match the GitHub profile, evasive answers to questions about identity, AI-flavoured PR descriptions with no human voice behind them — escalate.

If any of those answers is "no" or "unclear," default to reject and ask the contributor to clarify before re-review.

### Anonymous & Pseudonymous PRs

**Open question. Current default: reject.**

We have not yet decided whether anonymous or pseudonymous contributions are acceptable for `mindstone/mcp-servers`. Until that policy is finalised, the reviewer should reject PRs from contributors whose identity cannot be reasonably verified, with a polite note explaining that we currently require verifiable identity for the OSS connector repo and pointing them at the option to re-submit under a verifiable account or wait until our policy formalises.

If a reviewer wants to make an exception (e.g., the contributor is well-known under a pseudonym, like in some open-source security communities), they must:

1. Get a second reviewer's sign-off explicitly.
2. Add a PR comment recording why the exception was made.
3. Apply heightened scrutiny everywhere else in the review.

This will be revisited as part of the Phase 2 work referenced below.

### Inbound Licence Posture

This is **not** a formal IP-transfer or ownership-assignment process. It is a lightweight working posture for the current phase, pending the Phase 2 decision below. Treat it as the rules of thumb the reviewer applies right now — not a legally vetted policy.

**Current working assumption** (intentionally lightweight; do not add UI or process here yet):

- The repo is published under a permissive licence (`FSL-1.1-MIT` or similar — check `LICENSE` at the repo root).
- Contributors submit PRs through GitHub against that licence using their authenticated GitHub account. GitHub's standard inbound-licence behaviour for public repos is that opening a PR offers the contribution under the repo's licence, which we are relying on as the working basis for now. This matches the posture most permissive-licence OSS repos take and is the assumption the reviewer is operating under until Phase 2 lands.
- The in-app Rebel contribution flow only fires after the user authenticates with GitHub (`public_repo` scope) and consciously clicks "Add to the community," which adds an additional layer of explicit consent specifically for contributions originating from the in-app path.

**Reviewer responsibility right now:** Verify the contributor used their own GitHub account, that the PR is being submitted against the live licence in the repo, and that there are no claims in the PR (e.g., "this is proprietary code I'm releasing under MIT") that contradict that posture.

If something looks irregular — claims of corporate ownership, contributors mixing employer and personal accounts, prior code from other repos being copied wholesale, contradictions between the PR description and what the code actually contains, anything that suggests the contributor may not have the right to grant the inbound licence — **block merge, do not request changes as if it were a normal review issue, and escalate to the repo owner / product decision-maker for legal sign-off before proceeding.** This is not a "ask the contributor and move on" situation.

**Phase 2 (decision landed 2026-06-16):** Inbound licensing is formalised as **DCO sign-off** (`Signed-off-by` per commit, `git commit -s`) **plus a one-line inbound sublicensing grant** in `CONTRIBUTING.md` — **not** a CLA. See [`docs-private/ops/260616_oss_license_framework_decision.md`](../../docs-private/ops/260616_oss_license_framework_decision.md). Rollout note: enforcement tooling (a DCO sign-off check; optionally firming the grant into `CONTRIBUTOR_TERMS.md`) is a tracked fast-follow; the back-port gate's CLA re-verification needs the matching DCO rework (see [OSS_BACKPORT_RUNBOOK.md](OSS_BACKPORT_RUNBOOK.md) banner).


## Local Testing Process

### Reviewer Machine Safety

> **You are running untrusted community code on your machine.** Take precautions:

- **Review `package.json` scripts BEFORE `npm install`**: Check for `preinstall`, `postinstall`, and `prepare` hooks that could execute arbitrary code during install.
- **Use `npm install --ignore-scripts`** for the initial install, then review any build scripts before running them manually.
- **Consider a clean Rebel profile**: When registering the connector in Rebel for Step 4, your Rebel instance has access to all your connected services (Gmail, Slack, etc.). Disconnect sensitive connectors first, or test in a separate user account.
- **Prefer a sandbox environment** for connectors that spawn child processes, accept user-provided hostnames, or make outbound network calls.

### Prerequisites

- macOS, Windows, or Linux (depending on connector -- some are platform-specific)
- Node.js 18+
- `gh` CLI installed (`gh --version`)
- A local clone of `mindstone/mcp-servers` (first time: `gh repo clone mindstone/mcp-servers`)
- API key for the service (if the connector requires one -- check `.env.example`)

### Step 1: Checkout the PR

```bash
cd /path/to/mcp-servers
gh pr checkout <PR_NUMBER>
cd connectors/<connector-name>
```

### Step 2: Review and install

```bash
# Review package.json scripts FIRST
cat package.json | grep -A5 '"scripts"'

# Safe install (skips postinstall hooks)
npm install --ignore-scripts

# Then build (after reviewing the build script)
npm run build
```

Verify the build succeeds without errors. Check that `dist/index.js` is produced.

### Step 3: Standalone smoke test (no Rebel needed)

**Preferred: Use the MCP Inspector** for interactive testing:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

This opens a local web UI where you can list tools, fill in arguments, and execute tool calls interactively. Much more practical than raw JSON-RPC.

**Alternative: Raw JSON-RPC** (for quick headless check):

```bash
# List tools -- should return tool definitions
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

For connectors that need env vars:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | API_KEY=test-key node dist/index.js
```

Verify:
- Server starts without crashing
- `tools/list` returns the expected tools with names, descriptions, and input schemas
- Tool annotations are present and accurate

### Step 4: Test in Rebel (integration test)

1. Open Rebel
2. Go to **Settings -> Connectors -> Advanced**
3. Add a custom MCP server with a stdio config pointing to the built connector:
   - **Command:** `node`
   - **Args:** `/full/path/to/connectors/<connector-name>/dist/index.js`
   - **Env vars:** Add any required API keys from `.env.example`
4. Start a conversation and exercise each tool:
   - Test the "list" / read-only tools first
   - Test tools with optional parameters (omitted and provided)
   - Test error cases (invalid inputs, missing required fields)
   - For write tools: test in a sandbox/test account if possible

### Step 5: Verify tool safety annotations in Rebel

With the connector registered in Rebel, observe how the safety system treats each tool (see [TOOL_SAFETY](TOOL_SAFETY.md) for how Rebel evaluates annotations):
- Read-only tools (`readOnlyHint: true`) should auto-approve
- Destructive tools should trigger the approval prompt
- If annotations are wrong, this is a **critical** review finding

### Step 6: Clean up

Remove the custom MCP server from Settings -> Connectors -> Advanced when done testing.


## Handling API Keys

### Connectors that don't need keys

Some connectors use local system tools (e.g., macOS `shortcuts` CLI, filesystem access). These need no API key and can be fully tested by any reviewer on the right platform. Check `.env.example` for confirmation.

### Connectors that need keys

For connectors requiring API credentials:

1. **Check if the service has a free tier or sandbox.** Many services (Notion, Linear, Slack, etc.) offer free developer accounts. Create a test account specifically for PR review.

2. **Use test/sandbox API keys only.** Never use production credentials for PR review. If the service has a sandbox mode, use it.

3. **Test the unconfigured path.** Before adding any credentials, verify the server handles missing credentials gracefully (helpful error message, not a crash).

4. **If no free tier exists**, the reviewer should:
   - Review the code thoroughly (all checks above)
   - Test startup and tool listing (no key needed for MCP protocol)
   - Test the unconfigured error path
   - Note in the PR review that integration testing was not possible and why
   - Request the contributor provide evidence of successful tool calls (screenshots, logs)

### Env var naming conventions

Env vars in contributed connectors should follow the pattern: `<SERVICE>_API_KEY`, `<SERVICE>_TOKEN`, or `<SERVICE>_SECRET`. Check that the var names in `.env.example` match what the code actually reads from `process.env`.


## Common Issues in Contributed PRs

These patterns recur in community contributions. Check for them explicitly:

| Issue | Example | Fix |
|-------|---------|-----|
| **dist/ committed despite .gitignore** | `.gitignore` has `dist/` but dist files are in the PR | Remove dist files; CI or user builds from source |
| **Tests re-create schemas** | Tests define their own Zod schemas instead of importing from source | Tests must import and validate the actual schemas |
| **Wrong --input-path usage** | `shortcuts run --input-path "raw text"` (flag expects a file path) | Write to temp file or use stdin piping |
| **Missing timeout on child processes** | `spawn()` with no timeout; hanging process blocks MCP server | Add `{ timeout: 30000 }` or manual timer with `proc.kill()` |
| **Misleading safety annotations** | `destructiveHint: false` on a tool that can send emails or delete resources | Annotations must reflect worst-case behavior of the tool |
| **Hardcoded paths in README** | README says `/Users/you/mcp-servers/...` | Use `~/mcp-servers/...` or generic placeholder paths |
| **Internal references leaked** | Source contains `mindstone`, `rebel`, or `nspr` strings | Must be stripped for OSS -- these are internal identifiers |
| **Credential leakage in errors** | Error response includes `Authorization: Bearer sk-...` | Error messages must never echo credentials or request headers |
| **package-lock.json bloat** | 1000+ lines of lockfile | Expected for npm; verify it matches `package.json` dependencies |


## After Merge: Path to Rebel Catalog

Once a PR is merged, the connector is available via `npx` from the `mindstone/mcp-servers` monorepo. To make it available as a 1-click connector in Rebel:

1. **Add a catalog entry** to `resources/connector-catalog.json` -- see [MCP_ARCHITECTURE → Connector Catalog](MCP_ARCHITECTURE.md#connector-catalog) for the field reference
2. **Set the provider type** to `rebel-oss` (not `community` -- `contributionSwapService.ts` requires `rebel-oss` to auto-swap local builds for the catalog version)
3. **Add a `tools` array** with `{ name, description }` for each tool -- this powers tool awareness and search (see [TOOL_AWARENESS](TOOL_AWARENESS.md)). Use `npx tsx scripts/harvest-mcp-tools.ts` to auto-populate if available
4. **Add `setupFields`** if the connector requires API keys -- see [MCP_ARCHITECTURE → Authentication Patterns](MCP_ARCHITECTURE.md#authentication-patterns)
5. **Set `accountIdentity`** if the connector supports multiple accounts (`'email'`, `'workspace'`, or `'none'`) -- see [MCP_ARCHITECTURE → Multi-Instance Support](MCP_ARCHITECTURE.md#multi-instance-support)
6. **Ship in an app update** -- the catalog entry propagates via startup migration (`reconcileNpxPackageVersions()`) as described in [MCP_UPDATE_LIFECYCLE](MCP_UPDATE_LIFECYCLE.md)

The `contributionSwapService.ts` handles the transition automatically for users who built the connector locally: on app startup, it detects that the connector is now in the catalog (matching on `provider: 'rebel-oss'`) and silently swaps their local custom MCP config for the catalog (npx) version.


## Future: Automation Opportunities

Areas where this manual process could be automated:

| Area | Current | Future |
|------|---------|--------|
| **PR code review** | Manual checklist above | CI linter: no dist/, no secrets/fake keys, no internal refs (`mindstone`/`rebel`/`nspr`), no bridge patterns, LICENSE exists, `npm audit` clean |
| **Smoke test in CI** | Manual MCP Inspector / raw JSON-RPC | GitHub Actions workflow: `npm install && npm run build && mcp-smoke-test` using `scripts/mcp-test-harness.ts` adapted for external connectors |
| **Integration test** | Manual in Rebel | Headless test using `scripts/mcp-test-harness.ts` with `runMcpIntegrationSuite()` declarative config |
| **Catalog entry creation** | Manual JSON editing | Script that generates a catalog entry from a connector's `package.json` + `tools/list` output — see [`docs/plans/260424_catalog_sync_automation.md`](../plans/260424_catalog_sync_automation.md) for the full design (cross-repo GitHub Action that bumps version, tags for npm publish, and opens a catalog PR into `rebel-app`) |
| **Safety annotation validation** | Manual observation in Rebel | Static analysis: check `destructiveHint`/`readOnlyHint` against tool implementation patterns (spawn calls, HTTP methods) |
| **Logger sanitization check** | Manual code review | AST check that `src/logger.ts` uses the template redaction patterns |
| **Identity verification & IP transfer** | Manual reviewer judgment + de facto coverage via GitHub PR + repo licence | **Decided 2026-06-16: DCO sign-off (`git commit -s`) + the one-line inbound grant in `CONTRIBUTING.md`** (no CLA). Remaining: a DCO sign-off enforcement check + a written policy on anonymous/pseudonymous PRs (currently default-reject). |


## Code References

| File | Purpose |
|------|---------|
| `src/core/services/contributionStore.ts` | Stores contribution state (draft → testing → ready_to_submit → published) |
| `src/main/services/contributionSwapService.ts` | Swaps local configs for catalog entries after publish |
| `src/main/services/contributionStartupSweep.ts` | Detects stuck contributions on startup, promotes if evidence found |
| `resources/connector-catalog.json` | Source of truth for managed connector versions and metadata |
| `scripts/mcp-test-harness.ts` | Shared test harness (could be adapted for external connector CI) |
| `rebel-system/skills/coding/build-custom-mcp-server/SKILL.md` | The skill that generates connector PRs |


## Maintenance

Update this doc when:
- The `mindstone/mcp-servers` repo structure changes
- CI automation is added for PR validation
- The contribution submission flow changes
- New review criteria are discovered from PR patterns — especially novel attack patterns or "feels wrong" signals that turned out to be real
- The identity & IP-transfer enforcement tooling lands (a DCO sign-off check for the decided DCO + one-line-grant model — see line 175); this doc must be updated when that tooling ships
- The anonymous/pseudonymous PR policy is decided
