// mobile/src/screens/PairScreen.tsx

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
  Image,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BlurView } from 'expo-blur';
import Animated, {
  FadeIn,
  FadeInDown,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '@rebel/cloud-client';
import { colors as darkColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { Pressable } from '../components/Pressable';
import { FloatingOrbs } from '../components/FloatingOrbs';
import { ParticleField } from '../components/ParticleField';
import { hapticSuccess } from '../utils/haptics';
import { tracking as analyticsTracking } from '../analytics/tracking';

/** Coarse, non-PII categorisation of a pairing failure for analytics. */
function classifyPairFailure(rawError: string): 'auth' | 'network' | 'unknown' {
  const normalized = rawError.toLowerCase();
  if (
    normalized.includes('401') ||
    normalized.includes('403') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('token')
  ) {
    return 'auth';
  }
  if (
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('timeout') ||
    normalized.includes('connect') ||
    normalized.includes('unreachable') ||
    normalized.includes('offline')
  ) {
    return 'network';
  }
  return 'unknown';
}

// PairScreen is shown before fonts are loaded (_layout.tsx gates on fontsLoaded
// for the main app, but PairScreen is rendered when !isPaired which happens
// *after* the font loading gate). So we can safely use `true`.
const typography = createTypography(true);
const MASCOT_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/rebel4.png';

type PairPayload = { v: number; type: string; cloudUrl: string; token: string };
type PairMode = 'scan' | 'manual';

function isValidPairPayload(data: unknown): data is PairPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    'v' in data &&
    (data as PairPayload).v === 1 &&
    'type' in data &&
    (data as PairPayload).type === 'rebel-pair' &&
    'cloudUrl' in data &&
    typeof (data as PairPayload).cloudUrl === 'string' &&
    'token' in data &&
    typeof (data as PairPayload).token === 'string'
  );
}

function humanizePairError(rawError: string): string {
  const normalized = rawError.toLowerCase();

  if (
    normalized.includes('401') ||
    normalized.includes('403') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('token')
  ) {
    return "That code didn't work. Try generating a fresh one in Settings.";
  }

  if (
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('timeout') ||
    normalized.includes('connect') ||
    normalized.includes('unreachable') ||
    normalized.includes('offline')
  ) {
    return "Couldn't reach your Rebel. Make sure it's running on your computer.";
  }

  return 'Something went wrong. Try again, or enter details manually.';
}

