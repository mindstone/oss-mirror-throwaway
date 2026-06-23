import { useCallback, useState, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import type { UnifiedMentionResult, MentionFilterType } from '@renderer/features/mentions';
import { parseMentionQuery } from '@renderer/features/mentions';

const MENTION_TRIGGER_REGEX = /(^|[\s\(\[\{'"`])@([^\s@]*)$/;

/**
 * Stage 4 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` — H8 fix.
 * Module-level export so both the parent-layer scheduler in
 * `ComposerWithState` (and `MentionHeroInput` once Stage 5 lands) and tests
 * reference a single source of truth for the debounce window. Tuned to match
 * the legacy textarea path's 250ms.
 */
export const MENTION_DEBOUNCE_MS = 250;

/**
 * Stage 4 (post-spike Opus-Medium amendment) — FMM Row 27. Returns true when
 * the caret sits on or immediately adjacent to a resolved mention chip atom
 * (a `mention` node from `MentionNode.tsx`). The parent-layer scheduler uses
 * this to suppress mention-context updates so a click adjacent to a chip
 * does NOT re-open the picker for an already-resolved mention.
 *
 * Implementation: ProseMirror represents inline atoms as a single position;
 * the caret can sit "before" or "after" the atom. We probe both
 * `doc.nodeAt(selection.from)` and `doc.nodeAt(selection.from - 1)` so either
 * side detects the chip.
 *
 * Used by the parent-layer scheduler before scheduling the picker update.
 * String-based `findMentionTrigger` cannot see node atoms, so this editor-
 * aware check lives at the parent boundary.
 */
export function isCaretOnMentionChip(editor: Editor): boolean {
  const { selection, doc } = editor.state;
  const from = selection.from;
  const nodeAtCaret = from < doc.content.size ? doc.nodeAt(from) : null;
  const nodeBeforeCaret = from > 0 ? doc.nodeAt(Math.max(0, from - 1)) : null;
  return (
    nodeAtCaret?.type.name === 'mention' || nodeBeforeCaret?.type.name === 'mention'
  );
}

export type MentionState = {
  active: boolean;
  startIndex: number;
  endIndex: number;
  /** The raw query including any prefix (used for display/debugging) */
  rawQuery: string;
  /** The parsed query with prefix stripped (used for search) */
  query: string;
  /** The current filter type (derived from prefix or manual tab selection) */
  filter: MentionFilterType;
  /** Whether the filter was set by an explicit prefix (e.g., @skill:) */
  hasExplicitPrefix: boolean;
  results: UnifiedMentionResult[];
  selectedIndex: number;
};

const DEFAULT_MENTION_STATE: MentionState = {
  active: false,
  startIndex: -1,
  endIndex: -1,
  rawQuery: '',
  query: '',
  filter: 'all',
  hasExplicitPrefix: false,
  results: [],
  selectedIndex: 0
};

/**
 * Result of finding a mention trigger in text.
 */
interface MentionTriggerResult {
  /** Position of @ symbol in the text */
  startIndex: number;
  /** Raw query after @ (includes any prefix like "skill:") */
  rawQuery: string;
  /** Parsed query with prefix stripped (for search) */
  query: string;
  /** Filter type derived from prefix */
  filter: MentionFilterType;
  /** Whether an explicit prefix was present */
  hasExplicitPrefix: boolean;
}

/**
 * Finds a mention trigger (@) in the text at the given caret position.
 *
 * Key behavior:
 * - `startIndex` is calculated from the raw query length (including prefix)
 *   to ensure correct text replacement during mention insertion
 * - The parsed `query` has the prefix stripped for search purposes
 *
 * @param value - The full text value
 * @param caret - Current cursor position
 * @returns Trigger result or null if no mention trigger found
 */
const findMentionTrigger = (
  value: string,
  caret: number
): MentionTriggerResult | null => {
  const snippet = value.slice(0, caret);
  const match = snippet.match(MENTION_TRIGGER_REGEX);
  if (!match) {
    return null;
  }
  const rawQuery = match[2] ?? '';

  // Don't trigger mention popover for completed backtick-quoted mentions like @`path/to/file`
  // A completed mention has both opening and closing backticks
  if (rawQuery.startsWith('`') && rawQuery.endsWith('`') && rawQuery.length > 1) {
    return null;
  }

  // startIndex must be based on raw query length (including prefix) for correct insertion
  const startIndex = caret - rawQuery.length - 1;

  // Parse the query to extract filter and stripped query
  const parsed = parseMentionQuery(rawQuery);

  return {
    startIndex,
    rawQuery,
    query: parsed.query,
    filter: parsed.filter,
    hasExplicitPrefix: parsed.hasExplicitPrefix,
  };
};

type UseMentionAutocompleteOptions = {
  isTextMode: boolean;
  hasWorkspace: boolean;
  setTextPrompt: (updater: (prev: string) => string) => void;
  commandInputRef: RefObject<HTMLTextAreaElement | null>;
  mentionCaretRef: RefObject<number | null>;
  mentionResultsForQuery: (query: string, filter?: MentionFilterType) => UnifiedMentionResult[];
  ensureLibraryIndex: () => void;
  getRelativeLibraryPath: (absolutePath: string) => string;
  /** Whether conversation history is available for mentions */
  hasConversations?: boolean;
  /** Whether model profiles are available for mentions */
  hasModels?: boolean;
  /** Whether Operator mentions are available */
  hasOperators?: boolean;
  /** Called when the @mention popover opens (caller guards first-time logic). */
  onMentionPopoverOpened?: () => void;
  /**
   * Optional adapter for the rich-input code path (Stage 1+ of
   * `docs/plans/260429_composer_rich_chips_input.md`). When provided and it returns `true`, the
   * hook treats the insert as consumed and skips the legacy `setTextPrompt` path. Receives the
   * picked result plus the markdown range of the `@…` trigger so the editor can splice it out
   * before inserting a chip atom. When omitted (legacy textarea path), behaviour is unchanged.
   */
  insertMention?: (
    result: UnifiedMentionResult,
    range: { startIndex: number; endIndex: number },
  ) => boolean;
};

type UseMentionAutocompleteResult = {
  mentionState: MentionState;
  updateMentionContext: (value: string, caretPosition: number | null) => void;
  insertMentionResult: (result: UnifiedMentionResult) => void;
  navigateMentionUp: () => void;
  navigateMentionDown: () => void;
  selectCurrentMention: () => boolean;
  clearMentionState: () => void;
  setSelectedIndex: (index: number) => void;
  /**
   * Set the manual filter for tab-based filtering.
   * Only takes effect when there's no explicit prefix (e.g., @skill:).
   * When prefix is present, filter is derived from prefix.
   */
  setManualFilter: (filter: MentionFilterType) => void;
};

export const useMentionAutocomplete = ({
  isTextMode,
  hasWorkspace,
  setTextPrompt,
  commandInputRef,
  mentionCaretRef,
  mentionResultsForQuery,
  ensureLibraryIndex,
  getRelativeLibraryPath,
  hasConversations = true,
  hasModels = false,
  hasOperators = false,
  onMentionPopoverOpened,
  insertMention,
}: UseMentionAutocompleteOptions): UseMentionAutocompleteResult => {
  const [mentionState, setMentionState] = useState<MentionState>(DEFAULT_MENTION_STATE);
  /**
   * Manual filter set by tab clicks.
   * This is separate from parsedFilter (from prefix) because:
   * - When prefix present: parsedFilter takes precedence
   * - When no prefix: manualFilter is used
   * - When mention closes: manualFilter resets to 'all'
   */
  const [manualFilter, setManualFilterState] = useState<MentionFilterType>('all');

  const updateMentionContext = useCallback(
    (value: string, caretPosition: number | null) => {
      // Allow mentions if we have workspace, conversations, models, or Operators
      if (!isTextMode || (!hasWorkspace && !hasConversations && !hasModels && !hasOperators)) {
        if (mentionState.active) {
          setMentionState(DEFAULT_MENTION_STATE);
          setManualFilterState('all'); // Reset manual filter when popover closes
        }
        return;
      }

      const caret = typeof caretPosition === 'number' ? caretPosition : value.length;
      const trigger = findMentionTrigger(value, caret);

      if (!trigger) {
        if (mentionState.active) {
          setMentionState(DEFAULT_MENTION_STATE);
          setManualFilterState('all'); // Reset manual filter when popover closes
        }
        return;
      }

      // Fire when a new mention interaction begins (popover opens).
      if (!mentionState.active) {
        onMentionPopoverOpened?.();
      }

      // Effective filter: prefix takes precedence over manual tab selection
      // When user types @skill:foo, use 'skills' filter regardless of tab state
      // When user types plain @foo, use manualFilter (set by tab clicks)
      const effectiveFilter = trigger.hasExplicitPrefix ? trigger.filter : manualFilter;

      // If the query AND effective filter haven't changed and we're already active, skip the update entirely.
      // This prevents unnecessary re-renders during arrow key navigation.
      // Note: Must check both query AND filter - user may change prefix without changing query
      // (e.g., @s:foo -> @c:foo keeps query "foo" but changes filter)
      if (mentionState.active && mentionState.query === trigger.query && mentionState.filter === effectiveFilter) {
        return;
      }

      // Only ensure library index if filter might need file results
      if (effectiveFilter === 'all' || effectiveFilter === 'skills' || effectiveFilter === 'memory') {
        ensureLibraryIndex();
      }
      const results = mentionResultsForQuery(trigger.query, effectiveFilter);

      setMentionState((prev) => {
        // Preserve selectedIndex if the query hasn't changed (e.g., during arrow key navigation)
        // Reset to 0 only when the query changes or when starting a new mention
        const queryChanged = prev.query !== trigger.query;
        const newSelectedIndex = queryChanged ? 0 : Math.min(prev.selectedIndex, results.length - 1);

        return {
          active: true,
          startIndex: trigger.startIndex,
          endIndex: caret,
          rawQuery: trigger.rawQuery,
          query: trigger.query,
          filter: effectiveFilter,
          hasExplicitPrefix: trigger.hasExplicitPrefix,
          results,
          selectedIndex: Math.max(0, newSelectedIndex)
        };
      });
    },
    [ensureLibraryIndex, hasConversations, hasModels, hasOperators, hasWorkspace, isTextMode, manualFilter, mentionResultsForQuery, mentionState.active, mentionState.query, mentionState.filter, onMentionPopoverOpened]
  );

  const insertMentionResult = useCallback(
    (result: UnifiedMentionResult) => {
      const { startIndex, endIndex } = mentionState;
      if (startIndex === -1 || endIndex === -1) {
        return;
      }

      // Rich-input adapter (TipTap path): if a consumer is provided and claims the insert, skip
      // the legacy markdown-string mutation entirely. The consumer is responsible for clearing the
      // mention state via `clearMentionState()` after insertion. See
      // `docs/plans/260429_composer_rich_chips_input.md` Stage 1.
      if (insertMention && insertMention(result, { startIndex, endIndex })) {
        setMentionState(DEFAULT_MENTION_STATE);
        setManualFilterState('all');
        return;
      }

      setTextPrompt((prev) => {
        const before = prev.slice(0, startIndex);
        const after = prev.slice(endIndex);

        let mentionToken: string;
        if (result.kind === 'command') {
          // Command keyword: @files (literal insertion)
          mentionToken = `@${result.command}`;
        } else if (result.kind === 'file') {
          // File mention: @`path/to/file`
          const relativePath = getRelativeLibraryPath(result.node.path);
          mentionToken = `@\`${relativePath}\``;
        } else if (result.kind === 'model') {
          // Model mention: @model:`Profile Name`
          // Sanitization must match backend detectModelReferences() exactly:
          // strip non-word/non-whitespace/non-dot/non-hyphen chars, keep spacing as-is
          const sanitizedProfileName = result.profileName.replace(/[^\w\s.-]/g, '').trim();
          mentionToken = `@model:\`${sanitizedProfileName || result.profileName}\``;
        } else if (result.kind === 'operator') {
          mentionToken = `@operator:${result.operatorSlug}`;
        } else {
          // Conversation mention: @[Title](rebel://conversation/{id})
          // Escape special markdown characters in title
          const escapedTitle = result.title
            .replace(/\\/g, '\\\\')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/\n/g, ' ');
          mentionToken = `@[${escapedTitle}](rebel://conversation/${result.id})`;
        }

        const needsSpace = /^\s/.test(after) ? '' : ' ';
        const nextValue = `${before}${mentionToken}${needsSpace}${after}`;
        // Store caret position for after state update
        (mentionCaretRef as { current: number | null }).current =
          before.length + mentionToken.length + needsSpace.length;
        return nextValue;
      });

      setMentionState(DEFAULT_MENTION_STATE);
      setManualFilterState('all'); // Reset manual filter when mention is inserted

      requestAnimationFrame(() => {
        const textarea = commandInputRef.current;
        const caret = mentionCaretRef.current;
        if (textarea && caret !== null) {
          textarea.focus();
          textarea.setSelectionRange(caret, caret);
          (mentionCaretRef as { current: number | null }).current = null;
        }
      });
    },
    [commandInputRef, getRelativeLibraryPath, insertMention, mentionCaretRef, mentionState, setTextPrompt]
  );

  const navigateMentionUp = useCallback(() => {
    setMentionState((prev) => ({
      ...prev,
      selectedIndex: Math.max(prev.selectedIndex - 1, 0)
    }));
  }, []);

  const navigateMentionDown = useCallback(() => {
    setMentionState((prev) => ({
      ...prev,
      selectedIndex: Math.min(prev.selectedIndex + 1, prev.results.length - 1)
    }));
  }, []);

  const selectCurrentMention = useCallback((): boolean => {
    if (!mentionState.active || mentionState.results.length === 0) {
      return false;
    }
    const candidate =
      mentionState.results[mentionState.selectedIndex] ?? mentionState.results[0];
    if (candidate) {
      insertMentionResult(candidate);
      return true;
    }
    return false;
  }, [insertMentionResult, mentionState]);

  const clearMentionState = useCallback(() => {
    setMentionState(DEFAULT_MENTION_STATE);
    // Reset manual filter when mention popover closes
    setManualFilterState('all');
  }, []);

  const setSelectedIndex = useCallback((index: number) => {
    setMentionState((prev) => ({
      ...prev,
      selectedIndex: index
    }));
  }, []);

  /**
   * Set the manual filter (from tab clicks).
   * This only takes effect when there's no explicit prefix in the query.
   * Re-runs the search immediately with the new filter.
   * @param filter - The filter type to apply
   * @param freshQuery - Optional fresh query from textarea (use when debounced state may be stale)
   */
  const setManualFilter = useCallback(
    (filter: MentionFilterType, freshQuery?: string) => {
      setManualFilterState(filter);

      // If mention is active and there's no explicit prefix, re-run search with new filter
      if (mentionState.active && !mentionState.hasExplicitPrefix) {
        // Only ensure library index if filter might need file results
        if (filter === 'all' || filter === 'skills' || filter === 'memory') {
          ensureLibraryIndex();
        }
        const queryToUse = freshQuery ?? mentionState.query;
        const results = mentionResultsForQuery(queryToUse, filter);

        setMentionState((prev) => ({
          ...prev,
          filter,
          query: queryToUse,
          results,
          // Reset selectedIndex when filter changes (results may be different)
          selectedIndex: 0
        }));
      }
    },
    [ensureLibraryIndex, mentionResultsForQuery, mentionState.active, mentionState.hasExplicitPrefix, mentionState.query]
  );

  return {
    mentionState,
    updateMentionContext,
    insertMentionResult,
    navigateMentionUp,
    navigateMentionDown,
    selectCurrentMention,
    clearMentionState,
    setSelectedIndex,
    setManualFilter
  };
};

export { DEFAULT_MENTION_STATE, findMentionTrigger };
