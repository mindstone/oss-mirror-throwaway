---
description: "How Rebel classifies agent turn errors, routes recovery, and emits user-facing + observability signals"
last_updated: "2026-06-18"
---

# Error Classification and Routing

Intent: keep retry/fallback decisions driven by structured error kinds, keep renderer behaviour driven by definitive event metadata, and keep observability queryable without parsing humanized strings.

## See Also

- [ARCHITECTURE_AGENT_TURN_EXECUTION.md](ARCHITECTURE_AGENT_TURN_EXECUTION.md) — turn lifecycle, retry/fallback order, and where recovery plugs in
- [ERROR_MONITORING_AND_SENTRY.md](ERROR_MONITORING_AND_SENTRY.md) — broader Sentry capture/fingerprinting guidance
- [docs/plans/260419_openrouter_credits_error_ux.md](../plans/260419_openrouter_credits_error_ux.md) — staged rollout history for billing subtype UX and guardrails
- `src/core/rebelCore/modelErrors.ts` — HTTP/body classification into `ModelError`, including `upstreamProvider`
- `src/shared/utils/agentErrorCatalog.ts` — canonical `AgentErrorKind` set and routed-error helpers
- `src/shared/utils/friendlyErrors.ts` — `humanizeError()`, `classifyBillingSubtype()`, retry/transience helpers
- `packages/shared/src/utils/humanizeAgentError.ts` — classification-first humanizer + `HUMANIZER_OWNED_KINDS` / `CALLER_OVERRIDE_KINDS` partition
- `src/main/services/turnErrorRecovery.ts` — recovery handlers and billing-path Sentry tagging
- `src/core/services/agentEventDispatcher.ts` — `dispatchAgentErrorEvent()` helper and `ai_error_shown` analytics
- `src/renderer/App.tsx` — banner CTA routing and `PROVIDER_BILLING_URLS`

## Flow

1. `modelErrors.ts` converts provider/HTTP failures into `ModelError`.
2. `agentErrorCatalog.ts` normalizes routed errors to `AgentErrorKind`.
3. `turnErrorRecovery.ts` decides retry, fallback, or user-visible error handling.
4. `dispatchAgentErrorEvent()` emits a structured `AgentEvent`.
5. Renderer code reads definitive event metadata first, then falls back to legacy text matching only when old persisted events lack metadata.

## Type-Aware Source Classification

`modelErrors.ts` now reads the provider's **structured error type**, not just the humanized message:

