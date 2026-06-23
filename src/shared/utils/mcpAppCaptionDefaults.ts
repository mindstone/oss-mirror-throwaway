import type { McpAppUiMeta } from '../types';

export const PERMISSION_NEEDED_COPY = 'Allow this view to read this conversation so it can stay in sync.';

export function getPrimaryMcpAppCaptionDefault(
  uiMeta?: Pick<McpAppUiMeta, 'structuredFallback'>,
): string | null {
  switch (uiMeta?.structuredFallback?.kind) {
    case 'email-draft':
      return 'Draft ready. Tweak before sending.';
    case 'calendar-pick':
      return 'Time options ready. Pick what works.';
    case 'document-outline':
      return 'Outline ready. The blank page has lost.';
    case 'plain':
      return 'View ready. Details below.';
    default:
      return null;
  }
}
