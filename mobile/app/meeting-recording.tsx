// mobile/app/meeting-recording.tsx

/**
 * Meeting Recording Bootstrap Screen.
 *
 * This is a thin router/bootstrapper — not a full UI screen.
 * On mount it either:
 *  1. Creates a new companion session, starts recording, and navigates to the conversation.
 *  2. If already recording, navigates to the existing companion conversation.
 *  3. If action=stop, stops the recording and navigates back.
 *
 * All recording UI now lives in the conversation screen via MeetingRecordingBanner.
 */

import { useEffect, useRef, useMemo } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useColors, type ColorTokens } from '../src/theme/colors';
import { useMeetingRecordingContext } from '../src/context/MeetingRecordingContext';
import { useActiveRecordingStore } from '../src/stores/activeRecordingStore';
import { createLogger } from '@rebel/cloud-client';

const log = createLogger('MeetingRecordingBootstrap');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateDefaultTitle(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `Meeting ${month}/${day} ${hours}:${minutes}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MeetingRecordingBootstrap() {
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; action?: string }>();
  const { state, isRecording, startRecording, stopRecording, companionSessionId } = useMeetingRecordingContext();
  const storeCompanionId = useActiveRecordingStore((s) => s.companionSessionId);
  const hasBootstrapped = useRef(false);
  const mountedRef = useRef(true);
  const stopHandled = useRef(false);
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // Handle action=stop from widget intent (one-shot)
    if (params.action === 'stop' && !stopHandled.current) {
      stopHandled.current = true;
      log.info('action=stop received');
      if (isRecording || state === 'starting') {
        stopRecording();
      }
      const timer = setTimeout(() => {
        if (!mountedRef.current) return;
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(tabs)');
        }
      }, 500);
      return () => clearTimeout(timer);
    }

    // Prevent double-bootstrap
    if (hasBootstrapped.current) return;

    if (state === 'idle') {
      // Not recording — start a new recording with a new companion session
      hasBootstrapped.current = true;
      const title = generateDefaultTitle();
      const newCompanionId = `companion-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      log.info('starting new recording', { title, companionId: newCompanionId });

      void startRecording(title, newCompanionId).then((started) => {
        if (!mountedRef.current) return;
        if (!started) {
          log.warn('recording did not start');
          hasBootstrapped.current = false;
          // Don't show Alert here — the hook already set the error state
          // which the error useEffect will display
          return;
        }
        log.info('recording started, navigating to companion', { companionId: newCompanionId });
        router.replace(`/conversation/${newCompanionId}`);
      }).catch((err) => {
        if (!mountedRef.current) return;
        log.warn('failed to start recording', { err: err instanceof Error ? err.message : String(err) });
        hasBootstrapped.current = false;
        Alert.alert('Recording Error', 'Failed to start recording. Please try again.');
      });
    } else if (state === 'recording' || state === 'rotating' || state === 'starting') {
      // Already recording — navigate to companion conversation
      hasBootstrapped.current = true;
      const cid = storeCompanionId || companionSessionId;
      log.info('already recording, navigating to companion', { cid, state });
      if (cid) {
        router.replace(`/conversation/${cid}`);
      } else {
        // No companion ID available — fallback to tabs
        log.warn('no companion session ID available, falling back to tabs');
        router.replace('/(tabs)');
      }
    }
    // For 'stopping' state, just show the spinner and wait
     
  }, [state, params.action]);

  // Show error from recording context
  const { error } = useMeetingRecordingContext();
  useEffect(() => {
    if (error) {
      Alert.alert('Recording Error', error);
    }
  }, [error]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.textSecondary} />
      <Text style={styles.text}>Starting recording…</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: colors.background,
      gap: 16,
    },
    text: {
      fontSize: 16,
      color: colors.textSecondary,
    },
  });
}
