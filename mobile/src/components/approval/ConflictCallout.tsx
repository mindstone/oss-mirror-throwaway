/**
 * ConflictCallout — three-way conflict-resolution UI for a staged file.
 *
 * Presents three actions when a staged file conflicts with remote content:
 *   1. **Resolve with Rebel** (primary) — opens the current conversation
 *      with the composer prefilled with the hardened seed prompt
 *      produced by `buildConversationalResolutionPrompt`. User can
 *      review, edit, and send; the agent walks the user through
 *      "Keep mine" vs "Keep theirs" before calling
 *      `memory:staging-resolve-conflict`.
 *   2. **Keep mine** (secondary) — calls `resolveConflict(id,
 *      'keep-staged')` directly. Immediate escape hatch.
 *   3. **Keep theirs** (secondary) — calls `resolveConflict(id,
 *      'keep-real')` directly. Immediate escape hatch.
 *
 * Stage 6 of
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`.
 *
 * Offline behavior: when the caller passes `isOnline={false}` all three
 * actions are disabled and a "Requires online" hint renders. No silent
 * drop. Retry is implicit: once `isOnline` flips back to true the buttons
 * become tappable again.
 *
 * Rapid-tap defense (F6-R1-5): each action has INTERNAL per-action busy
 * state (tracked synchronously via a ref so consecutive taps in the
 * same microtask can't slip through) AND a disabled-visual flag (tracked
 * in state so the UI rerenders). Tapping any action marks it busy
 * BEFORE firing haptics + dispatch, runs the handler, and clears busy
 * on resolve / reject. While ANY action is in-flight, all three actions
 * render disabled so the user can't double-commit to a different
 * resolution. Haptics fire exactly once at tap time — never on rerender.
 *
 * Callers may still pass an external `busy` prop to force a disabled
 * state (e.g. while a parent-level IPC is in flight for a different
 * reason). Internal busy and external busy are both sufficient to
 * disable all actions.
 */

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { createLogger } from '@rebel/cloud-client';

import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';
import { hapticMedium, hapticWarning } from '../../utils/haptics';

const typography = createTypography(true);
const log = createLogger('ConflictCallout');

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type ActionHandler = () => void | Promise<void>;

