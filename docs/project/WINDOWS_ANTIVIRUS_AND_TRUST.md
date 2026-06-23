---
description: "Windows antivirus and trust hub — signing posture, false-positive causes, runtime AV resilience, canonical history"
last_updated: "2026-05-14"
---

# Windows Antivirus & Trust (Signing + AV Hardening)

This doc is an **internal, reusable context hub** for all Windows antivirus (AV) and “trust” work in Mindstone Rebel.

It’s meant to answer:
- “Why did AV flag this, and what did we do about it?”
- “What’s the current signing pipeline, and where do I debug it?”
- “Which commits/plans are the canonical history for future work?”

> User-facing guidance lives in `rebel-system/help-for-humans/windows-security-and-antivirus.md`.

---

## Canonical docs (start here)

- **Code signing SSoT:** `docs/project/WINDOWS_CODESIGNING.md`
- **Windows support (includes AV resilience + enterprise allowlisting):** `docs/project/WINDOWS_SUPPORT.md`
- **Auto-update architecture (NSIS + electron-updater):** `docs/project/AUTO_UPDATE.md`
- **Distribution overview:** `docs/project/DISTRIBUTION.md`
- **User-facing AV guide:** `rebel-system/help-for-humans/windows-security-and-antivirus.md`

---

## Problem model (why Windows AV flags Electron apps)

> **Note (January 2026):** We migrated from Squirrel.Windows to NSIS + electron-builder. This simplified our signing pipeline significantly - we no longer need to sign/strip Squirrel vendor binaries or use the signtool wrapper for installer creation. See `docs/project/WINDOWS_SUPPORT.md` for details.

Common Windows AV triggers for Rebel (and many Electron apps):

1. **Unsigned or inconsistently signed binaries** (outer installer vs inner installed files).
2. **Updater behavior** (Squirrel.Windows downloads/extracts/executes, touches many files; looks “self-modifying”).
3. **Bundled tools** (e.g., `rg.exe`, `node.exe`, `git.exe`) that get scanned/quarantined.
4. **Cold-start execution delays** (AV can block `CreateProcess` or file opens, causing “hangs” that timeouts can’t prevent).

We address this across **two tracks**:

- **Trust building (signing + metadata + verification gates)** to reduce false positives.
- **Runtime resilience** so AV-induced delays don’t look like app freezes.

---

## Current “trust” posture (what should be signed)

See full details in `docs/project/WINDOWS_CODESIGNING.md`.

At a high level, Windows trust depends on:

- **Azure Trusted Signing** (publisher identity: `CN=Mindstone Learning Limited`).
- Signing **both**:
  - the **installer** (`Setup.exe`), and
  - the **packaged/installed executables** that AV actually scans during install/first launch.

We generally preserve **vendor signatures** for third-party components (e.g., Electron/Chromium, bundled Git/Node) and avoid re-signing them in CI unless we have a specific need.

### Key binaries explicitly covered

- `Mindstone Rebel.exe` / `Mindstone Rebel Beta.exe`
- `*-Setup-*.exe` (NSIS installer)
- `rg.exe` (ripgrep — formerly bundled with the removed Claude Agent SDK; may no longer be in the bundle)
- `node.exe` (bundled Node.js for MCP server execution)

---

## Runtime AV resilience (when AV causes hangs, not detections)

The key nuance: on Windows, AV can delay **process creation**. Node timeouts often don’t apply because the timeout starts *after* `spawn()` returns.

Primary mitigations (see `docs/project/WINDOWS_SUPPORT.md#antivirus-resilience` and `docs/plans/finished/260121_Windows_AV_Resilience.md`):

- **Preflight “warmup”** to trigger AV scans during “Getting ready…” (not mid-turn):
  - `src/main/services/systemHealthService.ts` (fire-and-forget read of `rg.exe`)
- **Watchdogs/diagnostics** for likely AV blocks:
  - the former `squirrelHandler.ts` Update.exe spawn watchdog — **removed in the Squirrel→NSIS migration** (residual Squirrel cleanup now lives in `src/main/services/squirrelCleanupService.ts`)
  - `src/main/services/agentTurnExecutor.ts` (no-output watchdog; logs + Sentry)
- **Defensive install validation** that is explicitly **AV-safe** (read-only detection, not aggressive cleanup):
  - `docs/plans/finished/260120_Defensive_Windows_Install.md`
  - `src/main/startup/ensureUserDataHealth.ts` (the former `squirrelHandler.ts` validation was removed with the NSIS migration)

---

## Where the implementation lives

### CI / signing pipeline

- `.github/workflows/release.yml` — production Windows signing pipeline
- `.github/workflows/test-windows-signing.yml` — isolated workflow for signing experiments
- `scripts/windows-signing/create-signtool-wrapper.ps1` — generates the selective `signtool.exe` wrapper
- `forge.config.cjs` — Forge/Squirrel config; `signWithParams`; `win32metadata`

### Runtime AV resilience + update surfaces

- the former `squirrelHandler.ts` — Squirrel event handling + Update.exe spawn resilience; **removed in the NSIS migration** (residual cleanup: `src/main/services/squirrelCleanupService.ts`)
- `src/main/services/systemHealthService.ts` — preflight warmups
- `src/main/services/agentTurnExecutor.ts` — watchdog when SDK/CLI output stalls (possible AV block)
- `src/main/services/autoUpdateService.ts` — update orchestration (see `docs/project/AUTO_UPDATE.md`)

