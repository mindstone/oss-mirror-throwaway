---
description: "Canonical contract for Super-MCP use_tool output shaping: outer-block schema, passthrough field hoisting rules, materialisation behaviour, and forbidden regression patterns."
last_updated: "2026-05-11"
---

# Super-MCP Passthrough Contract

**Status:** Canonical (v1, 2026-05-09)
**Owner:** `super-mcp/src/handlers/useTool.ts` (producer); consumers listed below.
**Related:** [`MCP_UI_APPS.md`](MCP_UI_APPS.md), [`SUPER_MCP_LIFECYCLE.md`](SUPER_MCP_LIFECYCLE.md), [`MCP_APP_SUPER_MCP_SEAM.md`](MCP_APP_SUPER_MCP_SEAM.md) (full app-consumed seam table + `superMcpContract.ts` signpost), [`BOUNDARY_REGISTRY.md`](BOUNDARY_REGISTRY.md) (see entry `super-mcp-passthrough`).

## Why this contract exists

Super-MCP's `use_tool` handler is the meta-tool the agent invokes for every external MCP server call. Internally it wraps the downstream tool result into a `UseToolOutput` envelope and JSON-stringifies it into a single `text` content block — the model sees one tidy text block; it does not see the underlying MCP `tool_result` shape.

That serialization step is invisible to consumers downstream (agent SDK, agentMessageHandler, MCP App iframes, mobile / cloud DTOs). The model-facing JSON envelope is **legitimate** — truncation, continuation hints, schema-hash handshake, and per-call telemetry all live in it.

The problem is when an MCP server returns **non-text-channel passthrough fields** — specifically `_meta.ui` (MCP Apps view metadata) and `structuredContent` (typed payload). The MCP spec passes these on the *outer* `tool_result` envelope, not as text content. Super-MCP's pre-Apps-era envelope wrapping silently dropped those fields: they survived inside the JSON-stringified envelope text, but were no longer visible structurally on the outer block — exactly the place every spec-compliant consumer reads them.

This produced a recurring class of bug:
- [`260417_materialisation_non_text_bypass`](../../docs-private/postmortems/260417_materialisation_non_text_bypass_postmortem.md) — `_meta.ui` lost when tool output was materialised.
- [`260427_super_mcp_iserror_propagation`](../../docs-private/investigations/260427_super_mcp_iserror_propagation.md) — `isError` lost across the boundary.
- The 2026-05-07 email-compose pre-fill bug — `structuredContent` lost across the same envelope, leaving the iframe form blank.

The fix is structural, not surgical: define the passthrough contract at the boundary, hoist the spec-conformant fields onto the outer block, and namespace super-mcp's own metadata cleanly so it cannot collide.

## The contract

When `use_tool` returns, its outer block MUST satisfy the following shape. Each field is normative.

### Outer block schema

```ts
{
  // Model-facing payload — UNCHANGED from pre-contract behaviour.
  // Always carries the JSON-stringified UseToolOutput envelope as a single
  // text block. Pass-through images (when present and non-error) follow the
  // text block. Annotation cache, truncation/continuation hints, materialisation
  // placeholder, and large-output warnings all live in this text block.
  content: Array<TextContentBlock | ImageContentBlock>;

  // MCP-Apps spec passthrough — HOISTED from inner.structuredContent.
  // Present iff the inner tool_result had structuredContent AND the result
  // is not a materialised placeholder for non-MCP-App tools (see § Materialisation).
  // Type carried opaquely (unknown).
  structuredContent?: unknown;

  // MCP-Apps spec passthrough — HOISTED from inner._meta.ui.
  // Present iff the inner tool_result had _meta.ui shaped like a usable
  // record (non-array object with non-empty string resourceUri).
  _meta?: {
    // Spec-passthrough namespace. Carries the McpAppUiMeta payload as-is.
    ui?: McpAppUiMeta;

    // Super-MCP's own telemetry namespace. Mirrored from the JSON envelope's
    // top-level fields so structural consumers don't have to parse the text
    // block to read them. Always present when use_tool produces a result.
    superMcp?: {
      packageId: string;
      toolId: string;
      durationMs: number;
      outputChars?: number;
      truncated?: boolean;
      resultId?: string;
      dryRun?: true;
      continuation?: true;
      staged?: true;
    };

    // Super-MCP materialisation namespace. Present iff `materializeOutput`
    // short-circuited (tool output ≥ 20K chars OR mixed text+images). Lets
    // structural consumers reason about materialised payloads without
    // parsing the text envelope.
    materialization?: {
      status: 'materialized' | 'oversized_output';
      originalChars?: number;
      filePath?: string;
      imageFiles?: string[];
    };
  };

  // Inner tool_result error flag — UNCHANGED.
  isError?: boolean;
}
```

