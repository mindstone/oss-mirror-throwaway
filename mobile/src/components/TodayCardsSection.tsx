// mobile/src/components/TodayCardsSection.tsx
//
// Renders up to 3 actionable Today cards on the home screen with an optional
// "See all N items" overflow link. Renders nothing when loading or empty.

import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { spacing, radius, shadows } from '../theme/tokens';
import { Pressable } from './Pressable';
import type { TodayCard } from '../hooks/useTodayCards';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    section: {
      marginBottom: spacing.lg,
    },
    sectionTitle: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
      marginBottom: spacing.sm + 4,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm + 4,
      ...shadows.sm,
      shadowColor: colors.shadowColor,
      shadowOpacity: colors.shadowOpacity,
    },
    cardApproval: {
      backgroundColor: colors.errorLight,
    },
    cardInbox: {
      backgroundColor: colors.accentLight,
    },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: radius.sm + 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconWrapApproval: {
      backgroundColor: colors.errorLight,
    },
    iconWrapInbox: {
      backgroundColor: colors.accentMuted,
    },
    cardBody: {
      flex: 1,
      gap: 2,
    },
    cardTitle: {
      ...typography.body,
      fontSize: 15,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    cardSubtitle: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textSecondary,
    },
    ctaButton: {
      backgroundColor: colors.accent,
      borderRadius: radius.sm + 2,
      paddingHorizontal: spacing.sm + 4,
      paddingVertical: spacing.xs + 2,
    },
    ctaText: {
      ...typography.bodySmall,
      fontSize: 13,
      fontWeight: '600',
      color: '#fff',
    },
    overflowLink: {
      alignItems: 'center',
      paddingVertical: spacing.sm,
    },
    overflowText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.accent,
    },
  });
}

// ---------------------------------------------------------------------------
// Card sub-component
// ---------------------------------------------------------------------------

function TodayCardRow({
  card,
  styles,
  colors,
  onPress,
}: {
  card: TodayCard;
  styles: ReturnType<typeof createStyles>;
  colors: ColorTokens;
  onPress: () => void;
}) {
  const isApproval = card.type === 'approval';

  return (
    <Pressable
      testID={`today-card-${card.type}`}
      style={[
        styles.card,
        isApproval ? styles.cardApproval : styles.cardInbox,
      ]}
      onPress={onPress}
    >
      <View
        style={[
          styles.iconWrap,
          isApproval ? styles.iconWrapApproval : styles.iconWrapInbox,
        ]}
      >
        <Feather
          name={isApproval ? 'shield' : 'zap'}
          size={18}
          color={isApproval ? colors.error : colors.accent}
        />
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {card.title}
        </Text>
        <Text style={styles.cardSubtitle} numberOfLines={1}>
          {card.subtitle}
        </Text>
      </View>
      <View style={styles.ctaButton}>
        <Text style={styles.ctaText}>{card.ctaLabel}</Text>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

export interface TodayCardsSectionProps {
  cards: TodayCard[];
  totalCount: number;
}

export function TodayCardsSection({ cards, totalCount }: TodayCardsSectionProps) {
  const router = useRouter();
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  if (cards.length === 0) return null;

  return (
    <View testID="today-cards-section" style={s.section}>
      <Text style={s.sectionTitle}>Today</Text>

      {cards.map((card) => (
        <TodayCardRow
          key={card.type === 'inbox' ? card.item.id : 'approval'}
          card={card}
          styles={s}
          colors={colors}
          onPress={() => {
            if (card.type === 'inbox') {
              router.push({ pathname: '/(tabs)/inbox', params: { focusItemId: card.item.id } });
            } else {
              router.push('/(tabs)/inbox');
            }
          }}
        />
      ))}

      {totalCount > 3 && (
        <Pressable
          testID="today-cards-see-all"
          style={s.overflowLink}
          onPress={() => router.push('/(tabs)/inbox')}
        >
          <Text style={s.overflowText}>
            See all {totalCount} items →
          </Text>
        </Pressable>
      )}
    </View>
  );
}
