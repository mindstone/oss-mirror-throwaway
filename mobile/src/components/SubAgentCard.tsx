import { memo, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import type { SubAgentItem } from '@rebel/cloud-client';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 4,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    label: {
      ...typography.bodySmall,
      fontSize: 13,
      lineHeight: 18,
      color: colors.textPrimary,
      fontWeight: '600',
      flex: 1,
    },
    backgroundBadge: {
      ...typography.caption,
      fontSize: 10,
      lineHeight: 14,
      color: colors.textTertiary,
      backgroundColor: colors.border,
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: 1,
      overflow: 'hidden',
    },
    duration: {
      ...typography.caption,
      fontSize: 11,
      lineHeight: 14,
      color: colors.textTertiary,
    },
    summary: {
      ...typography.bodySmall,
      fontSize: 12,
      lineHeight: 16,
      color: colors.textSecondary,
    },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Props = {
  item: SubAgentItem;
};

export const SubAgentCard = memo(function SubAgentCard({ item }: Props) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  const isRunning = item.status === 'running';

  // Live timer for running agents
  const [elapsedMs, setElapsedMs] = useState(() =>
    isRunning ? Math.max(Date.now() - item.startedAt, 0) : 0,
  );

  useEffect(() => {
    if (!isRunning) return;
    setElapsedMs(Math.max(Date.now() - item.startedAt, 0));
    const id = setInterval(() => {
      setElapsedMs(Math.max(Date.now() - item.startedAt, 0));
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning, item.startedAt]);

  const durationMs = item.durationMs ?? elapsedMs;
  const bgTint = isRunning ? colors.accentLight : colors.successLight;

  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      style={[s.container, { backgroundColor: bgTint }]}
    >
      <View style={s.headerRow}>
        {isRunning ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Feather name="check-circle" size={14} color={colors.success} />
        )}
        <Text style={s.label} numberOfLines={1}>{item.label}</Text>
        {item.isBackground ? (
          <Text style={s.backgroundBadge}>Background</Text>
        ) : null}
        <Text style={s.duration}>{formatDuration(durationMs)}</Text>
      </View>
      {item.summary ? (
        <Text style={s.summary} numberOfLines={2}>{item.summary}</Text>
      ) : null}
    </Animated.View>
  );
});
