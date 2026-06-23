---
description: "Meeting bot architecture reference: desktop orchestration, cloud worker, transcript pipeline, and companion integrations."
last_updated: "2026-06-22"
---

> Non-technical guide: see `rebel-system/help-for-humans/meetings-and-notetaker.md`.

# Meeting Bot (Rebel Notetaker)

This is the technical reference for the current meeting bot stack. It focuses on architecture, service boundaries, and code entry points (not implementation walkthroughs).

## See also

- [ARCHITECTURE_OVERVIEW](ARCHITECTURE_OVERVIEW.md) — system-level process boundaries.
- [ARCHITECTURE_IPC](ARCHITECTURE_IPC.md) — IPC contracts and handler routing.
- [VOICE_AND_AUDIO](VOICE_AND_AUDIO.md) — shared voice/audio pipeline.
- [PHYSICAL_RECORDING](PHYSICAL_RECORDING.md) — in-person recording path.
- [THE_SPARK](THE_SPARK.md) — meeting-aware homepage surfaces.
- [INBOX_PANEL](INBOX_PANEL.md) — where meeting analysis results are reviewed.
- [AUTOMATIONS](AUTOMATIONS.md) — transcript-triggered automation behavior.

## Architecture at a glance

The current system is multi-path capture with a single renderer status stream:

1. **Cloud bot path** (Recall + worker + relay): schedules/joins meetings, streams captions, and retrieves final transcripts.
2. **Local fallback path** (Desktop SDK upload): captures and uploads local recordings when cloud bot is unavailable or not desired.
3. **Physical/quick-capture paths**: in-person and ad-hoc recordings feed the same transcript + automation pipeline.
4. **Companion/coaching path**: live coach and active participation use transcript + conversation state during meetings.

## Core code entry points

### Main-process orchestration

- `src/main/index.ts` — startup wiring, feature gate (`meetingBotUnlocked`), and service initialization.
- `src/main/services/meetingBot/meetingBotService.ts` — orchestrator for send/cancel, polling, relay lifecycle, transcript save/retry, and pre-scheduled activation.
- `src/main/services/meetingBot/pendingTranscriptsStore.ts` — persistent bot/transcript state used for retries and restart recovery. **Invariant:** staged transcripts must remain re-importable after restart until the final import succeeds — entries are only removed from the pending store on confirmed successful save, not on staging or intermediate steps. Polling failures are logged at warn level for observability.
- `src/main/services/meetingBot/transcriptStorage.ts` — transcript file writes, live transcript upgrade, prep-linking, and routing.
- `src/main/services/meetingBot/transcriptEventBus.ts` — transcript-saved and distribution-ready events for automations/history.
- `src/main/services/meetingBot/meetingAnalysisService.ts` — post-save headless analysis that creates inbox outcomes.
- `src/main/services/meetingBot/desktopSdkService.ts` — Desktop SDK detection, preview state, auto-send, Teams URL permission handling.
- `src/main/services/meetingBot/autoScheduleService.ts` — calendar-driven background scheduling/instant-join decisions.
- `src/main/services/meetingBot/localRecordingService.ts` — local recording capture/upload/transcript flow.
- `src/main/services/meetingBot/botQAService.ts` — live trigger detection, Q&A, pending responses, knowledge toggle, and live transcript buffering.
- `src/main/services/meetingBot/botVoiceService.ts` — in-meeting TTS playback/interrupt path over relay.
- `src/main/services/meetingBot/conversationStateService.ts` — structured meeting state updates (topic/summary/questions/decisions).
- `src/main/services/liveCoachService.ts` — proactive coaching + participant-mode contribution logic.
- `src/main/services/meetingHistoryStore.ts` — reconciliation of calendar meetings vs captured transcript outcomes.
- `src/main/services/meetingBot/externalProviders/pollingService.ts` — Fireflies/Fathom import sync and event emission.

### Worker backend (`meeting-bot-worker/`)

- `meeting-bot-worker/src/index.ts` — HTTP routing for bot lifecycle, transcript/status endpoints, chat/transcript webhooks, upload-session endpoints, relay upgrades.
- `meeting-bot-worker/src/relay.ts` — Durable Object WebSocket relay between desktop and avatar page.
- `meeting-bot-worker/src/utils.ts` — auth/signing, session token generation, URL canonicalization helpers.
- `meeting-bot-worker/src/types.ts` — worker environment + payload contracts.
- `meeting-bot-worker/wrangler.toml` — KV/DO bindings and runtime config.

### IPC and renderer surface

