---
description: "Catalogue of LLM-dependent call sites — Rebel Core, behind-the-scenes calls, safety evals, audio APIs, and local proxying"
last_updated: 2026-04-05
---

# LLM Call Sites

Comprehensive catalog of every place in the app where functionality relies on LLM calls — including Claude API, OpenAI Whisper, ElevenLabs, and local model proxying.

**Scope**: `src/` and `cloud-service/`. Excludes test files, `resources/mcp/`, `mobile/`, and `node_modules/`.

---

## Call Mechanisms Overview

LLM calls flow through a small number of mechanisms:

- **Rebel Core `rebelCoreQuery()`** — Multi-turn agentic conversations with tool use via direct Anthropic API. Used by the primary agent loop and heavyweight background tasks.
- **`callBehindTheScenesWithAuth()`** — Lightweight single-turn calls via `behindTheScenesClient.ts`. Routes through either direct Anthropic HTTP (API key path) or `rebelCoreQuery()` (OAuth path).
- **`callBehindTheScenes()`** — API-key-only variant of the above (no OAuth fallback). Used by Atlas search handlers.
- **`callWithModelAuthAware()`** — Same as above but accepts a specific model parameter. Delegates to `callBehindTheScenesWithAuth()` internally.
- **`SafetyEvaluationService.callLlm()`** — Platform-agnostic interface (`safetyEvaluationService.ts`). BTS implementation delegates to `callWithModelAuthAware()`.
- **`executeAgentTurn` (injected)** — Full agent turn pipeline injected as a dependency. Used by services that need agentic behavior without importing the executor directly.
- **External audio APIs** — Direct HTTP calls to OpenAI Whisper/TTS and ElevenLabs Scribe/TTS endpoints.

---

## Call Mechanism Summary Table

| Mechanism | Direct Callers |
|-----------|---------------|
| Rebel Core `rebelCoreQuery()` | `agentTurnExecutor`, `compactionService`, `promptCacheWarmupService`, `useCaseGeneratorService`, `behindTheScenesClient` (OAuth path) |
| `callBehindTheScenesWithAuth()` | `conversationTitleService`, `conversationSummaryService`, `quipGeneratorService`, `sessionCoachingService`, `communityShareService`, `memoryWriteHook` (×2), `memoryUpdateService`, `plaudSyncService`, `transcriptSummarizer`, `botQAService` (×2), `timeSavedService`, `evidenceCollectionService`, `weeklyAssessmentService`, `systemImprovementEvaluator`, `dashboardHandlers` (×2), `scratchpadHandlers`, `libraryHandlers`, `health/checks/prompt.ts` |
| `callBehindTheScenes()` | `searchHandlers` (×3) |
| `callWithModelAuthAware()` | `toolSafetyService`, `btsSafetyEvalService`, `autoContinueHook`, `doneSafetyService`, `publicBroadcastSafetyHook`, `spacesSynthesisService`, `semanticContextService` |
| `SafetyEvaluationService.callLlm()` | `safetyPromptLogic`, `safetyPromptMigration` |
| `executeAgentTurn` (injected) | `memoryUpdateService`, `useCaseGeneratorService`, `errorRecoveryService`, `inboundTriggerService`, `botQAService`, `automationScheduler`, `liveCoachService`, `approvalReEvalService` |
| OpenAI Whisper API | `audioService`, `physicalRecording/transcriptionService`, `plaudSyncService` |
| ElevenLabs API | `audioService`, `plaudSyncService` |
| Direct HTTP (`api.openai.com` chat/completions) | `settingsHandlers` (deep API key validation) |
| Direct HTTP (`api.anthropic.com` passthrough) | `localModelProxyServer` (passthrough mode) |

---

## Call Sites by Category

### Direct LLM Callers

#### Agent Execution

