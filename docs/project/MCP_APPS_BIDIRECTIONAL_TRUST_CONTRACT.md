---
description: "Canonical contract for the MCP Apps iframe-host trust boundary: provenance envelope, freshness/replay protection, rate limits, permission model, and logging requirements."
last_updated: "2026-05-11"
---

# MCP Apps Bidirectional Trust Contract

**Status:** Canonical (v1, 2026-05-10)  
**Owner:** MCP Apps iframe ↔ host boundary (`McpAppView`, MCP Apps IPC handlers, shared trust types)  
**Related:** [`MCP_UI_APPS.md`](MCP_UI_APPS.md), [`SUPER_MCP_PASSTHROUGH_CONTRACT.md`](SUPER_MCP_PASSTHROUGH_CONTRACT.md), [`BOUNDARY_REGISTRY.md`](BOUNDARY_REGISTRY.md)

## Purpose & Scope

This contract is the single source of truth for the MCP Apps iframe-host trust boundary. Phase A made MCP App views structurally visible and recoverable; Phase C lets those views send trusted requests back to the host. That second direction is where provenance, replay protection, rate limits, permissions, and logging must be specified before production code lands.

This contract covers:

- the provenance envelope attached to iframe-originated requests,
- freshness / replay protection for iframe loads,
- rate-limit shape and v1 starting values,
- default trust posture for current and future iframe methods,
- first-use permission behavior for conversation-mutating methods,
- structured logging requirements for every trust-boundary rejection.

This contract does **not** cover:

- cryptographic signature verification for `sourcePackageId` (v2 scope),
- tool-level capability tokens authorizing which iframe can call which tool (v2 scope),
- broader MCP Elicitation / HITL architecture beyond MCP Apps bidirectional messages.

## Surface applicability — desktop only in v1

This is a **desktop-only** trust contract for v1. The boundary exists where the Electron renderer hosts MCP App HTML in an iframe and routes iframe-originated JSON-RPC messages to the desktop host.

- **Desktop:** in scope. MCP App iframes exist and C1/C2/C3 must enforce this contract.
- **Cloud:** out of scope for v1. Cloud has no iframe host surface for MCP Apps.
- **Mobile:** out of scope for v1. Mobile renders the `TurnToolActivity` placeholder / structured fallback and does not execute interactive MCP App iframe code.

No permission grants, nonces, or trust-boundary rate-limit counters are synced cross-device in v1.

## Provenance envelope shape

The canonical envelope for host-authorized iframe messages is:

```ts
interface IframeProvenanceEnvelope {
  source: {
    kind: 'mcp-app';
    sourcePackageId: string;
    resourceUri: string;
    toolUseId: string;
  };
  timestamp: string; // ISO 8601
  sessionId: string;
  conversationId: string;
  iframeInstanceId: string;
  nonce: string; // freshness nonce, see below
}
```

This shape is the basis for all iframe → host messages added in C1/C2 (`ui/updateModelContext`, `ui/sendMessage`, and any copy/export delegate added after the C2 TODO). `ui/initialize` is the bootstrap exception: the initial request has no prior nonce, so the host derives the trusted source tuple, issues the nonce, stores it, and returns it to the iframe. Every subsequent message must include the nonce.

`McpAppUiMeta.sourcePackageId` remains optional in the manifest schema for legacy / migration compatibility, but the trust envelope requires a concrete `sourcePackageId`. C1/C2 handlers must reject iframe messages when the host-rendered `McpAppUiMeta.sourcePackageId` is missing or `null`; iframe-supplied source IDs are not a substitute.

The host derives this envelope from trusted host state, not from iframe-supplied params:

- `sourcePackageId` comes from the already-projected `McpAppUiMeta.sourcePackageId` / main-process routing state.
- `resourceUri` comes from the view metadata that caused the iframe load.
- `toolUseId`, `sessionId`, and `conversationId` come from the host-rendered message / session state.
- `iframeInstanceId` is assigned by the host at iframe mount (for example, a stable DOM element / React instance ID for that iframe load).
- `timestamp` is host-stamped when the request is accepted.
- `nonce` is host-issued per iframe load.

