import type {
  ActionEffectKind,
  ActionPreviewInput,
  ActionPreviewModel,
} from './model';
import { projectGenericStructured } from './projectors/generic';
import { projectDataCapture } from './projectors/dataCapture';
import { projectMessage } from './projectors/message';

export interface EffectProjector {
  project: (input: ActionPreviewInput) => ActionPreviewModel;
}

const genericProjector = (effectKind: ActionEffectKind): EffectProjector => ({
  project: (input) => projectGenericStructured(input, effectKind),
});

export const EFFECT_PROJECTOR_REGISTRY = {
  document: genericProjector('document'),
  message: { project: projectMessage },
  'data-capture': { project: projectDataCapture },
  command: genericProjector('command'),
  'external-record': genericProjector('external-record'),
  browser: genericProjector('browser'),
  generic: genericProjector('generic'),
} satisfies Record<ActionEffectKind, EffectProjector>;

type MissingEffectProjector = Exclude<ActionEffectKind, keyof typeof EFFECT_PROJECTOR_REGISTRY>;
const _effectProjectorCoverage: MissingEffectProjector extends never ? true : never = true;
void _effectProjectorCoverage;
