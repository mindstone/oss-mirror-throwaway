---
description: "Mindstone Rebel project overrides for shared agent workflows — droid roster, review policy, validation commands, tooling"
last_updated: "2026-05-28"
---

# Project Overrides — Mindstone Rebel

> **CRITICAL:** This file is read by AI agents at the start of every workflow in `coding-agent-instructions/`. It provides Rebel-specific configuration that the shared workflows reference but do not hardcode.

---

## Global Settings

### Available Droids

| Role | Droid | Model | Use Case |
|------|-------|-------|----------|
| Planner | `planner` | inherit | Planning and research |
| Implementer | `implementer` | inherit | Code implementation (fallback) |
| Implementer (Codex) | `implementer-gpt5.3-codex` | gpt-5.3-codex | Code implementation, extra high reasoning |
| Implementer (Opus) | `implementer-opus4.7-thinking` | claude-opus-4-7 | Code implementation, extended thinking |
| Implementer (GPT-5.5) | `implementer-gpt5.5-high` | gpt-5.5 | Code implementation, high reasoning |
| Implementer (Gemini) | `implementer-gemini3.1-pro` | gemini-3.1-pro-preview | Code implementation |
| Primary Reviewer | `reviewer-gpt5.5-high` | gpt-5.5 | Fast, broad pattern recognition |
| Deep Reviewer (Codex) | `reviewer-gpt5.3-codex` | gpt-5.3-codex | Deep analysis, extra high reasoning |
| Third Reviewer | `reviewer-opus4.7-thinking` | claude-opus-4-7 | Architectural analysis, complex tradeoffs |
| Fourth Reviewer | `reviewer-gemini3.1-pro` | gemini-3-pro-preview | Different perspective (reverted from 3.1 — reviewer regression) |
| Fifth Reviewer | `reviewer-kimi-k2.5` | kimi-k2.5 | Fresh perspective, independent model family |
| Sixth Reviewer | `reviewer-minimax2.7` | minimax-m2.7 | Strong agentic coding model |
| Seventh Reviewer | `reviewer-glm5` | glm-5 | Independent verification |
| Tester & Verifier | `tester-gpt5.5` | gpt-5.5 | Behavioral contract tests + CI/integration verification during review |
| Debugger | `debugger-*` | varies | Bug diagnosis and fixing (6 model variants) |
| Researcher | `researcher-*` | varies | Problem investigation |
| Chief Designer | `chief-designer` | gpt-5.5 | Delegated senior product-design authority for UI/UX decisions during planning and review |
| Design System Reviewer | `design-system-reviewer` | gpt-5.5 | Migration safety review for shared UI primitives, Storybook, componentisation, role/density preservation, and local-vs-shared semantics |
| Documenter | `documenter` | inherit | Doc updates after code changes |
| Documentation Specialist | `specialist-documentation` | gpt-5.5 | Identifies docs to read before planning + docs to update after |
| Testability Specialist | `specialist-testability` | gpt-5.5 | Assesses architectural testability + verification strategy |
| Security Specialist | `specialist-security` | gpt-5.5 | Focused security review: trust boundaries, injection, secrets |
| Performance Specialist | `specialist-performance` | gpt-5.5 | Deep analysis: CPU, memory, bundle size, render performance |
| Cost Specialist | `specialist-cost` | gpt-5.5 | API spend, token efficiency, model selection, cost tracking correctness |
| Operational Specialist | `specialist-operational` | gpt-5.5 | Failure modes, logging, error recovery, rollback, crash consistency |
| Completeness Specialist | `specialist-completeness` | gpt-5.5 | Consumer tracing, cross-cutting concerns, plan vs. delivery audit |
| Behavioral Safety Specialist | `specialist-behavioral-safety` | gpt-5.5 | Silent failure modes, behavioral preservation, edge cases |
| Approach Assessment Specialist | `specialist-structural-health` | gpt-5.3-codex | Root-cause vs bandaid, class-of-problem elimination |

### Substitution Order (Failure Fallbacks)

| Role | Primary | Substitution order |
|------|---------|-------------------|
| Planner | `planner` | `researcher-gpt5.5-high` > `researcher-opus4.7` > `researcher-gemini3.1-pro` |
| Implementer | `implementer-gpt5.3-codex` | `implementer-opus4.7-thinking` > `implementer-gpt5.5-high` > `implementer-gemini3.1-pro` |
| Reviewer | any `reviewer-*` | `reviewer-gpt5.5-high` > `reviewer-gpt5.3-codex` > `reviewer-opus4.7-thinking` > `reviewer-gemini3.1-pro` > `reviewer-kimi-k2.5` > `reviewer-minimax2.7` > `reviewer-glm5` |
| Debugger | any `debugger-*` | `debugger-gpt5.5-high` > `debugger-gpt5.3-codex` > `debugger-opus4.7-thinking` > `debugger-gemini3.1-pro` > `debugger-glm5` > `debugger-kimi-k2.5` |
| Chief Designer | `chief-designer` | *(no alternates — fall back to a tightly scoped `researcher-*` or `reviewer-*` prompt grounded in `rebel-system/skills/ux/chief-designer/SKILL.md`)* |
| Design System Reviewer | `design-system-reviewer` | *(no alternates — fall back to `reviewer-gpt5.5-high` grounded in `rebel-system/skills/ux/design-system-reviewer/SKILL.md`)* |

### Implementer Selection Policy

- **Policy:** Random selection for data collection
- **Available implementers:** `implementer-gpt5.3-codex`, `implementer-opus4.7-thinking`, `implementer-gpt5.5-high`, `implementer-gemini3.1-pro`
- **Notes:** Choose one at random with uniform probability at the start of each task. Use the same implementer for all stages. This ensures comparable data across models for performance analysis.

