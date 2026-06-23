---
description: "Dev/testing guide for resetting onboarding state — script flags, dev vs prod targeting, preserved data, OS permissions"
last_updated: "2025-12-10"
---

# Reset Onboarding for Testing

Instructions for AI agents to reset a user's onboarding state for testing purposes.


## Quick Reference

**Default action** (dev only):
```bash
./scripts/reset-onboarding.sh --dev
```

**Only reset prod if the user explicitly asks** (e.g., "reset prod", "reset production", "reset the packaged app"):
```bash
./scripts/reset-onboarding.sh --prod
```

**Only use these flags if user explicitly requests:**
```bash
# Clear workspace selection (user asks to "reset workspace" or "clear save location")
./scripts/reset-onboarding.sh --dev --reset-workspace

# Clear API keys (user asks to "reset keys", "clear API keys", "start completely fresh")
./scripts/reset-onboarding.sh --dev --reset-keys

# Full reset (user asks to "reset everything" or "completely fresh start")
./scripts/reset-onboarding.sh --dev --all --reset-workspace --reset-keys
```


## What Gets Reset

**By default**, the script resets:
- `onboardingCompleted` and `onboardingFirstCompletedAt` in app-settings.json
- localStorage (`permission-onboarding-shown` flag)

**With optional flags:**
| Flag | What it clears |
|------|----------------|
| `--all` | Session history |
| `--reset-workspace` | Workspace/coreDirectory setting |
| `--reset-keys` | API keys (Claude, OpenAI, ElevenLabs) |


## What Does NOT Get Reset

**OS-level permissions are NOT reset by this script.** The user must manually revoke these in System Settings if they want to fully re-test the permissions flow:

1. **Microphone**: System Settings → Privacy & Security → Microphone → toggle off Mindstone Rebel
2. **Files & Folders**: System Settings → Privacy & Security → Files and Folders → remove Mindstone Rebel's access

Inform the user of these manual steps after running the script.


## Data Locations

| Environment | Path |
|-------------|------|
| Dev | `~/Library/Application Support/mindstone-rebel/` |
| Prod | `~/Library/Application Support/Mindstone Rebel/` |


## Script Options

```bash
./scripts/reset-onboarding.sh [--dev | --prod] [--all] [--reset-workspace] [--reset-keys]

Options:
  --dev              Reset dev environment only (DEFAULT assumption for AI)
  --prod             Reset prod environment only
  --all              Also clear session history
  --reset-workspace  Also clear workspace/coreDirectory setting
  --reset-keys       Also clear API keys (Claude, voice providers)
```

Without flags, the script resets BOTH environments. Always pass `--dev` unless user requests otherwise.


## Prerequisites

- The app must not be running (script will warn and exit if it detects the app)
- `jq` is required for partial resets (preserves settings not being cleared); without it, the entire settings file is deleted
