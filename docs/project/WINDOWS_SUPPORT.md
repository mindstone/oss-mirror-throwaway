---
description: "Windows platform support guide — NSIS updates, Node bundling, symlinks, spawning, TLS trust, permissions, startup UX"
last_updated: 2026-06-14
---

# Windows Support

This document covers Windows-specific implementation details, compatibility considerations, and known differences from macOS/Linux for the Mindstone Rebel desktop app.

## See Also

- [WINDOWS_INSTALLER](WINDOWS_INSTALLER.md) - **NSIS installer configuration, compression optimizations, build pipeline**
- [WINDOWS_CODESIGNING](WINDOWS_CODESIGNING.md) - **Code signing architecture, Azure Trusted Signing, troubleshooting**
- [DISTRIBUTION](DISTRIBUTION.md) - Auto-updates, code signing, and platform-specific installation
- [AUTO_UPDATE](AUTO_UPDATE.md) - Auto-update architecture and testing
- [CI_PIPELINE](CI_PIPELINE.md) - CI pipeline that builds Windows artifacts
- [SETUP_USER.md](SETUP_USER.md) - End-user setup (update with Windows-specific notes)
- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) - MCP and Super-MCP configuration
- `scripts/bundle-node.mjs` - Node.js bundling script (supports Windows)
- `src/main/utils/systemUtils.ts` - Cross-platform Node.js detection
- **User-facing:** [windows-security-and-antivirus.md](../../rebel-system/help-for-humans/windows-security-and-antivirus.md) - End-user guide for AV exclusions and security warnings

---

## Overview

Windows support was added in December 2024. As of January 2026, the app uses **NSIS + electron-updater** for Windows installation and auto-updates.

