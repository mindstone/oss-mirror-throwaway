# UI Components

ShadCN-based primitives themed to match Mindstone Rebel's design system.

## Usage

```tsx
import { Button, IconButton, IconTile, ConversationPill, PageHeader, SectionHeader, Dialog, Input, Tabs, Card, Badge, Toast, Tooltip, Spinner, RebelLoadingIndicator } from '@renderer/components/ui';
```

### Icons

All UI icons use `lucide-react`:

```tsx
import { Mic, Settings, ChevronDown, X, Search, Trash2 } from 'lucide-react';

// Use size prop
<Mic size={20} />

// Or className with Tailwind
<Settings className="w-5 h-5" />
```

See `docs/project/DESIGN_ICONS.md` for full icon guidelines.

## Available Components

### Button
Primary interaction element with multiple variants. All buttons use a consistent 12px border radius.

```tsx
<Button variant="default">Default</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="outline">Outline</Button>
<Button variant="ghost">Ghost</Button>
<Button size="sm">Small</Button>
<Button size="lg">Large</Button>  {/* Use for primary CTAs in onboarding/hero sections */}
```

**Sizes:** `sm` (h-8, tighter gap, 8px radius, 12px font, 14px icon), `default` (h-10, 16px icon), `lg` (h-12, 16px font, 16px icon, wider padding)

**Current usage guidance:**
- `default` - stronger primary CTAs and setup actions
- `secondary` - soft filled secondary action for calm card CTAs and app-level actions like New
- `ghost` - the most common quiet action style
- `outline` - bounded action with a visible frame; keep separate from secondary
- `destructive` - clearly dangerous action, now styled to read as destructive

**Interaction guidance:**
- Button hover should stay visually flat - use background, border, contrast shifts, and soft outer shadow rather than lift/3D motion or inner gloss effects.
- `secondary` should remain clearly readable on dark card backgrounds.

**Decision rule:**
- The intended usage rules matter more than the current usage snapshot. If the app is using a variant incorrectly, update the app - do not expand the atom family just to accommodate inconsistent existing usage.

### IconButton
Compact icon-only action atom for toolbars, inline actions, and utility controls.

```tsx
<IconButton aria-label="Search">
  <Search size={18} />
</IconButton>
<IconButton variant="subtle" aria-label="Notifications">
  <Bell size={16} />
</IconButton>
<IconButton active aria-label="Recording is on">
  <Mic size={18} />
</IconButton>
```

**Sizes:** `xs` (28px, dense filters and compact toolbar actions), `sm` (32px, top-bar actions), `md` (36px, session controls), `lg` (40px, larger toolbar and hero-input affordances)

Use `IconButton` for icon-only utility actions. Do not use it for primary CTAs, icon+text buttons, or the composer submit arrow.

**Variant guidance:**
- `framed` (default) - visible square icon buttons with grey stroke/fill, used for app chrome, top bars, filters, and standalone toolbar controls.
- `ghost` - embedded icon controls inside an input or dense surface where a visible square container would add noise, such as composer mic/attachment affordances.
- `subtle` - slightly stronger framed treatment when the control needs more affordance but is still not a primary action.

Preserve the original visual role when migrating local buttons: if a control was borderless/embedded before, use `variant="ghost"`; if it was a square stroked app-chrome button, use the default framed variant.

### IconTile
Non-interactive square category marker for cards, rows, and dashboard summaries.

```tsx
<IconTile icon={Calendar} tone="meeting" />
<IconTile icon={Inbox} tone="inbox" />
<IconTile icon={Zap} tone="automation" />
```

Use `IconTile` when the icon labels a type of content. Use `IconButton` when the icon performs an action.

### DecisionCardGroup
Visible comparison molecule for a small set of meaningful choices.

```tsx
<DecisionCardGroup
  aria-label="Meeting join behavior"
  value={joinMode}
  onValueChange={setJoinMode}
  options={[
    {
      id: 'prompt',
      icon: MessageCircleQuestion,
      title: 'Ask me first',
      description: 'Rebel asks before joining.',
      footer: 'Prompt before joining',
    },
  ]}
/>
```

Use `DecisionCardGroup` when users need to compare consequences, not for low-ambiguity form fields. Descriptions start from the card's left edge, while the icon and title form the header.

### Notice
Persistent in-flow banner for status, attention, prerequisites, and recovery prompts.

```tsx
<Notice
  tone="warning"
  placement="section"
  title="Enable Full Disk Access"
  actions={[{ label: 'Open Settings', onClick: openSettings }]}
  dismissible
  onDismiss={dismiss}
>
  Rebel needs permission before this feature can work reliably.
</Notice>
```

