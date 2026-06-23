---
description: "Settings and form page conventions — SettingSection, SettingRow, hierarchy, spacing, tooltips, collapsible sections"
last_updated: "2026-06-20"
---

# UI Settings & Forms

Layout patterns, visual hierarchy rules, and component conventions for settings screens and form-style pages in Mindstone Rebel.

These rules were extracted from the AI & Models settings cleanup (March 2026) and codify the patterns that make settings pages scannable, consistent, and accessible.

## See Also

- [UI_OVERVIEW.md](UI_OVERVIEW.md) — High-level UI layout and surfaces
- [UI_CSS_ARCHITECTURE.md](UI_CSS_ARCHITECTURE.md) — Design tokens, theming, CSS modules
- [DESIGN.md](DESIGN.md) — Branding, iconography, visual design choices
- [`rebel-ui-consistency-review` skill](../../skills/ux/rebel-ui-consistency-review/SKILL.md) — Cross-reference checklist for all UI work
- [`SettingSection.tsx`](../../src/renderer/features/settings/components/SettingSection.tsx) — Section component (regular + collapsible)
- [`SettingRow.tsx`](../../src/renderer/features/settings/components/SettingRow.tsx) — Two-column row component
- [`SettingSection.module.css`](../../src/renderer/features/settings/components/SettingSection.module.css) — Section CSS
- [`SettingRow.module.css`](../../src/renderer/features/settings/components/SettingRow.module.css) — Row CSS


## Page Structure

Every settings/form page follows this hierarchy:

```
Page Header (title + description)
├── Section 1 (SettingSection)
│   ├── Row (SettingRow) — label left, control right
│   ├── Row
│   └── ...
├── Section 2 (SettingSection)
│   ├── Subsection (SettingSection, collapsible via `advanced`)
│   │   └── Rows...
│   └── Row
└── Section 3 (SettingSection)
    └── ...
```

**Rules:**
- Sections are separated by `border-top: 1px solid var(--color-border-soft)` and `padding: var(--space-6) 0`
- The first section omits the top border
- Every section has a `title` and a `description` — descriptions help users understand what they're looking at
- Use `data-section` attributes for deep-link scrolling


## Visual Hierarchy (3 Levels)

| Level | Component | Font | Use |
|-------|-----------|------|-----|
| **Section** | `SettingSection` | 1.1rem, weight 600 | Top-level grouping (e.g., "Authentication", "Model", "File Indexing") |
| **Subsection** | `SettingSection` (nested) | 0.95rem, weight 600 | Sub-grouping within a section (e.g., "Anthropic", "OpenAI" under Authentication) |
| **Row** | `SettingRow` | 0.875rem, weight 500 | Individual setting (label + control) |

**Key principle:** Size, weight, and spacing decrease at each level. Users should instantly understand the grouping hierarchy by scanning.


## SettingRow — The Standard Layout Primitive

Use `SettingRow` for **every** label + control pair. Never use `compactSelect`, inline labels, or custom flex layouts for settings.

```tsx
<SettingRow
  label="Working model"
  tooltip="The primary AI model for conversations."
  description="Optional description below the label."
  htmlFor="claude-model"
>
  <select id="claude-model" ...>
    ...
  </select>
</SettingRow>
```

**Layout:** Two-column grid (`1fr 1fr`). Label left, control right. Consistent alignment across all rows.

**Props:**
| Prop | Purpose |
|------|---------|
| `label` | Always required. Short, descriptive name. |
| `tooltip` | Explain what this setting does. Use for anything non-obvious. Shows a `?` icon. |
| `description` | Secondary text below the label. For conditional context or longer explanations. |
| `htmlFor` | Wire the label to the control for accessibility. Always set for form inputs. |
| `variant="stacked"` | Single-column layout for wide controls (e.g., full-width text inputs). |
| `badge` | Trailing element after the label (e.g., "(optional)" badge). |

**When to use `variant="stacked"`:** Only for controls that need the full width — typically password/text inputs. Selects, checkboxes, and toggles use the default two-column layout.

**Spacing:** Rows have `padding: var(--space-2) 0` and `border-bottom: 1px solid var(--color-border-soft)`. The last row in a group has no bottom border.


## Collapsible Sections (Accordion Pattern)

Use `SettingSection` with `advanced` prop for content that benefits from progressive disclosure:

