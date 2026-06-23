#!/usr/bin/env npx tsx
/**
 * CI validation: boundary-registry spec_doc + match.paths integrity.
 *
 * PM: 260607_oss_scrub_incomplete_removal_regression_class (rec f732cfb3fecaec74)
 *
 * `scripts/boundary-hints.ts` already collects spec_doc and path-glob drift as
 * warnings inside `loadRegistry()`, but those warnings only surfaced when
 * boundary-hints tests ran (merge-gated via vitest related). This gate promotes
 * them to an always-on validate:fast failure so dangling registry refs are
 * caught on every push regardless of merge status.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from './boundary-hints.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY_PATH = join(repoRoot, 'docs/project/boundary-registry.yaml');

export async function checkBoundaryRegistryPaths(
  registryPath: string = DEFAULT_REGISTRY_PATH,
  cwd: string = repoRoot,
): Promise<readonly string[]> {
  const { warnings } = await loadRegistry(registryPath, cwd);
  return warnings;
}

async function main(): Promise<void> {
  const warnings = await checkBoundaryRegistryPaths();
  if (warnings.length > 0) {
    console.error(
      [
        `[boundary-registry-paths] ERROR: ${warnings.length} registry path issue(s):`,
        ...warnings.map((warning) => `  - ${warning}`),
        '',
        'Fix the spec_doc path or match.paths glob in docs/project/boundary-registry.yaml.',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log('[boundary-registry-paths] OK: all boundary-registry spec_doc and path globs resolve.');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(
      `[boundary-registry-paths] unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
