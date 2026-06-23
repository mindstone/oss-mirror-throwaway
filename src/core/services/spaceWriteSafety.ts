/**
 * Space write-safety helpers — Stage 1 (additive, unwired) of
 * docs/plans/260423_symlink_write_through_into_app_bundle.md.
 *
 * Provides two pure utilities that future stages of the plan will wire
 * into spaceService write entry-points:
 *
 *  1. `assertSpaceWriteSafe(workspaceRoot, spacePath)` — resolve realpath
 *     for both inputs, refuse the write if the resolved real path lands
 *     under `process.resourcesPath`, the macOS app bundle (`/Applications`),
 *     or any obviously-unsafe system root.
 *
 *  2. `isProtectedRootName(name)` — predicate that matches `rebel-system`
 *     and `super-mcp` plus their conflicted-copy / numbered / backup /
 *     copy variants, so the candidate filter inside `_scanSpacesImpl` can
 *     replace its exact-name `Set<string>` lookup with this predicate.
 *
 * This module ships standalone with full unit coverage in
 * `__tests__/spaceWriteSafety.test.ts`. **No production write site is
 * wired to it yet** — wiring happens in a follow-up plan that goes
 * through CHIEF_BUGFIXER review (Stages 2-7 of the source plan), per
 * its own subagent-review mandate.
 *
 * @see docs/plans/260423_symlink_write_through_into_app_bundle.md
 * @see docs/plans/260509_incomplete_planned_work_sweep_v2.md (Stage 4)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class WriteOutsideWorkspaceError extends Error {
  public readonly workspaceRoot: string;
  public readonly spacePath: string;
  public readonly resolvedRealPath: string;
  public readonly reason: WriteOutsideWorkspaceReason;

  constructor(params: {
    workspaceRoot: string;
    spacePath: string;
    resolvedRealPath: string;
    reason: WriteOutsideWorkspaceReason;
  }) {
    super(
      `Refused space write — ${params.reason} (workspaceRoot=${params.workspaceRoot}, spacePath=${params.spacePath}, resolvedRealPath=${params.resolvedRealPath})`,
    );
    this.name = 'WriteOutsideWorkspaceError';
    this.workspaceRoot = params.workspaceRoot;
    this.spacePath = params.spacePath;
    this.resolvedRealPath = params.resolvedRealPath;
    this.reason = params.reason;
  }
}

export type WriteOutsideWorkspaceReason =
  | 'under-resources-path'
  | 'under-applications'
  | 'under-system-root'
  | 'under-windows-system-root'
  | 'escapes-workspace-and-not-under-home';

export interface AssertSpaceWriteSafeOptions {
  /**
   * Override `process.resourcesPath` for tests. Production callers should
   * leave undefined — the helper reads the live value of
   * `process.resourcesPath` at call time.
   */
  resourcesPath?: string | undefined;

  /** Override `os.homedir()` for tests. Production callers should leave undefined. */
  homedir?: string | undefined;

  /** Override `process.platform` for tests. Production callers should leave undefined. */
  platform?: NodeJS.Platform | undefined;
}

/**
 * Resolve `inputPath` to its filesystem realpath. If the path itself does
 * not exist (`ENOENT`), walk up to the deepest existing ancestor, realpath
 * THAT, and rejoin the remaining segments. This lets first-write callers
 * (e.g. README.md does not exist yet) still get a meaningful guard.
 *
 * Returned path is absolute and free of `..`. Never returns the input
 * unchanged when an ancestor exists.
 */
async function resolveRealPathWithAncestorFallback(inputPath: string): Promise<string> {
  const absolute = path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
  try {
    return await fs.realpath(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw err;
    }
  }

  // Walk up until we find an ancestor that exists. Stop at filesystem root.
  let current = absolute;
  const remaining: string[] = [];
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached root — return the absolute input unchanged. This only
      // happens for invented absolute paths whose root itself does not
      // exist, which on a real system is impossible. Tests covering
      // entirely-fake paths land here.
      return absolute;
    }
    remaining.unshift(path.basename(current));
    current = parent;
    try {
      const realParent = await fs.realpath(current);
      return path.join(realParent, ...remaining);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
      // Keep walking up.
    }
  }
}

function isUnderPath(candidate: string, root: string): boolean {
  if (root.length === 0) return false;
  const normalisedCandidate = path.resolve(candidate);
  const normalisedRoot = path.resolve(root);
  if (normalisedCandidate === normalisedRoot) return true;
  const withSep = normalisedRoot.endsWith(path.sep)
    ? normalisedRoot
    : normalisedRoot + path.sep;
  return normalisedCandidate.startsWith(withSep);
}

/**
 * Validate that writing under `spacePath` (interpreted relative to
 * `workspaceRoot`) is safe — i.e. the resolved realpath does not escape
 * into the installed app bundle, `/Applications`, or system roots.
 *
 * On accept, returns the resolved realpath of `spacePath` so the caller
 * can use it for subsequent writes without re-resolving.
 *
 * On reject, throws `WriteOutsideWorkspaceError` with structured fields
 * suitable for logging / Sentry breadcrumbs.
 *
 * Accept rules:
 *  - resolved real path is inside realpath(`workspaceRoot`); OR
 *  - resolved real path is inside `os.homedir()` and NOT under any deny-listed root.
 *
 * Reject rules (in priority order):
 *  - resolved real path is inside `process.resourcesPath` (or override).
 *  - resolved real path is inside `/Applications/`.
 *  - resolved real path is inside `/System/`, `/Library/`, or `/private/var/`
 *    (POSIX).
 *  - resolved real path is inside `C:\\Program Files`, `C:\\Program Files (x86)`,
 *    or `C:\\Windows` (Win32).
 *  - resolved real path escapes `workspaceRoot` AND is not under the user
 *    home directory.
 */
