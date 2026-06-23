import type { RebelCoreAgentDefinition } from './types';

export type CanonicalizeSubAgentModelResult =
  | { canonicalSlug: string; warnings: [] }
  | { canonicalSlug: null; warnings: [string] };

type CanonicalizeSubAgentModelContext = {
  agents: Record<string, Pick<RebelCoreAgentDefinition, 'routedModel'>>;
};

const ROUTED_SUBAGENT_SLUG_PREFIX = 'model-';

export function canonicalizeSubAgentModel(
  input: string,
  ctx: CanonicalizeSubAgentModelContext,
): CanonicalizeSubAgentModelResult {
  const normalizedInput = input.trim();
  if (normalizedInput.length === 0) {
    return {
      canonicalSlug: null,
      warnings: [`unknown sub-agent identifier: ${normalizedInput}; not in registered route table`],
    };
  }

  if (
    normalizedInput.startsWith(ROUTED_SUBAGENT_SLUG_PREFIX)
    && normalizedInput in ctx.agents
  ) {
    return { canonicalSlug: normalizedInput, warnings: [] };
  }

  for (const [agentSlug, agentDef] of Object.entries(ctx.agents)) {
    const routedModel = typeof agentDef.routedModel === 'string' ? agentDef.routedModel.trim() : '';
    if (!routedModel) {
      continue;
    }
    if (routedModel === normalizedInput) {
      return { canonicalSlug: agentSlug, warnings: [] };
    }
  }

  return {
    canonicalSlug: null,
    warnings: [`unknown sub-agent identifier: ${normalizedInput}; not in registered route table`],
  };
}
