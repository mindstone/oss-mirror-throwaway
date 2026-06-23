import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn();
let mockSearchParams: Record<string, string | string[] | undefined> = {};
const mockPair = jest.fn();
let mockAuthError: string | null = null;

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    Redirect: ({ href }: { href: string }) => React.createElement('redirect', { href }),
    useLocalSearchParams: () => mockSearchParams,
    useRouter: () => ({ replace: mockReplace }),
  };
});

jest.mock('@rebel/cloud-client', () => ({
  __esModule: true,
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  initAuthStore: jest.fn(),
  useAuthStore: Object.assign(
    jest.fn(() => ({ pair: mockPair })),
    { getState: () => ({ error: mockAuthError }) },
  ),
}));

import E2ePairRoute from '../../app/(e2e)/pair';

describe('E2ePairRoute', () => {
  const originalE2eFlag = process.env.EXPO_PUBLIC_REBEL_E2E;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_REBEL_E2E = '1';
    mockSearchParams = {
      cloudUrl: 'http://127.0.0.1:8080',
      token: 'test-token',
      runId: 'run-123',
    };
    mockAuthError = null;
    mockPair.mockResolvedValue(undefined);
    mockPair.mockClear();
    mockReplace.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalE2eFlag === undefined) {
      delete process.env.EXPO_PUBLIC_REBEL_E2E;
    } else {
      process.env.EXPO_PUBLIC_REBEL_E2E = originalE2eFlag;
    }
  });

  it('calls the real auth-store pair path with route params when E2E mode is enabled', async () => {
    render(<E2ePairRoute />);

    await waitFor(() => {
      expect(mockPair).toHaveBeenCalledWith('http://127.0.0.1:8080', 'test-token');
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
  });

  it('does not call pair when E2E mode is disabled', async () => {
    delete process.env.EXPO_PUBLIC_REBEL_E2E;

    render(<E2ePairRoute />);

    await act(async () => {});
    expect(mockPair).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('retries on a transient pairing error and surfaces it only after exhausting attempts, without navigating', async () => {
    jest.useFakeTimers();
    // pair() resolves but leaves a transient error every time — simulates the
    // cold-start "Server is waking up or unreachable" race that never clears.
    mockAuthError = 'Server is waking up or unreachable. Give it a moment and try again.';

    const { findByTestId } = render(<E2ePairRoute />);

    // Drive the bounded retry loop (6 attempts × 1s) to completion, flushing the
    // awaited pair() promise between each timer tick.
    await act(async () => {
      await jest.runAllTimersAsync();
    });

    expect(await findByTestId('e2e-pair-error')).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
    // It must have actually retried, not given up on the first failure.
    expect(mockPair.mock.calls.length).toBeGreaterThan(1);
  });

  it('recovers when a transient pairing error clears on a later retry', async () => {
    jest.useFakeTimers();
    // Fail the first two attempts, then succeed — the route should navigate home
    // and never show the error screen.
    let call = 0;
    mockPair.mockImplementation(async () => {
      call += 1;
      mockAuthError = call < 3 ? 'Server is waking up or unreachable. Give it a moment and try again.' : null;
    });

    render(<E2ePairRoute />);

    await act(async () => {
      await jest.runAllTimersAsync();
    });

    expect(mockReplace).toHaveBeenCalledWith('/');
  });
});
