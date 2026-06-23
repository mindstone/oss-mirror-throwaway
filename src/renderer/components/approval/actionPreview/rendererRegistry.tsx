import type { ComponentType } from 'react';
import type { ActionEffectKind, ActionPreviewModel } from '@rebel/shared';
import { GenericStructuredPreview } from './GenericStructuredPreview';
import { DataCapturePreview } from './DataCapturePreview';
import { MessagePreview } from './MessagePreview';

export interface ActionPreviewBodyRendererProps {
  model: ActionPreviewModel;
}

export type ActionPreviewBodyRenderer = ComponentType<ActionPreviewBodyRendererProps>;

function withDeferredRendererKey(rendererKey: ActionEffectKind): ActionPreviewBodyRenderer {
  // Message has a dedicated renderer in Stage 4; other kinds stay deferred for now.
  return ({ model }) => (
    <GenericStructuredPreview model={model} rendererKey={rendererKey} />
  );
}

function resolveKnownRenderer(effectKind: ActionEffectKind): ActionPreviewBodyRenderer {
  switch (effectKind) {
    case 'document':
      return withDeferredRendererKey('document');
    case 'message':
      return MessagePreview;
    case 'data-capture':
      return DataCapturePreview;
    case 'command':
      return withDeferredRendererKey('command');
    case 'external-record':
      return withDeferredRendererKey('external-record');
    case 'browser':
      return withDeferredRendererKey('browser');
    case 'generic':
      return withDeferredRendererKey('generic');
  }

  const exhaustiveCheck: never = effectKind;
  return exhaustiveCheck;
}

function isActionEffectKind(value: string): value is ActionEffectKind {
  return value === 'document'
    || value === 'message'
    || value === 'data-capture'
    || value === 'command'
    || value === 'external-record'
    || value === 'browser'
    || value === 'generic';
}

export function getActionPreviewBodyRenderer(effectKind: ActionEffectKind | string): ActionPreviewBodyRenderer {
  if (!isActionEffectKind(effectKind)) {
    return withDeferredRendererKey('generic');
  }

  return resolveKnownRenderer(effectKind);
}
