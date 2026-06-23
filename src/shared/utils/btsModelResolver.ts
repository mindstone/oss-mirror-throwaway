import { DEFAULT_AUXILIARY_MODEL } from './modelNormalization';
import { COST_CATEGORY_REGISTRY, type BtsTaskGroup } from '@shared/costCategories';
import type { AppSettings } from '@shared/types';
import {
  normalizeStoredBtsModelValue,
  rejectionReasonLabel,
  type NormalizationRejectionReason,
  type NormalizedBtsModelValue,
} from '@shared/utils/btsModelValueNormalization';

// Re-export from canonical source for backward compatibility
export { type BtsTaskGroup, BTS_TASK_GROUPS, BTS_TASK_GROUP_KEYS } from '@shared/costCategories';

/** Maps internal AuxiliaryCostCategory strings to user-facing task groups.
 *  Derived from the COST_CATEGORY_REGISTRY btsTaskGroup field. */
const CATEGORY_TO_GROUP = Object.entries(COST_CATEGORY_REGISTRY).reduce<Record<string, BtsTaskGroup>>(
  (acc, [cat, meta]) => {
    if ('btsTaskGroup' in meta && meta.btsTaskGroup) {
      acc[cat] = meta.btsTaskGroup;
    }
    return acc;
  },
  {},
);

type BtsModelResolverSettings = Pick<
  AppSettings,
  'behindTheScenesModel' | 'behindTheScenesOverrides'
> & {
  activeProvider?: AppSettings['activeProvider'] | string;
  models?: AppSettings['models'];
};

function rebuildNormalizedBtsModelValue(
  normalized: Extract<NormalizedBtsModelValue, { ok: true }>,
): string {
  if (normalized.kind === 'profile') return `profile:${normalized.profileId}`;
  return normalized.modelId;
}

function warnRejectedBtsModelValue(
  siteId: string,
  rawValue: unknown,
  reason: NormalizationRejectionReason,
  fallback: 'global' | 'default',
): void {
  if (typeof rawValue === 'string' && rawValue.length > 0) {
    console.warn(`[resolveBtsModel] ${siteId} rejected by normalizer: ${rejectionReasonLabel(reason)}; falling through to ${fallback}`, {
      siteId,
      rawTruncated: rawValue.slice(0, 32),
      rejectionReason: reason,
    });
    return;
  }

  if (rawValue != null && typeof rawValue !== 'string') {
    console.warn(`[resolveBtsModel] ${siteId} rejected non-string input by normalizer: ${rejectionReasonLabel(reason)}; falling through to ${fallback}`, {
      siteId,
      rawType: typeof rawValue,
      rejectionReason: reason,
    });
  }
}

/**
 * Resolve the effective BTS model for a given task category.
 * 1. If category maps to a group with an override, return the override (with `model:` decoded)
 * 2. Fall back to behindTheScenesModel (with `model:` decoded)
 * 3. Fall back to DEFAULT_AUXILIARY_MODEL
 *
 * `profile:<id>` values are preserved as-is for downstream profile resolution.
 */
export function resolveBtsModel(
  settings: BtsModelResolverSettings,
  category?: string
): string {
  if (category) {
    const group = CATEGORY_TO_GROUP[category];
    if (group) {
      const override = settings.behindTheScenesOverrides?.[group];
      if (override != null) {
        const normalized = normalizeStoredBtsModelValue(override);
        if (normalized.ok) return rebuildNormalizedBtsModelValue(normalized);
        warnRejectedBtsModelValue(
          'btsModelResolver:resolveBtsModel:override',
          override,
          normalized.reason,
          'global',
        );
      }
    }
  }
  const btsModel = settings.behindTheScenesModel;
  if (btsModel != null) {
    const normalized = normalizeStoredBtsModelValue(btsModel);
    if (normalized.ok) return rebuildNormalizedBtsModelValue(normalized);
    warnRejectedBtsModelValue(
      'btsModelResolver:resolveBtsModel:global',
      btsModel,
      normalized.reason,
      'default',
    );
  }
  if (settings.activeProvider === 'mindstone') {
    // eslint-disable-next-line no-restricted-properties -- Stage 10 intentionally reads the working model as the Mindstone managed-mode last resort; importing modelSettingsResolver here would create a resolver cycle.
    const modelSettings = settings.models;
    const workingModel = typeof modelSettings?.model === 'string' ? modelSettings.model.trim() : '';
    if (workingModel) return workingModel;
  }
  return DEFAULT_AUXILIARY_MODEL;
}
