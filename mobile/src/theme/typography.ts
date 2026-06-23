// mobile/src/theme/typography.ts
//
// Typography system for the Rebel mobile app.
//
// Uses Figtree font (matching desktop) loaded via @expo-google-fonts/figtree,
// with automatic fallback to system fonts (San Francisco on iOS, Roboto on
// Android) when Figtree fails to load.
//
// Usage with the existing createStyles(colors) pattern:
//
//   const typography = createTypography(fontsLoaded);
//   const styles = StyleSheet.create({
//     heading: { ...typography.title, color: colors.textPrimary },
//   });

import { TextStyle } from 'react-native';

// ---------------------------------------------------------------------------
// Font family names (as registered by @expo-google-fonts/figtree via useFonts)
// ---------------------------------------------------------------------------

export const figtreeFontFamily = {
  regular: 'Figtree_400Regular',
  medium: 'Figtree_500Medium',
  semiBold: 'Figtree_600SemiBold',
  bold: 'Figtree_700Bold',
} as const;


// ---------------------------------------------------------------------------
// System font fallback
// ---------------------------------------------------------------------------

// `undefined` tells React Native to use the platform default:
//   iOS  → San Francisco
//   Android → Roboto
const SYSTEM_FONT: undefined = undefined;

/**
 * Resolve to the Figtree font family name when loaded, otherwise fall back to
 * the platform system font.
 */
function resolveFontFamily(
  fontName: string,
  fontsLoaded: boolean,
): string | undefined {
  return fontsLoaded ? fontName : SYSTEM_FONT;
}

// ---------------------------------------------------------------------------
// Named text style presets
// ---------------------------------------------------------------------------

export type TextPresets = {
  /** Large display headings (36/44, bold) */
  display: TextStyle;
  /** Section titles (24/32, semibold) */
  title: TextStyle;
  /** Sub-headings (20/28, semibold) */
  headline: TextStyle;
  /** Default body text (16/24, regular) */
  body: TextStyle;
  /** Secondary body text (14/20, regular) */
  bodySmall: TextStyle;
  /** Small labels and metadata (12/16, medium) */
  caption: TextStyle;
  /** Uppercase section labels (11/16, semibold) */
  overline: TextStyle;
};

/**
 * Create a set of named text style presets.
 *
 * @param fontsLoaded – pass `true` once Figtree has been loaded via `useFonts`.
 *   When `false`, presets use system fonts so the app still looks correct.
 */
export function createTypography(fontsLoaded: boolean): TextPresets {
  const regular = resolveFontFamily(figtreeFontFamily.regular, fontsLoaded);
  const medium = resolveFontFamily(figtreeFontFamily.medium, fontsLoaded);
  const semiBold = resolveFontFamily(figtreeFontFamily.semiBold, fontsLoaded);
  const bold = resolveFontFamily(figtreeFontFamily.bold, fontsLoaded);

  return {
    display: {
      fontFamily: bold,
      fontSize: 36,
      fontWeight: '700',
      lineHeight: 44,
      letterSpacing: -0.5,
    },
    title: {
      fontFamily: semiBold,
      fontSize: 24,
      fontWeight: '600',
      lineHeight: 32,
      letterSpacing: -0.4,
    },
    headline: {
      fontFamily: semiBold,
      fontSize: 20,
      fontWeight: '600',
      lineHeight: 28,
      letterSpacing: -0.2,
    },
    body: {
      fontFamily: regular,
      fontSize: 16,
      fontWeight: '400',
      lineHeight: 24,
      letterSpacing: 0,
    },
    bodySmall: {
      fontFamily: regular,
      fontSize: 14,
      fontWeight: '400',
      lineHeight: 20,
      letterSpacing: 0.1,
    },
    caption: {
      fontFamily: medium,
      fontSize: 12,
      fontWeight: '500',
      lineHeight: 16,
      letterSpacing: 0.2,
    },
    overline: {
      fontFamily: semiBold,
      fontSize: 11,
      fontWeight: '600',
      lineHeight: 16,
      letterSpacing: 1.5,
      textTransform: 'uppercase',
    },
  };
}
