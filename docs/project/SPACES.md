---
description: "Spaces architecture reference — README frontmatter, settings metadata, space types, organisation grouping, agent context"
last_updated: "2026-05-29"
---

# Spaces

Spaces are user-defined areas within the Rebel workspace for organizing information by context (personal, work, project). They enable Rebel to route memories and files appropriately and provide the agent with context about where to store or retrieve information.

This document covers the spaces architecture, data model, and implementation details.

## See Also

- [ARCHITECTURE_DATA_STRUCTURES](ARCHITECTURE_DATA_STRUCTURES.md) - Core types including `SpaceConfig`, `SpaceType`
- [ELECTRON_STORAGE_REFERENCE](ELECTRON_STORAGE_REFERENCE.md) - Where settings are stored on disk
- [SYSTEM_PROMPT](SYSTEM_PROMPT.md) - How spaces are exposed to the agent via env context
- [LIBRARY_AND_FILE_ACCESS](LIBRARY_AND_FILE_ACCESS.md) - Workspace selection and file access
- [UI_NAVIGATION](UI_NAVIGATION.md) - Navigation to settings sections including Spaces
- [260105_mcp_email_field.md](../plans/finished/260105_mcp_email_field.md) - Planned: `emails` frontmatter for MCP-Space association (Stage B5)

## Principles

1. **Hybrid source of truth**: Operational data (path, symlink info) lives in app settings; semantic data (description, type, sharing) lives in README.md frontmatter
2. **Frontmatter takes precedence**: When both settings and frontmatter define a value, frontmatter wins. Corollary: never *infer* user-visible sharing or trust attributes from path patterns or filesystem properties — if not declared in frontmatter, leave them absent
3. **Backwards compatibility**: Spaces system supports legacy `googleDriveLinks` for migration
4. **Signpost, don't duplicate**: Types are defined in code (`src/shared/types.ts`), not repeated here

## Concepts

| Term | Definition |
|------|------------|
| **Space** | A folder in the workspace containing related information |
| **Space root** | The folder path (e.g., `work/AcmeConsulting`) |
| **Chief-of-Staff** | Built-in router space that always exists |
| **Symlinked space** | Space pointing to external storage (Google Drive, iCloud, etc.) |
| **Storage provider** | The cloud service for a symlinked space |

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Renderer Process                          │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │     SpacesManager.tsx (Settings UI)                      │   │
│   │     - Lists spaces by type (Chief-of-Staff/Personal/Work)│   │
│   │     - Edit descriptions and space metadata               │   │
│   └──────────────────────────────────────────────────────────┘   │
└───────────────────────────┬──────────────────────────────────────┘
                            │ IPC (library:scan-spaces, etc.)
┌───────────────────────────▼──────────────────────────────────────┐
│                         Main Process                             │
│   ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│   │  spaceService.ts    │    │      mcpService.ts              │ │
│   │  - scanSpaces()     │    │  - buildSpaceSummaries()        │ │
│   │  - createSpace()    │    │  - Populates system prompt      │ │
│   └─────────────────────┘    └─────────────────────────────────┘ │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│                      Workspace on Disk                           │
│   ~/Documents/Rebel/                                             │
│   ├── Chief-of-Staff/README.md (frontmatter)                     │
│   ├── personal/README.md                                         │
│   └── work/                                                      │
│       └── AcmeConsulting/README.md                                    │
└──────────────────────────────────────────────────────────────────┘
```

## Where Data Lives

### README.md Frontmatter (Semantic Metadata)

Located in the space root folder. Contains semantic metadata that describes the space's purpose.

```yaml
---
rebel_space_description: "Client projects and deliverables for AcmeConsulting"
space_type: company
sharing: private
---
# AcmeConsulting

