import { memo, useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import type { MobileAssistantDisplayItem } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';

const typography = createTypography(true);

const DEFAULT_PREVIEW_LIMIT = 3;

export type ActivityAssistantsSectionProps = {
  assistants: MobileAssistantDisplayItem[];
  isExpanded: boolean;
  previewLimit?: number;
};

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { gap: 6 },
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
      flex: 1,
    },
    countText: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 11,
      lineHeight: 14,
    },
    chipWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 5,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      maxWidth: '100%',
    },
    chipRunning: {
      backgroundColor: colors.accentLight,
      borderColor: colors.accentLight,
    },
    chipText: {
      ...typography.caption,
      color: colors.textPrimary,
      fontSize: 12,
      lineHeight: 16,
      flexShrink: 1,
    },
    chipMeta: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 11,
      lineHeight: 14,
    },
    overflowChip: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    overflowText: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 12,
      lineHeight: 16,
    },
    rowList: { gap: 6, marginTop: 2 },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      backgroundColor: colors.surface,
    },
    rowRunning: {
      backgroundColor: colors.accentLight,
    },
    rowIconWrap: {
      width: 16,
      minHeight: 18,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 1,
    },
    rowBody: { flex: 1, gap: 2 },
    rowTitleLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    rowActivity: {
      ...typography.bodySmall,
      color: colors.textPrimary,
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '600',
      flex: 1,
    },
    rowDuration: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 11,
      lineHeight: 14,
    },
    rowMetaLine: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 11,
      lineHeight: 14,
    },
    rowSummary: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    backgroundBadge: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 10,
      lineHeight: 14,
      backgroundColor: colors.border,
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: 1,
      overflow: 'hidden',
    },
  });
}

const ChipIcon = memo(function ChipIcon({
  status,
  colors,
}: {
  status: MobileAssistantDisplayItem['status'];
  colors: ColorTokens;
}) {
  if (status === 'running') return <ActivityIndicator size="small" color={colors.accent} />;
  return <Feather name="check-circle" size={12} color={colors.success} />;
});

export const ActivityAssistantsSection = memo(function ActivityAssistantsSection({
  assistants,
  isExpanded,
  previewLimit = DEFAULT_PREVIEW_LIMIT,
}: ActivityAssistantsSectionProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const reducedMotion = useReducedMotion();

  if (assistants.length === 0) return null;

  const runningCount = assistants.filter((a) => a.status === 'running').length;
  const previewItems = assistants.slice(0, previewLimit);
  const overflowCount = Math.max(0, assistants.length - previewItems.length);

  return (
    <View style={s.container}>
      <View style={s.headerRow}>
        <Text style={s.label}>Assistants</Text>
        {runningCount > 0 ? (
          <Text style={s.countText}>{runningCount} active</Text>
        ) : (
          <Text style={s.countText}>{assistants.length}</Text>
        )}
      </View>

      {!isExpanded ? (
        <View style={s.chipWrap}>
          {previewItems.map((item) => {
            const isRunning = item.status === 'running';
            const meta = isRunning ? item.elapsedLabel : item.durationLabel;
            return (
              <View
                key={item.id}
                style={[s.chip, isRunning && s.chipRunning]}
                accessible
                accessibilityLabel={`${item.activityLabel}${meta ? `, ${meta}` : ''}`}
              >
                <ChipIcon status={item.status} colors={colors} />
                <Text style={s.chipText} numberOfLines={1}>
                  {item.activityLabel}
                </Text>
                {meta ? <Text style={s.chipMeta}>{meta}</Text> : null}
              </View>
            );
          })}
          {overflowCount > 0 ? (
            <View style={s.overflowChip} accessible accessibilityLabel={`+${overflowCount} more assistants`}>
              <Text style={s.overflowText}>+{overflowCount} more</Text>
            </View>
          ) : null}
        </View>
      ) : (
        <Animated.View
          entering={reducedMotion ? undefined : FadeInDown.duration(160)}
          style={s.rowList}
        >
          {assistants.map((item) => {
            const isRunning = item.status === 'running';
            const meta = isRunning ? item.elapsedLabel : item.durationLabel;
            return (
              <View key={item.id} style={[s.row, isRunning && s.rowRunning]}>
                <View style={s.rowIconWrap}>
                  <ChipIcon status={item.status} colors={colors} />
                </View>
                <View style={s.rowBody}>
                  <View style={s.rowTitleLine}>
                    <Text style={s.rowActivity} numberOfLines={1}>
                      {item.activityLabel}
                    </Text>
                    {item.isBackground ? (
                      <Text style={s.backgroundBadge}>Background</Text>
                    ) : null}
                    {meta ? <Text style={s.rowDuration}>{meta}</Text> : null}
                  </View>
                  {item.summary && item.summary !== item.activityLabel ? (
                    <Text style={s.rowSummary} numberOfLines={2}>{item.summary}</Text>
                  ) : null}
                  {item.modelLabel || item.roleLabel !== item.activityLabel ? (
                    <Text style={s.rowMetaLine} numberOfLines={1}>
                      {[item.roleLabel, item.modelLabel]
                        .filter((part): part is string => Boolean(part) && part !== item.activityLabel)
                        .join(' · ')}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </Animated.View>
      )}
    </View>
  );
});
