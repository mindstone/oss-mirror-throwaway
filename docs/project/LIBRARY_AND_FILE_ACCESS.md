---
description: "Workspace and file-access reference — coreDirectory configuration, path resolution, IPC file operations, and safety boundaries"
last_updated: "2026-06-18"
---

### Introduction

Mindstone Rebel works against a single, user‑selected **workspace directory** (the `coreDirectory`) that acts as the root for all on‑disk work the agent can do.
This document is the **evergreen reference** for how that workspace is configured, how file trees and paths are resolved, which IPC methods expose file operations, and what safety rails apply.


## See Also

- [SYSTEM_ARCHITECTURE](ARCHITECTURE_OVERVIEW.md) - High-level system architecture, component responsibilities, and workspace integration
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - Canonical reference for app settings including coreDirectory configuration
- [MCP_CONFIGURATION](MCP_ARCHITECTURE.md) - MCP configuration file resolution including workspace-relative paths
- [SKILLS_DISCOVERY](SKILLS_DISCOVERY.md) - How skills are discovered from workspace, rebel-system, and spaces
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) - Agent session model and how workspace state relates to sessions
- [UI_LAYOUT_AND_INTERACTION_PATTERNS](UI_OVERVIEW.md) - Workspace drawer UI and file tree interaction patterns
- [IPC_ARCHITECTURE](ARCHITECTURE_IPC.md) - IPC contract system for workspace operations and permissions
- [URL_PROTOCOL](URL_PROTOCOL.md) - Custom URL protocols including canonical `rebel://library/` for file links in messages (plus legacy `library://` / `workspace://` for back-compat)
- [SCRATCHPAD](SCRATCHPAD.md) - Quick-capture notes stored in `Chief-of-Staff/memory/scratchpad.md`
- [LOGGING](LOGGING.md) - Structured logging architecture for debugging file access issues


### Implementation references

- `./SETUP_DEVELOPMENT_ENVIRONMENT.md` – How to get a dev environment running and configure the initial `coreDirectory` via the Settings UI.
- `./VOICE_AND_AUDIO.md` – Voice and permissions model; explains how file‑access checks integrate with voice‑first workflows.
- `../../src/shared/types.ts` – Definitions for `AppSettings` (including `coreDirectory`) and `FileNode`.
- `../../src/main/ipc/libraryHandlers.ts` – Main‑process IPC handlers for `library:*` operations (file CRUD, tree listing, symlinks, skills scanning).
- `../../src/main/ipc/permissionsHandlers.ts` – File‑access permission checks (`permissions:check-file-access`, `permissions:open-system-preferences`).
- `../../src/main/utils/systemUtils.ts` – `resolveLibraryPath`, which enforces that all workspace paths stay within the configured root.
- `../../src/main/services/fileTreeService.ts` – `buildFileTree` implementation used by `library:list-files`.
- `../../src/preload/index.ts` – Typed `window.api` bridge exposing workspace and permission methods to the renderer.
- `../../src/renderer/App.tsx` – Workspace sidebar UI, file editor wiring, and permission banners that consume these APIs.


### Principles and key decisions

- **Single workspace root**: At any given time the app operates on a single `coreDirectory`. All agent runs, file trees, and on‑disk edits are scoped to that directory.  
- **No access outside the workspace**: All on‑disk operations go through `resolveLibraryPath`, which rejects paths that escape the configured workspace root. TODO we may have to provide a user-configurable option to allow access outside it.
- **IPC‑only filesystem access**: The renderer never touches Node’s filesystem APIs directly; it calls a small set of audited IPC handlers in the main process via the preload bridge.  
- **Agent runs are workspace‑scoped**: Agent turns run with `cwd = coreDirectory`, so tools (including MCP servers) see the workspace as their working directory.  
- **Defensive limits for large repos**: File‑tree traversal is deliberately bounded in depth and per‑directory child count to keep the UI responsive even on huge codebases.  
- **Workspace doc as single source of truth**: This file is the canonical reference for workspace and file access behavior; other docs should signpost here rather than re‑describing these details.


