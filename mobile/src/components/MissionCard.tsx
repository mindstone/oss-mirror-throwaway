import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import type { MissionContext } from '@rebel/cloud-client';

const typography = createTypography(true);

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      backgroundColor: colors.accentLight,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    goal: {
      ...typography.bodySmall,
      fontSize: 13,
      lineHeight: 18,
      color: colors.textPrimary,
    },
    metaLine: {
      ...typography.caption,
      fontSize: 12,
      lineHeight: 16,
      color: colors.textTertiary,
      marginTop: 3,
    },
    metaLabel: {
      fontWeight: '600',
    },
  });
}

type Props = {
  mission: MissionContext;
};

export const MissionCard = memo(function MissionCard({ mission }: Props) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  return (
    <Animated.View entering={FadeInDown.duration(180)} style={s.container}>
      <Text style={s.goal} numberOfLines={3}>{mission.goal}</Text>
      {mission.doneCriteria ? (
        <Text style={s.metaLine} numberOfLines={2}>
          <Text style={s.metaLabel}>Done when </Text>
          {mission.doneCriteria}
        </Text>
      ) : null}
      {mission.constraints ? (
        <Text style={s.metaLine} numberOfLines={2}>
          <Text style={s.metaLabel}>Constraints </Text>
          {mission.constraints}
        </Text>
      ) : null}
    </Animated.View>
  );
});
