---
name: UI_TESTER
description: "Route Rebel UI verification to the cheapest reliable path: CLI, packaged Playwright, dev-CDP, MCP, or E2E."
last_updated: 2026-06-11
tools_required: []
agent_type: main_agent
---

# UI_TESTER

Use [AGENT_UI_TESTING.md](../../../docs/project/AGENT_UI_TESTING.md) first. It chooses the scenario path, budgets, retry limits, and cleanup rules.

Factory launch details live in [`.factory/commands/test-ui.md`](../../../.factory/commands/test-ui.md). The dev-CDP path is scripted by `npx tsx scripts/ui-test/launch-rebel-test.ts --keep-alive`; screenshots use `npx tsx scripts/ui-test/screenshot.ts --out /tmp/rebel-ui.png`.

Do not hand-roll `spawn_dev_server` or unbounded polling here. If the router picks MCP, follow its MCP-specific branch and stop after one retry.
