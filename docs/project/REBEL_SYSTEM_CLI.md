---
description: "Reference for the standalone Rebel System CLI — skill validation, dry runs, setup, and comparison with the headless CLI"
last_updated: "2026-01-16"
---

# Rebel System CLI

Lightweight command-line tool for testing and validating skills without the Electron app.

> **Not to be confused with** the [Headless CLI](./HEADLESS_CLI_ENTRYPOINT_REFERENCE.md), which runs the full Electron agent stack without a GUI. This CLI is a standalone script for skill development.

## Comparison

| | Headless CLI (`--headless-cli`) | Rebel System CLI (`rebel`) |
|---|---|---|
| **Location** | Electron app (`src/main/cli.ts`) | `rebel-system/cli/` |
| **Runtime** | Electron + full agent stack | Standalone Node/tsx script |
| **Purpose** | Automation, CI, MCP server | Testing/validating skills |
| **Features** | MCP tools, sessions, settings | Skills + Claude API only |
| **Setup** | Requires built/packaged app | `./setup` script (no build needed) |
| **Auth** | App settings (GUI or store) | Own API key config |

## See Also

- `rebel-system/cli/README.md` — Full usage documentation
- [HEADLESS_CLI_ENTRYPOINT_REFERENCE.md](./HEADLESS_CLI_ENTRYPOINT_REFERENCE.md) — The Electron-based headless CLI
- [SKILLS_DISCOVERY.md](./SKILLS_DISCOVERY.md) — How skills work in the app

## Quick Start

```bash
cd rebel-system/cli
./setup              # One-time: installs deps, configures API key
rebel list           # List all skills
rebel validate       # Validate skill structure/frontmatter
rebel run <skill> "message" --dry-run  # Preview prompt without API call
```

## When to Use

- **Skill development**: Iterate on skill prompts without launching Electron
- **Validation**: Check skill frontmatter and structure
- **Quick tests**: Run a skill against Claude API directly

For automation, CI pipelines, or MCP integration, use the [Headless CLI](./HEADLESS_CLI_ENTRYPOINT_REFERENCE.md) instead.
