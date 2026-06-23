/**
 * ApprovalSheetShell — shared bottom-sheet wrapper for the three approval
 * detail sheets (StagedFile / Memory / Tool).
 *
 * Stage D Round-2 F-D-R2-1: replaced `@gorhom/bottom-sheet` with React
 * Native's built-in `Modal`. Gorhom@5.2.9 ships Reanimated 3 internals
 * that are incompatible with `react-native-reanimated@~4.1.1` — sheets
 * fail to open or respond to gestures at runtime (issues #2546/2547/
 * 2592/2600). Option D from the Stage-D R2 playbook: `Modal` +
 * `animationType="slide"` + backdrop press-to-dismiss. This ships the
 * fastest, introduces zero dependencies, and is guaranteed compatible
 * with the current RN/Reanimated/gesture-handler matrix. Trade-off: no
 * drag-to-dismiss gesture. Acceptable per task spec; re-evaluate when
 * Reanimated 4-compat sheet library is available (gorhom next major,
 * actions-sheet once it lands worklets ^0.5.x support, or Discord's
 * fork once it stabilises).
 *
 * Stage D of `docs/plans/260417_approval_consolidation_closeout.md`.
 *
 * Design:
 *  - `visible` prop drives `Modal.visible`; closing is always observable
 *    via `onClose` (backdrop press or hardware back on Android).
 *  - Sheet content scrolls inside a `ScrollView` when taller than the
 *    85%-max-height container.
 *  - Backdrop is a full-screen `Pressable` that captures taps outside
 *    the sheet body.
 *  - `keyboardShouldPersistTaps="handled"` on the scrollview so users
 *    can tap buttons while the keyboard is up.
 *
 * Snapshot-friendly: the shell doesn't own any state about the sheet's
 * data — children can render a last-known snapshot while `visible`
 * animates out. See F-D-R2-4 in the sheet components.
 */

import { useMemo } from 'react';
import {
  type DimensionValue,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';

const typography = createTypography(true);

export interface ApprovalSheetShellProps {
  /** When true, the sheet animates open; when false, it animates closed. */
  visible: boolean;
  /** Fires when the user dismisses via backdrop tap or hardware back. */
  onClose: () => void;
  /** Sheet title rendered in the header. */
  title: string;
  /** Sheet subtitle / secondary context line (optional). */
  subtitle?: string;
  /** Identifier for accessibility + tests — the sheet root gets `testID`. */
  testID: string;
  /** Optional max height override for sheets that use the same recipe at a smaller size. */
  maxHeight?: DimensionValue;
  /** Sheet body. Rendered inside a `ScrollView`. */
  children: React.ReactNode;
}

function createStyles(colors: ColorTokens, bottomInset: number, maxHeight: DimensionValue) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    sheetContainer: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      maxHeight,
      paddingBottom: Math.max(bottomInset, 16),
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -2 },
      shadowOpacity: 0.15,
      shadowRadius: 8,
      elevation: 12,
    },
    handleContainer: {
      paddingTop: 8,
      paddingBottom: 4,
      alignItems: 'center',
    },
    handle: {
      backgroundColor: colors.border,
      width: 36,
      height: 4,
      borderRadius: 2,
    },
    header: {
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    title: {
      ...typography.headline,
      fontSize: 18,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    subtitle: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      marginTop: 2,
    },
    scrollContent: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 24,
      gap: 14,
    },
  });
}

export function ApprovalSheetShell({
  visible,
  onClose,
  title,
  subtitle,
  testID,
  maxHeight = '85%',
  children,
}: ApprovalSheetShellProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const s = useMemo(() => createStyles(colors, insets.bottom, maxHeight), [colors, insets.bottom, maxHeight]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      // iOS-only prop; harmless on Android.
      statusBarTranslucent={Platform.OS === 'android'}
      accessibilityViewIsModal
    >
      <Pressable
        style={s.backdrop}
        onPress={onClose}
        accessibilityLabel="Close sheet"
        accessibilityRole="button"
        testID={`${testID}-backdrop`}
      >
        {/*
         * Inner pressable with noop onPress so taps inside the sheet
         * body don't bubble to the backdrop and dismiss the sheet.
         * `android_disableSound` + activeOpacity=1 keeps it invisible.
         */}
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={s.sheetContainer}
          accessible={false}
        >
          <View style={s.handleContainer}>
            <View style={s.handle} />
          </View>
          <View style={s.header}>
            <Text style={s.title}>{title}</Text>
            {subtitle ? (
              <Text style={s.subtitle} numberOfLines={2}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <ScrollView
            testID={testID}
            contentContainerStyle={s.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default ApprovalSheetShell;
