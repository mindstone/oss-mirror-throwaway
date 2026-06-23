---
description: "One-hop signpost from docs to every subdirectory under src/main/services/."
last_updated: "2026-06-14"
---

# Main Services Overview

Electron-only service implementations and adapters that wire core boundaries to desktop APIs. If it does not need Electron, it belongs in `src/core/`.

| Subdirectory | What it does |
|---|---|
| [`calendar/`](../../src/main/services/calendar/) | Calendar cache enrichment for meeting metadata lookup |
| [`cloud/`](../../src/main/services/cloud/) | Desktop cloud routing, migration, workspace/session sync, outbox, token relay, and health adapters |
| [`desktopNotification/`](../../src/main/services/desktopNotification/) | Electron native notifications and click-intent routing |
| [`dockBadge/`](../../src/main/services/dockBadge/) | macOS dock and Windows taskbar unread badge adapter |
| [`embedding/`](../../src/main/services/embedding/) | Electron adapter for on-device embedding generation |
| [`fileIndexService/`](../../src/main/services/fileIndexService/) | LanceDB semantic index for workspace files |
| [`health/`](../../src/main/services/health/) | Re-exports core health checks plus desktop-only checks |
| [`inboundTriggers/`](../../src/main/services/inboundTriggers/) | Slack polling adapters and inbound trigger orchestration |
| [`localModelProxy/`](../../src/main/services/localModelProxy/) | Local model proxy classification and stream lifecycle |
| [`mcp/`](../../src/main/services/mcp/) | Electron subprocess spawner for local MCP connectors |
| [`mcpAppsTrust/`](../../src/main/services/mcpAppsTrust/) | MCP App iframe nonce, permissions, and rate limits |
| [`meetingBot/`](../../src/main/services/meetingBot/) | Meeting bot Q&A, voice, transcript, and triggers |
| [`physicalRecording/`](../../src/main/services/physicalRecording/) | Limitless Pendant BLE recording and transcription |
| [`plaud/`](../../src/main/services/plaud/) | Plaud recorder OAuth, sync, and file download |
| [`powerSaveBlocker/`](../../src/main/services/powerSaveBlocker/) | Prevents sleep during active agent or recording work |
| [`preTurnWorker/`](../../src/main/services/preTurnWorker/) | Desktop adapter for background pre-turn context worker |
| [`pushNotificationSink/`](../../src/main/services/pushNotificationSink/) | No-op mobile push sink on desktop surfaces |
| [`recovery/`](../../src/main/services/recovery/) | Desktop recovery adapter wiring compaction to UI events |
| [`safety/`](../../src/main/services/safety/) | Tool approval persistence, staged calls, session grants |
| [`scheduler/`](../../src/main/services/scheduler/) | Electron scheduler with window-visibility deferral |
| [`secureTokenStore/`](../../src/main/services/secureTokenStore/) | Electron safeStorage adapter for encrypted secrets |
| [`sentry/`](../../src/main/services/sentry/) | Sentry redaction regression tests for Slack webhook secrets |
| [`turnErrorRecovery/`](../../src/main/services/turnErrorRecovery/) | Modular agent-turn catch-block error handlers |
| [`turnPipeline/`](../../src/main/services/turnPipeline/) | Compatibility shims re-exporting core turn-pipeline phase modules and types |
| [`workspace/`](../../src/main/services/workspace/) | Workspace startup recovery dialogs for missing folders |
| [`workspaceFileSystem/`](../../src/main/services/workspaceFileSystem/) | Node filesystem adapter for guarded workspace I/O |

## See also

- [`src/main/AGENTS.md`](../../src/main/AGENTS.md)
- [`ARCHITECTURE_OVERVIEW`](./ARCHITECTURE_OVERVIEW.md)