```tsx
<SettingSection
  title="OpenAI"
  description="Voice, image generation, and GPT models"
  advanced
  defaultExpanded={!!draftSettings.providerKeys?.openai}
  data-section="openai"
>
  <SettingRow label="API key" htmlFor="provider-openai-key" variant="stacked">
    <input type="password" ... />
  </SettingRow>
</SettingSection>
```

**Rules:**
- `defaultExpanded` — Expand sections that have user data (e.g., configured API keys). Collapse empty/optional sections.
- **Content indentation** — Nested accordion content uses `padding-left: 26px` (aligns with text after the chevron + gap). This is handled by `.section .section .advancedContent` in `SettingSection.module.css`.
- **Title sizing** — Nested section titles use 0.95rem (vs 1.1rem for top-level) via `.section .section .advancedTitle`.
- **Don't over-nest** — Maximum 2 levels of nesting. If you need a third level, rethink the grouping.
- **Always render content in DOM** (hidden when collapsed) so `useScrollToSection` can find `data-section` elements and auto-expand.

**When to use collapsible vs flat:**
| Pattern | Use when |
|---------|----------|
| **Flat rows** | Settings the user configures frequently or needs to scan at a glance |
| **Collapsible** | Optional/advanced settings, provider-specific blocks, anything that reduces cognitive load when hidden |


## Card-Grid Selection Pattern (Provider Cards)

For choices that benefit from **branded visuals, contextual actions, and richer descriptions** than a dropdown or radio group can provide, use the **provider card grid** pattern. Currently used for AI provider selection in both Settings (`AgentsTab.tsx`) and Onboarding (`ApiStep.tsx`).

### Layout

Cards use `providerCardGrid` from `SettingsSurface.module.css`:

```css
.providerCardGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3, 12px);
  align-items: stretch;
}
```

Each card (`providerCard`) is a flex column with header (logo + title), body (description), and footer (actions + status). Selected state uses `providerCardSelected` with an accent border.

### ARIA Pattern

The grid uses `role="listbox"` with each card as `role="option"` and `aria-selected` for the active choice. Cards are focusable via `tabIndex={0}`.

### Card Anatomy

```
┌──────────────────────────────────┐
│  [Logo] Title  (recommended)     │  ← providerCardHeader
│                                  │
│  Description text explaining     │  ← providerCardBody
│  what this provider does.        │
│                                  │
│  [Help link]     [Connect btn]   │  ← providerCardFooter
│                  or ✓ Connected  │
└──────────────────────────────────┘
```

### When to Use Cards vs SettingRow

| Pattern | Use when |
|---------|----------|
| **SettingRow** | Standard label + control pairs (selects, checkboxes, text inputs) — the default for all settings |
| **Card grid** | Mutually exclusive choices with branding, inline OAuth flows, or contextual help links that would be too complex for a dropdown |

**Rules:**
- Card grids live **inside** a `SettingSection`, not as standalone top-level content
- Reuse the shared `providerCard*` CSS classes from `SettingsSurface.module.css` — do not create one-off card styles
- Cards in Onboarding import Settings styles (`settingsStyles`) to maintain visual consistency across surfaces
- Each card should have a `data-section` attribute for deep-link scrolling and search index targeting
- Keep descriptions short (1-2 sentences) and non-technical — target audience is knowledge workers, not developers

**Key code:**
- `src/renderer/features/settings/components/SettingsSurface.module.css` — `providerCardGrid`, `providerCard`, `providerCardSelected`, and related classes
- `src/renderer/features/settings/components/tabs/AgentsTab.tsx` — Settings implementation (Connection section)
- `src/renderer/features/onboarding/steps/ApiStep.tsx` — Onboarding implementation (reuses Settings card styles)


## Tooltips

**Every non-obvious setting should have a tooltip.** Knowledge workers are the target audience — don't assume they know what "Thinking model" or "Permission mode" means.

**Rules:**
- Use the `tooltip` prop on `SettingRow` (renders a `?` HelpCircle icon)
- Keep tooltip text to 1-2 sentences
- Explain what the setting does, not how to use it
- For complex settings with multiple options, briefly describe each option in the tooltip
- Don't duplicate tooltip content as a separate hint paragraph below the control

**Good:**
```tsx
tooltip="The primary AI model Rebel uses for conversations. This model writes, edits, and responds to your messages."
```

**Bad:**
```tsx
// Separate hint paragraph duplicating what the tooltip says
<p className={styles.modelConfigHint}>This model writes and edits content.</p>
```

