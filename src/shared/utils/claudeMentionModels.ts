import { PREFERRED_PLANNING_MODEL } from './modelNormalization';

export type ModelAlias = 'haiku' | 'sonnet' | 'opus';

export interface ClaudeMentionEntry {
  label: string;
  modelValue: string;
  modelAlias: ModelAlias;
}

/**
 * Single source of truth for Claude models available as @-mention subagent targets.
 *
 * Consumed by:
 * - Renderer (App.tsx) — mention autocomplete uses { label, modelValue }
 * - Main (councilService.ts) — detection + dispatch uses full shape including modelAlias
 */
export const CLAUDE_MENTION_MODELS: ClaudeMentionEntry[] = [
  { label: 'Haiku 4.5', modelValue: 'claude-haiku-4-5', modelAlias: 'haiku' },
  { label: 'Sonnet 4.6', modelValue: 'claude-sonnet-4-6', modelAlias: 'sonnet' },
  { label: 'Opus', modelValue: PREFERRED_PLANNING_MODEL, modelAlias: 'opus' },
];