### Hoisting rules

Outer metadata is constructed through a single egress helper:
`super-mcp/src/handlers/useTool.ts::buildOuter`. `buildOuter` is the only
caller of `applyOuterMeta`, so every successful, materialised, safety-net, or
bypass return gets `_meta.superMcp` from the same constructor. Throw paths remain
throws, and the `result_id`-without-`output_offset` continuation input-shape
error returns a plain error block as documented below.

The canonical downstream-tool paths are:

1. The success path (`callTool` resolved with no error).
2. The materialised path (`materializeOutput` short-circuited).
3. The serialized-output safety net (oversized-after-truncation placeholder).

Hoisting rules:

- **`structuredContent`:** hoist `inner.structuredContent` to the outer block when present. Carry as `unknown` (type-opaque). Do NOT clone or re-encode — this is a passthrough.
- **`_meta.ui`:** hoist `inner._meta.ui` to the outer block when shaped like a usable record (non-array object with non-empty string `resourceUri`). Malformed `_meta.ui` (`{}`, `[]`, primitive) is NOT hoisted; the inner JSON envelope still carries the original via `result`.
- **`_meta.superMcp`:** ALWAYS set on success, materialised, safety-net, and documented bypass paths. On downstream-tool paths it mirrors `package_id`, `tool_id`, `telemetry.duration_ms`, `telemetry.output_chars`, `telemetry.output_truncated`, `telemetry.result_id` from the JSON envelope. On bypass paths it carries the path flag described below. Allows consumers to reason about super-mcp routing without parsing the JSON envelope.
- **`_meta.materialization`:** ONLY set when `materializeOutput` short-circuited OR the safety-net placeholder fired. Mirrors the materialisation result for structural consumers.
- **`isError`:** preserved per [`260427_super_mcp_iserror_propagation`](../../docs-private/investigations/260427_super_mcp_iserror_propagation.md) — when `inner.isError === true`, the outer block carries `isError: true`. **`_meta.ui` and `structuredContent` are NOT hoisted from an error result** (the inner envelope is malformed; the outer block becomes a clean error envelope).

### Bypass paths (dry-run / continuation / _rebel_staged)

Three paths return without calling the downstream tool:

- **`_rebel_staged: true`** (toolSafetyService PreToolUse stub): `_meta.superMcp` IS emitted with `staged: true` flag. `_meta.ui` and `structuredContent` are NOT applied — there is no inner tool result.
- **`dry_run: true`**: `_meta.superMcp` IS emitted with `dryRun: true` flag. `_meta.ui` and `structuredContent` are NOT applied — the tool was not actually called.
- **`result_id` continuation**: `_meta.superMcp` IS emitted with `continuation: true` flag and the `resultId`. `_meta.ui` and `structuredContent` are NOT applied — these were already hoisted on the original tool call; continuation is a chunk re-read of the cached envelope text.

Structural consumers MUST tolerate the absence of `_meta.ui` / `structuredContent` on these paths. The `superMcp` flag identifies the path so consumers can attribute behavior correctly.

Continuation input-shape errors (specifically `result_id` without `output_offset`) emit a plain `{content, isError}` error block with no `_meta` — the call cannot form a valid continuation operation, the error text in `content[0].text` is the canonical signal, and there is no super-mcp telemetry to attribute. Other validation errors (package not found, schema validation failure, security policy block, auth-required) `throw` McpError-shaped exceptions per existing super-mcp conventions; they do not return `{content, isError}` and are unaffected by this section.

