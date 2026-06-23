import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { chipsForRating, slugifyChip } from '@shared/data/conversationFeedbackChips';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { radius, spacing } from '../theme/tokens';
import { Pressable } from './Pressable';
import type { ConversationStarValue } from './ConversationStarRating';

const typography = createTypography(true);

export interface ConversationFeedbackChipsProps {
  rating: ConversationStarValue;
  selectedChips: string[];
  onToggleChip: (chipLabel: string) => void;
  disabled?: boolean;
  testIDPrefix?: string;
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      gap: spacing.sm,
    },
    chipWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    chip: {
      minHeight: 44,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.sm + 6,
      gap: spacing.xs + 2,
    },
    chipSelected: {
      borderColor: colors.accent,
      backgroundColor: colors.accentLight,
    },
    chipLabel: {
      ...typography.bodySmall,
      fontWeight: '500',
      color: colors.textPrimary,
    },
    chipLabelSelected: {
      color: colors.accent,
      fontWeight: '600',
    },
    chipDisabled: {
      opacity: 0.6,
    },
  });
}

export const ConversationFeedbackChips = memo(function ConversationFeedbackChips({
  rating,
  selectedChips,
  onToggleChip,
  disabled = false,
  testIDPrefix = 'conversation-feedback-chip',
}: ConversationFeedbackChipsProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const availableChips = useMemo(() => chipsForRating(rating), [rating]);

  return (
    <View style={s.container}>
      <View style={s.chipWrap}>
        {availableChips.map((chipLabel) => {
          const selected = selectedChips.includes(chipLabel);
          const slug = slugifyChip(chipLabel);

          return (
            <Pressable
              key={chipLabel}
              testID={`${testIDPrefix}-${slug}`}
              style={[
                s.chip,
                selected && s.chipSelected,
                disabled && s.chipDisabled,
              ]}
              onPress={() => onToggleChip(chipLabel)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={chipLabel}
              accessibilityState={{ selected, disabled }}
            >
              {selected ? <Feather name="check" size={14} color={colors.accent} /> : null}
              <Text style={[s.chipLabel, selected && s.chipLabelSelected]}>{chipLabel}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});

ConversationFeedbackChips.displayName = 'ConversationFeedbackChips';

export default ConversationFeedbackChips;
