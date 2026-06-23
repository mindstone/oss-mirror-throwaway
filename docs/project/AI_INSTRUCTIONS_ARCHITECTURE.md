---
description: "Layered AI coding-instruction architecture for Rebel — shared submodule boundaries, repo overrides, droid setup patterns"
last_updated: "2026-02-20"
---

# AI Instructions Architecture

How AI coding instructions are organized across shared and repo-specific files.

## Overview

Mindstone Rebel uses a **layered instruction architecture** where generic coding principles live in a shared submodule (`coding-agent-instructions/`) and repo-specific conventions remain in local files.

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 2: Droid Definitions               │
│            .factory/droids/*.md (Factory)                   │
│            .cursor/ (Cursor)                                │
│           (model config + reference to shared base)         │
├─────────────────────────────────────────────────────────────┤
│                    Layer 1: Shared Base                     │
│               coding-agent-instructions/                    │
│    AGENTS-BASE.md, principles/, workflows/, droids/,        │
│                      sub_agents/                            │
│                  (generic, reusable)                        │
└─────────────────────────────────────────────────────────────┘

Repo-specific conventions live in `AGENTS.md` and `docs/project/CODING_PRINCIPLES.md`.
```

## The Shared Submodule

Location: `coding-agent-instructions/` (git submodule)

Contains:
- **AGENTS-BASE.md** — Core engineering principles, operating loop, collaboration norms
- **principles/CODING_PRINCIPLES.md** — Generic TypeScript/React patterns
- **workflows/CHIEF_ENGINEER2/** — Multi-agent coordination workflow (current; v1 frozen at `CHIEF_ENGINEER.md`)
- **droids/** — Base role definitions (planner, implementer, reviewer, etc.)
- **sub_agents/** — Extended guidance for each role

**Key rule:** No repo-specific paths, commands, or configurations in the shared repo.

## Reference Pattern

Files use directive language to reference shared content:

```markdown
> **Read `coding-agent-instructions/AGENTS-BASE.md` for core engineering principles.**
> Key points: Pragmatism, clarity, reversibility. Smaller > bigger, consistency > invention.
```

The inline summary provides degraded-mode context if the reference can't be followed.

## When to Add Content

| Content Type | Where to Add |
|-------------|--------------|
| Universal coding principles | `coding-agent-instructions/principles/` |
| Generic role responsibilities | `coding-agent-instructions/droids/` or `sub_agents/` |
| Repo-specific file paths | Local `docs/project/sub_agents/` |
| Model configurations | Local `.factory/droids/` |
| Project-specific workflows | Local `docs/project/` |
| Build/test commands | Local `AGENTS.md` |

## Conflict Resolution

When repo-specific instructions contradict shared instructions:

1. **Repo-specific wins** — Local conventions override generic advice
2. **Document the override** — Add a note explaining why you deviate
3. **Consider upstreaming** — If the override is broadly useful, update shared content

## Updating Shared Content

```bash
cd coding-agent-instructions
git fetch origin
git checkout main
git pull origin main
cd ..
git add coding-agent-instructions
git commit -m "chore: update coding-agent-instructions"
```

Recommended cadence: Weekly, or when significant shared content changes.

## Creating New Droids

When creating a new droid role:

1. **Check if generic** — Does this role apply across repos?
   - Yes → Add base definition to `coding-agent-instructions/droids/<role>-base.md`
   - No → Create only in local `.factory/droids/`

2. **Create the reference chain:**
   ```markdown
   **Read these for your full instructions:**
   1. `coding-agent-instructions/droids/<role>-base.md` — Base role
   2. `coding-agent-instructions/sub_agents/<role>.md` — Extended guidance
   ```

3. **Add any project-specific overrides** in the droid definition file itself.

## See Also

- [GIT_SUBMODULES.md](GIT_SUBMODULES.md) — Submodule management
- [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — Multi-agent coordination workflow (current; v1 frozen at `CHIEF_ENGINEER.md`)
- [coding-agent-instructions/README.md](../../coding-agent-instructions/README.md) — Shared repo documentation
