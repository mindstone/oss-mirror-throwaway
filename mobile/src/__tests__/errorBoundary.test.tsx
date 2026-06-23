/**
 * ErrorBoundary tests.
 *
 * Verifies that the boundary:
 *   - Renders children when no error.
 *   - Renders the themed recovery fallback when a child throws.
 *   - Reports the error to Sentry (componentDidCatch).
 *   - Themes the fallback via useColors() — light and dark differ (the
 *     light-mode bug this test guards against: hard-coded dark hex).
 *   - Resets stores + navigates home on the "Go Home" CTA.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Text, useColorScheme } from 'react-native';

jest.mock('react-native/Libraries/Utilities/useColorScheme');

const mockResetSession = jest.fn();
const mockResetInbox = jest.fn();
const mockResetApproval = jest.fn();
const mockResetStaged = jest.fn();
const mockClearRecording = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({ router: { replace: (...a: unknown[]) => mockReplace(...a) } }));
jest.mock('@rebel/cloud-client', () => ({
  // Pure live-meeting id casts (zero-import module) so a future pure cast added
  // there needs no mock edit. See meetingRecordingContext.test.tsx for rationale.
  ...(jest.requireActual('../../../cloud-client/src/types/liveMeetingIds') as typeof import('../../../cloud-client/src/types/liveMeetingIds')),
  useSessionStore: { getState: () => ({ resetStore: mockResetSession }) },
  useInboxStore: { getState: () => ({ resetStore: mockResetInbox }) },
  useApprovalStore: { getState: () => ({ resetStore: mockResetApproval }) },
  useStagedFilesStore: { getState: () => ({ resetStore: mockResetStaged }) },
}));
jest.mock('../stores/activeRecordingStore', () => ({
  useActiveRecordingStore: { getState: () => ({ clearRecording: mockClearRecording }) },
}));
jest.mock('../utils/sentry', () => ({
  mobileErrorReporter: { captureException: jest.fn() },
}));

import { ErrorBoundary } from '../components/ErrorBoundary';
import { mobileErrorReporter } from '../utils/sentry';

const Boom: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) throw new Error('intentional test error');
  return <Text>ok</Text>;
};

describe('ErrorBoundary', () => {
  let consoleErrorSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    (useColorScheme as jest.Mock).mockReturnValue('dark');
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleErrorSpy.mockRestore());

  it('renders children when no error', () => {
    const { queryByText } = render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(queryByText('ok')).toBeTruthy();
  });

  it('renders the recovery fallback and reports to Sentry when a child throws', () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(getByText("Well, that wasn't supposed to happen.")).toBeTruthy();
    expect(getByText('Go Home')).toBeTruthy();
    expect(mobileErrorReporter.captureException).toHaveBeenCalledTimes(1);
  });

  it('themes the fallback differently in light vs dark mode', () => {
    const flatten = (s: unknown): Record<string, unknown> =>
      Array.isArray(s) ? Object.assign({}, ...s.map(flatten)) : ((s as Record<string, unknown>) ?? {});

    (useColorScheme as jest.Mock).mockReturnValue('dark');
    const darkRender = render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    const darkBg = flatten(darkRender.getByTestId('error-boundary-fallback').props.style).backgroundColor;

    (useColorScheme as jest.Mock).mockReturnValue('light');
    const lightRender = render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    const lightBg = flatten(lightRender.getByTestId('error-boundary-fallback').props.style).backgroundColor;

    // The container background follows the theme — not the old hard-coded dark hex in light mode.
    expect(darkBg).toBe('#0a0a0e');
    expect(lightBg).toBe('#f4f7fb');
    expect(lightBg).not.toBe(darkBg);
  });

  it('resets stores and navigates home on Go Home', () => {
    const { getByText } = render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    fireEvent.press(getByText('Go Home'));
    expect(mockResetSession).toHaveBeenCalled();
    expect(mockResetInbox).toHaveBeenCalled();
    expect(mockResetApproval).toHaveBeenCalled();
    expect(mockResetStaged).toHaveBeenCalled();
    expect(mockClearRecording).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/');
  });
});
