---
description: "Windows NSIS installer guide — electron-builder config, install paths, Squirrel migration, compression and CI pipeline"
last_updated: 2026-02-27
---

# Windows Installer (NSIS)

Comprehensive documentation for the Windows NSIS installer configuration, compression optimizations, and CI pipeline.

## See Also

- [WINDOWS_SUPPORT](WINDOWS_SUPPORT.md) - Platform-specific Windows support overview
- [WINDOWS_CODESIGNING](WINDOWS_CODESIGNING.md) - Azure Trusted Signing configuration
- [DISTRIBUTION](DISTRIBUTION.md) - Auto-updates and platform-specific distribution
- [AUTO_UPDATE](AUTO_UPDATE.md) - Auto-update architecture (electron-updater)
- [CI_PIPELINE](CI_PIPELINE.md) - CI pipeline and artifact publishing

---

## Overview

As of January 2026, Windows uses **NSIS (Nullsoft Scriptable Install System) + electron-builder** for installation and auto-updates. This replaced the previous Squirrel.Windows approach.

### Key Configuration Files

| File | Purpose |
|------|---------|
| `electron-builder.cjs` | NSIS installer configuration |
| `build/nsis-installer.nsh` | Custom NSIS script (compression documentation) |
| `forge.config.cjs` | Electron Forge config (packaging only, no Squirrel maker) |
| `.github/workflows/release.yml` | CI pipeline for Windows builds |

### Install Locations

| Type | Path |
|------|------|
| Application (stable) | `%LocalAppData%\Programs\mindstone-rebel\` |
| Application (beta) | `%LocalAppData%\Programs\mindstone-rebel-beta\` |
| User Data | `%AppData%\mindstone-rebel\` |
| Logs | `%AppData%\mindstone-rebel\logs\` |

**Note:** Both stable and beta builds share the same `mindstone-rebel` userData directory (set by `src/main/startup/ensureAppIdentity.ts`). Install paths derive from `sanitizedName` (package.json `name` field, overridden via `extraMetadata` for beta).

---

## Why NSIS Instead of Squirrel.Windows

We migrated from Squirrel.Windows to NSIS in January 2026 for several reasons:

| Issue with Squirrel | NSIS Solution |
|---------------------|---------------|
| **Complex signing pipeline** - Required signing ~8 vendor binaries, stripping signatures from binaries that get modified | **Simple signing** - Sign app binaries once, then sign the NSIS installer |
| **Phantom Security Directory bug** - Squirrel modifies binaries after signing, invalidating signatures | **No post-sign modifications** - electron-builder creates installer without modifying signed binaries |
| **Enterprise SSL issues** - Squirrel's updater doesn't use system certificate store | **Native Node.js TLS system-CA merge** (`src/main/bootstrap.ts`) for Node.js HTTP clients + Chromium trust store for electron-updater/`net.fetch` — see [WINDOWS_SUPPORT § TLS Certificate Trust](WINDOWS_SUPPORT.md#tls-certificate-trust) |
| **Slower CI builds** - Signature stripping, wrapper scripts, multiple signing passes | **~27% faster Windows builds** |
| **Limited error handling** - Silent failures, hard to debug | **Better diagnostics** - electron-updater provides detailed error messages |

**Trade-offs:**
- No delta updates (NSIS downloads full installer) - Acceptable given our installer size
- Platform inconsistency - macOS still uses Squirrel.Mac (which works well)

---

## Compression Configuration

### The Problem: 5+ Minute Install Times

The app contains **10,000+ files** (node_modules, MCP servers, bundled Node.js, etc.). By default, electron-builder uses `SetCompressor /SOLID lzma` which provides maximum compression but **extremely slow decompression**.

With solid LZMA compression:
- The entire compressed block must be decompressed sequentially
- Install time: **5+ minutes** on average hardware
- User perception: "The installer froze/hung"

### The Solution: Non-Solid ZIP Compression

We use `compression: "normal"` combined with `useZip: true` in `electron-builder.cjs`:

```javascript
// electron-builder.cjs
nsis: {
  useZip: true,              // Use ZIP instead of 7z for app payload
  differentialPackage: false, // Required for useZip to work
},
compression: "normal",       // Balanced compression (ZIP Deflate level 7)
```

**Why this works:**
- ZIP extracts directly to `$INSTDIR` (single write pass)
- 7z extracts to temp, then uses `CopyFiles` (double write pass)
- `normal` compression provides meaningful size reduction with modest install time increase

### Compression Options Comparison

| Setting | Installer Size | Install Time | Use Case |
|---------|---------------|--------------|----------|
| `/SOLID lzma` (default) | ~150MB | 5+ minutes | Never - too slow |
| `lzma` (non-solid) | ~165MB | 1-2 minutes | Balance size/speed |
| `zlib` (non-solid) | ~180MB | ~30 seconds | Good balance |
| `normal` (ZIP Deflate) | ~650-800MB | ~15-30 seconds | **Current choice** |
| `store` (no compression) | ~850MB+ | ~10-15 seconds | Maximum speed |

**Our choice:** `normal` compression for a balanced trade-off between download size and install speed. This provides ~5-20% smaller downloads than `store` with only a modest install time increase (~15-30s vs ~10-15s). Note: actual sizes depend on content; pre-compressed binaries (Node.js, Electron, native modules) compress poorly.

### Custom NSIS Script

The `build/nsis-installer.nsh` file documents compression options and could be used for additional NSIS customization:

```nsis
; Custom NSIS installer script for Mindstone Rebel
; Optimized for fast installation at the cost of slightly larger installer size

