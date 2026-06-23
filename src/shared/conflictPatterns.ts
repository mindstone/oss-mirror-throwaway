/**
 * Shared Conflict Patterns
 *
 * Single source of truth for cloud-sync conflict file detection. Used by:
 *   - src/main/services/health/checks/conflictingCopies.ts (health check scan)
 *   - src/main/ipc/cloudHandlers.ts                        (workspace conflict listing)
 *   - src/core/services/spaceMaintenanceService.ts         (startup + daily cleanup)
 *
 * Consolidating prevents the pattern drift that previously caused the health check
 * to silently miss Rebel's own `.conflict-cloud` files while cloudHandlers matched
 * them (Round 1 critique finding — 2026-04-20).
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stage 1)
 */
import path from 'node:path';

/**
 * Marker suffix produced by `cloudWorkspaceSync` when local and cloud edits
 * diverge. Preserved as a bare constant for non-path use (e.g. substring
 * prefilter before invoking regex). Kept in lock-step with the
 * `rebel-cloud-conflict` entry of `CONFLICT_PATTERNS`.
 *
 * See cloudWorkspaceSync.ts:1055-1059 for the producer.
 */
export const WORKSPACE_CONFLICT_MARKER = '.conflict-cloud';

export type ConflictProvider = 'rebel' | 'dropbox' | 'google-drive' | 'generic';

export type ConflictLabel =
  | 'rebel-cloud-conflict'
  | 'dropbox-conflict'
  | 'numbered-copy'
  | 'copy-of-duplicate'
  | 'copy-suffix-duplicate'
  | 'sync-conflict';

export interface ConflictPattern {
  regex: RegExp;
  label: ConflictLabel;
  provider: ConflictProvider;
}

/**
 * Conflict filename patterns, evaluated in order. First match wins.
 *
 * The `rebel-cloud-conflict` regex intentionally permits the extensionless
 * form (`filename.conflict-cloud` with no trailing extension) because
 * `cloudWorkspaceSync.ts:1056-1059` can produce that shape when the source
 * file itself has no extension.
 */
export const CONFLICT_PATTERNS: readonly ConflictPattern[] = [
  { regex: /\.conflict-cloud(\.\w+)?$/,  label: 'rebel-cloud-conflict',   provider: 'rebel' },
  { regex: /\(conflicted copy[^)]*\)/i,  label: 'dropbox-conflict',       provider: 'dropbox' },
  { regex: /\(\d+\)\.\w+$/,              label: 'numbered-copy',          provider: 'google-drive' },
  { regex: /^Copy of /i,                 label: 'copy-of-duplicate',      provider: 'generic' },
  { regex: / copy\.\w+$/i,               label: 'copy-suffix-duplicate',  provider: 'generic' },
  { regex: /-conflict-\d{4,}/i,          label: 'sync-conflict',          provider: 'generic' },
] as const;

/**
 * Directory-only conflict patterns — DELIBERATELY NARROWER than the file set.
 *
 * Suppressing a conflict-copy *directory* drops an entire subtree from cloud
 * (Fly) sync + peer mirroring, so it is restricted to shapes that are
 * **unambiguously machine-minted**: Google Drive's numbered copy (`Project (1)`,
 * the REBEL-5QS report) and Dropbox's explicit `(conflicted copy …)` marker.
 *
 * The generic file heuristics `Copy of …`, `… copy`, `-conflict-<digits>` are
 * INTENTIONALLY EXCLUDED here: `Copy of Project/` and `backup copy/` are normal,
 * intentional user folder operations — matching them would silently drop a whole
 * legitimate folder tree from Fly. (Cross-family adversarial review F1, 2026-06-06.)
 * For files those names are a cheap one-file omission; for directories the blast
 * radius makes them too risky without proof they're machine-minted.
 */
const CONFLICT_DIR_PATTERNS: readonly ConflictPattern[] = [
  { regex: / \(\d+\)$/,                  label: 'numbered-copy',          provider: 'google-drive' },
  { regex: /\(conflicted copy[^)]*\)/i,  label: 'dropbox-conflict',       provider: 'dropbox' },
] as const;

/**
 * Match a filename against the known conflict patterns.
 * Returns the first matching pattern, or `null` if none match.
 *
 * Pass the basename — not the full path — so directory segments can't trip
 * the regexes (e.g. a `-conflict-` marker buried in a folder name).
 */