> **Note on packaging history:** We migrated from Squirrel.Windows to NSIS in January 2026. See [Why We Switched to NSIS](#why-we-switched-to-nsis) for details. macOS continues to use Squirrel.Mac.

Key areas requiring Windows-specific handling include:

- Node.js runtime bundling and detection
- Symlink/junction creation
- Process spawning (npm/npx commands)
- File permissions (chmod not supported)
- Single-instance app lock
- Splash screen for fast startup feedback

### Why We Switched to NSIS

In January 2026, we migrated from Squirrel.Windows to NSIS (Nullsoft Scriptable Install System) for several reasons:

| Issue with Squirrel | NSIS Solution |
|---------------------|---------------|
| **Complex signing pipeline** - Required signing ~8 vendor binaries, stripping signatures from binaries that get modified, and a custom signtool wrapper | **Simple signing** - Sign app binaries once, then sign the single NSIS installer |
| **Phantom Security Directory bug** - Squirrel modifies binaries after signing, invalidating signatures | **No post-sign modifications** - electron-builder creates the installer without modifying signed binaries |
| **Enterprise SSL issues** - Squirrel's updater doesn't use system certificate store | **System CA integration** - Native Node.js TLS APIs load OS certificates; electron-updater uses Chromium stack which natively trusts system certs |
| **Slower CI builds** - Signature stripping, wrapper scripts, multiple signing passes | **~27% faster Windows builds** - Simpler pipeline, fewer steps |
| **Limited error handling** - Silent failures, hard to debug | **Better diagnostics** - electron-updater provides detailed error messages |

**What we traded off:**
- Delta updates (Squirrel supported them, NSIS downloads full installer) - Acceptable given our installer size and update frequency
- Consistency with macOS - macOS still uses Squirrel.Mac (which works well), Windows now uses NSIS

### Installer and Startup UX

The Windows installer uses NSIS with enhanced UX features:

| Feature | Implementation |
|---------|---------------|
| **Installer feedback** | NSIS installer shows progress during installation |
| **App startup feedback** | Native splash window (`splash.html`) shows immediately while main window loads |
| **Multiple instances** | `app.requestSingleInstanceLock()` prevents concurrent instances |
| **Auto-updates** | electron-updater with NSIS installer |
| **Admin rights** | Not required (per-user install) |
| **SSL certificates** | Uses system certificate store via native Node.js TLS APIs |

---

## TLS Certificate Trust

Node.js uses a hardcoded Mozilla CA bundle by default, which does **not** include enterprise CA certificates installed in the OS certificate store. On corporate networks with SSL inspection proxies, this causes `unable to get local issuer certificate` errors on all outbound HTTPS calls from Node.js — while Chromium-based requests (Electron's `net.fetch()`, the auto-updater) work fine because they use the OS trust store.

### How It Works

We use native Node.js 22.15+ APIs to merge OS system certificates into Node.js's default CA list at startup. This runs on **all platforms** (Windows, macOS, Linux).

- **Location:** `src/main/bootstrap.ts` — `loadSystemCertificates()` runs **before** `import('./index')`, guaranteeing every HTTP call site in the app trusts OS system certs.
- **Mechanism:** `tls.getCACertificates('system')` reads the OS certificate store. `tls.setDefaultCACertificates([...defaults, ...system])` merges these with the built-in Mozilla bundle. Any HTTPS client (fetch/undici, electron-updater, Anthropic SDK) automatically benefits.
- **Cross-platform:** Runs on all platforms — Windows reads from the Windows cert store, macOS from Keychain, Linux from `/etc/ssl/certs` or similar.
- **Non-fatal:** Wrapped in try/catch with `typeof` guards — if the APIs are unavailable or fail, the app still starts with the default Mozilla bundle (non-enterprise users won't notice).
- **Diagnostics:** `logBootstrap()` writes to `bootstrap-diagnostics.log` in the userData logs directory, recording how many system vs default certs were loaded. This file persists across restarts (~150 bytes per restart).

### Defense in Depth

For the login reachability check specifically, there is a second-layer fallback:

1. **Primary:** Node.js `fetch()` with system certs loaded via native APIs (covers all platforms)
2. **Fallback (all platforms):** If Node.js `fetch()` fails with a TLS error, retries with Electron `net.fetch()` (Chromium network stack, which natively trusts the OS cert store). This runs on Windows, macOS, and Linux — not gated by platform.

The login screen shows a TLS-specific message ("Rebel can't verify a secure connection... managed networks that inspect HTTPS traffic") instead of the misleading generic "check your internet" message. See `classifyApiReachabilityError()` in `authService.ts`.

### Relevant APIs

| API | Added In | Purpose |
|-----|----------|---------|
| `tls.getCACertificates('default')` | Node 22.15.0 | Returns the built-in Mozilla CA bundle |
| `tls.getCACertificates('system')` | Node 22.15.0 | Reads the OS certificate store |
| `tls.setDefaultCACertificates(certs)` | Node 22.19.0 | Replaces the default CA list for all TLS connections |

Our bundled Node.js (24.16.0 via Electron 42.4.x) supports all three.

### Constraints

- **Startup modules must remain HTTP-free.** The static imports in `bootstrap.ts` (ensureAppIdentity, ensureUserDataHealth, singleInstanceLock) execute before cert loading. They must never make outbound HTTPS calls — see the `NOTE` comment in `bootstrap.ts`.

### History

**Feb 2026 (v0.4.10):** Originally used [`win-ca`](https://github.com/ukoloff/win-ca) to inject Windows system certificates. win-ca relied on a `roots.exe` binary (blocked by corporate AV/GPO), CJS interop hacks (silently broken in ESM), and asar unpacking (6 transitive dependencies). Despite multiple fixes to loading order and interop, **win-ca never reliably worked in packaged builds** on corporate networks.

**Feb 2026 (v0.4.12):** Replaced win-ca with native Node.js TLS APIs. win-ca's own README now says it is deprecated and recommends `tls.getCACertificates('system')`. The native approach has zero external dependencies, no binary helpers, no CJS interop issues, and works cross-platform. See `docs/plans/partway/260226_win_ca_corporate_tls_fix.md` for the full investigation.

> **Note:** win-ca remains in `package.json` and build configs (`forge.config.cjs`, `electron.vite.config.ts`, `vite.main.config.mjs`) as dead code. It is no longer imported or used at runtime. Removal is tracked as a follow-up task.

---

## Node.js Runtime

### Bundling

The app bundles a platform-specific Node.js runtime for MCP server execution. The bundling script (`scripts/bundle-node.mjs`) handles Windows differently:

| Aspect | macOS/Linux | Windows |
|--------|-------------|---------|
| Archive format | `.tar.gz` | `.zip` |
| Extraction | `tar -xzf` | PowerShell `Expand-Archive` |
| Directory structure | `node-vX.Y.Z-platform-arch/bin/` | `node-vX.Y.Z-win-arch/` (no `bin/` subdir) |
| Executables | `node`, `npm`, `npx` | `node.exe`, `npm.cmd`, `npx.cmd` |

### Detection

`src/main/utils/systemUtils.ts` checks for Node.js in platform-specific locations:

**Windows paths checked:**
- `%ProgramFiles%\nodejs`
- `%ProgramFiles(x86)%\nodejs`
- `%LOCALAPPDATA%\Programs\nodejs`
- `%APPDATA%\npm`
- `%NVM_HOME%` (nvm-windows)
- `%LOCALAPPDATA%\fnm_multishells` (fnm)

**Bundled Node detection:**
- macOS: `resources/node-bundle/bin/node`
- Windows: `resources/node-bundle/node.exe`

---

## Symlinks and Junctions

Windows handles symbolic links differently than Unix systems:

### Directory Symlinks → Junctions

For directories (workspace symlinks, Google Drive links, rebel-system), we use **junctions** instead of symlinks:

```typescript
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
await fs.symlink(targetDir, symlinkPath, linkType);
```

**Why junctions?**
- Junctions work without admin privileges or Developer Mode
- They work across the same drive (which covers most use cases)
- Symlinks on Windows require either:
  - Developer Mode enabled, OR
  - Running as Administrator

### File Symlinks → Copies

For file symlinks (AGENTS.md, CLAUDE.md in workspace root), we **copy** the file instead of creating a symlink:

```typescript
if (process.platform === 'win32') {
  await fs.copyFile(targetAbsolute, symlinkPath);
} else {
  await fs.symlink(targetRelative, symlinkPath);
}
```

**Limitation:** On Windows, these files won't auto-update if the source changes. Users need to delete and let the app recreate them.

**Affected files:**
- `{workspace}/AGENTS.md` → copy of `rebel-system/AGENTS.md`
- `{workspace}/CLAUDE.md` → copy of `AGENTS.md`

---

## Process Spawning

### Console Window Suppression (Critical)

**Always set `windowsHide: true`** when spawning background/worker processes on Windows. Without this flag, directly spawning a console-subsystem executable (e.g., `node.exe`, `ffmpeg`) creates a visible CMD window that stays open for the lifetime of the process.

```typescript
spawn(executable, args, {
  windowsHide: true,  // Suppresses visible console window on Windows
  // ... other options
});
```

This is harmless on macOS/Linux (ignored) so it can be set unconditionally. See postmortem: `docs-private/postmortems/260331_supermcp_windows_cmd_window_postmortem.md`.

### Bundled Node.js for MCP Servers

Super-MCP and bundled MCP servers use the **bundled Node.js**, not system `node` or `npx`:

```typescript
// In superMcpHttpManager.ts
const getNodeBinaryPath = (): string => {
  const isWindows = process.platform === 'win32';
  if (app.isPackaged) {
    return isWindows
      ? path.join(process.resourcesPath, 'node-bundle', 'node.exe')
      : path.join(process.resourcesPath, 'node-bundle', 'bin', 'node');
  }
  return 'node'; // Dev mode uses system node
};

// Spawn uses the bundled node binary directly
this.state.process = spawn(nodeBinary, args, {
  stdio: ['ignore', logFd, logFd],
  detached: !isWindows,
  windowsHide: true,
  // ...
});
```

### npm/npx Commands (Legacy)

If you need to spawn npm/npx commands (rare—prefer bundled node), note that on Windows these are `.cmd` batch files. Node.js `spawn()` cannot run them directly without `shell: true`:

```typescript
const isWindows = process.platform === 'win32';
spawn('npx', args, {
  shell: isWindows,  // Required for .cmd files on Windows
});
```

### Signal Handling

Unix signals (`SIGTERM`, `SIGKILL`) behave differently on Windows:

| Signal | Unix | Windows |
|--------|------|---------|
| `SIGTERM` | Graceful shutdown signal | Immediately terminates process |
| `SIGKILL` | Force kill | Immediately terminates process |
| `SIGINT` | Interrupt (Ctrl+C) | Works if process handles it |

**Current behavior:** Super-MCP HTTP server shutdown uses process-tree kill (`taskkill /t /f` on Windows; process-group `SIGKILL` on Unix). `SIGTERM` is only used as a fallback when PID is unavailable. This ensures all child processes are terminated.

---

## File Permissions

### chmod Not Supported

Unix file permissions (`chmod`) don't work on Windows. The codebase skips permission changes on Windows:

```typescript
// In systemSettingsSync.ts
if (process.platform !== 'win32') {
  await setReadOnly(settingsDir);
}
```

**Affected operations:**
- Setting rebel-system files to read-only after sync
- Executable permission checks (Windows just checks file existence)

---

## Path Handling

### Separator Normalization

**Use the portable path utility** (`src/core/utils/portablePath.ts`) when paths cross process boundaries (IPC, cloud, storage). Do not use inline `.replace(/\\/g, '/')` — use the utility instead:

```typescript
import { toPortablePath, relativePortablePath, joinPortablePath } from '@core/utils/portablePath';

// Normalize a path's separators to forward slashes
const normalized = toPortablePath(somePath);

// Compute a relative path with forward slashes (for IPC/storage)
const rel = relativePortablePath(workspaceRoot, filePath);

// Join segments with forward slashes (for logical/stored paths)
const stored = joinPortablePath('memory', 'sources', year, month, filename);
```

**When to use `path.join()`/`path.sep` vs portable path:**
- **`path.join()` / `path.sep`** — for OS filesystem operations (reading/writing files, containment checks like `startsWith(root + path.sep)`)
- **Portable path utility** — when the result will be stored in a database, sent over IPC, sent to a cloud service, or compared across platforms
- **`path.delimiter`** — for PATH environment variable (`;` on Windows, `:` on Unix)

### Known Patterns

Paths in settings/configs use forward slashes for consistency:
- `symlinkPath`: `"work/Mindstone/General"`
- Space paths: `"Chief-of-Staff"`, `"Personal"`, `"work/Company/Space"`

---

## Google Drive Detection

Windows-specific Google Drive detection in `libraryHandlers.ts`:

**Checked locations:**
- `%LOCALAPPDATA%\Google\DriveFS` - DriveFS configuration directory
- `%ProgramFiles%\Google\Drive File Stream\` - Installation directory

**Differences from macOS:**
- macOS uses `~/Library/CloudStorage/GoogleDrive-{email}` folder naming
- Windows uses DriveFS subdirectories and virtual drive letters

---

## rebel-system Sync

The sync process (`systemSettingsSync.ts`) has Windows-specific handling:

1. **Temp directory** - Uses `%TEMP%\rs-sync` instead of `%APPDATA%\mindstone-rebel\rebel-system-temp` to avoid MAX_PATH issues
2. **Zip extraction** - Tries PowerShell `Expand-Archive` first, falls back to `adm-zip` (pure JavaScript) if PowerShell is unavailable or fails
3. **File permissions** - Skipped on Windows
4. **Workspace symlink** - Uses junction instead of symlink
5. **File operation retry** - All file deletions and permission changes use exponential backoff retry logic to handle Windows file locking (EPERM/EBUSY errors)

### Zip Extraction Fallback

PowerShell 5.0+ is required for `Expand-Archive`. On systems where this is unavailable (older Windows, restricted execution policy), the sync automatically falls back to `adm-zip`, a pure JavaScript zip library with no external dependencies.

### File Locking Resilience

Windows Defender and other antivirus software can briefly hold file handles after operations complete. The sync process uses retry logic with exponential backoff (100ms, 200ms, 400ms, etc.) for all file operations that commonly encounter `EPERM` or `EBUSY` errors.

### MAX_PATH Workaround

Windows has a 260-character path limit by default. GitHub archives include a long prefix directory like `mindstone-rebel-system-8765ba51...` which, combined with deeply nested paths like `skills/Anthropic-official-skills/document-skills/docx/ooxml/schemas/...`, can exceed this limit when extracting to `%APPDATA%`.

**Solution:** On Windows, extraction happens in `%TEMP%\rs-sync` (~20 chars) instead of `%APPDATA%\mindstone-rebel\rebel-system-temp\extracted` (~70 chars), saving ~50 characters.

---

## CI/CD

Windows builds run on `windows-latest` in GitHub Actions. The build uses **NSIS via electron-builder** for packaging and **Azure Trusted Signing** for code signing.

**For detailed Windows signing information**, see [WINDOWS_CODESIGNING.md](WINDOWS_CODESIGNING.md), which covers:
- Signing architecture and CI pipeline flow
- Azure Trusted Signing configuration
- Troubleshooting signing failures

### Build Pipeline (NSIS)

The Windows build pipeline is simpler than the previous Squirrel-based approach:

1. **Package app** - `electron-forge package` creates the unpacked app
2. **Sign app binaries** - Azure Trusted Signing signs all `.exe` files in the packaged app
3. **Create NSIS installer** - `electron-builder --prepackaged` creates the installer
4. **Sign installer** - Azure Trusted Signing signs the final `*-Setup-*.exe`

### Auto-Update Artifacts

For NSIS auto-updates, CI uploads to `gs://mindstone-rebel/{updates|updates-beta}/win32/x64/`:
- `latest.yml` (stable) or `beta.yml` (beta) - electron-updater metadata file
- `*-Setup-*.exe` - Signed NSIS installer

---

## Antivirus Resilience

Windows antivirus software (especially Windows Defender) can interfere with Electron apps in several ways. This section documents our mitigations.

### CI Signing for AV Trust

All executables are code-signed during CI to prevent AV false positives:

| Binary | Signed By | Why |
|--------|-----------|-----|
| `Mindstone Rebel.exe` | Azure Trusted Signing | Main app executable |
| `*-Setup-*.exe` | Azure Trusted Signing | NSIS installer |
| `node.exe` (bundled) | Azure Trusted Signing | MCP server execution |
| `rg.exe` (ripgrep) | Azure Trusted Signing | Agent file search |

**Implementation:** The CI pipeline signs app binaries after packaging, then signs the NSIS installer after electron-builder creates it. This dual-signing approach ensures both the installer and installed executables are trusted.

### Preflight Warmup

During the "Getting ready..." preflight screen (`systemHealthService.ts`), we proactively trigger AV scans and Windows Firewall prompts:

1. **Windows Firewall warmup** - Spawns the bundled Node.js to trigger the firewall approval dialog during onboarding (not mid-conversation)
2. **AV-sensitive executable warmup** - Reads `rg.exe` (ripgrep) to trigger on-access AV scans during startup rather than during agent turns

```typescript
// From systemHealthService.ts - triggers AV scan via async file read
// Uses threadpool (cannot block main thread) unlike spawn()
fs.readFile(ripgrepPath, { flag: 'r' })
  .then(() => log.debug('Ripgrep AV warmup completed'))
  .catch(() => {}); // Ignore errors - goal is triggering the scan
```

### Watchdogs for AV-Related Delays

Two watchdogs detect when AV scanning causes unexpected delays:

#### 1. Squirrel Event Spawn Watchdog (`squirrelHandler.ts`)

When handling Squirrel events (install/update/uninstall), spawning `Update.exe` can block if AV is scanning the executable:

```typescript
// Watchdog detects if spawn appears blocked by AV
const watchdogId = setTimeout(() => {
  if (!spawned) {
    console.warn('[SQUIRREL] Spawn watchdog triggered - possible AV blocking');
  }
}, 5000);
```

#### 2. Agent Turn "No Output" Watchdog (`agentTurnExecutor.ts`)

Detects when the Claude CLI stops producing output (possible AV blocking `rg.exe` or other tools):

- **Threshold:** 30 seconds of silence
- **Check interval:** Every 10 seconds
- **Action:** Logs warning and reports to Sentry (no user interruption)

This helps diagnose issues without aborting turns—AV may eventually release the file.

### Defensive Install Validation (`squirrelHandler.ts`)

During Squirrel events, we validate the install root to detect corruption:

- Checks `Update.exe` exists
- Verifies app folder contains expected files (`Mindstone Rebel.exe`, `resources`)
- Detects nearly-empty install root (sign of interrupted update)
- **AV-safe:** Read-only validation only, no automatic fixes

```typescript
function validateSquirrelInstallRoot(): { healthy: boolean; issues: string[] }
```

Stale lock files are also **detected** (not deleted) with guidance for manual cleanup if needed.

---

## Enterprise Allowlisting Guide

For enterprise IT administrators deploying Mindstone Rebel in managed environments where antivirus or application control policies may block the application.

### Application Details

| Property | Value |
|----------|-------|
| Publisher | Mindstone Learning Limited |
| Certificate Subject | `CN=Mindstone Learning Limited` |
| Install Location | `%LOCALAPPDATA%\rebel-app\` |
| Main Executable | `%LOCALAPPDATA%\rebel-app\Mindstone Rebel.exe` |

### Key Executables to Allowlist

| Executable | Purpose |
|------------|---------|
| `Mindstone Rebel.exe` | Main application |
| `node.exe` | Bundled Node.js for MCP server execution |
| `git.exe` | Bundled Git for agent operations |
| `bash.exe` | Shell for agent operations |

### Windows Defender Configuration

**Option 1: Path-Based Exclusions (Defender AV)**
- Open Group Policy Editor
- Navigate to: Computer Configuration → Administrative Templates → Windows Components → Microsoft Defender Antivirus → Exclusions
- Add path exclusion: `%LOCALAPPDATA%\rebel-app\`

**Option 2: Application Control (WDAC/AppLocker)** - *Separate from AV*
For organizations using Windows Defender Application Control or AppLocker:
1. Create a publisher rule based on the signing certificate
2. Certificate subject: `CN=Mindstone Learning Limited`
3. This controls *application execution*, not AV detection

**Important distinction:**
- **Defender AV exclusions** (Option 1): Prevent files from being scanned/quarantined
- **WDAC/AppLocker** (Option 2): Control which apps can *execute* (does not prevent AV scanning)

Most organizations need Option 1 for AV false positives. Option 2 is for application control policies.

**Security consideration:** Broad folder exclusions reduce protection. Prefer narrower path exclusions for specific executables if supported by your security policies.

### Third-Party AV Products

| AV Product | Allowlist Method |
|------------|------------------|
| Symantec Endpoint Protection | Application Control → Trusted Publishers |
| CrowdStrike Falcon | Machine Learning Exclusions → Hash/Path |
| Carbon Black | Rules → Approve by certificate/path |
| Sophos | Global Exclusions → By folder/certificate |

### Verifying Signatures

To verify the application is legitimately signed:

```powershell
# Check digital signature
Get-AuthenticodeSignature "$env:LOCALAPPDATA\rebel-app\Mindstone Rebel.exe"

# Should show:
# Status: Valid
# SignerCertificate: CN=Mindstone Learning Limited
```

---

## Troubleshooting

### "spawn npx ENOENT"

**Cause:** npx.cmd cannot be spawned without `shell: true`  
**Fix:** Ensure `shell: isWindows` is set in spawn options

### "Unable to read platform instructions"

**Cause:** rebel-system directory empty or sync failed  
**Check:**
1. Network connectivity during first launch
2. `%APPDATA%\mindstone-rebel\rebel-system\` contains files
3. Logs in `%APPDATA%\mindstone-rebel\logs\`

### File symlinks not updating

**Cause:** Windows uses file copies instead of symlinks for AGENTS.md/CLAUDE.md  
**Fix:** Delete the file and restart the app to recreate

### Junctions not working

**Cause:** Junctions require same-drive paths  
**Fix:** Ensure workspace and target are on the same drive

### EPERM/EBUSY errors during sync

**Cause:** Windows Defender or antivirus software holding file handles  
**Fix:** The app automatically retries with exponential backoff. If issues persist:
1. Add the `%APPDATA%\mindstone-rebel` folder to your antivirus exclusions
2. Temporarily disable real-time scanning during first sync
3. Check that no other processes have files open in the app data directory

### PowerShell Expand-Archive unavailable

**Cause:** PowerShell 5.0+ not installed or execution policy restricts cmdlets  
**Fix:** The app automatically falls back to `adm-zip` (pure JavaScript extraction). No action needed.

---

## Known Gotchas & Lessons Learned

A collection of hard-won lessons from Windows-specific issues. **Update this section when fixing Windows bugs.**

### Paths with Spaces in CLI Arguments

**Problem**: Windows paths often contain spaces (`C:\Users\John Doe\...`, `Mindstone Rebel Beta.exe`). When external tools (like Squirrel) pass these paths to executables without quoting, they arrive as split arguments.

**Example**: `signtool.exe sign ... D:\path\Mindstone Rebel Beta_ExecutionStub.exe` arrives as:
- `args[n]` = `D:\path\Mindstone`
- `args[n+1]` = `Rebel`  
- `args[n+2]` = `Beta_ExecutionStub.exe`

**Solution**: When parsing CLI arguments, if a file path doesn't exist, try joining adjacent non-option arguments backward until `File.Exists()` succeeds. See `scripts/windows-signing/create-signtool-wrapper.ps1` for implementation.

**Prevention**: 
- Always quote paths when building CLI commands
- When receiving args from external tools, assume paths may be split and handle defensively

---

## Background Indexing

On Windows, semantic file indexing is **disabled by default** to avoid CPU impact. Users can enable it via the Library panel toggle when they want semantic search capabilities.

### Platform Defaults

| Platform | Indexing Default | Rationale |
|----------|-----------------|-----------|
| macOS | Enabled | Better thread scheduling, minimal CPU impact |
| Linux | Enabled | Better thread scheduling, minimal CPU impact |
| Windows | Disabled | ONNX Runtime can cause high CPU usage; opt-in when needed |

### Implementation

```typescript
// In src/main/index.ts
const indexingDefault = process.platform !== 'win32';
const indexingEnabled = settings.indexingEnabled ?? indexingDefault;
```

If a user explicitly enables or disables indexing, their preference is respected on all platforms.

### Thread Limiting (When Enabled)

When indexing runs on Windows, ONNX Runtime threads are limited to 4 (via `OMP_NUM_THREADS`) to prevent CPU saturation. See `embeddingService.ts`.

---

## Future Improvements

1. **Graceful Super-MCP shutdown** - Consider using `taskkill` or Windows-specific IPC for cleaner shutdown
2. **File symlink support** - Detect Developer Mode and use real symlinks if available
3. **WSL integration** - Potential for better Unix compatibility layer
