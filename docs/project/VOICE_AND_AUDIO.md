---
description: "End-to-end voice and audio architecture: microphone capture, STT, TTS, playback, and agent integration"
last_updated: "2026-03-20"
---

### Introduction

Mindstone Rebel is a **voice‑first** desktop app: the primary interaction loop is "press to speak → agent thinks → agent speaks back", with text as a first‑class alternative.
This document is the **evergreen reference** for how voice input and audio output work end‑to‑end: microphone capture, permissions, speech‑to‑text (STT), text‑to‑speech (TTS), playback, and how this all feeds the agent.


## See Also

- [VOICE_AND_AUDIO_LOCAL](VOICE_AND_AUDIO_LOCAL.md) - Local on-device STT: Parakeet V3 (desktop) and Moonshine Base (desktop + mobile)
- [PHYSICAL_RECORDING](PHYSICAL_RECORDING.md) - Limitless Pendant and Plaud device integrations for in-person meeting recording
- [SYSTEM_ARCHITECTURE](ARCHITECTURE_OVERVIEW.md) - High-level system architecture, component responsibilities, and process boundaries
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - Canonical reference for app settings including voice configuration
- [UI_LAYOUT_AND_INTERACTION_PATTERNS](UI_OVERVIEW.md) - Main UI layout, voice/text interaction patterns, and permissions UX
- [IPC_ARCHITECTURE](ARCHITECTURE_IPC.md) - IPC contract system for voice transcription and TTS handlers
- [ARCHITECTURE_MESSAGE_QUEUE](ARCHITECTURE_MESSAGE_QUEUE.md) - Message queue and interrupt-mode design for voice input integration
- [LIBRARY_AND_FILE_ACCESS](LIBRARY_AND_FILE_ACCESS.md) - File-access permissions that complement microphone permissions
- [LOGGING](LOGGING.md) - Structured logging architecture for debugging voice provider issues


### Implementation references

- `../plans/251115_speech_recognition_upgrade.md` – Historical implementation notes for the multi‑provider STT upgrade (OpenAI Whisper vs ElevenLabs Scribe).
- `../../src/main/services/audioService.ts` – Main‑process implementation of STT and TTS provider calls.
- `../../src/main/index.ts` – IPC handlers for `voice:transcribe` and `voice:text-to-speech`, streaming TTS chunks back to the renderer.
- `../../src/preload/index.ts` – Typed `window.api.transcribeAudio`, `window.api.textToSpeech`, and `window.api.onTtsChunk` bridge used by the UI.
- `../../src/renderer/App.tsx` – Voice state management and integration with agent message queue.
- `../../src/renderer/features/composer/InteractionStrip.tsx` – Mic button (STT) and speaker toggle (TTS) UI with missing-key guards.
- `../../src/renderer/features/voice/hooks/` – `useVoiceRecording` for recording, `useAudioPlayback` for TTS playback queue.


### Principles, key decisions

- **Voice‑first, text‑friendly**: Voice should feel like the default way to use the app, but everything must also work with pure text for accessibility, testing, and “quiet mode” usage.  
- **Clear process boundaries**:  
  - Renderer handles UI, microphone capture, and audio playback.  
  - Preload exposes a narrow, typed IPC surface.  
  - Main process owns provider calls, secrets, and permission checks.  
- **Provider‑agnostic UX**: Users should experience “press, speak, hear reply” regardless of which STT/TTS provider is selected. Provider details live in settings and `audioService.ts`, not scattered across the UI.  
- **Single source of truth for settings**: Voice configuration lives in `AppSettings.voice`, normalized by `normalizeSettings` so defaults, migrations, and provider selection are centralized.  
- **Streaming where it matters**: TTS responses are streamed to the renderer in chunks for low‑latency playback, instead of waiting for the entire audio buffer.  
- **Defensive error handling**: Provider failures should surface as clear, user‑visible errors and produce structured logs for debugging. Every STT/TTS HTTP call sets an explicit axios timeout and routes failures through `buildNetworkAwareMessage` so users see network-aware resilience copy rather than a hang or raw error.
- **Graceful degradation when unconfigured**: If voice API keys are missing, the mic and speaker buttons are visually disabled with helpful tooltips guiding users to Settings. Clicking opens Settings directly.