This space contains...
```

**Fields:**
- `rebel_space_description` (required) - Human-readable description; presence of this field identifies the folder as a Rebel space
- `space_type` (optional) - Category (see Space Types below)
- `sharing` (optional) - Access level (see Sharing Levels below). Used for display/context and as input to memory safety (e.g., non-private spaces enforce a "balanced" safety floor). See [MEMORY_SAFETY.md](MEMORY_SAFETY.md).
- `sensitivity` (optional) - Data sensitivity (`standard`, `confidential`, `restricted`)
- `related_spaces` (optional) - Array of related space paths
- `owner` (optional) - Email of space owner
- `emails` (optional) - Shared account hints for MCP matching. Accepts exact emails (`[external-email]`) or domain wildcards (`acme.com` - bare domain without @). User-local account binding lives in `SpaceConfig.associatedAccounts`; do not write a user's private exact account here from the wizard. See [260105_mcp_email_field.md](../plans/finished/260105_mcp_email_field.md) Stage B5 for historical context.
- `organisation_name` (optional) - Which organisation this space belongs to (e.g., `Mindstone`, `Acme Corp`). Used by the agent for `<spaces_available>` grouping and by the UI for Settings → Spaces organisation grouping. See [Organisation Grouping](#organisation-grouping) below. **The agent cannot write this field** — only the user can set it via the UI wizard or Settings → Spaces.

**Removed fields:**
- `memoryTrust` - **Deprecated and removed.** Memory safety is now controlled via per-space settings stored locally in `AppSettings.spaceSafetyLevels`. See [MEMORY_SAFETY.md](MEMORY_SAFETY.md) for details. This field is ignored if present in README.md.

Legacy support: If `README.md` doesn't exist, `AGENTS.md` is checked as fallback.

### App Settings (Operational Data)

Stored in `app-settings.json` via `AppSettings.spaces[]`. Contains operational config.

```typescript
interface SpaceConfig {
  name: string;              // Display name
  path: string;              // Relative path within workspace
  isSymlink: boolean;        // Whether this is a symlink
  sourcePath?: string;       // Absolute path for symlinks
  storageProvider?: SpaceStorageProvider;
  type?: SpaceType;          // Default type if frontmatter missing
  sharing?: SpaceSharingLevel;
  description?: string;      // Default if frontmatter missing
  companyName?: string;      // For work spaces
  createdAt?: number;
}
```

**Note:** Memory safety is controlled via `AppSettings.spaceSafetyLevels` (a separate setting), not in `SpaceConfig`. See [MEMORY_SAFETY.md](MEMORY_SAFETY.md).

## Space Types

| Type | Usage |
|------|-------|
| `chief-of-staff` | Built-in router space (always exists) |
| `personal` | Private user content |
| `company` | Company-level information (e.g., `work/AcmeConsulting`) |
| `team` | Team-shared content |
| `project` | Project-specific content |
| `other` | Catch-all for unclassified spaces |

**UI Grouping:**
- Chief of Staff: Always first
- Personal: `type === 'personal'`
- Work: `type` is `company`, `team`, or `project`
- Other: Everything else

## Sharing Levels

| Level | Meaning | Icon |
|-------|---------|------|
| `private` | Only the user | Lock |
| `team` | Shared with team | Users |
| `company-wide` | Visible to entire company | Building2 |
| `public` | Publicly accessible | Globe |

Note: Sharing levels are currently metadata for agent context. They don't enforce access control.

## Hybrid Source-of-Truth Model

Data is split between README.md frontmatter and app settings:

| Data | Primary Source | Fallback |
|------|----------------|----------|
| Description | README frontmatter (`rebel_space_description`) | `SpaceConfig.description` |
| Type | README frontmatter (`space_type`) | `SpaceConfig.type` |
| Sharing | README frontmatter (`sharing`) | `SpaceConfig.sharing` |
| Path | Settings (`SpaceConfig.path`) | N/A |
| Symlink info | Settings (`isSymlink`, `sourcePath`) | N/A |
| Associated Accounts | Settings (`SpaceConfig.associatedAccounts`) | README frontmatter `emails` only when the local field is `undefined` |
| Memory safety | Settings (`AppSettings.spaceSafetyLevels`) | N/A (defaults to `balanced`) |

**Precedence rules:**

- `SpaceConfig.associatedAccounts === undefined` means the user has not made a local account-binding decision, so prompt summaries keep legacy README `emails` behavior.
- `SpaceConfig.associatedAccounts` defined, including `[]`, means the local decision wins. Prompt summaries use local entries plus README bare-domain hints such as `acmecorp.com`, filtering README exact emails so a shared space cannot bind to a colleague's account.
1. For shared metadata fields (description, type, sharing, organisation), frontmatter values override settings values.
2. If frontmatter is missing, fall back to settings.
3. If both are missing, use sensible defaults.

## Storage Providers

For symlinked spaces pointing to external storage:

| Provider | Value |
|----------|-------|
| Google Drive | `google_drive` |
| OneDrive | `onedrive` |
| Dropbox | `dropbox` |
| Box | `box` |
| iCloud | `icloud` |
| Local | `local` |
| Other | `other` |

## Path Validation: validateSpacePath()

**Location:** `src/main/services/spaceService.ts`

Security function that validates and resolves space paths before any filesystem operation.

**Purpose:**
- Prevents path traversal attacks (e.g., `../../../etc/passwd`)
- Ensures all space operations stay within the workspace boundary
- Normalizes paths for consistent handling

**Behavior:**
1. Validates that `workspacePath` and `spacePath` are provided
2. Resolves the absolute path
3. Verifies the resolved path is within the workspace root
4. Returns the safe, resolved absolute path

**Throws:** Error if path is invalid, empty, or attempts to escape workspace.

## Space Discovery: scanSpaces()

**Location:** `src/main/services/spaceService.ts`

Discovers spaces within the workspace by scanning directories.

**Algorithm:**
1. Always include `Chief-of-Staff/` (required)
2. Scan `personal/` if it exists
3. Scan `work/[Company]/` directories:
   - If company directory has README.md **with frontmatter** → company IS a space
   - If company directory has no frontmatter → company is a container, scan children
4. For each candidate, read README.md frontmatter for type/sharing/description
5. Detect symlinks and resolve source paths

**Key behavior (bug fix 2025-12-27):**
- Previously, all subdirectories under `work/[Company]/` were treated as space candidates
- Now, if `work/[Company]/README.md` has valid frontmatter, the company itself is the space and children are NOT scanned as separate spaces
- This prevents false positives like `work/AcmeConsulting/memory` appearing as a separate space

**Output:** Array of `SpaceInfo` objects.

## Space Summaries: buildSpaceSummaries()

**Location:** `src/main/services/mcpService.ts`

Builds space summaries for the system prompt env context.

**Behavior:**
1. Always includes `Chief-of-Staff` as first entry
2. Checks `settings.spaces !== undefined` (not just `length > 0`):
   - `undefined` → not migrated, fall back to `googleDriveLinks`
   - `[]` → user explicitly has no spaces, don't use fallback
3. For each space, reads frontmatter to override description/type/sharing
4. Normalizes paths (adds trailing slash) for consistent matching

**Key behavior (bug fix 2025-12-27):**
- Changed from checking `configuredSpaces.length > 0` to `settings.spaces !== undefined`
- This prevents "ghost spaces" from `googleDriveLinks` resurrecting when user explicitly clears spaces

## Space Removal: removeSpace()

**Location:** `src/main/services/spaceService.ts`

Removes a space from the workspace.

**Behavior:**
1. Validates the path using `validateSpacePath()` (security)
2. Rejects attempts to remove Chief-of-Staff (using resolved path to prevent bypass)
3. Checks if path exists (missing path treated as success for idempotency)
4. Honors `removeSymlinkOnly` mode:
   - `true`: remove symlink/junction entries only; reject regular folders
   - `false`: allow deleting regular workspace folders (recursive) or removing symlink entries

**IPC Channel:** `library:remove-space`

**Key behavior (2025-12-28):**
- Settings auto-reconciliation: After removal, `reconcileSpacesWithSettings()` syncs `settings.spaces[]` with actual disk state
- This prevents "ghost spaces" where settings reference paths that no longer exist
- Windows junction handling: Falls back from `unlink()` to `rmdir()` on EPERM

**UI semantics:** Library cards now label actions by mode:
- **Remove space…** (symlink/junction) — non-destructive, removes only the Rebel link
- **Delete space…** (regular folder) — destructive, deletes the workspace folder content after explicit confirmation

## Space Relocation: moveSpace()

**Location:** `src/main/services/spaceService.ts`

Moves a space folder to a location outside the workspace. For non-symlink spaces that users want to "remove" from the workspace.

**Behavior:**
1. Validates the source path using `validateSpacePath()` (security)
2. Rejects attempts to move Chief-of-Staff
3. Rejects symlinks (use `removeSpace()` for those)
4. Verifies destination is outside the workspace
5. Checks destination doesn't already have a folder with the same name
6. Moves the folder (with cross-device copy fallback)

**IPC Channel:** `library:move-space`

**Cross-device handling:**
- First attempts `fs.rename()` (fast, same filesystem)
- On EXDEV error (cross-device), falls back to copy-then-delete
- Returns `wasCrossDevice: true` in response when fallback was used

**UI Flow (SpacesManager.tsx):**
1. User clicks "Move Out" on a workspace folder space
2. Confirmation dialog explains the move operation
3. OS folder picker opens for destination selection
4. Folder is moved, space is removed from settings

## Settings Reconciliation: reconcileSpacesWithSettings()

**Location:** `src/main/services/spaceService.ts`

Synchronizes `settings.spaces[]` with the actual spaces found on disk. Called after `scanSpaces()`.

**Behavior:**
1. Compares scanned spaces with current settings
2. Adds new spaces found on disk (logs: "Added space 'X' (found on disk)")
3. Removes settings entries for spaces no longer on disk (logs: "Removed space 'Y' (no longer exists)")
4. Preserves user-configured metadata when space still exists

**When called:**
- Every time `library:scan-spaces` IPC is invoked
- This ensures settings stay in sync with filesystem reality

**Key behavior (2025-12-28):**
- Replaces manual settings updates that were previously required after space removal
- Provides audit trail via debug logging

## Implementation References

| Component | Location |
|-----------|----------|
| **Types** | `src/shared/types.ts` (`SpaceConfig`, `SpaceType`, `SpaceSharingLevel`, `SpaceStorageProvider`) |
| **Frontmatter schema** | `src/main/services/promptTemplateService.ts` (`SpaceFrontmatterSchema`) |
| **Path validation** | `src/main/services/spaceService.ts::validateSpacePath()` |
| **Space scanning** | `src/main/services/spaceService.ts::scanSpaces()` |
| **Space removal** | `src/main/services/spaceService.ts::removeSpace()` |
| **Space relocation** | `src/main/services/spaceService.ts::moveSpace()` |
| **Settings sync** | `src/main/services/spaceService.ts::reconcileSpacesWithSettings()` |
| **README merge** | `src/main/services/spaceService.ts::mergeReadmeWithFrontmatter()` |
| **Health check scanning** | `src/main/services/health/checks/spaces.ts` |
| **Prompt summaries** | `src/main/services/mcpService.ts::buildSpaceSummaries()` |
| **IPC channels** | `src/shared/ipc/channels/library.ts` |
| **IPC schemas** | `src/shared/ipc/schemas/library.ts` |
| **Settings UI** | `src/renderer/features/settings/components/SpacesManager.tsx` |
| **Add Space Wizard** | `src/renderer/features/spaces/components/AddSpaceWizard.tsx` |
| **Wizard State Hook** | `src/renderer/features/spaces/hooks/useSpaceWizardState.ts` |
| **Unit tests** | `src/main/services/__tests__/spaceService.test.ts` |
| **Merge tests** | `src/main/services/__tests__/spaceService.mergeReadme.test.ts` |
| **Wizard tests** | `src/renderer/features/spaces/__tests__/useSpaceWizardState.test.ts` |

## Troubleshooting

### Space appears but lacks metadata
- Check that `README.md` exists in the space root
- Verify frontmatter is properly formatted with `---` delimiters

### Subdirectories showing as separate spaces
- Ensure the parent space has `README.md` with valid frontmatter
- Run `scanSpaces()` debug logs to trace detection

### "Ghost spaces" appearing after clearing
- Verify `settings.spaces` is `[]` not `undefined`
- Check that `googleDriveLinks` migration completed

### Symlink not detected
- Verify symlink is valid (not broken)
- Check that `sourcePath` resolves to existing directory

## Add Space Wizard

The Add Space Wizard provides a guided flow for managing spaces. It is available from:

- **Settings → Spaces** via the **Add space** button
- **Library (`Show: Spaces`)** via the `+` action, which deep-links into Settings and queues a typed pending action so the wizard opens as soon as `SpacesManager` mounts
- **Onboarding**

### Wizard Modes

The wizard supports three modes:

| Mode | Usage | Steps Shown | Metadata Behavior |
|------|-------|-------------|-------------------|
| `create` | New folder without existing frontmatter | Location → About | Full editing, writes frontmatter |
| `edit` | Existing space user already has | About only | Shared metadata updates frontmatter; Associated Accounts updates local settings |
| `add-existing` | Folder with existing README frontmatter | About only | Shared metadata read-only unless unlocked; Associated Accounts stays editable and local |

**Mode Detection:**
- `create` mode: Default when opening the wizard via "Add space" button
- `edit` mode: When editing an existing space from the space card
- `add-existing` mode: Auto-detected when selected folder has README.md with `rebel_space_description` frontmatter; also used when adding suggested spaces

### Wizard Flow

**Step 1: Location** (create mode only)
- Choose folder: Opens system folder picker
- Symlink detection: Identifies if selected folder is a symbolic link
- Storage provider detection: Auto-detects cloud storage (Google Drive, iCloud, OneDrive, etc.)
- Subfolder creation: Option to create standard folders (memory, skills, scripts) in symlinked folders
- **Frontmatter detection**: If selected folder has README.md with `rebel_space_description`, switches to `add-existing` mode

**Step 2: About**
- Name: Pre-filled from folder name, editable (read-only in edit/add-existing modes)
- Description: AI-generated via Haiku, or extracted from existing README.md
- Storage provider: Read-only display of detected provider
- Category: Personal or Work (inferred from path location)
- Sharing level: Suggested from storage provider (Google Shared Drive → shared)

**Add-existing mode differences:**
- Description, Category, Sharing are **read-only** (shared team data from README.md)
- Associated Accounts defaults to the current user's email when available, otherwise blank. It remains editable because it is local to this user's setup.
- Memory safety can be configured later in Settings → Safety
- Shows info banner: "This folder is already a Rebel space. Setting up your local connection."

### AI Description Generation

When entering Step 2, the wizard calls Haiku to generate a description:
1. Samples up to 200 files/folders from the directory
2. Reads up to 20K chars of README.md
3. Generates 1-2 sentence description (specific, concrete, no fluff)
4. Falls back to folder name on timeout (10s) or error

User can:
- Edit the generated description
- Click "Regenerate" to retry AI generation
- Enter their own description manually

### Storage Provider Detection

The wizard auto-detects storage provider from path patterns:

| Pattern (macOS) | Pattern (Windows) | Provider |
|-----------------|-------------------|----------|
| `/Library/CloudStorage/GoogleDrive-*/` | `/Google Drive/` | `google_drive` |
| `/Library/Mobile Documents/com~apple~CloudDocs/` | `/iCloudDrive/` | `icloud` |
| `/OneDrive*/` or `/OneDrive - */` | `/OneDrive/` | `onedrive` |
| `/Dropbox/` | `/Dropbox/` | `dropbox` |
| `/Box/` | `/Box/` | `box` |
| Other | Other | `local` |

### Symlink Handling

When a symlink is detected:
- Shows badge: "Linked folder" with target path
- Offers checkbox: "Create standard folders" for memory, skills, scripts
- Respects external folder structure (doesn't auto-create subfolders)

### README.md Safe Merge

When creating a space, the wizard handles existing README.md files:
1. **No README.md exists**: Creates new file with frontmatter
2. **README.md without frontmatter**: Prepends frontmatter, preserves existing content
3. **README.md with frontmatter**: Merges fields, space fields take precedence, preserves user's custom fields and body

The body content of existing README.md files is never deleted or overwritten.

## Add Space Wizard: IPC Channels

The wizard uses these IPC channels for backend operations:

| Channel | Purpose |
|---------|---------|
| `library:analyze-path` | Detects storage provider, infers sharing/category from path, detects existing frontmatter |
| `library:generate-space-description` | AI-generates description via Haiku |
| `library:check-symlink` | Checks if path is a symbolic link |
| `library:create-subfolders` | Creates multiple subfolders with path validation |
| `library:create-space` | Creates the space symlink and writes frontmatter |

**Channel Details:**

`library:analyze-path`:
- Input: Absolute path
- Output: `{ storageProvider, inferredSharing, inferredCategory, validationIssues?, isValid?, hasExistingFrontmatter?, existingFrontmatter?, error? }`
- Always returns all three inferred fields; `error` is optional (set on permission/access issues)
- Handles ENOENT, EACCES, EPERM errors gracefully
- **Path validation (2025-12-28)**: Returns `validationIssues` array with type, severity, message, and suggestion. Validates against dangerous paths (root, home, system folders), already-managed paths (Chief-of-Staff, existing spaces), and structural issues. `isValid=false` blocks wizard progression.
- **Frontmatter detection (2025-12-29)**: If the path contains README.md with `rebel_space_description` frontmatter, returns `hasExistingFrontmatter: true` and `existingFrontmatter` object with description, space_type, and sharing. Used to auto-switch wizard to `add-existing` mode.

`library:generate-space-description`:
- Input: Absolute path
- Output: `{ description, source: 'haiku' | 'fallback', status: 'success' | 'timeout' | 'error' }`
- Note: `'readme'` source is reserved for future use (direct README extraction); currently always returns `'haiku'` even when README content informs the generation
- 10-second timeout with fallback to folder name

`library:check-symlink`:
- Input: Absolute path
- Output: `{ isSymlink: boolean, target?: string }`

`library:create-subfolders`:
- Input: `{ basePath, subfolders: string[] }`
- Output: `{ created: string[], errors: { path, error }[] }`
- Path traversal prevention (validates resolved path stays within basePath)
- Idempotent: existing directories counted as success
- Note: Currently the UI collects subfolder preferences but wiring to this IPC is pending

`library:create-space`:
- Input: `CreateSpaceOptions` object with path, name, description, type, sharing, storageProvider, and optional `skipFrontmatterWrite`
- Output: `{ success: boolean, space?: SpaceInfo, error?: string }`
- Creates symlink from workspace to source folder
- Writes README.md frontmatter (unless `skipFrontmatterWrite: true`)
- **skipFrontmatterWrite flag (2025-12-29)**: When `true`, skips writing frontmatter to README.md. Used in `add-existing` mode to preserve shared team frontmatter while still creating the local space configuration.
- Persists `associatedAccounts` to `settings.spaces[]` when provided. This is per-user settings data and intentionally syncs with the user's cloud settings.

## Add Space Wizard: Component Architecture

The wizard components live in `src/renderer/features/spaces/`:

```
src/renderer/features/spaces/
├── index.ts                 # Feature exports
├── components/
│   ├── AddSpaceWizard.tsx   # Main dialog component
│   ├── AddSpaceWizard.module.css
│   ├── LocationStep.tsx     # Step 1: folder selection
│   └── AboutStep.tsx        # Step 2: metadata form
└── hooks/
    └── useSpaceWizardState.ts # State management hook