; COMPRESSION SETTINGS
; Default electron-builder uses: SetCompressor /SOLID lzma (5+ minute install)
; Current setting: compression: "normal" + useZip: true (see electron-builder.cjs)
; Result: ~650-800MB installer (estimated), ~15-30 second install
```

**Note:** The actual compression is configured in `electron-builder.cjs`, not the `.nsh` file. The script is included via the `include` option for potential future customization.

---

## electron-builder Configuration

### Key Settings (`electron-builder.cjs`)

```javascript
module.exports = {
  appId: "com.mindstone.rebel",      // or com.mindstone.rebel.beta
  productName: "Mindstone Rebel",
  
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    // Azure signing for uninstaller (two-pass signing)
    azureSignOptions: { /* ... */ },
  },
  
  nsis: {
    oneClick: true,                          // No wizard pages
    perMachine: false,                       // Per-user install (no admin)
    include: "build/nsis-installer.nsh",     // Custom script
    useZip: true,                            // ZIP extraction (faster)
    differentialPackage: false,              // Required for useZip
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,         // Preserve user data
  },
  
  publish: {
    provider: "generic",
    url: "https://storage.googleapis.com/mindstone-rebel/updates/win32/x64",
    channel: "latest",  // or "beta"
  },
  
  compression: "normal",  // Balanced compression (ZIP Deflate level 7)
};
```

### Build Channels

| Channel | App Name | App ID | Update URL |
|---------|----------|--------|------------|
| stable | Mindstone Rebel | com.mindstone.rebel | `updates/win32/x64` |
| beta | Mindstone Rebel Beta | com.mindstone.rebel.beta | `updates-beta/win32/x64` |

Set via `BUILD_CHANNEL` environment variable in CI.

---

## Build Pipeline

### Local Build

```bash
# Full NSIS build (requires Windows for makensis)
npm run build:windows:nsis

# Or step by step:
npm run prebuild
electron-forge package --platform win32 --arch x64
electron-builder --win --x64 --prepackaged "out/Mindstone Rebel-win32-x64" --config electron-builder.cjs
```

**Note:** The `USE_NSIS` env var is no longer needed - Squirrel.Windows maker was removed from `forge.config.cjs`.

### CI Pipeline Flow

1. **Package app** - `electron-forge package` creates unpacked app
2. **Sign app binaries** - Azure Trusted Signing signs `.exe` files in `out/`
3. **Create NSIS installer** - `electron-builder --prepackaged` creates installer
4. **Sign installer** - Azure Trusted Signing signs the final `*-Setup-*.exe`
5. **Upload artifacts** - Publish to GCS (`latest.yml` + installer)

### CI Artifacts

For NSIS auto-updates, CI uploads to `gs://mindstone-rebel/{updates|updates-beta}/win32/x64/`:

| File | Purpose |
|------|---------|
| `latest.yml` (stable) or `beta.yml` (beta) | electron-updater metadata |
| `rebel-app-Setup-{version}.exe` | Signed NSIS installer |

---

## Auto-Update Configuration

### electron-updater Integration

The app uses `electron-updater` for Windows updates (see `src/main/services/autoUpdateService.ts`):

```typescript
import { autoUpdater } from 'electron-updater';

autoUpdater.setFeedURL({
  provider: 'generic',
  url: updateBaseUrl,  // GCS bucket URL
  channel: isBetaApp ? 'beta' : 'latest',
  useMultipleRangeRequest: false,
});
```

### Update Metadata (latest.yml)

```yaml
version: 0.4.0
files:
  - url: rebel-app-Setup-0.4.0.exe
    sha512: <base64-hash>
    size: 350000000
path: rebel-app-Setup-0.4.0.exe
sha512: <base64-hash>
releaseDate: '2026-01-30T12:00:00.000Z'
```

