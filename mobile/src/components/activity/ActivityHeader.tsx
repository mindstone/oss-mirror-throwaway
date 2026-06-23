import { memo, useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { MobileActivityState } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';
import { Pressable } from '../Pressable';

const typography = createTypography(true);

export type ActivityHeaderProps = {
  state: MobileActivityState;
  headline: string;
  subheadline?: string;
  elapsedLabel?: string;
  progressLabel?: string;
  isExpanded: boolean;
  canExpand: boolean;
  onToggle: () => void;
};

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    pressable: {
      borderRadius: 12,
      paddingHorizontal: 2,
      paddingVertical: 2,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
    },
    iconWrap: {
      width: 16,
      minHeight: 18,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 2,
    },
    textWrap: {
      flex: 1,
      gap: 2,
    },
    headline: {
      ...typography.bodySmall,
      color: colors.textPrimary,
      fontSize: 14,
      lineHeight: 20,
      fontWeight: '600',
    },
    subheadline: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    metaWrap: {
      alignItems: 'flex-end',
      gap: 2,
      minWidth: 54,
      paddingTop: 1,
    },
    elapsed: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 11,
      lineHeight: 14,
    },
    progress: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 11,
      lineHeight: 14,
    },
  });
}

export const ActivityHeader = memo(function ActivityHeader({
  state,
  headline,
  subheadline,
  elapsedLabel,
  progressLabel,
  isExpanded,
  canExpand,
  onToggle,
}: ActivityHeaderProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  const statusIcon = useMemo(() => {
    if (state === 'completed') {
      return <Feather name="check-circle" size={14} color={colors.success} />;
    }
    if (state === 'error') {
      return <Feather name="alert-circle" size={14} color={colors.error} />;
    }
    if (state === 'paused') {
      return <Feather name="alert-circle" size={14} color={colors.warning} />;
    }
    return <ActivityIndicator size="small" color={colors.accent} />;
  }, [colors.accent, colors.error, colors.success, colors.warning, state]);

  const content = (
    <View style={s.row}>
      <View style={s.iconWrap}>{statusIcon}</View>
      <View style={s.textWrap}>
        <Text style={s.headline}>{headline}</Text>
        {subheadline ? <Text style={s.subheadline}>{subheadline}</Text> : null}
      </View>
      <View style={s.metaWrap}>
        {elapsedLabel ? <Text style={s.elapsed}>{elapsedLabel}</Text> : null}
        {progressLabel ? <Text style={s.progress}>{progressLabel}</Text> : null}
        {canExpand ? (
          <Feather
            name={isExpanded ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={colors.textTertiary}
          />
        ) : null}
      </View>
    </View>
  );

  if (!canExpand) {
    return content;
  }

  return (
    <Pressable
      style={s.pressable}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: isExpanded }}
      accessibilityLabel={isExpanded ? 'Collapse activity details' : 'Expand activity details'}
    >
      {content}
    </Pressable>
  );
});