export function matchConflictPattern(fileName: string): ConflictPattern | null {
  for (const pattern of CONFLICT_PATTERNS) {
    if (pattern.regex.test(fileName)) {
      return pattern;
    }
  }
  return null;
}

export function matchConflictDirPattern(dirName: string): ConflictPattern | null {
  for (const pattern of CONFLICT_DIR_PATTERNS) {
    if (pattern.regex.test(dirName)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Given an absolute (or platform-relative) path to a conflict file and the
 * label of the pattern it matched, return the absolute path to the probable
 * original file. Returns `null` when the derivation is ambiguous.
 *
 * Uses `path.dirname` / `path.basename` so Windows backslash paths round-trip
 * correctly — join the derived basename back to the ORIGINAL directory.
 *
 * Downstream callers must still verify the original exists — this is a
 * filename-transform, not a filesystem probe.
 */
export function deriveOriginalPath(conflictPath: string, label: ConflictLabel): string | null {
  const dir = path.dirname(conflictPath);
  const name = path.basename(conflictPath);

  const baseName = deriveOriginalBaseName(name, label);
  if (!baseName) return null;

  // dir === '.' when the input was a bare filename. Preserve that shape
  // instead of emitting a spurious `./` prefix via path.join.
  if (dir === '.' || dir === '') return baseName;
  return path.join(dir, baseName);
}

/**
 * Like {@link deriveOriginalPath}, but returns EVERY progressively-shallower
 * candidate original — not just the immediate one-level-up sibling.
 *
 * For a Google-Drive numbered copy this walks the whole `(N)` chain down to the
 * root: `foo (1) (1) (1).md` → [`foo (1) (1).md`, `foo (1).md`, `foo.md`]. The
 * one-level {@link deriveOriginalPath} only yields the first of these, which
 * makes the sibling-gate FAIL OPEN on a *missing-intermediate* chain — e.g. a
 * real Drive storm (or a partial manual cleanup) where `foo (1).md` has been
 * deleted/renamed but `foo (1) (1).md` and the root `foo.md` both remain. There
 * the deeper copy looks like a legitimate standalone and Rebel re-propagates it
 * through Fly, regenerating the fan-out (REBEL-62A recurrence, Jonas / 0.4.45).
 *
 * Suppression callers should treat the file as a conflict copy when ANY
 * candidate original is present. Only `numbered-copy` is multi-level; every
 * other label collapses to the single {@link deriveOriginalPath} result, so
 * their behavior is unchanged.
 *
 * Returns `[]` when no original can be derived.
 */
export function deriveOriginalPathCandidates(
  conflictPath: string,
  label: ConflictLabel,
): string[] {
  const dir = path.dirname(conflictPath);
  const name = path.basename(conflictPath);

  const baseNames = deriveOriginalBaseNameCandidates(name, label);
  return baseNames.map((baseName) =>
    dir === '.' || dir === '' ? baseName : path.join(dir, baseName),
  );
}

export function deriveOriginalDirPath(conflictDirPath: string, label: ConflictLabel): string | null {
  const dir = path.dirname(conflictDirPath);
  const name = path.basename(conflictDirPath);

  const baseName = deriveOriginalDirBaseName(name, label);
  if (!baseName) return null;

  if (dir === '.' || dir === '') return baseName;
  return path.join(dir, baseName);
}

function deriveOriginalBaseName(fileName: string, label: ConflictLabel): string | null {
  switch (label) {
    case 'rebel-cloud-conflict': {
      // `foo.conflict-cloud.md` -> `foo.md`
      // `foo.conflict-cloud`    -> `foo`  (extensionless case per cloudWorkspaceSync)
      if (fileName.endsWith(WORKSPACE_CONFLICT_MARKER)) {
        const base = fileName.slice(0, -WORKSPACE_CONFLICT_MARKER.length);
        return base.length > 0 ? base : null;
      }
      const markerWithDelimiter = `${WORKSPACE_CONFLICT_MARKER}.`;
      const markerIdx = fileName.lastIndexOf(markerWithDelimiter);
      if (markerIdx <= 0) return null;
      const base = fileName.slice(0, markerIdx);
      const ext = fileName.slice(markerIdx + markerWithDelimiter.length);
      if (!base || !ext) return null;
      return `${base}.${ext}`;
    }

    case 'dropbox-conflict': {
      // `README (conflicted copy 2025-01-15 Josh's MacBook).md` -> `README.md`
      // Strip `( optional-leading-space?conflicted copy ...)` — tolerate
      // either a space or nothing before the opening paren.
      const stripped = fileName.replace(/\s*\(conflicted copy[^)]*\)/i, '');
      return stripped && stripped !== fileName ? stripped : null;
    }

    case 'numbered-copy': {
      // `README (1).md` -> `README.md`
      // `data (2).tar.gz` -> `data.tar.gz` (only strips the final ` (N)` before ext)
      const stripped = fileName.replace(/\s*\(\d+\)(\.\w+)$/, '$1');
      return stripped && stripped !== fileName ? stripped : null;
    }

    case 'copy-of-duplicate': {
      // `Copy of notes.md` -> `notes.md`
      const stripped = fileName.replace(/^Copy of /i, '');
      return stripped && stripped !== fileName ? stripped : null;
    }

    case 'copy-suffix-duplicate': {
      // `README copy.md` -> `README.md`
      const stripped = fileName.replace(/ copy(\.\w+)$/i, '$1');
      return stripped && stripped !== fileName ? stripped : null;
    }

    case 'sync-conflict': {
      // `data-conflict-20250115123456.json` -> `data.json`
      // Strip the `-conflict-<digits>` marker anywhere before the extension.
      const stripped = fileName.replace(/-conflict-\d{4,}/i, '');
      return stripped && stripped !== fileName ? stripped : null;
    }

    default:
      return null;
  }
}

/**
 * Every progressively-shallower original basename for `fileName`. For
 * `numbered-copy` this strips the trailing ` (N)` group repeatedly, collecting
 * each shallower form down to the root original. All other labels yield the
 * single {@link deriveOriginalBaseName} result (or none), so their suppression
 * behavior is byte-identical to the one-level path.
 */
function deriveOriginalBaseNameCandidates(fileName: string, label: ConflictLabel): string[] {
  if (label !== 'numbered-copy') {
    const single = deriveOriginalBaseName(fileName, label);
    return single ? [single] : [];
  }

  const candidates: string[] = [];
  let current = fileName;
  // Strip the trailing ` (N)` (before the extension) repeatedly. Each iteration
  // peels one Drive numbering level; the loop terminates when no ` (N)` remains
  // (the regex no longer matches → `stripped === current`).
  for (;;) {
    const stripped = current.replace(/\s*\(\d+\)(\.\w+)$/, '$1');
    if (stripped === current) break;
    candidates.push(stripped);
    current = stripped;
  }
  return candidates;
}

function deriveOriginalDirBaseName(dirName: string, label: ConflictLabel): string | null {
  // Only the two labels in CONFLICT_DIR_PATTERNS are reachable here (matchConflictDirPattern
  // never returns the generic copy-of/copy-suffix/sync-conflict labels for directories).
  switch (label) {
    case 'numbered-copy': {
      const stripped = dirName.replace(/ \(\d+\)$/, '');
      return stripped && stripped !== dirName ? stripped : null;
    }

    case 'dropbox-conflict': {
      const stripped = dirName.replace(/\s*\(conflicted copy[^)]*\)/i, '');
      return stripped && stripped !== dirName ? stripped : null;
    }

    default:
      return null;
  }
}

/**
 * Sniff the first N bytes of a file buffer for non-text content.
 *
 * Heuristic:
 *   1. Any NUL byte in the sample -> binary.
 *   2. More than 30% non-printable (outside 0x09/0x0A/0x0D and 0x20..0x7E
 *      plus the >=0x80 high-byte range, which we accept as potential UTF-8)
 *      -> binary.
 *
 * The goal is fail-safe: if we're unsure, classify as binary and skip — the
 * LLM merge path should never see non-text content (Failure Mode Matrix F-binary).
 */
export function sniffIsBinary(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;

  let nonPrintable = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    // Common text bytes: tab, LF, CR, printable ASCII, or high-byte UTF-8.
    const printable =
      b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) || b >= 0x80;
    if (!printable) nonPrintable++;
  }
  return nonPrintable / bytes.length > 0.3;
}

/** Default sample size for `sniffIsBinary`. Exported for callers that want to read-then-sniff. */
export const BINARY_SNIFF_BYTES = 512;
