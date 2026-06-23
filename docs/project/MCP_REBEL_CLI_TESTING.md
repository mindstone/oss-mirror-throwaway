---
description: "How to use Rebel's headless CLI for live MCP and connector test runs against a real Rebel instance."
last_updated: "2026-05-29"
---

# MCP Rebel CLI Testing

Use this when you need a live post-change test against MCP tools and connectors configured in a real Rebel instance. The most common use case is a read-only connector smoke test: verify that Rebel can discover connector tools through Super-MCP and execute lightweight calls with the user's existing connector auth.

This complements, but does not replace, the automated MCP harness in [MCP_TESTING](./MCP_TESTING.md). The harness is better for repeatable CI and package-level assertions. The CLI test path is better for "does this work in my actual Rebel app right now?"

## See Also

- [HEADLESS_CLI_ENTRYPOINT_REFERENCE](./HEADLESS_CLI_ENTRYPOINT_REFERENCE.md) -- Electron-backed and standalone CLI entrypoints, flags, approval policy, auth, and JSON output.
- [MCP_TESTING](./MCP_TESTING.md) -- bundle smoke tests, declarative integration suites, and MCP test harness architecture.
- [MCP_ARCHITECTURE](./MCP_ARCHITECTURE.md) -- MCP config resolution and Super-MCP routing.
- `src/main/index.ts` -- Electron-backed headless CLI wiring via `--headless-cli`.
- `src/core/cli/runCli.ts` -- CLI command implementation and NDJSON event output.

## When To Use

Use this flow after connector changes when:

- The connector needs real OAuth/API auth that is already present in your Rebel app.
- You want to verify end-to-end routing through the same Rebel runtime the desktop app uses.
- You need a broad, human-readable pass/fail report across whatever connectors are actually connected.

Do not use this as the only gate for package changes. Add or update deterministic tests in the MCP harness when response shape, schema, auth handling, pagination, or error behavior changes.

## CLI Choice

Prefer the Electron-backed CLI for live MCP/connector tests because it shares the desktop app's OAuth tokens, settings, sessions, and MCP config.

Packaged app example:

```bash
"/Applications/Mindstone Rebel Beta.app/Contents/MacOS/Mindstone Rebel Beta" \
  --headless-cli run \
  --json \
  --approval-timeout 600000 \
  --session connector-read-smoke-$(date +%y%m%d-%H%M) \
  --reset \
  --prompt "$(cat /tmp/rebel-connector-test-prompt.txt)"
```

Development build example:

```bash
npm run build
npm run cli -- run \
  --json \
  --approval-timeout 600000 \
  --session connector-read-smoke-$(date +%y%m%d-%H%M) \
  --reset \
  --prompt "$(cat /tmp/rebel-connector-test-prompt.txt)"
```

The standalone Node CLI can work, but it needs env-var provider auth (`REBEL_ANTHROPIC_API_KEY`, `REBEL_OPENROUTER_API_KEY`, or short-lived `REBEL_CODEX_TOKEN`). If the standalone CLI says auth is missing, switch to the Electron-backed app CLI rather than copying secrets around.

## Reusable Prompt

Write the prompt to a file so shell quoting does not become the test.

```bash
cat > /tmp/rebel-connector-test-prompt.txt <<'EOF'
Run a read-only integration smoke test for the requested Rebel connectors.

Requested connectors:
- Notion
- Linear
- Google Workspace

Rules:
- Use read/list/search/fetch tools only.
- Do not call create, update, delete, send, move, comment, draft, upload, invite, or mutation tools.
- First discover which matching packages are actually connected in this Rebel instance.
- If a requested connector is not connected, unavailable, or has no safe read tool, report that clearly and move on.
- For each connected matching package, call one lightweight read-only tool:
  - Prefer account/profile/self/list tools over content-heavy search.
  - Prefer low limits such as 1 or a metadata-only call.
  - Use max_output_chars where available.
- Do not reveal private content.
- Report only: connector/package, exact tool used, success status, and minimal metadata such as object counts, object types, or high-level error.
EOF
```

For a connector-specific regression, replace the "Requested connectors" list with the package or connector under test. Keep the "not connected" rule: the user running the test may not have your exact connector installed.

## What This Looks Like

A recent live probe used the packaged Beta app CLI and asked Rebel to test Notion, Linear, and Google Workspace. Rebel attached the Super-MCP router, discovered package IDs, and ran only read-only calls:

- Notion packages were present in the catalog but unavailable: `Package ... is not connected`.
- Linear `Linear-mindstone__list_issues` succeeded with `limit: 1`.
- Google Workspace `list_workspace_calendars` succeeded for each connected Google account, returning calendar object counts.

The useful part is not those specific connectors. The useful pattern is:

1. Discover package IDs and safe read-only tools at runtime.
2. Treat missing or unauthenticated packages as a valid test result, not a script failure.
3. Execute one low-impact read call per connected package.
4. Summarize without private content.

## Reading Results

Use `--json` for auditability. The CLI writes newline-delimited JSON events. The final `result` event contains the assistant's summary; `tool` events show exactly which tools ran.

Quick extraction:

```bash
LOG=/tmp/rebel-connector-test.ndjson

"/Applications/Mindstone Rebel Beta.app/Contents/MacOS/Mindstone Rebel Beta" \
  --headless-cli run --json --approval-timeout 600000 \
  --session connector-read-smoke-$(date +%y%m%d-%H%M) \
  --reset \
  --prompt "$(cat /tmp/rebel-connector-test-prompt.txt)" \
  > "$LOG"

# Final assistant result
jq -r 'select(.type == "result") | .event.text' "$LOG"

# Tool calls that actually executed
jq -r 'select(.type == "tool") | [.event.toolName, .event.stage, (.event.isError // false)] | @tsv' "$LOG"
```

If `jq` is unavailable, inspect the log directly and search for `"type":"result"` and `"type":"tool"`.

## Safety Notes

- Keep the prompt explicit about read-only tools. Do not rely on the model to infer "smoke test" means read-only.
- Do not use `--bypass-safety` for broad connector probes unless the test environment is isolated and trusted.
- Avoid write-like "setup" helpers even when they look harmless (`create_draft`, `create_comment`, `upload`, `invite`, `move`, `send`).
- If a tool materializes output into `.rebel/tool-outputs/`, do not commit it. These files can contain private connector data and `.rebel/` is gitignored for that reason.
- If the packaged app is older than the current user-data epoch, use the matching Beta/current app or a fresh dev build. Older apps may enter read-only version-gate mode.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `Authentication is missing` | Standalone CLI has no provider env-var auth | Use the Electron-backed app CLI, or set the documented standalone env vars. |
| Connector package is unavailable | Connector is not connected in this Rebel instance, OAuth expired, or Super-MCP has not restarted since setup | Treat as a smoke-test result; reconnect in Settings -> Connectors if you need to test that connector. |
| Tool list does not include expected tools | Wrong app build, stale connector package, or different user's connector config | Confirm the app version, package ID, and connector setup before treating it as a regression. |
| CLI asks for approval | The selected operation is not obviously read-only or safety needs confirmation | Approve only if the tool and args are read-only. Otherwise deny and revise the prompt. |
| CLI process lingers after result | Cleanup is waiting on background runtime resources | Confirm the `result` event was emitted; if needed, terminate the finished CLI process and check for leftover `--headless-cli` processes. |
