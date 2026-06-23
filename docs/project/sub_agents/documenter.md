---
description: "Mindstone Rebel documenter droid conventions — canonical doc skill, doc locations, audiences, and end-user bundle boundary"
last_updated: "2026-02-17"
---

# Documenter — Project-Specific Instructions

> Generic documenter guidance lives in `coding-agent-instructions/droids/documenter-base.md` and `coding-agent-instructions/sub_agents/documenter.md`.
> This file contains only Mindstone Rebel-specific conventions.

## Canonical Skill

Follow [`rebel-system/skills/documentation/write-help-evergreen-doc/SKILL.md`](../../../rebel-system/skills/documentation/write-help-evergreen-doc/SKILL.md) for all documentation work. That skill defines structure, cross-referencing, and quality standards.

## Doc Locations

| Doc Type | Location | Audience |
|----------|----------|----------|
| Developer docs | `docs/project/` | Internal developers |
| User-facing docs | `rebel-system/help-for-humans/` | End users |
| Planning docs | `docs/plans/` | Ephemeral, decision records |
| Refactoring logs | `docs/refactoring-logs/` | Ephemeral, refactoring records |

**Important**: `rebel-system/` is bundled to end users — avoid dev-only details there. See [`docs/project/REBEL_SYSTEM_FILES.md`](../REBEL_SYSTEM_FILES.md).