function createStyles(
  colors: ColorTokens,
  options: {
    isTablet: boolean;
    scannerSize: number;
    topInset: number;
    bottomInset: number;
  },
) {
  const { isTablet, scannerSize, topInset, bottomInset } = options;

  return StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0e' },
    scroll: { flex: 1 },
    scrollContent: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingTop: Math.max(topInset + 20, 28),
      paddingBottom: Math.max(bottomInset + 24, 28),
      paddingHorizontal: isTablet ? 32 : 20,
    },
    glassCard: {
      width: '100%',
      maxWidth: isTablet ? 480 : undefined,
      alignSelf: 'center',
      borderRadius: 28,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.12)',
    },
    glassCardIos: { backgroundColor: 'rgba(26, 26, 26, 0.34)' },
    glassCardAndroid: { backgroundColor: 'rgba(26, 26, 26, 0.92)' },
    glassOverlay: { backgroundColor: 'rgba(26, 26, 26, 0.56)' },
    content: {
      justifyContent: 'center',
      gap: 20,
      paddingHorizontal: isTablet ? 32 : 24,
      paddingVertical: isTablet ? 34 : 28,
      minHeight: isTablet ? 620 : undefined,
    },
    header: { alignItems: 'center', gap: 10 },
    mascot: { width: 80, height: 80 },
    title: {
      ...typography.display,
      color: colors.textPrimary,
      fontSize: isTablet ? 38 : 32,
      lineHeight: isTablet ? 44 : 38,
      textAlign: 'center',
    },
    subtitle: { ...typography.body, color: colors.textSecondary, textAlign: 'center' },
    scanContainer: { alignItems: 'center', gap: 14 },
    cameraFrame: {
      width: scannerSize,
      height: scannerSize,
      borderRadius: 24,
      overflow: 'hidden',
      borderWidth: 2,
      borderColor: 'rgba(139, 92, 246, 0.5)',
      backgroundColor: '#111111',
    },
    camera: { width: '100%', height: '100%' },
    scanHint: { ...typography.caption, color: colors.textTertiary, textAlign: 'center' },
    permissionContainer: { alignItems: 'center', gap: 12, paddingVertical: 8 },
    permissionBody: { ...typography.body, color: colors.textSecondary, textAlign: 'center' },
    noCameraBody: { ...typography.bodySmall, color: colors.textSecondary, textAlign: 'center' },
    manualContainer: { gap: 16 },
    manualTitle: { ...typography.headline, color: colors.textPrimary, textAlign: 'center' },
    inputGroup: { gap: 6 },
    label: { ...typography.bodySmall, fontWeight: '600', color: colors.textSecondary },
    input: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 14,
      ...typography.body,
      color: colors.textPrimary,
      borderWidth: 1,
      borderColor: colors.border,
    },
    button: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 14,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 50,
      marginTop: 8,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    buttonText: { ...typography.body, fontWeight: '600', color: '#fff' },
    manualLink: { alignSelf: 'center', paddingVertical: 2 },
    manualLinkText: { ...typography.bodySmall, color: colors.accent, textAlign: 'center' },
    backLink: { alignSelf: 'center', paddingVertical: 4 },
    backLinkText: { ...typography.bodySmall, color: colors.accent, textAlign: 'center' },
    validatingText: { ...typography.bodySmall, color: colors.textSecondary, textAlign: 'center' },
    errorBanner: {
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
      borderRadius: 10,
      padding: 12,
      borderWidth: 1,
      borderColor: 'rgba(239, 68, 68, 0.34)',
    },
    errorText: { ...typography.bodySmall, color: '#ef4444', textAlign: 'center' },
    scannerGlow: {
      position: 'absolute' as const,
      top: -2,
      left: -2,
      right: -2,
      bottom: -2,
      borderRadius: 26,
      borderWidth: 2,
      borderColor: colors.accent,
    },
    invalidQrBanner: {
      backgroundColor: 'rgba(245, 158, 11, 0.1)',
      borderRadius: 10,
      padding: 10,
      borderWidth: 1,
      borderColor: 'rgba(245, 158, 11, 0.3)',
    },
    invalidQrText: { ...typography.caption, color: '#f59e0b', textAlign: 'center' },
  });
}

