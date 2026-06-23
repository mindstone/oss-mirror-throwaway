import React from 'react';
import type { AgentTurnMessage } from '@shared/types';
import './MeetingTurnSpeakerAttribution.css';

export function getMeetingTurnSpeakerAttribution(
  message: Pick<AgentTurnMessage, 'role' | 'triggerSource' | 'triggerSourceSpeaker'>,
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
  message: Pick<AgentTurnMessage, 'role' | 'triggerSource' | 'triggerSourceSpeaker'>;
}) {
  const attribution = getMeetingTurnSpeakerAttribution(message);

  if (!attribution) return null;

  return (
    <div className="meeting-turn-speaker-attribution" data-testid="meeting-turn-speaker-attribution">
      {attribution}
    </div>
  );
}
