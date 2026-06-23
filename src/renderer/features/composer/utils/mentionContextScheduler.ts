/**
 * Parent-layer mention-context scheduler — Stage 4 of
 * `docs/plans/260501_composer_tiptap_atmention_bugfix.md` (H8 ownership fix).
 *
 * The legacy textarea path debounced `updateMentionContext` directly inside
 * `MentionHeroInput.handleChange` (250ms); the rich-input path through
 * `ComposerWithState`'s `handleTextPromptValue` and `refreshMentionFromInput`
 * had ZERO debounce, so every keystroke + every selection-only transaction
 * fired a fresh picker re-query.
 *
 * Stage 4 moves the debounce ownership to a single shared scheduler at the
 * parent callback layer. One timer covers BOTH `handleTextPromptValue` and
 * `refreshMentionFromInput` — `cancel-and-reschedule-on-each-call` semantics
 * mean the latest schedule wins, eliminating duplicate work per transaction.
 *
 * Behaviour matrix (the 6 Stage 4 contract rows):
 *
 *  1. Caret-on-resolved-chip → suppressed (no fire). FMM Row 27.
 *  2. IME composing → deferred; `flushDeferred()` re-attempts after the
 *     compositionend listener (registered in `TipTapPromptEditor`) fires.
 *  3. Picker closed AND fresh `@` trigger at caret → fired immediately
 *     (no perceptible lag on the keystroke that introduces `@`).
 *  4. Otherwise → debounced via setTimeout (latest schedule wins).
 *  5. 50 fast keystrokes coalesce to ≤ 5 fires (the H8 quantitative DoD).
 *  6. The fired callback re-reads editor state at fire time via the
 *     captured (value, caret) of the LATEST schedule call — the cancel-and-
 *     reschedule semantics already deliver fire-time freshness.
 *
 * The factory takes pure dependencies (no React) so it is unit-testable
 * with vitest fake timers + an injected `isComposing` flag (vitest cannot
 * mock `editor.view.composing` directly because it's a getter on
 * `view.input`). Production wires real `editor.view.composing`.
 *
 * See the plan's Stage 4 section for the full DoD list and the integration
 * spike (`__tests__/integration-spike.spike.test.ts`, Section 3) for the
 * spike-validated contracts.
 */

import type { Editor } from '@tiptap/core';
import { MENTION_DEBOUNCE_MS } from '../hooks/useMentionAutocomplete';

export { MENTION_DEBOUNCE_MS };

export interface MentionContextSchedulerDeps {
  /**
   * Fires the actual update — typically forwards `(value, caret)` to
   * `updateMentionContext`. The scheduler invokes this either synchronously
   * (first-`@` fast-path) or asynchronously (after the debounce window).
   */
  onFire: (value: string, caret: number) => void;
  /** Returns whether the picker is currently open (controls the first-`@` fast-path). */
  isPickerOpen: () => boolean;
  /** Returns the rich editor handle when present; `null` for the legacy textarea path. */
  getEditor: () => Editor | null;
  /**
   * IME-state probe. Defaults to reading `editor.view.composing`; tests
   * inject a controllable flag because the production getter cannot be
   * mocked easily.
   */
  isComposing?: (editor: Editor) => boolean;
  /**
   * Returns true when the caret sits on / adjacent to a resolved mention
   * chip atom (FMM Row 27). When true, scheduling is suppressed so the
   * picker does not re-open for an already-resolved mention.
   */
  isCaretOnChip?: (editor: Editor) => boolean;
  /**
   * Returns true when (value, caret) represents a freshly-introduced `@`
   * trigger at the caret. Used to fire the picker immediately on the
   * keystroke that introduces `@`, before debounce kicks in.
   */
  detectFreshTrigger: (value: string, caret: number) => boolean;
  /** Debounce interval; defaults to MENTION_DEBOUNCE_MS (250ms). */
  debounceMs?: number;
}

export interface MentionContextScheduler {
  /**
   * Schedule a mention-context update for `(value, caret)`. Behaviour matrix
   * is documented at the top of this module.
   */
  schedule(value: string, caret: number): void;
  /**
   * Re-attempt the deferred schedule after IME composition ends. Wired to
   * the `compositionend` listener on `editor.view.dom` registered in
   * `TipTapPromptEditor`.
   */
  flushDeferred(): void;
  /**
   * Cancel any pending timer + deferred state. Call from the legacy short-
   * circuit when the value no longer contains `@` (the picker should clear
   * synchronously without waiting for debounce) and from the unmount cleanup.
   */
  cancel(): void;
}

export function createMentionContextScheduler(
  deps: MentionContextSchedulerDeps,
): MentionContextScheduler {
  const debounceMs = deps.debounceMs ?? MENTION_DEBOUNCE_MS;
  const isComposing = deps.isComposing ?? ((ed: Editor) => ed.view.composing);
  const isCaretOnChip = deps.isCaretOnChip ?? (() => false);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: string; caret: number } | null = null;

  function clearTimer(): void {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function fireAtTime(): void {
    timer = null;
    const p = pending;
    pending = null;
    if (!p) return;
    const ed = deps.getEditor();
    // Guard re-checks at fire time so a chip insertion / IME start that
    // happened between schedule and fire still suppresses the update.
    if (ed && isCaretOnChip(ed)) return;
    if (ed && isComposing(ed)) {
      // Re-stash; the compositionend listener will flushDeferred().
      pending = p;
      return;
    }
    deps.onFire(p.value, p.caret);
  }

  function schedule(value: string, caret: number): void {
    const ed = deps.getEditor();
    // FMM Row 27: caret on chip → suppress entirely.
    if (ed && isCaretOnChip(ed)) {
      clearTimer();
      pending = null;
      return;
    }
    // IME guard: defer; compositionend will flush.
    if (ed && isComposing(ed)) {
      clearTimer();
      pending = { value, caret };
      return;
    }
    // First-`@` fast-path: picker closed and a fresh trigger landed →
    // fire immediately so the picker feels responsive on the keystroke.
    if (!deps.isPickerOpen() && deps.detectFreshTrigger(value, caret)) {
      clearTimer();
      pending = null;
      deps.onFire(value, caret);
      return;
    }
    // Otherwise: debounce; the latest schedule wins (cancel-and-reschedule).
    clearTimer();
    pending = { value, caret };
    timer = setTimeout(fireAtTime, debounceMs);
  }

  function flushDeferred(): void {
    const p = pending;
    if (!p) return;
    pending = null;
    schedule(p.value, p.caret);
  }

  function cancel(): void {
    clearTimer();
    pending = null;
  }

  return { schedule, flushDeferred, cancel };
}