Iframe-supplied `sourcePackageId`, `sessionId`, `conversationId`, `toolUseId`, or `resourceUri` may be compared for diagnostics, but raw values must not be logged and they must never be the authority for scoping, permission lookup, or context/session mutation.

## Freshness / replay protection

Each iframe load gets a unique nonce issued by the host on first `ui/initialize`.

Nonce generation is security-sensitive:

- Generate nonces with `crypto.randomUUID()` (UUID v4).
- UUID v4 provides 122 bits of randomness; this is the minimum entropy for v1.
- Do **not** use UUID v1, sequential IDs, timestamps, counters, Math.random-style predictable PRNG output, package IDs, conversation IDs, or any deterministic derivation.

Protocol:

1. Iframe sends `ui/initialize`.
2. Host derives the trusted `(sourcePackageId, sessionId, conversationId, toolUseId, iframeInstanceId)` tuple from host state.
3. Host generates a UUID v4 nonce, stores it as the active nonce for that tuple, and returns it in the initialize result.
4. For each conversation-mutating / model-influencing request, the host bridge issues a fresh nonce immediately before dispatching the IPC request.
5. Host accepts only if the nonce matches the currently-active iframe nonce for the same `(sourcePackageId, sessionId, conversationId, toolUseId, iframeInstanceId)` tuple.
6. Nonce validation is **consuming**: a matching nonce is deleted during validation and cannot be reused, even if a later rate-limit, permission, role, or sanitization check rejects the request.

`iframeInstanceId` is the host-assigned identity for this iframe mount. It can be the iframe DOM element ID assigned at mount or an equivalent React instance ID; it must distinguish two live/reloaded iframes with the same tool result.

Invalidation:

- Conversation switch invalidates active nonces for the previous conversation view set.
- Iframe revoke / unmount invalidates that iframe load's nonce.
- Blob URL revocation invalidates that iframe load's nonce.
- Session end invalidates all session-scoped iframe nonces.

Messages from stale iframes are rejected with a synchronous JSON-RPC error and a structured host log. On nonce mismatch, log the safe source family/hash fields from the logging contract, `sessionId`, `conversationId`, attempted method, the attempted content hash, and the rejection reason. Do not log full content or raw `sourcePackageId`.

Example log shape (object first per Pino convention):

```ts
log.warn(
  {
    boundary: 'mcp-apps-bidirectional-trust',
    kind: 'replay',
    sourcePackageFamily,
    sourcePackageHash,
    sessionId,
    conversationId,
    method,
    nonce: nonce ?? 'none',
    reason: 'stale_nonce',
    attemptedContentBytes,
    attemptedContentHash,
  },
  'Rejected MCP App iframe message at trust boundary',
);
```

## Rate-limit shape

Rate limits apply in two dimensions:

1. **Per-method tiers** — counters keyed by method plus scope.
2. **Aggregate any-method tier** — counters keyed only by scope. This prevents a malicious iframe from rotating across method names to avoid per-method limits.

| Scope | Per-method v1 starting value | Aggregate any-method v1 starting value |
|---|---:|---:|
| Per-iframe | 10 messages / 60 seconds / method | 30 messages / 60 seconds across all methods |
| Per-conversation | 30 messages / 5 minutes / method | 100 messages / 5 minutes across all methods |
| Per-session | 200 messages / hour / method | 1,000 messages / hour across all methods |

The per-iframe tier is intentionally the most aggressive. It catches runaway or replayed iframe code before it can consume conversation/session budget. The aggregate tier is mandatory for all methods, including low-risk layout methods.

`ui/resize` is non-mutating but high-frequency. Iframe authors must debounce or `requestAnimationFrame`-coalesce resize messages before emitting them. The host still applies the aggregate tier to `ui/resize` to prevent renderer churn from a malicious or buggy iframe.

Trip behavior:

- The iframe receives a synchronous JSON-RPC error.
- The host emits a structured `warn` log with `sourcePackageFamily`, optional `sourcePackageHash`, `sessionId`, `conversationId`, method, nonce (or `"none"`), rejection reason, attempted content size in bytes (not content), attempt count, rate-limit tier, and time since first attempt.
- Counters reset on iframe unmount (including blob URL revocation), conversation switch, and session end.
- A new iframe load receives a new nonce and a new per-iframe counter. Conversation/session aggregate counters continue until their own scope resets.

Numeric limits are tunable. C1/C2 should keep the v1 values above unless a method needs a documented exception (for example, a non-mutating high-frequency UI method). Tuning should be done per method and recorded in the implementing stage log; never silently widen the global tiers.

## Default trust posture

- Deny by default for unrecognized methods. Return JSON-RPC `-32601` (`method not found`).
- `ui/sendMessage` defaults to `role: 'user'` only. Assistant-role injection is not enabled in v1; requests for assistant role are rejected with JSON-RPC `-32602` (`invalid params`).
- `ui/sendMessage` content is sanitized in the main process after nonce, rate-limit, and permission checks. The sanitizer strips known role/system/tool-call markers, CRLF-normalizes text, removes Unicode tag/control characters and excessive combining marks, and rejects the literal phrase "Ignore previous instructions" after normalization.
- Residual prompt-injection risk remains in v1: homoglyph and inline-role-confusion detection is pattern-based, not a complete natural-language safety classifier. It strips common role-claim contexts (including common Cyrillic/Greek confusables) and fails closed on the highest-risk literal phrase above. Broader semantic attacks remain model-safety / future capability-token work, not a reason to silently accept suspicious content.
- `ui/updateModelContext` defaults to attribution-required. The host injects an attribution prefix automatically, for example:

  ```text
  Context provided by app:<sourcePackageId> at <timestamp>:
  <content>
  ```

- Future methods must go through this contract review before implementation. If a future plan touches MCP Apps bidirectional trust, it should run `npx tsx scripts/boundary-hints.ts --planning-doc <path>` and cite this document in its Spec Reader block.

Allowed v1 method names are:

- `ui/initialize` — bootstrap / host context / nonce issuance.
- `ui/sendMessage` — C2; injects a user-authored message-like request into the conversation flow. Permission-gated.
- `ui/updateModelContext` — C1; supplies attributed context for the next model turn. Permission-gated because it influences model behavior equivalently to send-message.
- `ui/resize` — already wired; non-mutating layout signal, still part of the known method set; debounce/rAF-coalesce iframe-side and aggregate-rate-limit host-side.
- `tools/call` — already wired; package-scoped tool calls, additionally governed by nonce freshness, rate limits, allowlists, permissions where applicable, and tool safety.

Existing `tools/call` handling in `McpAppView.tsx` + `mcpAppsHandlers.ts` must be retrofitted in C3 to honor nonce validation, aggregate/per-method rate limits, and the permission/allowlist policy in this document. It is **not** an intentional v1 exception. Leaving `tools/call` on the old path would create a load-bearing hole in the trust boundary.

`tools/call` allowlisting is mandatory. The host must validate `(sourcePackageId, toolName)` against an explicit allowlist before dispatching. Current loose allowlisting patterns (for example, family-specific entries such as `google-workspace/send_workspace_email`) must be tightened and codified in C3 so app-only tool calls cannot drift into broad package-level capability.

## Permission model (v1)

Conversation-mutating or model-influencing methods require first-use permission per `(sourcePackageId, conversationId)`.

Permission-gated methods in v1:

- `ui/sendMessage`
- `ui/updateModelContext`

Model-influencing methods are permission-gated equivalently to send-message because they can alter the next assistant response even when they do not append visible transcript text.

Behavior:

- First use prompts the user before the host executes the request.
- `ui/updateModelContext` first-use prompt: **"This view wants to provide context to the assistant."**
- Grant applies only to the specific `(sourcePackageId, conversationId)` pair and listed method set.
- Permission denial returns a synchronous JSON-RPC error `-32603`; iframe code must handle it gracefully.
- Revocation is synchronous in settings UI and takes effect on the next iframe message.
- TTL: none in v1. Grants persist until revoked or until their conversation is deleted.
- On conversation deletion, matching permission entries are cleaned up.
- No cross-device sync in v1; this is an explicit desktop-only cross-surface exception.

