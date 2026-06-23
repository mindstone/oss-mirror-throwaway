---
description: "Council Mode: parallel multi-model execution, synthesis, and session-level activation"
last_updated: "2026-05-11"
---

# Council Mode (Multi-Model Parallel Execution)

Council Mode dispatches the user's request to multiple AI model providers in parallel (as SDK subagents), then has the lead Claude agent synthesize their responses into a single cross-checked answer. It is an opt-in-per-message feature available whenever council-enabled model profiles exist.


## Intent & Design Rationale

**Problem:** The `multiModelEnabled` experimental toggle created confusing UX -- users added model profiles but didn't realize they needed a separate toggle to see them in @ mentions or use council mode.

**Approach:** Remove the experimental flag entirely. Council mode is now available whenever council-enabled profiles exist. Three safety valves remain: (1) per-profile `councilEnabled` chip-toggle controls which profiles participate, (2) session-level `councilMode` defaults to false, (3) activation requires explicit `//council` keyword or UI toggle.

**Rejected:** Keeping the flag but auto-enabling it when profiles are added (still adds unnecessary state). Making council auto-activate without explicit request (too risky for cost -- council is ~4x token cost).

**Architectural context:** Council mode is one of N roles in the broader **Model team** abstraction (Main work, Deep thinking, Behind the Scenes, Council, Recovery). Smart model picking (planner-driven per-step model selection within a Quality Tier) is a *separate* concept layered on top of role-based selection -- see [`docs/plans/260509_model_team_and_smart_picking.md`](../plans/260509_model_team_and_smart_picking.md). The end-user framing is in [`rebel-system/help-for-humans/multi-model-council-mode.md`](../../rebel-system/help-for-humans/multi-model-council-mode.md); for the internal constants and normalization rules, see [MODEL_CONSTANTS](MODEL_CONSTANTS.md).

**Constraints a future agent must preserve:**
- Council mode must always require explicit user activation (never auto-activate per turn)
- Per-profile `councilEnabled` must remain as the mechanism to control council membership
- Proxy-routed model costs must be tracked in the cost ledger (see `completeTurnCleanup` in `agentTurnExecutor.ts`)

See [removal plan](../plans/260325_remove_multimodel_feature_flag.md) for full context.


## See also

### User-facing docs
- [`rebel-system/help-for-humans/multi-model-council-mode.md`](../../rebel-system/help-for-humans/multi-model-council-mode.md) — End-user documentation (setup, usage, tips)
- [`rebel-system/help-for-humans/AI-models.md`](../../rebel-system/help-for-humans/AI-models.md) — Model profile configuration basics

### Architecture & code
- [`src/main/services/councilService.ts`](../../src/main/services/councilService.ts) — **Core service**: builds agent definitions, route table, and system prompt augmentation
- [`src/main/services/localModelProxyServer.ts`](../../src/main/services/localModelProxyServer.ts) — Multi-route proxy: routes `claude-*` to Anthropic, everything else to the matching `ModelProfile` endpoint via Anthropic-to-OpenAI translation
- [`src/main/services/agentTurnExecutor.ts`](../../src/main/services/agentTurnExecutor.ts) — Turn execution: council config injection, proxy startup/cleanup, `//council` keyword parsing
- [`src/renderer/features/composer/SessionSettingsMenu.tsx`](../../src/renderer/features/composer/SessionSettingsMenu.tsx) — Per-message council mode toggle (in composer session settings menu)
- [`src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts`](../../src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts) — Passes `councilMode` flag through to the IPC turn request

### Types & schemas
- [`src/shared/types.ts`](../../src/shared/types.ts) — `ModelProfile.councilEnabled`, `AgentTurnOptions.councilMode`
- [`src/shared/ipc/schemas/settings.ts`](../../src/shared/ipc/schemas/settings.ts) — `ModelProfileSchema` with `councilEnabled` field
- [`src/shared/ipc/schemas/agent.ts`](../../src/shared/ipc/schemas/agent.ts) — `AgentTurnRequestSchema` with `councilMode` field

### Tests
- [`src/main/services/__tests__/councilService.test.ts`](../../src/main/services/__tests__/councilService.test.ts) — Agent definition generation, profile validation, system prompt construction
- [`src/main/services/__tests__/councilRouting.test.ts`](../../src/main/services/__tests__/councilRouting.test.ts) — Multi-route proxy routing logic

### Planning docs (historical)
- [`docs/plans/finished/260208_council_mode_multi_model_parallel_execution.md`](../plans/finished/260208_council_mode_multi_model_parallel_execution.md) — Original design plan, SDK research, architecture decisions
- [`docs/plans/finished/260209_fix_council_mode_system_prompt_routing.md`](../plans/finished/260209_fix_council_mode_system_prompt_routing.md) — System-prompt-based routing (replaced env var alias hijacking)
- [`docs/plans/finished/260209_council_subagent_context.md`](../plans/finished/260209_council_subagent_context.md) — Context forwarding to council members
- [`docs/plans/finished/260209_council_mode_robustness_polish.md`](../plans/finished/260209_council_mode_robustness_polish.md) — Robustness and UX polish
- [`docs/plans/obsolete/260208_fix-council-mode-proxy-auth-and-ux.md`](../plans/obsolete/260208_fix-council-mode-proxy-auth-and-ux.md) — Proxy auth and UX fixes