### Conceptual model: workspace, paths, and file trees

At a high level there are three related concepts:

- **Workspace root (`coreDirectory`)**  
  - A single directory on disk selected by the user in Settings.  
  - Stored in `AppSettings.coreDirectory` and persisted via `electron-store`.  
  - Used as:
    - The working directory (`cwd`) for Rebel Core agent turns.  
    - The root for all workspace file operations.  
    - The base for resolving some relative config paths (e.g. MCP configs).

- **Workspace paths**  
  - Strings that identify files or directories *within* the workspace.  
  - Can be absolute or relative when passed from the renderer; the main process always resolves them against `coreDirectory`.  
  - Must not escape the workspace root; attempts to access `../` or other parents are rejected.

- **File tree (`FileNode[]`)**  
  - A pruned view of the workspace, used by the workspace sidebar.  
  - Rooted at `coreDirectory` and represented as a tree of:
    - `name: string` – file or folder name.  
    - `path: string` – absolute path on disk.  
    - `kind: 'file' | 'directory'`.  
    - `children?: FileNode[]` – present for directories only.


### Configuring the workspace (`coreDirectory`)

`coreDirectory` is configured via the **Settings** UI:

- **Initial selection**
  - In Settings, choose a directory for the workspace using the “Core workspace directory” picker.  
  - The chosen path is stored as `AppSettings.coreDirectory` and persisted in the `app-settings` store.

- **Path semantics**
  - The setting is stored as a string; the main process resolves it with `path.resolve` whenever it needs a concrete root.  
  - While nothing prevents you from pointing at a parent directory (e.g. your home directory), it is strongly recommended to point at a *project folder* (e.g. a codebase) to keep file trees tractable.

- **When `coreDirectory` is required**
  - **Agent turns**: `executeAgentTurn` refuses to run if `coreDirectory` is not configured, emitting a user‑visible error (“Core directory is not configured.”).  
  - **Workspace IPC**: All `library:*` handlers validate that `coreDirectory` is set before proceeding.  
  - **File‑access checks**: `permissions:check-file-access` reports `hasAccess: false` with `reason: 'no-workspace-configured'` if the setting is missing.

Changing `coreDirectory` effectively moves the workspace root; subsequent agent runs and file operations will operate on the new directory.


### Path resolution and safety (`resolveLibraryPath`)

All workspace paths go through `resolveLibraryPath(target, coreDirectory)` in `systemUtils.ts` before touching the filesystem:

- **Inputs**
  - `target`: string provided by the renderer (may be absolute or relative).  
  - `coreDirectory`: current workspace root from `AppSettings.coreDirectory`.

- **Resolution steps**
  - Throw if `coreDirectory` is `null` or `target` is missing/empty.  
  - Compute `root = path.resolve(coreDirectory)`.  
  - If `target` is absolute and doesn't start with `root`:
    - **Symlink conversion**: Attempt to convert the absolute path to a workspace-relative path by checking if it's accessible through symlinks in the workspace root.
    - **Fake-absolute fallback**: If symlink conversion fails and the path starts with `/` (Unix-style) but doesn't exist on the filesystem, try stripping the leading slash(es) and treating it as workspace-relative. This handles cases where AI agents incorrectly format paths like `/Chief-of-staff/Memory/file.md` instead of `Chief-of-staff/Memory/file.md`.
  - If `target` is absolute (after conversions), compute `resolved = path.resolve(target)`; otherwise `resolved = path.resolve(root, target)`.  
  - Reject if `resolved` does **not** start with `root` (prevents path escape attacks and accidental cross‑workspace edits).

- **Result**
  - Returns `{ root, resolved }` where both are absolute, normalized paths.  
  - The `root` is reused in some IPC handlers to double‑check that newly constructed paths (e.g. after renames) still reside within the workspace.

