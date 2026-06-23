---
description: "Product vision, feature set, and guiding principles for Mindstone Rebel"
last_updated: "2026-04-16"
---

### Introduction

Mindstone Rebel is a user-friendly, voice-first, agentic desktop app that connects directly to the user's workspaces and tools, with a privacy-first architecture where Mindstone does not see or touch customer conversations, tool use, or other sensitive data. A lightweight backend (Rebel Platform) handles authentication and optional admin configuration.
This document summarizes the product vision, core features, and design principles; detailed architecture and implementation live in other docs.


### See also

- [Agent-native software](https://every.to/guides/agent-native) – External guide on designing agent-native applications.
- `../../README.md` – High-level project overview, build/run commands, and top-level directory layout.
- `../../AGENTS.md` – Guidance for AI agents working on this repo and pointers to key implementation files.
- `ARCHITECTURE_OVERVIEW.md` – High-level system architecture, components, and data flows.
- `VOICE_AND_AUDIO.md` – Voice/audio pipeline, STT/TTS providers, streaming playback, and custom transcription vocabulary.
- `MCP_ARCHITECTURE.md` – MCP and Super-MCP configuration, discovery, and integration details.
- `ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md` – Session model, persistence, and context-resume behavior.
- `TOOL_SAFETY.md` – LLM-evaluated tool safety and user approval flows.
- `MEMORY_SAFETY.md` – Approval flow for memory writes to user spaces.
- `SAFETY_SYSTEM_OVERVIEW.md` – Safety system: tool safety, memory safety, bash safety, evals.
- `LIBRARY_AND_FILE_ACCESS.md` – Workspace permissions, file operations, and semantic search.
- `CONVERSATION_MENTIONS.md` – `@[...]` syntax for referencing prior conversations in prompts.
- `ARCHITECTURE_MESSAGE_QUEUE.md` – Queue/interrupt model for sending messages during agent turns.
- `ONBOARDING_SETUP_WIZARD.md` – First-run experience, permissions, and background sync.
- `AUTOMATIONS.md` – Scheduled headless skill runs.
- [Actions panel](INBOX_PANEL.md) – Task deferral, scratchpad, and deferred execution.
- `HEADLESS_CLI_ENTRYPOINT_REFERENCE.md` – Command-line interface for scripted workflows (alpha).
- `SPACES.md` – Spaces architecture, workspace organisation, and sharing model.
- `THE_SPARK.md` – The Spark discovery hub and attention system.
- `SCRATCHPAD.md` – Scratchpad quick-capture and tasks panel.
- `ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md` – Analytics architecture and privacy.
- `LOCAL_MODEL_SUPPORT.md` – Local/alternative model providers (Ollama, LM Studio, OpenRouter).


### Product vision and major parts

- **Voice-first, agent-centric assistant**: Optimized for push-to-talk and continuous agent turns, with text as a first-class alternative. Multi-provider STT/TTS with streaming playback and custom transcription vocabulary for proper nouns (see `VOICE_AND_AUDIO.md`). Global voice hotkey with automatic screenshot capture for context-aware questions.
- **Workspace and Spaces**: Operates against a user-selected workspace on the local filesystem. Within the workspace, Spaces organise skills, memory, and sharing boundaries for different contexts (personal, company, team). Each Space has its own README, memory safety level, and optional shared-folder backing (Google Drive, OneDrive, Dropbox, Box). See `SPACES.md`, `LIBRARY_AND_FILE_ACCESS.md`.
- **Context engineering**: Semantic file search (`@files`), conversation mentions (`@[...]`), and conversation search (semantic + recency filters) to bring relevant context into prompts. See `CONVERSATION_MENTIONS.md`, `LIBRARY_AND_FILE_ACCESS.md`.
- **Three major parts**:
  - **Skills**: Prompted capabilities and workflows that describe how to perform tasks, perhaps along with coding scripts. Stored in Spaces and reusable across conversations.
  - **Connectors**: Integrations via MCP (Model Context Protocol) to tools, services, and external knowledge sources. One-click setup via Settings for 75+ integrations. See "Connector catalog" section below and `MCP_ARCHITECTURE.md`.
  - **Memory**: Storage, digestion, and retrieval of useful/relevant, user-, task-, team/project-, and organisation-specific knowledge to support ongoing work, observing appropriate sharing/permissions when writing. Per-space safety levels control approval behavior.


### Provider choice

Rebel treats **Anthropic**, **ChatGPT Pro / Codex**, and **OpenRouter** as first-class setup options in onboarding and Settings. The app should feel model-agnostic at the product level: users pick the route that fits their subscription, billing, or reliability needs, and Rebel maps Working / Thinking / Background roles onto that provider. Local and alternative model profiles remain available as an advanced add-on for users who want a specific self-hosted or direct OpenAI-compatible route.


### Key UX features

- **The Spark**: Discovery hub shown on the home screen. Displays personalized use-case suggestions, coaching insights from past conversations, personal goals coaching, and company/team values. See `THE_SPARK.md`.
- **Session modes**: Conversations adapt behavior based on context — Quick Question for fast answers, On the Case for deeper work. Privacy mode and voice-active flags further shape responses. See `../../rebel-system/help-for-humans/session-modes.md`.
- **Actions and Scratchpad**: Actions collects actionable items from connected tools for review and agent-assisted execution. The Scratchpad provides quick capture with AI-assisted note filing. Includes a Tasks panel with optional Todoist sync. See `INBOX_PANEL.md`, `SCRATCHPAD.md`.
- **Rebel Notetaker**: Joins video meetings (Zoom, Meet, Teams) to capture transcripts and generate AI summaries. Supports interactive Q&A during meetings, knowledge search toggle, meeting prep, and physical recording devices (Plaud, Limitless Pendant). External provider import (Fireflies, Fathom). See `MEETING_BOT.md`.
- **Automations**: Scheduled and event-triggered headless runs of skills, with run history and catch-up for missed runs. See `AUTOMATIONS.md`.
- **Conversation management**: Favorites, archive, trash with soft-delete, semantic conversation search, and Quick Open (`Cmd/Ctrl+O`) for fast file access. See `../../rebel-system/help-for-humans/favorites-and-trash.md`, `../../rebel-system/help-for-humans/searching-conversations.md`.
- **Big jobs and parallel work**: `//unleashed` mode for extended autonomous work (10 auto-continues), auto-done for fire-and-forget delegation, and multiple simultaneous conversations. See `../../rebel-system/help-for-humans/running-big-jobs-unleashed-auto-done.md`.
- **Keyboard shortcuts and global hotkey**: Full shortcut set including global voice activation with screenshot capture, session switching (`Ctrl+Tab`), and customizable hotkeys. See `../../rebel-system/help-for-humans/keyboard-shortcuts-and-hotkeys.md`.
- **Headless CLI**: Command-line interface for scripted workflows and CI pipelines (alpha). See `HEADLESS_CLI_ENTRYPOINT_REFERENCE.md`.


### Connector catalog

The app includes a growing catalog of 75+ connectors available via Settings > Connectors. Categories and connectors are defined in `resources/connector-catalog.json`. Individual connector documentation lives in `docs/project/mcps/`. For improvement status, see `docs/plans/obsolete/251224_mcp_improvement_audit.md`.

The catalog uses these categories (matching `connector-catalog.json`):

**Communication**: Outlook Mail, Slack, Teams, Intercom, Rebels Community
**Productivity**: Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides), Outlook Calendar, Notion, Asana, Atlassian (Jira/Confluence), monday.com, Todoist, ClickUp, Airtable, Productboard, Calendly, DocuSign, Email (IMAP), Browser Automation, Granola, Fathom, Fireflies, Otter.ai, Gamma, Zendesk, Quill Meetings
**Analytics**: BigQuery, Looker, Metabase, ThoughtSpot, Morningstar, PostHog (EU/US), ChartMogul
**Storage**: OneDrive, SharePoint, Box, Dropbox, Egnyte
**Sales**: HubSpot, Salesforce, Affinity CRM
**Development**: GitHub, Sentry, Vercel, Neon, Supabase, Cloudflare Workers, Linear, Atlassian, MongoDB, PostgreSQL, Simple Browser
**Design**: Canva, Miro, Figma, Framer, Webflow, Wix
**Payments**: Stripe, PayPal, Square, Ramp, Xero
**Media**: ElevenLabs MCP, Kling AI, Nano Banana, OpenAI Image Generation
**Automation**: Zapier

