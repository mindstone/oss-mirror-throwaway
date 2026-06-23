import { createContext, useContext, type ReactNode } from 'react';
import type { AppSettings, BreadcrumbEntry, RendererLogPayload } from '@shared/types';

export type EmitLogPayload = Omit<RendererLogPayload, 'source' | 'breadcrumbs'> & {
  breadcrumbs?: BreadcrumbEntry[];
};

export type EmitLogFn = (payload: EmitLogPayload) => void;
export type RecordBreadcrumbFn = (breadcrumb: BreadcrumbEntry) => void;

/**
 * Toast message shape for the unified toast system.
 * Uses ui/Toast.tsx via ToastProvider.
 *
 * `action` accepts either a ReactNode or Sonner's `{ label, onClick }` shorthand.
 * @see docs/project/UI_INTERNAL_NOTIFICATIONS.md
 */
export type ToastMessage = {
  title: string;
  description?: string;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
  duration?: number;
  action?: ReactNode | { label: string; onClick: () => void };
  icon?: ReactNode;
};

/**
 * Show a toast notification.
 * @see docs/project/UI_INTERNAL_NOTIFICATIONS.md
 */
export type ShowToastFn = (message: ToastMessage) => void;

export type AppContextValue = {
  emitLog: EmitLogFn;
  showToast: ShowToastFn;
  recordBreadcrumb: RecordBreadcrumbFn;
  settings: AppSettings | null;
};

const AppContext = createContext<AppContextValue | null>(null);

export type AppProviderProps = {
  value: AppContextValue;
  children: ReactNode;
};

export const AppProvider = ({ value, children }: AppProviderProps) => {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useAppContext = (): AppContextValue => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};

export const useAppContextSafe = (): AppContextValue | null => {
  return useContext(AppContext);
};
