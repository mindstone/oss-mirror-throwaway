---
description: "Per-endpoint request-parameter capability contract — which sampling/feature params each upstream endpoint supports, and the single code site that strips/translates/forwards each one. Consult before adding a request param."
last_updated: "2026-05-31"
---

# Provider Request-Parameter Capability Matrix

The consolidated contract for **which request parameters each upstream endpoint accepts**, and **where in our code each param is stripped, translated, or forwarded**. Read this before adding any new field to an outbound model request.

## Why this doc exists

A request param that one endpoint accepts (e.g. Anthropic-direct happily takes `temperature`) will make a *different* endpoint return HTTP 400 (`gpt-5`-class Responses-API models reject `temperature`, `max_output_tokens`, `top_p`). Because Rebel routes the *same* logical request across several wire protocols, an unsupported param leaking to the wrong upstream has been a **recurring root cause** — the same bug class has surfaced at least three times on one seam:

- [`260530_operator_consult_temperature_unsupported_postmortem`](../../docs-private/postmortems/260530_operator_consult_temperature_unsupported_postmortem.md) — `temperature` leaked through `translateChatToResponses` to the Codex/Responses API; explicitly notes *"There is still no per-endpoint request-parameter capability contract."* This doc is that contract.
- [`260430_evals_s5b_cluster_gpt5_temperature_rejection_postmortem`](../../docs-private/postmortems/260430_evals_s5b_cluster_gpt5_temperature_rejection_postmortem.md) — `gpt-5`+ rejects `temperature: 0` (default is `1`, explicit values rejected).
- [`260430_evals_s5b_cluster_gpt5_max_tokens_rejection_postmortem`](../../docs-private/postmortems/260430_evals_s5b_cluster_gpt5_max_tokens_rejection_postmortem.md) — `max_tokens` rejected; standardised on `max_completion_tokens` only.

Each fix so far has been a **local strip on one seam**. The durable solution is a typed per-endpoint capability matrix that makes leakage impossible by construction (see [`260505_typed_provider_capability_matrix`](../plans/260505_typed_provider_capability_matrix.md) and the architecture-consolidation plans referenced from the operator-consult postmortem). Until that lands, this table is the single place to consult.

## The five endpoints (columns)

1. **Anthropic-direct** — `src/core/rebelCore/clients/anthropicClient.ts` (native Messages API).
2. **OpenRouter passthrough** — Anthropic-shaped body proxied via `src/main/services/localModelProxyServer.ts`; non-Anthropic OR models need Anthropic-only fields stripped/translated.
3. **OpenAI Chat-Completions** — `src/core/rebelCore/clients/openaiClient.ts` (`requestCompletion` / `streamChatCompletions`) and the proxy's OpenAI-compatible egress.
4. **OpenAI / Codex Responses** — reached when `needsResponsesApiRoute()` is true or in Codex mode; the body is rebuilt by `translateChatToResponses()`.
5. **Local OpenAI-compatible** — Ollama / LM Studio / BYO profiles served through the proxy's OpenAI egress.

## The matrix (rows = params)

| Param / feature | Anthropic-direct | OpenRouter passthrough | OpenAI Chat-Completions | OpenAI/Codex Responses | Local OpenAI-compat | Strip/translate code site |
|---|---|---|---|---|---|---|
| `temperature` / `top_p` | supported | supported (Anthropic body) | **stripped for OpenAI reasoning models** via enforced-chokepoint, else forwarded if present | **dropped** (translator-allowlist) | forwarded if present (non-OpenAI/non-reasoning) | Responses translator-allowlist: `translateChatToResponses` (codexResponsesTranslator.ts). Chat-Completions enforced-chokepoint: `finalizeChatCompletionsBody` wraps `stripUnsupportedChatCompletionsSamplingParams` (chatCompletionsParamCapability.ts) and brands the body before `/chat/completions` egress; non-reasoning/non-OpenAI keep them. The rebel-core `openaiClient.ts` never sets `temperature`. |
| `thinking` → `reasoning_effort` / `reasoning` | native `thinking` | translated to OR `reasoning.max_tokens` | `reasoning_effort` forwarded for reasoning models; **stripped for first-party OpenAI *non-reasoning* models** via enforced-chokepoint | translated to `reasoning.effort` | forwarded per profile (non-OpenAI/unknown kept) | `translateThinkingToReasoning` (localModelProxyServer.ts) for OR; `translateChatToResponses` maps `reasoning_effort`→`reasoning.effort` on Responses. Chat-Completions enforced-chokepoint: `finalizeChatCompletionsBody` wraps `stripUnsupportedChatCompletionsReasoningParams` (chatCompletionsParamCapability.ts) to drop `reasoning_effort` for first-party OpenAI non-reasoning models (e.g. a `gpt-4.1` profile with a stale `reasoningEffort`); non-OpenAI/unknown models keep it. |
| `context_management` | supported | dropped for non-Anthropic models | n/a | n/a | n/a | `stripContextManagementForNonAnthropic` (localModelProxyServer.ts) — gated by `isAnthropicModel`. |
| `context-management` beta header flags | sent (`anthropic-beta`) | stripped for non-Anthropic models | n/a | n/a | n/a | `stripContextManagementBetaFlag` (localModelProxyServer.ts) — strips `context-management-2025-06-27` + `compact-2026-01-12`. |
| Anthropic compact (`compact_20260112`) | supported **per Claude model** | n/a | n/a | n/a | n/a | Gated by `modelSupportsAnthropicCompact` in `buildContextManagementConfig`; runtime 400 fallback in `runWithCompactFallback` (anthropicClient.ts). |
| top-level `cache_control` | supported | dropped on Bedrock/Vertex 404 fallback | n/a | n/a | n/a | `stripTopLevelCacheControl` + `prepareFallbackRetryBody` (localModelProxyServer.ts); block-level cache stays. |
| `max_tokens` vs `max_completion_tokens` vs `max_output_tokens` | `max_tokens` | `max_tokens` (Anthropic body) | `max_completion_tokens` only | **dropped** (`max_output_tokens` not emitted) | `max_completion_tokens` | rebel-core sends only `max_completion_tokens` (openaiClient.ts `doCreate`/`doStream`); proxy maps Anthropic `max_tokens`→`max_completion_tokens`; `translateChatToResponses` deliberately omits `max_output_tokens`. |
| vision / inline images | gated per model | gated per model | gated by capability | gated by capability | gated by capability | `capabilities.supportsImageContent(model)` — a function of the per-request model: provider term (`supportsInlineImageContent`, providerFeatureGuards.ts, OpenAI-compat only) AND model term (`modelSupportsImageInput`, modelCatalog.ts; deepseek family is text-only, unknown ids fail open); translators substitute text placeholders when unsupported. |

