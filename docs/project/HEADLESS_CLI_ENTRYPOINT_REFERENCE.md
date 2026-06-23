---
description: "Developer reference for Mindstone Rebel's CLI entrypoint — two-path model (Electron-backed and standalone Node binary) — commands, flags, env-vars, approval policy, and exit codes"
last_updated: "2026-05-15"
---

## Introduction

Rebel has **two CLI front doors**, both powered by the same core runtime:

| Aspect | Electron-backed CLI | Standalone Node `rebel` |
|--------|---------------------|------------------------|
| Auth | OAuth via GUI (Codex/Anthropic/OpenRouter) | Env-vars only (`REBEL_ANTHROPIC_API_KEY`, etc.) |
| Session store | Shared with GUI | Shared with GUI (locked) |
| MCP tools | Full | Full + `--no-mcp` opt-out |
| Cold start | 1–3 s | ~442 ms (target <500 ms) |
| Long sessions (`chat`) | Yes | Anthropic/OpenRouter yes; **Codex single-shot only** |
| Install | Bundled in .app | `npm i -g @mindstone/rebel-cli` |

The **Electron-backed CLI** (`npm run cli` or from inside the packaged .app) is the full-power path — shares OAuth tokens, session history, and MCP config with the GUI. Use this for scripting that needs to tap a live authenticated session.

The **standalone Node binary** is the fast cold-start path — no Electron dependency, reads the same settings and sessions, but requires env-var authentication. Ideal for CI, evals, and power users who want a lightweight `rebel` on `PATH`.

**Quick reference:** Run `rebel --help` or `rebel <command> --help` for comprehensive usage and examples.

## See also

- [`docs/plans/260515_cli_alternative_interface.md`](../plans/260515_cli_alternative_interface.md) — full implementation history (Stages 1–9) and design rationale for the two-path model.
- [`docs/plans/260330_headless_runtime_consolidation.md`](../plans/260330_headless_runtime_consolidation.md) — shared `createHeadlessRuntime()` that powers all headless surfaces.
- [REBEL_SYSTEM_CLI.md](./REBEL_SYSTEM_CLI.md) – **Different CLI**: lightweight skill-testing tool in `rebel-system/cli/` (no Electron required).
- `docs/plans/finished/251123_headless_cli_entrypoint_for_rebel.md` – original design and acceptance criteria for the headless CLI.
- `docs/plans/finished/251225_headless_cli_phase2_fixes.md` – bug fixes and improvements made in December 2024.
- `docs/project/SETUP_DEVELOPMENT_ENVIRONMENT.md` – how to configure `coreDirectory`, MCP, and provider credentials so GUI and CLI share the same settings.
- `docs/project/SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` — canonical env-var reference including new `REBEL_CLI_*` and `REBEL_*_API_KEY` variables.
- `docs/project/ARCHITECTURE_OVERVIEW.md` – main-process architecture including agent turn execution and MCP/tool-call orchestration reused by the CLI.
- `src/main/index.ts` – Electron main entrypoint where the headless CLI mode is wired into the app bootstrap (see `isHeadlessCli()` and the early CLI execution block).
- `src/main/cli.ts` – Electron-backed CLI implementation (Clipanion commands, event handling, JSON output mode).
- `src/main/startup/singleInstanceLock.ts` – single-instance lock logic that skips in CLI mode.
- `scripts/rebel-cli/main.ts` – standalone Node binary entrypoint.

## Two-path model

### Path 1 — Electron-backed CLI (full feature parity)

Runs from inside the Electron main process. Shares all GUI state.

**Development:**
```bash
npm run build
npm run cli -- <command> [options]
# or
electron out/main/index.js --headless-cli <command> [options]
```

**Packaged app:**
```bash
# macOS
"/Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel" --headless-cli <command> [options]

# Windows
"C:\Program Files\Mindstone Rebel\Mindstone Rebel.exe" --headless-cli <command> [options]

# Linux
"/opt/Mindstone Rebel/mindstone-rebel" --headless-cli <command> [options]
```

Auth comes from the GUI's OAuth flows. Settings are read from the same `app-settings.json` the GUI owns.

### Path 2 — Standalone Node `rebel` binary (fast, env-var auth)

Boots without Electron. Requires `REBEL_ANTHROPIC_API_KEY` or equivalent env-var.

**Install:**
```bash
npm i -g @mindstone/rebel-cli
```

**Usage:**
```bash
rebel <command> [options]
# or (if not on PATH yet, from a bundled .app install):
~/.local/bin/rebel <command> [options]
```

The standalone binary also ships inside the packaged .app under `Resources/rebel-cli/`. A post-install script can add it to your PATH — see `scripts/rebel-cli/` for setup scripts per platform.

