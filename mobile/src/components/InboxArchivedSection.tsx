import { Fragment, useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { InboxHistoryEntry, InboxItem } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../theme/colors';

interface InboxArchivedSectionProps {
  archivedItems: InboxItem[];
  historyEntries: InboxHistoryEntry[];
  expanded: boolean;
  onToggle: () => void;
  renderArchivedItem: (item: InboxItem) => ReactNode;
  renderHistoryItem: (entry: InboxHistoryEntry) => ReactNode;
  topMargin?: number;
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    archivedToggle: {
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    archivedToggleText: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textTertiary,
    },
    archivedSection: {
      paddingHorizontal: 16,
      paddingBottom: 24,
      gap: 8,
    },
  });
}

export function InboxArchivedSection({
  archivedItems,
  historyEntries,
  expanded,
  onToggle,
  renderArchivedItem,
  renderHistoryItem,
  topMargin,
}: InboxArchivedSectionProps) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const archivedCount = archivedItems.length + historyEntries.length;

  if (archivedCount === 0) {
    return null;
  }

  return (
    <>
      <TouchableOpacity
        testID="inbox-archived-toggle-button"
        style={[styles.archivedToggle, topMargin != null ? { marginTop: topMargin } : null]}
        onPress={onToggle}
        activeOpacity={0.7}
      >
        <Text style={styles.archivedToggleText}>
          {expanded ? '▾' : '▸'} Archived ({archivedCount})
        </Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.archivedSection}>
          {archivedItems.map((item) => (
            <Fragment key={item.id}>{renderArchivedItem(item)}</Fragment>
          ))}
          {historyEntries.map((entry) => (
            <Fragment key={`${entry.id}-${entry.executedAt}`}>{renderHistoryItem(entry)}</Fragment>
          ))}
        </View>
      )}
    </>
  );
}
