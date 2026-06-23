// mobile/app/conversation/[id].tsx
// @device-scoped: voice-mode preference is a local interaction setting, not account content.

import { useEffect, useCallback, useRef, useState, useMemo, memo } from 'react';
import {
  ActionSheetIOS,
  View,
  Text,
  Image,
  FlatList,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Share,
  Clipboard,
  NativeSyntheticEvent,
  NativeScrollEvent,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import {
  useSessionStore,
  useSessionConflictStore,
  useAgentTurn,
  useDraftPreservingSend,
  useSmoothStream,
  useOfflineQueueStore,
  useUserQuestions,
  mergeUserQuestionEvents,
  ipcCall,
  type UserQuestionSubmitRequest,
  type UserQuestionSubmitResponse,
  QueueFullError,
  patchSession,
  updateSession,
  getSettings,
  COUNCIL_REVIEW_PROMPT,
  isCouncilReviewAvailable,
  selectVisibleMessages,
  extractMissionFromEvents,
  extractTasksFromEvents,
  extractSubAgentItems,
  parseIndividualTaskIdFromDetail,
  type SessionMessage,
  type SessionToolEvent,
  type QueueItem,
  type WebFileAttachment,
  type CloudMeetingSessionId,
  createLogger,
  SessionNeedsReconcileError,
} from '@rebel/cloud-client';
import type { AnyAttachmentPayload } from '@shared/types/agent';
import type { MeetingCompanionTriggerMeta } from '@shared/types';
import { buildCompanionTurnPrompt } from '@core/services/meetingTriggerDetector/buildCompanionTurnPrompt';
import { asyncStoragePersistence } from '../../src/storage/asyncStoragePersistence';
import { UserQuestionCard, MinimizedQuestionPill } from '../../src/components/UserQuestionCard';
import { createMarkdownLinkHandler, isSessionDone } from '@rebel/shared';
import { parseNavigationUrl } from '@shared/navigation/urlParser';
import { isBackgroundConversationSession } from '@shared/sessionKind';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const log = createLogger('conversation');

/**
 * Re-enqueue a send-and-done prompt into the offline queue. Used when a
 * detached send-and-done turn fails (pre-ack, or post-ack with a tombstoned
 * session) and the user has already navigated away — the queue then drains it
 * through the existing affordances (failed chip / recreate-on-tombstone) so the
 * message is never silently lost. The server never produced a usable result in
 * these cases, so re-running is safe.
 */
function reenqueueSendAndDonePrompt(params: {
  sessionId: string;
  prompt: string;
  attachments?: WebFileAttachment[];
  meetingSessionId?: CloudMeetingSessionId;
  recordingActive?: boolean;
  logLabel: string;
}): void {
  const { sessionId, prompt, attachments, meetingSessionId, recordingActive, logLabel } = params;
  try {
    const queue = useOfflineQueueStore.getState();
    if (attachments && attachments.length > 0) {
      void queue.enqueueWithJsonPayloadOrThrow(
        'text-with-attachments',
        { prompt, attachments },
        { sessionId, prompt, attachmentCount: attachments.length, meetingSessionId, recordingActive },
      ).catch((err) => {
        log.error(`Failed to enqueue ${logLabel} fallback (with attachments)`, { err: err instanceof Error ? err.message : String(err) });
      });
    } else {
      void queue.enqueueOrThrow(
        'text-message',
        null,
        null,
        { sessionId, prompt, meetingSessionId, recordingActive },
      ).catch((err) => {
        log.error(`Failed to enqueue ${logLabel} fallback (text)`, { err: err instanceof Error ? err.message : String(err) });
      });
    }
  } catch (err) {
    log.error(`${logLabel} draft writeback failed`, { err: err instanceof Error ? err.message : String(err) });
  }
}
import Markdown, { MarkdownIt } from '@ronradtke/react-native-markdown-display';
import { useColors, type ColorTokens } from '../../src/theme/colors';
import { createTypography } from '../../src/theme/typography';
import { createMarkdownStyles } from '../../src/theme/markdownStyles';
import { hapticLight, hapticHeavy, hapticSuccess } from '../../src/utils/haptics';
import { tracking as analyticsTracking } from '../../src/analytics/tracking';
import { QUEUE_FULL_USER_MESSAGE, queueToastCopy } from '../../src/utils/queueCopy';
import { checkSufficientDiskSpace } from '../../src/utils/diskSpace';
import { useNetworkContext } from '../../src/context/NetworkContext';

const typography = createTypography(true);
const conversationMarkdownIt = MarkdownIt({ typographer: true });
// Mobile link dispatcher (createMarkdownLinkHandler) is stricter than markdown-it's
// built-in validator (it blocks every scheme except http(s)://, library://, workspace://,
// rebel://, file://, and relative paths). Widen validateLink so non-http schemes reach
// the dispatcher instead of being silently filtered here.
//
// IMPORTANT: validateLink also controls IMAGE parsing in markdown-it. Widening it means
// `![x](library://foo.png)` now produces an image node. We handle that via the
// `allowedImageHandlers` + `defaultImageHandler={null}` props on the <Markdown> component
// (see renders below) so unsupported image schemes render as nothing rather than making a
// bogus https://library://foo.png network request. Link-scheme blocking is handled by
// the dispatcher's onBlocked → showToast path.
conversationMarkdownIt.validateLink = () => true;
import { Pressable } from '../../src/components/Pressable';
import { useMobileVoiceRecording } from '../../src/hooks/useMobileVoiceRecording';
import {
  setVoiceTranscriptListener,
  clearVoiceTranscriptListener,
  setVoiceQueueCompletionListener,
  clearVoiceQueueCompletionListener,
} from '../../src/hooks/useVoiceQueueConsumer';
import {
  setTextQueueCompletionListener,
  clearTextQueueCompletionListener,
} from '../../src/hooks/useTextQueueConsumer';
import {
  setTextAttachmentsQueueCompletionListener,
  clearTextAttachmentsQueueCompletionListener,
} from '../../src/hooks/useTextAttachmentsQueueConsumer';
import { useMobileAudioPlayback } from '../../src/hooks/useMobileAudioPlayback';
import { useMobileFileAttachments } from '../../src/hooks/useMobileFileAttachments';
import { AgentActivityBubble } from '../../src/components/AgentActivityBubble';
import { ConversationApprovalBanner } from '../../src/components/ConversationApprovalBanner';
import { ConversationFeedbackPrompt } from '../../src/components/ConversationFeedbackPrompt';
import { FileViewerModal } from '../../src/components/FileViewerModal';
import { MeetingRecordingBanner, type TranscriptStatus } from '../../src/components/MeetingRecordingBanner';
import { AskSparkPicker, type AskSparkPickerSubtitleVariant } from '../../src/components/AskSparkPicker';
import { useFileViewer } from '../../src/hooks/useFileViewer';
import { sendAndDoneInBackground, type SendAndDoneTerminalFailure } from '../../src/utils/sendAndDone';
import { TurnToolActivity } from '../../src/components/TurnToolActivity';
import { TurnSeparator } from '../../src/components/TurnSeparator';
import { Skeleton } from '../../src/components/Skeleton';
import { ListeningGlow } from '../../src/components/ListeningGlow';
import { FloatingOrbs } from '../../src/components/FloatingOrbs';
import { SlackContextChip } from '../../src/components/SlackContextChip';
import { FinishLineChip } from '../../src/components/FinishLineChip';
import { FinishLineEditorSheet } from '../../src/components/FinishLineEditorSheet';
import { SilentErrorBoundary } from '../../src/components/SilentErrorBoundary';
import { usePulseAnimation } from '../../src/hooks/usePulseAnimation';
import { QueuedMessageChip, type QueuedMessageChipState } from '../../src/components/QueuedMessageChip';
import { useActiveRecordingStore } from '../../src/stores/activeRecordingStore';
import { useMeetingRecordingContext } from '../../src/context/MeetingRecordingContext';
import { useMeetingHealthIndicator, type MeetingHealthStatus } from '../../src/hooks/useMeetingHealthIndicator';
import { useExternalContextForMobileSession } from '../../src/hooks/useExternalContextForMobileSession';
import { useMeetingTriggerHeard } from '../../src/hooks/useMeetingTriggerHeard';
import { MeetingTurnSpeakerAttribution } from '../../src/components/MeetingTurnSpeakerAttribution';

const VOICE_MODE_PREF_KEY = 'rebel_voice_mode_preferred';

const IDLE_QUIPS = [
  "What's on your mind?",
  'I\'m all ears. Figuratively.',
  'Ready for anything. Almost.',
  'Standing by. Impress me.',
  'Your move.',
];

function pickIdleQuip(): string {
  return IDLE_QUIPS[Math.floor(Math.random() * IDLE_QUIPS.length)];
}

interface ConversationMessage extends SessionMessage {
  isQueued?: boolean;
  isPermanentFailure?: boolean;
  lastError?: string;
  queueItemStatus?: string;
}

interface QueuedTextPreview {
  itemId: string;
  text: string;
  enqueuedAt: number;
  isPermanentFailure?: boolean;
  lastError?: string;
  status?: string;
  triggerMeta?: MeetingCompanionTriggerMeta;
}

function formatConflictAgeShort(detectedAt: number): string {
  const deltaMs = Math.max(0, Date.now() - detectedAt);
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatConflictFieldLabel(field: string): string {
  if (field === 'doneAt') return 'done';
  if (field === 'starredAt') return 'starred';
  if (field === 'privateMode') return 'private mode';
  if (field === 'meetingCompanion') return 'meeting companion';
  if (field === 'finishLine') return 'finish line';
  return field.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function describeConflictFields(fields: string[]): string {
  if (fields.length === 0) return 'Session metadata changed on another device.';
  return `Changed elsewhere: ${fields.map(formatConflictFieldLabel).join(', ')}`;
}

function createMessageBubbleStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { paddingHorizontal: 12, paddingVertical: 4 },
    userContainer: { alignItems: 'flex-end' },
    assistantContainer: { alignItems: 'flex-start' },
    bubble: { maxWidth: '85%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
    userBubble: { backgroundColor: colors.accent },
    assistantBubble: { backgroundColor: colors.surface },
    text: { ...typography.body, fontSize: 15, lineHeight: 22 },
    userText: { color: '#fff' },
    assistantText: { color: colors.textPrimary },
    time: { ...typography.caption, fontSize: 11, color: colors.textTertiary, marginTop: 2, marginHorizontal: 4 },
    queuedIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 4,
      marginHorizontal: 4,
    },
    queuedIndicatorText: {
      ...typography.caption,
      fontSize: 11,
      color: colors.textTertiary,
    },
  });
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    messagesList: { flex: 1, minHeight: 0 },
    messages: { paddingTop: 12, paddingBottom: 8 },
    // When there are no messages, let the content container fill the list
    // viewport so the FlatList behaves identically to the populated state under
    // the keyboard: it yields/scrolls space (so the docked input/send bar is
    // never pushed off-screen) and gives keyboardDismissMode="interactive" a
    // surface to drag against. Without flexGrow the empty content collapses to
    // its intrinsic height and the keyboard-avoidance path mis-sizes — the
    // root cause of the new-conversation send-button occlusion (REBEL-6BP).
    messagesEmpty: { flexGrow: 1 },
    slackContextHeader: {
      paddingHorizontal: 12,
      paddingTop: 2,
      paddingBottom: 8,
    },
    pendingIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    feedbackPromptSlot: {
      paddingTop: 8,
      paddingBottom: 4,
    },
    pendingIndicatorText: {
      ...typography.caption,
      fontSize: 12,
      color: colors.textTertiary,
    },
    toast: {
      position: 'absolute',
      bottom: 100,
      alignSelf: 'center',
      backgroundColor: colors.surface,
      borderRadius: 16,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
      zIndex: 1000,
    },
    toastText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    headerConflictBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.warning,
      backgroundColor: `${colors.warning}20`,
    },
    headerConflictText: {
      ...typography.caption,
      fontSize: 11,
      fontWeight: '600',
      color: colors.warning,
    },
    emptyText: { ...typography.body, fontSize: 15, color: colors.textSecondary },
    errorText: { ...typography.body, fontSize: 15, color: '#ef4444', textAlign: 'center', marginBottom: 12 },
    retryButton: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
    retryText: { ...typography.body, fontSize: 15, fontWeight: '600', color: '#fff' },
    composerAccessories: { flexShrink: 1 },
    inputBar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 12,
      paddingVertical: 8,
      paddingBottom: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
      gap: 8,
    },
    input: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 10,
      ...typography.body,
      fontSize: 15,
      color: colors.textPrimary,
      maxHeight: 100,
      borderWidth: 1,
      borderColor: colors.border,
    },
    sendButton: {
      backgroundColor: colors.accent,
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    sendDisabled: { opacity: 0.4 },
    sendText: { ...typography.body, fontSize: 15, fontWeight: '600', color: '#fff' },
    stopButton: {
      backgroundColor: '#ef4444',
      borderRadius: 20,
      width: 40,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
    },
    stopIcon: {
      width: 14,
      height: 14,
      backgroundColor: '#fff',
      borderRadius: 2,
    },
    scrollToBottomButton: {
      position: 'absolute',
      right: 16,
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 3,
    },
    micButton: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      width: 40,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    micButtonRecording: {
      backgroundColor: colors.errorLight,
      borderColor: '#ef4444',
    },
    voiceFirstBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 12,
      paddingVertical: 16,
      paddingBottom: 20,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
      gap: 16,
    },
    voiceFirstBarActive: {
      borderTopColor: colors.success,
      backgroundColor: `${colors.success}0D`,
    },
    voiceBarCenter: {
      flex: 1,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 16,
    },
    voiceBarSpacer: {
      width: 32,
    },
    voiceMicLarge: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.accent,
      justifyContent: 'center',
      alignItems: 'center',
    },
    voiceMicLargeRecording: {
      backgroundColor: '#ef4444',
    },
    voiceHintText: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textTertiary,
      textAlign: 'center',
    },
    voiceHintRecordingText: {
      ...typography.bodySmall,
      fontSize: 13,
      color: '#ef4444',
      fontWeight: '600',
      textAlign: 'center',
    },
    keyboardButton: {
      padding: 8,
      borderRadius: 8,
    },
    voiceStopButtonLarge: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: '#ef4444',
      justifyContent: 'center',
      alignItems: 'center',
    },
    voiceStopIcon: {
      width: 20,
      height: 20,
      backgroundColor: '#fff',
      borderRadius: 3,
    },
    voiceTranscribingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      padding: 16,
    },
    voiceTranscribingText: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textSecondary,
    },
    voiceError: {
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    voiceErrorText: {
      ...typography.caption,
      color: colors.error,
    },
    voiceRecordingContainer: {
      gap: 12,
    },
    voiceRecordingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    voiceRecordingActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingLeft: 76, // 64px mic button + 12px gap
    },
    voiceEditAction: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 10,
      paddingHorizontal: 8,
    },
    voiceEditActionText: {
      ...typography.bodySmall,
      fontSize: 14,
      color: colors.textSecondary,
    },
    voiceSendAndDoneAction: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      paddingVertical: 10,
      paddingHorizontal: 8,
    },
    voiceSendAndDoneText: {
      ...typography.bodySmall,
      fontSize: 14,
      color: colors.success,
      fontWeight: '600' as const,
    },
    voiceActionPill: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 20,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    voiceActionPillText: {
      ...typography.bodySmall,
      fontSize: 13,
      fontWeight: '600' as const,
      color: colors.textSecondary,
    },
    voiceActionPillSuccess: {
      borderColor: colors.success,
      backgroundColor: colors.successLight,
    },
    voiceActionPillSuccessText: {
      color: colors.success,
    },
    emptyStateContainer: {
      // flexGrow (not flex/minHeight) so the empty state fills the list
      // viewport WITHOUT establishing a rigid intrinsic floor that the
      // keyboard-avoidance path can't shrink below. Paired with the
      // `messagesEmpty` content-container style (flexGrow:1) on the FlatList.
      // See REBEL-6BP — a rigid `minHeight: 240` here fought the keyboard
      // shrink and contributed to the send button being occluded on a new
      // conversation.
      flexGrow: 1,
      position: 'relative' as const,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
      paddingHorizontal: 32,
      paddingVertical: 40,
    },
    emptyStateContent: {
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
    },
    emptyStateQuip: {
      ...typography.body,
      fontSize: 16,
      color: colors.textSecondary,
      textAlign: 'center' as const,
    },
    attachButton: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      width: 40,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    attachButtonDisabled: {
      opacity: 0.4,
    },
    attachmentStrip: {
      flexDirection: 'row',
      paddingHorizontal: 12,
      paddingVertical: 6,
      gap: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
    },
    thumbnailContainer: {
      width: 56,
      height: 56,
      borderRadius: 8,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
      justifyContent: 'center',
      alignItems: 'center',
    },
    thumbnailImage: {
      width: 56,
      height: 56,
      borderRadius: 8,
    },
    thumbnailRemove: {
      position: 'absolute',
      top: -4,
      right: -4,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: colors.textSecondary,
      justifyContent: 'center',
      alignItems: 'center',
    },
    thumbnailName: {
      fontFamily: typography.caption.fontFamily,
      fontSize: 8,
      color: colors.textSecondary,
      textAlign: 'center',
      marginTop: 2,
      paddingHorizontal: 2,
    },
    attachError: {
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    attachErrorText: {
      ...typography.caption,
      color: colors.error,
    },
    voiceModeToggle: {
      padding: 10,
      borderRadius: 20,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    voiceModeToggleActive: {
      backgroundColor: colors.success,
      borderColor: colors.success,
    },
    voiceModeLabel: {
      position: 'absolute' as const,
      left: 0,
      right: 0,
      top: -28,
      alignItems: 'center' as const,
    },
    voiceModeLabelText: {
      ...typography.caption,
      fontSize: 11,
      color: colors.textSecondary,
      backgroundColor: colors.surface,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 8,
      overflow: 'hidden' as const,
      borderWidth: 1,
      borderColor: colors.border,
    },
    voiceModeLabelTextActive: {
      color: colors.success,
      borderColor: colors.success,
    },
    ttsError: {
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    ttsErrorText: {
      ...typography.caption,
      color: colors.error,
    },
  });
}

