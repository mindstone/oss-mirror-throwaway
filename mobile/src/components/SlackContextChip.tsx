import { memo, useCallback, useMemo } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type Insets,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { createLogger, type SlackMentionPollContext, type SlackThreadContext } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';

const typography = createTypography(true);
const log = createLogger('SlackContextChip');
const HIT_SLOP: Insets = { top: 8, right: 8, bottom: 8, left: 8 };

export interface SlackContextChipProps {
  channelName?: string | null;
  userName?: string | null;
  userDisplayName?: string | null;
  teamName?: string | null;
  permalink?: string | null;
  externalContext?: SlackThreadContext | SlackMentionPollContext | null;
}

function normaliseLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normaliseHttpsPermalink(value: string | null | undefined): string | null {
  const trimmed = normaliseLabel(value);
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return null;

    const isSlackHost = url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com');
    if (!isSlackHost) return null;

    return url.toString();
  } catch {
    return null;
  }
}

function resolveChipLabels(args: {
  channelName?: string | null;
  userName?: string | null;
  userDisplayName?: string | null;
  teamName?: string | null;
}) {
  const displayUser = normaliseLabel(args.userName) ?? normaliseLabel(args.userDisplayName);
  const channelName = normaliseLabel(args.channelName);
  const teamName = normaliseLabel(args.teamName);
  const channelLabel = channelName ? `#${channelName}` : null;
  const sourceLabel = channelLabel && displayUser
    ? `${displayUser} in ${channelLabel}`
    : channelLabel
      ? `Unknown user in ${channelLabel}`
      : displayUser
        ? `${displayUser} in (channel unavailable)`
        : 'Slack message';
  const fullLabel = teamName ? `${sourceLabel} · ${teamName}` : sourceLabel;
  const accessibilityLabel = channelLabel && displayUser
    ? `View Slack message from ${displayUser} in ${channelLabel}`
    : `View Slack message: ${fullLabel}`;

  return {
    sourceLabel,
    teamName,
    fullLabel,
    accessibilityLabel,
  };
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    chip: {
      minHeight: 44,
      maxWidth: '100%',
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 2,
      elevation: 1,
    },
    chipPressed: {
      backgroundColor: colors.surfaceHover,
    },
    icon: {
      flexShrink: 0,
    },
    source: {
      ...typography.caption,
      color: colors.textSecondary,
      fontWeight: '600',
      flexShrink: 1,
      minWidth: 0,
    },
    separator: {
      ...typography.caption,
      color: colors.textTertiary,
      flexShrink: 0,
    },
    team: {
      ...typography.caption,
      color: colors.textTertiary,
      fontStyle: 'italic',
      flexShrink: 1,
      minWidth: 0,
    },
    linkText: {
      ...typography.caption,
      color: colors.accent,
      fontWeight: '600',
      flexShrink: 0,
    },
  });
}

const SlackContextChipComponent = ({
  channelName,
  userName,
  userDisplayName,
  teamName,
  permalink,
  externalContext,
}: SlackContextChipProps) => {
  if (externalContext === null) return null;

  const metadata = externalContext?.metadata;
  const resolvedChannelName = metadata?.channelName ?? channelName;
  const resolvedUserName = metadata?.userName ?? userName;
  const resolvedUserDisplayName = metadata?.userDisplayName ?? userDisplayName;
  const resolvedTeamName = metadata?.teamName ?? teamName;
  const safePermalink = normaliseHttpsPermalink(metadata?.permalink ?? permalink);

  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const labels = useMemo(
    () => resolveChipLabels({
      channelName: resolvedChannelName,
      userName: resolvedUserName,
      userDisplayName: resolvedUserDisplayName,
      teamName: resolvedTeamName,
    }),
    [resolvedChannelName, resolvedTeamName, resolvedUserDisplayName, resolvedUserName],
  );

  const handleOpen = useCallback(() => {
    if (!safePermalink) return;
    Linking.openURL(safePermalink).catch((err: unknown) => {
      let permalinkHost: string | undefined;
      try {
        permalinkHost = new URL(safePermalink).host;
      } catch {
        permalinkHost = undefined;
      }
      log.warn('Failed to open Slack permalink', {
        permalinkHost,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, [safePermalink]);

  const content = (
    <>
      <Feather
        name="message-square"
        size={12}
        color={colors.textTertiary}
        style={s.icon}
        testID="slack-context-chip-icon"
      />
      <Text
        style={s.source}
        numberOfLines={1}
        ellipsizeMode="tail"
        testID="slack-context-chip-source"
      >
        {labels.sourceLabel}
      </Text>
      {labels.teamName ? (
        <>
          <Text style={s.separator} accessibilityElementsHidden importantForAccessibility="no">
            ·
          </Text>
          <Text
            style={s.team}
            numberOfLines={1}
            ellipsizeMode="tail"
            testID="slack-context-chip-team"
          >
            {labels.teamName}
          </Text>
        </>
      ) : null}
      {safePermalink ? (
        <>
          <Text style={s.separator} accessibilityElementsHidden importantForAccessibility="no">
            ·
          </Text>
          <Text style={s.linkText} testID="slack-context-chip-link-label">
            View in Slack
          </Text>
        </>
      ) : null}
    </>
  );

  if (safePermalink) {
    return (
      <Pressable
        testID="slack-context-chip"
        accessibilityRole="link"
        accessibilityLabel={labels.accessibilityLabel}
        accessibilityHint="Opens the original Slack message"
        hitSlop={HIT_SLOP}
        onPress={handleOpen}
        style={({ pressed }) => [s.chip, pressed && s.chipPressed]}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View
      testID="slack-context-chip"
      accessible
      accessibilityRole="text"
      accessibilityLabel={labels.accessibilityLabel}
      style={s.chip}
    >
      {content}
    </View>
  );
};

export const SlackContextChip = memo(SlackContextChipComponent);
SlackContextChip.displayName = 'SlackContextChip';
