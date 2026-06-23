---
description: "ElevenLabs bundled MCP reference — API key bridge, music generation, voice and audio tools, local server architecture"
last_updated: "2026-04-11"
---

# ElevenLabs MCP

AI music generation, text-to-speech, sound effects, voice browsing, and speech-to-text.

| Field | Value |
|-------|-------|
| **Type** | Bundled (local) |
| **Provider** | Mindstone |
| **Transport** | stdio |
| **Auth** | API key (starts with `sk_`) |
| **Status** | Updated Apr 2026 (v3 model support) |

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup, discovery, and troubleshooting
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [ElevenLabs API Documentation](https://elevenlabs.io/docs/api-reference) - Official API reference
- Source code: `resources/mcp/elevenlabs/`


## Overview

The ElevenLabs MCP integrates with [ElevenLabs](https://elevenlabs.io) to provide a full audio suite directly from Rebel. The main capability is **AI music generation** — compose original music from text prompts with full composition control. Also includes text-to-speech, sound effects, voice browsing, and speech-to-text.

**Key capabilities:**
- Generate music from text prompts (3s to 10 minutes)
- Create free composition plans for fine-tuned control
- Text-to-speech with 1000+ voices and voice search
- Sound effect generation from text descriptions
- Speech-to-text transcription from audio files
- API key configuration via bridge


## Connector Catalog Entry

```json
{
  "id": "bundled-elevenlabs",
  "name": "ElevenLabs",
  "category": "media",
  "provider": "bundled",
  "bundledConfig": {
    "authType": "api-key",
    "settingsKey": "elevenlabs.enabled",
    "serverName": "ElevenLabs",
    "setupToolName": "configure_elevenlabs_api_key"
  },
  "icon": "music"
}
```


## Architecture

```
resources/mcp/elevenlabs/
├── src/
│   └── index.ts          # MCP server, tools, and ElevenLabs API client
├── package.json
├── tsconfig.json
└── build/                # Compiled JS (gitignored)
```

Single-file architecture using:
- `@modelcontextprotocol/sdk` for MCP server implementation
- Direct ElevenLabs REST API integration
- Bridge pattern for credential persistence (same as Kling/Runway)


## Authentication

1. User gets an API key from [ElevenLabs Settings](https://elevenlabs.io/app/settings/api-keys)
2. Key starts with `sk_`
3. Provides key to Rebel via Settings UI or `configure_elevenlabs_api_key` tool
4. All API calls use `xi-api-key` header

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ELEVENLABS_API_KEY` | Yes | ElevenLabs API key (starts with `sk_`) |
| `MINDSTONE_REBEL_BRIDGE_STATE` | Auto | Bridge state file path (set by Rebel) |


## Tools Reference (8 tools)

### Music Generation

#### `generate_music`
Generate music from a text prompt. Returns a local file path.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| prompt | string | Yes | - | Music description (genre, mood, instruments, style) |
| duration_seconds | number | No | 30 | Duration 3-600 seconds |
| force_instrumental | boolean | No | false | Force no vocals |
| output_format | string | No | mp3_44100_128 | Audio format |
| seed | integer | No | - | Random seed for reproducibility |

#### `create_music_plan`
Create a composition plan — **FREE, no credits consumed**.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| prompt | string | Yes | - | Music description |
| duration_seconds | number | No | 30 | Target duration |

Returns a structured plan with sections, styles, and lyrics that can be edited before generation.

#### `generate_music_from_plan`
Generate music from a composition plan.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| composition_plan | object | Yes | - | Plan from create_music_plan or manually crafted |
| seed | integer | No | - | Random seed |
| output_format | string | No | mp3_44100_128 | Audio format |

### Text-to-Speech

#### `generate_speech`
Generate spoken audio from text.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| text | string | Yes | - | Text to speak (max ~5000 chars) |
| voice_id | string | No | - | Direct voice ID |
| voice_name | string | No | Rachel | Voice name for fuzzy search |
| model_id | string | No | eleven_v3 | TTS model (eleven_v3, eleven_multilingual_v2, eleven_flash_v2_5) |
| stability | number | No | 0.5 | Voice stability (0-1) |
| similarity_boost | number | No | 0.75 | Voice similarity (0-1) |

### Sound Effects

#### `generate_sound_effect`
Generate sound effects from text.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| prompt | string | Yes | - | Sound effect description |
| duration_seconds | number | No | auto | Duration 0.5-22 seconds |
| prompt_influence | number | No | 0.3 | Prompt adherence (0-1) |

### Voice Management

#### `list_voices`
Search and browse voices — **FREE, no credits consumed**.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| search | string | No | - | Search query |
| category | string | No | - | premade, cloned, generated, professional |
| page_size | integer | No | 20 | Results per page (1-100) |

### Speech-to-Text

#### `transcribe_audio`
Transcribe speech from an audio file.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| file_path | string | Yes | - | Absolute path to audio file |
| language_code | string | No | auto | Language code (en, es, fr, etc.) |

### Configuration

#### `configure_elevenlabs_api_key`
Save API key via bridge.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| api_key | string | Yes | ElevenLabs API key (starts with `sk_`) |


## Usage Examples

**Generate music:**
```
Compose a 30-second lo-fi hip hop beat with soft piano and vinyl crackle
```

**Plan → generate workflow:**
```
Create a music plan for a 60-second cinematic score that builds from soft to epic
```
→ Review plan → "Generate from this plan, but change the second section to use strings instead of brass"

**Text-to-speech:**
```
Generate speech saying "Welcome to the future of AI" using a warm, professional voice
```

**Sound effects:**
```
Create the sound of rain on a tin roof for 10 seconds
```

**Voice search:**
```
Find voices that sound British and professional
```

**Transcription:**
```
Transcribe the audio from ~/Downloads/meeting-recording.mp3
```


## Setup Flow

1. Go to **Settings → Connectors** → Find **ElevenLabs**
2. Click **"Set up"**
3. Navigate to [https://elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys)
4. Create and copy an API key (starts with `sk_`)
5. Paste the key and click **Connect**

**Free tier:** 10,000 characters/month for TTS. Music generation requires a paid plan.


## Technical Details

- **Type**: Bundled MCP (maintained by Mindstone)
- **Transport**: stdio (runs as subprocess)
- **Server script**: `resources/mcp/elevenlabs/build/index.js`
- **API Base**: `https://api.elevenlabs.io/v1`
- **SDK**: `@modelcontextprotocol/sdk` v1.0.0
- **No external dependencies** beyond the MCP SDK and Node.js built-ins

### Credits System

ElevenLabs uses a credit-based system:
- **Music generation**: Credits based on duration
- **TTS**: ~1 credit per 100 characters
- **Sound effects**: Credits based on duration
- **Voice browsing**: FREE
- **Music plan creation**: FREE
- Check usage at [ElevenLabs Usage](https://elevenlabs.io/app/usage)


## Troubleshooting

### "ElevenLabs API key not configured"
Get a key from [https://elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys) and configure in Settings.

### "Authentication failed" / HTTP 401
Invalid or expired API key. Regenerate at the ElevenLabs settings page.

### "Insufficient credits" / HTTP 403
Quota exceeded. Check usage at [https://elevenlabs.io/app/usage](https://elevenlabs.io/app/usage).

### "Missing permissions" for music generation
Your API key needs the `music_generation` permission. Create a new key with the correct scopes.

### "No voice found matching..."
The voice name didn't match any voices. Use `list_voices` to browse available voices and get exact IDs.

### Rate limiting (HTTP 429)
Too many requests. Wait a moment and retry.


## Migration from Community MCP

This bundled MCP replaces the previous community Python MCP (`uvx elevenlabs-mcp`). Key differences:
- **No Python required** — runs in Node.js
- **Music generation** — new capability not in the community MCP
- **Focused tool set** — 8 tools vs 24 (removed conversational AI agent management tools)
- **Same API key** — uses the same `ELEVENLABS_API_KEY` env var