### High‑level voice and audio architecture

At a high level there are two main flows:

- **Voice input (STT):**  
  User speaks → renderer records microphone audio → preload sends audio buffer via IPC → main calls STT provider → transcript returned to renderer → renderer enqueues transcript as a user message to the agent.

- **Voice output (TTS):**  
  Agent produces text → renderer optionally sends that text to TTS via IPC → main calls TTS provider and streams audio → renderer decodes and plays back audio, maintaining an audio queue for consecutive messages.

Responsibility split:

- **Renderer (`App.tsx` + `InteractionStrip.tsx`)**  
  - `InteractionStrip` renders the mic button (STT) and speaker toggle (TTS/autoSpeak).  
  - Mic button uses `useTranscriptionMic` hook for recording; speaker toggle controls `autoSpeak` state.  
  - Both buttons are guarded: if the voice API key is missing, they show a disabled state with a tooltip explaining how to configure voice in Settings.  
  - `useAudioPlayback` hook manages TTS playback queue with Web Audio API.  
  - On successful transcription, the transcript is sent to the agent message queue.

- **Preload (`index.ts`)**  
  - Exposes `transcribeAudio`, `textToSpeech`, and `onTtsChunk` as a typed `window.api` surface using `ipcRenderer.invoke` / `ipcRenderer.on`.  
  - Does not contain business logic; it’s a thin, audited bridge between renderer and main.

- **Main process (`index.ts` + `audioService.ts`)**  
  - Normalizes settings (`AppSettings.voice`) and selects the active provider.  
  - Implements `voice:transcribe` and `voice:text-to-speech` IPC handlers.  
  - Delegates to `transcribeAudio` / `textToSpeechStream` in `audioService.ts` for provider‑specific HTTP calls.  
  - Streams TTS audio back to the renderer via `voice:tts-chunk` events while also accumulating the full buffer to return from the IPC call.  
  - Manages microphone and filesystem permissions (macOS) via `systemPreferences`.


### Voice input (speech‑to‑text) pipeline

#### 1. Microphone capture and recording (renderer)

When the user starts a voice interaction (e.g. tapping the voice button):

- `App.tsx` calls `navigator.mediaDevices.getUserMedia({ audio: true })` to obtain a microphone stream.  
- A `MediaRecorder` instance is created from this stream and attached to `mediaRecorder` / `audioChunks` refs.  
- As audio becomes available, `dataavailable` events push `Blob`s into `audioChunks.current`.  
- When recording stops, the renderer:
  - Builds a `Blob` from all chunks, using the recorder’s `mimeType` or a default like `audio/webm`.  
  - Calls `blob.arrayBuffer()` to obtain raw audio bytes.  
  - Invokes `window.api.transcribeAudio({ audio: buffer, mimeType })`.

The renderer updates user‑visible state during this flow:

- `voiceHint` shows “Listening… tap to stop” and then “Processing audio…”.  
- Errors (e.g. empty transcript, STT failure) update `error` state and log via `emitLog`.

#### 2. IPC bridge (preload)

The preload script defines:

- `transcribeAudio(payload: VoiceTranscriptionPayload): Promise<string>` → `ipcRenderer.invoke('voice:transcribe', payload)`.

This isolates the renderer from `ipcRenderer` details and keeps the interface typed and testable.

#### 3. STT provider selection and calls (main + `audioService.ts`)

The main process handles the `voice:transcribe` IPC channel:

- Ensures settings are normalized and loads `AppSettings` from `electron-store`.  
- Calls `transcribeAudio(payload)` in `audioService.ts`.  
- Wraps errors so they always surface as a string message over IPC.

`audioService.transcribeAudio`:

- Reads `AppSettings.voice.provider`, `openaiApiKey`, `elevenlabsApiKey`, and `model`.  
- Constructs a `FormData` payload with:
  - `file`: audio bytes as a `Buffer`, with a safe filename and `contentType` based on `mimeType`.  
  - `model` / `model_id`: STT model name derived from settings.