export function PairScreen() {
  const { pair, isValidating, error, clearError } = useAuthStore();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const scannerSize = isTablet ? 320 : 260;
  const reducedMotion = useReducedMotion();
  const s = useMemo(
    () => createStyles(darkColors, { isTablet, scannerSize, topInset: insets.top, bottomInset: insets.bottom }),
    [isTablet, scannerSize, insets.top, insets.bottom],
  );
  const [mode, setMode] = useState<PairMode>('scan');
  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [mascotFailed, setMascotFailed] = useState(false);
  const [invalidQr, setInvalidQr] = useState(false);
  const invalidQrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cameraDeniedPermanently = permission !== null && !permission.granted && !permission.canAskAgain;

  // Clean up invalid QR timer on unmount
  useEffect(() => () => {
    if (invalidQrTimer.current) clearTimeout(invalidQrTimer.current);
  }, []);

  // Scanner border glow animation
  const glowOpacity = useSharedValue(0.5);
  useEffect(() => {
    if (mode === 'scan' && permission?.granted && !reducedMotion) {
      glowOpacity.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1000 }),
          withTiming(0.3, { duration: 1000 }),
        ),
        -1,
      );
    } else {
      cancelAnimation(glowOpacity);
      glowOpacity.value = 0.5;
    }
    return () => cancelAnimation(glowOpacity);
  }, [mode, permission?.granted, reducedMotion, glowOpacity]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const friendlyError = useMemo(
    () => (error ? humanizePairError(error) : null),
    [error],
  );

  const entering = useCallback(
    (delay: number) => (reducedMotion ? undefined : FadeInDown.duration(420).delay(delay)),
    [reducedMotion],
  );

  const handleBarCodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (scanned || isValidating) return;
      setScanned(true);
      try {
        const payload = JSON.parse(data);
        if (isValidPairPayload(payload)) {
          hapticSuccess();
          // Analytics: UI pairing lifecycle (client-origin; core only logs).
          // No cloudUrl / token in props — those are forbidden keys anyway.
          analyticsTracking.pair.started('scan');
          await pair(payload.cloudUrl, payload.token);
          const pairError = useAuthStore.getState().error;
          if (pairError) {
            analyticsTracking.pair.failed('scan', classifyPairFailure(pairError));
            setScanned(false);
          } else {
            analyticsTracking.pair.succeeded('scan');
          }
        } else {
          // Show invalid QR inline banner
          setInvalidQr(true);
          if (invalidQrTimer.current) clearTimeout(invalidQrTimer.current);
          invalidQrTimer.current = setTimeout(() => {
            setInvalidQr(false);
            setScanned(false);
          }, 3000);
          clearError();
        }
      } catch {
        clearError();
        setInvalidQr(true);
        if (invalidQrTimer.current) clearTimeout(invalidQrTimer.current);
        invalidQrTimer.current = setTimeout(() => {
          setInvalidQr(false);
          setScanned(false);
        }, 3000);
      }
    },
    [scanned, isValidating, pair, clearError],
  );

  const handleManualConnect = useCallback(() => {
    if (!urlInput.trim() || !tokenInput.trim()) return;
    // Analytics: UI pairing lifecycle (client-origin). Fire-and-forget; the
    // succeeded/failed event is emitted off the store's post-pair error.
    analyticsTracking.pair.started('manual');
    void (async () => {
      await pair(urlInput, tokenInput);
      const pairError = useAuthStore.getState().error;
      if (pairError) {
        analyticsTracking.pair.failed('manual', classifyPairFailure(pairError));
      } else {
        analyticsTracking.pair.succeeded('manual');
      }
    })();
  }, [urlInput, tokenInput, pair]);

  const switchToManual = useCallback(() => {
    clearError();
    setScanned(false);
    setMode('manual');
  }, [clearError]);

  const switchToScan = useCallback(() => {
    clearError();
    setScanned(false);
    setMode('scan');
  }, [clearError]);

  const renderScanMode = () => {
    if (permission === null) {
      return (
        <Animated.View entering={entering(160)} style={s.permissionContainer}>
          <ActivityIndicator color={darkColors.accent} size="small" />
          <Text style={s.permissionBody}>Checking your camera…</Text>
          <Pressable
            testID="pair-manual-toggle-button"
            style={s.manualLink}
            onPress={switchToManual}
          >
            <Text style={s.manualLinkText}>Camera not working? Enter details manually</Text>
          </Pressable>
        </Animated.View>
      );
    }

    if (!permission.granted && permission.canAskAgain) {
      return (
        <Animated.View entering={entering(160)} style={s.permissionContainer}>
          <Text style={s.permissionBody}>We need your camera to scan the pairing code. Nothing else.</Text>
          <Pressable
            testID="pair-camera-permission-button"
            style={s.button}
            onPress={requestPermission}
          >
            <Text style={s.buttonText}>Allow camera</Text>
          </Pressable>
          <Pressable
            testID="pair-manual-toggle-button"
            style={s.manualLink}
            onPress={switchToManual}
          >
            <Text style={s.manualLinkText}>Camera not working? Enter details manually</Text>
          </Pressable>
        </Animated.View>
      );
    }

    if (!permission.granted && !permission.canAskAgain) {
      return (
        <Animated.View entering={entering(160)} style={s.permissionContainer}>
          <Text style={s.noCameraBody}>
            Camera access was denied. You can change this in your device settings, or enter details manually.
          </Text>
          <Pressable
            testID="pair-manual-toggle-button"
            style={s.manualLink}
            onPress={switchToManual}
          >
            <Text style={s.manualLinkText}>Enter details manually</Text>
          </Pressable>
        </Animated.View>
      );
    }

    return (
      <Animated.View entering={entering(160)} style={s.scanContainer}>
        <View style={{ position: 'relative' }}>
          <View style={s.cameraFrame}>
            <CameraView
              testID="pair-qr-scanner"
              style={s.camera}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
            />
          </View>
          <Animated.View style={[s.scannerGlow, glowStyle]} pointerEvents="none" />
        </View>
        {invalidQr && (
          <Animated.View entering={reducedMotion ? undefined : FadeIn.duration(200)} style={s.invalidQrBanner}>
            <Text style={s.invalidQrText}>
              That&apos;s not a Rebel code. Try the one in your desktop Settings.
            </Text>
          </Animated.View>
        )}
        <Text style={s.scanHint}>Point at the QR code. We&apos;ll know.</Text>
        {isValidating && <Text style={s.validatingText}>Making the connection...</Text>}
        <Pressable
          testID="pair-manual-toggle-button"
          style={s.manualLink}
          onPress={switchToManual}
        >
          <Text style={s.manualLinkText}>Camera not working? Enter details manually</Text>
        </Pressable>
      </Animated.View>
    );
  };

  const renderManualMode = () => (
    <Animated.View entering={entering(160)} style={s.manualContainer}>
      <Text style={s.manualTitle}>Enter details manually</Text>
      <View style={s.inputGroup}>
        <Text style={s.label}>Server address</Text>
        <TextInput
          testID="pair-url-input"
          style={s.input}
          value={urlInput}
          onChangeText={(t) => {
            setUrlInput(t);
            clearError();
          }}
          placeholder="https://your-server-address"
          placeholderTextColor={darkColors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </View>
      <View style={s.inputGroup}>
        <Text style={s.label}>Pairing code</Text>
        <TextInput
          testID="pair-token-input"
          style={s.input}
          value={tokenInput}
          onChangeText={(t) => {
            setTokenInput(t);
            clearError();
          }}
          placeholder="Your pairing code"
          placeholderTextColor={darkColors.textTertiary}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <Pressable
        testID="pair-connect-button"
        style={[s.button, (!urlInput.trim() || !tokenInput.trim()) && s.buttonDisabled]}
        onPress={handleManualConnect}
        disabled={!urlInput.trim() || !tokenInput.trim() || isValidating}
      >
        {isValidating ? (
          <View style={s.buttonContent}>
            <ActivityIndicator color="#fff" size="small" />
            <Text style={s.buttonText}>Making the connection...</Text>
          </View>
        ) : (
          <Text style={s.buttonText}>Connect</Text>
        )}
      </Pressable>
      {!cameraDeniedPermanently && (
        <Pressable
          testID="pair-scan-toggle-button"
          style={s.backLink}
          onPress={switchToScan}
        >
          <Text style={s.backLinkText}>Back to scanner</Text>
        </Pressable>
      )}
    </Animated.View>
  );

  const cardContent = (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? Math.max(insets.top, 12) : 0}
      style={s.content}
    >
      <Animated.View entering={entering(0)} style={s.header}>
        {!mascotFailed && (
          <Image
            source={{ uri: MASCOT_URL }}
            style={s.mascot}
            onError={() => setMascotFailed(true)}
            accessibilityIgnoresInvertColors
          />
        )}
        <Text style={s.title}>Connect to your Rebel</Text>
        <Text style={s.subtitle}>
          Open Rebel on your computer, find the pairing code in Settings, and scan it here. That&apos;s it.
        </Text>
      </Animated.View>

      {friendlyError && (
        <Animated.View entering={entering(80)} testID="pair-error" style={s.errorBanner}>
          <Text style={s.errorText}>{friendlyError}</Text>
        </Animated.View>
      )}

      {mode === 'scan' ? renderScanMode() : renderManualMode()}
    </KeyboardAvoidingView>
  );

  return (
    <View style={s.container}>
      <StatusBar style="light" />
      <FloatingOrbs count={2} />
      <ParticleField count={isTablet ? 25 : 15} />

      <ScrollView
        testID="pair-screen"
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {Platform.OS === 'ios' ? (
          <BlurView tint="dark" intensity={40} style={[s.glassCard, s.glassCardIos]}>
            <View style={s.glassOverlay}>{cardContent}</View>
          </BlurView>
        ) : (
          <View style={[s.glassCard, s.glassCardAndroid]}>
            {cardContent}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
