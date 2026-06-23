---
description: "Linux platform support: current beta status, packaging, known issues, and troubleshooting"
last_updated: "2026-04-16"
---

# Linux Support

> **Status:** Beta (Ubuntu .deb packages shipping since early 2026)

This document covers Linux support in Mindstone Rebel — packaging, known platform-specific issues, CI/CD, and troubleshooting. Linux builds are produced alongside macOS and Windows in the release pipeline. Auto-update uses a notification-only model (no in-place updates).

## See Also

- [WINDOWS_SUPPORT.md](WINDOWS_SUPPORT.md) - Windows-specific implementation patterns (reference for platform-specific handling)
- [BUILD_AND_RELEASE_OVERVIEW](BUILD_AND_RELEASE_OVERVIEW.md) - Hub for build/release docs
- [CI_PIPELINE](CI_PIPELINE.md) - CI pipeline and release workflow
- [Electron Forge Makers](https://www.electronforge.io/config/makers) - Official Electron Forge documentation
- [Electron Forge DEB Maker](https://www.electronforge.io/config/makers/deb) - Debian package maker
- [Electron Forge RPM Maker](https://www.electronforge.io/config/makers/rpm) - RPM package maker
- [electron-builder Auto-Update](https://www.electron.build/auto-update.html) - Auto-update support for Linux
- `scripts/bundle-node.mjs` - Node.js bundling (includes Linux in supportedPlatforms)
- `scripts/bundle-git.mjs` - Git bundling (already has dugite-native for Linux)
- `forge.config.cjs` - Electron Forge configuration

---

## Current Status

Linux beta builds are produced in CI and published to GCS alongside macOS and Windows artifacts. Key implementation state:

| Area | Status | Notes |
|------|--------|-------|
| **Node.js bundling** | ✅ Done | `bundle-node.js` includes `'linux'` in `supportedPlatforms` |
| **Git bundling** | ✅ Done | `bundle-git.js` has full Linux support via dugite-native (x64 + arm64) |
| **DEB packaging** | ✅ Done | `@electron-forge/maker-deb` configured in `forge.config.cjs` |
| **CI/CD pipeline** | ✅ Done | `build-linux` job in `release.yml`, artifacts published to GCS |
| **Auto-update notifications** | ✅ Done | `linuxUpdateService.ts` + `LinuxUpdateAvailableToast.tsx` — notification-only (no in-place install) |
| **Electron auto-updater** | N/A | `update-electron-app` exits gracefully on Linux — no code change needed |
| **Native modules** | ✅ Auto | npm resolves platform-specific deps from package dependencies automatically |
| **Linux icon (`build/icon.png`)** | ⚠️ Missing | `forge.config.cjs` conditionally includes it; builds succeed without it but .deb has no icon |
| **GPG package signing** | ❌ Deferred | Non-interactive passphrase handling in CI remains unresolved (see below) |
| **AppArmor profile shipping** | ❌ Not done | Ubuntu 24.04 users need manual workaround (see Edge Cases) |

---

## Target Linux Distribution

### Ubuntu Only

The current Linux release targets **Ubuntu only**:

| Distribution | Package Format | Versions | Notes |
|--------------|----------------|----------|-------|
| **Ubuntu** | `.deb` | 22.04 LTS, 24.04 LTS | Primary and only target for initial release |

### Package Format

**`.deb` only** - This simplifies:
- CI/CD pipeline (no RPM tooling needed)
- Testing matrix (Ubuntu only)
- Documentation and support

Future expansion to Fedora/RPM, Debian, Linux Mint, or AppImage can be considered based on user demand.

---

## Packaging

### Electron Forge DEB Maker

The DEB maker is configured in `forge.config.cjs`. Key details:
- Maker: `@electron-forge/maker-deb` (installed as dev dependency)
- Executable name: `mindstone-rebel` (or `mindstone-rebel-beta` for beta builds) — lowercase, hyphenated as required by DEB packaging
- Icon: conditionally included from `build/icon.png` if the file exists (`hasLinuxIcon` guard in forge config)
- Categories: Productivity, Development

### Note on Native Module Dependencies (NOT REQUIRED)

The `package.json` includes explicit platform-specific native modules in `optionalDependencies` for darwin and win32. **Adding Linux entries is NOT required** because:

1. **Packages declare their own deps**: `rollup`, `@swc/core`, `tailwindcss`, and `lightningcss` all declare their platform-specific binaries in their own `optionalDependencies`. When `npm ci` runs on a Linux CI runner, npm automatically fetches the Linux variants.

2. **Verified via npm registry**: `rollup@4.53.3` declares `@rollup/rollup-linux-x64-gnu` and 15+ other platform variants in its own package.

3. **The existing entries are workarounds**: The darwin/win32 entries in the project's `optionalDependencies` exist to work around npm bugs in certain versions where cross-platform lockfiles didn't resolve correctly. These bugs have been largely fixed in npm 11.3.0+.

**Recommendation**: Do not add Linux entries. If build issues occur on CI, delete `package-lock.json` and regenerate it on the Linux runner.

### Build Requirements

**For `.deb` packages:**
- `fakeroot` and `dpkg` must be installed
- Can build on Linux or macOS (not Windows)
- Ubuntu CI runner: `sudo apt-get install -y fakeroot dpkg`

---

## Code Changes (Reference)

The following sections document Linux-specific code considerations. Most items are already implemented.

### 1. Platform Checks

The codebase already handles `darwin` and `win32`. Linux-specific paths need review:

**File: `src/main/services/superMcpHttpManager.ts`**
```typescript
// Current: Only checks win32
const isWindows = process.platform === 'win32';

// Linux uses same Unix patterns as macOS for:
// - Process spawning (no shell:true needed)
// - Signal handling (SIGTERM works correctly)
// - Path separators
```

**File: `src/main/ipc/libraryHandlers.ts`**
```typescript
// Symlinks: Linux uses standard Unix symlinks (same as macOS)
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
// ✅ Already works - 'dir' symlink type is correct for Linux
```

**File: `src/main/ipc/permissionsHandlers.ts`**
```typescript
// Add Linux handling for microphone permissions
if (process.platform !== 'darwin') {
  // Linux: Check PulseAudio/PipeWire permissions via system calls
  // For now, assume granted (most Linux DEs don't require explicit app permissions)
  return 'granted';
}
```

### 2. Node.js Bundle Path (✅ Done)

`scripts/bundle-node.mjs` includes `'linux'` in `supportedPlatforms`. The script downloads the correct Node.js tarball for linux-x64/arm64, extracts using `tar`, and places binaries at `resources/node-bundle/bin/node`.

### 3. Git Bundle Path (✅ Done)

`scripts/bundle-git.mjs` already supports Linux via dugite-native:
```javascript
// Already configured in bundle-git.mjs
const DUGITE_ASSETS = {
  'linux-x64': { name: '...ubuntu-x64.tar.gz', checksum: '...' },
  'linux-arm64': { name: '...ubuntu-arm64.tar.gz', checksum: '...' },
};
```

### 4. System Utils (Minor Updates)

**File: `src/main/utils/systemUtils.ts`**
```typescript
// Already has Linux support for Git environment
if (process.platform === 'linux') {
  process.env.PREFIX = bundledGitDir;
  const sslCABundle = path.join(bundledGitDir, 'ssl', 'cacert.pem');
  // ... sets GIT_SSL_CAINFO
}
```

### 5. Health Checks (Add Linux-Specific)

**File: `src/main/services/health/checks/system.ts`**

Add Linux-specific health checks:
```typescript
export async function checkLinuxDependencies(): Promise<CheckResult> {
  const id = 'linuxDeps';
  const name = 'Linux Dependencies';

  if (process.platform !== 'linux') {
    return { id, name, status: 'pass', message: 'Not running on Linux' };
  }

  const issues: string[] = [];

  // Check for common missing dependencies that affect Electron
  // libappindicator (tray icons), libnotify (notifications)
  // These are usually present but worth checking
  
  return {
    id,
    name,
    status: issues.length === 0 ? 'pass' : 'warn',
    message: issues.length === 0 ? 'Linux dependencies OK' : issues.join('; ')
  };
}
```

### 6. Icon Assets (⚠️ Remaining)

`build/icon.png` does not yet exist. The `forge.config.cjs` conditionally includes it (`hasLinuxIcon` guard), so builds succeed without it — but the resulting .deb package has no app icon.

**To create:** Convert from the existing `build/icon.icns`:
```bash
sips -s format png --resampleHeightWidth 512 512 build/icon.icns --out build/icon.png
```

### 7. Auto-Updater Linux Handling (✅ Done)

Electron's `update-electron-app` exits gracefully on Linux (logs a message and returns early — no crash). A **notification-only update system** is implemented:

- `src/main/services/linuxUpdateService.ts` — fetches `latest.json` manifest from GCS, compares versions using `semver`, and sends an IPC event when an update is available
- `src/renderer/components/LinuxUpdateAvailableToast.tsx` — toast with "Download" (opens browser to .deb URL) and "Later" (dismisses)
- First check: 15 seconds after startup; subsequent checks: every 4 hours
- All code is platform-gated (`process.platform === 'linux'`) — zero impact on macOS/Windows

---

## Known Linux Edge Cases for Electron Apps

> **Filesystem case-sensitivity:** import paths must match on-disk component filename casing *exactly*. macOS and Windows case-insensitive filesystems hide mismatches that then break Linux builds — a wrong-case import compiles and runs everywhere except here.

### 1. Sandboxing / Unprivileged Namespaces (Ubuntu 24.04 CRITICAL)

**Issue:** Ubuntu 24.04 introduced new AppArmor restrictions (`kernel.apparmor_restrict_unprivileged_userns=1` by default) that prevent Electron's Chromium sandbox from working without an AppArmor profile.

**Symptoms:** App crashes on launch with:
- "The SUID sandbox helper binary was found, but is not configured correctly"
- Or AppArmor "DENIED" messages in system logs

**Affected Versions:**
- Ubuntu 24.04 LTS and later (AppArmor restriction enabled by default)
- Ubuntu 23.10 (first version with this restriction)
- Debian-based distros may also be affected

**Solutions (in order of preference):**

1. **AppArmor Profile (Best for distribution):** Ship an AppArmor profile with the .deb package. This is what Chrome and other Electron apps do. Profile would be installed to `/etc/apparmor.d/mindstone-rebel`.

2. **User Workaround (Document in SETUP_USER.md):**
   ```bash
   # Temporary (until reboot):
   sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
   
   # Permanent:
   echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-apparmor-userns.conf
   sudo sysctl --system
   ```

3. **`--no-sandbox` flag (NOT RECOMMENDED):** Disables Chromium sandboxing entirely. Security risk.

**Recommendation for Phase 1:** Document the user workaround. For Phase 2, investigate shipping an AppArmor profile with the .deb package (requires `postinst`/`prerm` scripts in maker-deb config).

### 2. Wayland vs X11

**Issue:** Electron has experimental Wayland support via Ozone platform. Many desktop environments (GNOME 42+, KDE Plasma 6) default to Wayland.

**Known Wayland Issues:**
- Tray icons may not appear (depends on desktop environment)
- Context menus may appear on wrong workspace
- Window icons may show Electron default instead of app icon
- Native file dialogs may behave differently

**Solutions:**
1. Default to XWayland (Electron's default behavior) - works reliably
2. Allow users to opt-in to native Wayland via environment variable:
   ```bash
   ELECTRON_OZONE_PLATFORM_HINT=wayland mindstone-rebel
   ```

**Recommendation:** Don't force Wayland; let users opt-in. XWayland works well for most cases.

### 3. Tray Icon Compatibility

**Issue:** System tray support varies across Linux desktop environments.

| Desktop | Tray Support | Notes |
|---------|--------------|-------|
| GNOME | Limited | Requires AppIndicator extension |
| KDE Plasma | Full | Native support |
| XFCE | Full | Native support |
| Cinnamon | Full | Native support |

**Solution:** Use `libappindicator` support (Electron includes this). Gracefully handle tray failures:
```typescript
try {
  tray = new Tray(iconPath);
} catch (error) {
  log.warn('System tray not available on this platform');
  // Continue without tray - app remains functional
}
```

### 4. Audio Permissions (PulseAudio/PipeWire)

**Issue:** Linux audio systems (PulseAudio, PipeWire) handle permissions differently than macOS/Windows.

**Good News:** Most Linux distributions don't require explicit app-level microphone permissions - users grant access at the system level.

**Recommendation:** Keep current pattern where we return 'granted' for non-Darwin platforms, but add a health check to verify audio device access.

### 5. File Permissions

**Issue:** Linux respects file permissions strictly. Read-only files (rebel-system) work as expected.

**Good News:** `chmod` operations work on Linux (unlike Windows). No changes needed to permission-setting code.

---

## CI/CD Implementation

### GitHub Actions Workflow (✅ Implemented)

The `build-linux` job exists in `.github/workflows/release.yml` and runs alongside macOS and Windows builds. Reference configuration:

```yaml
build-linux:
  name: Build Linux (${{ needs.setup.outputs.channel }})
  needs: setup
  runs-on: ubuntu-22.04  # Use LTS for broader compatibility
  strategy:
    matrix:
      arch: [x64]  # Start with x64, add arm64 later if needed
  env:
    BUILD_CHANNEL: ${{ needs.setup.outputs.channel }}

  steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Checkout rebel-system submodule
      run: |
        git config --global url."https://${{ secrets.REBEL_SYSTEM_TOKEN }}@github.com/".insteadOf "[external-email]:"
        git submodule update --init --recursive

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: ${{ env.NODE_VERSION }}
        cache: 'npm'

    - name: Install system dependencies
      run: |
        sudo apt-get update
        sudo apt-get install -y fakeroot dpkg

    - name: Install dependencies
      run: npm ci --legacy-peer-deps

    - name: Update version for beta
      if: needs.setup.outputs.channel == 'beta'
      run: |
        CURRENT_VERSION=$(node -p "require('./package.json').version")
        BASE_VERSION=$(echo "$CURRENT_VERSION" | sed 's/-.*$//')
        BETA_VERSION="${BASE_VERSION}${{ needs.setup.outputs.version_suffix }}"
        npm version "$BETA_VERSION" --no-git-tag-version

    - name: Bundle Node runtime
      run: npm run bundle:node
      env:
        BUNDLE_NODE_ARCH: ${{ matrix.arch }}

    - name: Bundle Git (dugite-native)
      run: npm run bundle:git
      env:
        BUNDLE_GIT_ARCH: ${{ matrix.arch }}

    - name: Generate runtime config
      env:
        RUDDERSTACK_WRITE_KEY: ${{ secrets.RUDDERSTACK_WRITE_KEY }}
        RUDDERSTACK_DATA_PLANE_URL: ${{ secrets.RUDDERSTACK_DATA_PLANE_URL }}
      run: |
        mkdir -p config
        jq -n \
          --arg writeKey "$RUDDERSTACK_WRITE_KEY" \
          --arg dataPlaneUrl "$RUDDERSTACK_DATA_PLANE_URL" \
          '{analytics: {rudderstack: {writeKey: $writeKey, dataPlaneUrl: $dataPlaneUrl}}, voice: {sttTimeoutMs: 15000, ttsTimeoutMs: 15000}}' \
          > config/app-config.json

    - name: Run Electron Forge make
      run: npx electron-forge make --arch=${{ matrix.arch }}

    - name: Upload artifacts
      uses: actions/upload-artifact@v4
      with:
        name: linux-${{ matrix.arch }}-${{ needs.setup.outputs.channel }}-artifacts
        path: |
          out/make/**/*.deb
        retention-days: 7
```

### GCS Upload (publish-to-gcs job)

Linux artifact handling in the publish job:
```yaml
- name: Publish Linux artifacts
  run: |
    RELEASES_PATH="${{ steps.paths.outputs.releases_path }}"
    ARTIFACT_DIR="artifacts/linux-x64-${BUILD_CHANNEL}-artifacts"
    
    if [ ! -d "$ARTIFACT_DIR" ]; then
      echo "No Linux artifacts found, skipping"
      exit 0
    fi
    
    # Upload DEB for downloads
    for file in ${ARTIFACT_DIR}/**/*.deb; do
      gsutil -m cp "$file" "gs://${GCS_BUCKET}/${RELEASES_PATH}/linux/x64/"
    done
```

### Release Manifest Generation

The `Generate release manifest` step in `publish-to-gcs` includes Linux. Reference for the `linux-x64` manifest entry:

```yaml
# Optional: locate Linux x64 DEB
LINUX_X64_DEB="$(find artifacts/linux-x64-${BUILD_CHANNEL}-artifacts -type f -name '*.deb' | head -n 1 || true)"
if [ -n "${LINUX_X64_DEB}" ]; then
  LINUX_X64_BASENAME="$(basename "$LINUX_X64_DEB")"
  LINUX_X64_SIZE="$(stat -c%s "$LINUX_X64_DEB")"
  LINUX_X64_SHA256="$(sha256sum "$LINUX_X64_DEB" | awk '{print $1}')"
  gsutil -m cp "$LINUX_X64_DEB" "gs://${GCS_BUCKET}/${RELEASES_PATH}/${VERSION_NO_V}/linux-x64/${LINUX_X64_BASENAME}"
  LINUX_X64_URL="https://storage.googleapis.com/${GCS_BUCKET}/${RELEASES_PATH}/${VERSION_NO_V}/linux-x64/${LINUX_X64_BASENAME}"
else
  echo "WARN: Linux x64 DEB not found; skipping versioned upload and manifest entry" >&2
  LINUX_X64_URL=""; LINUX_X64_SHA256=""; LINUX_X64_SIZE="0"
fi
```

And update the `jq` manifest generation to include a `linux-x64` entry:
```yaml
+ (
    if ($linux_url | length) > 0 then
      { "linux-x64": { url: $linux_url, sha256: $linux_sha, size: $linux_size, releaseNotesUrl: $notes } }
    else
      {}
    end
  )
```

---

## Auto-Update Strategy

Electron's built-in `autoUpdater` does **not** support Linux. Rebel uses a **notification-only** model (✅ implemented):

- `src/main/services/linuxUpdateService.ts` fetches `latest.json` from GCS, compares via `semver` (installed as a dependency), and notifies the renderer
- `src/renderer/components/LinuxUpdateAvailableToast.tsx` shows a toast with "Download" (opens browser) and "Later" (dismisses)
- Check cadence: 15s after startup, then every 4 hours
- Beta channel detected from `app.getVersion().includes('-beta')`
- Platform-isolated: all code gated on `process.platform === 'linux'`

### Future Enhancements

- Settings toggle to disable update checks
- Exponential backoff on repeated failures
- Consider `electron-updater` with AppImage for seamless in-place updates
- Consider apt repository hosting for enterprise users

---

## Code Signing on Linux

### Overview

Unlike macOS (notarization) and Windows (Authenticode), Linux does not have a mandatory code signing requirement. Package signing is a best practice for distribution trust and enterprise deployment but is not blocking beta releases.

### Implementation Status: DEFERRED

> **Current State:** GPG signing is **temporarily disabled** in CI. Linux packages are released unsigned.

GPG package signing was attempted but encountered persistent issues with passphrase handling in the non-interactive CI environment. The code is preserved as comments in the workflow for future re-enablement.

### Attempted Approaches (December 2024)

We tried 8+ different approaches to pass the GPG passphrase non-interactively in GitHub Actions:

| Attempt | Approach | Result |
|---------|----------|--------|
| 1 | `dpkg-sig -g "--passphrase-fd 0" <<< "$PASSPHRASE"` | Failed: stdin doesn't reach gpg through dpkg-sig |
| 2 | `--passphrase-file` with temp file | `BADSIG`: signature created but invalid |
| 3 | `echo "$PASS" \| dpkg-sig -g "--passphrase-fd 0"` | Failed: dpkg-sig consumes stdin |
| 4 | Custom wrapper script via `DPKG_SIG_GPG` env var | `BADSIG`: env var doesn't exist in dpkg-sig |
| 5 | `gpg-preset-passphrase` to cache in gpg-agent | `BADSIG`: cache approach unreliable |
| 6 | `expect` script for automated passphrase entry | `NOSIG`: inappropriate ioctl for device |
| 7 | Custom pinentry script with passphrase from env | `BADSIG`: TTY errors, pinentry not being used |
| 8 | Configure pinentry before starting agent | `gpg-agent already running` error |

**Root Cause:** The GitHub Actions environment has no TTY, and gpg-agent starts automatically during key import before custom pinentry configuration can take effect. All attempts to configure a custom pinentry program were thwarted by the agent spawning with default settings.

### Future Solutions to Investigate

1. **Use `debsigs` instead of `dpkg-sig`** - Different tool, may have better non-interactive support
2. **Detached GPG signatures** - Sign with `gpg --detach-sign` instead of embedding in .deb
3. **Pre-cache passphrase before key import** - May require gpg-agent to be explicitly started first
4. **Use a passphrase-less key** - Less secure but would work (not recommended)
5. **Container-based signing** - Run signing in a Docker container with controlled gpg-agent lifecycle

### GitHub Secrets (For Future Use)

| Secret | Description |
|--------|-------------|
| `LINUX_GPG_PRIVATE_KEY` | Base64-encoded GPG private key |
| `LINUX_GPG_PASSPHRASE` | GPG key passphrase |
| `LINUX_GPG_KEY_ID` | GPG key ID (e.g., `ABCD1234EFGH5678`) |

### GPG Key Generation (One-Time Setup)

```bash
# 1. Generate a new GPG key
gpg --full-generate-key
# - Key type: RSA and RSA (default)
# - Key size: 4096
# - Expiry: 0 (does not expire) or 2y
# - Real name: Mindstone Learning Limited
# - Email: security@mindstone.com
# - Set a strong passphrase

# 2. List keys to get the key ID
gpg --list-secret-keys --keyid-format LONG
# Output shows: sec rsa4096/ABCD1234EFGH5678 ...

# 3. Export private key (base64 for GitHub Secrets)
gpg --export-secret-keys --armor ABCD1234EFGH5678 | base64 > gpg-private-key.b64

# 4. Export public key (for user distribution)
gpg --export --armor ABCD1234EFGH5678 > mindstone-gpg-key.asc
```

### User Verification (Future)

Once signing is re-enabled, users will be able to verify signed packages:
```bash
# Import Mindstone's public key
curl -fsSL https://storage.googleapis.com/mindstone-rebel/keys/linux-signing-key.asc | gpg --import

# Verify a downloaded .deb package
dpkg-sig --verify mindstone-rebel*.deb
# Should output: GOODSIG _gpgbuilder ...
```

### CI Implementation (Currently Disabled)

The signing steps are preserved as comments in `.github/workflows/release.yml` in the `build-linux` job:
- Import GPG signing key
- Install dpkg-sig
- Sign DEB packages
- Verify DEB signatures

To re-enable, uncomment these steps and resolve the passphrase handling issues described above.

---

## Implementation Checklist

### Phase 1: Core Linux Support — ✅ Complete

**Dependencies & Configuration:**
- [x] Install Linux maker dependency (`@electron-forge/maker-deb`)
- [x] Add DEB maker configuration to `forge.config.cjs`
- ~~Add Linux native modules to package.json~~ — NOT NEEDED (npm auto-resolves)

**Code Changes:**
- [x] `scripts/bundle-node.mjs`: `'linux'` added to `supportedPlatforms`
- ~~Auto-updater skip~~ — NOT NEEDED (`update-electron-app` handles Linux gracefully)
- [ ] **Remaining:** Create `build/icon.png` (512×512 PNG recommended)

**CI/CD:**
- [x] `build-linux` job in `.github/workflows/release.yml`
- [x] `linux-x64` in `publish-to-gcs` artifact handling
- [x] Manifest generation includes `linux-x64` platform entry
- [x] `build-linux` in the `needs` array for `publish-to-gcs`

### Phase 2: Polish and Signing — Partially Complete

- [ ] Add Linux-specific health checks (`checkLinuxDependencies()`)
- [ ] Ship AppArmor profile with .deb package (eliminates Ubuntu 24.04 workaround)
- [ ] Re-enable GPG package signing in CI (passphrase handling unresolved — see Code Signing section)
- [ ] Publish GPG public key to GCS
- [ ] Document Wayland opt-in
- [ ] Consider arm64 Linux support

### Phase 3: Auto-Update — ✅ Complete (notification-only)

- [x] Notification-only update system (`linuxUpdateService.ts` + `LinuxUpdateAvailableToast.tsx`)
- [ ] Evaluate `electron-updater` with AppImage for seamless in-place updates (future)
- [ ] Consider apt repository hosting for enterprise users (future)

---

## Known Remaining Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Ubuntu 24.04 AppArmor sandbox** | **High** | **High** | User workaround documented below; shipping AppArmor profile is Phase 2 |
| Wayland bugs | Low | Medium | Default to XWayland; users can opt-in via env var |
| Missing tray icon (GNOME) | Medium | Low | Graceful degradation — app works without tray |
| Missing .deb icon | Low | Low | `build/icon.png` not yet created; builds succeed but package has no icon |

---

## Testing Matrix

### Required Testing Before Release

| Distribution | Version | Desktop | Priority |
|--------------|---------|---------|----------|
| Ubuntu | 22.04 LTS | GNOME | P0 |
| Ubuntu | 24.04 LTS | GNOME | P0 |

### Test Cases

1. **Installation**
   - Install .deb via `sudo dpkg -i` or `sudo apt install ./package.deb`
   - Verify desktop entry created
   - Verify icon appears correctly

2. **Core Functionality**
   - Voice recording/transcription
   - TTS playback
   - Agent turns complete successfully
   - MCP server spawning works
   - Workspace file operations

3. **Edge Cases**
   - Launch with Wayland session
   - Tray icon visibility
   - System notifications
   - File permissions on read-only rebel-system

---

---

## Review History

| Date | Reviewer | Confidence | Summary |
|------|----------|------------|---------|
| 2025-12-09 | Chief Engineer Review #1 | 75% | Initial plan review identified 6 critical issues: (1) `bundle-node.js` missing Linux in `supportedPlatforms`, (2) `@electron-forge/maker-deb` not installed, (3) `build/icon.png` missing, (4) Linux native modules missing from `optionalDependencies`, (5) Auto-updater needs Linux skip, (6) CI manifest generation missing Linux platform. |
| 2025-12-09 | Chief Engineer Review #2 | 98% | Deep research and verification completed. **Key findings:** (1) Auto-updater issue RESOLVED - `update-electron-app` source code confirms it exits gracefully on Linux with `supportedPlatforms = ['darwin', 'win32']` check. No code changes needed. (2) Native modules issue RESOLVED - npm auto-fetches platform-specific deps from package dependencies (verified rollup declares 15+ platform variants). (3) Ubuntu 24.04 AppArmor issue DISCOVERED - new sandbox restrictions require workaround documentation or AppArmor profile shipping. (4) Icon requirements clarified - 512x512 PNG recommended. (5) Effort reduced from 3-4 days to 2-3 days. **Remaining blockers:** (a) One-line fix in bundle-node.js, (b) Install maker-deb, (c) Create icon.png, (d) CI workflow updates, (e) Document Ubuntu 24.04 workaround. |
| 2025-12-10 | Chief Engineer Review #3 (Droid) | 85% | **Linux Update Notification Plan Review.** Plan follows industry best practices - same pattern as `electron-update-notification` library. **Approved with revisions:** (1) Fixed beta detection to use `app.getVersion().includes('-beta')` instead of fragile path checking. (2) Updated to use existing toast infrastructure with new `LinuxUpdateAvailableToast` component (reuses `UpdateAvailableToast.module.css`). (3) Added proper IPC subscription definition using `defineSubscription()` pattern. (4) Changed semver import from dynamic to static. (5) Uses existing `shellOpenExternal` API instead of new IPC handler. **Research verified:** Approach matches `pd4d10/electron-update-notification`, electron-builder docs, and Stack Overflow patterns for Linux Electron apps. |
| 2025-12-11 | Chief Engineer Review #4 | 85% | **Plan critique incorporated.** Key improvements: (1) Added prerequisites table with P0/P1 blockers (semver dependency, CI manifest, TypeScript types). (2) Added JSON parse error handling with try/catch. (3) Added manifest field validation before access. (4) Added `webContents.isDestroyed()` check for backgrounded app edge case. (5) Added interval cleanup on `app.on('will-quit')`. (6) Noted semver is NOT currently installed - must be added or use simple version compare. (7) Added implementation checklist with status tracking. (8) Added platform isolation section confirming no interference with macOS/Windows. (9) Added future enhancements section (settings toggle, exponential backoff, test coverage). Time estimate updated to 2-3 hours. |

---

## Appendix: Research Sources

### Official Documentation
- [Electron Forge DEB Maker](https://www.electronforge.io/config/makers/deb) - Official DEB packaging documentation
- [Electron Forge Custom Icons](https://www.electronforge.io/guides/create-and-add-icons) - Icon format requirements (512x512 PNG recommended)
- [Electron autoUpdater API](https://electronjs.org/docs/latest/api/auto-updater) - Confirms Linux not supported by built-in autoUpdater

### Source Code Verification
- [update-electron-app source](https://github.com/electron/update-electron-app/blob/main/src/index.ts) - Line ~117 confirms `supportedPlatforms = ['darwin', 'win32']` with graceful early exit on Linux
- [rollup npm registry](https://www.npmjs.com/package/rollup) - Confirms package declares own platform-specific optionalDependencies (15+ variants)

### Ubuntu 24.04 / AppArmor Issues
- [Electron Issue #42510](https://github.com/electron/electron/issues/42510) - SUID sandbox helper error on Ubuntu 24.04
- [Electron Issue #41066](https://github.com/electron/electron/issues/41066) - AppArmor userns restrictions affecting all Electron versions
- [electron-builder Issue #8635](https://github.com/electron-userland/electron-builder/issues/8635) - AppArmor profile shipping discussion
- [AppImage Sandboxing Docs](https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html) - Unprivileged namespace requirements

### npm optionalDependencies Research
- [npm CLI Issue #4828](https://github.com/npm/cli/issues/4828) - Platform-specific optional deps bug (largely fixed in npm 11.3.0)
- [npm CLI Issue #7961](https://github.com/npm/cli/issues/7961) - OS/CPU package variants pruning bug

### Other References
- [Linux Statistics 2025](https://sqmagazine.co.uk/linux-statistics/) - Distribution market share data
- [Packagecloud DEB Signing](https://blog.packagecloud.io/how-to-gpg-sign-and-verify-deb-packages-and-apt-repositories/) - DEB signing process
