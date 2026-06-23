---
description: "Nano Banana MCP connector for Gemini image generation — text-to-image, image editing, API-key setup, model options"
last_updated: "2026-04-22"
---

# Nano Banana MCP

Google Gemini image generation and editing via the Nano Banana models.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - MCP development patterns
- [Google Gemini Image Generation Docs](https://ai.google.dev/gemini-api/docs/image-generation)


## Overview

**Status:** Updated Mar 2026

| Attribute | Value |
|-----------|-------|
| **ID** | `bundled-nano-banana` |
| **Name** | Nano Banana (Local) |
| **Provider** | Bundled MCP |
| **Auth** | API key (from Google AI Studio) |
| **Data flow** | Local only (direct API calls) |


## Tools

| Tool | Description | Example Prompt |
|------|-------------|----------------|
| `nano_banana_generate` | Generate images from text descriptions | "Generate an image of a sunset over mountains" |
| `nano_banana_edit` | Edit existing images with text instructions | "Edit this image to add a rainbow in the sky" |


## Usage Examples

**Generate an image:**
```
Generate a futuristic cityscape at night with neon lights using Nano Banana
```

**Edit an image:**
```
Use nano_banana_edit to change the color of the car in ~/photos/car.png to red
```

**Save generated image:**
```
Generate an image of a cat wearing a space helmet and save it to ~/Desktop/space-cat.png
```


## Setup

1. Go to **Settings → Connectors** → Find **Nano Banana**
2. Click the **"Open Nano Banana"** button to go to Google AI Studio
3. Click 'Create API key' or use an existing one
4. Copy your API key and paste it in the form
5. Click **"Set up with Rebel"** to connect


## Technical Details

- **Type**: Bundled MCP (maintained by Mindstone)
- **Transport**: stdio (runs as subprocess)
- **Server script**: `resources/mcp/nano-banana/server.cjs`
- **Environment Variables**:
  - `GEMINI_API_KEY` (required) - Your Google AI Studio API key
- **Default Model**: `gemini-3.1-flash-image-preview` (Nano Banana 2 - pro-quality at flash speed, 4K)
- **Pro Model**: `gemini-3-pro-image-preview` (Nano Banana Pro - highest quality, 4K)
- **Legacy Model**: `gemini-2.5-flash-image` (original Nano Banana - fast, superseded by Nano Banana 2)
- **Rate Limits**: 1500 requests/day on free tier


## Tool Reference

### nano_banana_generate

Create images from text descriptions.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| prompt | string | Yes | - | Text description of the image to generate |
| model | string | No | gemini-3.1-flash-image-preview | `gemini-3.1-flash-image-preview` (Nano Banana 2, default), `gemini-3-pro-image-preview` (Pro), or `gemini-2.5-flash-image` (legacy) |
| aspect_ratio | string | No | 1:1 | Aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 |
| save_path | string | No | - | File path to save the image (supports ~) |

**Returns:** Inline image displayed in conversation, plus optional file save.


### nano_banana_edit

Edit an existing image using AI.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| source_image_path | string | Yes | - | Path to the image file to edit |
| prompt | string | Yes | - | Instructions for how to edit the image |
| model | string | No | gemini-3.1-flash-image-preview | `gemini-3.1-flash-image-preview` (Nano Banana 2, default), `gemini-3-pro-image-preview` (Pro), or `gemini-2.5-flash-image` (legacy) |
| aspect_ratio | string | No | - | Aspect ratio for the edited image |
| save_path | string | No | - | File path to save the edited image |

**Supported formats:** PNG, JPEG, WebP

**Returns:** Inline edited image displayed in conversation, plus optional file save.


## Known Limitations

- **No OAuth**: Unlike Google Workspace, Gemini image API only supports API keys
- **Content filtering**: Some prompts may be blocked by Google's safety filters
- **No multi-turn editing**: Each edit requires specifying `source_image_path` (no session state)


## Troubleshooting

**"Invalid Gemini API key":**
- Verify your API key at [Google AI Studio](https://aistudio.google.com/api-keys)
- Regenerate the key if needed
- Ensure no extra whitespace when pasting

**"Content was blocked by safety filters":**
- Try rephrasing your prompt
- Avoid potentially sensitive content

**"Rate limit exceeded":**
- Wait a moment before retrying
- Free tier allows 1500 requests/day

**"No image generated":**
- Try a more descriptive prompt
- Some prompts may not produce images; the model returns text instead


## Updating Models

When Google releases a new Nano Banana / Gemini image model:

1. **Find the new model ID** — check [Google AI docs](https://ai.google.dev/gemini-api/docs/image-generation) or search for "Nano Banana" + year. Model IDs follow the pattern `gemini-{version}-{variant}-image-preview`.
2. **Update `resources/mcp/nano-banana/server.cjs`**:
   - Add the new model ID to `SUPPORTED_MODELS` (first position = recommended default)
   - Update `DEFAULT_MODEL` if the new model should be the default
   - Update `MODEL_DESCRIPTION` to list all options
3. **Test against the live API** — call `v1beta/models/{model}:generateContent` with a simple prompt and `responseModalities: ["TEXT", "IMAGE"]` to confirm the model ID works
4. **Update this doc** — model table in Technical Details, Tool Reference defaults, and Comparison table
5. **Update the skill file** — `work/Mindstone/General/skills/brand-and-design/nano-banana-branded-image-generation/SKILL.md` (model selection table, examples, and `references/INFOGRAPHIC.md`)

History: Original Nano Banana (`gemini-2.5-flash-image`) → Nano Banana 2 (`gemini-3.1-flash-image-preview`, Feb 2026).


## Comparison with OpenAI Image Generation

| Feature | Nano Banana (Gemini) | OpenAI Image Generation |
|---------|---------------------|------------------------|
| Provider | Google | OpenAI |
| Image editing | Yes | No |
| API key source | Google AI Studio | OpenAI Platform |
| Models | gemini-3.1-flash-image-preview (Nano Banana 2), gemini-3-pro-image-preview (Pro), gemini-2.5-flash-image (legacy) | gpt-image-2 |
| Aspect ratio | Yes (10 options) | Yes (square/portrait/landscape) |
| Quality options | Standard vs Pro model | Yes (low/medium/high/auto) |