| File | Description |
|------|-------------|
| `src/main/services/agentTurnExecutor.ts` | Core agent turn execution. Calls Rebel Core `rebelCoreQuery()` with full fallback chains (OAuth → API key, extended → standard context, Opus → Sonnet). |
| `src/main/services/agentTurnService.ts` | Turn orchestration. Wires up and dispatches `executeAgentTurn` calls. Entry point for all agent turns. |
| `src/main/services/recovery/desktopRecoveryAdapter.ts` | Context overflow recovery wrapper. Wraps `executeAgentTurn` with automatic retry on context overflow errors. |

#### Tool Safety

| File | Description |
|------|-------------|
| `src/main/services/toolSafetyService.ts` | Interactive tool safety. Calls `callWithModelAuthAware()` to evaluate tool risk level (allow/ask/block). 15s timeout. |
| `src/core/safetyPromptLogic.ts` | Safety prompt evaluation for automation sessions. Calls `SafetyEvaluationService.callLlm()` with retry logic (up to 2 retries). Results cached per (version, tool, input). |
| `src/main/services/safety/btsSafetyEvalService.ts` | BTS safety eval implementation. Implements `SafetyEvaluationService` using `callWithModelAuthAware()`. |

#### Auto-Continue

| File | Description |
|------|-------------|
| `src/core/services/autoContinueHook.ts` | Stop hook / auto-continue. LLM evaluates whether Claude should continue or stop for user input. Has fast-path pattern matching (no LLM) and slow-path LLM evaluation. |

#### Done Safety

| File | Description |
|------|-------------|
| `src/core/services/doneSafetyService.ts` | "Done" safety evaluation. Calls `callWithModelAuthAware()` to evaluate whether agent completion is appropriate. |

#### Conversation Compaction

| File | Description |
|------|-------------|
| `src/core/services/compactionService.ts` | Context compaction. Generates conversation summaries to fit within context limits. Calls `rebelCoreQuery()` directly. 30s timeout. |

#### Conversation Metadata

| File | Description |
|------|-------------|
| `src/core/services/conversationTitleService.ts` | Title generation. Generates concise conversation titles via `callBehindTheScenesWithAuth()`. Max 5 words / 48 chars. |
| `src/core/services/conversationSummaryService.ts` | Conversation summary for @-mentions. Generates comprehensive summaries via `callBehindTheScenesWithAuth()`. Structured JSON output. |

#### Memory & Safety

| File | Description |
|------|-------------|
| `src/main/services/safety/memoryWriteHook.ts` | Memory write sensitivity evaluation. Two `callBehindTheScenesWithAuth()` calls: sensitivity assessment and content classification. Also calls `evaluateSafetyPrompt()` for safety prompt checks on memory writes. |
| `src/core/services/memoryUpdateService.ts` | Post-turn memory updates. Calls `executeAgentTurn` (injected) for headless agent turns with memory update skills. Also calls `callBehindTheScenesWithAuth()` for entity extraction pre-check. |

#### Post-Session Analytics

| File | Description |
|------|-------------|
| `src/core/services/timeSavedService.ts` | Post-session time saved estimation via `callBehindTheScenesWithAuth()`. |
| `src/core/services/evidenceCollectionService.ts` | Post-session evidence collection for achievements via `callBehindTheScenesWithAuth()`. |
| `src/core/services/weeklyAssessmentService.ts` | Weekly usage pattern assessment via `callBehindTheScenesWithAuth()`. |
| `src/core/services/systemImprovementStore.ts` | System improvement evaluation via `callBehindTheScenesWithAuth()`. |
| `src/core/services/sessionCoachingService.ts` | Post-session coaching. Analyzes conversations to identify missed opportunities via `callBehindTheScenesWithAuth()`. Structured JSON output. |

#### Content Generation

