import * as React from 'react';
import { createContext, useContext, useCallback } from 'react';
import { Toaster, toast } from 'sonner';
import { isNotificationsSuppressed } from '@renderer/utils/notificationSuppress';
import { captureRendererMessage, recordRendererBreadcrumb } from '@renderer/src/sentry';
import './Toast.module.css';

/**
 * Toast notification system using Sonner.
 * Use the ToastProvider at the app root and useToast hook to show notifications.
 *
 * @example
 * // In App.tsx:
 * <ToastProvider>
 *   <YourApp />
 * </ToastProvider>
 *
 * // In components:
 * const { showToast } = useToast();
 * showToast({ title: 'Success!', variant: 'success' });
 */

export type ToastVariant = 'default' | 'success' | 'warning' | 'error' | 'info';

/**
 * Group every tool ARGUMENT-VALIDATION error-toast into ONE Sentry issue
 * (FOX-3519). Without this, `instrumentToast` fingerprints by the full toast
 * title, so each tool/package produced a distinct singleton issue — ~15 prior
 * autopilot tickets (REBEL-6BM, FOX-3344/3350/3358/…) that were really one
 * recurring class. Matching on the validator's stable substring (present in
 * both the `use_tool` wrapper error and the per-tool `-33003` error) collapses
 * them. FOX-3519's primary fix routes this class to a calm `info` toast (no
 * Sentry capture at all); this fingerprint is a backstop for any RESIDUAL
 * error-variant toast that still carries the validator text from another path.
 */
function argValidationToastFingerprint(title: string, description?: string): string[] | undefined {
  const haystack = `${title} ${description ?? ''}`.toLowerCase();
  if (
    haystack.includes('argument validation failed') ||
    haystack.includes('downstream validation failed') ||
    haystack.includes('"args" must be an object') ||
    haystack.includes('-33003')
  ) {
    return ['toast', 'tool-arg-validation-failed'];
  }
  return undefined;
}

/** Record Sentry breadcrumb + optional event for a toast. Exported for testing. */
export function instrumentToast(
  title: string,
  variant: ToastVariant,
  description?: string,
): void {
  const breadcrumbLevel = variant === 'error' ? 'error' : variant === 'warning' ? 'warning' : 'info';
  recordRendererBreadcrumb({
    category: 'toast',
    level: breadcrumbLevel,
    message: title,
    data: {
      variant,
      ...(description && { description }),
    },
  });

  if (variant === 'error') {
    const fingerprint = argValidationToastFingerprint(title, description);
    captureRendererMessage(`toast.error: ${title}`, {
      level: 'error',
      tags: { area: 'toast', variant: 'error' },
      ...(fingerprint && { fingerprint }),
      extra: {
        ...(description && { description }),
      },
    });
  }
}

/** Sonner's built-in action object format (label + click handler) */
export interface ToastActionObject {
  label: string;
  onClick: () => void;
}

export interface ToastProps {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
  /** Primary action button — either a ReactNode or Sonner's `{ label, onClick }` object */
  action?: React.ReactNode | ToastActionObject;
  /** Secondary action button (rendered with [data-cancel] styling) */
  cancel?: ToastActionObject;
  /** Optional icon element displayed to the left of the title */
  icon?: React.ReactNode;
  onClose?: () => void;
}

type ToastContextValue = {
  toasts: ToastProps[];
  showToast: (toast: Omit<ToastProps, 'id'>) => string;
  dismissToast: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
};

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const showToast = useCallback((props: Omit<ToastProps, 'id'>): string => {
    // Suppress toasts during onboarding coach to keep parallel work a surprise
    if (isNotificationsSuppressed()) return '';
    
    const { title, description, variant = 'default', duration = 4000, action, cancel, icon, onClose } = props;

    instrumentToast(title, variant, description);

    const toastOptions = {
      description,
      duration,
      action,
      cancel,
      icon,
      onDismiss: onClose,
      onAutoClose: onClose,
    };

    let id: string | number;
    switch (variant) {
      case 'success':
        id = toast.success(title, toastOptions);
        break;
      case 'error':
        id = toast.error(title, toastOptions);
        break;
      case 'warning':
        id = toast.warning(title, toastOptions);
        break;
      case 'info':
        id = toast.info(title, toastOptions);
        break;
      default:
        id = toast(title, toastOptions);
    }

    return String(id);
  }, []);

  const dismissToast = useCallback((id: string) => {
    // Sonner accepts string | number; passing string works for both cases
    toast.dismiss(id);
  }, []);

  // Sonner manages toast state internally. We expose an empty array for backwards
  // compatibility with any code that destructures `toasts` from the context.
  const value: ToastContextValue = {
    toasts: [],
    showToast,
    dismissToast,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster
        position="top-right"
        expand={false}
        closeButton
        gap={8}
        visibleToasts={3}
        offset={{ top: '80px', right: 16 }}
        toastOptions={{
          // Glass-morphism styling is handled entirely by Toast.module.css.
          // Visual spec: docs/project/UI_INTERNAL_NOTIFICATIONS.md
          style: {
            fontFamily: 'var(--font-family-sans)',
          },
          className: 'rebel-toast',
        }}
      />
    </ToastContext.Provider>
  );
};
ToastProvider.displayName = 'ToastProvider';
