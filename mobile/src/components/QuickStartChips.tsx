// mobile/src/components/QuickStartChips.tsx
//
// Horizontal row of 0-2 contextual suggestion chips for the home screen.
// Only shows chips that provide shortcuts NOT available from the persistent
// tab bar. Renders nothing when no contextual chips apply.

import { useCallback, useMemo } from 'react';
import { ScrollView, Text, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { spacing, radius } from '../theme/tokens';
import { generateMobileSessionId } from '../utils/sessionId';
import { Pressable } from './Pressable';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChipDescriptor {
  key: string;
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
}

export interface QuickStartChipsProps {
  approvalCount: number;
  todayActionCount: number;
  hasAnySessions: boolean;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    scrollView: {
      marginBottom: spacing.md,
    },
    scrollContent: {
      paddingHorizontal: spacing.xs,
      gap: spacing.sm,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.full,
      paddingHorizontal: spacing.sm + 4,
      paddingVertical: spacing.xs + 2,
    },
    chipLabel: {
      ...typography.bodySmall,
      fontSize: 13,
      fontWeight: '500',
      color: colors.textPrimary,
    },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuickStartChips({
  approvalCount,
  todayActionCount,
  hasAnySessions,
}: QuickStartChipsProps) {
  const colors = useColors();
  const router = useRouter();
  const s = useMemo(() => createStyles(colors), [colors]);

  const navigateToInbox = useCallback(() => {
    router.push('/(tabs)/inbox');
  }, [router]);

  const startNewConversation = useCallback(() => {
    const sessionId = generateMobileSessionId();
    router.push(`/conversation/${sessionId}?compose=text`);
  }, [router]);

  const chips = useMemo<ChipDescriptor[]>(() => {
    const result: ChipDescriptor[] = [];

    if (approvalCount > 0) {
      result.push({
        key: 'approvals',
        icon: 'shield',
        label: `Review ${approvalCount} approval${approvalCount === 1 ? '' : 's'}`,
        onPress: navigateToInbox,
      });
    }

    if (todayActionCount > 0) {
      result.push({
        key: 'actions',
        icon: 'zap',
        label: `${todayActionCount} action${todayActionCount === 1 ? '' : 's'} need${todayActionCount === 1 ? 's' : ''} attention`,
        onPress: navigateToInbox,
      });
    }

    if (!hasAnySessions && result.length === 0) {
      result.push({
        key: 'new-conversation',
        icon: 'message-circle',
        label: 'Ask Rebel anything',
        onPress: startNewConversation,
      });
    }

    return result;
  }, [approvalCount, todayActionCount, hasAnySessions, navigateToInbox, startNewConversation]);

  if (chips.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={s.scrollView}
      contentContainerStyle={s.scrollContent}
      testID="quick-start-chips"
    >
      {chips.map((chip) => (
        <Pressable
          key={chip.key}
          style={s.chip}
          onPress={chip.onPress}
          testID={`quick-start-chip-${chip.key}`}
        >
          <Feather name={chip.icon} size={14} color={colors.accent} />
          <Text style={s.chipLabel}>{chip.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