Use `Notice` for decision-support banners and persistent messages that should stay near the surface they affect. Use `DecisionCardGroup` when the UI is the decision itself, such as choosing between meaningful modes. Do not use local banner markup unless the surface is live chrome or a feature-specific organism.

### ConversationPill
Compact recent-conversation shortcut molecule.

```tsx
<ConversationPill title="Friday Pulso feedback session" onClick={openConversation} />
```

Use `ConversationPill` for recent conversation shortcuts near prompt-entry surfaces. Do not use it as a generic badge or metadata chip.

### PageHeader / SectionHeader
Shared hierarchy molecules for page-level greetings and section headings.

```tsx
<PageHeader title="Good afternoon, Team Member" subtitle="Here's your check-in for today." />
<SectionHeader title="Needs your attention today" subtitle="Sorted by what matters most." />
```

Use `PageHeader` for the main page title/subtitle block. Use `SectionHeader` for repeated content sections inside a page.

### Dialog
Modal dialog for confirmations and forms.

```tsx
<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <DialogContent>
    <DialogHeader icon="🎉">
      <DialogTitle>Dialog Title</DialogTitle>
      <DialogDescription>Supporting text</DialogDescription>
    </DialogHeader>
    <DialogBody>Content here</DialogBody>
    <DialogFooter>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      <Button onClick={onConfirm}>Confirm</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### Input / Textarea / Label
Form input components.

```tsx
<Label htmlFor="email">Email</Label>
<Input id="email" placeholder="Enter email..." inputSize="md" />
<Textarea placeholder="Description..." rows={4} />
```

**Sizes:** `sm` for compact search and toolbar fields, `md` for normal forms, `lg` for spacious setup/onboarding fields.

Use `Input` for standard text/search fields even when the surrounding wrapper owns icons, chips, or clear buttons. It is fine for the wrapper and nearby `IconButton`s to have slightly different fills: the input should read as the editable field, while the icon buttons should read as adjacent actions. They should share the same border/radius/token family, not necessarily the exact same fill.

Plain inputs should use the same stroke/focus language as hero/composer inputs: muted slate border by default and a restrained indigo focus ring. For compact search fields (`inputSize="sm"`), use a 14px leading search icon unless the surface has a clear reason to be larger.

Do not use `Input` for hidden file/date inputs, inline rename fields that need bespoke sizing, or rich composer/hero inputs; those are separate patterns.

### Select
Native select dropdown with styled appearance.

```tsx
<Select value={selected} onChange={e => setSelected(e.target.value)}>
  <option value="">Select option...</option>
  <option value="opt1">Option 1</option>
  <option value="opt2">Option 2</option>
</Select>
```

### RichSelect
Custom select with rich content options (title + description). Use when users need contextual help to understand their choices.

```tsx
<RichSelect
  value={selected}
  onChange={setSelected}
  options={[
    { value: 'auto', label: 'Auto-save', description: 'Saves automatically without asking' },
    { value: 'smart', label: 'Smart check', description: 'Asks for sensitive content only' },
    { value: 'ask', label: 'Always ask', description: 'Asks before saving anything' },
  ]}
  placeholder="Select option..."
/>
```

Options can also include an `icon` property (a Lucide icon component) to display before the label.

### Toggle
Compact binary on/off atom for settings rows and other trust-sensitive controls.

```tsx
<Toggle checked={enabled} onCheckedChange={setEnabled} aria-label="Enable feature" />
```

Use `Toggle` for the low-level on/off control. Use a higher-level row pattern when the control needs labels, warnings, badges, or helper text around it.

### InlineToggle
Compact labeled toggle for dense cards, popovers, and inline behavior controls.

```tsx
<InlineToggle
  checked={autoDone}
  onCheckedChange={setAutoDone}
  label="Auto-mark done"
/>
```

Use `InlineToggle` when you need the shared `Toggle` control plus a short inline label inside a compact surface. Do not use it for full settings rows; those should stay on `SettingRow` or another higher-level pattern.

### Tabs
Tab navigation for switching content panels.

```tsx
<Tabs defaultValue="tab1">
  <TabsList variant="default">
    <TabsTrigger value="tab1">Tab 1</TabsTrigger>
    <TabsTrigger value="tab2">Tab 2</TabsTrigger>
  </TabsList>
  <TabsContent value="tab1">Content 1</TabsContent>
  <TabsContent value="tab2">Content 2</TabsContent>
