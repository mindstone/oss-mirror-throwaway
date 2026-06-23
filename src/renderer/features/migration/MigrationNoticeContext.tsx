import { createContext, useContext, type ReactNode } from 'react';
import type { MigrationImportNotice } from '@shared/ipc/channels/migration';

/**
 * The single reactive source of truth for "this install came from a transfer
 * and still has outstanding re-auth steps".
 *
 * App.tsx owns the `migrationImportNotice` state (seeded from localStorage
 * `migration-import-active-notice`, populated by the consume effect, cleared by
 * `handleDismissMigrationImportNotice`). That same state is exposed here so the
 * Settings "Finish settling in" section reads the SAME value the App-level
 * startup card reads — deliberately NOT a second `readStoredMigrationImportNotice()`
 * call, which would diverge on dismiss/consume (no same-window `storage` event).
 *
 * Consequence (intended): dismiss is coupled. Dismissing the App-level card hides
 * the Settings section too. See docs/plans/260611_transfer-ui-tweaks/PLAN.md
 * (Stage 3 mechanism).
 */
export type MigrationNoticeContextValue = {
  notice: MigrationImportNotice | null;
  dismiss: () => void;
};

const MigrationNoticeContext = createContext<MigrationNoticeContextValue | null>(null);

export type MigrationNoticeProviderProps = {
  children: ReactNode;
  value: MigrationNoticeContextValue;
};

export const MigrationNoticeProvider = ({ children, value }: MigrationNoticeProviderProps) => {
  return <MigrationNoticeContext.Provider value={value}>{children}</MigrationNoticeContext.Provider>;
};

/**
 * Returns the migration-import notice context, or null if no provider is mounted.
 * Settings consumes the safe variant so it renders inertly outside the App subtree
 * (e.g. isolated component tests).
 */
export const useMigrationNoticeSafe = (): MigrationNoticeContextValue | null => {
  return useContext(MigrationNoticeContext);
};
