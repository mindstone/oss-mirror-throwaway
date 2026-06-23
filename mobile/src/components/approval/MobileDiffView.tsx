/**
 * MobileDiffView — renders a line-level diff of staged vs remote content.
 *
 * Consumes the shared `computeDiffAsync` engine from `@rebel/shared`
 * (Stage 5). Critically:
 *  - Uses `InteractionManager.runAfterInteractions` as the yield scheduler
 *    so the LCS pass waits for any in-flight gestures / animations to
 *    settle before burning CPU (Stage 5 R2 follow-up #2).
 *  - Wires an `AbortController` to the computation so an unmounting
 *    component / closed sheet cancels any queued work silently. We treat
 *    `DiffAbortError` as "discard" — not a user-visible error.
 *  - Handles the `{ tooLarge: true }` discriminated-union bail-out
 *    explicitly with a "file too large — open on desktop" state rather
 *    than silently rendering a zero-diff.
 *
 * Added in Stage 6 of
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  InteractionManager,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import {
  computeDiffAsync,
  DiffAbortError,
  type DiffResult,
  type SchedulerFn,
} from '@rebel/shared';

import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MobileDiffViewProps {
  /** Remote / "before" content — typically what's currently on disk. */
  before: string;
  /** Staged / "after" content — what Rebel wants to save. */
  after: string;
  /**
   * Cap the diff line count before bailing out with a "too large" state.
   * Defaults to 2_000 (combined lines). Low-end Android devices should
   * consider a smaller cap.
   */
  maxLinesForFullDiff?: number;
  /**
   * When true, expand the full hunk list. When false (default), show
   * only a compact "+N / -M lines" badge.
   */
  expanded?: boolean;
  /** Optional outer-container style override. */
  style?: ViewStyle;
}

// ---------------------------------------------------------------------------
// Scheduler — yields to the main JS thread after any in-flight interactions
// ---------------------------------------------------------------------------

/**
 * RN-optimal scheduler: wraps `InteractionManager.runAfterInteractions`
 * in a Promise so `computeDiffAsync` can `await` it. If RN scheduling
 * ever fails (defensive), falls back to `setTimeout(0)` so the diff
 * still eventually runs.
 */
const rnInteractionScheduler: SchedulerFn = () =>
  new Promise<void>((resolve) => {
    try {
      const handle = InteractionManager.runAfterInteractions(() => resolve());
      // If the host returns a cancellable handle, we'd normally store it
      // for abort — but InteractionManager already handles cleanup on
      // component unmount via the task queue; we just resolve naturally.
      void handle;
    } catch {
      setTimeout(resolve, 0);
    }
  });

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { gap: 8 },
    badgeRow: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
    },
    badge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    addedBadge: {
      backgroundColor: `${colors.success}22`,
    },
    removedBadge: {
      backgroundColor: `${colors.error}22`,
    },
    addedText: {
      ...typography.caption,
      fontWeight: '700',
      color: colors.success,
    },
    removedText: {
      ...typography.caption,
      fontWeight: '700',
      color: colors.error,
    },
    loadingText: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    tooLargeText: {
      ...typography.caption,
      color: colors.textTertiary,
      fontStyle: 'italic',
    },
    errorText: {
      ...typography.caption,
      color: colors.error,
    },
    hunksScroll: {
      maxHeight: 360,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.background,
    },
    hunksContent: {
      padding: 8,
    },
    hunkLine: {
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 12,
      lineHeight: 18,
    },
    hunkAdded: { color: colors.success },
    hunkRemoved: { color: colors.error },
    hunkUnchanged: { color: colors.textSecondary },
  });
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

interface DiffState {
  status: 'idle' | 'loading' | 'ready' | 'tooLarge' | 'error';
  result: DiffResult | null;
  error: string | null;
}

