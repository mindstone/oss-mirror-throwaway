---
description: "Windows code signing source of truth — Azure Trusted Signing, signtool wrapper, CI flow, verification, troubleshooting"
last_updated: "2026-05-15"
---

# Windows Code Signing

This document is the **single source of truth** for Windows code signing in Mindstone Rebel. It covers the signing architecture, Azure Trusted Signing configuration, the signtool wrapper, known issues, and troubleshooting.

## See Also

- [DISTRIBUTION](DISTRIBUTION.md) - Auto-updates and platform-specific distribution
- [WINDOWS_SUPPORT](WINDOWS_SUPPORT.md) - Windows-specific implementation (symlinks, paths, process spawning)
- [CI_PIPELINE](CI_PIPELINE.md) - CI automation and artifact storage
- [BUILD_AND_RELEASE_OVERVIEW](BUILD_AND_RELEASE_OVERVIEW.md) - Hub for all build/release docs

### Historical Debugging Lessons

These planning documents contain detailed debugging timelines and lessons learned:

| Document | Summary |
|----------|---------|
| [260122_windows_signing_debugging_lessons.md](../plans/finished/260122_windows_signing_debugging_lessons.md) | **The Phantom Security Directory Bug** - 11 workflow runs debugging `0x800700C1` errors |
| [251222_windows_code_signing_fix.md](../plans/finished/251222_windows_code_signing_fix.md) | Original Azure Trusted Signing setup, split package/make flow |
| [260109_windows_build_optimization.md](../plans/finished/260109_windows_build_optimization.md) | Build performance including signing overhead |
| [260121_ensure_all_exe_signed.md](../plans/finished/260121_ensure_all_exe_signed.md) | Ensuring all EXEs are signed (Update.exe, Squirrel.exe, rg.exe) |
| [260121_fix_signtool_wrapper_path_spaces.md](../plans/finished/260121_fix_signtool_wrapper_path_spaces.md) | Handling file paths with spaces in signtool wrapper |

---

## Overview

All Windows executables are signed using **Azure Trusted Signing** (formerly Azure Code Signing). This includes:

| File | Purpose | When Signed |
|------|---------|-------------|
| `Mindstone Rebel.exe` | Main application | After package, before make |
| `rg.exe` (ripgrep) | Search binary (AV false-positive mitigation) | After package, before make |
| `Update.exe` | Squirrel update manager | Before make (explicit Azure action) |
| `Squirrel.exe` | Installer/updater | Before make, then stripped, then re-signed during make |
| `_ExecutionStub.exe` | App launcher stub | During make (via wrapper) |
| `Setup.exe` | Final installer | After make |

**Note:** `Update.exe` and `Squirrel.exe` come from `node_modules/electron-winstaller/vendor/`. They are signed explicitly BEFORE make. `Squirrel.exe` is then stripped and re-signed because rcedit modifies it. `Update.exe` is NOT stripped (not modified).

**Why sign?** Without signatures:
- Windows SmartScreen blocks installation
- Antivirus software flags executables as suspicious
- Enterprise policies may prevent installation

---

## Signing Architecture

### CI Pipeline Flow

The Windows signing pipeline in `.github/workflows/release.yml` follows this sequence:

```
1. Package application (electron-forge package)
2. Sign packaged app exe with Azure Trusted Signing
3. Sign ripgrep binary with Azure Trusted Signing (AV hardening)
4. Verify pre-make signatures
5. Setup Azure Trusted Signing for Squirrel stubs
6. Create signtool wrapper (selective signing)
7. Sign Squirrel vendor binaries (Update.exe, Squirrel.exe, etc.)
8. Verify vendor signatures
9. STRIP signatures from StubExecutable, Squirrel, Setup (prevents phantom bug)
10. Make installer (electron-forge make --skip-package)
11. Review signtool wrapper log
12. Sign final installer (Setup.exe) with Azure Trusted Signing
13. Verify all final signatures
```

**Key insight:** We sign vendor binaries, then STRIP signatures from specific files before make. This prevents the "Phantom Security Directory" bug (see below).

### The Split Package/Make Flow

Originally, `electron-forge make` ran both package and make in one step. We split this to allow signing between steps:

```yaml
# Step 1: Package
npx electron-forge package

# Step 2: Sign packaged app
# (Azure Trusted Signing action)

# Step 3: Make installer (skip package since already done)
npx electron-forge make --skip-package
```

This ensures the main app executable is signed BEFORE Squirrel bundles it into the installer.

---

## Azure Trusted Signing Configuration

### Required Secrets

