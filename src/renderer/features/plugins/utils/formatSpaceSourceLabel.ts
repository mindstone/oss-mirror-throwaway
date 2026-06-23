/**
 * Render a short, human-friendly label for the Space that owns a plugin.
 *
 * Falls back to `'Unknown Space'` when the path is missing.
 *
 * @example
 *   formatSpaceSourceLabel('/Users/me/Spaces/Acme/Projects/Beta')
 *   // → 'Acme/Projects/Beta' is too long; we keep the last two segments.
 *   // → 'Projects/Beta'
 */
export function formatSpaceSourceLabel(spacePath?: string): string {
  if (!spacePath) {
    return 'Unknown Space';
  }

  const parts = spacePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }

  return parts[0] ?? 'Unknown Space';
}
