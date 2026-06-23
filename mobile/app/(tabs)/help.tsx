// mobile/app/(tabs)/help.tsx

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Linking,
  ActivityIndicator,
  Switch,
  Share,
  Clipboard,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useLocalSearchParams } from 'expo-router';
import {
  useAuthStore,
  checkHealth,
  getSelfDiagnostics,
  getSettings,
  ipcCall,
  useOfflineQueueStore,
  QueueFullError,
  createLogger,
} from '@rebel/cloud-client';
import type { FeedbackRequest } from '@rebel/cloud-client';
import { useNetworkContext } from '../../src/context/NetworkContext';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import {
  DEFAULT_DIAGNOSTIC_SECTIONS,
  DIAGNOSTIC_SECTION_DESCRIPTORS,
  type DiagnosticSections,
  type SectionId,
} from '@shared/diagnostics/diagnosticBundleSections';
import { useColors, type ColorTokens } from '../../src/theme/colors';
import { createTypography } from '../../src/theme/typography';
import { useMobileVoiceRecording } from '../../src/hooks/useMobileVoiceRecording';
import { useActiveRecordingStore } from '../../src/stores/activeRecordingStore';
import { wipeAllAccountScopedState } from '../../src/services/accountScopedStateTeardown';

const typography = createTypography(true);
import { usePulseAnimation } from '../../src/hooks/usePulseAnimation';
import { hapticLight, hapticSuccess } from '../../src/utils/haptics';
import { gatherMobileDiagnostics } from '../../src/utils/mobileDiagnostics';
import { prepareDiagnosticSharePayload } from '../../src/utils/diagnosticExport';
import { MobileModelDownloadCard } from '../../src/components/MobileModelDownloadCard';

type FeedbackType = FeedbackRequest['feedbackType'];
type Urgency = FeedbackRequest['urgency'];
type VoiceField = 'message' | 'steps' | 'expected';

const FEEDBACK_TYPES: { value: FeedbackType; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'other', label: 'Something else' },
];

