import os from 'node:os';
import path from 'pathe';
import { getPlatformConfig } from '@core/platform';
import { toPortablePath } from '@core/utils/portablePath';
import { normalizeSafetyPath } from '@core/services/safety/bashTargetSpace';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { OutsideCategory } from '@rebel/shared';

/**
 * Classification for files that couldn't be matched to any space. Mirrors the
 * `OutsideCategory` enum (the persisted/IPC shape) one-to-one.
 */
export type UnmatchedFileClassification = OutsideCategory;

export interface ClassifyUnmatchedPathOptions {
  /**
   * Symlink-aware containment predicate applied as a SECOND gate on the
   * auto-approvable branches (temp / inbox / mcp_servers). The lexical
   * (`startsWith`) check runs first; this predicate must ALSO return true for
   * the branch to match.
   *
   * Desktop safety callers (the memory-write hook) inject a realpath-based check
   * so a symlinked subdir escape — e.g. `<inbox>/escape/x` where `escape` ->
   * `../trusted-tools` — is NOT classified `inbox` (and therefore not
   * auto-approved) even though it lexically starts with the inbox dir.
   *
   * Display-only callers (file-location labels) omit it: a mislabeled badge is
   * harmless, and it keeps this branch lexical-only for surfaces that only need
   * a human-readable label. The predicate receives RAW (un-normalized) child +
   * parent so it can realpath them itself.
   *
   * Default: always-contained (lexical-only classification).
   */
  isContained?: (rawChild: string, rawParent: string) => boolean;
}

const ALWAYS_CONTAINED = (): boolean => true;

/**
 * Classify a file path that couldn't be matched to any space, returning a
 * machine-readable `classification` plus a human `displayLabel`.
 *
 * SINGLE SOURCE OF TRUTH for the unmatched-path precedence ladder
 * (temp -> system -> inbox -> mcp_servers -> outside/workspace_root/unknown).
 * Both the safety auto-approve decision (`memoryWriteHook.ts`, which injects a
 * realpath containment predicate) and the display-label resolver
 * (`fileLocation.ts`, lexical-only) consume this so the label a user sees and
 * the decision the gate makes can never drift apart. This unifies the two
 * copies that previously carried a "precedence MUST match … drift is a safety
 * hazard" warning.
 *
 * All path comparisons run through `normalizeSafetyPath` (collapses
 * `.`/`..`/`//`, strips trailing `/`) so a traversal spelling cannot evade the
 * lexical containment checks. The symlink dimension is handled by the injected
 * `isContained` predicate (see {@link ClassifyUnmatchedPathOptions}).
 */
export function classifyUnmatchedPath(
  filePath: string,
  coreDirectory: string | undefined,
  options: ClassifyUnmatchedPathOptions = {},
): { classification: UnmatchedFileClassification; displayLabel: string } {
  const isContained = options.isContained ?? ALWAYS_CONTAINED;

  const normalizedPath = normalizeSafetyPath(filePath).toLowerCase();
  const normalizedCore = coreDirectory ? normalizeSafetyPath(coreDirectory).toLowerCase() : undefined;
  const isUnderCore = normalizedCore
    ? normalizedPath === normalizedCore || normalizedPath.startsWith(`${normalizedCore}/`)
    : false;

  // Temp directories (OS temp, macOS /private/tmp, /var/folders). Lexical
  // containment first, then the injected symlink-aware gate so a `<tmp>/escape/x`
  // where `escape` symlinks outside temp is not auto-approved.
  const rawTempDirs = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders'];
  for (const rawTp of rawTempDirs) {
    const tp = normalizeSafetyPath(rawTp).toLowerCase();
    if (
      (normalizedPath === tp || normalizedPath.startsWith(`${tp}/`))
      && isContained(filePath, rawTp)
    ) {
      return { classification: 'temp', displayLabel: 'Temporary folder' };
    }
  }

  // rebel-system directory (bundled system files): under coreDirectory/rebel-system
  // or a bare relative rebel-system/.
  if (normalizedPath.includes('/rebel-system/') || normalizedPath.startsWith('rebel-system/')) {
    return { classification: 'system', displayLabel: 'System files' };
  }

  // Electron userData inbox directory. Scoped to inbox/ ONLY — other userData
  // paths (settings, trusted tools, …) are security-sensitive and must NOT be
  // auto-approved.
  try {
    const rawInboxDir = path.join(getPlatformConfig().userDataPath, 'inbox');
    const inboxDir = normalizeSafetyPath(rawInboxDir).toLowerCase();
    if (
      (normalizedPath === inboxDir || normalizedPath.startsWith(`${inboxDir}/`))
      && isContained(filePath, rawInboxDir)
    ) {
      return { classification: 'inbox', displayLabel: 'Actions' };
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'classifyUnmatchedPath.inbox',
      reason: 'platform config unavailable before bootstrap / non-desktop context; skip inbox branch',
    });
  }

  // MCP server project directory (~/mcp-servers/). Auto-approved in interactive
  // sessions (user-initiated custom connector builds); the secret gate still runs
  // before auto-approve downstream.
  try {
    const homePath = getPlatformConfig().homePath;
    const rawMcpServersDir = path.join(homePath, 'mcp-servers');
    const mcpServersDir = toPortablePath(rawMcpServersDir).toLowerCase();
    // Expand tilde shorthand: agents may pass literal ~/mcp-servers/… —
    // path.resolve does NOT expand ~ (it becomes <cwd>/~/…).
    let expandedPath = filePath;
    if (expandedPath.startsWith('~/') || expandedPath.startsWith('~\\')) {
      expandedPath = path.join(homePath, expandedPath.slice(2));
    } else if (expandedPath === '~') {
      expandedPath = homePath;
    }
    // path.resolve collapses traversal (../../.ssh/keys) before comparison.
    const resolvedPath = toPortablePath(path.resolve(expandedPath)).toLowerCase();
    if (
      (resolvedPath === mcpServersDir || resolvedPath.startsWith(`${mcpServersDir}/`))
      && isContained(expandedPath, rawMcpServersDir)
    ) {
      return { classification: 'mcp_servers', displayLabel: 'MCP Servers' };
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'classifyUnmatchedPath.mcpServers',
      reason: 'platform config unavailable before bootstrap / non-desktop context; skip mcp-servers branch',
    });
  }

  if (!isUnderCore && path.isAbsolute(filePath)) {
    return { classification: 'outside', displayLabel: 'Outside workspace' };
  }
  if (isUnderCore) {
    return { classification: 'workspace_root', displayLabel: 'Workspace root' };
  }
  return { classification: 'unknown', displayLabel: 'Not in a space' };
}
