---
description: "Set up a local Mindstone Rebel development environment, including repo sync, provider auth, and basic verification checks."
last_updated: "2026-04-16"
---

### Introduction

This document describes how to get a local development environment running for Mindstone Rebel: prerequisites, installation steps, configuration, and basic “it actually works” checks.  
It is intentionally concise and signposts to other docs as the single sources of truth for deeper architectural or feature details.


### See also

- [README.md](../../README.md) – Quickstart commands for install, dev server, build, and lint
- [AGENTS.md](../../AGENTS.md) – Guidance for AI agents working on this repo (how to run tools, where to look in the code)
- [GIT_WORKTREES.md](GIT_WORKTREES.md) - Git worktree setup steps
- [SETUP_USER.md](SETUP_USER.md) - End-user setup and onboarding: installing a packaged build, first run, permissions, and first conversation
- [SECRET_SCANNING.md](SECRET_SCANNING.md) - TruffleHog pre-commit + CI secret scanning (mandatory; install required)
- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) – High-level system architecture, component responsibilities, and data flows
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) – Canonical reference for app settings, configuration surfaces, and environment variables
- [LOCAL_BACKEND_DEVELOPMENT.md](LOCAL_BACKEND_DEVELOPMENT.md) – Running the Electron app against a local rebel-platform backend
- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) - MCP and Super-MCP configuration, discovery, HTTP vs stdio mode selection, and troubleshooting
- [VOICE_AND_AUDIO.md](VOICE_AND_AUDIO.md) – Voice/audio pipeline (STT/TTS, permissions, playback) and provider behavior
- [REBEL_SYSTEM_SYNC.md](REBEL_SYSTEM_SYNC.md) - How rebel-system is synced from GitHub, submodule usage in dev mode
- [BUILD_AND_RELEASE_OVERVIEW](BUILD_AND_RELEASE_OVERVIEW.md) – Hub for all build/release docs (packaging, CI, distribution)
- [CLAUDE_AGENT_SDK_REFERENCE.md](../research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md) – Archived reference for the removed Claude Agent SDK (historical — SDK was removed April 2026)


### Principles, key decisions

- **Cross‑platform**: The app targets macOS and Windows. Development works on both platforms where Electron and Node are supported. See [WINDOWS_SUPPORT.md](WINDOWS_SUPPORT.md) for Windows-specific implementation details.  
- **Keep docs and scripts aligned**: Prefer the existing npm scripts (`dev`, `build`, `lint`, `package`, `dist`) and update this doc if those change.  
- **Safe defaults first**: Start with a simple, local dev setup; advanced MCP, HTTP mode, and production‑style Node bundling are optional layers you can enable once the basics work.


### Prerequisites

- **Operating system**
  - macOS or Windows (both are fully supported for development and distribution).  
  - Linux is in beta.

- **Node.js and npm**
  - Install a recent Node.js LTS release (Node 20+ recommended).  
  - `npm` is required for `npm ci`, `npm run dev`, and the build/packaging scripts.  
  - You do *not* need system `npx` available in production – the app bundles its own Node/npm/npx for packaged builds (see [BUILDING](./BUILDING.md)), but you do need a working Node/npm locally to build that bundle.

- **Git & repo access**
  - Clone the repo:
    ```bash
    git clone [external-email]:mindstone/rebel-app.git
    cd mindstone-rebel
    git checkout dev
    ```
  - Day-to-day work happens on `dev`. Before making larger changes, use the approved sync command from the repo root:
    ```bash
    npx tsx scripts/git-safe-sync.ts --no-push
    ```
  - Initialize submodules (including the `rebel-system` submodule):
    ```bash
    git submodule update --init --recursive
    ```
    See `../../AGENTS.md` (Submodules section) for the single‑source‑of‑truth description and `./GIT_WORKTREES.md` for worktree‑specific guidance.