**Exception:** Dynamic hints that change based on state (e.g., "Enabled. Configure model profiles above.") are acceptable as separate paragraphs since tooltips are static.


## Feature Maturity Badges

Use `MaturityBadge` from `@renderer/components/ui` to indicate when a feature is pre-stable. The badge renders an icon-only button that opens the community forum on click.

**Source:** [`MaturityBadge.tsx`](../../src/renderer/components/ui/MaturityBadge.tsx)

### Levels

| Level | Icon | When to use |
|-------|------|-------------|
| `labs` | FlaskConical | Experimental — may not work, could be removed |
| `early` | (text "Early") | Actively shaping based on feedback |
| `beta` | FlaskConical | Works well but still being refined |

### Placement

**In a SettingSection title** (preferred for settings pages):
```tsx
<SettingSection
  title="Meeting Notetaker"
  badge={<MaturityBadge level="beta" featureName="Meeting Notetaker" />}
>
```

**Inline with text** (custom headers, card titles):
```tsx
<h4>Add cloud continuity <MaturityBadge level="beta" featureName="Cloud Continuity" /></h4>
```

**Rules:**
- Use the `badge` prop on `SettingSection` or `SettingRow` — don't render as a standalone child element
- One badge per section/feature, placed next to the title
- Include `featureName` for tracking context
- Use `tooltip` prop to override the default tooltip when needed (e.g., `tooltip=""` to suppress)


## Colors and Theming

- **All colors must use design tokens.** No hardcoded hex values.
- Use `var(--color-text-primary)`, `var(--color-text-secondary)`, `var(--color-text-muted)` for text
- Use `var(--color-success)`, `var(--color-destructive)`, `var(--color-warning)` for status
- Use `var(--color-accent)` for interactive/brand elements
- **Light mode overrides** use `:global(body.light) .className` pattern in CSS modules
- Elements with `rgba(255, 255, 255, ...)` backgrounds in dark mode always need a light mode override

See [UI_CSS_ARCHITECTURE.md](UI_CSS_ARCHITECTURE.md) for the full token reference.


## Copy and Labels

- **Labels:** Short, descriptive, title case. "Working model" not "working model" or "WORKING MODEL".
- **Descriptions:** Sentence case, muted color, 1-2 sentences max. Explain the purpose, not the mechanics.
- **Section titles:** Use the least technical term that's still accurate. Prefer "Authentication" over "API Keys" or "Provider Configuration".
- **Tooltips:** Plain language. Avoid jargon. Write for a PM or executive, not a developer.
- **Placeholders:** Show the expected format. "sk-ant-..." not "Enter your key here".

See [BRAND_VOICE.md](BRAND_VOICE.md) for overall voice guidelines.


## Anti-Patterns

| Don't | Do instead |
|-------|------------|
| `<div className={styles.compactSelect}>` with inline label + select | `<SettingRow label="..." htmlFor="...">` |
| `style={{ color: '#ef4444' }}` | `var(--color-destructive)` in CSS module |
| `style={{ maxWidth: '280px' }}` on controls | Let `SettingRow`'s grid handle width |
| Inline `<div style={{ borderTop: '...' }}>` dividers | `SettingRow`'s built-in `border-bottom` |
| Separate `<p>` hint duplicating a tooltip | Use `tooltip` prop on `SettingRow` |
| Deeply nested SettingSections (3+ levels) | Flatten to 2 levels, use collapsible for the second |
| `compactSelect` for forms/settings | Reserved for inline controls in non-form contexts only |
| `<MaturityBadge>` as a standalone child element | Use `badge` prop on `SettingSection` or `SettingRow` |


## Checklist for New Settings Pages

Use this when building or reviewing a settings/form screen:

- [ ] Page has a header with title and description
- [ ] Content is organized into `SettingSection` groups with titles and descriptions
- [ ] All label + control pairs use `SettingRow` (not custom layouts)
- [ ] All controls have `htmlFor` wiring for accessibility
- [ ] Non-obvious settings have `tooltip` explanations
- [ ] Collapsible sections use `SettingSection advanced` with appropriate `defaultExpanded`
- [ ] Nested accordion content is indented (handled by CSS, verify visually)
- [ ] No hardcoded colors — all values use design tokens
- [ ] Works in both light and dark mode
- [ ] `data-section` attributes set for deep-link scrolling
- [ ] Copy follows brand voice: clear over clever, non-technical language
- [ ] No inline style dividers or maxWidth constraints — components handle spacing


