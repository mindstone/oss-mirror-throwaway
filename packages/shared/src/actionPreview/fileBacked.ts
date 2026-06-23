import type { ActionEffectKind } from './model';

export const FILE_BACKED_ACTION_EFFECT_KINDS = new Set<ActionEffectKind>([
  'document',
  'data-capture',
]);

export function isFileBackedEffectKind(
  effectKind: ActionEffectKind | null | undefined,
): effectKind is 'document' | 'data-capture' {
  return typeof effectKind === 'string' && FILE_BACKED_ACTION_EFFECT_KINDS.has(effectKind);
}