- **TruffleHog (secret scanning — mandatory)**
  - Required by the pre-commit hook. The dev setup script installs it automatically; manual install:
    ```bash
    brew install trufflehog      # macOS
    ```
  - Linux/Windows install + bypass + FP handling: see [SECRET_SCANNING.md](SECRET_SCANNING.md).

- **Provider auth (for full feature testing)**
  - **Agent runs** — Configure **one** supported agent auth path in Settings → Agents:
    - **Anthropic API key** (direct Anthropic access)
    - **OpenRouter OAuth** (multi-provider gateway)
    - **ChatGPT Pro / Codex** (subscription-backed OpenAI routing)
  - **OpenAI** – Optional shared provider key for Whisper/TTS and other OpenAI-backed features.
  - **ElevenLabs** – Optional for ElevenLabs Scribe/TTS testing.
  - You can start development without every provider configured, but agent turns, voice, or provider-specific flows stay limited until the relevant credentials are connected.


### Install and basic commands

- **First-time setup (fresh clone)**

  ```bash
  git clone --recurse-submodules https://github.com/mindstone/rebel-app.git
  cd rebel-app
  npm run setup
  npm run dev
  ```

  `npm run setup` (`scripts/oss-setup.mjs`) is the one-shot, cross-platform
  bootstrap for a fresh clone: it checks prerequisites (Node 20+, npm, git),
  initialises the submodules (with a network retry), runs `npm ci`, builds
  super-mcp and the bundled MCP connectors, and scaffolds `.env.local` from
  `.env.example`. It is zero-prompt — you add your AI key inside the app
  (Settings → Agents) on first run, not here.

- **Install dependencies** (already handled by `npm run setup`; run directly when
  you only need to refresh dependencies)

  ```bash
  npm ci
  ```

- **Run in development**

  ```bash
  npm run dev
  ```

  This runs both the Electron main process and the renderer with hot reload. Use the Electron devtools in the renderer for debugging UI and agent behavior.

- **Build release artifacts**

  ```bash
  npm run build
  ```

  This runs the production build/make flow and produces release artifacts. See [BUILDING](./BUILDING.md) for packaging details and output locations.

- **Lint / type‑check**

  ```bash
  npm run lint
  npm run lint:ts
  ```

  `npm run lint` runs ESLint. `npm run lint:ts` runs strict TypeScript checking (`tsc --noEmit`) and is the primary way to catch type errors before committing.

- **Package / dist (macOS)**

  ```bash
  # Unpacked app for local testing
  npm run package

  # Signed DMG for installation
  npm run dist
  ```

  For details on what these commands produce and how to install/test the packaged app, see [BUILDING](./BUILDING.md).


### Core app configuration

Most configuration is done inside the running app via its **Settings** UI. The key concepts are:

- **Core workspace directory**
  - The app is designed to work against a user‑selected “core” directory (typically a codebase).  
  - In Settings, choose a directory for `coreDirectory` using the file picker.  
  - Workspace operations (file tree, read/write, create/rename/delete) are restricted to this root; see `./LIBRARY_AND_FILE_ACCESS.md` for the canonical reference and the “Workspace integration and file operations” section in `./ARCHITECTURE_OVERVIEW.md` for a high‑level overview.

- **MCP configuration**
  - MCP servers are configured via JSON config files (Claude Desktop, Cursor, Super‑MCP, or project‑local variants).  
  - In Settings, set the MCP config file path (`mcpConfigFile`); the main process will resolve and normalize it.  
  - For details of supported shapes, mode selection (direct vs Super‑MCP), and HTTP mode, see:
    - `./MCP_ARCHITECTURE.md` – canonical reference for MCP and Super‑MCP configuration  
    - `./SUPERMCP_OVERVIEW.md` for HTTP transport behavior  
    - [BUILDING](./BUILDING.md) for production Node/npm/npx considerations

- **Voice and audio**
  - Voice settings control provider (`openai-whisper` vs `elevenlabs-scribe`), model, and API keys.  
  - The main process owns STT/TTS requests; the renderer talks to it via IPC.  
  - See `./VOICE_AND_AUDIO.md` and the "Audio pipeline" section in `./ARCHITECTURE_OVERVIEW.md` for details.