| Secret | Description |
|--------|-------------|
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_CLIENT_ID` | Service principal client ID |
| `AZURE_CLIENT_SECRET` | Service principal secret |
| `AZURE_CODE_SIGNING_ENDPOINT` | Azure Code Signing endpoint URL |
| `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_CERT_PROFILE_NAME` | Certificate profile name |

### How It Works

1. **Azure Trusted Signing Action** (`azure/trusted-signing-action@v0.5.0`) handles direct signing of specific directories
2. **Signtool wrapper** intercepts Squirrel's calls to signtool and routes them through Azure Trusted Signing
3. **Sign parameters** are built from:
   - **Trusted Signing Client** downloaded from NuGet (`Microsoft.Trusted.Signing.Client`)
   - **metadata.json** generated with endpoint, account, and profile settings
   - The parameters are stored in `WINDOWS_SIGN_PARAMS`:
   ```
   /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib <path>\Azure.CodeSigning.Dlib.dll /dmdf <path>\metadata.json
   ```

---

## The Signtool Wrapper

### Why It Exists

Squirrel calls `signtool.exe` directly during the releasify process. We need to:
1. **Intercept** these calls and route them through Azure Trusted Signing
2. **Skip** already-signed files (bundled Git, Node.js) for performance
3. **Handle** path reconstruction when Squirrel passes unquoted paths with spaces

**Implementation:** The wrapper script generates a C# executable that **replaces** `node_modules/electron-winstaller/vendor/signtool.exe`. The real Windows SDK signtool is copied to `REAL_SIGNTOOL_PATH` and called by the wrapper when signing is needed.

### How It Works

The wrapper (`scripts/windows-signing/create-signtool-wrapper.ps1`) generates a C# executable that:
1. Receives signtool arguments from Squirrel
2. Checks if the file should be excluded or must-sign
3. Waits for file to exist (handles race conditions)
4. Validates PE header before signing
5. Calls the real signtool with Azure Trusted Signing parameters
6. Logs all decisions to `SIGNTOOL_WRAPPER_LOG`

### Exclusion Patterns

Files matching these patterns are SKIPPED (already signed or unnecessary):
```csharp
@"\\resources\\git-bundle\\"       // Bundled Git (already signed)
@"\\resources\\node-bundle\\"      // Bundled Node.js (already signed)
@"\\resources\\claude-agent-sdk\\vendor\\"  // SDK vendor files
@"\\prebuilds\\(?!win32-)"         // Non-Windows native prebuilds
@"\\dummy\.node$"                  // Zero-byte placeholder
```

### Must-Sign Patterns

Files matching these are ALWAYS signed (never excluded):
```csharp
@"Mindstone Rebel Beta\.exe$"
@"Mindstone Rebel\.exe$"
@"_ExecutionStub\.exe$"
@"\\squirrel\.exe$"
@"\\Update\.exe$"
@"\\rg\.exe$"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `REAL_SIGNTOOL_PATH` | Path to the actual Windows SDK signtool.exe |
| `SIGNTOOL_WRAPPER_LOG` | Path to log file for debugging |
| `WINDOWS_SIGN_PARAMS` | Azure Trusted Signing parameters |

---

## The Phantom Security Directory Bug

### Background

This is our most complex Windows signing issue. It manifests as `0x800700C1 (ERROR_BAD_EXE_FORMAT)` when signtool tries to sign certain executables.

**Root cause:** When a signed PE file is modified (by rcedit or WriteZipToSetup), the signature bytes are removed but the **PE header's Security Directory entry is NOT cleared**. This creates a "phantom" pointer to:
- Data beyond the end of file, OR
- Data that is now something else (like appended ZIP payload)

### The Three Instances

| File | How Modified | Security Dir Points To |
|------|--------------|----------------------|
| `_ExecutionStub.exe` | rcedit adds icon/version | Beyond EOF (file truncated) |
| `Squirrel.exe` | rcedit adds setup icon | Beyond EOF |
| `Setup.exe` | WriteZipToSetup appends nupkg | ZIP payload data (wrong format) |

### The Fix

**Strip signatures BEFORE modification:**

```powershell
$binariesToStrip = @("StubExecutable.exe", "Squirrel.exe", "Setup.exe")
foreach ($binary in $binariesToStrip) {
    signtool remove /s $binaryPath
}
```

This step runs AFTER signing vendor binaries but BEFORE make. With no signature, there's no Security Directory entry to become orphaned.

### Diagnostic Signs

If you see this in CI logs:
```
SignTool Error: SignedCode::Sign returned error: 0x800700C1
For more information, please see https://aka.ms/badexeformat
```