export interface ConflictCalloutProps {
  /**
   * Kick off the conversational flow. The caller is expected to:
   *   - Build the seed prompt via `buildConversationalResolutionPrompt`
   *   - Navigate to `/conversation/{sessionId}?prefill=...`
   *   - NOT auto-send the turn — the user reviews, optionally tweaks,
   *     then taps send.
   *
   * May return a Promise (e.g. if the handler fetches content before
   * navigating); the callout will keep the "in-flight" visual until it
   * resolves.
   */
  onResolveWithRebel: ActionHandler;
  /** Direct "keep my staged version" handler. May return a Promise. */
  onKeepMine: ActionHandler;
  /** Direct "keep the remote version" handler. May return a Promise. */
  onKeepTheirs: ActionHandler;
  /** Offline gate — disables all three actions with "Requires online" hint. */
  isOnline?: boolean;
  /**
   * External busy flag — disables all actions while an in-flight resolve
   * IPC / other parent-owned work is pending. Combined with the callout's
   * internal per-action busy state so callers never need to wire both.
   */
  busy?: boolean;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      gap: 10,
      padding: 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: `${colors.warning}55`,
      backgroundColor: `${colors.warning}11`,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    title: {
      ...typography.bodySmall,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    subtitle: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    primaryButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 11,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 6,
    },
    primaryButtonDisabled: {
      opacity: 0.5,
    },
    primaryText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: '#fff',
    },
    secondaryRow: {
      flexDirection: 'row',
      gap: 8,
    },
    secondaryButton: {
      flex: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryButtonDisabled: {
      opacity: 0.5,
    },
    secondaryText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    offlineHint: {
      ...typography.caption,
      color: colors.textTertiary,
      fontStyle: 'italic',
    },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ActionKey = 'resolveWithRebel' | 'keepMine' | 'keepTheirs';

export const ConflictCallout = memo(function ConflictCallout({
  onResolveWithRebel,
  onKeepMine,
  onKeepTheirs,
  isOnline = true,
  busy = false,
}: ConflictCalloutProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  // Synchronous ref so consecutive taps in the same microtask can't
  // slip past the React-state update. Once a key is set, subsequent
  // taps for any action short-circuit until this clears.
  const inFlightRef = useRef<ActionKey | null>(null);
  // Mirror state drives the visual disabled look. It trails the ref by
  // one render, which is fine because the ref stops duplicate dispatch
  // synchronously.
  const [inFlight, setInFlight] = useState<ActionKey | null>(null);

  const internallyBusy = inFlight !== null;
  const disabled = !isOnline || busy || internallyBusy;

  const runAction = useCallback(
    (key: ActionKey, haptic: () => void, handler: ActionHandler) => {
      // Block rapid-double-taps BEFORE React has a chance to rerender.
      if (inFlightRef.current !== null) return;
      // Respect the external disable signals too — TouchableOpacity
      // already blocks presses when `disabled=true`, but a stale prop
      // edge case (e.g. offline state flipping false-to-true-to-false
      // within one gesture) is caught here.
      if (!isOnline || busy) return;

      inFlightRef.current = key;
      setInFlight(key);
      // Haptic fires exactly once at tap time — never on rerender. This
      // is important because the memoized handler identity changes
      // across renders and a naive useEffect-driven haptic would spam.
      haptic();

      let result: void | Promise<void>;
      try {
        result = handler();
      } catch (err) {
        // Synchronous throw from a void handler — clear immediately and
        // rethrow so parent error boundaries still see it.
        inFlightRef.current = null;
        setInFlight(null);
        throw err;
      }

      // If the handler returned a promise, wait for it; otherwise
      // clear on the next microtask so a synchronous handler doesn't
      // leave the button stuck-disabled.
      //
      // Rejection policy: the CALLER owns error UI (the inbox-level
      // handler is expected to toast / log / retry). This component
      // attaches a `.catch` purely to keep busy-state tracking
      // observable on failure — the catch emits a structured WARN so
      // unexpected rejections are never silently dropped (see
      // AGENTS.md "silent failure is a bug"). The caller's own
      // error-handling branch still runs; the component does not
      // intercept the rejection before the caller sees it.
      Promise.resolve(result)
        .catch((err) => {
          log.warn('conflict action handler rejected; caller owns error UI', {
            action: key,
            err: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          inFlightRef.current = null;
          setInFlight(null);
        });
    },
    [isOnline, busy],
  );

  const handleResolveWithRebel = useCallback(() => {
    runAction('resolveWithRebel', hapticMedium, onResolveWithRebel);
  }, [runAction, onResolveWithRebel]);

  const handleKeepMine = useCallback(() => {
    runAction('keepMine', hapticWarning, onKeepMine);
  }, [runAction, onKeepMine]);

  const handleKeepTheirs = useCallback(() => {
    runAction('keepTheirs', hapticWarning, onKeepTheirs);
  }, [runAction, onKeepTheirs]);

  return (
    <View testID="conflict-callout" style={s.container}>
      <View style={s.header}>
        <Feather name="alert-triangle" size={16} color={colors.warning} />
        <Text style={s.title}>This file conflicts with a recent change</Text>
      </View>
      <Text style={s.subtitle}>
        The version on disk is different from what Rebel wants to save. Pick how to resolve.
      </Text>

      <TouchableOpacity
        testID="conflict-callout-resolve-with-rebel"
        style={[s.primaryButton, disabled && s.primaryButtonDisabled]}
        onPress={handleResolveWithRebel}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Resolve this conflict by asking Rebel"
        accessibilityState={{ disabled }}
        activeOpacity={0.8}
      >
        <Feather name="message-circle" size={14} color="#fff" />
        <Text style={s.primaryText}>Resolve with Rebel</Text>
      </TouchableOpacity>

      <View style={s.secondaryRow}>
        <TouchableOpacity
          testID="conflict-callout-keep-mine"
          style={[s.secondaryButton, disabled && s.secondaryButtonDisabled]}
          onPress={handleKeepMine}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel="Keep the version Rebel staged"
          accessibilityState={{ disabled }}
          activeOpacity={0.7}
        >
          <Text style={s.secondaryText}>Keep mine</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="conflict-callout-keep-theirs"
          style={[s.secondaryButton, disabled && s.secondaryButtonDisabled]}
          onPress={handleKeepTheirs}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel="Keep the version currently on disk"
          accessibilityState={{ disabled }}
          activeOpacity={0.7}
        >
          <Text style={s.secondaryText}>Keep theirs</Text>
        </TouchableOpacity>
      </View>

      {!isOnline && (
        <Text testID="conflict-callout-offline" style={s.offlineHint}>
          Requires online — reconnect to resolve.
        </Text>
      )}
    </View>
  );
});

ConflictCallout.displayName = 'ConflictCallout';

export default ConflictCallout;