### Environment variables

Most development flows only need provider auth configured in the app plus any STT/TTS keys you plan to test with. Additional environment variables are useful for advanced scenarios; see `./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md#environment-variables` for the canonical list and detailed explanations:

- **MCP / Super‑MCP**

  ```bash
  export SUPER_MCP_HTTP_PORT=3200         # Optional: prefer a specific HTTP port for the Super-MCP router
  export MINDSTONE_FORCE_DIRECT_MCP=true  # Debug only: force direct MCP mode, bypassing Super-MCP
  ```

  Rebel uses a **router‑first, HTTP‑only** Super‑MCP model by default. See `./SUPERMCP_OVERVIEW.md` and `./MCP_ARCHITECTURE.md` for details.

- **Removed SDK-era variables**

  Rebel Core no longer uses Claude Agent SDK environment variables such as `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`. If you see them in older notes, treat them as historical only — they are not part of the current setup flow.

- **Logging**

  ```bash
  export MINDSTONE_LOG_LEVEL=debug
  ```

  In development this increases log verbosity; in packaged macOS builds logs are written under  
  `~/Library/Application Support/mindstone-rebel/logs/`.  
  See `./LOGGING.md` for details of log architecture and other logging‑related environment variables.


### Verifying your setup

After installing dependencies and running `npm run dev`:

1. **App launches**
   - Electron window opens without errors.  
   - You can open devtools in the renderer.

2. **Core directory configured**
   - Open Settings and choose a `coreDirectory`.  
   - The workspace sidebar should show a file tree (respecting depth/children limits described in `./ARCHITECTURE_OVERVIEW.md`).

3. **Agent runs**
   - Configure one supported agent auth path (Anthropic API key, OpenRouter, or ChatGPT Pro / Codex).
   - Send a simple text message; the agent should respond without MCP tools initially.  
   - Optionally configure MCP and verify tool usage.

4. **Voice works (optional)**
   - Set either `openaiApiKey` or `elevenlabsApiKey` in settings.  
   - Use push‑to‑talk; verify that transcription appears and the agent responds.

5. **Build & validation**
   - Run `npm run build`, `npm run lint`, and `npm run lint:ts`.
   - All should complete successfully; fix any ESLint or TypeScript errors before committing changes.


### Quick tip: reset onboarding during development

When you’re iterating on the permissions/onboarding UI, you may want to re-run onboarding repeatedly. Use the renderer devtools console to reset it:

1. Open the Electron renderer devtools (View → Toggle Developer Tools).
2. Switch to the Console tab.
3. Paste and run:

```js
await window.api.updateSettings({
  ...(await window.api.getSettings()),
  onboardingCompleted: false
});
localStorage.removeItem('permission-onboarding-shown');
location.reload();
```

This sets `onboardingCompleted` back to `false` and clears the localStorage flag for the permission dialog so the onboarding flow shows again after reload.


### Troubleshooting and further reading

- If the app launches but agent runs fail or MCP tools do not work, start with:
  - `./SUPERMCP_OVERVIEW.md` – for HTTP mode and concurrency issues.  
  - [DISTRIBUTION](./DISTRIBUTION.md) – if problems only appear in packaged builds.
  - `./ARCHITECTURE_OVERVIEW.md` – for process boundaries (which layer is likely at fault).
- For voice issues, see `./VOICE_AND_AUDIO.md`.  


### Maintenance

- Keep this doc aligned with:
  - npm scripts in `package.json`  
  - key environment variables listed in `./ARCHITECTURE_OVERVIEW.md` and feature docs  
  - any new docs that become the canonical references for MCP, workspace access, voice, or troubleshooting  
- When you change build scripts, core configuration flows, or environment‑variable behavior, update this doc alongside `AGENTS.md`, and relevant project/reference docs.


