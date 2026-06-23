import React from 'react';
import { render } from '@testing-library/react-native';

import {
  getMeetingTurnSpeakerAttribution,
  MeetingTurnSpeakerAttribution,
} from '../MeetingTurnSpeakerAttribution';

describe('MeetingTurnSpeakerAttribution', () => {
  it.each([
    [
      { role: 'user', triggerSource: 'voice-trigger', triggerSourceSpeaker: 'unknown' },
      'Asked by someone in the meeting',
    ],
    [
      { role: 'user', triggerSource: 'quick-ask-button', triggerSourceSpeaker: 'user' },
      'Asked while recording',
    ],
    [
      { role: 'user', triggerSource: 'voice-trigger', triggerSourceSpeaker: 'user' },
      'Asked by you while recording',
    ],
    [
      { role: 'user', triggerSource: 'voice-trigger', triggerSourceSpeaker: 'Avery' },
      'Asked by Avery',
    ],
  ] as const)('derives locked copy %#', (message, expected) => {
    expect(getMeetingTurnSpeakerAttribution(message)).toBe(expected);
  });

  it('renders only for user messages with triggerSource', () => {
    const { getByText, queryByTestId, rerender } = render(
      <MeetingTurnSpeakerAttribution
        message={{ role: 'user', triggerSource: 'voice-trigger', triggerSourceSpeaker: 'unknown' }}
      />,
    );

    expect(getByText('Asked by someone in the meeting')).toBeTruthy();

    rerender(<MeetingTurnSpeakerAttribution message={{ role: 'assistant' }} />);
    expect(queryByTestId('meeting-turn-speaker-attribution')).toBeNull();
  });
});