Note: Google Workspace includes Gmail and Google Drive; Microsoft connectors are split into Outlook Mail, Outlook Calendar, OneDrive, SharePoint, and Teams.


### Safety and approvals

The app includes layered safety mechanisms to protect user data and prevent unintended actions:

- **Tool safety**: LLM-evaluated risk assessment for tool calls with configurable user approval levels (see `TOOL_SAFETY.md`).
- **Memory safety**: Per-space approval flow for memory writes, with sensitivity-aware prompting and a safety floor for shared spaces (see `MEMORY_SAFETY.md`).
- **Privacy mode**: Per-session toggle that forces stricter approval prompts for sensitive work.

See `SAFETY_SYSTEM_OVERVIEW.md` for the full safety system architecture.


### Core principles

- **User-friendly**: Prioritize clear, predictable behavior and a responsive UX for both voice and text interactions.
- **Respect the user's attention**: Avoid unnecessary friction and keep interactions focused on what the user is trying to achieve.
- **Do no harm**: Avoid destructive operations by default; treat user projects and data as the primary assets to protect.
- **Ask if you don't know, don't guess**: When intent, risk, or consequences are unclear, prefer asking the user over guessing.
- **Privacy-first architecture**: The app is designed so that Mindstone does not see or touch customer conversations, tool use, or other sensitive data. The app connects directly to models and user data. A lightweight backend (Rebel Platform) handles authentication and allows customer technical-contact-admins to define configuration to speed up employee onboarding, but the privacy-first design for important user data remains. Optional services like analytics and error monitoring are separate from user content.
- **Careful handling of user data**: Be deliberate about where and how data is stored (e.g. conversations, outputs, memories), use open or inspectable formats where possible (e.g. markdown, SQLite), respect permissions, and avoid overwriting or deleting user files without explicit authorization.
- **Thoughtful, scalable risk handling**: Distinguish between low-, medium-, and high-risk actions and surface them appropriately in the UI (e.g. low-risk actions can be automatic, medium-risk actions should be undoable and clearly indicated, high-risk actions should require explicit confirmation). See `TOOL_SAFETY.md`.
- **Model-agnostic**: Treat Anthropic, ChatGPT Pro / Codex, and OpenRouter as first-class choices while remaining flexible enough to work with local/small language models (SLMs) and other OpenAI-compatible endpoints through model profiles (see `LOCAL_MODEL_SUPPORT.md`).
- **MCP-first extensibility**: Use MCP (including Super-MCP router modes) as the primary way to connect to external tools and services, keeping the core app small and composable.
- **Best-in-class context engineering**: Design sessions, MCP usage, and memory so they scale to many skills and connectors without exhausting model context, including appropriate use of sub-agents and streaming event handling. Includes semantic search (`@files`), conversation mentions (`@[...]`), and always-on 1M context when the setting is enabled.
- **Work in parallel where safe**: Use concurrency patterns (message queue, MCP HTTP mode, streaming events) to keep the app responsive without increasing risk. Users can queue messages during agent turns or stop-and-preempt (see `ARCHITECTURE_MESSAGE_QUEUE.md`). Multiple conversations can run simultaneously.
- **Good logging**: Maintain structured logging in main and renderer so failures and edge cases are observable and diagnosable (see `LOGGING.md`).
- **Prefer open standards**: Favor open or widely-supported formats and interfaces (e.g. markdown, SQLite) for storing and integrating data.
- **Strict process separation**: Keep Electron main, preload, and renderer roles clearly separated, with a minimal, typed IPC surface and shared types for cross-process contracts (see `ARCHITECTURE_IPC.md`).
- **Session continuity and history**: Ensure agent sessions can be persisted, resumed safely, and reconnected to upstream model sessions where supported (see `ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md`).
- **Easy to resume after failure**: When something goes wrong, favor patterns that allow the user to recover and continue (e.g. resuming sessions, retrying turns) without losing work.
