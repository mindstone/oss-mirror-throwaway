/**
 * SilentErrorBoundary tests.
 *
 * Verifies that the boundary:
 *   - Renders children when no error.
 *   - Renders `null` (or fallback) when a child throws.
 *   - Reports errors to Sentry exactly once.
 *   - Re-renders children when `resetKey` changes.
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { Text } from 'react-native';

jest.mock('../utils/sentry', () => ({
  mobileErrorReporter: { captureException: jest.fn() },
}));

import { SilentErrorBoundary } from '../components/SilentErrorBoundary';
import { mobileErrorReporter } from '../utils/sentry';

// Throwing component for tests.
const Boom: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) throw new Error('intentional test error');
  return <Text>ok</Text>;
};

describe('SilentErrorBoundary', () => {
  // React error boundaries emit a big console.error by default; silence it.
  let consoleErrorSpy: jest.SpyInstance;
  beforeEach(() => {
    (mobileErrorReporter.captureException as jest.Mock).mockClear();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when no error', () => {
    const { queryByText } = render(
      <SilentErrorBoundary boundaryName="test">
        <Text>hello</Text>
      </SilentErrorBoundary>,
    );
    expect(queryByText('hello')).not.toBeNull();
  });

  it('renders null when a child throws, with no UI residue', () => {
    const { queryByText } = render(
      <SilentErrorBoundary boundaryName="test">
        <Boom shouldThrow={true} />
      </SilentErrorBoundary>,
    );
    expect(queryByText('ok')).toBeNull();
  });

  it('renders a caller-provided fallback when a child throws', () => {
    const { queryByText } = render(
      <SilentErrorBoundary
        boundaryName="test"
        fallback={<Text>fallback-rendered</Text>}
      >
        <Boom shouldThrow={true} />
      </SilentErrorBoundary>,
    );
    expect(queryByText('fallback-rendered')).not.toBeNull();
  });

  it('reports the error to Sentry with the boundary name', () => {
    render(
      <SilentErrorBoundary boundaryName="ConnectivityBanner">
        <Boom shouldThrow={true} />
      </SilentErrorBoundary>,
    );

    expect(mobileErrorReporter.captureException).toHaveBeenCalledTimes(1);
    const [err, context] = (mobileErrorReporter.captureException as jest.Mock).mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(context).toMatchObject({
      extra: {
        source: 'silentErrorBoundary',
        boundaryName: 'ConnectivityBanner',
      },
    });
  });

  it('re-renders children after resetKey changes', () => {
    const { queryByText, rerender } = render(
      <SilentErrorBoundary boundaryName="test" resetKey="v1">
        <Boom shouldThrow={true} />
      </SilentErrorBoundary>,
    );
    expect(queryByText('ok')).toBeNull();

    // Bump reset key and stop throwing
    rerender(
      <SilentErrorBoundary boundaryName="test" resetKey="v2">
        <Boom shouldThrow={false} />
      </SilentErrorBoundary>,
    );
    expect(queryByText('ok')).not.toBeNull();
  });
});