If any of these checks fail, IPC handlers throw user‑friendly errors such as:

- “Core directory is not configured.”  
- “Invalid workspace path.”  
- “Access to paths outside the workspace directory is not permitted.”



### Rebel-system read-only fallback

The `library:read-file` and `library:read-file-base64` handlers have a narrow fallback for paths prefixed with `rebel-system/`. When `resolveLibraryPath` resolves a workspace path that does not exist on disk (ENOENT) **and** the original target starts with `rebel-system/`, the handler re-resolves the path against the bundled rebel-system directory (`getSystemSettingsPath()`).

- **Why:** The workspace `rebel-system` symlink (or Windows junction) may be broken or not yet created. This fallback ensures agent-referenced system files (skills, memory templates, help docs) remain readable regardless of symlink health.
- **Security:** The fallback path is validated with `isPathInsideLexical(fallbackPath, systemSettingsPath)` to prevent path-traversal attacks. Only read operations are affected — writes, deletes, creates, and any non-`rebel-system/` paths are **not** covered by the fallback and continue to use `resolveLibraryPath` exclusively.
- **Scope:** Only the two read handlers (`library:read-file`, `library:read-file-base64`). No other `library:*` channel gets the fallback.
- **Non-ENOENT errors:** Errors like EACCES or EPERM on the workspace path are **not** caught by the fallback — they propagate as normal.
- **Code:** `resolveRebelSystemFallback()` in `src/main/ipc/libraryHandlers.ts`.


### Workspace-escape salvage (read-only)

`library:read-file` and `library:read-file-base64` also include a read-only fallback for malformed relative links that escape the workspace only because they have too many leading `../` segments (for example, historical transcript image links).

- **How it works:** `resolveWorkspaceEscapeSalvage()` strips only leading literal `..` segments, resolves the remaining tail against `coreDirectory`, and then re-validates with `isPathInsideLexical`.
- **Safety gates:** The helper rejects dangerous path forms via `rejectDangerousPath` (NUL, URL-scheme prefixes, Windows device/UNC/drive-letter forms, overlong paths), does **not** pre-normalize with `path.normalize`, and returns `null` when the salvaged candidate still escapes.
- **Existence + type check:** The candidate must already exist and be a regular file (`fs.stat().isFile() === true`). Missing paths (`ENOENT` / `ENOTDIR`) return `null`; unexpected I/O failures bubble up.
- **Concurrency envelope:** Salvage `stat` runs inside the same library-read slot + EMFILE retry envelope as normal reads.
- **Scope:** Read handlers only (`library:read-file`, `library:read-file-base64`). Write/create/delete handlers are unchanged and remain fail-closed on workspace escape.
- **Symlink model:** This preserves the existing "workspace symlinks are trusted" behavior documented in `docs/plans/finished/260117_Path_Traversal_Security_Fix.md` (no new symlink behavior is introduced by salvage).


### Intent & Design Rationale (workspace-escape salvage)

> This section explains **why** each design decision was made. For **what** the salvage does, see the section above.

**Why read-only with mandatory gates.** The salvage is intentionally scoped to read handlers only — write handlers must never receive a salvaged path. The security invariants from `docs/plans/finished/260117_Path_Traversal_Security_Fix.md` (S1–S10) are frozen, and the regression guard for this constraint is test `T-WS-MAIN-11` in `src/main/ipc/__tests__/libraryHandlers.workspaceEscapeSalvage.test.ts`: a write to `../../../foo.md` must still reject, with no salvage invocation and no `info` log.

**Why a substring-match classifier today.** The renderer's `classifyError` in `MessageMarkdown.tsx` uses `classifyError` substring-matching on `'outside the workspace directory'` rather than typed error codes because main-side error-code enrichment (follow-up I1 in `docs/plans/260422_broken_image_followups_i6_i7.md`) hasn't shipped yet. This is safe because the canonical strings are pinned by the producer-side contract test at `src/main/ipc/__tests__/libraryHandlers.errorMessageContract.test.ts` — any future rename of either error message fails both the producer test and the renderer classifier together, making silent regression impossible. The path to typed codes is tracked in I-NEW-6 of the planning doc.