</Tabs>
```

Variants: `default`, `pills`, `underline`

Use `Tabs` for generic content switching inside a page, settings area, dialog, or diagnostics view. Do not force app navigation chips, inbox temporal filters, Library lens chips (`Show` / `View as`), or pinned conversation tabs into `Tabs` unless their behavior and density match generic content tabs. Those are product-level segmented controls and should either stay local or graduate into a separate molecule such as `SegmentedTabStrip` / `FlowChipTabs`.

### Navigation Controls
Storybook has a dedicated `Design System/Molecules/Navigation Controls` page for controls that move, filter, or scope the user's view.

Use that page to compare:
- app-shell flow chips for major app navigation
- content tabs from the shared `Tabs` atom
- list/filter controls such as conversation, library, and time-period filters
- session-specific shortcuts

These controls should share Rebel's visual family: restrained active fill, related radius, consistent text/icon scale, clear focus treatment, and predictable badge styling. They should not automatically share one implementation API.

### Card
Container for related content.

```tsx
<Card variant="default">
  <CardHeader>
    <CardTitle>Card Title</CardTitle>
    <CardDescription>Description</CardDescription>
  </CardHeader>
  <CardContent>Main content</CardContent>
  <CardFooter>
    <Button size="sm">Action</Button>
  </CardFooter>
</Card>
```

Variants: `default`, `outlined`, `elevated`, `glass`

### Badge
Status indicators and labels.

```tsx
<Badge>Default</Badge>
<Badge variant="success">Active</Badge>
<Badge variant="warning">Pending</Badge>
<Badge variant="destructive">Error</Badge>
<Badge size="sm">Small</Badge>
```

Variants: `default`, `primary`, `secondary`, `success`, `warning`, `destructive`, `outline`, `muted`

### Toast
Notification system with glass-morphism cards. Use `showToast()` — never build custom notification components.

```tsx
const { showToast } = useToast();
showToast({ title: 'Settings saved' });
showToast({ title: 'Upload complete', variant: 'success' });
showToast({ title: 'Connection lost', variant: 'error' });
```

Variants: `default`, `success`, `warning`, `error`, `info`

> **Full visual spec, taxonomy, and guidelines:** See [UI_INTERNAL_NOTIFICATIONS.md](../../../docs/project/UI_INTERNAL_NOTIFICATIONS.md)

### Spinner / RebelLoadingIndicator
Loading indicators split by user meaning, not by visual preference.

```tsx
<Spinner size="sm" label="Loading..." />
<Spinner size="xs" decorative />
<Spinner size="sm" decorative />
<RebelLoadingIndicator
  layout="stacked"
  size="lg"
  label="Rebel is thinking"
  description="A visible mascot moment for meaningful waits."
/>
```

Use `Spinner` for compact utility waits: retry buttons, small rows, dropdowns, table cells, and inline status text. Use `size="xs"` when replacing the old 12px `spinner-small` footprint in dense icon controls. Use `decorative` only when the surrounding control already has a clear accessible loading label or visible loading text; do not combine `decorative` with `label`. Use `RebelLoadingIndicator` when Rebel is visibly thinking, preparing, generating, or setting something up for the user. It uses the same mascot spinner asset as the conversation thinking panel. Use skeletons when the page or card shape is known; skeleton shapes should be soft fill-only placeholders, not stroked controls.

Do not replace every spinner with the mascot. The mascot is a product moment, not a loading glyph. `RebelLoadingIndicator` defaults to respecting `prefers-reduced-motion` by switching to the static mascot image.

### Tooltip
Hover hints for elements.

```tsx
<Tooltip content="Helpful tip" placement="top">
  <button>Hover me</button>
</Tooltip>
```

Placements: `top`, `bottom`, `left`, `right`

## Theming

Components use CSS variables from `styles/foundations/tokens.css` and `styles/foundations/theme.css`. Override variables in a parent scope to theme sections:

```css
.dark-section {
  --color-background: #0f172a;
  --color-text-primary: #f1f5f9;
}
```

## Adding Components

1. Copy base structure from [ui.shadcn.com](https://ui.shadcn.com)
2. Create component file in `src/renderer/components/ui/`
3. Create colocated `.module.css` file using design tokens
4. Replace Tailwind classes with CSS module classes
5. Add JSDoc comments documenting props and usage
6. Export from `index.ts`
7. Update this README

## Test IDs for E2E Testing

All interactive UI elements should include `data-testid` attributes to enable reliable Playwright e2e tests. Test IDs make tests resilient to CSS/styling changes.

### Naming Convention

Use kebab-case with a descriptive hierarchy:
- `{feature}-{element}` for feature-specific elements
- `{component}-{action}` for reusable components

### Examples

```tsx
// Landing page elements
<button data-testid="landing-settings-button">Settings</button>
<button data-testid="landing-mic-button">Record</button>