- Dispatches a provider‑specific HTTP request:
  - **OpenAI Whisper** – `POST https://api.openai.com/v1/audio/transcriptions` with `Authorization: Bearer {openaiApiKey}`.  
  - **ElevenLabs Scribe** – `POST https://api.elevenlabs.io/v1/speech-to-text` with `xi-api-key: {elevenlabsApiKey}`.
- Validates that `response.data.text` is a string and returns `text.trim()`.  
- On failure:
  - Logs detailed context (status, response body, headers) with `logger`.  
  - Throws a human‑readable `Error` summarizing status and error detail.

Provider selection rules (actual logic lives in `normalizeSettings` and `VoiceSettings`):

- `voice.provider` is one of `'openai-whisper' | 'elevenlabs-scribe' | 'local-parakeet' | 'local-moonshine' | 'custom-openai'`.  
- Separate API keys are stored for OpenAI and ElevenLabs; local provider requires no API key.  
- The normalize layer can:
  - Migrate legacy fields (e.g. a single `apiKey`) into the new structure.  
  - Prefer ElevenLabs when both keys are present, while still allowing manual override via settings.

#### 3b. Local STT providers (Parakeet V3 + Moonshine Base)

Two on-device speech recognition providers, no API keys required:

- **Parakeet V3** (`local-parakeet`): NVIDIA Parakeet TDT 0.6B. macOS (CoreML) and Windows (ONNX Runtime). ~482-670 MB download.
- **Moonshine Base** (`local-moonshine`): Moonshine by Useful Sensors. macOS, Windows (ONNX Runtime), iOS, and Android (native SDKs). ~251 MB desktop, ~429 MB mobile.

Moonshine is the only local provider available on mobile. On desktop, both are selectable in Settings. See [VOICE_AND_AUDIO_LOCAL](VOICE_AND_AUDIO_LOCAL.md) for full architecture details.

Parakeet is available during onboarding (API step voice-provider selector) and in Settings, so users can adopt local STT from first-run setup without entering voice API keys.

See **[VOICE_AND_AUDIO_LOCAL](VOICE_AND_AUDIO_LOCAL.md)** for full documentation including architecture, model management, platform-specific implementation details, and troubleshooting.

#### 4. Feeding transcripts into the agent

When the renderer receives a non‑empty transcript:

- It calls `handleUserMessage(transcript, 'queue')`, which:  
  - Enqueues the message into the renderer’s message queue.  
  - Uses the queue/interrupt logic (see `ARCHITECTURE_MESSAGE_QUEUE.md`) to start or schedule an agent turn.  
- The transcript is stored as a normal user message in `messages`, and the agent turn proceeds exactly as if the user had typed the same text.

If the transcript is empty:

- The renderer restores `voiceHint` to the default, clears `isBusy`, and shows a user‑visible error (“Transcription was empty. Please try again.”).  
- A warning is logged with `mimeType` context to aid debugging.


### Voice output (text‑to‑speech) pipeline

#### 1. Deciding when to speak

The app treats TTS as an **optional enhancement**:

- The renderer can call `speakText(text)` after receiving agent responses.  
- Whether TTS is triggered may depend on UI state (e.g. voice mode toggle) or future settings (e.g. “always speak replies” vs “speak only on demand”).  
- TTS failure should never break the core agent flow; it only disables voice playback.

#### 2. IPC and TTS provider calls (preload + main)

The preload layer exposes:

- `textToSpeech(text: string): Promise<ArrayBuffer>` → `ipcRenderer.invoke('voice:text-to-speech', text)`.

The main process `voice:text-to-speech` handler:

- Normalizes settings and selects provider from `AppSettings.voice.provider`.  
- Calls `textToSpeechStream(text, settings)` in `audioService.ts`, which returns a Node `Readable` stream.  
- Subscribes to the stream:
  - On each `data` chunk (MP3 bytes), pushes into an in‑memory `Buffer[]` and sends the chunk to the renderer via `win.webContents.send('voice:tts-chunk', chunk)`.  
  - On `end`, concatenates all chunks and resolves the IPC promise with a full `ArrayBuffer`.  
  - On `error`, logs and rejects the promise with a string error message.

