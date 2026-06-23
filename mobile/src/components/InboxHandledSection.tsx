import { Fragment, useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { InboxItem } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../theme/colors';

interface InboxHandledSectionProps {
  items: InboxItem[];
  expanded: boolean;
  onToggle: () => void;
  renderItem: (item: InboxItem) => ReactNode;
  topMargin?: number;
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
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
      fontSize: 14,
      fontWeight: '600',
      color: colors.accent,
    },
  });
}

export function InboxHandledSection({
  items,
  expanded,
  onToggle,
  renderItem,
  topMargin,
}: InboxHandledSectionProps) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const handledItems = items;

  if (handledItems.length === 0) {
    return null;
  }

  return (
    <>
      <TouchableOpacity
        testID="inbox-handled-toggle-button"
        style={[styles.handledToggle, topMargin != null ? { marginTop: topMargin } : null]}
        onPress={onToggle}
        activeOpacity={0.7}
      >
        <Text style={styles.handledToggleText}>
          {expanded ? '▾' : '▸'} Handled by Rebel ({handledItems.length})
        </Text>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.handledSection}>
          {handledItems.map((item) => (
            <Fragment key={item.id}>{renderItem(item)}</Fragment>
          ))}
        </View>
      )}
    </>
  );
}