### Backward-compat invariant

The model-facing JSON envelope inside `content[0].text` is **unchanged** by this contract. Existing consumers that parse the JSON envelope (six known production paths via `parseUseToolEnvelopeJson`) keep working byte-identically. The contract is purely additive on the outer block — it adds structural visibility without removing the envelope.

This means:
- `mcpClient.cacheConnectorAnnotations` (which parses the JSON envelope for annotations) is unaffected.
- `agentMessageHandler` Method 0 (defense-in-depth envelope unwrap) is unaffected — it becomes vestigial for super-mcp paths but remains valid for replay of pre-contract sessions and direct-MCP fallback.
- Truncation suffix, continuation hint, large-output warning all stay in the text block.

## Consumer expectations

After this contract lands, the canonical consumer pattern is:

```ts
// CANONICAL — read structured fields directly off the outer block
const ui = block._meta?.ui;
const sc = block.structuredContent;

// LEGACY — parse the JSON envelope only when the outer block is missing
// the field AND a fallback is genuinely required (replay of pre-contract
// sessions, direct-MCP without the super-mcp wrap).
if (!ui && !sc) {
  const envelope = parseUseToolEnvelopeJson(block.content[0]?.text);
  // ...
}
```

Method 0 (envelope-aware unwrap) in `agentMessageHandler.ts` becomes the legacy fallback path. It is retained for:
- Replay of pre-contract conversations (the JSON envelope is in storage; the outer-block hoist did not run when those events were captured).
- Direct-MCP and runtime-bypass scenarios where super-mcp's `use_tool` route is not in play.

## Materialisation behaviour

`materializeOutput` short-circuits when the tool output is ≥ 20K chars (default) or contains image content. The materialisation envelope replaces the inner `result.content[]` with a `{ status: 'materialized', file_path, image_files, ... }` placeholder so the model sees a compact reference instead of the full payload.

Under this contract:
- `inner._meta.ui` and `inner.structuredContent` are hoisted to the outer block **before** `materializeOutput` rewrites `inner.content[]`. MCP App tools that produce large structured payloads keep working — the iframe receives `structuredContent` from the outer block; the model receives the materialised text envelope.
- `_meta.materialization` on the outer block records the materialisation status. Renderers can use this to show "this view's data is materialised; the iframe is rendering from cached JSON" or similar UX, rather than silently treating an empty inner.content as failure.

## Forbidden patterns

Do NOT (regression) re-introduce any of these:
- Adding a new consumer-side text-envelope sniff (`content[0].text` regex / JSON.parse) for `_meta.ui` or `structuredContent`. The contract makes these fields available structurally — consumers MUST read them off the outer block.
- Stripping `_meta.ui` or `structuredContent` from the outer block in any super-mcp transformation step (truncation, continuation, safety net, materialisation).
- Mixing super-mcp's own metadata (request id, telemetry, materialisation status) into `_meta.ui` or `_meta` top-level. Super-mcp's metadata MUST namespace under `_meta.superMcp` and `_meta.materialization`.
- Adding a new `use_tool` success/materialisation/safety-net/bypass return that does not go through `buildOuter`. `applyOuterMeta` MUST have exactly one caller: the single egress constructor.

## Validation

The contract is enforced by the conformance test suite in `super-mcp/test/useTool-passthrough.test.ts`. CI gates on it. Future super-mcp changes that drop a hoisted field break the build. The suite covers canonical success/materialisation/error paths plus bypass-path cases for `_rebel_staged`, `dry_run`, and `result_id` continuation.

## References

- [`MCP_UI_APPS.md`](MCP_UI_APPS.md) — MCP Apps spec mapping.
- [`260507_unified_interactive_ui_architecture.md`](../plans/260507_unified_interactive_ui_architecture.md) — the planning doc this contract was authored under (Phase A0).
- [`260507_email_compose_prefill_bug.md`](../../docs-private/investigations/260507_email_compose_prefill_bug.md) — the load-bearing acceptance test for the contract.
- Postmortems on prior envelope-shape bugs: `260417_materialisation_non_text_bypass`, `260427_super_mcp_iserror_propagation`.
