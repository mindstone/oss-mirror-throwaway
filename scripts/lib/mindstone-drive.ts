/**
 * Lightweight TypeScript shim for resolving the Mindstone Google Shared Drive
 * path. Standalone (no evals/ or src/core imports) so it's safe to use from
 * `scripts/` and any tsx-run tooling.
 *
 * Fallback chain (identical to the canonical resolvers):
 *   1. MINDSTONE_PRODUCT_DRIVE env var
 *   2. `~/Library/CloudStorage/GoogleDrive-*@example.com/Shared drives/Product`
 *   3. First `GoogleDrive-*` with `Shared drives/Product`
 *   4. null — caller falls back
 *
 * Canonical sources:
 *   - Python: `coding-agent-instructions/scripts/drive_resolver.py`
 *   - TypeScript: `evals/shared.ts` (resolveMindstoneProductDrive)
 *   - Design doc: `docs/project/GOOGLE_DRIVE_PATH_RESOLUTION.md`
 *
 * Keep this in sync with the canonical implementations. The intentional
 * duplication exists because `evals/shared.ts` pulls in `@core/*` path
 * aliases that don't resolve under the default `npx tsx` command used in
 * `scripts/`.
 */

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MINDSTONE_DOMAIN = '@example.com';
const SHARED_DRIVE_NAME = 'Product';

/** Returns the absolute path to the Mindstone Product drive, or null. */
export function resolveMindstoneProductDrive(): string | null {
  const envOverride = process.env.MINDSTONE_PRODUCT_DRIVE?.trim();
  if (envOverride) {
    try {
      if (fsSync.statSync(envOverride).isDirectory()) return envOverride;
    } catch {
      // ignore — fall through to auto-detect
    }
  }

  if (process.platform !== 'darwin') return null;

  const cloudStorage = path.join(os.homedir(), 'Library', 'CloudStorage');
  let entries: string[];
  try {
    const stat = fsSync.statSync(cloudStorage);
    if (!stat.isDirectory()) return null;
    entries = fsSync.readdirSync(cloudStorage).sort();
  } catch {
    return null;
  }

  // Pass 1: prefer @example.com
  for (const entry of entries) {
    if (entry.startsWith('GoogleDrive-') && entry.includes(MINDSTONE_DOMAIN)) {
      const candidate = path.join(cloudStorage, entry, 'Shared drives', SHARED_DRIVE_NAME);
      try {
        if (fsSync.statSync(candidate).isDirectory()) return candidate;
      } catch {
        // ignore
      }
    }
  }

  // Pass 2: any Google Drive with Shared drives/Product
  for (const entry of entries) {
    if (entry.startsWith('GoogleDrive-')) {
      const candidate = path.join(cloudStorage, entry, 'Shared drives', SHARED_DRIVE_NAME);
      try {
        if (fsSync.statSync(candidate).isDirectory()) return candidate;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

/**
 * Returns a subdirectory under the Product drive, or null if the drive is
 * unresolvable. Does NOT create the directory.
 */
export function resolveMindstoneProductSubdir(...parts: string[]): string | null {
  const base = resolveMindstoneProductDrive();
  return base ? path.join(base, ...parts) : null;
}
