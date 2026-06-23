import { useLayoutEffect, type RefObject } from 'react';

/**
 * Auto-resize a `<textarea>` so it grows with its content instead of staying a
 * fixed single line. On every `value` change the textarea's height is
 * reconciled to its `scrollHeight`; the visual bounds (one-line floor, grow
 * cap, scroll-on-overflow) stay in CSS via `min-height` / `max-height` /
 * `overflow-y: auto` — so the cap lives in one place (the stylesheet) rather
 * than being duplicated as a JS magic number.
 *
 * This mirrors the in-conversation composer's auto-resize behaviour
 * (`ComposerWithState.tsx`) as a standalone, reusable primitive. It is wired
 * into the legacy `<textarea>` render path of `MentionHeroInput`; the TipTap
 * rich-editor path self-sizes via the editor's own CSS bounds and does not
 * need this hook.
 *
 * `useLayoutEffect` runs synchronously after the DOM mutation and before paint,
 * so the resize never flickers between the old and new height.
 *
 * `enabled` lets a caller that conditionally renders a real `<textarea>` skip
 * the resize when the ref currently points at something else (e.g. the
 * `MentionHeroInput` rich-editor path, where the shared ref holds a
 * textarea-shaped shim proxying to the editor DOM that already self-sizes).
 */
export function useAutoResizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  enabled = true,
): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    // Reset to `auto` first so the textarea can shrink as well as grow:
    // scrollHeight reflects the content's natural height once the explicit
    // height is cleared. CSS `max-height` then clamps the rendered height and
    // `overflow-y: auto` provides the scrollbar past the cap.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value, enabled]);
}
