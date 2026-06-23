# Rebel CLI

Standalone terminal entry point for Rebel.

## Install

```bash
npm install -g @mindstone/rebel-cli
```

## Authentication

The standalone CLI uses environment variables for credentials:

```bash
export REBEL_ANTHROPIC_API_KEY="..."
export REBEL_OPENROUTER_API_KEY="..."
export REBEL_CODEX_TOKEN="..."
```

It reads Rebel's normal settings and sessions from the same local user-data directory as the desktop app. Set `REBEL_USER_DATA` to point at another directory when testing.

## Commands

```bash
rebel --version
rebel smoke-test
rebel run --prompt "Draft a launch email"
rebel chat
rebel sessions list
rebel sessions show <session-id>
rebel sessions tail <session-id>
```

Useful per-turn flags include `--provider`, `--model`, `--thinking`, `--effort`, `--private`, `--council`, `--unleashed`, `--attach`, and `--no-mcp`.
