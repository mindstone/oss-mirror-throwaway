/**
 * ApprovalSheetProvider / useApprovalSheet
 *
 * F-D-R2-8 — lifts the imperative approval-sheet handle into a small
 * React context so screens beyond the inbox (e.g. the conversation
 * `ConversationApprovalBanner`) can open detail sheets without
 * prop-drilling a ref through multiple layers.
 *
 * Architecture:
 *  - `ApprovalSheetProvider` lives at the root (`app/_layout.tsx`) so
 *    it's always mounted.
 *  - The screen that physically renders `ApprovalSheetHost` (inbox)
 *    calls `registerHandle(ref.current)` in an effect after mount, and
 *    `registerHandle(null)` on unmount.
 *  - Any descendant can call `useApprovalSheet().openApproval(kind, id)`
 *    which delegates to the registered handle. If no host is currently
 *    registered the call emits a dev warning and is a no-op — this is
 *    safe because the host is always mounted when the inbox is in the
 *    stack, and RN Modals present over the entire app (including the
 *    conversation screen on top of the inbox tab).
 *
 * Rationale for registration pattern (vs rendering the host inside the
 * provider itself): the host's action handlers (publish/discard/keep-
 * private/conflict-resolve) depend on inbox-local state (toast, router)
 * and extracting all of them out of the inbox is a larger refactor than
 * this remediation budget allows. The registration pattern lets us
 * ship the banner-opens-sheet affordance today without touching any of
 * those handlers.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type {
  ApprovalSheetHandle,
  ApprovalSheetKind,
} from './ApprovalSheetHost';

interface ApprovalSheetContextValue {
  /**
   * Called by the screen that hosts `ApprovalSheetHost` — pass the
   * current ref value on mount, pass `null` on unmount. This is how
   * the provider learns which host is currently live.
   */
  registerHandle: (handle: ApprovalSheetHandle | null) => void;
  /**
   * Open the detail sheet for the given approval kind + id. Safe to
   * call even when no host is registered (no-ops with a dev warning).
   */
  openApproval: (kind: ApprovalSheetKind, id: string) => void;
  /** Force-close whichever sheet is currently open. */
  closeApproval: () => void;
}

const ApprovalSheetContext = createContext<ApprovalSheetContextValue | null>(
  null,
);

export function ApprovalSheetProvider({ children }: { children: ReactNode }) {
  const [handle, setHandle] = useState<ApprovalSheetHandle | null>(null);

  const openApproval = useCallback(
    (kind: ApprovalSheetKind, id: string) => {
      if (handle) {
        handle.openApproval(kind, id);
      } else if (__DEV__) {
        console.warn(
          '[ApprovalSheet] openApproval called before any host registered',
          { kind, id },
        );
      }
    },
    [handle],
  );

  const closeApproval = useCallback(() => {
    handle?.closeApproval();
  }, [handle]);

  const value = useMemo<ApprovalSheetContextValue>(
    () => ({
      registerHandle: setHandle,
      openApproval,
      closeApproval,
    }),
    [openApproval, closeApproval],
  );

  return (
    <ApprovalSheetContext.Provider value={value}>
      {children}
    </ApprovalSheetContext.Provider>
  );
}

const NOOP_CONTEXT: ApprovalSheetContextValue = {
  registerHandle: () => {},
  openApproval: () => {
    if (__DEV__) {
      console.warn(
        '[ApprovalSheet] openApproval called without ApprovalSheetProvider (no-op)',
      );
    }
  },
  closeApproval: () => {},
};

/**
 * Consumer hook for any descendant of `ApprovalSheetProvider`. Returns
 * `openApproval`/`closeApproval` for imperative use. Degrades to a
 * no-op + dev warning when used outside the provider — the production
 * tree always wraps with the provider, and allowing the no-op
 * fallback lets the many existing test trees that don't mount the
 * provider continue to render without changes.
 */
export function useApprovalSheet(): ApprovalSheetContextValue {
  const ctx = useContext(ApprovalSheetContext);
  return ctx ?? NOOP_CONTEXT;
}
