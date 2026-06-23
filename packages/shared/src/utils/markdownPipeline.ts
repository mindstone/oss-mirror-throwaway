import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';

import { encodeSpacesInMarkdownLinks } from './markdownPreprocessors';

/**
 * Default remark plugins every Rebel markdown surface should use.
 */
export const DEFAULT_REMARK_PLUGINS: PluggableList = [remarkGfm];

/**
 * Options for `preprocessMarkdownForRender`.
 */
export interface PreprocessMarkdownOptions {
  /**
   * Additional remark plugins to append after the defaults. Renderer-only
   * callers that can import `remarkLibraryLinks` pass it here; web-companion
   * and changelog callers pass nothing. Order matters — defaults run first.
   */
  additionalPlugins?: PluggableList;
}

/**
 * Result returned by `preprocessMarkdownForRender`.
 */
export interface PreprocessMarkdownResult {
  /**
   * Source with pre-parse normalisations applied (for example, spaces encoded in
   * link and image destinations).
   */
  source: string;
  /**
   * Default + additional plugins merged for ReactMarkdown's `remarkPlugins`
   * prop.
   */
  remarkPlugins: PluggableList;
}

/**
 * Canonical Rebel markdown pre-render pipeline.
 *
 * Currently applies:
 * - `encodeSpacesInMarkdownLinks` — encodes spaces in link/image destinations
 *   so remark-parse accepts `![alt](my image.png)` syntax.
 *
 * Future markdown pre-render normalisations should be added here rather than in
 * individual callers.
 */
export function preprocessMarkdownForRender(
  raw: string,
  options?: PreprocessMarkdownOptions,
): PreprocessMarkdownResult {
  const source = encodeSpacesInMarkdownLinks(raw ?? '');
  const additional = options?.additionalPlugins ?? [];
  const remarkPlugins =
    additional.length === 0
      ? DEFAULT_REMARK_PLUGINS
      : [...DEFAULT_REMARK_PLUGINS, ...additional];

  return { source, remarkPlugins };
}
