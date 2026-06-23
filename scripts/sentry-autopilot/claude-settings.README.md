# `claude-settings.json` — Sentry Autopilot VM-specific Claude settings

Loaded by `session-supervisor.sh` via `claude --settings <path>` when
`AUTOPILOT_CLI=claude`. Resolves at supervisor start to
`AUTOPILOT_CLAUDE_SETTINGS`, defaulting to `claude-settings.json` next to the
supervisor script. Operators can override the env var to swap in a custom
settings file.

## Why it exists

The repo-root `.claude/settings.json` declares `SessionStart` /
`SessionEnd` hooks that run `python3 …/coding-agent-instructions/hooks/export_transcript.py`
to export transcripts to Google Drive. That Python script needs `rclone`
configured to a developer's personal Google Drive — the autopilot VM
(`team-cloud`) doesn't have that, so the hooks would log timeouts/errors
into every session.

Earlier versions of the supervisor used `claude --bare` to disable hooks.
But `--bare` *also* disables MCP servers, plugins, and the `Task` subagent
tool. Shadow-mode escalations diagnosed exactly this: claude could not
fetch Sentry evidence (no Sentry MCP) and could not run parallel debugger
investigations (no `Task` tool). See
`docs/plans/260606_autopilot-claude-runtime-fixes/PLAN.md` Stage 3 root-cause.

This file pins:

- `hooks: {}` — empty object suppresses the dev-only transcript-export hooks
  without touching anything else.

It deliberately does not pin `enabledPlugins`, `mcp`, or any other key — those
fall through to claude's defaults so MCP servers and the `Task` subagent tool
remain available to the bug-fixer.

## When to update this file

- A new dev-only hook lands in the repo-root `.claude/settings.json` that the
  autopilot must continue to suppress: usually no change needed (`hooks: {}`
  already wins on key-by-key merge), but verify by checking a fresh shadow run.
- The autopilot needs different MCP servers from the developer default: add
  an explicit `mcp` block here.
- Operators want a different settings file per VM environment: leave this one
  alone and override `AUTOPILOT_CLAUDE_SETTINGS` in `~/autopilot.env`.

## Verification after changes

After deploying, smoke-test by inspecting `supervisor.log` for the next
claude session and confirming the init line shows non-empty
`mcp_servers: [...]` and a `tools` array that includes `Task`. Bare-mode
runs would show `mcp_servers: []` and `tools: ["Bash","Edit","Read"]`.