**Build locally:**
```bash
node scripts/rebel-cli/build.mjs
# runs at: node scripts/rebel-cli/dist/rebel.js
```

**Environment:**
```bash
export REBEL_ANTHROPIC_API_KEY=sk-ant-...      # required for Anthropic provider
export REBEL_OPENROUTER_API_KEY=<key>          # required for OpenRouter provider
export REBEL_CODEX_TOKEN=<token>               # required for Codex provider (short-session only)
export REBEL_USER_DATA=/path/to/data           # optional: overrides default data directory
```

The standalone binary reads the same `sessions/` and `app-settings.json` as the GUI. Codex OAuth tokens expire after ~1 hour — for long interactive sessions with Codex, use the Electron-backed CLI instead.

## Commands

Run `rebel --help` for the full command list, or `rebel <command> --help` for detailed options.

### Core commands

| Command | Description |
|---------|-------------|
| `smoke-test` | Fast process-start probe only; use `run -p` or the Electron-backed `smoke-test` for agent health |
| `run` | Run a single agent turn and exit (for scripting and CI) |
| `chat` | Interactive multi-turn REPL session |
| `mcp-server` | Run Rebel as an MCP server for external tools (Cursor, Claude Desktop, etc.) |

### Session commands

| Command | Description |
|---------|-------------|
| `sessions list` | List all sessions (GUI-created and CLI-created), sorted by last updated |
| `sessions show <id>` | Print a session transcript |
| `sessions tail <id>` | Follow new events in a session (1 s poll; stops on SIGINT/SIGTERM) |

Session IDs in filenames are hashed (`sha256`) — filenames never expose raw session IDs. The session store is shared between GUI and CLI; both can read and write concurrently (file locks prevent corruption).

## Shared options

- `--json` – emit newline-delimited JSON (NDJSON) events instead of human-readable output. Recommended for automation and AI integrations.
- `-h, --help` – show help for the CLI or a specific command.
- `--no-mcp` – skip Super-MCP startup (faster cold start for non-tool turns). Available on both Electron-backed and standalone CLIs. `mcp-server` mode ignores this flag.

### Per-turn flags (`run`, `chat`)

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | The turn prompt |
| `--session <id>` | Resume an existing session (CLI or GUI-created). Alias: `--session-id` (deprecated, emits stderr warning) |
| `--reset` | Start a fresh conversation in the session |
| `--model <id>` | Override the working model |
| `--thinking <id>` | Override the thinking model |
| `--no-thinking` | Disable thinking model |
| `--working-profile <id>` | Override the working profile |
| `--thinking-profile <id>` | Override the thinking profile |
| `--effort <low\|medium\|high\|xhigh>` | Reasoning effort level |
| `--council` | Enable council mode |
| `--unleashed` | Enable unleashed (higher autonomy) mode |
| `--private` | Force cautious safety for this turn |
| `--provider <anthropic\|openrouter\|codex>` | Override the active provider. **Note:** `codex` in the standalone CLI is single-shot only — for Codex long sessions, use the Electron-backed CLI. |
| `--attach <path>` | Attach a file (image, PDF, document, text file — repeatable). Validated against type-specific size caps before reading. |
| `--profile` | Output timing and cache metrics after the turn |
| `--bypass-safety` | Disables tool-safety, memory-write, and auto-continue safety hooks for this invocation. Equivalent to `REBEL_CLI_BYPASS_SAFETY=1`; CLI flag takes precedence. Emits a mandatory danger banner on stderr every invocation. Use only for trusted automations. |
| `--approval-timeout <ms>` | Timeout for interactive approval prompts. Equivalent to `REBEL_CLI_APPROVAL_TIMEOUT_MS=<ms>`; CLI flag takes precedence. |
| `--no-mcp` | Skip Super-MCP startup (faster; no MCP tools available) |

## Environment variables

| Variable | Applies to | Description |
|----------|-----------|-------------|
| `REBEL_CLI_BYPASS_SAFETY=1` | Both CLI paths | Disables all safety hooks (tool safety, memory-write, auto-continue). **Dangerous.** Emits a mandatory stderr banner. |
| `REBEL_CLI_APPROVAL_TIMEOUT_MS=<ms>` | Both CLI paths | Timeout for interactive approval prompts (default: 60,000 ms). Non-TTY invocations ignore this. |
| `REBEL_OPERATOR_IDENTITY=<name>;<mandate>` | Both CLI paths | Operator identity for automations. Format: `name;free-form-mandate`. Semicolon-separated; name must not contain `;`. |
| `REBEL_SUPER_MCP_BIN=<path>` | Both CLI paths | Override Super-MCP binary path. Resolution order: env-var → bundled path → `npx super-mcp-router@<pinned-version>` fallback. |
| `REBEL_ANTHROPIC_API_KEY=<key>` | Standalone only | Anthropic API key (required for standalone CLI with `anthropic` provider). |
| `REBEL_OPENROUTER_API_KEY=<key>` | Standalone only | OpenRouter API key (required for standalone CLI with `openrouter` provider). |
| `REBEL_CODEX_TOKEN=<token>` | Standalone only | Codex bearer token (required for standalone CLI with `codex` provider). **Short-session only.** |
| `REBEL_USER_DATA=<path>` | Both CLI paths | Override the user data directory (default: platform convention, e.g. `~/Library/Application Support/mindstone-rebel/` on macOS). Both CLI paths and the GUI must use the same path to share sessions and settings. |
| `REBEL_SURFACE=cli-standalone` | Standalone binary | Set automatically; guards against loading desktop-only token storage modules. |
| `REBEL_HEADLESS=1` | Both CLI paths | Set automatically by the CLI bootstrap. |
| `REBEL_HEADLESS_CLI=1` | Electron-backed CLI | Set automatically; used to detect headless mode. |

