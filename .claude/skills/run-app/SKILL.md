---
name: run-app
description: Route Rebel app verification to the cheapest reliable path, then launch, drive, or screenshot the Electron app when the selected recipe requires it.
---

# Run the Rebel app

> **Heads-up — launching uses your REAL `userData`.** The dev/packaged app reads and writes `~/Library/Application Support/mindstone-rebel` (your real conversations), shared with your installed app. Launching a build whose `DATA_SCHEMA_EPOCH` differs from your installed app (a worktree, a `dev`-branch dev server, or a beta build) can flip the store read-only and risk your real data — this is what caused the 2026-06-16 session-index-collapse (folders looked empty). Prefer an epoch-matching build, or point app data at a throwaway dir. See [`GIT_WORKTREES.md` § epoch mismatch / read-only mode](../../../docs/project/GIT_WORKTREES.md#sign-in-failed-please-try-again-after-switching-worktrees).

Start with the router: [`docs/project/AGENT_UI_TESTING.md`](../../../docs/project/AGENT_UI_TESTING.md). It decides whether the task belongs on standalone CLI, packaged Playwright, dev-CDP, MCP, or E2E.

For dev-time HMR/CDP verification in Claude Code, use the scripted launch path:

```bash
npm run test:preflight
npx tsx scripts/ui-test/launch-rebel-test.ts --keep-alive
npx tsx scripts/ui-test/screenshot.ts --out /tmp/rebel-dev.png
```

Useful launch flags: `--seed-onboarding-incomplete`, `--cdp-port <n>`, `--renderer-port <n>`, `--test-dir <path>`, `--timeout-ms <n>`. The script owns EPIPE-safe launch, settings seeding, CDP polling, guest/onboarding canaries, failure tails, and scoped cleanup. In `--keep-alive` mode it prints the PID, CDP port, test dir, log path, and exact cleanup command.

Factory's launch SSOT is [`.factory/commands/test-ui.md`](../../../.factory/commands/test-ui.md); this skill is the Claude Code entry point that routes there through the same script.

For deterministic no-TTY verification, use the packaged path instead: `npx tsx scripts/drive-packaged-app.ts --seed-staged-call --screenshot /tmp/x.png`. Full packaged guidance lives in [`docs/project/TESTING_E2E.md` § Driving the packaged app interactively](../../../docs/project/TESTING_E2E.md#driving-the-packaged-app-interactively-ad-hoc-verification-no-dev-server).
