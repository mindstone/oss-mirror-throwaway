import type { AppSettings } from '@shared/types';

type ModelAuthNamespace = Partial<
  Pick<NonNullable<AppSettings['models']>, 'apiKey' | 'oauthMigratedAt'>
>;

export interface ModelSettingsAccessorSettings {
  models?: ModelAuthNamespace | null;
}

function readNamespaceField<K extends keyof ModelAuthNamespace>(
  namespace: unknown,
  key: K,
): ModelAuthNamespace[K] | undefined {
  if (namespace === null || namespace === undefined) return undefined;
  if (typeof namespace !== 'object' || Array.isArray(namespace)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(namespace, key)) return undefined;
  return (namespace as ModelAuthNamespace)[key];
}

export function getApiKey(
  settings: ModelSettingsAccessorSettings | null | undefined,
): string | null | undefined {
  if (!settings) return undefined;
  return readNamespaceField(settings.models, 'apiKey');
}

export function getOauthMigratedAt(
  settings: ModelSettingsAccessorSettings | null | undefined,
): string | undefined {
  if (!settings) return undefined;
  const modelsValue = readNamespaceField(settings.models, 'oauthMigratedAt');
  return modelsValue ?? undefined;
}
