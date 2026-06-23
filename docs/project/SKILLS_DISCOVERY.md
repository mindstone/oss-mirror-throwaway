---
description: "Skills discovery architecture — platform, workspace, and space skill locations, file formats, parsing, grouping rules"
last_updated: "2026-01-16"
---

# Skills Discovery

## Introduction

Mindstone Rebel supports **skills**: markdown files with YAML frontmatter that provide structured guidance, workflows, and reference documentation for the AI agent. This document explains how Rebel discovers and organizes skills from the workspace, rebel-system, and linked spaces.

Skills are not automatically injected into the system prompt—instead, they form a **discoverable library** that the agent can read when relevant to the current task.


## See Also

- [SYSTEM_PROMPT](SYSTEM_PROMPT.md) — How the composite system prompt is constructed (skills are not auto-loaded, but available for the agent to read)
- [LIBRARY_AND_FILE_ACCESS](LIBRARY_AND_FILE_ACCESS.md) — Workspace selection and file access patterns used during skill discovery
- [MCP_CONFIGURATION](MCP_ARCHITECTURE.md) — MCP configuration; skills complement MCP tools by providing procedural guidance
- `rebel-system/skills/` — The bundled platform skills directory
- `src/main/services/skillsService.ts` — Canonical implementation of skill scanning and parsing
- `src/main/services/spaceService.ts` — Space discovery used to find skill directories in spaces
- `src/shared/systemSkills.ts` — System skill path configuration for core skills (safety guard, memory update)


## Skill Locations

Skills are discovered from three sources, scanned in this order:

### 1. Platform Skills (`rebel-system/skills/`)

Built-in skills bundled with Rebel. These are read-only and maintained by the Mindstone team.

- **Path**: `${coreDirectory}/rebel-system/skills/`
- **Type**: `'platform'`
- **Label**: "Rebel system"
- **Characteristics**:
  - Included when the directory exists and contains at least one skill
  - Marked as `isBuiltIn: true`
  - Contains categories like `coding/`, `documentation/`, `safety/`, `memory/`, `research/`, etc.

### 2. Workspace Root Skills (`skills/`)

Project-specific skills stored at the workspace root.

- **Path**: `${coreDirectory}/skills/`
- **Type**: `'workspace'`
- **Label**: "Workspace"
- **Included**: Only if the directory exists and contains at least one skill
- **Use case**: Skills specific to the current project or codebase

### 3. Space Skills

Skills stored within individual spaces (Chief-of-Staff, Personal, work spaces).

- **Path**: `${spacePath}/skills/` for each discovered space
- **Type**: `'space'`
- **Label**: Space name (e.g., "Chief of Staff", "Personal", "work/CompanyName/TeamName")
- **Included**: If the space has a `skills/` directory—even if that directory contains 0 skills (unlike platform/workspace groups which require at least one skill)
- **Discovery**: Uses `scanSpaces()` from spaceService to find all spaces, then checks each for a `skills/` subdirectory


## Skill File Formats

Rebel supports two skill file conventions:

### Folder-Based Skills (Anthropic convention)

A folder containing a `SKILL.md` file:

```
skills/
  documentation/
    write-help-evergreen-doc/
      SKILL.md           ← The skill file
      examples/          ← Optional supporting files
```

- **Name**: Derived from the folder name (e.g., `write-help-evergreen-doc`)
- **Category**: Derived from parent folders (e.g., `documentation`)
- **Advantages**: Can include supporting files (examples, templates) alongside the skill

### File-Based Skills (simpler convention)

A standalone markdown file:

```
skills/
  documentation/
    quick-reference.md   ← The skill file
```

- **Name**: Derived from filename without `.md` extension (e.g., `quick-reference`)
- **Category**: Derived from containing folder (e.g., `documentation`)
- **Advantages**: Simpler for single-file skills

### Skipped Files

