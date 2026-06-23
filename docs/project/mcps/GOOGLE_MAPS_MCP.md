---
description: "Google Maps MCP connector — place search, geocoding, directions, distance matrix, setup, smoke testing"
last_updated: "2026-02-24"
---

# Google Maps MCP

Connect Rebel to Google Maps for directions, place search, geocoding, distance calculations, and elevation data.

| Property | Value |
|----------|-------|
| **Status** | Beta |
| **Type** | Community MCP (npx) |
| **Provider** | Anthropic / Model Context Protocol |
| **Source** | https://github.com/modelcontextprotocol/servers |
| **Package** | `@modelcontextprotocol/server-google-maps@0.6.2` |
| **Auth** | Google Maps API Key |
| **Tools** | 7 |


## Overview

Google Maps MCP enables location-based workflows through natural language. Plan routes, find nearby places, convert addresses to coordinates, calculate travel times between multiple locations, and look up elevation data.

Useful for: customer visit planning, logistics routing, travel preparation, location research, address validation.


## Tools

| Tool | Description |
|------|-------------|
| `maps_geocode` | Convert an address to coordinates |
| `maps_reverse_geocode` | Convert coordinates to an address |
| `maps_search_places` | Find places by text query with optional location/radius |
| `maps_place_details` | Get detailed info about a place by place ID |
| `maps_distance_matrix` | Calculate distances and travel times between origins and destinations |
| `maps_elevation` | Get elevation data for locations |
| `maps_directions` | Get route directions between two points |


## Setup

### Prerequisites

- A Google Cloud project with billing enabled
- Google Maps API key with the following APIs enabled:
  - Geocoding API
  - Places API
  - Directions API
  - Distance Matrix API
  - Elevation API

### Step 1: Create a Google Maps API Key

1. Go to the [Google Cloud Console Credentials page](https://console.cloud.google.com/apis/credentials)
2. Create or select a project
3. Click **Create Credentials** > **API Key**
4. Enable the required APIs in the [APIs & Services Library](https://console.cloud.google.com/apis/library)

### Step 2: Add Connection in Rebel

1. Open **Settings > Connectors**
2. Find **Google Maps** and click **Set up with Rebel**
3. Paste your Google Maps API key

### Pricing

Google Maps API usage is billed per request. New Google Cloud accounts receive $200/month in free credits. See [Google Maps Billing](https://developers.google.com/maps/billing-and-pricing) for details.


## Architecture

- **Transport**: stdio (spawned via npx)
- **Package**: `@modelcontextprotocol/server-google-maps@0.6.2` (version-pinned)
- **License**: MIT
- **Env var**: `GOOGLE_MAPS_API_KEY`

The package is from the official MCP servers repository. While the npm package is marked deprecated (the repo restructured), the code remains functional and stable at v0.6.2.


## Testing

Smoke tests are in `scripts/__tests__/mcp-smoke.test.ts` (Community MCP Smoke Tests section). Tests verify:
- Server starts and registers all 7 tools
- Tool schemas are valid
- Auth error handling (REQUEST_DENIED with invalid key)
- Server stability after error


## See Also

- [MCP_IMPROVEMENT_WORKFLOW](../MCP_IMPROVEMENT_WORKFLOW.md) -- MCP development process
- [MCP_ARCHITECTURE](../MCP_ARCHITECTURE.md) -- connector catalog and architecture
- [Google Maps API docs](https://developers.google.com/maps/documentation)
