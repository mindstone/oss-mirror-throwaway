---
description: "OpenAI Image Generation MCP connector — gpt-image-2 generation/editing, workspace file output, provider-key auth, tools, limits"
last_updated: "2026-05-19"
---

# OpenAI Image Generation MCP

AI-powered image generation using OpenAI's gpt-image-2 model.

| Field | Value |
|-------|-------|
| **Type** | rebel-oss managed connector |
| **Provider** | `@mindstone/mcp-server-openai-image@0.1.0` |
| **Transport** | stdio |
| **Auth** | `providerKeys.openai` → `OPENAI_API_KEY` via `providerKeyMapping` |
| **Status** | Stage 2a lifecycle cleanup (generic provider-key rotation handler) |

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup, discovery, and troubleshooting
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [OpenAI Images API Documentation](https://platform.openai.com/docs/guides/images) - Official API reference
- Package source: [github.com/mindstone/mcp-servers/tree/main/connectors/openai-image](https://github.com/mindstone/mcp-servers/tree/main/connectors/openai-image) (published as `@mindstone/mcp-server-openai-image@0.1.0`)


## Overview

The OpenAI Image Generation MCP enables Rebel to create new images and edit existing workspace images using OpenAI's gpt-image-2 model (launched 2026-04-21). Generated and edited images are automatically saved to your workspace for easy access and reference.

As of the OSS migration path, this connector is treated as a `rebel-oss` package (`@mindstone/mcp-server-openai-image@0.1.0`) and picks up provider-key rotation through the generic `settings:update` lifecycle handler rather than an OpenAI-specific re-registration branch.

**Key capabilities:**
- Sharp text rendering, including non-Latin scripts and multilingual copy
- Better realism and detail fidelity than the prior generation
- Configurable quality levels (`low`, `medium`, `high`, `auto`) — defaults to `high`
- Content-moderation strictness parameter (`auto` or `low`)
- Square, portrait, and landscape size presets (1024² / 1024×1536 / 1536×1024)
- Multi-image batching via `count: 1-8` (each image billed separately)
- Automatic saving of generated and edited files to your workspace

**Supported on the API but not yet exposed by this tool:**
- 2K-resolution presets — planned
- Aspect ratios up to 3:1 (this tool currently ships fixed presets only)


## Architecture

- Runtime package: `@mindstone/mcp-server-openai-image@0.1.0`
- Host launch mode: rebel-oss stdio subprocess (`npx`/managed-install entry)
- Host env wiring:
  - `OPENAI_API_KEY` from `providerKeys.openai` (`providerKeyMapping`)
  - `MCP_WORKSPACE_PATH` for workspace-fenced file access
  - Optional `OPENAI_IMAGE_MODEL` model override
- Missing credentials are handled in **graceful unconfigured mode** (structured `NOT_CONFIGURED` tool result), not process-exit at startup.


## Authentication

### API Key Setup

OpenAI Image Generation uses the **same API key** as Rebel's voice features (TTS/STT). No separate configuration is needed if you've already set up voice.

**To configure:**
1. Go to **Settings → Voice**
2. Enter your OpenAI API key in the "OpenAI API Key" field
3. The image generation MCP activates automatically

**Alternatively:** If you only want image generation (no voice), you can still configure the key in Voice settings—the voice features will remain disabled unless you also enable a voice provider.

### API Key Requirements

- Obtain an API key from [OpenAI Platform](https://platform.openai.com/api-keys)
- The key must have access to the Images API (gpt-image-2)
- Standard OpenAI billing applies per image generated


## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key (passed from app settings) |
| `MCP_WORKSPACE_PATH` | No | Workspace path for saving images (host-injected) |
| `OPENAI_IMAGE_MODEL` | No | Operator override for model selection (defaults to `gpt-image-2`) |


## Tools Reference

### `generate_image`

Generate images from text descriptions using OpenAI's gpt-image-2 model.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| prompt | string | Yes | - | Text description of the image to generate |
| size | string | No | 'square' | Image dimensions: `square`, `portrait`, `landscape` |
| quality | string | No | 'high' | Quality level: `low`, `medium`, `high`, `auto` |
| count | number | No | 1 | How many images to generate (1-8). Cost multiplies by count. |
| moderation | string | No | 'auto' | Content-moderation strictness: `auto` (standard filtering) or `low` (less restrictive) |

**Size Options:**
| Size | Dimensions | Best For |
|------|------------|----------|
| `square` | 1024x1024 | Logos, icons, social media posts |
| `portrait` | 1024x1536 | Mobile wallpapers, vertical content |
| `landscape` | 1536x1024 | Presentations, headers, desktop wallpapers |

**Example request:**
```json
{
  "prompt": "A vintage travel poster for Kyoto with the text 'Welcome to Kyoto — 京都へようこそ' in elegant serif typography, soft sunset colors, cherry blossoms in the foreground",
  "size": "portrait",
  "quality": "high",
  "count": 3
}
```

**Example response:**
```
Image generated and saved to: /Users/you/workspace/Chief-of-Staff/generated-images/1703891234567-a-vintage-travel-poster-for-kyoto.png
```

### `edit_image`

Edit an existing image by describing the change — redraw, recolor, add/remove objects, or fix text. Provide 1-4 reference images (PNG/JPEG/WEBP) and optionally a PNG mask to constrain the edit region. Edits are billed at high-fidelity input rate on top of the output — a single square edit at high quality runs ~$0.25-$0.40. Saves to Chief-of-Staff/generated-images/.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| prompt | string | Yes | - | What to change in the image, in plain language |
| image_paths | string[] | Yes | - | 1–4 absolute or relative PNG/JPEG/WEBP reference images; each path must resolve inside your workspace |
| mask_path | string | No | - | Optional PNG mask; path may be absolute or relative, but it must resolve inside your workspace |
| size | string | No | `square` | Output dimensions: `square`, `portrait`, `landscape` |
| quality | string | No | `high` | Quality level: `low`, `medium`, `high`, `auto` |
| count | number | No | 1 | How many edited outputs to request (1–8). Cost scales linearly. |
| moderation | string | No | `auto` | Content-moderation strictness: `auto` or `low` |

Files must be inside your current workspace (Space folders count). If you want to edit a file from outside, drag it into your workspace first.

**Example request:**
```json
{ "prompt": "Replace the poster headline with 'Launch Week' and clean up the background",
  "image_paths": ["Chief-of-Staff/assets/poster.png"],
  "mask_path": "Chief-of-Staff/assets/poster-mask.png" }
```


## Image Storage

Generated and edited images are automatically saved to disk:

**Primary location (with workspace):**
```
<workspace>/Chief-of-Staff/generated-images/<timestamp>-<prompt-slug>.png
```

**Fallback location (no workspace):**
```
~/Pictures/MCP-Generated-Images/<timestamp>-<prompt-slug>.png
```

The MCP will create the `Chief-of-Staff` folder in your workspace if it doesn't exist, using the canonical name regardless of any existing case variations.

### Filename Format

Files are named using: `<timestamp>-<slug>.png`
- **Timestamp:** Unix epoch milliseconds for uniqueness
- **Slug:** First 40 characters of the prompt, lowercase, with special characters replaced by hyphens

Example: `1703891234567-a-cat-wearing-a-top-hat.png`


## Usage Examples

**Generate a simple image:**
```
Create an image of a cozy coffee shop on a rainy day
```

**Specify size and quality:**
```
Generate a high-quality landscape image of northern lights over snow-covered mountains
```

**Create business graphics:**
```
Make a square image of a minimalist logo featuring a lightbulb and gears, blue and white colors
```

**Portrait format:**
```
Create a portrait image of a futuristic cityscape at night with neon lights
```

**Tips for good prompts:**
- Be specific about style, colors, composition, and mood
- Mention artistic styles if relevant (e.g., "watercolor", "minimalist", "photorealistic")
- Include details about lighting, perspective, and background


## Technical Details

- **Type**: rebel-oss connector (managed install / npx)
- **Transport**: stdio (runs as subprocess)
- **Package**: `@mindstone/mcp-server-openai-image@0.1.0`
- **Package source (upstream)**: [`connectors/openai-image/src/index.ts`](https://github.com/mindstone/mcp-servers/blob/main/connectors/openai-image/src/index.ts) in `mindstone/mcp-servers`
- **Server name**: `OpenAIImageGeneration`
- **API endpoints**: `https://api.openai.com/v1/images/generations` and `https://api.openai.com/v1/images/edits`
- **Model**: `gpt-image-2`
- **Response format**: Base64 JSON (converted to PNG file)

### Pricing (2026-04-22)

OpenAI's per-image pricing for `gpt-image-2` at 1024×1024:

| Quality | Price per image |
|---------|-----------------|
| `low`    | $0.006 |
| `medium` | $0.053 |
| `high`   | $0.211 |

Rebel's default quality is now `high`, which matches gpt-image-2's strength at text rendering and realism. Image-generation costs are billed directly to the user's OpenAI account; Rebel does not proxy or meter them.

### Internal rollback seam

The connector reads the model id from `OPENAI_IMAGE_MODEL` (default `gpt-image-2`). This is an operator-only emergency knob — not a user-facing setting — intended for rapid rollback to a prior model (e.g., `gpt-image-1.5`) if OpenAI changes the service in a disruptive way. Leave unset in normal operation.

### Conditional Registration

Registration and key-rotation lifecycle now runs through the generic `settings:update` provider-key handler. When a mapped provider key changes, matching rebel-oss connectors restart with freshly resolved env. Clearing a key no longer hard-removes the connector; it restarts into graceful unconfigured mode.

### Connect-Failure Surfacing

Failures from the Settings → Connectors → **Connect** flow surface to the user as a toast emitted by the renderer (`UnifiedConnectionsPanel`). The toast title is `"<Connector name> connection failed"` and the description is the error message thrown by the IPC handler in `src/main/ipc/settingsHandlers.ts`.

For OpenAI Image Generation specifically, attempting to connect with no OpenAI provider key set rejects with:

> Add an OpenAI API key in Settings → Provider Keys before connecting Image Generation.

This was added in FOX-3264 (May 2026) — previously the IPC silently registered an unusable server, and the renderer suppressed the toast for non-OAuth `authType` connectors. See `docs-private/postmortems/260506_FOX-3264_openai_image_generation_catalog_registry_split_brain_postmortem.md` for the full incident write-up. The same toast surface now applies to every bundled connector regardless of `authType`.


## Known Limitations

1. **Batch size**: Generates 1–8 images per request via the `count` parameter. Beyond 8, call multiple times.

2. **PNG only**: Images are saved as PNG format. No option for JPEG or other formats.

3. **API costs**: Each generation or edit consumes OpenAI API credits. Check [OpenAI pricing](https://openai.com/pricing) for current rates.


## Troubleshooting

### "Add an OpenAI API key in Settings → Provider Keys before connecting Image Generation."
**Where you'll see it:** Toast titled `"OpenAI Image Generation connection failed"` after clicking **Connect** in Settings → Connectors with no OpenAI provider key set.
**Cause:** The Settings IPC handler refuses to register the connector when `providerKeys.openai` is empty (FOX-3264, May 2026 — previously this failed silently).
**Solution:**
1. Go to **Settings → Provider Keys** (or **Settings → Voice**, which writes to the same key) and enter your OpenAI API key.
2. Click **Connect** again — key changes are applied through the generic `settings:update` lifecycle path (no app restart required).

### `NOT_CONFIGURED` / "OPENAI_API_KEY not set" (returned from a tool call)
**Where you'll see it:** Structured tool-call failure when the connector is running without a usable OpenAI key.
**Cause:** The connector is in graceful unconfigured mode (missing/empty key) rather than crashing at startup.
**Solution:**
1. Go to **Settings → Voice** (or **Settings → Provider Keys**) and confirm the OpenAI API key is set.
2. Save the key — the provider-key rotation handler restarts matching connectors with refreshed env automatically.

### "Invalid OpenAI API key"
**Cause:** The API key is malformed or revoked.
**Solution:**
1. Verify your API key at [OpenAI Platform](https://platform.openai.com/api-keys)
2. Regenerate if needed
3. Update the key in **Settings → Voice** — Rebel picks it up automatically.

### "Rate limit exceeded"
**Cause:** Too many requests in a short period.
**Solution:**
1. Wait a moment and try again
2. Check your [OpenAI usage limits](https://platform.openai.com/usage)
3. Consider upgrading your OpenAI plan for higher limits

### "Content policy violation"
**Cause:** The prompt was flagged by OpenAI's content moderation.
**Solution:**
1. Revise your prompt to comply with [OpenAI's usage policies](https://openai.com/policies/usage-policies)
2. Remove any inappropriate or restricted content from the prompt

### Image not appearing in workspace
**Cause:** Workspace path not set or permission issue.
**Solution:**
1. Check that you have a workspace selected in Rebel
2. Verify write permissions to the workspace folder
3. Look in `~/Pictures/MCP-Generated-Images/` as a fallback location
4. Check the log output for specific error messages

### "No image data returned"
**Cause:** API returned URL format instead of base64.
**Solution:** This is an unexpected API response format. Try the request again. If it persists, report the issue—the MCP expects base64 responses.


## Common Use Cases

- **Presentation visuals**: "Create a professional diagram showing a three-step process"
- **Social media graphics**: "Generate a square image for an Instagram post about productivity tips"
- **Concept visualization**: "Illustrate what a sustainable city of the future might look like"
- **Logo drafts**: "Design a minimalist tech startup logo with geometric shapes"
- **Blog illustrations**: "Create a landscape header image for an article about remote work"
- **Brainstorming**: "Show me different artistic interpretations of 'collaboration'"


## Workflow Integration

### With Kling (Image-to-Video)

Generate a static image, then animate it:
1. Use `generate_image` to create your starting frame
2. Upload the saved PNG to a hosting service
3. Use Kling's `generate_video_from_image` with the public URL

### With Memory Spaces

Images saved to `Chief-of-Staff/generated-images/` are in your workspace and can be:
- Referenced in future conversations
- Organized into memory spaces
- Included in documents or presentations


## References

- [OpenAI Images API](https://platform.openai.com/docs/guides/images)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference/images)
- [OpenAI Pricing](https://openai.com/pricing)
- [OpenAI Usage Policies](https://openai.com/policies/usage-policies)
