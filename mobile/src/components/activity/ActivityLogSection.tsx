import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown, useReducedMotion } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import type { MobileActivityStep } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';
import { hapticLight } from '../../utils/haptics';
import { ToolResultImages } from '../ToolResultImage';

const typography = createTypography(true);

export type ActivityLogSectionProps = {
  steps: MobileActivityStep[];
  owningSessionId?: string;
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
    },
    list: { gap: 4 },
    stepContainer: { gap: 4 },
    stepButton: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      borderRadius: 8,
      paddingVertical: 1,
    },
    stepIconWrap: {
      width: 16,
      minHeight: 18,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 1,
    },
    stepTextWrap: {
      flex: 1,
    },
    stepLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 6,
    },
    stepLabel: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 18,
      flexShrink: 1,
    },
    stepImageIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    stepImageIndicatorText: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 11,
      lineHeight: 14,
    },
    stepDetailWrap: {
      marginLeft: 24,
      gap: 8,
    },
    stepDetail: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 12,
      lineHeight: 16,
    },
  });
}

export const ActivityLogSection = memo(function ActivityLogSection({
  steps,
  owningSessionId,
}: ActivityLogSectionProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const reducedMotion = useReducedMotion();
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});

  const toggleDetail = useCallback((key: string, hasExpandableContent: boolean) => {
    if (!hasExpandableContent) return;
    hapticLight();
    setExpandedDetails((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  if (steps.length === 0) return null;

  return (
    <View style={s.container}>
      <View style={s.headerRow}>
        <Text style={s.label}>Activity log</Text>
      </View>
      <Animated.View
        entering={reducedMotion ? undefined : FadeInDown.duration(160)}
        style={s.list}
      >
        {steps.map((step) => {
          const refCount = step.imageRef
            ? step.imageRef.reduce((sum, ref) => (ref ? sum + 1 : sum), 0)
            : 0;
          const imageCount = Math.max(step.imageContent?.length ?? 0, refCount);
          const hasImages = imageCount > 0;
          const hasDetail = Boolean(step.shortDetail);
          const hasExpandableContent = hasDetail || hasImages;
          const isDetailExpanded = Boolean(expandedDetails[step.key]);

          let statusIcon;
          if (step.status === 'running') {
            statusIcon = <Feather name="clock" size={14} color={colors.warning} />;
          } else if (step.status === 'error') {
            statusIcon = <Feather name="alert-circle" size={14} color={colors.error} />;
          } else {
            statusIcon = <Feather name="check-circle" size={14} color={colors.success} />;
          }

          return (
            <View key={step.key} style={s.stepContainer}>
              <TouchableOpacity
                style={s.stepButton}
                activeOpacity={hasExpandableContent ? 0.7 : 1}
                onPress={() => toggleDetail(step.key, hasExpandableContent)}
                accessibilityRole={hasExpandableContent ? 'button' : undefined}
                accessibilityState={hasExpandableContent ? { expanded: isDetailExpanded } : undefined}
              >
                <View style={s.stepIconWrap}>{statusIcon}</View>
                <View style={s.stepTextWrap}>
                  <View style={s.stepLabelRow}>
                    <Text style={s.stepLabel}>{step.label}</Text>
                    {hasImages ? (
                      <View style={s.stepImageIndicator}>
                        <Feather name="image" size={11} color={colors.textTertiary} />
                        <Text style={s.stepImageIndicatorText}>
                          {imageCount} image{imageCount === 1 ? '' : 's'}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
                {hasExpandableContent ? (
                  <Feather
                    name={isDetailExpanded ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={colors.textTertiary}
                  />
                ) : null}
              </TouchableOpacity>

              {hasExpandableContent && isDetailExpanded ? (
                <Animated.View
                  entering={reducedMotion ? undefined : FadeInDown.duration(120)}
                  exiting={reducedMotion ? undefined : FadeOutDown.duration(100)}
                  style={s.stepDetailWrap}
                >
                  {hasDetail ? <Text style={s.stepDetail}>{step.shortDetail}</Text> : null}
                  {hasImages ? (
                    <ToolResultImages
                      images={step.imageContent}
                      imageRefs={step.imageRef}
                      owningSessionId={owningSessionId}
                    />
                  ) : null}
                </Animated.View>
              ) : null}
            </View>
          );
        })}
      </Animated.View>
    </View>
  );
});
