// mobile/app/(tabs)/index.tsx

import { useEffect, useCallback, useState, useMemo, useContext, createContext, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import {
  useSessionStore,
  useApprovalStore,
  useInboxStore,
  useStagedFilesStore,
  formatRelativeTime,
  getProcessingQuip,
} from '@rebel/cloud-client';

import { useOfflineQueueStore } from '@rebel/cloud-client';
import { useNetworkContext } from '../../src/context/NetworkContext';
import { useColors, type ColorTokens } from '../../src/theme/colors';
import { createTypography } from '../../src/theme/typography';
import { Pressable } from '../../src/components/Pressable';
import { EmptyState } from '../../src/components/EmptyState';
import { TodayCardsSection } from '../../src/components/TodayCardsSection';
import { QuickStartChips } from '../../src/components/QuickStartChips';
import { HandledByRebelCard } from '../../src/components/HandledByRebelCard';
import { FloatingOrbs } from '../../src/components/FloatingOrbs';
import { useTodayCards } from '../../src/hooks/useTodayCards';

import { usePulseAnimation } from '../../src/hooks/usePulseAnimation';
import { isToday } from '../../src/utils/dateHelpers';
import { getRebelGreeting } from '../../src/utils/rebelGreeting';
import { isBackgroundConversationSession } from '@shared/sessionKind';

// Typography presets — safe to call with `true` because _layout.tsx gates
// rendering until Inter fonts are loaded.
const typography = createTypography(true);

const FALLBACK_SAFE_AREA_CONTEXT = createContext<{
  top: number;
  right: number;
  bottom: number;
  left: number;
} | null>(null);

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: { paddingHorizontal: 16, paddingBottom: 32 },
    header: { marginBottom: 24 },
    greeting: { ...typography.display, fontSize: 32, lineHeight: 40, color: colors.textPrimary },
    section: { marginBottom: 24 },
    sectionTitle: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
      marginBottom: 12,
    },
    sessionRow: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 8,
      gap: 4,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    sessionRowContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    sessionTitle: { ...typography.body, fontSize: 15, fontWeight: '600', color: colors.textPrimary, flex: 1 },
    sessionTime: { ...typography.caption, color: colors.textTertiary },
    sessionPreview: { ...typography.bodySmall, fontSize: 13, color: colors.textSecondary },
    emptyHint: { ...typography.bodySmall, color: colors.textTertiary, textAlign: 'center', paddingVertical: 20 },
    activeSessionCard: {
      backgroundColor: colors.accentLight,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 10,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    activeSessionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    activeSessionTitle: {
      ...typography.body,
      fontSize: 15,
      fontWeight: '600',
      color: colors.textPrimary,
      flex: 1,
    },
    activeSessionQuip: {
      ...typography.bodySmall,
      marginTop: 6,
      fontSize: 13,
      color: colors.textSecondary,
    },
    activeSessionDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.accent,
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
  });
}

