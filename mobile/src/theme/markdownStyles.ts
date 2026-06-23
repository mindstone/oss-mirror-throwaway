import { Platform } from 'react-native';
import { createTypography } from './typography';
import type { ColorTokens } from './colors';

const typography = createTypography(true);

/**
 * Shared markdown styles for @ronradtke/react-native-markdown-display.
 * Used by the conversation screen, file viewer modal, and inbox.
 */
export function createMarkdownStyles(colors: ColorTokens) {
  return {
    body: { fontFamily: typography.body.fontFamily, color: colors.textPrimary, fontSize: 15, lineHeight: 22 },
    heading1: { fontFamily: typography.title.fontFamily, color: colors.textPrimary, fontWeight: 'bold' as const, fontSize: 22, marginVertical: 6 },
    heading2: { fontFamily: typography.title.fontFamily, color: colors.textPrimary, fontWeight: 'bold' as const, fontSize: 20, marginVertical: 5 },
    heading3: { fontFamily: typography.title.fontFamily, color: colors.textPrimary, fontWeight: 'bold' as const, fontSize: 18, marginVertical: 4 },
    heading4: { fontFamily: typography.title.fontFamily, color: colors.textPrimary, fontWeight: 'bold' as const, fontSize: 16, marginVertical: 3 },
    heading5: { fontFamily: typography.title.fontFamily, color: colors.textPrimary, fontWeight: 'bold' as const, fontSize: 15, marginVertical: 2 },
    heading6: { fontFamily: typography.title.fontFamily, color: colors.textPrimary, fontWeight: 'bold' as const, fontSize: 14, marginVertical: 2 },
    code_inline: {
      backgroundColor: colors.background,
      color: colors.accent,
      borderRadius: 4,
      paddingHorizontal: 4,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 13,
    },
    code_block: {
      backgroundColor: colors.background,
      borderRadius: 8,
      padding: 10,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 13,
      color: colors.textPrimary,
    },
    fence: {
      backgroundColor: colors.background,
      borderRadius: 8,
      padding: 10,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 13,
      color: colors.textPrimary,
    },
    link: { color: colors.accent },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: colors.accent,
      paddingLeft: 12,
      opacity: 0.8,
      backgroundColor: 'transparent',
    },
    list_item: { marginVertical: 2 },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    table: { borderWidth: 1, borderColor: colors.border, borderRadius: 4 },
    th: { borderWidth: 1, borderColor: colors.border, padding: 6, backgroundColor: colors.background },
    td: { borderWidth: 1, borderColor: colors.border, padding: 6 },
    hr: { backgroundColor: colors.border, height: 1, marginVertical: 8 },
    paragraph: { marginTop: 0, marginBottom: 6 },
    strong: { fontWeight: 'bold' as const },
    em: { fontStyle: 'italic' as const },
  };
}
