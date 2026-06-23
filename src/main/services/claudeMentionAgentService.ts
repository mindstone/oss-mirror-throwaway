import type { AgentDefinition } from '@core/agentRuntimeTypes';
import {
  CLAUDE_MENTION_MODELS,
  type ClaudeMentionEntry,
} from '@shared/utils/claudeMentionModels';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import { escapeRegExp, MIN_BARE_NAME_LENGTH } from './adHocAgentService';

const log = createScopedLogger({ service: 'claudeMentionAgentService' });

/**
 * Re-export type and data from shared single source of truth.
 * @see src/shared/utils/claudeMentionModels.ts
 */
export type ClaudeMentionTarget = ClaudeMentionEntry;
export const CLAUDE_MENTION_TARGETS: ClaudeMentionEntry[] = CLAUDE_MENTION_MODELS;

/**
 * Scan the user's prompt for Claude model references and return matching targets.
 *
 * Detection strategies (mirror `detectModelReferences` for consistency):
 * 1. @model:`label` — explicit backtick-quoted mention (e.g., @model:`Haiku 4.5`)
 * 2. @model:label — legacy format fallback
 * 3. Bare model value (e.g., `claude-haiku-4-5`) — word boundary match
 * 4. Bare label (e.g., "Haiku 4.5", "Opus") — word boundary, only if ≥ MIN_BARE_NAME_LENGTH
 *
 * Case-insensitive. Returns matched targets (no duplicates since CLAUDE_MENTION_TARGETS is small and unique).
 */
export function detectClaudeModelReferences(prompt: string): ClaudeMentionTarget[] {
  const matched: ClaudeMentionTarget[] = [];

  for (const target of CLAUDE_MENTION_TARGETS) {
    const sanitizedLabel = target.label.replace(/[^\w\s.-]/g, '').trim();

    // 1. Explicit @model mentions (backtick-quoted or legacy)
    const backtickPattern = new RegExp(`@model:\`${escapeRegExp(target.label)}\``, 'i');
    const legacyPattern = new RegExp(`@model:${escapeRegExp(sanitizedLabel)}\\b`, 'i');
    if (backtickPattern.test(prompt) || legacyPattern.test(prompt)) {
      matched.push(target);
      continue;
    }

    // 2. Bare model value (technical identifier — always safe to match)
    const modelPattern = new RegExp(`\\b${escapeRegExp(target.modelValue)}\\b`, 'i');
    if (modelPattern.test(prompt)) {
      matched.push(target);
      continue;
    }

    // 3. Bare label (only if long enough to be distinctive)
    if (sanitizedLabel.length >= MIN_BARE_NAME_LENGTH) {
      const labelPattern = new RegExp(`\\b${escapeRegExp(sanitizedLabel)}\\b`, 'i');
      if (labelPattern.test(prompt)) {
        matched.push(target);
        continue;
      }
    }
  }

  return matched;
}

export interface ClaudeSubagentConfig {
  /** Agent definitions to register with the agent query (Anthropic-native, no proxy) */
  agents: Record<string, AgentDefinition>;
  /** Soft system prompt hint describing available Claude subagents */
  systemPromptHint: string;
  /** Model value → display label (for logging and stats) */
  modelDisplayNames: Map<string, string>;
}

/**
 * Build Anthropic-native agent configuration for Claude model @-mentions.
 *
 * Unlike `buildAdHocAgentConfig()`:
 * - Uses Anthropic-native model aliases ('haiku', 'sonnet', 'opus') — no proxy routing
 * - No route metadata in the prompt
 * - No route table entries
 * - Agent names use `claude-` prefix
 *
 * Returns null if no valid agents can be built.
 */
export function buildClaudeSubagentConfig(
  matchedTargets: ClaudeMentionTarget[],
  settings: AppSettings,
): ClaudeSubagentConfig | null {
  if (matchedTargets.length === 0) return null;

  const activeProvider = settings.activeProvider ?? 'anthropic';
  if (activeProvider !== 'anthropic') {
    log.warn(
      {
        activeProvider,
        matchedTargets: matchedTargets.map((t) => ({ modelValue: t.modelValue, modelAlias: t.modelAlias })),
      },
      'Claude subagent dispatch gated: active provider is non-Anthropic; @model mentions ignored',
    );
    return null;
  }

  const agents: Record<string, AgentDefinition> = {};
  const modelDisplayNames = new Map<string, string>();
  const memberDescriptions: string[] = [];

  for (const target of matchedTargets) {
    const agentName = `claude-${target.modelAlias}`;

    agents[agentName] = {
      description: `Consult Claude ${target.label} for an independent perspective.`,
      prompt: `You are Claude ${target.label}. Investigate the user's request thoroughly using all available tools. Provide a comprehensive response.`,
      model: target.modelAlias ?? getDefaultModelForProvider(settings, 'working'),
    };

    modelDisplayNames.set(target.modelValue, target.label);
    memberDescriptions.push(`- subagent_type: "${agentName}" — Claude ${target.label} (${target.modelAlias})`);

    log.info({ agentName, modelValue: target.modelValue, modelAlias: target.modelAlias }, 'Registered Claude native subagent');
  }

  const systemPromptHint = buildClaudeSubagentSystemPromptHint(memberDescriptions);

  return {
    agents,
    systemPromptHint,
    modelDisplayNames,
  };
}

function buildClaudeSubagentSystemPromptHint(memberDescriptions: string[]): string {
  return [
    '',
    '<claude_subagents>',
    'The user has referenced the following Claude model(s) in their message:',
    ...memberDescriptions,
    'When the user asks you to consult a model, delegate the task via the Task tool.',
    '</claude_subagents>',
  ].join('\n');
}