---

## Key plans / investigations (deep context)

### AV false positives

- `Google Drive `droid-conversations/mindstonerebel/2026/01/260112_windows_avast_idp_generic_false_positive.md` — original “IDP.Generic” user report + initial hypothesis
- `docs/plans/finished/260116_windows_av_false_positive_hardening.md` — ripgrep signing + PE/DLL/.node audits + future stages
- `docs/plans/finished/260121_ensure_all_exe_signed.md` — ensure Update.exe/Squirrel.exe/rg.exe are actually signed; add CI verification

### Runtime resilience / install defensiveness

- `docs/plans/finished/260121_Windows_AV_Resilience.md` — warmups + watchdogs; why timeouts don’t protect against AV
- `docs/plans/finished/260120_Defensive_Windows_Install.md` — install/update corruption detection with AV-safe constraints
- `docs/plans/finished/260121_Windows_Version_Metadata.md` — Windows PE metadata fields to improve AV/SmartScreen trust

### Signing debugging (critical incident)

- `docs/plans/finished/260122_windows_signing_debugging_lessons.md` — the “Phantom Security Directory” bug timeline and fix
- `docs/plans/finished/260121_fix_signtool_wrapper_path_spaces.md` — handling unquoted paths with spaces

### Earlier signing architecture / perf constraints

- `docs/plans/finished/251222_windows_code_signing_fix.md` — original “sign inner binaries before Squirrel” plan
- `docs/plans/finished/260109_windows_build_optimization.md` — why recursive signing and high file counts were infeasible

---

## Key commits (milestones)

> Tip: for any hash below: `git show <hash>` (superproject) or `git -C rebel-system show <hash>` (submodule).

### 2026-01

- `cb000cd5` — fix(windows): resolve phantom Security Directory signing bugs + add `WINDOWS_CODESIGNING.md`
  - Adds durable troubleshooting explanation + signature-stripping fix for Squirrel-modified binaries.
- `f4df3570` — fix(windows): sign Squirrel vendor binaries (Update.exe/Squirrel.exe) to prevent AV false positives
  - Ensures vendor updater executables are signed before `make`.
- `45738f0b` — fix(windows): handle unquoted paths with spaces in signtool wrapper
- `af417596` — feat(windows): AV resilience (preflight warmup + watchdogs)
- `fc1f626a` — feat(windows): AV-safe defensive install validation
- `b26dc037` — feat(windows): add Windows version metadata to improve AV trust
- `667c86ab` — feat(ci): integrate Windows AV hardening into release workflow
- `50520bb3` — feat(ci): add Windows AV hardening with ripgrep signing (+ plan + wrapper update)
- `d5ee0d10` — fix(ci): sign Windows packaged exe before Squirrel make, add anti-virus improvements

### 2025-12

- `71d4842c` — feat: Windows selective signing (wrapper + exclusions) to keep CI fast enough to ship
- `919e9b75` — refactor(ci): simplify Windows signing with `signWithParams`

### User-facing AV guide (submodule)

- Superproject pointer update: `b7140ba2` — chore(rebel-system): add Windows security and antivirus guide
- Submodule commits (in `rebel-system/`):
  - `222d113` — add user-facing Windows security & antivirus guide
  - `1b2d475` — add Bitdefender GravityZone exclusion instructions
  - `2003641` — add workspace + app data exclusions for AV performance
  - `8c60e26` — add enterprise onboarding guidance for IT teams

---

## Responding to a new AV false positive (internal runbook)

### 1) Collect minimal evidence

- AV product + detection name (e.g., Avast/AVG “IDP.Generic”)
- Which file path was quarantined/blocked (`Update.exe`, `Squirrel.exe`, `rg.exe`, installer, etc.)
- Exact Rebel version + channel (beta/stable)
- Whether the file is **signed** (ask for screenshot of Digital Signatures tab or:
  - `Get-AuthenticodeSignature -LiteralPath "<path>"`)

### 2) Confirm signing coverage (fast checks)

- CI: confirm `release.yml` ran the signing steps and the current verification gates (notably **“Review signtool wrapper log”**).
- Locally (on Windows): verify signatures for the quarantined binary and the installer.

### 3) Submit to vendors (if needed)

**Microsoft (SmartScreen / Defender reputation):**
- Submit signed installer + hashes via Microsoft submission portal (see Stage 7 suggestion in `docs/plans/finished/260116_windows_av_false_positive_hardening.md`).

**Avast/AVG:**
- Submit as false positive with:
  - signed binary,
  - SHA256,
  - detection name,
  - reproduction notes.

Keep submissions reproducible: treat them as “per-release reputation ops” until reputation stabilizes.

---

## Known sharp edges (don’t rediscover these)

- **`0x800700C1 (ERROR_BAD_EXE_FORMAT)` during signing** is often a malformed PE certificate table (Phantom Security Directory).
  - Canonical explanation + fix: `docs/project/WINDOWS_CODESIGNING.md` and `docs/plans/finished/260122_windows_signing_debugging_lessons.md`.
- **Paths with spaces** can arrive unquoted from third-party tooling; wrapper must reconstruct paths.
  - See: `docs/plans/finished/260121_fix_signtool_wrapper_path_spaces.md`.
- **Performance constraints matter**: recursive signing and huge file counts can make Windows builds unusably slow.
  - See: `docs/plans/finished/260109_windows_build_optimization.md`.
