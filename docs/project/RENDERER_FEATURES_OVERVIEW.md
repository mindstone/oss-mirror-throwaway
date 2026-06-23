---
description: "One-hop signpost from docs to every subdirectory under src/renderer/features/."
last_updated: "2026-06-14"
---

# Renderer Features Overview

Feature-scoped React modules — components, hooks, and local state for each product surface. Put feature-specific logic here, not in `App.tsx`.

| Subdirectory | What it does |
|---|---|
| [`agent-session/`](../../src/renderer/features/agent-session/) | Agent turn state machine, session store, conversation UI |
| [`app-bridge/`](../../src/renderer/features/app-bridge/) | Browser, Slack, and Office external-context indicator chips |
| [`app-shell/`](../../src/renderer/features/app-shell/) | Per-surface error boundaries that isolate UI crashes |
| [`atlas/`](../../src/renderer/features/atlas/) | 3D file-embedding graph with semantic search spotlight |
| [`auth/`](../../src/renderer/features/auth/) | Login screen, auth gate, and account menu hooks |
| [`automations/`](../../src/renderer/features/automations/) | Automations panel UI and live CRUD hooks |
| [`canvas/`](../../src/renderer/features/canvas/) | Mind-map canvas and interactive canvas input surface |
| [`cloud/`](../../src/renderer/features/cloud/) | Workspace conflict dialog for local vs cloud copies |
| [`composer/`](../../src/renderer/features/composer/) | Chat input strip, queues, finish-line, session settings |
| [`document-editor/`](../../src/renderer/features/document-editor/) | Unified multi-tab document viewer and editor |
| [`flow-panels/`](../../src/renderer/features/flow-panels/) | Main navigation shell and flow-surface routing state |
| [`focus/`](../../src/renderer/features/focus/) | Strategic planning panel with goals and calendar alignment |
| [`homepage/`](../../src/renderer/features/homepage/) | Landing surface with chat hero, today, and coach |
| [`inbox/`](../../src/renderer/features/inbox/) | Inbox triage panel with staging, search, and approvals |
| [`library/`](../../src/renderer/features/library/) | Workspace file browser with navigator, search, and lenses |
| [`mentions/`](../../src/renderer/features/mentions/) | Unified @-mention picker for files and conversations |
| [`migration/`](../../src/renderer/features/migration/) | Transfer import notice context and re-auth checklist |
| [`nps/`](../../src/renderer/features/nps/) | Net Promoter Score survey dialog and timing logic |
| [`onboarding/`](../../src/renderer/features/onboarding/) | First-run wizard and coach orchestration flows |
| [`operators/`](../../src/renderer/features/operators/) | Operator registry panel, cards, and personalisation |
| [`permissions/`](../../src/renderer/features/permissions/) | Onboarding and permission wizard orchestration hook |
| [`plugins/`](../../src/renderer/features/plugins/) | Plugin runtime, API hooks, compiler, manifest registry, security, and themed UI kit |
| [`scratchpad/`](../../src/renderer/features/scratchpad/) | Quick-capture scratchpad modal and recent memory files |
| [`settings/`](../../src/renderer/features/settings/) | Settings surface, provider tabs, and save orchestration |
| [`spaces/`](../../src/renderer/features/spaces/) | Add-space wizard and space management hooks |
| [`surveys/`](../../src/renderer/features/surveys/) | Generic in-app survey modal and scheduling hook |
| [`tutorials/`](../../src/renderer/features/tutorials/) | Tutorial nudges, whispers, and progress modal |
| [`usecases/`](../../src/renderer/features/usecases/) | Spark panel with use cases, coaching, and community |
| [`visual-verification/`](../../src/renderer/features/visual-verification/) | Screenshot capture overlay during agent verification |
| [`voice/`](../../src/renderer/features/voice/) | Voice recording, playback, and auto-speak hooks |
| [`whats-new/`](../../src/renderer/features/whats-new/) | Changelog highlights widget and version parsing |

## See also

- [`src/renderer/AGENTS.md`](../../src/renderer/AGENTS.md)
- [`UI_OVERVIEW`](./UI_OVERVIEW.md)