### Settings UI
- [`src/renderer/features/settings/components/tabs/AgentsTab.tsx`](../../src/renderer/features/settings/components/tabs/AgentsTab.tsx) — Model profile configuration
- [`src/renderer/features/settings/components/LocalModelSection.tsx`](../../src/renderer/features/settings/components/LocalModelSection.tsx) — Per-profile `councilEnabled` toggle and profile CRUD

### Related systems
- [ARCHITECTURE_OVERVIEW](ARCHITECTURE_OVERVIEW.md) — Overall system architecture
- [ARCHITECTURE_AGENT_TURN_EXECUTION](ARCHITECTURE_AGENT_TURN_EXECUTION.md) — Detailed turn orchestration (council integrates here)
- [LOCAL_MODEL_SUPPORT](LOCAL_MODEL_SUPPORT.md) — Local model proxy, which council mode extends into multi-route mode


## Key design decisions

1. **SDK subagent mechanism, not parallel `query()` calls.** Council members are registered as `AgentDefinition` entries in the SDK's `agents` option. The lead Claude agent dispatches them via `Task` tool calls. This gives us built-in parallel execution, abort propagation, and `SubAgentPill` UI for free. MCP tool inheritance requires explicitly setting `mcpServers` (as string references to top-level servers) on each `AgentDefinition`.

2. **System-prompt routing via `<council-route>` tag.** Each council member's system prompt includes a `<council-route model="..." />` tag. The proxy extracts this to determine the backend, then strips it before forwarding. This replaced an earlier env-var-alias-hijacking approach that was limited to 3 members and conflicted with `opusPlanMode`.

3. **All subagents use `model: 'sonnet'` for SDK validation.** The SDK's Zod enum restricts `AgentDefinition.model` to a fixed set of Anthropic aliases. We use `'sonnet'` as a pass-through placeholder; actual routing is handled entirely by the proxy. This dependency should be verified on every SDK update.

4. **Lead agent always uses a full Claude model name.** This ensures the proxy routes lead-agent traffic directly to Anthropic (passthrough) while council-member traffic goes through Anthropic-to-OpenAI translation to the appropriate provider.

5. **No member cap.** Since routing is by system-prompt tag (not by SDK alias slots), any number of council members can be configured.

6. **Per-message activation.** Council mode is toggled per-message (UI button or `//council` keyword), not per-session, to avoid accidental cost explosion (~4x+ token usage).


## How it works (execution flow)

1. User sends a message with council mode toggled on (or `//council` keyword).
2. `agentTurnExecutor` calls `buildCouncilConfig()` from `councilService.ts`, which:
   - Reads `councilEnabled` profiles from settings
   - Generates `AgentDefinition` entries with `<council-route>` tags
   - Builds a `ModelRouteTable` mapping model names to `ModelProfile` endpoints
   - Constructs a system prompt suffix instructing the lead agent to dispatch all council members in parallel
3. The multi-route proxy starts on a local port with the route table.
4. `ANTHROPIC_BASE_URL` is set to the proxy URL for the entire `query()` process.
5. The lead agent (Claude) receives the augmented system prompt and dispatches parallel `Task` calls to each council member.
6. The proxy routes each request: `claude-*` models passthrough to Anthropic; everything else is translated to OpenAI format and sent to the profile's `serverUrl`.
7. All council members return results; the lead agent synthesizes and presents a unified answer.
8. On turn completion, the proxy is stopped and stats are logged.


## Provider-specific behavior

The proxy handles provider-specific API differences transparently:

- **OpenAI GPT-5+ / o-series**: Uses `developer` message role (instead of `system`) per OpenAI API requirements. Supports `reasoning_effort` values: `low`, `medium`, `high`, `xhigh` (xhigh for GPT-5.2+ models).
- **Google Gemini 3**: Captures and re-injects `thought_signature` tokens for multi-turn tool use. Uses `v1beta/openai` endpoint.
- **Upstream timeouts**: Non-streaming requests timeout after 5 minutes. Streaming requests detect stalls (90s between chunks) and gracefully terminate with proper Anthropic SSE events so the SDK doesn't hang.


## Gotchas

- **SDK dependency on `'sonnet'` alias**: All council agents use `model: 'sonnet'`. If the SDK removes this alias or adds runtime validation for programmatic agents, council mode will break. Check on every SDK update. See the guard comment in `councilService.ts`.
- **`opusPlanMode` interaction**: Both features now coexist (council uses system-prompt routing, not env vars), but the lead agent model is forced to a full Claude name when council is active, bypassing alias resolution.
- **Proxy lifecycle**: The multi-route proxy is started per-turn and stopped on cleanup. The `councilTurnIds` set in `agentTurnExecutor.ts` tracks which turns need proxy cleanup. The proxy is a global singleton, so concurrent council turns are not supported.
- **Section exclusion**: `buildCouncilMemberContext()` in `councilService.ts` strips sections marked `<!-- council: exclude -->` from the system prompt forwarded to council members. This lets AGENTS.md authors control what council subagents see.
- **Cost**: Each council member runs a full agent turn with tool access. Token usage scales linearly with the number of members.
