import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useColors } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { Pressable } from './Pressable';

const typography = createTypography(true);

type EmptyStateProps = {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle?: string;
  ctaLabel?: string;
  onCtaPress?: () => void;
  testID?: string;
};

/**
 * Reusable empty state with icon, witty copy, optional CTA, and entry animation.
 * Respects reduced motion — renders immediately without FadeIn if preferred.
 */
export function EmptyState({
  icon,
  title,
  subtitle,
  ctaLabel,
  onCtaPress,
  testID,
}: EmptyStateProps) {
  const colors = useColors();
  const reducedMotion = useReducedMotion();

  const content = (
    <View testID={testID} style={styles.container}>
      <Feather name={icon} size={48} color={colors.textTertiary} style={styles.icon} />
      <Text style={[typography.headline, styles.title, { color: colors.textSecondary }]}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={[typography.bodySmall, styles.subtitle, { color: colors.textTertiary }]}>
          {subtitle}
        </Text>
      ) : null}
      {ctaLabel && onCtaPress ? (
        <Pressable
          testID={testID ? `${testID}-cta` : undefined}
          style={[styles.cta, { backgroundColor: colors.accent }]}
          onPress={onCtaPress}
        >
          <Text style={[typography.bodySmall, styles.ctaText]}>
            {ctaLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  if (reducedMotion) return content;

  return (
    <Animated.View entering={FadeIn.duration(400)}>
      {content}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingVertical: 40,
  },
  icon: {
    marginBottom: 16,
  },
  title: {
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
    marginTop: 6,
  },
  cta: {
    marginTop: 20,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  ctaText: {
    color: '#fff',
    fontWeight: '600',
  },
});