Check the wrapper log for PE diagnostics:
```
DIAG | Security Directory (cert table): Offset=223232, Size=15808
DIAG | Security Dir checks: WithinFile=FAIL  ← Security Dir points beyond EOF
```

Or:
```
DIAG | WIN_CERTIFICATE: dwLength=2679130783, wRevision=0x4205
DIAG | WIN_CERTIFICATE validity: Revision=FAIL, Type=FAIL  ← Garbage data at Security Dir location
```

---

## Troubleshooting

### 0x800700C1 (ERROR_BAD_EXE_FORMAT)

**Symptom:** signtool fails with "is not a valid Win32 application"

**Causes:**
1. **Phantom Security Directory** - See section above
2. **File still being written** - Wrapper has 10s wait loop, but check for race conditions
3. **Corrupt PE header** - Check wrapper log for PE validation errors

**Debug steps:**
1. Check the **"Review signtool wrapper log"** step output in the CI workflow logs
2. Search for `DIAG | Security Directory` lines
3. Check `WithinFile` result
4. If `FAIL`, the signature strip step may have missed this file

### Files Not Being Signed

**Symptom:** Executables in the final package are unsigned

**Causes:**
1. **Matched exclusion pattern** - Check wrapper log for `SKIP` entries
2. **Not called by Squirrel** - Some files need explicit Azure Trusted Signing action
3. **File path had spaces** - Check for `fixedArgs` entries in log

**Debug steps:**
1. Check wrapper log for the specific file
2. Verify file path doesn't match exclusion patterns
3. Verify file path matches must-sign patterns if expected

### Azure Authentication Failures

**Symptom:** Azure Trusted Signing action fails with auth error

**Causes:**
1. **Expired service principal secret**
2. **Missing or incorrect secrets in GitHub**
3. **Azure subscription issues**

**Debug steps:**
1. Check Azure portal for service principal status
2. Verify all 6 secrets are set in GitHub repository settings
3. Try regenerating `AZURE_CLIENT_SECRET`

### Verifying Signatures Locally

```powershell
# Check if a file is signed
Get-AuthenticodeSignature -LiteralPath "path\to\file.exe"

# Detailed signature info
signtool verify /pa /v "path\to\file.exe"

# Check signer
(Get-AuthenticodeSignature "file.exe").SignerCertificate.Subject
# Should show: CN=Mindstone Learning Limited
```

---

## Performance Considerations

### Why Signing Is Slow

1. **Network calls** - Each file requires a round-trip to Azure Trusted Signing
2. **File enumeration** - Squirrel processes every file in the package
3. **Windows Defender** - Real-time scanning adds overhead

### Optimizations Applied

1. **Selective signing** - Wrapper skips already-signed files (Git, Node.js bundles)
2. **Defender exclusions** - CI adds workspace to Defender exclusions
3. **Same-drive temp** - Temp directories on same drive as workspace (avoids cross-drive copy)

### Expected Timing

| Operation | Typical Duration |
|-----------|-----------------|
| Sign packaged app exe | ~30s |
| Sign vendor binaries | ~1 min |
| Make installer (with signing) | 10-15 min |
| Sign final installer | ~30s |
| Total Windows signing | ~15-20 min |

---

## Key Lessons Learned

### 1. Don't Assume the Obvious Cause
The first `0x800700C1` investigation assumed path quoting issues. Reality: the PE structure was corrupted. **Always gather diagnostic data before implementing fixes.**

### 2. Add Diagnostic Logging Incrementally
Each CI run revealed more information. Start with broad logging (what goes in, what comes out), then narrow down.

### 3. Signtool Errors Are Cryptic
`0x800700C1` just means "something is wrong with this PE." You may need to parse the PE structure yourself to find the specific corruption.

### 4. PE Validation Has Layers
Basic PE validation (MZ header, PE signature) can pass while signing-specific validation fails. For signing issues, focus on the **Security Directory** (data directory entry 4).

### 5. Fix Upstream, Not Downstream
The phantom Security Directory bug couldn't be fixed by handling malformed output. The fix was stripping signatures from INPUT files before they were modified.

### 6. Any Signed File That Gets Modified Is At Risk
The bug affects ANY signed binary that gets modified after signing:
- rcedit icon/version injection
- WriteZipToSetup payload appending
- Any other PE modification tool

---

## Files Reference

| File | Purpose |
|------|---------|
| `.github/workflows/release.yml` | Main CI workflow with all signing steps |
| `scripts/windows-signing/create-signtool-wrapper.ps1` | Signtool wrapper generator |
| `forge.config.cjs` | Electron Forge config (includes signWithParams) |
| `node_modules/electron-winstaller/vendor/` | Squirrel vendor binaries |
