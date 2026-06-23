---
description: "Operators + live meeting coaches (unified): OPERATOR.md frontmatter model, schema & parsing, service map, agent surface, rules for adding a new operator/coach"
last_updated: "2026-06-10"
---

# Operators + Live Meeting Coaches (Unified)

Both surface types live under one `OPERATOR.md` frontmatter format with a `roles: [operator | live_meeting]` flag (multi-role allowed).

**Source of truth:** [`docs/plans/260524_operators_redefinition.md`](../plans/260524_operators_redefinition.md) plus Phases A/B/C in [`docs/plans/260526_operators_redesign_stage10_through_15.md`](../plans/260526_operators_redesign_stage10_through_15.md).

## Schema & parsing

- Schema in `src/shared/types/operators.ts` + Zod parser in `src/shared/schemas/operatorFrontmatter.ts`.
- Frontmatter mutation goes through the shared `src/main/services/operatorFrontmatterSerializer.ts` (yaml-AST round-trip; preserves comments, field order, block-vs-flow).
- Live-coach prompt selection goes through `src/main/services/meetingCoachPromptResolver.ts` (FS-authoritative re-parse + content-hash invalidation).

## Service map

- **Activation**: `src/main/services/operatorActivationService.ts` — copy-only (no calibration, no grounding store).
- **Removal**: `src/main/services/operatorRemovalService.ts` — deletes `OPERATOR.md` and removes the empty directory; diary.md is preserved.
- **Rename**: `src/main/services/operatorDisplayNameService.ts` (frontmatter-only; slug stays source-derived).
- **Live-coach toggle (Phase C)**: `src/main/services/operatorRoleToggleService.ts` flips `live_meeting` in `roles`, requires `live_prompt`, blocks empty roles.
- **Duplicate (Phase A)**: `src/main/services/operatorDuplicateService.ts` derives slug + collision-resolves.
- **Personalisation**: runs as an agent turn via `src/main/services/operatorPersonalisationService.ts` + `personalisationPromptTemplate.ts`, broadcasting `conversations:start-requested` with `systemPromptPrefix` and `origin: 'operator-personalisation'`.

## Renderer

- Error map covers 13 error codes in `src/renderer/features/operators/utils/activationErrorMessages.ts`.

## Agent surface

The agent surface (`<operators_available>` + consult runner) prefers `display_name` over `name`, so renamed/duplicated operators are addressable to the agent.

## Adding a new operator/coach

Edit `OPERATOR.md` with explicit `roles: [...]` — do **NOT** create separate `SKILL.md` files for coaches.