Persistence:

- Store: desktop `electron-store` settings.
- Key: `mcpAppsTrust.permissions`.
- Shape:

```ts
type McpAppTrustPermissionStoreV1 = Record<
  string, // sourcePackageId
  Record<
    string, // conversationId
    {
      granted: boolean;
      grantedAt: string; // ISO 8601
      methods: string[];
    }
  >
>;
```

Method membership is explicit via `methods`; do not treat a package/conversation grant as permission for every future method. Do not use renderer `localStorage` for this permission state.

## Host-to-iframe permission-change forwarding

The renderer may forward the existing host-side `mcp:permission-changed` broadcast into a live MCP App iframe so iframe code can retry a request that previously failed at the permission gate. This forwarding is a renderer-only `window.postMessage` contract; it is not a new IPC invoke channel and it does not grant authority by itself.

Forwarding rules:

- The host must forward only after matching the broadcast to the host-rendered iframe's trusted `sourcePackageId` and `conversationId`; iframe-supplied identifiers are not authority for this match.
- The forwarded iframe payload must be scoped and minimal: `{ kind: 'mcp-app:permission-changed', scope, sourcePackageId }`. It must not include nonces, raw user account data, secrets, OAuth tokens, tool arguments, message content, or unrelated permission records.
- The iframe must verify `event.source === window.parent` before processing `mcp-app:permission-changed`. Messages from nested iframes, sibling windows, or synthetic non-parent sources are ignored.
- A forwarded permission-change message is only a hint to retry through the normal trust path. Any retry must issue a fresh host-side nonce and pass the standard rate-limit, permission, role, sanitizer, attribution, and logging checks for the underlying method.

## Logging contract

Every trust-boundary trip must log structured Pino with these fields:

- `boundary: 'mcp-apps-bidirectional-trust'`
- `kind`: one of `rate_limit`, `replay`, `permission_denial`, `unknown_method`, `invalid_role`, `invalid_params`, `injection_failed`
- `sourcePackageFamily`
- `sourcePackageHash` (optional)
- `sessionId`
- `conversationId`
- `method`
- `nonce` (or `"none"`)
- `reason`
- `attemptedContentBytes` (not content)

Additional allowed diagnostic fields:

- `toolUseId`
- `resourceUri`
- `rateLimitTier`
- `attemptCount`
- `timeSinceFirstAttemptMs`
- `attemptedContentHash` for replay / nonce mismatches
- `subkind` for invalid-params discriminators such as `oversized`, `all_stripped`, or `prompt_injection_literal`

Accepted-but-sanitized `ui/sendMessage` content logs an `info` breadcrumb with `kind: 'sanitization_applied'`, marker/control counts, and original/sanitized lengths. It also appends a user-visible cleaned indicator to the displayed app-attributed message. Broadcast failures after trust checks pass must log `kind: 'injection_failed'` with attempted bytes before returning an error to the iframe.

Never emit raw `sourcePackageId` in structured logs. It can contain email addresses, user IDs, UUIDs, or other instance-specific identifiers. Instead:

- Log `sourcePackageFamily` derived with the A3d display-name resolver pattern in `src/renderer/features/agent-session/utils/mcpAppDisplayNames.ts` (strip suffix tails such as email slugs, UUIDs, `userid` / `uid` / `user` suffixes, and numeric IDs; keep examples like `GoogleWorkspace-jane-example-com` at `GoogleWorkspace` / `Google Workspace` family level, and families such as `Notion` without instance suffixes).
- Optionally log `sourcePackageHash`, defined as the first 8 hex characters of SHA-256 over the raw `sourcePackageId`, for traceability without leaking the identifier.

Do not log message content, model context content, tool arguments, secrets, OAuth tokens, API keys, raw `sourcePackageId`, or raw iframe payloads.

## Trust language reconciliation

A3d's `From X · Safe view` strip surfaces the source identity claimed by the installed connector instance and normalized through the display-name resolver. In v1, `From X` is **connector-asserted**, not Rebel-verified by cryptographic signature.

