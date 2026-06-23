/**
 * Mobile adapter for `ApprovalTransport`.
 *
 * Added by Stage 0 of the cross-surface approval consolidation plan
 * (`docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`). Wraps
 * `cloudClient.ipcCall(...)` and the shared `safetyPromptEventEmitter` so that
 * any hook moved to `@rebel/cloud-client` in Stage 4 can run on mobile
 * unchanged (it talks to the transport, not to `cloudClient` directly).
 *
 * Semantics in this stage:
 *  - `safetyPrompt.*` routes through the existing cloud-service IPC channels
 *    (`safety-prompt:generate-options`, `safety-prompt:apply-selection`,
 *    `safety-prompt:update`, etc.). The cloud-service is single-user and
 *    bearer-token gated, so writes authoritatively update the instance state.
 *  - `safetyPrompt.onUpdated` subscribes to the `safetyPromptEventEmitter`
 *    singleton, which `EventBridge` feeds from the WebSocket push channel.
 *  - `settings.setSpaceSafetyLevel` uses the narrow-slice
 *    `settings:set-space-safety-level` channel (D11 / F-R2-2). The previous
 *    get→merge→update dance was racy (F-R2-12) and leaked full AppSettings
 *    (including providerKeys/apiKey) through the cloud transport.
 *  - `settings.addTrustedTool` uses the existing
 *    `settings:add-trusted-tool` channel (atomic, deduplicated server-side).
 */

import { useMemo } from 'react';
import { ApprovalTransportError, ipcCall, safetyPromptEventEmitter } from '@rebel/cloud-client';
import type {
  ApprovalTransport,
  SafetyPromptSnapshot,
  SafetyPromptUpdatedEvent,
  SpaceSafetyLevel,
} from '@rebel/cloud-client';

/**
 * Build the mobile adapter. Dependencies can be overridden in tests so that
 * neither the real cloud client nor the real event emitter is contacted.
 */
export interface MobileApprovalTransportDeps {
  /** Injected `ipcCall`. Defaults to the real cloud-client implementation. */
  ipcCall?: typeof ipcCall;
  /**
   * Injected event emitter — must expose `on(event, handler) => unsubscribe`.
   * Defaults to the shared `safetyPromptEventEmitter` singleton.
   */
  safetyPromptEventEmitter?: {
    on(
      event: 'safety-prompt:updated',
      handler: (payload: SafetyPromptUpdatedEvent) => void,
    ): () => void;
  };
}

export function buildMobileApprovalTransport(
  deps: MobileApprovalTransportDeps = {},
): ApprovalTransport {
  const call = deps.ipcCall ?? ipcCall;
  const emitter = deps.safetyPromptEventEmitter ?? safetyPromptEventEmitter;

  return {
    safetyPrompt: {
      generateOptions(ctx) {
        return call('safety-prompt:generate-options', ctx);
      },
      generateDenyOptions(ctx) {
        return call('safety-prompt:generate-deny-options', ctx);
      },
      applySelection(req) {
        return call('safety-prompt:apply-selection', req);
      },
      applyDenySelection(req) {
        return call('safety-prompt:apply-deny-selection', req);
      },
      async update(req): Promise<SafetyPromptSnapshot> {
        const response = await call('safety-prompt:update', {
          prompt: req.prompt,
          updatedBy: req.updatedBy,
        });
        return {
          prompt: response.prompt,
          version: response.version,
          lastUpdatedAt: response.lastUpdatedAt,
          lastUpdatedBy: response.lastUpdatedBy,
          history: response.history,
          migrationComplete: response.migrationComplete,
        };
      },
      onUpdated(listener) {
        return emitter.on('safety-prompt:updated', listener);
      },
    },
    settings: {
      async setSpaceSafetyLevel(spaceId: string, level: SpaceSafetyLevel): Promise<void> {
        // Uses the narrow-slice `settings:set-space-safety-level` channel (D11 / F-R2-2).
        // The previous get→merge→update dance was racy and leaked full AppSettings
        // (including providerKeys/apiKey) through the cloud transport.
        //
        // F4-1 fail-loud: the handler returns `{ success: boolean, error?, spaceId? }`
        // on a 200 response and does NOT throw on READ_ONLY / UNKNOWN_SPACE_ID.
        // Without this check the hook would silently UI-apply without mutating.
        const response = (await call('settings:set-space-safety-level', { spaceId, level })) as
          | { success: boolean; error?: string; spaceId?: string }
          | undefined;
        if (response && response.success === false) {
          const { success: _s, error, ...rest } = response;
          throw new ApprovalTransportError(
            'settings.setSpaceSafetyLevel',
            error,
            rest,
          );
        }
      },
      async addTrustedTool(req): Promise<void> {
        // Stage 4 R2: handler now returns `{ success, error?, toolId? }` so
        // the adapter carries the typed READ_ONLY classification through to
        // ApprovalTransportError.details (symmetric with setSpaceSafetyLevel).
        const response = (await call('settings:add-trusted-tool', {
          toolId: req.toolId,
          displayName: req.displayName,
          serverHint: req.serverHint,
        })) as { success: boolean; error?: string; toolId?: string } | undefined;
        if (response && response.success === false) {
          // F4-1 fail-loud: preserve any additional handler fields as details.
          const { success: _s, error, ...rest } = response;
          throw new ApprovalTransportError(
            'settings.addTrustedTool',
            error,
            rest,
          );
        }
      },
    },
  };
}

/**
 * Mobile wrapper hook — memoizes the transport so consumers passing it into
 * `usePrincipleOptions` don't invalidate `useCallback` deps across renders.
 *
 * Mirrors the desktop `useDesktopApprovalTransport` hook at
 * `src/renderer/transport/useDesktopApprovalTransport.ts` (Stage F of
 * `docs/plans/260417_approval_consolidation_closeout.md`). Keeping the
 * construction behind a hook (not a module-scope singleton) lets tests inject
 * a fake transport via `buildMobileApprovalTransport(deps)`.
 */
export function useMobileApprovalTransport(): ApprovalTransport {
  return useMemo(() => buildMobileApprovalTransport(), []);
}
