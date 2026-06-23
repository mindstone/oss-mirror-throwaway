import type { AppSettings } from '@shared/types';

/**
 * 260622 Stage 4: resolve the on-disk Chief-of-Staff README path renderer-side
 * for the "Open the file" recovery action (the `reveal-chief-of-staff-readme`
 * sentinel). Prefer the chief-of-staff entry's on-disk relative path from
 * `settings.spaces` (handles a case-variant / symlinked directory name), else
 * fall back to the canonical `Chief-of-Staff` join. Returns `null` when no
 * workspace folder is set.
 *
 * This mirrors the main-side `resolveChiefOfStaffDir` derivation
 * (`src/core/services/turnPipeline/chiefOfStaffAdmission.ts`) but is a pure,
 * I/O-free string join: it is only used to point the OS file manager at the
 * file (`revealPath`, which degrades gracefully if the path is gone), never to
 * read it — so a static join is sufficient and safe.
 */
export function resolveChiefOfStaffReadmePath(
  settings: Pick<AppSettings, 'coreDirectory' | 'spaces'> | null | undefined,
): string | null {
  const coreDirectory = settings?.coreDirectory?.trim();
  if (!coreDirectory) return null;

  const base = coreDirectory.replace(/[/\\]+$/, '');
  // Match the core admission resolver (`resolveChiefOfStaffDir`): prefer the
  // typed chief-of-staff entry, but also accept a legacy entry whose relative
  // path IS the Chief-of-Staff dir (case-insensitive) even if `type` is unset on
  // an older settings shape — so we don't reveal the canonical fallback when a
  // real, differently-cased entry exists.
  const cosEntry = settings?.spaces?.find(
    (space) =>
      space.type === 'chief-of-staff' ||
      space.path?.replace(/[/\\]+$/, '').toLowerCase() === 'chief-of-staff',
  );
  const relativeDir = cosEntry?.path?.replace(/[/\\]+$/, '') || 'Chief-of-Staff';

  // Preserve the workspace path's separator style (Windows backslash vs POSIX
  // slash) — `path` is unavailable in the renderer, so join manually.
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return [base, relativeDir, 'README.md'].join(sep);
}