For `run` and `chat`, safety-control precedence is: **CLI flag > env-var > default**. In practice, `--bypass-safety` overrides the absence or non-enabling value of `REBEL_CLI_BYPASS_SAFETY`, and `--approval-timeout=<ms>` overrides `REBEL_CLI_APPROVAL_TIMEOUT_MS` for that process.

## Approval policy

When a turn requires tool-safety or memory-write approval:

- **TTY-attached interactive CLI** — the CLI pauses assistant output, prints `[approval] <action> — allow? (y/N): ` to stderr, reads from stdin. On `y` or Enter, proceeds. On `n`, timeout, or non-TTY stdin, the turn ends with exit code `2`. Abort signal (Ctrl+C) wins immediately — pending approval denies, lock files release.
- **Non-TTY (piped, CI, automation)** — the CLI auto-denies. Turn ends. Exit code `2`.
- **`--json` mode** — never prompts even on TTY. Emits a structured `approval_required` NDJSON event and auto-denies. Use `REBEL_CLI_BYPASS_SAFETY=1` for non-interactive trusted automations.
- **`--bypass-safety` / `REBEL_CLI_BYPASS_SAFETY=1`** — auto-approves all hooks. Emits the danger banner on stderr and a `safety_bypass_active` structured event in `--json` mode. **Use only for trusted automations behind a firewall.**

### `mcp-server` notes

The `mcp-server` command auto-approves all tool safety via the `REBEL_MCP_SERVER_MODE=1` mechanism — this is separate from the interactive approval policy above. For setup instructions, see `docs/project/EXPOSING_REBEL_AS_MCP_TOOL_FOR_EXTERNAL_CLIENTS.md`.

## Output formats

### Human-readable mode (default)

- Status, tool, and progress events → `stderr`:
  - `[status] …` — high-level progress updates.
  - `[tool:start]` / `[tool:end]` — tool call boundaries.
  - `[usage] …` — token and cost summary when available.
  - `[approval] …` — interactive approval prompt (TTY only).
- Assistant and result text → `stdout`.

### JSON mode (`--json`)

Emits newline-delimited JSON (NDJSON) events on `stdout`. Recommended for CI and scripted integrations.

```jsonc
{ "turnId": "…", "type": "status", "timestamp": 1234567890, "event": { … } }
{ "turnId": "…", "type": "assistant", "timestamp": 1234567891, "event": { … } }
{ "turnId": "…", "type": "approval_required", "timestamp": 1234567892, "event": { … } }
{ "turnId": "…", "type": "result", "timestamp": 1234567893, "event": { … } }
```

### Profiling (`--profile`)

Outputs timing and cache metrics after the turn completes.

**Human-readable:**
```
[profile] TTFT: 1234ms | Total: 5678ms | Cache hit: 85.2%
[profile] First event: 89ms | In: 12345 | Out: 234
[profile] Model: claude-sonnet-4-20250514
```

**JSON** (`--profile --json`): Adds a `profile` NDJSON event with full metrics.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (turn completed; session saved) |
| `1` | General error (auth missing, settings invalid, tool error — see stderr message) |
| `2` | Validation / policy error (approval denied, timeout, invalid flag) |
| `3` | Session contention — another process is writing this session store. Retry after the other process finishes. |

## Configuration and prerequisites

### Electron-backed CLI

Shares the GUI's settings via `electron-store` in the main process. Before first use:

- Open the GUI, set `coreDirectory` (workspace path).
- Configure at least one provider auth (Anthropic, OpenRouter, or ChatGPT Pro / Codex).

If `coreDirectory` or provider auth is missing, `smoke-test` and `run` exit early with exit code `1` and a clear message.

### Standalone CLI

Requires env-vars for auth. Recommended: set in your shell profile or CI secret store:

