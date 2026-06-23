// mobile/app/(tabs)/approvals.tsx

// NOTE: This screen is hidden from the tab bar (href: null in _layout.tsx).
// It is retained as a route file for Expo Router compatibility and potential
// deep link targets. The primary approval UI is now in inbox.tsx (Actions tab)
// and ConversationApprovalBanner.tsx (inline in conversations).

import { useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApprovalStore, type MemoryWriteApproval } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../../src/theme/colors';
import { useApprovalActions } from '../../src/hooks/useApprovalActions';
import {
  ToolApprovalCard,
  StagedCallCard,
  MemoryApprovalCard,
  type ApprovalItem as BaseApprovalItem,
} from '../../src/components/ApprovalCards';

type ApprovalItem = BaseApprovalItem | { kind: 'memory'; data: MemoryWriteApproval };

// ---------------------------------------------------------------------------
// Styles factory (screen-level only)
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingHorizontal: 16,
      paddingBottom: 12,
      backgroundColor: colors.background,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerTitle: {
      fontSize: 28,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    centered: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    list: { padding: 16 },
    separator: { height: 12 },
    errorText: { fontSize: 15, color: colors.error, textAlign: 'center', marginBottom: 12 },
    retryButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    retryText: { fontSize: 15, fontWeight: '600', color: '#fff' },
    emptyTitle: { fontSize: 20, fontWeight: '600', color: colors.textPrimary },
    emptySubtitle: {
      fontSize: 15,
      color: colors.textSecondary,
      marginTop: 6,
      textAlign: 'center',
    },
  });
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function ApprovalsScreen() {
  const {
    toolApprovals,
    stagedCalls,
    memoryApprovals,
    isLoading,
    error,
    fetchPending,
  } = useApprovalStore();
  const {
    handleApprove,
    handleDeny,
    handleExecute,
    handleReject,
    approveMemoryWrite,
    skipMemoryWrite,
  } = useApprovalActions();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const s = useMemo(() => createStyles(colors), [colors]);

  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  const items: ApprovalItem[] = useMemo(
    () =>
      [
        ...toolApprovals.map((a) => ({ kind: 'tool' as const, data: a })),
        ...stagedCalls.map((c) => ({ kind: 'staged' as const, data: c })),
        ...memoryApprovals.map((m) => ({ kind: 'memory' as const, data: m })),
      ].sort((a, b) => {
        return b.data.timestamp - a.data.timestamp;
      }),
    [toolApprovals, stagedCalls, memoryApprovals],
  );

  const renderItem = useCallback(
    ({ item }: { item: ApprovalItem }) => {
      if (item.kind === 'tool') {
        return (
          <ToolApprovalCard
            approval={item.data}
            onApprove={(allowForSession) => void handleApprove(item.data.toolUseID, allowForSession)}
            onDeny={() => void handleDeny(item.data.toolUseID)}
          />
        );
      }
      if (item.kind === 'memory') {
        return (
          <MemoryApprovalCard
            approval={item.data}
            onSave={() => void approveMemoryWrite(item.data)}
            onSkip={() => void skipMemoryWrite(item.data)}
          />
        );
      }
      return (
        <StagedCallCard
          call={item.data}
          onExecute={() => void handleExecute(item.data.id)}
          onReject={() => void handleReject(item.data.id)}
        />
      );
    },
    [
      handleApprove,
      handleDeny,
      handleExecute,
      handleReject,
      approveMemoryWrite,
      skipMemoryWrite,
    ],
  );

  const keyExtractor = useCallback(
    (item: ApprovalItem) =>
      item.kind === 'tool'
        ? item.data.toolUseID
        : item.kind === 'memory'
          ? item.data.toolUseId
          : item.data.id,
    [],
  );

  return (
    <View testID="approvals-screen" style={s.container}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Text style={s.headerTitle}>Approvals</Text>
      </View>

      {isLoading && items.length === 0 ? (
        <View style={s.centered}>
          <ActivityIndicator testID="approvals-loading-indicator" color={colors.accent} size="large" />
        </View>
      ) : error && items.length === 0 ? (
        <View style={s.centered}>
          <Text testID="approvals-error" style={s.errorText}>Couldn&apos;t load approvals. The network is being difficult.</Text>
          <TouchableOpacity
            testID="approvals-retry-button"
            style={s.retryButton}
            onPress={fetchPending}
            activeOpacity={0.7}
          >
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : items.length === 0 ? (
        <View testID="approvals-empty-state" style={s.centered}>
          <Text style={s.emptyTitle}>All clear</Text>
          <Text style={s.emptySubtitle}>Nothing pending. Suspicious.</Text>
        </View>
      ) : (
        <FlatList
          testID="approvals-list"
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={s.list}
          ItemSeparatorComponent={() => <View style={s.separator} />}
          refreshControl={
            <RefreshControl
              refreshing={isLoading}
              onRefresh={fetchPending}
              tintColor={colors.accent}
            />
          }
        />
      )}
    </View>
  );
}
