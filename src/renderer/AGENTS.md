---
description: "Rules and signposts for src/renderer/ — the React UI, feature hooks, and Zustand session state. Audience: knowledge workers."
last_updated: "2026-05-14"
---

# src/renderer — React UI

The Electron renderer process: React + TypeScript + Vite. This is the surface our **non-technical knowledge-worker audience** actually sees, so every change here should be evaluated through that lens (UI copy, defaults, error messages, onboarding).

## Hard rules

- **Use the shared UI component library**: `import { Button, Dialog, Input, ... } from '@renderer/components/ui'`. For new product UI, **no raw `<button>` elements, no one-off styles, no additions to `deprecated.css`**. Raw buttons are acceptable only inside the UI primitives themselves or in legacy code being actively migrated. Icons come from `lucide-react`.
- **Theming**: always test both light and dark modes. Use design tokens. See [`components/ui/README.md`](./components/ui/README.md) and the Theming Checklist in [`UI_CSS_ARCHITECTURE.md`](../../docs/project/UI_CSS_ARCHITECTURE.md).
- **Building or updating UI is a STOP gate**. Route product-design judgement through [`chief-designer`](../../rebel-system/skills/ux/chief-designer/SKILL.md) and component/token decisions through [`design-system-reviewer`](../../rebel-system/skills/ux/design-system-reviewer/SKILL.md). Operational checklist: [`rebel-ui-consistency-review`](../../skills/ux/rebel-ui-consistency-review/SKILL.md).
- **IPC**: prefer the domain APIs over raw `window.api`. Contracts live in `src/shared/ipc/contracts.ts` and are validated with Zod.
- **`localStorage` is for small disposable UI prefs only** (view modes, dismissals, panel sizes). Never for user content, large data, or cross-process state — see [`SETTINGS_CONFIGURATION_AND_ENVIRONMENT`](../../docs/project/SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md).
- **State**: functional components + hooks; Zustand with pure reducers and selector-based subscriptions. Memoise intentionally, not reflexively.
- **`AgentAssistantMessage` has NO `.text` property.** Text lives in `message.message.content`. Always use `extractAgentAssistantText()` from `@core/agentRuntimeTypes` — see [`postmortem`](../../docs-private/postmortems/260329_sdk_text_extraction_postmortem.md).
- **`console.warn` / `console.error` are captured** in log files with a `[Renderer]` prefix — useful for diagnosis, but still don't log secrets.

## App.tsx is large by design

`App.tsx` is intentionally ~2,800 LOC. It orchestrates voice, session, workspace, settings, and other major features — the coordination logic has to live somewhere.

- **Feature-specific logic** → `src/renderer/features/<feature>/hooks/`, not App.tsx
- **Independent UI state** → `src/renderer/hooks/` (see `useDialogStates`, `useDraftDiscardDialog`)
- **Cross-cutting concerns** → may belong in App.tsx, but prefer hooks with callback injection

Navigation aids in App.tsx: `// SECTION: State Declarations`, `// SECTION: Core Feature Hooks`, `// SECTION: Event Handlers & Callbacks`, `// SECTION: Render`.

## Key entry points

- `App.tsx` — main UI orchestration
- `main.tsx` — React bootstrap
- `features/agent-session/hooks/useAgentSessionEngine.ts` — agent turn state machine
- `features/agent-session/store/sessionStore.ts` — conversation state (Zustand)
- `features/agent-session/work-surface/utils/personaQuips.ts` — Rebel's [brand voice](../../docs/project/BRAND_VOICE.md) reference
- `components/ui/` — the shared design system (has its own `README.md`)
- [`components/sandbox/`](components/sandbox/) — pure security helpers (e.g. `escapeHtmlAttribute` for MCP App / plugin iframe CSP injection)
- `transport/` — renderer-side IPC plumbing
- `features/` — major feature surfaces; each may have its own internal organisation. See [RENDERER_FEATURES_OVERVIEW](../../docs/project/RENDERER_FEATURES_OVERVIEW.md) for a one-line map of each feature subdir.

## See also

- Root [`AGENTS.md`](../../AGENTS.md) — repo-wide rules; especially "Brand Voice" and the UI STOP gate
- [`docs/project/UI_OVERVIEW.md`](../../docs/project/UI_OVERVIEW.md) — UI layout, patterns
- [`docs/project/UI_CSS_ARCHITECTURE.md`](../../docs/project/UI_CSS_ARCHITECTURE.md) — CSS architecture, design tokens, theming checklist
- [`docs/project/UI_CONVERSATIONS.md`](../../docs/project/UI_CONVERSATIONS.md) — conversation transcript, message cards, auto-scroll, dual turn ID model
- [`docs/project/BRAND_VOICE.md`](../../docs/project/BRAND_VOICE.md) — voice traits, design philosophy, examples
- [`docs/project/AGENT_UI_TESTING.md`](../../docs/project/AGENT_UI_TESTING.md) — choosing the right agent UI verification path
- [`components/ui/README.md`](./components/ui/README.md) — full component catalog, usage, design tokens
