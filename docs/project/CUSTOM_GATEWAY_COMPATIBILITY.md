---
title: Custom (OpenAI-compatible) gateway compatibility
description: How Rebel talks to a "custom endpoint" model profile, the reasoning/tool parameter-translation hazards when that endpoint proxies to a native provider (litellm → Vertex / Bedrock / Azure), how to diagnose them, and what to keep in mind when bumping models.
audience: internal / dev
last_updated: "2026-06-19"
---

# Custom (OpenAI-compatible) gateway compatibility

Some deployments — typically enterprises with an internal LLM gateway — point Rebel at a
**custom OpenAI-compatible endpoint** instead of a first-party provider. In Rebel this is a
model profile with provider **"Other (custom endpoint)"** (`providerType: 'other'`): Rebel
speaks the **OpenAI Chat-Completions protocol** to it via `OpenAIClient`.

These gateways are frequently a **proxy that re-translates** the OpenAI request into a
*different* native provider's API — e.g. a [litellm](https://github.com/BerriAI/litellm)
proxy in front of **Vertex AI** (Anthropic + Gemini), **AWS Bedrock**, or **Azure OpenAI**.
That re-translation step is where compatibility breaks: Rebel sends a clean OpenAI request,
but the gateway must turn it into the native shape the underlying model actually accepts, and
it can pick a stale, deprecated, or incomplete form.

This is a **repeatable pattern** — any enterprise gateway integration can hit it — so it's
worth understanding the class rather than each instance.

> **Why this matters when bumping models.** The most common trigger is a **model-default
> change** (see [`NEW_MODEL_SUPPORT_PROCESS.md`](NEW_MODEL_SUPPORT_PROCESS.md)). When Rebel's
> default thinking/working model id changes, custom-gateway profiles that were happily routing
> the old id can suddenly send a *new* model id (or a *new* parameter) that the gateway's
> translation config doesn't know about yet — and the deployment breaks without any change on
> their side. **Treat custom-gateway customers as a compatibility surface when adding or
> defaulting to a new frontier model.**

## The core hazard: reasoning / "thinking" parameter translation

Rebel attaches an OpenAI **`reasoning_effort`** parameter to requests for any model it treats
as "effort-capable" (this is decided by model-id in `modelLimits.ts` — `supportsEffort()` /
`resolveEffortForApi()`). For a first-party Anthropic request, Rebel's *native* client instead
emits the correct Anthropic thinking shape (`resolveThinkingConfig` → `{type: 'adaptive'}` +
`output_config.effort`). But a `providerType: 'other'` gateway profile goes through
`OpenAIClient`, which only knows `reasoning_effort`.

If the gateway then **mistranslates `reasoning_effort` into a native thinking parameter the
underlying model rejects**, the request 400s. Two concrete shapes seen in production:

### 1. Anthropic-behind-gateway — `thinking.type.enabled` rejected

A litellm→Vertex gateway serving Claude translated OpenAI `reasoning_effort` into the
**deprecated** Anthropic `thinking: {type: "enabled"}` form, which newer Vertex Claude models
reject with:

```
"thinking.type.enabled" is not supported for this model.
Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
```

**Mitigations (in order of preference):**

1. **Gateway-side (root fix):** the gateway owner updates their proxy config to emit the
   adaptive thinking shape (or to map the model id Rebel now sends). This is the durable fix —
   it survives future model bumps and is the only place that *owns* the OpenAI→native
   translation. Rebel should not try to inject native-provider keys through a generic OpenAI
   client (that would break other proxies).
2. **Rebel-side, auto-detect:** run the profile's **Test** button. It probes the endpoint with
   `reasoning_effort`, sees the 400, and marks the profile `thinkingCompatibility: 'incompatible'`.
   From then on every egress path sends **no** `reasoning_effort` for that profile — sidestepping
   the mistranslation entirely, and self-healing if a later Test succeeds. See "How suppression
   works" below. (There is no manual "turn thinking off" toggle — suppression is purely this
   detected verdict.)
3. **Point the profile at a model the gateway already handles** (e.g. a model id whose
   translation the gateway has working today). One-click via the profile's Model ID field.

### 2. Gemini-behind-gateway — missing `thought_signature` on tool calls

A gateway routing to Vertex **Gemini** for **tool-calling** turns can fail with:

```
Function call is missing a thought_signature in functionCall parts.
This is required for tools to work correctly...
```

Gemini requires the per-functionCall `thought_signature` it returns to be echoed back on every
subsequent turn (native field `functionCall.thoughtSignature`).

**The OpenAI wire shape _can_ carry the signature — but there are two incompatible conventions,
and Rebel/its proxy implement the one most gateways do _not_ use:**

| Convention | Where the signature lives | Who uses it |
| --- | --- | --- |
| **Google OpenAI-compat** | `tool_calls[].extra_content.google.thought_signature` | Google's own endpoint + **Rebel's local proxy** |
| **litellm** | embedded in `tool_call.id` as `call_xxx__thought__<sig>` **and** `tool_calls[].provider_specific_fields.thought_signature`; does **not** use `extra_content` | litellm proxies |