**Why salvage + prompt-nudge complement I-NEW-3.** The agent-transcript case — the original bug report — has **no** `documentPath` context: the markdown is rendered as quoted agent output, not as a document. So `AutoLoadImage`'s existing `documentPath` prop is unset for transcripts. Salvage covers this case directly; the prompt nudge in `rebel-system/AGENTS.md` prevents future occurrences; and I-NEW-3 (`documentPath` threading through `MessageItem → MessageMarkdown`) covers any other rendering surface where the prop could be derived. The three are complementary, not redundant.

**Sunset criterion (I-NEW-7).** Re-evaluate removing the salvage 6 months after Stage 3 ships **and** once telemetry shows < 0.5% of image loads triggering the salvage path. Without this trigger, the salvage becomes permanent ambient complexity with ongoing maintenance cost. The planning doc is at `docs/plans/260503_library_read_relative_path_escape_salvage.md`.


### File tree construction (`library:list-files`)

The workspace sidebar’s tree view is built by:

- **IPC handler (`src/main/index.ts`)**
  - Channel: `library:list-files`.  
  - Validates `coreDirectory` is set, resolves it to `root`, and calls:
    - `buildFileTree(root, root, 0, includeHidden)`.
  - Returns a `FileNode[]` array to the renderer.

- **Traversal implementation (`buildFileTree` in `fileTreeService.ts`)**
  - **Purpose**: Recursively walk directories under `root` and construct a tree of `FileNode`s.  
  - **Depth limit**: Stops recursion once `depth > MAX_FILE_DEPTH` (currently 12).  
  - **Per‑directory limit**: Only processes the first `MAX_CHILDREN_PER_DIRECTORY` entries in each directory (currently 200) to avoid blowing up on large trees.  
  - **Hidden files**:  
    - Skips entries whose names start with `.` when `includeHidden` is `false`.  
    - Includes them only when the caller explicitly sets `includeHidden: true` (toggled by “Show hidden files” in the UI).  
  - **Special directories**: Always skips `node_modules` to keep the tree usable and fast.  
  - **Symlinks and cycles**:
    - Attempts to resolve `fs.realpath(directory)` and tracks visited real paths in a `Set`.  
    - If a directory (or symlink target) has already been visited, recursion stops to avoid cycles.  
  - **Cloud-mount symlinks (RC-1)**:
    - Does not descend into directory symlinks whose resolved target is a cloud-sync mount (Google Drive, iCloud, OneDrive, etc.) — FUSE I/O on those paths can hang the scan indefinitely. The directory node stays visible in the tree (no children). Predicate: `shouldSkipCloudSymlinkTarget()` in `src/core/utils/cloudStorageUtils.ts`; wired in `buildFileTreeInternal` in `src/core/services/workspace/fileTreeService.ts`.
    - All recursive walkers share the same default-on guard via `skipCloudSymlinkTargets` on `safeWalkDirectory()` (`src/core/utils/safeWalkDirectory.ts`). Backup/snapshot collectors that must mirror linked cloud subtrees opt out with `skipCloudSymlinkTargets: false`.
    - Full policy reference: [LIBRARY_SCAN_AND_CLOUD_WORKSPACES.md](LIBRARY_SCAN_AND_CLOUD_WORKSPACES.md).
  - **Bounds to workspace**:
    - Computes `absolutePath = path.resolve(directory, entry.name)` and discards entries where `!absolutePath.startsWith(root)`.
  - **Directory vs file detection**:
    - Uses `Dirent.isDirectory()` when available.  
    - For symlinks, calls `fs.stat` to determine whether the target is a directory.
  - **Sorting**:
    - Directories appear before files.  
    - Within each group, entries are sorted alphabetically by `name`.

