#!/usr/bin/env npx tsx
/**
 * CI guard: the reasoning-replay capability decision at the route-dispatch seam must key on the
 * CONCRETE backend model, never on the alias (`request.model` / the route-table placeholder).
 *
 * Why (the alias-vs-concrete capability drift class, REBEL-5N8 / Stage 0):
 * `computeSupportsReasoningReplay(profile, model)` is a DESTINATION-capability bit — it drives
 * thinking-block retention between turns and OpenAI-compatible `reasoning_content` replay, so it
 * MUST describe the model that actually runs. On a route-table dispatch the inbound `model` is the
 * alias (e.g. `'working'` → GPT-5.5) while the request runs on a different concrete backend (e.g.
 * Haiku 4.5 / DeepSeek). Keying replay on the alias is wrong in both directions (non-DeepSeek alias
 * → DeepSeek backend strips/replays wrong; DeepSeek alias → non-DeepSeek backend over-retains). The
 * fix (agentTool `5906dacaa`) keys on the concrete backend; this guard keeps it that way.
 *
 * What it asserts (conservative raw-text scan of the two dispatch-path producers):
 *   - `agentTool.ts` — the single `computeSupportsReasoningReplay(...)` call must pass the concrete
 *     `subModelForLimits` (the route-table-resolved backend), NOT the bare alias `model`.
 *   - `localModelProxyServer.ts` — every `computeSupportsReasoningReplay(...)` call must pass a
 *     profile-derived concrete model (`profile.model || …`, a branded `CodexEgressModel`, or an
 *     `nsModelName` derived from the resolved profile), NOT the bare inbound `anthropicRequest.model`
 *     alone. The proxy keeps its OWN independent recompute on the resolved profile (it must NOT
 *     trust a caller plan — hard constraint), so this guard pins each proxy site's model argument
 *     to a profile-concrete source.
 *
 * A future site that mis-keys replay on the alias (`request.model` / `anthropicRequest.model` /
 * a bare route-table `model`) fails CI here. Modeled on the existing concrete-keyed guards
 * (check-no-routing-model-forge.ts, check-direct-anthropic-route-chokepoint.ts).
 *
 * See docs/plans/260614_smart-model-routing/STAGE0_PLAN.md (Step 1) and SPIKE_FINDINGS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_TOOL = path.join('src', 'core', 'rebelCore', 'agentTool.ts');
const PROXY = path.join('src', 'main', 'services', 'localModelProxyServer.ts');

const CALL_RE = /\bcomputeSupportsReasoningReplay\s*\(\s*([^)]*?)\)/gs;

// In agentTool the dispatch-path call must use the concrete-backend local. The alias is the bare
// `model`; the concrete backend is `subModelForLimits` (= routedModelForTransport on route-table
// scopes). A call whose 2nd arg is the bare alias `model` is the drift we forbid.
const AGENT_TOOL_CONCRETE_ARG = 'subModelForLimits';

// In the proxy, the model argument must derive from the resolved profile (its own recompute), not
// the bare inbound body alias. Accept any of the profile-concrete spellings used today.
const PROXY_CONCRETE_ARG_PATTERNS: readonly RegExp[] = [
  /\bprofile\.model\b/, // `profile.model || anthropicRequest.model`
  /\bnsModelName\b/, // derived from the resolved profile / branded egress
  /\bmodelName\b/, // `profile.model || …` assigned to modelName, or branded CodexEgressModel
];

export interface DispatchSeamViolation {
  readonly file: 'agentTool' | 'proxy';
  readonly arg: string;
  readonly message: string;
}

/** Extract the trimmed 2nd argument (the model arg) from a computeSupportsReasoningReplay(...) call. */
function modelArg(callBody: string): string {
  // callBody is the text between the parens: `profile, modelName` etc. Split on the FIRST comma at
  // depth 0; the remainder is the model argument.
  let depth = 0;
  for (let i = 0; i < callBody.length; i++) {
    const c = callBody[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      return callBody.slice(i + 1).trim();
    }
  }
  return callBody.trim();
}

// The bare inbound alias on the proxy path — the working/route-table placeholder, NOT the concrete
// backend. If this WINS the model-arg expression, replay is mis-keyed.
const PROXY_ALIAS_RE = /\b(?:anthropicRequest|request)\.model\b/;

/**
 * The first `||`-operand of a fallback chain — the operand that WINS at runtime when truthy. We key
 * the proxy check on this (not mere token presence) so that an alias-first chain like
 * `anthropicRequest.model || profile.model` is caught even though it contains a concrete token.
 */
function firstOrOperand(arg: string): string {
  let depth = 0;
  for (let i = 0; i < arg.length - 1; i++) {
    const c = arg[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '|' && arg[i + 1] === '|') return arg.slice(0, i).trim();
  }
  return arg.trim();
}