### Review Intensity Defaults

| Intensity | General Reviewers | Specialists |
|-----------|------------------|-------------|
| Light | 1-2 (diverse model families) | 0-1 (Chief's discretion) |
| Medium (default) | 2 (diverse model families) | DA + 2-3 (Chief selects from roster) |
| Heavy | 3 (GPT + Gemini + Opus families) | DA + 3-5 (default + triggered) |

See [CHIEF_ENGINEER2 § Review Architecture](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md#4-review-architecture) for the canonical intensity table and specialist selection guidelines.

### Devil's Advocate Configuration

- **Anchor DA:** `reviewer-gpt5.5-high` (where its unique-finding rate is highest)
- **Rotating DA pool:** `reviewer-opus4.7-thinking` (75% accept rate), `reviewer-gpt5.3-codex` (~69% accept rate) — pick with equal probability
- **Excluded from DA:** `reviewer-kimi-k2.5` (38% accept), `reviewer-gemini3.1-pro` (40% accept) — below signal threshold
- **Planner DA:** `reviewer-gpt5.3-codex` (for adversarial plan challenge at medium+ complexity)
- **Experiment notes:** *(Trial — revisit 2026-04-20. See `docs/plans/260406_chief_perf_instrumentation_and_da.md` for data.)*

### Validation Commands

| Concept | Command | Notes |
|---------|---------|-------|
| Fast validation | `npm run validate:fast` | lint + IPC contracts + store versions + MCP bundles + circular deps + TS error ratchet + boundary contract enforcement (forbidden terms, cloud channel parity, IPC handler parity) + husky pre-push fast-tier contract + integration-test provider-gate AST check |
| Full validation | `npm run verify:agent:full` | validate:fast → validate:knip-health → npm test → generate-impact-map → electron-vite build |
| Strict type check | `npm run lint:ts` | ~380 existing errors (ratcheted — don't increase) |
| Lint only | `npm run lint` | ESLint |
| Unit tests | `npm test` | Vitest |
| Contract/schema validation | `npm run validate:ipc` | IPC channel + Zod schema consistency (part of validate:fast) |
| Build | `electron-vite build` | Part of verify:agent:full |
| MCP smoke tests | `npm run test:mcp:smoke` | MCP bundle + tool wiring tests |
| Performance E2E | `npm run test:e2e:perf` | Performance regression suite |
| Agent verification | `npm run verify:agent` | validate:fast + knip-health + unit tests (no build) |

**Why full validation matters:** Vitest mocks module resolution differently than Vite's bundler. A renderer file importing from `@core/` (main-process-only alias) will pass all unit tests but fail the Vite build at runtime. This gate catches architectural boundary violations and IPC bridge generation issues that static analysis misses.

### Impact Analysis Tooling

- **Command:** `npx tsx scripts/generate-impact-map.ts`
- **Output:** `.impact-map.json`
- **Runtime:** ~60-90 seconds
- **Also runs as part of:** `npm run verify:agent:full`
- **Exhaustive for:** static TypeScript import dependencies (`reverseDeps`), `vi.mock`/`jest.mock` sites (`mockTargets`), switch statements on `.type`/`.kind`/`.action` discriminants (`switchDispatchSites`), IPC handler registrations (`ipcRegistrations`)
- **Does NOT capture:** stringly-typed config/feature-flag lookups, runtime-only dependencies (`dynamic import()`, `require()`), event emitter channels, plugin registrations, cloud channel policy sync, string-keyed registry maps
- **Usage:** Instruct specialists to read `_warnings` array first. If unavailable, fall back to ad-hoc ripgrep.

### Architecture & Cross-Surface Parity

- **Surfaces:** Desktop (Electron), Cloud (Node.js HTTP server), Mobile (React Native)
- **Shared code:** `src/core/` (platform-agnostic), `src/shared/` (cross-process types/contracts)
- **Desktop entry:** `src/main/bootstrap.ts` → `src/main/index.ts`
- **Cloud entry:** `cloud-service/src/bootstrap.ts` → `cloud-service/src/server.ts`
- **Mobile:** `mobile/` (consumes `cloud-client/` and `src/shared/`)
- **Transport contracts:** `src/shared/ipc/contracts.ts` (Zod schemas), `src/shared/cloudChannelPolicies.ts` (cloud-routable channels)
- **Parity check:** When shared code changes, reviewers MUST verify:
  - [ ] Desktop bootstrap wiring: `src/main/bootstrap.ts`
  - [ ] Cloud bootstrap wiring: `cloud-service/src/bootstrap.ts`
  - [ ] Cloud channel policies: `src/shared/cloudChannelPolicies.ts`
  - [ ] Server routing: `cloud-service/src/server.ts`
  - [ ] Mobile compatibility (if applicable)
- **Historical note:** 26% of production bugs were cross-surface parity gaps — this is not a theoretical concern.

### Brand Voice & Style

- **Brand voice doc:** `docs/project/BRAND_VOICE.md`
- **Quick summary:** Rebel is dry, witty, self-aware — "capable colleague who happens to be amusing." Bias toward clear over clever, calm over exciting, useful over impressive.
- **Target audience:** Non-technical knowledge workers (executives, PMs, sales & marketing, researchers). Every product decision should be evaluated through this lens.
- **For reviewers:** User-facing copy should match Rebel's personality. See `docs/project/BRAND_VOICE.md`.

### Documentation Conventions

- **Internal docs:** `docs/project/`
- **User-facing docs:** `rebel-system/help-for-humans/`
- **Planning docs:** `docs/plans/YYMMDD_<task>.md`
- **Research docs:** `docs/research/YYMMDD_<topic>.md`
- **Investigation docs:** `docs-private/investigations/YYMMDD_<bug>.md`
- **Doc update process:** `docs/project/DEV_DOCUMENTATION_UPDATE_PROCESS.md`
- **Internal changelog:** `CHANGELOG.md`
- **User-facing changelog:** `rebel-system/help-for-humans/changelog.md`
- **Doc writing skill:** `rebel-system/skills/documentation/write-help-evergreen-doc/SKILL.md`

### Issue Tracker Integration

- **Tracker:** Linear
- **Ticket prefix:** `FOX-`
- **Branch naming:** `feature/FOX-XXXX-<short-description>`
- **Auto-close on merge:** Yes — include ticket ID in commit message
- **Workflow doc:** `coding-agent-instructions/workflows/CREATE_LINEAR_TICKET.md`

---

## Chief Designer Overrides

These settings adapt the shared [CHIEF_DESIGNER](../../coding-agent-instructions/workflows/CHIEF_DESIGNER.md) workflow to Mindstone Rebel. Keep Rebel-specific paths, droid names, brand voice, component references, and visual-evidence tooling here rather than in the shared workflow.

### Design Authority

- **Primary audience:** Non-technical knowledge workers: executives, product managers, sales and marketing, customer success, professionals, and researchers.
- **Product goal:** Make agentic AI feel understandable, useful, calm, and under the user's control.
- **Decision scope:** Information architecture, naming, hierarchy, state design, trust/recovery, copy direction, accessibility, and reuse-vs-new pattern decisions.
- **Decision style:** Chief Designer should make one primary recommendation when the relevant product facts are known. Ask only for missing facts that materially change the outcome.
- **Preservation policy:** Preserve working capabilities, useful information, user-facing words, CTAs, controls, data, behaviours, settings, diagnostics, and recovery paths unless the user or product owner explicitly authorises removal.
- **Correction-loop emphasis:** For follow-up UI/design feedback, preserve the accepted parts and lock the user's words, CTAs, behaviours, and non-goals before proposing changes. Prefer hierarchy, spacing, density, alignment, and system reuse over decorative fixes such as extra chrome, random colours, gradients, or nested containers.
- **AI experience emphasis:** Apply the shared Chief Designer AI heuristics for calibrated reliance, anti-sycophancy, transparent personalization, low anthropomorphic pressure, and feedback-loop awareness. Rebel should feel like a capable tool under the user's control, not a social agent steering them invisibly.

### Product Context Sources

- **Brand voice:** `docs/project/BRAND_VOICE.md`
- **Product overview:** `docs/project/PRODUCT_VISION_FEATURES.md`
- **UI overview:** `docs/project/UI_OVERVIEW.md`
- **Spaces and organisation model:** `docs/project/SPACES.md`
- **AI behavioural heuristics:** [Nudges, Biases & Heuristics for the Age of AI](https://www.nudges.fyi/library?cat=ai)
- **Personas / journeys / research:** prefer `personas/`, `user-journeys/`, `research/`, injected `@designContext`, and relevant planning docs when present.

### Design System Sources

- **Canonical Rebel design judgment skill:** `rebel-system/skills/ux/chief-designer/SKILL.md`
- **Design System Reviewer skill:** `rebel-system/skills/ux/design-system-reviewer/SKILL.md`
- **UI workflow learnings:** `docs/plans/260429_ui_design_workflow_chain_and_correction_loop_learnings.md`
- **Operational UI checklist:** `skills/ux/rebel-ui-consistency-review/SKILL.md`
- **Component library:** `src/renderer/components/ui/README.md`
- **Storybook manifest:** `src/renderer/components/ui/storybookManifest.ts`
- **Component health manifest:** `src/renderer/components/ui/manifests/storybook_component_manifest.json`
- **Design-system audit:** `docs/research/260423_hybrid_ui_consistency_audit.md`
- **UI taxonomy plan:** `docs/plans/260423_ui_system_taxonomy_first_pass.md`
- **Storybook IA:** `docs/plans/260423_storybook_atomic_review_information_architecture.md`
- **Settings/forms patterns:** `docs/project/UI_SETTINGS_AND_FORMS.md`
- **CSS architecture and theming:** `docs/project/UI_CSS_ARCHITECTURE.md`

### Visual Evidence Rules

- **Required for:** Any visible Rebel app UI review, redesign, component/variant recommendation, hierarchy judgment, spacing/tone decision, or post-implementation validation.
- **Accepted sources:** Current Rebel app captures, valid coding-context dev-app captures, user-provided screenshots/images, and explicitly scoped Figma or web references.
- **Rejected sources:** Stale screenshots found on disk, wrong-surface captures, browser/Chrome/about:blank surfaces, OS-region screenshots, Storybook-only evidence for current app UI, and isolated Demo Mode / spawned app captures when reviewing the user's current dev app.
- **In-app pure-judgment path:** Use `rebel_navigate_app` for named built-in surfaces, then `rebel_get_app_screenshot`; use scroll capture for long surfaces. Preserve and restore the user's original surface and theme when navigation or theme cycling changes them.
- **Coding-context live app path:** The user's actual CDP-accessible dev app is the source of truth. Try `electron_connect_existing_app` with `debug_port: 9222` when available; otherwise use `scripts/capture-rebel-dev-screenshot.ts` before disclosing failure.
- **Managed smoke path:** For isolated implementation verification only, choose the route in `docs/project/AGENT_UI_TESTING.md`.
- **Theme / viewport expectations:** For implemented visible UI changes, verify both light and dark modes when available, plus narrow width where layout can compress.
- **Failure disclosure:** If capture is unavailable after the project-approved paths fail, say visual verification is blocked, include the tool/script diagnosis, and mark the recommendation or review as provisional. Do not substitute invalid evidence.

### Design-System Reviewer Handoff

- **Reviewer droid / skill:** `design-system-reviewer`, grounded in `rebel-system/skills/ux/design-system-reviewer/SKILL.md`.
- **Picker mode trigger:** After Chief Designer settles product intent and implementation needs concrete component, variant, token, tier, or Storybook choices.
- **Reviewer mode trigger:** After implementation changes shared UI primitives, Storybook review pages, componentisation, shared/app-pattern migration, size/variant contracts, focus ownership, or local-vs-shared semantics.
- **Fallback:** If the droid cannot run, read and apply `.cursor/skills/design-system-reviewer/SKILL.md` or return an explicit DSR brief with intent, evidence paths, candidate tier, ruled-out families, component/variant question, token needs, Storybook surfaces, and required visual evidence.

### Output Additions

- **Pattern reuse decision:** what existing shared/app-pattern families to reuse, or why they are insufficient.
- **Pattern classification:** shared primitive | app-pattern/molecule | organism | local/contextual.
- **Chosen IA / component approach:** structure and component family the implementer should follow.
- **User conclusion test:** required for trust/status/recovery/settings semantics.
- **Control and recovery path:** required for trust-sensitive flows.
- **Correction checklist:** required when the prompt follows layered user feedback.
- **Correction-loop lock list:** required when the prompt follows a previous design pass or user correction; name accepted parts, locked words/controls/behaviours, unresolved concerns, and the exact verification surface.
- **Decision confidence:** high | medium | low.
- **Visual Evidence:** include consumed evidence paths for visual-surface work.

---

## Chief Engineer Overrides

### Specialist Trigger Customization

- **Cost specialist additional triggers:** When touching Anthropic API calls, BTS client, Rebel Core agent turns, `costLedgerService`, `pricingCalculator`, `costCategories`, `usageAggregator`
- **Operational specialist additional triggers:** When touching `cloud-service/` routes, MCP/tool execution pipelines
- **Security specialist additional triggers:** When touching IPC channels, preload scripts, Electron process boundaries

### Cross-Surface Parity Checklist

See [Architecture & Cross-Surface Parity](#architecture--cross-surface-parity) above.

### UI Mode

UI Mode is activated by [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) when a task changes visible renderer UI. This subsection is what those hooks resolve to: the UI Brief planning template, packet addenda, and the Phase 8 completion gate. For deep checklists (tokens, theming, typography, animation, accessibility, anti-patterns), link out to the canonical skill rather than duplicating its content here.

**Canonical references** (read before planning UI work):

- **UI workflow chain + correction-loop learnings:** `docs/plans/260429_ui_design_workflow_chain_and_correction_loop_learnings.md` — three-skill agent architecture, design-time → tactical-pick → implement → migration-review chain, dual-mode DSR, foundational correction-loop guardrails, Storybook coverage standard
- **UI consistency skill:** `skills/ux/rebel-ui-consistency-review/SKILL.md` — design tokens, theming, typography, interactions, animations, accessibility, copy guidelines, pattern cross-reference
- **Design system / component library:** `src/renderer/components/ui/README.md`
- **Design-system learning audit:** `docs/research/260423_hybrid_ui_consistency_audit.md` — current shared/app-pattern/local taxonomy, Storybook review philosophy, and Melissa walkthrough learnings
- **UI taxonomy plan:** `docs/plans/260423_ui_system_taxonomy_first_pass.md` — atom/molecule/organism/local classification and rollout order
- **Brand voice:** `docs/project/BRAND_VOICE.md`
- **UI overview / layout:** `docs/project/UI_OVERVIEW.md`
- **CSS architecture & theming:** `docs/project/UI_CSS_ARCHITECTURE.md`
- **Settings/forms patterns:** `docs/project/UI_SETTINGS_AND_FORMS.md`
- **Agent UI testing router:** `docs/project/AGENT_UI_TESTING.md` — choose CLI, packaged Playwright, dev-CDP, MCP, or E2E verification by scenario

**Design philosophy:** Rebel UI should feel calm, capable, and minimal. Composition first, components second. Use whitespace, alignment, scale, and contrast before adding chrome. Default to cardless layouts — cards only when the card IS the interaction. Real content, not placeholders. Restrained motion: ship 2-3 intentional motions, not 10. Classify patterns before extraction: shared primitive, app-pattern/molecule, organism, or intentionally local. Storybook is the review surface, not proof of maturity.

#### UI Brief (Planning Doc Section)

The planning doc must include this section when UI Mode is active. The planner fills it during Phase 2. For **major UI work** (new surfaces, new interaction patterns, significant layout changes) fill all fields. For **minor UI work** (modifying existing patterns, adding a state, changing copy) fill only the fields marked with `*`.

```markdown
## UI Brief

### Visual Thesis
<One sentence: mood, energy, spatial feel. E.g., "Calm productivity panel matching the existing Settings density and restraint.">

### Composition *
- **Primary content zone:** <what dominates the view>
- **Secondary context:** <supporting information>
- **Actions:** <where CTAs live>
- **Reading flow:** <what the user scans first → second → third>
- **What is NOT a card:** <content that should be sections/lists, not cards>

### User Conclusion Test *
- **What the user should believe:** <one sentence, in non-technical language>
- **What must not be implied:** <wrong provider/blame/state/consequence to avoid>
- **Component-correct but product-wrong risk:** <where the right primitive could still fail through width, tone, placement, density, or action hierarchy>

### Control and Recovery
<!-- Required for trust-sensitive surfaces: settings, onboarding, auth, billing, permissions, connectors, destructive actions, recovery flows. -->
| Path | User-visible affordance |
|------|-------------------------|
| Enter state | ... |
| Understand state | ... |
| Fix state | ... |
| Leave state | ... |

### State Matrix *
| State | Visual Treatment | Copy |
|-------|-----------------|------|
| Default (populated) | ... | ... |
| Empty (first use) | ... | ... |
| Empty (cleared) | ... | ... |
| Loading | ... | ... |
| Error (recoverable) | ... | ... |
| Success / completion | ... | ... |

### Content Source *
- **Labels/descriptions:** <where real copy comes from — existing UI, brand voice doc, user-facing strings>
- **Longest expected strings:** <test layout won't break with real data>
- **Error copy pattern:** <what happened → why → what to do>

### Analogous Screens *
- <Existing Rebel screen 1> — <what to match from it>
- <Existing Rebel screen 2> — <what to match from it>

### Interaction Thesis
- <0-3 intentional motions, e.g., "subtle fade-in on section mount, hover lift on interactive cards">
- <If no motion needed, say "no motion — static content">

### Picker Decision
<!-- Filled when `design-system-reviewer` is run in picker mode during planning (see Design-System Review Escalation).
     Capture the tactical answer so the implementer doesn't have to re-derive it. Skip for trivial UI changes. -->
- **User conclusion to preserve:** <what the user should believe after seeing this UI>
- **Component:** <e.g., `Button` — variant `secondary`, size `sm`>
- **Tokens:** <e.g., background `--color-card`, foreground `--color-text-primary`, border `--color-border-soft`>
- **Tier:** shared primitive | app-pattern | organism | local
- **Graduation rationale:** <required for shared/app-pattern/organism: real examples, first consumer, counter-example that stays local, and "too early" boundary>
- **Canonical reference:** <e.g., `src/renderer/features/inbox/components/InboxPanel.module.css` `.card`>
- **Storybook coverage required:** <which stories must exist — embedded/in-context, multi-state, both themes>
- **System gaps surfaced:** <missing tokens or variants flagged honestly, not papered over>
- **Ruled out:** <alternatives considered and why they don't fit>

### Correction Checklist
<!-- Fill when this plan follows user correction or layered feedback. -->
| Concern | Product problem | Action | DSR / implementation implication | Verification surface |
|---------|-----------------|--------|-----------------------------------|----------------------|
| ... | ... | ... | ... | ... |
```

#### Implementer Addendum

Append this to the Implementation Packet's "Definition of Done" section when UI Mode is active.

> **Read first:**
> - The UI Brief section in the planning doc — including the **Picker Decision** subfield if present (the tactical answer from `design-system-reviewer` in picker mode)
> - `skills/ux/rebel-ui-consistency-review/SKILL.md` (canonical UI consistency reference — tokens, theming, typography, interactions, animations, accessibility, copy)
>
> **Before writing code:**
> 1. **If a Picker Decision is present in the UI Brief, treat it as the source of truth for component, variant, tokens, tier, and Storybook coverage.** Do not re-derive or override it — that's what the picker step settled. Skip steps 2–4 in that case.
> 2. If no Picker Decision exists, find the closest existing UI pattern in the codebase. Reference it in your Implementation Notes.
> 3. Read its CSS module to see exact token usage, hover states, theme handling.
> 4. Classify the pattern before extraction: shared primitive, app-pattern/molecule, organism, or local/contextual.
> 5. If your implementation deviates from the reference (or from the Picker Decision), explain why.
>
> **While building:**
> - Use shared UI components from `@renderer/components/ui` when their role matches the job. If a shared primitive would change role, density, hierarchy, or trust semantics, escalate or keep an app-pattern/local treatment with rationale.
> - Use design tokens for ALL spacing, colors, radii — no hardcoded values or magic numbers
> - Use real copy matching Rebel's brand voice (see `docs/project/BRAND_VOICE.md`) — no Lorem ipsum, no TODO, no generic "No items found"
> - Implement ALL states from the State Matrix (empty, loading, error, success) — not just the happy path
> - Keep surface hierarchy calm — strong typography, few colors, minimal chrome
> - Add `data-testid` attributes on key interactive elements for MCP/E2E testing
> - Escalate genuinely new UI patterns to the coordinator — do not improvise novel patterns
>
> Deep checklists (tokens, theme matrix, animation timings, accessibility, copy, anti-patterns) live in the UI consistency skill — follow it rather than duplicating here.
>
> **Self-critique before declaring complete:**
> 1. **Scan test** — reading only headings, labels, and numbers, can you understand the screen?
> 2. **Card-removal test** — remove any card border/shadow; does meaning survive? If yes, it shouldn't be a card.
> 3. **Decoration test** — remove all decorative elements; does the UI still work?
> 4. **Brand test** — does this feel like Rebel, or a generic admin console?
> 5. **Accessibility** — focus-visible on interactive elements, keyboard reachable, color not sole meaning carrier, `prefers-reduced-motion` respected.
> 6. **User-conclusion test** — would a non-technical user believe the intended thing, and not infer the wrong provider/state/consequence?
> 7. **Component-correct but product-wrong test** — does rendered width, placement, wrapping, truncation, tone adjacency, density, or action hierarchy undermine the component choice?
> 8. **Same-class sweep** — if this implements a user correction, did you check sibling variants, both themes, Storybook, and adjacent surfaces?
>
> **UI Verification (mandatory):** Choose the verification surface via `docs/project/AGENT_UI_TESTING.md`.
>
> For live user-change review, use the actual CDP-accessible app as the source of truth (`electron_list_apps` / `electron_list_targets` when available); if it is not visible, record visual capture as blocked rather than substituting another surface.
>
> For isolated smoke verification, run `npm run test:preflight` and the router-selected recipe, usually `scripts/ui-test/launch-rebel-test.ts` or `scripts/drive-packaged-app.ts`. Record screenshot paths only; never embed/base64 image content.
>
> Add to Definition of Done:
> - [ ] UI verification per router: both themes, normal + narrow width, core interaction works

#### Reviewer Addendum

Append this to the Review Packet's "Required Output" when UI Mode is active.

> **Litmus tests:**
> 1. **Scan test:** If you read only headings, labels, and numbers — can you understand the page immediately?
> 2. **Card-removal test:** Are there cards whose borders/shadows could be removed without losing meaning? Flag them.
> 3. **Decoration test:** Is there any purely decorative element that adds no UX value? Flag it.
> 4. **Brand test:** Does this feel like Rebel (calm, capable, minimal), or a generic admin console?
>
> **Consistency checks:**
> - [ ] Design tokens used throughout — no hardcoded colors, spacing, radii
> - [ ] Light AND dark mode work correctly
> - [ ] Shared UI components used where role/density/hierarchy match; justified app-pattern/local exceptions are explicit
> - [ ] Matches the analogous screens referenced in the UI Brief
> - [ ] Cross-surface parity: if similar UI exists on another surface, hierarchy/density/tone are consistent
> - [ ] Storybook, if touched, shows real states and context rather than only a clean demo
> - [ ] Rendered context passes the component-correct/product-wrong check: width, alignment, action placement, tone adjacency, wrapping, truncation, density, and visual priority still match intent
> - [ ] Evidence provenance is valid for the review type; Demo Mode, spawned isolated apps, Storybook, browser screenshots, or OS-region screenshots are not used as proof of the user's current dev-app UI
>
> **State completeness:**
> - [ ] All states from the State Matrix are implemented (empty, loading, error, success)
> - [ ] Error messages tell the user what happened AND what to do
> - [ ] Empty states have encouraging, on-brand copy (not generic "No items found")
>
> **Interaction & accessibility:**
> - [ ] Focus-visible styles on all interactive elements
> - [ ] Keyboard reachable (Tab order follows visual order)
> - [ ] Color is not the sole carrier of meaning
> - [ ] `prefers-reduced-motion` respected for any animations
> - [ ] Fixed/floating UI (header, composer) does not overlap content
> - [ ] Trust-sensitive surfaces expose enter / understand / fix / leave paths
> - [ ] If user feedback was layered, every concern is marked addressed, not addressed, or escalated to Chief Designer
> - [ ] If this review follows a correction, same-class sweep covered sibling variants, both themes, Storybook, and adjacent surfaces or explicitly scoped them out
>
> **Anti-patterns** (flag if present):
> - Card mosaics where cards are not the interaction
> - Thick borders or decorative gradients behind routine UI
> - Multiple competing accent colors
> - Placeholder copy or generic strings
> - Decorative-only motion with no UX purpose
> - Raw `<button>`, `<input>`, or hardcoded styles
> - "Consistent, but wrong" migrations that preserve a component API while changing meaning, density, hierarchy, or trust
> - Flattening visually similar but semantically different patterns, such as tabs/chips/pills, connector chips, composer controls, or card actions
>
> Deep token/theme/typography/animation/accessibility checklists live in `skills/ux/rebel-ui-consistency-review/SKILL.md` — defer to it for the full rubric.

#### Phase 8 — UI Completion Gate

When UI Mode is active, before generating the final summary in Phase 8, run this fail-closed gate:

1. **Determine branch (drives expected evidence):**

   | Branch | Expected captures |
   |---|---|
   | Full visual change recommendation (Chief Designer in CHIEF_ENGINEER + implementation completed) | BEFORE + AFTER in both themes (4 total). Custom-accent theme-cycling unavailable: current theme only (2 total). |
   | Critique-only (Chief Designer ran; no implementation followed) | BEFORE only in both themes (2 total). Custom-accent: 1. |
   | Pure judgment (Chief Designer-only design judgment, no implementation expected) | BEFORE only in both themes (2 total). Custom-accent: 1. Phase 8 gate does not run when no implementation occurred. |
   | DSR standalone (post-hoc review with no upstream Chief Designer) | AFTER only in both themes (2 total). Custom-accent: 1. |
   | No-tool / non-visual / cloud / mobile | 0 captures + required first-line disclosure from typed-error mapping. |

2. **Producer role (chain exit):**
   - If a visual change was implemented and AFTER capture is missing, capture AFTER now (both themes when available; otherwise current theme only for custom-accent constraints) and record paths under `## Visual Evidence (chain exit)` in planning-doc Implementation Notes.
   - For coding-context capture, use the same source-of-truth split as the Implementer Addendum: live user-change evidence must come from the actual CDP app found through `electron_list_apps` / `electron_list_targets` when available; managed smoke verification follows `docs/project/AGENT_UI_TESTING.md`. If the real dev app is not visible, record visual capture as blocked instead of substituting a different window. For in-app Rebel, use `rebel_get_app_screenshot` in the running app.
   - If a visual change was implemented and BEFORE capture is missing, do not silently continue. BEFORE cannot be retroactively captured once the surface changed. Fail closed and surface this message verbatim:

   ```
   Visual review requires a BEFORE capture, taken at chain entry when Chief Designer was invoked. No BEFORE was captured.

   Options:
   1. Re-run the task from Chief Designer with the original surface (revert the implementation, re-capture BEFORE, re-implement).
   2. Proceed with AFTER-only review (mark this as a degraded review in the response; DSR Reviewer critiques AFTER against the diff).
   3. Abort the task.
   ```

   Do not pass this gate without an explicit user choice recorded.

3. **Validator role (evidence quality):**
   - Validate each cited screenshot path exists on disk (file-exists check), not just text presence in notes/output.
   - Accept either path family:
     - `.rebel/screenshots/...` (in-app captures)
     - `docs/project/ux_testing/reports/screenshots/...` (coding-context captures)
   - Validate capture counts match the selected branch matrix above.
   - For the no-tool/non-visual/cloud/mobile branch, validate the recommendation starts with the verbatim first-line disclosure from the typed-error mapping.

4. **Operational UI checks still required:**
   - Confirm MCP verification evidence exists (both themes + narrow-width check when applicable); run it if missing.
   - Confirm all states from the UI Brief State Matrix are implemented.
   - Scan user-facing copy for placeholders/jargon and brand-voice mismatch.

### Design Judgment Escalation

This is the Chief Engineer / Chief Bugfixer hook into the shared [CHIEF_DESIGNER](../../coding-agent-instructions/workflows/CHIEF_DESIGNER.md) workflow. Rebel-specific grounding, evidence rules, output addenda, and DSR handoff expectations live in [Chief Designer Overrides](#chief-designer-overrides).

- **When required:** If a CHIEF_ENGINEER or CHIEF_BUGFIXER task includes material UI/UX or product-design judgment, invoke the `chief-designer` droid before finalizing the plan or fix approach.
- **Trigger test (mechanical):** Fire if the change touches **any** of:
  - **IA** — information architecture, surface structure, what's grouped where
  - **Naming** — user-facing concept names, labels, terminology
  - **Hierarchy** — what's primary / secondary, scan order, visual weight
  - **Trust / reversibility** — how the user verifies what happened, undoes, recovers control
  - **State design** — empty, loading, error, success, partial, attention-needed states
  - **Copy direction** — error messages, empty-state copy, microcopy with material tone or clarity stakes
  - **Reuse-vs-new pattern decisions** — whether an existing shared/app-pattern family is sufficient or a new one is warranted

  **When in doubt, fire.** A Chief Designer consult is cheap; a wrong design call is not.
- **Fires independently of UI Mode:** This trigger applies even when no visible UI changes. A backend-only change that reshapes user trust, naming, recovery flows, permissions, or how the user understands the system still requires Chief Designer. UI Mode covers operational implementation (tokens, themes, MCP verification, state matrix); Design Judgment Escalation covers product-design judgment. Both can fire — independently or together.
- **Wired into the workflow at:**
  - **CHIEF_ENGINEER2:** Phase 0 Design Judgment detection (logged) and Phase 2 critique (invoked alongside reviewers and specialists). See [CHIEF_ENGINEER2 § Phase 0](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md#phase-0--intake--setup) and [§ Phase 2 — Planning (Critique step)](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md#phase-2--planning).
  - **CHIEF_BUGFIXER:** Phase 0 Design Judgment detection (logged) and Phase 3 Fix Design Checkpoint (invoked alongside the Fix Design reviewer). See [CHIEF_BUGFIXER.md § Phase 0](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md#phase-0-bug-intake--evidence-gathering) and [§ Phase 3](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md#phase-3-diagnosis-synthesis-you-do-this).
- **How to ground it:** `chief-designer` follows the shared Chief Designer workflow plus this file's [Chief Designer Overrides](#chief-designer-overrides). Ask it to make the IA/component/naming/state decision when enough product facts are known, with one primary recommendation, key risks, system effects, missing evidence, accessibility concerns, and which existing shared/app-pattern families should be reused or explicitly ruled out.
- **Required judgment gates:** Ask Chief Designer to include the user-conclusion test for trust/status/recovery/settings semantics, the control-and-recovery path for trust-sensitive surfaces, and a correction checklist when the prompt follows layered user feedback.
- **Scope:** This is a design-judgment checkpoint, not a substitute for UI Mode implementation/review.
- **Hand-off to picker:** Once `chief-designer` settles the design intent and the implementation will involve concrete component, variant, token, or Storybook choices, run `design-system-reviewer` in **picker mode** (see Design-System Review Escalation, below) to translate the intent into a tactical answer before locking the plan.

### Design-System Review Escalation

`design-system-reviewer` runs in two modes. Both are grounded in `rebel-system/skills/ux/design-system-reviewer/SKILL.md`. Use the mode the situation calls for.

#### Picker mode — Phase 2 (planning)

- **When required:** After `chief-designer` has established design intent (Design Judgment Escalation, above), and the implementation will involve concrete component, variant, token, or Storybook choices. Also for self-contained UI tasks where the intent is already clear and only the tactical answer is needed.
- **What to ask for:** Translate the design intent into a tactical answer — which existing component, variant, size, tokens, and Storybook precedent to use; which tier the UI belongs to (shared / app-pattern / organism / local); what Storybook coverage is required; what (if anything) is missing from the system. Cite the canonical reference implementation.
- **Required tactical gates:** Ask for the user conclusion the component must preserve and, when recommending shared/app-pattern/organism graduation, the real examples, first real consumer, counter-example that stays local, overrides required if shared, and "too early" boundary.
- **Where the output goes:** Capture the picker decision in the planning doc's UI Brief section under a `### Picker Decision` subfield so the implementer in Phase 4 has a concrete tactical answer to build against — instead of improvising component/token choices themselves.

#### Reviewer mode — Phase 5 (stage review) or Phase 7 (final review)

- **When required:** When the implementation changes shared UI primitives, Storybook review pages, componentisation, shared/app-pattern migration, size/variant contracts, focus ownership, or local-vs-shared semantics. Run after implementation, before completion.
- **What to ask for:** Verify the implementation preserved before/after role, density, hierarchy, state clarity, and trust semantics. Catch "consistent, but wrong" regressions where a shared primitive made meaning, hierarchy, or trust worse. Verify Storybook honesty (real states + context, not only pristine demos).
- **Required review gates:** Include evidence provenance, layered feedback coverage when relevant, and same-class sweep status when the review follows a correction.
- **Scope:** This is a migration-safety and design-system contract checkpoint.

Escalate back to `chief-designer` only if the product direction itself turns out to be unresolved (e.g., the picker discovers the intent doesn't fit any existing tier and a product-direction call is needed first).

### Build Validation Details

> For the full build/run command reference, see `AGENTS.md` → Build & Run. The validation commands table above is the canonical source for workflow-specific validation.

**Key workflow-specific note:** `validate:fast` alone is NOT sufficient for workflow completion — it catches type/lint errors but misses Vite/bundler import resolution failures. Always use `verify:agent:full` (which includes the production build) at Phase 8 (Completion).

### Rebel CLI Standalone Binary (Stage 8–9)

The standalone Node `rebel` binary lives at `scripts/rebel-cli/`. It is the fast cold-start CLI path (~442 ms vs 1–3 s for Electron-backed) with env-var-only auth. See [`docs/project/HEADLESS_CLI_ENTRYPOINT_REFERENCE.md`](HEADLESS_CLI_ENTRYPOINT_REFERENCE.md) for the full two-path model.

**Building locally:**
```bash
node scripts/rebel-cli/build.mjs
# output: scripts/rebel-cli/dist/rebel.js
```

**Installing locally for dev testing:**
```bash
# links the built binary to the global prefix so `rebel --version` works
npm link --prefix scripts/rebel-cli
# or run directly:
node scripts/rebel-cli/dist/rebel.js <command>
```

**Dev smoke test:**
```bash
REBEL_USER_DATA=$(mktemp -d) node scripts/rebel-cli/dist/rebel.js smoke-test
```

**Running tests:**
```bash
npx vitest run scripts/rebel-cli/ --no-coverage
```

**Package integrity:**
```bash
npm ci --prefix scripts/rebel-cli
npm audit --prefix scripts/rebel-cli --audit-level=moderate
npm ls --prefix scripts/rebel-cli --all
```

**Stage 9 note:** The standalone binary is published to npm as `@mindstone/rebel-cli` and bundled inside the .app. CI publishes via `[deploy-cli]` on push-to-main. See `docs/project/CI_PIPELINE.md`.

### Testability Specialist Reference

Uses the decision matrix from [TESTING_AUTOMATION_OVERVIEW](TESTING_AUTOMATION_OVERVIEW.md). Verification ladder: code health → unit → integration → MCP UI → E2E → evals → specialist suites.

---

## Chief Bugfixer Overrides

### Project-Specific Investigation Lenses

| Lens | When | What |
|------|------|------|
| **Electron / Process Boundary** | Bug involves IPC, preload, window lifecycle, dev-vs-packaged paths | Trace across: contract → bridge → contextBridge → handler → cloud routing. Check dev-vs-packaged differences. |

### Bug Reporter Domain

- **Internal domains:** `@example.com`
- **External handling:** When closing an externally-reported Sentry issue or Linear ticket, draft a brief, user-facing response explaining the fix.

### Conversation Diagnosis

- **Diagnosis doc:** `docs/project/DIAGNOSE_ONE_OF_MY_CONVERSATIONS.md`
- **Conversation URL scheme:** `rebel://conversation/{id}`
- **Usage:** For bugs discovered from a conversation diagnosis, the diagnosis workflow produces evidence and a diagnosis doc that feeds into the Chief Bugfixer.

---

## Rename Refactor Overrides

### Project-Specific Surfaces

| Surface | Location | Agent-Readable? | Priority |
|---------|----------|-----------------|----------|
| Built-in skills | `rebel-system/skills/` | Yes | P0 |
| Help docs | `rebel-system/help-for-humans/` | Yes | P0 |
| Agent instructions | `coding-agent-instructions/` | Yes | P1 |
| UI strings | `src/renderer/` | No | P0 (user-facing) |
| MCP tool IDs | `rebel_inbox_*` etc. | No | P2 — backwards-compat alias required |
| IPC channels / Zod schemas | `src/shared/ipc/contracts.ts` | No | P2 — requires migration |
| Electron store keys | User preferences, feature flags | No | P2 — requires migration script |
| Core business logic | `src/core/` | No | P2 |
| Cloud service | `cloud-service/` | No | P2 |

### Backwards Compatibility Constraints

- **MCP tool IDs** (`rebel_inbox_*`, etc.) — renaming breaks clients. Alias indefinitely.
- **IPC channels** — require migration, not just rename. See `src/shared/ipc/contracts.ts`.
- **Electron store keys** — require migration script to preserve user data. See `electron-store` initialization.
- **Submodule commit order:** If the rename touches `rebel-system` or `coding-agent-instructions`, commit and push submodule changes first, then the superproject pointer.

### Verification Commands

See [Validation Commands](#validation-commands) above for the full command matrix.

---

## Notes

- This file is the single source of truth for Rebel-specific workflow configuration.
- The shared `coding-agent-instructions/` workflows reference this file but never contain Rebel-specific content.
- Keep this file current when adding new droids, changing validation commands, or modifying architecture.
- Full droid catalog and selection guide: [SUBAGENT_REFERENCE](SUBAGENT_REFERENCE.md)
