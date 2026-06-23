/**
 * Desktop wrapper hook — memoizes `buildDesktopApprovalTransport()` so
 * consumers passing the transport into hooks like `usePrincipleOptions` don't
 * invalidate `useCallback` deps across renders.
 *
 * Stage F of `docs/plans/260417_approval_consolidation_closeout.md`: mirrors
 * the mobile `useMobileApprovalTransport` hook (`mobile/src/transport/mobileApprovalTransport.ts`)
 * and replaces the per-call-site `useMemo(() => buildDesktopApprovalTransport(), [])`
 * pattern that previously lived inside the retired `usePrincipleOptions` shim.
 *
 * Construction stays behind a hook (not a module-scope singleton) so tests
 * can inject a fake transport via `buildDesktopApprovalTransport(deps)`.
 */

import { useMemo } from 'react';

import type { ApprovalTransport } from '@rebel/cloud-client';

import { buildDesktopApprovalTransport } from './desktopApprovalTransport';

export function useDesktopApprovalTransport(): ApprovalTransport {
  return useMemo(() => buildDesktopApprovalTransport(), []);
}
