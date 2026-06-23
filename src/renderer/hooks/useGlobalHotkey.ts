import type { DependencyList } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import type { HotkeyCallback, Keys } from 'react-hotkeys-hook';
// This file is the only allowed consumer of the `useHotkeys` named export from
// `react-hotkeys-hook`. An ESLint `no-restricted-imports` rule enforces this
// (see `eslint.config.mjs`); the rule's renderer-scoped `ignores` list
// exempts this single file rather than relying on per-line `eslint-disable`.

/**
 * Canonical options for a global app keyboard shortcut.
 *
 * Critical: react-hotkeys-hook v5 treats `enableOnFormTags` and
 * `enableOnContentEditable` as INDEPENDENT gates. Without
 * `enableOnContentEditable: true`, the library suppresses the handler whenever
 * focus is inside a contenteditable surface — and Rebel's main composer is now
 * a TipTap-rendered <div contenteditable> (and so is the document editor). The
 * 2026-04-29 TipTap composer rollout silently broke six shortcuts because the
 * call sites only set `enableOnFormTags: true`. The wrapper exists to make
 * "global app shortcut" mean the same thing at every call site.
 *
 * See `docs/project/KEYBOARD_SHORTCUTS.md`.
 */
const GLOBAL_HOTKEY_OPTIONS = {
  preventDefault: true,
  enableOnFormTags: true,
  enableOnContentEditable: true,
} as const;

/**
 * Register a global app keyboard shortcut.
 *
 * Fires from anywhere in the renderer, including <input>/<textarea>/<select>
 * (form tags) AND contenteditable surfaces (TipTap composer, document editor).
 *
 * `deps` is required (no default) — react-hotkeys-hook v5 keeps the callback
 * ref fresh when deps are omitted entirely, but defaulting to `[]` here would
 * silently freeze the first-render closure. Force callers to think.
 *
 * For context-specific shortcuts that should be inert in editable surfaces
 * (e.g., the inbox keyboard shortcuts), use a native `addEventListener` with
 * an editable-element guard instead of bare `useHotkeys` from
 * `react-hotkeys-hook`. Direct `useHotkeys` use is banned by ESLint.
 */
export function useGlobalHotkey(
  keys: Keys,
  callback: HotkeyCallback,
  deps: DependencyList,
): void {
  useHotkeys(keys, callback, GLOBAL_HOTKEY_OPTIONS, deps);
}
