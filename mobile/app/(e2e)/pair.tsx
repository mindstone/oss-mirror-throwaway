import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { createLogger, useAuthStore } from '@rebel/cloud-client';

const log = createLogger('e2ePairRoute');

type PairRouteParams = {
  cloudUrl?: string | string[];
  token?: string | string[];
  runId?: string | string[];
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function E2ePairRoute() {
  if (process.env.EXPO_PUBLIC_REBEL_E2E !== '1') {
    return <Redirect href="/" />;
  }

  return <E2ePairRouteInner />;
}

function E2ePairRouteInner() {
  const router = useRouter();
  const params = useLocalSearchParams<PairRouteParams>();
  const { pair } = useAuthStore();
  const hasStarted = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    const cloudUrl = firstParam(params.cloudUrl);
    const token = firstParam(params.token);
    const runId = firstParam(params.runId);

    if (!cloudUrl || !token) {
      const message = 'Missing E2E pairing parameters.';
      log.error(message, { hasCloudUrl: Boolean(cloudUrl), hasToken: Boolean(token), runId });
      setError(message);
      return;
    }

    void (async () => {
      // Bounded retry: the deep link fires immediately after a clearState launch,
      // so the FIRST pair() can lose a race against the network stack / local-
      // networking ATS warm-up and fail with a transient abort/timeout (surfaced
      // as "Server is waking up or unreachable"). The cloud is healthy — a short
      // retry resolves it. We only surface an error after exhausting attempts.
      const MAX_ATTEMPTS = 6;
      const RETRY_DELAY_MS = 1000;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await pair(cloudUrl, token);
          const pairError = useAuthStore.getState().error;
          if (!pairError) {
            router.replace('/');
            return;
          }
          if (attempt === MAX_ATTEMPTS) {
            log.error('E2E pairing failed', { error: pairError, runId, attempts: attempt });
            setError(pairError);
            return;
          }
          log.warn('E2E pairing attempt failed; retrying', { error: pairError, runId, attempt });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt === MAX_ATTEMPTS) {
            log.error('E2E pairing threw', { error: message, runId, attempts: attempt });
            setError(message);
            return;
          }
          log.warn('E2E pairing attempt threw; retrying', { error: message, runId, attempt });
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    })();
  }, [pair, params.cloudUrl, params.token, params.runId, router]);

  if (error) {
    return (
      <View style={styles.container}>
        <Text testID="e2e-pair-error" style={styles.errorText}>
          {error}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator testID="e2e-pair-loading" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errorText: {
    color: '#ef4444',
    textAlign: 'center',
  },
});
