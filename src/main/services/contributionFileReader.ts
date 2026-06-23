/**
 * Contribution File Reader
 *
 * Pure-function helper that reads a built connector's file tree from disk
 * and shapes it into the `{ path, content }[]` payload used by both the
 * D7 direct-fork GitHub submission and the optional relay submission.
 *
 * Extracted from the inline logic previously embedded in
 * `src/main/ipc/contributionHandlers.ts::contribution:submit-from-store` so
 * both transport paths share identical traversal rules. Behaviour preserved
 * exactly:
 *   - Tilde (`~`) expansion to the OS home directory.
 *   - Path-traversal guard: the resolved real path must live under `$HOME`.
 *   - Skips `node_modules`, `.git`, `.DS_Store`, `dist`.
 *   - Skips backend-denylisted filenames (`.env*`, `.pem`, `.key`, etc.) and
 *     reports them via `skippedDenylisted` so callers can surface the list
 *     instead of hitting a backend 400. Mirrors the rule set in
 *     `src/shared/utils/contributionSensitiveFiles.ts`.
 *   - Per-file size cap of 1 MB (binary / oversized files are skipped with a log line).
 *   - Paths are normalised to POSIX separators and emitted as
 *     `connectors/<connectorName>/<relative-path>`.
 *
 * @see docs/plans/260420_oss_mcp_backend_relay.md (Stage 2)
 * @see docs-private/investigations/260423_contribution_relay_400_validation.md
 */

import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { createScopedLogger } from '@core/logger';
import { isDenylistedFilename } from '@shared/utils/contributionSensitiveFiles';

const log = createScopedLogger({ service: 'contribution-file-reader' });

// ─── Constants ──────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '.DS_Store', 'dist']);

/**
 * Per-file size cap. Files exceeding this are skipped with a log line —
 * they are overwhelmingly build artefacts or binaries, and including them
 * would blow past the backend 256 KB per-file relay limit anyway.
 */
const MAX_FILE_SIZE_BYTES = 1024 * 1024;

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Shape matches the `ConnectorFile` inline object used by the relay
 * contract (`ContributionFileSchema` in
 * `src/shared/schemas/contributionRelay.ts`).
 */
export interface ConnectorFile {
  path: string;
  content: string;
}

/**
 * Result of a connector-file read. Exposes both the files that will be
 * submitted AND the basenames of files that were auto-skipped because they
 * matched the backend's sensitive-file rules.
 *
 * Callers typically submit `files` as-is and surface `skippedDenylisted` to
 * the user (post-submit toast / status UI) so the skip is observable rather
 * than silent.
 */
export interface ReadConnectorFilesResult {
  files: ConnectorFile[];
  /** Basenames (not full paths) of files that were denylisted and skipped. */
  skippedDenylisted: string[];
}

// ─── Errors ─────────────────────────────────────────────────────────

/**
 * Raised when the caller-supplied `localServerPath` fails the sandbox
 * check (absolute outside `$HOME`, traversal via `..`, missing, or not a
 * directory). Distinct from a read error so callers can surface a crisp
 * "cannot submit from this path" message without leaking filesystem state.
 */
export class ContributionFileReadError extends Error {
  readonly code:
    | 'OUTSIDE_HOME'
    | 'NOT_FOUND'
    | 'NOT_A_DIRECTORY'
    | 'SYMLINK_REJECTED'
    | 'NO_FILES_FOUND';

  constructor(
    code: ContributionFileReadError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'ContributionFileReadError';
    this.code = code;
  }
}

// ─── Path resolution ────────────────────────────────────────────────

/**
 * Expand a leading `~` segment to the OS home directory. Agents
 * occasionally store literal `~/mcp-servers/...` paths in the contribution
 * record, and `path.resolve()` does NOT expand `~`.
 */