```

### AddSpaceWizard Component

Main dialog component with three modes:
- `mode: 'create'` - Full 2-step flow for new spaces
- `mode: 'edit'` - Step 2 only for editing metadata (path changes require remove/re-add)
- `mode: 'add-existing'` - Step 2 only for adding a folder that already has frontmatter (used by Suggest Spaces)

Props:
```typescript
interface AddSpaceWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (space: CreateSpaceOptions) => void;
  onCancel: () => void;
  mode?: 'create' | 'edit' | 'add-existing';
  existingSpace?: SpaceInfo;  // Used by both edit and add-existing modes
  defaultCompanyName?: string;
  defaultUserEmail?: string | null; // Used to seed local Associated Accounts
}
```

### useSpaceWizardState Hook

State management hook returning `{ state, actions }` pattern:

**State:**
- `step: 'location' | 'about'` - Current wizard step
- `path`, `pathError` - Selected folder path and validation
- `isAnalyzing` - Path analysis in progress
- `name`, `description`, `descriptionSource`, `descriptionLoading` - Form fields
- `storageProvider`, `sharing`, `category`, `companyName` - Inferred values
- `isSymlink`, `symlinkTarget` - Symlink detection
- `createSubfolders`, `selectedSubfolders` - Subfolder options

**Actions:**
- `setPath(path)` - Sets path and triggers analyze-path + check-symlink IPC
- `generateDescription()` - Triggers generate-space-description IPC
- `setStep(step)` - Navigate between steps
- `updateField(field, value)` - Update any form field
- `reset()` - Reset to initial state

### Integration

SpacesManager.tsx imports and renders the wizard:
```typescript
import { AddSpaceWizard } from '@renderer/features/spaces';

