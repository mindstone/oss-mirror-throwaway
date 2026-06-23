---
description: "Distribution reference for Mindstone Rebel — auto-updates, code signing, installers, platform behaviours, and user update troubleshooting"
last_updated: "2026-04-05"
---

# Distribution

This document explains how the app reaches users: auto-updates, code signing, and platform-specific installation details.

## See also

**Project Documentation**
- [AUTO_UPDATE](./AUTO_UPDATE.md) — **Detailed auto-update architecture, troubleshooting, and known issues**
- [BUILD_AND_RELEASE_OVERVIEW](./BUILD_AND_RELEASE_OVERVIEW.md) — hub for all build/release docs
- [BUILDING](./BUILDING.md) — local build commands and outputs
- [CI_PIPELINE](./CI_PIPELINE.md) — CI automation and artifact storage
- [RELEASING](./RELEASING.md) — step-by-step runbook for releasing
- [SETUP_USER](./SETUP_USER.md) — end-user installation guide
- [WINDOWS_SUPPORT](./WINDOWS_SUPPORT.md) — Windows-specific implementation details

**Research Documentation (Installer Strategy)**
- [260202_Squirrel_vs_NSIS_Windows_Installer_Deep_Dive.md](../research/260202_Squirrel_vs_NSIS_Windows_Installer_Deep_Dive.md) — **Squirrel vs NSIS comparison, migration recommendation**
- [260127_Installer_Updater_Recommendation.md](../research/260127_Installer_Updater_Recommendation.md) — NSIS + electron-updater analysis


## Auto-updates

The app uses `update-electron-app` with StaticStorage pointed at GCS buckets.

| Channel | Update feed URL |
|---------|-----------------|
| Stable | `https://storage.googleapis.com/mindstone-rebel/updates/` |
| Beta | `https://storage.googleapis.com/mindstone-rebel/updates-beta/` |

### How it works

1. The app checks the GCS bucket for new versions every hour
2. Compares the available version against the installed version
3. If the GCS version is **higher** → user sees an update prompt
4. User can install the update immediately or defer

### Update formats

| Platform | Format |
|----------|--------|
| macOS | `RELEASES.json` manifest + ZIP archives |
| Windows | `RELEASES` file + nupkg packages (Squirrel format) |


## macOS distribution

### Code signing status

- Builds are signed with a **Developer ID Application** certificate owned by **Mindstone Learning limited**
- Users can verify the signer via Finder's "Get Info" dialog or `codesign --display --verbose=4`
- **Not notarized** — was historically blocked by unsigned third-party native libraries from the Claude Agent SDK (removed April 2026). Notarization may now be feasible and should be re-evaluated.

### Gatekeeper behavior

Because the app is Developer ID-signed but **not** notarized, first-time launch shows a Gatekeeper warning:

> "Mindstone Rebel" cannot be opened because Apple cannot check it for malicious software.

**Workaround — Option 1 (Right-click Open):**
1. Right-click (or Control-click) the app in Finder
2. Choose **Open**
3. In the dialog, click **Open** again

**Workaround — Option 2 (Security settings):**
1. Attempt to open the app once (it will be blocked)
2. Open **System Settings → Privacy & Security → General**
3. Find the message about the app being blocked
4. Click **Open Anyway**, then confirm with **Open**

After the first successful launch, macOS treats the app as trusted.


## Windows distribution

Windows builds currently use the Squirrel installer format:

- `.exe` installer that handles installation and updates
- `.nupkg` packages for delta updates
- **Signed** with Azure Trusted Signing (certificate: `CN=Mindstone Learning Limited`)

> **Note:** Squirrel.Windows is unmaintained (last release 2020). We are evaluating migration to NSIS.
> See [260202_Squirrel_vs_NSIS_Windows_Installer_Deep_Dive.md](../research/260202_Squirrel_vs_NSIS_Windows_Installer_Deep_Dive.md) for analysis.

See:
- [WINDOWS_CODESIGNING](./WINDOWS_CODESIGNING.md) for code signing details
- [WINDOWS_SUPPORT](./WINDOWS_SUPPORT.md) for Windows-specific implementation details
- [AUTO_UPDATE](./AUTO_UPDATE.md) for update troubleshooting and known Squirrel issues


## Troubleshooting

### App will not open after installation (macOS)

1. Follow the Gatekeeper workarounds above
2. Check logs at:
   - Stable: `~/Library/Application Support/mindstone-rebel/logs/`
   - Beta: `~/Library/Application Support/mindstone-rebel-beta/logs/`

### Users don't see an update

Most likely the version wasn't bumped before merging to main. The auto-updater compares version strings — if the version is the same, no update appears.

Check what version is live:

```bash
curl -s https://storage.googleapis.com/mindstone-rebel/releases/latest.json | jq .version
```

If this matches what users already have, you'll need to bump the version and release again. See [RELEASING](./RELEASING.md).

### Windows SmartScreen warning

SmartScreen warnings should not appear for signed builds. If users see SmartScreen warnings:

1. Verify the installer is signed: `Get-AuthenticodeSignature Setup.exe`
2. SmartScreen may still warn for new certificates with low reputation - reputation builds over time
3. See [WINDOWS_CODESIGNING](./WINDOWS_CODESIGNING.md) for troubleshooting


