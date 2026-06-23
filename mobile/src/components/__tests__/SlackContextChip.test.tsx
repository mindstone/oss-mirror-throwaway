import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as ReactNative from 'react-native';

const { Linking } = ReactNative;
const mockUseColorScheme = jest.fn((): 'light' | 'dark' | null => 'dark');

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) => (
      <Text testID={testID}>{name}</Text>
    ),
  };
});

import { SlackContextChip } from '../SlackContextChip';

const HTTPS_PERMALINK = 'https://acme.slack.com/archives/C1/p1700000000123456';
const HIT_SLOP = { top: 8, right: 8, bottom: 8, left: 8 };

describe('SlackContextChip', () => {
  let openUrlSpy: jest.SpyInstance<Promise<void>, [url: string]>;
  let consoleWarnSpy: jest.SpyInstance;
  let colorSchemeSpy: jest.SpyInstance;

  beforeEach(() => {
    mockUseColorScheme.mockReturnValue('dark');
    colorSchemeSpy = jest.spyOn(ReactNative, 'useColorScheme').mockImplementation(mockUseColorScheme);
    openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    openUrlSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    colorSchemeSpy.mockRestore();
  });

  it('renders full metadata as a pressable link and opens the Slack permalink', () => {
    const { getByTestId, getByText } = render(
      <SlackContextChip
        userName="Alice"
        channelName="planning"
        teamName="Acme"
        permalink={HTTPS_PERMALINK}
      />,
    );

    const chip = getByTestId('slack-context-chip');
    expect(chip.props.accessibilityRole).toBe('link');
    expect(chip.props.accessibilityLabel).toBe('View Slack message from Alice in #planning');
    expect(chip.props.hitSlop).toEqual(HIT_SLOP);
    expect(getByText('Alice in #planning')).toBeTruthy();
    expect(getByText('Acme')).toBeTruthy();
    expect(getByText('View in Slack')).toBeTruthy();

    fireEvent.press(chip);

    expect(openUrlSpy).toHaveBeenCalledWith(HTTPS_PERMALINK);
  });

  it('renders channel-only metadata as a read-only chip', () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <SlackContextChip channelName="ops" teamName="Acme" />,
    );

    const chip = getByTestId('slack-context-chip');
    expect(chip.props.accessibilityRole).toBe('text');
    expect(chip.props.accessibilityLabel).toBe('View Slack message: Unknown user in #ops · Acme');
    expect(getByText('Unknown user in #ops')).toBeTruthy();
    expect(queryByTestId('slack-context-chip-link-label')).toBeNull();
  });

  it('renders DM-style context using the user display name', () => {
    const { getByText } = render(
      <SlackContextChip userDisplayName="Display Alice" teamName="Acme" />,
    );

    expect(getByText('Display Alice in (channel unavailable)')).toBeTruthy();
  });

  it('returns null cleanly when external context is explicitly missing', () => {
    const { toJSON } = render(<SlackContextChip externalContext={null} />);

    expect(toJSON()).toBeNull();
  });

  it('matches the light theme snapshot', () => {
    mockUseColorScheme.mockReturnValue('light');
    const result = render(
      <SlackContextChip
        userName="Alice"
        channelName="planning"
        teamName="Acme"
        permalink={HTTPS_PERMALINK}
      />,
    );

    expect(result.toJSON()).toMatchSnapshot();
  });

  it('matches the dark theme snapshot', () => {
    mockUseColorScheme.mockReturnValue('dark');
    const result = render(
      <SlackContextChip
        userName="Alice"
        channelName="planning"
        teamName="Acme"
        permalink={HTTPS_PERMALINK}
      />,
    );

    expect(result.toJSON()).toMatchSnapshot();
  });

  it('matches the long-label truncation snapshot', () => {
    const result = render(
      <SlackContextChip
        userName="Alexandria Longlastname-McPlannington"
        channelName="quarterly-planning-and-cross-functional-risks"
        teamName="Acme International Strategic Operations"
        permalink={HTTPS_PERMALINK}
      />,
    );

    expect(result.toJSON()).toMatchSnapshot();
  });

  it('matches the missing-metadata fallback snapshot', () => {
    const result = render(
      <SlackContextChip
        userName={null}
        channelName={null}
        teamName={null}
        permalink={null}
      />,
    );

    expect(result.toJSON()).toMatchSnapshot();
    expect(result.getByText('Slack message')).toBeTruthy();
  });

  it('does not crash when Linking.openURL rejects', async () => {
    openUrlSpy.mockRejectedValueOnce(new Error('No handler'));
    const { getByTestId } = render(
      <SlackContextChip
        userName="Alice"
        channelName="planning"
        permalink={HTTPS_PERMALINK}
      />,
    );

    fireEvent.press(getByTestId('slack-context-chip'));

    await waitFor(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[WARN] [SlackContextChip] Failed to open Slack permalink'),
      );
    });
  });

  it('treats non-HTTPS permalinks as read-only', () => {
    const { getByTestId, queryByTestId } = render(
      <SlackContextChip
        userName="Alice"
        channelName="planning"
        permalink="slack://channel?id=C1"
      />,
    );

    expect(getByTestId('slack-context-chip').props.accessibilityRole).toBe('text');
    expect(queryByTestId('slack-context-chip-link-label')).toBeNull();
  });

  it('treats non-Slack HTTPS permalinks as read-only', () => {
    const { getByTestId, queryByTestId } = render(
      <SlackContextChip
        userName="Alice"
        channelName="planning"
        permalink="https://evil.example/X"
      />,
    );

    const chip = getByTestId('slack-context-chip');
    expect(chip.props.accessibilityRole).toBe('text');
    expect(queryByTestId('slack-context-chip-link-label')).toBeNull();

    fireEvent.press(chip);

    expect(openUrlSpy).not.toHaveBeenCalled();
  });

  it('links workspace Slack HTTPS permalinks', () => {
    const { getByTestId } = render(
      <SlackContextChip
        userName="Alice"
        channelName="planning"
        permalink="https://workspace.slack.com/archives/C1/p1700000000123456"
      />,
    );

    const chip = getByTestId('slack-context-chip');
    expect(chip.props.accessibilityRole).toBe('link');

    fireEvent.press(chip);

    expect(openUrlSpy).toHaveBeenCalledWith('https://workspace.slack.com/archives/C1/p1700000000123456');
  });
});
