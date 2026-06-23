---
description: "On-device STT architecture: Parakeet V3 (desktop), Moonshine Base (desktop + mobile)"
last_updated: "2026-04-08"
---

# Local Speech-to-Text

On-device speech recognition providing instant transcription without sending audio to the cloud.

Two local STT providers are available:

| Provider | Platforms | Model | Size | Use Case |
|----------|-----------|-------|------|----------|
| **Parakeet V3** | macOS, Windows | NVIDIA Parakeet TDT 0.6B | ~482-670 MB | Desktop default, CoreML on macOS |
| **Moonshine Base** | macOS, Windows, iOS, Android | Moonshine Base ONNX | ~251 MB (desktop), ~429 MB (mobile) | Cross-platform, mobile-first |

Users select their provider in Settings → Agents & Voice. Both providers are local-only — no API keys required.


## See Also

- [VOICE_AND_AUDIO](VOICE_AND_AUDIO.md) — Parent doc covering all voice/audio: STT, TTS, permissions, playback
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — Voice provider configuration in `AppSettings.voice`
- `src/main/services/localSttService.ts` — Transcription logic, audio conversion, platform dispatch
- `src/main/services/localSttModelManager.ts` — Model download, verification, status tracking
- `src/main/ipc/localSttHandlers.ts` — IPC handlers for model management
- `resources/local-stt/README.md` — Binary build instructions and packaging details
- `docs/plans/obsolete/260109_local_stt_integration.md` — Original planning doc with research and decisions


## Principles and Key Decisions

- **Privacy-first**: Audio never leaves the device; no API keys required
- **Platform-specific backends**: CoreML on macOS (Apple Neural Engine), ONNX Runtime on Windows
- **Models downloaded on-demand**: ~500-700MB download, not bundled with app
- **Pure JavaScript audio conversion**: No ffmpeg dependency (uses `audio-decode` + `wav-encoder`)
- **Graceful degradation**: Failures show clear errors, don't crash app, suggest cloud alternatives
- **Opt-in provider with first-run availability**: Can be selected during onboarding or later in Settings; doesn't require voice API keys


## Platform Support

| Platform | Backend | Status |
|----------|---------|--------|
| **macOS** | FluidAudio CLI (CoreML) | Supported |
| **Windows** | sherpa-onnx-node (ONNX Runtime) | Supported |
| **Linux** | — | Not yet (shows "coming soon") |


## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Renderer                                                        │
│  MediaRecorder → OGG Opus audio → IPC voice:transcribe          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Main Process (localSttService.ts)                               │
│                                                                 │
│  1. convertToWav() - audio-decode + wav-encoder (pure JS)       │
│     OGG Opus → mono 16kHz 16-bit PCM WAV                        │
│                                                                 │
│  2. Platform dispatch:                                          │
│     ├─ macOS: spawn fluidaudiocli → CoreML inference            │
│     └─ Windows: sherpa-onnx-node → ONNX Runtime inference       │
│                                                                 │
│  3. Return transcript text                                      │
└─────────────────────────────────────────────────────────────────┘
```


## Model Management

Models are downloaded from HuggingFace on first use:

| Platform | Repository | Size |
|----------|------------|------|
| macOS | `FluidInference/parakeet-tdt-0.6b-v3-coreml` | ~482 MB |
| Windows | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` | ~670 MB |

**Download features:**
- Progress shown in Settings UI
- SHA256 checksum verification for large weight files
- Atomic downloads (`.downloading` temp files) prevent corruption
- Redirect handling for HuggingFace LFS URLs
- Models stored in `{userData}/models/`

**IPC channels:**
- `localStt:get-status` — Check if model is installed/downloading
- `localStt:start-download` — Begin download with progress events
- `localStt:cancel-download` — Cancel in-progress download
- `localStt:remove-model` — Delete downloaded model files


## macOS Implementation (CoreML)

