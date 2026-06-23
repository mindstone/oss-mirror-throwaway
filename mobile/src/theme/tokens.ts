// mobile/src/theme/tokens.ts

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  full: 9999,
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  display: 36,
} as const;

/**
 * Shadow tokens for consistent card elevation.
 *
 * These define the structural shadow properties (offset, radius, elevation).
 * Pair with theme-aware `colors.shadowColor` and `colors.shadowOpacity` for
 * the final style, e.g.:
 *
 *   { ...shadows.md, shadowColor: colors.shadowColor, shadowOpacity: colors.shadowOpacity }
 */
export const shadows = {
  xs: {
    shadowOffset: { width: 0, height: 0.5 },
    shadowRadius: 1.5,
    elevation: 1,
  },
  sm: {
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
    elevation: 2,
  },
  md: {
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 4,
  },
  lg: {
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: 8,
  },
} as const;
