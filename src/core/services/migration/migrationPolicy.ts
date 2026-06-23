import path from 'node:path';
import { normalizeSnapshotRelativePath } from '@core/utils/safeSnapshotCopy';
import {
  MIGRATION_CLASSIFICATIONS,
  type MigrationClassificationEntry,
  type MigrationClassificationVerdict,
} from './migrationClassification';
import type { MigrationBundleManifest } from './migrationManifest';

export const MIGRATION_DATA_DIR_NAME = 'data';
export const MIGRATION_WORKSPACE_DATA_PREFIX = 'workspace';
export const MIGRATION_APP_SETTINGS_REL_PATH = 'app-settings.json';
export const MIGRATION_WORKSPACE_ROOT_SPACE_REL_PATH = '.';

const MIGRATION_EXPORT_SAFETY_DENYLIST: readonly string[] = [
  'mcp',
  'auth-tokens.json',
  'plugin-storage.json',
  'plugin-data',
  'cloud-service-client-id.json',
  'connector-contributions.json',
  'cloud-token-store.json',
  'cloud-token.json',
  'cloud-tokens.json',
];

const MIGRATION_EXPORT_SAFETY_DENYLIST_PATTERNS: readonly RegExp[] = [
  /(^|\/)[^/]*-tokens\.json$/i,
];

const MIGRATION_CLASSIFICATION_ENTRIES = MIGRATION_CLASSIFICATIONS as readonly MigrationClassificationEntry[];

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isUnderRelPath(relativePath: string, possibleParent: string): boolean {
  return relativePath === possibleParent || relativePath.startsWith(`${possibleParent}/`);
}

export function isDeniedMigrationRelPath(relativePath: string): boolean {
  const normalized = normalizeSnapshotRelativePath(relativePath);
  if (MIGRATION_EXPORT_SAFETY_DENYLIST.some((denied) => {
    const normalizedDenied = normalizeSnapshotRelativePath(denied);
    return normalized === normalizedDenied || normalized.startsWith(`${normalizedDenied}/`);
  })) {
    return true;
  }
  return MIGRATION_EXPORT_SAFETY_DENYLIST_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildNonCopyRelPaths(): string[] {
  const nonCopyRelPaths: string[] = [];
  for (const entry of MIGRATION_CLASSIFICATION_ENTRIES) {
    if (entry.verdict === 'copy') continue;
    nonCopyRelPaths.push(...(entry.relPaths ?? []).map(normalizeSnapshotRelativePath));
  }
  return sortedUnique(nonCopyRelPaths);
}

const NON_COPY_REL_PATHS = buildNonCopyRelPaths();

export function shouldCopyUserDataMigrationRelPath(relativePath: string): boolean {
  const normalized = normalizeSnapshotRelativePath(relativePath);
  return !isDeniedMigrationRelPath(normalized) &&
    !NON_COPY_REL_PATHS.some((excluded) => isUnderRelPath(normalized, excluded));
}

export function buildMigrationCopyRoots(): string[] {
  const copyRoots: string[] = [];
  for (const entry of MIGRATION_CLASSIFICATION_ENTRIES) {
    if (entry.verdict !== 'copy') continue;
    for (const relPath of entry.relPaths ?? []) {
      if (!isDeniedMigrationRelPath(relPath)) copyRoots.push(normalizeSnapshotRelativePath(relPath));
    }
  }
  return sortedUnique(copyRoots);
}

export function buildMigrationExclusions(): MigrationBundleManifest['exclusions'] {
  const exclusions: MigrationBundleManifest['exclusions'] = {
    derived: [],
    keychain: [],
    cloud: [],
    transient: [],
  };

  for (const entry of MIGRATION_CLASSIFICATION_ENTRIES) {
    const group = exclusionGroupForVerdict(entry.verdict);
    if (!group) continue;
    exclusions[group].push(...(entry.relPaths ?? []).map(normalizeSnapshotRelativePath));
  }

  // Safety overlay for A3 deny-list paths whose Stage 1 classification is not
  // an exclusion verdict. Keep this as a policy overlay so export and import
  // reject the same sensitive portable paths.
  exclusions.keychain.push(...MIGRATION_EXPORT_SAFETY_DENYLIST.map(normalizeSnapshotRelativePath));

  return {
    derived: sortedUnique(exclusions.derived),
    keychain: sortedUnique(exclusions.keychain),
    cloud: sortedUnique(exclusions.cloud),
    transient: sortedUnique(exclusions.transient),
  };
}

function exclusionGroupForVerdict(
  verdict: MigrationClassificationVerdict,
): keyof MigrationBundleManifest['exclusions'] | null {
  switch (verdict) {
    case 'exclude-derived':
      return 'derived';
    case 'exclude-keychain':
      return 'keychain';
    case 'exclude-cloud':
      return 'cloud';
    case 'exclude-transient':
      return 'transient';
    case 'copy':
    case 'special':
      return null;
  }
}

const MIGRATION_COPY_ROOTS = buildMigrationCopyRoots();

function isAllowedUserDataImportPath(normalizedRelPath: string): boolean {
  if (!shouldCopyUserDataMigrationRelPath(normalizedRelPath)) return false;
  return MIGRATION_COPY_ROOTS.some((copyRoot) => isUnderRelPath(normalizedRelPath, copyRoot));
}

function isAllowedWorkspaceImportPath(
  normalizedRelPath: string,
  spaces: MigrationBundleManifest['spaces'],
): boolean {
  if (
    normalizedRelPath !== MIGRATION_WORKSPACE_DATA_PREFIX &&
    !normalizedRelPath.startsWith(`${MIGRATION_WORKSPACE_DATA_PREFIX}/`)
  ) {
    return false;
  }

  for (const space of spaces) {
    if (space.classification !== 'internal-local') continue;
    if (space.relPath === MIGRATION_WORKSPACE_ROOT_SPACE_REL_PATH) continue;

    const spacePrefix = normalizeSnapshotRelativePath(path.posix.join(
      MIGRATION_WORKSPACE_DATA_PREFIX,
      space.relPath,
    ));
    if (!isUnderRelPath(normalizedRelPath, spacePrefix)) continue;

    const spaceRelativePath = normalizeSnapshotRelativePath(path.posix.relative(spacePrefix, normalizedRelPath));
    return spaceRelativePath !== MIGRATION_WORKSPACE_ROOT_SPACE_REL_PATH &&
      !isDeniedMigrationRelPath(spaceRelativePath);
  }
  return false;
}

export function isAllowedMigrationImportEntryPath(
  relativePath: string,
  manifest: MigrationBundleManifest,
): boolean {
  const normalized = normalizeSnapshotRelativePath(relativePath);
  if (normalized === MIGRATION_APP_SETTINGS_REL_PATH) return true;
  return isAllowedUserDataImportPath(normalized) || isAllowedWorkspaceImportPath(normalized, manifest.spaces);
}
