/**
 * Shared Nunjucks Configuration
 *
 * Single source of truth for the Nunjucks environment used by:
 * - promptTemplateService.ts (composite system prompt rendering)
 * - promptFileService.ts (externalized BTS prompt rendering)
 *
 * @see docs/plans/260406_prompt_externalization.md
 */

import nunjucks from 'nunjucks';

export const sharedNunjucksEnv = new nunjucks.Environment(null, {
  throwOnUndefined: true,
  autoescape: false,
  trimBlocks: true,
  lstripBlocks: true,
});
