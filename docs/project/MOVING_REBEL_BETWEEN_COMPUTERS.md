---
description: "Developer guide for the MANUAL file-copy migration of Rebel between computers — userData, workspace folders, path-sensitive settings, MCP router reset. The assisted .rebeltransfer flow is documented separately in MIGRATION_BETWEEN_MACHINES.md."
last_updated: "2026-06-10"
---

# Moving Rebel Between Computers

How to move Rebel from one computer to another, use Rebel on multiple machines, or relocate the workspace folder.

> **There is now an assisted migration flow.** Rebel can export/import a portable `.rebeltransfer` bundle (read-only on the source, never mutates a live install) — see [MIGRATION_BETWEEN_MACHINES.md](./MIGRATION_BETWEEN_MACHINES.md). **This document is the manual file-copy fallback** for cases the assisted flow doesn't cover (or when you need to relocate the workspace folder in place).

## See also

- [moving-rebel-to-a-new-computer.md](../../rebel-system/help-for-humans/moving-rebel-to-a-new-computer.md) — **user-facing version** of this guide (bundled with app)
- [ELECTRON_STORAGE_REFERENCE.md](./ELECTRON_STORAGE_REFERENCE.md) — full inventory of files in userData
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — AppSettings schema (including `mcpConfigFile`, `coreDirectory`)
- [MCP_ARCHITECTURE.md](./MCP_ARCHITECTURE.md) — MCP router config format and discovery
- [SUPERMCP_OVERVIEW.md](./SUPERMCP_OVERVIEW.md) — Super-MCP HTTP lifecycle and troubleshooting
- [rebel-system/help-for-humans/where-rebel-stores-things.md](../../rebel-system/help-for-humans/where-rebel-stores-things.md) — user-facing storage summary
- [MIGRATIONS.md](./MIGRATIONS.md) — *unrelated*: store schema versioning and data format migrations (not computer-to-computer transfer)

---

## What Rebel Stores and Where

Rebel persists data in two locations:

