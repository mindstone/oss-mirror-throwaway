---
description: "Guide to rebel-system content boundaries — shipped skills, help docs, audience separation, directory structure, update rules"
last_updated: "2026-01-22"
---

# Rebel System Files

This document describes the `rebel-system/` directory structure and its audience separation from `docs/project/`.

**Key principle:** `rebel-system/` contains Rebel's built-in instructions, skills, and help documentation. It should remain product-agnostic — no Mindstone-specific branding, internal processes, or company references. Think of it as the "operating system" content that ships with Rebel itself.

## See Also

- [HELP_FOR_HUMANS_DOCUMENTATION](./HELP_FOR_HUMANS_DOCUMENTATION.md) — **Canonical guide for writing user-facing docs** in `help-for-humans/`
- [HELP_FOR_HUMANS_UPDATE_PROCESS](./HELP_FOR_HUMANS_UPDATE_PROCESS.md) — Periodic audit workflow for keeping help-for-humans docs current
- [REBEL_SYSTEM_SYNC](./REBEL_SYSTEM_SYNC.md) — How rebel-system syncs from GitHub, submodule usage, and release coupling
- [where-rebel-stores-things.md](../../rebel-system/help-for-humans/where-rebel-stores-things.md) — User-facing doc explaining where rebel-system and app data live

## Document Audience Distinction

Three documentation systems serve different audiences:

| Directory | Audience | Bundled with App? | Content Type |
|-----------|----------|-------------------|--------------|
| `rebel-system/` | End users (knowledge workers) | Yes | Skills, help docs, templates |
| `docs/project/` | App developers | No | Architecture, build, internal processes |
| `coding-agent-instructions/` | AI coding agents (internal) | No | Project-agnostic dev docs & skills |

### `coding-agent-instructions/` — Shared Internal Dev Docs

This submodule contains **project-agnostic** instructions, principles, and skills for AI coding agents. It is shared across multiple repos and is **not bundled with the app** or visible to end users.

**Purpose:** Standardise how AI agents work across different projects (coding principles, git workflows, documentation skills).

**Avoid referencing in:**
- User-facing changelogs (`rebel-system/help-for-humans/changelog.md`)
- User-facing help docs (`help-for-humans/`)
- Any content bundled with the app

**Include in:** Internal developer documentation (`docs/project/`) when relevant.

### `rebel-system/` — User-Facing (Bundled)

This directory is **bundled into the Rebel app** and distributed to end users. Its content is symlinked into each user's workspace at runtime. **Users cannot modify these files—they are read-only and updated only via app releases.** If a skill needs persistent user data, it should direct the agent to store it in a memory space (user-writeable), not inside rebel-system.

**Write for:** General knowledge workers — executives, PMs, researchers, professionals. Not developers.

**Avoid:**
- Developer-only details (submodules, Git internals, private tokens)
- References to this superproject (e.g. `docs/project/`, `src/`, `package.json`)
- Technical jargon without explanation
- Implementation details users don't need

**Include:**
- Clear, friendly explanations of how features work
- Step-by-step instructions for common tasks
- Troubleshooting guidance users can follow themselves
- Links to other help-for-humans docs (not internal docs)

### `docs/project/` — Developer-Facing (Internal)

This directory is for Rebel app developers only. It is **not bundled** with the app and users never see it.

**Write for:** Developers maintaining and extending the Rebel app.

**Include:**
- Full technical details (architecture, IPC contracts, state management)
- Internal processes (CI/CD, release procedures, debugging)
- Implementation rationale and design decisions
- References to code (`src/`), scripts, and build tooling


## The `rebel-system/` Directory Structure

```
rebel-system/
├── AGENTS.md              # System prompt and instructions
├── README.md              # Human-oriented overview
├── help-for-humans/       # User-facing documentation
├── skills/                # Task-specific instructions
├── templates/             # README templates, configs
├── scripts/               # Shared utility scripts
└── resources/             # Static resources (connector catalog, etc.)
```

### `help-for-humans/` — User Documentation

End-user guides explaining how Rebel works, how to use features, and troubleshooting.

**Key files:**
- `getting-started.md` — First-time setup and onboarding
- `terminology.md` — Glossary of concepts (spaces, skills, memory, MCPs)
- `troubleshooting.md` — Common problems and solutions
- Feature-specific guides (voice, permissions, spaces, etc.)

### `skills/` — Executable Instructions

Step-by-step instructions that tell AI agents how to perform specific tasks. Organised by category:

- `documentation/` — Writing skills for docs, transcripts, diagrams
- `system/` — Workspace setup, file organisation, MCP management
- `research/` — Web research, CRM research, Notion/Slack search
- `thinking/` — Sounding board, prioritisation, devil's advocate
- `meetings/` — Calendar, meeting prep, follow-ups
- And more (browse `skills/` directories)


## Writing `help-for-humans/` Documentation

See [HELP_FOR_HUMANS_DOCUMENTATION](./HELP_FOR_HUMANS_DOCUMENTATION.md) for the canonical guide covering:
- Format requirements (YAML frontmatter, filenames)
- Content guidelines and tone
- Quality checklist
- Internal-to-user doc mapping

### User-Facing Changelog

The file `rebel-system/help-for-humans/changelog.md` has its own distinct style — punchy, benefit-focused, with dry closing quips. See [CHANGELOG_UPDATE_PROCESS.md](./CHANGELOG_UPDATE_PROCESS.md) for detailed style guidance.


## Updating `rebel-system/` Content

Changes to `rebel-system/` require a new app release (it's bundled at build time). See [REBEL_SYSTEM_SYNC](./REBEL_SYSTEM_SYNC.md) for the sync workflow.

When updating help docs:
1. Edit locally in the submodule
2. Test with `npm run dev` to verify rendering
3. Push to the rebel-system repo
4. Update the submodule pointer in the main repo
5. Include in the next app release