Uses [FluidAudio](https://github.com/FluidInference/FluidAudio), an open-source Swift SDK that wraps Apple's CoreML framework.

**Binary:** `fluidaudiocli-darwin`
- Universal (arm64 + x64)
- Bundled in `resources/local-stt/` (committed to git)
- Copied to `{app}/Resources/fluidaudiocli` during packaging
- Signed automatically during afterSign hook

**Invocation:**
```bash
fluidaudiocli transcribe /path/to/audio.wav
# Returns JSON: {"text": "transcribed text", "confidence": 0.95}
```

**Timeout:** 30 seconds (prevents hangs)


## Windows Implementation (ONNX)

Uses `sherpa-onnx-node` npm package with native ONNX Runtime bindings.

**Packaging:**
- `sherpa-onnx-node` and `sherpa-onnx-win-x64` copied to `app.asar.unpacked`
- Handled by `forge.config.cjs` Step 5d

**API usage:**
```typescript
const sherpa = await import('sherpa-onnx-node');
const recognizer = new sherpa.OfflineRecognizer(config);
const stream = recognizer.createStream();
stream.acceptWaveform({ samples, sampleRate });
recognizer.decode(stream);
const result = recognizer.getResult(stream);
```

**Known limitation:** Decode is synchronous — can freeze UI briefly for long audio. Future improvement: move to Worker Thread.


## Audio Conversion Pipeline

Browser records as OGG Opus (preferred) or WebM Opus. Main process converts to WAV:

1. **Decode**: `audio-decode` handles OGG/WebM/MP3/WAV
2. **Mix to mono**: Average channels if stereo
3. **Resample**: Linear interpolation to 16kHz
4. **Encode**: `wav-encoder` outputs 16-bit PCM WAV

No ffmpeg dependency required.


## Error Handling

| Scenario | Behavior |
|----------|----------|
| Model not installed | Clear error directing user to Settings |
| Native module load failure (Windows) | Suggests using cloud provider |
| Download failure | Progress UI shows error, allows retry |
| Transcription timeout (macOS) | Returns error after 30s, doesn't hang |
| Network error during download | Partial files cleaned up, can retry |


## Performance

| Metric | Value |
|--------|-------|
| First-run download | 2-5 minutes (one-time) |
| Cold start | ~1 second to load model |
| Transcription speed | ~0.1x real-time on Apple Silicon |
| Memory usage | ~70-80 MB after model cached |


## Limitations

- **No custom vocabulary**: Unlike OpenAI Whisper's prompt parameter
- **No streaming/partial transcripts**: Batch mode only
- **Windows UI freeze**: Synchronous decode blocks main thread
- **Quality variance**: May struggle with accents, background noise, technical jargon
- **No Linux support**: Would require sherpa-onnx integration


---

## Moonshine Base (Cross-Platform ONNX)

Second local STT provider, using [Moonshine](https://github.com/usefulsensors/moonshine) by Useful Sensors. Purpose-built for edge/mobile inference with native iOS and Android SDKs. On desktop, runs via `onnxruntime-node`.

### Desktop Implementation (ONNX Runtime)

- `src/main/services/moonshineTranscriber.ts` — Full ONNX inference pipeline: encoder → autoregressive decoder with KV cache → greedy token decoding
- Same `localSttModelManager.ts` handles download/status/verification (parameterized with `modelId`)
- Model: `onnx-community/moonshine-base-ONNX` from HuggingFace (~251 MB)
- SHA-256 checksums pinned for all model files
- Lazy model loading: ONNX sessions created on first use, cached for subsequent calls
- Repetition guard: stops generation if same token repeats 3+ times consecutively
- Promise coalescing: concurrent first-use transcriptions share the same loading promise

### Mobile Implementation (Expo Native Module)

- `mobile/modules/moonshine-stt/` — Expo native module wrapping Moonshine's platform SDKs
- **iOS**: MoonshineVoice via SPM (`moonshine-ai/moonshine-swift`), `AVAudioConverter` for M4A→16kHz PCM, `DispatchQueue.global` for background inference, `NSLock` for thread safety, `OnAppMemoryWarning` unloads model
- **Android**: `ai.moonshine:voice` Maven dependency, `MediaExtractor`+`MediaCodec` for audio decoding, linear interpolation resampling, `Dispatchers.Default` for background work
- Model download: `mobile/src/hooks/useMobileModelDownload.ts` — staging/resume/size-verification/cellular-warning
- Provider toggle: `MobileModelDownloadCard.tsx` with Switch to enable on-device transcription
- Voice preference stored in AsyncStorage (device-local, NOT synced to cloud/desktop)

### Mobile Crash Containment

- `mobile/src/utils/localSttCrashGuard.ts` — AsyncStorage-based crash detection
- Marks inference start/complete; stale flag on mount = app crashed during inference
- `markInferenceFailed()` clears flag without incrementing counter (handles JS-level errors)
- After 3 consecutive process crashes: auto-disables local STT, switches to cloud
- `resetCrashState()` called when user re-enables local STT or re-downloads model

### Model Files

**Desktop** (from `onnx-community/moonshine-base-ONNX`):
- `encoder_model.onnx` (80.8 MB)
- `decoder_model_merged.onnx` (166.2 MB)
- `tokenizer.json` (3.8 MB)
- `config.json` (922 B)

**Mobile** (from `download.moonshine.ai`):
- `encoder.ort`, `decoder_kv.ort`, `frontend.ort`, `adapter.ort`, `cross_kv.ort`, `decoder_kv_with_attention.ort`, `streaming_config.json`, `tokenizer.bin` (~429 MB total)

---

## Shared Infrastructure

### isLocalProvider() Helper

`src/shared/utils/voiceProviderUtils.ts` — Used across the codebase to guard cloud-only code paths. Returns true for both `local-parakeet` and `local-moonshine`. When adding a new local provider, update this function.

### Model Manager Parameterization

`localSttModelManager.ts` methods accept optional `modelId` parameter (defaults to `'parakeet-v3'`). Per-model download state tracked via `Map<string, DownloadState>`. Progress events include `modelId` for UI filtering.

### IPC Channels

All `localStt:*` channels accept optional `{ modelId: string }` parameter. Backward-compatible: old callers without modelId default to Parakeet.


## Future Improvements

- Linux support (likely sherpa-onnx like Windows)
- Windows timeout/cancellation via Worker Thread
- Higher-quality resampling (Lanczos/polyphase vs linear)
