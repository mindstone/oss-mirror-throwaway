// mobile/app/(tabs)/inbox.tsx

import { useEffect, useCallback, useState, useRef, useMemo, memo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SectionList,
  ActivityIndicator,
  RefreshControl,
  Animated as RNAnimated,
  ScrollView,
  Platform,
  Keyboard,
  type KeyboardEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  useInboxStore,
  useApprovalStore,
  useStagedFilesStore,
  createAgentTurnSocket,
  formatRelativeTime,
  getProcessingQuip,
  sortInboxItems,
  groupByTemporal,
  ipcCall,
  readWorkspaceFile,
  TEMPORAL_GROUP_META,
  type InboxItem,
  type InboxHistoryEntry,
  type ConcreteTemporalGroup,
  type StagedFile,
} from '@rebel/cloud-client';
import { buildConversationalResolutionPrompt } from '@rebel/shared';

import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useColors, type ColorTokens } from '../../src/theme/colors';
import { createTypography } from '../../src/theme/typography';
import { hapticLight, hapticMedium } from '../../src/utils/haptics';
import { tracking as analyticsTracking } from '../../src/analytics/tracking';
import { isToday, getSnoozeDueBy } from '../../src/utils/dateHelpers';
import { StagedFilesSection } from '../../src/components/StagedFilesSection';
import { InboxItemDetailModal } from '../../src/components/InboxItemDetailModal';
import {
  ApprovalSheetHost,
  type ApprovalSheetHandle,
} from '../../src/components/approval/ApprovalSheetHost';
import { useApprovalSheet } from '../../src/components/approval/ApprovalSheetProvider';
import { describeMintError } from '../../src/components/approval/mintErrorMessages';

const typography = createTypography(true);
import { Pressable } from '../../src/components/Pressable';
import { ToolApprovalCard, StagedCallCard, MemoryApprovalCard } from '../../src/components/ApprovalCards';
import { InboxArchivedSection } from '../../src/components/InboxArchivedSection';
import { InboxHandledSection } from '../../src/components/InboxHandledSection';
import { SwipeableRow } from '../../src/components/SwipeableRow';
import { useApprovalActions } from '../../src/hooks/useApprovalActions';
import { useNetworkContext } from '../../src/context/NetworkContext';
import { deferNativeCleanup } from '../../src/utils/deferNativeCleanup';


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMPORAL_SECTION_ORDER: ConcreteTemporalGroup[] = ['due-today', 'due-this-week', 'upcoming'];

