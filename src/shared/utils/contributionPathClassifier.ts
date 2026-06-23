import path from 'pathe';

export type ContributionPathClass =
  | 'canonical'
  | 'connectors-repo'
  | 'non-canonical'
  | 'unknown';

export interface NonCanonicalPathTransitionError {
  reason: 'non-canonical-path';
  observedPath?: string;
  expectedPathPrefix?: string;
  guidance?: string;
}

const WINDOWS_ABSOLUTE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const CONNECTORS_SEGMENT_REGEX = /\/connectors\/([a-zA-Z0-9_.-]+)(?:\/|$)/;

function toPortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function inferHomePathFromEnv(): string | null {
  if (typeof process === 'undefined' || !process.env) return null;
  const candidate = process.env.HOME ?? process.env.USERPROFILE;
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  return toPortablePath(candidate.trim());
}

function isAbsolutePathLike(value: string): boolean {
  const portable = toPortablePath(value);
  return portable.startsWith('/') || portable.startsWith('//') || WINDOWS_ABSOLUTE_PATH_REGEX.test(value);
}

function normalizeAbsolutePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const expanded = expandLeadingTildePath(trimmed);
  const portable = toPortablePath(expanded);
  if (!isAbsolutePathLike(portable)) return null;

  if (/^[A-Za-z]:\//.test(portable)) {
    const drive = portable.slice(0, 2);
    const rest = portable.slice(2);
    const normalizedRest = path.posix.normalize(rest.startsWith('/') ? rest : `/${rest}`);
    return `${drive}${normalizedRest}`;
  }

  return path.posix.normalize(portable);
}

export function expandLeadingTildePath(
  value: string,
  homePath: string | null | undefined = inferHomePathFromEnv(),
): string {
  if (!value.startsWith('~/') && !value.startsWith('~\\')) {
    return value;
  }
  if (!homePath) return value;
  return `${toPortablePath(homePath).replace(/\/+$/, '')}/${value.slice(2)}`;
}

export function extractConnectorFromConnectorsSegment(
  resolvedPath: string,
): { connectorName: string; repoRoot: string } | null {
  const portable = toPortablePath(resolvedPath);
  const match = portable.match(CONNECTORS_SEGMENT_REGEX);
  if (!match) return null;

  const connectorName = match[1];
  const matchIndex = portable.indexOf(match[0]);
  const repoRoot = portable.slice(0, matchIndex);
  return { connectorName, repoRoot };
}

export function pathStartsUnderHomeMcpServers(
  candidatePath: string,
  homePath: string | null | undefined = inferHomePathFromEnv(),
): boolean {
  if (!homePath || !homePath.trim()) return false;
  const normalizedCandidate = toPortablePath(candidatePath).toLowerCase();
  const mcpServersPrefix = path.posix
    .join(toPortablePath(homePath), 'mcp-servers')
    .replace(/\\/g, '/')
    .toLowerCase();
  return normalizedCandidate.startsWith(`${mcpServersPrefix}/`);
}

export function classifyContributionPath(
  localServerPath: string | null | undefined,
): ContributionPathClass {
  if (typeof localServerPath !== 'string' || !localServerPath.trim()) {
    return 'unknown';
  }

  const resolvedPath = normalizeAbsolutePath(localServerPath);
  if (!resolvedPath) return 'unknown';

  if (extractConnectorFromConnectorsSegment(resolvedPath)) {
    return 'connectors-repo';
  }

  if (pathStartsUnderHomeMcpServers(resolvedPath)) {
    return 'canonical';
  }

  return 'non-canonical';
}

export function tryParseNonCanonicalError(
  raw: string | null | undefined,
): NonCanonicalPathTransitionError | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(trimmed) as Partial<NonCanonicalPathTransitionError>;
    if (!parsed || typeof parsed !== 'object' || parsed.reason !== 'non-canonical-path') {
      return null;
    }

    return {
      reason: 'non-canonical-path',
      ...(typeof parsed.observedPath === 'string' ? { observedPath: parsed.observedPath } : {}),
      ...(typeof parsed.expectedPathPrefix === 'string'
        ? { expectedPathPrefix: parsed.expectedPathPrefix }
        : {}),
      ...(typeof parsed.guidance === 'string' ? { guidance: parsed.guidance } : {}),
    };
  } catch {
    return null;
  }
}
