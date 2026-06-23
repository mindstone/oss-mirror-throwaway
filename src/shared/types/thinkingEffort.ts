/**
 * Reasoning/thinking effort level — leaf type module.
 *
 * Extracted from `settings.ts` so that this small shared type lives in a
 * dependency leaf and can't form an import cycle with its consumers.
 * `settings.ts` re-exports `ThinkingEffort` for back-compat, so existing
 * `import { ThinkingEffort } from '.../settings'` call sites are unaffected.
 */
export type ThinkingEffort = 'xhigh' | 'high' | 'medium' | 'low';
