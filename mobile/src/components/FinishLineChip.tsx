import { memo, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  Pressable,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { normalizeFinishLine } from '@core/utils/finishLine';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';

const typography = createTypography(true);
const DISPLAY_LIMIT = 80;

export interface FinishLineChipProps {
  value: string | undefined;
  onPress: () => void;
}

function truncateCriterion(value: string): string {
  if (value.length <= DISPLAY_LIMIT) return value;
  return `${value.slice(0, DISPLAY_LIMIT - 1).trimEnd()}…`;
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: 12,
      paddingTop: 6,
      paddingBottom: 2,
      backgroundColor: colors.background,
    },
    chip: {
      alignSelf: 'flex-start',
      maxWidth: '100%',
      minHeight: 34,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 11,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    chipActive: {
      borderColor: colors.accent,
      backgroundColor: colors.accentLight,
    },
    chipPressed: {
      backgroundColor: colors.surfaceHover,
    },
    chipPressedActive: {
      backgroundColor: colors.accentMuted,
    },
    icon: {
      flexShrink: 0,
    },
    label: {
      ...typography.caption,
      color: colors.textSecondary,
      fontWeight: '600',
      flexShrink: 1,
      minWidth: 0,
    },
    labelActive: {
      color: colors.textPrimary,
    },
  });
}

const FinishLineChipComponent = ({ value, onPress }: FinishLineChipProps) => {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const normalizedValue = normalizeFinishLine(value);
  const displayValue = normalizedValue ?? '';
  const hasValue = displayValue.length > 0;
  const label = hasValue ? truncateCriterion(displayValue) : 'Set finish line';

  return (
    <View style={s.container} testID="finish-line-chip-container">
      <Pressable
        testID="finish-line-chip"
        hitSlop={8}
        style={({ pressed }) => [
          s.chip,
          hasValue && s.chipActive,
          pressed && (hasValue ? s.chipPressedActive : s.chipPressed),
        ]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={hasValue ? `Finish line: ${displayValue}` : 'Set finish line'}
        accessibilityHint={
          hasValue
            ? 'Rebel stops when this is met. Opens the editor to edit or clear it.'
            : 'Tell Rebel what finished looks like.'
        }
        accessibilityState={{ selected: hasValue }}
      >
        <Feather
          name="flag"
          size={13}
          color={hasValue ? colors.accent : colors.textTertiary}
          style={s.icon}
          testID="finish-line-chip-icon"
        />
        <Text
          style={[s.label, hasValue && s.labelActive]}
          numberOfLines={1}
          ellipsizeMode="tail"
          testID="finish-line-chip-label"
        >
          {label}
        </Text>
      </Pressable>
    </View>
  );
};

export const FinishLineChip = memo(FinishLineChipComponent);