This is accepted v1 behavior because installation is the trust act: the user installed / enabled the connector instance, and Rebel routes the view from host-derived state for that installed instance. V2 can add signature verification and a verified-vendor distinction in the source strip. Do not soften or rewrite A3d's user-facing copy unilaterally in C0; document this gap for future review instead.

App-attributed `ui/sendMessage` transcript text uses a private-use marker prefix (`U+E001 APPMSG`, `U+E002`, `U+E003`) plus base64-encoded attribution JSON. Ordinary typed text with the old human-readable prefix is not attributed. This is acceptable v1 spoof resistance because normal keyboards cannot type the marker sequence, but it is not cryptographic: a user can copy-paste private-use code points from another app. V2 should move attribution out of message text and into structured event metadata once the session event manifest is stable.

## Central trust-policy map and CI guard

Every dispatcher-supported iframe method must be registered in a central trust-policy map. The map should be the only source of truth for permission posture and rate-limit tiers; adding a new `IframeMessageMethod` without a policy must fail TypeScript.

```ts
type TrustPermissionScope = 'none' | 'firstUse' | 'allowlistOnly';

type TrustRateLimitPolicy = {
  iframe: number;
  conversation: number;
  session: number;
  aggregate?: number;
};

type TrustMethodPolicy = {
  permissionScope: TrustPermissionScope;
  rateLimit: TrustRateLimitPolicy;
};

const TRUST_POLICIES = {
  'ui/initialize': { permissionScope: 'none', rateLimit: { iframe: 30, conversation: 100, session: 500, aggregate: 500 } },
  'ui/sendMessage': { permissionScope: 'firstUse', rateLimit: { iframe: 3, conversation: 10, session: 50, aggregate: 50 } },
  'ui/updateModelContext': { permissionScope: 'firstUse', rateLimit: { iframe: 5, conversation: 20, session: 100, aggregate: 100 } },
  'ui/resize': { permissionScope: 'none', rateLimit: { iframe: 30, conversation: 100, session: 1000, aggregate: 1000 } },
  'tools/call': { permissionScope: 'allowlistOnly', rateLimit: { iframe: 10, conversation: 50, session: 200, aggregate: 200 } },
} satisfies Record<IframeMessageMethod, TrustMethodPolicy>;
```

Use the `satisfies Record<IframeMessageMethod, TrustMethodPolicy>` pattern as the compile-time tripwire. Add a contract test in C1/C2/C3 that asserts the runtime dispatcher only handles methods present in `TRUST_POLICIES`.

## What v1 does NOT include (deferred to v2)

- Cryptographic signature verification of `sourcePackageId`. In v1, any iframe payload can claim any package ID; host-side state is therefore the authority, not iframe params.
- Tool-level capability tokens that specify which iframe can call which tool.
- Cross-conversation context sharing.
- Multi-window iframe shared state.

These are deferred because v1's host-derived envelope + nonce + first-use permission model is sufficient for C1/C2's scoped bidirectional messages, while signature verification and capability tokens require a broader package identity and tool authorization design.

## Boundary registry hint

This contract is registered in [`boundary-registry.yaml`](boundary-registry.yaml) as `mcp-apps-bidirectional-trust`. Future planning docs touching MCP Apps bidirectional trust should run `npx tsx scripts/boundary-hints.ts --planning-doc <path>` and reference this document.

## References

- Parent plan: [`260507_unified_interactive_ui_architecture.md`](../plans/260507_unified_interactive_ui_architecture.md)
- Sequencing doc: [`260507_unified_interactive_ui_architecture_sequencing.md`](../plans/260507_unified_interactive_ui_architecture_sequencing.md) § Stage C0
- HITL plan: [`260330_mcp_apps_hitl_architecture.md`](../plans/260330_mcp_apps_hitl_architecture.md) — predecessor; this contract supersedes the HITL Phase 1 trust skeleton
- A0 super-mcp contract: [`SUPER_MCP_PASSTHROUGH_CONTRACT.md`](SUPER_MCP_PASSTHROUGH_CONTRACT.md) — sister contract upstream of the renderer