// In render
<AddSpaceWizard
  open={showAddSpaceWizard}
  onOpenChange={setShowAddSpaceWizard}
  onComplete={handleAddSpaceComplete}
  onCancel={handleAddSpaceCancel}
  defaultCompanyName={defaultCompanyName}
/>
```

## Edit Space Wizard

The Edit Space Wizard allows users to modify metadata for existing spaces. It reuses the AddSpaceWizard component in `mode='edit'`.

### Accessing the Edit Wizard

From **Settings > Spaces**, click the **Edit** button on any space card. The wizard opens directly to the About step (skipping Location, since the path cannot be changed).

### What Can Be Edited

| Field | Editable | Notes |
|-------|----------|-------|
| Name | No | Reflects folder name on disk |
| Description | Yes | AI-generated or manual; saved to README.md frontmatter |
| Category | Yes | Personal / Work |
| Sharing | Yes | Private / Team / Company-wide |
| Associated Accounts | Yes | Saved to local `settings.spaces[].associatedAccounts`, not README frontmatter |

**Note:** Memory safety is configured in Settings → Safety, not per-space editing. To change a space's location, remove and re-add it.

### Location Display

In edit mode, the wizard shows:
- The full absolute path to the space folder
- A "Reveal in folder" button to open the containing folder in Finder/Explorer

### Description Regeneration

The "Regenerate" button triggers AI description generation. The prompt includes:

1. **Folder name** - Primary context
2. **Custom subfolders** - Subfolders that aren't standard (memory, skills, scripts)
3. **Standard folders** - Mentioned briefly but de-emphasized
4. **Key indicator files** - Up to 2 files from: `AGENTS.md`, `TODO.md`, `CHANGELOG.md`, `index.md`, `context.md`, `ABOUT.md` (first 1500 chars each)
5. **README.md content** - Up to 4K chars if key files present, otherwise 20K chars

The prompt instructs Haiku to focus on what makes the space unique, avoiding generic descriptions like "Contains memory/, skills/, scripts/".

**Implementation:** `buildDescriptionPrompt()` in `src/main/ipc/libraryHandlers.ts`

### Saving Changes

When saving shared metadata, the wizard calls `library:update-space-frontmatter` to write changes directly to the README.md frontmatter, preserving any existing body content. Associated Accounts are saved to local `settings.spaces[].associatedAccounts` instead of README frontmatter.

## Onboarding Integration

The Add Space Wizard is integrated into the onboarding flow's "Spaces & Shared Folders" step. This provides a unified experience for creating spaces regardless of entry point.

### How It Works

1. During onboarding Step 2, users click "Add Space" to open the wizard as a dialog
2. The wizard operates in `create` or `add-existing` mode (no edit during onboarding)
3. Spaces are created **immediately** when the wizard completes (not batched on Continue)
4. Connected spaces appear in a list within the onboarding step
5. Users can remove spaces before continuing

### State Management

- `useOnboardingFlow` hook maintains `connectedSpaces: SpaceInfo[]`
- This unified state replaced the legacy dual-tracking system (`pendingDriveLinks` + `createdDriveLinks`)
- On wizard open, existing spaces are loaded via `library:scan-spaces`
- On wizard complete, `addConnectedSpace()` updates the local state
- The space is already persisted to settings when created

### Google Drive Guidance

The onboarding step retains Google Drive-specific guidance:
- **Install detection**: Shows whether Google Drive is installed on the system
- **Offline guidance**: Appears if any connected space has `storageProvider === 'google_drive'`

This guidance helps users configure Google Drive for offline access to their shared drives.

## Suggest Spaces Feature

The Suggest Spaces feature (2025-12-29) auto-discovers folders that are configured as spaces but not yet tracked by Rebel.

### How It Works

1. On Settings > Spaces open, `library:suggest-spaces` scans the workspace root
2. Finds root-level directories/symlinks **NOT** covered by `scanSpaces()` (i.e., not Chief-of-Staff, Personal, or work/*)
3. Checks each for README.md with `rebel_space_description` frontmatter
4. Returns matching folders as suggestions

### UI

- Collapsible "Suggested Spaces" section in SpacesManager
- Positioned below existing spaces, above "Add space" button
- Default expanded when suggestions exist
- Each suggestion shows name, path, description, and "Ready to add" indicator
- "Add" button opens AddSpaceWizard in `add-existing` mode

### IPC Channel

`library:suggest-spaces`:
- Input: void
- Output: `{ success: boolean, suggestions: SpaceInfo[], error?: string }`
- Uses `scanSuggestedSpaces()` in spaceService.ts

### Implementation

- `scanSuggestedSpaces()` mirrors `scanSpaces()` structure but scans non-standard locations
- Excludes Chief-of-Staff, Personal, and work directories (case-insensitive)
- Reuses existing frontmatter reading and symlink detection helpers
- Duplicate filtering prevents already-tracked spaces from appearing

## Organisation Grouping

Spaces can be grouped under an **organisation** — a shared label that tells Rebel which company, client, or team a space belongs to. Grouping affects the system prompt's `<spaces_available>` block (spaces with the same organisation are listed together) and the Settings → Spaces UI (spaces with the same organisation are grouped under a heading).

> **User-facing word:** "Company" is the human-facing term used in onboarding and some UI copy. `organisation_name` is the canonical frontmatter field name and the internal concept.

### What an organisation is

An organisation is a tag on a space — it does **not** imply ownership, permissions, or access control. Spaces with the same organisation are peers that happen to share a label; they do not inherit each other's sharing level, memory safety, or tool permissions.

The `company` entity in the entity layer (`docs/project/ENTITY_LAYER.md`) is a **related but separate** concept — it tracks real-world companies as first-class topic entities. It does not own spaces.

### Canonical source of truth

When Rebel needs to determine a space's organisation, it uses a resolution ladder:

| Source | How it contributes |
|---|---|
| `README.md` frontmatter `organisation_name` | **Primary.** If set, this wins. |
| `AppSettings.spaces[*].companyName` (legacy) | **Fallback.** Pre-rollout users who never set `organisation_name` may have this value from onboarding. |
| Neither set | **None.** The space is unorganised. The agent does NOT infer an organisation from the folder path. |

The agent-facing resolver (`resolveOrganisationName` in `mcpService.ts`) returns a discriminated `{ source, value }` where `source ∈ {frontmatter, settings, none}`. **It never consults the filesystem path.** The path heuristic lives only in the UI-side helper `suggestOrganisationFromPath` used for backfill copy suggestions — not for agent resolution.

> **Intent-critical guardrail:** The agent cannot write `organisation_name`. The `rebel_space_update_config` MCP allowlist is `['rebel_space_description', 'emails']` only — `organisation_name` is rejected. This prevents the agent from indirectly conferring organisation membership by creating a space at `work/Mindstone/...`. See [Intent-critical Decision #1 in the planning doc](../plans/260511_spaces_organisation_grouping.md#intent-critical-decisions-carried-forward).

### Grouping key

UI and agent surfaces group spaces using `canonicalOrganisationKey(value)` which normalises (trim + NFKC Unicode normalisation + lowercase + collapse internal whitespace). This means `"Mindstone"`, `"mindstone"`, `"Mindstone "`, and `"Mindstone\u00a0Inc"` all group under the same key. Display always uses the first-seen raw `organisation_name` casing.

### `{COMPANY_NAME}` resolution

Chief-of-Staff skills that reference `{COMPANY_NAME}` resolve it at agent runtime from the `<spaces_available>` block — not at template render time (skills can load outside any single-space context, making template-time substitution fragile). The resolution rule is locked in `rebel-system/help-for-humans/variables-and-user-info.md` and the Chief-of-Staff template:

1. **Tool-targeted space first:** if the skill is invoked via a tool call targeting a specific space, and that space's `organisation` is set in `<spaces_available>`, resolve to that.
2. **Single-org Chief-of-Staff context:** else if the Chief-of-Staff `<spaces_available>` has exactly one organisation grouping, resolve to that.
3. **Ask the user:** else ask explicitly, enumerating available organisations. Never infer from path, file content, or message history.

### Writes

Only the user can set or change a space's organisation:

- **UI path:** Settings → Spaces → "Set organisation" per-card action, or the Add/Edit Space wizard's About step.
- **IPC channel:** `library:update-space-frontmatter` accepts `organisation_name` on the UI write path only.
- **Agent path:** `rebel_space_update_config` (the MCP `update_config` tool) is explicitly **not** allowlisted for `organisation_name`. The server-side allowlist in `bundledInboxBridge.ts` is `['rebel_space_description', 'emails']`.

### Migration story

`AppSettings.companyName` and `SpaceConfig.companyName` are `@deprecated` but still functional as backwards-compat fallback readers. They are **not** the canonical source of truth — `organisation_name` is. No removal is planned until a future release after the deprecation period. See [Stage 9 in the planning doc](../plans/260511_spaces_organisation_grouping.md) for the full deprecation rationale.

Onboarding still writes `companyName` to `AppSettings` (this is intentional — the value seeds the `work/<Company>/...` folder path during first-run). Onboarding also seeds `organisation_name` on the first-created work space's README frontmatter.

### Failure modes

Key failure modes and mitigations are documented in the [Failure Mode Matrix in the planning doc](../plans/260511_spaces_organisation_grouping.md#failure-mode-matrix). Notable ones:

| Scenario | Behaviour |
|---|---|
| Space with no organisation set | Appears under "**No organisation set**" in Settings → Spaces; no `organisation:` line in `<spaces_available>`; agent must NOT invent ownership |
| Casing variant collision (`"Mindstone"` vs `"mindstone"`) | Groups on canonical key; displays first-seen raw casing |
| Onboarding split-write failure (settings succeeds, frontmatter seed fails) | Non-blocking toast: "We saved your settings but couldn't tag the first space's organisation. You can set it in Settings → Spaces." |
| Agent creates space at `work/<Org>/...` without frontmatter | Agent prompt shows space WITHOUT `organisation: <Org>` — path does not confer membership |
| Multi-window staleness | Frontmatter writes emit `library:changed` broadcast; window B re-scans on next Spaces open |

### Related postmortems

The following postmortems are directly relevant to the spaces grouping architecture and must be read before modifying the resolver, write-safety, or grouping logic:

- [`260415_safety_prompt_cache_key_cross_space_stale_decision_postmortem.md`](../../docs-private/postmortems/260415_safety_prompt_cache_key_cross_space_stale_decision_postmortem.md) — privacy boundary across shared spaces
- [`260415_safety_staging_fail_open_shared_spaces_postmortem.md`](../../docs-private/postmortems/260415_safety_staging_fail_open_shared_spaces_postmortem.md) — sharing level enforcement
- [`260417_library_view_skill_enoent_symlinked_space_postmortem.md`](../../docs-private/postmortems/260417_library_view_skill_enoent_symlinked_space_postmortem.md) — symlink/path semantics
- [`260425_file_tools_space_symlink_rejected_postmortem.md`](../../docs-private/postmortems/260425_file_tools_space_symlink_rejected_postmortem.md) — file tools symlink handling

### Code signposting

| File | Role |
|---|---|
| `src/main/services/mcpService.ts` (`resolveOrganisationName`, `buildSpaceSummaries`) | Agent-facing resolver — discriminated source, never consults path |
| `src/core/services/spaceOrganisationHeuristics.ts` (`canonicalOrganisationKey`, `suggestOrganisationFromPath`, `groupItemsByOrganisation`) | Grouping helpers; `suggestOrganisationFromPath` is UI-only, not used by agent resolver |
| `src/shared/ipc/channels/library.ts:368-385` (`library:update-space-frontmatter`) | UI write path for `organisation_name`; inline allowlist in the channel schema |
| `src/shared/ipc/schemas/library.ts` (`SpaceInfoSchema`, `CreateSpaceOptionsSchema`) | IPC schemas extended with `organisationName` |
| `src/renderer/features/settings/components/SpacesManager.tsx` | Settings → Spaces grouping UI; per-card "Set organisation" editor |
| `src/renderer/features/settings/components/SpaceCard.tsx` | Non-interactive organisation chip |
| `src/renderer/features/library/components/views/FoldersView.tsx` | Library `Show: Spaces` grouping in `View as: Folders` |
| `src/renderer/features/agent-session/components/TeamKnowledgeIndicator.tsx` | Source list grouping by organisation |
| `src/renderer/features/spaces/components/AddSpaceWizard.tsx` | About step organisation field |
| `src/main/services/bundledInboxBridge.ts:3443-3454` | `rebel_space_update_config` allowlist — blocks `organisation_name` |

### Planning doc

The full implementation log, design rationale, stage breakdown, and intent-critical decisions are in [`docs/plans/260511_spaces_organisation_grouping.md`](../plans/260511_spaces_organisation_grouping.md). This document is the canonical evergreen reference; the planning doc is the implementation archive.

## Future Work

- Phase 2: Rename `type` → `context` for clearer semantics
- Phase 2: Simplify sharing from 4 to 3 values
- Phase 2: Remove deprecated `googleDriveLinks` field
- Sensitivity level (derived from sharing or explicit)
- Onboarding integration: AddSpaceWizard integrated in GoogleDriveStep as "Other cloud storage" option
