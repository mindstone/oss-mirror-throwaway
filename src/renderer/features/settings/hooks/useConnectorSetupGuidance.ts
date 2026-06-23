import { useCallback, useMemo, useState } from 'react';
import {
  OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE,
  type OAuthSetupGuidance,
} from '@shared/ipc/schemas/common';

/**
 * Any IPC result that MIGHT carry structured OAuth setup guidance. Start-auth handlers (Stage 3)
 * attach `setupGuidance` on the not-configured path; every other field is irrelevant here. Kept
 * deliberately loose (`{ setupGuidance?: ... }`) so a single helper can inspect heterogeneous
 * result shapes (Slack/Google/HubSpot/Microsoft/GitHub start-auth, `mcpAuthenticate`,
 * `cloud:do-start-oauth`, Salesforce) without each call-site needing a bespoke type.
 */
export interface MaybeSetupGuidanceResult {
  setupGuidance?: OAuthSetupGuidance | null;
}

/**
 * Narrowing type guard: is this value a not-configured OAuth setup-guidance payload? Checks the
 * `code` discriminant so the dialog opens ONLY for the structured credentials-not-configured
 * result and never for ordinary connect/auth errors (which keep the existing generic-error toast).
 */
export function isOAuthSetupGuidance(value: unknown): value is OAuthSetupGuidance {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { code?: unknown }).code === OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE
  );
}

export interface UseConnectorSetupGuidanceResult {
  /** The guidance currently driving the dialog, or null when closed. */
  guidance: OAuthSetupGuidance | null;
  /** Whether the setup dialog should be open. */
  isOpen: boolean;
  /**
   * Inspect any IPC result; if it carries a not-configured `setupGuidance`, open the dialog and
   * return `true` (so the caller can SKIP its generic-error toast). Returns `false` otherwise, so
   * the caller falls through to its normal error handling.
   */
  handleResult: (result: MaybeSetupGuidanceResult | null | undefined) => boolean;
  /** Open the dialog directly with a known guidance payload. */
  open: (guidance: OAuthSetupGuidance) => void;
  /** Setter compatible with `<Dialog onOpenChange>` — closing clears the guidance. */
  setOpen: (open: boolean) => void;
  /** Close + clear. */
  close: () => void;
}

/**
 * Shared funnel for connector setup guidance (Stage 5). EVERY connect/auth surface routes its IPC
 * result through `handleResult` so the `ConnectorSetupDialog` opens uniformly when a connector is
 * broken-by-default (no OAuth client credentials) — a future consumer can't diverge. Detection is
 * by the `oauth-credentials-not-configured` discriminant only; all other failures fall through to
 * the caller's existing error handling.
 *
 * NOT gated on `isOssBuild`: commercial BYOK connectors (e.g. Salesforce) can also hit this path.
 */
export function useConnectorSetupGuidance(): UseConnectorSetupGuidanceResult {
  const [guidance, setGuidance] = useState<OAuthSetupGuidance | null>(null);

  const open = useCallback((next: OAuthSetupGuidance) => {
    setGuidance(next);
  }, []);

  const close = useCallback(() => {
    setGuidance(null);
  }, []);

  const setOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen) setGuidance(null);
  }, []);

  const handleResult = useCallback(
    (result: MaybeSetupGuidanceResult | null | undefined): boolean => {
      const candidate = result?.setupGuidance;
      if (isOAuthSetupGuidance(candidate)) {
        setGuidance(candidate);
        return true;
      }
      return false;
    },
    [],
  );

  // Memoised so the returned object keeps a STABLE identity across renders when
  // `guidance` is unchanged. Consumers list this object in `useCallback`/`useEffect`
  // dep arrays (e.g. `generateAuthLink` in `useOnboardingFlow`, two `ToolAuthStep`
  // callbacks); an unmemoised literal here gave it a new identity every render, which
  // recreated those callbacks every render and re-fired the onboarding auto-gen effect
  // on every render (~70k churned firings in a real user's logs — a render-churn loop,
  // not a state-mutation loop, so it never threw "Maximum update depth exceeded").
  // The inner callbacks are already stable `useCallback([])`, so this recomputes only
  // when `guidance` actually changes.
  return useMemo(
    () => ({
      guidance,
      isOpen: guidance !== null,
      handleResult,
      open,
      setOpen,
      close,
    }),
    [guidance, handleResult, open, setOpen, close],
  );
}
