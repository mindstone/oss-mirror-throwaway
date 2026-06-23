---
description: "The invariant that the local model proxy is THE auth boundary for all LLM egress: SDK clients carry a sentinel key, the real upstream credential is resolved + injected only at the proxy edge through one sanctioned site."
last_updated: "2026-05-30"
---

# Proxy Auth Boundary

The local model proxy (`src/main/services/localModelProxyServer.ts`) is the **single authoritative auth boundary** for every LLM request that egresses to a real upstream provider (Anthropic, OpenRouter, the Codex Responses API, BYOK/council profiles). The SDK clients that Rebel Core constructs never hold a real upstream credential when a proxy route is in play — they carry a sentinel, and the proxy resolves and injects the real secret at the very edge, after stripping anything the client sent.

This doc captures the invariant and *why* it exists. The code is the source of truth for *how*.

## The core invariant

When a proxy route is in play, the SDK client is constructed with a **sentinel API key** instead of a real credential:

- Constant: `PROXY_HANDLES_AUTH_SENTINEL` (`'proxy-handles-auth'`) in `src/core/rebelCore/proxyAuthContract.ts`. This file is the shared producer/consumer contract — read its header for the full producer/consumer map.
- **Producer:** `createModelClient()` in `src/core/rebelCore/clientFactory.ts` (PRECEDENCE 1). It sets `apiKey: PROXY_HANDLES_AUTH_SENTINEL` when it detects the proxy has identified itself via provider-identity headers (see below); otherwise it falls back to a real Anthropic key via `getAnthropicAuth(settings)`.
- **Egress:** The real upstream credential is resolved at the proxy from the proxy's *own* source-of-truth (persisted settings / OAuth token store), never from anything the SDK client sent.

Two halves of the contract that MUST always hold together:

1. The sentinel must reach the proxy and **never** be forwarded upstream.
2. Every passthrough/forwarding handler MUST strip any inbound `x-api-key` / `authorization` before injecting the upstream-correct credential.

## Why: the sentinel-leak postmortem

This split exists because the symmetric strip+inject was once duplicated across five handlers, and one handler (`handleAnthropicPassthrough`) failed to honor its half — it forwarded the SDK sentinel `x-api-key: proxy-handles-auth` straight to `api.anthropic.com`, producing 401s.

- Postmortem: `docs-private/postmortems/260501_proxy_anthropic_passthrough_sentinel_leak_postmortem.md` (and the eval-cluster sibling `docs-private/postmortems/260430_evals_s5b_cluster_anthropic_passthrough_sentinel_leak_postmortem.md`).
- Recovery + extraction plan: `docs/plans/260430_eval_harness_recovery_and_anthropic_auth_fix.md` (Stage 2 extracted the inline string literal into the shared contract).

The fix was to **centralize** the strip/inject so a single named site owns it and a CI check forbids re-inlining it.

## The single sanctioned strip/inject site

All upstream-auth injection goes through `src/main/services/localModelProxy/upstreamAuth.ts`:

- `injectUpstreamAuth(headers, plan)` — **always** strips inbound client auth first (defence: not even the sentinel survives), then injects the host-correct credential.
- `stripClientAuthHeaders(headers)` — the one sanctioned home for `delete headers['x-api-key' | 'authorization']`; exported for the Anthropic fail-closed path (strip without inject when no key is configured).
- `CredentialPlan` — discriminated union (`anthropic-x-api-key` | `openrouter-bearer` | `profile-bearer` | `codex-oauth`) so a new auth shape is a compile error at the injector, not a silently-unhandled branch.

This module is reachable from the cloud bootstrap, so it MUST NOT import `electron` — `@core` / `@shared` only.

### Egress consumers

Each handler in `localModelProxyServer.ts` resolves its own credential, then calls `injectUpstreamAuth` with the matching plan:

- `handleAnthropicPassthrough` → `{ kind: 'anthropic-x-api-key' }`
- `handleOpenRouterPassthrough` → `{ kind: 'openrouter-bearer' }`
- `forwardToCodexModel` / `handleCodexStreamingRequest` → `{ kind: 'codex-oauth' }`
- `forwardToLocalModel` (profile / council-member / Responses-API egress) → `{ kind: 'profile-bearer' }`

## CI / test guards that lock the boundary

- `scripts/check-proxy-auth-translator-centralization.ts` — mechanical check asserting the raw `delete headers['x-api-key'|'authorization']` and the upstream `x-api-key`/`Bearer` injection patterns appear ONLY inside `upstreamAuth.ts`. A new handler cannot quietly re-introduce an inline asymmetric path.
- `src/main/services/__tests__/localModelProxyServer.crossHandlerAuth.test.ts` — feeds each passthrough handler a "poison" inbound `x-api-key` / `authorization` and asserts neither the poison value nor the `proxy-handles-auth` sentinel survives to the captured upstream `fetch`.
- Boundary-registry entry `proxy-passthrough-auth-symmetry` in [BOUNDARY_REGISTRY](./BOUNDARY_REGISTRY.md).

## Durable design note: the provider-identity-header contract

`proxyHandlesAuth` in `createModelClient()` is *inferred from header presence*, not stated explicitly:

- `x-codex-turn: true`, or
- `x-openrouter-turn: true`, or
- the pair `x-routed-turn-id` + `x-proxy-auth`.

If none are present, `createModelClient` assumes a direct Anthropic call and demands a real Anthropic key. This is a deliberate "prove the proxy is in the loop" design — but it is **fragile by construction**: a proxy env builder that composes its headers via object-spread and accidentally fails to re-emit its provider-identity header will silently flip a proxy-routed turn into a direct-Anthropic turn, breaking auth. This exact class of bug is documented in `docs-private/postmortems/260417_openrouter_adhoc_auth_failure_postmortem.md` (which recommends composing proxy headers in one pass via a shared map to eliminate the overwrite hazard).

When adding a new proxy provider flag, follow the in-code checklist in `clientFactory.ts` near the `proxyHandlesAuth` computation (add the header detection AND include it in the `proxyHandlesAuth` OR-check) and add a corresponding `CredentialPlan` variant + egress handler.

## See also

- [REBEL_CORE](./REBEL_CORE.md) — `clientFactory.ts` / `ResolvedTarget` routing; the ESLint guard that forces all client construction through `createModelClient()` (the only sanctioned sentinel producer).
- [LOCAL_MODEL_SUPPORT](./LOCAL_MODEL_SUPPORT.md) — what the local proxy is and how it translates Anthropic-format requests; this doc covers the auth half of that boundary.
- [LLM_CALL_SITES](./LLM_CALL_SITES.md) — inventory of egress points, including the proxy passthrough to `api.anthropic.com`.
- [BOUNDARY_REGISTRY](./BOUNDARY_REGISTRY.md) — the `proxy-passthrough-auth-symmetry` registry entry that tracks this invariant.
- [AUTHENTICATION](./AUTHENTICATION.md) — app-level auth modes incl. the ChatGPT Pro (Codex) OAuth flow whose token feeds the `codex-oauth` plan.
- `src/core/rebelCore/proxyAuthContract.ts` — the shared sentinel contract; read its header for the canonical producer/consumer map.
- `src/main/services/localModelProxy/upstreamAuth.ts` — the single strip/inject home and the `CredentialPlan` union.