function expandTilde(rawPath: string): string {
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return nodePath.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function normalizeForPrefixCheck(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithinDirectory(targetPath: string, rootDir: string): boolean {
  const resolvedTarget = normalizeForPrefixCheck(nodePath.resolve(targetPath));
  const resolvedRoot = normalizeForPrefixCheck(nodePath.resolve(rootDir));
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${nodePath.sep}`)
  );
}

/**
 * Resolve `localServerPath` to an absolute path on disk, enforcing the
 * `$HOME`-sandbox rule. Throws `ContributionFileReadError` on violations.
 */
function resolveServerDir(localServerPath: string): string {
  const expanded = expandTilde(localServerPath);
  const serverDir = nodePath.resolve(expanded);
  const resolvedHomeDir = nodePath.resolve(os.homedir());

  // Fail closed for obvious out-of-sandbox paths even when the target does
  // not exist (prevents existence probing outside $HOME).
  if (!isWithinDirectory(serverDir, resolvedHomeDir)) {
    log.warn(
      { serverDir, homeDir: resolvedHomeDir },
      'Blocked connector file read: path outside home directory',
    );
    throw new ContributionFileReadError(
      'OUTSIDE_HOME',
      'Connector directory must be within the home directory',
    );
  }

  if (!fs.existsSync(serverDir)) {
    throw new ContributionFileReadError(
      'NOT_FOUND',
      `Connector directory not found: ${serverDir}`,
    );
  }

  const canonicalServerDir = fs.realpathSync(serverDir);
  const canonicalHomeDir = fs.realpathSync(nodePath.resolve(os.homedir()));

  // Must be inside $HOME after canonicalisation (prevents symlink escape).
  if (!isWithinDirectory(canonicalServerDir, canonicalHomeDir)) {
    log.warn(
      { serverDir, canonicalServerDir, canonicalHomeDir },
      'Blocked connector file read: path outside home directory',
    );
    throw new ContributionFileReadError(
      'OUTSIDE_HOME',
      'Connector directory must be within the home directory',
    );
  }

  const stat = fs.lstatSync(canonicalServerDir);
  if (!stat.isDirectory()) {
    throw new ContributionFileReadError(
      'NOT_A_DIRECTORY',
      'localServerPath is not a directory',
    );
  }

  return canonicalServerDir;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Read a connector's file tree from disk and return it in the shape
 * expected by both the GitHub and relay submission paths.
 *
 * @param localServerPath - Absolute (or `~`-prefixed) path to the built
 *   connector directory. Must resolve to a directory under the user's
 *   home folder.
 * @param connectorName - Slug used as the leading path segment on every
 *   emitted file (`connectors/<connectorName>/...`).
 *
 * @throws {ContributionFileReadError} when the path is outside `$HOME`,
 *   missing, not a directory, or contains no readable files.
 */
export async function readConnectorFilesForSubmission(
  localServerPath: string,
  connectorName: string,
): Promise<ReadConnectorFilesResult> {
  const serverDir = resolveServerDir(localServerPath);
  const files: ConnectorFile[] = [];
  const skippedDenylisted: string[] = [];

  // bounded-walker-pending: see docs/plans/260503_s9_bounded_walker_resource_budget.md
  const readDir = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = nodePath.resolve(serverDir, relativePath);
      if (!isWithinDirectory(fullPath, serverDir)) {
        throw new ContributionFileReadError(
          'OUTSIDE_HOME',
          'Connector directory traversal was rejected',
        );
      }
      const entryStat = fs.lstatSync(fullPath);
      if (entryStat.isSymbolicLink()) {
        throw new ContributionFileReadError(
          'SYMLINK_REJECTED',
          `Symlinks are not allowed in connector submissions: ${fullPath}`,
        );
      }
      if (entryStat.isDirectory()) {
        readDir(fullPath, relativePath);
        continue;
      }
      if (!entryStat.isFile()) {
        continue;
      }
      // Sensitive-file denylist check — mirror of the backend's
      // `isDenylistedExtension()` rules mirrored by contributionSensitiveFiles.
      // Skip the file AND record its basename so callers can surface the
      // exclusion; previously these files passed through and triggered a
      // generic backend 400.
      if (isDenylistedFilename(entry.name)) {
        log.info(
          { basename: entry.name, serverDir, reason: 'denylisted' },
          'Excluded sensitive file from contribution',
        );
        skippedDenylisted.push(entry.name);
        continue;
      }
      if (entryStat.size > MAX_FILE_SIZE_BYTES) {
        log.info(
          { fullPath, size: entryStat.size },
          'Skipping large file in contribution',
        );
        continue;
      }
      files.push({
        path: `connectors/${connectorName}/${relativePath}`,
        content: fs.readFileSync(fullPath, 'utf-8'),
      });
    }
  };
  readDir(serverDir, '');

  if (files.length === 0) {
    throw new ContributionFileReadError(
      'NO_FILES_FOUND',
      'No files found in connector directory',
    );
  }

  return { files, skippedDenylisted };
}