`n/a` = the param/feature has no meaning on that protocol (e.g. `context_management` is an Anthropic Messages-API concept).

## Key code sites (verify before editing)

- `src/core/services/codexResponsesTranslator.ts` — `translateChatToResponses()` is a **positive-allowlist chokepoint**: it forwards only fields it explicitly constructs, so sampling params (`temperature`, `top_p`, `max_output_tokens`) are dropped by omission. The in-file comment documents which fields the Responses API 400s on. **Do not add a `temperature`/`top_p` pass-through here.**
- `src/core/services/chatCompletionsParamCapability.ts` — `finalizeChatCompletionsBody()` is the **enforced Chat-Completions chokepoint**. It calls both strip helpers, then returns a branded `ValidatedChatCompletionsBody` for `/chat/completions` egress. The strip helpers remain exported implementation details; callers mint the brand only through `finalizeChatCompletionsBody`.
- `src/main/services/localModelProxyServer.ts` — `stripContextManagementForNonAnthropic`, `stripContextManagementBetaFlag`, `translateThinkingToReasoning`, `stripTopLevelCacheControl`, `prepareFallbackRetryBody`. This is also where inbound Anthropic `temperature` is **forwarded** into the outbound `OpenAIRequest` (several egress sites guarded by `if (anthropicRequest.temperature !== undefined)`).
- `src/core/rebelCore/clients/anthropicClient.ts` — `modelSupportsAnthropicCompact()`, `buildContextManagementConfig()`, `runWithCompactFallback()`, `isCompactNotSupportedError()`. Compaction support is a **per-Claude-model** capability, not a transport capability — the gate intentionally lives here, not in `providerFeatureGuards.ts`.
- `src/core/rebelCore/clients/openaiClient.ts` — `needsResponsesApiRoute()` (route to Responses when tools + reasoning_effort on a Responses-route provider), `assertChatCompatibleModel()` (fail-closed on non-chat OpenAI models). This client emits only `max_completion_tokens` and never sets `temperature`.
- `src/core/rebelCore/providerFeatureGuards.ts` — `takesResponsesApiRoute`, `nonChatModelGuardEnabled`, `supportsInlineImageContent` (the per-provider-type capability flags consumed above).

## Design note: temperature stripping per seam

The Responses seam strips `temperature` centrally (one translator-allowlist in `translateChatToResponses`). The **Chat-Completions** egress now strips `temperature`/`top_p` **for first-party OpenAI *reasoning* models** via the branded `finalizeChatCompletionsBody` chokepoint (`src/core/services/chatCompletionsParamCapability.ts`), keyed on the `ModelOption.reasoning` capability — gpt-5.x reasoning models reject explicit `temperature` (HTTP 400), gpt-4.1 and other non-reasoning models accept it and keep it. (This closed a real latent leak found by a spike — operator-consult sets `temperature` and a reasoning-model `profile-http` turn used to 400; see the Decision Log in `docs/plans/260530_model-provider-hardening/PLAN.md`.) Non-OpenAI providers and models not in the OpenAI preset list are left unchanged (conservative — no over-stripping). New `buildCompletionsUrl` POST modules must call `finalizeChatCompletionsBody`; `validate:fast` runs `scripts/check-chat-completions-chokepoint.ts` to fail production files that skip it or forge the `ValidatedChatCompletionsBody` brand.

**Guidance when adding a param or a route:** confirm the strip/translation applies on the *specific* route you are wiring. A param dropped on the Responses seam is **not** automatically dropped on the Chat-Completions seam, and vice-versa. The operator-consult postmortem above is exactly this failure: a reroute moved traffic onto a seam whose contract differed. Add a guardrail test that asserts the param does/doesn't reach the upstream for the route you touched.

## See also

- [LOCAL_MODEL_SUPPORT](./LOCAL_MODEL_SUPPORT.md) — proxy architecture, BTS routing, dual-translator reasoning-replay invariants; owns the `localModelProxyServer.ts` strip/translate machinery cited above.
- [REBEL_CORE](./REBEL_CORE.md) — agent runtime and the rebel-core model clients (`anthropicClient.ts`, `openaiClient.ts`).
- [MODEL_CONSTANTS](./MODEL_CONSTANTS.md) — model constants + normalization rules feeding provider-aware routing; don't hardcode model ids — signpost to the owning constant.
- [LLM_CALL_SITES](./LLM_CALL_SITES.md) — inventory of where LLM requests originate (the callers that build the bodies routed here).
- [`260505_typed_provider_capability_matrix`](../plans/260505_typed_provider_capability_matrix.md) — the structural fix that turns this prose table into a typed, enforced capability matrix.
