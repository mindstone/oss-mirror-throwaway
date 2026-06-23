/**
 * Shared utilities for memory write approval explanations.
 */

/**
 * Get human-readable sharing label for explanation text.
 */
export function getSharingLabel(sharing: string | undefined): string {
  switch (sharing) {
    case 'restricted': return 'a small group';
    case 'company-wide': return 'the whole company';
    case 'public': return 'anyone';
    default: return 'others';
  }
}