So a litellm gateway and Google's endpoint disagree on _where_ the field lives. This matters
because the prior framing here — *"the OpenAI wire shape has no field to round-trip the token,
so it's not code-fixable through an OpenAI-protocol gateway"* — is **directionally right but
for the wrong reason**. The wire shape _can_ carry the token (via the id / `provider_specific_fields`,
or via `extra_content`); the real causes are a **convention mismatch** plus a **litellm
streaming bug**:

- Rebel **already echoes `tool_call.id` verbatim** through the `ToolUseBlock` round-trip
  (`openaiTranslators.ts` capture at response-parse → re-inject at request-build, both
  non-streaming and streaming). So litellm's id-embedding convention *should* round-trip for free
  on a **non-streaming** turn.
- **…but litellm has a documented streaming-drop bug**: its `stream_chunk_builder` discards the
  signature when reassembling streamed chunks (litellm issues #16893, #25322) — and Rebel
  **streams**. A signature the gateway never delivers cannot be re-injected by any client-side
  round-trip. Combined with litellm-version dependence, this is the likely live cause, and it is
  **gateway/version-side**, not a Rebel-client bug.

In short: the gap is a convention mismatch + a gateway/litellm streaming-drop bug, **not** a
fundamental "the OpenAI protocol can't express this" limitation. Whether a given gateway actually
surfaces the signature (and in which convention) can only be known from its real traffic — which
is what the diagnostic below measures.

**What Rebel does today:**
- **Surfaces it clearly.** The 400 is recovered from the (often Python-`b'…'`-wrapped) body by
  `extractHttpErrorMessage`, and `classifyErrorUx` gives an actionable, non-cryptic banner for the
  `thought_signature` case ("This model can't use its tools through your current setup …") instead
  of dumping the raw provider string. (Detected by a `thought.?signature` match on the recovered
  message; see `packages/shared/src/utils/classifyErrorUx.ts` `invalid_request` branch + test.)
- **Measures which convention a gateway surfaces (diagnostic).** On the custom-gateway path
  (`providerType:'other'`), Rebel classifies each tool-call's signature presence — id-embedded vs
  `provider_specific_fields` vs `extra_content` — and emits one PII-safe analytics event,
  **`Gateway Tool Signature Observed`** (counts/booleans only; the diagnostic never **extracts,
  logs, or emits** the signature **value**). Note the litellm id-embedding convention puts the
  signature inside `tool_call.id`, which Rebel already preserves verbatim into `ToolUseBlock.id` —
  so the accurate claim is "never extracted/logged/emitted as a value", not "never stored". It
  fires on **both** the streaming and non-streaming paths so we can
  see whether streaming drops a signature non-streaming would keep. `withAnySignature: 0` is itself
  the diagnosis (the gateway never surfaced it → litellm streaming-drop / old version → not
  client-fixable); any `withX > 0` tells us which convention to echo *if* we later build a
  round-trip. See `src/core/rebelCore/clients/gatewayToolSignatureDiagnostic.ts` and the wire-up at
  the response-parse / stream-finalize seams in `openaiClient.ts`. (Round-trip / non-streaming
  mitigation is **deferred until this telemetry tells us the real scenario** — see the plan in
  `docs/plans/260619_gemini-thought-signature-roundtrip/`.)
- **The desktop local proxy already round-trips the signature** — `localModelProxyServer.ts`
  captures `extra_content.google.thought_signature` from Gemini responses and re-injects it on
  later turns. Note this is the **Google** convention; a litellm gateway uses the id /
  `provider_specific_fields` convention instead, so the proxy's approach would not transfer
  verbatim to a litellm gateway.
- **Auto-marked at runtime.** When this error fires on a turn, `turnErrorRecovery.ts` detects it
  via `isToolUseIncompatibilityError` (`modelErrors.ts`) and marks the active profile
  `toolUseCompatibility: 'incompatible'` (mirroring the chat-incompat auto-mark) — so the profile
  shows the **"No Tools"** badge and the verdict persists, complementing the per-turn banner. The
  Test button also sets it. **Still open:** nothing yet *consumes* `toolUseCompatibility` to steer
  routing away from tools or to fail a turn fast — a deliberate next step (the working model *needs*
  tools, so the consumer is a product decision: block-the-turn-with-a-switch-recovery vs warn).

**Operational path for a Gemini-behind-gateway tool-call failure:**
1. Get the gateway's **litellm version** — the streaming-drop bug is version-dependent; recommend a
   version that carries the fix.
2. Check the `Gateway Tool Signature Observed` telemetry for that deployment to confirm whether the
   gateway surfaces a signature at all, and in which convention.
3. As an interim, consider **non-streaming** for tool-heavy Gemini-via-gateway turns (litellm's
   streaming reassembly is where the signature is dropped), or have the gateway owner preserve the
   signature end-to-end.

## How suppression works

- **One signal — `ModelProfile.thinkingCompatibility`** (`'unknown' | 'compatible' | 'incompatible'`;
  TS `src/shared/types/settings.ts`, Zod `src/shared/ipc/schemas/settings.ts`). Set automatically by
  the profile **Test** button (`useProfileTester.ts`) — which probes the endpoint with
  `reasoning_effort` — or by a runtime auto-mark. There is **no** manual "turn thinking off"
  preference: suppression is purely this detected capability verdict, so it **self-heals** if a
  later Test succeeds. (A former manual `reasoningDisabled` flag was removed 2026-06-18 — see the
  migration note below.)
- **The single suppression gate (kills the class by construction):** two pure helpers in
  `src/shared/utils/reasoningSuppression.ts` (re-exported from `src/core/rebelCore/modelLimits.ts`
  so the egress code keeps its domain-local import path) —
  - `shouldSuppressProfileReasoning(profile)` → `true` when `thinkingCompatibility === 'incompatible'`.
  - `resolveProfileReasoningEffort(profile)` → the profile's `reasoningEffort`, or `undefined`
    when suppressed.

  The helpers live in **shared** (depending only on the `ModelProfile` type) precisely so the
  renderer can read through the *same* predicate the wire does — egress and UI can't drift.

  The verdict is honoured at **every** profile-driven egress, so the class can't re-open by adding
  a new egress path that reads `profile.reasoningEffort` raw:
  - **Direct `OpenAIClient`** — `clientFactory.ts` passes `suppressReasoningEffort:
    shouldSuppressProfileReasoning(profile)` (also in Codex mode); the client omits
    `reasoning_effort` in `doCreate`/`doStream`. `providerType:'other'` profiles route here, so
    desktop, cloud, and mobile primary turns all benefit (the gate lives in shared core).
  - **Desktop local model proxy** (`localModelProxyServer.ts`) — all egress sites and
    `needsResponsesApiRoute` use `resolveProfileReasoningEffort(profile)`; the Codex passthrough
    honours it at the working-profile inheritance seam. (Timeout tuning still reads the raw
    configured effort — it's not an egress parameter.)
  - **`normalizeSettings`** (`settingsUtils.ts`) **migrates** any legacy `reasoningDisabled:true`
    profile to `thinkingCompatibility:'incompatible'` (and drops the field), so a profile that was
    relying on the old manual flag keeps suppressing rather than re-leaking `reasoning_effort`. The
    schema is `.passthrough()`, so the legacy key survives Zod until this boot-time migration runs.

- **The read-only thinking display honours the same gate.** The profile table's thinking pill
  (`ProfileTable.tsx` → `ThinkingLevelPill`) renders `resolveProfileReasoningEffort(profile)`, not
  the raw `profile.reasoningEffort` — so a suppressed (thinking-incompatible) profile shows
  **"No reasoning"** rather than advertising a thinking level it no longer sends. The wizard editor
  still shows the *configured* effort (it edits intent); the table shows the *effective* state. The
  "why" (incompatible) is carried by the adjacent `ChatCompatibilityBadge`. The **planner routing
  catalogue** (`planningMode.ts` → `buildPlanningRoutingPool`) likewise gates a profile's advertised
  `reasoning` capability on `shouldSuppressProfileReasoning`, so a suppressed profile isn't offered
  to the routing LLM as thinking-capable.

  (Egress gate landed 2026-06-17; display + planner consistency and the collapse to the single
  auto-detect signal, 2026-06-18. Cross-family reviewed. Sentry REBEL-5RJ.)

## Diagnosing a gateway 400

- The thrown error is a `ModelError` classified by `classifyHttpError`
  (`src/core/rebelCore/modelErrors.ts`); the egress frame is
  `OpenAIClient.streamChatCompletions`.
- Proxy errors often arrive as a **Python-bytes-wrapped** non-JSON body (e.g.
  `b'{"error": ...}'`). `extractHttpErrorMessage` recovers the embedded provider message from
  that wrapper so the real reason surfaces instead of raw bytes; the recovered text is redacted
  before it becomes user-facing banner copy (`redactRawError.ts`,
  `agentEventDispatcher.ts`, `classifyErrorUx.ts`).
- A telltale of a stale gateway config is a server-side fallback map that only knows *older*
  model ids ("No fallback model group found for …") — i.e. the gateway hasn't been updated for
  the model id Rebel is now sending.

## Related

- [`MODEL_AND_PROVIDER_OVERVIEW.md`](MODEL_AND_PROVIDER_OVERVIEW.md) — territory hub: how a
  model is chosen, routed, authed, billed, and given a thinking budget.
- [`NEW_MODEL_SUPPORT_PROCESS.md`](NEW_MODEL_SUPPORT_PROCESS.md) — adding/upgrading a frontier
  model (the most common re-break trigger).
- [`NEW_PROVIDER_SUPPORT_PROCESS.md`](NEW_PROVIDER_SUPPORT_PROCESS.md) — adding a new provider
  (BYOK / custom-endpoint archetype).
- [`REBEL_CORE.md`](REBEL_CORE.md), [`ARCHITECTURE_AGENT_TURN_EXECUTION.md`](ARCHITECTURE_AGENT_TURN_EXECUTION.md)
  — runtime + turn pipeline.
