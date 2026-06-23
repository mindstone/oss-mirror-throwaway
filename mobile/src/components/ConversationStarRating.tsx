import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { useColors, type ColorTokens } from '../theme/colors';
import { radius } from '../theme/tokens';

export type ConversationStarValue = 1 | 2 | 3 | 4 | 5;

export interface ConversationStarRatingProps {
  value: number | null;
  onSelect?: (rating: ConversationStarValue) => void;
  interactive?: boolean;
  testIDPrefix?: string;
}

const STAR_VALUES: readonly ConversationStarValue[] = [1, 2, 3, 4, 5];
const STAR_SIZE = 24;
const STAR_TOUCH_TARGET = 44;

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    starButton: {
      width: STAR_TOUCH_TARGET,
      height: STAR_TOUCH_TARGET,
      borderRadius: radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    starButtonReadOnly: {
      opacity: 0.9,
    },
    starFilled: {
      color: colors.accent,
    },
    starEmpty: {
      color: colors.textTertiary,
    },
  });
}

function getStarAccessibilityLabel(value: ConversationStarValue): string {
  if (value === 1) return '1 star, Bad';
  if (value === 5) return '5 stars, Great';
  return `${value} stars`;
}

export const ConversationStarRating = memo(function ConversationStarRating({
  value,
  onSelect,
  interactive = true,
  testIDPrefix = 'conversation-star-rating',
}: ConversationStarRatingProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  const handleSelect = useCallback((rating: ConversationStarValue) => {
    if (!interactive) return;
    onSelect?.(rating);
  }, [interactive, onSelect]);

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Rate this conversation"
      style={s.row}
      testID={`${testIDPrefix}-group`}
    >
      {STAR_VALUES.map((rating) => {
        const isChecked = value === rating;
        const isFilled = value !== null && rating <= value;

        return (
          <TouchableOpacity
            key={rating}
            testID={`${testIDPrefix}-star-${rating}`}
            onPress={() => handleSelect(rating)}
            disabled={!interactive}
            accessibilityRole="radio"
            accessibilityLabel={getStarAccessibilityLabel(rating)}
            accessibilityState={{ checked: isChecked, disabled: !interactive }}
            style={[s.starButton, !interactive && s.starButtonReadOnly]}
            activeOpacity={interactive ? 0.75 : 1}
          >
            <Feather
              name="star"
              size={STAR_SIZE}
              color={isFilled ? s.starFilled.color : s.starEmpty.color}
              testID={`${testIDPrefix}-icon-${rating}`}
            />
          </TouchableOpacity>
        );
      })}
    </View>
  );
});

ConversationStarRating.displayName = 'ConversationStarRating';

export default ConversationStarRating;