- **Renderer usage (`App.tsx`)**
  - Calls `window.api.listWorkspaceFiles({ includeHidden })` to fetch the tree.  
  - Stores it in `workspaceTree` state and renders a collapsible sidebar, with expansion state tracked independently in `expandedDirectories`.  
  - Only the visible subtree is rendered at any given time, helping with performance.

The key design choice is that the **tree is a convenience view**, not an exhaustive index: very deeply nested or extremely large directories will be pruned according to the above limits.


### Quick Open dialog

The **Quick Open** dialog (`QuickOpenDialog.tsx`) provides fast keyboard-driven file access:

- **Trigger**: `Cmd/Ctrl+O` anywhere in the app, or click the search icon in the header
- **Lens-aware filters**: Everything, Spaces, Skills, Memory — narrow results by Library lens category
- **Search**: Fuzzy file name matching powered by Fuse.js
- **Navigation**: Arrow keys to navigate, Enter to open, Escape to close
- **Destination**: Files open in Document Preview Drawer (for supported text files like .md, .txt, .json) or navigate to Library (for folders and other file types)

See [KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md) for implementation details.

### Library lens create + reveal routing (Stage 5B)

The Library lens toolbar now applies filter-aware create/reveal behavior:

- **Memory (`Show: Memory`) create** starts a fresh chat and seeds the composer draft with `Remember this: `.
- **Spaces (`Show: Spaces`) add** deep-links to Settings → Spaces and queues a typed pending action that opens the Add Space wizard after the settings surface mounts (no `window` custom-event dependency).
- **Reveal routing** classifies targets (`skills`, `memory`, `spaces`, `everything`) and normalizes pending folder paths so absolute and workspace-relative inputs converge on the same tree target.

Implementation signposts:
- `src/renderer/hooks/useLibraryCreateActions.ts`
- `src/renderer/features/library/providers/LibraryNavigatorProvider.tsx`
- `src/renderer/features/library/utils/revealInClassifiedView.ts`
- `src/renderer/features/settings/hooks/useSettingsFeature.ts`


### Accurate file counts (`library:get-stats`)

The workspace header displays an accurate total count of files and directories using a separate API:

- **IPC handler**: `library:get-stats` in `libraryHandlers.ts`.
- **Implementation**: `countWorkspaceItems()` in `fileTreeService.ts` traverses the full workspace without the per-directory limits used by the tree view.
- **Limits**: Depth limit of 50 (effectively unlimited), plus a 1M item safety cap with truncation flag.
- **Filters**: Respects the same filters as the tree (skips `node_modules`, respects hidden files toggle).

This allows the UI to show "51,733 items" while only rendering ~200 per directory in the browsable tree.

**Note**: The "Search index" count shown in the workspace drawer reflects files indexed by the semantic search system (see [SEMANTIC_SEARCH.md](SEMANTIC_SEARCH.md)), which has different criteria (file type, size limits) and may require a "Reindex" to discover newly added files.


### File operations (read, write, create, rename, delete)

All file operations funnel through IPC handlers in the main process and enforce the workspace root safety checks described earlier.

#### Reading files

- **IPC handler**: `library:read-file` in `index.ts`.  
- **Preconditions**:
  - `coreDirectory` must be configured.  
  - `target` path argument must be a non‑empty string.  
  - `resolveLibraryPath(target, coreDirectory)` must succeed.  
  - `fs.stat(resolved)` must indicate a regular file.
- **Behavior**:
  - Reads the file as UTF‑8.  
  - Returns `{ path: resolved, content, updatedAt: stat.mtimeMs }`.  
  - Logs and converts low‑level errors into user‑friendly messages like “Unable to read the selected file.”

#### Writing files

