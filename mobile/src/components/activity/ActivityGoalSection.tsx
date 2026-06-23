import { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown, useReducedMotion } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import type { MobileActivityViewModel } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';
import { Pressable } from '../Pressable';
import { hapticLight } from '../../utils/haptics';

const typography = createTypography(true);

export type ActivityGoalSectionProps = {
  mission: NonNullable<MobileActivityViewModel['mission']>;
  defaultExpanded?: boolean;
};

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { gap: 4 },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    label: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 11,
      lineHeight: 14,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    labelSpacer: { flex: 1 },
    chevron: { paddingHorizontal: 2, paddingVertical: 2 },
    goal: {
      ...typography.bodySmall,
      color: colors.textPrimary,
      fontSize: 13,
      lineHeight: 18,
    },
    detailLine: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
      marginTop: 2,
    },
    detailLabel: {
      color: colors.textPrimary,
      fontWeight: '600',
    },
  });
}

export const ActivityGoalSection = memo(function ActivityGoalSection({
  mission,
  defaultExpanded = false,
}: ActivityGoalSectionProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const reducedMotion = useReducedMotion();
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const hasDetails = Boolean(mission.doneCriteria || mission.constraints);

  return (
    <View style={s.container}>
      {hasDetails ? (
        <Pressable
          style={s.headerRow}
          onPress={() => {
            hapticLight();
            setIsExpanded((prev) => !prev);
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: isExpanded }}
          accessibilityLabel={isExpanded ? 'Hide goal details' : 'Show goal details'}
        >
          <Text style={s.label}>Goal</Text>
          <View style={s.labelSpacer} />
          <View style={s.chevron}>
            <Feather
              name={isExpanded ? 'chevron-up' : 'chevron-down'}
              size={12}
              color={colors.textTertiary}
            />
          </View>
        </Pressable>
      ) : (
        <View style={s.headerRow}>
          <Text style={s.label}>Goal</Text>
        </View>
      )}
      <Text style={s.goal} numberOfLines={isExpanded ? undefined : 3}>{mission.goal}</Text>
      {isExpanded && hasDetails ? (
        <Animated.View
          entering={reducedMotion ? undefined : FadeInDown.duration(140)}
          exiting={reducedMotion ? undefined : FadeOutDown.duration(110)}
        >
          {mission.doneCriteria ? (
            <Text style={s.detailLine}>
              <Text style={s.detailLabel}>Done when </Text>
              {mission.doneCriteria}
            </Text>
          ) : null}
          {mission.constraints ? (
            <Text style={s.detailLine}>
              <Text style={s.detailLabel}>Constraints </Text>
              {mission.constraints}
            </Text>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
});
