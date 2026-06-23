# UI Componentisation Map

Purpose: move toward "everything repeated is a component", while still rolling adoption back into the app gradually and safely.

This is not the same as "everything becomes a primitive." The working model is:

- `primitive` - generic shared UI building blocks
- `pattern` - shared product-level components that compose primitives
- `local` - one-off or not-yet-promoted UI

Current decision rule:

- If a UI shape appears in **3+ places**, it is a candidate for shared componentisation.
- Shared candidates should define:
  - sizes
  - variants
  - states
  - token usage
  - usage rules

## Storybook role in this system

Storybook should support componentisation, not replace it.

- **Code is the source of truth** for implementation, tokens, and behavior.
- **Storybook is the preview/review layer** for comparing states, variants, and composition patterns.
- **Judgment docs** should explain when a family is a primitive, a pattern, or intentionally local.

That means:

- do not create fake shared components just to fill Storybook
- do create honest Storybook pages for repeated app patterns that need review before promotion
- do pair the most ambiguous families with short written guidance about reuse, exceptions, and trust/accessibility expectations

## Highest-priority candidates

| Candidate | Classification | Why share it | Current evidence / source areas | Notes |
|---|---|---|---|---|
| `IconButton` | `primitive` | Repeated icon-only controls with inconsistent sizing, hit area, and active states | `src/renderer/features/composer/components/MentionHeroInput.tsx`, `src/renderer/features/document-editor/components/DocumentHeader.tsx`, `src/renderer/features/agent-session/components/SessionListItemActions.tsx`, `src/renderer/features/focus/FocusPanel.tsx` | Should likely support square/icon-only sizes and pressed/active states |
| `Chip` / `PillButton` family | `primitive` | Repeated pill-like UI across filter, metadata, status, and disclosure use cases | `src/renderer/features/settings/components/ConnectionChip.tsx`, `src/renderer/features/library/components/FrontmatterPill.tsx`, `src/renderer/features/agent-session/components/InsightsPill.tsx`, `src/renderer/components/ContributionPill.tsx`, `src/renderer/features/onboarding/components/StepPill.tsx` | Probably a family, not one mega-component |
| `ToggleField` / `SwitchRow` | `pattern` | Settings and safety toggles need consistent layout, help text, status, and badges | `src/renderer/features/settings/components/SlackMentionToggle.tsx`, `src/renderer/features/settings/components/sections/FocusToggleSection.tsx`, `src/renderer/features/settings/components/sections/SystemExperimentalFeaturesSection.tsx`, `src/renderer/features/settings/components/tabs/AgentsTab.tsx` | Split low-level switch primitive from higher-level row pattern |
| `EmptyState` | `pattern` | Empty states are repeated and highly inconsistent in structure and CTA treatment | Diagnostics tabs, library tabs, inbox, settings, homepage, automations | Keep richer onboarding/conversation empty states separate if needed |
| `StatusDot` / `InlineStatusIndicator` | `primitive` | Repeated micro-status patterns for loading, good, warning, and error states | `src/renderer/features/operators/components/OperatorStatusDot.tsx`, focus cards, `src/renderer/components/RecordingStateIndicator.tsx`, `src/renderer/features/app-bridge/BrowserContextChip.tsx` | Useful foundation for richer pattern components |
| `SegmentedTabStrip` / `FlowChipTabs` | `pattern` | App shell tabs and similar "flow-chip" controls are not the same as content tabs | `src/renderer/features/flow-panels/FlowPanelsShell.tsx`, `src/renderer/styles/layout/app-shell.css`, `src/renderer/features/settings/components/tabs/UsageTab.tsx` | Keep distinct from generic `ui/Tabs` |

## Existing shared layer vs rollout targets

### Already shared in `src/renderer/components/ui`

- `Button`
- `Input` / `Textarea` / `Label`
- `Select`
- `RichSelect`
- `Tabs`
- `Card`
- `Badge`
- `Dialog`
- `Tooltip`
- `Spinner`
- `SplitButton`

### Shared next (recommended)

- `IconButton`
- `Chip` base
- `PillButton`
- `Toggle`
- `ToggleField`
- `EmptyState`
- `StatusIndicator`
- `FlowChipTabs`

## Sizes to formalise

These should be explicitly documented for each shared candidate:

- `xs`
- `sm`
- `md`
- `lg`
- `icon`
- `compact`

Not every component needs every size, but each component should have an intentional size matrix rather than ad hoc CSS.

## Rollout strategy

1. Keep building Storybook previews for both:
   - shared primitives
   - real app patterns
2. Add lightweight judgment docs for important families so Storybook does not carry design rationale by itself.
2. Promote repeated local patterns into shared components **without** immediately rewriting every caller.
3. Replace old local implementations surface by surface.
4. Track remaining local uses until the rollout is complete.

## Current progress snapshot

### Shared atoms now materially established

- `IconButton` exists in `src/renderer/components/ui/` and has initial app adoption.
- `Toggle` exists in `src/renderer/components/ui/` and has initial Settings adoption.
- `Select` remains the shared atom and is being adopted more consistently in Settings.
- `Button` was simplified by removing unused `tertiary`, and its review/docs now record intended usage.

### Storybook review progress

Key Storybook pages are increasingly being normalized so they answer:

- what this family is
- how it should be used
- where it is used now
- what it should not be used for

This has now been applied across the main atom/molecule pages rather than only the button page.

### Remaining consistency work

- continue real atom adoption in Settings
- then Homepage
- then Inbox
- add missing review pages for connector-chip taxonomy and larger organism-level structures

## Recommended review/build order

1. Make Storybook trustworthy as a review surface.
2. Promote highest-frequency primitives:
   - `IconButton`
   - `Toggle`
   - `ToggleField`
3. Promote repeated product patterns:
   - card footer/action hierarchy
   - `Chip` / `Pill` family
   - `FlowChipTabs`
   - `EmptyState`
4. Expand coverage to more bespoke surfaces only after the system-level rules are clear.

## Useful companion files

- `src/renderer/components/ui/manifests/ui_component_token_inventory.md`
- `docs/plans/260423_ui_system_taxonomy_first_pass.md`
- `docs/plans/260423_iconbutton_judgment_doc.md`
- `docs/plans/260423_select_dropdown_judgment_doc.md`
- `docs/plans/260423_settings_row_judgment_doc.md`
- `docs/plans/260423_connector_chip_taxonomy_judgment_doc.md`
- `docs/plans/260423_settings_header_and_subtabs_judgment_doc.md`
- `docs/plans/260423_decision_card_group_judgment_doc.md`
- `docs/plans/260423_dashboard_action_panel_judgment_doc.md`
- `docs/plans/260423_action_card_cta_judgment_doc.md`
- `docs/plans/260423_composer_suggestion_chips_judgment_doc.md`
- `docs/plans/260423_atomic_glossary_for_rebel_ui.md`
- `docs/plans/260423_settings_header_hierarchy_judgment_doc.md`
- `docs/plans/260423_storybook_atomic_review_information_architecture.md`
- `src/renderer/components/ui/AppPatterns.stories.tsx`
- `src/renderer/components/ui/Overview.stories.tsx`