The following are not treated as skills:
- Files starting with `.` (hidden files)
- `README.md`, `index.md`, `SKILLS-MENU.md`
- Directories named `node_modules`, `archive`, `obsolete`


## Skill Frontmatter

Skills should include YAML frontmatter with metadata. The schema is validated using Zod:

```yaml
---
description: "Creates concise, well-structured evergreen documentation."
use_cases:
  - "Document a new feature"
  - "Update existing documentation"
last_updated: "2025-10-28"
tools_required:
  - Read
  - Write
agent_type: main_agent
dependencies:
  - signposting-to-single-source-of-truth
---
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | `string` | One-line summary of what the skill does |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `use_cases` | `string[]` | Example scenarios when to use this skill |
| `last_updated` | `string` | Date of last update |
| `tools_required` | `string[]` | Tools the skill expects to be available |
| `agent_type` | `'main_agent' \| 'subagent'` | Whether skill is for main agent or subagents |
| `dependencies` | `string[]` | Other skills this skill references |

**Note**: The skill name is always derived from the folder name (folder-based skills) or filename (file-based skills)—there is no `name` frontmatter field.

### Frontmatter Parsing Behavior

Skills with missing or invalid frontmatter are still discovered. The `hasFrontmatter` property is `true` if at least a valid `description` field could be extracted—even if full Zod schema validation failed. If no `description` exists, `hasFrontmatter` is `false`.


## Discovery Process

The skill discovery process is implemented in `skillsService.ts`:

### 1. `scanSkills(workspacePath)`

Main entry point. Scans all three skill locations and returns grouped results:

```typescript
interface SkillsScanResult {
  groups: SkillsGroup[];
  totalCount: number;
}
```

### 2. `scanSkillsDirectory(skillsDir, workspaceRoot)`

Recursively scans a directory for skills, handling both folder-based and file-based formats.

### 3. `findSkills(dir, ...)`

Recursive helper that:
- Checks for `SKILL.md` in folders (folder-based skills)
- Scans for `*.md` files (file-based skills)
- Respects `maxDepth` limit (default: 10)
- Skips hidden files and archive directories

### 4. `readSkillFrontmatter(filePath)`

Parses YAML frontmatter using the `front-matter` library and validates against `SkillFrontmatterSchema`.


## Skill Grouping

Skills are organized into groups (`SkillsGroup`) by source:

```typescript
interface SkillsGroup {
  source: string;              // e.g., 'platform', 'workspace', 'work/CompanyName'
  label: string;               // UI display name
  type: 'platform' | 'space' | 'workspace';
  categories: Record<string, SkillInfo[]>;  // Skills by category
  count: number;               // Total skills in group
  isBuiltIn?: boolean;         // True for platform skills
  relativePath?: string;       // Path from workspace root
  absolutePath?: string;       // Full filesystem path
  isSymlink?: boolean;         // True if source is symlinked
  storageProvider?: string;    // For symlinks: google_drive, onedrive, dropbox, etc.
  sharing?: string;            // From space frontmatter: private, team, company-wide, public
}
```

Within each group, skills are organized by **category** (derived from the folder structure).


## System Skills

Certain skills are referenced directly by code for core functionality. These are defined in `src/shared/systemSkills.ts`:

### Default System Skill Paths

| Key | Default Path | Purpose |
|-----|--------------|---------|
| `safetyGuard` | `skills/safety/safety-guard/SKILL.md` | Tool risk evaluation for the safety service |
| `memoryUpdate` | `skills/memory/memory-update/SKILL.md` | Memory update processing |

### Configurable Paths

System skill paths can be overridden via `AppSettings.systemSkills`:

```typescript
interface SystemSkillsSettings {
  safetyGuardPath?: string | null;  // Override for safety guard skill
  memoryUpdatePath?: string | null; // Override for memory update skill
}
```

The `getEffectiveSkillPath(skillKey, settings)` function returns the configured path or falls back to the default.


## Symlink Handling

Skills in spaces can be symlinked to external locations (Google Drive, OneDrive, etc.). The discovery process relies on **space metadata** from `spaceService`:

1. `scanSpaces()` detects symlinks (via `fs.lstat()`) and resolves targets (via `fs.readlink()`) for each space
2. `SpaceInfo` objects include `isSymlink` and `sourcePath` properties
3. `scanSkills()` reads these properties from `SpaceInfo` and infers the storage provider from `sourcePath`:

```typescript
function inferStorageProvider(sourcePath: string): StorageProvider {
  // Checks for patterns like:
  // - 'google' + 'drive' → 'google_drive'
  // - 'onedrive' → 'onedrive'
  // - 'dropbox' → 'dropbox'
  // - 'box' → 'box'
  // - 'icloud' or 'mobile documents' → 'icloud'
  // Otherwise → 'other'
}
```

**Note**: The skills service itself does not call `fs.lstat()` or `fs.readlink()`—it relies on the space information already computed by `spaceService.ts`.

This metadata is exposed in `SkillsGroup.storageProvider` for UI display purposes.


## Integration with System Prompt

Skills are **not automatically injected** into the system prompt. Instead:

1. **Discoverable library**: The agent can read skill files when needed using standard file reading
2. **Platform instructions reference skills**: The `rebel-system/AGENTS.md` file may instruct the agent to consult specific skills for certain tasks
3. **System skills loaded on demand**: Services like `toolSafetyService` read skill files directly when needed

This design keeps the system prompt lean while making skills available for complex, multi-step workflows.


## IPC Integration

Skills are exposed to the renderer via IPC:

- **Handler**: `library:scan-skills` in `libraryHandlers.ts`
- **Calls**: `scanSkills(settings.coreDirectory)`
- **Returns**: `{ success: boolean, groups: SkillsGroup[], totalCount: number }`


## Troubleshooting

### Skills not appearing

1. **Check coreDirectory**: Ensure workspace is configured in Settings
2. **Verify path structure**: Skills must be in `skills/` directories
3. **Check file format**: Must be `SKILL.md` (folder-based) or `*.md` (file-based)
4. **Check frontmatter**: Invalid YAML may cause parsing to fail silently

### Symlinked skills not discovered

1. **Verify symlink is valid**: `ls -la` should show the symlink target
2. **Check space is discovered**: Space must have a `README.md` with frontmatter
3. **Permissions**: Ensure the app has access to the symlink target

### System skill not loading

1. **Check path exists**: Verify the skill file is at the expected path
2. **Run health check**: Use Settings → Diagnostics → System Health—the "Safety Guard Prompt" and "Memory Update Prompt" checks verify these system skills exist


## Code References

```
// Main skill discovery
src/main/services/skillsService.ts
  - scanSkills(workspacePath): SkillsScanResult
  - scanSkillsDirectory(skillsDir, workspaceRoot)
  - findSkills(dir, workspaceRoot, skillsRootDir, maxDepth, currentDepth)
  - readSkillFrontmatter(filePath): SkillFrontmatter | undefined
  - SkillFrontmatterSchema (Zod schema)

// System skill configuration
src/shared/systemSkills.ts
  - DEFAULT_SYSTEM_SKILL_PATHS
  - SystemSkillsSettings
  - getEffectiveSkillPath(skillKey, settings)

// Space discovery (used by skills)
src/main/services/spaceService.ts
  - scanSpaces(workspacePath): SpaceInfo[]

// IPC handler
src/main/ipc/libraryHandlers.ts
  - 'library:scan-skills' handler

// System skill existence checks
src/main/services/health/checks/prompt.ts
  - checkSafetyPromptExists(): Validates safety guard skill exists
  - checkMemoryPromptExists(): Validates memory update skill exists

// Skills convention check (for rebel-system/skills structure)
src/main/services/health/checks/skills.ts
  - checkSkillsConvention(): Validates skills follow Anthropic folder convention (SKILL.md with name/description frontmatter)
```
