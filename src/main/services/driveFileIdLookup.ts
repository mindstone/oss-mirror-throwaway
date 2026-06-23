/**
 * Direct Google Drive file_id lookup from the local filesystem.
 *
 * Google Drive for Desktop (macOS) stores the Drive file_id in an
 * extended attribute (`com.google.drivefs.item-id#S`) on every mirrored
 * file. Reading this is an O(1) operation and is guaranteed to match
 * the exact file the user sees in Finder — no fuzzy path walking
 * required.
 *
 * Falls back to `null` when:
 *   - Running on a non-macOS platform (Drive for Desktop uses a
 *     different mechanism on Windows; see follow-ups in
 *     `docs-private/investigations/260421_drive_file_id_resolution_lessons.md`).
 *   - The file is not inside a Drive for Desktop mirror (local-only
 *     files have no such xattr).
 *   - The `xattr` CLI is unavailable (should never happen on macOS).
 *
 * This is the primary resolution path for `driveSkillHistoryService`.
 * Only when this returns `null` does the service fall back to the
 * slower MCP-based path search.
 *
 * @see docs-private/investigations/260421_drive_file_id_resolution_lessons.md
 */
import { execFile } from 'node:child_process';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'driveFileIdLookup' });

const DRIVE_ITEM_ID_XATTR = 'com.google.drivefs.item-id#S';
const XATTR_TIMEOUT_MS = 2_000;
const DRIVE_ITEM_ID_SHAPE = /^[A-Za-z0-9_-]{10,120}$/;

function runXattr(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'xattr',
      ['-p', DRIVE_ITEM_ID_XATTR, absolutePath],
      { timeout: XATTR_TIMEOUT_MS, maxBuffer: 4 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const out = stdout as unknown;
        const text =
          typeof out === 'string'
            ? out
            : Buffer.isBuffer(out)
              ? out.toString('utf8')
              : '';
        resolve(text);
      },
    );
  });
}

/**
 * Read the Google Drive file_id for a local path, if the file is
 * inside a Drive for Desktop mirror on macOS.
 *
 * Returns `null` in any failure mode. Callers should fall back to
 * another resolution strategy (e.g. MCP search) rather than treating
 * `null` as a hard error.
 */
export async function readDriveFileIdFromXattr(absolutePath: string): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  let raw: string;
  try {
    raw = (await runXattr(absolutePath)).trim();
  } catch (err) {
    // Expected: exit code 1 means the attribute does not exist (file
    // is not inside a Drive mirror, or Drive for Desktop is not
    // installed). We surface it at debug level to avoid noise.
    const code = (err as { code?: unknown })?.code;
    if (code !== 1 && code !== '1') {
      log.debug({ err, absolutePath }, 'Drive item-id xattr read failed');
    }
    return null;
  }

  if (!raw) {
    return null;
  }
  if (!DRIVE_ITEM_ID_SHAPE.test(raw)) {
    log.debug({ absolutePath, rawLength: raw.length }, 'Drive item-id xattr value failed shape check');
    return null;
  }
  return raw;
}
