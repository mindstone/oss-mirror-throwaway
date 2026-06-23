// mobile/src/components/ErrorBoundary.tsx
// React error boundary that catches JS rendering errors and shows a recovery screen.
// The boundary itself must be a class component (React requirement for error boundaries),
// but the fallback is rendered via a function component (ErrorFallback) so it can use
// the useColors() theme hook — otherwise the fallback hard-codes dark-theme hex and
// renders broken in light mode.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSessionStore, useInboxStore, useApprovalStore, useStagedFilesStore } from '@rebel/cloud-client';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';
import { useColors } from '../theme/colors';
import { mobileErrorReporter } from '../utils/sentry';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Themed recovery fallback. A function component so useColors() (light/dark) is available —
 * class error boundaries can't call hooks directly.
 */
function ErrorFallback({ onGoHome }: { onGoHome: () => void }) {
  const colors = useColors();
  return (
    <View testID="error-boundary-fallback" style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={styles.emoji}>😬</Text>
      <Text style={[styles.title, { color: colors.textPrimary }]}>
        Well, that wasn't supposed to happen.
      </Text>
      <Text style={[styles.subtitle, { color: colors.textTertiary }]}>
        Something broke. Let's start fresh.
      </Text>
      <TouchableOpacity
        style={[styles.button, { backgroundColor: colors.accent }]}
        onPress={onGoHome}
        activeOpacity={0.7}
      >
        <Text style={styles.buttonText}>Go Home</Text>
      </TouchableOpacity>
    </View>
  );
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    mobileErrorReporter.captureException(error, { extra: { componentStack: info.componentStack } });
  }

  private handleGoHome = () => {
    // Reset corrupted stores before navigating
    try {
      useSessionStore.getState().resetStore();
      useInboxStore.getState().resetStore();
      useApprovalStore.getState().resetStore();
      useStagedFilesStore.getState().resetStore();
      useActiveRecordingStore.getState().clearRecording();
    } catch { /* best effort during error recovery */ }
    this.setState({ hasError: false });
    router.replace('/');
  };

  render() {
    if (this.state.hasError) {
      return <ErrorFallback onGoHome={this.handleGoHome} />;
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 32,
  },
  button: {
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
  },
  buttonText: {
    // Accent button uses white text in both themes for contrast against the purple accent.
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
});
