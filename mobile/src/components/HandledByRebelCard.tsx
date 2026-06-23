// mobile/src/components/HandledByRebelCard.tsx
//
// Collapsible card summarizing inbox items that Rebel auto-completed today.
// Manages its own expanded/dismissed state internally.

import { useState, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';

import type { InboxItem } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { Pressable } from './Pressable';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDayKey(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 12,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
      gap: 8,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    summaryButton: {
      flex: 1,
    },
    summaryText: {
      ...typography.body,
      fontSize: 15,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    quip: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textSecondary,
      marginTop: 2,
    },
    dismissButton: {
      borderRadius: 999,
      padding: 4,
    },
    expandedTitles: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textSecondary,
    },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface HandledByRebelCardProps {
  handledItems: InboxItem[];
}

export function HandledByRebelCard({ handledItems }: HandledByRebelCardProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  const todayKey = getDayKey(Date.now());
  const [dismissedDayKey, setDismissedDayKey] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Reset expanded state at day boundary
  useEffect(() => {
    setIsExpanded(false);
  }, [todayKey]);

  const count = handledItems.length;
  const showCard = count > 0 && dismissedDayKey !== todayKey;

  const titles = useMemo(
    () =>
      handledItems
        .map((item) => item.title?.trim() || item.text?.trim() || 'Untitled')
        .join(' · '),
    [handledItems],
  );

  const summaryText = `While you were away, Rebel handled ${count} item${count === 1 ? '' : 's'}.`;
  const quipText =
    count === 1
      ? 'Consider it done. That one is off your plate.'
      : `Consider it done. All ${count} of them.`;

  if (!showCard) return null;

  return (
    <View testID="home-handled-by-rebel-card" style={s.card}>
      <View style={s.header}>
        <Pressable
          testID="home-handled-by-rebel-toggle"
          style={s.summaryButton}
          onPress={() => setIsExpanded((current) => !current)}
        >
          <Text style={s.summaryText} numberOfLines={1}>
            {summaryText}
          </Text>
          <Text style={s.quip} numberOfLines={1}>
            {quipText}
          </Text>
        </Pressable>

        <TouchableOpacity
          testID="home-handled-by-rebel-dismiss"
          style={s.dismissButton}
          onPress={() => {
            setDismissedDayKey(todayKey);
            setIsExpanded(false);
          }}
          activeOpacity={0.7}
          accessibilityLabel="Dismiss handled by Rebel card"
        >
          <Feather name="x" size={16} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>

      {isExpanded && (
        <Text style={s.expandedTitles}>{titles}</Text>
      )}
    </View>
  );
}