- **IPC handler**: `library:write-file`.  
- **Payload**: `{ path: string; content: string }`.  
- **Preconditions**:
  - Valid payload with a non‑empty `path`.  
  - `coreDirectory` configured.  
  - `resolveLibraryPath(path, coreDirectory)` passes.
- **Behavior**:
  - Writes `content` as UTF‑8 to the resolved path (creating or overwriting).  
  - Reads file `stat` afterwards and returns `{ path: resolved, updatedAt: stat.mtimeMs }`.  
- **Typical use**:
  - The renderer tracks `WorkspaceDocumentState` including `originalContent`, `content`, and `updatedAt`, and uses `writeWorkspaceFile` to persist edits.

#### Creating files and folders

- **IPC handlers**:
  - `library:create-file` with payload `{ parentPath?: string; fileName: string }`.  
  - `library:create-folder` with payload `{ parentPath?: string; folderName: string }`.

- **Shared behavior**:
  - Validate that a `coreDirectory` is configured.  
  - Trim and validate the name (must be non‑empty).  
  - Resolve the intended parent:
    - When `parentPath` is provided, resolve it via `resolveLibraryPath`.  
    - If `parentPath` points at a file, its directory is used as the parent.  
    - When `parentPath` is omitted, the workspace root is used.
  - Construct the target path with `path.resolve(parentDir, name)`.  
  - Reject the operation if `!targetPath.startsWith(root)` (ensuring we stay under the workspace).  
  - Check for collisions; if anything already exists at `targetPath`, throw “A file or folder with this name already exists.”

- **Differences**:
  - `library:create-file`:
    - Creates an empty file with `fs.writeFile(filePath, '', 'utf8')`.  
    - Logs success and returns `{ path: filePath, name: fileName }`.
  - `library:create-folder`:
    - Uses `fs.mkdir(folderPath, { recursive: false })`.  
    - Logs success and returns `{ path: folderPath, name: folderName }`.

#### Renaming items

- **IPC handler**: `library:rename-item` with payload `{ itemPath: string; newName: string }`.  
- **Preconditions**:
  - Non‑empty `itemPath` and `newName`.  
  - `coreDirectory` configured.  
  - `resolveLibraryPath(itemPath, coreDirectory)` passes, returning `{ resolved: oldPath, root }`.  
  - `newPath = path.resolve(parentDirOfOldPath, newName)` must start with `root`.
- **Behavior**:
  - If `oldPath === newPath`, the handler is a no‑op and returns `{ path: newPath }`.  
  - Validates that nothing exists at `newPath` (throws a collision error if so).  
  - Calls `fs.rename(oldPath, newPath)` and logs success.  
  - Returns `{ path: newPath, name: newName }`.

#### Deleting items

- **IPC handler**: `library:delete-item` with payload `{ itemPath: string }`.  
- **Preconditions**:
  - Non‑empty `itemPath`.  
  - `coreDirectory` configured.  
  - `resolveLibraryPath(itemPath, coreDirectory)` passes, returning `{ resolved: itemPath, root }`.  
  - `itemPath` must start with `root` (double‑check).
- **Behavior**:
  - `fs.stat(itemPath)` determines whether the target is a directory or file.  
  - Directories are deleted via `fs.rm(itemPath, { recursive: true, force: true })`.  
  - Files are deleted via `fs.unlink(itemPath)`.  
  - Logs success and returns `{ success: true }`.  
  - On error, logs details and throws a generic “Unable to delete item.” message for the renderer.



### Document Preview Drawer

> **Canonical reference**: See [UI_CONVERSATIONS](UI_CONVERSATIONS.md) → "Document Preview Drawer" for full documentation of the preview drawer UI, supported file types, and features.

The Document Preview Drawer uses `window.libraryApi.readFile()` to load file content, which goes through the same `resolveLibraryPath` safety checks described above.

### Permissions and platform behavior

Workspace access interacts with OS‑level permissions, especially on macOS where “Full Disk Access” and “Files and Folders” permissions can block access to certain directories.

