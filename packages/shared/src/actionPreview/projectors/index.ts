import { classifyEffectKind } from '../classify';
import type { ActionPreviewInput, ActionPreviewModel } from '../model';
import { EFFECT_PROJECTOR_REGISTRY } from '../registry';
export { projectDataCapture } from './dataCapture';

export function deriveActionPreview(input: ActionPreviewInput): ActionPreviewModel {
  const effectKind = classifyEffectKind(input);
  return EFFECT_PROJECTOR_REGISTRY[effectKind].project(input);
}