## Flag-gated "Backup connections" section (multi-provider foundation)

> **Default-off / inert.** This is foundation work behind the experimental flag
> `experimental.multiProviderRoutingEnabled` (optional boolean, **default off** — `src/shared/types/settings.ts`, `src/shared/ipc/schemas/settings.ts`). With the flag off there is **no user-visible behaviour**: the section is hidden in Settings and the router ignores the backup chain entirely. Don't describe it as a live user feature.

The "Backup connections" section ([`BackupConnectionsSection.tsx`](../../src/renderer/features/settings/components/BackupConnectionsSection.tsx)) lets a user order a provider failover chain ("main + backups"). It's rendered inside the Agents tab ([`AgentsTab.tsx`](../../src/renderer/features/settings/components/tabs/AgentsTab.tsx) — `BackupConnectionsSection` is gated on `draftSettings.experimental?.multiProviderRoutingEnabled === true && !isMindstoneActive && isActiveProviderConnected`). So it's hidden unless the flag is on, the active provider isn't Mindstone (managed subscription is a later phase), and the active provider is connected.

**`activeProvider` ↔ `enabledProviders` write contract.** Edits go through `writeProviderList` (Stage 6a writer in [`settingsUtils.ts`](../../src/shared/utils/settingsUtils.ts)), which writes the ordered `enabledProviders` list **and** sets `activeProvider` to the list head atomically, maintaining the invariant `activeProvider === enabledProviders[0]`. The editor reads the chain via `getDisplayProviderChain` (active-at-head display view) — never `getEnabledProviders` directly from the renderer (that's the router's raw-priority read). Both helpers live in `settingsUtils.ts`.

**Search-index registration.** Registered in [`searchIndex.ts`](../../src/renderer/features/settings/searchIndex.ts) as `{ tab: 'agents', section: 'backupConnections', ... }` (keywords: backup, fallback, failover, rate limit, provider order, …), satisfying the bidirectional drift gate below (`backupConnections` is a real `data-section` with a matching search entry).

→ Routing/failover side: [SMART_MODEL_PICKING](./SMART_MODEL_PICKING.md), [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md). Plan: `docs/plans/260618_multiprovider-foundation/PLAN.md`.


## Search Index Sync — Intent & Design Rationale

Settings search (`SETTINGS_SEARCH_INDEX` in [`searchIndex.ts`](../../src/renderer/features/settings/searchIndex.ts)) is a **static, hand-authored index** — this is deliberate. The index was shipped as a static v1 during the settings redesign (Stage 9, March 2026) because it allows keyword enrichment beyond what component metadata can provide (e.g. "text too small" → Font size, "when task finishes" → Automation notifications) and avoids coupling search results to the render lifecycle.

**Why not runtime auto-registration?** Explicitly rejected. Auto-registration ties search discovery to React mount order, can't include synonym keywords, and introduces coupling between search behavior and component lifecycle. The user's rationale: static is simpler, more predictable, and lets humans curate search quality.

**Keeping it in sync.** A CI validation script ([`check-settings-search-index.ts`](../../scripts/check-settings-search-index.ts)) performs bidirectional drift detection — every `data-section` attribute in settings components must have ≥1 matching search entry (or be explicitly allowlisted), and every `section` in the index must reference a `data-section` that exists. This runs as part of `validate:fast`.

**Constraints for future work:**
- **Static index is deliberate** — do not replace with runtime registration without a strong reason and user approval.
- **`data-section` values are part of the navigation contract** — they drive deep-link scrolling, on-page anchors, and search targeting. Renaming or removing a value requires updating the search index, navigation contract, and anchor config.
- **Composite sections use an allowlist** — wrapper anchors (`supportDiagnostics`, `developerTools`, `labsPlugins`) and sub-sections of indexed parents (`apiKey`, `otherProviders`) are intentionally unindexed. Their children carry the search entries.
- **Typed section union was deferred, not rejected** — a `SettingsSectionId` union type would add compile-time safety but was too invasive for the initial implementation. The validation script is the incremental step.

> **Planning doc:** [`docs/plans/260402_settings_search_index_sync.md`](../plans/260402_settings_search_index_sync.md) — full research, gap analysis, review history, and rejected alternatives.
