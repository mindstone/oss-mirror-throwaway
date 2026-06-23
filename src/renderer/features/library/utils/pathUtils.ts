import { getFileName, normalizePath } from '@renderer/utils/stringUtils';

export const normalizeLibraryPath = (value: string | null | undefined): string => {
  if (!value) return '';
  const normalized = normalizePath(value).trim();
  if (!normalized) return '';
  // normalizePath already converts backslashes and collapses multiple slashes
  const withoutTrailing = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  const finalValue = withoutTrailing || '/';
  if (finalValue === '/') {
    return '/';
  }
  if (/^[A-Za-z]:$/i.test(finalValue)) {
    return `${finalValue}/`;
  }
  return finalValue;
};

export const getParentDirectoryPath = (value: string, workspaceRootPath: string): string | null => {
  const normalized = normalizeLibraryPath(value);
  if (!normalized) {
    return workspaceRootPath || null;
  }
  if (!workspaceRootPath) {
    return normalized;
  }
  if (normalized === workspaceRootPath || normalized === '/') {
    return workspaceRootPath;
  }
  const base = normalized.endsWith('/') && normalized !== '/' ? normalized.slice(0, -1) : normalized;
  const lastSlash = base.lastIndexOf('/');
  if (lastSlash <= 0) {
    return workspaceRootPath;
  }
  const parent = base.slice(0, lastSlash);
  return parent || workspaceRootPath;
};

export const isDescendantPath = (candidate: string, ancestor: string): boolean => {
  const normalizedCandidate = normalizeLibraryPath(candidate);
  const normalizedAncestor = normalizeLibraryPath(ancestor);
  if (!normalizedCandidate || !normalizedAncestor) {
    return false;
  }
  if (normalizedCandidate === normalizedAncestor) {
    return true;
  }
  const ancestorPrefix = normalizedAncestor === '/' ? '/' : `${normalizedAncestor}/`;
  return normalizedCandidate.startsWith(ancestorPrefix);
};

export const getRelativeLibraryPath = (absolute: string, workspaceRootAbsolute?: string | null): string => {
  if (!absolute) {
    return '';
  }
  if (!workspaceRootAbsolute) {
    return getFileName(absolute);
  }
  const rootNormalized = normalizePath(workspaceRootAbsolute).replace(/\/+$/, '');
  const targetNormalized = normalizePath(absolute);
  const rootLower = rootNormalized.toLowerCase();
  const targetLower = targetNormalized.toLowerCase();
  if (targetLower.startsWith(rootLower)) {
    let relative = targetNormalized.slice(rootNormalized.length);
    if (relative.startsWith('/')) {
      relative = relative.slice(1);
    }
    return relative.length > 0 ? relative : getFileName(absolute);
  }
  return getFileName(absolute);
};

/**
 * Determine if a memory path is in a shared (work) space or private space.
 * Handles both relative paths ("work/...") and absolute paths ("/Users/.../work/...").
 * - Contains "/work/" or starts with "work/" → 'shared'
 * - Everything else → 'private'
 */
export const getSpaceVisibility = (filePath: string | undefined): 'private' | 'shared' => {
  if (!filePath) return 'private';
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  // Check for work/ at start (relative) or /work/ anywhere (absolute paths)
  if (normalized.startsWith('work/') || normalized.includes('/work/')) {
    return 'shared';
  }
  return 'private';
};

/**
 * Derive a display-friendly space name from a file path.
 * Handles both workspace-relative paths and absolute paths (backwards compatibility).
 * - "work/Acme/Sales/..." → "Acme / Sales"
 * - "/Users/.../work/Acme/Sales/..." → "Acme / Sales"
 * - "Chief-of-Staff/..." → "Private Space"
 * - "/Users/.../Chief-of-Staff/..." → "Private Space"
 * - "SomeSpace/..." → "SomeSpace"
 */
export const getSpaceDisplayName = (filePath: string | undefined): string => {
  if (!filePath) return 'Unknown';

  const normalized = filePath.replace(/\\/g, '/');

  // Handle work/Company/Space pattern - check both relative and absolute paths
  // Relative: work/Company/Space/...
  const workMatchRelative = normalized.match(/^work\/([^/]+)\/([^/]+)\//i);
  if (workMatchRelative) {
    return `${workMatchRelative[1]} / ${workMatchRelative[2]}`;
  }
  // Absolute: .../work/Company/Space/...
  const workMatchAbsolute = normalized.match(/\/work\/([^/]+)\/([^/]+)\//i);
  if (workMatchAbsolute) {
    return `${workMatchAbsolute[1]} / ${workMatchAbsolute[2]}`;
  }

  // Handle known root-level spaces - check both relative and absolute paths
  const normalizedLower = normalized.toLowerCase();

  // Chief-of-Staff → "Private Space" (user-facing display name)
  if (normalizedLower.startsWith('chief-of-staff/') || /\/chief-of-staff\//i.test(normalized)) {
    return 'Private Space';
  }

  // Personal space
  if (normalizedLower.startsWith('personal/') || /\/personal\//i.test(normalized)) {
    return 'Personal';
  }

  // Fallback: Any root-level space for relative paths: SomeName/...
  const rootMatch = normalized.match(/^([^/]+)\//);
  if (rootMatch && !rootMatch[1].includes('.') && !rootMatch[1].startsWith('.')) {
    return rootMatch[1];
  }

  return 'Unknown';
};