- `src/shared/ipc/channels/meetingBot.ts` — contract-first meeting channels and payload schemas.
- `src/main/ipc/meetingBotHandlers.ts` — domain handlers bridging renderer requests to services.
- `src/preload/generated/ipcBridge.ts` — generated `meetingBotApi` bridge.
- `src/renderer/contexts/MeetingStatusContext.tsx` — merged status model with source precedence (`desktop_sdk`, `cloud_bot`, `local_recording`, `quick_capture`, `physical_recording`).
- `src/renderer/components/MeetingStatusIndicator.tsx` — title-bar meeting controls and live-state UI.
- `src/renderer/features/settings/components/tabs/MeetingsTab.tsx` — meeting settings and provider configuration.
- `src/renderer/features/agent-session/components/MeetingCompanionManager.tsx` — companion session lifecycle.
- `src/renderer/features/agent-session/components/SessionSurfaceContent.tsx` + `src/renderer/components/MeetingCompanionBanner.tsx` — coach selection and presence-mode controls.

## Integration points

### Audio capture + transcription

- **Cloud captions/transcripts:** worker + Recall bot path (`meetingBotService.ts`, `meeting-bot-worker/src/index.ts`).
- **Local meeting recording:** Desktop SDK upload-session path (`localRecordingService.ts` + worker `/api/upload-session*` endpoints).
- **Physical and quick capture:** `physicalRecordingService.ts` and `quickCaptureHandlers.ts` publish into the same `meeting-bot:status` UI channel.

### Voice interaction in meetings

- `botQAService.ts` handles wake phrases, stop/discard triggers, pending responses, and transcript-context answers.
- `botVoiceService.ts` performs chunked TTS playback with interruption support.
- `relayClient.ts` + worker `relay.ts` carry avatar state/audio/transcript messages.

### Calendar and lifecycle

- `desktopSdkService.ts` combines real-time detection with calendar cache enrichment and pre-scheduled bot activation.
- `autoScheduleService.ts` dispatches future or instant-join bots based on join mode + meeting timing.
- `meetingHistoryStore.ts` reconciles calendar entries with transcript outcomes.

### Coaching and companion behavior

- `liveCoachService.ts` consumes transcript buffer + conversation state for proactive coaching and participant contributions.
- `conversationStateService.ts` provides structured context to coaching, Q&A, and post-meeting analysis.
- Renderer companion components use `meetingBotApi.setCoach` / `setPresenceMode` to control live behavior.

## Configuration and setup requirements

- **Feature gate:** meeting services start only when `settings.meetingBotUnlocked === true` (`src/main/index.ts`).
- **Settings contract:** `MeetingBotSettings` and `MeetingJoinMode` live in `src/shared/types/settings.ts`; user controls are in `MeetingsTab.tsx`.
- **Worker deployment config:** `meeting-bot-worker/wrangler.toml` plus secrets (`RECALL_API_KEY`, `MINDSTONE_AUTH_SECRET`, `JWT_SECRET`) are required.
- **Permissions:**
  - Desktop SDK + Teams URL extraction permissions are managed in `desktopSdkService.ts`.
  - Local recording permission checks/requests are managed in `localRecordingService.ts`.

### Backend config & OSS posture

Desktop services resolve the meeting-bot backend URL and HMAC auth key through [`@core/services/meetingBotBackendConfig`](../../src/core/services/meetingBotBackendConfig.ts): environment variables first, then the injected private provider, then fail-closed with structured `reason: 'meeting_bot_backend_config_missing'` logs. [`src/main/services/meetingBot/backendAuth.ts`](../../src/main/services/meetingBot/backendAuth.ts) refuses to sign requests when the auth key is missing.

Commercial desktop gets the production backend config from `@private/mindstone`: [`private/mindstone/src/services/meetingBotBackendConfigProvider.ts`](../../private/mindstone/src/services/meetingBotBackendConfigProvider.ts) supplies the URL and reads the main-bundle-only build-time key from `MAIN_VITE_MEETING_BOT_BACKEND_AUTH_KEY`; [`src/main/oss/private-mindstone-stub/services/meetingBotBackendConfigProvider.ts`](../../src/main/oss/private-mindstone-stub/services/meetingBotBackendConfigProvider.ts) is the OSS null provider. [`scripts/check-built-bundle-meeting-bot-config.mjs`](../../scripts/check-built-bundle-meeting-bot-config.mjs) guards the commercial/OSS bundle posture.

OSS is broken-by-default / BYO-backend: operators must set both `MEETING_BOT_BACKEND_URL` and `MEETING_BOT_BACKEND_AUTH_KEY`. Intent and rotation notes live in the [meeting-bot secret-leak plan](../plans/260622_fix-meeting-bot-secret-leak/PLAN.md).

## Recent architecture shifts (from changelog)

- **260326_1045:** added `ConversationStateService`; state now feeds live Q&A and post-meeting analysis.
- **260320_1830:** wired meeting companion context into live coaching turns.
- **260319_2050:** added participant-mode active contributions with live caption awareness.
- **260316_1133:** fixed pre-scheduled bot activation for long lead-time meetings.
- **260313_1344:** added transcript webhook delivery path to reduce relay-only transcript dependence.
