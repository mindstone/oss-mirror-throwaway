import React, { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { SessionMessage } from '@rebel/cloud-client';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';

const typography = createTypography(true);

export function getMeetingTurnSpeakerAttribution(
  message: Pick<SessionMessage, 'role' | 'triggerSource' | 'triggerSourceSpeaker'>,
): string | null {
  if (message.role !== 'user' || !message.triggerSource) return null;

  const speaker = typeof message.triggerSourceSpeaker === 'string'
    ? message.triggerSourceSpeaker.trim()
    : '';

  if (speaker && speaker !== 'unknown' && speaker !== 'user') {
    return `Asked by ${speaker}`;
  }

  if (message.triggerSource === 'voice-trigger') {
    return speaker === 'user'
      ? 'Asked by you while recording'
      : 'Asked by someone in the meeting';
  }

  if (message.triggerSource === 'quick-ask-button') {
    return 'Asked while recording';
  }

  return null;
}

export function MeetingTurnSpeakerAttribution({
  message,
}: {
  message: Pick<SessionMessage, 'role' | 'triggerSource' | 'triggerSourceSpeaker'>;
}) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const attribution = getMeetingTurnSpeakerAttribution(message);

  if (!attribution) return null;

  return (
    <Text style={s.text} testID="meeting-turn-speaker-attribution">
      {attribution}
    </Text>
  );
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    text: {
      ...typography.caption,
      fontSize: 11,
      fontWeight: '400',
      color: colors.textTertiary,
      marginTop: 2,
      marginHorizontal: 4,
    },
  });
}