**Important:** The SHA512 hash must be regenerated after code signing (CI handles this automatically).

---

## Code Signing

### Two-Pass Uninstaller Signing

NSIS embeds the uninstaller during build. electron-builder supports a two-pass process:

1. **First pass** - Build installer with unsigned uninstaller stub
2. **Sign uninstaller** - Extract and sign the uninstaller
3. **Second pass** - Rebuild installer with signed uninstaller
4. **Sign installer** - Sign the final installer

This is enabled via `win.azureSignOptions` in `electron-builder.cjs`:

```javascript
win: {
  azureSignOptions: {
    publisherName: "Mindstone Learning Limited",
    endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
    codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
    certificateProfileName: process.env.AZURE_CERT_PROFILE_NAME,
  },
  signAndEditExecutable: true,
}
```

### Required CI Environment Variables

| Variable | Description |
|----------|-------------|
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_CLIENT_ID` | Azure service principal client ID |
| `AZURE_CLIENT_SECRET` | Azure service principal secret |
| `AZURE_CODE_SIGNING_ENDPOINT` | `https://eus.codesigning.azure.net/` |
| `AZURE_CODE_SIGNING_ACCOUNT` | Azure Trusted Signing account name |
| `AZURE_CERT_PROFILE_NAME` | Certificate profile name |

See [WINDOWS_CODESIGNING.md](WINDOWS_CODESIGNING.md) for full details.

---

## Silent Installation

NSIS supports silent installation via command-line flags:

```powershell
# Silent install (for scripted deployments)
.\rebel-app-Setup-0.4.0.exe /S

# Silent install to custom directory
.\rebel-app-Setup-0.4.0.exe /S /D=C:\CustomPath

# Silent uninstall
.\Uninstall Mindstone Rebel.exe /S
```

**Notes:**
- `/S` must be uppercase (NSIS convention)
- Silent install still runs `runAfterFinish` (app launches after install)
- Per-user install doesn't require admin rights

---

## Troubleshooting

### Slow Installation

**Symptom:** Installer takes 5+ minutes  
**Cause:** Using solid LZMA compression  
**Fix:** Ensure `compression: "normal"` and `useZip: true` are set in `electron-builder.cjs`

### Unsigned Uninstaller Warning

**Symptom:** SmartScreen warning when running uninstaller  
**Cause:** Uninstaller not signed during build  
**Fix:** Ensure Azure signing credentials are passed to electron-builder step in CI

### Auto-Update Fails with SHA512 Mismatch

**Symptom:** `sha512 checksum mismatch` error  
**Cause:** `latest.yml` hash generated before signing, but signing changes file  
**Fix:** CI must regenerate SHA512 hash after signing (see `release.yml`)

### NSIS Syntax Error in Custom Script

**Symptom:** `SetDetailsPrint not valid outside Section or Function`  
**Cause:** NSIS commands used in global scope  
**Fix:** Only use directives (not commands) in `build/nsis-installer.nsh`

---

## Migration from Squirrel.Windows

For users migrating from the old Squirrel-based installer:

1. **User data is preserved** - Both installers use the same `%AppData%\mindstone-rebel\` location
2. **Automatic cleanup** - The app silently removes old Squirrel installation remnants
3. **Desktop/Start Menu shortcuts** - Will be recreated by NSIS installer

### Automatic Squirrel Cleanup

When running as an NSIS installation, the app automatically cleans up old Squirrel artifacts via `src/main/services/squirrelCleanupService.ts`:

- Detects if running from NSIS install path (`%LocalAppData%\Programs\...`)
- Removes old Squirrel shortcuts that point to defunct paths
- Cleans up Squirrel registry entries (`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\mindstone-rebel`)
- Logs cleanup actions to Sentry for monitoring

This cleanup runs silently in the background - no user interaction required.

---

## Related Planning Documents

For historical context and implementation details:

| Document | Description |
|----------|-------------|
| `docs/plans/partway/260127_Auto_Update_Migration.md` | Original migration plan |
| `docs/plans/finished/260129_CI_NSIS_Migration.md` | CI pipeline changes |
| `docs/plans/obsolete/260127_NSIS_Migration_Rollout.md` | User migration strategy |
| `docs/plans/finished/260130_nsis-uninstaller-signing.md` | Uninstaller signing implementation |

---

## Future Considerations

1. **Differential updates** - Currently disabled (no blockmaps). Could reduce download size for minor updates if needed.

2. **MSIX packaging** - Microsoft Store and enterprise deployment alternative. Would require significant changes.

3. **ARM64 support** - Windows on ARM is growing. Would need separate build target in `electron-builder.cjs`.
