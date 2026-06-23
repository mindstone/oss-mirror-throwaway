---
description: "How the rebel-system submodule is used in development and bundled into app releases, plus where to find the canonical sync workflow."
last_updated: "2026-04-16"
---

# Rebel System Distribution

This document explains how the `rebel-system` instruction files are bundled and distributed with the app.

## Overview

The app ships with "rebel system" - Markdown files (AGENTS.md, skills, help-for-humans) and scripts that guide the AI agent's behavior, provide help documentation, and define system policies. These instructions are bundled directly into the app package.

**Key point:** App releases include the rebel-system content as a bundled resource. Changes to rebel-system require a new app release.

## How It Works

### Development Mode

In dev mode (`npm run dev`), the app uses the local `rebel-system/` submodule:

```
rebel-app/
├── rebel-system/    ← submodule, editable locally
├── src/
└── ...
```

- Edit instructions locally, changes reflect immediately
- Keep the repo and submodules in sync with the approved safe-sync workflow from the repo root:
  ```bash
  npx tsx scripts/git-safe-sync.ts --no-push
  ```
- No network requests or downloads at runtime

### Production Mode

In packaged builds, the rebel-system is bundled as an extraResource:

1. During packaging, `rebel-system/` directory is copied to the app's Resources folder
2. At runtime, `getSystemSettingsPath()` returns `process.resourcesPath/rebel-system`
3. Workspace symlinks point to this bundled location

### Storage locations (cross‑platform)

In production, the bundled instructions are at:

- macOS: `<app>.app/Contents/Resources/rebel-system/`
- Windows: `<app>/resources/rebel-system/`

At runtime, the app creates a workspace symlink named `rebel-system/` inside the selected `coreDirectory` that points to the bundled location.

## Guidelines for Managing Changes

### Before Releasing an App Version

1. **Test instructions with the app** - Run the app in dev mode with your instruction changes
2. **Commit submodule updates** - Ensure the submodule pointer is updated in the main repo
3. **Package and verify** - Run `npm run package` and verify the bundled content is correct

### When Making Instruction Changes

| Change Type             | Approach                                          |
| ----------------------- | ------------------------------------------------- |
| Bug fix in instructions | Commit to rebel-system, update submodule, release app |
| New feature docs        | Include in next scheduled release |
| Policy updates          | Batch with other changes, release when convenient |

### Testing Checklist

Before releasing:

- [ ] Tested with current app version in dev mode
- [ ] Verified all markdown renders correctly
- [ ] Checked that agent behavior matches expectations
- [ ] Reviewed any policy/privacy implications
- [ ] Confirmed no sensitive information in instructions
- [ ] Ran `npm run package` and verified rebel-system is in Resources

## Contributor Sync Workflow

### Initial Setup (New Clone)

```bash
git clone <repo>
cd rebel-app
git submodule update --init --recursive
```

For normal contributor work, do **not** use `git submodule update --remote` as your routine workflow — it can silently discard local submodule work. The canonical instructions now live in:

- [`../../AGENTS.md`](../../AGENTS.md) — repo-wide git/submodule policy, detached-HEAD hazards, and commit guidance
- [`../../.factory/commands/git-safe-sync-and-push.md`](../../.factory/commands/git-safe-sync-and-push.md) — step-by-step instructions for `npx tsx scripts/git-safe-sync.ts`

Use the safe-sync command from the repo root when you need to refresh the superproject and submodules together:

```bash
npx tsx scripts/git-safe-sync.ts --no-push
```

If you are actively editing `rebel-system/` itself, commit/push that submodule work on its own branch first (usually `main` inside the submodule), then follow the canonical safe-sync instructions above to carry the updated pointer in the superproject. This doc deliberately does not duplicate the full git workflow — `AGENTS.md` and the command doc are the single sources of truth.

## Related Documentation

- [REBEL_SYSTEM_FILES](./REBEL_SYSTEM_FILES.md) - User vs developer doc audiences, rebel-system structure, and guidelines for writing help-for-humans docs
- [Git Submodules Tutorial](../tutorials/251212a_git_submodules_explainer.html) - Comprehensive guide to Git submodules
- [Settings Configuration](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - Storage locations and runtime behavior
- [BUILD_AND_RELEASE_OVERVIEW](./BUILD_AND_RELEASE_OVERVIEW.md) - Hub for all build/release docs
- [RELEASING](./RELEASING.md) - Step-by-step release runbook
- [CI_PIPELINE](./CI_PIPELINE.md) - CI pipeline behavior
- [../../AGENTS.md](../../AGENTS.md) - Canonical contributor workflow, git safety rules, and submodule guidance
- [../../.factory/commands/git-safe-sync-and-push.md](../../.factory/commands/git-safe-sync-and-push.md) - Canonical safe-sync command reference