#### File‑access checks

- **IPC handler**: `permissions:check-file-access`.  
- **Behavior**:
  - Ensures settings are normalized and reads `coreDirectory`.  
  - If `coreDirectory` is missing, returns:
    - `{ hasAccess: false, reason: 'no-workspace-configured' }`.  
  - Otherwise:
    - Resolves `root = path.resolve(coreDirectory)`.  
    - Attempts `fs.access(root, fs.constants.R_OK | fs.constants.W_OK)` followed by `fs.readdir(root)`.  
    - On success, logs and returns `{ hasAccess: true }`.  
    - On failure, logs a warning and returns:
      - `{ hasAccess: false, reason: 'access-denied', errorCode, errorMessage }`, where `errorCode` is typically an OS error code (e.g. `EACCES`).

The renderer uses this to show workspace permission banners and guide the user to fix misconfigured or inaccessible folders.

#### Opening system preferences for files

- **IPC handler**: `permissions:open-system-preferences` with payload `{ type: 'microphone' | 'files' }`.  
- **macOS behavior**:
  - For `type === 'files'`, opens:
    - `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`  
    so the user can grant file access.  
  - Logs success or error and returns `{ success: boolean, reason?: string, error?: string }`.  
- **Non‑macOS**:
  - Logs a warning and returns `{ success: false, reason: 'not-supported' }`.

The renderer can combine `checkFileAccess` with `openSystemPreferences('files')` to provide a clear remediation path when the OS blocks workspace access.


### Interaction with agent turns and MCP

Workspace configuration is tightly coupled to how agent turns and MCP tools are executed:

- **Agent working directory**
  - `executeAgentTurn` sets `options.cwd = settings.coreDirectory` when invoking Rebel Core.  
  - This means:
    - MCP servers launched via `npx` (filesystem, Git, etc.) see the workspace as their current working directory.  
    - Relative paths inside those tools are naturally interpreted relative to the workspace root.

- **System prompts and knowledge worker agent**
  - `resolveSystemPrompt` reads `Chief-of-Staff/README.md` from the workspace, and `synchronizeKnowledgeWorkerAgent` writes a `.claude/agents/knowledge-worker.md` file into the workspace.  
  - These operations rely on `coreDirectory` to determine where to read/write prompt metadata.

- **MCP configuration paths**
  - The Super‑MCP HTTP manager resolves the configured MCP config path relative to `coreDirectory` (or `process.cwd()` if unset).  
  - In general, `mcpConfigFile` paths in settings are interpreted in the context described in `./MCP_ARCHITECTURE.md`, which often uses the workspace root as a base.

In practice, this means that **choosing the right workspace root** is one of the most important steps in configuring Rebel for a project: it shapes agent behavior, MCP tool behavior, and filesystem visibility.


### Gotchas, limitations, and troubleshooting

- **Workspace not configured**
  - Symptoms:
    - Agent runs fail with “Core directory is not configured.”  
    - Workspace sidebar is empty or errors when loading.  
  - Fix:
    - Open Settings and choose a `coreDirectory`.  
    - Run `checkFileAccess` from the UI to verify basic read/write access.

- **OS‑level access denied**
  - Symptoms:
    - `checkFileAccess` returns `hasAccess: false` with `reason: 'access-denied'`.  
    - Agent runs or file operations fail even though the path looks correct.  
  - Fix:
    - On macOS, ensure the app has the necessary “Full Disk Access” or “Files and Folders” permissions, using `openSystemPreferences('files')` if provided by the UI.  
    - Try pointing `coreDirectory` at a path under your home directory (e.g. `~/dev/my-project`) rather than a system folder.