/**
 * Pure checker over the two dispatch-path sources. Returns one violation per mis-keyed call site,
 * plus a synthetic violation if a producer has no `computeSupportsReasoningReplay()` call at all
 * (the seam moved/was removed — re-verify the concrete-keying invariant by hand).
 */
export function checkCapabilityResolutionDispatchSeam(
  agentToolSrc: string,
  proxySrc: string,
): DispatchSeamViolation[] {
  const violations: DispatchSeamViolation[] = [];

  const agentCalls = [...agentToolSrc.matchAll(CALL_RE)];
  if (agentCalls.length === 0) {
    violations.push({
      file: 'agentTool',
      arg: '',
      message:
        `${AGENT_TOOL} has no computeSupportsReasoningReplay() call — the sub-agent dispatch seam ` +
        `appears to have moved or been removed. Update this guard (and confirm the replay capability ` +
        `is still keyed on the concrete backend).`,
    });
  }
  for (const m of agentCalls) {
    const arg = modelArg(m[1] ?? '');
    if (arg !== AGENT_TOOL_CONCRETE_ARG) {
      violations.push({
        file: 'agentTool',
        arg,
        message:
          `${AGENT_TOOL}: computeSupportsReasoningReplay(...) keys reasoning-replay on \`${arg}\` ` +
          `instead of the concrete routed backend \`${AGENT_TOOL_CONCRETE_ARG}\`. On a route-table ` +
          `dispatch the bare alias \`model\` is the working placeholder (e.g. 'working'); the request ` +
          `runs on \`subModelForLimits\` (= routedModelForTransport). Replay is a destination-capability ` +
          `bit and MUST describe the model that actually runs. See agentTool.ts:~1672 + STAGE0_PLAN.md.`,
      });
    }
  }

  const proxyCalls = [...proxySrc.matchAll(CALL_RE)];
  if (proxyCalls.length === 0) {
    violations.push({
      file: 'proxy',
      arg: '',
      message:
        `${PROXY} has no computeSupportsReasoningReplay() call — the proxy replay recomputation ` +
        `appears to have moved or been removed. Update this guard.`,
    });
  }
  for (const m of proxyCalls) {
    const arg = modelArg(m[1] ?? '');
    // Key on the WINNING operand (first `||`-operand), not mere token presence: it must be a
    // profile-concrete source AND must not be the bare inbound alias. This catches alias-first
    // drift (`anthropicRequest.model || profile.model`) that a token-presence check would miss.
    const winning = firstOrOperand(arg);
    const ok = PROXY_CONCRETE_ARG_PATTERNS.some((re) => re.test(winning)) && !PROXY_ALIAS_RE.test(winning);
    if (!ok) {
      violations.push({
        file: 'proxy',
        arg,
        message:
          `${PROXY}: computeSupportsReasoningReplay(...) keys reasoning-replay on \`${arg}\` whose ` +
          `winning operand \`${winning}\` is not a profile-concrete source (or is the bare inbound ` +
          `alias). The proxy must recompute replay on the RESOLVED profile's concrete model ` +
          `(\`profile.model || …\`, a branded CodexEgressModel, or a profile-derived \`nsModelName\`) ` +
          `with the concrete source FIRST in any fallback chain — never the bare inbound ` +
          `\`anthropicRequest.model\` alias winning. The proxy keeps its own independent recompute ` +
          `(it must not trust a caller plan). See STAGE0_PLAN.md hard constraints.`,
      });
    }
  }

  return violations;
}

function readOrThrow(rel: string): string {
  const abs = path.join(process.cwd(), rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`producer not found at ${rel} — update this guard if the file moved.`);
  }
  return fs.readFileSync(abs, 'utf8');
}

export function main(): void {
  let agentToolSrc: string;
  let proxySrc: string;
  try {
    agentToolSrc = readOrThrow(AGENT_TOOL);
    proxySrc = readOrThrow(PROXY);
  } catch (err) {
    console.error(`\n✗ check-capability-resolution-dispatch-seam: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const violations = checkCapabilityResolutionDispatchSeam(agentToolSrc, proxySrc);
  if (violations.length > 0) {
    console.error(
      `\n✗ check-capability-resolution-dispatch-seam:\n${violations.map((v) => `  - ${v.message}`).join('\n')}\n`,
    );
    process.exit(1);
  }

  const proxyCalls = [...proxySrc.matchAll(CALL_RE)].length;
  console.log(
    `✓ check-capability-resolution-dispatch-seam: agentTool keys replay on the concrete backend ` +
      `(${AGENT_TOOL_CONCRETE_ARG}); all ${proxyCalls} proxy sites recompute on a profile-concrete model.`,
  );
}

// Only run the CLI side-effect when invoked directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
