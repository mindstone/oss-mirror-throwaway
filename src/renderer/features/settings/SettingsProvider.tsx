import { createContext, useContext, type ReactNode } from 'react';
import type { useSettingsFeature } from './hooks/useSettingsFeature';

/**
 * The context value is the return type of useSettingsFeature.
 * This allows components to access settings state and actions without prop drilling.
 */
export type SettingsContextValue = ReturnType<typeof useSettingsFeature>;

const SettingsContext = createContext<SettingsContextValue | null>(null);

export type SettingsProviderProps = {
  children: ReactNode;
  value: SettingsContextValue;
};

/**
 * Provider that makes settings feature values available via context.
 * Wrap components that need access to settings state/actions.
 *
 * Usage in App.tsx:
 * ```tsx
 * const settingsFeature = useSettingsFeature({ ... });
 * return (
 *   <SettingsProvider value={settingsFeature}>
 *     {children}
 *   </SettingsProvider>
 * );
 * ```
 */
export const SettingsProvider = ({ children, value }: SettingsProviderProps) => {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};

/**
 * Hook to access settings feature values from context.
 * Must be used within a SettingsProvider.
 *
 * @throws Error if used outside of SettingsProvider
 */
export const useSettings = (): SettingsContextValue => {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};

/**
 * Safe version that returns null if not within provider.
 * Useful for optional settings access.
 */
export const useSettingsSafe = (): SettingsContextValue | null => {
  return useContext(SettingsContext);
};
