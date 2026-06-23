---
description: "Zoom MCP connector — meeting management with Server-to-Server OAuth, setup, tool limits, transcript alternatives, evaluated approaches"
last_updated: "2026-02-19"
---

# Zoom MCP

Connect Rebel to Zoom for meeting management.

| Property | Value |
|----------|-------|
| **Status** | Added Feb 2026 |
| **Type** | Community MCP (npx) |
| **Provider** | JavaProgrammerLB |
| **Source** | https://github.com/JavaProgrammerLB/zoom-mcp-server |
| **npm** | `@yitianyigexiangfa/zoom-mcp-server@0.7.4` |
| **License** | MIT |
| **Auth** | Server-to-Server OAuth (Account ID + Client ID + Client Secret) |
| **Tools** | 4 |


## Overview

The Zoom MCP enables basic meeting management -- listing, creating, deleting, and retrieving meeting details. It uses Zoom's Server-to-Server OAuth, which authenticates at the account/org level (not per-user).

**Important limitations**: This connector does **not** provide access to recordings, transcripts, participants, or user management. For Zoom transcript needs, see [Alternatives](#alternatives-and-overlap-with-existing-rebel-infrastructure) below.


## Setup

### Prerequisites

- Node.js 18+ installed
- A Zoom account with admin/developer access to the Zoom Marketplace

### Step 1: Create a Server-to-Server OAuth App

1. Go to the [Zoom Marketplace](https://marketplace.zoom.us/)
2. Click **Develop** > **Build App**
3. Choose **Server-to-Server OAuth** app type
4. Enter an app name (e.g., `Rebel AI`)
5. Copy the **Account ID**, **Client ID**, and **Client Secret** from the App Credentials page
6. Add scopes: **Meeting** > select all meeting permissions
7. Click **Activate** to enable the app

### Step 2: Add Connection in Rebel

1. Go to **Settings** > **Connectors**
2. Find **Zoom** and click **+ Add**
3. Enter the Account ID, Client ID, and Client Secret from Step 1


## Tools

| Tool | Description |
|------|-------------|
| `list_meetings` | List upcoming and past meetings for the account |
| `create_meeting` | Schedule a new Zoom meeting |
| `delete_meeting` | Delete a meeting by ID |
| `get_meeting_details` | Get details for a specific meeting |


## Alternatives and Overlap with Existing Rebel Infrastructure

### Why transcripts are not available via this connector

Zoom's transcript access requires the Cloud Recording API (`GET /users/{userId}/recordings`), which is only available on Zoom Business/Enterprise plans with cloud recording enabled. The current community MCP package does not implement recording or transcript endpoints.

### Existing Rebel infrastructure that covers Zoom workflows

Before building a custom Zoom MCP, consider that Rebel already provides Zoom meeting support through other channels:

| Existing Feature | What It Does | Zoom Support |
|-----------------|-------------|--------------|
| **Recall.ai Meeting Bot** (`meeting-bot-worker/`) | Joins meetings via URL, produces live transcripts and recordings | Zoom URLs supported (`zoom.us/j/...`) |
| **RebelMeetings MCP** | Schedule recording bots, fetch transcripts, meeting history | Platform-agnostic (works with Zoom, Meet, Teams) |
| **Fathom MCP** (`resources/mcp/fathom/`) | Fetch meeting transcripts, summaries, action items | Works if user records Zoom meetings via Fathom |
| **Fireflies MCP** | Meeting transcripts and AI-powered insights | Works if user records Zoom meetings via Fireflies |
| **Otter.ai MCP** | Meeting transcripts and summaries | Works if user records Zoom meetings via Otter |

**Recommendation**: For users who need Zoom meeting transcripts, the Recall.ai bot (already built into Rebel) or Fathom/Fireflies/Otter integrations are better options than building direct Zoom API transcript access.

### All evaluated Zoom MCP approaches

| Approach | Auth | Capabilities | Transcripts? | Status |
|----------|------|-------------|-------------|--------|
| **Current: community `@yitianyigexiangfa/zoom-mcp-server`** | S2S OAuth (admin setup) | 4 meeting tools | No | Shipped |
| **Build bundled MCP (Zoom REST API + user OAuth)** | User OAuth (click-to-connect) | Full: meetings, recordings, transcripts, participants | Yes (requires Business/Enterprise plan + cloud recording) | Not started |
| **`mattcoatsworth/zoom-mcp-server`** (GitHub) | S2S OAuth | Full Zoom API coverage (meetings, users, webinars, recordings, reports, chat, phone) | Yes (via recordings API) | Community, not on npm as npx package |
| **`echelon-ai-labs/zoom-mcp`** (GitHub, Python) | Unknown | Unknown scope | Unknown | Community, Python-based |
| **`@peakmojo/mcp-server-zoom-noauth`** (npm) | No end-user auth (S2S pre-configured) | Recordings and transcripts | Yes | Community, Apache-2.0, compliance risk |
| **`forayconsulting/zoom_transcript_mcp`** (GitHub) | Unknown | Transcript-focused | Yes | Community, MIT |
| **Zoom official remote MCP** | N/A | N/A | N/A | **Does not exist** (confirmed Feb 2026) |
| **Zoom "Custom Agents" MCP (Zoomtopia announcement)** | Unknown | Unknown | Unknown | No public endpoint or docs available |
| **Recall.ai + RebelMeetings (existing)** | Recall API key (internal) | Join meetings, live transcripts, recording | Yes | Already built into Rebel |
| **Fathom/Fireflies/Otter (existing)** | API key / OAuth | Meeting transcripts, summaries | Yes | Already in connector catalog |


## Future Improvements

If a dedicated bundled Zoom MCP is built in the future, it should:

1. **Use user-level OAuth** (not S2S) for a click-to-connect experience
2. **Include recording/transcript access** via `GET /users/me/recordings`
3. **Follow the HubSpot/Google Workspace bundled MCP pattern** for auth flow
4. **Consider whether it duplicates** what Recall.ai + RebelMeetings already provides

See [MCP_IMPROVEMENT_WORKFLOW](../MCP_IMPROVEMENT_WORKFLOW.md) for the standard process.


## Troubleshooting

| Problem | Solution |
|---------|----------|
| `401 Unauthorized` | Verify Account ID, Client ID, and Client Secret are correct. Ensure the app is activated in Zoom Marketplace. |
| `403 Forbidden` | The S2S app may lack required scopes. Go to Zoom Marketplace > your app > Scopes and add Meeting permissions. |
| No meetings returned | S2S OAuth operates at account level. Ensure the app has permission to access the target user's meetings. |
| Want transcripts? | Use Rebel's built-in Recall.ai meeting bot or Fathom/Fireflies/Otter connectors instead. |
