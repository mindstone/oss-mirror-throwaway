// mobile/src/components/SilentErrorBoundary.tsx
// Dedicated silent error boundary for "nice-to-have" UI surfaces
// (e.g. ConnectivityBanner) that should never crash the whole app shell.
//
// Why not reuse <ErrorBoundary>?
//   - ErrorBoundary renders a full-screen "Well, that wasn't supposed to happen."
//     fallback, which is catastrophic UX for a small banner.
//   - Wrapping <ConnectivityBannerConnected> in the main ErrorBoundary would also
//     hide the connectivity banner while the main app is recovering — which is
//     actually worse (the user is blind to connectivity issues during a crash).
//
// This boundary:
//   - Renders `null` (or a caller-provided fallback) on error.
//   - Reports the error to Sentry exactly once per mount.
//   - Allows retries via a monotonic `resetKey` prop.

import React from 'react';
import { mobileErrorReporter } from '../utils/sentry';

interface Props {
  children: React.ReactNode;
  /** Label attached to the Sentry report for diagnosis. */
  boundaryName: string;
  /** Optional fallback rendered when the inner tree has thrown. Defaults to `null`. */
  fallback?: React.ReactNode;
  /**
   * When this value changes, the boundary resets and re-renders its children.
   * Use sparingly — usually children render `null` gracefully, no reset needed.
   */
  resetKey?: string | number;
}

interface State {
  hasError: boolean;
  resetKey?: string | number;
}

export class SilentErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(nextProps: Props, prevState: State): Partial<State> | null {
    // Caller explicitly asked for a reset via monotonic resetKey change.
    if (prevState.resetKey !== nextProps.resetKey) {
      return { hasError: false, resetKey: nextProps.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    mobileErrorReporter.captureException(error, {
      extra: {
        source: 'silentErrorBoundary',
        boundaryName: this.props.boundaryName,
        componentStack: info.componentStack,
      },
    });
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