- **Workspace tree truncated or missing directories**
  - Symptoms:
    - Deeply nested directories do not appear in the sidebar.  
    - Very large directories only show the first ~200 entries.  
  - Causes:
    - `buildFileTree` enforces `MAX_FILE_DEPTH` (12) and `MAX_CHILDREN_PER_DIRECTORY` (200).  
  - Fix/Workarounds:
    - Treat the sidebar as a *navigation aid*, not a full index; open large or deeply nested files via other tools if necessary.  
    - If you need different limits, adjust the constants in `src/main/constants.ts` and update this doc accordingly.

- **Hidden files not visible**
  - Symptoms:
    - Dotfiles (e.g. `.env`, `.gitignore`) do not appear in the tree.  
  - Fix:
    - Use the “Show hidden files” toggle in the workspace UI, which calls `listWorkspaceFiles({ includeHidden: true })`.

- **Operations outside the workspace**
  - Symptoms:
    - Errors like “Access to paths outside the workspace directory is not permitted.”  
  - Causes:
    - Calling workspace APIs with absolute paths that do not reside under `coreDirectory`.  
    - Using `..` or other parent references in relative paths.  
  - Fix:
    - Ensure all paths passed to workspace APIs point inside the current workspace root.  
    - If you genuinely need to work on a different directory, switch `coreDirectory` in Settings.


- **Programmatic tree navigation (expand/scroll to file)**
  - When building features that highlight or scroll to files in the workspace tree sidebar, paths must match the format used by `node.path` from `fileTreeService.ts`:
    - **Native OS separators**: macOS/Linux use `/`, Windows uses `\`
    - **`expandedDirectories` keys**: must match `node.path` exactly
    - **`data-path` attributes**: use `CSS.escape()` for robust selectors
    - **Scroll container**: `[data-testid="workspace-tree"]` IS the scrollable element (not its parent)
  - See the `joinWorkspaceAbsolute()` helper in `WorkspaceNavigatorProvider.tsx` for the canonical path-building approach.


### Public file sharing

Cloud-synced library files can be shared publicly via a secure link, using the same mechanics as conversation sharing (optional password, expiry, rate limiting). The shared file always reflects the latest cloud-synced version — it is live, not a snapshot.

**Key behaviors:**
- **Cloud continuity required** — Only files synced to the cloud instance can be shared. If cloud continuity is off, sharing is unavailable.
- **Rename/move breaks the link** — Share links are keyed by workspace-relative file path. Moving or renaming a shared file breaks the existing share link. The share dialog warns users about this.
- **Text-based files render inline** — Recipients see rendered content in the browser (markdown, plain text, JSON, XML, CSV, and other text formats). Binary files (images, PDFs, etc.) are served as downloads.
- **Sync cadence** — "Live" means "latest synced version", bounded by the workspace sync cadence (15s debounce, 5-minute throttle). Not real-time streaming.

The desktop UI exposes file sharing via the library context menu ("Share publicly…") when cloud mode is active. See [PUBLIC_SHARING.md](PUBLIC_SHARING.md) for the full sharing architecture covering both conversations and files.


### Future work

- **Multiple workspaces and recent‑workspace switching**
  - Support for quickly switching between several known workspaces without manually re‑selecting paths each time.

- **Workspace‑scoped settings**
  - Allow certain settings (e.g. MCP config file) to be stored per workspace, making project‑specific configuration easier.

- **Smarter tree virtualisation**
  - Additional UI‑level virtualisation or search to handle extremely large repositories more gracefully.


### Maintenance

- Treat this document as the **single source of truth** for how workspace selection, file trees, and file operations behave.  
- When changing:
  - `src/main/ipc/libraryHandlers.ts` or `src/main/ipc/permissionsHandlers.ts`,  
  - `src/main/services/fileTreeService.ts`,  
  - `src/main/utils/systemUtils.ts` (especially `resolveLibraryPath`), or  
  - the workspace sidebar and editor logic in `src/renderer/App.tsx`,  
  update this file as part of the same change.  
- Periodically verify that the limits (`MAX_FILE_DEPTH`, `MAX_CHILDREN_PER_DIRECTORY`) and error messages described here still match the implementation.


