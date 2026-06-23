---
description: "Demo mode architecture and lifecycle — temp userData isolation, restart flow, sample environment seeding, entry/exit UX, and cleanup"
last_updated: "2026-04-16"
---

### Introduction

Demo Mode allows showcasing Mindstone Rebel without affecting user data. When active, the app runs in a **completely isolated environment** using a temporary userData directory. All demo data is discarded when exiting demo mode.

The isolation is achieved by restarting the app with `app.setPath('userData', tempDir)` called before any Electron stores are initialized, so all persistence automatically goes to the temp directory.


### See also

- [ONBOARDING_SETUP_WIZARD](./ONBOARDING_SETUP_WIZARD.md) – Onboarding wizard and setup flow; demo mode skips onboarding entirely.
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) – App settings storage and configuration surfaces.
- Code (main): `src/main/services/demoModeService.ts` – Core demo mode lifecycle, environment seeding, cleanup.
- Code (main): `src/main/startup/ensureDemoModeUserData.ts` – Early startup hook that redirects userData path.
- Code (main): `src/main/ipc/demoHandlers.ts` – IPC handlers for entering/exiting demo mode.
- Code (renderer): `src/renderer/components/DemoModeDialog.tsx` – Entry dialog with API key option.
- Code (renderer): `src/renderer/features/flow-panels/FlowPanelsShell.tsx` – Header indicator and exit/restart buttons.
- Code (renderer): `src/renderer/hooks/useDemoMode.ts` – React hook for demo mode status.


### How it works

Demo mode uses a **restart-based isolation** approach:

1. **Entry**: `enterDemoMode()` creates a temp directory, writes a flag file to `os.tmpdir()`, and restarts the app.
2. **Early startup**: Before any stores initialize, `ensureDemoModeUserData.ts` reads the flag and calls `app.setPath('userData', tempDir)`.
3. **Automatic isolation**: Because all Electron stores use `app.getPath('userData')`, all persistence automatically goes to the demo temp directory.
4. **Environment seeding**: A workspace structure is pre-created with realistic folders for onboarding demos.
5. **Exit**: Clears the flag, marks the temp dir for cleanup, and restarts back to normal mode.


### Entry and exit

**Entering demo mode**

Demo mode can be entered via:
- **App menu → "Start Demo Mode..."** – Opens a dialog with options
- **Settings → Advanced (Support tab) → Advanced → Demo Mode → "Enter Demo Mode"** – Quick entry (no API keys)

The entry dialog (`DemoModeDialog.tsx`) offers two options:
- **Keep my API keys** – Copies provider configuration to demo settings so agent turns work. This includes Claude/OpenAI/ElevenLabs API keys, the active provider selection, OpenRouter settings (OAuth token, selected model), model profiles, and custom providers.
- **Completely fresh start** – No keys or provider settings copied; requires manual configuration in demo

**Entry behavior**:
- If agent turns are in progress, they are **force-aborted** before restart
- A unique temp directory is created: `$TMPDIR/mindstone-demo-<timestamp>-<random>`
- The app restarts to apply the userData redirection

**Exiting demo mode**

When demo mode is active, the header shows:
- A **Demo Mode indicator**
- **Exit Demo** button – Returns to normal mode
- **Restart Demo** button – Creates fresh demo environment

**Exit behavior**:
- Active agent turns are force-aborted
- The temp directory is marked for cleanup
- The app restarts back to normal userData


### Environment seeding

When entering demo mode, `seedDemoEnvironment()` creates a fully configured account. The user lands directly in the main app — onboarding is skipped.

**Folder structure** (with "Include sample content" checked):

```
$TMPDIR/mindstone-demo-<id>/
├── Rebel/                              # coreDirectory (workspace root)
│   ├── Chief-of-Staff/                 # Personal space (skills, memories)
│   └── work/ACME Corp/
│       ├── General/                    # Company-wide space
│       └── Product Team/              # Team space (roster, rituals, OKRs)
├── ACME Corp/                          # External folder (simulated Google Drive)
│   └── General/
└── app-settings.json                   # Pre-seeded settings
```

**Pre-seeded settings**:
- `onboardingCompleted: true` — skips onboarding wizard
- `coreDirectory`, `workspaceName`, `companyName`
- `userEmail`, `userFirstName` — demo persona
- `spaces` — Chief-of-Staff + work spaces (when sample content enabled)
- `eulaAcceptedAt`, `onboardingFirstCompletedAt`
- Optionally: API keys and provider settings if user selected "Keep my API keys" (active provider, OpenRouter config, model profiles, custom providers)

**Sample content** (when "Include sample content" is checked):
- Chief-of-Staff: skills (meeting-prep, email-drafting, weekly-summary) + memories (contacts, board members, projects)
- Product Team: team roster, meeting rituals, active projects, Q1 OKRs
- General: company-wide README


### Data isolation

| Data Type | Normal Mode | Demo Mode |
|-----------|-------------|-----------|
| All Electron stores | User's `userData` | Temp directory |
| Sessions | Persisted | Isolated (temp dir) |
| Inbox | Persisted | Isolated (temp dir) |
| Settings | Persisted | Isolated (temp dir) |
| Workspace | User's `coreDirectory` | Demo `Rebel/` folder |
| MCP config | User's config | Fresh (no MCPs configured) |
| API keys & provider config | User settings | **Optional** (copied if requested — includes active provider, OpenRouter, model profiles, custom providers) |

**Note**: If "Keep my API keys" is selected, agent turns consume API credits from the user's account.


### IPC contract

```typescript
// Enter demo mode (triggers restart)
'demo:enter': {
  request: { keepApiKeys?: boolean },
  response: { success: boolean; error?: string; requiresRestart: true }
}

// Exit demo mode (triggers restart)
'demo:exit': {
  request: void,
  response: { success: boolean; error?: string; requiresRestart: true }
}

// Check current demo mode status
'demo:status': {
  request: void,
  response: { active: boolean; hasActiveTurns: boolean }
}
```


### Cleanup

**Automatic cleanup**:
- On exit: Current demo directory is marked for cleanup via `$TMPDIR/mindstone-demo-cleanup.txt`
- On normal startup: `cleanupMarkedDemoDirs()` deletes marked directories
- On normal startup: `cleanupOrphanedDemoDirs()` deletes stale `mindstone-demo-*` dirs older than **7 days**

**Manual cleanup**:
If needed, orphaned demo directories can be deleted: `rm -rf $TMPDIR/mindstone-demo-*`


### Path validation in demo mode

Demo mode loosens some workspace path validations (`libraryHandlers.ts`):
- Skips "system folder" warnings (macOS temp paths are under `/var/folders/`)
- Skips "temp directory" warnings (demo intentionally uses temp)
- Skips "app userData directory" warning (demo workspace is inside demo userData)


### Development mode behavior

In development (`!app.isPackaged`):
- Entry/exit spawns a new terminal running `npm run dev` with a 2s delay (to free port 5173)
- Then quits the current app process
- Packaged builds use `app.relaunch()` directly


### Limitations

1. **Restart required**: Entry and exit both require app restart.
2. **API costs**: If keys are copied, agent turns consume actual API credits.
3. **No persistence**: All demo data is lost on exit.
4. **No headless support**: Demo mode is UI-only; not available in CLI mode.
5. **Single instance**: Only one demo session can be active at a time.


### Use cases

- **Demos and presentations**: Show Rebel's capabilities without affecting production data
- **Training new users**: Let users explore without fear of messing up their workspace
- **Testing onboarding flows**: Enter demo mode, then relaunch onboarding from Settings → Advanced (Support tab)
- **Debugging**: Isolate behavior in a clean environment
