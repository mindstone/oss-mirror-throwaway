---
description: "Kling AI MCP connector for video generation — text-to-video, image-to-video, dual-key auth, local bundled architecture"
last_updated: "2026-01-16"
---

# Kling MCP

AI-powered video generation from text prompts and images.

| Field | Value |
|-------|-------|
| **Type** | Bundled (local) |
| **Provider** | Mindstone |
| **Transport** | stdio |
| **Auth** | API key pair (Access Key + Secret Key) |
| **Status** | Tested Dec 2024 |

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup, discovery, and troubleshooting
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Kling AI API Documentation](https://app.klingai.com/global/dev/document-api) - Official API reference
- Source code: `resources/mcp/kling/`


## Overview

The Kling MCP integrates with [Kling AI](https://klingai.com) to generate high-quality AI videos directly from Rebel. Users can create videos from text descriptions or animate existing images.

**Key capabilities:**
- Generate videos from text prompts (text-to-video)
- Animate images with motion (image-to-video)
- Multiple model versions and quality modes
- Configurable aspect ratios and durations
- Credit balance checking


## Connector Catalog Entry

```json
{
  "id": "bundled-kling",
  "name": "Kling AI",
  "description": "AI video generation. Create videos from text prompts or images. Animate still images with motion. Credit-based API.",
  "category": "media",
  "provider": "bundled",
  "bundledConfig": {
    "authType": "api-key",
    "settingsKey": "kling.enabled",
    "serverName": "Kling"
  },
  "icon": "video",
  "popular": false
}
```


## Architecture

```
resources/mcp/kling/
├── src/
│   └── index.ts          # MCP server, tools, and Kling API client
├── package.json
├── tsconfig.json
└── build/                # Compiled JS (gitignored)
```

The Kling MCP uses a single-file architecture with:
- `@modelcontextprotocol/sdk` for MCP server implementation
- `jose` library for JWT token generation
- Direct Kling REST API integration


## Authentication

### API Key Setup

Kling uses a dual-key authentication system (Access Key + Secret Key):

1. User navigates to [Kling AI Developer Console](https://app.klingai.com/global/dev/api-key)
2. Creates a new API key pair
3. Copies **both** the Access Key and Secret Key
4. Provides both keys to Rebel via Settings UI
5. MCP generates JWT tokens using these keys for API authentication

### JWT Token Generation

The MCP generates JWT tokens internally:
- Tokens are signed using HS256 algorithm
- Valid for 30 minutes (1800 seconds)
- Cached and reused until near expiry (60s buffer)
- Automatically refreshed on subsequent requests


## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KLING_ACCESS_KEY` | Yes | Kling API access key (starts with `ak_`) |
| `KLING_SECRET_KEY` | Yes | Kling API secret key (starts with `sk_`) |


## Tools Reference

### Video Generation

#### `generate_kling_video`
Generate a video from a text prompt. Returns a task_id immediately for status polling.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| prompt | string | Yes | - | Text description of the video (max 2500 chars) |
| negative_prompt | string | No | - | What to avoid in the video |
| model | string | No | 'kling-v2-master' | Model version |
| aspect_ratio | string | No | '16:9' | `16:9`, `9:16`, or `1:1` |
| duration | string | No | '5' | `5` or `10` seconds |
| mode | string | No | 'standard' | `standard` or `professional` |
| cfg_scale | number | No | 0.5 | Prompt adherence 0-1 (0=creative, 1=strict) |

**Models:**
| Model | Description |
|-------|-------------|
| `kling-v2-master` | Latest, highest quality (default) |
| `kling-v1.6` | Fast, good quality |
| `kling-v1.5` | Balanced |
| `kling-v1` | Original model |

**Example request:**
```json
{
  "prompt": "A golden retriever playing in autumn leaves, cinematic lighting, slow motion",
  "aspect_ratio": "16:9",
  "duration": "5",
  "mode": "professional"
}
```

**Example response:**
```json
{
  "ok": true,
  "task_id": "task_abc123xyz",
  "status": "submitted",
  "message": "Video generation started. Use check_kling_task with task_id \"task_abc123xyz\" to poll for completion (typically 2-5 minutes).",
  "nextPollSeconds": 30
}
```

#### `generate_kling_image_to_video`
Transform an image into a video. The image must be a publicly accessible HTTPS URL.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| image_url | string | Yes | - | HTTPS URL of source image |
| prompt | string | Yes | - | Description of desired motion |
| negative_prompt | string | No | - | What to avoid |
| model | string | No | 'kling-v2-master' | Model version |
| duration | string | No | '5' | `5` or `10` seconds |
| mode | string | No | 'standard' | `standard` or `professional` |
| cfg_scale | number | No | 0.5 | Prompt adherence 0-1 |

**Example request:**
```json
{
  "image_url": "https://example.com/landscape.jpg",
  "prompt": "Camera slowly pans across the scene, clouds drift by, gentle wind moves the grass"
}
```

**Example response:**
```json
{
  "ok": true,
  "task_id": "task_xyz789abc",
  "status": "submitted",
  "message": "Image-to-video generation started. Use check_kling_task with task_id \"task_xyz789abc\" to poll for completion.",
  "nextPollSeconds": 30
}
```

### Status Checking

#### `check_kling_task`
Check the status of a video generation task.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| task_id | string | Yes | Task ID from generation tools |

**Status values:**
| Status | Description |
|--------|-------------|
| `submitted` | Task received, queued |
| `processing` | Generation in progress |
| `succeed` | Complete - video URL available |
| `failed` | Error occurred |

**Example response (processing):**
```json
{
  "ok": true,
  "task_id": "task_abc123xyz",
  "status": "processing",
  "nextPollSeconds": 20,
  "hint": "Still processing. Poll again in 20 seconds."
}
```

**Example response (complete):**
```json
{
  "ok": true,
  "task_id": "task_abc123xyz",
  "status": "succeed",
  "video": {
    "url": "https://cdn.klingai.com/...",
    "duration": "5",
    "aspect_ratio": "16:9"
  },
  "hint": "Video generation complete! URL is valid for 30 days."
}
```

### Account Management

#### `get_kling_balance`
Check your Kling AI credit balance and active resource packages.

**Parameters:** None

**Example response:**
```json
{
  "ok": true,
  "balance": 1500,
  "packages": [
    {
      "name": "Starter Pack",
      "amount": 1000,
      "expire_at": "2025-06-01T00:00:00Z"
    }
  ],
  "summary": "Kling AI Balance: 1500 credits\n\nResource Packages:\n- Starter Pack: 1000 credits (expires 6/1/2025)\n\nApproximate costs: 5s standard ~100 credits, 5s professional ~200 credits"
}
```


## Usage Examples

**Generate a text-to-video:**
```
Create a 5-second video of a sunset over the ocean with waves crashing on rocks
```

**Animate an image:**
```
Turn this image into a video where the camera slowly zooms in and the leaves sway in the wind
```

**Professional quality video:**
```
Generate a 10-second professional quality video of a futuristic city at night with flying cars and neon lights
```

**Check task status:**
```
What's the status of my Kling video generation?
```

**Check credits:**
```
How many Kling credits do I have left?
```


## Setup Flow

1. Go to **Settings → Connectors** → Find **Kling AI**
2. Click **"Set up"** to open the configuration form
3. Navigate to [https://app.klingai.com/global/dev/api-key](https://app.klingai.com/global/dev/api-key) to create an API key
4. Copy both the **Access Key** and **Secret Key**
5. Paste both keys into the respective input fields
6. Click **Connect** - Rebel saves and activates the connection

**Important:** You need BOTH keys. The Access Key identifies your account; the Secret Key signs the JWT tokens for authentication.


## Technical Details

- **Type**: Bundled MCP (maintained by Mindstone)
- **Transport**: stdio (runs as subprocess)
- **Server script**: `resources/mcp/kling/build/index.js`
- **API Base**: `https://api.klingai.com/v1`
- **SDK**: Uses `@modelcontextprotocol/sdk` v1.0.0
- **JWT Library**: `jose` v5.2.0

### Credits System

Kling uses a credit-based system:
- **5s standard video**: ~100 credits
- **5s professional video**: ~200 credits
- **10s videos**: ~2x the 5s cost
- Check balance at [Kling Developer Console](https://app.klingai.com/global/dev/billing)


## Known Limitations

1. **Async generation**: Video generation takes 2-5 minutes. Users must poll with `check_kling_task` to check completion.

2. **Credit-based**: Each generation consumes credits. Users need sufficient credits in their Kling account.

3. **Public URLs for image-to-video**: Kling requires publicly accessible HTTPS URLs for source images. Local files must be uploaded to a hosting service first.

4. **30-day video retention**: Generated video URLs expire after 30 days.

5. **Rate limiting**: Subject to Kling API rate limits. The MCP handles 429 responses with retry guidance.

6. **No video editing**: The MCP creates new videos only. Editing requires using Kling's web interface.


## Troubleshooting

### "Kling API credentials not configured"
**Cause:** Access Key or Secret Key not set up.
**Solution:** 
1. Get both keys from [https://app.klingai.com/global/dev/api-key](https://app.klingai.com/global/dev/api-key)
2. Configure both in Settings → Connectors → Kling AI

### "KLING_ACCESS_KEY and KLING_SECRET_KEY must be set"
**Cause:** One or both API keys are missing.
**Solution:** Ensure you've provided BOTH the Access Key and Secret Key in Settings.

### "Kling API error (401)" or authentication errors
**Cause:** Invalid or expired API keys.
**Solution:** 
1. Verify your API keys at the Kling Developer Console
2. Regenerate the keys if needed
3. Reconfigure in Settings → Connectors → Kling AI

### "Rate limited by Kling API"
**Cause:** Too many requests in a short time.
**Solution:** Wait the specified time (shown in error) before retrying.

### "Image URL must use HTTPS"
**Cause:** Attempted image-to-video with a non-HTTPS URL.
**Solution:** 
1. Upload your image to a hosting service (Imgur, your server, etc.)
2. Use the HTTPS URL from the hosting service

### "Insufficient credits" or balance errors
**Cause:** Not enough credits for the requested generation.
**Solution:** Purchase more credits at [https://app.klingai.com/global/dev/billing](https://app.klingai.com/global/dev/billing)

### "Content policy violation"
**Cause:** Prompt contains content that violates Kling's usage policies.
**Solution:** Revise your prompt to remove sensitive or prohibited content.

### Generation stuck on "processing"
**Cause:** Long generation time or API issue.
**Solution:**
1. Wait and poll again (complex videos may take 5+ minutes)
2. If stuck for more than 10 minutes, try a new generation
3. Try a shorter duration or standard mode for faster results


## Common Use Cases

- **Social media content**: "Create a 10-second video loop of abstract particles for my Instagram"
- **Product visualization**: "Generate a video showing a smartphone rotating on a gradient background"
- **Concept visualization**: "Create a video of my character design walking through a forest"
- **B-roll footage**: "Make a 5-second video of rain falling on a window with soft focus"
- **Marketing materials**: "Generate a professional video of text revealing 'Coming Soon' with dramatic lighting"


## Image-to-Video Workflow

For animating images generated by other tools (OpenAI, Gemini):

1. **Generate the image** using OpenAI Image Generation or similar tool
2. **Save to disk** using the `save_path` parameter if available
3. **Upload to hosting** (Imgur, your own server, cloud storage with public URLs)
4. **Use the HTTPS URL** with `generate_kling_image_to_video`

Example workflow:
```
1. Create an image of a serene mountain lake at sunset
2. [User uploads to hosting service]
3. Now animate this image: https://example.com/my-lake-image.jpg 
   - Make the water ripple gently, clouds drift slowly, and birds fly across the sky
```


## References

- [Kling AI Website](https://klingai.com)
- [Kling AI Developer Console](https://app.klingai.com/global/dev)
- [Kling API Documentation](https://app.klingai.com/global/dev/document-api)
- [API Key Management](https://app.klingai.com/global/dev/api-key)
- [Billing & Credits](https://app.klingai.com/global/dev/billing)
