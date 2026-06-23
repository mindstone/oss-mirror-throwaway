import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return {
    ...Reanimated,
    useReducedMotion: () => false,
  };
});

jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => ReactLocal.createElement(RNLocal.Text, { testID: `icon-${name}` }, name),
  };
});

import { ASK_SPARK_ONBOARDING_STORAGE_KEY } from '../../hooks/useMeetingFirstUseOnboarding';
import { MeetingRecordingBanner, type MeetingRecordingBannerProps } from '../MeetingRecordingBanner';

function renderBanner(overrides: Partial<MeetingRecordingBannerProps> = {}) {
  return render(
    <MeetingRecordingBanner
      title="Weekly Standup"
      startTime={Date.now()}
      isRecording
      transcriptStatus="live"
      onStop={jest.fn()}
      onAskSparkPress={jest.fn()}
      {...overrides}
    />,
  );
}

describe('MeetingRecordingBanner', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(ASK_SPARK_ONBOARDING_STORAGE_KEY, 'true');
    jest.clearAllMocks();
  });

  it('places Ask Spark in the main row and opens through the supplied handler', () => {
    const onAskSparkPress = jest.fn();
    const { getByLabelText } = renderBanner({ onAskSparkPress });

    fireEvent.press(getByLabelText('Ask Spark during this meeting'));

    expect(onAskSparkPress).toHaveBeenCalledTimes(1);
  });

  it('shows and persists the first-use instructional row dismissal', async () => {
    await AsyncStorage.removeItem(ASK_SPARK_ONBOARDING_STORAGE_KEY);
    const { getByText, getByTestId, queryByText } = renderBanner();

    await waitFor(() => {
      expect(getByText('Try: "Hey Spark, summarise so far." Answers stay here, not in the call.')).toBeTruthy();
    });

    fireEvent.press(getByTestId('ask-spark-first-use-dismiss'));

    await waitFor(() => {
      expect(queryByText('Try: "Hey Spark, summarise so far." Answers stay here, not in the call.')).toBeNull();
    });
    await expect(AsyncStorage.getItem(ASK_SPARK_ONBOARDING_STORAGE_KEY)).resolves.toBe('true');
  });

  it('shows the offline state while leaving Ask Spark enabled', () => {
    const { getByText, getByLabelText, getByTestId } = renderBanner({ transcriptStatus: 'offline' });

    expect(getByText('Offline - voice trigger paused. Ask Spark still saves questions.')).toBeTruthy();
    expect(getByTestId('icon-wifi-off')).toBeTruthy();
    expect(getByLabelText('Ask Spark during this meeting').props.accessibilityState.disabled).toBe(false);
  });

  it('shows rate-limited and awaiting-turn status states', () => {
    const { getByText, rerender } = renderBanner({ rateLimited: true });

    expect(getByText('Voice trigger is paused for this meeting. Ask Spark still works.')).toBeTruthy();

    rerender(
      <MeetingRecordingBanner
        title="Weekly Standup"
        startTime={Date.now()}
        isRecording
        transcriptStatus="live"
        onStop={jest.fn()}
        onAskSparkPress={jest.fn()}
        awaitingTurn
      />,
    );
    expect(getByText('Still drafting...')).toBeTruthy();
  });

  it('shows pulse, recording-stopped, and dropped-trigger copy variants', () => {
    const { getByText, rerender } = renderBanner({ askSparkPulsing: true });

    expect(getByText('Spark heard you')).toBeTruthy();

    rerender(
      <MeetingRecordingBanner
        title="Weekly Standup"
        startTime={Date.now()}
        isRecording={false}
        transcriptStatus="live"
        onStop={jest.fn()}
        onAskSparkPress={jest.fn()}
      />,
    );
    expect(getByText('Recording\'s stopped, so Spark isn\'t listening right now.')).toBeTruthy();

    rerender(
      <MeetingRecordingBanner
        title="Weekly Standup"
        startTime={Date.now()}
        isRecording
        transcriptStatus="live"
        onStop={jest.fn()}
        onAskSparkPress={jest.fn()}
        lastDropReason="action-timeout"
      />,
    );
    expect(getByText('Your last question didn\'t go through. Please ask again.')).toBeTruthy();
  });
});
