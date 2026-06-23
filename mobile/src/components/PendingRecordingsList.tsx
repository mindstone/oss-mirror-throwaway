// mobile/src/components/PendingRecordingsList.tsx
//
// Expandable section showing pending offline voice recordings above the
// conversations list. Collapsed: summary row. Expanded: full list with
// per-recording actions. Auto-collapses when the queue empties.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { spacing, radius, shadows } from '../theme/tokens';
import { Pressable } from './Pressable';
import { PendingRecordingRow } from './PendingRecordingRow';
import { usePendingRecordingsAudio } from '../hooks/usePendingRecordingsAudio';
import { useNetworkState } from '../hooks/useNetworkState';
import { readMeetingManifest } from '../utils/meetingManifest';
import {
  useSessionStore,
  type QueueItem,
  type OfflineQueueState,
} from '@rebel/cloud-client';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Safe store access — useOfflineQueueStore throws if not initialized.
// In test environments or early app lifecycle, the store may not exist yet.
// ---------------------------------------------------------------------------

/** Safely access offline queue items, returning empty when store is not initialized. */
function useQueueItems(): QueueItem[] {
  try {
    // Dynamic require to avoid module-level throw if store doesn't exist yet
    const { useOfflineQueueStore } = require('@rebel/cloud-client') as {
      useOfflineQueueStore: { (selector: (s: OfflineQueueState) => QueueItem[]): QueueItem[] };
    };
    return useOfflineQueueStore((s: OfflineQueueState) => s.items);
  } catch {
    return [];
  }
}