| File | Description |
|------|-------------|
| `src/core/services/quipGeneratorService.ts` | Dynamic status quips. Generates witty loading messages during long turns (30s+) via `callBehindTheScenesWithAuth()`. 8s timeout. |
| `src/core/services/communityShareService.ts` | Community win post composition. Composes anonymized Discourse posts via `callBehindTheScenesWithAuth()`. |
| `src/main/services/spacesSynthesisService.ts` | Weekly activity synthesis. Generates workspace activity summaries via `callWithModelAuthAware()`. Uses Rebel's personality. |

#### Prompt Cache Warmup

| File | Description |
|------|-------------|
| `src/main/services/promptCacheWarmupService.ts` | JIT cache warmup. Calls `rebelCoreQuery()` with a minimal prompt on composer focus (if >5min since last API call), then immediately aborts. Fire-and-forget. |

#### Use Case Discovery

| File | Description |
|------|-------------|
| `src/main/services/useCaseGeneratorService.ts` | Personalized use case discovery. Phase 1: `rebelCoreQuery()` for agentic data crawling with MCP tools (10min timeout). Phase 2: `rebelCoreQuery()` for text→JSON formatting (30s timeout). Also uses injected `executeAgentTurn`. |

#### Semantic Search / HyDE

| File | Description |
|------|-------------|
| `src/main/services/semanticContextService.ts` | Hypothetical Document Embeddings (HyDE). Generates hypothetical documents for action-oriented queries via `callWithModelAuthAware()`. 5s timeout, max 150 output tokens. |

#### IPC Handlers

| File | Description |
|------|-------------|
| `src/main/ipc/dashboardHandlers.ts` | Goal extraction and restructuring. Two `callBehindTheScenesWithAuth()` calls for dashboard AI features. |
| `src/main/ipc/scratchpadHandlers.ts` | Note location suggestion via `callBehindTheScenesWithAuth()`. |
| `src/main/ipc/libraryHandlers.ts` | Space description generation via `callBehindTheScenesWithAuth()`. |
| `src/main/ipc/searchHandlers.ts` | Atlas semantic search. Three `callBehindTheScenes()` calls (API-key-only variant): summarize, ask, and search. |

#### Meeting Bot

| File | Description |
|------|-------------|
| `src/main/services/meetingBot/botQAService.ts` | Meeting bot Q&A. Multiple LLM calls: answer questions via `callBehindTheScenesWithAuth()` (Haiku, 8s timeout), check query completeness via `callBehindTheScenesWithAuth()` (2s timeout, 10 max tokens), and knowledge base queries via injected `executeAgentTurn`. |
| `src/main/services/meetingBot/meetingAnalysisService.ts` | Transcript summarization. Generates meeting summaries with key points and action items via `callBehindTheScenesWithAuth()`. Structured JSON output. |
| `src/main/services/meetingBot/transcriptSensitivityGuard.ts` | Transcript sensitivity evaluation. Delegates to `evaluateMemorySensitivity()` from `memoryWriteHook.ts` (indirect LLM call via BTS client). |

#### Plaud

| File | Description |
|------|-------------|
| `src/main/services/plaud/plaudSyncService.ts` | Plaud recording processing. Title generation via `callBehindTheScenesWithAuth()`. Transcription via Whisper API and ElevenLabs Scribe STT. |

#### Inbound Triggers

| File | Description |
|------|-------------|
| `src/main/services/inboundTriggers/publicBroadcastSafetyHook.ts` | Public broadcast content safety. Evaluates outbound public-broadcast messages for sensitive information via `callWithModelAuthAware()`. Fail-closed on error. |
| `src/main/services/inboundTriggers/inboundTriggerService.ts` | Inbound trigger agent turns. Spawns agent turns in response to external events (Slack @-mentions, etc.) via injected `executeAgentTurn`. |

#### Voice / Audio APIs

| File | Description |
|------|-------------|
| `src/main/services/audioService.ts` | Voice transcription & TTS. OpenAI Whisper STT, ElevenLabs Scribe STT, OpenAI TTS, and ElevenLabs TTS — multiple direct HTTP calls to external audio APIs. |
| `src/main/services/physicalRecording/transcriptionService.ts` | Physical recording transcription. OpenAI Whisper API for audio files. Handles chunking for files >24MB. |

