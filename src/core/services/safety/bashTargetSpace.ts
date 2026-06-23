import path from 'pathe';
import type { SpaceConfig } from '@shared/types';
import type { ActionContextSpaceSharingClass } from '@core/safetyPromptTypes';
import { matchPathToSpace } from '@core/services/spacePathMatcher';
import { toPortablePath } from '@core/utils/portablePath';

export interface SettingsSpaceCandidate {
  name: string;
  path: string;
  absolutePath: string;
  type: SpaceConfig['type'];
  sharing?: SpaceConfig['sharing'];
  sourcePath?: string;
  description?: string;
  isSymlink?: boolean;
}

export function normalizeSafetyPath(inputPath: string): string {
  const portable = toPortablePath(inputPath).replace(/\/+/g, '/');
  const normalized = path.posix.normalize(portable);
  if (normalized === '.') return '';
  return normalized
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

function normalizeSpacePath(inputPath: string): string {
  return normalizeSafetyPath(inputPath).replace(/^\/+/, '');
}

function pathEscapesWorkspace(workspacePath: string, absolutePath: string): boolean {
  const relativePath = toPortablePath(path.relative(workspacePath, absolutePath)).replace(/\/+/g, '/');
  return (
    relativePath === '..'
    || relativePath.startsWith('../')
    || path.isAbsolute(relativePath)
  );
}

export function buildSettingsSpaceCandidates(
  spaceConfigs: readonly SpaceConfig[] | undefined,
  coreDirectory: string | undefined,
): SettingsSpaceCandidate[] {
  if (!spaceConfigs || spaceConfigs.length === 0 || !coreDirectory) {
    return [];
  }

  return spaceConfigs.map((space) => {
    const normalizedPath = normalizeSpacePath(space.path);
    return {
      name: space.name,
      path: normalizedPath,
      absolutePath: path.join(coreDirectory, normalizedPath),
      type: space.type,
      sharing: space.sharing,
      sourcePath: space.sourcePath,
      description: space.description,
      isSymlink: space.isSymlink,
    };
  });
}

export function resolveSettingsSpaceForPath(
  filePath: string | undefined,
  spaces: readonly SettingsSpaceCandidate[],
  coreDirectory: string | undefined,
): SettingsSpaceCandidate | null {
  if (!filePath || spaces.length === 0 || !coreDirectory) {
    return null;
  }
  const normalizedWorkspacePath = normalizeSafetyPath(coreDirectory);
  const normalizedCandidatePath = normalizeSafetyPath(filePath);
  if (!normalizedWorkspacePath || !normalizedCandidatePath) {
    return null;
  }

  const resolvedAbsolutePath = path.isAbsolute(normalizedCandidatePath)
    ? normalizedCandidatePath
    : normalizeSafetyPath(path.resolve(normalizedWorkspacePath, normalizedCandidatePath));

  if (pathEscapesWorkspace(normalizedWorkspacePath, resolvedAbsolutePath)) {
    return null;
  }

  return matchPathToSpace(resolvedAbsolutePath, spaces, normalizedWorkspacePath);
}

export function normalizeSharingClass(sharing: string | undefined): ActionContextSpaceSharingClass {
  if (!sharing) return 'unknown';
  const normalized = sharing.trim().toLowerCase();
  if (normalized === 'private') return 'private';
  if (normalized === 'team' || normalized === 'restricted') return 'team';
  if (normalized === 'company-wide' || normalized === 'shared') return 'shared';
  if (normalized === 'public') return 'public';
  return 'unknown';
}

export function isPrivateOrChiefOfStaffSpace(space: SettingsSpaceCandidate): boolean {
  if (space.type === 'chief-of-staff') return true;
  return normalizeSharingClass(space.sharing) === 'private';
}

/**
 * Extract potential file write target paths from a Bash command.
 *
 * SINGLE SOURCE OF TRUTH for bash write-target enumeration across both safety
 * subsystems (tool-safety deterministic gates AND memory-write safety). Both
 * import this one function to keep command-coverage regexes from drifting apart
 * (see docs/plans/260614_investigate-bashwritetargets/PLAN.md).
 *
 * Returns RAW (un-normalized) target strings — `..`/`./`/`//`/trailing-`/` are
 * NOT collapsed. This is deliberate:
 *  - The audit log (BASH_WRITE_DETECTED) and approval-request destination show
 *    the path as the agent spelled it.
 *  - EVERY downstream security decision MUST canonicalize before deciding. Most
 *    do (`resolveSettingsSpaceForPath` / `matchPathToSpace` / `isProtectedSystemPath`
 *    all normalize). Guards that string-match a raw target before canonicalizing
 *    are a latent-evasion hazard — they MUST normalize the path themselves first
 *    (`normalizeSafetyPath` / `path.resolve`). See the memory-write guards in
 *    `memoryWriteHook.ts` (isMemoryPendingPath, detectPluginSourceFile,
 *    classifyUnmatchedPath, isInboxPath) which now do exactly that.
 *  - Callers that surface a single target string directly (not via a path
 *    matcher) must normalize at that point — see `extractDominantBashTargetPath`.
 */
export function extractBashWriteTargets(command: string): string[] | null {
  if (!command) return null;

  const targets: string[] = [];

  // Detect cd prefix for relative path resolution
  // e.g., "cd /some/path && cat > file.md" → prepend /some/path to relative targets
  const cdMatch = command.match(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*(?:&&|;)/);
  const cdPrefix = cdMatch?.[1] ?? cdMatch?.[2] ?? cdMatch?.[3] ?? null;

  const resolvePath = (target: string): string => {
    if (!target) return target;
    if (path.isAbsolute(target) || !cdPrefix) return target;
    return path.join(cdPrefix, target);
  };

  const redirectRegex = /(?:&>>|&>|>>|2>>|>\||2>|>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  for (const match of command.matchAll(redirectRegex)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target && target !== '>' && target !== '&') {
      targets.push(resolvePath(target));
    }
  }

  const teeMatch = command.match(/\btee\s+((?:(?:-[a-z]+\s+)?(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*)+)/i);
  if (teeMatch) {
    const teeArgRegex = /(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
    for (const argMatch of teeMatch[1].matchAll(teeArgRegex)) {
      const arg = argMatch[1] ?? argMatch[2] ?? argMatch[3];
      if (arg && !arg.startsWith('-')) {
        targets.push(resolvePath(arg));
      }
    }
  }

  const copyMatch = command.match(/\b(cp|mv|install|rsync)\s+(.+?)(?:$|[;&|])/);
  if (copyMatch) {
    const args: string[] = [];
    const argRegex = /(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
    for (const argMatch of copyMatch[2].trim().matchAll(argRegex)) {
      const arg = argMatch[1] ?? argMatch[2] ?? argMatch[3];
      if (arg && !arg.startsWith('-')) {
        args.push(arg);
      }
    }
    if (args.length > 0) {
      targets.push(resolvePath(args[args.length - 1]));
    }
  }

  const ddMatch = command.match(/\bdd\s+[^;&|]*\bof=(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (ddMatch) {
    const target = ddMatch[1] ?? ddMatch[2] ?? ddMatch[3];
    if (target) {
      targets.push(resolvePath(target));
    }
  }

  return targets.length > 0 ? targets : null;
}

function looksLikePathToken(token: string): boolean {
  if (!token) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  if (/^\w+@\w/.test(token)) return false;
  if (token === '-' || token.startsWith('-')) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  if (token.startsWith('./') || token.startsWith('../') || token.startsWith('~')) return true;
  return /\.[a-z0-9]{1,12}$/i.test(token);
}

function stripQuotes(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith('\'') && token.endsWith('\''))) {
    return token.slice(1, -1);
  }
  return token;
}

function extractReadPathFromCommandHeader(command: string): string | null {
  const firstLine = command.split('\n')[0] ?? '';
  const tokens = firstLine.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  for (let i = 1; i < tokens.length; i += 1) {
    const normalized = stripQuotes(tokens[i]);
    if (!looksLikePathToken(normalized)) continue;
    return normalized;
  }
  return null;
}

function extractQuotedPathFromCommandBody(command: string): string | null {
  const matches = command.matchAll(/["']([^"'\n]+)["']/g);
  for (const match of matches) {
    const candidate = (match[1] ?? '').trim();
    if (!looksLikePathToken(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Dominant Bash target for safety context:
 * 1) first confidently parsed write target
 * 2) first path-like token in command header
 * 3) first quoted path-like literal in command body (e.g., heredoc scripts)
 * 4) workspace root fallback
 */
export function extractDominantBashTargetPath(
  command: string | undefined,
  workspacePath: string | undefined,
): string | undefined {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return workspacePath ? normalizeSafetyPath(workspacePath) : workspacePath;
  }

  const writeTargets = extractBashWriteTargets(command);
  if (writeTargets && writeTargets.length > 0) {
    // extractBashWriteTargets returns RAW targets; this surface returns a single
    // target string directly (not via a path matcher), so canonicalize it here
    // to preserve the normalized output this function has always produced.
    return normalizeSafetyPath(writeTargets[0]);
  }

  const headerPath = extractReadPathFromCommandHeader(command);
  if (headerPath) {
    const normalizedHeaderPath = normalizeSafetyPath(headerPath);
    if (normalizedHeaderPath) return normalizedHeaderPath;
  }

  const bodyPath = extractQuotedPathFromCommandBody(command);
  if (bodyPath) {
    const normalizedBodyPath = normalizeSafetyPath(bodyPath);
    if (normalizedBodyPath) return normalizedBodyPath;
  }

  return workspacePath ? normalizeSafetyPath(workspacePath) : workspacePath;
}