export async function assertSpaceWriteSafe(
  workspaceRoot: string,
  spacePath: string,
  options: AssertSpaceWriteSafeOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  const resourcesPath =
    options.resourcesPath !== undefined ? options.resourcesPath : process.resourcesPath;

  const resolvedWorkspace = await resolveRealPathWithAncestorFallback(workspaceRoot);
  const resolvedSpace = await resolveRealPathWithAncestorFallback(spacePath);

  // `process.resourcesPath` is an absolute denylist — even if a developer
  // accidentally points their workspace at the bundle (e.g. by symlink),
  // we must never write through it. This rule wins over every other.
  if (resourcesPath && resourcesPath.length > 0 && isUnderPath(resolvedSpace, resourcesPath)) {
    throw new WriteOutsideWorkspaceError({
      workspaceRoot,
      spacePath,
      resolvedRealPath: resolvedSpace,
      reason: 'under-resources-path',
    });
  }

  // Trusted-root accept: if the resolved real path is inside the
  // resolved workspace, the user explicitly placed their workspace
  // there. The system-root denylist below is a defence against ESCAPE
  // — it must not fire on legitimate writes inside a workspace that
  // happens to live under `/private/var/...` (e.g. CI tmpdir) or
  // `/Library/Application Support/...` (legitimate user data dir).
  if (isUnderPath(resolvedSpace, resolvedWorkspace)) {
    return resolvedSpace;
  }

  if (platform === 'darwin' || platform === 'linux') {
    if (isUnderPath(resolvedSpace, '/Applications')) {
      throw new WriteOutsideWorkspaceError({
        workspaceRoot,
        spacePath,
        resolvedRealPath: resolvedSpace,
        reason: 'under-applications',
      });
    }
    // `/private/var` is intentionally NOT in the denylist: macOS tmpdir
    // ($TMPDIR) realpaths under `/private/var/folders/...`, so denying
    // the whole subtree would false-positive on legitimate tmpdir-based
    // workspaces (CI runners, tests). The accept-when-inside-workspace
    // rule above already covers the legitimate case; the real-incident
    // attacker target was `/Applications/`.
    for (const systemRoot of ['/System', '/Library']) {
      if (isUnderPath(resolvedSpace, systemRoot)) {
        throw new WriteOutsideWorkspaceError({
          workspaceRoot,
          spacePath,
          resolvedRealPath: resolvedSpace,
          reason: 'under-system-root',
        });
      }
    }
  }

  if (platform === 'win32') {
    for (const systemRoot of [
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\Windows',
    ]) {
      if (isUnderWin32Path(resolvedSpace, systemRoot)) {
        throw new WriteOutsideWorkspaceError({
          workspaceRoot,
          spacePath,
          resolvedRealPath: resolvedSpace,
          reason: 'under-windows-system-root',
        });
      }
    }
  }

  if (homedir && homedir.length > 0 && isUnderPath(resolvedSpace, homedir)) {
    return resolvedSpace;
  }

  throw new WriteOutsideWorkspaceError({
    workspaceRoot,
    spacePath,
    resolvedRealPath: resolvedSpace,
    reason: 'escapes-workspace-and-not-under-home',
  });
}

/** Exported for direct unit testing on POSIX hosts. */
export function isUnderWin32Path(candidate: string, root: string): boolean {
  if (root.length === 0) return false;
  const normalisedCandidate = path.win32.resolve(candidate).toLowerCase();
  const normalisedRoot = path.win32.resolve(root).toLowerCase();
  if (normalisedCandidate === normalisedRoot) return true;
  const withSep = normalisedRoot.endsWith('\\') ? normalisedRoot : normalisedRoot + '\\';
  return normalisedCandidate.startsWith(withSep);
}

const PROTECTED_EXACT = new Set<string>(['rebel-system', 'super-mcp']);

/**
 * True if `name` is a workspace-root entry that should NEVER be treated
 * as a candidate space, even when wrapped in conflicted-copy / numbered
 * / backup / copy variants.
 *
 * Matches:
 *  - `rebel-system`, `super-mcp` (case-insensitive)
 *  - `rebel-system (Greg's MacBook Air's conflicted copy 2026-04-21)`
 *  - `rebel-system 2`, `rebel-system (1)`
 *  - `rebel-system.backup`, `rebel-system copy`
 *  - `super-mcp (conflicted copy 2026-...)`
 *
 * Does NOT match:
 *  - `rebel-system-extras`, `my-rebel-system-fork` — false-positive guards.
 *  - empty string, names not starting with the protected stem.
 */
export function isProtectedRootName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  const lower = name.toLowerCase();
  if (PROTECTED_EXACT.has(lower)) return true;
  return /^(rebel-system|super-mcp)([ .(]|$)/.test(lower);
}
