/**
 * Canonical connector path key — Stage 2.B (260426).
 *
 * Used wherever path equality across casing/separator/symlink/Unicode-form
 * variants must converge. Replaces the legacy `toPortablePath(p).toLowerCase()`
 * idiom that incorrectly lowercased Linux paths and ignored macOS NFD/NFC
 * encoding differences (failure-matrix #21).
 *
 * Behaviour by platform:
 *   - Tilde-expansion via `getPlatformConfig().homePath` (when bootstrapped).
 *   - `path.resolve` to absolute (defends against ../traversal).
 *   - `fs.realpathSync` ONLY when `fs.existsSync` is true. Falls through on
 *     ENOENT — paths frequently don't exist yet during build.
 *   - `toPortablePath` to forward slashes.
 *   - `.normalize('NFC')` so macOS NFD-encoded paths compare equal to NFC.
 *   - `.toLowerCase()` on darwin + win32; identity on linux + others.
 *
 * Returns `''` for empty/null/undefined/whitespace inputs (preserves the
 * existing "session-keyed for pathless records" contract).
 *
 * NOTE: lives outside `portablePath.ts` because that file is intentionally
 * renderer-safe (uses `pathe`, no `node:fs` / `node:path` imports). This
 * helper depends on platform-aware `node:path` resolution and `node:fs`
 * realpath, so it lives next door rather than infecting the renderer-safe
 * path utilities.
 *
 * @see docs/plans/260426_foolproof_contribution_flow_stage2.md (Stage 2.B)
 */

import nodePath from 'node:path';
import fs from 'node:fs';
import { getPlatformConfig } from '@core/platform';
import { toPortablePath } from '@core/utils/portablePath';

export function canonicalizeConnectorPath(
  localServerPath: string | undefined | null,
): string {
  if (!localServerPath || !localServerPath.trim()) return '';

  let homePath = '';
  try {
    homePath = getPlatformConfig().homePath;
  } catch {
    // Pre-bootstrap callers (none expected outside tests, but be lenient):
    // skip tilde expansion. Subsequent NFC + casing normalisation still apply.
  }

  let expanded = localServerPath.trim();
  if (homePath && (expanded.startsWith('~/') || expanded.startsWith('~\\'))) {
    expanded = nodePath.join(homePath, expanded.slice(2));
  }

  let absolute: string;
  try {
    absolute = nodePath.resolve(expanded);
  } catch {
    // path.resolve can throw for non-string-like inputs in extreme edges.
    absolute = expanded;
  }

  let realpathed = absolute;
  try {
    if (fs.existsSync(absolute)) {
      realpathed = fs.realpathSync(absolute);
    }
  } catch {
    // realpath can throw EACCES on locked dirs / ELOOP on circular symlinks;
    // fall through to the absolute (non-realpathed) form.
  }

  const portable = toPortablePath(realpathed).normalize('NFC');
  if (process.platform === 'linux') {
    return portable;
  }
  return portable.toLowerCase();
}
