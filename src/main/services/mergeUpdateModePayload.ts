import type { McpServerConfigDetails, McpServerUpsertPayload } from '@shared/types';
import { DEFAULT_ONLY_SANDBOX_ENV_KEYS } from './mcpSandboxEnvKeys';

export interface UpdateModeCatalogSetupField {
  id: string;
  envVar?: string;
  headerKey?: string;
  headerPrefix?: string;
}

const UNRESOLVED_PLACEHOLDER_RE = /\{\{[A-Z0-9_]+\}\}/;

const isNonBlank = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isPreservableExistingValue = (
  key: string,
  value: string | null | undefined,
  internalKeys: ReadonlySet<string>,
): value is string => {
  if (!isNonBlank(value)) return false;
  if (internalKeys.has(key)) return false;
  if (UNRESOLVED_PLACEHOLDER_RE.test(value)) return false;
  return true;
};

const isBlankIncomingValue = (
  value: string | null | undefined,
  field?: Pick<UpdateModeCatalogSetupField, 'headerPrefix'>,
): boolean => {
  if (!isNonBlank(value)) return true;

  const headerPrefix = field?.headerPrefix;
  if (!headerPrefix) return false;

  // `buildPayloadFromCatalog` applies headerPrefix after trimming setup field values.
  // A blank header-backed credential can therefore appear as just the prefix
  // (for example "Bearer "), which should still mean "preserve existing".
  return value === headerPrefix || value.trim() === headerPrefix.trim();
};

const mergeCredentialRecord = (
  existingRecord: Record<string, string> | null | undefined,
  newRecord: Record<string, string> | null | undefined,
  fields: readonly UpdateModeCatalogSetupField[],
  getKey: (field: UpdateModeCatalogSetupField) => string | undefined,
  internalKeys: ReadonlySet<string>,
  defaultOnlyKeys: ReadonlySet<string>,
): Record<string, string> | null | undefined => {
  const merged: Record<string, string> = { ...(newRecord ?? {}) };
  const fieldsByKey = new Map<string, UpdateModeCatalogSetupField>();
  for (const field of fields) {
    const key = getKey(field);
    if (key) fieldsByKey.set(key, field);
  }

  for (const field of fields) {
    const key = getKey(field);
    if (!key) continue;

    const incomingValue = merged[key];
    if (!isBlankIncomingValue(incomingValue, field)) continue;

    const existingValue = existingRecord?.[key];
    if (isPreservableExistingValue(key, existingValue, internalKeys)) {
      merged[key] = existingValue;
    } else {
      delete merged[key];
    }
  }

  // Default-only sandbox keys (e.g. RUNWAY_ALLOWED_ROOT): the catalog provides
  // a default that the user is allowed to override. If a user value exists,
  // it wins regardless of whether the new payload has a resolved catalog value
  // for the same key. Without this, an update-mode flow re-resolving
  // {{ALLOWED_ROOTS_ANCESTOR}} would clobber a manual advanced-config entry.
  if (existingRecord) {
    for (const key of defaultOnlyKeys) {
      const existingValue = existingRecord[key];
      if (!isPreservableExistingValue(key, existingValue, internalKeys)) continue;
      merged[key] = existingValue;
    }
  }

  // Mirror `mergePreservedUserEnv` precedence: keys present in the existing entry
  // but not driven by a catalog setup field are preserved verbatim, except for
  // internal keys, unresolved placeholders, and keys the catalog already resolved
  // (catalog-resolved values win). This keeps user-added env/header customisations
  // intact across credential rotation.
  if (existingRecord) {
    for (const [key, value] of Object.entries(existingRecord)) {
      if (fieldsByKey.has(key)) continue;
      if (key in merged) continue;
      if (!isPreservableExistingValue(key, value, internalKeys)) continue;
      merged[key] = value;
    }
  }

  if (Object.keys(merged).length > 0) {
    return merged;
  }

  if (newRecord === null) return null;
  if (newRecord === undefined) return undefined;
  return {};
};

// Empty set for headers — sandbox keys are env-only.
const NO_DEFAULT_ONLY_KEYS: ReadonlySet<string> = new Set();

export function mergeUpdateModePayload(
  existingEntry: McpServerConfigDetails,
  newPayload: McpServerUpsertPayload,
  catalogSetupFields: readonly UpdateModeCatalogSetupField[],
  internalEnvKeys: ReadonlySet<string>,
): McpServerUpsertPayload {
  return {
    ...newPayload,
    env: mergeCredentialRecord(
      existingEntry.env,
      newPayload.env,
      catalogSetupFields,
      (field) => field.envVar,
      internalEnvKeys,
      DEFAULT_ONLY_SANDBOX_ENV_KEYS,
    ),
    headers: mergeCredentialRecord(
      existingEntry.headers,
      newPayload.headers,
      catalogSetupFields,
      (field) => field.headerKey,
      internalEnvKeys,
      NO_DEFAULT_ONLY_KEYS,
    ),
    catalogId: existingEntry.catalogId ?? null,
    email: existingEntry.email ?? null,
    lastConnectedAt: existingEntry.lastConnectedAt ?? null,
  };
}