// Session/conversation elements
<aside data-testid="session-sidebar">
<input data-testid="session-search-input" />
<ul data-testid="session-list">

// Interaction elements
<footer data-testid="interaction-strip">
<button data-testid="mode-toggle-button">

// Global elements
<button data-testid="brand-home">
<button data-testid="new-chat-button">
```

### When to Add Test IDs

**Always add `data-testid` to:**
- Buttons and interactive controls
- Form inputs (text fields, selects, checkboxes)
- Navigation elements (tabs, links, sidebar items)
- Modal/dialog triggers and close buttons
- Key content containers that tests need to verify

**Skip `data-testid` for:**
- Purely decorative elements (icons, dividers)
- Elements only used for styling (wrappers, spacers)
- Elements that can be reliably selected by role/text

### Existing Test IDs

| Test ID | Location | Purpose |
|---------|----------|---------|
| `brand-home` | App.tsx | Home/logo button |
| `new-chat-button` | App.tsx | Start new conversation |
| `interaction-strip` | InteractionStrip.tsx | Composer footer |
| `mode-toggle-button` | InteractionStrip.tsx | Voice/text mode toggle |
| `session-sidebar` | AgentSessionSidebar.tsx | History sidebar |
| `session-search-input` | AgentSessionSidebar.tsx | Search conversations |
| `session-list` | AgentSessionSidebar.tsx | Session entries list |
| `usecases-panel` | UseCasesPanel.tsx | Use cases panel container |
| `usecases-panel-empty` | UseCasesPanel.tsx | Empty state for use cases |
| `usecase-card-*` | UseCasesPanel.tsx | Individual use case cards |

#### Onboarding Wizard Test IDs

| Test ID | Location | Purpose |
|---------|----------|---------|
| `onboarding-wizard` | OnboardingWizard.tsx | Main wizard container |
| `onboarding-steps-nav` | OnboardingWizard.tsx | Step pills navigation |
| `onboarding-step-{step}` | OnboardingWizard.tsx | Dynamic step content (welcome, workspace, googleDrive, api, toolAuth, permissions) |
| `onboarding-footer` | OnboardingWizard.tsx | Footer with navigation buttons |
| `onboarding-back-button` | OnboardingWizard.tsx | Back navigation |
| `onboarding-continue-button` | OnboardingWizard.tsx | Continue to next step |
| `onboarding-finish-button` | OnboardingWizard.tsx | Complete onboarding |
| `onboarding-welcome-content` | OnboardingWizard.tsx | Welcome step container |
| `onboarding-welcome-title` | OnboardingWizard.tsx | Welcome headline |
| `onboarding-get-started-button` | OnboardingWizard.tsx | Start onboarding CTA |

## CSS Migration Guide

When migrating from deprecated.css classes to UI components:

| Deprecated Class | Replacement Component |
|------------------|----------------------|
| `.ghost-button` | `<Button variant="ghost">` |
| `.primary-button` | `<Button variant="default">` |
| `.toast-notification` | Use `<ToastProvider>` + `useToast()` |
| Custom dialog overlay | `<Dialog>` + `<DialogContent>` |
| Custom input styles | `<Input>` or `<Textarea>` |
| Custom select styles | `<Select>` |

### Migration Steps

1. Import the component: `import { Button } from '@renderer/components/ui'`
2. Replace the element with the component
3. Remove the deprecated class usage
4. Once all usages of a deprecated class are migrated, remove it from `deprecated.css`

### Example Migration

Before:
```tsx
<button className="primary-button" onClick={onClick}>
  Submit
</button>
<button className="ghost-button" onClick={onCancel}>
  Cancel
</button>
```

After:
```tsx
import { Button } from '@renderer/components/ui';

<Button onClick={onClick}>Submit</Button>
<Button variant="ghost" onClick={onCancel}>Cancel</Button>
```

## Design Tokens Reference

See `src/renderer/styles/foundations/tokens.css` for available tokens:

- Colors: `--color-*`
- Spacing: `--space-*` (1-12 scale)
- Radii: `--radius-*` (xs, sm, md, lg, xl, 2xl, pill)
- Shadows: `--shadow-*` (soft, medium, hard)
- Motion: `--motion-duration-*`, `--motion-ease-*`
- Z-index: `--z-*` (base, shell, overlay, modal, toast)
