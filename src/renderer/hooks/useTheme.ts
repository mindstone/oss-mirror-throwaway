import { useCallback, useEffect, useState } from 'react';
import type { ThemePreference } from '@shared/types';

type ResolvedTheme = 'light' | 'dark';

/**
 * Get the system's preferred color scheme
 */
const getSystemTheme = (): ResolvedTheme => {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
};

/**
 * Resolve a theme preference to an actual theme (light or dark)
 */
const resolveTheme = (preference: ThemePreference): ResolvedTheme => {
  if (preference === 'system') {
    return getSystemTheme();
  }
  return preference;
};

/**
 * Hook for managing theme state and applying it to the document body.
 * Supports 'light', 'dark', and 'system' (follows OS preference).
 * @param initialTheme - The theme preference from settings (default: 'dark')
 * @param onThemeChange - Callback to persist theme changes to settings
 */
export const useTheme = (
  initialTheme: ThemePreference = 'dark',
  onThemeChange?: (theme: ThemePreference) => void
) => {
  const [themePreference, setThemePreference] = useState<ThemePreference>(initialTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(initialTheme));

  // Apply resolved theme class to document body
  const applyTheme = useCallback((theme: ResolvedTheme) => {
    const body = document.body;
    body.classList.remove('light', 'dark');
    body.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
  }, []);

  // Set theme preference and persist
  const setTheme = useCallback(
    (newPreference: ThemePreference) => {
      setThemePreference(newPreference);
      const resolved = resolveTheme(newPreference);
      setResolvedTheme(resolved);
      applyTheme(resolved);
      onThemeChange?.(newPreference);
    },
    [applyTheme, onThemeChange]
  );

  // Toggle between light and dark (skips system)
  const toggleTheme = useCallback(() => {
    const newTheme: ThemePreference = resolvedTheme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
  }, [resolvedTheme, setTheme]);

  // Apply initial theme on mount
  useEffect(() => {
    const resolved = resolveTheme(initialTheme);
    setResolvedTheme(resolved);
    applyTheme(resolved);
  }, [initialTheme, applyTheme]);

  // Sync if initialTheme changes (e.g., settings loaded)
  useEffect(() => {
    if (initialTheme !== themePreference) {
      setThemePreference(initialTheme);
      const resolved = resolveTheme(initialTheme);
      setResolvedTheme(resolved);
      applyTheme(resolved);
    }
  }, [initialTheme, themePreference, applyTheme]);

  // Listen for system theme changes when preference is 'system'
  useEffect(() => {
    if (themePreference !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      const resolved = getSystemTheme();
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themePreference, applyTheme]);

  return {
    theme: themePreference,
    resolvedTheme,
    setTheme,
    toggleTheme,
    isDark: resolvedTheme === 'dark',
    isLight: resolvedTheme === 'light',
  };
};