`audioService.textToSpeechStream`:

- For **OpenAI TTS**:  
  - `POST https://api.openai.com/v1/audio/speech` with JSON body `{ model: 'tts-1', voice, input, response_format: 'mp3' }`.  
  - Uses `responseType: 'stream'` to obtain a streaming response.  
  - Logs detailed errors, including HTTP status and any `error.message`.

- For **ElevenLabs TTS**:  
  - `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream`.  
  - Sends JSON body including `text`, `model_id` (e.g. `eleven_multilingual_v2`), and `voice_settings`.  
  - Uses `responseType: 'stream'` similarly and surfaces structured error messages.

#### 3. Playback queue and Web Audio decoding (renderer)

On the renderer side, `App.tsx` manages a simple playback queue:

- State and refs:
  - `isSpeaking` – user‑visible “agent is speaking” indicator.  
  - `audioQueueRef` – FIFO of `ArrayBuffer` audio payloads.  
  - `isPlayingRef` – tracks whether something is currently playing.  
  - `audioContextRef` – shared `AudioContext` instance.  
  - `currentAudioSourceRef` – current `AudioBufferSourceNode` for stop/pause logic.

When `speakText(text)` is called:

- It logs a debug event and awaits `window.api.textToSpeech(text)`.  
- The returned `ArrayBuffer` is pushed onto `audioQueueRef.current`.  
- `playNextAudioInQueue()` is invoked to start playback if idle.

`playNextAudioInQueue()`:

- Returns early if already playing or the queue is empty.  
- Marks `isPlayingRef.current = true` and sets `isSpeaking = true`.  
- Shifts the next `ArrayBuffer` from the queue.  
- Ensures an `AudioContext` exists, then calls `decodeAudioData` to convert the buffer into an `AudioBuffer`.  
- Creates an `AudioBufferSourceNode`, connects it to `context.destination`, and starts playback.  
- On `source.onended`:
  - Clears `currentAudioSourceRef`, resets `isPlayingRef` / `isSpeaking`, and recursively calls `playNextAudioInQueue()` to handle any queued audio.  
- On decode/play errors:
  - Logs an error with a message like “Failed to decode/play audio”.  
  - Resets flags and attempts to play the next item in the queue.

The renderer also exposes `stopCurrentSpeech()` to:

- Stop the current `AudioBufferSourceNode` if present.  
- Clear `isSpeaking`, reset `isPlayingRef`, and flush `audioQueueRef`.

#### 4. Handling TTS failures gracefully

If TTS fails at any point (IPC error, provider error, decode error):

- The renderer logs a structured error (“Text‑to‑speech failed”) with the error message.  
- The `autoSpeak` toggle may be disabled, and an error is surfaced to the user.  
- The agent conversation flow continues; only audio playback is affected.


### Permissions and platform behavior

- **Microphone permission**:
  - On macOS, the main process uses `systemPreferences.getMediaAccessStatus('microphone')` and `askForMediaAccess('microphone')`.  
  - Preload exposes `getMicrophonePermissionStatus` and `requestMicrophonePermission` via IPC.  
  - The renderer can use these to show permission banners and guide users to grant access.  
  - A helper `openSystemPreferences('microphone')` opens the appropriate System Settings pane.

- **File and workspace access**:
  - While not directly audio‑related, voice usage often assumes the agent can read/write the configured workspace.  
  - `permissions:check-file-access` verifies that the `coreDirectory` is configured and accessible, and the renderer can surface issues in the UI.

- **Non‑macOS platforms**:
  - For microphone permission checks, non‑macOS platforms are treated as “granted” by default, relying on the browser‑like permission model in the renderer.


### Configuration and settings

Voice configuration lives in `AppSettings.voice` and is normalized on load:

- **Provider**: `'openai-whisper' | 'elevenlabs-scribe'`.  
- **API keys**:  
  - `openaiApiKey: string | null`  
  - `elevenlabsApiKey: string | null`  
