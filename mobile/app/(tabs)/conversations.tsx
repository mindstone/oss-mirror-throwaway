// mobile/app/(tabs)/conversations.tsx

import { useEffect, useCallback, useMemo, memo, useState, useRef } from 'react';
import {
  ActionSheetIOS,
  Alert,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { EmptyState } from '../../src/components/EmptyState';
import {
  useSessionStore,
  updateSession,
  formatRelativeTime,
  getProcessingQuip,
  type SessionSummary,
} from '@rebel/cloud-client';
import { isBackgroundConversationSession } from '@shared/sessionKind';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { useOfflineQueueStore } from '@rebel/cloud-client';
import { useNetworkContext } from '../../src/context/NetworkContext';
import { useColors, type ColorTokens } from '../../src/theme/colors';
import { createTypography } from '../../src/theme/typography';
import { Pressable } from '../../src/components/Pressable';
import { SwipeableRow } from '../../src/components/SwipeableRow';
import { usePulseAnimation } from '../../src/hooks/usePulseAnimation';
import { useQueuedCountBySessionId } from '../../src/hooks/useQueuedCountBySessionId';
import { PendingRecordingsList } from '../../src/components/PendingRecordingsList';
import { hapticSuccess } from '../../src/utils/haptics';
import { generateMobileSessionId } from '../../src/utils/sessionId';

const typography = createTypography(true);

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
    headerTitle: {
      ...typography.title,
      fontSize: 28,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    searchWrap: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: colors.background,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    searchInputWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      paddingHorizontal: 10,
      gap: 8,
    },
    searchInputWrapFocused: {
      borderColor: colors.accent,
    },
    searchInput: {
      ...typography.body,
      flex: 1,
      paddingVertical: 10,
      fontSize: 15,
      color: colors.textPrimary,
    },
    searchClearButton: {
      width: 24,
      height: 24,
      borderRadius: 12,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: colors.background,
    },
    list: { paddingTop: 8, paddingBottom: 32 },
    listEmpty: {
      flexGrow: 1,
      justifyContent: 'center',
    },
    row: {
      marginHorizontal: 16,
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.surface,
      borderRadius: 16,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    rowBusy: {
      backgroundColor: colors.accentLight,
    },
    rowContent: { gap: 4 },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    rowTitle: { ...typography.body, fontWeight: '600', color: colors.textPrimary, flex: 1 },
    busyDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.accent,
    },
    starIcon: { marginLeft: 2 },
    rowPreview: { ...typography.bodySmall, color: colors.textSecondary },
    rowFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
    rowTime: { ...typography.caption, color: colors.textTertiary },
    rowMeta: { ...typography.caption, color: colors.textTertiary },
    statusChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    statusBusy: {
      ...typography.caption,
      fontWeight: '600',
      color: colors.accent,
    },
    separator: { height: 8 },
    queuedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    queuedBadgeText: {
      fontSize: 10,
      fontWeight: '700',
      color: '#fff',
    },
    errorText: { ...typography.body, fontSize: 15, color: '#ef4444', textAlign: 'center', marginBottom: 12 },
    retryButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    retryText: { ...typography.body, fontSize: 15, fontWeight: '600', color: '#fff' },
    emptyTitle: { ...typography.body, color: colors.textSecondary },
    emptySubtext: { ...typography.bodySmall, color: colors.textTertiary, textAlign: 'center', marginTop: 8, paddingHorizontal: 32 },
    noResultsWrap: {
      alignItems: 'center',
      paddingHorizontal: 24,
      gap: 6,
    },
    noResultsTitle: {
      ...typography.body,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    noResultsText: {
      ...typography.bodySmall,
      color: colors.textTertiary,
      textAlign: 'center',
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

const SessionRow = memo(function SessionRow({
  session,
  onPress,
  onLongPress,
}: {
  session: SessionSummary;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const busyDotStyle = usePulseAnimation(Boolean(session.isBusy));
  const busyQuip = useMemo(() => session.isBusy ? getProcessingQuip() : '', [session.isBusy, session.id]);
  const queuedCount = useQueuedCountBySessionId(session.id);

  return (
    <Pressable
      testID={`conversations-item-${session.id}`}
      style={[s.row, session.isBusy && s.rowBusy]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={240}
    >
      <View style={s.rowContent}>
        <View style={s.rowHeader}>
          <Text style={s.rowTitle} numberOfLines={1}>
            {session.title || 'Untitled'}
          </Text>
          {queuedCount > 0 ? (
            <View testID={`conversations-item-queued-badge-${session.id}`} style={s.queuedBadge}>
              <Feather name="clock" size={10} color="#fff" />
              <Text style={s.queuedBadgeText}>{queuedCount}</Text>
            </View>
          ) : null}
          {session.starredAt ? (
            <Feather
              testID="conversations-item-starred-icon"
              name="star"
              size={14}
              color={colors.warning}
              accessibilityLabel="Starred"
              style={s.starIcon}
            />
          ) : null}
          {session.isBusy ? (
            <Animated.View style={busyDotStyle}>
              <View testID="conversations-item-busy-dot" style={s.busyDot} />
            </Animated.View>
          ) : null}
        </View>
        <Text style={s.rowPreview} numberOfLines={2}>
          {session.preview || 'No messages yet'}
        </Text>
        <View style={s.rowFooter}>
          <View style={s.statusChip}>
            {session.isBusy ? (
              <>
                <ActivityIndicator
                  testID="conversations-item-busy-indicator"
                  size="small"
                  color={colors.accent}
                />
                <Text style={s.statusBusy}>{busyQuip}</Text>
              </>
            ) : (
              <Text style={s.rowTime}>{formatRelativeTime(session.updatedAt)}</Text>
            )}
          </View>
          <Text style={s.rowMeta}>
            {session.messageCount} message{session.messageCount !== 1 ? 's' : ''}
          </Text>
        </View>
      </View>
    </Pressable>
  );
});

export default function ConversationsScreen() {
  const { sessions, isLoading, error, fetchSessions } = useSessionStore();
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);
  const animatedIdsRef = useRef(new Set<string>());
  const reducedMotion = useReducedMotion();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const tabBarHeight = useBottomTabBarHeight();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    fetchSessions({ activeOnly: true });
  }, [fetchSessions]);

  // Single flat list: non-deleted sessions, busy first, then by updatedAt desc
  const sortedSessions = useMemo(() => {
    return sessions
      .filter((sess) => !sess.deletedAt && !isBackgroundConversationSession(sess.id))
      .sort((a, b) => {
        // Busy sessions float to the top
        if (a.isBusy && !b.isBusy) return -1;
        if (!a.isBusy && b.isBusy) return 1;
        // Then by updatedAt descending
        return b.updatedAt - a.updatedAt;
      });
  }, [sessions]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim().toLowerCase());
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const filteredSessions = useMemo(() => {
    if (!debouncedSearchQuery) return sortedSessions;

    return sortedSessions.filter((session) => {
      const title = session.title?.toLowerCase() ?? '';
      const preview = session.preview?.toLowerCase() ?? '';
      return title.includes(debouncedSearchQuery) || preview.includes(debouncedSearchQuery);
    });
  }, [debouncedSearchQuery, sortedSessions]);

  const { isOnline } = useNetworkContext();

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchSessions({ activeOnly: true, forceFullRefresh: true });
      // Pull-to-refresh is also the user's "sync now" — drain the offline
      // upload queue so stuck recordings (REBEL-663) actually retry. Drain is
      // internally guarded and never rejects; fire-and-forget (mirrors _layout).
      void useOfflineQueueStore.getState().drain(isOnline);
      if (mountedRef.current) {
        setToast(getProcessingQuip());
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => { if (mountedRef.current) setToast(null); }, 2500);
      }
    } finally {
      setRefreshing(false);
    }
  }, [fetchSessions, isOnline]);

  const handlePress = useCallback(
    (id: string) => {
      router.push(`/conversation/${id}`);
    },
    [router],
  );

  const mutateSession = useCallback(async (
    session: SessionSummary,
    patch: Record<string, unknown>,
  ) => {
    await updateSession(session.id, patch);
  }, []);

  const runSessionAction = useCallback(async (action: () => Promise<void>) => {
    try {
      await action();
      await fetchSessions({ activeOnly: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Action failed', message);
    }
  }, [fetchSessions]);

  const handleMarkDone = useCallback(async (session: SessionSummary) => {
    if (isBackgroundConversationSession(session.id)) {
      return;
    }
    const now = Date.now();
    // Lifecycle DONE write via canonical `doneAt`. resolvedAt is a distinct
    // concept (turn/task completion) — kept as existing behaviour, never
    // conflated with doneAt.
    await mutateSession(session, {
      doneAt: now,
      resolvedAt: now,
      updatedAt: now,
    });
  }, [mutateSession]);

  const handleToggleStar = useCallback(async (session: SessionSummary) => {
    // True favourite toggle. Star is independent of lifecycle — only touch
    // starredAt, never doneAt.
    await mutateSession(session, {
      starredAt: session.starredAt ? null : Date.now(),
      updatedAt: Date.now(),
    });
  }, [mutateSession]);

  const handleDelete = useCallback(async (session: SessionSummary) => {
    await useSessionStore.getState().deleteSessionOptimistically(session.id, 'mobile');
  }, []);

  const confirmDelete = useCallback((session: SessionSummary) => {
    Alert.alert(
      'Delete conversation?',
      'This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void runSessionAction(() => handleDelete(session));
          },
        },
      ],
    );
  }, [handleDelete, runSessionAction]);

  const showSessionActions = useCallback((session: SessionSummary) => {
    const isBackground = isBackgroundConversationSession(session.id);
    const starLabel = session.starredAt ? 'Remove from Starred' : 'Add to Starred';

    const markDone = () => { void runSessionAction(() => handleMarkDone(session)); };
    const star = () => { void runSessionAction(() => handleToggleStar(session)); };
    const del = () => { confirmDelete(session); };

    if (Platform.OS === 'ios') {
      const options = isBackground
        ? ['Cancel', starLabel, 'Delete']
        : ['Cancel', 'Mark as done', starLabel, 'Delete'];
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 0,
          destructiveButtonIndex: isBackground ? 2 : 3,
        },
        (buttonIndex) => {
          if (!isBackground && buttonIndex === 1) markDone();
          if (buttonIndex === (isBackground ? 1 : 2)) star();
          if (buttonIndex === (isBackground ? 2 : 3)) del();
        },
      );
      return;
    }

    Alert.alert(session.title || 'Conversation', undefined, [
      ...(isBackground ? [] : [{ text: 'Mark as done', onPress: markDone }]),
      { text: starLabel, onPress: star },
      { text: 'Delete', style: 'destructive', onPress: del },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [confirmDelete, handleMarkDone, handleToggleStar, runSessionAction]);

  if (isLoading && sessions.length === 0) {
    return (
      <View style={s.centered}>
        <ActivityIndicator testID="conversations-loading-indicator" color={colors.accent} size="large" />
      </View>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <View style={s.centered}>
        <Text testID="conversations-error" style={s.errorText}>{error}</Text>
        <TouchableOpacity
          testID="conversations-retry-button"
          style={s.retryButton}
          onPress={handleRefresh}
          activeOpacity={0.7}
        >
          <Text style={s.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View testID="conversations-screen" style={s.container}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Text style={s.headerTitle}>Conversations</Text>
      </View>

      {sortedSessions.length === 0 ? (
        <EmptyState
          testID="conversations-empty-state"
          icon="message-circle"
          title="No conversations yet"
          subtitle="Start one and see where it goes."
          ctaLabel="New conversation"
          onCtaPress={() => {
            const sessionId = generateMobileSessionId();
            router.push(`/conversation/${sessionId}?compose=text`);
          }}
        />
      ) : (
        <>
          <View style={s.searchWrap}>
            <View style={[s.searchInputWrap, searchFocused && s.searchInputWrapFocused]}>
              <Feather name="search" size={16} color={searchFocused ? colors.accent : colors.textTertiary} />
              <TextInput
                testID="conversations-search-input"
                style={s.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder="Search conversations"
                placeholderTextColor={colors.textTertiary}
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
              />
              {searchQuery ? (
                <TouchableOpacity
                  testID="conversations-search-clear-button"
                  style={s.searchClearButton}
                  onPress={() => setSearchQuery('')}
                  activeOpacity={0.7}
                >
                  <Feather name="x" size={14} color={colors.textSecondary} />
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          <FlatList
            testID="conversations-list"
            data={filteredSessions}
            keyExtractor={(item) => item.id}
            keyboardDismissMode="interactive"
            renderItem={({ item, index }) => {
              const isBackground = isBackgroundConversationSession(item.id);
              const shouldAnimate = !reducedMotion && !animatedIdsRef.current.has(item.id) && index < 10;
              if (shouldAnimate) animatedIdsRef.current.add(item.id);
              const row = (
                <SwipeableRow
                  // SwipeableRow's onSwipeLeft fires for the LEFT panel
                  // (leftLabel); onSwipeRight fires for the RIGHT panel
                  // (rightLabel) — see SwipeableRow's onSwipeableOpen comment
                  // for the verified RNGH 2.28 semantics. Pair each label with
                  // the handler that fires for its panel so label matches
                  // action (see chief-designer §3a/D7).
                  // Left panel (amber warning) = Star; right panel (accent) = Done.
                  onSwipeLeft={() => {
                    void runSessionAction(() => handleToggleStar(item));
                  }}
                  onSwipeRight={
                    isBackground
                      ? undefined
                      : () => {
                          hapticSuccess();
                          void runSessionAction(() => handleMarkDone(item));
                        }
                  }
                  leftLabel={item.starredAt ? 'Unstar' : 'Star'}
                  rightLabel={isBackground ? undefined : 'Done'}
                  rightActionTone="accent"
                >
                  <SessionRow
                    session={item}
                    onPress={() => handlePress(item.id)}
                    onLongPress={() => showSessionActions(item)}
                  />
                </SwipeableRow>
              );
              if (shouldAnimate) {
                return (
                  <Animated.View entering={FadeInDown.delay(index * 50).duration(250)}>
                    {row}
                  </Animated.View>
                );
              }
              return row;
            }}
            contentContainerStyle={[s.list, { paddingBottom: 32 + tabBarHeight }, filteredSessions.length === 0 && s.listEmpty]}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={colors.accent}
              />
            }
            ListHeaderComponent={<PendingRecordingsList />}
            ItemSeparatorComponent={() => <View style={s.separator} />}
            ListEmptyComponent={
              <EmptyState
                testID="conversations-search-empty-state"
                icon="search"
                title="No matching conversations"
                subtitle="Try a different keyword."
              />
            }
          />
        </>
      )}
      {toast && (
        <View testID="conversations-toast" style={s.toast} pointerEvents="none">
          <Text style={s.toastText}>{toast}</Text>
        </View>
      )}
    </View>
  );
}