export default function HomeScreen() {
  const router = useRouter();
  const { sessions, fetchSessions } = useSessionStore();
  const fetchPending = useApprovalStore((s) => s.fetchPending);
  const approvalCount = useApprovalStore(
    (s) =>
      s.toolApprovals.length
      + s.stagedCalls.length
      + s.memoryApprovals.filter((approval) => !approval.staged).length,
  );
  const inboxItems = useInboxStore((s) => s.items);
  const fetchInbox = useInboxStore((s) => s.fetchInbox);
  const stagedFilesCount = useStagedFilesStore((s) => s.files.length);
  const fetchStagedFiles = useStagedFilesStore((s) => s.fetchStagedFiles);
  const [refreshing, setRefreshing] = useState(false);
  const [activeSessionQuip, setActiveSessionQuip] = useState(() => getProcessingQuip());
  const [greeting] = useState(() => getRebelGreeting());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);
  const insets = useContext(SafeAreaInsetsContext ?? FALLBACK_SAFE_AREA_CONTEXT);
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const tabBarHeight = useBottomTabBarHeight();
  const isFocused = useIsFocused();

  // Single source of truth for Today cards data (approvals + actionable inbox items)
  const { cards: todayCards, totalCount: todayTotalCount, isLoading: todayLoading } = useTodayCards();
  const hasTodayCards = !todayLoading && todayCards.length > 0;

  const handledTodayItems = useMemo(
    () => inboxItems.filter(
      (item) => item.autoCompleted === true
        && typeof item.completedAt === 'number'
        && isToday(item.completedAt),
    ),
    [inboxItems],
  );

  useEffect(() => {
    fetchSessions({ activeOnly: true });
    fetchPending();
    fetchInbox();
    fetchStagedFiles();
  }, [fetchSessions, fetchPending, fetchInbox, fetchStagedFiles]);

  const foregroundActiveSessions = sessions.filter((session) =>
    !session.deletedAt && !isBackgroundConversationSession(session.id)
  );
  const activeSessions = foregroundActiveSessions.filter((session) => session.isBusy);
  const recentSessions = foregroundActiveSessions.filter((session) => !session.isBusy).slice(0, 4);
  const activeDotStyle = usePulseAnimation(activeSessions.length > 0);

  useEffect(() => {
    if (activeSessions.length === 0) return;
    const timer = setInterval(() => setActiveSessionQuip(getProcessingQuip()), 5000);
    return () => clearInterval(timer);
  }, [activeSessions.length]);

  const { isOnline } = useNetworkContext();

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        fetchSessions({ activeOnly: true, forceFullRefresh: true }),
        fetchPending(),
        fetchInbox(),
        fetchStagedFiles(),
      ]);
      // Pull-to-refresh is also the user's "sync now" — drain the offline
      // upload queue so stuck recordings (REBEL-663) actually retry, not just
      // refresh session/inbox data. Drain is internally guarded and never
      // rejects; fire-and-forget (mirrors _layout.tsx).
      void useOfflineQueueStore.getState().drain(isOnline);
      if (mountedRef.current) {
        setToast(getProcessingQuip());
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => { if (mountedRef.current) setToast(null); }, 2500);
      }
    } finally {
      setRefreshing(false);
    }
  }, [fetchSessions, fetchPending, fetchInbox, fetchStagedFiles, isOnline]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(toastTimerRef.current);
    };
  }, []);

  return (
    <View testID="home-screen-container" style={s.container}>
      {isFocused && <FloatingOrbs count={3} />}
      <ScrollView
        testID="home-screen"
        style={s.container}
        contentContainerStyle={[s.content, { paddingTop: (insets?.top ?? 0) + 8, paddingBottom: 32 + tabBarHeight }]}
        automaticallyAdjustKeyboardInsets
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.accent}
          />
        }
      >
        <View style={s.header}>
          <Text testID="home-greeting" style={s.greeting}>{greeting}</Text>
        </View>

      {!hasTodayCards && (
        <QuickStartChips
          approvalCount={approvalCount + stagedFilesCount}
          todayActionCount={0}
          hasAnySessions={sessions.length > 0}
        />
      )}

      <HandledByRebelCard handledItems={handledTodayItems} />

      <TodayCardsSection cards={todayCards} totalCount={todayTotalCount} />

      {/* Active sessions */}
      {activeSessions.length > 0 && (
        <View testID="home-active-sessions-list" style={s.section}>
          <Text style={s.sectionTitle}>Active</Text>
          {activeSessions.map((session) => (
            <Pressable
              key={session.id}
              testID={`home-active-session-item-${session.id}`}
              style={s.activeSessionCard}
              onPress={() => router.push(`/conversation/${session.id}`)}
            >
              <View style={s.activeSessionHeader}>
                <Animated.View style={activeDotStyle}>
                  <View style={s.activeSessionDot} />
                </Animated.View>
                <Text style={s.activeSessionTitle} numberOfLines={1}>
                  {session.title || 'Untitled'}
                </Text>
              </View>
              <Text style={s.activeSessionQuip} numberOfLines={1}>
                {activeSessionQuip}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Recent conversations */}
      {recentSessions.length > 0 ? (
        <View testID="home-recent-sessions-list" style={s.section}>
          <Text style={s.sectionTitle}>Recent</Text>
          {recentSessions.map((session) => (
            <Pressable
              key={session.id}
              testID={`home-recent-session-item-${session.id}`}
              style={s.sessionRow}
              onPress={() => router.push(`/conversation/${session.id}`)}
            >
              <View style={s.sessionRowContent}>
                <Text style={s.sessionTitle} numberOfLines={1}>
                  {session.title || 'Untitled'}
                </Text>
                <Text style={s.sessionTime}>{formatRelativeTime(session.updatedAt)}</Text>
              </View>
              <Text style={s.sessionPreview} numberOfLines={1}>
                {session.preview}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : recentSessions.length === 0 && !hasTodayCards ? (
        <EmptyState
          testID="home-empty-state"
          icon="message-circle"
          title="No conversations yet"
          subtitle="Tap the mic below to get started."
        />
      ) : null}
      </ScrollView>
      {toast && (
        <View testID="home-toast" style={s.toast} pointerEvents="none">
          <Text style={s.toastText}>{toast}</Text>
        </View>
      )}
    </View>
  );
}
