---
description: "Signpost for the shared embedded chat stack used by the browser extension side panel and Office taskpane."
last_updated: "2026-04-25"
audience: "contributors"
---

# Embedded Chat Architecture

This doc is the quick signpost for Rebel's **shared embedded chat stack** — the
conversation surfaces used by:

- `packages/browser-extension/src/sidepanel/`
- `mcp-servers/connectors/office/src/addin/`

The implementation is intentionally split into three shared layers inside
`packages/shared/src/`:

1. **Intent client** — `@rebel/shared/intentClient`
   - Shared HTTP/SSE client, diagnostic events, and persistence contracts.
   - Canonical wire types live in `src/core/appBridge/shared/intentProtocol.ts`.
2. **Chat controller** — `@rebel/shared/chatController`
   - Shared conversation lifecycle, reconnect ladder, offline probe, and
     persistence-driven hydration.
3. **Chat UI primitives** — `@rebel/shared/chatUI`
   - Shared copy, transcript entry modelling, notice/status mapping, and
     formatting helpers consumed by the extension React UI and Office's plain-DOM
     renderer.

## Load-bearing constraints

- **Browser chat is tab/page scoped.** The browser side panel asks the service
  worker for the active scope and remounts on `scope-changed`; switching to a
  tab/page with no scoped record starts empty instead of hydrating another tab's
  transcript.
- **Office chat is document scoped.** Office stores only opaque local/document
  scope identifiers and sanitized document metadata; switching to a different
  document/workbook/presentation starts empty unless that scope already has a
  local chat record.
- **Scope-bound persistence is immutable per controller instance.** Late writes
  from an old browser tab or Office document must not mutate the newly active
  scope after a remount.
- **Browser DOM tools are conversation-bound.** App Bridge maintains the
  conversation → browser tab binding and rejects browser tool execution when the
  tab is gone or has navigated away from the bound URL fingerprint.
- **Office keeps the sidecar proxy transport.** Do not replace it with direct
  browser-to-bridge requests.
- **Browser extension keeps paired-app auth + `X-Rebel-*` headers.**
- **Subpath-only imports.** Use `@rebel/shared/intentClient`,
  `@rebel/shared/chatController`, and `@rebel/shared/chatUI`; do **not** add
  these to `packages/shared/src/index.ts`.
- **Diagnostics bridge into the existing observability stack.** Shared
  diagnostic events flow to `src/core/logger.ts` / `src/core/errorReporter.ts`
  where available; Office additionally mirrors them through the sidecar's
  `/diag/*` tooling.
- **Desktop renderer unification is deferred.** `src/renderer/features/agent-session/components/ConversationPane.tsx`
  is deliberately out of scope for this stack.

## Read this next

- `docs/plans/260424_shared_embedded_chat_stack_unification.md` — canonical
  plan, stage history, bundle-baseline rationale, and follow-ups.
- `docs/project/APP_BRIDGE.md` — transport/security architecture for the App
  Bridge used by both companion surfaces.
- `docs/plans/260421_embedded_chat_in_extension.md` — original extension chat
  rollout plan.
- `docs/plans/260423_office_addin_intent_proxy.md` — Office sidecar proxy
  constraints and transport rationale.
- `docs-private/investigations/260424_word_taskpane_rebel_not_responding.md` — current
  taskpane diagnostic workflow after the shared migration.