function useComputedDiff(
  before: string,
  after: string,
  maxLinesForFullDiff: number | undefined,
): DiffState {
  const [state, setState] = useState<DiffState>({
    status: 'loading',
    result: null,
    error: null,
  });
  const mountedRef = useRef(true);
  // Per-effect "generation" token. Incremented each time the effect
  // fires; each async compute captures its own generation at start and
  // refuses to commit its result unless it still matches the latest.
  // This guards against:
  //   (a) an OLDER diff resolving AFTER a newer one and overwriting it
  //       when props change rapidly (e.g. a FlatList of conflicts where
  //       the sheet body swaps before the first diff finishes), and
  //   (b) React strict-mode double-mount causing two compute promises
  //       in flight at once.
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const myGeneration = generationRef.current + 1;
    generationRef.current = myGeneration;
    const controller = new AbortController();
    setState({ status: 'loading', result: null, error: null });

    computeDiffAsync(before, after, {
      maxLinesForFullDiff,
      scheduler: rnInteractionScheduler,
      signal: controller.signal,
    })
      .then((result) => {
        if (!mountedRef.current) return;
        // Newer generation already kicked off — discard this result
        // even if it resolved after the newer one (e.g. stale A resolves
        // AFTER fresh B due to scheduler timing).
        if (generationRef.current !== myGeneration) return;
        if (result.tooLarge) {
          setState({ status: 'tooLarge', result, error: null });
        } else {
          setState({ status: 'ready', result, error: null });
        }
      })
      .catch((err) => {
        // `DiffAbortError` is expected on unmount / new-generation — treat as silent discard.
        if (err instanceof DiffAbortError) return;
        if (!mountedRef.current) return;
        if (generationRef.current !== myGeneration) return;
        const message = err instanceof Error ? err.message : 'Failed to compute diff';
        setState({ status: 'error', result: null, error: message });
      });

    return () => {
      mountedRef.current = false;
      // Bumping the generation on cleanup ensures any result that
      // resolves between `return` and the next effect fire is also
      // treated as stale. (Strict-mode double-mount path.)
      generationRef.current += 1;
      controller.abort();
    };
  }, [before, after, maxLinesForFullDiff]);

  return state;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MobileDiffView({
  before,
  after,
  maxLinesForFullDiff = 2_000,
  expanded = false,
  style,
}: MobileDiffViewProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const state = useComputedDiff(before, after, maxLinesForFullDiff);

  const stats = state.result && !state.result.tooLarge ? state.result.stats : null;

  return (
    <View testID="mobile-diff-view" style={[s.container, style]}>
      {state.status === 'loading' && (
        <Text testID="mobile-diff-loading" style={s.loadingText}>
          Computing diff…
        </Text>
      )}

      {state.status === 'tooLarge' && (
        <Text testID="mobile-diff-too-large" style={s.tooLargeText}>
          File is too large to preview on mobile — open on desktop.
        </Text>
      )}

      {state.status === 'error' && (
        <Text testID="mobile-diff-error" style={s.errorText}>
          Couldn&apos;t compute diff: {state.error}
        </Text>
      )}

      {state.status === 'ready' && stats && (
        <View testID="mobile-diff-stats" style={s.badgeRow}>
          <View style={[s.badge, s.addedBadge]}>
            <Text testID="mobile-diff-added-count" style={s.addedText}>
              +{stats.added} added
            </Text>
          </View>
          <View style={[s.badge, s.removedBadge]}>
            <Text testID="mobile-diff-removed-count" style={s.removedText}>
              −{stats.removed} removed
            </Text>
          </View>
        </View>
      )}

      {expanded && state.status === 'ready' && state.result && !state.result.tooLarge && (
        <ScrollView
          testID="mobile-diff-hunks"
          style={s.hunksScroll}
          contentContainerStyle={s.hunksContent}
        >
          {state.result.hunks.map((hunk, idx) => {
            const lineStyle =
              hunk.type === 'added'
                ? s.hunkAdded
                : hunk.type === 'removed'
                  ? s.hunkRemoved
                  : s.hunkUnchanged;
            const prefix = hunk.type === 'added' ? '+ ' : hunk.type === 'removed' ? '- ' : '  ';
            // Split on \n but preserve visual per-line rendering.
            const lines = hunk.value.split('\n');
            // Remove trailing empty entry produced by trailing \n.
            const displayLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
            return displayLines.map((line, lineIdx) => (
              <Text
                key={`${idx}-${lineIdx}`}
                testID={`mobile-diff-line-${hunk.type}-${idx}-${lineIdx}`}
                style={[s.hunkLine, lineStyle]}
                selectable
              >
                {`${prefix}${line}`}
              </Text>
            ));
          })}
        </ScrollView>
      )}
    </View>
  );
}

export default MobileDiffView;