function getHandledSessionId(item: InboxItem): string | undefined {
  if (typeof item.executingSessionId === 'string' && item.executingSessionId.length > 0) {
    return item.executingSessionId;
  }

  const historySessionId = (item as Partial<InboxHistoryEntry>).sessionId;
  if (typeof historySessionId === 'string' && historySessionId.length > 0) {
    return historySessionId;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Styles factory
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    centered: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: colors.background,
      padding: 24,
    },
    header: {
      paddingHorizontal: 16,
      paddingBottom: 12,
      backgroundColor: colors.background,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
    },
    headerTitle: {
      ...typography.title,
      fontSize: 28,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    headerCount: {
      ...typography.bodySmall,
      color: colors.textTertiary,
    },
    errorBanner: {
      backgroundColor: colors.errorLight,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    errorBannerText: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.error,
    },
    list: { paddingTop: 4, paddingBottom: 32 },
    separator: { height: 8 },

    // Approval section
    approvalSection: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
      gap: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      marginBottom: 4,
    },
    approvalSectionTitle: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
    },
    approvalErrorText: {
      ...typography.caption,
      color: colors.error,
      textAlign: 'center',
    },
    temporalSectionHeader: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: colors.background,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    temporalSectionTitle: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
    },
    temporalSectionCountBadge: {
      minWidth: 24,
      height: 24,
      borderRadius: 12,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    temporalSectionCountText: {
      ...typography.caption,
      fontSize: 12,
      fontWeight: '700',
      color: colors.textSecondary,
    },

    // Item card (compact)
    itemCard: {
      marginHorizontal: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 6,
      backgroundColor: colors.surface,
      borderRadius: 16,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    itemCardExecuting: {
      backgroundColor: colors.accentLight,
    },
    itemCardDoNow: {},
    itemCardSchedule: {},
    itemHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    itemTitle: {
      ...typography.body,
      fontWeight: '600',
      color: colors.textPrimary,
      flex: 1,
    },
    urgencyIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    urgencyDotUrgent: {
      width: 7,
      height: 7,
      borderRadius: 3.5,
      backgroundColor: colors.error,
    },
    urgencyDotImportant: {
      width: 7,
      height: 7,
      borderRadius: 3.5,
      borderWidth: 1.5,
      borderColor: colors.accentMuted,
      backgroundColor: 'transparent',
    },
    urgencyLabelUrgent: {
      ...typography.caption,
      fontSize: 11,
      fontWeight: '700',
      color: colors.error,
      letterSpacing: 0.3,
    },
    urgencyLabelImportant: {
      ...typography.caption,
      fontSize: 11,
      fontWeight: '600',
      color: colors.textTertiary,
      letterSpacing: 0.3,
    },
    progressHint: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textTertiary,
      marginTop: 4,
    },
    itemFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 2,
    },
    itemTime: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    executingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    executingText: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.accent,
      fontWeight: '600',
    },
    itemPreview: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textTertiary,
      lineHeight: 18,
    },
    itemTagsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 2,
    },
    itemTagPill: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    itemTagText: {
      ...typography.caption,
      fontSize: 11,
      color: colors.textSecondary,
    },

    // Empty state
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    emptyTitle: {
      ...typography.body,
      fontSize: 17,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    emptySubtitle: {
      ...typography.bodySmall,
      color: colors.textTertiary,
      marginTop: 4,
    },

    // "Handled by Rebel" section
    handledSection: {
      paddingHorizontal: 16,
      paddingBottom: 12,
      gap: 8,
    },
    handledToggle: {
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    handledToggleText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.accent,
    },
    handledRow: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 12,
      gap: 4,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    handledTitle: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textSecondary,
      flex: 1,
    },
    handledLink: {
      ...typography.bodySmall,
      fontSize: 13,
      fontWeight: '600',
      color: colors.accent,
    },
    handledHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },

    // Archived
    archivedToggle: {
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    archivedToggleText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textTertiary,
    },
    archivedSection: {
      paddingHorizontal: 16,
      paddingBottom: 24,
      gap: 8,
    },
    archivedRow: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 12,
      gap: 4,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    archivedTitle: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textSecondary,
      flex: 1,
    },
    archivedText: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textTertiary,
    },
    archivedTime: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    historyHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    historyLink: {
      ...typography.bodySmall,
      fontSize: 13,
      fontWeight: '600',
      color: colors.accent,
    },

    // Error / Retry
    errorText: { ...typography.body, fontSize: 15, color: colors.error, textAlign: 'center', marginBottom: 12 },
    retryButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    retryText: { ...typography.body, fontSize: 15, fontWeight: '600', color: '#fff' },

    // Voice (for detail modal mic button)
    micButton: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    micButtonRecording: {
      backgroundColor: colors.errorLight,
      borderColor: '#ef4444',
    },
    voiceError: {
      paddingVertical: 4,
    },
    voiceErrorText: {
      ...typography.caption,
      color: colors.error,
    },
    transcribingRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      paddingVertical: 4,
    },
    transcribingText: {
      ...typography.caption,
      color: colors.textTertiary,
    },

    // Toast
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
    },
    toastText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textPrimary,
    },

    // Detail modal
    modalOverlay: { flex: 1, justifyContent: 'flex-end' },
    modalSheet: { backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%' },
    modalHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 8, marginBottom: 4 },
    modalHeader: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
    modalTitle: { ...typography.headline, fontSize: 18, fontWeight: '700', color: colors.textPrimary },
    modalMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
    modalTimestamp: { ...typography.caption, fontSize: 13, color: colors.textTertiary },
    modalBody: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
    modalSection: { marginBottom: 16 },
    modalSectionTitle: { ...typography.overline, fontSize: 13, fontWeight: '700', color: colors.textTertiary, letterSpacing: 1.5, marginBottom: 12 },
    modalMarkdownWrap: { backgroundColor: colors.surface, borderRadius: 16, padding: 12 },
    clarifyingWrap: { backgroundColor: colors.accentLight, borderRadius: 16, padding: 12 },
    draftWrap: { backgroundColor: colors.successLight, borderRadius: 16, padding: 12 },
    referenceChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, marginBottom: 8 },
    referenceChipText: { ...typography.bodySmall, fontSize: 13, color: colors.textSecondary },
    referencesRow: { flexDirection: 'row', flexWrap: 'wrap' },
    modalContextRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
    modalContextInput: { ...typography.body, flex: 1, backgroundColor: colors.surface, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: colors.textPrimary, borderWidth: 1, borderColor: colors.border, minHeight: 44, maxHeight: 120 },
    modalActions: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
    modalActionPrimary: { flex: 1, backgroundColor: colors.accent, borderRadius: 16, paddingVertical: 12, alignItems: 'center' },
    modalActionPrimaryText: { ...typography.body, fontSize: 15, fontWeight: '700', color: '#fff' },
    modalActionIcon: { width: 44, height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Compact item card — title + quadrant badge + timestamp + executing indicator */
const InboxItemCard = memo(function InboxItemCard({
  item,
  onPress,
  isDeparting,
}: {
  item: InboxItem;
  onPress: (item: InboxItem) => void;
  isDeparting?: boolean;
}) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  const isExecuting = !!item.executingSessionId;
  const isUrgentImportant = item.urgent && item.important;
  const isImportantOnly = !item.urgent && item.important;

  // Departure animation
  const fadeAnim = useRef(new RNAnimated.Value(1)).current;
  const slideAnim = useRef(new RNAnimated.Value(0)).current;

  useEffect(() => {
    if (isDeparting) {
      RNAnimated.parallel([
        RNAnimated.timing(fadeAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        RNAnimated.timing(slideAnim, {
          toValue: -100,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isDeparting, fadeAnim, slideAnim]);

  // Left border style for urgency
  const quadrantBorder =
    isUrgentImportant
      ? s.itemCardDoNow
      : isImportantOnly
        ? s.itemCardSchedule
        : null;

  return (
    <RNAnimated.View
      testID={`inbox-item-${item.id}`}
      style={{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] }}
    >
      <Pressable
        testID={`inbox-item-button-${item.id}`}
        style={[s.itemCard, isExecuting && s.itemCardExecuting, quadrantBorder]}
        onPress={() => onPress(item)}
      >
        <View style={s.itemHeader}>
          <Text style={s.itemTitle} numberOfLines={1}>
            {item.title}
          </Text>
          {isUrgentImportant ? (
            <View testID={`inbox-item-urgency-urgent-${item.id}`} style={s.urgencyIndicator}>
              <View style={s.urgencyDotUrgent} />
              <Text style={s.urgencyLabelUrgent}>Urgent</Text>
            </View>
          ) : isImportantOnly ? (
            <View testID={`inbox-item-urgency-important-${item.id}`} style={s.urgencyIndicator}>
              <View style={s.urgencyDotImportant} />
              <Text style={s.urgencyLabelImportant}>Important</Text>
            </View>
          ) : null}
        </View>

        {!!item.text?.trim() && item.text.trim() !== item.title.trim() && (
          <Text style={s.itemPreview} numberOfLines={1}>
            {item.text.trim()}
          </Text>
        )}

        {item.tags && item.tags.length > 0 && (
          <View style={s.itemTagsRow}>
            {item.tags.slice(0, 3).map((tag) => (
              <View key={tag} style={s.itemTagPill}>
                <Text style={s.itemTagText}>{tag}</Text>
              </View>
            ))}
            {item.tags.length > 3 && (
              <View style={s.itemTagPill}>
                <Text style={s.itemTagText}>+{item.tags.length - 3}</Text>
              </View>
            )}
          </View>
        )}

        <View style={s.itemFooter}>
          <Text style={s.itemTime}>{formatRelativeTime(item.addedAt)}</Text>
          {isExecuting && (
            <View testID="inbox-item-executing" style={s.executingRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={s.executingText}>{getProcessingQuip()}</Text>
            </View>
          )}
        </View>
      </Pressable>
    </RNAnimated.View>
  );
});

function ArchivedItemRow({ item }: { item: InboxItem }) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={s.archivedRow}>
      <Text style={s.archivedTitle} numberOfLines={1}>
        {item.title}
      </Text>
      {item.text ? (
        <Text style={s.archivedText} numberOfLines={1}>
          {item.text}
        </Text>
      ) : null}
      <Text style={s.archivedTime}>
        {formatRelativeTime(item.archivedAt ?? item.addedAt)}
      </Text>
    </View>
  );
}

/** Row for "Handled by Rebel" section — title + "View conversation" link */
function HandledByRebelRow({ item }: { item: InboxItem }) {
  const router = useRouter();
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const handledSessionId = getHandledSessionId(item);

  return (
    <TouchableOpacity
      testID={`inbox-handled-item-${item.id}`}
      style={s.handledRow}
      onPress={() => {
        if (handledSessionId) {
          router.push(`/conversation/${handledSessionId}`);
        }
      }}
      activeOpacity={0.7}
      disabled={!handledSessionId}
    >
      <View style={s.handledHeader}>
        <Text style={s.handledTitle} numberOfLines={1}>
          {item.title}
        </Text>
        {handledSessionId && (
          <Text style={s.handledLink}>View conversation →</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

function HistoryItemRow({ entry }: { entry: InboxHistoryEntry }) {
  const router = useRouter();
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  return (
    <TouchableOpacity
      testID={`inbox-history-item-${entry.id}`}
      style={s.archivedRow}
      onPress={() => router.push(`/conversation/${entry.sessionId}`)}
      activeOpacity={0.7}
    >
      <View style={s.historyHeader}>
        <Text style={s.archivedTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        <Text style={s.historyLink}>View →</Text>
      </View>
      {entry.text ? (
        <Text style={s.archivedText} numberOfLines={1}>
          {entry.text}
        </Text>
      ) : null}
      <Text style={s.archivedTime}>{formatRelativeTime(entry.executedAt)}</Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

type InboxTemporalSection = {
  group: ConcreteTemporalGroup;
  title: string;
  data: InboxItem[];
};

export default function InboxScreen() {
  const router = useRouter();
  const { focusItemId } = useLocalSearchParams<{ focusItemId?: string }>();
  const insets = useSafeAreaInsets();
  const {
    items,
    history,
    isLoading,
    error,
    fetchInbox,
    archiveItem,
    snoozeItem,
    deleteItem,
    executeItem,
    setStatus,
    setQuadrant,
    setTags,
  } = useInboxStore();
  const toolApprovals = useApprovalStore((state) => state.toolApprovals);
  const stagedCalls = useApprovalStore((state) => state.stagedCalls);
  const memoryApprovals = useApprovalStore((state) => state.memoryApprovals);
  const fetchPending = useApprovalStore((state) => state.fetchPending);
  const stagedFiles = useStagedFilesStore((state) => state.files);
  const fetchStagedFiles = useStagedFilesStore((state) => state.fetchStagedFiles);
  const publishFile = useStagedFilesStore((state) => state.publishFile);
  const discardFile = useStagedFilesStore((state) => state.discardFile);
  const keepPrivate = useStagedFilesStore((state) => state.keepPrivate);
  const publishAll = useStagedFilesStore((state) => state.publishAll);
  const discardAll = useStagedFilesStore((state) => state.discardAll);
  const resolveConflict = useStagedFilesStore((state) => state.resolveConflict);
  const mintConflictCapability = useStagedFilesStore((state) => state.mintConflictCapability);
  const stagedError = useStagedFilesStore((state) => state.error);
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const tabBarHeight = useBottomTabBarHeight();
  const { isOnline } = useNetworkContext();

  const [showArchived, setShowArchived] = useState(false);
  const [showHandled, setShowHandled] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const archiveTimerRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const backgroundSocketRef = useRef<{ close: () => void } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [departingIds, setDepartingIds] = useState<Set<string>>(new Set());
  // Ref to the approval detail-sheet host. Tapping a card routes to the
  // host's `openApproval(kind, id)` which mounts the matching bottom sheet.
  const approvalSheetRef = useRef<ApprovalSheetHandle>(null);

  // F-D-R2-8 — register the inbox's local ApprovalSheetHost with the
  // global provider so cousins (e.g. ConversationApprovalBanner) can
  // open detail sheets without prop-drilling a ref. We keep the local
  // ref so inbox can still call openApproval synchronously without a
  // round-trip through context state.
  const { registerHandle } = useApprovalSheet();
  useEffect(() => {
    registerHandle(approvalSheetRef.current);
    return () => registerHandle(null);
  }, [registerHandle]);

  const openToolApprovalSheet = useCallback((id: string) => {
    approvalSheetRef.current?.openApproval('tool', id);
  }, []);
  const openStagedFileSheet = useCallback((file: { id: string }) => {
    approvalSheetRef.current?.openApproval('staged-file', file.id);
  }, []);
  const openMemoryApprovalSheet = useCallback((id: string) => {
    approvalSheetRef.current?.openApproval('memory', id);
  }, []);
  const openStagedCallSheet = useCallback((id: string) => {
    approvalSheetRef.current?.openApproval('staged-call', id);
  }, []);

  const {
    handleApprove,
    handleDeny,
    handleExecute: handleExecuteStagedCall,
    handleReject: handleRejectStagedCall,
    approveMemoryWrite,
    skipMemoryWrite,
    actionError: approvalActionError,
  } = useApprovalActions();

  const nonStagedMemoryApprovals = useMemo(
    () => memoryApprovals.filter((approval) => !approval.staged),
    [memoryApprovals],
  );

  const hasPendingApprovals =
    toolApprovals.length > 0 || stagedCalls.length > 0 || nonStagedMemoryApprovals.length > 0;
  const hasApprovals =
    toolApprovals.length > 0
    || stagedCalls.length > 0
    || nonStagedMemoryApprovals.length > 0
    || stagedFiles.length > 0;

  useEffect(() => {
    return () => {
      clearTimeout(toastTimerRef.current);
      archiveTimerRef.current.forEach(clearTimeout);
      deferNativeCleanup(() => backgroundSocketRef.current?.close());
    };
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSubscription = Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    fetchInbox();
    fetchPending();
    fetchStagedFiles();
  }, [fetchInbox, fetchPending, fetchStagedFiles]);

  // Auto-open detail modal when navigated with a specific item ID from Today cards
  useEffect(() => {
    if (!focusItemId || items.length === 0) return;
    const target = items.find((i) => i.id === focusItemId);
    if (target) {
      setSelectedItemId(target.id);
    }
    router.setParams({ focusItemId: undefined });
  }, [focusItemId, items, router]);

  // Compute "Handled by Rebel" items for today.
  const handledByRebelItems = useMemo(() => {
    const archivedToday = items.filter(
      (item) =>
        item.autoCompleted === true
        && item.archived
        && typeof item.archivedAt === 'number'
        && isToday(item.archivedAt),
    );
    const historyToday = history.filter(
      (entry) => entry.autoCompleted === true && isToday(entry.executedAt),
    );
    return [...archivedToday, ...historyToday];
  }, [items, history]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2000);
  }, []);

  const handleExecute = useCallback(
    async (itemId: string, context: string | undefined, isAutoDone: boolean) => {
      try {
        hapticMedium();
        // Analytics: UI inbox-action tap (client-origin). The execution itself
        // runs on the cloud instance and is emitted there — NOT mirrored. No
        // item content, just the action enum. No-op until analytics initialises.
        analyticsTracking.inboxActionTapped({ action: 'execute' });
        const result = await executeItem(itemId, context);
        // Fire the turn in the background — no navigation needed.
        const socket = createAgentTurnSocket(
          { sessionId: result.sessionId, prompt: result.prompt },
          () => {}, // Events handled by EventBridge
          undefined,
          () => {}, // Close is fine
        );
        backgroundSocketRef.current = socket;
        // Auto-done: only attempt AFTER execute succeeds (fixes race condition)
        if (isAutoDone) {
          setStatus(itemId, 'completed', 'user').catch(() => {});
        }
        showToast(isAutoDone ? 'Rebel is on it \u2014 marked done' : 'Rebel is on it \u2713');
        setSelectedItemId(null);
      } catch {
        showToast('Failed to start');
      }
    },
    [executeItem, setStatus, showToast],
  );

  // Stage 2: Priority editing
  const handleSetPriority = useCallback(
    async (itemId: string, urgent: boolean, important: boolean) => {
      try {
        await setQuadrant(itemId, urgent, important);
      } catch {
        showToast('Failed to update priority');
      }
    },
    [setQuadrant, showToast],
  );

  // Stage 3: Schedule picker
  const handleSnooze = useCallback(
    async (itemId: string, dueBy: number | null) => {
      try {
        hapticLight();
        await snoozeItem(itemId, dueBy);
        showToast(dueBy != null ? 'Scheduled' : 'Schedule cleared');
      } catch {
        showToast('Failed to schedule');
      }
    },
    [snoozeItem, showToast],
  );

  // Stage 5: Tag editing
  const handleSetTags = useCallback(
    async (itemId: string, tags: string[]) => {
      try {
        await setTags(itemId, tags);
        showToast('Tags updated');
      } catch {
        showToast('Failed to update tags');
      }
    },
    [setTags, showToast],
  );

  // Stage 6: Done button
  const handleDone = useCallback(
    async (itemId: string) => {
      try {
        hapticMedium();
        await setStatus(itemId, 'completed', 'user');
        setSelectedItemId(null);
        showToast('Marked done ✓');
      } catch {
        showToast('Failed to mark done');
      }
    },
    [setStatus, showToast],
  );

  const archiveWithAnimation = useCallback(
    (itemId: string, withHaptic = false) => {
      if (withHaptic) {
        hapticMedium();
      }
      setDepartingIds((prev) => new Set(prev).add(itemId));
      const timer = setTimeout(() => {
        void archiveItem(itemId, true);
        setDepartingIds((prev) => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      }, 300);
      archiveTimerRef.current.push(timer);
    },
    [archiveItem],
  );

  const handleMarkDoneFromSwipe = useCallback(
    (itemId: string) => {
      archiveWithAnimation(itemId, false);
    },
    [archiveWithAnimation],
  );

  const handleSnoozeFromSwipe = useCallback(
    async (itemId: string, group: ConcreteTemporalGroup) => {
      const dueBy = getSnoozeDueBy(group);
      if (dueBy == null) {
        return;
      }
      try {
        hapticLight();
        await snoozeItem(itemId, dueBy);
        showToast('Snoozed');
      } catch {
        showToast('Failed to snooze');
      }
    },
    [showToast, snoozeItem],
  );

  const handleDelete = useCallback(
    (itemId: string) => {
      analyticsTracking.inboxActionTapped({ action: 'delete' });
      void deleteItem(itemId);
    },
    [deleteItem],
  );

  const handlePublishFile = useCallback(async (id: string) => {
    await publishFile(id);
  }, [publishFile]);

  const handleDiscardFile = useCallback(async (id: string) => {
    await discardFile(id);
  }, [discardFile]);

  const handleKeepPrivateFile = useCallback(async (id: string) => {
    await keepPrivate(id);
  }, [keepPrivate]);

  const handlePublishAll = useCallback(async () => {
    await publishAll();
  }, [publishAll]);

  const handleDiscardAll = useCallback(async () => {
    await discardAll();
  }, [discardAll]);

  // Stage 6: conflict-resolution handlers. `handleResolveWithRebel` fetches
  // staged + remote content, builds the hardened seed prompt via
  // `buildConversationalResolutionPrompt`, and navigates to the originating
  // session with `?prefill=...`. The composer displays the seeded prompt
  // but does NOT auto-send — the user reviews, optionally tweaks, and taps
  // send manually. `handleKeepMine` / `handleKeepTheirs` call the store's
  // `resolveConflict` action directly (Stage 3's idempotent-success
  // handling means duplicate dispatches are safe).
  const handleResolveWithRebel = useCallback(
    async (file: StagedFile) => {
      // F-B-R2-4: mint + content fetch in parallel so the user-visible
      // latency is min(mint, content). Mint failure blocks navigation
      // entirely — silently routing to a blank conversation drops the
      // user's intent. Content-fetch failure is non-blocking (empty
      // body is legitimately possible when the remote file was deleted);
      // the seed prompt still carries the staged file id + token.
      const [mintResult, stagedResult, remoteResult] = await Promise.allSettled([
        mintConflictCapability(file.id),
        ipcCall<{ content: string | null; error?: string }>('memory:staging-get-content', { id: file.id }),
        readWorkspaceFile(file.realPath),
      ]);

      // Fail-closed mint handling — no silent degradation.
      if (mintResult.status === 'rejected') {
        console.warn('[inbox] Resolve with Rebel: capability mint threw', {
          fileId: file.id,
          reason: mintResult.reason instanceof Error ? mintResult.reason.message : String(mintResult.reason),
        });
        showToast('Could not start conflict resolution. Please try again.');
        return;
      }
      if (!mintResult.value.success) {
        console.warn('[inbox] Resolve with Rebel: capability mint rejected', {
          fileId: file.id,
          error: mintResult.value.error,
        });
        showToast(describeMintError(mintResult.value.error));
        return;
      }
      const capabilityToken = mintResult.value.token;

      const stagedContent =
        stagedResult.status === 'fulfilled' && typeof stagedResult.value.content === 'string'
          ? stagedResult.value.content
          : '';
      const remoteContent =
        remoteResult.status === 'fulfilled' ? remoteResult.value.content : '';

      let prompt: string;
      try {
        prompt = buildConversationalResolutionPrompt({
          stagedFile: {
            id: file.id,
            realPath: file.realPath,
            spaceName: file.spaceName,
            stagedContent,
          },
          remoteContent,
          capabilityToken,
        });
      } catch (err) {
        // Build failure is effectively impossible with a valid minted
        // token + well-formed file metadata, but fail-closed just in
        // case. Surfacing the error keeps the user's intent alive for
        // retry instead of silently routing to a blank conversation.
        console.warn('[inbox] Resolve with Rebel: seed-prompt build failed', {
          fileId: file.id,
          reason: err instanceof Error ? err.message : String(err),
        });
        showToast('Could not prepare the resolution. Please try again.');
        return;
      }

      router.push({
        pathname: '/conversation/[id]',
        params: { id: file.sessionId, prefill: prompt },
      });
    },
    [router, mintConflictCapability, showToast],
  );

  const handleKeepMine = useCallback(
    async (file: StagedFile) => {
      // F-B-R2-5: on mint failure, surface the real server error and
      // SKIP the resolve call. Reaching resolve with an empty token
      // would generic-error out with "Missing capability token" — we
      // want the user to see the actual issue ("refresh needed",
      // "service unavailable", etc.).
      const mintResult = await mintConflictCapability(file.id);
      if (!mintResult.success) {
        console.warn('[inbox] Keep mine: capability mint rejected', {
          fileId: file.id,
          error: mintResult.error,
        });
        showToast(describeMintError(mintResult.error));
        return;
      }
      await resolveConflict(file.id, 'keep-staged', mintResult.token);
    },
    [resolveConflict, mintConflictCapability, showToast],
  );

  const handleKeepTheirs = useCallback(
    async (file: StagedFile) => {
      const mintResult = await mintConflictCapability(file.id);
      if (!mintResult.success) {
        console.warn('[inbox] Keep theirs: capability mint rejected', {
          fileId: file.id,
          error: mintResult.error,
        });
        showToast(describeMintError(mintResult.error));
        return;
      }
      await resolveConflict(file.id, 'keep-real', mintResult.token);
    },
    [resolveConflict, mintConflictCapability, showToast],
  );

  // S3 — memoized sheet-host prop callbacks. Avoids creating a fresh
  // arrow each render so `ApprovalSheetHost` (and its memoized
  // children) don't get new function references per re-render.
  const handleSheetHostPublishFile = useCallback(
    (file: StagedFile) => { void handlePublishFile(file.id); },
    [handlePublishFile],
  );
  const handleSheetHostDiscardFile = useCallback(
    (file: StagedFile) => { void handleDiscardFile(file.id); },
    [handleDiscardFile],
  );
  const handleSheetHostKeepPrivate = useCallback(
    (file: StagedFile) => { void handleKeepPrivateFile(file.id); },
    [handleKeepPrivateFile],
  );
  const handleSheetHostApproveMemory = useCallback(
    (approval: Parameters<typeof approveMemoryWrite>[0]) => {
      void approveMemoryWrite(approval);
    },
    [approveMemoryWrite],
  );
  const handleSheetHostSkipMemory = useCallback(
    (approval: Parameters<typeof skipMemoryWrite>[0]) => {
      void skipMemoryWrite(approval);
    },
    [skipMemoryWrite],
  );
  const handleSheetHostApproveTool = useCallback(
    (approval: { toolUseID: string }, allowForSession: boolean) => {
      // Analytics: UI approval-resolution tap (client-origin). The approved tool
      // then runs on the cloud instance, emitted there — NOT mirrored. No tool
      // args / IDs, just the resolution. No-op until analytics initialises.
      analyticsTracking.approvalResolved({ resolution: 'approved', allowForSession });
      void handleApprove(approval.toolUseID, allowForSession);
    },
    [handleApprove],
  );
  const handleSheetHostDenyTool = useCallback(
    (approval: { toolUseID: string }) => {
      analyticsTracking.approvalResolved({ resolution: 'denied' });
      void handleDeny(approval.toolUseID);
    },
    [handleDeny],
  );
  const handleSheetHostExecuteStagedCall = useCallback(
    (call: { id: string }) => { void handleExecuteStagedCall(call.id); },
    [handleExecuteStagedCall],
  );
  const handleSheetHostRejectStagedCall = useCallback(
    (call: { id: string }) => { void handleRejectStagedCall(call.id); },
    [handleRejectStagedCall],
  );

  // Split items
  const activeItems = useMemo(
    () => sortInboxItems(items.filter((i) => !i.archived)),
    [items],
  );
  const archivedItems = useMemo(
    () => items.filter((i) => i.archived),
    [items],
  );
  const sections = useMemo<InboxTemporalSection[]>(() => {
    const grouped = groupByTemporal(activeItems);

    return TEMPORAL_SECTION_ORDER
      .map((group) => ({
        group,
        title: TEMPORAL_GROUP_META[group].label,
        data: grouped.get(group) ?? [],
      }))
      .filter((section) => section.data.length > 0);
  }, [activeItems]);

  const renderSectionHeader = useCallback(
    ({ section }: { section: InboxTemporalSection }) => (
      <View style={s.temporalSectionHeader}>
        <Text style={s.temporalSectionTitle}>{section.title}</Text>
        <View style={s.temporalSectionCountBadge}>
          <Text style={s.temporalSectionCountText}>{section.data.length}</Text>
        </View>
      </View>
    ),
    [s.temporalSectionCountBadge, s.temporalSectionCountText, s.temporalSectionHeader, s.temporalSectionTitle],
  );

  const renderSectionItem = useCallback(
    ({ item, section }: { item: InboxItem; section: InboxTemporalSection }) => {
      const canSnooze = section.group !== 'upcoming';

      return (
        <SwipeableRow
          // onSwipeLeft fires for the LEFT panel (leftLabel); onSwipeRight for
          // the RIGHT panel (rightLabel). Done is always available (right,
          // always-rendered panel); Snooze is conditional (left, optional panel)
          // so the left panel only appears when canSnooze.
          onSwipeLeft={canSnooze ? () => void handleSnoozeFromSwipe(item.id, section.group) : undefined}
          onSwipeRight={() => {
            handleMarkDoneFromSwipe(item.id);
          }}
          leftLabel="Snooze"
          rightLabel="Done"
        >
          <InboxItemCard
            item={item}
            onPress={(i) => setSelectedItemId(i.id)}
            isDeparting={departingIds.has(item.id)}
          />
        </SwipeableRow>
      );
    },
    [departingIds, handleMarkDoneFromSwipe, handleSnoozeFromSwipe],
  );

  const renderApprovalPanels = useCallback(() => (
    <>
      {stagedFiles.length > 0 && (
        <StagedFilesSection
          files={stagedFiles}
          onPublishFile={handlePublishFile}
          onDiscardFile={handleDiscardFile}
          onKeepPrivateFile={handleKeepPrivateFile}
          onPublishAll={handlePublishAll}
          onDiscardAll={handleDiscardAll}
          onResolveWithRebel={handleResolveWithRebel}
          onKeepMine={handleKeepMine}
          onKeepTheirs={handleKeepTheirs}
          onOpenFile={openStagedFileSheet}
          isOnline={isOnline}
          actionError={stagedError}
        />
      )}

      {hasPendingApprovals && (
        <View testID="inbox-approval-section" style={s.approvalSection}>
          <Text style={s.approvalSectionTitle}>Needs your OK</Text>
          {approvalActionError && (
            <Text testID="inbox-approval-error" style={s.approvalErrorText}>
              {approvalActionError}
            </Text>
          )}
          {toolApprovals.map((approval) => (
            <ToolApprovalCard
              key={approval.toolUseID}
              approval={approval}
              onApprove={(allowForSession) => void handleApprove(approval.toolUseID, allowForSession)}
              onDeny={() => void handleDeny(approval.toolUseID)}
              onOpen={() => openToolApprovalSheet(approval.toolUseID)}
            />
          ))}
          {stagedCalls.map((call) => (
            <StagedCallCard
              key={call.id}
              call={call}
              onExecute={() => void handleExecuteStagedCall(call.id)}
              onReject={() => void handleRejectStagedCall(call.id)}
              onOpen={() => openStagedCallSheet(call.id)}
            />
          ))}
          {nonStagedMemoryApprovals.map((approval) => (
            <MemoryApprovalCard
              key={approval.toolUseId}
              approval={approval}
              onSave={() => void approveMemoryWrite(approval)}
              onSkip={() => void skipMemoryWrite(approval)}
              onOpen={() => openMemoryApprovalSheet(approval.toolUseId)}
            />
          ))}
        </View>
      )}
    </>
  ), [
    approvalActionError,
    approveMemoryWrite,
    handleApprove,
    handleDeny,
    handleDiscardAll,
    handleDiscardFile,
    handleExecuteStagedCall,
    handleKeepMine,
    handleKeepPrivateFile,
    handleKeepTheirs,
    handlePublishAll,
    handlePublishFile,
    handleRejectStagedCall,
    handleResolveWithRebel,
    hasPendingApprovals,
    isOnline,
    nonStagedMemoryApprovals,
    openMemoryApprovalSheet,
    openStagedCallSheet,
    openStagedFileSheet,
    openToolApprovalSheet,
    s.approvalErrorText,
    s.approvalSection,
    s.approvalSectionTitle,
    skipMemoryWrite,
    stagedCalls,
    stagedError,
    stagedFiles,
    toolApprovals,
  ]);

  // Loading state — but don't hide approvals if they exist
  if (isLoading && items.length === 0 && !hasApprovals) {
    return (
      <View style={s.centered}>
        <ActivityIndicator testID="inbox-loading-indicator" color={colors.accent} size="large" />
      </View>
    );
  }

  // Error state (no data loaded) — but don't hide approvals if they exist
  if (error && items.length === 0 && !hasApprovals) {
    return (
      <View style={s.centered}>
        <Text testID="inbox-error" style={s.errorText}>{error}</Text>
        <TouchableOpacity
          testID="inbox-retry-button"
          style={s.retryButton}
          onPress={() => fetchInbox()}
          activeOpacity={0.7}
        >
          <Text style={s.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View testID="inbox-screen" style={s.container}>
      {/* Header — title + item count */}
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <View style={s.headerRow}>
          <Text style={s.headerTitle}>Actions</Text>
          {activeItems.length > 0 && (
            <Text style={s.headerCount}>
              {activeItems.length} item{activeItems.length !== 1 ? 's' : ''}
            </Text>
          )}
        </View>
        {handledByRebelItems.length > 0 && (
          <Text testID="inbox-progress-hint" style={s.progressHint}>
            {handledByRebelItems.length} handled by Rebel today
          </Text>
        )}
      </View>

      {/* Inline error banner */}
      {error && items.length > 0 && (
        <View testID="inbox-error-banner" style={s.errorBanner}>
          <Text style={s.errorBannerText}>{error}</Text>
        </View>
      )}

      {/* Active items or empty state */}
      {activeItems.length > 0 ? (
        <SectionList<InboxItem, InboxTemporalSection>
          testID="inbox-list"
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          renderSectionHeader={renderSectionHeader}
          renderItem={renderSectionItem}
          contentContainerStyle={[s.list, { paddingBottom: 32 + tabBarHeight }]}
          ListHeaderComponent={
            hasApprovals ? renderApprovalPanels() : null
          }
          refreshControl={
            <RefreshControl
              refreshing={isLoading}
              onRefresh={() => { fetchInbox(); fetchPending(); fetchStagedFiles(); }}
              tintColor={colors.accent}
            />
          }
          ItemSeparatorComponent={() => <View style={s.separator} />}
          ListFooterComponent={() => (
            <>
              <InboxHandledSection
                items={handledByRebelItems}
                expanded={showHandled}
                onToggle={() => setShowHandled((prev) => !prev)}
                renderItem={(item) => <HandledByRebelRow item={item} />}
              />
              <InboxArchivedSection
                archivedItems={archivedItems}
                historyEntries={history}
                expanded={showArchived}
                onToggle={() => setShowArchived((prev) => !prev)}
                renderArchivedItem={(item) => <ArchivedItemRow item={item} />}
                renderHistoryItem={(entry) => <HistoryItemRow entry={entry} />}
              />
            </>
          )}
        />
      ) : hasApprovals ? (
        <ScrollView
          testID="inbox-approvals-only"
          style={s.container}
          contentContainerStyle={{ paddingBottom: tabBarHeight }}
          refreshControl={
            <RefreshControl
              refreshing={isLoading}
              onRefresh={() => { fetchInbox(); fetchPending(); fetchStagedFiles(); }}
              tintColor={colors.accent}
            />
          }
        >
          {renderApprovalPanels()}

          <InboxHandledSection
            items={handledByRebelItems}
            expanded={showHandled}
            onToggle={() => setShowHandled((prev) => !prev)}
            renderItem={(item) => <HandledByRebelRow item={item} />}
            topMargin={24}
          />

          <InboxArchivedSection
            archivedItems={archivedItems}
            historyEntries={history}
            expanded={showArchived}
            onToggle={() => setShowArchived((prev) => !prev)}
            renderArchivedItem={(item) => <ArchivedItemRow item={item} />}
            renderHistoryItem={(entry) => <HistoryItemRow entry={entry} />}
            topMargin={24}
          />
        </ScrollView>
      ) : (
        <View testID="inbox-empty-state" style={[s.emptyState, { paddingBottom: tabBarHeight }]}>
          {renderApprovalPanels()}
          <Text style={s.emptyTitle}>{TEMPORAL_GROUP_META['due-today'].emptyMessage}</Text>
          <Text style={s.emptySubtitle}>{TEMPORAL_GROUP_META['due-this-week'].emptyMessage}</Text>

          <InboxHandledSection
            items={handledByRebelItems}
            expanded={showHandled}
            onToggle={() => setShowHandled((prev) => !prev)}
            renderItem={(item) => <HandledByRebelRow item={item} />}
            topMargin={24}
          />

          <InboxArchivedSection
            archivedItems={archivedItems}
            historyEntries={history}
            expanded={showArchived}
            onToggle={() => setShowArchived((prev) => !prev)}
            renderArchivedItem={(item) => <ArchivedItemRow item={item} />}
            renderHistoryItem={(entry) => <HistoryItemRow entry={entry} />}
            topMargin={24}
          />
        </View>
      )}

      {/* Toast */}
      {toast && (
        <View
          testID="inbox-toast"
          style={[s.toast, keyboardHeight > 0 ? { bottom: keyboardHeight + 16 } : null]}
        >
          <Text style={s.toastText}>{toast}</Text>
        </View>
      )}

      {/* Item detail modal — derive from store so in-modal mutations are reflected */}
      {(() => {
        const selectedItem = selectedItemId ? items.find((i) => i.id === selectedItemId && !i.archived) ?? null : null;
        return selectedItem ? (
          <InboxItemDetailModal
            item={selectedItem}
            onClose={() => setSelectedItemId(null)}
            onExecute={handleExecute}
            onDelete={handleDelete}
            onSetPriority={handleSetPriority}
            onSnooze={handleSnooze}
            onSetTags={handleSetTags}
            onDone={handleDone}
          />
        ) : null;
      })()}

      {/* Approval detail bottom sheets (Stage D). Host manages its own
          `selectedApproval: {kind, id}` state; callers drive it via the
          `approvalSheetRef` handle exposed on card `onOpen` handlers. */}
      <ApprovalSheetHost
        ref={approvalSheetRef}
        onPublishStagedFile={handleSheetHostPublishFile}
        onDiscardStagedFile={handleSheetHostDiscardFile}
        onKeepPrivateStagedFile={handleSheetHostKeepPrivate}
        onResolveWithRebel={handleResolveWithRebel}
        onKeepMine={handleKeepMine}
        onKeepTheirs={handleKeepTheirs}
        onApproveMemoryWrite={handleSheetHostApproveMemory}
        onSkipMemoryWrite={handleSheetHostSkipMemory}
        onApproveTool={handleSheetHostApproveTool}
        onDenyTool={handleSheetHostDenyTool}
        onExecuteStagedCall={handleSheetHostExecuteStagedCall}
        onRejectStagedCall={handleSheetHostRejectStagedCall}
        isOnline={isOnline}
      />
    </View>
  );
}
