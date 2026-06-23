/**
 * Shared document utilities for file categorization, privacy detection, and content processing.
 * Re-exported from @rebel/shared to keep existing desktop consumers stable during the refactor.
 */

// Re-export from @rebel/shared to avoid touching 13 consumer files in this PR.
export * from '@rebel/shared/utils/fileCategories';
export * from '@rebel/shared/utils/markdownPreprocessors';
export * from '@rebel/shared/utils/libraryUrls';

// Legacy aliases for existing desktop consumers (follow-up PR can rename call sites).
export { getFilePreviewCategory as getFileCategory } from '@rebel/shared';
export type { FilePreviewCategory as FileCategory } from '@rebel/shared';

/**
 * Decode HTML entities in markdown content for TipTap rendering.
 * Desktop-only: keeps the DOM textarea fast-path used by TipTap consumers.
 *
 * The @tiptap/markdown extension uses `marked` to tokenize markdown, but `marked`
 * preserves HTML entities (like `&nbsp;`, `&amp;`, `&#39;`) as literal text in tokens.
 * When TipTap creates ProseMirror text nodes from these tokens, the entities appear as
 * visible literal text (e.g. the user sees "&nbsp;" instead of a space).
 *
 * This function decodes HTML entities in markdown text while preserving code blocks
 * and inline code spans, where entities should remain as literal text.
 *
 * Stage 9 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` — this is
 * the **library editor's input-side workaround** for the same upstream
 * `&nbsp;` / HTML-entity round-trip issue. The composer uses an orthogonal
 * **output-side** fix (node-level `renderMarkdown` overrides on
 * `PromptDocument` / `PromptParagraph` / `PromptHardBreak`, the
 * `sanitiseCorruptedDraftText` pure function inside `markdownToDoc`, and the
 * branded `ComposerWireMarkdown` type) so the composer's wire format never
 * emits `&nbsp;` in the first place. The two fix surfaces are independent:
 * neither replaces the other and neither propagates between editors. See
 * also `src/renderer/features/library/components/TipTapMarkdownEditor.tsx`
 * for the library editor's consumer path.
 *
 * @param markdown - The markdown content to process
 * @returns Markdown with HTML entities decoded (except inside code)
 */
export const decodeHtmlEntitiesInMarkdown = (markdown: string): string => {
  if (!markdown) return markdown;

  if (!markdown.includes('&')) return markdown;

  const segments = markdown.split(/(```[\s\S]*?```|``[^`]+``|`[^`\n]+`)/g);

  return segments
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return decodeHtmlEntities(segment);
    })
    .join('');
};

function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;

  let decoded: string;

  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    decoded = textarea.value;
  } else {
    decoded = text
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, '\u00a0')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
  }

  return decoded
    .replace(/&nbsp;/gi, '\u00a0')
    .replace(/&#160;/g, '\u00a0')
    .replace(/&#xA0;/gi, '\u00a0');
}
