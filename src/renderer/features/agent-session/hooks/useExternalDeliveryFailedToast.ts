/**
 * useExternalDeliveryFailedToast
 *
 * Surfaces external-delivery failures (e.g. Slack-thread retries exhausted,
 * workspace disconnected mid-conversation) as a Sonner toast. Without this
 * consumer, the renderer-side terminus of the `external-delivery:failed`
 * cloud-push channel was empty: the broadcast fired, the cloud-push
 * allowlist forwarded it, but the user saw nothing — a silent failure.
 *
 * See:
 * - Producer: `src/core/services/externalConversation/adapters/slackThreadAdapter.ts`
 *   (`scheduleRetry` retries-exhausted path; `cancelByTeamId` workspace-disconnected path).
 * - Allowlist: `src/main/services/cloud/cloudEventChannel.ts`.
 * - Plan: `docs/plans/260503_premerge_audit_followups.md` Stage 2.
 *
 * Provenance: the payload carries `conversationId` (session-bound), `teamId`
 * (workspace), and `deliveryId`. Per the
 * `cross-session-routed-broadcast-event-provenance` boundary contract, a
 * "view conversation" navigation MUST use `payload.conversationId` — never
 * the ambient active session — because this event can fire for a background
 * conversation while the user is on a different one.
 *
 * Dedupe: per-`deliveryId` so the same delivery never produces two toasts.
 * The producer broadcasts at most once per delivery, but the cloud-push
 * forwarding path can re-send on reconnect; we belt-and-suspender it here.
 */

import { useEffect, useRef } from 'react';
import type { ShowToastFn } from '@renderer/contexts/AppContext';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export type ExternalDeliveryFailedReason =
  | 'retries_exhausted'
  | 'workspace_disconnected'
  | string;

export interface ExternalDeliveryFailedPayload {
  deliveryId: string;
  conversationId: string;
  teamId: string;
  reason: ExternalDeliveryFailedReason;
  permanent?: boolean;
}

export interface UseExternalDeliveryFailedToastArgs {
  showToast: ShowToastFn;
  /**
   * Navigate to a conversation. Reuses the existing `navigateToConversation`
   * function from `App.tsx`. Injected for testability and so the hook does
   * not import session machinery directly.
   */
  navigateToConversation: (conversationId: string) => void | Promise<unknown>;
  /**
   * Open Slack reconnect surface (settings → connectors → slack). Optional
   * because it is only used by the `workspace_disconnected` toast action.
   */
  openSlackReconnect?: () => void;
}

const DEFAULT_TOAST_DURATION_MS = 8000;

/**
 * Map a delivery-failure reason onto user-facing copy. Rebel voice: dry,
 * acknowledging, never blaming the user; offers the next concrete step.
 */
export function buildExternalDeliveryFailedToast(
  payload: ExternalDeliveryFailedPayload,
  options: {
    onView?: () => void;
    onReconnect?: () => void;
  },
): {
  title: string;
  description?: string;
  variant: 'error' | 'warning';
  duration: number;
  action?: { label: string; onClick: () => void };
} {
  const baseDuration = DEFAULT_TOAST_DURATION_MS;

  if (payload.reason === 'workspace_disconnected') {
    const action = options.onReconnect
      ? { label: 'Reconnect Slack', onClick: options.onReconnect }
      : undefined;
    return {
      title: "Slack disconnected mid-conversation.",
      description: "Reconnect to keep the thread flowing.",
      variant: 'warning',
      duration: baseDuration,
      ...(action ? { action } : {}),
    };
  }

  if (payload.reason === 'retries_exhausted') {
    const action = options.onView
      ? { label: 'View conversation', onClick: options.onView }
      : undefined;
    return {
      title: "Slack didn't take the hint.",
      description: 'After several attempts, the reply still didn\u2019t reach the thread.',
      variant: 'error',
      duration: baseDuration,
      ...(action ? { action } : {}),
    };
  }

  // Unknown reason: surface defensively so unexpected upstream values still
  // become observable to the user instead of silently swallowed.
  return {
    title: "Couldn't reach Slack.",
    description: `Reason: ${payload.reason}`,
    variant: 'error',
    duration: baseDuration,
  };
}

export function useExternalDeliveryFailedToast(args: UseExternalDeliveryFailedToastArgs): void {
  const { showToast, navigateToConversation, openSlackReconnect } = args;
  const seenDeliveryIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const subscribe = (window as unknown as {
      api?: {
        onExternalDeliveryFailed?: (
          cb: (payload: ExternalDeliveryFailedPayload) => void,
        ) => () => void;
      };
    }).api?.onExternalDeliveryFailed;

    if (!subscribe) return;

    const unsubscribe = subscribe((payload) => {
      if (seenDeliveryIdsRef.current.has(payload.deliveryId)) return;
      seenDeliveryIdsRef.current.add(payload.deliveryId);

      const toastSpec = buildExternalDeliveryFailedToast(payload, {
        onView: () => {
          void Promise.resolve(navigateToConversation(payload.conversationId)).catch(
            (error) => {
              ignoreBestEffortCleanup(error, {
                operation: 'useExternalDeliveryFailedToast.onView.navigateToConversation',
                reason:
                  'Toast "View" navigation is best-effort; a nav failure must not surface a second error to the user',
                severity: 'warn',
              });
            },
          );
        },
        ...(openSlackReconnect ? { onReconnect: openSlackReconnect } : {}),
      });

      showToast(toastSpec);
    });

    return () => {
      unsubscribe();
    };
  }, [showToast, navigateToConversation, openSlackReconnect]);
}
