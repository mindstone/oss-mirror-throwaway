#!/usr/bin/env npx tsx
/**
 * Fail-loud guard for browser-extension build artifacts.
 *
 * IMPORTANT: This script intentionally fails when `packages/browser-extension/dist`
 * is missing. `validate:fast` builds the extension first, so a missing dist
 * directory means the build step did not run or failed unexpectedly.
 *
 * Checks:
 * 1) dist/manifest.json has no `.ts` entries in web_accessible_resources[*].resources
 * 2) dist/src/content/contentScript.ts does not exist
 * 3) JS files under dist/assets (recursive) do not contain `__rebelE2E__`
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(__dirname, '..');
const EXTENSION_DIST_DIR = path.join(ROOT_DIR, 'packages', 'browser-extension', 'dist');
const DIST_MANIFEST_PATH = path.join(EXTENSION_DIST_DIR, 'manifest.json');
const RAW_CONTENT_SCRIPT_PATH = path.join(
  EXTENSION_DIST_DIR,
  'src',
  'content',
  'contentScript.ts',
);
const DIST_ASSETS_DIR = path.join(EXTENSION_DIST_DIR, 'assets');

interface ManifestWebAccessibleResource {
  resources?: string[];
}

interface DistManifest {
  web_accessible_resources?: ManifestWebAccessibleResource[];
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listJsFilesRecursively(dir: string): Promise<string[]> {
  if (!(await exists(dir))) {
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listJsFilesRecursively(entryPath);
      }
      if (entry.isFile() && entry.name.endsWith('.js')) {
        return [entryPath];
      }
      return [];
    }),
  );
  return files.flat();
}

function failWithViolations(violations: string[]): never {
  console.error('\n❌ Browser extension dist bundle check failed.\n');
  for (const violation of violations) {
    console.error(`   - ${violation}`);
  }
  console.error('\n   See docs/plans/260424_browser_extension_bundling_and_permissions_fix.md\n');
  process.exit(1);
}

async function main(): Promise<void> {
  const violations: string[] = [];

  if (!(await exists(EXTENSION_DIST_DIR))) {
    failWithViolations([
      `Missing dist directory: ${path.relative(ROOT_DIR, EXTENSION_DIST_DIR)} (build must run before this check).`,
    ]);
  }

  if (!(await exists(DIST_MANIFEST_PATH))) {
    violations.push(`Missing dist manifest: ${path.relative(ROOT_DIR, DIST_MANIFEST_PATH)}.`);
  } else {
    const manifestRaw = await fs.readFile(DIST_MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(manifestRaw) as DistManifest;
    const resources =
      manifest.web_accessible_resources?.flatMap((entry) => entry.resources ?? []) ?? [];
    const tsResources = resources.filter((resource) => resource.endsWith('.ts'));
    if (tsResources.length > 0) {
      violations.push(
        `web_accessible_resources contains raw .ts entries: ${tsResources.join(', ')}.`,
      );
    }
  }

  if (await exists(RAW_CONTENT_SCRIPT_PATH)) {
    violations.push(
      `Raw TypeScript content script still exists in dist: ${path.relative(ROOT_DIR, RAW_CONTENT_SCRIPT_PATH)}.`,
    );
  }

  const assetJsFiles = await listJsFilesRecursively(DIST_ASSETS_DIR);
  const leakedE2EFiles: string[] = [];
  for (const filePath of assetJsFiles) {
    const content = await fs.readFile(filePath, 'utf8');
    if (content.includes('__rebelE2E__')) {
      leakedE2EFiles.push(path.relative(ROOT_DIR, filePath));
    }
  }
  if (leakedE2EFiles.length > 0) {
    violations.push(
      `Found '__rebelE2E__' in production asset bundle(s): ${leakedE2EFiles.join(', ')}. ` +
        "Gate test-only helpers behind `import.meta.env.MODE === 'test'`.",
    );
  }

  if (violations.length > 0) {
    failWithViolations(violations);
  }

  console.log('✅ Browser extension dist bundle check passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  failWithViolations([`Unexpected error while checking dist bundle: ${message}`]);
});
