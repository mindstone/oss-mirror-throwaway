// mobile/src/theme/colors.ts

import { useColorScheme } from 'react-native';

const dark = {
  background: '#0a0a0e',
  surface: '#0d111c',
  surfaceHover: '#1e293b',
  border: 'rgba(148, 163, 184, 0.18)',
  accent: '#8b5cf6',
  accentHover: '#7c3aed',
  accentLight: 'rgba(139, 92, 246, 0.08)',
  accentStrong: '#7c3aed',
  accentMuted: 'rgba(139, 92, 246, 0.15)',
  textPrimary: '#f8faff',
  textSecondary: 'rgba(203, 213, 225, 0.78)',
  textTertiary: '#94a3b8',
  success: '#22c55e',
  successLight: 'rgba(34, 197, 94, 0.08)',
  error: '#ef4444',
  errorLight: 'rgba(239, 68, 68, 0.10)',
  warning: '#f59e0b',
  warningLight: 'rgba(245, 158, 11, 0.12)',
  shadowColor: '#0f172a',
  shadowOpacity: 0.3,
};

const light = {
  background: '#f4f7fb',
  surface: '#ffffff',
  surfaceHover: '#eef2ff',
  border: 'rgba(226, 232, 240, 0.7)',
  accent: '#8b5cf6',
  accentHover: '#7c3aed',
  accentLight: 'rgba(139, 92, 246, 0.06)',
  accentStrong: '#7c3aed',
  accentMuted: 'rgba(139, 92, 246, 0.12)',
  textPrimary: '#0f172a',
  textSecondary: 'rgba(15, 23, 42, 0.6)',
  textTertiary: 'rgba(30, 41, 59, 0.55)',
  success: '#16a34a',
  successLight: 'rgba(22, 163, 74, 0.06)',
  error: '#dc2626',
  errorLight: 'rgba(220, 38, 38, 0.08)',
  warning: '#d97706',
  warningLight: 'rgba(217, 119, 6, 0.10)',
  shadowColor: '#0f172a',
  shadowOpacity: 0.08,
};

export type ColorTokens = typeof dark;

// Default export for static usage (dark theme)
export const colors = dark;

// Hook for dynamic theme
export function useColors(): ColorTokens {
  const scheme = useColorScheme();
  return scheme === 'light' ? light : dark;
}