- **Model**:  
  - For STT, e.g. `gpt-4o-transcribe` or `scribe_v2`, chosen for best accuracy/latency trade‑off.  
- **TTS voice**:  
  - `ttsVoice: string | null` – provider‑specific voice ID/name for output speech.
- **Custom vocabulary** (OpenAI only):  
  - `transcriptionVocabulary: string[] | undefined` – list of words/phrases to hint to the STT model.  
  - Helps with proper nouns, technical terms, company names, and acronyms that are often misrecognized.  
  - Configured via Settings → Voice & Audio → Custom vocabulary (newline-separated input).  
  - When set, formatted as a prompt: `"The following terms may appear: term1, term2, ..."` and sent with the transcription request.  
  - See `rebel-system/skills/system/transcription-vocabulary-suggest/` for a skill that suggests vocabulary from memory files.

The settings UI (in `App.tsx`) reflects these fields:

- Dropdown to select provider.  
- Provider‑specific API key inputs (only the relevant key is shown).  
- Model selection limited to “best” options rather than an exhaustive list.  
- Password‑style fields for keys.

`normalizeSettings`:

- Migrates legacy single‑key fields into the new split `openaiApiKey` / `elevenlabsApiKey`.  
- Applies sensible defaults for provider and model.  
- Can auto‑select provider based on which keys are configured (e.g. prefer ElevenLabs when both keys are present).


### Session Binding for Voice Transcripts

Voice transcripts are bound to the conversation that was active when recording started, not when transcription completes. This prevents a common bug where switching conversations during transcription would send the transcript to the wrong conversation.

**How it works:**

1. **Recording start capture**: When the user starts recording (voice mode or inline mic), the current `sessionId` is captured in a `useRef` immediately before `recorder.start()`.
2. **Threading through submission**: The captured `sessionId` is passed through `submitVoicePrompt()` and `submitQueuedMessage()` as `targetSessionId`.
3. **Message queue awareness**: The `useMessageQueue` hook now accepts `targetSessionId` in options and threads it to `processMessage()`.
4. **Session validation**: `processMessage()` validates the target session exists and isn't deleted via `resolveTargetSession()`.
5. **Graceful fallback**: If the original session was deleted during transcription, the transcript falls back to the current session with a toast notification.

**Pending audio recovery** also respects session binding:
- Pending audio files store `sessionId` in the filename (format: `{timestamp}_{source}_{sessionId}.{ext}`)
- On retry, the stored `sessionId` is used to route to the correct conversation
- Legacy files without `sessionId` fall back to the current session

**Key files:**
- `useVoiceRecording.ts` — captures sessionId at recording start, passes to `submitVoicePrompt`
- `useTranscriptionMic.ts` — captures sessionId at recording start, passes to callbacks
- `useMessageQueue.ts` — accepts `targetSessionId` in `handleUserMessage` options
- `useAgentSessionEngine.ts` — `processMessage` accepts `targetSessionId`, validates via `resolveTargetSession()`
- `src/shared/ipc/channels/voice.ts` — `savePendingAudio` includes optional `sessionId`

See also: [ARCHITECTURE_MESSAGE_QUEUE.md](ARCHITECTURE_MESSAGE_QUEUE.md) for queue-level session targeting.


### Gotchas, limitations, and troubleshooting

- **Empty or low‑quality transcripts**:
  - Very short utterances, background noise, or unsupported audio formats can yield empty transcripts.  
  - The renderer treats empty transcripts as a recoverable error and asks the user to try again.

- **Latency differences between providers**:
  - OpenAI Whisper is tuned for **highest accuracy** but may have higher latency.
  - ElevenLabs Scribe is optimized for **low latency**, making it better for rapid, conversational use.

  **STT Provider Comparison:**

  | Provider | Model | Accuracy (WER) | Latency | Cost/hour | Best For |
  |----------|-------|----------------|---------|-----------|----------|
  | **OpenAI** | gpt-4o-transcribe | 2.46% | ~1600ms | $0.36 | Highest accuracy |
  | **ElevenLabs** | scribe_v2 | ~3-5% | **150ms** | $0.20-0.40 | Real-time apps |
  | **Local (Parakeet)** | Parakeet V3 | ~3-5% | **~100ms** | **Free** | Privacy, offline use |
  | **Local (Moonshine)** | Moonshine Base | ~6-7% | **~200ms** | **Free** | Cross-platform, mobile |

