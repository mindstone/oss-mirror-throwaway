import type { MigrationBundleManifest } from './migrationManifest';

export type MigrationCompatibilityResult =
  | { ok: true }
  | { ok: false; reason: 'source-newer-than-target'; sourceDataSchemaEpoch: number; targetDataSchemaEpoch: number };

export function isBundleCompatible(
  targetDataSchemaEpoch: number,
  manifest: Pick<MigrationBundleManifest, 'sourceDataSchemaEpoch'>,
): MigrationCompatibilityResult {
  if (targetDataSchemaEpoch >= manifest.sourceDataSchemaEpoch) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'source-newer-than-target',
    sourceDataSchemaEpoch: manifest.sourceDataSchemaEpoch,
    targetDataSchemaEpoch,
  };
}
