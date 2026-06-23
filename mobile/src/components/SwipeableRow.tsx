import { memo, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import type { Swipeable as SwipeableType } from 'react-native-gesture-handler';
import { useColors, type ColorTokens } from '../theme/colors';
import { hapticMedium } from '../utils/haptics';

/**
 * Tone for the right swipe panel. Defaults to 'error' (red) for destructive /
 * existing callers; 'accent' is for non-destructive lifecycle actions like
 * "Done" (Done is success, not danger — see chief-designer §3a/D7, OQ2).
 */
type RightActionTone = 'error' | 'accent';

type SwipeableRowProps = {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  leftLabel: string;
  rightLabel?: string;
  rightActionTone?: RightActionTone;
  children: ReactNode;
};

function createStyles(colors: ColorTokens, rightActionTone: RightActionTone) {
  return StyleSheet.create({
    actionContainer: {
      justifyContent: 'center',
      minWidth: 96,
      paddingHorizontal: 14,
      borderRadius: 16,
      marginHorizontal: 16,
    },
    leftAction: {
      alignItems: 'flex-start',
      backgroundColor: colors.warning,
    },
    rightAction: {
      alignItems: 'flex-end',
      backgroundColor: rightActionTone === 'accent' ? colors.accent : colors.error,
    },
    actionText: {
      color: '#fff',
      fontSize: 13,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
  });
}

export const SwipeableRow = memo(function SwipeableRow({
  onSwipeLeft,
  onSwipeRight,
  leftLabel,
  rightLabel,
  rightActionTone = 'error',
  children,
}: SwipeableRowProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors, rightActionTone), [colors, rightActionTone]);
  const swipeableRef = useRef<SwipeableType | null>(null);

  const runAction = useCallback((action: () => void) => {
    hapticMedium();
    action();
    swipeableRef.current?.close();
  }, []);

  const renderLeftActions = useCallback(() => {
    return (
      <View style={[s.actionContainer, s.leftAction]}>
        <Text style={s.actionText}>{leftLabel}</Text>
      </View>
    );
  }, [leftLabel, s.actionContainer, s.actionText, s.leftAction]);

  const renderRightActions = useCallback(() => {
    return (
      <View style={[s.actionContainer, s.rightAction]}>
        <Text style={s.actionText}>{rightLabel}</Text>
      </View>
    );
  }, [rightLabel, s.actionContainer, s.actionText, s.rightAction]);

  return (
    <Swipeable
      ref={swipeableRef}
      friction={2}
      leftThreshold={48}
      rightThreshold={48}
      // Each panel renders only when its own handler is provided.
      renderLeftActions={onSwipeLeft == null ? undefined : renderLeftActions}
      renderRightActions={onSwipeRight == null ? undefined : renderRightActions}
      onSwipeableOpen={(direction) => {
        // react-native-gesture-handler@2.28 semantics (verified against
        // node_modules/.../components/Swipeable.tsx animateRow): the LEFT
        // panel (renderLeftActions / leftLabel) opens with direction='left';
        // the RIGHT panel (renderRightActions / rightLabel) opens with
        // direction='right'. So onSwipeLeft is the LEFT panel's handler and
        // onSwipeRight is the RIGHT panel's handler — each fires for the panel
        // whose label it sits next to.
        if (direction === 'left' && onSwipeLeft != null) {
          runAction(onSwipeLeft);
          return;
        }
        if (direction === 'right' && onSwipeRight != null) {
          runAction(onSwipeRight);
        }
      }}
    >
      {children}
    </Swipeable>
  );
});