- **Transcription failure recovery (PendingAudioPopover)**:
  - When transcription fails, the recording is saved as an audio file (WAV when conversion is available, otherwise raw webm/ogg) and a `PendingAudioPopover` (`src/renderer/features/composer/PendingAudioPopover.tsx`) shows an indicator near the mic button.
  - Errors are classified into 5 categories (`VoiceErrorCategory`): `temporary`, `billing`, `auth`, `network`, `provider-error` — each with a plain-language explanation.
  - Actions: **Retry** (always), **Reveal file** (always), **Settings** (conditional — only for `auth`/`billing` errors).
  - Pending audio files store `sessionId` in the filename for session-bound retry routing.
  - Inline-mic recordings auto-retry in the background with increasing delays (`usePendingAudioCount.ts`); voice-mode recordings retry on reconnect/online recovery.

- **Rate limits and API errors**:
  - Both providers can return rate‑limit or auth errors; these are surfaced to the user and logged with details.  
  - If you see repeated “transcription failed” or “text‑to‑speech failed” messages, check API keys, quotas, and provider status.

- **Audio formats**:
  - The app records using `MediaRecorder` with a browser‑dependent MIME type (commonly `audio/webm`).  
  - `audioService.ts` derives a safe extension and content type; edge‑case formats may still cause provider errors, which will be logged.

- **Platform audio quirks**:
  - Web Audio behavior and microphone devices vary by platform; test on your target OS (macOS today, Windows later).  
  - If playback is silent but no error is logged, confirm output device / system volume.


### Planned and potential future work

- **Richer voice settings**:  
  - Per‑provider voice/model selection UI, presets (e.g. “fast”, “high accuracy”), and test‑voice buttons.

- **Smarter TTS triggering**:  
  - Settings to control when the agent speaks (always, only when user is in voice mode, or never).  
  - Automatic “barge‑in” behavior when the user starts speaking while the agent is talking.

- **Realtime / streaming STT**:  
  - Potential migration to true realtime streaming STT for lower latency and partial transcripts.  
  - Would require a different capture and IPC strategy (e.g. chunked audio upload).

- **Local STT improvements**: See [VOICE_AND_AUDIO_LOCAL](VOICE_AND_AUDIO_LOCAL.md#future-improvements) for planned enhancements.


### Appendix

- **Key types**:
  - `VoiceTranscriptionPayload` in `src/shared/types.ts` – IPC payload for STT.  
  - `VoiceSettings` in `src/shared/types.ts` – voice configuration stored in settings.

- **Key IPC channels**:
  - `voice:transcribe` – STT IPC handler in main.  
  - `voice:text-to-speech` – TTS IPC handler in main.  
  - `voice:tts-chunk` – streaming audio chunks from main to renderer during TTS playback.
  - `localStt:*` – Local STT model management (see [VOICE_AND_AUDIO_LOCAL](VOICE_AND_AUDIO_LOCAL.md)).

- **Programmatic vocabulary updates (MCP tools)**:
  - The `transcription-vocabulary-suggest` skill scans memory files and suggests vocabulary terms.
  - Rebel's agent can now update vocabulary programmatically via MCP tools in RebelSettings:
    - `rebel_vocabulary_get` – Returns current vocabulary array.
    - `rebel_vocabulary_update` – Add, remove, or replace vocabulary terms.
  - Actions: `add` (merge with existing, dedupe), `remove` (delete specific terms), `replace` (full replacement).
  - Guardrails: Max 200 terms, max 100 characters per term.
  - Returns a diff (`before`, `after`, `added`, `removed`) for transparency.
  - Tool safety: The update tool requires explicit user permission (enforced via Rebel's LLM-based tool safety evaluation).


