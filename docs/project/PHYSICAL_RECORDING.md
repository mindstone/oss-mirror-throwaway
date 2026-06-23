---
description: "Physical recording architecture overview — Limitless BLE, Plaud cloud sync, transcript routing, settings, file format"
last_updated: "2026-01-18"
---

# Physical Recording

Physical recording captures in-person meetings and conversations using dedicated hardware devices. This is a third recording path alongside Meeting Bot (cloud) and Local Recording (Desktop SDK).

## See Also

- [VOICE_AND_AUDIO](VOICE_AND_AUDIO.md) - Voice input/output pipeline (STT/TTS) for Rebel's conversational interface
- [MEETING_BOT](MEETING_BOT.md) - Cloud bot for online meetings (Zoom/Meet/Teams)
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) - Session model and transcript storage
- [SPACES](SPACES.md) - Memory spaces where transcripts are saved

### Implementation Plans (Detailed)

- `../plans/260111_limitless_pendant_integration.md` - Limitless BLE integration plan (architecture, protocol, phases)
- `../plans/260113_plaud_integration_plan.md` - Plaud OAuth/cloud sync plan (API, sync service, skill processing)

> **Note**: The plans contain extensive implementation detail and research findings. This doc provides the high-level overview; see the plans for protocol specifics, API responses, and phase-by-phase implementation notes.


## The Three Recording Paths

| Path | When | Audio Source | Transcription |
|------|------|--------------|---------------|
| **Meeting Bot** | Online meetings with bot | Bot captures server-side | Recall.ai (diarization) |
| **Local Recording** | Online meetings, no bot | Desktop SDK system audio | Recall.ai (diarization) |
| **Physical Recording** | In-person meetings | BLE device or cloud sync | Whisper API (no diarization) |

Physical recordings produce single-speaker transcripts (no diarization) because they capture one mixed audio stream from the room, unlike online meetings where each participant has a discrete audio stream.


## Supported Devices

### Limitless Pendant (BLE Real-Time)

Direct Bluetooth Low Energy connection for real-time audio streaming.

**Data flow:**
```
Device → BLE → Opus decode → WAV → Whisper API → Markdown → Memory Space
```

**Key characteristics:**
- Real-time audio streaming during recording
- Button press triggers start/stop (detected by Rebel)
- Battery level and connection status visible in UI
- Auto-reconnect on app startup if previously paired

**Key files:**
- `src/main/services/physicalRecording/physicalRecordingService.ts` - BLE connection, audio capture
- `src/main/services/physicalRecording/transcriptionService.ts` - Whisper transcription with chunking
- `src/main/services/physicalRecording/storageService.ts` - Frontmatter generation, file save
- `src/main/ipc/physicalRecordingHandlers.ts` - IPC handlers (scan, connect, start/stop)


### Plaud (OAuth Cloud Sync)

Cloud-based sync via OAuth API. User records on device, syncs via Plaud mobile app, then Rebel pulls from cloud.

**Data flow:**
```
Device → Plaud App → Cloud → OAuth API → MP3 → Whisper API → Markdown → Memory Space
```

**Key characteristics:**
- Polling-based sync (default: every 15 minutes)
- OAuth authentication via Cloudflare Worker callback
- LLM-generated smart titles from transcript content
- Resilience patterns: interruption handling, retry logic, auth failure throttling

**Key files:**
- `src/main/services/plaud/plaudAuthService.ts` - OAuth flow, token management
- `src/main/services/plaud/plaudSyncService.ts` - Periodic sync, staging, processing
- `src/main/services/plaud/plaudApiClient.ts` - Plaud API calls
- `src/main/ipc/plaudHandlers.ts` - IPC handlers (connect, disconnect, sync)


## Settings and Configuration

Physical recording devices are configured in **Settings → Meetings → Voice Recorders**.

### Transcript Routing

Both device types route transcripts to the same destination:
- Setting: `meetingBot.physicalMeetingSpaceId`
- Default: Falls back to Chief of Staff space
- File location: `{space}/memory/sources/YYYY/MM-MMM/DD/`

### Device-Specific Settings

**Limitless:**
- `meetingBot.limitless.lastConnectedDeviceId` - For auto-reconnect
- `meetingBot.limitless.autoConnectEnabled` - Auto-connect on startup (default: true)

**Plaud:**
- `meetingBot.plaud.enabled` - Whether Plaud sync is active
- `meetingBot.plaud.userEmail` - Connected Plaud account
- `meetingBot.plaud.autoSyncIntervalMinutes` - Polling interval (default: 15)


## File Format

Both device types produce identical file formats for unified downstream processing.

### Filename Convention

```
yyMMdd_HHmm_meeting_{provider}_{smart-title}.md
```

Examples:
- `260111_1437_meeting_limitless_team-standup.md`
- `260113_0900_meeting_plaud_q1-budget-review.md`

### Frontmatter Schema

```yaml
---
description: "Q1 Budget Review with Finance Team"
source_type: meeting
source_system: limitless | plaud
source_account: user@example.com
source_uid: plaud_9a9a6b023e2400eada525d1c6b2db4cb
source_url: "urn:limitless:recording:..." | "urn:plaud:recording:..."
occurred_at: 2026-01-11
stored_at: 2026-01-13
duration_minutes: 45
device: "Limitless Pendant" | "Plaud NotePin"
review_status: pending
---
```


## Status and UI Integration

### Meeting Status Indicator

Physical recording states integrate with the unified `MeetingStatusIndicator`:
- `recording_physical` - Active recording (high precedence, takes over indicator)
- `transcribing_physical` - Post-recording processing (low precedence)
- `done_physical` - Successfully saved

### Physical Recording Indicator

When Limitless is connected but not recording, a separate `PhysicalRecordingIndicator` shows:
- Device name and battery level
- "Record" button to start manually

This avoids precedence conflicts with meeting previews (e.g., "Meeting in 5 minutes").


## Known Limitations

1. **No speaker diarization** - Physical recordings produce single-speaker transcripts
2. **macOS only (v1)** - Windows BLE support deferred to v2
3. **Single device** - Only one Limitless device can be paired at a time
4. **Plaud cloud-only** - Cannot access Plaud devices directly (BLE requires server-issued bind token)


## Troubleshooting

### Limitless Not Connecting

1. Ensure Bluetooth is enabled in System Settings
2. Factory reset the pendant if BLE connection fails repeatedly
3. Check logs: `grep "physical-recording" ~/Library/Application\ Support/mindstone-rebel/logs/*.log`

### Plaud Sync Not Working

1. Verify OAuth connection in Settings → Meetings
2. Check if recordings are synced to Plaud cloud (via Plaud mobile app)
3. Manual "Sync Now" button triggers immediate sync
4. Check logs: `grep "plaud" ~/Library/Application\ Support/mindstone-rebel/logs/*.log`

### Transcription Failures

- Verify OpenAI API key is configured (used for Whisper)
- For long recordings (>25MB), transcription is chunked automatically
- Check `transcriptionService.ts` logs for specific errors