const URGENCY_OPTIONS: { value: Urgency; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const MAX_FEEDBACK_PREFILL_LENGTH = 5000;
const MAX_SERVER_CONTEXT_LENGTH = 100_000;

/** Hard cap (ms) for the optional server-context fetch so it can never delay or
 *  block durable persistence of the raw report (R2). */
const SERVER_CONTEXT_TIMEOUT_MS = 4000;

/**
 * Mint a UUID for client-side idempotency/grouping. Prefers the platform crypto
 * (available in this RN runtime — also used by submitTurnViaSocket / anonymousId);
 * falls back to a Math.random v4 (entropy sufficient for dedup/grouping, NOT
 * security-sensitive).
 */
function randomUuid(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** A 32-char lowercase-hex id (a v4 UUID with hyphens stripped) for use as a
 *  Sentry `event_id` — must be hex, NOT a dashed UUID (the cloud relay validates
 *  `/^[0-9a-f]{32}$/`). */
function mintHexEventId(): string {
  return randomUuid().replace(/-/g, '');
}

/** Reject after `ms` so an optional enrichment fetch can't hang the submit. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('enrichment timeout')), ms)),
  ]);
}

const feedbackLog = createLogger('helpFeedback');

const createDefaultDiagnosticSections = (): DiagnosticSections => ({ ...DEFAULT_DIAGNOSTIC_SECTIONS });

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    flex: { flex: 1 },
    container: { flex: 1, backgroundColor: colors.background },
    content: { paddingHorizontal: 16, paddingTop: 60, paddingBottom: 40 },
    title: { ...typography.title, fontSize: 28, fontWeight: '700', color: colors.textPrimary, marginBottom: 24 },
    identitySection: {
      alignItems: 'center',
      paddingVertical: 24,
      gap: 4,
      marginBottom: 8,
    },
    identityName: {
      ...typography.display,
      fontSize: 28,
      lineHeight: 34,
      color: colors.textPrimary,
    },
    identityTagline: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    identityVersion: {
      ...typography.caption,
      color: colors.textTertiary,
      marginTop: 4,
    },
    sectionOverline: {
      ...typography.overline,
      fontSize: 11,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
      marginTop: 8,
      marginBottom: 8,
      marginLeft: 4,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      marginBottom: 16,
      gap: 10,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    cardLabel: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
    },
    // Picker buttons
    pickerRow: { flexDirection: 'row', gap: 8 },
    pickerButton: {
      flex: 1,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
    },
    pickerButtonActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    pickerText: { ...typography.bodySmall, fontSize: 13, fontWeight: '600', color: colors.textSecondary },
    pickerTextActive: { color: '#fff' },
    // Form fields
    fieldHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 4,
    },
    fieldLabel: { ...typography.bodySmall, fontSize: 13, fontWeight: '600', color: colors.textSecondary },
    micButton: {
      width: 32,
      height: 32,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.border,
    },
    micButtonRecording: {
      backgroundColor: colors.errorLight,
      borderColor: '#ef4444',
    },
    textarea: {
      ...typography.body,
      backgroundColor: colors.background,
      borderRadius: 10,
      padding: 12,
      fontSize: 15,
      color: colors.textPrimary,
      minHeight: 100,
      borderWidth: 1,
      borderColor: colors.border,
    },
    textareaSmall: {
      ...typography.body,
      backgroundColor: colors.background,
      borderRadius: 10,
      padding: 12,
      fontSize: 15,
      color: colors.textPrimary,
      minHeight: 72,
      borderWidth: 1,
      borderColor: colors.border,
    },
    transcribingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 2,
    },
    transcribingText: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    // Submit button
    submitButton: {
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 4,
    },
    submitDisabled: { opacity: 0.4 },
    submitText: { ...typography.body, fontWeight: '600', color: '#fff' },
    // Diagnostics toggle
    diagnosticsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 4,
    },
    diagnosticsSubRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 4,
      paddingBottom: 2,
      marginLeft: 8,
    },
    diagnosticsTextCol: {
      flex: 1,
      marginRight: 12,
    },
    diagnosticsHint: {
      ...typography.caption,
      fontSize: 12,
      color: colors.textTertiary,
      marginTop: 2,
    },
    diagnosticsSectionList: {
      gap: 10,
      paddingTop: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    diagnosticsSectionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    diagnosticsSectionTitle: {
      ...typography.bodySmall,
      fontSize: 13,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    // Messages
    successContainer: {
      alignItems: 'center',
      paddingVertical: 20,
      gap: 10,
    },
    successIconCircle: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.success,
      alignItems: 'center',
      justifyContent: 'center',
    },
    successMessage: { ...typography.body, fontSize: 16, color: colors.success, fontWeight: '600', textAlign: 'center' },
    warningIconCircle: { backgroundColor: colors.warning },
    deliveryUnavailableHint: { ...typography.bodySmall, fontSize: 13, color: colors.textSecondary, textAlign: 'center', paddingHorizontal: 8 },
    copyReportButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 8,
      backgroundColor: colors.warningLight,
    },
    copyReportText: { ...typography.body, fontSize: 14, color: colors.accent, fontWeight: '600' },
    deliveryDismissText: { ...typography.bodySmall, fontSize: 13, color: colors.textSecondary, marginTop: 4 },
    errorMessage: { ...typography.bodySmall, fontSize: 13, color: colors.error },
    // Diagnostics export
    diagnosticsDescription: {
      ...typography.body,
      fontSize: 14,
      color: colors.textSecondary,
    },
    shareButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingVertical: 12,
    },
    shareButtonText: {
      ...typography.body,
      fontWeight: '600',
      color: '#fff',
      fontSize: 15,
    },
    // Community link
    communityLink: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    communityText: { ...typography.body, fontSize: 15, fontWeight: '600', color: colors.accent },
    externalArrow: { fontSize: 16, color: colors.accent },
    // Connection info
    connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    connectedDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.success,
    },
    connectionText: { ...typography.body, fontSize: 15, color: colors.textPrimary },
    connectionBold: { fontWeight: '600' },
    infoRow: { flexDirection: 'row', justifyContent: 'space-between' },
    infoLabel: { ...typography.body, fontSize: 15, color: colors.textSecondary },
    infoValue: { ...typography.body, fontSize: 15, color: colors.textPrimary },
    // Disconnect
    disconnectButton: {
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 16,
      borderWidth: 1,
      borderColor: colors.error,
    },
    disconnectText: { ...typography.body, fontWeight: '600', color: colors.error },
  });
}

export default function HelpScreen() {
  const { cloudUrl, unpair } = useAuthStore();
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const tabBarHeight = useBottomTabBarHeight();
  const deepLinkParams = useLocalSearchParams<{
    feedbackType?: string;
    description?: string;
    stepsToReproduce?: string;
    expectedBehavior?: string;
    urgency?: string;
    attachContinuityDiagnostics?: string;
  }>();
  const isMeetingRecording = useActiveRecordingStore((st) => st.isActive);

  const [isUnpairing, setIsUnpairing] = useState(false);

  // Connection info
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  // Feedback form state
  const [feedbackType, setFeedbackType] = useState<FeedbackType>('bug');
  const [urgency, setUrgency] = useState<Urgency>('medium');
  const [message, setMessage] = useState('');
  const [stepsToReproduce, setStepsToReproduce] = useState('');
  const [expectedBehavior, setExpectedBehavior] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The offline-queue item id for the just-submitted report, so we can watch it
  // for permanent delivery failure and surface the honest delivery-unavailable
  // state (R3). The retained payload backs the Copy-report fallback.
  const [reportItemId, setReportItemId] = useState<string | null>(null);
  const [deliveryUnavailableReport, setDeliveryUnavailableReport] = useState<FeedbackRequest | null>(null);
  // Watch ONLY the tracked report's permanent-failure flag. A delivered report
  // is removed from the queue (item gone → false → silent success, no toast); a
  // 422 / retry-exhausted report flips this true while its payload is retained.
  const trackedReportPermanentlyFailed = useOfflineQueueStore((st) =>
    reportItemId ? (st.items.find((i) => i.id === reportItemId)?.isPermanentFailure ?? false) : false,
  );
  const { isOnline } = useNetworkContext();
  const [localRecordingTriggerListening, setLocalRecordingTriggerListening] = useState(false);
  const [meetingToggleLoading, setMeetingToggleLoading] = useState(true);
  const [meetingToggleSaving, setMeetingToggleSaving] = useState(false);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [includeServerContext, setIncludeServerContext] = useState(false);
  const [diagnosticSections, setDiagnosticSections] = useState<DiagnosticSections>(() => createDefaultDiagnosticSections());

  // Diagnostics export state
  const [isExportingDiagnostics, setIsExportingDiagnostics] = useState(false);
  const [diagnosticExportError, setDiagnosticExportError] = useState<string | null>(null);

  const activeVoiceFieldRef = useRef<VoiceField>('message');
  const pendingVoiceFieldRef = useRef<VoiceField | null>(null);
  const waitingForFieldSwitchRef = useRef(false);
  const sawSwitchTranscribingRef = useRef(false);
  const switchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRecordingRef = useRef(false);
  const isTranscribingRef = useRef(false);

  useEffect(() => {
    let isCancelled = false;
    void (async () => {
      try {
        const settings = await getSettings();
        if (isCancelled || !settings || typeof settings !== 'object') return;

        const settingsRecord = settings as Record<string, unknown>;
        const meetingBot = (
          settingsRecord.meetingBot && typeof settingsRecord.meetingBot === 'object'
            ? settingsRecord.meetingBot as Record<string, unknown>
            : {}
        );

        const triggerPhrase = typeof meetingBot.triggerPhrase === 'string' ? meetingBot.triggerPhrase : null;
        const hasExplicitTriggerPhrase = !!triggerPhrase && triggerPhrase.trim().length > 0;
        const explicitToggle = typeof meetingBot.localRecordingTriggerListening === 'boolean'
          ? meetingBot.localRecordingTriggerListening
          : null;

        const resolvedToggle = explicitToggle ?? hasExplicitTriggerPhrase;
        setLocalRecordingTriggerListening(resolvedToggle);
      } catch {
        // Ignore load errors and keep defaults.
      } finally {
        if (!isCancelled) {
          setMeetingToggleLoading(false);
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  const handleLocalRecordingTriggerToggle = useCallback(async (enabled: boolean) => {
    if (meetingToggleSaving) return;

    const previousValue = localRecordingTriggerListening;
    setLocalRecordingTriggerListening(enabled);
    setMeetingToggleSaving(true);

    try {
      const settings = await getSettings();
      if (!settings || typeof settings !== 'object') {
        throw new Error('Missing settings payload');
      }

      const settingsRecord = settings as Record<string, unknown>;
      const currentMeetingBot = (
        settingsRecord.meetingBot && typeof settingsRecord.meetingBot === 'object'
          ? settingsRecord.meetingBot as Record<string, unknown>
          : {}
      );

      await ipcCall('settings:update', {
        ...settingsRecord,
        meetingBot: {
          ...currentMeetingBot,
          localRecordingTriggerListening: enabled,
        },
      });
    } catch {
      setLocalRecordingTriggerListening(previousValue);
      Alert.alert('Couldn’t update setting', 'Please try again.');
    } finally {
      setMeetingToggleSaving(false);
    }
  }, [localRecordingTriggerListening, meetingToggleSaving]);

  useEffect(() => {
    const toStringParam = (value: string | string[] | undefined): string | undefined => (
      Array.isArray(value) ? value[0] : value
    );

    const feedbackTypeParam = toStringParam(deepLinkParams.feedbackType);
    const descriptionParam = toStringParam(deepLinkParams.description);
    const stepsParam = toStringParam(deepLinkParams.stepsToReproduce);
    const expectedParam = toStringParam(deepLinkParams.expectedBehavior);
    const urgencyParam = toStringParam(deepLinkParams.urgency);
    const attachContinuityParam = toStringParam(deepLinkParams.attachContinuityDiagnostics);

    const hasAnyPrefill = Boolean(
      feedbackTypeParam
      || descriptionParam
      || stepsParam
      || expectedParam
      || urgencyParam
      || attachContinuityParam,
    );

    if (!hasAnyPrefill) return;

    if (feedbackTypeParam === 'bug' || feedbackTypeParam === 'improvement' || feedbackTypeParam === 'other') {
      setFeedbackType(feedbackTypeParam);
    }
    if (urgencyParam === 'low' || urgencyParam === 'medium' || urgencyParam === 'high' || urgencyParam === 'critical') {
      setUrgency(urgencyParam);
    }
    if (descriptionParam) {
      setMessage(descriptionParam.slice(0, MAX_FEEDBACK_PREFILL_LENGTH));
    }
    if (stepsParam) {
      setStepsToReproduce(stepsParam.slice(0, MAX_FEEDBACK_PREFILL_LENGTH));
    }
    if (expectedParam) {
      setExpectedBehavior(expectedParam.slice(0, MAX_FEEDBACK_PREFILL_LENGTH));
    }

    const shouldAttachContinuity = attachContinuityParam === '1' || attachContinuityParam === 'true';
    if (shouldAttachContinuity) {
      setIncludeDiagnostics(true);
      setIncludeServerContext(true);
    }
  }, [
    deepLinkParams.feedbackType,
    deepLinkParams.description,
    deepLinkParams.stepsToReproduce,
    deepLinkParams.expectedBehavior,
    deepLinkParams.urgency,
    deepLinkParams.attachContinuityDiagnostics,
  ]);

  const appendTranscript = useCallback((currentText: string, transcript: string) => {
    return currentText ? `${currentText} ${transcript}` : transcript;
  }, []);

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      const activeField = activeVoiceFieldRef.current;
      if (activeField === 'steps') {
        setStepsToReproduce((currentText) => appendTranscript(currentText, text));
        return;
      }

      if (activeField === 'expected') {
        setExpectedBehavior((currentText) => appendTranscript(currentText, text));
        return;
      }

      setMessage((currentText) => appendTranscript(currentText, text));
    },
    [appendTranscript],
  );

  const {
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    error: voiceError,
  } = useMobileVoiceRecording(handleVoiceTranscript);
  const pulseStyle = usePulseAnimation(isRecording);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    isTranscribingRef.current = isTranscribing;
  }, [isTranscribing]);

  const clearPendingFieldSwitch = useCallback(() => {
    pendingVoiceFieldRef.current = null;
    waitingForFieldSwitchRef.current = false;
    sawSwitchTranscribingRef.current = false;
    if (switchTimeoutRef.current) {
      clearTimeout(switchTimeoutRef.current);
      switchTimeoutRef.current = null;
    }
  }, []);

  const startRecordingForField = useCallback(
    (field: VoiceField) => {
      activeVoiceFieldRef.current = field;
      hapticLight();
      void startRecording();
    },
    [startRecording],
  );

  const startPendingField = useCallback(() => {
    const pendingField = pendingVoiceFieldRef.current;
    if (!pendingField) return;
    clearPendingFieldSwitch();
    startRecordingForField(pendingField);
  }, [clearPendingFieldSwitch, startRecordingForField]);

  const handleFieldMicPress = useCallback(
    (field: VoiceField) => {
      // Block voice recording when meeting recording is active
      if (isMeetingRecording) return;

      const currentField = activeVoiceFieldRef.current;

      if (isRecording) {
        if (currentField === field) {
          clearPendingFieldSwitch();
          stopRecording();
          return;
        }

        pendingVoiceFieldRef.current = field;
        waitingForFieldSwitchRef.current = true;
        sawSwitchTranscribingRef.current = false;
        if (switchTimeoutRef.current) {
          clearTimeout(switchTimeoutRef.current);
          switchTimeoutRef.current = null;
        }
        stopRecording();
        return;
      }

      if (isTranscribing) {
        pendingVoiceFieldRef.current = field;
        waitingForFieldSwitchRef.current = true;
        sawSwitchTranscribingRef.current = true;
        return;
      }

      clearPendingFieldSwitch();
      startRecordingForField(field);
    },
    [isMeetingRecording, isRecording, isTranscribing, clearPendingFieldSwitch, startRecordingForField, stopRecording],
  );

  useEffect(() => {
    if (!waitingForFieldSwitchRef.current || !pendingVoiceFieldRef.current) return;

    if (isTranscribing) {
      sawSwitchTranscribingRef.current = true;
      return;
    }

    if (isRecording) return;

    if (sawSwitchTranscribingRef.current) {
      startPendingField();
      return;
    }

    if (switchTimeoutRef.current) {
      clearTimeout(switchTimeoutRef.current);
      switchTimeoutRef.current = null;
    }

    switchTimeoutRef.current = setTimeout(() => {
      if (!waitingForFieldSwitchRef.current || !pendingVoiceFieldRef.current) return;
      if (isRecordingRef.current || isTranscribingRef.current) return;
      startPendingField();
    }, 250);

    return () => {
      if (switchTimeoutRef.current) {
        clearTimeout(switchTimeoutRef.current);
        switchTimeoutRef.current = null;
      }
    };
  }, [isRecording, isTranscribing, startPendingField]);

  useEffect(() => {
    return () => {
      if (switchTimeoutRef.current) {
        clearTimeout(switchTimeoutRef.current);
        switchTimeoutRef.current = null;
      }
    };
  }, []);

  const isFieldRecording = useCallback(
    (field: VoiceField) => isRecording && activeVoiceFieldRef.current === field,
    [isRecording],
  );

  useEffect(() => {
    checkHealth()
      .then((health) => {
        if (health.version) setServerVersion(health.version);
      })
      .catch(() => {
        // Health check failed — leave version unknown
      });
  }, []);

  // Auto-reset success state after 4 seconds so users can send another
  useEffect(() => {
    if (!submitSuccess) return;
    const timer = setTimeout(() => setSubmitSuccess(false), 4000);
    return () => clearTimeout(timer);
  }, [submitSuccess]);

  const handleUnpair = useCallback(() => {
    Alert.alert(
      'Disconnect',
      'This will unpair the app from your cloud instance. You can re-pair anytime.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            setIsUnpairing(true);
            await wipeAllAccountScopedState(cloudUrl, {
              reason: 'explicitDisconnect',
              clearOfflineQueue: true,
              unpair,
            });
          },
        },
      ],
    );
  }, [cloudUrl, unpair]);

  useEffect(() => {
    if (!includeDiagnostics || feedbackType !== 'bug') {
      setIncludeServerContext(false);
    }
  }, [includeDiagnostics, feedbackType]);

  const includedSectionCount = useMemo(
    () => DIAGNOSTIC_SECTION_DESCRIPTORS.filter((section) => diagnosticSections[section.id] !== false).length,
    [diagnosticSections],
  );

  const setDiagnosticSection = useCallback((sectionId: SectionId, enabled: boolean) => {
    setDiagnosticSections((current) => ({
      ...current,
      [sectionId]: enabled,
    }));
  }, []);

  const trimServerContext = useCallback((value: string): string => {
    if (value.length <= MAX_SERVER_CONTEXT_LENGTH) {
      return value;
    }
    return value.slice(0, MAX_SERVER_CONTEXT_LENGTH);
  }, []);

  const handleSubmitFeedback = useCallback(async () => {
    if (!message.trim()) return;

    setIsSubmitting(true);
    setSubmitError(null);
    // Clear any prior report's tracking/unavailable state for this fresh submit.
    setReportItemId(null);
    setDeliveryUnavailableReport(null);

    try {
      const mobilePlatform = Platform.OS === 'ios' ? 'ios' : 'android';
      // Client-minted idempotency keys persisted with the report and reused on
      // every retry: `eventId` (32-hex) → Sentry event_id (dedup on retry);
      // `clientReportId` → per-report fingerprint (each report its own issue).
      const payload: FeedbackRequest = {
        feedbackType,
        urgency,
        message: message.trim(),
        platform: mobilePlatform,
        appVersion: Constants.expoConfig?.version ?? undefined,
        clientReportId: randomUuid(),
        eventId: mintHexEventId(),
        ...(feedbackType === 'bug' && includeDiagnostics
          ? { diagnosticSections }
          : {}),
        ...(feedbackType === 'bug' && stepsToReproduce.trim()
          ? { stepsToReproduce: stepsToReproduce.trim() }
          : {}),
        ...(feedbackType === 'bug' && expectedBehavior.trim()
          ? { expectedBehavior: expectedBehavior.trim() }
          : {}),
      };

      // Best-effort enrichment — HARD-bounded so it can never delay or block the
      // durable persistence of the raw report (R2). The raw message/type/urgency
      // is always in the payload regardless of what enrichment completes.
      if (includeDiagnostics) {
        try {
          const diagnosticBundle = await gatherMobileDiagnostics({ diagnosticSections }); // already 5s-bounded
          if (diagnosticBundle) {
            payload.diagnostics = diagnosticBundle;
          }
        } catch (err) {
          // Diagnostics are strictly best-effort enrichment — submit without them
          // on failure/timeout. The raw report is already in the payload (R2).
          ignoreBestEffortCleanup(err, {
            operation: 'helpFeedback.gatherMobileDiagnostics',
            reason: 'diagnostics are optional enrichment; the raw report is captured regardless',
          });
        }
      }

      if (includeServerContext) {
        try {
          // getSelfDiagnostics is a normal cloud request (internal retries/timeout);
          // bound it so a slow/offline cloud can't stall the durable write.
          const serverContext = await withTimeout(
            getSelfDiagnostics({ include: diagnosticSections }),
            SERVER_CONTEXT_TIMEOUT_MS,
          );
          payload.serverContext = trimServerContext(JSON.stringify(serverContext));
        } catch (err) {
          // Server context is optional enrichment — submit without it on
          // failure/timeout. The raw report is already in the payload (R2).
          ignoreBestEffortCleanup(err, {
            operation: 'helpFeedback.getSelfDiagnostics',
            reason: 'server context is optional enrichment; the raw report is captured regardless',
          });
        }
      }

      // Persist-before-accept (R1): the report is durably written to the on-device
      // offline queue BEFORE we confirm to the user. The queue then drains
      // immediately when online (near-instant delivery) and retries with backoff
      // when offline / on transient failure — surviving app background/kill.
      const boundCloudUrl = useAuthStore.getState().cloudUrl ?? undefined;
      const item = await useOfflineQueueStore.getState().enqueueWithJsonPayloadOrThrow(
        'feedback',
        payload,
        { feedbackType, urgency },
        boundCloudUrl,
      );
      setReportItemId(item.id);
      hapticSuccess();
      setSubmitSuccess(true);
      setMessage('');
      setStepsToReproduce('');
      setExpectedBehavior('');
      setDiagnosticSections(createDefaultDiagnosticSections());
      // Kick an immediate best-effort drain so an online report delivers now
      // (and a permanent 422 surfaces while the receipt is still on screen)
      // rather than waiting for the next foreground/reconnect/periodic wake. The
      // queue's enqueue does NOT auto-drain; drain is internally guarded, never
      // rejects, and is fire-and-forget so it can't block the receipt.
      void useOfflineQueueStore.getState().drain(isOnline);
    } catch (err) {
      if (err instanceof QueueFullError) {
        // Even the durable save failed (queue at capacity). Honest, not a false receipt.
        setSubmitError("We couldn't save your report right now. Please try again, or copy it and contact us directly.");
      } else {
        setSubmitError('Something went wrong. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [feedbackType, urgency, message, stepsToReproduce, expectedBehavior, includeDiagnostics, includeServerContext, diagnosticSections, trimServerContext, isOnline]);

  // Load the retained report payload for the Copy-report fallback when the
  // tracked report permanently fails to deliver (R3 honest delivery-unavailable).
  useEffect(() => {
    if (!reportItemId || !trackedReportPermanentlyFailed) return;
    let cancelled = false;
    void useOfflineQueueStore
      .getState()
      .loadJsonPayload<FeedbackRequest>(reportItemId)
      .then((persisted) => {
        if (cancelled) return;
        if (persisted) {
          setDeliveryUnavailableReport(persisted);
        } else {
          // Observable, not silent: the delivery-unavailable card still renders
          // (gated on the permanent-failure flag, NOT on this load), but the
          // Copy-report action is unavailable because we couldn't read the
          // retained payload. The report itself is still on disk in the queue.
          feedbackLog.warn('Could not load retained feedback payload for Copy-report', { reportItemId });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        feedbackLog.warn('Error loading retained feedback payload for Copy-report', {
          reportItemId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reportItemId, trackedReportPermanentlyFailed]);

  const handleCopyReport = useCallback(() => {
    if (!deliveryUnavailableReport) return;
    hapticLight();
    const r = deliveryUnavailableReport;
    const lines = [r.message];
    if (r.stepsToReproduce) lines.push(`\nSteps to reproduce:\n${r.stepsToReproduce}`);
    if (r.expectedBehavior) lines.push(`\nExpected behavior:\n${r.expectedBehavior}`);
    Clipboard.setString(lines.join('\n'));
    Alert.alert('Copied', 'Your report is on the clipboard. Paste it to us directly or in the Rebels community.');
  }, [deliveryUnavailableReport]);

  const handleDismissDeliveryStatus = useCallback(() => {
    setReportItemId(null);
    setDeliveryUnavailableReport(null);
    setSubmitSuccess(false);
  }, []);

  const handleCommunityLink = useCallback(() => {
    Linking.openURL('https://rebels.mindstone.com');
  }, []);

  const handlePrivacyPolicyLink = useCallback(() => {
    Linking.openURL('https://mindstone.com/privacy-policy');
  }, []);

  const handleShareDiagnostics = useCallback(async () => {
    hapticLight();
    setIsExportingDiagnostics(true);
    setDiagnosticExportError(null);

    try {
      const payload = await prepareDiagnosticSharePayload();

      if (payload.zipUri) {
        try {
          await Share.share(
            Platform.OS === 'ios'
              ? { title: 'Mindstone Rebel Diagnostics', url: payload.zipUri }
              : {
                  title: 'Mindstone Rebel Diagnostics',
                  url: payload.zipUri,
                  message: 'Mindstone Rebel diagnostics bundle attached.',
                },
          );
          return;
        } catch {
          // Some targets reject file attachments; fallback to markdown body below.
        }
      }

      await Share.share({ message: payload.markdownFallback });
    } catch {
      setDiagnosticExportError('Failed to generate diagnostics. Please try again.');
    } finally {
      setIsExportingDiagnostics(false);
    }
  }, []);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={s.flex}
    >
      <ScrollView testID="help-screen" style={s.container} contentContainerStyle={[s.content, { paddingBottom: 40 + tabBarHeight }]}>
        {/* Rebel identity */}
        <View testID="help-identity-section" style={s.identitySection}>
          <Text style={s.identityName}>Rebel</Text>
          <Text style={s.identityTagline}>Your unreasonably capable assistant.</Text>
          <Text style={s.identityVersion}>
            v{Constants.expoConfig?.version ?? ''}
            {(() => {
              const build =
                Platform.OS === 'ios'
                  ? Constants.platform?.ios?.buildNumber
                  : Platform.OS === 'android'
                    ? Constants.platform?.android?.versionCode
                    : null;
              return build != null && build !== '' ? ` (${build})` : '';
            })()}
          </Text>
        </View>

        <Text style={s.title}>Settings</Text>

        {/* Voice section */}
        <Text style={s.sectionOverline}>Voice</Text>
        <MobileModelDownloadCard />

        {/* Meetings section */}
        <Text style={s.sectionOverline}>Meetings</Text>
        <View testID="help-meetings-section" style={s.card}>
          <View style={s.diagnosticsRow}>
            <View style={s.diagnosticsTextCol}>
              <Text style={s.fieldLabel}>Listen for trigger phrase during local recording</Text>
              <Text style={s.diagnosticsHint}>
                When on, saying &#39;hey [your trigger phrase]&#39; during local recordings asks Spark in your conversation.
              </Text>
            </View>
            <Switch
              testID="help-meetings-local-recording-trigger-switch"
              value={localRecordingTriggerListening}
              onValueChange={(value) => void handleLocalRecordingTriggerToggle(value)}
              disabled={meetingToggleLoading || meetingToggleSaving}
              thumbColor={localRecordingTriggerListening ? colors.accent : undefined}
            />
          </View>
        </View>

        {/* Feedback section */}
        <Text style={s.sectionOverline}>Feedback</Text>
        <View style={s.card}>
          <Text style={s.cardLabel}>Send Feedback</Text>

          {trackedReportPermanentlyFailed ? (
            <View testID="help-feedback-delivery-unavailable" style={s.successContainer}>
              <View style={[s.successIconCircle, s.warningIconCircle]}>
                <Feather name="alert-triangle" size={26} color="#fff" />
              </View>
              <Text style={s.successMessage}>
                Saved, but we couldn&apos;t reach the team yet
              </Text>
              <Text style={s.deliveryUnavailableHint}>
                Your report is safe on this device and Rebel will keep trying. If it&apos;s urgent, copy it and send it to us directly, or post it in the Rebels community.
              </Text>
              {deliveryUnavailableReport && (
                <TouchableOpacity
                  testID="help-feedback-copy-report-button"
                  style={s.copyReportButton}
                  onPress={handleCopyReport}
                  activeOpacity={0.7}
                >
                  <Feather name="copy" size={16} color={colors.accent} />
                  <Text style={s.copyReportText}>Copy report</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                testID="help-feedback-delivery-dismiss-button"
                onPress={handleDismissDeliveryStatus}
                activeOpacity={0.7}
              >
                <Text style={s.deliveryDismissText}>Back to feedback</Text>
              </TouchableOpacity>
            </View>
          ) : submitSuccess ? (
            <View testID="help-feedback-success" style={s.successContainer}>
              <View style={s.successIconCircle}>
                <Feather name="check" size={28} color="#fff" />
              </View>
              <Text style={s.successMessage}>
                Got it — your report is safe with Rebel, and on its way to the team.
              </Text>
            </View>
          ) : (
            <>
            {/* Type picker */}
            <View style={s.pickerRow}>
              {FEEDBACK_TYPES.map(({ value, label }) => (
                <TouchableOpacity
                  key={value}
                  testID={`help-feedback-type-${value}-button`}
                  style={[s.pickerButton, feedbackType === value && s.pickerButtonActive, isSubmitting && s.submitDisabled]}
                  onPress={() => setFeedbackType(value)}
                  disabled={isSubmitting}
                  activeOpacity={0.7}
                >
                  <Text style={[s.pickerText, feedbackType === value && s.pickerTextActive]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Urgency picker */}
            <Text style={s.fieldLabel}>Urgency</Text>
            <View style={s.pickerRow}>
              {URGENCY_OPTIONS.map(({ value, label }) => (
                <TouchableOpacity
                  key={value}
                  testID={`help-feedback-urgency-${value}-button`}
                  style={[s.pickerButton, urgency === value && s.pickerButtonActive, isSubmitting && s.submitDisabled]}
                  onPress={() => setUrgency(value)}
                  disabled={isSubmitting}
                  activeOpacity={0.7}
                >
                  <Text style={[s.pickerText, urgency === value && s.pickerTextActive]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

              {/* Description */}
              <View style={s.fieldHeader}>
                <Text style={s.fieldLabel}>Description</Text>
                <Animated.View
                  style={isFieldRecording('message') ? pulseStyle : undefined}
                >
                  <TouchableOpacity
                    testID="help-feedback-message-mic-button"
                    style={[s.micButton, isFieldRecording('message') && s.micButtonRecording, (isSubmitting || isMeetingRecording) && s.submitDisabled]}
                    onPress={() => handleFieldMicPress('message')}
                    disabled={isSubmitting || isMeetingRecording}
                    activeOpacity={0.7}
                    accessibilityLabel={
                      isMeetingRecording
                        ? 'Voice recording disabled — meeting recording in progress'
                        : isFieldRecording('message')
                          ? 'Stop recording description'
                          : 'Record description'
                    }
                  >
                    <Feather
                      name="mic"
                      size={16}
                      color={isFieldRecording('message') ? '#ef4444' : isMeetingRecording ? colors.textTertiary : colors.textSecondary}
                    />
                  </TouchableOpacity>
                </Animated.View>
              </View>
            <TextInput
              testID="help-feedback-message-input"
              style={[s.textarea, isSubmitting && s.submitDisabled]}
              placeholder="What happened?"
              placeholderTextColor={colors.textTertiary}
              value={message}
              onChangeText={setMessage}
              editable={!isSubmitting}
              multiline
              maxLength={5000}
              textAlignVertical="top"
            />

              {/* Bug-only fields */}
              {feedbackType === 'bug' && (
                <>
                  <View style={s.fieldHeader}>
                    <Text style={s.fieldLabel}>Steps to reproduce</Text>
                    <Animated.View
                      style={isFieldRecording('steps') ? pulseStyle : undefined}
                    >
                      <TouchableOpacity
                        testID="help-feedback-steps-mic-button"
                        style={[s.micButton, isFieldRecording('steps') && s.micButtonRecording, (isSubmitting || isMeetingRecording) && s.submitDisabled]}
                        onPress={() => handleFieldMicPress('steps')}
                        disabled={isSubmitting || isMeetingRecording}
                        activeOpacity={0.7}
                        accessibilityLabel={
                          isMeetingRecording
                            ? 'Voice recording disabled — meeting recording in progress'
                            : isFieldRecording('steps')
                              ? 'Stop recording reproduction steps'
                              : 'Record reproduction steps'
                        }
                      >
                        <Feather
                          name="mic"
                          size={16}
                          color={isFieldRecording('steps') ? '#ef4444' : isMeetingRecording ? colors.textTertiary : colors.textSecondary}
                        />
                      </TouchableOpacity>
                    </Animated.View>
                  </View>
                <TextInput
                  testID="help-feedback-steps-input"
                  style={[s.textareaSmall, isSubmitting && s.submitDisabled]}
                  placeholder="1. Go to… 2. Click on…"
                  placeholderTextColor={colors.textTertiary}
                  value={stepsToReproduce}
                  onChangeText={setStepsToReproduce}
                  editable={!isSubmitting}
                  multiline
                  maxLength={5000}
                  textAlignVertical="top"
                />
                  <View style={s.fieldHeader}>
                    <Text style={s.fieldLabel}>Expected behavior</Text>
                    <Animated.View
                      style={isFieldRecording('expected') ? pulseStyle : undefined}
                    >
                      <TouchableOpacity
                        testID="help-feedback-expected-mic-button"
                        style={[
                          s.micButton,
                          isFieldRecording('expected') && s.micButtonRecording,
                          (isSubmitting || isMeetingRecording) && s.submitDisabled,
                        ]}
                        onPress={() => handleFieldMicPress('expected')}
                        disabled={isSubmitting || isMeetingRecording}
                        activeOpacity={0.7}
                        accessibilityLabel={
                          isMeetingRecording
                            ? 'Voice recording disabled — meeting recording in progress'
                            : isFieldRecording('expected')
                              ? 'Stop recording expected behavior'
                              : 'Record expected behavior'
                        }
                      >
                        <Feather
                          name="mic"
                          size={16}
                          color={isFieldRecording('expected') ? '#ef4444' : isMeetingRecording ? colors.textTertiary : colors.textSecondary}
                        />
                      </TouchableOpacity>
                    </Animated.View>
                  </View>
                <TextInput
                  testID="help-feedback-expected-input"
                  style={[s.textareaSmall, isSubmitting && s.submitDisabled]}
                  placeholder="What should have happened?"
                  placeholderTextColor={colors.textTertiary}
                  value={expectedBehavior}
                  onChangeText={setExpectedBehavior}
                  editable={!isSubmitting}
                  multiline
                  maxLength={5000}
                  textAlignVertical="top"
                />
                </>
              )}

              {isTranscribing && (
                <View testID="help-feedback-transcribing-indicator" style={s.transcribingRow}>
                  <ActivityIndicator size="small" color={colors.textTertiary} />
                  <Text style={s.transcribingText}>Transcribing…</Text>
                </View>
              )}

              {/* Error display */}
              {voiceError && <Text testID="help-feedback-voice-error" style={s.errorMessage}>{voiceError}</Text>}
              {submitError && <Text testID="help-feedback-submit-error" style={s.errorMessage}>{submitError}</Text>}

              {/* Include diagnostics toggle */}
              <View testID="help-feedback-diagnostics-toggle" style={s.diagnosticsRow}>
                <View style={s.diagnosticsTextCol}>
                  <Text style={s.fieldLabel}>Include diagnostics</Text>
                  <Text style={s.diagnosticsHint}>Device info and recent logs to help us investigate</Text>
                </View>
                <Switch
                  value={includeDiagnostics}
                  onValueChange={setIncludeDiagnostics}
                  trackColor={{ false: colors.border, true: colors.accent }}
                  thumbColor="#fff"
                  disabled={isSubmitting}
                />
              </View>

              {feedbackType === 'bug' && includeDiagnostics && (
                <View testID="help-feedback-diagnostic-section-toggles" style={s.diagnosticsSectionList}>
                  <Text style={s.diagnosticsHint}>{includedSectionCount} of {DIAGNOSTIC_SECTION_DESCRIPTORS.length} sections included.</Text>
                  {DIAGNOSTIC_SECTION_DESCRIPTORS.map((section) => (
                    <View key={section.id} testID={`help-diagnostic-section-${section.id}`} style={s.diagnosticsSectionRow}>
                      <View style={s.diagnosticsTextCol}>
                        <Text style={s.diagnosticsSectionTitle}>{section.label}</Text>
                        <Text style={s.diagnosticsHint}>{section.description} {section.privacyHint}</Text>
                      </View>
                      <Switch
                        testID={`help-diagnostic-section-${section.id}-switch`}
                        value={diagnosticSections[section.id] !== false}
                        onValueChange={(enabled) => setDiagnosticSection(section.id, enabled)}
                        trackColor={{ false: colors.border, true: colors.accent }}
                        thumbColor="#fff"
                        disabled={isSubmitting}
                      />
                    </View>
                  ))}
                  <View testID="help-feedback-server-context-toggle" style={s.diagnosticsSubRow}>
                    <View style={s.diagnosticsTextCol}>
                      <Text style={s.fieldLabel}>Include server context</Text>
                      <Text style={s.diagnosticsHint}>Adds cloud continuity diagnostics from this device</Text>
                    </View>
                    <Switch
                      testID="help-feedback-server-context-switch"
                      value={includeServerContext}
                      onValueChange={setIncludeServerContext}
                      trackColor={{ false: colors.border, true: colors.accent }}
                      thumbColor="#fff"
                      disabled={isSubmitting}
                    />
                  </View>
                </View>
              )}

              {/* Submit button */}
              <TouchableOpacity
                testID="help-feedback-submit-button"
                style={[s.submitButton, (isSubmitting || !message.trim()) && s.submitDisabled]}
                onPress={handleSubmitFeedback}
                disabled={isSubmitting || !message.trim()}
                activeOpacity={0.7}
              >
                {isSubmitting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={s.submitText}>Send Feedback</Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Community card */}
        <View style={s.card}>
          <Text style={s.cardLabel}>Community</Text>
          <TouchableOpacity
            testID="help-community-link"
            style={s.communityLink}
            onPress={handleCommunityLink}
            activeOpacity={0.7}
          >
            <Text style={s.communityText}>Ask the Community</Text>
            <Text style={s.externalArrow}>↗</Text>
          </TouchableOpacity>
        </View>

        {/* Diagnostics export card */}
        <View style={s.card}>
          <Text style={s.cardLabel}>Diagnostics</Text>
          <Text style={s.diagnosticsDescription}>
            Share diagnostic info to help troubleshoot issues.
          </Text>
          <TouchableOpacity
            testID="help-share-diagnostics-button"
            style={[s.shareButton, isExportingDiagnostics && s.submitDisabled]}
            onPress={handleShareDiagnostics}
            disabled={isExportingDiagnostics}
            activeOpacity={0.7}
          >
            {isExportingDiagnostics ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Feather name="share" size={16} color="#fff" />
                <Text style={s.shareButtonText}>Share Diagnostics</Text>
              </>
            )}
          </TouchableOpacity>
          {diagnosticExportError && (
            <Text testID="help-diagnostics-export-error" style={s.errorMessage}>
              {diagnosticExportError}
            </Text>
          )}
        </View>

        {/* Privacy section — disclosure only (analytics is always-on, no toggle) */}
        <Text style={s.sectionOverline}>Privacy</Text>
        <View testID="help-privacy-section" style={s.card}>
          <Text style={s.cardLabel}>Usage data</Text>
          <Text style={s.diagnosticsDescription}>
            Rebel collects usage and diagnostic data — tied to your account — to see what&#39;s working
            and what&#39;s broken, so we can make the app better. Never any message content. This goes to
            our analytics provider, RudderStack, on our behalf.
          </Text>
          <TouchableOpacity
            testID="help-privacy-policy-link"
            style={s.communityLink}
            onPress={handlePrivacyPolicyLink}
            accessibilityRole="link"
            activeOpacity={0.7}
          >
            <Text style={s.communityText}>Privacy policy</Text>
            <Text style={s.externalArrow}>↗</Text>
          </TouchableOpacity>
        </View>

        {/* Connection info card */}
        <View style={s.card}>
          <Text style={s.cardLabel}>Connection</Text>
          <View testID="help-connection-status" style={s.connectionRow}>
            <View style={s.connectedDot} />
            <Text style={s.connectionText}>
              Connected to{' '}
              <Text style={s.connectionBold}>
                {cloudUrl?.replace(/^https?:\/\//, '') || 'unknown'}
              </Text>
            </Text>
          </View>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Platform</Text>
            <Text style={s.infoValue}>
              {Platform.OS} {Platform.Version}
            </Text>
          </View>
          {serverVersion && (
            <View style={s.infoRow}>
              <Text style={s.infoLabel}>Server version</Text>
              <Text style={s.infoValue}>{serverVersion}</Text>
            </View>
          )}
        </View>

        {/* Disconnect button */}
        <TouchableOpacity
          testID="help-disconnect-button"
          style={s.disconnectButton}
          onPress={handleUnpair}
          disabled={isUnpairing}
          activeOpacity={0.7}
        >
          <Text style={s.disconnectText}>
            {isUnpairing ? 'Disconnecting...' : 'Disconnect from cloud'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
