import React, { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useColors } from '../theme/colors';

/** Thin visual divider between conversation turns. */
export const TurnSeparator = memo(function TurnSeparator() {
  const colors = useColors();
  return (
    <View style={[styles.separator, { backgroundColor: colors.border }]} />
  );
});

const styles = StyleSheet.create({
  separator: {
    marginVertical: 12,
    marginHorizontal: 24,
    height: StyleSheet.hairlineWidth,
  },
});