const MessageBubble = memo(function MessageBubble({
  message,
  onLongPress,
  onLinkPress,
  isQueued = false,
  isPermanentFailure = false,
  lastError,
  queueItemStatus,
}: {
  message: SessionMessage;
  onLongPress: () => void;
  onLinkPress?: (url: string) => boolean;
  isQueued?: boolean;
  isPermanentFailure?: boolean;
  lastError?: string;
  queueItemStatus?: string;
}) {
  const colors = useColors();
  const mb = useMemo(() => createMessageBubbleStyles(colors), [colors]);
  const mdStyles = useMemo(() => createMarkdownStyles(colors), [colors]);

  const isUser = message.role === 'user';
  if (message.isHidden) return null;

  const chipState: QueuedMessageChipState | null = isQueued
    ? isPermanentFailure
      ? 'failed'
      : queueItemStatus === 'processing'
        ? 'sending'
        : 'waiting'
    : null;

  return (
    <View style={[mb.container, isUser ? mb.userContainer : mb.assistantContainer]}>
      <TouchableOpacity activeOpacity={0.8} onLongPress={onLongPress} delayLongPress={240}>
        <View style={[mb.bubble, isUser ? mb.userBubble : mb.assistantBubble]}>
          {isUser ? (
            <Text style={[mb.text, mb.userText]}>{message.text ?? ''}</Text>
          ) : (
            <Markdown
              onLinkPress={onLinkPress}
              style={mdStyles}
              markdownit={conversationMarkdownIt}
              defaultImageHandler={null}
            >{message.text ?? ''}</Markdown>
          )}
        </View>
      </TouchableOpacity>
      <MeetingTurnSpeakerAttribution message={message} />
      <Text style={mb.time}>
        {new Date(message.createdAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </Text>
      {chipState && (
        <View testID="conversation-message-queued-indicator" style={mb.queuedIndicator}>
          <QueuedMessageChip state={chipState} errorMessage={lastError} />
        </View>
      )}
    </View>
  );
});



export default function ConversationScreen() {
  const { id, initialPrompt, autoRecord, compose, prefill } = useLocalSearchParams<{ id: string; initialPrompt?: string; autoRecord?: string; compose?: string; prefill?: string }>();
  const isBackgroundSession = isBackgroundConversationSession(id);
  const router = useRouter();
  const { isOnline } = useNetworkContext();
  const currentSession = useSessionStore((s) => s.currentSession);
  const finishLine = useSessionStore((s) => s.currentSession?.finishLine);
  const isLoadingSession = useSessionStore((s) => s.isLoadingSession);
  const sessionError = useSessionStore((s) => s.error);
  const sessionConflict = useSessionConflictStore((s) => (id ? s.conflictsBySessionId[id] ?? null : null));
  const dismissSessionConflict = useSessionConflictStore((s) => s.dismissSessionConflict);
  const queueFullAt = useOfflineQueueStore((s) => s.queueFullAt);
  const [input, setInput] = useState('');
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [askSparkPickerVisible, setAskSparkPickerVisible] = useState(false);
  const [isFinishLineEditorOpen, setIsFinishLineEditorOpen] = useState(false);
  const [queuedTextPreviews, setQueuedTextPreviews] = useState<QueuedTextPreview[]>([]);
  const listRef = useRef<FlatList>(null);
  const previousMessageCountRef = useRef(0);
  // Tracks the session id we have already auto-scrolled to bottom for.
  // The user expects entering a conversation to land at the latest message;
  // since the FlatList is not inverted and messages stream in over multiple
  // ticks, a single onContentSizeChange-driven scroll can race the layout.
  // We force a non-animated jump-to-end the first time messages populate
  // for a given session and retry briefly if layout was not ready yet.
  const initialScrollSessionIdRef = useRef<string | null>(null);
  const initialSentRef = useRef(false);
  // F6-R2-1 (behavioral-safety reviewer): guards against re-applying the same
  // prefill payload when the session-lifecycle effect re-runs. Keyed by
  // `${id}|${prefill}` so a new prefill for the same session id still
  // applies; same prefill twice in a row does not. Cleared on id change.
  const prefillAppliedRef = useRef<string | null>(null);
  const voiceIntentRef = useRef<'send' | 'edit' | 'send-and-done' | null>(null);
  const didCaptureInitialRenderRef = useRef(false);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const lastAssistantMessageAtTurnStartRef = useRef<string | null>(null);
  const pendingCompletionPulseRef = useRef(false);
  const wasSendingRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastQueueFullToastAtRef = useRef<number | null>(null);
  const colors = useColors();
  const isFocused = useIsFocused();
  const [idleQuip] = useState(() => pickIdleQuip());
  const isMeetingRecording = useActiveRecordingStore((s) => s.isActive);
  const companionSessionId = useActiveRecordingStore((s) => s.companionSessionId);
  const companionStartTime = useActiveRecordingStore((s) => s.startTime);
  const recordingNotice = useActiveRecordingStore((s) => s.recordingNotice);
  const setRecordingNotice = useActiveRecordingStore((s) => s.setRecordingNotice);
  const isLiveMeetingCompanion = companionSessionId === id;
  const isHistoricalMeetingCompanion = !isLiveMeetingCompanion && currentSession?.meetingCompanion != null;
  const isMeetingCompanion = isLiveMeetingCompanion || isHistoricalMeetingCompanion;
  const showSessionConflictBadge = sessionConflict !== null && sessionConflict.dismissedAt === null;
  const sessionConflictAgeLabel = sessionConflict
    ? formatConflictAgeShort(sessionConflict.detectedAt)
    : null;
  const sessionConflictDetails = sessionConflict
    ? describeConflictFields(sessionConflict.fields ?? [])
    : '';
  const mobileExternalContext = useExternalContextForMobileSession(id);
  const mobileSlackContext = mobileExternalContext?.externalContext;

  // Meeting recording context & health (only active when this is a companion session)
  const meetingRecordingCtx = useMeetingRecordingContext();
  const liveMeetingOptions = useMemo(() => (
    isLiveMeetingCompanion
      ? {
        meetingSessionId: meetingRecordingCtx.meetingCloudSessionId ?? undefined,
        recordingActive: true,
      }
      : undefined
  ), [isLiveMeetingCompanion, meetingRecordingCtx.meetingCloudSessionId]);
  const meetingHealth = useMeetingHealthIndicator({
    meetingSessionId: isLiveMeetingCompanion ? meetingRecordingCtx.meetingSessionId : null,
    isRecording: isLiveMeetingCompanion && meetingRecordingCtx.isRecording,
  });
  const meetingTrigger = useMeetingTriggerHeard(
    isLiveMeetingCompanion
      ? meetingRecordingCtx.meetingCloudSessionId ?? meetingRecordingCtx.meetingSessionId
      : null,
  );

  // Map MeetingHealthStatus → TranscriptStatus for the banner
  const transcriptStatus: TranscriptStatus = useMemo(() => {
    if (!isLiveMeetingCompanion) return 'listening';
    const s2 = meetingHealth.status;
    if (s2 === 'connected') return 'live';
    if (s2 === 'uploading') return 'uploading';
    if (s2 === 'offline') return 'offline';
    return 'listening';
  }, [isLiveMeetingCompanion, meetingHealth.status]);

  // Prep notes auto-send: fire once when this conversation first becomes a live companion
  const hasSentPrepRef = useRef(false);

  const mb = useMemo(() => createMessageBubbleStyles(colors), [colors]);
  const s = useMemo(() => createStyles(colors), [colors]);

  // File viewer for library:// and workspace:// links in messages
  const fileViewer = useFileViewer();

  const [attachError, setAttachError] = useState<string | null>(null);
  const [isTextMode, setIsTextMode] = useState(false);
  const [voiceModeActive, setVoiceModeActive] = useState(false);
  const voiceModeActiveRef = useRef(false);
  const needsVoiceModeMarkRef = useRef(false);

  // Restore persisted voice mode preference on mount
  useEffect(() => {
    SecureStore.getItemAsync(VOICE_MODE_PREF_KEY).then((val) => {
      if (val === 'true') {
        needsVoiceModeMarkRef.current = true;
        setVoiceModeActive(true);
      }
    }).catch((err) => log.warn('Failed to restore voice mode preference', { err: err instanceof Error ? err.message : String(err) }));
  }, []);

  // Track which messages have been spoken to avoid replaying (same pattern as desktop useVoiceModeAutoSpeak)
  const lastSpokenMessageIdRef = useRef<string | null>(null);
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());
  const autoListenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    isSending, streamingText: rawStreamingText, activeTurnId, optimisticMessages,
    completedSteps, thinkingHeadline, error: turnError, startTurn, handleStop, closeSocket,
    clearError, missionContext, taskProgress, subAgentItems, hasMissionSet, touchedTaskIds,
    userQuestionEventsByTurn,
  } = useAgentTurn();

  // User question card integration — mirrors desktop useUserQuestions but
  // backed by AsyncStorage for dismiss persistence and cloud `ipcCall` for
  // the submission path. Continuation turn is started locally via startTurn
  // with isSystemContinuation=true (renderer-started continuation pattern).
  // See docs/plans/260420_user_question_cross_surface_resilience.md Stage 5.
  const userQuestionOptions = useMemo(
    () => ({
      submitAnswer: async (request: UserQuestionSubmitRequest): Promise<UserQuestionSubmitResponse> => {
        const result = await ipcCall('agent:user-question-response', request);
        return {
          success: result.success,
          error: result.error,
          continuationMessage: result.continuationMessage,
          continuationContext: result.continuationContext,
        };
      },
      startContinuationTurn: async (
        sessionId: string,
        continuationMessage: string,
        attachments?: AnyAttachmentPayload[],
        continuationContext?: import('@rebel/cloud-client').UserQuestionContinuationContext,
      ) => {
        startTurn(
          sessionId,
          continuationMessage,
          attachments as WebFileAttachment[] | undefined,
          {
            isSystemContinuation: true,
            meetingSessionId: liveMeetingOptions?.meetingSessionId,
            recordingActive: liveMeetingOptions?.recordingActive,
            ...(continuationContext ? { continuationContext } : {}),
          },
        );
      },
      persistence: asyncStoragePersistence,
    }),
    [liveMeetingOptions?.meetingSessionId, liveMeetingOptions?.recordingActive, startTurn],
  );

  // Stage 7 cross-session rehydration: on mount, the live `userQuestionEventsByTurn`
  // from `useAgentTurn` is empty. Seed from the session's persisted events so the
  // answered state survives a force-quit between the user's answer and the
  // continuation turn completing. See:
  //   docs-private/postmortems/260420_empty_result_anomaly_askuserquestion_deny_postmortem.md
  //   docs/plans/260420_user_question_cross_surface_resilience.md (Stage 7)
  const mergedUserQuestionEventsByTurn = useMemo(
    () => mergeUserQuestionEvents(userQuestionEventsByTurn, currentSession?.userQuestionEventsByTurn),
    [currentSession?.userQuestionEventsByTurn, userQuestionEventsByTurn],
  );

  const {
    questionBatches: userQuestionBatches,
    submitAnswers: submitUserQuestionAnswers,
    skipBatch: skipUserQuestionBatch,
    dismissBatch: dismissUserQuestionBatch,
    isSubmitting: isUserQuestionSubmitting,
    submissionError: userQuestionError,
  } = useUserQuestions(id ?? null, mergedUserQuestionEventsByTurn, userQuestionOptions);

  const streamingText = useSmoothStream(rawStreamingText || undefined, isSending);

  // ── Minimized question pill ──────────────────────────────────────────────
  const [minimizedQuestionBatchId, setMinimizedQuestionBatchId] = useState<string | null>(null);
  const prevSendingRef = useRef(isSending);
  useEffect(() => {
    if (isSending && !prevSendingRef.current && minimizedQuestionBatchId) {
      dismissUserQuestionBatch(minimizedQuestionBatchId);
      setMinimizedQuestionBatchId(null);
    }
    prevSendingRef.current = isSending;
  }, [isSending, minimizedQuestionBatchId, dismissUserQuestionBatch]);

  // Clear minimized state when batch disappears
  useEffect(() => {
    if (!minimizedQuestionBatchId) return;
    const stillExists = userQuestionBatches.some(
      (b) => b.batch.batchId === minimizedQuestionBatchId && !b.isAnswered && !b.dismissed,
    );
    if (!stillExists) setMinimizedQuestionBatchId(null);
  }, [minimizedQuestionBatchId, userQuestionBatches]);

  const handleMinimizeQuestion = useCallback((batchId: string) => {
    setMinimizedQuestionBatchId(batchId);
  }, []);

  const handleRestoreMinimizedQuestion = useCallback((batchId: string) => {
    if (batchId === minimizedQuestionBatchId) setMinimizedQuestionBatchId(null);
  }, [minimizedQuestionBatchId]);

  const handleDismissMinimizedQuestion = useCallback((batchId: string) => {
    dismissUserQuestionBatch(batchId);
    setMinimizedQuestionBatchId(null);
  }, [dismissUserQuestionBatch]);

  // Recover mission/task/steps from stored events when returning to a busy session.
  // useAgentTurn starts fresh on re-mount so its live state is empty, but the REST
  // response includes toolEventsByTurn for the active turn.
  const activeTurnEvents: SessionToolEvent[] | undefined = useMemo(() => {
    const turnId = activeTurnId || currentSession?.activeTurnId;
    if (!turnId || !currentSession?.toolEventsByTurn) return undefined;
    return currentSession.toolEventsByTurn[turnId];
  }, [activeTurnId, currentSession?.activeTurnId, currentSession?.toolEventsByTurn]);

  const recoveredMission = useMemo(
    () => (!missionContext && activeTurnEvents ? extractMissionFromEvents(activeTurnEvents) : null),
    [missionContext, activeTurnEvents],
  );
  const recoveredTasks = useMemo(
    () => (taskProgress.length === 0 && activeTurnEvents ? extractTasksFromEvents(activeTurnEvents) : []),
    [taskProgress, activeTurnEvents],
  );
  const recoveredSubAgents = useMemo(() => {
    if (subAgentItems && subAgentItems.length > 0) return [];
    if (!activeTurnEvents) return [];
    try { return extractSubAgentItems(activeTurnEvents); } catch { return []; }
  }, [subAgentItems, activeTurnEvents]);
  const recoveredSteps = useMemo(() => {
    if (completedSteps.length > 0 || !activeTurnEvents) return [];
    const paired = new Map<string, { start?: SessionToolEvent; end?: SessionToolEvent }>();
    const standalone: SessionToolEvent[] = [];
    for (const ev of activeTurnEvents) {
      const uid = ev.toolUseId?.trim();
      if (!uid) { standalone.push(ev); continue; }
      const pair = paired.get(uid) ?? {};
      if (ev.stage === 'start') pair.start = ev;
      else if (ev.stage === 'end') pair.end = ev;
      paired.set(uid, pair);
    }
    const steps: typeof completedSteps = [];
    for (const [uid, pair] of paired) {
      const src = pair.end ?? pair.start;
      if (!src) continue;
      steps.push({
        label: src.toolName,
        timestamp: src.timestamp,
        toolName: src.toolName,
        detail: src.detail || undefined,
        isError: pair.end?.isError ?? false,
        toolUseId: uid,
      });
    }
    for (const ev of standalone) {
      steps.push({
        label: ev.toolName,
        timestamp: ev.timestamp,
        toolName: ev.toolName,
        detail: ev.detail || undefined,
        isError: ev.stage === 'end' ? (ev.isError ?? false) : false,
        toolUseId: undefined,
      });
    }
    steps.sort((a, b) => a.timestamp - b.timestamp);
    return steps;
  }, [completedSteps, activeTurnEvents]);

  // Recover delta metadata from events when hook state is fresh after remount
  const recoveredHasMissionSet = useMemo(() => {
    if (hasMissionSet || !activeTurnEvents) return false;
    return activeTurnEvents.some(e => e.toolName === 'MissionSet');
  }, [hasMissionSet, activeTurnEvents]);
  const recoveredTouchedTaskIds = useMemo(() => {
    if (touchedTaskIds.length > 0 || !activeTurnEvents) return [] as string[];
    const ids: string[] = [];
    const seen = new Set<string>();
    const sorted = [...activeTurnEvents].sort((a, b) => a.timestamp - b.timestamp);
    for (const ev of sorted) {
      if ((ev.toolName === 'TaskCreate' || ev.toolName === 'TaskUpdate') && ev.stage === 'end') {
        const id = parseIndividualTaskIdFromDetail(ev.detail);
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
    }
    return ids;
  }, [touchedTaskIds, activeTurnEvents]);

  const effectiveMission = missionContext ?? recoveredMission;
  const effectiveTasks = taskProgress.length > 0 ? taskProgress : recoveredTasks;
  const effectiveSubAgents = (subAgentItems && subAgentItems.length > 0) ? subAgentItems : recoveredSubAgents;
  const effectiveSteps = completedSteps.length > 0 ? completedSteps : recoveredSteps;
  const effectiveHasMissionSet = hasMissionSet || recoveredHasMissionSet;
  const effectiveTouchedTaskIds = touchedTaskIds.length > 0 ? touchedTaskIds : recoveredTouchedTaskIds;

  const {
    attachments, pickImage, pickDocument, removeAttachment, clearAttachments, restoreAttachments, canAddMore,
  } = useMobileFileAttachments((msg) => setAttachError(msg));

  const showToast = useCallback((message: string, durationMs = 2000) => {
    setToast(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs);
  }, []);

  const handleSaveFinishLine = useCallback(async (next: string) => {
    if (!id) return;
    const session = useSessionStore.getState().currentSession;
    if (!session) return;

    const baseSeq = session.maxSeq ?? 0;
    const clientCloudUpdatedAt = session.cloudUpdatedAt ?? 0;
    const normalized = next.trim();
    const patchValue = normalized.length > 0 ? normalized : null;

    try {
      await patchSession(id, {
        baseSeq,
        clientCloudUpdatedAt,
        patch: { finishLine: patchValue },
      });
      await useSessionStore.getState().fetchSession(id);
      setIsFinishLineEditorOpen(false);
    } catch (err) {
      if (err instanceof SessionNeedsReconcileError) {
        log.warn('patchSession finishLine needs reconcile', { sessionId: id });
        await useSessionStore.getState().fetchSession(id);
        showToast('Finish line changed elsewhere. Review and try again.');
        return;
      }
      log.error('patchSession finishLine failed', { err: err instanceof Error ? err.message : String(err) });
      showToast('Could not save finish line');
    }
  }, [id, showToast]);

  useEffect(() => {
    if (!recordingNotice || !isLiveMeetingCompanion) return;
    showToast(recordingNotice, 3500);
    setRecordingNotice(null);
  }, [isLiveMeetingCompanion, recordingNotice, setRecordingNotice, showToast]);

  const showQueuedMessageToast = useCallback(() => {
    showToast(queueToastCopy.enqueuedOffline, 2500);
  }, [showToast]);

  /**
   * Surface a send-and-done turn that failed AFTER the server acknowledged it
   * (post-ack terminal error or a tombstoned session). The user has typically
   * navigated away, so we surface honestly without silently marking the session
   * done:
   *   - terminal-error: the turn already persisted as an error and is visible in
   *     the transcript; show an honest, recoverable toast. We do NOT re-enqueue
   *     (re-running would just persist the same error again — no model can run).
   *   - session-tombstoned: the turn never ran, so re-enqueue it; the offline
   *     queue consumer recreates the conversation under a fresh id (Stage 1b).
   */
  const handleSendAndDoneTerminalFailure = useCallback((
    failure: SendAndDoneTerminalFailure,
    ctx: {
      sessionId: string;
      prompt: string;
      attachments?: WebFileAttachment[];
      meetingSessionId?: CloudMeetingSessionId;
      recordingActive?: boolean;
      logLabel: string;
    },
  ) => {
    log.warn(`${ctx.logLabel} failed after ack (terminal)`, {
      sessionId: ctx.sessionId,
      kind: failure.kind,
      provider: failure.provider,
      errorKind: failure.errorKind,
      promptLen: ctx.prompt.length,
      attachmentCount: ctx.attachments?.length ?? 0,
    });
    if (failure.kind === 'session-tombstoned' || failure.kind === 'delivery-failed') {
      // The turn never ran (tombstone) or its outcome is unknown after an
      // abnormal close/timeout on a current server (delivery-failed). Re-enqueue
      // so the offline queue redelivers it — recreating under a fresh, visible id
      // for a tombstone, or re-submitting through the ack-guarded path otherwise.
      reenqueueSendAndDonePrompt({
        sessionId: ctx.sessionId,
        prompt: ctx.prompt,
        attachments: ctx.attachments,
        meetingSessionId: ctx.meetingSessionId,
        recordingActive: ctx.recordingActive,
        logLabel: ctx.logLabel,
      });
      try {
        showToast(queueToastCopy.sendAndDoneFailedPreAck, 3500);
      } catch (e) {
        ignoreBestEffortCleanup(e, { operation: 'sendAndDone.terminalFailure.toast', reason: 'user navigated away before the toast could render' });
      }
      return;
    }
    // terminal-error: honest, recoverable message. The persisted error turn is
    // already in the transcript, so the user sees the failure on return.
    try {
      showToast(failure.userMessage, 4500);
    } catch (e) {
      ignoreBestEffortCleanup(e, { operation: 'sendAndDone.terminalFailure.toast', reason: 'user navigated away before the toast could render' });
    }
  }, [showToast]);

  // Draft preservation for online sends: snapshot composer BEFORE clearing, and
  // restore it if the turn fails before the server acknowledges (activeTurnId set).
  // Uses event-based latch (not a time window) — see useDraftPreservingSend.
  const inputRef = useRef<string>('');
  const attachmentsRef = useRef<WebFileAttachment[]>([]);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);

  const { beginSendAttempt, noteUserEdit } = useDraftPreservingSend<WebFileAttachment>({
    activeTurnId,
    error: turnError,
    isSending,
    getComposerSnapshot: () => ({
      input: inputRef.current,
      attachments: attachmentsRef.current,
    }),
    onRestore: (snapshot, _reason) => {
      // Restore the user's draft + attachments. Guard against clobbering:
      // if the user already typed something new (composer not empty), keep
      // theirs. The hook's revision counter usually prevents this, but the
      // extra guard is a defensive belt-and-braces for refactor safety.
      // Any turn-error banner stays visible so the user can decide whether
      // to retry.
      if (snapshot.input) {
        setInput((current) => (current && current.length > 0 ? current : snapshot.input));
      }
      if (snapshot.attachments.length > 0) {
        restoreAttachments(snapshot.attachments);
      }
      showToast(queueToastCopy.draftRestored, 3000);
    },
  });

  useEffect(() => {
    return () => {
      clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (queueFullAt === null) return;
    if (lastQueueFullToastAtRef.current === queueFullAt) return;
    lastQueueFullToastAtRef.current = queueFullAt;
    showToast(queueToastCopy.olderItemsDropped, 3500);
  }, [queueFullAt, showToast]);

  const linkDispatcher = useMemo(() => createMarkdownLinkHandler({
    onOpenFile: (path) => {
      fileViewer.openPath(path);
    },
    onOpenImage: (path) => {
      fileViewer.openPath(path);
    },
    onOpenFolder: () => {
      showToast('Folder browsing is coming to mobile soon.');
    },
    onOpenConversation: (sessionId) => {
      router.push(`/conversation/${sessionId}`);
    },
    onNavigate: (url) => {
      // Route rebel://... URLs through the shared parser so the mobile
      // conversation screen matches +native-intent.ts behavior. Anything the
      // mobile router can't handle falls back to the "only on desktop" toast
      // — "silent failure is a bug" still applies here.
      const target = parseNavigationUrl(url);
      if (!target) {
        showToast("That link doesn't look right.");
        return;
      }

      switch (target.type) {
        case 'sessions':
          if (target.sessionId) {
            router.push(`/conversation/${target.sessionId}`);
          } else {
            router.push('/(tabs)/conversations');
          }
          return;
        case 'tasks':
          if (target.focusApprovalId) {
            router.push({
              pathname: '/(tabs)/inbox',
              params: { focusItemId: target.focusApprovalId },
            });
          } else {
            router.push('/(tabs)/inbox');
          }
          return;
        case 'action':
          // In-app action verbs aren't something we render as clickable links
          // inside a conversation today, but if one slips through, fall back
          // to the same toast pattern until mobile grows explicit handlers.
          showToast('This link only works on desktop.');
          return;
        case 'feedback': {
          const params: Record<string, string> = {};
          if (target.feedbackType) params.feedbackType = target.feedbackType;
          if (target.description) params.description = target.description;
          if (target.stepsToReproduce) params.stepsToReproduce = target.stepsToReproduce;
          if (target.expectedBehavior) params.expectedBehavior = target.expectedBehavior;
          if (target.attachContinuityDiagnostics) {
            params.attachContinuityDiagnostics = '1';
          }
          router.push({ pathname: '/(tabs)/help', params });
          return;
        }
        default:
          showToast('This link only works on desktop.');
          return;
      }
    },
    onOpenTutorial: (path) => {
      fileViewer.openPath(path);
    },
    onBlocked: (url, reason) => {
      console.warn('[mobile] blocked link', { url, reason });
      // Every blocked tap gets user feedback — "silent failure is a bug" principle.
      // Dead taps without explanation feel like the app is broken.
      switch (reason) {
        case 'platform-unsupported':
          showToast('This link only works on desktop.');
          break;
        case 'invalid-tutorial':
          showToast("That tutorial link doesn't look right.");
          break;
        case 'invalid-rebel-url':
          showToast("That link doesn't look right.");
          break;
        case 'empty-path':
          showToast("That link doesn't point to anything.");
          break;
        case 'protocol-relative':
        case 'unknown-scheme':
          showToast("That link isn't supported here.");
          break;
      }
    },
  }), [fileViewer.openPath, router, showToast]);

  const handleLinkPress = useCallback((url: string): boolean => {
    const result = linkDispatcher(url);
    return result.action === 'open-external';
  }, [linkDispatcher]);

  const streamingLinkDispatcher = useMemo(() => createMarkdownLinkHandler({
    onOpenFile: () => undefined,
    onOpenImage: () => undefined,
    onOpenFolder: () => undefined,
    onOpenConversation: (sessionId) => {
      router.push(`/conversation/${sessionId}`);
    },
    onOpenTutorial: () => undefined,
    onBlocked: () => undefined,
  }), [router]);

  const handleStreamingLinkPress = useCallback((url: string): boolean => {
    const result = streamingLinkDispatcher(url);
    return result.action === 'open-external';
  }, [streamingLinkDispatcher]);

  // Forward-declared ref for audio playback state used by handleVoiceTranscript
  // below. The voice -> audio dependency chain is circular at hook-init time
  // (handleVoiceTranscript -> useMobileVoiceRecording -> handlePlaybackComplete
  // -> useMobileAudioPlayback -> isSpeaking/ttsLoading/stopSpeech), so we read
  // those values via this ref and populate it after useMobileAudioPlayback
  // resolves (see useEffect below).
  const audioPlaybackRef = useRef<{
    isSpeaking: boolean;
    ttsLoading: boolean;
    stopSpeech: () => void;
  } | null>(null);

  const handleVoiceTranscript = useCallback((text: string) => {
    hapticLight();
    const intent = voiceIntentRef.current;
    voiceIntentRef.current = null;

    if (intent === 'send') {
      if (isOnline) {
        // Voice transcript online send: override the snapshot so a pre-ack
        // failure drops the transcript into the composer for the user to retry.
        const atts: WebFileAttachment[] | undefined = attachments.length > 0 ? attachments : undefined;
        const attempt = beginSendAttempt({ input: text, attachments: atts ?? [] });
        startTurn(id, text, atts, liveMeetingOptions);
        if (atts) clearAttachments();
        void attempt.done;
      } else if (attachments.length > 0) {
        // Offline with attachments: route to text-with-attachments
        void (async () => {
          try {
            const diskCheck = await checkSufficientDiskSpace();
            if (!diskCheck.ok) {
              showToast('Not enough storage to save these attachments. Free up some space first.');
              return;
            }
            await useOfflineQueueStore.getState().enqueueWithJsonPayloadOrThrow(
              'text-with-attachments',
              { prompt: text, attachments },
              {
                sessionId: id,
                prompt: text,
                attachmentCount: attachments.length,
                meetingSessionId: liveMeetingOptions?.meetingSessionId,
                recordingActive: liveMeetingOptions?.recordingActive,
              },
            );
            clearAttachments();
            showQueuedMessageToast();
          } catch (err) {
            if (err instanceof QueueFullError) {
              showToast(QUEUE_FULL_USER_MESSAGE);
              log.warn('Queue full on voice transcript send with attachments', { itemType: 'text-with-attachments', sessionId: id, queueSize: err.maxSize });
            } else {
              showToast("Couldn't save your message. Try again.");
              log.error('Failed to enqueue voice transcript with attachments', { err: err instanceof Error ? err.message : String(err) });
            }
          }
        })();
      } else {
        try {
          void useOfflineQueueStore.getState()
            .enqueueOrThrow(
              'text-message',
              null,
              null,
              {
                sessionId: id,
                prompt: text,
                meetingSessionId: liveMeetingOptions?.meetingSessionId,
                recordingActive: liveMeetingOptions?.recordingActive,
              },
            )
            .then(() => {
              showQueuedMessageToast();
            })
            .catch((err) => {
              if (err instanceof QueueFullError) {
                showToast(QUEUE_FULL_USER_MESSAGE);
                log.warn('Queue full on voice transcript send', { itemType: 'text-message', sessionId: id, queueSize: err.maxSize });
              }
            });
        } catch { /* queue unavailable — voice recordings are still separately queued */ }
      }
    } else if (intent === 'send-and-done') {
      if (voiceModeActiveRef.current) {
        voiceModeActiveRef.current = false;
        if (autoListenTimerRef.current) {
          clearTimeout(autoListenTimerRef.current);
          autoListenTimerRef.current = null;
        }
      }
      const audio = audioPlaybackRef.current;
      if (audio && (audio.isSpeaking || audio.ttsLoading)) {
        audio.stopSpeech();
      }
      if (isOnline) {
        const atts: WebFileAttachment[] | undefined = attachments.length > 0 ? attachments : undefined;
        const capturedText = text;
        const capturedAtts = atts ? [...atts] : undefined;
        const capturedMeetingSessionId = liveMeetingOptions?.meetingSessionId;
        const capturedRecordingActive = liveMeetingOptions?.recordingActive;
        sendAndDoneInBackground(id, text, atts, {
          meetingSessionId: capturedMeetingSessionId,
          recordingActive: capturedRecordingActive,
          onFailureBeforeAck: (reason) => {
            log.warn('voice send-and-done failed before ack', {
              sessionId: id,
              reason,
              transcriptLen: capturedText.length,
              attachmentCount: capturedAtts?.length ?? 0,
            });
            try {
              showToast(queueToastCopy.sendAndDoneFailedPreAck, 3500);
            } catch { /* navigated away */ }
            // Write the transcript into the offline queue so it's not lost
            // when the user navigates away. Safe: server never acked.
            reenqueueSendAndDonePrompt({
              sessionId: id,
              prompt: capturedText,
              attachments: capturedAtts,
              meetingSessionId: capturedMeetingSessionId,
              recordingActive: capturedRecordingActive,
              logLabel: 'voice send-and-done',
            });
          },
          onTerminalFailure: (failure) => {
            handleSendAndDoneTerminalFailure(failure, {
              sessionId: id,
              prompt: capturedText,
              attachments: capturedAtts,
              meetingSessionId: capturedMeetingSessionId,
              recordingActive: capturedRecordingActive,
              logLabel: 'voice send-and-done',
            });
          },
        });
        if (atts) clearAttachments();
      } else if (attachments.length > 0) {
        // Offline send-and-done with attachments
        void (async () => {
          try {
            const diskCheck = await checkSufficientDiskSpace();
            if (!diskCheck.ok) {
              showToast('Not enough storage to save these attachments. Free up some space first.');
              return; // Don't navigate away
            }
            await useOfflineQueueStore.getState().enqueueWithJsonPayloadOrThrow(
              'text-with-attachments',
              { prompt: text, attachments },
              {
                sessionId: id,
                prompt: text,
                attachmentCount: attachments.length,
                meetingSessionId: liveMeetingOptions?.meetingSessionId,
                recordingActive: liveMeetingOptions?.recordingActive,
              },
            );
            clearAttachments();
            showQueuedMessageToast();
            router.back();
          } catch (err) {
            if (err instanceof QueueFullError) {
              showToast(QUEUE_FULL_USER_MESSAGE);
              log.warn('Queue full on voice send-and-done with attachments', { itemType: 'text-with-attachments', sessionId: id, queueSize: err.maxSize });
            } else {
              showToast("Couldn't save your message. Try again.");
              log.error('Failed to enqueue voice send-and-done with attachments', { err: err instanceof Error ? err.message : String(err) });
            }
          }
        })();
        return; // Don't fall through to router.back() below
      } else {
        try {
          const enqueueResult = useOfflineQueueStore.getState().enqueueOrThrow(
            'text-message',
            null,
            null,
            {
              sessionId: id,
              prompt: text,
              meetingSessionId: liveMeetingOptions?.meetingSessionId,
              recordingActive: liveMeetingOptions?.recordingActive,
            },
          );
          void enqueueResult
            .then(() => {
              showQueuedMessageToast();
            })
            .catch((err) => {
              if (err instanceof QueueFullError) {
                showToast(QUEUE_FULL_USER_MESSAGE);
                log.warn('Queue full on voice send-and-done', { itemType: 'text-message', sessionId: id, queueSize: err.maxSize });
                // Don't navigate away — keep user in conversation
              }
            });
        } catch { /* queue unavailable */ }
      }
      router.back();
    } else {
      // Default: put transcript in input for editing
      setIsTextMode(true);
      setInput(prev => prev ? prev + ' ' + text : text);
    }
  }, [
    id,
    isOnline,
    startTurn,
    router,
    attachments,
    clearAttachments,
    showToast,
    showQueuedMessageToast,
    beginSendAttempt,
    liveMeetingOptions,
    handleSendAndDoneTerminalFailure,
  ]);

  const {
    isRecording, isTranscribing, toggleRecording, startRecording, stopRecording,
    error: voiceError,
  } = useMobileVoiceRecording(handleVoiceTranscript, id);

  // Register transcript listener for async queue consumer delivery.
  // When the queue consumer transcribes a recording for this session,
  // it fires the registered listener. This handles the case where
  // the queue drains asynchronously (e.g., after reconnecting).
  useEffect(() => {
    setVoiceTranscriptListener((sessionId, _transcript) => {
      // Only handle transcripts for the current conversation
      if (sessionId !== id) return;
      // The queue consumer already submitted the turn via WebSocket,
      // so we don't need to call startTurn here. The event channel
      // will deliver the turn results naturally.
      // This listener is a hook point for future UX (e.g., toast feedback).
    });
    return () => clearVoiceTranscriptListener();
  }, [id]);

  useEffect(() => {
    setTextQueueCompletionListener((event) => {
      if (event.originalSessionId !== id && event.sessionId !== id) return;
      hapticSuccess();
      if (event.recreatedSession) {
        showToast('Original conversation was deleted — started a new one.');
        return;
      }
      showToast('Message sent');
    });
    setTextAttachmentsQueueCompletionListener((event) => {
      if (event.originalSessionId !== id && event.sessionId !== id) return;
      hapticSuccess();
      if (event.recreatedSession) {
        showToast('Original conversation was deleted — started a new one.');
        return;
      }
      showToast('Message with attachments sent');
    });
    return () => {
      clearTextQueueCompletionListener();
      clearTextAttachmentsQueueCompletionListener();
    };
  }, [id, showToast]);

  useEffect(() => {
    setVoiceQueueCompletionListener((event) => {
      if (event.originalSessionId !== id && event.sessionId !== id) return;
      hapticSuccess();
      if (event.recreatedSession) {
        showToast('Original conversation was deleted — started a new one.');
        return;
      }
      showToast('Voice recording sent');
    });
    return () => clearVoiceQueueCompletionListener();
  }, [id, showToast]);

  // Auto-listen: after TTS playback completes, start recording if voice mode is still active.
  // Uses ref for voiceModeActive to avoid stale closure in the timer callback.
  const handlePlaybackComplete = useCallback(() => {
    if (voiceModeActiveRef.current && !isSending) {
      // Don't auto-listen if a meeting recording is active
      if (useActiveRecordingStore.getState().isActive) return;
      voiceIntentRef.current = 'send';
      if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current);
      autoListenTimerRef.current = setTimeout(() => {
        autoListenTimerRef.current = null;
        if (voiceModeActiveRef.current && !useActiveRecordingStore.getState().isActive) {
          void startRecording();
        }
      }, 300);
    }
  }, [isSending, startRecording]);

  const {
    isLoading: ttsLoading, isSpeaking, error: ttsError, speakText, stopSpeech,
  } = useMobileAudioPlayback(handlePlaybackComplete);

  // Populate the forward-declared ref read by handleVoiceTranscript above.
  useEffect(() => {
    audioPlaybackRef.current = { isSpeaking, ttsLoading, stopSpeech };
  }, [isSpeaking, ttsLoading, stopSpeech]);

  // Barge-in: stop speech (or cancel in-flight TTS fetch) when user starts recording
  const handleStartRecording = useCallback(async () => {
    // Block voice recording when meeting recording is active
    if (isMeetingRecording) {
      showToast('Meeting recording in progress');
      return;
    }
    if (isSpeaking || ttsLoading) {
      stopSpeech();
    }
    if (autoListenTimerRef.current) {
      clearTimeout(autoListenTimerRef.current);
      autoListenTimerRef.current = null;
    }
    void startRecording();
  }, [isMeetingRecording, isSpeaking, ttsLoading, stopSpeech, startRecording, showToast]);

  const handleVoiceStopAndSend = useCallback(() => {
    voiceIntentRef.current = 'send';
    hapticLight();
    stopRecording();
  }, [stopRecording]);

  const handleVoiceStopAndEdit = useCallback(() => {
    voiceIntentRef.current = 'edit';
    hapticLight();
    stopRecording();
  }, [stopRecording]);

  const handleVoiceStopAndSendDone = useCallback(() => {
    voiceIntentRef.current = 'send-and-done';
    hapticLight();
    stopRecording();
  }, [stopRecording]);

  const voiceModeToggleScale = useSharedValue(1);
  const voiceModeToggleAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: voiceModeToggleScale.value }],
  }));
  const [voiceModeLabel, setVoiceModeLabel] = useState<string | null>(null);
  const voiceModeLabelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleVoiceModeToggle = useCallback(() => {
    hapticLight();
    const next = !voiceModeActive;
    if (voiceModeActive && isSpeaking) {
      stopSpeech();
    }
    setVoiceModeActive(next);
    SecureStore.setItemAsync(VOICE_MODE_PREF_KEY, String(next))
      .catch((err) => log.warn('Failed to persist voice mode preference', { err: err instanceof Error ? err.message : String(err) }));

    voiceModeToggleScale.value = withSequence(
      withSpring(1.25, { damping: 8, stiffness: 300 }),
      withSpring(1, { damping: 12, stiffness: 200 }),
    );

    if (voiceModeLabelTimerRef.current) clearTimeout(voiceModeLabelTimerRef.current);
    setVoiceModeLabel(next ? 'Replies spoken aloud' : 'Text replies');
    voiceModeLabelTimerRef.current = setTimeout(() => {
      setVoiceModeLabel(null);
      voiceModeLabelTimerRef.current = null;
    }, 2000);
  }, [voiceModeActive, isSpeaking, stopSpeech, voiceModeToggleScale]);

  useEffect(() => {
    return () => {
      if (voiceModeLabelTimerRef.current) clearTimeout(voiceModeLabelTimerRef.current);
    };
  }, []);

  const pulseStyle = usePulseAnimation(isRecording);
  const [completionPulseMessageId, setCompletionPulseMessageId] = useState<string | null>(null);
  const completionPulseOpacity = useSharedValue(1);
  const completionPulseStyle = useAnimatedStyle(() => ({ opacity: completionPulseOpacity.value }));

  // Council review availability (fetched once on mount)
  const [councilAvailable, setCouncilAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getSettings().then((s2) => {
      if (!cancelled) setCouncilAvailable(isCouncilReviewAvailable(s2 as Record<string, unknown>));
    }).catch(() => { /* settings unavailable */ });
    return () => { cancelled = true; };
  }, []);

  const handleCouncilReview = useCallback(() => {
    if (!id || isSending) return;
    hapticLight();
    startTurn(id, COUNCIL_REVIEW_PROMPT, undefined, {
      councilMode: true,
      meetingSessionId: liveMeetingOptions?.meetingSessionId,
      recordingActive: liveMeetingOptions?.recordingActive,
    });
  }, [id, isSending, liveMeetingOptions?.meetingSessionId, liveMeetingOptions?.recordingActive, startTurn]);



  // Animated streaming cursor — smooth opacity pulse via Reanimated
  const cursorOpacity = useSharedValue(1);
  const hasStreamingText = Boolean(streamingText);
  useEffect(() => {
    if (hasStreamingText) {
      cursorOpacity.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 400 }),
          withTiming(1, { duration: 400 }),
        ),
        -1,
      );
    } else {
      cancelAnimation(cursorOpacity);
      cursorOpacity.value = 1;
    }
  }, [hasStreamingText, cursorOpacity]);
  const cursorStyle = useAnimatedStyle(() => ({ opacity: cursorOpacity.value }));

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    setShowScrollButton(distanceFromBottom > 200);
  }, []);

  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    if (!id) return;

    // F6-R2-1: clear prefill-applied memo whenever the session id
    // changes so a subsequent prefill for a new session always fires.
    prefillAppliedRef.current = null;

    // F6-R1-6 / F6-R2-1: when both `initialPrompt` and `prefill` are supplied,
    // `prefill` WINS — prefill is the explicit "review before send"
    // channel and auto-sending via initialPrompt would defeat its
    // purpose. The actual prefill APPLICATION lives in a separate
    // effect (below) so that same-session prefill param updates are
    // honoured without re-running the full session-lifecycle effect.
    if (!initialPrompt || !prefill) {
      // initialPrompt handling (no prefill present)
      if (initialPrompt && !initialSentRef.current) {
        initialSentRef.current = true;
        startTurn(id, initialPrompt, undefined, liveMeetingOptions);
      } else if (!initialPrompt && !prefill) {
        if (autoRecord === 'true') {
          // Skip fetchSession for autoRecord -- the session doesn't exist yet.
          // It will be created when the user sends their first turn.
          // Clear any stale error from a previous session to avoid blocking the voice UI.
          useSessionStore.setState({ error: null });
          // Don't auto-record if a meeting recording is active (audio session conflict)
          if (!useActiveRecordingStore.getState().isActive) {
            void startRecording();
          }
        } else if (compose === 'text') {
          // Skip fetchSession for text compose -- the session doesn't exist yet.
          // It will be created when the user sends their first turn.
          useSessionStore.setState({ error: null });
          setIsTextMode(true);
        } else {
          useSessionStore.getState().fetchSession(id);
        }
      }
    }
    return () => {
      // Clear session first so any pending handleSessionChanged sees currentSession as null
      // and won't resurrect stale session state (I8 fix).
      useSessionStore.getState().clearCurrentSession();
      // Close socket (deferred internally to next microtask to avoid
      // native TurboModule exceptions during React's synchronous unmount).
      closeSocket();
    };
  }, [id, liveMeetingOptions, startTurn]);

  // F6-R2-1 (behavioral-safety reviewer): dedicated prefill-application
  // effect. Watches [id, prefill] so an updated prefill for the SAME
  // session id still applies (previous single-effect design on [id]
  // only latched — new prefill never reached the composer). Guarded
  // by prefillAppliedRef so we don't re-apply an identical payload
  // when the effect re-fires due to unrelated re-renders. Keeps the
  // 16 KB cap, the log.warn on double-param precedence, and the
  // "don't overwrite existing user input" rule from the original.
  useEffect(() => {
    if (!id || !prefill) return;

    // F6-R1-6: cap `prefill` at 16 KB (the built conflict prompt is ~8 KB
    // body + guards + metadata; 16 KB accommodates the full built
    // prompt with headroom). An attacker-controlled deep link could
    // otherwise point at a megabyte-size prefill.
    const MAX_PREFILL_BYTES = 16 * 1024;
    let safePrefill: string = prefill;
    if (safePrefill.length > MAX_PREFILL_BYTES) {
      log.warn('prefill URL param exceeded cap — truncating', {
        length: safePrefill.length,
        cap: MAX_PREFILL_BYTES,
      });
      safePrefill = safePrefill.slice(0, MAX_PREFILL_BYTES);
      showToast('Prefilled message was too long and was shortened.');
    }

    // F6-R1-6: when both `initialPrompt` and `prefill` are supplied,
    // `prefill` WINS.
    if (initialPrompt) {
      log.warn('conversation route received both initialPrompt and prefill — prefill wins', {
        sessionId: id,
      });
    }

    // F6-R2-1: skip if this exact prefill was already applied for this
    // session id (prevents churn from re-renders).
    const appliedKey = `${id}|${safePrefill}`;
    if (prefillAppliedRef.current === appliedKey) return;
    prefillAppliedRef.current = appliedKey;

    // Prefill the composer WITHOUT auto-sending. Always open text
    // mode so the prefill is visible. Do not overwrite existing
    // non-empty input — user draft protection.
    setIsTextMode(true);
    setInput((current) => (current && current.length > 0 ? current : safePrefill));
    useSessionStore.getState().fetchSession(id);
  }, [id, prefill, initialPrompt]);

  const handleAskSparkOpen = useCallback(() => {
    if (!meetingRecordingCtx.isRecording) {
      showToast('Recording stopped - start a new recording to use Ask Spark.', 2500);
      return;
    }
    setAskSparkPickerVisible(true);
  }, [meetingRecordingCtx.isRecording, showToast]);

  const handleAskSparkSelect = useCallback((triggerExtracted: string) => {
    if (!id) return;
    if (!meetingRecordingCtx.isRecording) {
      showToast('Recording stopped - start a new recording to use Ask Spark.', 2500);
      return;
    }

    hapticLight();
    const companionTurn = buildCompanionTurnPrompt({
      triggerSource: 'quick-ask-button',
      triggerSourceSpeaker: 'user',
      triggeredAt: Date.now(),
      triggerExtracted,
    });

    if (isOnline) {
      startTurn(id, companionTurn.prompt, undefined, {
        ...liveMeetingOptions,
        recordingActive: true,
        triggerMeta: companionTurn.meta,
      });
      return;
    }

    try {
      void useOfflineQueueStore.getState().enqueueOrThrow(
        'text-message',
        null,
        null,
        {
          sessionId: id,
          prompt: companionTurn.prompt,
          meetingSessionId: liveMeetingOptions?.meetingSessionId,
          recordingActive: true,
          triggerMeta: companionTurn.meta,
        },
      ).then(() => {
        showToast('Saved your question - Spark will answer when reconnected.', 2500);
      }).catch((err) => {
        if (err instanceof QueueFullError) {
          showToast(QUEUE_FULL_USER_MESSAGE);
          log.warn('Queue full on Ask Spark quick ask', { itemType: 'text-message', sessionId: id, queueSize: err.maxSize });
          return;
        }
        showToast("Couldn't save your question. Try again.");
        log.error('Failed to enqueue Ask Spark quick ask', { err: err instanceof Error ? err.message : String(err) });
      });
    } catch (err) {
      showToast("Couldn't save your question. Try again.");
      log.warn('Offline queue unavailable for Ask Spark quick ask', { err: err instanceof Error ? err.message : String(err) });
    }
  }, [
    id,
    isOnline,
    liveMeetingOptions,
    meetingRecordingCtx.isRecording,
    showToast,
    startTurn,
  ]);

  // Handle stop recording from banner
  const handleStopMeetingRecording = useCallback(() => {
    meetingRecordingCtx.stopRecording();
  }, [meetingRecordingCtx.stopRecording]);

  const handleAttach = useCallback(() => {
    setAttachError(null);
    // Attaching a file counts as composer activity — if a send is in flight
    // and fails pre-ack, we should NOT clobber the newly-attached file.
    noteUserEdit();
    Alert.alert('Attach', undefined, [
      { text: 'Photo Library', onPress: () => void pickImage() },
      { text: 'Document', onPress: () => void pickDocument() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [pickImage, pickDocument, noteUserEdit]);

  const handleSend = useCallback(() => {
    if (!input.trim() || !id) return;
    // Block send when actively sending OR server confirms session is busy.
    // The `||` is safe because recovery polling (I3) ensures `isSending` clears
    // after 60s max, and the event channel also clears `isBusy` on turn completion.
    if (isSending || currentSession?.isBusy) return;
    hapticHeavy();
    const prompt = input.trim();

    // Analytics: UI send-tap (client-origin). The resulting agent turn is
    // emitted server-side on the cloud instance — NOT mirrored here. No message
    // content: only the shape of the send. No-op until analytics initialises.
    analyticsTracking.messageSent({
      source: 'text',
      hasAttachments: attachments.length > 0,
      online: isOnline,
    });

    if (isOnline) {
      // Online: fire-and-forget, but protected by draft preservation.
      // beginSendAttempt() snapshots composer state BEFORE we clear it;
      // if startTurn fails before activeTurnId is set, the draft is restored.
      const attempt = beginSendAttempt();
      setInput('');
      const atts: WebFileAttachment[] | undefined = attachments.length > 0 ? attachments : undefined;
      startTurn(id, prompt, atts, liveMeetingOptions);
      clearAttachments();
      // Attempt resolves automatically via the hook's useEffect watchers;
      // we keep a local reference only for abort() on unmount.
      void attempt.done;
      return;
    }

    // Offline path: handle attachments or text-only
    if (attachments.length > 0) {
      // Enqueue text-with-attachments (preserves user's files through offline queue).
      // Input/attachments cleared ONLY after successful enqueue — no data loss on failure.
      void (async () => {
        try {
          const diskCheck = await checkSufficientDiskSpace();
          if (!diskCheck.ok) {
            showToast('Not enough storage to save these attachments. Free up some space first.');
            log.warn('Disk space insufficient for offline attachments', { sessionId: id });
            return;
          }

          await useOfflineQueueStore.getState().enqueueWithJsonPayloadOrThrow(
            'text-with-attachments',
            { prompt, attachments },
            {
              sessionId: id,
              prompt,
              attachmentCount: attachments.length,
              meetingSessionId: liveMeetingOptions?.meetingSessionId,
              recordingActive: liveMeetingOptions?.recordingActive,
            },
          );
          // Only clear AFTER successful enqueue:
          setInput('');
          clearAttachments();
          showQueuedMessageToast();
        } catch (err) {
          if (err instanceof QueueFullError) {
            showToast(QUEUE_FULL_USER_MESSAGE);
            log.warn('Queue full on handleSend', { itemType: 'text-with-attachments', sessionId: id, queueSize: err.maxSize });
            return; // Keep input + attachments for user to retry
          }
          showToast("Couldn't save your message. Try again.");
          log.error('Failed to enqueue text-with-attachments', { err: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }

    // Text-only offline path (no attachments).
    // Input cleared ONLY after successful enqueue.
    try {
      void useOfflineQueueStore.getState().enqueueOrThrow(
        'text-message',
        null,
        null,
        {
          sessionId: id,
          prompt,
          meetingSessionId: liveMeetingOptions?.meetingSessionId,
          recordingActive: liveMeetingOptions?.recordingActive,
        },
      ).then(() => {
        setInput('');
        showQueuedMessageToast();
      }).catch((err) => {
        if (err instanceof QueueFullError) {
          showToast(QUEUE_FULL_USER_MESSAGE);
          log.warn('Queue full on handleSend', { itemType: 'text-message', sessionId: id, queueSize: err.maxSize });
          return;
        }
        showToast("Couldn't save your message. Try again.");
        log.error('Failed to enqueue offline text message', { err: err instanceof Error ? err.message : String(err) });
      });
    } catch (err) {
      log.warn('Offline queue unavailable for text message', { err: err instanceof Error ? err.message : String(err) });
    }
  }, [
    input,
    id,
    isSending,
    currentSession?.isBusy,
    isOnline,
    startTurn,
    attachments,
    clearAttachments,
    showToast,
    showQueuedMessageToast,
    beginSendAttempt,
    liveMeetingOptions,
  ]);

  const handleSendAndDone = useCallback(() => {
    if (!input.trim() || !id) return;
    if (isSending || currentSession?.isBusy) return;
    hapticSuccess();
    const prompt = input.trim();
    if (voiceModeActiveRef.current) {
      voiceModeActiveRef.current = false;
      if (autoListenTimerRef.current) {
        clearTimeout(autoListenTimerRef.current);
        autoListenTimerRef.current = null;
      }
    }
    if (isSpeaking || ttsLoading) {
      stopSpeech();
    }

    if (isOnline) {
      // Online send-and-done: we navigate away immediately. If the socket
      // errors/closes/times-out before the server acknowledges, the user's
      // prompt would otherwise be lost. Draft preservation:
      //   - If still on-screen: show a toast (best-effort).
      //   - ALWAYS: enqueue the prompt into the offline queue so it's
      //     preserved and will flush when connectivity recovers. The server
      //     never acknowledged, so this is safe — no duplicate send.
      const capturedPrompt = prompt;
      const capturedAtts = attachments.length > 0 ? [...attachments] : undefined;
      const capturedMeetingSessionId = liveMeetingOptions?.meetingSessionId;
      const capturedRecordingActive = liveMeetingOptions?.recordingActive;
      setInput('');
      sendAndDoneInBackground(id, prompt, capturedAtts, {
        meetingSessionId: capturedMeetingSessionId,
        recordingActive: capturedRecordingActive,
        onFailureBeforeAck: (reason) => {
          log.warn('send-and-done failed before ack', {
            sessionId: id,
            reason,
            promptLen: capturedPrompt.length,
            attachmentCount: capturedAtts?.length ?? 0,
          });
          try {
            // Re-surface in current screen if still mounted.
            showToast(queueToastCopy.sendAndDoneFailedPreAck, 3500);
          } catch { /* navigated away */ }
          // Enqueue as offline item so the message survives navigation.
          // This is safe because the server never acknowledged the turn.
          reenqueueSendAndDonePrompt({
            sessionId: id,
            prompt: capturedPrompt,
            attachments: capturedAtts,
            meetingSessionId: capturedMeetingSessionId,
            recordingActive: capturedRecordingActive,
            logLabel: 'send-and-done',
          });
        },
        onTerminalFailure: (failure) => {
          handleSendAndDoneTerminalFailure(failure, {
            sessionId: id,
            prompt: capturedPrompt,
            attachments: capturedAtts,
            meetingSessionId: capturedMeetingSessionId,
            recordingActive: capturedRecordingActive,
            logLabel: 'send-and-done',
          });
        },
      });
      clearAttachments();
      router.back();
      return;
    }

    if (attachments.length > 0) {
      // Offline with attachments: enqueue text-with-attachments, then navigate away (user intent is "save + leave").
      // Input/attachments cleared ONLY after successful enqueue — no data loss on failure.
      void (async () => {
        try {
          const diskCheck = await checkSufficientDiskSpace();
          if (!diskCheck.ok) {
            showToast('Not enough storage to save these attachments. Free up some space first.');
            log.warn('Disk space insufficient for offline attachments (send-and-done)', { sessionId: id });
            return; // Don't navigate away
          }

          await useOfflineQueueStore.getState().enqueueWithJsonPayloadOrThrow(
            'text-with-attachments',
            { prompt, attachments },
            {
              sessionId: id,
              prompt,
              attachmentCount: attachments.length,
              meetingSessionId: liveMeetingOptions?.meetingSessionId,
              recordingActive: liveMeetingOptions?.recordingActive,
            },
          );
          // Only clear AFTER successful enqueue:
          setInput('');
          clearAttachments();
          showQueuedMessageToast();
          router.back();
        } catch (err) {
          if (err instanceof QueueFullError) {
            showToast(QUEUE_FULL_USER_MESSAGE);
            log.warn('Queue full on handleSendAndDone', { itemType: 'text-with-attachments', sessionId: id, queueSize: err.maxSize });
            return; // Don't navigate away
          }
          showToast("Couldn't save your message. Try again.");
          log.error('Failed to enqueue offline send-and-done with attachments', { err: err instanceof Error ? err.message : String(err) });
        }
      })();
      return; // Don't fall through to router.back() below — the async block handles navigation
    }

    // Offline text-only: enqueue the text message (archive skipped — can't archive offline).
    // The message is preserved in the queue and will be sent when back online.
    // Input cleared ONLY after successful enqueue.
    try {
      void useOfflineQueueStore.getState().enqueueOrThrow(
        'text-message',
        null,
        null,
        {
          sessionId: id,
          prompt,
          meetingSessionId: liveMeetingOptions?.meetingSessionId,
          recordingActive: liveMeetingOptions?.recordingActive,
        },
      ).then(() => {
        setInput('');
        clearAttachments();
        showQueuedMessageToast();
        router.back();
      }).catch((err) => {
        if (err instanceof QueueFullError) {
          showToast(QUEUE_FULL_USER_MESSAGE);
          log.warn('Queue full on handleSendAndDone', { itemType: 'text-message', sessionId: id, queueSize: err.maxSize });
          return; // Don't navigate away
        }
        showToast("Couldn't save your message. Try again.");
        log.error('Failed to enqueue offline send-and-done', { err: err instanceof Error ? err.message : String(err) });
      });
    } catch (err) {
      log.warn('Offline queue unavailable for send-and-done', { err: err instanceof Error ? err.message : String(err) });
      // Don't navigate away if enqueue failed
    }
  }, [
    input,
    id,
    isSending,
    currentSession?.isBusy,
    isOnline,
    isSpeaking,
    ttsLoading,
    stopSpeech,
    attachments,
    clearAttachments,
    showToast,
    router,
    showQueuedMessageToast,
    liveMeetingOptions,
    handleSendAndDoneTerminalFailure,
  ]);

  // Per-conversation lifecycle + favourite controls. The detail view is the
  // only place a Done conversation is reachable (the list is active-only), so
  // it hosts the two-way Mark as done ⇄ Reopen toggle plus Star. Reuses the
  // list's action-sheet pattern (chief-designer §3b / OQ1) rather than a new
  // affordance.
  const runLifecycleAction = useCallback(async (action: () => Promise<void>) => {
    try {
      await action();
      if (id) await useSessionStore.getState().fetchSession(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Action failed', message);
    }
  }, [id]);

  const showConversationActions = useCallback(() => {
    if (!id) return;
    // FullSession now carries doneAt/starredAt (fetchSession threads them through
    // — see docs/plans/260614_done-state-rename), so read them directly. Lifecycle
    // is read via isSessionDone (strict null), never `!doneAt` truthiness.
    const lifecycle = currentSession ?? undefined;
    const isDone = lifecycle ? isSessionDone(lifecycle) : false;
    const isStarred = lifecycle?.starredAt != null;
    const lifecycleLabel = isDone ? 'Reopen' : 'Mark as done';
    const starLabel = isStarred ? 'Remove from Starred' : 'Add to Starred';

    const toggleLifecycle = () => {
      const now = Date.now();
      // Lifecycle write via canonical `doneAt`. Reopen = Active (doneAt cleared);
      // Mark as done = Done (doneAt set). resolvedAt is co-written only when
      // marking done (matches the list) and stays a distinct concept.
      const patch: Record<string, unknown> = isDone
        ? { doneAt: null, updatedAt: now }
        : { doneAt: now, resolvedAt: now, updatedAt: now };
      void runLifecycleAction(() => updateSession(id, patch));
    };
    const toggleStar = () => {
      // Star is independent of lifecycle — only touch starredAt.
      void runLifecycleAction(() => updateSession(id, {
        starredAt: isStarred ? null : Date.now(),
        updatedAt: Date.now(),
      }));
    };

    if (Platform.OS === 'ios') {
      const options = isBackgroundSession
        ? ['Cancel', starLabel]
        : ['Cancel', lifecycleLabel, starLabel];
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (!isBackgroundSession && buttonIndex === 1) toggleLifecycle();
          if (buttonIndex === (isBackgroundSession ? 1 : 2)) toggleStar();
        },
      );
      return;
    }

    Alert.alert(lifecycle?.title || 'Conversation', undefined, [
      ...(isBackgroundSession ? [] : [{ text: lifecycleLabel, onPress: toggleLifecycle }]),
      { text: starLabel, onPress: toggleStar },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [id, currentSession, isBackgroundSession, runLifecycleAction]);

  const messageInputPlaceholder = !isRecording && !isOnline && attachments.length > 0
    ? 'Add your message (will send when online)...'
    : isRecording
      ? 'Listening...'
      : 'Message Rebel...';

  const onStop = useCallback(async () => {
    const turnId = activeTurnId || currentSession?.activeTurnId;
    if (turnId) {
      hapticHeavy();
      handleStop();
    }
  }, [activeTurnId, currentSession?.activeTurnId, handleStop]);

  const serverMessages = useMemo(
    () => selectVisibleMessages(currentSession?.messages ?? []),
    [currentSession?.messages],
  );
  const queuedTextMessages = useMemo<ConversationMessage[]>(() => {
    return queuedTextPreviews.map((queuedItem) => ({
      id: `queued-${queuedItem.itemId}`,
      turnId: `queued-${queuedItem.itemId}`,
      role: 'user',
      text: queuedItem.text,
      createdAt: queuedItem.enqueuedAt,
      isQueued: true,
      isPermanentFailure: queuedItem.isPermanentFailure,
      lastError: queuedItem.lastError,
      queueItemStatus: queuedItem.status,
      ...(queuedItem.triggerMeta ?? {}),
    }));
  }, [queuedTextPreviews]);

  const allMessages = useMemo<ConversationMessage[]>(() => {
    const mergedMessages = optimisticMessages.length === 0
      ? serverMessages
      : (() => {
        const lastServerUserMsg = serverMessages.findLast((m) => m.role === 'user');
        const uniqueOptimistic = optimisticMessages.filter((m) => {
          if (!lastServerUserMsg || !m.text?.trim()) return true;
          return !(m.role === 'user' && m.text.trim() === lastServerUserMsg.text?.trim());
        });
        return [...serverMessages, ...uniqueOptimistic];
      })();
    return [...mergedMessages, ...queuedTextMessages];
  }, [serverMessages, optimisticMessages, queuedTextMessages]);

  // Auto-send prep notes when this conversation first becomes a live meeting companion.
  // Gate on !isLoadingSession to avoid firing while session history is still loading
  // (allMessages.length === 0 is not reliable until the session fetch completes).
  useEffect(() => {
    if (isLiveMeetingCompanion && !hasSentPrepRef.current && !isLoadingSession && allMessages.length === 0 && !isSending) {
      hasSentPrepRef.current = true;
      const title = meetingRecordingCtx.meetingTitle || 'meeting';
      const prepPrompt = `I'm joining a meeting: "${title}".\n\n1. Search for any existing prep notes I may have for this meeting. If found, give me a quick summary.\n2. If no prep notes are found, check whether this meeting is on my calendar:\n   - If it IS on the calendar: do a brief light prep now using the calendar event (attendees, title, description). Pull recent emails/Slack involving the attendees, and if external attendees are present, do a quick web look at their company. Cap yourself to 2-3 tool calls and keep it concise. If you can't find solid info, say so — don't fabricate.\n   - If it is NOT on the calendar: just say you're ready to help during the meeting.`;
      startTurn(id, prepPrompt, undefined, liveMeetingOptions);
    }
  }, [
    isLiveMeetingCompanion,
    isLoadingSession,
    allMessages.length,
    isSending,
    id,
    meetingRecordingCtx.meetingTitle,
    startTurn,
    liveMeetingOptions,
  ]);

  const turnBoundaries = useMemo(() => {
    const boundaries = new Set<string>();
    let prevTurnId: string | null = null;
    for (const msg of allMessages) {
      if (prevTurnId && msg.turnId !== prevTurnId) {
        boundaries.add(msg.id);
      }
      prevTurnId = msg.turnId;
    }
    return boundaries;
  }, [allMessages]);

  const lastNonUserMessageIdByTurnId = useMemo(() => {
    const map: Record<string, string> = {};
    allMessages.forEach((message) => {
      if ((message.role === 'assistant' || message.role === 'result') && message.turnId) {
        map[message.turnId] = message.id;
      }
    });
    return map;
  }, [allMessages]);

  const lastAssistantMessageAnchor = useMemo(() => {
    for (let index = allMessages.length - 1; index >= 0; index--) {
      const message = allMessages[index];
      if (message.role === 'assistant' || message.role === 'result') {
        return {
          messageId: message.id,
          messageIndex: index,
          turnId: message.turnId ?? null,
        };
      }
    }
    return null;
  }, [allMessages]);
  const lastAssistantMessageId = lastAssistantMessageAnchor?.messageId ?? null;
  const lastAssistantMessageIndex = lastAssistantMessageAnchor?.messageIndex ?? null;
  const lastAssistantTurnId = lastAssistantMessageAnchor?.turnId ?? null;

  const handleContentSizeChange = useCallback(() => {
    const messageCountIncreased = allMessages.length > previousMessageCountRef.current;
    const shouldAutoFollowWhileSending = isSending && !showScrollButton;

    if (messageCountIncreased || shouldAutoFollowWhileSending) {
      listRef.current?.scrollToEnd({ animated: true });
    }

    previousMessageCountRef.current = allMessages.length;
  }, [allMessages.length, isSending, showScrollButton]);

  // Jump to the latest message the first time a conversation populates after
  // entry. Uses an unanimated jump (so the user lands on the last message
  // rather than watching the list scroll past prior turns) and a short retry
  // window because contentSize is not always ready on the first tick.
  useEffect(() => {
    if (!id || allMessages.length === 0) return;
    if (initialScrollSessionIdRef.current === id) return;
    initialScrollSessionIdRef.current = id;
    // Reset the running count so cross-session navigation doesn't make the
    // streaming auto-follow think the count "decreased" and skip catch-up.
    previousMessageCountRef.current = allMessages.length;

    let cancelled = false;
    let attempts = 0;
    const tryScroll = () => {
      if (cancelled) return;
      const list = listRef.current;
      if (!list) return;
      list.scrollToEnd({ animated: false });
      attempts += 1;
      // Re-attempt for ~600ms in case layout wasn't yet measured. Cheap and
      // bounded; gives the FlatList time to lay out long histories.
      if (attempts < 4) {
        setTimeout(tryScroll, 150);
      }
    };
    // Defer the first attempt one tick so the FlatList has rendered children.
    const initial = setTimeout(tryScroll, 0);
    return () => {
      cancelled = true;
      clearTimeout(initial);
    };
  }, [id, allMessages.length]);

  useEffect(() => {
    if (didCaptureInitialRenderRef.current) return;
    allMessages.forEach((message) => seenMessageIdsRef.current.add(message.id));
    didCaptureInitialRenderRef.current = true;
  }, [allMessages]);

  useEffect(() => {
    if (!wasSendingRef.current && isSending) {
      pendingCompletionPulseRef.current = false;
      lastAssistantMessageAtTurnStartRef.current = lastAssistantMessageId;
      setCompletionPulseMessageId(null);
    }

    if (wasSendingRef.current && !isSending) {
      pendingCompletionPulseRef.current = !turnError;
    }

    wasSendingRef.current = isSending;
  }, [isSending, turnError, lastAssistantMessageId]);

  useEffect(() => {
    if (isSending || turnError || !pendingCompletionPulseRef.current) return;
    if (!lastAssistantMessageId || lastAssistantMessageId === lastAssistantMessageAtTurnStartRef.current) return;

    pendingCompletionPulseRef.current = false;
    setCompletionPulseMessageId(lastAssistantMessageId);
    completionPulseOpacity.value = withSequence(
      withTiming(0.55, { duration: 130 }),
      withTiming(1, { duration: 220 }),
    );

    const timer = setTimeout(() => setCompletionPulseMessageId(null), 450);
    return () => clearTimeout(timer);
  }, [isSending, turnError, lastAssistantMessageId, completionPulseOpacity]);

  // Voice mode activation/deactivation — sync ref, clear timers, mark existing messages as handled.
  // Reset dedup tracking on voice mode toggle or session switch.
  // Intentionally NOT depending on allMessages to avoid re-running on every message change.
  useEffect(() => {
    voiceModeActiveRef.current = voiceModeActive;
    if (voiceModeActive && allMessages.length > 0) {
      lastSpokenMessageIdRef.current = allMessages[allMessages.length - 1].id;
      spokenMessageIdsRef.current.clear();
      needsVoiceModeMarkRef.current = false;
    }
    if (!voiceModeActive) {
      lastSpokenMessageIdRef.current = null;
      spokenMessageIdsRef.current.clear();
      needsVoiceModeMarkRef.current = false;
      if (autoListenTimerRef.current) {
        clearTimeout(autoListenTimerRef.current);
        autoListenTimerRef.current = null;
      }
    }
    return () => {
      if (autoListenTimerRef.current) {
        clearTimeout(autoListenTimerRef.current);
        autoListenTimerRef.current = null;
      }
    };
   
  }, [voiceModeActive, id]);

  // Auto-speak new assistant messages when voice mode is active
  // Replicates desktop useVoiceModeAutoSpeak dedup logic
  useEffect(() => {
    if (!voiceModeActive || allMessages.length === 0) return;

    // If voice mode was restored from storage and messages just loaded,
    // mark them as handled to prevent speaking historical messages.
    if (needsVoiceModeMarkRef.current) {
      needsVoiceModeMarkRef.current = false;
      lastSpokenMessageIdRef.current = allMessages[allMessages.length - 1].id;
      return;
    }

    const lastMessage = allMessages[allMessages.length - 1];

    // Only speak final result or assistant messages
    if (lastMessage.role !== 'result' && lastMessage.role !== 'assistant') return;

    // Skip if already spoken
    if (spokenMessageIdsRef.current.has(lastMessage.id)) return;

    // Skip if this message existed before voice mode was activated
    if (lastMessage.id === lastSpokenMessageIdRef.current) return;

    // Skip stopped/aborted turns (empty text)
    if (!lastMessage.text?.trim()) return;

    // Skip if agent is still sending (wait for completion)
    if (isSending) return;

    // Mark as spoken and trigger TTS
    spokenMessageIdsRef.current.add(lastMessage.id);
    void speakText(lastMessage.text);
  }, [voiceModeActive, allMessages, isSending, speakText]);

  const showMessageActions = useCallback((message: SessionMessage) => {
    const messageText = message.text?.trim();
    if (!messageText) return;

    const copyText = () => {
      Clipboard.setString(messageText);
      hapticLight();
    };

    const shareText = () => {
      void Share.share({ message: messageText });
    };

    const isAssistantMessage = message.role !== 'user';

    if (Platform.OS === 'ios') {
      const options = isAssistantMessage ? ['Cancel', 'Copy text', 'Share'] : ['Cancel', 'Copy text'];

      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) copyText();
          if (buttonIndex === 2) shareText();
        },
      );
      return;
    }

    Alert.alert(
      'Message actions',
      undefined,
      [
        { text: 'Copy text', onPress: copyText },
        ...(isAssistantMessage ? [{ text: 'Share', onPress: shareText }] : []),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, []);

  const renderMessageItem = useCallback(({ item }: { item: ConversationMessage }) => {
    const hasSeen = seenMessageIdsRef.current.has(item.id);
    const shouldAnimateIn = didCaptureInitialRenderRef.current && !hasSeen;
    if (!hasSeen) {
      seenMessageIdsRef.current.add(item.id);
    }

    const isTurnTailMessage =
      (item.role === 'assistant' || item.role === 'result') &&
      item.turnId &&
      lastNonUserMessageIdByTurnId[item.turnId] === item.id;

    const turnToolEvents = isTurnTailMessage
      ? currentSession?.toolEventsByTurn?.[item.turnId]
      : undefined;

    const fallbackTurnSteps = isTurnTailMessage
      ? useSessionStore.getState().completedStepsByTurnId[item.turnId]
      : undefined;

    const missionTaskSnapshot = isTurnTailMessage
      ? useSessionStore.getState().missionTaskByTurnId[item.turnId]
      : undefined;

    return (
      <>
        {turnBoundaries.has(item.id) && <TurnSeparator />}
        <Animated.View
          entering={shouldAnimateIn ? FadeIn.duration(200) : undefined}
          style={item.id === completionPulseMessageId ? completionPulseStyle : undefined}
        >
          {isTurnTailMessage ? (
            <TurnToolActivity
              turnId={item.turnId}
              events={turnToolEvents}
              fallbackSteps={fallbackTurnSteps}
              missionContext={missionTaskSnapshot?.mission}
              taskProgress={missionTaskSnapshot?.tasks}
              hasMissionSet={missionTaskSnapshot?.hasMissionSet}
              touchedTaskIds={missionTaskSnapshot?.touchedTaskIds}
              owningSessionId={currentSession?.id}
            />
          ) : null}

          <MessageBubble
            message={item}
            isQueued={item.isQueued === true}
            isPermanentFailure={item.isPermanentFailure === true}
            lastError={item.lastError}
            queueItemStatus={item.queueItemStatus}
            onLongPress={() => showMessageActions(item)}
            onLinkPress={handleLinkPress}
          />
        </Animated.View>
      </>
    );
  }, [
    turnBoundaries,
    completionPulseMessageId,
    completionPulseStyle,
    currentSession?.toolEventsByTurn,
    lastNonUserMessageIdByTurnId,
    showMessageActions,
    handleLinkPress,
  ]);

  const connectionState = useSessionStore((s) => s.connectionState);

  // Count pending recordings for this session.
  // Uses subscribe pattern (not hook) to be safe when queue store isn't initialized.
  const [pendingRecordingCount, setPendingRecordingCount] = useState(0);
  useEffect(() => {
    const deriveQueueState = (items: QueueItem[]): void => {
      const recordingCount = items.filter(
        (item) =>
          item.type === 'voice-transcription'
          && (item.metadata as { sessionId?: string | null }).sessionId === id,
      ).length;
      setPendingRecordingCount(recordingCount);

      const textPreviews = items
        .filter(
          (item) =>
            (item.type === 'text-message' || item.type === 'text-with-attachments')
            && (item.metadata as { sessionId?: string | null }).sessionId === id,
        )
        .map((item) => ({
          itemId: item.id,
          text: (item.metadata as { prompt?: string }).prompt?.trim() ?? '',
          enqueuedAt: item.enqueuedAt,
          isPermanentFailure: item.isPermanentFailure || false,
          lastError: item.lastError,
          status: item.status,
          triggerMeta: (item.metadata as { triggerMeta?: MeetingCompanionTriggerMeta }).triggerMeta,
        }))
        .filter((item) => item.text.length > 0)
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt);

      setQueuedTextPreviews(textPreviews);
    };

    try {
      const unsub = useOfflineQueueStore.subscribe((state: {
        items: QueueItem[];
      }) => {
        deriveQueueState(state.items);
      });
      // Set initial value
      try {
        const state = useOfflineQueueStore.getState();
        deriveQueueState(state.items);
      } catch { /* store may not be ready */ }
      return unsub;
    } catch {
      // Queue store not initialized — ignore
      setPendingRecordingCount(0);
      setQueuedTextPreviews([]);
      return undefined;
    }
  }, [id]);

  const isBusy = isSending || currentSession?.isBusy;
  // Don't show loading/error states while we have an active turn or optimistic content
  const hasActiveContent = isSending || optimisticMessages.length > 0 || streamingText.length > 0;
  const showActivity = isBusy && !streamingText;
  // When server reports busy but we have no local turn (crash recovery),
  // provide a connection-aware fallback headline.
  const connectionSuffix =
    connectionState === 'reconnecting' ? ' · Reconnecting...' :
    connectionState === 'disconnected' ? ' · Disconnected' : '';
  const effectiveHeadline = thinkingHeadline
    ? thinkingHeadline + connectionSuffix
    : showActivity
      ? `Rebel is working on this...${connectionSuffix}`
      : '';
  const mdStyles = useMemo(() => createMarkdownStyles(colors), [colors]);
  const askSparkPickerSubtitleVariant: AskSparkPickerSubtitleVariant =
    transcriptStatus === 'offline'
      ? 'offline'
      : meetingTrigger.rateLimited
        ? 'rate-limited'
        : 'default';
  const askSparkDisabled = Boolean(isSending || currentSession?.isBusy || !id);

  const canRequestCouncilReview = useMemo(() => {
    if (isBusy || !councilAvailable) return false;
    const hasAssistantMessage = allMessages.some((m: SessionMessage) => m.role === 'assistant' || m.role === 'result');
    if (!hasAssistantMessage) return false;
    const lastUserMsg = [...allMessages].reverse().find((m: SessionMessage) => m.role === 'user');
    if (lastUserMsg?.text === COUNCIL_REVIEW_PROMPT) return false;
    return true;
  }, [isBusy, councilAvailable, allMessages]);

  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const keyboardVerticalOffset = headerHeight;
  const handleDismissSessionConflict = useCallback(() => {
    if (!id) return;
    dismissSessionConflict(id);
  }, [dismissSessionConflict, id]);

  const handleOpenSessionConflictDetails = useCallback(() => {
    Alert.alert('Edited elsewhere', sessionConflictDetails);
  }, [sessionConflictDetails]);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerTitle: currentSession?.title || 'New conversation',
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.textPrimary,
          headerBackTitle: '',
          headerShadowVisible: false,
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {showSessionConflictBadge ? (
                <View style={s.headerConflictBadge} testID="session-conflict-badge-mobile">
                  <TouchableOpacity
                    onPress={handleOpenSessionConflictDetails}
                    accessibilityRole="button"
                    accessibilityLabel={`Edited elsewhere ${sessionConflictAgeLabel ?? ''}`.trim()}
                    hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                  >
                    <Feather name="alert-triangle" size={12} color={colors.warning} />
                    <Text style={s.headerConflictText}>
                      {sessionConflictAgeLabel ? `Edited elsewhere ${sessionConflictAgeLabel}` : 'Edited elsewhere'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleDismissSessionConflict}
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss conflict badge"
                    hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
                  >
                    <Feather name="x" size={12} color={colors.warning} />
                  </TouchableOpacity>
                </View>
              ) : null}
              <TouchableOpacity
                testID="conversation-actions-button"
                onPress={showConversationActions}
                accessibilityRole="button"
                accessibilityLabel="Conversation actions"
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <Feather name="more-horizontal" size={20} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
          ),
        }}
      />
      <KeyboardAvoidingView
        testID="conversation-screen"
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? keyboardVerticalOffset : 0}
      >
        {isLoadingSession && !currentSession && !hasActiveContent ? (
          <View style={s.centered} testID="conversation-loading-indicator">
            <Skeleton />
          </View>
        ) : sessionError && !currentSession && !hasActiveContent ? (
          <View style={s.centered}>
            <Text testID="conversation-error" style={s.errorText}>{sessionError}</Text>
            <TouchableOpacity
              testID="conversation-retry-button"
              style={s.retryButton}
              onPress={() => id && useSessionStore.getState().fetchSession(id)}
            >
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {isLiveMeetingCompanion && meetingRecordingCtx.isRecording && companionStartTime && (
              <MeetingRecordingBanner
                title={meetingRecordingCtx.meetingTitle || 'Meeting'}
                startTime={companionStartTime}
                isRecording={meetingRecordingCtx.isRecording}
                transcriptStatus={transcriptStatus}
                onStop={handleStopMeetingRecording}
                onAskSparkPress={handleAskSparkOpen}
                askSparkDisabled={askSparkDisabled}
                askSparkSubmitting={isSending}
                askSparkPulsing={meetingTrigger.pulsing}
                rateLimited={meetingTrigger.rateLimited}
                awaitingTurn={meetingTrigger.awaitingTurn}
                lastDropReason={meetingTrigger.lastDropReason}
              />
            )}
            <AskSparkPicker
              visible={askSparkPickerVisible}
              onClose={() => setAskSparkPickerVisible(false)}
              onSelectPrompt={handleAskSparkSelect}
              subtitleVariant={askSparkPickerSubtitleVariant}
            />
            <FlatList
              testID="conversation-messages-list"
              ref={listRef}
              style={s.messagesList}
              data={allMessages}
              keyExtractor={(item) => item.id}
              renderItem={renderMessageItem}
              contentContainerStyle={[s.messages, allMessages.length === 0 && s.messagesEmpty]}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={
                mobileSlackContext ? (
                  <SilentErrorBoundary
                    boundaryName="conversation-slack-context-chip"
                    resetKey={`${id ?? 'new'}:${mobileSlackContext.kind}`}
                  >
                    <View style={s.slackContextHeader}>
                      <SlackContextChip externalContext={mobileSlackContext} />
                    </View>
                  </SilentErrorBoundary>
                ) : null
              }
              onContentSizeChange={handleContentSizeChange}
              onScroll={handleScroll}
              keyboardDismissMode="interactive"
              maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
              scrollEventThrottle={16}
              ListFooterComponent={
                <>
                  {showActivity && <AgentActivityBubble headline={effectiveHeadline} completedSteps={effectiveSteps} missionContext={effectiveMission} taskProgress={effectiveTasks} subAgentItems={effectiveSubAgents} hasMissionSet={effectiveHasMissionSet} touchedTaskIds={effectiveTouchedTaskIds} />}
                  {streamingText ? (
                    <View testID="conversation-streaming-message" style={[mb.container, mb.assistantContainer]}>
                      <View style={[mb.bubble, mb.assistantBubble]}>
                        <Markdown
                          onLinkPress={handleStreamingLinkPress}
                          style={mdStyles}
                          markdownit={conversationMarkdownIt}
                          defaultImageHandler={null}
                        >
                          {streamingText}
                        </Markdown>
                        <Animated.Text style={[mb.text, mb.assistantText, cursorStyle]}>▍</Animated.Text>
                      </View>
                    </View>
                  ) : null}
                  {turnError && !isSending && (
                    <View testID="conversation-turn-error-card" style={{ marginHorizontal: 12, marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.error }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <Feather name="alert-circle" size={16} color={colors.error} />
                        <Text style={{ ...typography.bodySmall, flex: 1, color: colors.textPrimary }}>{turnError}</Text>
                      </View>
                      <TouchableOpacity
                        testID="conversation-turn-error-retry-button"
                        style={{ alignSelf: 'flex-start', backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 }}
                        onPress={() => {
                          clearError();
                        }}
                      >
                        <Text style={{ ...typography.bodySmall, fontWeight: '600', color: '#fff' }}>Dismiss</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  {id && lastAssistantMessageId && !isSending ? (
                    <View style={s.feedbackPromptSlot}>
                      <ConversationFeedbackPrompt
                        sessionId={id}
                        lastAssistantMessageId={lastAssistantMessageId}
                        lastAssistantTurnId={lastAssistantTurnId}
                        lastAssistantMessageIndex={lastAssistantMessageIndex}
                        isSending={isSending}
                        showToast={({ title, description }) => {
                          if (description) {
                            showToast(`${title}. ${description}`);
                            return;
                          }
                          showToast(title);
                        }}
                      />
                    </View>
                  ) : null}
                </>
              }
              ListEmptyComponent={
                isLoadingSession ? (
                  <View style={s.centered} testID="conversation-inline-loading">
                    <Skeleton lines={2} />
                  </View>
                ) : turnError && !isSending ? (
                  <View style={s.centered}>
                    <Feather name="alert-circle" size={32} color={colors.error} style={{ marginBottom: 8 }} />
                    <Text testID="conversation-turn-error" style={s.errorText}>{turnError}</Text>
                    <TouchableOpacity
                      testID="conversation-turn-retry-button"
                      style={s.retryButton}
                      onPress={() => {
                        clearError();
                        if (id && initialPrompt) startTurn(id, initialPrompt, undefined, liveMeetingOptions);
                      }}
                    >
                      <Text style={s.retryText}>Try again</Text>
                    </TouchableOpacity>
                  </View>
                ) : !isSending && !input.trim() ? (
                  <View testID="conversation-empty-state" style={s.emptyStateContainer}>
                    {isFocused && <FloatingOrbs count={2} />}
                    <Animated.View entering={FadeIn.duration(600)} style={s.emptyStateContent}>
                      <Text style={s.emptyStateQuip}>{idleQuip}</Text>
                    </Animated.View>
                  </View>
                ) : null
              }
            />

            {showScrollButton && (
              <TouchableOpacity
                testID="conversation-scroll-to-bottom-button"
                style={[s.scrollToBottomButton, { bottom: isTextMode ? 70 : 110 }]}
                onPress={scrollToBottom}
                activeOpacity={0.7}
              >
                <Feather name="chevron-down" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            )}

            <ScrollView
              testID="conversation-composer-accessories"
              style={[s.composerAccessories, { maxHeight: Math.round(windowHeight * 0.4) }]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {id && <ConversationApprovalBanner sessionId={id} />}

              {/* Inline user-question cards render first in the scrollable
               * accessory region so they stay reachable when the dock is
               * protected, even if a compressed region requires scrolling.
               * See docs/plans/260420_user_question_cross_surface_resilience.md Stage 5. */}
              {userQuestionBatches
                .filter((b) => !b.dismissed)
                .map((b) => {
                  if (!b.isAnswered && b.batch.batchId === minimizedQuestionBatchId) {
                    return (
                      <View key={b.batch.batchId} style={{ paddingHorizontal: 12, paddingTop: 8 }}>
                        <MinimizedQuestionPill
                          batchId={b.batch.batchId}
                          onRestore={handleRestoreMinimizedQuestion}
                          onDismiss={handleDismissMinimizedQuestion}
                        />
                      </View>
                    );
                  }
                  return (
                    <View key={b.batch.batchId} style={{ paddingHorizontal: 12, paddingTop: 8 }}>
                      <UserQuestionCard
                        batch={b.batch}
                        isAnswered={b.isAnswered}
                        answers={b.answers}
                        skipped={b.skipped}
                        isSubmitting={isUserQuestionSubmitting}
                        error={userQuestionError}
                        onSubmit={submitUserQuestionAnswers}
                        onSkip={skipUserQuestionBatch ?? (async () => { /* skip not supported on this surface */ })}
                        onDismiss={dismissUserQuestionBatch}
                        onMinimize={handleMinimizeQuestion}
                      />
                    </View>
                  );
                })}

              {pendingRecordingCount > 0 && (
                <View testID="conversation-pending-indicator" style={s.pendingIndicator}>
                  <Feather name="clock" size={12} color={colors.textTertiary} />
                  <Text style={s.pendingIndicatorText}>
                    {pendingRecordingCount === 1
                      ? '1 recording pending'
                      : `${pendingRecordingCount} recordings pending`}
                  </Text>
                </View>
              )}

              {voiceError && (
                <View testID="conversation-voice-error" style={s.voiceError}>
                  <Text style={s.voiceErrorText}>{voiceError}</Text>
                </View>
              )}

              {ttsError && (
                <View testID="conversation-tts-error" style={s.ttsError}>
                  <Text style={s.ttsErrorText}>{ttsError}</Text>
                </View>
              )}

              {attachError && (
                <View testID="conversation-attach-error" style={s.attachError}>
                  <Text style={s.attachErrorText}>{attachError}</Text>
                </View>
              )}

              {attachments.length > 0 && (
                <View testID="conversation-attachments-strip" style={s.attachmentStrip}>
                  {attachments.map((att) => (
                    <View
                      key={att.id}
                      testID={`conversation-attachment-item-${att.id}`}
                      style={{ position: 'relative' }}
                    >
                      <View style={s.thumbnailContainer}>
                        {att.type === 'image' ? (
                          <Image
                            source={{ uri: `data:${att.mimeType};base64,${att.base64Data}` }}
                            style={s.thumbnailImage}
                          />
                        ) : (
                          <Feather
                            name={att.type === 'document' ? 'file-text' : 'file'}
                            size={24}
                            color={colors.textSecondary}
                          />
                        )}
                      </View>
                      <TouchableOpacity
                        testID={`conversation-attachment-remove-button-${att.id}`}
                        style={s.thumbnailRemove}
                        onPress={() => { noteUserEdit(); removeAttachment(att.id); }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Feather name="x" size={12} color="#fff" />
                      </TouchableOpacity>
                      {att.type !== 'image' && (
                        <Text style={s.thumbnailName} numberOfLines={1}>
                          {att.name}
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              )}

              {canRequestCouncilReview && (
                <View style={{ alignItems: 'center', paddingVertical: 4 }}>
                  <TouchableOpacity
                    testID="conversation-council-review-button"
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: colors.surface,
                    }}
                    onPress={handleCouncilReview}
                    activeOpacity={0.7}
                    accessibilityLabel="Council review"
                  >
                    <Feather name="users" size={14} color={colors.textSecondary} />
                    <Text style={{ ...typography.caption, color: colors.textSecondary }}>Review</Text>
                  </TouchableOpacity>
                </View>
              )}

              {currentSession && (
                <FinishLineChip
                  value={finishLine}
                  onPress={() => setIsFinishLineEditorOpen(true)}
                />
              )}
            </ScrollView>

            {toast && (
              <View testID="conversation-toast" style={s.toast}>
                <Text style={s.toastText}>{toast}</Text>
              </View>
            )}

            {isTextMode ? (
              <View testID="conversation-input-bar" style={[s.inputBar, { flexShrink: 0, paddingBottom: 12 + insets.bottom }]}>
                <TouchableOpacity
                  testID="conversation-voice-toggle-button"
                  style={s.keyboardButton}
                  onPress={() => setIsTextMode(false)}
                  accessibilityLabel="Switch to voice"
                  activeOpacity={0.7}
                >
                  <Feather name="mic" size={20} color={colors.textTertiary} />
                </TouchableOpacity>
                <TouchableOpacity
                  testID="conversation-attach-button"
                  style={[s.attachButton, (!canAddMore || isSending) && s.attachButtonDisabled]}
                  onPress={handleAttach}
                  disabled={!canAddMore || isSending}
                  activeOpacity={0.7}
                >
                  <Feather name="paperclip" size={20} color={canAddMore && !isSending ? colors.textSecondary : colors.textTertiary} />
                </TouchableOpacity>
                <TextInput
                  testID="conversation-input"
                  style={s.input}
                  value={input}
                  onChangeText={(v) => { setInput(v); noteUserEdit(); }}
                  placeholder={messageInputPlaceholder}
                  placeholderTextColor={isRecording ? '#ef4444' : colors.textTertiary}
                  multiline
                  maxLength={10_000}
                  editable={!isSending && !isRecording}
                />
                {isBusy ? (
                  <Pressable testID="conversation-stop-button" style={s.stopButton} onPress={onStop}>
                    <View style={s.stopIcon} />
                  </Pressable>
                ) : isTranscribing ? (
                  <ActivityIndicator
                    testID="conversation-transcribing-indicator"
                    color={colors.accent}
                    size="small"
                  />
                ) : input.trim() ? (
                  <Pressable
                    testID="conversation-send-button"
                    style={s.sendButton}
                    onPress={handleSend}
                    onLongPress={() => {
                      hapticLight();
                      if (isBackgroundSession) {
                        handleSend();
                        return;
                      }
                      if (Platform.OS === 'ios') {
                        ActionSheetIOS.showActionSheetWithOptions(
                          {
                            options: ['Cancel', 'Send', 'Send & done'],
                            cancelButtonIndex: 0,
                          },
                          (buttonIndex) => {
                            if (buttonIndex === 1) handleSend();
                            if (buttonIndex === 2) handleSendAndDone();
                          },
                        );
                      } else {
                        Alert.alert('Send options', undefined, [
                          { text: 'Send', onPress: handleSend },
                          { text: 'Send & done', onPress: handleSendAndDone },
                          { text: 'Cancel', style: 'cancel' },
                        ]);
                      }
                    }}
                    delayLongPress={300}
                  >
                    <Feather name="send" size={16} color="#fff" />
                  </Pressable>
                ) : (
                  <Animated.View style={pulseStyle}>
                    <Pressable
                      testID="conversation-mic-button"
                      style={[s.micButton, isRecording && s.micButtonRecording, isMeetingRecording && { opacity: 0.4 }]}
                      onPress={() => {
                        if (isMeetingRecording) { showToast('Meeting recording in progress'); return; }
                        voiceIntentRef.current = null; toggleRecording();
                      }}
                      haptic={false}
                      disabled={isMeetingRecording}
                    >
                      <Feather name="mic" size={20} color={isRecording ? '#ef4444' : colors.textSecondary} />
                    </Pressable>
                  </Animated.View>
                )}
              </View>
            ) : (
              <View testID="conversation-voice-bar" style={[s.voiceFirstBar, voiceModeActive && s.voiceFirstBarActive, { flexShrink: 0, paddingBottom: 20 + insets.bottom }]}>
                <View>
                  {voiceModeLabel && (
                    <Animated.View
                      entering={FadeIn.duration(150)}
                      exiting={FadeOut.duration(300)}
                      style={s.voiceModeLabel}
                      pointerEvents="none"
                    >
                      <Text style={[s.voiceModeLabelText, voiceModeActive && s.voiceModeLabelTextActive]}>
                        {voiceModeLabel}
                      </Text>
                    </Animated.View>
                  )}
                  <Animated.View style={voiceModeToggleAnimStyle}>
                    <TouchableOpacity
                      testID="conversation-voice-mode-toggle"
                      style={[s.voiceModeToggle, voiceModeActive && s.voiceModeToggleActive]}
                      onPress={handleVoiceModeToggle}
                      accessibilityLabel={voiceModeActive ? 'Disable voice replies' : 'Enable voice replies'}
                      activeOpacity={0.7}
                    >
                      <Feather name="volume-2" size={20} color={voiceModeActive ? '#fff' : colors.textSecondary} />
                    </TouchableOpacity>
                  </Animated.View>
                </View>

                <View style={s.voiceBarCenter}>
                  {isBusy ? (
                    <Pressable
                      testID="conversation-voice-stop-button"
                      style={s.voiceStopButtonLarge}
                      onPress={onStop}
                    >
                      <View style={s.voiceStopIcon} />
                    </Pressable>
                  ) : isTranscribing ? (
                    <View testID="conversation-transcribing-indicator" style={s.voiceTranscribingRow}>
                      <ActivityIndicator color={colors.accent} size="small" />
                      <Text style={s.voiceTranscribingText}>Transcribing…</Text>
                    </View>
                  ) : isRecording ? (
                    <View style={s.voiceRecordingContainer}>
                      <View style={s.voiceRecordingRow}>
                        <ListeningGlow isActive size={64} mode="listening">
                          <Pressable
                            testID="conversation-voice-send-button"
                            style={[s.voiceMicLarge, s.voiceMicLargeRecording]}
                            onPress={handleVoiceStopAndSend}
                            accessibilityLabel="Stop recording and send"
                            haptic={false}
                          >
                            <Feather name="send" size={24} color="#fff" />
                          </Pressable>
                        </ListeningGlow>
                        <Text style={s.voiceHintRecordingText}>Tap to send</Text>
                      </View>
                      <Animated.View
                        entering={FadeInDown.duration(250).springify()}
                        style={s.voiceRecordingActions}
                      >
                        {!voiceModeActive && (
                          <Pressable
                            testID="conversation-voice-edit-button"
                            style={s.voiceActionPill}
                            onPress={handleVoiceStopAndEdit}
                            accessibilityLabel="Edit text before sending"
                            haptic={false}
                          >
                            <Feather name="edit-2" size={14} color={colors.textSecondary} />
                            <Text style={s.voiceActionPillText}>Edit first</Text>
                          </Pressable>
                        )}
                        {!isBackgroundSession && (
                          <Pressable
                            testID="conversation-voice-send-done-button"
                            style={[s.voiceActionPill, s.voiceActionPillSuccess]}
                            onPress={handleVoiceStopAndSendDone}
                            accessibilityLabel="Send and mark as done"
                            haptic={false}
                          >
                            <Feather name="check-circle" size={14} color={colors.success} />
                            <Text style={[s.voiceActionPillText, s.voiceActionPillSuccessText]}>Send & done</Text>
                          </Pressable>
                        )}
                      </Animated.View>
                    </View>
                  ) : isSpeaking || ttsLoading ? (
                    <>
                      <ListeningGlow isActive={isSpeaking} size={64} mode="speaking">
                        <Pressable
                          testID="conversation-mic-button"
                          style={[s.voiceMicLarge, isMeetingRecording && { opacity: 0.4 }]}
                          onPress={() => { hapticLight(); void handleStartRecording(); }}
                          accessibilityLabel={isMeetingRecording ? 'Voice recording disabled — meeting recording in progress' : 'Tap to interrupt and speak'}
                          haptic={false}
                          disabled={isMeetingRecording}
                        >
                          {ttsLoading ? (
                            <ActivityIndicator color="#fff" size="small" />
                          ) : (
                            <Feather name="mic" size={28} color="#fff" />
                          )}
                        </Pressable>
                      </ListeningGlow>
                      <View>
                        <Text style={s.voiceHintText}>{ttsLoading ? 'Preparing reply…' : 'Rebel is speaking…'}</Text>
                      </View>
                    </>
                  ) : (
                    <>
                      <ListeningGlow isActive={false} size={64}>
                        <Pressable
                          testID="conversation-mic-button"
                          style={[s.voiceMicLarge, isMeetingRecording && { opacity: 0.4 }]}
                          onPress={() => {
                            if (isMeetingRecording) { showToast('Meeting recording in progress'); return; }
                            voiceIntentRef.current = voiceModeActive ? 'send' : null;
                            hapticLight();
                            toggleRecording();
                          }}
                          accessibilityLabel={isMeetingRecording ? 'Voice recording disabled — meeting recording in progress' : 'Tap to speak'}
                          haptic={false}
                          disabled={isMeetingRecording}
                        >
                          <Feather name="mic" size={28} color="#fff" />
                        </Pressable>
                      </ListeningGlow>
                      <View>
                        <Text style={s.voiceHintText}>{isMeetingRecording ? 'Meeting recording in progress' : 'Tap to speak'}</Text>
                      </View>
                    </>
                  )}
                </View>

                {!isBusy && !isTranscribing && !isRecording && !isSpeaking && !ttsLoading ? (
                  <TouchableOpacity
                    testID="conversation-text-toggle-button"
                    style={s.keyboardButton}
                    onPress={() => setIsTextMode(true)}
                    accessibilityLabel="Switch to typing"
                    activeOpacity={0.7}
                  >
                    <Feather name="type" size={20} color={colors.textTertiary} />
                  </TouchableOpacity>
                ) : (
                  <View style={s.voiceBarSpacer} />
                )}
              </View>
            )}
          </>
        )}
      </KeyboardAvoidingView>
      <FileViewerModal
        {...fileViewer.viewerProps}
        onLinkPress={handleLinkPress}
      />
      <FinishLineEditorSheet
        visible={isFinishLineEditorOpen}
        initialValue={finishLine}
        onClose={() => setIsFinishLineEditorOpen(false)}
        onSave={handleSaveFinishLine}
      />
    </>
  );
}