```bash
export REBEL_ANTHROPIC_API_KEY=sk-ant-...
export REBEL_USER_DATA=~/Library/Application\ Support/mindstone-rebel/  # must match GUI's path
```

The standalone `smoke-test` exits before settings or auth validation. For `run` and `chat`, if `coreDirectory` is not set in settings and the workspace cannot be determined, the command exits with code `1`.

## Non-blocking behaviour and cleanup

Both CLI paths run with **minimal initialization** and terminate promptly after non-interactive commands complete:

- The Electron-backed CLI uses `createHeadlessRuntime()` (shared with eval and cloud surfaces) and cleans up in order: abort turns → drain → stop Super-MCP → close file index → stop model proxy.
- The standalone CLI adds SIGINT/SIGTERM handlers that release session locks and call `runtime.cleanup()`.
- Exit codes are reliable and safe to consume from CI or external scripts.

The `chat` command is interactive and keeps the process running until you exit the REPL (`exit` / Ctrl+D / Ctrl+C).

## Sessions and concurrency

The session store (`sessions/index.json` + `sessions/<hash>.json`) is shared between GUI, Electron-backed CLI, and standalone CLI. File locks prevent corruption:

- **Per-session lock** (`sessions-locks/<hash>.lock`) — protects same-session write contention.
- **Global index lock** (`sessions-locks/index.lock`) — protects `index.json` during cross-session updates.
- **Optimistic concurrency** — before writing, the CLI re-reads the session's `updatedAt`. If another process advanced it, the CLI fails with exit code `3` and a structured error describing what changed. No silent overwrite.
- **Cross-process lock contention** — if another process (typically the desktop GUI) is mid-write and still holds the per-session or global index lock, the CLI waits up to a bounded budget (5 s) before giving up. On timeout it exits `3` with a structured `session_persist_contention` error (NDJSON event under `--json`) rather than a raw stack — retryable, the same exit code as optimistic-concurrency contention. The 5 s budget comfortably covers normal holds (~400–600 ms; longer on cloud-synced userData such as Google Drive) without risking a long block.

CLI-created sessions appear in the GUI sidebar on next GUI reload. Live cross-process update (CLI session appears in GUI without restart) is not yet supported.

## Troubleshooting

- **`Core directory is not configured.`** — Open the GUI, set a default workspace directory, and retry.
- **`Authentication is missing.`** — For standalone CLI: set `REBEL_ANTHROPIC_API_KEY` (or `REBEL_OPENROUTER_API_KEY` / `REBEL_CODEX_TOKEN`). For Electron-backed CLI: authenticate via the GUI.
- **`Provider not configured.`** — `--provider codex` requires valid `REBEL_CODEX_TOKEN` in standalone mode, or Codex OAuth connected in the GUI. For long Codex sessions, use the Electron-backed CLI.
- **`Session contention (exit 3).`** — Another process (GUI or CLI) is writing this session store (it advanced the session, or still holds a session/index lock). Wait and retry.
- **`CLI appears to hang in automation.`** — Use standalone `smoke-test` for a process-start probe, or `run` for an agent-runtime check (not `chat`). Ensure you are invoking the correct CLI path (Electron-backed via `--headless-cli` or standalone `rebel` binary).
- **MCP-related errors** — Confirm MCP config path and servers as described in `MCP_ARCHITECTURE.md`. Use `--no-mcp` to skip MCP startup if tools are not needed.
- **`--json is not supported with chat`** — The `chat` command doesn't support JSON mode because readline prompts would corrupt NDJSON output. Use `run` for structured agent output, or standalone `smoke-test` only for a process-start probe.
- **`Smoke test failed: no meaningful content produced.`** — The agent completed without errors but produced an empty response. Check that MCP tools and workspace access are working correctly.
- **`Unable to read platform instructions at .../rebel-system/AGENTS.md`** — In development mode, the rebel-system submodule must be initialized: `git submodule update --init --recursive`. In production builds this file is bundled automatically.
- **`Store is not a constructor` or similar ESM/CJS errors** — The Electron-backed CLI uses electron-store (ESM-only). Ensure the build config bundles it (see `electron.vite.config.ts`).
- **`MCP server is not enabled.`** — Open Rebel, go to Settings → Connectors, and enable "Allow external MCP access".
- **CLI uses different settings than GUI (dev mode)** — When running via `electron out/main/index.js`, Electron uses a generic app name and reads from `~/Library/Application Support/Electron/` instead of the Rebel path. This is auto-fixed by `ensureAppIdentity.ts` — verify it is imported first in `index.ts` if you see auth failures.
- **`Super-MCP CLI not found` or path resolution errors** — The CLI checks: `REBEL_SUPER_MCP_BIN` env-var → bundled path → `npx super-mcp-router@<pinned-version>`. Ensure submodules are initialized with `git submodule update --init --recursive`.