#### Health & Diagnostics

| File | Description |
|------|-------------|
| `src/main/services/health/checks/prompt.ts` | Health check prompt coherence. Calls `callBehindTheScenesWithAuth()` to validate prompt pipeline health. |
| `src/main/ipc/settingsHandlers.ts` | Deep API key validation. Direct HTTP POST to OpenAI `chat/completions` endpoint to verify key validity. Non-feature diagnostic. |

#### Safety Prompt Migration

| File | Description |
|------|-------------|
| `src/core/safetyPromptMigration.ts` | Safety prompt migration. Calls `SafetyEvaluationService.callLlm()` to migrate legacy safety prompts. |

---

### Indirect LLM Callers (via `executeAgentTurn` injection)

These services don't call LLM APIs directly — they receive `executeAgentTurn` as a dependency and use it to run full agent turns.

| File | Description |
|------|-------------|
| `src/main/services/liveCoachService.ts` | Proactive coaching during meetings via injected `executeAgentTurn`. |
| `src/main/services/safety/approvalReEvalService.ts` | Approval re-evaluation continuation via injected `executeAgentTurn`. |
| `src/main/services/automationScheduler.ts` | Scheduled automation runs via injected `executeAgentTurn`. |
| `src/main/services/errorRecoveryService.ts` | Agent-based error diagnosis. Uses injected `executeAgentTurn` with read-only tools to evaluate whether Rebel can fix detected errors. |

---

### Infrastructure

These files enable, route, or implement LLM call abstractions.

| File | Description |
|------|-------------|
| `src/core/services/behindTheScenesClient.ts` | Central routing hub for all background LLM calls. Routes to Anthropic HTTP or `rebelCoreQuery()` depending on auth method. Tracks costs via `costLedgerService`. |
| `src/core/safetyEvaluationService.ts` | Platform-agnostic safety eval interface. Defines `callLlm()` method implemented by platform-specific services. |
| `src/main/services/safety/btsSafetyEvalService.ts` | BTS safety implementation of `SafetyEvaluationService` (see also Tool Safety above). |
| `src/main/services/localModelProxyServer.ts` | Anthropic → OpenAI API translation layer for local models (LM Studio, Ollama). Also makes direct `fetch` to `api.anthropic.com/v1/messages` in passthrough mode. |
| `src/main/services/councilService.ts` | Council mode agent configuration. Builds agent definitions and proxy route tables — configures agents that `rebelCoreQuery()` in `agentTurnExecutor` uses. |

---

### No Direct LLM Calls

| Scope | Notes |
|-------|-------|
| `cloud-service/` | Delegates to the same core services via HTTP router. All LLM calls originate from `src/core/` and `src/main/` services. `bootstrap.ts` and `cloudAutomationScheduler.ts` wire the same boundary interfaces and inject `executeAgentTurn`. |
| `src/main/services/localSttService.ts` | Local speech-to-text using on-device models (CoreML on macOS, Sherpa-ONNX on others). No API calls. |
| `src/main/services/embeddingService.ts` | Local embeddings using BGE-small-en-v1.5. No API calls. |

---

## Maintenance

Keep this doc current when adding new LLM call sites. Use these patterns to audit completeness:

```bash
# Find all BTS client callers
rg "callBehindTheScenesWithAuth|callWithModelAuthAware|callBehindTheScenes" src/ --type ts -l | grep -v __tests__

# Find all rebelCoreQuery() callers
rg "rebelCoreQuery" src/ --type ts -l | grep -v __tests__

# Find all executeAgentTurn consumers
rg "executeAgentTurn" src/ --type ts -l | grep -v __tests__ | grep -v agentTurnExecutor

# Find direct external API calls
rg "api\.openai\.com|api\.elevenlabs\.io|api\.anthropic\.com" src/ --type ts -l | grep -v __tests__
```
