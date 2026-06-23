---
description: "Setup Wizard first-run flow, current step order, and the Home attention-card handoff after onboarding."
last_updated: "2026-06-11"
---

### Introduction

This document explains Mindstone Rebel’s Setup Wizard - the first-run onboarding flow that guides new users through initial configuration. It covers the user‑facing journey (screens, decisions, and transitions) and the technical details behind it (settings, IPC, permissions, analytics, and background sync).


For the post-wizard **Tutorial Checklist** (the "Getting Started" sidebar widget), see [ONBOARDING_TUTORIAL_CHECKLIST](ONBOARDING_TUTORIAL_CHECKLIST.md).

Use this doc alongside the linked diagrams for quick orientation, and follow the code/docs references for implementation depth and maintenance.


### References

- `docs/diagrams/251127b_user_onboarding_ui_flow.svg` – UI‑first vertical diagram showing primary screens, decisions, optional paths, the escape hatch, and background system‑settings sync.
- `docs/project/UI_ANIMATIONS.md` – Ambient visual effects (particle starfields, aurora backgrounds) used during onboarding; performance and pause behavior.
- `docs/project/UI_OVERVIEW.md` – App shell, overlays, recorder strip, escape hatch; how onboarding and permission surfaces fit into the UI.  
- `docs/project/ARCHITECTURE_OVERVIEW.md` – Process boundaries and high‑level flows; onboarding and audio‑intro linkage called out explicitly.  
- `docs/project/SETUP_USER.md` – End‑user setup, Gatekeeper first‑open, permissions, and the first session.  
- `docs/project/LIBRARY_AND_FILE_ACCESS.md` – Workspace model, file‑tree behavior, and file‑access checks used during onboarding.  
- `docs/project/VOICE_AND_AUDIO.md` – Microphone permissions, voice provider behavior, and the audio‑intro handoff.  
- `docs/project/REBEL_SYSTEM_SYNC.md` – How “rebel-system” are synced (dev submodule vs. production zip) and how the `rebel-system/` symlink appears in the workspace.  
- Code (renderer): `src/renderer/App.tsx`, `src/renderer/features/onboarding/OnboardingWizard.tsx`, `src/renderer/features/onboarding/hooks/useOnboardingFlow.ts`, `src/renderer/features/permissions/usePermissionsOrchestrator.ts`, `src/renderer/PermissionComponents.tsx`, `src/renderer/src/tracking.ts`  
- Code (preload): `src/preload/index.ts` (typed `window.api` bridge)  
- Code (main): `src/main/settingsStore.ts`, `src/main/ipc/settingsHandlers.ts`, `src/main/ipc/permissionsHandlers.ts`, `src/main/services/systemSettingsSync.ts`, `src/main/index.ts`
- `docs/tutorials/251129a_mcp_config_pointer_and_supermcp_explainer.html` – MCP config pointer vs write locations, and how Super‑MCP transport is chosen (collapsible details).
- `docs/diagrams/251129a_mcp_config_pointer_supermcp_simple.svg` – Simplified visual of pointer/write flow and Super‑MCP mode selection.
- [DEMO_MODE](./DEMO_MODE.md) – Demo mode for presentations; bypasses onboarding with temporary data isolation.
- [THE_SPARK](THE_SPARK.md) – The Spark dashboard; personalized workflows are generated during or after onboarding.


### Principles, key decisions

- **Voice‑first, text‑friendly**: Onboarding gets you to a productive voice experience fast, while keeping text fully usable.  
- **One shell, progressive activation**: Users land in a single window/shell; we gate advanced capabilities with clear, optional steps.  
- **Safe by default**: Workspace access is explicit; file‑access checks are verified; microphone is optional at onboarding.  
- **Optional integrations don’t block**: Shared Drives and individual tool authentication are skippable or “later in Settings”.  
- **Background sync is non‑blocking**: The “rebel-system” sync runs after startup and creates a `rebel-system/` symlink into the workspace when ready.  
- **Escape hatch exists**: A secret hotkey lets support guide users past onboarding if something breaks.  
- **Telemetry with restraint**: Step views/completions and escape‑hatch usage are tracked; sensitive data is not.