- An Anthropic `404 not_found_error` (a bogus/typo'd model id) classifies as `model_unavailable` rather than a hard failure, so the configured-role / Opus auto-fallback fires instead of dead-ending the turn. (00d4111e7, 9b1dc0f76)
- A **status-less** local-proxy / Codex SSE `stream_error` classifies as a **retryable** `server_error`. This is scoped to the absent-status case only — a concrete HTTP status is never overridden by the stream-type heuristic. (9b1dc0f76)

### Catch-clobber invariant in the planning client

The `rebelCoreQuery` planning-client `catch` (`src/core/rebelCore/rebelCoreQuery.ts`, ~L1190) previously flattened everything to `ModelError('auth')`, which surfaced a routing reject as a misleading "issue with your API key". It now calls `reclassifyOrRethrow(caught, fallbackKind)` (`modelErrors.ts`), which **rethrows already-classified/branded errors** (routing, `ConnectionNotConfigured`, `UnsupportedModel`, auth) unchanged and only applies the fallback kind to genuinely unclassified errors. A custom ESLint rule `eslint-rules/no-model-error-catch-clobber.js` enforces this by construction so the clobber cannot reappear. (6c65d65a4, 5d0711fbb, be4d44f78)

## Canonical Contracts

### `AgentErrorKind`

`AgentErrorKind` is the stable routing taxonomy. It answers "what happened?", not "what should the app do next?".

- `billing`, `rate_limit`, `auth`, `moderation`, `server_error`, `invalid_request`, `context_overflow`, `model_unavailable`, `message_timeout`, `mcp_error`, `process_exit`, `user_action`, `unknown`, plus a small set of legacy migration kinds
- `moderation` is a peer kind, not a billing subtype
- recovery policy lives in `turnErrorRecovery.ts`, not in renderer copy helpers

### `AgentEvent` metadata

For `type: 'error'` events, these fields are the definitive renderer/analytics signals:

- `errorKind` — normalized category for routing, copy, analytics, and fingerprints
- `billingMeta` — billing-only metadata; currently `subtype`, optional `rawError`, optional `upstreamProviderName`
- `rateLimitMeta` — rate-limit-only metadata; currently `retryAfterMs` and optional raw text. **Codex quota exhaustion** on route-resolved + SSE terminal paths is surfaced as HTTP **429** (not a generic 500/502) via `throwCodexTerminalError()` in `src/core/services/codexResponsesTranslator.ts`, so downstream classification lands on `rate_limit` / billing recovery — matching the direct-HTTP-429 path.

Rules:

- Prefer `billingMeta` / `rateLimitMeta` over re-parsing `error`
- Keep text fallback only for legacy persisted events or unmigrated call sites
- `provider` is the billing-owner / CTA-routing field
- `billingMeta.upstreamProviderName` is display-only context; it must not override CTA routing

## Central Dispatch Helper

Actionable user-facing error events should go through `dispatchAgentErrorEvent(win, turnId, rawError, opts?)`.

It is the canonical place that:

- derives `errorKind`
- humanizes the message
- populates `billingMeta` / `rateLimitMeta`
- carries provider context into the event
- marks billing errors actionable by default
- emits analytics only after dispatch succeeds

Inline `dispatchAgentEvent(..., { type: 'error', ... })` is blocked at compile time — see Compile-Time Type-Wall below.

## Compile-Time Type-Wall

`src/core/services/agentEventDispatcher.ts` narrows the public `dispatchAgentEvent` signature to `event: Exclude<AgentEvent, { type: 'error' }>`. Error events MUST route through `dispatchAgentErrorEvent(win, turnId, rawError, opts)` — inline `type: 'error'` construction via `dispatchAgentEvent` fails to compile.

- The helper's own internal dispatch routes through a non-exported `dispatchAgentEventInternal` that accepts the full union, preserving the single legitimate internal-self-call path.
- The desktop decorator in `src/main/services/agentEventDispatcher.ts` carries the same narrowed signature; the type-wall cascades end-to-end.
- DI type contracts in `src/main/ipc/agentHandlers.ts` and `src/core/services/agentTurnService.ts` mirror the narrowed signature so pass-through call-sites inherit the invariant.
- A committed compile-time regression test at `src/core/services/__tests__/agentEventDispatcher.types.test.ts` uses `@ts-expect-error` to assert inline error dispatch fails to compile.

Historical note: a warning-only ESLint rule (`errorDispatchGuardSelectors`) provided the same coverage at lint level as a staged-migration concession. It was removed when the type-wall landed — see docs/plans/260420_inline_error_dispatch_migration.md Stage 4.

Preferred pattern:

```ts
dispatchAgentErrorEvent(win, turnId, rawError, opts);
```

## Observability

### Sentry

The billing recovery capture path in `turnErrorRecovery.ts` adds these queryable tags:

- `error_kind`
- `provider`
- `billing_subtype`
- `upstream_provider`

These tags are intentionally structured so dashboards can answer "which billing subtype regressed?" without parsing message text.

### Posthog

`dispatchAgentErrorEvent()` fires `ai_error_shown` after a successful dispatch with:

- `errorKind`
- optional `billingSubtype`
- optional `provider`
- optional `upstreamProvider`

This event is best-effort and must never prevent the user-visible error from being dispatched.

## Timeout Diagnostics

`message_timeout` remains a first-class error kind with a richer `timeoutDiagnostic` payload on the event:

```ts
timeoutDiagnostic?: {
  kind: 'anthropic_issue' | 'internet_unreachable' | 'transient_stall';
  indicator?: string;
  description?: string;
};
```

See:

- `src/core/services/timeoutDiagnosticsService.ts` for probe logic
- `src/main/services/turnErrorRecovery.ts` handler 10 for integration
- `docs/plans/260408_timeout_diagnostics_and_messaging.md` for design history

## Classification-First Humanization

Use `humanizeAgentError(meta)` from `@rebel/shared` for all new user-facing error copy. It treats `errorKind`, `billingMeta`, `rateLimitMeta`, `provider`, and `upstreamProviderName` as primary signals, and falls back to raw-message substring matching only when classification is unavailable (via the `kind: 'unclassified'` branch).

The humanizer's input is a discriminated union:

- `{ kind: 'classified', errorKind, rawMessage, ...meta }` — caller has a classified error
- `{ kind: 'unclassified', rawMessage, provider? }` — caller has only raw text

Two kind-sets partition every `AgentErrorKind`:

- `HUMANIZER_OWNED_KINDS` — kinds where the humanizer produces the copy (`billing`, `rate_limit`, `auth`, `moderation`, `server_error`, `invalid_request`, `context_overflow`, `model_unavailable`). Renderer layers may freely call `humanizeAgentError` for these to keep copy consistent across desktop/cloud/mobile.
- `CALLER_OVERRIDE_KINDS` — kinds where the dispatcher passes bespoke per-call-site copy via `humanizedOverride` (`message_timeout`, `process_exit`, `mcp_error`, `session_not_found`, `tool_name_corrupt`, `user_action`, `unknown`). The humanizer returns a safe generic fallback for these — it must never overwrite caller-generated copy. Renderers MUST gate any re-humanization with `HUMANIZER_OWNED_KINDS.has(errorKind)` so these call-site strings survive to the UI.

Legacy `humanizeError(string)` remains for:

- Pre-migration call sites not yet converted
- Surfaces that genuinely don't have metadata (e.g., operational logs, Sentry fingerprinting)
- The classification-unknown fallback inside `humanizeAgentError`

`formatBillingCopy` has been folded into `humanizeAgentError`'s billing branch (Stage 6, 2026-04-22). Do not add new standalone copy-selection helpers — extend the unified humanizer.

## AgentErrorResolution shape and classifier table

FOX-3267 adds `AgentErrorResolution` metadata to every dispatched `AgentEvent` error so renderer, cloud-client, and mobile consumers can show the same recovery path without parsing humanized strings.

Producer / consumer signposts:

- `packages/shared/src/utils/classifyErrorUx.ts` — pure kind-first producer for `AgentErrorResolution`
- `src/renderer/components/SessionErrorNotice.tsx` — desktop transcript Notice consumer
- `src/shared/ipc/channels/agentError.ts` + `src/main/ipc/agentErrorHandlers.ts` — `error:apply-resolution` action channel
- `src/core/services/agentEventDispatcher.ts` — attaches `resolution` before dispatch

Shape:

```ts
type AgentErrorCategory =
  | 'transient'
  | 'user-fixable'
  | 'system-broken'
  | 'unsupported-feature'
  | 'unknown';

type AgentErrorResolutionAction = {
  label: string;
  action: 'switch-model' | 'switch-provider' | 'open-settings' | 'retry';
  payload?: {
    model?: string;
    provider?: 'codex' | 'anthropic' | 'openrouter' | 'openai';
    settingsSection?: string;
  };
  variant?: 'primary' | 'secondary';
};

type AgentErrorResolution = {
  category: AgentErrorCategory;
  kind: AgentErrorKind;
  title: string;
  body: string;
  alternatives: AgentErrorResolutionAction[]; // capped at two Notice actions
  defaultAction?: AgentErrorResolutionAction;
  persistent: boolean;
};
```

Classifier table:

| `AgentErrorKind` | Resolution category | Default UX |
|---|---|---|
| `rate_limit` | `transient` | Silent retry; toast only after retry exhaustion. **Codex:** quota / usage-limit terminal failures on route-resolved + SSE paths are normalized to HTTP 429 by `throwCodexTerminalError()` (`codexResponsesTranslator.ts`) before `modelErrors.ts` classifies them here — not a generic 502. |
| `server_error` | `transient` | Silent retry |
| `message_timeout` | `transient` | Silent retry / timeout diagnostics |
| `process_exit` | `transient` | Bounded retry |
| `auth` | `user-fixable` | Notice: open provider keys |
| `connection-not-configured` | `user-fixable` | Notice: connect provider in Settings |
| `billing` | `user-fixable` | Notice: open billing/provider settings |
| `moderation` | `user-fixable` | Notice: rephrase and retry |
| `invalid_request` | `user-fixable` | Notice: retry or adjust model settings; never treated as transient when kind is known |
| `context_overflow` | `system-broken` | Notice / recovery flow for oversized conversation context |
| `model_unavailable` | `unsupported-feature` | Notice: choose another model |
| `unsupported_model` | `unsupported-feature` | Notice: choose supported Codex model or model settings |
| `image_input_unsupported` | `unsupported-feature` | Notice: switch to a vision-capable model (leads with switch-model — a tool-result image is baked into history, so retry/remove-attachment can't fix it; OpenRouter 404 "No endpoints found that support image input") |
| `routing` | `system-broken` | Notice: retry or open Diagnose |
| `session_not_found` | `user-fixable` | Notice: start/retry conversation recovery |
| `tool_name_corrupt` | `system-broken` | Notice: retry or inspect connectors |
| `mcp_error` | `user-fixable` | Notice: open connector settings or retry |
| `user_action` | `transient` | Suppressed stopped-turn surface |
| `unknown` | `unknown` | Persistent fallback Notice |

Locked brand-voice variants:

| Variant | Notice copy | Actions |
|---|---|---|
| A — Codex unsupported model with on-provider alternative | **ChatGPT Pro doesn't run GPT-5.5 Pro.**<br>Pick a model that works on your subscription, or switch providers. | `[Use GPT-5.5]` (`switch-model`, `gpt-5.5`) · `[Open settings]` (`open-settings`, `providerKeys`) |
| B — Codex unsupported model, no on-provider alternative | **This model isn't available on your subscription.**<br>Choose another to keep going. | `[Choose another]` (`open-settings`, `model`) |
| C — `system-broken` (`Stream must be true`, routing failures) | **Rebel hit a snag in the plumbing.**<br>Not your message — something on our end. Your work is saved. | `[Try again]` (`retry`) · `[Open Diagnose]` (`open-settings`, `diagnose`) |
| Fallback — `unknown` kind | **Something went sideways.**<br>Your message is safe. Try again, or check Settings → Diagnose. | `[Try again]` (`retry`) · `[Open Diagnose]` (`open-settings`, `diagnose`) |
| Transient auto-retry | No Notice during retry. Toast only after exhaustion: "Connection's been moody. Saving your message — try again." | None |

Cross-surface parity: `classifyErrorUx.ts` lives in `packages/shared`, so the same resolution metadata ships through desktop and cloud-client. Mobile receives it automatically via the `AgentEvent` stream; platform-specific surfaces only adapt how actions are invoked.

Kind-first motivation: BTS 260430 (`Stream must be true`) showed why substring-first transient checks are brittle. Known `AgentErrorKind` values must drive retry and UX classification first; substring fallback is only for `unknown` / legacy unclassified errors.

## Adding or Changing Error Handling

1. Update the classifier closest to the source (`modelErrors.ts`, `agentMessageHandler.ts`, or another boundary) rather than adding renderer-only text matching.
2. Add or update tests in the relevant unit suite before changing copy or routing.
3. If the change affects a user-visible actionable error, route it through `dispatchAgentErrorEvent()`.
4. If you add new definitive metadata, update the shared event schema/types first, then renderer helpers, then observability docs.
5. If you need new user-facing copy for an existing `AgentErrorKind` in `HUMANIZER_OWNED_KINDS`, extend the relevant branch in `humanizeAgentError.ts` (not a surface-specific helper) and add a regression test in `packages/shared/src/utils/__tests__/humanizeAgentError.test.ts`.
