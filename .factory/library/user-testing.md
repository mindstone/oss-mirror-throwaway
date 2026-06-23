# User Testing

## Validation Surface

This is a CLI/packaging migration mission. No browser UI testing is needed. All validation is via shell commands.

### Surface: Shell / CLI
- **What to test**: npm package builds, npx installation/startup, tool registration, test suites, security audits, rebel-app validation
- **Tool**: Shell commands (npm, npx, grep/rg, node)
- **Setup needed**: npm ci in relevant directories
- **Auth/bootstrap**: npm auth already configured globally

### Surfaces NOT applicable:
- Browser (no UI changes)
- Electron app (no need to launch the full app)
- API endpoints (no running services)

## Validation Concurrency

**Max concurrent validators: 5**

Rationale: Each validator runs lightweight shell commands (npm test, grep, npx). No services to start, no browsers to launch. On 48GB RAM / 14 CPU cores, 5 concurrent validators use negligible resources (~50MB each for node processes).

## Testing Tools

- `npx -y @mindstone-engineering/mcp-server-<name>@<version>` -- verify package installation and startup
- `npm test` / `npm run build` / `npm audit` -- in connector directories
- `npm run validate:fast` / `npm run test` -- in rebel-app
- `rg` (ripgrep) -- for security audit grep checks
- `node -e "..."` -- for quick JS verification scripts

## Known Validation Quirks

- For live Retell smoke checks, `RETELL_API_KEY` is stored under `mcpServers` in `$HOME/Library/Application Support/mindstone-rebel/mcp/super-mcp-router.json` (not the older top-level JSON shape).
- Security greps for `mindstone|rebel|nspr` can include benign metadata matches; confirm prohibited patterns with targeted checks for `/bundled/` endpoints and secret-like literals before failing assertions.
- For browser-automation package checks, MCP stdio clients that spawn with `command: "npx"` can fail in some environments (`sh: mcp-server-browser-automation: command not found`) even when direct shell `npx -y @mindstone-engineering/mcp-server-browser-automation@<version>` works; prefer direct shell startup or install the package into an isolated sandbox and spawn `dist/index.js`.
- Browser-automation fallback evidence can show `agent-browser` fallback invocation via `npx -y agent-browser@0.17` while still returning a structured error payload in constrained PATH environments (e.g., `Unknown command: --headless`); this confirms fallback attempt and actionable error handling.
- For outreach package checks, MCP stdio child-process spawning through `npx`/`npm exec` may intermittently fail (`command not found`) despite the package being valid; use an isolated clean-install sandbox and run `node dist/index.js` for deterministic `tools/list` and annotation validation.
- Outreach cleanup grep checks may still find `connectorType: "bundled"` in `src/main/services/outreachAuthService.ts`; treat it as a non-runtime analytics label unless runtime bundled helper/path checks also fail.
- In some shell contexts, direct Node imports of `@mindstone-engineering/mcp-test-harness` can fail due to unresolved TS-linked `.js` module paths; for deterministic outreach CLI validation, use direct MCP SDK `Client` + `InMemoryTransport` against compiled `dist/server.js`.
- For packed-artifact audit checks, `npm install <tarball>` can run `prepare` and fail when `tsc` is unavailable; use an isolated audit sandbox with `npm install --ignore-scripts --package-lock-only <tarball>` followed by `npm audit --audit-level=high`.

## Flow Validator Guidance: shell-cli

- Stay within assigned assertion IDs and only test shell/CLI behavior.
- Use absolute paths and keep all writes limited to:
  - `.factory/validation/<milestone>/user-testing/flows/<group-id>.json`
  - `{missionDir}/evidence/<milestone>/<group-id>/`
- Do not edit application source code, package manifests, or mission contract files.
- Do not run destructive git commands or any network actions beyond package/test validation commands required by assigned assertions.
- Never print secrets; for credentialed checks, pass env vars at execution time and sanitize captured evidence.