| Location | What lives here | Platform path |
|----------|----------------|---------------|
| **userData** (Application Support) | Settings, sessions, inbox, MCP config, OAuth tokens, logs, indices | macOS: `~/Library/Application Support/mindstone-rebel/` · Windows: `%APPDATA%\mindstone-rebel\` |
| **Workspace** (user-chosen) | User documents, Chief-of-Staff instructions, memory spaces | Wherever the user set `coreDirectory` in Settings |

See [ELECTRON_STORAGE_REFERENCE.md](./ELECTRON_STORAGE_REFERENCE.md) for the full directory tree.

---

## Moving Rebel to a New Computer

### Step 1: Copy the two directories

1. **userData** — copy the entire `mindstone-rebel/` folder from Application Support (or `%APPDATA%` on Windows) to the same location on the new machine.
2. **Workspace** — copy the workspace folder (whatever path was set as `coreDirectory`) to the new machine.

### Step 2: Fix path-sensitive settings

Several settings in `app-settings.json` store **absolute paths** that will break if the username or directory structure changes:

| Setting | What it points to | Typical old value |
|---------|-------------------|-------------------|
| `coreDirectory` | Workspace folder | `/Users/olduser/Documents/Rebel/Core` |
| `mcpConfigFile` | Super-MCP router config | `/Users/olduser/Library/Application Support/mindstone-rebel/mcp/super-mcp-router.json` |

**Fix**: Open `app-settings.json` in a text editor and update these paths to their new locations. Or see "Resetting the MCP router" below if the router file itself is stale.

> **Note — embedded paths in conversation data**: Absolute paths from the old machine can also be embedded inside session/conversation JSON files (e.g. file paths referenced in tool calls or results). These won't break core functionality but may cause stale references. If needed, a recursive find-and-replace across the userData directory can fix them — e.g. replacing `/Users/olduser/` with `/Users/newuser/`. Be careful with regex tools; a simple literal string substitution (e.g. `sed` with a fixed string) is more reliable than a regex pattern here.

### Step 3: Reset the MCP router (recommended)

The `super-mcp-router.json` file inside `userData/mcp/` contains absolute paths in several places:

- `configPaths` — array of external config files (Cursor, Claude Desktop, etc.)
- `mcpServers.*.command` — paths to bundled MCP server scripts
- OAuth credential paths embedded in server entries

These paths are almost certainly wrong on the new machine. The cleanest fix:

1. **Quit Rebel** completely.
2. **Delete** (or rename) the stale router file:
   ```bash
   # macOS
   rm ~/Library/Application\ Support/mindstone-rebel/mcp/super-mcp-router.json

   # Windows (PowerShell)
   Remove-Item "$env:APPDATA\mindstone-rebel\mcp\super-mcp-router.json"
   ```
3. **Clear `mcpConfigFile`** in `app-settings.json` — delete the key entirely or set it to `""`.
4. **Launch Rebel.**

On startup, the app will:
- See that `mcpConfigFile` is empty → call `ensureRouterConfigFile()` to create a fresh skeleton at `userData/mcp/super-mcp-router.json`
- Save the correct new path back to settings
- Run `upsertMcpServersBatch()` to register all bundled MCP servers (RebelInbox, etc.) with correct paths for the current machine

**What you keep**: conversations, inbox items, memory, automations, settings (API keys, model preferences, etc.).

**What you lose**: OAuth connector sessions (Google Workspace, Microsoft 365, Slack, etc.) and any external `configPaths` references. You will need to re-authenticate these connectors from the Connections panel.

### Step 4: Re-authenticate OAuth connectors

After the router reset, go to **Settings → Connections** and re-connect any OAuth-based services (Google Workspace, Microsoft 365, Slack, Salesforce, HubSpot, etc.). The app will register fresh MCP server entries with correct paths.

---

## Moving the Workspace Folder

If you just want to relocate the workspace to a different path (same computer):

1. Move the folder to its new location.
2. In Rebel, go to **Settings** and update the workspace directory to the new path.

The `coreDirectory` setting updates automatically. No MCP router reset is needed.

---

## Using Rebel on Multiple Computers

Rebel does not currently have built-in sync between machines. Each install is independent. If you want a similar setup on two machines:

- Copy userData and workspace as described above.
- Each machine will diverge from that point — conversations, inbox, and memory are local to each.
- OAuth tokens are not portable between machines (re-authenticate on each).
- API keys (Claude, OpenAI, etc.) in `app-settings.json` will carry over since they are not machine-specific.

---

## Troubleshooting

### "Super-MCP failed to start" after migration

This almost always means `super-mcp-router.json` has stale paths. Follow "Reset the MCP router" above.

### Workspace not found on startup

If `coreDirectory` in `app-settings.json` points to a path that doesn't exist, Rebel shows a **"Workspace Not Found"** dialog on startup with two options:

- **Locate Existing...** — opens a folder picker to point Rebel at the moved workspace. If the selected folder contains a `Chief-of-Staff/` directory or space folders, it's accepted directly. Otherwise Rebel asks if you want to create a new workspace there.
- **Create New...** — clears `coreDirectory` and re-triggers onboarding, which sets up a fresh workspace.

There are actually two layers of this check:

1. **Main process** (`src/main/index.ts`): a native `dialog.showMessageBox` that runs before the window opens. It has `cancelId: -1` — there is no way to dismiss it or quit from this dialog. You must pick one of the two options.
2. **Renderer** (`App.tsx`): a `workspaceRecoveryDialog` that runs after the window loads if the workspace is still inaccessible. This dialog has `onOpenChange={() => {}}` — also uncloseable. It offers "Choose new location" or "Try again."

> **Known limitation — no Quit option**: Neither dialog offers a way to quit the app. If the user wants to fix the path manually (e.g., editing `app-settings.json`), they must force-quit the app first. This is a UX gap worth addressing.

> **Tip for migration**: To avoid the dialog entirely, fix `coreDirectory` in `app-settings.json` to the correct new path *before* launching Rebel.

### License not recognized on new machine

> **Known issue**: After migrating, Rebel may not recognize your subscription tier (Pro, Max, etc.) on the new machine. If this happens, **log out and log back in** from **Settings → Account**. This forces a fresh license check against the server and should restore your correct tier. The root cause is that license state is cached locally and doesn't automatically refresh on a new machine.

### Connectors show "disconnected"

OAuth tokens are stored in machine-specific paths under userData (e.g., `google-workspace-mcp/`, `microsoft-mcp/`). Even if copied, the tokens may reference old redirect URIs or expired sessions. Re-authenticate from **Settings → Connections**.

### Safe mode on launch

If the app launches in safe mode after migration, a store file is likely corrupted or has an unexpected format. Check the safe-mode diagnostics panel for details — it will identify which JSON file is problematic. See [ELECTRON_STORAGE_REFERENCE.md](./ELECTRON_STORAGE_REFERENCE.md) for the expected format of each file.