### High‑level UI flow

See the simplified diagram: `docs/diagrams/251127b_user_onboarding_ui_flow.svg`.

- **Welcome**  
  - Minimal copy; “Get started” primary action.

- **Step 1 — Spaces & Shared Folders (optional)**  
  - Connect shared folders from Google Drive, OneDrive, iCloud, Dropbox, or any cloud storage.
  - Click "Add Space" to open the Add Space Wizard as a dialog.
  - Spaces are created **immediately** when the wizard completes (not batched on Continue).
  - Connected spaces appear in a list; users can remove spaces before continuing.
  - You can Skip; the main path still progresses.
  - **Google Drive guidance**:
    - Install detection shows whether Google Drive is installed on the system.
    - Offline guidance appears if any connected space uses Google Drive storage.
  - **Frontmatter detection**: If a selected folder has README.md with `rebel_space_description` frontmatter, the wizard switches to `add-existing` mode (read-only metadata).
  - See [SPACES.md](SPACES.md#onboarding-integration) for technical details.

- **Step 2 — Claude API connection**  
  - Claude access is configured here (Claude Max login or Claude API key).  
  - This step also lets the user choose the Library/workspace folder via the inline “Choose folder” control.
  - Missing Claude credentials show inline prompts; these guard progression from this step.
  - **Auto-skip for returning users**: If the user already has valid Claude AND voice provider keys (validated on wizard open), this step is skipped entirely. This improves the experience when relaunching the wizard or for users who configured keys via Settings first. Network errors during validation cause the step to show (fail-safe).

- **Step 3 — Voice setup**  
  - Voice has its own dedicated step (`VoiceSetupStep.tsx`).
  - Users can enable the microphone here and optionally switch providers.
  - On macOS and Windows, voice defaults to `local-parakeet`; OpenAI Whisper and ElevenLabs Scribe remain available if the user prefers cloud transcription.

- **Step 4 — Tool authentication (optional)**  
  - Connect your email (Gmail or Outlook), calendar, and chat tools via local OAuth.
  - OAuth flows use bundled local MCPs (Google Workspace, Microsoft 365, Slack) for privacy-first authentication.

- **Permissions after the wizard**  
  - Permissions are no longer a numbered wizard step.
  - If microphone or file access is still missing after configuration, `PermissionOnboardingDialog` / `usePermissionsOrchestrator` guide the user separately.

- **Finish → Home activation**  
  - Finishing sets setup onboarding complete; users land on Home rather than being forced into the coaching conversation.
  - Home shows a persistent activation card in "Needs your attention today" until the onboarding coach conversation completes. The card is non-dismissible but non-blocking: users can use the app normally, then start or resume the intro from Home.
  - If permissions are still missing later, a compact banner re‑guides the user.

- **Escape hatch (secret hotkey)**  
  - Cmd/Ctrl + Shift + Alt/Option + E.  
  - During onboarding wizard: shows a confirmation dialog; confirming completes onboarding and skips the audio intro.  
  - During audio intro: immediately skips to the main landing screen (no confirmation, since setup is already complete).  
  - Intended for support; tracked via `tracking.onboarding.escapeHatch*`.  
  - See [UI_LAYOUT_AND_INTERACTION_PATTERNS](UI_OVERVIEW.md#onboarding-escape-hatch-support-reference) for full hotkey and implementation details.


### Technical overview (developer)

- **First‑run gating & flags**
  - Settings default (`electron-store`): `onboardingCompleted: false` (`src/main/settingsStore.ts`).  
  - Renderer shows the wizard when `!settings.onboardingCompleted` (`usePermissionsOrchestrator.ts`).  
  - A separate localStorage key (`permission-onboarding-shown`) gates the permission dialog/banner after configuration.
  - Settings action `Relaunch onboarding` sets `onboardingCompleted=false` and clears `permission-onboarding-shown`, then opens the wizard again (implemented in `src/renderer/features/permissions/usePermissionsOrchestrator.ts` and surfaced in Settings → Onboarding & Actions).
  - **Relaunch reset contract:** relaunch also clears every coach-completion/resume signal via `clearCoachCompletionState` (`src/renderer/features/onboarding/utils/coachCompletionState.ts` — the SSOT paired with the Home activation-card suppression predicate `hasCoachCompletionSignal`), so after re-completing the wizard the Home activation card shows again and offers a fresh intro. It deliberately does NOT reset tutorial-checklist progress (`onboardingChecklist.step` / `completedSteps[1-4]`) — that's the separate Settings "Reset Tutorial Checklist" action (see [ONBOARDING_TUTORIAL_CHECKLIST](ONBOARDING_TUTORIAL_CHECKLIST.md)).

- **Wizard state & steps**
  - Steps are defined in `useOnboardingFlow.ts` as `FULL_STEP_SEQUENCE`:  
    `['welcome', 'googleDrive', 'api', 'voiceSetup', 'toolAuth']`  
  - **Dynamic step sequence**: Steps are conditionally removed based on user state:
    - The `'api'` step is skipped if the user already has valid API keys (async validation on wizard open via `canSkipApiStep`).
    - The `'googleDrive'` (Spaces) step is skipped for free-tier users (`licenseTier === 'free'` from `auth:get-config`) who don't have a license to create spaces (via `canSkipGoogleDriveStep`).
    - Both use a `stepIndexRef.current === 0` guard to only apply if the user is still on the welcome step when the async check resolves. See `useOnboardingFlow.ts`.
  - Each step owns minimal validation; the “Continue” button is disabled or reveals a hint until ready.  
  - On Finish, `completeOnboardingFlow()` sets `onboardingCompleted=true` and lets the main app render Home.
  - The onboarding coach conversation is started or resumed explicitly from the Home attention card. Completion persists `onboardingCompletedAt`, `onboardingDay: 1`, and `onboardingChecklist.completedSteps[0]`.
  - The old permissions step has been removed from the wizard; post-configuration permission prompting is handled separately by `PermissionOnboardingDialog` and `usePermissionsOrchestrator`.

- **Workspace handling**
  - Default suggestion via `settings:get-default-workspace` (Documents/Mindstone Rebel).  
  - Access check via `permissions:check-file-access`:  
    - Dev: bypass strict checks; ensure directory exists.  
    - Prod: mkdir + read/write + probe file create/read/delete.  
  - See `docs/project/LIBRARY_AND_FILE_ACCESS.md` for the full contract and safety rails.

- **Permissions**
  - Microphone status/request: `permissions:get-microphone-status` / `permissions:request-microphone` (macOS uses `systemPreferences`).  
  - Open System Settings deep‑links: `permissions:open-system-preferences('files'|'microphone')`.  
  - Permission banner/dialog in the renderer: `PermissionComponents.tsx`; orchestration in `usePermissionsOrchestrator.ts`.
  - This permission flow is now separate from the numbered setup wizard and runs after onboarding when access is still missing.

- **Tool Authentication + MCP**
  - Tool authentication uses bundled local MCPs (Google Workspace, Microsoft 365, Slack) for privacy-first OAuth.  
  - Tool authentication step generates OAuth links and polls verification.  
  - All MCP resolution/Super‑MCP interactions are handled in main; see `mcpService.ts` and `SUPERMCP_OVERVIEW.md` (signposted from system architecture docs).

- **System settings sync (rebel-system)**
  - Dev: local git submodule at `rebel-system`; the app reads directly from that folder.  
  - Prod: on startup, `syncSystemSettingsIfNeeded()` compares `package.json.systemSettings.version`; if newer, downloads the tagged ZIP from GitHub into Application Support, sets read‑only, and updates a local version file.  
  - After sync (or immediately in dev), `createWorkspaceSymlink(coreDirectory)` creates `rebel-system/` in the workspace so the agent can read shared “system settings”.  
  - See `docs/project/REBEL_SYSTEM_SYNC.md` for operational details and the update script (`npm run update-rebel-system`).

- **AGENTS.md and CLAUDE.md symlinks (Cursor/IDE fallback)**
  - After workspace symlink creation, `createAgentsMdSymlink()` creates root `AGENTS.md` → `rebel-system/AGENTS.md`.
  - Then `createClaudeMdSymlink()` creates root `CLAUDE.md` → `AGENTS.md`.
  - These provide Cursor and Claude Code users with platform instructions when using external IDEs.
  - The `rebel-system/AGENTS.md` includes an `EXTERNAL-IDE-FALLBACK` block telling external IDEs to read `Chief-of-Staff/AGENTS.md`.
  - In the Rebel app, the composite system prompt is rendered via Nunjucks (see `docs/project/SYSTEM_PROMPT.md`).
  - Symlinks are idempotent and will not overwrite existing non-symlink files.

- **Home activation & onboarding coach**
  - After Finish, Home renders the activation card in "Needs your attention today" when setup is complete but the coach intro is not.
  - `OnboardingCoachOrchestrator` starts the coach only after an explicit Home launch request, then pre-seeds the first assistant greeting and watches for completion/deferred markers.
  - The "Later" path returns to Home without setting `onboardingCompletedAt`, so the activation card remains available.
  - Voice provider calls are owned by main (`audioService.ts`); renderer uses the typed preload bridge.  
  - See `docs/project/VOICE_AND_AUDIO.md`.

- **Analytics & logging**
  - Onboarding step viewed/completed, completion totals, and escape‑hatch events are tracked via `src/renderer/src/tracking.ts`.  
  - Renderer logs are routed to main’s logger; see `docs/project/LOGGING.md`.


### Background behavior (non‑blocking, no “memory ingestion”)

- The app does not run background “ingestion” or build long‑term memories during onboarding.  
- What may run:
  - Tool‑auth verification is manual only; no polling occurs in the background.  
  - System‑settings sync (rebel-system) after startup; creates a `rebel-system/` symlink into the workspace once ready.  
  - Automations with `runOnLaunch=true` (if any).  
  - “Attention suggestions” generation runs on demand (dashboard overlay). A prefetch API exists but is not invoked by default.


### Gotchas, limitations, troubleshooting

- **Workspace access is required to finish**: On macOS, grant Files & Folders for the chosen workspace; the wizard loops with an explicit hint until granted.  
- **Gatekeeper first‑open**: See `SETUP_USER.md` for the right‑click “Open” workflow and Privacy & Security → “Open Anyway”.  
- **Missing API keys**: API step blocks forward progress until keys are present for the selected providers.  
- **Dev vs Prod file‑access checks**: Dev bypasses strict entitlements and ensures directory existence; Prod performs mkdir + R/W probe.  
- **Microphone is optional**: Voice can be enabled later; a banner helps if permissions are missing in normal use.  
- **Diagrams as source of truth for UX**: Keep `251127b_*.mermaid` aligned with step text and decisions to avoid confusion.


### Appendix: Key IPC surfaces (selected)

- Settings pickers: `settings:choose-directory`, `settings:choose-file`, `settings:get-default-workspace`  
- Permissions (main): `permissions:get-microphone-status`, `permissions:request-microphone`, `permissions:check-file-access`, `permissions:open-system-preferences`  
- Voice (main): `voice:transcribe`, `voice:text-to-speech`, `voice:tts-chunk`  
- System settings sync (main): `syncSystemSettingsIfNeeded()`, `createWorkspaceSymlink()`  
- Preload exposes typed `window.api` wrappers for all of the above.