/** Safely get store state for imperative actions. */
function getQueueState(): OfflineQueueState | null {
  try {
    const { useOfflineQueueStore } = require('@rebel/cloud-client') as {
      useOfflineQueueStore: { getState: () => OfflineQueueState };
    };
    return useOfflineQueueStore.getState();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSummaryText(count: number): string {
  if (count === 1) return '1 recording waiting in the wings';
  return `${count} recordings waiting in the wings`;
}

function getSessionName(sessionId: string | null | undefined, sessions: { id: string; title: string | null }[]): string | null {
  if (!sessionId) return null;
  const session = sessions.find((s) => s.id === sessionId);
  return session?.title ?? null;
}

function hasFailedItems(items: QueueItem[]): boolean {
  return items.some((item) => item.isPermanentFailure || item.lastError);
}

interface MeetingChunkMetadata {
  meetingSessionId?: string;
  chunkIndex?: number;
  meetingTitle?: string;
  totalChunks?: number;
}

interface GroupedMeetingRow {
  sessionId: string;
  itemIds: string[];
  displayItem: QueueItem;
  summary: {
    meetingSessionId: string;
    meetingTitle?: string;
    uploadedChunks: number;
    totalChunks: number;
    pendingChunks: number;
    failedChunks: number;
  };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      marginHorizontal: 16,
      marginBottom: spacing.sm,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
      ...shadows.sm,
      shadowColor: colors.shadowColor,
      shadowOpacity: colors.shadowOpacity,
    },
    collapsedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: spacing.sm + 2,
    },
    iconWrap: {
      width: 32,
      height: 32,
      borderRadius: radius.sm + 2,
      backgroundColor: colors.accentMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    summaryText: {
      ...typography.bodySmall,
      fontSize: 14,
      fontWeight: '500',
      color: colors.textPrimary,
      flex: 1,
    },
    chevron: {
      marginLeft: spacing.xs,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingHorizontal: 14,
      paddingBottom: 6,
      gap: spacing.md,
    },
    headerActionText: {
      ...typography.caption,
      fontSize: 12,
      fontWeight: '600',
    },
    retryAllText: {
      color: colors.accent,
    },
    clearAllText: {
      color: colors.textTertiary,
    },
    listContainer: {
      overflow: 'hidden',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginHorizontal: 12,
    },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PendingRecordingsList = memo(function PendingRecordingsList() {
  const queueItems = useQueueItems();
  const voiceItems = useMemo(
    () => queueItems.filter((item) => item.type === 'voice-transcription'),
    [queueItems],
  );
  const meetingChunkItems = useMemo(
    () => queueItems.filter((item) => item.type === 'meeting-chunk'),
    [queueItems],
  );
  const legacyMeetingItems = useMemo(
    () => queueItems.filter((item) => item.type === 'meeting-recording'),
    [queueItems],
  );
  const sessions = useSessionStore((s) => s.sessions);
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [meetingManifestState, setMeetingManifestState] = useState<Record<string, {
    uploadedChunks: number;
    totalChunks: number;
    meetingTitle?: string;
  }>>({});

  const [isExpanded, setIsExpanded] = useState(false);
  const wasExpandedRef = useRef(false);

  // Animated height for expand/collapse
  const expandProgress = useSharedValue(0);

  const { playingId, togglePlayback, stopPlayback } = usePendingRecordingsAudio();

  // Network state for connectivity-aware drain (ref avoids callback dep churn)
  const { isOnline } = useNetworkState();
  const isOnlineRef = useRef(isOnline);
  useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);

  useEffect(() => {
    const sessionIds = Array.from(
      new Set(
        meetingChunkItems
          .map((item) => (item.metadata as MeetingChunkMetadata | undefined)?.meetingSessionId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );

    if (sessionIds.length === 0) {
      setMeetingManifestState({});
      return;
    }

    let cancelled = false;
    void (async () => {
      const nextState: Record<string, { uploadedChunks: number; totalChunks: number; meetingTitle?: string }> = {};
      for (const sessionId of sessionIds) {
        const manifest = await readMeetingManifest(sessionId);
        if (!manifest) continue;
        nextState[sessionId] = {
          uploadedChunks: Math.max(0, manifest.lastAckedChunkIndex + 1),
          totalChunks: manifest.totalChunks ?? manifest.nextChunkIndex,
          meetingTitle: manifest.meetingTitle,
        };
      }
      if (!cancelled) {
        setMeetingManifestState(nextState);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meetingChunkItems]);

  const groupedMeetingRows = useMemo<GroupedMeetingRow[]>(() => {
    const groups = new Map<string, QueueItem[]>();

    for (const item of meetingChunkItems) {
      const metadata = item.metadata as MeetingChunkMetadata | undefined;
      const sessionId = metadata?.meetingSessionId;
      if (!sessionId) continue;
      const current = groups.get(sessionId) || [];
      current.push(item);
      groups.set(sessionId, current);
    }

    const rows: GroupedMeetingRow[] = [];

    for (const [sessionId, items] of groups.entries()) {
      const primaryItem = items[0];
      if (!primaryItem) continue;

      const manifestStats = meetingManifestState[sessionId];
      const sampleMetadata = (primaryItem.metadata as MeetingChunkMetadata | undefined) || {};
      const pendingChunks = items.filter((item) => !(item.isPermanentFailure || item.lastError)).length;
      const failedChunks = items.filter((item) => item.isPermanentFailure || Boolean(item.lastError)).length;
      const inferredTotalFromMetadata = items.reduce((max, item) => {
        const metadata = item.metadata as MeetingChunkMetadata | undefined;
        const byTotal = typeof metadata?.totalChunks === 'number' ? metadata.totalChunks : 0;
        const byIndex = typeof metadata?.chunkIndex === 'number' ? metadata.chunkIndex + 1 : 0;
        return Math.max(max, byTotal, byIndex);
      }, 0);
      const totalChunks = Math.max(
        1,
        manifestStats?.totalChunks || 0,
        inferredTotalFromMetadata,
      );

      const uploadedChunks = Math.min(
        totalChunks,
        manifestStats?.uploadedChunks
          ?? Math.max(0, totalChunks - pendingChunks),
      );

      const displayItem: QueueItem = {
        ...primaryItem,
        id: `meeting-${sessionId}`,
        enqueuedAt: Math.min(...items.map((item) => item.enqueuedAt)),
      };

      rows.push({
        sessionId,
        itemIds: items.map((item) => item.id),
        displayItem,
        summary: {
          meetingSessionId: sessionId,
          meetingTitle: manifestStats?.meetingTitle || sampleMetadata.meetingTitle,
          uploadedChunks,
          totalChunks,
          pendingChunks,
          failedChunks,
        },
      });
    }

    for (const item of legacyMeetingItems) {
      const metadata = item.metadata as { meetingTitle?: string } | undefined;
      rows.push({
        sessionId: item.id,
        itemIds: [item.id],
        displayItem: {
          ...item,
          id: `legacy-meeting-${item.id}`,
        },
        summary: {
          meetingSessionId: item.id,
          meetingTitle: metadata?.meetingTitle,
          uploadedChunks: 0,
          totalChunks: 1,
          pendingChunks: item.isPermanentFailure || item.lastError ? 0 : 1,
          failedChunks: item.isPermanentFailure || item.lastError ? 1 : 0,
        },
      });
    }

    return rows.sort((a, b) => b.displayItem.enqueuedAt - a.displayItem.enqueuedAt);
  }, [legacyMeetingItems, meetingChunkItems, meetingManifestState]);

  const displayCount = voiceItems.length + groupedMeetingRows.length;
  const managedItems = useMemo(
    () => [...voiceItems, ...meetingChunkItems, ...legacyMeetingItems],
    [legacyMeetingItems, meetingChunkItems, voiceItems],
  );

  // Auto-collapse when queue empties
  useEffect(() => {
    if (displayCount === 0 && wasExpandedRef.current) {
      setIsExpanded(false);
      wasExpandedRef.current = false;
      expandProgress.value = withTiming(0, { duration: 200 });
      stopPlayback();
    }
  }, [displayCount, expandProgress, stopPlayback]);

  const toggleExpanded = useCallback(() => {
    const next = !isExpanded;
    setIsExpanded(next);
    wasExpandedRef.current = next;
    expandProgress.value = withTiming(next ? 1 : 0, { duration: 250 });
    if (!next) {
      stopPlayback();
    }
  }, [isExpanded, expandProgress, stopPlayback]);

  const animatedListStyle = useAnimatedStyle(() => ({
    opacity: expandProgress.value,
    maxHeight: expandProgress.value * (displayCount * 60 + 40), // ~60px per row + header actions
  }));

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${expandProgress.value * 180}deg` }],
  }));

  const handleRetry = useCallback(async (id: string) => {
    try {
      const state = getQueueState();
      if (!state) return;
      await state.retryItem(id);
      await state.drain(isOnlineRef.current);
    } catch { /* logged internally */ }
  }, []);

  const handleRetryMeeting = useCallback(async (meetingSessionId: string) => {
    try {
      const state = getQueueState();
      if (!state) return;
      const row = groupedMeetingRows.find((entry) => entry.sessionId === meetingSessionId);
      if (!row) return;
      for (const itemId of row.itemIds) {
        await state.retryItem(itemId);
      }
      await state.drain(isOnlineRef.current);
    } catch { /* logged internally */ }
  }, [groupedMeetingRows]);

  const handleDelete = useCallback((id: string) => {
    Alert.alert(
      'Delete recording?',
      'This recording hasn\'t been sent yet and will be lost.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            stopPlayback();
            try {
              await getQueueState()?.removeItem(id);
            } catch { /* logged internally */ }
          },
        },
      ],
    );
  }, [stopPlayback]);

  const handleDeleteMeeting = useCallback((meetingSessionId: string) => {
    Alert.alert(
      'Delete meeting upload?',
      'Pending meeting chunks for this meeting will be removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            stopPlayback();
            try {
              const state = getQueueState();
              if (!state) return;
              const row = groupedMeetingRows.find((entry) => entry.sessionId === meetingSessionId);
              if (!row) return;
              for (const itemId of row.itemIds) {
                await state.removeItem(itemId);
              }
              const { deleteMeetingSession } = await import('../utils/meetingManifest');
              await deleteMeetingSession(meetingSessionId);
            } catch { /* logged internally */ }
          },
        },
      ],
    );
  }, [groupedMeetingRows, stopPlayback]);

  const handleRetryAll = useCallback(async () => {
    try {
      const state = getQueueState();
      if (!state) return;
      // Retry all failed items
      const failedItems = managedItems.filter((i) => i.isPermanentFailure || i.lastError);
      for (const item of failedItems) {
        await state.retryItem(item.id);
      }
      await state.drain(isOnlineRef.current);
    } catch { /* logged internally */ }
  }, [managedItems]);

  const handleClearAll = useCallback(() => {
    Alert.alert(
      'Clear all recordings?',
      'All unsent recordings will be lost. This can\'t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          style: 'destructive',
          onPress: async () => {
            stopPlayback();
            try {
              const state = getQueueState();
              if (!state) return;
              for (const item of managedItems) {
                await state.removeItem(item.id);
              }
            } catch { /* logged internally */ }
          },
        },
      ],
    );
  }, [managedItems, stopPlayback]);

  // Don't render anything when queue is empty
  if (displayCount === 0) return null;

  const showRetryAll = hasFailedItems(managedItems);

  return (
    <Animated.View
      testID="pending-recordings-section"
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      style={s.container}
    >
      <View style={s.card}>
        {/* Collapsed summary row — always visible */}
        <Pressable
          testID="pending-recordings-toggle"
          style={s.collapsedRow}
          onPress={toggleExpanded}
          accessibilityLabel={
            isExpanded
              ? 'Collapse pending recordings'
              : `Expand pending recordings. ${getSummaryText(displayCount)}`
          }
          accessibilityRole="button"
        >
          <View style={s.iconWrap}>
            <Feather name="mic" size={16} color={colors.accent} />
          </View>
          <Text style={s.summaryText}>
            {getSummaryText(displayCount)}
          </Text>
          <Animated.View style={chevronStyle}>
            <Feather
              name="chevron-down"
              size={16}
              color={colors.textTertiary}
              style={s.chevron}
            />
          </Animated.View>
        </Pressable>

        {/* Expanded list */}
        <Animated.View style={[s.listContainer, animatedListStyle]}>
          {/* Header actions */}
          <View style={s.headerActions}>
            {showRetryAll && (
              <Pressable
                testID="pending-recordings-retry-all"
                onPress={handleRetryAll}
                accessibilityLabel="Retry all failed recordings"
              >
                <Text style={[s.headerActionText, s.retryAllText]}>
                  Retry all
                </Text>
              </Pressable>
            )}
            <Pressable
              testID="pending-recordings-clear-all"
              onPress={handleClearAll}
              accessibilityLabel="Clear all pending recordings"
            >
              <Text style={[s.headerActionText, s.clearAllText]}>
                Clear all
              </Text>
            </Pressable>
          </View>

          {/* Recording rows */}
          {voiceItems.map((item, index) => {
            const sessionId = (item.metadata as Record<string, unknown>).sessionId as string | null | undefined;
            const name = getSessionName(sessionId, sessions);
            return (
              <View key={item.id}>
                {index > 0 && <View style={s.divider} />}
                <PendingRecordingRow
                  item={item}
                  sessionName={name}
                  isPlaying={playingId === item.id}
                  onTogglePlay={togglePlayback}
                  onRetry={handleRetry}
                  onDelete={handleDelete}
                />
              </View>
            );
          })}

          {groupedMeetingRows.map((row, index) => {
            const dividerIndex = voiceItems.length + index;
            return (
              <View key={row.sessionId}>
                {dividerIndex > 0 && <View style={s.divider} />}
                <PendingRecordingRow
                  item={row.displayItem}
                  sessionName={null}
                  isPlaying={false}
                  onTogglePlay={togglePlayback}
                  onRetry={handleRetryMeeting}
                  onDelete={handleDeleteMeeting}
                  variant="meeting-chunk"
                  meetingSummary={row.summary}
                />
              </View>
            );
          })}
        </Animated.View>
      </View>
    </Animated.View>
  );
});
