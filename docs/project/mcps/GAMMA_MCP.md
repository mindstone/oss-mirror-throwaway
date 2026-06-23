---
description: "Gamma bundled MCP reference — API key bridge, content generation tools, catalog entry, architecture, live configuration"
last_updated: "2026-01-20"
---

# Gamma MCP

AI-powered presentation, document, and webpage generation.

| Field | Value |
|-------|-------|
| **Type** | Bundled (local) |
| **Provider** | Mindstone |
| **Transport** | stdio |
| **Auth** | API key via Bridge pattern |
| **Status** | Tested Dec 2024 |

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup, discovery, and troubleshooting
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Gamma API Documentation](https://developers.gamma.app/) - Official API reference
- Source code: `resources/mcp/gamma/`


## Overview

The Gamma MCP integrates with [Gamma.app](https://gamma.app) to generate professional presentations, documents, webpages, and social posts directly from Rebel. Users provide a topic, notes, or outline, and Gamma's AI creates polished visual content.

**Key capabilities:**
- Generate presentations (slide decks)
- Create documents (formatted text with visuals)
- Build webpages
- Create social media posts
- Download as PDF or PowerPoint
- Customize with themes and instructions


## Connector Catalog Entry

```json
{
  "id": "bundled-gamma",
  "name": "Gamma",
  "description": "Create presentations, documents, and websites with AI",
  "category": "productivity",
  "provider": "bundled",
  "bundledConfig": {
    "authType": "api-key",
    "settingsKey": "gamma.enabled",
    "serverName": "GammaMcp",
    "envKey": "GAMMA_API_KEY"
  },
  "icon": "presentation",
  "popular": true
}
```


## Architecture

```
resources/mcp/gamma/
├── src/
│   ├── index.ts          # Entry point
│   └── tools/
│       ├── server.ts     # MCP server + tool handlers
│       └── client.ts     # Gamma API client
├── package.json
└── build/                # Compiled JS (gitignored)
```

The Gamma MCP uses a modular architecture with:
- `@modelcontextprotocol/sdk` for MCP server implementation
- Custom API client for Gamma's REST API
- Bridge pattern for API key configuration from the main app


## Authentication

### API Key Setup

Gamma uses API key authentication (no OAuth flow):

1. User navigates to Gamma API Settings (see `setupUrl` in `resources/connector-catalog.json` for canonical URL)
2. Creates or copies their API key
3. Provides the key to Rebel (either via Settings UI or in conversation)
4. MCP calls `bridgeRequest('/bundled/gamma/configure')` to store the key
5. Client initializes immediately (no restart required)

### Self-Initialization

Unlike most MCPs, Gamma supports **live API key configuration**. When `configure_gamma_api_key` is called:
1. Bridge stores the key securely
2. The MCP client initializes itself in-memory
3. Tools are available immediately (no process restart)


## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GAMMA_API_KEY` | Yes | Gamma API key (see `setupUrl` in connector catalog) |
| `MINDSTONE_REBEL_BRIDGE_STATE` | Yes* | Path to bridge state file (*for key configuration) |


## Tools Reference

### Configuration

#### `configure_gamma_api_key`
Configure the Gamma API key. Call this when the user provides their API key.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| api_key | string | Yes | Gamma API key (get from Gamma API Settings) |

**Example:**
```json
{ "api_key": "gamma_api_xxx..." }
```

**Response:**
```json
{
  "success": true,
  "message": "Gamma API key configured successfully! You can now use gamma_generate to create presentations, documents, and webpages."
}
```

### Content Generation

#### `gamma_generate`
Create a presentation, document, webpage, or social post using Gamma AI. Returns a generation ID for status polling.

**Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| input_text | string | Yes | - | Topic, notes, or outline to generate from |
| format | string | No | 'presentation' | Output format: `presentation`, `document`, `webpage`, `socialPost` |
| text_mode | string | No | 'generate' | How to interpret input: `generate`, `pasteText`, `pasteOutline` |
| num_cards | number | No | - | Number of slides/cards to generate |
| additional_instructions | string | No | - | Extra instructions (tone, audience, style) |

**Text Modes:**
| Mode | Description | Best For |
|------|-------------|----------|
| `generate` | AI generates content from topic/idea | "Create a deck about market trends" |
| `pasteText` | Uses text exactly as provided | Existing content to format |
| `pasteOutline` | Interprets as structured outline | Bullet points, numbered lists |

**Example request:**
```json
{
  "input_text": "Q4 2024 Sales Performance: exceeded targets by 15%, new enterprise deals, key metrics",
  "format": "presentation",
  "text_mode": "generate",
  "num_cards": 10,
  "additional_instructions": "Professional tone, executive audience, include charts"
}
```

**Example response:**
```json
{
  "success": true,
  "generation_id": "gen_abc123xyz",
  "message": "Generation started. Use gamma_get_status with ID \"gen_abc123xyz\" to check progress."
}
```

#### `gamma_get_status`
Check the status of a generation and get download URLs when complete.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| generation_id | string | Yes | ID returned by `gamma_generate` |

**Status values:**
| Status | Description |
|--------|-------------|
| `pending` | Generation in progress |
| `completed` | Ready - URLs available |
| `failed` | Error occurred |

**Example response (completed):**
```json
{
  "generation_id": "gen_abc123xyz",
  "status": "completed",
  "gamma_url": "https://gamma.app/docs/Your-Presentation-xyz123",
  "pdf_url": "https://...",
  "pptx_url": "https://...",
  "credits": {
    "deducted": 1,
    "remaining": 49
  },
  "message": "Generation complete! Access your content at the URL above."
}
```

**Example response (pending):**
```json
{
  "generation_id": "gen_abc123xyz",
  "status": "pending",
  "message": "Generation in progress..."
}
```

### Discovery

#### `gamma_list_themes`
List available themes for presentations.

**Parameters:** None

**Example response:**
```json
{
  "themes": [
    {
      "id": "theme_123",
      "name": "Modern Dark",
      "previewUrl": "https://..."
    },
    {
      "id": "theme_456",
      "name": "Corporate Clean",
      "previewUrl": "https://..."
    }
  ]
}
```


## Usage Examples

**Generate a presentation:**
```
Create a 10-slide presentation about our Q4 sales results using Gamma
```

**Create a document:**
```
Make a Gamma document explaining our product roadmap for stakeholders
```

**Generate with specific instructions:**
```
Use Gamma to create a presentation on AI trends. Make it engaging for a technical audience with data visualizations.
```

**Check generation status:**
```
What's the status of my Gamma generation?
```

**Create from outline:**
```
Turn this outline into a Gamma presentation:
1. Introduction - company overview
2. Problem statement
3. Our solution
4. Key benefits
5. Next steps
```


## Setup Flow

1. Go to **Settings → Connectors** → Find **Gamma**
2. Click **"Set up"** to open the configuration form
3. Click "Open Gamma" to get your API key
4. Paste your API key into the input field
5. Click **Connect** - Rebel saves and activates the connection

**Alternative (in conversation):**
1. Tell Rebel: "I want to use Gamma for presentations"
2. Rebel prompts for your API key
3. Click "Open Gamma" or get your key from Gamma's API settings
4. Rebel calls `configure_gamma_api_key` and tools become available immediately


## Technical Details

- **Type**: Bundled MCP (maintained by Mindstone)
- **Transport**: stdio (runs as subprocess)
- **Server script**: `resources/mcp/gamma/build/index.js`
- **API Base**: `https://public-api.gamma.app/v1.0`
- **SDK**: Uses `@modelcontextprotocol/sdk` v1.0.0

### Credits System

Gamma uses a credit-based system for generation:
- Each generation costs credits
- `gamma_get_status` returns `credits.deducted` and `credits.remaining`
- Check your credit balance at [Gamma Settings](https://gamma.app/settings)


## Known Limitations

1. **Async generation**: Content generation takes time (10-60 seconds). Users must poll with `gamma_get_status` to check completion.

2. **Credit-based**: Each generation consumes Gamma credits. Users need sufficient credits in their Gamma account.

3. **No editing**: The MCP creates new content only. Editing existing Gamma documents requires using Gamma's web interface.

4. **Theme selection**: Theme IDs from `gamma_list_themes` can be used with the API's `themeId` parameter, but this option isn't currently exposed in the simplified tool interface.

5. **Rate limits**: Subject to Gamma API rate limits (check [Gamma API docs](https://developers.gamma.app/) for current limits).


## Troubleshooting

### "Gamma API key not configured"
**Cause:** API key hasn't been set up.
**Solution:** 
1. Go to Settings → Connectors → Gamma and click "Open Gamma" to get your API key
2. Either configure there, or provide the key in conversation

### "Gamma API error (401)"
**Cause:** Invalid or expired API key.
**Solution:** 
1. Click "Open Gamma" in Settings → Connectors to verify/regenerate your key
2. Reconfigure in Settings → Connectors → Gamma

### "Generation failed"
**Cause:** Generation error on Gamma's side.
**Solution:**
1. Check the error message in the status response
2. Try again with different input or fewer cards
3. Verify you have sufficient credits

### Generation stuck on "pending"
**Cause:** Long generation time or API issue.
**Solution:**
1. Wait and poll again (complex presentations may take 30-60 seconds)
2. If stuck for more than 2 minutes, try a new generation
3. Check [Gamma status page](https://status.gamma.app/) for outages


## Common Use Cases

- **Sales decks**: "Create a presentation for our Q4 investor update"
- **Product docs**: "Generate a product overview document for new clients"
- **Training materials**: "Build a 15-slide onboarding presentation for new hires"
- **Meeting summaries**: "Turn these meeting notes into a formatted document"
- **Social content**: "Create a social post announcing our new feature"


## References

- [Gamma Website](https://gamma.app/)
- [Gamma API Documentation](https://developers.gamma.app/)
- [Gamma API Reference](https://developers.gamma.app/reference/generate-a-gamma)
- API key URL: See `setupUrl` in `resources/connector-catalog.json` (single source of truth)
