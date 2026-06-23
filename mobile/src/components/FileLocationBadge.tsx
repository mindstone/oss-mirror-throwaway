import { memo, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { createLogger } from '@rebel/cloud-client';
import {
  describeFileLocation,
  type FileLocation,
} from '@rebel/shared';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';

const typography = createTypography(true);
const log = createLogger('FileLocationBadge');
const warnedLegacyKeys = new Set<string>();

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minWidth: 0,
      maxWidth: '100%',
    },
    badgeCompact: {
      opacity: 0.92,
    },
    badgeDegraded: {
      opacity: 0.86,
    },
    icon: {
      flexShrink: 0,
    },
    label: {
      ...typography.caption,
      color: colors.textSecondary,
      flexShrink: 1,
      minWidth: 0,
    },
    labelCompact: {
      ...typography.caption,
    },
    labelDegraded: {
      color: colors.textTertiary,
      fontStyle: 'italic',
    },
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.55)',
      justifyContent: 'center',
      padding: 24,
    },
    tooltipCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
      gap: 8,
    },
    tooltipTitle: {
      ...typography.overline,
      color: colors.textTertiary,
    },
    tooltipText: {
      ...typography.bodySmall,
      color: colors.textPrimary,
    },
  });
}

export interface FileLocationBadgeProps {
  location: FileLocation;
  compact?: boolean;
}

export const FileLocationBadge = memo(function FileLocationBadge({
  location,
  compact = false,
}: FileLocationBadgeProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const description = useMemo(() => describeFileLocation(location), [location]);
  const warnKey = `${description.fileName}|${description.label}`;

  useEffect(() => {
    if (location.kind !== 'legacy-missing-location' || warnedLegacyKeys.has(warnKey)) {
      return;
    }
    warnedLegacyKeys.add(warnKey);
    log.warn('Rendering degraded FileLocationBadge', {
      surface: 'mobile',
      warnKey,
      fileName: description.fileName,
      label: description.label,
    });
  }, [description.fileName, description.label, location.kind, warnKey]);

  return (
    <>
      <Pressable
        onLongPress={() => setTooltipVisible(true)}
        delayLongPress={250}
        accessibilityRole="button"
        accessibilityLabel={description.tooltip}
        testID="file-location-badge"
      >
        <View
          style={[
            s.badge,
            compact && s.badgeCompact,
            description.degraded && s.badgeDegraded,
          ]}
        >
          {description.degraded ? (
            <Feather
              name="alert-triangle"
              size={compact ? 12 : 14}
              color={colors.warning}
              style={s.icon}
              testID="file-location-badge-warning-icon"
            />
          ) : null}
          <Text
            testID="file-location-badge-label"
            style={[
              s.label,
              compact && s.labelCompact,
              description.degraded && s.labelDegraded,
            ]}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {compact ? description.shortLabel : description.label}
          </Text>
        </View>
      </Pressable>

      <Modal
        visible={tooltipVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTooltipVisible(false)}
      >
        <Pressable
          style={s.backdrop}
          onPress={() => setTooltipVisible(false)}
          testID="file-location-badge-tooltip"
        >
          <Pressable onPress={(event) => event.stopPropagation()}>
            <View style={s.tooltipCard}>
              <Text style={s.tooltipTitle}>Full path</Text>
              <Text style={s.tooltipText}>{description.tooltip}</Text>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
});
