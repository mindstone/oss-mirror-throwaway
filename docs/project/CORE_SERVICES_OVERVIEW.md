---
description: "One-hop signpost from docs to every subdirectory under src/core/services/."
last_updated: "2026-06-14"
---

# Core Services Overview

Platform-agnostic domain services shared by desktop, cloud, and mobile. If the logic does not need Electron or React, it belongs here — wired in via boundary interfaces at bootstrap.

| Subdirectory | What it does |
|---|---|
| [`agentTurnReducer/`](../../src/core/services/agentTurnReducer/) | Pure reducers for conversation, runtime, and live turn state |
| [`automation/`](../../src/core/services/automation/) | Cross-surface automation rule engine and admission policy |
| [`automations/`](../../src/core/services/automations/) | Script automation registry and sandboxed script runner |
| [`bts/`](../../src/core/services/bts/) | Behind-the-scenes LLM dispatch core with typed outcomes |
| [`cloud/`](../../src/core/services/cloud/) | Cloud provider registry plus instance discovery, health reconciliation, migration footprint, volume, and VM-tier helpers |
| [`continuity/`](../../src/core/services/continuity/) | Session tombstones, stale-busy reaper, turn idempotency |
| [`conversationState/`](../../src/core/services/conversationState/) | Canonical conversation state derived from event streams |
| [`diagnostics/`](../../src/core/services/diagnostics/) | Diagnostic bundle manifest, drift detection, log redaction |
| [`externalConversation/`](../../src/core/services/externalConversation/) | Transport-agnostic routing of inbound messages to sessions |
| [`health/`](../../src/core/services/health/) | Shared health-check types and portable check functions |
| [`inboundAuthorGates/`](../../src/core/services/inboundAuthorGates/) | Connector-specific gates for inbound author admission |
| [`inboundAuthorPolicy/`](../../src/core/services/inboundAuthorPolicy/) | Normalizes inbound author IDs per connector |
| [`inboundTriggers/`](../../src/core/services/inboundTriggers/) | Slack inbound prompt-safety wrappers for untrusted text |
| [`inbox/`](../../src/core/services/inbox/) | Bundled inbox bridge state machine and plugin source validation |
| [`localInference/`](../../src/core/services/localInference/) | Ollama inference strategy and local model catalog |
| [`mcp/`](../../src/core/services/mcp/) | MCP server config resolution and transport inference |
| [`meeting/`](../../src/core/services/meeting/) | Live meeting transcription, analysis, coaching, and companion-trigger helpers |
| [`meetings/`](../../src/core/services/meetings/) | Meeting upload session state, chunks, and companion QA |
| [`meetingTriggerDetector/`](../../src/core/services/meetingTriggerDetector/) | Voice and chat trigger detection for meeting bots |
| [`migration/`](../../src/core/services/migration/) | Data-migration copy policy and path classification rules |
| [`recovery/`](../../src/core/services/recovery/) | Context-overflow recovery state machine and adapter contracts |
| [`safety/`](../../src/core/services/safety/) | Tool-safety evaluation, intent extraction, and guard hooks |
| [`settingsStore/`](../../src/core/services/settingsStore/) | App settings persistence, normalization, and migrations |
| [`space/`](../../src/core/services/space/) | Space creation, discovery, frontmatter, and filesystem ops |
| [`tokenStorage/`](../../src/core/services/tokenStorage/) | Secure token stores for app auth, Codex/OpenRouter, Fly, and generic cloud provider tokens |
| [`tokenSync/`](../../src/core/services/tokenSync/) | Cross-surface OAuth token file sync and merge coordinator |
| [`toolIndex/`](../../src/core/services/toolIndex/) | Semantic LanceDB index for MCP tool discovery |
| [`turnPipeline/`](../../src/core/services/turnPipeline/) | Portable turn admission, execution, and recovery orchestration |
| [`watchdog/`](../../src/core/services/watchdog/) | Agent silence and subagent lifecycle stall tracking |
| [`workspace/`](../../src/core/services/workspace/) | Guarded workspace paths and shared file-tree traversal |

## See also

- [`src/core/AGENTS.md`](../../src/core/AGENTS.md)
- [`ARCHITECTURE_OVERVIEW`](./ARCHITECTURE_OVERVIEW.md)
