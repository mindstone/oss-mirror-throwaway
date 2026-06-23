import type { AgentDefinition, AgentMcpServerSpec } from '@core/agentRuntimeTypes';
import type { ModelProfile } from '@shared/types';
import type { ModelRouteTable } from './localModelProxyServer';
import { createScopedLogger } from '@core/logger';
import { buildSubagentMemberContext } from './agentContextHelpers';

const log = createScopedLogger({ service: 'adHocAgentService' });

/**
 * Escape special regex characters in a string for use in `new RegExp()`.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Minimum length for profile display names to be matched as bare words.
 * Short names (e.g. "AI", "Go") are too common to match in natural language.
 * Names below this length require an explicit `@model:` mention to match.
 */
export const MIN_BARE_NAME_LENGTH = 4;

/**
 * Scan the user's prompt for model references and return matching profiles.
 *
 * Detection strategies:
 * 1. @model:`profileName` — explicit mention (preferred), always matched regardless of name length.
 *    Legacy fallback: `@model:profileName`.
 * 2. Bare model name (e.g. `gpt-5.2-codex`) — matched as a word boundary pattern.
 *    Model names are technical identifiers unlikely to appear in natural language.
 * 3. Profile display name (e.g. "GPT-5.2") — only matched as bare word if the name
 *    is ≥ MIN_BARE_NAME_LENGTH characters to avoid false positives on common words.
 *
 * Matching is case-insensitive. Deduplicates by model name (first match wins).
 * Skips profiles without a `model` field.
 */
export function detectModelReferences(prompt: string, profiles: ModelProfile[]): ModelProfile[] {
  const candidates = profiles.filter(p => p.model);
  if (candidates.length === 0) return [];

  const matched = new Map<string, ModelProfile>();

  for (const profile of candidates) {
    const modelName = profile.model;
    if (!modelName) continue;
    if (matched.has(modelName)) continue;

    const sanitizedName = profile.name.replace(/[^\w\s.-]/g, '').trim();

    // 1. Always check explicit @model mentions (any name length)
    // Preferred format: @model:`profileName` (backtick-quoted)
    // Legacy fallback: @model:profileName
    const backtickPattern = new RegExp(`@model:\`${escapeRegExp(sanitizedName)}\``, 'i');
    const legacyPattern = new RegExp(`@model:${escapeRegExp(sanitizedName)}\\b`, 'i');
    if (backtickPattern.test(prompt) || legacyPattern.test(prompt)) {
      matched.set(modelName, profile);
      continue;
    }

    // 2. Check bare model name (technical identifier — always safe to match)
    const modelPattern = new RegExp(`\\b${escapeRegExp(modelName)}\\b`, 'i');
    if (modelPattern.test(prompt)) {
      matched.set(modelName, profile);
      continue;
    }

    // 3. Check bare profile display name (only if name is long enough to be distinctive)
    if (sanitizedName.length >= MIN_BARE_NAME_LENGTH) {
      const namePattern = new RegExp(`\\b${escapeRegExp(sanitizedName)}\\b`, 'i');
      if (namePattern.test(prompt)) {
        matched.set(modelName, profile);
        continue;
      }
    }
  }

  return Array.from(matched.values());
}

export interface AdHocAgentConfig {
  /** Agent definitions to register with the agent query */
  agents: Record<string, AgentDefinition>;
  /** Route table for the multi-route proxy */
  routeTable: ModelRouteTable;
  /** Soft system prompt hint describing available ad-hoc models */
  systemPromptHint: string;
  /** Model name → profile display name (for error reporting and stats) */
  modelDisplayNames: Map<string, string>;
}

/**
 * Build the ad-hoc agent configuration for model references detected in the user's prompt.
 *
 * Similar to `buildCouncilConfig` but with key differences:
 * - Agent names use `model-` prefix (not `council-`)
 * - Agent description is softer — consultation, not parallel investigation
 * - System prompt hint is advisory (not a mandatory override)
 * - Only matched profiles are registered (not all council-enabled profiles)
 *
 * Returns null if no valid agents can be built.
 */
export function buildAdHocAgentConfig(
  matchedProfiles: ModelProfile[],
  baseSystemPrompt: string,
  mcpServerSpecs?: AgentMcpServerSpec[],
): AdHocAgentConfig | null {
  if (matchedProfiles.length === 0) return null;

  const subagentContext = buildSubagentMemberContext(baseSystemPrompt);

  const agents: Record<string, AgentDefinition> = {};
  const routes = new Map<string, ModelProfile>();
  const usedAgentNames = new Set<string>();
  const modelDisplayNames = new Map<string, string>();
  const memberDescriptions: string[] = [];

  for (const profile of matchedProfiles) {
    if (!profile.model) continue;
    const modelName = profile.model;

    // Skip duplicate model names (first profile wins)
    if (routes.has(modelName)) {
      log.warn(
        { modelName, profileId: profile.id, profileName: profile.name },
        'Skipping ad-hoc agent: duplicate model name already registered',
      );
      continue;
    }

    const sanitizedName = profile.name.replace(/[^\w\s.-]/g, '');

    // Build unique agent name using same slug pattern as council
    const slug = sanitizedName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    let agentName = `model-${slug}`;
    if (usedAgentNames.has(agentName)) {
      agentName = `model-${slug}-${profile.id.slice(0, 8)}`;
    }
    usedAgentNames.add(agentName);

    agents[agentName] = {
      description: `Consult ${sanitizedName} (${modelName}) for an independent perspective.`,
      prompt: [
        ...(subagentContext ? [subagentContext, ''] : []),
        `You are an independent consultant providing your perspective using ${sanitizedName}.`,
        'Investigate the user\'s request thoroughly using all available tools.',
        'Provide a comprehensive response with your findings, reasoning, and conclusions.',
      ].join('\n'),
      model: 'working',
      routedModel: modelName,
      mcpServers: mcpServerSpecs,
    };

    routes.set(modelName, profile);
    modelDisplayNames.set(modelName, sanitizedName);
    memberDescriptions.push(`- subagent_type: "${agentName}" — ${sanitizedName} (${modelName})`);

    log.info({ agentName, modelName, profileId: profile.id }, 'Registered ad-hoc model agent');
  }

  if (memberDescriptions.length === 0) {
    log.warn('All ad-hoc profiles were skipped during validation');
    return null;
  }

  const systemPromptHint = buildAdHocSystemPromptHint(memberDescriptions);

  return {
    agents,
    routeTable: { routes },
    systemPromptHint,
    modelDisplayNames,
  };
}

function buildAdHocSystemPromptHint(memberDescriptions: string[]): string {
  return [
    '',
    '<ad_hoc_models>',
    'The user has referenced the following model(s) in their message. You have access to them as subagents:',
    ...memberDescriptions,
    '',
    'When the user asks you to consult a model, delegate the task via the Task tool.',
    'Include full context in the delegation prompt.',
    'After receiving the response, integrate it into your answer.',
    '</ad_hoc_models>',
  ].join('\n');
}
